// Adapter configuration and per-Codex-session state, both under `<checkout>/.weft/`
// (excluded from git by the installer). Hook processes are short-lived and may run
// concurrently (parallel tool calls), so state is a JSON file guarded by a lock dir.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pickCliSession, type CliSessionPick, type CliSessionState } from "@weft/protocol";

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
  /** Consecutive Stop refusals for the same open errors before letting Codex stop anyway. */
  maxStopRefusals?: number;
  timeoutMs?: number;
};

export type Loaded = { root: string; config: AdapterConfig; token: string };

export const CONFIG_REL = ".weft/codex.json";

/** Walk up from `start` to the first directory holding `.weft/codex.json`. */
export function findRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(start: string, env: NodeJS.ProcessEnv = process.env): Loaded | undefined {
  const root = env.WEFT_ROOT ? resolve(env.WEFT_ROOT) : findRoot(start);
  if (!root) return undefined;
  let config: AdapterConfig;
  try {
    config = JSON.parse(readFileSync(join(root, CONFIG_REL), "utf8")) as AdapterConfig;
  } catch {
    return undefined;
  }
  if (env.WEFT_URL) config.url = env.WEFT_URL;
  if (env.WEFT_MODE === "advise" || env.WEFT_MODE === "enforce") config.mode = env.WEFT_MODE;
  let token = env.WEFT_TOKEN ?? "";
  if (!token) {
    try {
      token = readFileSync(resolve(root, config.tokenFile ?? ".weft/token"), "utf8").trim();
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
  /** Bash snapshot: dirty files that could not be read before the call (never submitted by it). */
  unreadable?: string[];
  at: number;
};

export type SessionState = {
  codexSession: string;
  wcpSession?: string;
  /** Agent and change `wcpSession` was opened for (set at hello), so another agent's CLI never acts in it (#18). */
  agent?: string;
  change?: string;
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
  /** Claim limits from the last welcome (bounds `weft claim --ttl`, spec §7.5). */
  claimLimits?: { claim_ttl_ms: number; claims?: { lease_ms: number; firm_max_ms: number } };
};

export function stateDir(root: string): string {
  return join(root, ".weft", "state");
}

function statePath(root: string, codexSession: string): string {
  return join(stateDir(root), `${codexSession.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readState(root: string, codexSession: string): SessionState {
  try {
    const st = JSON.parse(readFileSync(statePath(root, codexSession), "utf8")) as SessionState;
    // Several adapters share .weft/state/ in one checkout (npx @celador/weft installs all of
    // them), and `.weft/bin/weft` is one adapter's CLI: a file another adapter wrote names its
    // session under its own key (claudeSession). Keep the id it was read by, or writeState throws.
    if (typeof st.codexSession !== "string") st.codexSession = codexSession;
    return st;
  } catch {
    return { codexSession, base: 0, acked: 0, pending: {}, lastContact: 0 };
  }
}

export function writeState(root: string, state: SessionState): void {
  mkdirSync(stateDir(root), { recursive: true });
  const path = statePath(root, state.codexSession);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
  writeFileSync(join(stateDir(root), "current"), state.codexSession);
}

/**
 * The session `.weft/bin/weft negotiate | claim | inbox` acts in for `agent` (protocol
 * cli-session.ts): never another agent's session in a shared checkout (#18). Reads every
 * adapter's state files here (their session id is under `claudeSession` or `codexSession`).
 */
export function cliSession(root: string, agent: string, change: string, explicit?: string): CliSessionPick {
  const dir = stateDir(root);
  let marker: string | undefined;
  try {
    marker = readFileSync(join(dir, "current"), "utf8").trim() || undefined;
  } catch {
    /* no marker */
  }
  const states: CliSessionState[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    /* no state yet */
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const id = typeof raw.claudeSession === "string" ? raw.claudeSession : typeof raw.codexSession === "string" ? raw.codexSession : f.replace(/\.json$/, "");
      states.push({ session: id, ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}), mtimeMs: statSync(join(dir, f)).mtimeMs });
    } catch {
      /* a file being written or not a state file */
    }
  }
  return pickCliSession({ agent, change, ...(marker ? { marker } : {}), states, ...(explicit !== undefined ? { explicit } : {}) });
}

/** Most recently active Codex session in this checkout (used by git hooks). */
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
export async function withLock<T>(root: string, codexSession: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  mkdirSync(stateDir(root), { recursive: true });
  const lock = `${statePath(root, codexSession)}.lock`;
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
