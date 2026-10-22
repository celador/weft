// Where the extension finds its gateway, repo and token for a workspace folder (no vscode
// import here, so it is unit-tested in plain Node).
//
// Token lookup (docs/harness-coverage.md §3.4), first hit wins for reading:
//   1. WEFT_TOKEN in the environment VS Code was started with;
//   2. the checkout's .weft/: `human-token` (a human token you put there), then the adapter's
//      agent token (`tokenFile` in .weft/<adapter>.json, default `.weft/token`);
//   3. ~/.config/weft (written by `npx @celador/weft`): the space's viewer key in cli.json for
//      this gateway, then `<repo>.token`, then `token`;
//   4. the editor's SecretStorage ("Weft: Set token").
// Actions (approve, undo, pause, resume, message) need the `human` scope. They try the same
// list in order and skip a token the gateway answers 403 for, so a human token set with
// "Weft: Set token" works even when the checkout holds an agent token for reading.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_URL = "http://localhost:8787";

export type TokenSource = "env" | "repo" | "config" | "secret";
export type TokenCandidate = { token: string; source: TokenSource; /** Human-readable origin, never the token. */ where: string };

/** What a checkout says about itself in .weft/ (adapter configs, `npx weft` space pointer). */
export type Checkout = {
  root: string;
  url?: string;
  repo?: string;
  /** The checkout's agent, task and WCP change (from an adapter config). */
  agents: { agent: string; change?: string; task?: string; adapter: string }[];
  /** Repo-path prefix of this checkout (adapter `prefix`): repo path = prefix + checkout path. */
  prefix: string;
  tokenFiles: string[];
  /** Which file named url/repo. */
  from?: string;
};

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function readJson(path: string): Json | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

function readSecret(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return str(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads `<root>/.weft/`: `space.json` (npx weft) first, then every adapter config with url + repo. */
export function readCheckout(root: string): Checkout {
  const dir = join(root, ".weft");
  const c: Checkout = { root, agents: [], prefix: "", tokenFiles: [] };
  const space = readJson(join(dir, "space.json"));
  if (space && str(space.url) && str(space.repo)) {
    c.url = str(space.url);
    c.repo = str(space.repo);
    c.from = ".weft/space.json";
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "space.json").sort();
  } catch {
    /* no .weft */
  }
  for (const f of names) {
    const j = readJson(join(dir, f));
    if (!j || !str(j.url) || !str(j.repo)) continue;
    if (!c.url) {
      c.url = str(j.url);
      c.repo = str(j.repo);
      c.from = `.weft/${f}`;
    }
    if (str(j.repo) !== c.repo) continue;
    const task = j.task && typeof j.task === "object" ? str((j.task as Json).id) : str(j.task);
    if (str(j.agent)) c.agents.push({ agent: str(j.agent)!, ...(str(j.change) ? { change: str(j.change)! } : {}), ...(task ? { task } : {}), adapter: f.replace(/\.json$/, "") });
    if (str(j.prefix) && !c.prefix) c.prefix = str(j.prefix)!;
    const tf = str(j.tokenFile) ?? ".weft/token";
    if (!c.tokenFiles.includes(tf)) c.tokenFiles.push(tf);
  }
  if (!c.tokenFiles.includes(".weft/token") && existsSync(join(dir, "token"))) c.tokenFiles.push(".weft/token");
  return c;
}

/** `$WEFT_HOME`, else `$XDG_CONFIG_HOME/weft`, else ~/.config/weft (as `npx weft` does). */
export function configDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.WEFT_HOME) return env.WEFT_HOME;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "weft");
}

export type Resolved = {
  url: string;
  urlFrom: string;
  repo?: string;
  repoFrom?: string;
  checkout?: Checkout;
};

/** Gateway URL and repo: settings, then env, then the checkout's .weft/, then the default. */
export function resolveTarget(o: { settingUrl?: string; settingRepo?: string; env?: NodeJS.ProcessEnv; checkout?: Checkout }): Resolved {
  const env = o.env ?? process.env;
  const c = o.checkout;
  const [url, urlFrom] = str(o.settingUrl)
    ? [str(o.settingUrl)!, "setting weft.url"]
    : str(env.WEFT_URL)
      ? [str(env.WEFT_URL)!, "WEFT_URL"]
      : c?.url
        ? [c.url, c.from ?? ".weft/"]
        : [DEFAULT_URL, "default"];
  const [repo, repoFrom] = str(o.settingRepo)
    ? [str(o.settingRepo), "setting weft.repo"]
    : str(env.WEFT_REPO)
      ? [str(env.WEFT_REPO), "WEFT_REPO"]
      : c?.repo
        ? [c.repo, c.from ?? ".weft/"]
        : [undefined, undefined];
  return { url: url.replace(/\/+$/, ""), urlFrom, ...(repo ? { repo, repoFrom } : {}), ...(c ? { checkout: c } : {}) };
}

/** Every token we can find, in lookup order (de-duplicated). Never logs a token. */
export function tokenCandidates(o: { env?: NodeJS.ProcessEnv; checkout?: Checkout; url: string; repo?: string; secret?: string; home?: string }): TokenCandidate[] {
  const env = o.env ?? process.env;
  const out: TokenCandidate[] = [];
  const push = (token: string | undefined, source: TokenSource, where: string) => {
    if (token && !out.some((t) => t.token === token)) out.push({ token, source, where });
  };
  push(str(env.WEFT_TOKEN), "env", "WEFT_TOKEN");
  if (o.checkout) {
    const root = o.checkout.root;
    push(readSecret(join(root, ".weft", "human-token")), "repo", ".weft/human-token");
    for (const tf of o.checkout.tokenFiles) push(readSecret(resolve(root, tf)), "repo", tf);
  }
  const dir = configDir(env, o.home);
  const cli = readJson(join(dir, "cli.json"));
  const gws = (cli?.gateways ?? {}) as Record<string, Json>;
  const gw = gws[o.url] ?? gws[o.url.replace(/\/+$/, "")];
  push(str(gw?.viewer), "config", "~/.config/weft/cli.json (viewer key)");
  if (o.repo) push(readSecret(join(dir, `${o.repo}.token`)), "config", `~/.config/weft/${o.repo}.token`);
  push(readSecret(join(dir, "token")), "config", "~/.config/weft/token");
  push(str(o.secret), "secret", "Weft: Set token (SecretStorage)");
  return out;
}

/** The checkout-relative path for a repo path (strips the adapter prefix), or undefined if outside. */
export function localPath(repoPath: string, prefix = ""): string | undefined {
  const p = repoPath.replace(/^\/+/, "");
  if (!prefix) return p;
  const pre = prefix.replace(/^\/+/, "").replace(/\/?$/, "/");
  return p.startsWith(pre) ? p.slice(pre.length) : undefined;
}
