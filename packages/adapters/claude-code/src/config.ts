// Adapter configuration and per-Claude-session state, both under `<checkout>/.weft/`
// (excluded from git by the installer). Hook processes are short-lived and may run
// concurrently (parallel tool calls), so state is a JSON file guarded by a lock dir.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { editPath } from "./edits";
import type { HookInput } from "./hooks";

export type Mode = "enforce" | "advise";

export type AdapterConfig = {
  url: string;
  repo: string;
  agent: string;
  task: { id: string; title?: string; priority?: number };
  /** WCP change id = the commit `Change-Id` trailer (spec §8.2). */
  change: string;
  /** Prefix prepended to checkout-relative paths to form repo paths in symbol keys. */
  prefix?: string;
  mode?: Mode;
  /** Path (relative to the checkout) of the file holding the agent token. Default `.weft/token`. */
  tokenFile?: string;
  /** Consecutive Stop refusals for the same open errors before letting Claude stop anyway. */
  maxStopRefusals?: number;
  timeoutMs?: number;
};

export type Loaded = { root: string; config: AdapterConfig; token: string };

export const CONFIG_REL = ".weft/claude.json";

/** Walk up from `start` to the first directory holding `.weft/claude.json`. */
export function findRoot(start: string, configRel: string = CONFIG_REL): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, configRel))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export const BASH_TARGET_FORMS = "a leading `cd <absolute or ~ path> && ...` or `git -C <absolute or ~ path> ...`";
// Bare paths exclude glob and brace characters: Bash expands them before cd runs, so the literal would be a wrong target.
// Double-quoted paths exclude `$`, backquote and `\`: inside "…" the shell expands or unescapes them, so
// the literal would be a wrong target (refused, not decoded). Single quotes keep every character literal.
// Only spaces and tabs separate words here: a newline (or CR) ends a shell command, so it is never
// part of a target or of the separator before `&&` or the git subcommand.
const DIR = String.raw`(?:"([^"$\`\\\n\r]+)"|'([^'\n\r]+)'|([^\s"'$\`;&|<>()*?\[\]{},\\]+))`;
const CD_TARGET = new RegExp(String.raw`^[ \t]*cd[ \t]+${DIR}[ \t]*&&`);
// The git subcommand must follow `-C <dir>` directly: a second `-C`, `--work-tree`, `--git-dir` or
// `-c` before it could move the command to another checkout.
const GIT_C_TARGET = new RegExp(String.raw`^[ \t]*git[ \t]+-C[ \t]+${DIR}[ \t]+[a-z]`);

/** True when a path has a `..` segment. */
export function hasDotDot(path: string): boolean {
  return path.split(/[\\/]/).includes("..");
}

/**
 * The directory a Bash command works in, when it names one in an accepted form (and only these):
 *   - a leading `cd <dir> && ...`        (dir absolute, or ~ / ~/... ; quoted or bare)
 *   - a leading `git -C <dir> <subcommand> ...` (same dir forms; no other git option before the subcommand)
 * Nothing else counts: no relative paths, no $VAR, no `..`, no `cd` after another command, no newline
 * inside the leading part. Undefined when the command names no accepted target (callers fail closed
 * under --by-path). Only this leading target is checked; a later `cd` or absolute path in the same
 * command is not attributed.
 */
export function bashTargetDir(command: string, cwd: string): string | undefined {
  const m = CD_TARGET.exec(command) ?? GIT_C_TARGET.exec(command);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  if (!raw) return undefined;
  // `..` is resolved by the kernel after symlinks (`/wt/link/..` is the link target's parent), not lexically.
  if (hasDotDot(raw)) return undefined;
  // A quoted ~ is not expanded by the shell, so it is a literal relative directory, not a home path.
  if (m && (m[1] !== undefined || m[2] !== undefined) && raw.startsWith("~")) return undefined;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw.startsWith("/")) return resolve(raw);
  return undefined;
}

/**
 * Where to look for `.weft/claude.json`. By default the session's cwd. With `byPath` (the
 * `weft-worker` subagent's hooks) the edited file's own checkout comes first: a subagent runs in
 * the parent session's cwd but edits inside its own joined worktree, which must be the agent it
 * acts as. Lives here, not in cli.ts, because host.ts (the shared Host for Cursor, OpenCode and
 * Gemini) cannot import cli.ts.
 */
export function configStarts(input: HookInput, byPath: boolean, fallback: string = process.cwd()): string[] {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? fallback;
  if (!byPath) return [cwd];
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const file = editPath(ti);
  const dir0 = file ? dirname(resolve(cwd, file)) : input.tool_name === "Bash" && typeof ti.command === "string" ? bashTargetDir(ti.command, cwd) : undefined;
  if (!dir0) return [cwd];
  // Only the target's own checkout counts: an unjoined worktree nested inside a joined one must
  // not resolve to its parent's agent.
  for (let dir = dir0; ; dir = dirname(dir)) {
    // The target's checkout has no config: not coordinated. Falling back to the cwd would attribute the edit to the parent agent.
    // A checkout with a config is only ever its own: no fallback to the cwd if its config fails to load.
    if (existsSync(join(dir, ".git"))) return existsSync(join(dir, CONFIG_REL)) ? [dir] : [];
    if (dirname(dir) === dir) return [];
  }
}

/** The coordinator a worker definition was installed for (pinned by `install-agent`). */
export type Pin = { url: string; repo: string; mode?: Mode };

/** The checkout's config file as written (before env overrides), or undefined when absent or unreadable. */
export function readConfigFile(root: string, configRel: string = CONFIG_REL): Partial<AdapterConfig> | undefined {
  try {
    return JSON.parse(readFileSync(join(root, configRel), "utf8")) as Partial<AdapterConfig>;
  } catch {
    return undefined;
  }
}

/**
 * Env overrides a by-path hook must ignore: each would point a pinned checkout somewhere else, or
 * (WEFT_TOKEN, inherited from the parent session) make the worker act with the parent's identity.
 */
export function withoutPinnedOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { WEFT_URL: _url, WEFT_ROOT: _root, WEFT_MODE: _mode, WEFT_TOKEN: _token, ...rest } = env;
  return rest;
}

/**
 * True when `path` reaches its checkout through a symlink: the path itself or any directory on the
 * way up to, and including, the first one holding `.git`. `--by-path` attributes a path to that
 * checkout lexically, so a link (`src/x.ts -> /parent/src/x.ts`, or `linked -> /parent`) would let
 * a write land in another checkout, or load another checkout's config. `--by-path` denies it.
 * Components that do not exist yet are not links. A path in no checkout is not coordinated at all,
 * so its links (macOS `/tmp`, `/var`) do not count.
 */
export function throughSymlink(path: string): boolean {
  let linked = false;
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      if (lstatSync(p).isSymbolicLink()) linked = true;
    } catch {
      /* not created yet */
    }
    if (existsSync(join(p, ".git"))) return linked;
    if (dirname(p) === p) return false;
  }
}

/**
 * `--by-path` trusts a checkout's `.weft/claude.json` only when its url, repo and mode equal the pin.
 * A repo can ship its own config, so an unpinned or mismatched one must not route edits to a
 * server it chose. No pin means nothing is trusted.
 */
export function pinMatches(root: string, pin: Pin | undefined): boolean {
  const c = readConfigFile(root);
  return !!pin && !!c && c.url === pin.url && c.repo === pin.repo && (c.mode ?? "enforce") === (pin.mode ?? "enforce");
}

/** Append one line to `<root>/.weft/log/adapter.log`. Never throws: logging must not break a hook. */
export function appendAdapterLog(root: string, message: string, at: number = Date.now()): void {
  try {
    const dir = join(root, ".weft", "log");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "adapter.log");
    if (existsSync(path) && statSync(path).size > 2_000_000) renameSync(path, `${path}.1`);
    appendFileSync(path, `${new Date(at).toISOString()} ${message}\n`);
  } catch {
    /* logging must never break a hook */
  }
}

/**
 * `confineToken` (set by `hook --by-path`, which trusts a checkout's config only through the pin):
 * the config file must be a regular file (not a link to another checkout's config), and the token
 * file must stay under a real `.weft/` directory of the checkout, compared by real path.
 * Plain `hook` and the other commands read `tokenFile` as before (`install --token-file` may put it anywhere).
 */
export function loadConfig(start: string, env: NodeJS.ProcessEnv = process.env, configRel: string = CONFIG_REL, confineToken = false): Loaded | undefined {
  const root = env.WEFT_ROOT ? resolve(env.WEFT_ROOT) : findRoot(start, configRel);
  if (!root) return undefined;
  let config: AdapterConfig;
  try {
    if (confineToken && (!lstatSync(join(root, dirname(configRel))).isDirectory() || !lstatSync(join(root, configRel)).isFile())) return undefined;
    config = JSON.parse(readFileSync(join(root, configRel), "utf8")) as AdapterConfig;
    if (!config || typeof config !== "object") return undefined; // a config of `null` or a number is not a config
  } catch {
    return undefined;
  }
  if (env.WEFT_URL) config.url = env.WEFT_URL;
  if (env.WEFT_MODE === "advise" || env.WEFT_MODE === "enforce") config.mode = env.WEFT_MODE;
  let token = env.WEFT_TOKEN ?? "";
  if (!token) {
    try {
      const tokenPath = resolve(root, config.tokenFile ?? ".weft/token");
      if (confineToken) {
        // A repo-shipped config must not point tokenFile at another file and have its content sent as the
        // bearer token. .weft itself must be a real directory (a symlinked .weft would move the whole
        // prefix); then compare real paths.
        if (!lstatSync(resolve(root, ".weft")).isDirectory()) throw new Error(".weft is not a directory");
        if (!realpathSync(tokenPath).startsWith(realpathSync(resolve(root, ".weft")) + sep)) throw new Error("tokenFile outside .weft/");
      }
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      token = "";
    }
  }
  if (!config.url || !config.repo || !config.agent || !config.change || !config.task?.id || !token) return undefined;
  return { root, config, token };
}

export type PendingEdit = {
  tool: string;
  /** checkout-relative path -> text before the tool ran (null = file did not exist). */
  before: Record<string, string | null>;
  /** Context already shown to the model by PreToolUse for this call (avoid repeats). */
  shown: string[];
  /** Files that existed but could not be read before the tool ran: never submitted for this call. */
  unreadable?: string[];
  at: number;
};

export type SessionState = {
  claudeSession: string;
  wcpSession?: string;
  /** base_seq: last delivered_through whose content reached the model (spec §5.2). */
  base: number;
  /** Highest inbox id injected into the model (acked on the next request, spec §5.4). */
  acked: number;
  /** Keep base below this until the checkout contains the landing (spec §5.2). */
  rebaseFloor?: { seq: number; sha?: string };
  pending: Record<string, PendingEdit>;
  head?: string;
  stopRefusals?: { fingerprint: string; count: number };
  lastContact: number;
  /** Claim limits the coordinator announced in its last welcome (spec §7.5), for `weft claim`. */
  claimLimits?: { claim_ttl_ms: number; claims?: { lease_ms: number; firm_max_ms: number } };
};

export function stateDir(root: string): string {
  return join(root, ".weft", "state");
}

function statePath(root: string, claudeSession: string): string {
  return join(stateDir(root), `${claudeSession.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readState(root: string, claudeSession: string): SessionState {
  try {
    return JSON.parse(readFileSync(statePath(root, claudeSession), "utf8")) as SessionState;
  } catch {
    return { claudeSession, base: 0, acked: 0, pending: {}, lastContact: 0 };
  }
}

export function writeState(root: string, state: SessionState): void {
  mkdirSync(stateDir(root), { recursive: true });
  const path = statePath(root, state.claudeSession);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
  writeFileSync(join(stateDir(root), "current"), state.claudeSession);
}

/** Most recently active Claude session in this checkout (used by git hooks). */
export function currentSession(root: string): string | undefined {
  const dir = stateDir(root);
  try {
    const named = readFileSync(join(dir, "current"), "utf8").trim();
    if (named) return named;
  } catch {
    /* fall through */
  }
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    return files[0]?.replace(/\.json$/, "");
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialize state read-modify-write across concurrent hook processes. */
export async function withLock<T>(root: string, claudeSession: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  mkdirSync(stateDir(root), { recursive: true });
  const lock = `${statePath(root, claudeSession)}.lock`;
  const deadline = Date.now() + waitMs;
  let owned = false;
  for (;;) {
    try {
      mkdirSync(lock);
      owned = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* raced with the owner releasing it */
      }
      if (Date.now() > deadline) break; // proceed unlocked rather than hang the harness
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    if (owned) rmSync(lock, { recursive: true, force: true });
  }
}
