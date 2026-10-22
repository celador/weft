// Shared host for harness translators that reuse the Claude Code WCP core
// (`ClaudeAdapter`): Cursor CLI, OpenCode, Gemini CLI. Each translator maps its harness's
// hook payloads onto Claude-shaped `HookInput`s (Edit/Write/MultiEdit/Bash, file_path,
// old_string/new_string, content, command) and maps the core's output back. Everything that
// is not harness-specific lives here: install (config + token + git hooks + agent CLI),
// commit-msg trailers, the pre-commit gate, heartbeats, `negotiate`/`inbox`, status, and
// per-hook timing in `.weft/log/hooks.jsonl`.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Capabilities } from "@weft/protocol";
import { NEGOTIATE_USAGE, parseNegotiate } from "@weft/protocol";
import { HttpTransport, type Transport } from "./client";
import { currentSession, loadConfig, readState, stateDir, withLock, writeState, type AdapterConfig, type Loaded } from "./config";
import { ClaudeAdapter, type HookInput, type HookOutput } from "./hooks";
import { flushJobs, type LspJob } from "./lsp-queue";
import { stableNodePath } from "./node-path";

// Not imported from ./cli: that module runs Claude's main() when it is the entry bundle,
// and esbuild would make every translator bundle that entry.
/** Per-checkout wrapper the model runs (`<checkout>/.weft/bin/weft negotiate …`). */
export const CLI_REL = ".weft/bin/weft";

/** Where this checkout's git hooks go (see cli.ts gitHooksDir: per-worktree hooksPath). */
export function gitHooksDir(root: string): string {
  try {
    return resolve(root, git(root, ["config", "core.hooksPath"]));
  } catch {
    /* not set */
  }
  const gitDir = resolve(root, git(root, ["rev-parse", "--git-dir"]));
  const common = resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
  if (gitDir === common) return resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
  const dir = join(gitDir, "hooks");
  git(root, ["config", "extensions.worktreeConfig", "true"]);
  git(root, ["config", "--worktree", "core.hooksPath", dir]);
  return dir;
}

export type HostSpec = {
  /** Short name used in hook markers and messages, e.g. `cursor`. */
  name: string;
  /** Executable name in usage text, e.g. `weft-adapter-cursor`. */
  bin: string;
  /** Config file relative to the checkout, e.g. `.weft/cursor.json`. */
  configRel: string;
  harness: string;
  adapter: string;
  capabilities: Capabilities;
  /** Absolute path of the running bundle (the hook/git-hook command target). */
  self: string;
  /** Write the harness's own hook config; returns human-readable lines for the install report. */
  installHarness: (root: string, hookCommand: string, args: string[]) => string[];
  /** Extra `.git/info/exclude` lines (machine-specific harness config). */
  excludes?: string[];
};

export type Call = { op: string; ms: number };

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

/** Time every coordinator call (written to .weft/log/hooks.jsonl). */
function timed(t: Transport, calls: Call[]): Transport {
  return new Proxy(t, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const start = performance.now();
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          calls.push({ op: String(prop), ms: Math.round(performance.now() - start) });
        }
      };
    },
  });
}

export class Host {
  constructor(readonly spec: HostSpec) {}

  load(start: string = process.cwd()): Loaded | undefined {
    return loadConfig(start, process.env, this.spec.configRel);
  }

  cliFor(root: string): string {
    const wrapper = join(root, CLI_REL);
    return existsSync(wrapper) ? wrapper : `${shellQuote(process.execPath)} ${shellQuote(this.spec.self)}`;
  }

  adapter(loaded: Loaded, calls?: Call[], lspJobs?: LspJob[]): ClaudeAdapter {
    const http = new HttpTransport(loaded.config.url, loaded.token, loaded.config.repo, loaded.config.timeoutMs ?? 8000);
    const transport = calls ? timed(http, calls) : http;
    const self = this.spec.self;
    return new ClaudeAdapter(loaded, {
      transport,
      analyze: async (changes, root, prefix) => (await import("./analysis")).analyzeChangesAsync(changes, root, prefix),
      diff: async (rel, before, after) => (await import("./analysis")).unifiedDiff(rel, before, after),
      cli: this.cliFor(loaded.root),
      identity: { harness: this.spec.harness, adapter: this.spec.adapter, capabilities: this.spec.capabilities },
      ...(lspJobs ? { lsp: (job: LspJob) => void lspJobs.push(job) } : {}),
      startHeartbeat: (session) => {
        try {
          spawn(process.execPath, [self, "heartbeat-loop", session, "--root", loaded.root], { detached: true, stdio: "ignore" }).unref();
        } catch {
          /* best effort: sessions re-hello on expiry */
        }
      },
    });
  }

  /**
   * Run one translated hook through the core and log its timing. `input` is the
   * Claude-shaped hook input; returns the core's output (undefined = no opinion).
   * Never throws (fail open).
   */
  async run(loaded: Loaded, input: HookInput, extra: Record<string, unknown> = {}): Promise<HookOutput> {
    const calls: Call[] = [];
    const lspJobs: LspJob[] = [];
    const start = performance.now();
    let out: HookOutput;
    try {
      out = await this.adapter(loaded, calls, lspJobs).handle(input);
    } catch {
      out = undefined;
    }
    // Language-server enrichment runs in a per-checkout daemon (src/lsp.ts); this only queues.
    if (lspJobs.length) flushJobs(loaded, lspJobs, this.spec.self);
    try {
      const o = out as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string; permissionDecisionReason?: string } } | undefined;
      const injected = [o?.reason, o?.hookSpecificOutput?.additionalContext, o?.hookSpecificOutput?.permissionDecisionReason].filter((x): x is string => typeof x === "string").join("\n");
      const rec = {
        ts: new Date().toISOString(),
        harness: this.spec.harness,
        event: input.hook_event_name,
        tool: input.tool_name,
        session: input.session_id,
        total_ms: Math.round(performance.now()),
        handle_ms: Math.round(performance.now() - start),
        calls,
        decision: o?.hookSpecificOutput?.permissionDecision ?? o?.decision,
        injected_chars: injected.length,
        weft_chars: /\[weft/.test(injected) ? injected.length : 0,
        ...extra,
        ...(process.env.WEFT_HOOK_TRACE === "1" && injected ? { injected } : {}),
      };
      mkdirSync(join(loaded.root, ".weft", "log"), { recursive: true });
      appendFileSync(join(loaded.root, ".weft", "log", "hooks.jsonl"), JSON.stringify(rec) + "\n");
    } catch {
      /* timing is best-effort */
    }
    return out;
  }

  // ------------------------------------------------------------------ translator helpers

  private carryPath(root: string, session: string): string {
    return join(stateDir(root), `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.carry.json`);
  }

  /**
   * Model-visible text the harness could not deliver at the hook point that produced it
   * (e.g. warnings on an allowed pre-edit check, where the harness's pre-tool output has no
   * context field). Delivered by the next hook that can inject (`takeCarry`).
   */
  addCarry(root: string, session: string, text: string): void {
    if (!text) return;
    try {
      mkdirSync(stateDir(root), { recursive: true });
      const p = this.carryPath(root, session);
      const prev = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as string[]) : [];
      writeFileSync(p, JSON.stringify([...prev, text]));
    } catch {
      /* best effort */
    }
  }

  takeCarry(root: string, session: string): string {
    try {
      const p = this.carryPath(root, session);
      if (!existsSync(p)) return "";
      const texts = JSON.parse(readFileSync(p, "utf8")) as string[];
      writeFileSync(p, "[]");
      return texts.filter(Boolean).join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Record the pre-edit text of files for a tool call the core never saw a pre-hook for
   * (post-edit-only harness events, the file watcher), so its post-edit commit diffs
   * against the real before-state instead of git HEAD.
   */
  async seedBefore(root: string, session: string, callId: string, tool: string, before: Record<string, string | null>): Promise<void> {
    await withLock(root, session, async () => {
      const st = readState(root, session);
      st.pending[callId] = { tool, before, shown: [], at: Date.now() };
      writeState(root, st);
    });
  }

  // ------------------------------------------------------------------ commands

  install(args: string[]): void {
    const { spec } = this;
    const dir = resolve(arg(args, "dir") ?? process.cwd());
    const root = git(dir, ["rev-parse", "--show-toplevel"]);
    const cfgPath = join(root, spec.configRel);
    const prev: Partial<AdapterConfig> = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, "utf8")) as AdapterConfig) : {};
    const taskId = arg(args, "task") ?? prev.task?.id ?? "adhoc";
    const title = arg(args, "title") ?? prev.task?.title;
    const priority = arg(args, "priority") !== undefined ? Number(arg(args, "priority")) : prev.task?.priority;
    const config: AdapterConfig = {
      url: arg(args, "url") ?? prev.url ?? process.env.WEFT_URL ?? "",
      repo: arg(args, "repo") ?? prev.repo ?? "",
      agent: arg(args, "agent") ?? prev.agent ?? "",
      task: { id: taskId, ...(title ? { title } : {}), ...(priority !== undefined && !Number.isNaN(priority) ? { priority } : {}) },
      change: arg(args, "change") ?? (prev.task?.id === taskId && prev.change ? prev.change : `I${createHash("sha1").update(randomBytes(32)).digest("hex")}`),
      ...((arg(args, "prefix") ?? prev.prefix) ? { prefix: arg(args, "prefix") ?? prev.prefix } : {}),
      mode: (arg(args, "mode") as AdapterConfig["mode"]) ?? prev.mode ?? "enforce",
      tokenFile: arg(args, "token-file") ?? prev.tokenFile ?? ".weft/token",
    };
    const missing = (["url", "repo", "agent"] as const).filter((k) => !config[k]);
    if (missing.length) throw new Error(`install: missing --${missing.join(", --")}`);
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
    if (process.env.WEFT_TOKEN) {
      const tokenPath = resolve(root, config.tokenFile!);
      mkdirSync(dirname(tokenPath), { recursive: true });
      writeFileSync(tokenPath, process.env.WEFT_TOKEN.trim() + "\n", { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
    }
    const exclude = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]));
    mkdirSync(dirname(exclude), { recursive: true });
    const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const want = [".weft/", ...(spec.excludes ?? [])].filter((l) => !ex.split("\n").includes(l));
    if (want.length) writeFileSync(exclude, `${ex}${ex && !ex.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`);

    const hookCommand = `${shellQuote(stableNodePath())} ${shellQuote(spec.self)} hook`;
    const harnessLines = spec.installHarness(root, hookCommand, args);

    const mark = `weft-${spec.name}`;
    const hooksDir = gitHooksDir(root);
    mkdirSync(hooksDir, { recursive: true });
    const node = stableNodePath();
    const bodies: Array<[string, string]> = [
      ["commit-msg", `#!/bin/sh\n# ${mark}: add Change-Id / Task-Id / Agent-Id trailers (installed by ${spec.bin})\nexec ${shellQuote(node)} ${shellQuote(spec.self)} commit-msg "$1"\n`],
      ["pre-commit", `#!/bin/sh\n# ${mark}: last gate — refuse the commit while this checkout's Weft session has open errors\nexec ${shellQuote(node)} ${shellQuote(spec.self)} pre-commit\n`],
    ];
    for (const [name, body] of bodies) {
      const p = join(hooksDir, name);
      if (existsSync(p) && !/# weft-/.test(readFileSync(p, "utf8"))) {
        writeFileSync(`${p}.pre-weft`, readFileSync(p));
        process.stderr.write(`weft: existing ${name} hook moved to ${name}.pre-weft (not chained)\n`);
      }
      writeFileSync(p, body, { mode: 0o755 });
      chmodSync(p, 0o755);
    }
    const cliPath = join(root, CLI_REL);
    mkdirSync(dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, `#!/bin/sh\n# ${mark}: Weft CLI for the agent in this checkout (negotiate, inbox)\nexec ${shellQuote(node)} ${shellQuote(spec.self)} "$@"\n`, { mode: 0o755 });
    chmodSync(cliPath, 0o755);
    const hasToken = existsSync(resolve(root, config.tokenFile!)) || !!process.env.WEFT_TOKEN;
    process.stdout.write(
      `weft: installed ${spec.harness} adapter in ${root}\n` +
        `  coordinator ${config.url} repo ${config.repo} agent ${config.agent} task ${config.task.id} change ${config.change}\n` +
        `  capabilities ${JSON.stringify(spec.capabilities)}\n` +
        harnessLines.map((l) => `  ${l}\n`).join("") +
        `  git hooks: ${hooksDir}/commit-msg, pre-commit\n  agent cli: ${cliPath}\n` +
        (hasToken ? "" : `  NOTE: no token yet — write it to ${config.tokenFile} (mode 600) or export WEFT_TOKEN\n`),
    );
  }

  commitMsg(file: string): void {
    const loaded = this.load();
    if (!loaded) return;
    const { config } = loaded;
    execFileSync("git", ["interpret-trailers", "--in-place", "--if-exists", "doNothing", "--trailer", `Change-Id: ${config.change}`, "--trailer", `Task-Id: ${config.task.id}`, "--trailer", `Agent-Id: ${config.agent}`, file]);
  }

  async preCommit(): Promise<number> {
    const loaded = this.load();
    if (!loaded) return 0;
    const session = currentSession(loaded.root);
    if (!session) return 0;
    const refusal = await this.adapter(loaded).commitGate(session);
    if (!refusal) return 0;
    process.stderr.write(`${refusal}\n`);
    return 1;
  }

  /** The checkout's language-server enrichment daemon (src/lsp.ts). */
  async lspDaemon(rootArg?: string): Promise<void> {
    const loaded = this.load(rootArg ?? process.cwd());
    if (!loaded) return;
    const { LspWorker, runDaemon } = await import("./lsp");
    const transport = new HttpTransport(loaded.config.url, loaded.token, loaded.config.repo, loaded.config.timeoutMs ?? 8000);
    await runDaemon(loaded.root, new LspWorker(loaded, { transport }));
  }

  async heartbeatLoop(session: string, rootArg?: string): Promise<void> {
    const loaded = this.load(rootArg ?? process.cwd());
    if (!loaded) return;
    const adapter = this.adapter(loaded);
    for (;;) {
      await new Promise((r) => setTimeout(r, 30_000));
      if (!(await adapter.beat(session, 30 * 60_000).catch(() => false))) return;
    }
  }

  async negotiate(args: string[]): Promise<number> {
    if (!args.length || args.includes("--help") || args.includes("-h")) {
      process.stdout.write(`${NEGOTIATE_USAGE}\n\nWith no --to/--keys, propose and escalate target the agent behind your newest open Weft error.\n`);
      return args.length ? 0 : 2;
    }
    const loaded = this.load();
    if (!loaded) {
      process.stderr.write(`weft: not configured here (no ${this.spec.configRel} or no token)\n`);
      return 2;
    }
    let cmd;
    try {
      cmd = parseNegotiate(args);
    } catch (err) {
      process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const r = await this.adapter(loaded).negotiate(currentSession(loaded.root) ?? "cli", cmd);
    process.stdout.write(`${r.text}\n`);
    return r.code;
  }

  async inbox(args: string[]): Promise<number> {
    const loaded = this.load();
    if (!loaded) {
      process.stderr.write(`weft: not configured here (no ${this.spec.configRel} or no token)\n`);
      return 2;
    }
    const r = await this.adapter(loaded).inbox(currentSession(loaded.root) ?? "cli", Number(arg(args, "wait") ?? 0) || 0);
    process.stdout.write(`${r.text}\n`);
    return r.code;
  }

  status(): void {
    const loaded = this.load();
    if (!loaded) {
      process.stdout.write(`weft: not configured here (no ${this.spec.configRel} or no token)\n`);
      return;
    }
    const { config, root } = loaded;
    process.stdout.write(`${JSON.stringify({ root, harness: this.spec.harness, capabilities: this.spec.capabilities, ...config, token: "(set)" }, null, 2)}\n`);
    try {
      for (const f of readdirSync(stateDir(root)).filter((x) => x.endsWith(".json"))) {
        const st = readState(root, f.replace(/\.json$/, ""));
        process.stdout.write(`session ${st.claudeSession}: wcp ${st.wcpSession ?? "-"} base #${st.base} acked ${st.acked}${st.rebaseFloor ? ` floor #${st.rebaseFloor.seq}` : ""}\n`);
      }
    } catch {
      /* no state yet */
    }
  }

  /** Dispatch the shared sub-commands; `hook` is the translator's own. */
  async main(argv: string[], hook: (args: string[]) => Promise<void>, extra: Record<string, (args: string[]) => Promise<number | void>> = {}): Promise<void> {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case "hook":
        return hook(args);
      case "install":
        return this.install(args);
      case "commit-msg":
        return this.commitMsg(args[0]!);
      case "pre-commit":
        process.exitCode = await this.preCommit();
        return;
      case "heartbeat-loop":
        return this.heartbeatLoop(args[0]!, arg(args, "root"));
      case "lsp-daemon":
        return this.lspDaemon(arg(args, "root"));
      case "status":
        return this.status();
      case "negotiate":
        process.exitCode = await this.negotiate(args);
        return;
      case "inbox":
        process.exitCode = await this.inbox(args);
        return;
      default:
        if (cmd && extra[cmd]) {
          const code = await extra[cmd](args);
          if (typeof code === "number") process.exitCode = code;
          return;
        }
        process.stderr.write(
          `usage: ${this.spec.bin} install --url URL --repo REPO --agent ID --task ID [--title T] [--priority N] [--prefix P] [--mode enforce|advise]\n` +
            `       ${this.spec.bin} hook|commit-msg FILE|pre-commit|status|negotiate …|inbox${Object.keys(extra).length ? `|${Object.keys(extra).join("|")}` : ""}\n`,
        );
        process.exitCode = cmd ? 2 : 0;
    }
  }
}
