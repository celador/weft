// Adapter configuration and per-Claude-session state, both under `<checkout>/.weft/`
// (excluded from git by the installer). Hook processes are short-lived and may run
// concurrently (parallel tool calls), so state is a JSON file guarded by a lock dir.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * True when `dir` is a linked git worktree: its `.git` is a file whose gitdir lives in
 * `<common git dir>/worktrees/` (a submodule's points into `modules/` instead).
 */
export function isLinkedWorktree(dir: string): boolean {
  try {
    const dotgit = join(dir, ".git");
    if (!lstatSync(dotgit).isFile()) return false;
    const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotgit, "utf8").slice(0, 4096));
    return !!m && basename(dirname(resolve(dir, m[1]!))) === "worktrees";
  } catch {
    return false;
  }
}

/** The main checkout of a linked git worktree (its gitdir's `commondir`), else undefined. */
export function mainOfLinkedWorktree(dir: string): string | undefined {
  try {
    const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(join(dir, ".git"), "utf8").slice(0, 4096));
    if (!m) return undefined;
    const gitdir = resolve(dir, m[1]!);
    if (basename(dirname(gitdir)) !== "worktrees") return undefined;
    const common = existsSync(join(gitdir, "commondir")) ? resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()) : dirname(dirname(gitdir));
    return basename(common) === ".git" ? dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `start` lies in a linked git worktree that has no config of its own, while the checkout it would
 * have borrowed one from does (the checkout above it, e.g. `<main>/.worktrees/<task>` inside
 * `<main>`, else the worktree's main checkout). `findRoot` gives such a worktree no config (it must
 * not report or stamp as the main checkout's task), so the hook uses this to refuse edits there when
 * that checkout enforces: creating a worktree must not be a way around enforcement.
 */
export function unjoinedWorktree(start: string, configRel: string = CONFIG_REL): { worktree: string; owner: string } | undefined {
  let worktree: string | undefined;
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, configRel))) return worktree ? { worktree, owner: dir } : undefined;
    if (!worktree && isLinkedWorktree(dir)) worktree = dir;
    if (dirname(dir) === dir) break;
  }
  const main = worktree ? mainOfLinkedWorktree(worktree) : undefined;
  return worktree && main && existsSync(join(main, configRel)) ? { worktree, owner: main } : undefined;
}

/**
 * Walk up from `start` to the first directory holding `.weft/claude.json`. The walk stops at a
 * linked git worktree without its own config (Claude Code's config only): kanban worktrees live inside the main checkout
 * (`<main>/.worktrees/<task>`), and borrowing the main checkout's config there would report the
 * worktree's edits, and stamp its commits (the shared commit-msg hook), as the main checkout's
 * task and change. Such a worktree is not coordinated until it joins (`install --dir <worktree>`);
 * until then the hook refuses edits there when the main checkout enforces (`unjoinedWorktree`).
 */
export function findRoot(start: string, configRel: string = CONFIG_REL): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, configRel))) return dir;
    // Claude Code's own config only: its hook refuses edits in such a worktree (unjoinedWorktree).
    // Hosts on other configs (host.ts) have no such refusal yet and keep inheriting, so a worktree
    // never switches their enforcement off.
    if (configRel === CONFIG_REL && isLinkedWorktree(dir)) return undefined;
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
 * Gemini) cannot import cli.ts. `configRel` names the adapter's config (`.weft/claude.json` here,
 * `.weft/<harness>.json` for the others, which route through `routeTargets`).
 */
export function configStarts(input: HookInput, byPath: boolean, fallback: string = process.cwd(), configRel: string = CONFIG_REL): string[] {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? fallback;
  if (!byPath) return [cwd];
  const target = callTargets(input, cwd)[0];
  if (target === undefined) return [cwd];
  // Only the target's own checkout counts: an unjoined worktree nested inside a joined one must
  // not resolve to its parent's agent.
  // The target's checkout has no config: not coordinated. Falling back to the cwd would attribute the edit to the parent agent.
  // A checkout with a config is only ever its own: no fallback to the cwd if its config fails to load.
  const own = checkoutOf(resolve(cwd, target));
  return own && existsSync(join(own, configRel)) ? [own] : [];
}

/**
 * What a Claude-shaped hook call writes or works in, for path routing: the edited file, or a Bash
 * command's leading target (`bashTargetDir`). Empty for every other call (Stop, SessionStart, a
 * Bash command that names no accepted target). Paths are as given (maybe relative to `cwd`).
 */
export function callTargets(input: HookInput, cwd: string): string[] {
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const file = editPath(ti);
  if (file) return [file];
  const dir = input.tool_name === "Bash" && typeof ti.command === "string" ? bashTargetDir(ti.command, cwd) : undefined;
  return dir ? [dir] : [];
}

/** How `routeTargets` routed one hook call. */
export type PathRoute =
  /** Act in the session's own checkout, exactly as without `--by-path`. */
  | { kind: "plain" }
  /** Act in another joined checkout, as that checkout's agent (its config matched the pin). */
  | { kind: "routed"; loaded: Loaded }
  /** The call's own checkout has a config that does not load or does not match the pin: not coordinated (logged there). */
  | { kind: "refused"; root: string; problem: string }
  /** One call writes into more than one checkout (a multi-file patch): each needs its own agent. */
  | { kind: "split"; roots: string[] };

/**
 * `hook --by-path --url U --repo R [--mode M]` for adapters whose ONE hook configuration serves a
 * session and the work it delegates (Cursor, OpenCode, Gemini, Codex; opt-in with `install
 * --by-path`). Delegated work runs in the session's directory, so the session's checkout is the
 * wrong agent for an edit inside another joined worktree. Each target path counts for its own
 * checkout (the nearest directory holding `.git`, as in `configStarts`):
 *   - in another checkout that joined with `configRel`: that checkout, loaded with the env
 *     overrides dropped (a parent's WEFT_TOKEN must not act as the worktree) and the token kept
 *     under its `.weft/`, and trusted only when its url/repo/mode equal the pin. A repo can ship
 *     its own `.weft/`, so an unpinned config never receives diffs.
 *   - anywhere else (the session's own checkout, an unjoined checkout, no checkout, a path with a
 *     `..` or through a symlink, whose checkout cannot be told lexically): plain, i.e. exactly
 *     what the hook did before `--by-path`. Routing never makes a call less coordinated than that,
 *     except that a joined checkout whose config is broken or unpinned is not coordinated at all
 *     rather than reported as the session's agent.
 * Targets in two checkouts (or one routed checkout plus the session's own) are `split`.
 */
export function routeTargets(targets: string[], cwd: string, pin: Pin | undefined, configRel: string, env: NodeJS.ProcessEnv = process.env): PathRoute {
  const plainRoot = env.WEFT_ROOT ? resolve(env.WEFT_ROOT) : findRoot(cwd, configRel);
  const routed = new Set<string>();
  let plainHit = false;
  for (const raw of targets) {
    const abs = resolve(cwd, raw);
    const own = hasDotDot(raw) || throughSymlink(abs) ? undefined : checkoutOf(abs);
    if (own && own !== plainRoot && existsSync(join(own, configRel))) routed.add(own);
    else if (plainRoot && !relative(plainRoot, abs).startsWith("..") && !isAbsolute(relative(plainRoot, abs))) plainHit = true;
  }
  if (!routed.size) return { kind: "plain" };
  if (routed.size > 1 || plainHit) return { kind: "split", roots: [...routed, ...(plainHit && plainRoot ? [plainRoot] : [])] };
  const root = [...routed][0]!;
  const r = loadConfigResult(root, withoutPinnedOverrides(env), configRel, true);
  if (!r.loaded || r.root !== root) {
    const problem = `${join(root, configRel)} exists but does not load (${r.problem ?? "it is not this checkout's"})`;
    appendAdapterLog(root, `hook --by-path: ${problem}; call not coordinated`);
    return { kind: "refused", root, problem };
  }
  if (!pinMatches(root, pin, configRel)) {
    const problem = `${join(root, configRel)} url/repo/mode do not match the pinned coordinator`;
    appendAdapterLog(root, `hook --by-path refused: ${problem}`);
    return { kind: "refused", root, problem };
  }
  return { kind: "routed", loaded: r.loaded };
}

/** `install --by-path`: the hook arguments that turn path routing on, pinned to the coordinator this checkout joined (see `routeTargets`). */
export function byPathHookArgs(config: Pick<AdapterConfig, "url" | "repo" | "mode">): string[] {
  return ["--by-path", "--url", config.url, "--repo", config.repo, "--mode", config.mode ?? "enforce"];
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
export function withoutPinnedOverrides(env: NodeJS.ProcessEnv, keepToken = false): NodeJS.ProcessEnv {
  const { WEFT_URL: _url, WEFT_ROOT: _root, WEFT_MODE: _mode, WEFT_TOKEN: token, ...rest } = env;
  return keepToken && token ? { ...rest, WEFT_TOKEN: token } : rest;
}

/** The pin a `hook --by-path|--pinned` was started with: `--url U --repo R [--mode advise]`. Undefined unless both are given. */
export function pinFromArgs(args: string[]): Pin | undefined {
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = get("url");
  const repo = get("repo");
  return url && repo ? { url, repo, mode: get("mode") === "advise" ? "advise" : "enforce" } : undefined;
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
export function pinMatches(root: string, pin: Pin | undefined, configRel: string = CONFIG_REL): boolean {
  const c = readConfigFile(root, configRel);
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
  return loadConfigResult(start, env, configRel, confineToken).loaded;
}

/**
 * `loadConfig` with the reason it failed. `root` is set once a checkout with a config file was
 * found, so a caller can log a config that exists but does not load into that checkout's own
 * `.weft/log` (`problem` never contains the token).
 */
export function loadConfigResult(start: string, env: NodeJS.ProcessEnv = process.env, configRel: string = CONFIG_REL, confineToken = false): { loaded?: Loaded; root?: string; problem?: string } {
  const root = env.WEFT_ROOT ? resolve(env.WEFT_ROOT) : findRoot(start, configRel);
  if (!root) return { problem: "no config" };
  let config: AdapterConfig;
  try {
    if (confineToken && !lstatSync(join(root, dirname(configRel))).isDirectory()) return { root, problem: `${dirname(configRel)} is not a directory` };
    if (confineToken && !lstatSync(join(root, configRel)).isFile()) return { root, problem: `${configRel} is not a regular file` };
    config = JSON.parse(readFileSync(join(root, configRel), "utf8")) as AdapterConfig;
    if (!config || typeof config !== "object") return { root, problem: `${configRel} is not a JSON object` }; // `null` or a number is not a config
  } catch (err) {
    return { root, problem: `${configRel} is unreadable or not JSON (${err instanceof SyntaxError ? "invalid JSON" : (err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (env.WEFT_URL) config.url = env.WEFT_URL;
  if (env.WEFT_MODE === "advise" || env.WEFT_MODE === "enforce") config.mode = env.WEFT_MODE;
  let token = env.WEFT_TOKEN ?? "";
  let tokenProblem = "no token (empty or missing token file)";
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
    } catch (err) {
      token = "";
      if (err instanceof Error && !(err as NodeJS.ErrnoException).code) tokenProblem = `token not read: ${err.message}`;
    }
  }
  const missing: string[] = (["url", "repo", "agent", "change"] as const).filter((k) => !config[k]);
  if (!config.task?.id) missing.push("task.id");
  if (missing.length) return { root, problem: `${configRel} lacks ${missing.join(", ")}` };
  if (!token) return { root, problem: tokenProblem };
  return { loaded: { root, config, token }, root };
}

/**
 * Append lines to the checkout's `info/exclude` (what never enters git: `.weft/`, machine-specific
 * hook settings, generated agent files). One helper for every installer; lines already there are kept once.
 */
export function excludeFromGit(root: string, lines: string[]): void {
  const exclude = resolve(root, execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim());
  mkdirSync(dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const have = new Set(ex.split("\n"));
  const want = [...new Set(lines)].filter((l) => !have.has(l));
  if (want.length) writeFileSync(exclude, `${ex}${ex && !ex.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`);
}

/** The git checkout holding `path`: the nearest directory, `path` itself included, that has a `.git`. Lexical (no symlinks resolved). */
export function checkoutOf(path: string): string | undefined {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) return p;
    if (dirname(p) === p) return undefined;
  }
}

/**
 * Every git checkout a shell command names, read OPAQUELY: any absolute or `~/` path anywhere in
 * the text (after any `cd`, in a subshell, on a later line, inside quotes) counts, whatever the
 * shell would make of it. The hook reconciles each of these checkouts after the command instead
 * of parsing the shell. Paths with a `..` segment are skipped (resolved after symlinks, not lexically).
 */
export function namedCheckouts(command: string, max = 64): string[] {
  const tokens = new Set<string>();
  for (const t of command.split(/[\s'"`;&|<>()=,]+/)) tokens.add(t);
  for (const m of command.matchAll(/'([^']*)'|"([^"]*)"/g)) tokens.add(m[1] ?? m[2] ?? "");
  const roots: string[] = [];
  for (const raw of tokens) {
    if (roots.length >= max) break;
    const t = raw.trim(); // `--file=/x` and `2>/x` were split at `=` and `>` above
    const abs = t.startsWith("~/") ? join(homedir(), t.slice(2)) : t === "~" ? homedir() : t.startsWith("/") ? t : undefined;
    if (!abs || hasDotDot(abs)) continue;
    const root = checkoutOf(abs);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * The config for a hook that runs with a pin (`hook --pinned`, the plugin path), FAILING CLOSED:
 * undefined unless the checkout's own config equals the pin. Env overrides that would move the
 * coordinator (WEFT_URL, WEFT_ROOT, WEFT_MODE) are ignored, and the token must stay under `.weft/`.
 * A repo-shipped `.weft/` can therefore never redirect diffs to a server the user did not choose.
 */
export function loadPinned(start: string, pin: Pin | undefined, env: NodeJS.ProcessEnv = process.env, configRel: string = CONFIG_REL): Loaded | undefined {
  if (!pin) return undefined;
  const found = loadConfig(start, withoutPinnedOverrides(env, true), configRel, true);
  return found && pinMatches(found.root, pin, configRel) ? found : undefined;
}

export type PendingEdit = {
  tool: string;
  /** checkout-relative path -> text before the tool ran (null = file did not exist). */
  before: Record<string, string | null>;
  /** Context already shown to the model by PreToolUse for this call (avoid repeats). */
  shown: string[];
  /** Files that existed but could not be read before the tool ran: never submitted for this call. */
  unreadable?: string[];
  /**
   * Edit tools: sha256 of the text the edit will leave (when it can be derived). A parallel Bash
   * call's reconcile leaves a file in this exact state to this edit's own PostToolUse, so the
   * change is submitted once.
   */
  expect?: string;
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
  /** Lines from the asynchronous language-server enrichment (src/lsp.ts) for the next hook to inject. */
  lspNotes?: string[];
  /** Inbox seqs already sent to the enrichment daemon for a breakage check (dedupe redeliveries). */
  lspSeen?: number[];
};

export function stateDir(root: string): string {
  return join(root, ".weft", "state");
}

function statePath(root: string, claudeSession: string): string {
  return join(stateDir(root), `${claudeSession.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readState(root: string, claudeSession: string): SessionState {
  try {
    const st = JSON.parse(readFileSync(statePath(root, claudeSession), "utf8")) as SessionState;
    // Several adapters share .weft/state/ in one checkout (npx @celador/weft installs all of
    // them), and `.weft/bin/weft` is one adapter's CLI: a file another adapter wrote names its
    // session under its own key (codexSession). Keep the id it was read by, or writeState throws.
    if (typeof st.claudeSession !== "string") st.claudeSession = claudeSession;
    return st;
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
