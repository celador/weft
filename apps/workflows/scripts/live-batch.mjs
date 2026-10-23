#!/usr/bin/env node
// LIVE proof for batched landing with bisect (t_5f9c01c1; not part of the gate), on the preview
// stack with its own repo `weft-batch` (the demo repo `weft-demo` is untouched):
//
//   node apps/workflows/scripts/live-batch.mjs
//
//  1. bind Weft repo `weft-batch` to an Artifacts trunk; config land.batch = { max: 4, wait_s: 30 };
//     seed a small TypeScript shop with 6 node:test files (~1.5 s of work each, a synthetic
//     suite: the numbers show the mechanism, not a real project's CI).
//  2. batch: 5 agents push 5 independent changes (W, A, B, C, D). W is landed first and lands
//     alone (the N = 1 path, unchanged). While W's presubmit runs, A-D ask to land: they queue
//     behind W, and the next head stacks all four, runs the presubmit ONCE and lands them with
//     one CAS push (4 land ops, 4 landing ranges).
//  3. bisect: same with Y, E, F, G, H where G plants a failing test. The batch presubmit fails,
//     bisect isolates G, the passing prefix lands, G is bounced with the failing output, and
//     the changes after G are re-stacked and land in a second round.
//  4. revert one change of the step-2 batch through the op log (RevertOperation): only its
//     own range is reverted.
//
// Writes demo/evidence/batch-live/run.json. Tokens from ~/.config/weft, never printed.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GW = process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai";
const WF = process.env.WEFT_WORKFLOWS_URL ?? "https://weft-workflows-preview.elier.ai";
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const REPO = process.env.WEFT_BATCH_REPO ?? "weft-batch";
const cfg = (f) => readFileSync(join(homedir(), ".config/weft", f), "utf8").trim();
const ADMIN = cfg("preview-admin-token");
const SYS = cfg("preview-workflows-system-token");
const WFTOK = cfg("preview-workflows-token");
const scrub = (s) => String(s).replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***").replace(/wcp_[A-Za-z0-9_-]+/g, "wcp_***");
const T0 = Date.now();
const log = (...a) => console.log(`[live +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a.map((x) => (typeof x === "string" ? scrub(x) : scrub(JSON.stringify(x)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { started_at: new Date().toISOString(), gateway: GW, workflows: WF, repo: REPO, steps: [] };
const step = (name, data) => {
  out.steps.push({ name, at_s: +((Date.now() - T0) / 1000).toFixed(1), ...data });
  log(name, data);
};

async function api(method, path, token, body, expect) {
  const r = await fetch(`${GW}${path}`, { method, headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  if (expect && ![].concat(expect).includes(r.status)) throw new Error(`${method} ${path} -> ${r.status}: ${scrub(t).slice(0, 600)}`);
  return t ? JSON.parse(t) : {};
}
async function wf(kind, id) {
  const r = await fetch(`${WF}/v1/workflows/${kind}/${id}`, { headers: { authorization: `Bearer ${WFTOK}` } });
  return r.json();
}
async function waitWf(kind, id, until = ["complete", "errored", "terminated"], maxMs = 900_000) {
  const t = Date.now();
  let last;
  for (;;) {
    const s = await wf(kind, id);
    if (s.status !== last?.status) log(`workflow ${kind}/${id}:`, s.status);
    last = s;
    if (until.includes(s.status)) return s;
    if (Date.now() - t > maxMs) throw new Error(`workflow ${kind}/${id} still ${s.status}`);
    await sleep(3000);
  }
}
async function cf(method, path, body) {
  execFileSync("pnpm", ["exec", "wrangler", "whoami"], { stdio: "ignore", env: { ...process.env, CLOUDFLARE_API_TOKEN: "" }, cwd: here });
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"))[1];
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}
function git(args, { cwd, token } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "weft-live", GIT_AUTHOR_EMAIL: "live@agents.weft.dev", GIT_COMMITTER_NAME: "weft-live", GIT_COMMITTER_EMAIL: "live@agents.weft.dev" };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${scrub(r.stderr)}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
}

// ------------------------------------------------------------------ the shop

const WORK = "// ~1.5 s of synchronous work per test file: stands in for a real suite's cost.\nexport function work(ms = 1500): void {\n  const end = Date.now() + ms;\n  while (Date.now() < end) Math.sqrt(Math.random());\n}\n";
const t = (name, imports, body) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { work } from "./work.ts";\n${imports}\n\ntest(${JSON.stringify(name)}, () => {\n  work();\n${body}\n});\n`;
const SHOP = {
  "package.json": JSON.stringify({ name: "batch-shop", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# batch shop\n\nLive fixture for Weft's batched landing with bisect.\n",
  "src/money.ts": "export function round2(n: number): number {\n  return Math.round(n * 100) / 100;\n}\n",
  "src/pricing.ts": "import { round2 } from \"./money.ts\";\n\nexport function lineTotal(price: number, qty: number): number {\n  return round2(price * qty);\n}\n",
  "src/users.ts": "export function displayName(first: string, last: string): string {\n  return `${first} ${last}`;\n}\n",
  "test/work.ts": WORK,
  "test/round.test.ts": t("round2", 'import { round2 } from "../src/money.ts";', "  assert.equal(round2(1.234), 1.23);"),
  "test/pricing.test.ts": t("lineTotal", 'import { lineTotal } from "../src/pricing.ts";', "  assert.equal(lineTotal(1.1, 3), 3.3);"),
  "test/users.test.ts": t("displayName", 'import { displayName } from "../src/users.ts";', '  assert.equal(displayName("Ada", "Lovelace"), "Ada Lovelace");'),
  "test/a.test.ts": t("a", "", "  assert.ok(true);"),
  "test/b.test.ts": t("b", "", "  assert.ok(true);"),
  "test/c.test.ts": t("c", "", "  assert.ok(true);"),
};
const CONFIG = { tests: { command: ["node", "--test"], timeout_s: 300 }, layers: ["git", "mergiraf"], job_timeout_s: 900, land: { batch: { max: 4, wait_s: 30 } } };
/** One independent change per agent: a new module + a line in the README. */
const feature = (k) => () => ({ [`src/feature-${k}.ts`]: `export const feature${k.toUpperCase()} = ${JSON.stringify(k)};\n` });

async function main() {
  const stamp = Date.now().toString(36);
  await api("POST", "/v1/admin/repos", ADMIN, { repo: REPO }, [200, 201]);
  let bound;
  try {
    bound = await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: REPO, config: CONFIG }, [200, 201]);
  } catch (e) {
    if (!/-> 404/.test(e.message)) throw e;
    bound = await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: REPO, create: true, config: CONFIG }, [200, 201]);
  }
  step("bound trunk", { trunk: bound.trunk, namespace: bound.namespace, config: bound.config });
  const human = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: "john", scopes: ["human"], repos: [REPO] }, 201)).token;
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { ttl: 1800 }, 201);
  const seed = mkdtempSync(join(tmpdir(), "weft-batch-seed-"));
  git(["init", "-q", "-b", "main", seed]);
  git(["remote", "add", "origin", tt.remote], { cwd: seed });
  let before = null;
  try {
    git(["fetch", "-q", "origin", "main"], { cwd: seed, token: tt.token.plaintext });
    git(["checkout", "-q", "-B", "main", "FETCH_HEAD"], { cwd: seed });
    before = git(["rev-parse", "HEAD"], { cwd: seed });
  } catch {
    /* empty trunk */
  }
  // Every run starts from the seed shop (earlier runs' features removed).
  for (const f of git(["ls-files", "src"], { cwd: seed }).split("\n").filter((x) => /^src\/feature-/.test(x))) git(["rm", "-q", f], { cwd: seed });
  write(seed, SHOP);
  if (!before || git(["status", "--porcelain"], { cwd: seed })) {
    git(["add", "-A"], { cwd: seed });
    git(["commit", "-qm", `shop: seed for the batched-landing live run (${stamp})`], { cwd: seed });
    git(["push", "-q", `--force-with-lease=refs/heads/main:${before ?? ""}`, "origin", "HEAD:refs/heads/main"], { cwd: seed, token: tt.token.plaintext });
  }
  const base = git(["rev-parse", "HEAD"], { cwd: seed });
  step("trunk seeded", { before, base, tests: Object.keys(SHOP).filter((f) => f.endsWith(".test.ts")) });

  const queue = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
  if (!queue) throw new Error("queue weft-artifacts-events-preview not found (see the restore steps on t_5f9c01c1)");
  const subs = [];
  const agentTokens = {};
  async function candidate(task, title, agent) {
    const r = await api("POST", `/v1/repos/${REPO}/tasks/${task}/candidates`, SYS, { count: 1, agents: [agent], title, ttl: 3600 }, 201);
    const c = r.candidates[0];
    if (c.subscription.status !== "active") {
      const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: queue.queue_id }, events: ["pushed"] });
      await api("POST", "/v1/admin/artifacts/subscriptions", ADMIN, { change: c.change, subscription_id: sub.id }, 200);
      subs.push(sub.id);
    }
    agentTokens[agent] ??= (await api("POST", "/v1/admin/tokens", ADMIN, { principal: agent, scopes: ["agent"], repos: [REPO], agent }, 201)).token;
    const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: task, priority: 0 }, change: c.change };
    c.session = (await api("POST", `/v1/repos/${REPO}/sessions`, agentTokens[agent], hello, 201)).session;
    c.agent = agent;
    c.task = task;
    return c;
  }
  const delivery = {};
  async function push(c, files, msg) {
    const d = mkdtempSync(join(tmpdir(), "weft-batch-agent-"));
    git(["clone", "-q", c.fork.remote, d], { token: c.token.plaintext });
    const before = git(["rev-parse", "HEAD"], { cwd: d });
    write(d, files(d));
    git(["add", "-A"], { cwd: d });
    git(["commit", "-qm", `${msg}\n\n${Object.entries(c.trailers).map(([k, v]) => `${k}: ${v}`).join("\n")}`], { cwd: d });
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: d, token: c.token.plaintext });
    const after = git(["rev-parse", "HEAD"], { cwd: d });
    // Same Artifacts-event fallback as live-testselect.mjs (see the comment there).
    delivery[after] = "artifacts";
    const t0 = Date.now();
    for (;;) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      if (ch.revisions.some((r) => r.sha === after)) break;
      if (Date.now() - t0 > 60_000) {
        const message = git(["log", "-1", "--format=%B", after], { cwd: d });
        const envelope = { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: c.fork.namespace, repoName: c.fork.name }, payload: { ref: "refs/heads/main", before, after, commits: [{ id: after, message, timestamp: new Date().toISOString(), parents: [before] }], totalCommitsCount: 1 }, metadata: { accountId: ACCOUNT, eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() } };
        await cf("POST", `/queues/${queue.queue_id}/messages`, { body: envelope });
        delivery[after] = "queue-fallback";
        log("no Artifacts event after 60 s; sent the push envelope to the queue", { change: c.change, after });
        break;
      }
      await sleep(3000);
    }
    return after;
  }
  async function processed(c, sha, maxMs = 900_000) {
    const t0 = Date.now();
    for (;;) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      const rev = ch.revisions.find((r) => r.sha === sha);
      if (rev && ["processed", "conflict", "failed"].includes(rev.status)) return rev;
      if (Date.now() - t0 > maxMs) throw new Error(`revision ${sha} of ${c.change} still ${rev?.status ?? "unseen"}`);
      await sleep(3000);
    }
  }
  const qAll = async () => (await api("GET", `/v1/repos/${REPO}/system/queue?status=queued,landing,landed,failed,cancelled`, SYS, undefined, 200)).entries;
  const opsAll = async () => (await api("GET", `/v1/repos/${REPO}/system/ops`, SYS, undefined, 200)).ops;
  out.delivery = delivery;

  /** One phase: `warm` lands alone first; the rest ask to land while it is in its presubmit. */
  async function phase(name, specs) {
    const cs = [];
    for (const s of specs) cs.push(await candidate(`${name}-${s.k}-${stamp}`, s.title, s.agent));
    const shas = await Promise.all(cs.map((c, i) => push(c, specs[i].files, specs[i].msg)));
    const revs = await Promise.all(cs.map((c, i) => processed(c, shas[i])));
    step(`${name}: ${cs.length} checkpoints processed`, { changes: cs.map((c, i) => ({ k: specs[i].k, agent: c.agent, change: c.change, sha: shas[i], revision: revs[i].status, layer: revs[i].layer })) });
    const [warm, ...rest] = cs;
    const lw = await api("POST", `/v1/repos/${REPO}/changes/${warm.change}/land`, human, { note: `live ${name}: warm-up (lands alone)` }, 202);
    // Wait until the warm-up is in its presubmit (queue entry landing), then the others ask to land.
    const t0 = Date.now();
    for (;;) {
      const e = (await qAll()).find((x) => x.change === warm.change && ["landing", "landed", "failed"].includes(x.status));
      if (e) break;
      if (Date.now() - t0 > 300_000) throw new Error("warm-up never started landing");
      await sleep(1000);
    }
    const lr = [];
    for (const c of rest) lr.push(await api("POST", `/v1/repos/${REPO}/changes/${c.change}/land`, human, { note: `live ${name}` }, 202));
    step(`${name}: land requested`, { warm: { change: warm.change, workflow: lw.workflow }, rest: rest.map((c, i) => ({ change: c.change, workflow: lr[i].workflow })) });
    const wsts = await Promise.all([lw, ...lr].map((x) => waitWf("land", x.workflow, undefined, 1_500_000)));
    const q = (await qAll()).filter((e) => cs.some((c) => c.change === e.change));
    const ops = (await opsAll()).filter((o) => cs.some((c) => c.change === o.change_id));
    const evid = {};
    for (const c of cs) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      evid[c.change] = { status: ch.status, evidence: ch.evidence.filter((e) => ["land", "presubmit"].includes(e.kind)).map((e) => ({ kind: e.kind, status: e.status, ...(() => { const d = JSON.parse(e.data ?? "{}"); return { batch: d.batch ?? null, reason: d.reason ?? null, before: d.before ?? null, after: d.after ?? null, summary: d.summary ?? null, ms: d.ms ?? null, tail: e.kind === "presubmit" && e.status === "fail" ? String(d.tail ?? "").slice(-600) : undefined }; })() })) };
    }
    const res = { workflows: wsts.map((s, i) => ({ change: cs[i].change, k: specs[i].k, status: s.status, output: s.output ?? null, error: s.error ?? null })), queue: q, ops, evidence: evid, changes: cs.map((c, i) => ({ k: specs[i].k, change: c.change, agent: c.agent, session: undefined })) };
    step(`${name}: done`, res);
    return { cs, res };
  }

  // 2. batch: W alone, then A-D as one batch.
  const b = await phase("batch", [
    { k: "w", agent: "claude-w", title: "Warm-up: feature W", msg: "feature W", files: feature("w") },
    { k: "a", agent: "claude-a", title: "Feature A", msg: "feature A", files: feature("a") },
    { k: "b", agent: "codex-b", title: "Feature B", msg: "feature B", files: feature("b") },
    { k: "c", agent: "cursor-c", title: "Feature C", msg: "feature C", files: feature("c") },
    { k: "d", agent: "gemini-d", title: "Feature D", msg: "feature D", files: feature("d") },
  ]);
  // 3. bisect: Y alone, then E, F, G (planted failure), H.
  const s = await phase("bisect", [
    { k: "y", agent: "claude-y", title: "Warm-up: feature Y", msg: "feature Y", files: feature("y") },
    { k: "e", agent: "claude-e", title: "Feature E", msg: "feature E", files: feature("e") },
    { k: "f", agent: "codex-f", title: "Feature F", msg: "feature F", files: feature("f") },
    { k: "g", agent: "cursor-g", title: "Money: faster rounding (planted bug)", msg: "money: round2 truncates (planted failure)", files: () => ({ "src/money.ts": SHOP["src/money.ts"].replace("Math.round(n * 100) / 100", "Math.trunc(n * 10) / 10"), "src/feature-g.ts": "export const featureG = \"g\";\n" }) },
    { k: "h", agent: "gemini-h", title: "Feature H", msg: "feature H", files: feature("h") },
  ]);
  const g = s.cs[3];
  const gInbox = await api("POST", `/v1/repos/${REPO}/sessions/${g.session}/inbox`, agentTokens["cursor-g"], { type: "inbox.drain" }, 200);
  step("bisect: G's inbox (bounce)", { items: gInbox.items.filter((i) => i.kind === "message").map((i) => ({ seq: i.record?.seq, text: String(i.record?.payload?.text ?? "").slice(0, 1200) })) });

  // 4. revert one change of the batch (B) via the op log.
  const bChange = b.cs[2].change;
  const bOp = (await opsAll()).find((o) => o.kind === "land" && o.change_id === bChange);
  const rv = await api("POST", `/v1/repos/${REPO}/system/revert`, SYS, { op_id: bOp.op_id, reason: "live: revert one change of a batch" }, 202);
  const rvs = await waitWf("revert", rv.workflow);
  const tip = rvs.output?.sha;
  const show = (f) => {
    const d = mkdtempSync(join(tmpdir(), "weft-batch-show-"));
    git(["init", "-q", d]);
    git(["fetch", "-q", tt.remote, tip], { cwd: d, token: tt.token.plaintext });
    return spawnSync("git", ["cat-file", "-e", `${tip}:${f}`], { cwd: d }).status === 0;
  };
  const files = Object.fromEntries(["w", "a", "b", "c", "d", "y", "e", "f", "g", "h"].map((k) => [`src/feature-${k}.ts`, show(`src/feature-${k}.ts`)]));
  step("revert B (one change of the batch)", { op_id: bOp.op_id, workflow: rv.workflow, status: rvs.status, output: rvs.output ?? null, trunk_files: files });

  for (const id of subs) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
  out.finished_at = new Date().toISOString();
  out.total_s = (Date.now() - T0) / 1000;
  const dir = join(here, "../../../demo/evidence/batch-live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), scrub(JSON.stringify(out, null, 2)) + "\n");
  log("wrote", join(dir, "run.json"));
}

main().catch((e) => {
  console.error("[live] FAILED:", scrub(e.stack ?? e));
  try {
    const dir = join(here, "../../../demo/evidence/batch-live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.failed.json"), scrub(JSON.stringify({ ...out, error: String(e.message ?? e) }, null, 2)) + "\n");
  } catch {}
  process.exit(1);
});
