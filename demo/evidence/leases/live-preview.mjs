// Live two-agent check of L1 against the preview gateway. Prints no tokens.
import { readFileSync } from "node:fs";
const U = "https://weft-gateway-preview.elier.ai";
const ADMIN = readFileSync(`${process.env.HOME}/.config/weft/preview-admin-token`, "utf8").trim();
const repo = `l1-verify-${Date.now().toString(36)}`;
const X = "src/auth/session.ts#refreshToken", Y = "src/api/client.ts#fetchWithAuth", Z = "src/cart.ts#cartSummary";
async function call(method, path, tok, body) {
  const r = await fetch(U + path, { method, headers: { "wcp-version": "0.1", authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) process.exitCode = 1; };
const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" };
const hello = (id, change) => ({ type: "hello", protocol: "wcp/0.1", agent: { id, harness: "claude-code" }, capabilities: caps, task: { id: `T-${id}` }, change });
const tok = async (spec) => (await call("POST", "/v1/admin/tokens", ADMIN, spec)).body.token;

console.log(`repo ${repo} on ${U}`);
ok((await call("POST", "/v1/admin/repos", ADMIN, { repo })).status === 201, "create repo (new repo: default claims policy)");
const ta = await tok({ principal: "agent-a", scopes: ["agent"], repos: [repo], agent: "agent-a" });
const tb = await tok({ principal: "agent-b", scopes: ["agent"], repos: [repo], agent: "agent-b" });
const tobs = await tok({ principal: "l1-verify", scopes: ["observe"], repos: [repo] });
const base = `/v1/repos/${repo}`;
const sub = (t, s, event, mode = "commit") => call("POST", `${base}/sessions/${s}/events`, t, { type: "submit", mode, event });
const gate = async (t, s) => (await call("POST", `${base}/sessions/${s}/gate`, t, { type: "gate", gate: "stop" })).body;
const events = async (after = 0) => (await call("GET", `${base}/events?after=${after}&limit=200`, tobs)).body.events;

let A = (await call("POST", `${base}/sessions`, ta, hello("agent-a", "C-a"))).body;
let B = (await call("POST", `${base}/sessions`, tb, hello("agent-b", "C-b"))).body;
ok(A.claim_ttl_ms === 120000 && A.policy.claims?.lease_ms === 120000 && A.policy.claims?.firm_max_ms === 600000, `welcome: claim_ttl_ms=${A.claim_ttl_ms} policy.claims=${JSON.stringify(A.policy.claims)}`);

let v = (await sub(ta, A.session, { kind: "edit", base_seq: A.delivered_through, writes: [{ key: X, kind: "body" }] })).body;
ok(v.verdict === "accept", `agent-a edits refreshToken -> #${v.seq} accept (soft lease)`);
let c = (await sub(tb, B.session, { kind: "edit", base_seq: B.delivered_through, writes: [{ key: X, kind: "body" }] }, "check")).body;
ok(c.diagnostics.some((d) => d.code === "claim_wait"), `agent-b check on refreshToken: ${c.diagnostics.map((d) => `${d.code}/${d.severity}`).join(",")}`);
await call("DELETE", `${base}/sessions/${A.session}`, ta, { type: "bye", reason: "done" });
let ev = (await events()).slice(-2);
ok(ev[0]?.kind === "leave" && ev[1]?.kind === "release" && ev[1]?.payload?.reason === "session_ended", `agent-a bye -> ${ev.map((e) => `#${e.seq} ${e.summary}`).join(" | ")}`);
c = (await sub(tb, B.session, { kind: "edit", base_seq: c.delivered_through, writes: [{ key: X, kind: "body" }] }, "check")).body;
ok(c.diagnostics.length === 0, "agent-b check on refreshToken right after: clean");

// Firm claim with a hard limit, holder heartbeating (DO alarm releases it).
A = (await call("POST", `${base}/sessions`, ta, hello("agent-a", "C-a"))).body;
v = (await sub(ta, A.session, { kind: "claim", base_seq: A.delivered_through, writes: [{ key: Z, kind: "body" }], payload: { firm: true, source: "explicit", ttl_ms: 4000 } })).body;
ok(v.verdict === "accept", `agent-a firmly claims cartSummary for 4 s -> #${v.seq}`);
const t0 = Date.now();
let released;
while (Date.now() - t0 < 30000) {
  await call("POST", `${base}/sessions/${A.session}/heartbeat`, ta, { type: "heartbeat" });
  await call("POST", `${base}/sessions/${B.session}/heartbeat`, tb, { type: "heartbeat" });
  released = (await events(v.seq)).find((e) => e.kind === "release" && e.payload?.keys?.includes(Z));
  if (released) break;
  await new Promise((r) => setTimeout(r, 1000));
}
ok(released?.payload?.reason === "expired", `firm claim released by the DO alarm after ${((Date.now() - t0) / 1000).toFixed(1)} s despite heartbeats every 1 s: #${released?.seq} ${released?.summary}`);

// #17 live: commit-mode rejection survives release-all and bye + hello.
v = (await sub(ta, A.session, { kind: "claim", base_seq: A.delivered_through, writes: [{ key: Y, kind: "body" }], payload: { firm: true, source: "explicit" } })).body;
let r = (await sub(tb, B.session, { kind: "edit", base_seq: c.delivered_through, writes: [{ key: Y, kind: "body" }] })).body;
ok(r.verdict === "reject" && r.diagnostics[0]?.code === "claim_wait", `agent-b edit of fetchWithAuth (firm claim of agent-a) -> #${r.seq} reject ${r.diagnostics[0]?.code}`);
ok((await gate(tb, B.session)).allow === false, "agent-b stop gate closed");
await sub(tb, B.session, { kind: "release", base_seq: r.delivered_through, payload: {} });
ok((await gate(tb, B.session)).allow === false, "agent-b release (all) -> stop gate still closed");
await call("DELETE", `${base}/sessions/${B.session}`, tb, { type: "bye" });
B = (await call("POST", `${base}/sessions`, tb, hello("agent-b", "C-b"))).body;
const g = await gate(tb, B.session);
const inbox = (await call("POST", `${base}/sessions/${B.session}/inbox`, tb, { type: "inbox.drain" })).body;
ok(g.allow === false && inbox.items.some((i) => i.kind === "diagnostic" && i.seq === r.seq), `agent-b bye + new hello -> gate still closed (${g.open_errors.map((d) => d.code)}), error redelivered as inbox item for #${r.seq}`);
const summary = (await call("GET", "/v1/repos", tobs)).body.repos.find((x) => x.repo === repo);
console.log(`summary: open_conflicts=${summary.open_conflicts} policy=${JSON.stringify(summary.policy)}`);

// Legacy repo + journaled policy migration.
const legacy = `${repo}-legacy`;
await call("POST", "/v1/admin/repos", ADMIN, { repo: legacy, claims: null });
const tl = await tok({ principal: "agent-a", scopes: ["agent"], repos: [legacy], agent: "agent-a" });
let L = (await call("POST", `/v1/repos/${legacy}/sessions`, tl, hello("agent-a", "C-a"))).body;
ok(L.claim_ttl_ms === 1800000 && !L.policy.claims, `legacy repo welcome: claim_ttl_ms=${L.claim_ttl_ms}, no claims policy`);
const p = await call("POST", `/v1/admin/repos/${legacy}/policy`, ADMIN, { claims: { lease_ms: 120000, firm_max_ms: 600000 } });
L = (await call("POST", `/v1/repos/${legacy}/sessions`, tl, hello("agent-a", "C-a"))).body;
ok(p.status === 200 && L.claim_ttl_ms === 120000, `admin policy migration -> ${p.status} ${JSON.stringify(p.body)}; new welcome claim_ttl_ms=${L.claim_ttl_ms}`);
console.log("\nlog:");
for (const e of await events()) console.log(`  #${e.seq} ${e.status} ${e.kind.padEnd(8)} ${e.summary}`);
