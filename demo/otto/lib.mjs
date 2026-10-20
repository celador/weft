// Shared plumbing for the Otto demo lanes (demo/otto/lane.mjs) and the run tools (seed, report).
// Adapted from demo/m2-full.mjs: same gateway API calls, same harness invocations, plus Gemini
// CLI and Hermes candidates. Tokens come from ~/.config/weft (mode 600), the wrangler OAuth
// config, ~/.hermes/auth.json (Claude OAuth, only when `claude auth status` is logged out) and
// ~/.hermes/.env (GEMINI_API_KEY). None is printed or written: `scrub` runs on every log line.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, WEFT_CLI } from "./scenario.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const MAIN_ROOT = join(homedir(), "github/weft"); // node_modules + adapter bundles live in the main checkout
export const SITE = join(homedir(), "github/weft-demo-site");
export const GW = (process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai").replace(/\/+$/, "");
export const WF = (process.env.WEFT_WORKFLOWS_URL ?? "https://weft-workflows-preview.elier.ai").replace(/\/+$/, "");
export const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
export const DEMO_URL = process.env.WEFT_DEMO_SITE_URL ?? "https://weft-demo-site.elier.ai";
export const OC_MODEL = process.env.WEFT_OTTO_OPENCODE_MODEL ?? "opencode/big-pickle";
// Free-tier Gemini quotas are per model and per day, so each card's Gemini agent uses its own model.
const GEMINI_MODELS = { t2: "gemini-3.6-flash", t5: "gemini-3.5-flash", t7: "gemini-3.5-flash-lite" };
export const geminiModel = (key) => process.env[`WEFT_OTTO_GEMINI_MODEL_${String(key).toUpperCase()}`] ?? process.env.WEFT_OTTO_GEMINI_MODEL ?? GEMINI_MODELS[key] ?? "gemini-3.6-flash";
export const TURN_TIMEOUT_MS = 15 * 60_000;

const cfgFile = (f) => readFileSync(join(homedir(), ".config/weft", f), "utf8").trim();
export const TOK = {
  get admin() { return cfgFile("preview-admin-token"); },
  get sys() { return cfgFile("preview-workflows-system-token"); },
  get wf() { return cfgFile("preview-workflows-token"); },
  /** principal john, scope human: the token Otto's Weft panel uses (auto-config) */
  get human() { return JSON.parse(cfgFile("otto-human-token.json")).token; },
};

export const scrub = (s) =>
  String(s)
    .replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***")
    .replace(/wcp_[A-Za-z0-9_-]+/g, "wcp_***")
    .replace(/weft_[A-Za-z0-9_-]{20,}/g, "weft_***")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}/g, "gemini-key-***");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------ HTTP

export async function api(method, path, token, body, expect) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${GW}${path}`, { method, headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      if (attempt < 4) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
    const t = await r.text();
    if (r.status >= 500 && attempt < 3 && method === "GET") {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (expect && ![].concat(expect).includes(r.status)) throw new Error(`${method} ${path} -> ${r.status}: ${scrub(t).slice(0, 600)}`);
    return t ? JSON.parse(t) : {};
  }
}
export async function wf(kind, id) {
  // A dropped connection to the workflow API must not end a lane: retry (run-4 lost t3/t6 to one
  // "fetch failed" while polling BestOfN).
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await wfOnce(kind, id);
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}
async function wfOnce(kind, id) {
  const r = await fetch(`${WF}/v1/workflows/${kind}/${id}`, { headers: { authorization: `Bearer ${TOK.wf}` } });
  if (r.status === 404 || r.status === 400) return { status: "absent", http: r.status };
  return r.json();
}
let cfRefreshed = 0;
export function refreshCf(force = false) {
  if (!force && Date.now() - cfRefreshed < 5 * 60_000) return;
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  spawnSync("npx", ["wrangler", "whoami"], { cwd: join(MAIN_ROOT, "apps/gateway"), env, stdio: "ignore", timeout: 60_000 });
  cfRefreshed = Date.now();
}
export function cfToken() {
  refreshCf();
  return /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"))[1];
}
export async function cf(method, path, body, retried = false) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${cfToken()}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!j.success && !retried && (j.errors ?? []).some((e) => e.code === 10000 || e.code === 9109)) {
    refreshCf(true);
    return cf(method, path, body, true);
  }
  if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

export async function events(after = 0, kind) {
  const all = [];
  for (;;) {
    const p = await api("GET", `/v1/repos/${REPO}/events?after=${after}&limit=500${kind ? `&kind=${kind}` : ""}`, TOK.sys, undefined, 200);
    all.push(...p.events);
    if (!p.has_more) return all;
    after = p.next_after;
  }
}
export async function headSeq() {
  return (await api("GET", `/v1/repos/${REPO}/events?tail=true&limit=1`, TOK.sys, undefined, 200)).head_seq;
}

// ------------------------------------------------------------------------------ git

export function git(args, { cwd, token, allowFail, id } = {}) {
  const who = id ?? "weft-otto-demo";
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@agents.weft.invalid`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@agents.weft.invalid` };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ").slice(0, 80)}: ${scrub(r.stderr)}`);
  return allowFail ? { code: r.status, out: (r.stdout ?? "").trim(), err: scrub(r.stderr ?? "") } : r.stdout.trim();
}
export const tryRun = (cmd, args, cwd, timeout = 180_000, env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, ...(env ? { env } : {}) });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// ------------------------------------------------------------------------------ credentials (never printed)

let claudeEnv;
/** `claude -p` auth: the keychain login when it works, else the Hermes credential pool's Anthropic OAuth token. */
export function claudeAuthEnv() {
  if (claudeEnv) return claudeEnv;
  const st = JSON.parse(tryRun("claude", ["auth", "status", "--json"], ROOT).out || "{}");
  if (st.loggedIn || process.env.CLAUDE_CODE_OAUTH_TOKEN) return (claudeEnv = {});
  const pool = JSON.parse(readFileSync(join(homedir(), ".hermes/auth.json"), "utf8")).credential_pool?.anthropic ?? [];
  const tok = pool.find((c) => c.auth_type === "oauth" && c.last_status === "ok" && /^sk-ant-oat/.test(c.access_token ?? ""))?.access_token;
  if (!tok) throw new Error("claude is not logged in and the Hermes pool has no Anthropic OAuth token");
  return (claudeEnv = { CLAUDE_CODE_OAUTH_TOKEN: tok });
}
export function geminiKey() {
  for (const l of readFileSync(join(homedir(), ".hermes/.env"), "utf8").split("\n")) {
    const m = /^(?:export )?GEMINI_API_KEY=(.*)$/.exec(l.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("GEMINI_API_KEY missing from ~/.hermes/.env");
}

// ------------------------------------------------------------------------------ harnesses

export const BUNDLES = {
  claude: join(MAIN_ROOT, "packages/adapters/claude-code/dist/weft-claude.mjs"),
  codex: join(MAIN_ROOT, "packages/adapters/codex/dist/weft-codex.mjs"),
  opencode: join(MAIN_ROOT, "packages/adapters/opencode/dist/weft-opencode.mjs"),
  gemini: join(MAIN_ROOT, "packages/adapters/gemini/dist/weft-gemini.mjs"),
};
export const HARNESS_LABEL = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI", hermes: "Hermes", planted: "scripted (planted bug)" };

/** Spawn a harness turn; resolves with exit code + parsed stdout lines. */
function runTurn(cmd, args, cwd, outFile, env) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, scrub(stdout));
      if (stderr.trim()) writeFileSync(outFile.replace(/\.jsonl$/, ".stderr.txt"), scrub(stderr));
      const lines = stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      res({ code, lines, ms: Date.now() - started });
    });
  });
}
const CLAUDE_TOOLS = (dir) => `Read,Edit,Write,MultiEdit,Glob,Grep,Bash(node --test:*),Bash(git status:*),Bash(git diff:*),Bash(${dir}/${WEFT_CLI}:*),Bash(${WEFT_CLI}:*)`;

/** The env a candidate process must not inherit from the Hermes worker that started its lane. */
const WORKER_ENV = /^(HERMES_KANBAN_|HERMES_SESSION|HERMES_TASK|WEFT_TOKEN$|WEFT_HERMES_)/;

export class Agent {
  constructor({ task, card, harness, cand, work, ev, run }) {
    Object.assign(this, { task, card, harness, cand, id: cand.agent, turns: [], session: undefined, run });
    this.dir = harness === "hermes" ? join(SITE, ".worktrees", `${this.id}`) : join(work, this.id);
    this.ev = join(ev, "agents", this.id);
    this.work = work;
    mkdirSync(this.ev, { recursive: true });
  }
  env() {
    const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !WORKER_ENV.test(k)));
    e.WEFT_HOOK_TRACE = "1";
    if (this.harness === "claude") {
      delete e.OPENROUTER_API_KEY;
      Object.assign(e, claudeAuthEnv());
    }
    if (this.harness === "opencode") {
      // Concurrent `opencode serve` processes lock each other's SQLite store: one data dir per agent.
      const data = join(this.work, `.xdg-${this.id}`);
      if (!existsSync(join(data, "opencode"))) {
        mkdirSync(join(data, "opencode"), { recursive: true });
        const auth = join(homedir(), ".local/share/opencode/auth.json");
        if (existsSync(auth)) cpSync(auth, join(data, "opencode/auth.json"));
      }
      e.XDG_DATA_HOME = data;
    }
    if (this.harness === "gemini") {
      // Gemini CLI's Google-login tier was retired; an isolated HOME selects API-key auth
      // (and keeps concurrent Gemini agents' session stores apart).
      // Gemini CLI 0.62 never runs untrusted *project* hooks headless (the run hangs), so the
      // adapter's hooks from the clone's .gemini/settings.json go into this user-level file.
      const home = join(this.work, `.home-${this.id}`);
      mkdirSync(join(home, ".gemini"), { recursive: true });
      const proj = join(this.dir, ".gemini/settings.json");
      const hooks = existsSync(proj) ? JSON.parse(readFileSync(proj, "utf8")).hooks : undefined;
      writeFileSync(join(home, ".gemini/settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } }, ui: { hideBanner: true }, ...(hooks ? { hooks } : {}) }));
      e.HOME = home;
      e.GEMINI_API_KEY = geminiKey();
      for (const f of [".gitconfig"]) if (existsSync(join(homedir(), f)) && !existsSync(join(home, f))) cpSync(join(homedir(), f), join(home, f));
    }
    if (this.harness === "hermes") {
      Object.assign(e, { TERMINAL_CWD: this.dir, WEFT_HERMES_REPO: REPO, WEFT_HERMES_TOKEN: this.wcp, WEFT_HERMES_AGENT: this.id, WEFT_HERMES_CHANGE: this.cand.change, WEFT_HERMES_TASK: this.card, WEFT_HERMES_TASK_TITLE: this.task.title, WEFT_HERMES_MODE: "enforce" });
    }
    return e;
  }
  async turn(name, prompt) {
    const f = join(this.ev, `${this.turns.length + 1}-${name}.jsonl`);
    writeFileSync(f.replace(/\.jsonl$/, ".prompt.txt"), `${this.harness}${this.session ? ` (resume ${this.session})` : ""}\n\n${prompt}\n`);
    let r;
    const env = this.env();
    if (this.harness === "claude") {
      const args = ["-p", "--verbose", "--output-format", "stream-json", "--include-hook-events", "--setting-sources", "project,local", "--permission-mode", "acceptEdits", "--allowedTools", CLAUDE_TOOLS(this.dir)];
      if (this.session) args.push("--resume", this.session);
      r = await runTurn("claude", [...args, "--", prompt], this.dir, f, env);
      this.session ??= r.lines.find((l) => l.session_id)?.session_id;
    } else if (this.harness === "codex") {
      const common = ["--json", "--dangerously-bypass-hook-trust", "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"];
      r = await runTurn("codex", this.session ? ["exec", "resume", ...common, this.session, prompt] : ["exec", ...common, "--cd", this.dir, prompt], this.dir, f, env);
      this.session ??= r.lines.find((l) => l.thread_id)?.thread_id;
    } else if (this.harness === "opencode") {
      if (!this.server) await this.startServer();
      r = await runTurn("opencode", ["run", "--attach", this.server.url, "--dir", this.dir, "-m", OC_MODEL, "--format", "json", "--auto", ...(this.session ? ["--session", this.session] : []), prompt], this.dir, f, env);
      this.session ??= r.lines.find((l) => l.sessionID)?.sessionID ?? r.lines.find((l) => l.part?.sessionID)?.part?.sessionID;
      if (this.session) await this.settle();
    } else if (this.harness === "gemini") {
      const args = ["--skip-trust", "-m", geminiModel(this.task.key), "--approval-mode", "yolo", "--output-format", "stream-json"];
      if (this.session) args.push("--resume", "latest");
      r = await runTurn("gemini", [...args, "-p", prompt], this.dir, f, env);
      this.session ??= r.lines.find((l) => l.session_id)?.session_id ?? (r.code === 0 ? "latest" : undefined);
    } else if (this.harness === "hermes") {
      // --in + TERMINAL_CWD: Hermes' terminal otherwise starts in the configured cwd (~), and
      // the prompt names the checkout so the agent never wanders into ~/github/weft-demo-site.
      const scoped = `Your working directory is the git checkout ${this.dir}. Work only inside it (never in ~/github/weft-demo-site itself).\n\n${prompt}`;
      const args = ["chat", "-q", scoped, "-Q", "--format", "stream-json", "--yolo", "--max-turns", "60", "--source", "weft-demo", "--in", this.dir];
      if (this.session) args.push("--resume", this.session);
      r = await runTurn("hermes", args, this.dir, f, env);
      this.session ??= r.lines.find((l) => l.session_id)?.session_id ?? r.lines.find((l) => l.session?.id)?.session?.id;
    } else throw new Error(`unknown harness ${this.harness}`);
    const failure =
      r.lines.find((l) => l.type === "turn.failed")?.error?.message ??
      r.lines.find((l) => l.type === "error")?.error?.data?.message ??
      r.lines.find((l) => l.type === "error")?.message ??
      (r.lines.find((l) => l.type === "result" && l.is_error) ? r.lines.find((l) => l.type === "result").result : undefined);
    this.turns.push({ name, code: r.code, ms: r.ms, ...(failure ? { failure: scrub(String(failure)).slice(0, 300) } : {}) });
    return r;
  }
  async startServer() {
    const port = 4300 + Math.floor(Math.random() * 1500);
    const child = spawn("opencode", ["serve", "--port", String(port)], { cwd: this.dir, env: { ...this.env(), PWD: this.dir }, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    child.stdout.on("data", (c) => (o += c));
    child.stderr.on("data", (c) => (o += c));
    child.on("close", () => writeFileSync(join(this.ev, "opencode-serve.log"), scrub(o)));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      if (await fetch(`${url}/config`).then((x) => x.ok, () => false)) break;
      await sleep(500);
    }
    this.server = { child, url };
  }
  /** OpenCode: stop-gate continuations run after `run --attach` exits; wait until idle for good. */
  async settle(quietMs = 20_000, maxMs = 8 * 60_000) {
    const p = join(this.dir, ".weft/log/hooks.jsonl");
    const size = () => (existsSync(p) ? readFileSync(p, "utf8").length : 0);
    const busy = async () => {
      try {
        const st = await (await fetch(`${this.server.url}/session/status`)).json();
        return st?.[this.session]?.type === "busy" || st?.[this.session]?.type === "retry";
      } catch {
        return false;
      }
    };
    const end = Date.now() + maxMs;
    let last = size();
    let since = Date.now();
    while (Date.now() < end) {
      await sleep(2000);
      const now = size();
      if (now !== last || (await busy())) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since > quietMs) return;
    }
  }
  stop() {
    if (this.server) this.server.child.kill("SIGTERM");
  }
  /** Commit through the adapter's git hooks (trailers + pre-commit gate); Hermes has no git hooks, so its trailers are added here. */
  commitAndPush() {
    git(["add", "-A"], { cwd: this.dir });
    if (!git(["status", "--porcelain"], { cwd: this.dir })) return (this.push = { ok: false, reason: "no changes" });
    const trailers = this.harness === "hermes" ? `\n\n${Object.entries(this.cand.trailers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}` : "";
    const c = git(["commit", "-qm", `${this.task.title} (${this.id})${trailers}`], { cwd: this.dir, allowFail: true, id: this.id });
    if (c.code !== 0) return (this.push = { ok: false, reason: "commit refused", detail: c.err.slice(0, 800) });
    const sha = git(["rev-parse", "HEAD"], { cwd: this.dir });
    const p = git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: this.dir, token: this.cand.token.plaintext, allowFail: true });
    if (p.code !== 0) return (this.push = { ok: false, reason: "push failed", detail: p.err.slice(0, 400) });
    this.push = { ok: true, sha, at_ms: Date.now(), trailers: git(["log", "-1", "--format=%(trailers:only)"], { cwd: this.dir }) };
    return this.push;
  }
}

/** Clone the candidate's fork, mint its agent token, install its harness adapter. */
export async function prepare(a, runLabel) {
  mkdirSync(dirname(a.dir), { recursive: true });
  git(["clone", "-q", a.cand.fork.remote, a.dir], { token: a.cand.token.plaintext });
  for (const [k, v] of Object.entries({ "user.name": a.id, "user.email": `${a.id}@agents.weft.invalid` })) git(["config", k, v], { cwd: a.dir });
  // the site's tests need no packages; tsc is only used on trunk by the report
  a.wcp = (await api("POST", "/v1/admin/tokens", TOK.admin, { principal: a.id, scopes: ["agent", "observe"], repos: [REPO], agent: a.id, label: `otto demo ${runLabel}` }, 201)).token;
  if (BUNDLES[a.harness]) {
    execFileSync(process.execPath, [BUNDLES[a.harness], "install", "--url", GW, "--repo", REPO, "--agent", a.id, "--task", a.card, "--title", a.task.title, "--priority", String(a.task.priority ?? 0), "--change", a.cand.change], {
      cwd: a.dir,
      env: { ...process.env, WEFT_TOKEN: a.wcp },
      stdio: "ignore",
    });
  } else if (a.harness === "hermes") {
    // the Hermes adapter is a plugin of the Hermes install; candidate mode is pure env (Agent.env)
    writeFileSync(join(a.dir, ".git/info/exclude"), `${readFileSync(join(a.dir, ".git/info/exclude"), "utf8")}\n.weft/\n`);
  }
}

/** Replays an Artifacts `pushed` event that never reached the gateway (see m2-report.md). */
let QUEUE_ID;
export async function queueId() {
  QUEUE_ID ??= (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview").queue_id;
  return QUEUE_ID;
}
export async function replayPush(a, why = "x_replayed_by otto lane") {
  a.replayed = true;
  const sha = a.push.sha;
  const before = git(["rev-parse", `${sha}~1`], { cwd: a.dir });
  const commit = { id: sha, message: git(["log", "-1", "--format=%B", sha], { cwd: a.dir }), timestamp: new Date().toISOString(), parents: [before] };
  const envelope = { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: a.cand.fork.namespace ?? "weft-preview", repoName: a.cand.fork.name }, payload: { ref: "refs/heads/main", before, after: sha, commits: [commit], totalCommitsCount: 1 }, metadata: { accountId: ACCOUNT, eventTimestamp: new Date().toISOString(), x_replayed_by: why } };
  await cf("POST", `/queues/${await queueId()}/messages`, { body: envelope, content_type: "json" });
  return { agent: a.id, sha, after_push_s: Math.round((Date.now() - (a.push.at_ms ?? Date.now())) / 1000) };
}

/** End of a lane: release the candidates' claims so losing candidates don't hold symbols (claims outlive sessions). */
export async function releaseAll(agents, card) {
  for (const a of agents) {
    if (!a.wcp) continue;
    try {
      const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: a.id, harness: "otto-lane" }, capabilities: { level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: false }, task: { id: card }, change: a.cand.change };
      const w = await api("POST", `/v1/repos/${REPO}/sessions`, a.wcp, hello, 201);
      await api("POST", `/v1/repos/${REPO}/sessions/${w.session}/events`, a.wcp, { type: "submit", mode: "commit", event: { kind: "release", base_seq: w.delivered_through } });
      await api("POST", `/v1/repos/${REPO}/sessions/${w.session}/bye`, a.wcp, { type: "bye", reason: "lane finished" }).catch(() => undefined);
    } catch {}
  }
}

export function summarize(e) {
  const d = (() => {
    try {
      return JSON.parse(e.data ?? "{}");
    } catch {
      return {};
    }
  })();
  if (e.kind === "review") return { verdict: d.verdict, score: d.score, summary: String(d.summary ?? "").slice(0, 240) };
  if (e.kind === "test") return { status: d.status, summary: d.summary };
  if (e.kind === "rebase") return { status: d.status, layer: d.layer };
  if (e.kind === "risk") return { risk: d.risk };
  if (e.kind === "screenshot") return { route: d.route, ratio: d.ratio ?? d.diff_ratio ?? null };
  if (e.kind === "visual_diff") return d;
  if (e.kind === "rank") return { score: d.score, eligible: d.eligible, reasons: d.reasons };
  return Object.keys(d).length ? Object.fromEntries(Object.entries(d).slice(0, 8).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : v])) : null;
}
