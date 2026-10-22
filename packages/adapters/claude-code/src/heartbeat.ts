// The background heartbeat that keeps a WCP session alive between hooks, shared by every
// Node adapter (Claude Code, Codex, and every Host translator: Cursor, Gemini, OpenCode,
// Copilot, Antigravity, Windsurf, the watcher, @weft/mcp).
//
// A hook process lives for one hook, so SessionStart spawns `<bundle> heartbeat-loop
// <session> --root <checkout> --parent <pid>` detached. That process must not outlive the
// session it serves. It exits when the first of these happens:
//   - the owning process (the harness, or the long-lived watcher/MCP server) is gone;
//   - the checkout's .weft dir is gone (a deleted worktree or test temp dir);
//   - the session ended: SessionEnd said bye, the coordinator answered session_expired/404,
//     or no hook has touched the session for `idleLimitMs`;
//   - the coordinator has been unreachable for `unreachableLimitMs`
//     (the next hook re-hellos, so nothing is lost);
//   - it has run for `maxLifetimeMs` (a backstop for a recycled parent pid).
// Liveness is polled every `pollMs` (cheap: kill(pid, 0) + stat); the coordinator is only
// contacted every `intervalMs`.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type BeatResult = "alive" | "ended" | "unreachable";

export type StopReason = "parent-exited" | "root-gone" | "session-ended" | "unreachable" | "max-lifetime";

export type LoopLimits = {
  intervalMs: number;
  pollMs: number;
  idleLimitMs: number;
  unreachableLimitMs: number;
  maxLifetimeMs: number;
};

export const DEFAULT_LIMITS: LoopLimits = {
  intervalMs: 30_000,
  pollMs: 2_000,
  idleLimitMs: 30 * 60_000,
  unreachableLimitMs: 5 * 60_000,
  maxLifetimeMs: 12 * 60 * 60_000,
};

/** Limits with `WEFT_HEARTBEAT_*_MS` overrides (tests shorten them). */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): LoopLimits {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    intervalMs: n("WEFT_HEARTBEAT_INTERVAL_MS", DEFAULT_LIMITS.intervalMs),
    pollMs: n("WEFT_HEARTBEAT_POLL_MS", DEFAULT_LIMITS.pollMs),
    idleLimitMs: n("WEFT_HEARTBEAT_IDLE_MS", DEFAULT_LIMITS.idleLimitMs),
    unreachableLimitMs: n("WEFT_HEARTBEAT_UNREACHABLE_MS", DEFAULT_LIMITS.unreachableLimitMs),
    maxLifetimeMs: n("WEFT_HEARTBEAT_MAX_MS", DEFAULT_LIMITS.maxLifetimeMs),
  };
}

/** True while `pid` exists (EPERM = exists but not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "env", "cmd.exe", "powershell.exe", "pwsh"]);

/**
 * The process a hook really belongs to: its parent, skipping the `sh -c` wrappers harnesses
 * run hook commands through. Falls back to the direct parent.
 */
export function harnessPid(start: number = process.ppid): number {
  if (process.platform === "win32") return start;
  let pid = start;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    let line: string;
    try {
      line = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return pid;
    }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return pid;
    const comm = basename(m[2]!.trim()).replace(/^-/, "");
    if (!SHELLS.has(comm)) return pid;
    const up = Number(m[1]);
    if (up <= 1) return pid;
    pid = up;
  }
  return pid;
}

export function pidFile(root: string, session: string): string {
  return join(root, ".weft", "state", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.heartbeat.pid`);
}

/**
 * Spawn the detached heartbeat loop for `session`. `owner` is the pid whose exit ends the
 * loop: the harness for hook adapters, the process itself for in-process hosts.
 * `WEFT_HEARTBEAT_TAG` (set by test suites) is passed through as `--tag` so a suite can find
 * and reap the loops it started. `WEFT_HEARTBEAT=0` disables the loop.
 */
export function spawnHeartbeat(self: string, session: string, root: string, owner: "harness" | "self" = "harness"): void {
  if (process.env.WEFT_HEARTBEAT === "0") return;
  try {
    const parent = owner === "self" ? process.pid : harnessPid();
    const tag = process.env.WEFT_HEARTBEAT_TAG;
    const args = [self, "heartbeat-loop", session, "--root", root, "--parent", String(parent), ...(tag ? ["--tag", tag] : [])];
    spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best effort: sessions re-hello on expiry */
  }
}

export type LoopDeps = {
  root: string;
  session: string;
  /** Pid whose exit ends the loop; undefined = not watched (old spawners). */
  parent?: number;
  /** One coordinator heartbeat. */
  beat: (idleLimitMs: number) => Promise<BeatResult>;
  limits?: Partial<LoopLimits>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  rootExists?: () => boolean;
  /** Write/remove `<state>/<session>.heartbeat.pid` (default true). */
  pidFile?: boolean;
};

/** Run the loop until a stop condition; returns why it stopped. */
export async function runHeartbeatLoop(d: LoopDeps): Promise<StopReason> {
  const lim = { ...limitsFromEnv(), ...d.limits };
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = d.alive ?? pidAlive;
  const weftDir = join(d.root, ".weft");
  const rootExists = d.rootExists ?? (() => existsSync(weftDir));
  const started = now();
  let nextBeat = started + lim.intervalMs;
  let unreachableSince: number | undefined;
  const pf = d.pidFile === false ? undefined : pidFile(d.root, d.session);
  if (pf && rootExists()) {
    try {
      mkdirSync(join(weftDir, "state"), { recursive: true });
      writeFileSync(pf, `${process.pid}\n`);
    } catch {
      /* informational only */
    }
  }
  const stop = (why: StopReason): StopReason => {
    if (pf) rmSync(pf, { force: true });
    return why;
  };
  for (;;) {
    await sleep(Math.max(1, Math.min(lim.pollMs, nextBeat - now())));
    if (d.parent !== undefined && !alive(d.parent)) return stop("parent-exited");
    if (!rootExists()) return stop("root-gone");
    const t = now();
    if (t - started >= lim.maxLifetimeMs) return stop("max-lifetime");
    if (t < nextBeat) continue;
    nextBeat = t + lim.intervalMs;
    const r = await d.beat(lim.idleLimitMs).catch((): BeatResult => "ended");
    if (r === "ended") return stop("session-ended");
    if (r === "alive") unreachableSince = undefined;
    else {
      unreachableSince ??= t;
      if (now() - unreachableSince >= lim.unreachableLimitMs) return stop("unreachable");
    }
  }
}

/** Parse `heartbeat-loop <session> --root R [--parent PID]` arguments. */
export function loopArgs(args: string[]): { session: string; root?: string; parent?: number } {
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const p = Number(get("parent"));
  return { session: args[0]!, root: get("root"), parent: Number.isInteger(p) && p > 0 ? p : undefined };
}
