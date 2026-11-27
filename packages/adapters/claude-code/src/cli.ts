// `weft-adapter-claude` CLI (bundled to dist/weft-claude.mjs).
//
//   install        configure a checkout: .weft/claude.json (+ token file), .claude/settings.json
//                  hooks, git commit-msg (Change-Id/Task-Id/Agent-Id trailers) + pre-commit gate
//   hook           Claude Code hook entry: JSON on stdin -> JSON on stdout (always exit 0)
//                  --root W --url U --repo R: a per-worktree weft-worker subagent; every call
//                  (edits, Bash, its Stop = SubagentStop) acts for worktree W. Edits in another
//                  checkout and Bash commands that do not start in W are denied.
//                  --by-path --url U --repo R: find the checkout from the edited file first
//                  (weft-worker subagents). Only a checkout whose config has exactly that url,
//                  repo and mode (--mode, default enforce) is trusted; a Bash command with no
//                  accepted cd/git -C target, and an edit through a symlink, are denied.
//                  Worker hooks reconcile, after a Bash call, every joined checkout the command
//                  names (read opaquely), and log a config that exists but does not load.
//   install-agent  write .claude/agents/weft-worker[-<worktree>].md: a subagent whose own hooks run
//                  `hook --root W|--by-path --url U --repo R --mode M`, pinned to the parent session's config
//   commit-msg F   git commit-msg hook
//   pre-commit     git pre-commit hook (last gate: refuses while the session has open errors)
//   heartbeat-loop keep a WCP session alive between hooks (spawned detached by SessionStart)
//   lsp-daemon     language-server enrichment for this checkout (spawned detached by the first
//                  hook that has work for it; src/lsp.ts). WEFT_LSP=off disables it.
//   status         print config (never the token) and session state
//   negotiate …    the agent's shell command for WCP negotiation (propose/accept/reject/counter/escalate)
//   inbox          print what is waiting for this agent (inbox, open errors, negotiations owed)
//   claim          explicit claim on symbols: claim --keys path#sym[,…] [--firm] [--ttl MS]
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_USAGE, NEGOTIATE_USAGE, parseClaim, parseNegotiate, takeSessionFlag } from "@weft/protocol";
import { HttpTransport, type Transport } from "./client";
import { BASH_TARGET_FORMS, CONFIG_REL, appendAdapterLog, bashTargetDir, checkoutOf, configStarts, excludeFromGit, pinFromArgs, withoutPinnedOverrides, currentSession, cliSession, findRoot, loadConfig, loadConfigResult, hasDotDot, namedCheckouts, pinMatches, throughSymlink, readConfigFile, readState, stateDir, unjoinedWorktree, type AdapterConfig, type Loaded, type Pin } from "./config";
import { EDIT_TOOLS, editPath } from "./edits";
import { ClaudeAdapter, type HookInput, type HookOutput } from "./hooks";
import { flushJobs, type LspJob } from "./lsp-queue";
import { stableNodePath } from "./node-path";
import { recordPin } from "./pins";
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

function adapterFor(loaded: Loaded, calls?: Call[], lspJobs?: LspJob[], worker = false): ClaudeAdapter {
  const http = new HttpTransport(loaded.config.url, loaded.token, loaded.config.repo, loaded.config.timeoutMs ?? 8000);
  const transport = calls ? timed(http, calls) : http;
  return new ClaudeAdapter(loaded, {
    transport,
    analyze: async (changes, root, prefix) => (await import("./analysis")).analyzeChangesAsync(changes, root, prefix),
    diff: async (rel, before, after) => (await import("./analysis")).unifiedDiff(rel, before, after),
    cli: cliFor(loaded.root),
    ...(lspJobs ? { lsp: (job: LspJob) => void lspJobs.push(job) } : {}),
    startHeartbeat: (claudeSession) => spawnHeartbeat(SELF, claudeSession, loaded.root),
    ...(worker ? { worker: true } : {}),
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
/** The one command that joins `worktree` to the enforcing checkout `owner` (its config `cfg`). `task` = the WCP task. */
function joinWords(worktree: string, owner: string, cfg: Partial<AdapterConfig>, task: string): string[] {
  const words = [`${owner}/.weft/bin/weft`, "install", "--dir", worktree, "--url", cfg.url ?? "", "--repo", cfg.repo ?? "",
    "--agent", cfg.agent ?? "", "--task", task, "--mode", "enforce", "--token-from", resolve(owner, cfg.tokenFile ?? ".weft/token")];
  return cfg.prefix ? [...words, "--prefix", cfg.prefix] : words;
}

const JOIN_TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Denial for an edit or command in a linked worktree that has not joined Weft while the checkout it
 * belongs to enforces. Names the one command that joins it (no secret in it: the token is copied
 * from the owner's token file by the adapter itself).
 */
export function unjoinedDenial(worktree: string, owner: string, cfg: Partial<AdapterConfig>): string {
  const cmd = joinWords(worktree, owner, cfg, "TASK").map((w) => (w === "TASK" ? "<task id>" : shellQuote(w))).join(" ");
  return `[weft] ${worktree} is a git worktree of ${owner}, which enforces Weft, but it has not joined Weft yet (no .weft/claude.json of its own), so edits and commands here are refused. Join it first (exactly this command, with your task id): ${cmd}`;
}

/** Shell words of a command made only of bare, '...' and "..." words (no expansion, no operators); undefined otherwise. */
export function plainWords(command: string): string[] | undefined {
  if (/[;&|`$<>()\n\r\\]/.test(command)) return undefined;
  const words: string[] = [];
  const re = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))(?=\s|$)/y;
  let i = 0;
  const rest = command.trimEnd();
  while (i < rest.length) {
    re.lastIndex = i;
    const m = re.exec(rest);
    if (!m) return undefined;
    words.push(m[1] ?? m[2] ?? m[3]!);
    i = re.lastIndex;
  }
  return words;
}

/**
 * True when a Bash command in an unjoined worktree is THE join (the owner's launcher, `install`,
 * this worktree, the owner's url/repo/agent/prefix/token file, `--mode enforce`, any task id: no
 * other flag, nothing else on the line), or works outside that worktree. Any other install (say
 * `--mode advise`) would let the agent switch enforcement off, so it is refused like the rest.
 */
export function unjoinedAllows(command: string, cwd: string, worktree: string, owner: string, cfg: Partial<AdapterConfig> = readConfigFile(owner) ?? {}): boolean {
  const words = plainWords(command.trim());
  if (words && words.length >= 2 && words[1] === "install") {
    const task = words[words.indexOf("--task") + 1] ?? "";
    const want = joinWords(worktree, owner, cfg, task);
    const flags = (ws: string[]) => {
      const m = new Map<string, string>();
      for (let i = 2; i < ws.length; i += 2) {
        if (!ws[i]!.startsWith("--") || m.has(ws[i]!) || i + 1 >= ws.length) return undefined;
        m.set(ws[i]!, ws[i + 1]!);
      }
      return m;
    };
    const got = flags(words);
    const exp = flags(want)!;
    // every planned flag present (so no other flag fits in the same count) with its planned value
    const same = !!got && got.size === exp.size && [...exp].every(([k, v]) => got.has(k) && (k === "--dir" ? resolve(cwd, got.get(k)!) === v : got.get(k) === v));
    return words[0] === want[0] && JOIN_TASK.test(task) && same && !!cfg.url && !!cfg.repo && !!cfg.agent;
  }
  const target = bashTargetDir(command, cwd);
  return !!target && target !== worktree && !target.startsWith(worktree + sep);
}

/** `--by-path` note when the checkout's config does not match the pinned coordinator. */
export const BY_PATH_REFUSED =
  "[weft] This checkout is not coordinated: its .weft/claude.json does not match the coordinator this subagent is pinned to (see .weft/log/adapter.log). Work only in the worktree you were given.";

/** `--pinned` note when the checkout's config does not match the coordinator the user chose. */
export const PINNED_REFUSED =
  "[weft] Weft is off in this checkout: its .weft/claude.json does not match the coordinator chosen when Weft was set up here (see .weft/log/adapter.log). Run `npx @celador/weft` in a checkout you trust to turn it on.";

/** Worker-hook note when a checkout's config exists but does not load (the reason is logged in that checkout). */
export const NOT_LOADED =
  "[weft] This checkout is not coordinated: its .weft/claude.json exists but does not load (the reason is in its .weft/log/adapter.log). This call was not checked; ask for the worktree to be joined again.";

/** `--root` denial: an edit outside the worktree the worker is bound to, inside another git checkout. */
export function rootBound(root: string): string {
  return `[weft] You are bound to the worktree ${root}. This file is in another git checkout, so the edit is refused: edit files only under ${root}, by that absolute path (no symlink, no \`..\`).`;
}

/** `--root` denial: a Bash command that does not start in the worktree the worker is bound to. */
export function rootBashTarget(root: string): string {
  return `[weft] You are bound to the worktree ${root}. Start every Bash command with \`cd ${shellQuote(root)} && ...\` (or \`git -C ${shellQuote(root)} ...\`), using exactly that absolute path. Accepted forms: ${BASH_TARGET_FORMS}.`;
}

/** `--root` denial: the agent file names a worktree that is not the top of a git checkout. */
export function rootInvalid(root: string): string {
  return `[weft] This worker's hooks name ${root} as its worktree, but that is not the top of a git checkout (or the path has a symlink or a \`..\`), so nothing it does can be coordinated. Re-run \`install-agent --worktree <absolute worktree path>\`.`;
}

/** `--root` note: the worker's worktree has not joined Weft. */
export function rootUnjoined(root: string): string {
  return `[weft] ${root} has not joined Weft (no .weft/claude.json), so this call is not coordinated. Join it (\`install --dir ${shellQuote(root)} ...\`) before giving it to a worker.`;
}

type Route = { out?: HookOutput; starts: string[] };

const denyPre = (reason: string): HookOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/**
 * Other joined checkouts a worker's Bash command names (read opaquely, see namedCheckouts): each
 * is reconciled after the command as its own agent. The session's own checkout (the cwd's) is left
 * out: the session's settings hooks already reconcile it, also inside subagents.
 */
function extraCheckouts(command: string, cwd: string, have: string[]): string[] {
  const own = checkoutOf(cwd);
  return namedCheckouts(command).filter((r) => !have.includes(r) && r !== own && existsSync(join(r, CONFIG_REL)) && !throughSymlink(r));
}

/** `hook --by-path`: the edited file's (or the Bash target's) own checkout, plus every other one the command names. */
function routeByPath(input: HookInput, cwd: string, command: string): Route {
  const pre = input.hook_event_name === "PreToolUse";
  const bash = input.tool_name === "Bash";
  const bashDir = pre && bash ? bashTargetDir(command, cwd) : undefined;
  const file = pre && EDIT_TOOLS.has(input.tool_name ?? "") ? editPath(input.tool_input ?? {}) : undefined;
  const target = bashDir ?? (file ? resolve(cwd, file) : undefined);
  // Fail closed: a command with no accepted target is not run, and no checkout is coordinated for it.
  if (pre && bash && !bashDir) return { out: denyPre(BASH_NEEDS_TARGET), starts: [] };
  // The checkout is found lexically: through a link, the write (or the config) would be another checkout's.
  if (target && ((file && hasDotDot(file)) || throughSymlink(target))) return { out: denyPre(BY_PATH_SYMLINK), starts: [] };
  const starts = configStarts(input, true);
  // Fail closed: a leading target in no joined checkout coordinates nothing, while the rest of the command may write one.
  if (pre && bash && !starts.length) return { out: denyPre(BASH_NEEDS_TARGET), starts: [] };
  // Case-insensitive: on macOS and Windows defaults `.WEFT/token` is the same file.
  if (file && starts.some((root) => relative(root, resolve(cwd, file)).split(sep)[0]!.toLowerCase() === ".weft")) return { out: denyPre(BY_PATH_WEFT_DIR), starts: [] };
  return { starts: bash ? [...starts, ...extraCheckouts(command, cwd, starts)] : starts };
}

/**
 * `hook --root <worktree>` (a per-worktree weft-worker): the worktree is given, not inferred, so
 * calls without a file path (Bash, the worker's Stop = SubagentStop) act for it too. Edits in
 * another checkout and Bash commands that start elsewhere are refused.
 */
function routeRoot(input: HookInput, rootArg: string, cwd: string, command: string): Route {
  const pre = input.hook_event_name === "PreToolUse";
  const edit = EDIT_TOOLS.has(input.tool_name ?? "");
  const bash = input.tool_name === "Bash";
  const refuse = (reason: string): Route => ({ out: pre && (edit || bash) ? denyPre(reason) : undefined, starts: [] });
  const root = resolve(rootArg);
  if (!isAbsolute(rootArg) || hasDotDot(rootArg) || checkoutOf(root) !== root || throughSymlink(root)) return refuse(rootInvalid(rootArg));
  if (edit) {
    const file = editPath(input.tool_input ?? {});
    if (!file) return { starts: [] };
    const target = resolve(cwd, file);
    if (pre && (hasDotDot(file) || throughSymlink(target))) return refuse(BY_PATH_SYMLINK);
    const home = checkoutOf(target);
    // A file in no checkout at all (a scratch file in /tmp) is not this hook's business.
    if (home !== root) return home ? refuse(rootBound(root)) : { starts: [] };
    if (relative(root, target).split(sep)[0]!.toLowerCase() === ".weft") return refuse(BY_PATH_WEFT_DIR);
    return { starts: [root] };
  }
  if (bash && pre) {
    const dir = bashTargetDir(command, cwd);
    if (!dir || checkoutOf(dir) !== root) return refuse(rootBashTarget(root));
    if (throughSymlink(dir)) return refuse(BY_PATH_SYMLINK);
  }
  // Bash is reconciled opaquely: the whole worktree, whatever the command did in it, plus every other joined checkout it names.
  return { starts: bash ? [root, ...extraCheckouts(command, cwd, [root])] : [root] };
}

/** One answer from several checkouts' answers: any deny or block wins; context is concatenated. */
export function mergeOutputs(event: string, outs: HookOutput[]): HookOutput {
  const list = outs.filter((o): o is Record<string, any> => !!o);
  if (list.length <= 1) return list[0];
  const denies = list.filter((o) => o.hookSpecificOutput?.permissionDecision === "deny");
  if (denies.length) return denyPre(denies.map((o) => o.hookSpecificOutput.permissionDecisionReason).join("\n\n"));
  const blocks = list.filter((o) => o.decision === "block");
  if (blocks.length) return { decision: "block", reason: blocks.map((o) => o.reason).join("\n\n") };
  const ctx = list.map((o) => o.hookSpecificOutput?.additionalContext).filter((t): t is string => typeof t === "string" && !!t);
  return ctx.length ? { hookSpecificOutput: { hookEventName: event, additionalContext: ctx.join("\n") } } : undefined;
}

/** Add notes to a PreToolUse answer that is not a denial. */
function withNotes(out: HookOutput, notes: string[]): HookOutput {
  if (!notes.length) return out;
  const o = (out ?? {}) as Record<string, any>;
  if (o.hookSpecificOutput?.permissionDecision === "deny") return out;
  const ctx = [o.hookSpecificOutput?.additionalContext, ...new Set(notes)].filter(Boolean).join("\n");
  return { ...o, hookSpecificOutput: { ...(o.hookSpecificOutput ?? {}), hookEventName: "PreToolUse", additionalContext: ctx } };
}

async function hook(args: string[] = []): Promise<void> {
  let out: HookOutput;
  let input: HookInput | undefined;
  const loaded: Loaded[] = [];
  const calls: Call[] = [];
  const lspJobs = new Map<string, LspJob[]>();
  const handleStart = performance.now();
  // `--pinned` (the plugin): the cwd's checkout, trusted only through the pin. `--by-path` (a subagent): the edited
  // file's checkout, same rule. `--root <worktree>` (a per-worktree subagent): that worktree, same rule.
  const rootArg = arg(args, "root");
  const byPath = args.includes("--by-path");
  const pinned = args.includes("--pinned");
  const pin: Pin | undefined = pinFromArgs(args);
  const worker = byPath || rootArg !== undefined;
  const how = rootArg !== undefined ? "--root" : byPath ? "--by-path" : "--pinned";
  try {
    input = JSON.parse(await readStdin()) as HookInput;
    // Inside a subagent the hook still gets the parent session's id: each worker gets its own state and WCP session.
    if (worker && typeof input.agent_id === "string" && input.agent_id) input = { ...input, session_id: `${input.session_id}.agent-${input.agent_id}` };
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const pre = input.hook_event_name === "PreToolUse";
    const route: Route = rootArg !== undefined ? routeRoot(input, rootArg, cwd, command) : byPath ? routeByPath(input, cwd, command) : { starts: configStarts(input, false) };
    out = route.out;
    const notes: string[] = [];
    if (!out) {
      for (const start of route.starts) {
        if (!worker) {
          // The session's own checkout (plain, or the plugin's --pinned): first match only.
          const found = pinned ? loadConfig(start, withoutPinnedOverrides(process.env, true), CONFIG_REL, true) : loadConfig(start);
          if (!found) continue;
          if (pinned && !pinMatches(found.root, pin)) {
            appendAdapterLog(found.root, `hook --pinned refused: ${found.root}/${CONFIG_REL} url/repo/mode do not match the pinned coordinator`);
            notes.push(PINNED_REFUSED);
            break;
          }
          loaded.push(found);
          break;
        }
        // A worker: every routed checkout, each trusted only through the pin. A config that exists but does not
        // load is logged in that checkout and the call is not coordinated there (never another checkout's agent).
        if (rootArg !== undefined && !existsSync(join(start, CONFIG_REL))) continue;
        const r = loadConfigResult(start, withoutPinnedOverrides(process.env), CONFIG_REL, true);
        if (!r.root || loaded.some((l) => l.root === r.root)) continue;
        if (!r.loaded || (rootArg !== undefined && r.root !== start)) {
          appendAdapterLog(r.root, `hook ${how}: ${join(r.root, CONFIG_REL)} exists but does not load (${r.problem ?? "it is not this worktree's"}); ${input.hook_event_name} ${input.tool_name ?? ""} not coordinated`);
          notes.push(NOT_LOADED);
          continue;
        }
        if (!pinMatches(r.root, pin)) {
          // A checkout whose config does not match the pinned coordinator is not coordinated.
          appendAdapterLog(r.root, `hook ${how} refused: ${r.root}/${CONFIG_REL} url/repo/mode do not match the pinned coordinator`);
          notes.push(BY_PATH_REFUSED);
          continue;
        }
        loaded.push(r.loaded);
      }
    }
    if (!loaded.length && !out && !notes.length && pre && (EDIT_TOOLS.has(input.tool_name ?? "") || input.tool_name === "Bash")) {
      // A linked worktree without its own config borrows nothing (findRoot), but if the checkout it
      // belongs to enforces, `git worktree add` must not switch enforcement off: refuse until it joins.
      const file = EDIT_TOOLS.has(input.tool_name ?? "") ? editPath(input.tool_input ?? {}) : undefined;
      const target = input.tool_name === "Bash" ? bashTargetDir(command, cwd) : file ? resolve(cwd, file) : undefined;
      const starts = rootArg !== undefined ? route.starts : byPath && target ? [file ? dirname(target) : target] : configStarts(input, byPath);
      for (const start of starts.length ? starts : [cwd]) {
        const u = unjoinedWorktree(start);
        const owner = u ? readConfigFile(u.owner) : undefined;
        if (!u || !owner || owner.mode === "advise") continue;
        if ((worker || pinned) && !pinMatches(u.owner, pin)) continue;
        if (input.tool_name === "Bash" && unjoinedAllows(command, cwd, u.worktree, u.owner, owner)) continue;
        appendAdapterLog(u.owner, `hook refused ${input.tool_name} in unjoined worktree ${u.worktree}`);
        out = denyPre(unjoinedDenial(u.worktree, u.owner, owner));
        break;
      }
      if (!out && rootArg !== undefined && route.starts.length) notes.push(rootUnjoined(route.starts[0]!));
    }
    // Copilot CLI also runs `.claude/settings*.json` hooks. In a checkout where the Copilot
    // adapter is installed it owns the session; answering here too would double every event.
    const mine = process.env.COPILOT_CLI === "1" ? loaded.filter((l) => !existsSync(join(l.root, ".weft/copilot.json"))) : loaded;
    loaded.splice(0, loaded.length, ...mine);
    if (!out && loaded.length) {
      const outs: HookOutput[] = [];
      for (const l of loaded) {
        const jobs: LspJob[] = [];
        lspJobs.set(l.root, jobs);
        outs.push(await adapterFor(l, calls, jobs, worker).handle(input));
      }
      out = mergeOutputs(input.hook_event_name, outs);
    }
    if (pre && notes.length) out = withNotes(out, notes);
  } catch {
    out = undefined; // fail open: malformed input or a bug must not block the harness
  }
  if (out) process.stdout.write(JSON.stringify(out));
  const lspStart = performance.now();
  for (const l of loaded) {
    const jobs = lspJobs.get(l.root) ?? [];
    if (jobs.length) flushJobs(l, jobs, SELF);
  }
  const allJobs = [...lspJobs.values()].flat();
  const lspMs = allJobs.length ? Math.round(performance.now() - lspStart) : undefined;
  if (loaded.length && input) {
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
        // Time spent handing jobs to the language-server daemon (queue write, daemon spawn).
        ...(lspMs !== undefined ? { lsp_ms: lspMs, lsp_jobs: allJobs.map((j) => j.type) } : {}),
        decision: o?.hookSpecificOutput?.permissionDecision ?? o?.decision,
        injected_chars: injected.length,
        weft_chars: /\[weft/.test(injected) ? injected.length : 0,
        // WEFT_HOOK_TRACE=1: keep the verbatim injected text (demo evidence; may quote code)
        ...(process.env.WEFT_HOOK_TRACE === "1" && injected ? { injected } : {}),
        ...(loaded.length > 1 ? { checkouts: loaded.length } : {}),
      };
      for (const l of loaded) {
        mkdirSync(join(l.root, ".weft", "log"), { recursive: true });
        appendFileSync(join(l.root, ".weft", "log", "hooks.jsonl"), JSON.stringify(rec) + "\n");
      }
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
/**
 * Permission rules that let the agent run its own Weft command (`.weft/bin/weft inbox`,
 * `negotiate ...`) without a prompt. Without them a headless `claude -p --permission-mode
 * acceptEdits` agent is refused every Weft command and can't answer the squiggle (2026-10 cold run).
 */
export function weftAllowRules(cliPaths: string[]): string[] {
  return [...new Set([CLI_REL, ...cliPaths])].map((p) => `Bash(${p}:*)`);
}

export function mergeSettings(settings: Record<string, unknown>, command: string, allow: string[] = []): Record<string, unknown> {
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
  if (!allow.length) return { ...settings, hooks };
  const perms = { ...((settings.permissions as Record<string, unknown>) ?? {}) };
  const had = Array.isArray(perms.allow) ? (perms.allow as unknown[]).filter((r) => !(typeof r === "string" && r.includes(CLI_REL))) : [];
  perms.allow = [...had, ...allow];
  return { ...settings, permissions: perms, hooks };
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
  // The plugin trusts this checkout's config only through what the user chose here, kept outside the repo.
  // Only an explicit --url/--repo counts: a config that was already in the checkout is not a choice.
  if (arg(args, "url") && arg(args, "repo")) recordPin(root, "claude-code", { url: config.url, repo: config.repo, mode: config.mode ?? "enforce" });
  // The token: WEFT_TOKEN, or --token-from <file> (another checkout's token file, e.g. the main
  // checkout's when a kanban worktree joins: the caller never has to read the token itself).
  const tokenFrom = arg(args, "token-from");
  const tokenValue = process.env.WEFT_TOKEN?.trim() || (tokenFrom ? readFileSync(resolve(tokenFrom), "utf8").trim() : "");
  if (tokenFrom && !tokenValue) throw new Error(`install: --token-from ${tokenFrom} is empty`);
  if (tokenValue) {
    const tokenPath = resolve(root, config.tokenFile!);
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, tokenValue + "\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  }

  // .weft/ (token, state, logs) and local hook settings never enter git
  excludeFromGit(root, [".weft/", ".claude/settings.local.json"]);

  // Claude Code hooks. Default: .claude/settings.local.json (machine-specific absolute paths,
  // never committed); --shared writes the committed .claude/settings.json instead.
  const command = `${shellQuote(stableNodePath())} ${shellQuote(SELF)} hook`;
  const settingsPath = join(root, ".claude", args.includes("--shared") ? "settings.json" : "settings.local.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>) : {};
  const cliAbs = join(root, CLI_REL);
  let cliReal = cliAbs;
  try {
    cliReal = join(realpathSync(root), CLI_REL);
  } catch {
    // keep the path as given
  }
  writeFileSync(settingsPath, JSON.stringify(mergeSettings(settings, command, weftAllowRules([cliAbs, cliReal])), null, 2) + "\n");

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
  const hasToken = existsSync(resolve(root, config.tokenFile!)) || !!tokenValue;
  process.stdout.write(
    `weft: installed Claude Code adapter in ${root}\n` +
      `  coordinator ${config.url} repo ${config.repo} agent ${config.agent} task ${config.task.id} change ${config.change}\n` +
      `  hooks: ${settingsPath}\n  git hooks: ${hooksDir}/commit-msg, pre-commit\n  agent cli: ${cliPath}\n` +
      (hasToken ? "" : `  NOTE: no token yet — write it to ${config.tokenFile} (mode 600) or export WEFT_TOKEN\n`),
  );
}

type AgentHook = { matcher?: string; command: string };

/** The hooks a worker definition registers. `root`: the per-worktree worker, which also gates its stop (frontmatter `Stop` runs as SubagentStop). */
function workerHooks(command: string, root?: string): Record<string, AgentHook[]> {
  // Bash too: a shell edit (sed, heredoc, redirect) is reconciled against the worktree after it runs.
  const edits = "Edit|Write|MultiEdit|Bash";
  return {
    PreToolUse: [{ matcher: edits, command }],
    PostToolUse: [{ matcher: edits, command }],
    PostToolUseFailure: [{ matcher: root ? edits : "Bash", command }],
    ...(root ? { Stop: [{ command }] } : {}),
  };
}

function workerDescription(root?: string): string {
  return root
    ? `Implements one task inside the Weft-joined git worktree ${root}. Give it the task; its edits, commits and stop are checked by the Weft coordinator as that worktree's agent.`
    : "Implements one task inside its own Weft-joined git worktree. Give it the absolute worktree path and the task; its edits are checked by the Weft coordinator as that worktree's agent.";
}

function workerPrompt(root?: string): string {
  if (!root)
    return `
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
  const q = shellQuote(root);
  return `
You work on one task inside the git worktree ${root}, which is joined to Weft.

- Edit only files under ${root}, always by that absolute path and never through a symlink or a
  \`..\`. Weft checks each edit as this worktree's agent; an edit in another checkout is refused.
- Start every Bash command with \`cd ${q} && …\` (or use \`git -C ${q} …\`); a command that starts
  anywhere else is refused. \`git commit\` is refused while Weft has open errors.
- If an edit is denied with \`[weft error]\`, do not retry it unchanged: the diagnostic says what
  to do next.
- You cannot finish while Weft errors are open: fix the cited code (or retreat from it), then stop.
- \`${root}/.weft/bin/weft inbox\` shows what is waiting for you.
`;
}

/** The subagent definition `install-agent` writes: its own hooks, running `command` (the pinned `hook --by-path`, or `hook --root <worktree>`). */
export function workerAgent(command: string, name = "weft-worker", root?: string): string {
  const q = JSON.stringify(command);
  const hooks = Object.entries(workerHooks(command, root))
    .map(([event, entries]) => `  ${event}:\n${entries.map((e) => `    - ${e.matcher !== undefined ? `matcher: "${e.matcher}"\n      ` : ""}hooks:\n        - type: command\n          command: ${q}\n          timeout: 30`).join("\n")}`)
    .join("\n");
  // JSON strings are YAML double-quoted scalars: a worktree path with `:` or `#` stays one value.
  const description = root ? JSON.stringify(workerDescription(root)) : workerDescription();
  return `---\nname: ${name}\ndescription: ${description}\nhooks:\n${hooks}\n---\n${workerPrompt(root)}`;
}

/** The same definition as `claude --agents` JSON (a session started with `-p` skips project agents' frontmatter hooks until the folder is trusted). */
export function workerAgentJson(command: string, name = "weft-worker", root?: string): Record<string, unknown> {
  const hooks = Object.fromEntries(Object.entries(workerHooks(command, root)).map(([event, entries]) => [event, entries.map((e) => ({ ...(e.matcher !== undefined ? { matcher: e.matcher } : {}), hooks: [{ type: "command", command: e.command, timeout: 30 }] }))]));
  return { [name]: { description: workerDescription(root), prompt: workerPrompt(root).trimStart(), hooks } };
}

/** Refuse to write through a symlinked `.claude`, `.claude/agents` or agent file: the hook-bearing file must land in this checkout. */
export function refuseSymlinks(root: string, rels: string[]): void {
  for (const rel of rels) {
    let link = false;
    try {
      link = lstatSync(join(root, rel)).isSymbolicLink();
    } catch {
      /* not there yet */
    }
    if (link) throw new Error(`install-agent: ${join(root, rel)} is a symlink; refusing to write the hook-bearing agent file through it`);
  }
}

/**
 * `install-agent [--dir D] [--worktree W] [--name N] [--url U --repo R [--mode M]] [--print-json]`:
 * write the pinned weft-worker subagent into D's `.claude/agents/` (where a session started in D
 * finds it). With --worktree, a per-worktree worker (`weft-worker-<dir name>`) whose hooks run
 * `hook --root W`; without it, the by-path worker that infers its worktree from each path.
 * --print-json prints the definition for `claude --agents` instead of writing it.
 */
function installAgent(args: string[]): void {
  const dir = resolve(arg(args, "dir") ?? process.cwd());
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const wtArg = arg(args, "worktree");
  let worktree: string | undefined;
  if (wtArg !== undefined) {
    if (!isAbsolute(wtArg) || hasDotDot(wtArg)) throw new Error("install-agent: --worktree must be an absolute path with no `..`");
    worktree = resolve(wtArg);
    const top = git(worktree, ["rev-parse", "--show-toplevel"]);
    // The hook compares paths lexically: keep the path as given, but it must be the checkout's top and not a link.
    if (realpathSync(top) !== realpathSync(worktree) || throughSymlink(worktree)) throw new Error(`install-agent: --worktree ${worktree} is not the top of a git checkout (or it is a symlink); its top is ${top}`);
  }
  const name = arg(args, "name") ?? (worktree ? `weft-worker-${basename(worktree).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48)}` : "weft-worker");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`install-agent: --name must be letters, digits, - or _ (got ${JSON.stringify(name)})`);
  // The coordinator the subagent may act for: the parent session's own config when it has one,
  // else --url and --repo. Every worker hook must match it (config.ts pinMatches).
  const parentRoot = findRoot(dir);
  const parent = parentRoot ? readConfigFile(parentRoot) : undefined;
  const pin: Pin | undefined = parent?.url && parent.repo
    ? { url: parent.url, repo: parent.repo, mode: parent.mode === "advise" ? "advise" : "enforce" }
    : arg(args, "url") && arg(args, "repo") ? { url: arg(args, "url")!, repo: arg(args, "repo")!, mode: arg(args, "mode") === "advise" ? "advise" : "enforce" } : undefined;
  if (!pin) throw new Error("install-agent: no coordinator to pin: the parent session has no .weft/claude.json; pass --url and --repo");
  const pinned = `--url ${shellQuote(pin.url)} --repo ${shellQuote(pin.repo)} --mode ${pin.mode}`;
  const command = `${shellQuote(process.execPath)} ${shellQuote(SELF)} hook ${worktree ? `--root ${shellQuote(worktree)}` : "--by-path"} ${pinned}`;
  if (worktree) {
    const wc = readConfigFile(worktree);
    if (!wc) process.stderr.write(`weft: ${worktree} has not joined Weft yet: run \`install --dir ${shellQuote(worktree)} ...\` before starting ${name}\n`);
    else if (!pinMatches(worktree, pin)) process.stderr.write(`weft: ${worktree}/${CONFIG_REL} names another coordinator (url/repo/mode) than this session; ${name}'s hooks will refuse it until it is joined to ${pin.url} repo ${pin.repo}\n`);
  }
  if (args.includes("--print-json")) {
    process.stdout.write(`${JSON.stringify(workerAgentJson(command, name, worktree))}\n`);
    return;
  }
  const rel = `.claude/agents/${name}.md`;
  refuseSymlinks(root, [".claude", ".claude/agents", rel]);
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  refuseSymlinks(root, [".claude", ".claude/agents", rel]); // nothing swapped in while the directories were made
  writeFileSync(path, workerAgent(command, name, worktree));
  // absolute machine paths: keep it out of git, like settings.local.json
  excludeFromGit(root, [rel]);
  process.stdout.write(
    worktree
      ? `weft: wrote subagent ${path}\n  start the ${name} subagent from a session in ${root} for work in ${worktree} (its edits, Bash commands, commits and stop act as that worktree's agent)\n`
      : `weft: wrote subagent ${path}\n  run \`weft-adapter-claude install\` in each worktree, then start a ${name} subagent per worktree\n`,
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

async function lspDaemon(rootArg?: string): Promise<void> {
  const loaded = loadConfig(rootArg ?? process.cwd());
  if (!loaded) return;
  const { LspWorker, runDaemon } = await import("./lsp");
  const transport = new HttpTransport(loaded.config.url, loaded.token, loaded.config.repo, loaded.config.timeoutMs ?? 8000);
  await runDaemon(loaded.root, new LspWorker(loaded, { transport }));
}

async function heartbeatLoop(args: string[]): Promise<void> {
  const { session, root, parent } = loopArgs(args);
  const loaded = loadConfig(root ?? process.cwd());
  if (!loaded) return;
  const adapter = adapterFor(loaded);
  await runHeartbeatLoop({ root: loaded.root, session, parent, beat: (idle) => adapter.beat(session, idle) });
}

/**
 * The session the agent's own command acts in: never another agent's in a shared checkout (#18).
 * `--session <id>|new` names it. A number is the exit code (the reason is on stderr).
 */
function cliSessionFor(loaded: Loaded, explicit: string | undefined): string | number {
  const pick = cliSession(loaded.root, loaded.config.agent, loaded.config.change, explicit);
  if ("refused" in pick) {
    process.stderr.write(`${pick.refused}\n`);
    return 2;
  }
  return pick.session;
}

/** Strip `--session <id>` before a subcommand parser sees the arguments. */
function sessionFlag(args: string[]): { explicit?: string; rest: string[] } | number {
  const t = takeSessionFlag(args);
  if (t.error) {
    process.stderr.write(`weft: ${t.error}\n`);
    return 2;
  }
  return t;
}

async function negotiateCmd(argv: string[]): Promise<number> {
  const flagged = sessionFlag(argv);
  if (typeof flagged === "number") return flagged;
  const args = flagged.rest;
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
  const session = cliSessionFor(loaded, flagged.explicit);
  if (typeof session === "number") return session;
  const r = await adapterFor(loaded).negotiate(session, cmd);
  process.stdout.write(`${r.text}\n`);
  return r.code;
}

async function claimCmd(argv: string[]): Promise<number> {
  const flagged = sessionFlag(argv);
  if (typeof flagged === "number") return flagged;
  const args = flagged.rest;
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
  const session = cliSessionFor(loaded, flagged.explicit);
  if (typeof session === "number") return session;
  const r = await adapterFor(loaded).claim(session, cmd);
  (r.code === 2 ? process.stderr : process.stdout).write(`${r.text}\n`);
  return r.code;
}

async function inboxCmd(argv: string[]): Promise<number> {
  const flagged = sessionFlag(argv);
  if (typeof flagged === "number") return flagged;
  const args = flagged.rest;
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stderr.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return 2;
  }
  const wait = Number(arg(args, "wait") ?? 0) || 0;
  const session = cliSessionFor(loaded, flagged.explicit);
  if (typeof session === "number") return session;
  const r = await adapterFor(loaded).inbox(session, wait);
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
      return hook(args);
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
    case "lsp-daemon":
      return lspDaemon(arg(args, "root"));
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
      process.stderr.write("usage: weft-adapter-claude install --url URL --repo REPO --agent ID --task ID [--title T] [--priority N] [--prefix P] [--mode enforce|advise] [--token-from FILE] [--shared]\n       weft-adapter-claude hook [--root W|--by-path --url U --repo R [--mode M]]|install-agent [--dir D] [--worktree W] [--name N] [--url U --repo R [--mode M]] [--print-json]|commit-msg FILE|pre-commit|status\n       weft-adapter-claude negotiate …|inbox (see negotiate --help)\n       weft-adapter-claude claim --keys path#symbol[,…] [--firm] [--ttl MS]\n");
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
