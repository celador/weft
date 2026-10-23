#!/usr/bin/env node
// LIVE proof for affected-test selection (not part of the gate), on the preview stack with its own
// repo `weft-testselect` (the demo repo `weft-demo` is untouched):
//
//   node apps/workflows/scripts/live-testselect.mjs
//
//  1. bind Weft repo `weft-testselect` to a new Artifacts trunk; config tests.select = true;
//     seed a small TypeScript shop with 8 node:test files over 4 areas (money, pricing/cart,
//     users, catalog). Each test file does ~1.2 s of synchronous work to stand in for a real
//     suite (a synthetic suite: the numbers show the mechanism, not a real project's CI).
//  2. task A: edit src/users.ts -> ProcessRevision runs only the users tests (subset)
//  3. land A -> LandChange presubmit runs the FULL suite (8/8) before the trunk CAS push
//  4. task B: edit money.round2 (reached by pricing, cart, barrel) -> subset, time saved vs A's
//     full presubmit
//  5. task C: bump package.json -> full-suite fallback with the reason
//
// Writes demo/evidence/testselect-live/run.json. Tokens from ~/.config/weft, never printed.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GW = process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai";
const WF = process.env.WEFT_WORKFLOWS_URL ?? "https://weft-workflows-preview.elier.ai";
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const REPO = process.env.WEFT_TESTSELECT_REPO ?? "weft-testselect";
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

const WORK = "// ~1.2 s of synchronous work per test file: stands in for a real suite's cost.\nexport function work(ms = 1200): void {\n  const end = Date.now() + ms;\n  while (Date.now() < end) Math.sqrt(Math.random());\n}\n";
const t = (name, imports, body) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { work } from "./work.ts";\n${imports}\n\ntest(${JSON.stringify(name)}, () => {\n  work();\n${body}\n});\n`;
const SHOP = {
  "package.json": JSON.stringify({ name: "testselect-shop", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# testselect shop\n\nLive fixture for Weft's affected-test selection.\n",
  "src/money.ts": "export function round2(n: number): number {\n  return Math.round(n * 100) / 100;\n}\n\nexport const CURRENCY = \"USD\";\n",
  "src/pricing.ts": "import { round2 } from \"./money.ts\";\n\nexport function lineTotal(price: number, qty: number): number {\n  return round2(price * qty);\n}\n\nexport function discount(total: number): number {\n  return total > 100 ? round2(total * 0.9) : total;\n}\n",
  "src/cart.ts": "import { lineTotal } from \"./pricing.ts\";\n\nexport type Item = { sku: string; price: number; qty: number };\n\nexport function cartTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + lineTotal(i.price, i.qty), 0);\n}\n",
  "src/users.ts": "export function displayName(first: string, last: string): string {\n  return `${first} ${last}`;\n}\n\nexport function initials(first: string, last: string): string {\n  return `${first[0]}${last[0]}`.toUpperCase();\n}\n",
  "src/catalog.ts": "export const SKUS = [\"apple\", \"pear\", \"kiwi\"] as const;\n\nexport function isSku(s: string): boolean {\n  return (SKUS as readonly string[]).includes(s);\n}\n",
  "src/index.ts": "export * from \"./pricing.ts\";\nexport { cartTotal } from \"./cart.ts\";\n",
  "test/work.ts": WORK,
  "test/money.test.ts": t("currency", 'import { CURRENCY } from "../src/money.ts";', '  assert.equal(CURRENCY, "USD");'),
  "test/round.test.ts": t("round2", 'import { round2 } from "../src/money.ts";', "  assert.equal(round2(1.234), 1.23);"),
  "test/pricing.test.ts": t("lineTotal", 'import { lineTotal } from "../src/pricing.ts";', "  assert.equal(lineTotal(1.1, 3), 3.3);"),
  "test/discount.test.ts": t("discount", 'import { discount } from "../src/pricing.ts";', "  assert.equal(discount(200), 180);"),
  "test/cart.test.ts": t("cartTotal", 'import { cartTotal } from "../src/cart.ts";', '  assert.equal(cartTotal([{ sku: "apple", price: 2, qty: 3 }]), 6);'),
  "test/users.test.ts": t("displayName", 'import { displayName } from "../src/users.ts";', '  assert.equal(displayName("Ada", "Lovelace"), "Ada Lovelace");'),
  "test/initials.test.ts": t("initials", 'import { initials } from "../src/users.ts";', '  assert.equal(initials("ada", "lovelace"), "AL");'),
  "test/catalog.test.ts": t("isSku", 'import { isSku } from "../src/catalog.ts";', '  assert.ok(isSku("kiwi"));'),
};
const CONFIG = { tests: { command: ["node", "--test"], timeout_s: 300, select: true }, layers: ["git", "mergiraf"], job_timeout_s: 900 };

async function main() {
  const stamp = Date.now().toString(36);
  await api("POST", "/v1/admin/repos", ADMIN, { repo: REPO }, [200, 201]);
  // Bind the existing trunk; create it on the first run.
  let bound;
  try {
    bound = await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: REPO, config: CONFIG }, [200, 201]);
  } catch (e) {
    if (!/-> 404/.test(e.message)) throw e;
    bound = await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: REPO, create: true, config: CONFIG }, [200, 201]);
  }
  step("bound trunk", { trunk: bound.trunk, namespace: bound.namespace, config: bound.config });
  const human = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: "john", scopes: ["human"], repos: [REPO] }, 201)).token;
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { ttl: 900 }, 201);
  const seed = mkdtempSync(join(tmpdir(), "weft-ts-seed-"));
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
  write(seed, SHOP);
  if (!before || git(["status", "--porcelain"], { cwd: seed })) {
    git(["add", "-A"], { cwd: seed });
    git(["commit", "-qm", "shop: 4 areas, 8 node:test files (testselect live seed)"], { cwd: seed });
    git(["push", "-q", `--force-with-lease=refs/heads/main:${before ?? ""}`, "origin", "HEAD:refs/heads/main"], { cwd: seed, token: tt.token.plaintext });
  }
  const base = git(["rev-parse", "HEAD"], { cwd: seed });
  step("trunk seeded", { before, base, tests: Object.keys(SHOP).filter((f) => f.endsWith(".test.ts")) });

  const queue = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
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
    // An agent session on the change: the repo coordinator learns the change (the land queue needs it).
    const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: task, priority: 0 }, change: c.change };
    c.session = (await api("POST", `/v1/repos/${REPO}/sessions`, agentTokens[agent], hello, 201)).session;
    return c;
  }
  const delivery = {};
  async function push(c, files, msg) {
    const d = mkdtempSync(join(tmpdir(), "weft-ts-agent-"));
    git(["clone", "-q", c.fork.remote, d], { token: c.token.plaintext });
    const before = git(["rev-parse", "HEAD"], { cwd: d });
    write(d, files(d));
    git(["add", "-A"], { cwd: d });
    git(["commit", "-qm", `${msg}\n\n${Object.entries(c.trailers).map(([k, v]) => `${k}: ${v}`).join("\n")}`], { cwd: d });
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: d, token: c.token.plaintext });
    const after = git(["rev-parse", "HEAD"], { cwd: d });
    // The push event normally arrives via the fork's Artifacts event subscription. After the
    // 2026-10-22 wind-down re-created queue, Artifacts did not deliver within minutes, so after
    // 60 s this sends the same `cf.artifacts.repo.pushed` envelope to the queue (same idempotency
    // key: a late real delivery is a duplicate). Everything after the queue is the real pipeline.
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
  const ev = (rows, kind, pred = () => true) => {
    const e = [...rows].reverse().find((x) => x.kind === kind && pred(JSON.parse(x.data ?? "{}")));
    return e ? { status: e.status, ...JSON.parse(e.data ?? "{}") } : null;
  };
  async function processed(c, sha, maxMs = 600_000) {
    const t0 = Date.now();
    for (;;) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      const rev = ch.revisions.find((r) => r.sha === sha);
      if (rev && ["processed", "conflict", "failed"].includes(rev.status)) return { rev, evidence: ch.evidence.filter((e) => e.sha === sha), wall_s: (Date.now() - t0) / 1000 };
      if (Date.now() - t0 > maxMs) throw new Error(`revision ${sha} of ${c.change} still ${rev?.status ?? "unseen"}`);
      await sleep(3000);
    }
  }
  const brief = (sel, test) => ({
    mode: sel?.mode,
    reason: sel?.reason,
    selected: sel?.selected,
    total: sel?.total,
    files: sel?.files,
    why: sel?.why,
    writes: sel?.writes,
    graph: sel?.graph,
    select_ms: sel?.select_ms,
    tests_ms: sel?.tests_ms,
    baseline_ms: sel?.baseline?.ms ?? null,
    saved_ms: sel?.saved_ms ?? null,
    saved_fraction: sel?.saved_fraction ?? null,
    test: test ? { status: test.status, command: test.command, summary: test.summary, ms: test.ms } : null,
  });
  out.delivery = delivery;

  // 2. A: users change -> subset
  const a = await candidate(`ts-a-${stamp}`, "Users: show last name first", "claude-a");
  const shaA = await push(a, () => ({ "src/users.ts": SHOP["src/users.ts"].replace("`${first} ${last}`", "`${first} ${last}`.trim()") }), "users: trim display name");
  const pa = await processed(a, shaA);
  step("A checkpoint (ProcessRevision): subset", { sha: shaA, revision: pa.rev.status, wall_s: pa.wall_s, ...brief(ev(pa.evidence, "test_selection"), ev(pa.evidence, "test")) });

  // 3. land A -> full presubmit
  const landA = await api("POST", `/v1/repos/${REPO}/changes/${a.change}/land`, human, { note: "live: land A (full presubmit)" }, 202);
  const landAst = await waitWf("land", landA.workflow);
  const chA = await api("GET", `/v1/repos/${REPO}/changes/${a.change}`, SYS, undefined, 200);
  step("A landed (LandChange): full presubmit", { workflow: landA.workflow, status: landAst.output?.status, after: landAst.output?.after ?? null, ...brief(ev(chA.evidence, "test_selection", (d) => d.stage === "presubmit"), ev(chA.evidence, "presubmit")) });
  if (landAst.output?.status !== "landed") throw new Error(`A did not land: ${JSON.stringify(landAst.output ?? landAst.error)}`);

  // 4. B: money.round2 -> subset with time saved vs A's presubmit
  const b = await candidate(`ts-b-${stamp}`, "Money: banker's rounding", "codex-b");
  const shaB = await push(b, () => ({ "src/money.ts": SHOP["src/money.ts"].replace("Math.round(n * 100) / 100", "Math.round((n + Number.EPSILON) * 100) / 100") }), "money: epsilon rounding");
  const pb = await processed(b, shaB);
  step("B checkpoint (ProcessRevision): subset", { sha: shaB, revision: pb.rev.status, wall_s: pb.wall_s, ...brief(ev(pb.evidence, "test_selection"), ev(pb.evidence, "test")) });

  // 5. C: deps change -> full-suite fallback
  const c = await candidate(`ts-c-${stamp}`, "Add a dependency", "cursor-c");
  const shaC = await push(c, () => ({ "package.json": SHOP["package.json"].replace('"private": true,', '"private": true,\n  "engines": { "node": ">=22" },') }), "package: engines");
  const pc = await processed(c, shaC);
  step("C checkpoint (ProcessRevision): full fallback", { sha: shaC, revision: pc.rev.status, wall_s: pc.wall_s, ...brief(ev(pc.evidence, "test_selection"), ev(pc.evidence, "test")) });

  for (const id of subs) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
  out.finished_at = new Date().toISOString();
  out.total_s = (Date.now() - T0) / 1000;
  const dir = join(here, "../../../demo/evidence/testselect-live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), scrub(JSON.stringify(out, null, 2)) + "\n");
  log("wrote", join(dir, "run.json"));
}

main().catch((e) => {
  console.error("[live] FAILED:", scrub(e.stack ?? e));
  try {
    const dir = join(here, "../../../demo/evidence/testselect-live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.failed.json"), scrub(JSON.stringify({ ...out, error: String(e.message ?? e) }, null, 2)) + "\n");
  } catch {}
  process.exit(1);
});
