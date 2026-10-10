// `weft-adapter-claude` CLI (bundled to dist/weft-claude.mjs).
//
//   install        configure a checkout: .weft/claude.json (+ token file), .claude/settings.json
//                  hooks, git commit-msg (Change-Id/Task-Id/Agent-Id trailers) + pre-commit gate
//   hook           Claude Code hook entry: JSON on stdin -> JSON on stdout (always exit 0)
//   commit-msg F   git commit-msg hook
//   pre-commit     git pre-commit hook (last gate: refuses while the session has open errors)
//   heartbeat-loop keep a WCP session alive between hooks (spawned detached by SessionStart)
//   status         print config (never the token) and session state
//   negotiate …    the agent's shell command for WCP negotiation (propose/accept/reject/counter/escalate)
//   inbox          print what is waiting for this agent (inbox, open errors, negotiations owed)
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NEGOTIATE_USAGE, parseKey, parseNegotiate } from "@weft/protocol";
import { HttpTransport, type Transport } from "./client";
import { CONFIG_REL, currentSession, loadConfig, readState, stateDir, type AdapterConfig, type Loaded } from "./config";
import { ClaudeAdapter, type ClaimCommand, type HookInput } from "./hooks";
import { stableNodePath } from "./node-path";

const SELF = fileURLToPath(import.meta.url);
const HOOK_MARK = "weft-claude";
/** Per-checkout wrapper the model runs (`<checkout>/.weft/bin/weft negotiate …`). */
export const CLI_REL = ".weft/bin/weft";

function cliFor(root: string): string {
  const wrapper = join(root, CLI_REL);
  return existsSync(wrapper) ? wrapper : `${shellQuote(process.execPath)} ${shellQuote(SELF)}`;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

function adapterFor(loaded: Loaded, calls?: Call[]): ClaudeAdapter {
  const http = new HttpTransport(loaded.config.url, loaded.token, loaded.config.repo, loaded.config.timeoutMs ?? 8000);
  const transport = calls ? timed(http, calls) : http;
  return new ClaudeAdapter(loaded, {
    transport,
    analyze: async (changes, root, prefix) => (await import("./analysis")).analyzeChanges(changes, root, prefix),
    diff: async (rel, before, after) => (await import("./analysis")).unifiedDiff(rel, before, after),
    cli: cliFor(loaded.root),
    startHeartbeat: (claudeSession) => {
      try {
        spawn(process.execPath, [SELF, "heartbeat-loop", claudeSession, "--root", loaded.root], { detached: true, stdio: "ignore" }).unref();
      } catch {
        /* heartbeat is best-effort; sessions re-hello on expiry */
      }
    },
  });
}

type Call = { op: string; ms: number };

/** Time every coordinator call of this hook process (written to .weft/log/hooks.jsonl). */
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

/** Model-visible text a hook output injects (for token-overhead accounting). */
export function injectedText(out: unknown): string {
  const o = (out ?? {}) as { reason?: unknown; hookSpecificOutput?: { additionalContext?: unknown; permissionDecisionReason?: unknown } };
  return [o.reason, o.hookSpecificOutput?.additionalContext, o.hookSpecificOutput?.permissionDecisionReason].filter((x): x is string => typeof x === "string").join("\n");
}

async function hook(): Promise<void> {
  let out: unknown;
  let input: HookInput | undefined;
  let loaded: Loaded | undefined;
  const calls: Call[] = [];
  const handleStart = performance.now();
  try {
    input = JSON.parse(await readStdin()) as HookInput;
    loaded = loadConfig(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    if (loaded) out = await adapterFor(loaded, calls).handle(input);
  } catch {
    out = undefined; // fail open: malformed input or a bug must not block the harness
  }
  if (out) process.stdout.write(JSON.stringify(out));
  if (loaded && input) {
    // Per-hook timing: total = since this node process started (incl. boot), handle = hook
    // logic incl. coordinator calls; injected = chars of text that reached the model.
    try {
      const o = out as { decision?: string; hookSpecificOutput?: { permissionDecision?: string } } | undefined;
      const injected = injectedText(out);
      const rec = {
        ts: new Date().toISOString(),
        event: input.hook_event_name,
        tool: input.tool_name,
        session: input.session_id,
        total_ms: Math.round(performance.now()),
        handle_ms: Math.round(performance.now() - handleStart),
        calls,
        decision: o?.hookSpecificOutput?.permissionDecision ?? o?.decision,
        injected_chars: injected.length,
        weft_chars: /\[weft/.test(injected) ? injected.length : 0,
        // WEFT_HOOK_TRACE=1: keep the verbatim injected text (demo evidence; may quote code)
        ...(process.env.WEFT_HOOK_TRACE === "1" && injected ? { injected } : {}),
      };
      mkdirSync(join(loaded.root, ".weft", "log"), { recursive: true });
      appendFileSync(join(loaded.root, ".weft", "log", "hooks.jsonl"), JSON.stringify(rec) + "\n");
    } catch {
      /* timing is best-effort */
    }
  }
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/**
 * Where this checkout's git hooks go. Respects core.hooksPath. A linked worktree shares
 * `<common>/hooks` with every other worktree of the repo, so two adapters installed in two
 * worktrees (e.g. Claude Code in one, Codex in the other) would overwrite each other's
 * commit-msg/pre-commit; give the worktree its own hooks dir via worktree-scoped config.
 */
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

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

/** Merge Weft hooks into a Claude settings object, replacing any previous Weft entries. */
export function mergeSettings(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  const ours = (matcher?: string): HookEntry => ({ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 30 }] });
  const want: Record<string, HookEntry> = {
    SessionStart: ours(),
    UserPromptSubmit: ours(),
    PreToolUse: ours("Edit|Write|MultiEdit|Bash"),
    PostToolUse: ours("*"),
    Stop: ours(),
    SessionEnd: ours(),
  };
  for (const [event, entry] of Object.entries(want)) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !h.command.includes(HOOK_MARK)) }))
      .filter((e) => e.hooks.length);
    hooks[event] = [...kept, entry];
  }
  return { ...settings, hooks };
}

const COMMIT_MSG = (node: string) => `#!/bin/sh
# weft-claude: add Change-Id / Task-Id / Agent-Id trailers (installed by weft-adapter-claude)
exec ${shellQuote(node)} ${shellQuote(SELF)} commit-msg "$1"
`;
const PRE_COMMIT = (node: string) => `#!/bin/sh
# weft-claude: last gate — refuse the commit while this checkout's Weft session has open errors
exec ${shellQuote(node)} ${shellQuote(SELF)} pre-commit
`;

async function install(args: string[]): Promise<void> {
  const dir = resolve(arg(args, "dir") ?? process.cwd());
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const cfgPath = join(root, CONFIG_REL);
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
  mkdirSync(join(root, ".weft"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
  if (process.env.WEFT_TOKEN) {
    const tokenPath = resolve(root, config.tokenFile!);
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, process.env.WEFT_TOKEN.trim() + "\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  }

  // .weft/ (token, state, logs) and local hook settings never enter git
  const exclude = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]));
  mkdirSync(dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const want = [".weft/", ".claude/settings.local.json"].filter((l) => !ex.split("\n").includes(l));
  if (want.length) writeFileSync(exclude, `${ex}${ex && !ex.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`);

  // Claude Code hooks. Default: .claude/settings.local.json (machine-specific absolute paths,
  // never committed); --shared writes the committed .claude/settings.json instead.
  const command = `${shellQuote(stableNodePath())} ${shellQuote(SELF)} hook`;
  const settingsPath = join(root, ".claude", args.includes("--shared") ? "settings.json" : "settings.local.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(settingsPath, JSON.stringify(mergeSettings(settings, command), null, 2) + "\n");

  // git hooks (respect core.hooksPath; per-worktree hooks for linked worktrees)
  const hooksDir = gitHooksDir(root);
  mkdirSync(hooksDir, { recursive: true });
  for (const [name, body] of [["commit-msg", COMMIT_MSG(stableNodePath())], ["pre-commit", PRE_COMMIT(stableNodePath())]] as const) {
    const p = join(hooksDir, name);
    if (existsSync(p) && !readFileSync(p, "utf8").includes(HOOK_MARK)) {
      writeFileSync(`${p}.pre-weft`, readFileSync(p));
      process.stderr.write(`weft: existing ${name} hook moved to ${name}.pre-weft (not chained)\n`);
    }
    writeFileSync(p, body, { mode: 0o755 });
    chmodSync(p, 0o755);
  }
  // The agent's own Weft command (negotiate / inbox), run through its shell tool.
  const cliPath = join(root, CLI_REL);
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(cliPath, `#!/bin/sh\n# ${HOOK_MARK}: Weft CLI for the agent in this checkout (negotiate, inbox)\nexec ${shellQuote(stableNodePath())} ${shellQuote(SELF)} "$@"\n`, { mode: 0o755 });
  chmodSync(cliPath, 0o755);
  const hasToken = existsSync(resolve(root, config.tokenFile!)) || !!process.env.WEFT_TOKEN;
  process.stdout.write(
    `weft: installed Claude Code adapter in ${root}\n` +
      `  coordinator ${config.url} repo ${config.repo} agent ${config.agent} task ${config.task.id} change ${config.change}\n` +
      `  hooks: ${settingsPath}\n  git hooks: ${hooksDir}/commit-msg, pre-commit\n  agent cli: ${cliPath}\n` +
      (hasToken ? "" : `  NOTE: no token yet — write it to ${config.tokenFile} (mode 600) or export WEFT_TOKEN\n`),
  );
}

function commitMsg(file: string): void {
  const loaded = loadConfig(process.cwd());
  if (!loaded) return;
  const { config } = loaded;
  execFileSync("git", [
    "interpret-trailers", "--in-place", "--if-exists", "doNothing",
    "--trailer", `Change-Id: ${config.change}`,
    "--trailer", `Task-Id: ${config.task.id}`,
    "--trailer", `Agent-Id: ${config.agent}`,
    file,
  ]);
}

async function preCommit(): Promise<number> {
  const loaded = loadConfig(process.cwd());
  if (!loaded) return 0;
  const session = currentSession(loaded.root);
  if (!session) return 0;
  const refusal = await adapterFor(loaded).commitGate(session);
  if (!refusal) return 0;
  process.stderr.write(`${refusal}\n`);
  return 1;
}

async function heartbeatLoop(claudeSession: string, rootArg?: string): Promise<void> {
  const loaded = loadConfig(rootArg ?? process.cwd());
  if (!loaded) return;
  const adapter = adapterFor(loaded);
  const intervalMs = 30_000;
  const idleLimitMs = 30 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!(await adapter.beat(claudeSession, idleLimitMs).catch(() => false))) return;
  }
}

async function negotiateCmd(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${NEGOTIATE_USAGE}\n\nWith no --to/--keys, propose and escalate target the agent behind your newest open Weft error.\n`);
    return args.length ? 0 : 2;
  }
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stderr.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return 2;
  }
  let cmd;
  try {
    cmd = parseNegotiate(args);
  } catch (err) {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const r = await adapterFor(loaded).negotiate(currentSession(loaded.root) ?? "cli", cmd);
  process.stdout.write(`${r.text}\n`);
  return r.code;
}

/** Longest a claim may be held (ten minutes): the planned hard limit for firm claims. A longer hold would block other agents for the rest of a run. */
export const CLAIM_TTL_MAX_MS = 10 * 60_000;

export const CLAIM_USAGE = `usage: weft claim --keys path#symbol[,path#symbol…] [--firm] [--ttl MS] (1..${CLAIM_TTL_MAX_MS}, default: the deployment claim TTL)

Claim symbols you are about to write. A plain claim is soft: another agent's overlapping edit
only gets a warning. --firm makes an overlapping edit by a junior change an error (blocked).`;

/**
 * `claim --keys path#sym[,…] [--firm] [--ttl MS]`. Keys are validated against the protocol's
 * symbol-key grammar; the claim is soft unless --firm is given (spec §7.5).
 */
export function parseClaim(args: string[]): ClaimCommand {
  const raw = arg(args, "keys");
  const keys = (raw ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error("claim: which symbols? pass --keys path#symbol[,…]");
  for (const k of keys) parseKey(k);
  // A present --ttl must carry a value: a bare flag would otherwise fall back to the default
  // lifetime and report success.
  const hasTtl = args.includes("--ttl");
  const ttl = arg(args, "ttl");
  const ttl_ms = hasTtl ? Number(ttl) : undefined;
  if (hasTtl && (!Number.isInteger(ttl_ms) || ttl_ms! < 1 || ttl_ms! > CLAIM_TTL_MAX_MS))
    throw new Error(`claim: --ttl must be a whole number of milliseconds from 1 to ${CLAIM_TTL_MAX_MS} (got ${JSON.stringify(ttl ?? "")})`);
  return { keys, firm: args.includes("--firm"), ...(ttl_ms !== undefined ? { ttl_ms } : {}) };
}

async function claimCmd(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${CLAIM_USAGE}\n`);
    return 0;
  }
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stderr.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return 2;
  }
  let cmd: ClaimCommand;
  try {
    cmd = parseClaim(args);
  } catch (err) {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const r = await adapterFor(loaded).claim(currentSession(loaded.root) ?? "cli", cmd);
  process.stdout.write(`${r.text}\n`);
  return r.code;
}

async function inboxCmd(args: string[]): Promise<number> {
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stderr.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return 2;
  }
  const wait = Number(arg(args, "wait") ?? 0) || 0;
  const r = await adapterFor(loaded).inbox(currentSession(loaded.root) ?? "cli", wait);
  process.stdout.write(`${r.text}\n`);
  return r.code;
}

function status(): void {
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stdout.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return;
  }
  const { config, root } = loaded;
  process.stdout.write(`${JSON.stringify({ root, ...config, token: "(set)" }, null, 2)}\n`);
  try {
    for (const f of readdirSync(stateDir(root)).filter((x) => x.endsWith(".json"))) {
      const st = readState(root, f.replace(/\.json$/, ""));
      process.stdout.write(`session ${st.claudeSession}: wcp ${st.wcpSession ?? "-"} base #${st.base} acked ${st.acked}${st.rebaseFloor ? ` floor #${st.rebaseFloor.seq}` : ""}\n`);
    }
  } catch {
    /* no state yet */
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "hook":
      return hook();
    case "install":
      return install(args);
    case "commit-msg":
      return commitMsg(args[0]);
    case "pre-commit":
      process.exitCode = await preCommit();
      return;
    case "heartbeat-loop":
      return heartbeatLoop(args[0], arg(args, "root"));
    case "status":
      return status();
    case "negotiate":
      process.exitCode = await negotiateCmd(args);
      return;
    case "inbox":
      process.exitCode = await inboxCmd(args);
      return;
    case "claim":
      process.exitCode = await claimCmd(args);
      return;
    default:
      process.stderr.write("usage: weft-adapter-claude install --url URL --repo REPO --agent ID --task ID [--title T] [--priority N] [--prefix P] [--mode enforce|advise] [--shared]\n       weft-adapter-claude hook|commit-msg FILE|pre-commit|status\n       weft-adapter-claude negotiate …|inbox|claim --keys K[,K] [--firm] [--ttl MS] (see negotiate --help, claim --help)\n");
      process.exitCode = cmd ? 2 : 0;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-claude(\.mjs)?$/.test(entry)) {
  main().catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
