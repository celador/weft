// `weft-adapter-claude` CLI (bundled to dist/weft-claude.mjs).
//
//   install        configure a checkout: .weft/claude.json (+ token file), .claude/settings.json
//                  hooks, git commit-msg (Change-Id/Task-Id/Agent-Id trailers) + pre-commit gate
//   hook           Claude Code hook entry: JSON on stdin -> JSON on stdout (always exit 0)
//                  --by-path --url U --repo R: find the checkout from the edited file first
//                  (weft-worker subagents). Only a checkout whose config has exactly that url,
//                  repo and mode (--mode, default enforce) is trusted; a Bash command with no
//                  accepted cd/git -C target, and an edit through a symlink, are denied.
//   install-agent  write .claude/agents/weft-worker.md: a subagent whose own hooks run
//                  `hook --by-path --url U --repo R --mode M`, pinned to the parent session's config
//   commit-msg F   git commit-msg hook
//   pre-commit     git pre-commit hook (last gate: refuses while the session has open errors)
//   heartbeat-loop keep a WCP session alive between hooks (spawned detached by SessionStart)
//   status         print config (never the token) and session state
//   negotiate …    the agent's shell command for WCP negotiation (propose/accept/reject/counter/escalate)
//   inbox          print what is waiting for this agent (inbox, open errors, negotiations owed)
//   claim          explicit claim on symbols: claim --keys path#sym[,…] [--firm] [--ttl MS]
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_USAGE, NEGOTIATE_USAGE, parseClaim, parseNegotiate } from "@weft/protocol";
import { HttpTransport, type Transport } from "./client";
import { BASH_TARGET_FORMS, CONFIG_REL, appendAdapterLog, bashTargetDir, configStarts, withoutPinnedOverrides, currentSession, findRoot, loadConfig, hasDotDot, pinMatches, throughSymlink, readConfigFile, readState, stateDir, type AdapterConfig, type Loaded, type Pin } from "./config";
import { EDIT_TOOLS, editPath } from "./edits";
import { ClaudeAdapter, type HookInput } from "./hooks";
import { stableNodePath } from "./node-path";
import { loopArgs, runHeartbeatLoop, spawnHeartbeat } from "./heartbeat";

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
    analyze: async (changes, root, prefix) => (await import("./analysis")).analyzeChangesAsync(changes, root, prefix),
    diff: async (rel, before, after) => (await import("./analysis")).unifiedDiff(rel, before, after),
    cli: cliFor(loaded.root),
    startHeartbeat: (claudeSession) => spawnHeartbeat(SELF, claudeSession, loaded.root),
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

/** The one denial `--by-path` gives a Bash command that names no accepted target. */
export const BASH_NEEDS_TARGET =
  `[weft] This Bash command names no checkout Weft can coordinate. Start the command with \`cd <worktree> &&\` (or \`git -C <worktree> ...\`), using the absolute worktree path. Accepted forms: ${BASH_TARGET_FORMS}.`;
/** `--by-path` denial for an edit or Bash target that reaches its checkout through a symlink or a `..`. */
export const BY_PATH_SYMLINK =
  "[weft] This path goes through a symlink or a `..` segment, so Weft cannot tell which checkout it writes to. Use the real absolute path of the file (or worktree), with no symlink and no `..` in it.";
/** `--by-path` denial for an edit inside a joined checkout's own `.weft/` (its config and token). */
export const BY_PATH_WEFT_DIR =
  "[weft] Files under the worktree's .weft/ are Weft's own (its config and token); a subagent does not edit them.";
/** `--by-path` note when the checkout's config does not match the pinned coordinator. */
export const BY_PATH_REFUSED =
  "[weft] This checkout is not coordinated: its .weft/claude.json does not match the coordinator this subagent is pinned to (see .weft/log/adapter.log). Work only in the worktree you were given.";

async function hook(byPath: boolean, args: string[] = []): Promise<void> {
  let out: unknown;
  let input: HookInput | undefined;
  let loaded: Loaded | undefined;
  const calls: Call[] = [];
  const handleStart = performance.now();
  const pinMode = arg(args, "mode") === "advise" ? "advise" : "enforce";
  const pin: Pin | undefined = arg(args, "url") && arg(args, "repo") ? { url: arg(args, "url")!, repo: arg(args, "repo")!, mode: pinMode } : undefined;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const pre = byPath && input.hook_event_name === "PreToolUse";
    const bashDir = pre && input.tool_name === "Bash" ? bashTargetDir(command, cwd) : undefined;
    const file = pre && EDIT_TOOLS.has(input.tool_name ?? "") ? editPath(input.tool_input ?? {}) : undefined;
    const target = bashDir ?? (file ? resolve(cwd, file) : undefined);
    if (pre && input.tool_name === "Bash" && !bashDir) {
      // Fail closed: a command with no accepted target is not run, and no checkout is coordinated for it.
      out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BASH_NEEDS_TARGET } };
    } else if (target && ((file && hasDotDot(file)) || throughSymlink(target))) {
      // The checkout is found lexically: through a link, the write (or the config) would be another checkout's.
      out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BY_PATH_SYMLINK } };
    } else if (pre && input.tool_name === "Bash" && !configStarts(input, true).length) {
      // Fail closed: a leading target in no joined checkout coordinates nothing, while the rest of the command may write one.
      out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BASH_NEEDS_TARGET } };
    } else if (file && configStarts(input, true).some((root) => relative(root, resolve(cwd, file)).split(sep)[0]!.toLowerCase() === ".weft")) {
      // Case-insensitive: on macOS and Windows defaults `.WEFT/token` is the same file.
      out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BY_PATH_WEFT_DIR } };
    } else {
      for (const start of configStarts(input, byPath)) {
        const found = byPath ? loadConfig(start, withoutPinnedOverrides(process.env), CONFIG_REL, true) : loadConfig(start);
        if (!found) continue;
        if (byPath && !pinMatches(found.root, pin)) {
          // A checkout whose config does not match the pinned coordinator is not coordinated.
          appendAdapterLog(found.root, `hook --by-path refused: ${found.root}/${CONFIG_REL} url/repo/mode do not match the pinned coordinator`);
          if (input.hook_event_name === "PreToolUse") out = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: BY_PATH_REFUSED } };
          break;
        }
        loaded = found;
        break;
      }
    }
    // Copilot CLI also runs `.claude/settings*.json` hooks. In a checkout where the Copilot
    // adapter is installed it owns the session; answering here too would double every event.
    if (loaded && process.env.COPILOT_CLI === "1" && existsSync(join(loaded.root, ".weft/copilot.json"))) loaded = undefined;
    if (loaded && input) out = await adapterFor(loaded, calls).handle(input);
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
    // A tool that fails partway (e.g. a shell command that edits, then errors) fires this
    // instead of PostToolUse; its edits are reconciled the same way.
    PostToolUseFailure: ours("Bash|Edit|Write|MultiEdit"),
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
  writeFileSync(cliPath, `#!/bin/sh\n# ${HOOK_MARK}: Weft CLI for the agent in this checkout (negotiate, inbox, claim)\nexec ${shellQuote(stableNodePath())} ${shellQuote(SELF)} "$@"\n`, { mode: 0o755 });
  chmodSync(cliPath, 0o755);
  const hasToken = existsSync(resolve(root, config.tokenFile!)) || !!process.env.WEFT_TOKEN;
  process.stdout.write(
    `weft: installed Claude Code adapter in ${root}\n` +
      `  coordinator ${config.url} repo ${config.repo} agent ${config.agent} task ${config.task.id} change ${config.change}\n` +
      `  hooks: ${settingsPath}\n  git hooks: ${hooksDir}/commit-msg, pre-commit\n  agent cli: ${cliPath}\n` +
      (hasToken ? "" : `  NOTE: no token yet — write it to ${config.tokenFile} (mode 600) or export WEFT_TOKEN\n`),
  );
}

/** The subagent definition `install-agent` writes: its own hooks, running `command` (the pinned `hook --by-path`). */
export function workerAgent(command: string, name = "weft-worker"): string {
  const q = JSON.stringify(command);
  // Bash too: a shell edit (sed, heredoc, redirect) is reconciled against the worktree after it runs.
  const edits = "Edit|Write|MultiEdit|Bash";
  return `---
name: ${name}
description: Implements one task inside its own Weft-joined git worktree. Give it the absolute worktree path and the task; its edits are checked by the Weft coordinator as that worktree's agent.
hooks:
  PreToolUse:
    - matcher: "${edits}"
      hooks:
        - type: command
          command: ${q}
          timeout: 30
  PostToolUse:
    - matcher: "${edits}"
      hooks:
        - type: command
          command: ${q}
          timeout: 30
  PostToolUseFailure:
    - matcher: "Bash"
      hooks:
        - type: command
          command: ${q}
          timeout: 30
---

You work on one task inside one git worktree that is joined to Weft (it has \`.weft/claude.json\`).
The task message gives you its absolute path.

- Edit only files under that worktree, always by absolute path and never through a symlink.
  Weft checks each edit as that worktree's agent; edits elsewhere are not coordinated.
- Start every Bash command with \`cd <worktree> && …\` (or use \`git -C <worktree> …\`). Weft finds
  the worktree from that; a command without it is denied ("names no checkout Weft can
  coordinate"), so every command must start with it. Its git \`pre-commit\` hook refuses commits
  while Weft has open errors.
- If an edit is denied with \`[weft error]\`, do not retry it unchanged: the diagnostic says what
  to do next.
- \`<worktree>/.weft/bin/weft inbox\` shows what is waiting for you.
`;
}

/** `install-agent [--dir D] [--name N] [--url U --repo R]`: write the pinned weft-worker subagent. */
function installAgent(args: string[]): void {
  const dir = resolve(arg(args, "dir") ?? process.cwd());
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const name = arg(args, "name") ?? "weft-worker";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`install-agent: --name must be letters, digits, - or _ (got ${JSON.stringify(name)})`);
  // The coordinator the subagent may act for: the parent session's own config when it has one,
  // else --url and --repo. Every by-path hook must match it (config.ts pinMatches).
  const parentRoot = findRoot(dir);
  const parent = parentRoot ? readConfigFile(parentRoot) : undefined;
  const pin: Pin | undefined = parent?.url && parent.repo
    ? { url: parent.url, repo: parent.repo, mode: parent.mode === "advise" ? "advise" : "enforce" }
    : arg(args, "url") && arg(args, "repo") ? { url: arg(args, "url")!, repo: arg(args, "repo")!, mode: arg(args, "mode") === "advise" ? "advise" : "enforce" } : undefined;
  if (!pin) throw new Error("install-agent: no coordinator to pin: the parent session has no .weft/claude.json; pass --url and --repo");
  const path = join(root, ".claude", "agents", `${name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const pinned = `--url ${shellQuote(pin.url)} --repo ${shellQuote(pin.repo)} --mode ${pin.mode}`;
  writeFileSync(path, workerAgent(`${shellQuote(process.execPath)} ${shellQuote(SELF)} hook --by-path ${pinned}`, name));
  // absolute machine paths: keep it out of git, like settings.local.json
  const exclude = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]));
  const rel = `.claude/agents/${name}.md`;
  mkdirSync(dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!ex.split("\n").includes(rel)) writeFileSync(exclude, `${ex}${ex && !ex.endsWith("\n") ? "\n" : ""}${rel}\n`);
  process.stdout.write(`weft: wrote subagent ${path}\n  run \`weft-adapter-claude install\` in each worktree, then start a ${name} subagent per worktree\n`);
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

async function heartbeatLoop(args: string[]): Promise<void> {
  const { session, root, parent } = loopArgs(args);
  const loaded = loadConfig(root ?? process.cwd());
  if (!loaded) return;
  const adapter = adapterFor(loaded);
  await runHeartbeatLoop({ root: loaded.root, session, parent, beat: (idle) => adapter.beat(session, idle) });
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

async function claimCmd(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${CLAIM_USAGE}\n`);
    return args.length ? 0 : 2;
  }
  let cmd;
  try {
    cmd = parseClaim(args);
  } catch (err) {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stderr.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return 2;
  }
  const r = await adapterFor(loaded).claim(currentSession(loaded.root) ?? "cli", cmd);
  (r.code === 2 ? process.stderr : process.stdout).write(`${r.text}\n`);
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
      return hook(args.includes("--by-path"), args);
    case "install-agent":
      return installAgent(args);
    case "install":
      return install(args);
    case "commit-msg":
      return commitMsg(args[0]);
    case "pre-commit":
      process.exitCode = await preCommit();
      return;
    case "heartbeat-loop":
      return heartbeatLoop(args);
    case "status":
      return status();
    case "negotiate":
      process.exitCode = await negotiateCmd(args);
      return;
    case "inbox":
      process.exitCode = await inboxCmd(args);
      break;
    case "claim":
      process.exitCode = await claimCmd(args);
      return;
    default:
      process.stderr.write("usage: weft-adapter-claude install --url URL --repo REPO --agent ID --task ID [--title T] [--priority N] [--prefix P] [--mode enforce|advise] [--shared]\n       weft-adapter-claude hook [--by-path --url U --repo R [--mode M]]|install-agent [--dir D] [--name N] [--url U --repo R [--mode M]]|commit-msg FILE|pre-commit|status\n       weft-adapter-claude negotiate …|inbox (see negotiate --help)\n       weft-adapter-claude claim --keys path#symbol[,…] [--firm] [--ttl MS]\n");
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
