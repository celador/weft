// Which gateway the CLI talks to, and the space it holds there.
//
//   hosted  https://weft-hosted.elier.ai   free spaces, no account (default)
//   local   http://127.0.0.1:8787          `weft --local`: the same gateway on this machine
//   own     your Cloudflare account         `weft deploy`
//
// ~/.config/weft/cli.json (0600) keeps, per gateway URL, the space id and its owner and
// viewer tokens; each checkout keeps a pointer in .weft/space.json and a copy of the owner
// token in .weft/space-token (0600, git-ignored) so the repo can find its space again.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { Api, statusOf } from "./api";
import { packageDist } from "./adapters";
import { c, configDir, info, ok, readJson, readSecret, VERSION, WeftError, which, writeJson, writeSecret } from "./util";

export const HOSTED_URL = "https://weft-hosted.elier.ai";
export const LOCAL_PORT = 7878;
const WRANGLER = "wrangler@4";

export type GatewayState = { kind: "hosted" | "local" | "own"; space?: string; owner?: string; viewer?: string; viewerId?: string; admin?: string; name?: string; created_at?: string };
export type CliState = { default?: string; gateways: Record<string, GatewayState> };

const statePath = (env = process.env) => join(configDir(env), "cli.json");

export function loadState(env = process.env): CliState {
  const s = readJson<CliState>(statePath(env), { gateways: {} });
  s.gateways ??= {};
  return s;
}

export function saveState(s: CliState, env = process.env): void {
  writeJson(statePath(env), s, true);
}

export function kindOf(url: string): GatewayState["kind"] {
  if (url === HOSTED_URL) return "hosted";
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) return "local";
  return "own";
}

export type RepoPointer = { url: string; space: string; repo: string; name: string };

export function readPointer(root: string): RepoPointer | undefined {
  const p = readJson<RepoPointer | null>(join(root, ".weft", "space.json"), null);
  return p && p.url && p.space && p.repo ? p : undefined;
}

// ------------------------------------------------------------------ the Hermes adapter's feed
//
// Hermes kanban workers report through the Hermes adapter (<configDir>/hermes-adapter.json, or
// $WEFT_HERMES_CONFIG) to one gateway: `url`, with each project directory mapped to a repo in
// `projects.repos`. A checkout that sits in such a project already has a feed, so the CLI uses it
// rather than creating a second, empty one in a hosted space. The VS Code extension and the
// hermes-ios relay (Otto) read the same two files, so every client shows the same events.

/** The shared human token file every client reads ({url, token, scopes:["human"], repos:"*"}). */
export const HUMAN_TOKEN_FILE = "otto-human-token.json";

export type HermesPointer = { url: string; repo: string; project: string; config: string };

export function hermesConfigPath(env = process.env): string {
  const p = env.WEFT_HERMES_CONFIG?.trim();
  if (p) return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return join(configDir(env), "hermes-adapter.json");
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The Hermes adapter mapping for any of `dirs` (this checkout, its main checkout), longest project first. */
export function hermesPointer(dirs: string[], env = process.env): HermesPointer | undefined {
  const config = hermesConfigPath(env);
  const cfg = readJson<{ url?: unknown; enabled?: unknown; projects?: { repos?: Record<string, unknown> } } | null>(config, null);
  const url = typeof cfg?.url === "string" ? cfg.url.trim().replace(/\/+$/, "") : "";
  if (!cfg || cfg.enabled === false || !url) return undefined;
  const projects = Object.entries(cfg.projects?.repos ?? {})
    .filter((e): e is [string, string] => typeof e[1] === "string" && !!e[0] && !!e[1])
    .map(([p, repo]) => ({ dir: real(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p), repo }))
    .sort((a, b) => b.dir.length - a.dir.length);
  for (const d of dirs.map(real)) {
    const hit = projects.find((p) => d === p.dir || d.startsWith(p.dir + sep));
    if (hit) return { url, repo: hit.repo, project: hit.dir, config };
  }
  return undefined;
}

/** The shared human token, when it was minted for `url`. */
export function sharedHumanToken(url: string, env = process.env): string | undefined {
  const j = readJson<{ url?: unknown; token?: unknown } | null>(join(configDir(env), HUMAN_TOKEN_FILE), null);
  if (!j || typeof j.url !== "string" || typeof j.token !== "string") return undefined;
  return j.url.replace(/\/+$/, "") === url.replace(/\/+$/, "") ? j.token.trim() || undefined : undefined;
}

export function writePointer(root: string, p: RepoPointer, owner: string): void {
  writeJson(join(root, ".weft", "space.json"), p);
  writeSecret(join(root, ".weft", "space-token"), owner);
}

/** The space for `url`: from cli.json, else from this repo's .weft/space-token, else a new one. */
export async function ensureSpace(api: Api, url: string, root: string, label: string): Promise<{ gw: GatewayState; created: boolean }> {
  const state = loadState();
  const gw: GatewayState = state.gateways[url] ?? { kind: kindOf(url) };
  const tryOwner = async (owner: string | undefined) => {
    if (!owner) return undefined;
    try {
      return (await api.space(owner)).space.id;
    } catch (e) {
      if (statusOf(e) === 401 || statusOf(e) === 403) return undefined;
      throw e;
    }
  };
  let created = false;
  let id = await tryOwner(gw.owner);
  if (!id) {
    const ptr = readPointer(root);
    const repoOwner = ptr?.url === url ? readSecret(join(root, ".weft", "space-token")) : undefined;
    id = await tryOwner(repoOwner);
    if (id) {
      gw.owner = repoOwner;
      delete gw.viewer;
      delete gw.viewerId;
    }
  }
  if (!id) {
    let r;
    try {
      r = await api.createSpace(label, gw.admin);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "rate_limited" || code === "unavailable")
        throw new WeftError(`the hosted gateway could not create a space: ${(e as Error).message}`, "Run your own instead: `npx @celador/weft --local` (this machine) or `npx @celador/weft deploy` (your Cloudflare account).");
      throw e;
    }
    id = r.space.id;
    gw.owner = r.token;
    gw.created_at = r.space.created_at;
    delete gw.viewer;
    delete gw.viewerId;
    created = true;
  }
  gw.space = id;
  if (!gw.viewer) {
    const v = await api.token(gw.owner!, { kind: "viewer", label: "feed link" });
    gw.viewer = v.token;
    gw.viewerId = v.info.id;
  }
  state.gateways[url] = gw;
  saveState(state);
  return { gw, created };
}

export function feedLink(url: string, viewer: string): string {
  return `${url}/feed#t=${encodeURIComponent(viewer)}`;
}

// ------------------------------------------------------------------ local gateway (`--local`)

/**
 * wrangler, installed once into ~/.config/weft/tools and run with the node running us (so a
 * global wrangler or an older node earlier on PATH never gets picked). Offline after the first install.
 */
function wranglerCmd(): { cmd: string; pre: string[] } {
  if (process.env.WEFT_USE_GLOBAL_WRANGLER === "1") {
    const w = which("wrangler");
    if (w) return { cmd: w, pre: [] };
  }
  const tools = join(configDir(), "tools");
  const js = join(tools, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(js)) {
    info(`installing wrangler (Cloudflare's CLI) into ${tools} ${c.dim("(once)")}`);
    mkdirSync(tools, { recursive: true });
    if (!existsSync(join(tools, "package.json"))) writeFileSync(join(tools, "package.json"), '{ "private": true }\n');
    const npm = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
    const r = spawnSync(existsSync(npm) ? npm : "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", tools, WRANGLER], { stdio: ["ignore", "inherit", "inherit"], env: nodeEnv() });
    if (r.status !== 0 || !existsSync(js)) throw new WeftError("installing wrangler failed", `Retry, or install it yourself: npm install --prefix ${tools} ${WRANGLER}`);
  }
  return { cmd: process.execPath, pre: [js] };
}

/** PATH with this node first, so wrangler (and the node it spawns) is the same, supported version. */
function nodeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, WRANGLER_SEND_METRICS: "false" };
}

/** A Worker project for the bundled gateway (coordinator + registry only). */
function writeWorkerProject(dir: string, cfg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const bundle = join(packageDist(), "gateway", "index.js");
  if (!existsSync(bundle)) throw new WeftError("gateway bundle missing from this package", "Reinstall: npx @celador/weft@latest");
  writeFileSync(join(dir, "index.js"), readFileSync(bundle));
  writeJson(join(dir, "wrangler.json"), {
    main: "index.js",
    compatibility_date: "2025-09-06",
    no_bundle: true,
    durable_objects: { bindings: [{ name: "WEFT_REPO", class_name: "RepoCoordinator" }, { name: "WEFT_REGISTRY", class_name: "Registry" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["RepoCoordinator", "Registry"] }],
    ...cfg,
  });
}

async function healthy(url: string): Promise<boolean> {
  try {
    await new Api(url).health();
    return true;
  } catch {
    return false;
  }
}

/** Start (or reuse) the local gateway on 127.0.0.1:8787. State lives in ~/.config/weft/local. */
function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createNetServer();
    srv.once("error", () => done(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => done(true)));
  });
}

export async function startLocal(want?: number): Promise<{ url: string; admin: string }> {
  const dir = join(configDir(), "local");
  let admin = readSecret(join(dir, "admin-token"));
  const last = Number(readSecret(join(dir, "port"))) || undefined;
  let port = want ?? last ?? LOCAL_PORT;
  if (admin && (await healthy(`http://127.0.0.1:${port}`))) return { url: `http://127.0.0.1:${port}`, admin };
  if (!want) for (let i = 0; i < 20 && !(await portFree(port)); i++) port = LOCAL_PORT + 1 + i;
  else if (!(await portFree(port))) throw new WeftError(`port ${port} is in use by another program`, "Pick another: npx @celador/weft --local --url http://127.0.0.1:<port>");
  const url = `http://127.0.0.1:${port}`;
  writeSecret(join(dir, "port"), String(port));
  admin ??= Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  writeSecret(join(dir, "admin-token"), admin);
  // The Worker project gets its own directory: wrangler dev watches it and reloads on any change,
  // so the state and the log live next to it, not inside it.
  const project = join(dir, "worker");
  writeWorkerProject(project, { name: "weft-local", vars: { WEFT_SIGNUPS: "admin" } });
  writeFileSync(join(project, ".dev.vars"), `WEFT_ADMIN_TOKEN=${admin}\n`, { mode: 0o600 });
  const { cmd, pre } = wranglerCmd();
  const log = openSync(join(dir, "gateway.log"), "a");
  info(`starting the local gateway on ${url} ${c.dim("(first start takes ~10 s)")}`);
  const child = spawn(cmd, [...pre, "dev", "--config", join(project, "wrangler.json"), "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"], {
    cwd: project,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...nodeEnv(), CLOUDFLARE_API_TOKEN: "" },
  });
  child.unref();
  writeFileSync(join(dir, "gateway.pid"), String(child.pid));
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    if (await healthy(url)) {
      ok(`local gateway running ${c.dim(`(pid ${child.pid}; logs ${join(dir, "gateway.log")}; stop: npx @celador/weft local stop)`)}`);
      return { url, admin };
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new WeftError("the local gateway did not start", `See ${join(dir, "gateway.log")}`);
}

export async function stopLocal(): Promise<boolean> {
  const pidFile = join(configDir(), "local", "gateway.pid");
  const pid = Number(readSecret(pidFile));
  if (!pid) return false;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return false;
  // wrangler dev runs detached in its own process group (wrangler + workerd): stop the group.
  for (const sig of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {
      /* group gone */
    }
    for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    if (!alive()) break;
  }
  writeFileSync(pidFile, "");
  return !alive();
}

// ------------------------------------------------------------------ your own Cloudflare (`weft deploy`)

function wrangler(args: string[], opts: { cwd: string; input?: string; inherit?: boolean }) {
  const { cmd, pre } = wranglerCmd();
  const env = nodeEnv();
  return spawnSync(cmd, [...pre, ...args], { cwd: opts.cwd, env, encoding: "utf8", ...(opts.input !== undefined ? { input: opts.input } : {}), stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"] });
}

export async function deploy(o: { name: string; domain?: string }): Promise<{ url: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) throw new WeftError("--name must be lowercase letters, digits and '-'");
  const dir = join(configDir(), "deploy", o.name);
  info(`deploying Weft's gateway to your Cloudflare account as Worker ${c.bold(o.name)}`);
  // 1. login (OAuth in the browser) unless a token or a login is already there
  const who = wrangler(["whoami"], { cwd: configDir() });
  if (who.status !== 0 || /not authenticated|You are not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
    info("log in to Cloudflare (a browser window opens)");
    const l = wrangler(["login"], { cwd: configDir(), inherit: true });
    if (l.status !== 0) throw new WeftError("Cloudflare login failed", "Or set CLOUDFLARE_API_TOKEN (Workers Scripts:Edit) and retry.");
  }
  // 2. the Worker: coordinator + registry, Durable Objects with SQLite storage (free plan works)
  writeWorkerProject(dir, {
    name: o.name,
    ...(o.domain ? { workers_dev: false, routes: [{ pattern: o.domain, custom_domain: true }] } : { workers_dev: true }),
    vars: { WEFT_SIGNUPS: "admin" },
    observability: { enabled: true },
  });
  const d = wrangler(["deploy", "--config", join(dir, "wrangler.json")], { cwd: dir });
  const out = `${d.stdout}\n${d.stderr}`;
  if (d.status !== 0) throw new WeftError(`wrangler deploy failed:\n${out.trim().split("\n").slice(-15).join("\n")}`);
  const url = o.domain ? `https://${o.domain}` : (/(https:\/\/[^\s]+\.workers\.dev)/.exec(out)?.[1] ?? "");
  if (!url) throw new WeftError(`deployed, but could not find the Worker's URL in wrangler's output:\n${out.slice(-800)}`);
  // 3. the operator secret (stays on this machine and in the Worker)
  const state = loadState();
  const gw: GatewayState = state.gateways[url] ?? { kind: "own", name: o.name };
  gw.admin ??= Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  let s = wrangler(["secret", "put", "WEFT_ADMIN_TOKEN", "--config", join(dir, "wrangler.json")], { cwd: dir, input: gw.admin });
  // A brand-new Worker can take a few seconds to be visible to the secrets API.
  for (let i = 0; i < 5 && s.status !== 0 && /does not exist|10007/.test(`${s.stdout}${s.stderr}`); i++) {
    await new Promise((r) => setTimeout(r, 4000));
    s = wrangler(["secret", "put", "WEFT_ADMIN_TOKEN", "--config", join(dir, "wrangler.json")], { cwd: dir, input: gw.admin });
  }
  if (s.status !== 0) throw new WeftError(`setting the admin secret failed:\n${(s.stderr || s.stdout).trim().slice(-600)}`);
  state.gateways[url] = gw;
  state.default = url;
  saveState(state);
  writeSecret(join(dir, "admin-token"), gw.admin);
  // 4. wait until it answers. For a custom domain, first wait for public DNS (over HTTPS), so the
  // health poll never asks this machine's resolver too early and gets a cached "no such host".
  const end = Date.now() + 180_000;
  if (o.domain) {
    while (Date.now() < end) {
      try {
        const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(o.domain)}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
        if (((await r.json()) as { Answer?: unknown[] }).Answer?.length) break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  while (Date.now() < end && !(await healthy(url))) await new Promise((r) => setTimeout(r, 3000));
  if (!(await healthy(url))) throw new WeftError(`deployed to ${url}, but it does not answer yet`, "Wait a minute and run `npx @celador/weft` again.");
  // the secret ships as a new version a few seconds after the code: wait until the admin key works
  const api = new Api(url);
  while (Date.now() < end) {
    try {
      await api.call("GET", "/v1/admin/hosted", gw.admin);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  ok(`your gateway is live at ${c.bold(url)} ${c.dim(`(weft ${VERSION})`)}`);
  return { url };
}
