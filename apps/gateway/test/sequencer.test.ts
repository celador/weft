// Named behaviours of the sequencer, exercised end to end over HTTP against the real
// RepoCoordinator Durable Object (real Workers clock, no injection).

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ActionResult, Diagnostic, EventPage, EventRecord, InboxBatch, Verdict, Welcome } from "@weft/protocol";
import type { JournalEntry, RepoCoordinator, Result } from "@weft/sequencer";
import { ADMIN, agentToken, call, createRepo, hello, humanToken, observerToken, systemToken, uniqueRepo, wcp } from "./helpers";

const K = {
  refresh: "src/auth/session.ts#refreshToken",
  fetch: "src/api/client.ts#fetchWithAuth",
  parse: "src/util/parse.ts#parseJson",
};

async function world(init: Record<string, unknown> = {}) {
  const repo = uniqueRepo("seq");
  await createRepo(repo, init);
  const ta = await agentToken(repo, "claude-a");
  const tb = await agentToken(repo, "codex-b");
  const base = `/v1/repos/${repo}`;
  const a = await wcp<Welcome>("POST", `${base}/sessions`, ta, hello("claude-a", "I-a"));
  const b = await wcp<Welcome>("POST", `${base}/sessions`, tb, hello("codex-b", "I-b"));
  // Each side tracks the last delivered_through it saw: that is the only legal base (§5.2).
  const seen = { a: a.delivered_through, b: b.delivered_through };
  const sid = (who: "a" | "b") => (who === "a" ? a.session : b.session);
  const tok = (who: "a" | "b") => (who === "a" ? ta : tb);
  const submit = async (who: "a" | "b", event: Record<string, unknown>, mode: "check" | "commit" = "commit", headers: Record<string, string> = {}) => {
    const v = await wcp<Verdict>("POST", `${base}/sessions/${sid(who)}/events`, tok(who), { type: "submit", mode, event: { base_seq: seen[who], ...event } }, headers);
    seen[who] = v.delivered_through;
    return v;
  };
  const drain = async (who: "a" | "b", ack?: number) => {
    const r = await wcp<InboxBatch>("POST", `${base}/sessions/${sid(who)}/inbox`, tok(who), { type: "inbox.drain", ...(ack !== undefined ? { ack } : {}) });
    seen[who] = r.delivered_through;
    return r;
  };
  const gate = (who: "a" | "b") => wcp<{ allow: boolean; open_errors: Diagnostic[] }>("POST", `${base}/sessions/${sid(who)}/gate`, tok(who), { type: "gate", gate: "stop" });
  return { repo, base, ta, tb, a, b, seen, submit, drain, gate };
}

describe("sequencer behaviours (HTTP → DO)", () => {
  it("accept: assigns gapless seqs, summary, delivered_through, and soft claims", async () => {
    const w = await world();
    expect(w.a.head_seq).toBe(1);
    expect(w.b.head_seq).toBe(2);
    const v = await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.refresh, kind: "body" }], intent: "add a retry budget" });
    expect(v).toMatchObject({ type: "verdict", verdict: "accept", mode: "commit", seq: 3, head_seq: 3, delivered_through: 3, diagnostics: [] });
    expect(v.summary).toBe("claude-a edited refreshToken in src/auth/session.ts — add a retry budget");
    const page = await wcp<EventPage>("GET", `${w.base}/events`, await observerToken([w.repo]));
    expect(page.events.map((e) => [e.seq, e.kind, e.status])).toEqual([
      [1, "join", "accepted"],
      [2, "join", "accepted"],
      [3, "edit", "accepted"],
    ]);
    const check = await w.submit("a", { kind: "edit", base_seq: 3, writes: [{ key: K.refresh, kind: "body" }] }, "check");
    expect(check).toMatchObject({ verdict: "accept", mode: "check", seq: null, head_seq: 3 }); // an accepting check appends nothing
  });

  it("write-write error: editing a symbol that landed on trunk after your base is stale_overwrite", async () => {
    const w = await world();
    await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.fetch, kind: "body" }] }); // #3
    const sys = await systemToken([w.repo], "landing-queue");
    const land = await wcp<EventRecord>("POST", `${w.base}/system/events`, sys, { kind: "land", base_seq: 3, change: "I-a", payload: { sha: "abc1234", op_id: "op_1" } });
    expect(land).toMatchObject({ seq: 4, kind: "land", status: "accepted", actor: { type: "system", id: "landing-queue" }, writes: [{ key: K.fetch, kind: "body" }] });
    const v = await w.submit("b", { kind: "edit", base_seq: 2, writes: [{ key: K.fetch, kind: "body" }] });
    expect(v.verdict).toBe("reject");
    expect(v.seq).toBe(5); // rejected records are logged
    expect(v.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "stale_overwrite", symbol: K.fetch, caused_by_seq: 4, caused_by_agent: "claude-a" })]);
    expect((await w.gate("b")).allow).toBe(false);
    const ev = await wcp<EventRecord>("GET", `${w.base}/events/5`, await observerToken([w.repo]));
    expect(ev.summary.startsWith("Blocked: codex-b")).toBe(true);
  });

  it("signature-read error: reading a symbol whose signature changed after base rejects with stale_assumption", async () => {
    const w = await world();
    await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.refresh, kind: "signature" }] }); // #3
    const v = await w.submit("b", { kind: "edit", base_seq: 2, reads: [K.refresh], writes: [{ key: K.fetch, kind: "body" }] }, "check");
    expect(v).toMatchObject({ verdict: "reject", mode: "check", seq: 4 });
    expect(v.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "stale_assumption", symbol: K.refresh, caused_by_seq: 3, caused_by_agent: "claude-a" })]);
    expect(v.context).toContain("[weft error] stale_assumption");
    // B was also pushed a contract_changed warning at #3? No: B had no reads of refreshToken before #3.
    expect(v.inbox).toEqual([]);
    // Rebased past #3 (base 4), the same edit is accepted and the gate opens.
    const ok = await w.submit("b", { kind: "edit", base_seq: 4, reads: [K.refresh], writes: [{ key: K.fetch, kind: "body" }] });
    expect(ok.verdict).toBe("accept");
    expect((await w.gate("b")).allow).toBe(true);
  });

  it("body-read warning: a body-only change after base is stale_read (warning) and does not reject", async () => {
    const w = await world();
    await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.refresh, kind: "body" }] });
    const v = await w.submit("b", { kind: "edit", base_seq: 2, reads: [K.refresh], writes: [{ key: K.fetch, kind: "body" }] });
    expect(v.verdict).toBe("accept");
    expect(v.diagnostics).toEqual([expect.objectContaining({ severity: "warning", code: "stale_read", symbol: K.refresh, caused_by_seq: 3 })]);
    expect((await w.gate("b")).allow).toBe(true);
  });

  it("arbitration asymmetry: only the later (junior) agent gets the warning/error; the holder gets info", async () => {
    const w = await world();
    await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.parse, kind: "body" }] }); // A born at #3: senior
    const vb = await w.submit("b", { kind: "edit", writes: [{ key: K.parse, kind: "body" }] });
    expect(vb.verdict).toBe("accept");
    expect(vb.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "claim_wait", arbitration: expect.objectContaining({ policy: "wound-wait", outcome: "wait", winner: { agent: "claude-a", change: "I-a" }, loser: { agent: "codex-b", change: "I-b" } }) }),
    ]);
    const ia = await w.drain("a");
    expect(ia.items.map((i) => [i.kind, i.diagnostic?.severity, i.diagnostic?.code])).toEqual([["diagnostic", "info", "claim_contended"]]);
    expect(ia.items.every((i) => i.diagnostic?.severity !== "warning" && i.diagnostic?.severity !== "error")).toBe(true);
    // The senior keeps winning: A edits again, gets no warning; B is the one notified (info).
    const va = await w.submit("a", { kind: "edit", writes: [{ key: K.parse, kind: "body" }] });
    expect(va.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    // A firm claim by the senior turns the junior's wait into an error.
    await w.submit("a", { kind: "claim", writes: [{ key: K.fetch, kind: "body" }], payload: { firm: true, source: "explicit" } });
    const firm = await w.submit("b", { kind: "edit", writes: [{ key: K.fetch, kind: "body" }] });
    expect(firm.verdict).toBe("reject");
    expect(firm.diagnostics[0]).toMatchObject({ severity: "error", code: "claim_wait" });
    expect((await w.gate("a")).allow).toBe(true);
    expect((await w.gate("b")).allow).toBe(false);
  });

  it("arbitration asymmetry under wound-wait: a higher-priority junior wounds the holder (holder gets the error)", async () => {
    const repo = uniqueRepo("wound");
    await createRepo(repo);
    const base = `/v1/repos/${repo}`;
    const ta = await agentToken(repo, "a");
    const tb = await agentToken(repo, "b");
    const a = await wcp<Welcome>("POST", `${base}/sessions`, ta, hello("a", "C-a", 0));
    const b = await wcp<Welcome>("POST", `${base}/sessions`, tb, hello("b", "C-b", 5));
    await wcp<Verdict>("POST", `${base}/sessions/${a.session}/events`, ta, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: K.parse, kind: "body" }] } });
    const vb = await wcp<Verdict>("POST", `${base}/sessions/${b.session}/events`, tb, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 2, writes: [{ key: K.parse, kind: "body" }] } });
    expect(vb.diagnostics).toEqual([expect.objectContaining({ severity: "info", code: "claim_contended", arbitration: expect.objectContaining({ outcome: "wound" }) })]);
    const ia = await wcp<InboxBatch>("POST", `${base}/sessions/${a.session}/inbox`, ta, { type: "inbox.drain" });
    expect(ia.items.map((i) => i.diagnostic?.code)).toEqual(["claim_wounded"]);
    expect(ia.open_errors.map((d) => d.code)).toEqual(["claim_wounded"]);
  });

  it("inbox drain: at-least-once delivery until acked; delivered_through advances; base_ahead enforced", async () => {
    const w = await world();
    await w.submit("b", { kind: "edit", base_seq: 2, reads: [K.refresh], writes: [{ key: K.fetch, kind: "body" }] }); // #3: B reads refreshToken
    await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.refresh, kind: "signature" }] }); // #4 → contract_changed to B
    const msgTok = await humanToken([w.repo]);
    await wcp<ActionResult>("POST", `${w.base}/actions`, msgTok, { type: "action", action: "message", to: { agent: "codex-b" }, text: "keep the old signature", intent: "steer" }); // #5
    const first = await w.drain("b");
    expect(first.items.map((i) => [i.id, i.seq, i.kind])).toEqual([
      [1, 4, "diagnostic"],
      [2, 5, "message"],
    ]);
    expect(first.items[0]!.diagnostic).toMatchObject({ code: "contract_changed", severity: "warning" });
    expect(first.items[1]!.record).toMatchObject({ actor: { type: "human", id: "john" }, kind: "message" });
    expect(first.delivered_through).toBe(5);
    expect(first.context).toContain("contract_changed");
    // Not acked → redelivered.
    expect((await w.drain("b")).items.map((i) => i.id)).toEqual([1, 2]);
    // Ack 1 → only 2 remains; ack via submit.inbox_ack also works.
    expect((await w.drain("b", 1)).items.map((i) => i.id)).toEqual([2]);
    const v = await wcp<Verdict>("POST", `${w.base}/sessions/${w.b.session}/events`, w.tb, { type: "submit", mode: "check", inbox_ack: 2, event: { kind: "intent", base_seq: 5 } });
    expect(v.inbox).toEqual([]);
    // base_seq beyond what was delivered is refused.
    const ahead = await call("POST", `${w.base}/sessions/${w.b.session}/events`, w.tb, { type: "submit", mode: "commit", event: { kind: "intent", base_seq: 99 } });
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ error: { code: "base_ahead", details: { delivered_through: 5 } } });
  });

  it("replay determinism: the DO journal replayed into a fresh DO reproduces the exact log and state", async () => {
    const w = await world({ policy: "wait-die" });
    await w.submit("a", { kind: "edit", base_seq: 1, writes: [{ key: K.parse, kind: "signature" }], diff: "+export function parseJson(s: string, strict = false) {}" });
    await w.submit("b", { kind: "edit", reads: [K.parse], writes: [{ key: K.parse, kind: "body" }] }); // claim_die → reject
    await w.submit("b", { kind: "edit", base_seq: 2, reads: [K.parse], writes: [{ key: K.fetch, kind: "body" }] }); // stale_assumption → reject
    await w.drain("b");
    const live = env.WEFT_REPO.get(env.WEFT_REPO.idFromName(w.repo));
    const journal = (await live.journal()) as unknown as Result<JournalEntry[]>;
    if (!journal.ok) throw new Error("journal");
    const replica = env.WEFT_REPO.get(env.WEFT_REPO.idFromName(`${w.repo}-replica`));
    await replica.init({ repo: w.repo, policy: "wait-die" });
    await runInDurableObject(replica, async (inst: RepoCoordinator) => {
      let t = 0;
      inst.setClock(() => t);
      for (const e of journal.value) {
        t = e.at;
        await inst.op(e.op, e.args as unknown[]);
      }
    });
    const [a, b] = [(await live.dump()) as unknown as Result<Record<string, unknown[]>>, (await replica.dump()) as unknown as Result<Record<string, unknown[]>>];
    expect(a.ok && b.ok).toBe(true);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const log = a.ok ? (a.value.events as Array<{ status: string }>) : [];
    expect(log.map((r) => r.status)).toEqual(["accepted", "accepted", "accepted", "rejected", "rejected"]);
  });

  it("Idempotency-Key: a retried hook does not append twice", async () => {
    const w = await world();
    const ev = { kind: "edit", base_seq: 1, writes: [{ key: K.refresh, kind: "body" }] };
    const v1 = await w.submit("a", ev, "commit", { "idempotency-key": "call-42" });
    const v2 = await w.submit("a", ev, "commit", { "idempotency-key": "call-42" });
    expect(v2).toEqual(v1);
    const page = await wcp<EventPage>("GET", `${w.base}/events`, await observerToken([w.repo]));
    expect(page.head_seq).toBe(3);
  });

  it("claims with TTL expire through the Durable Object alarm (system release record)", async () => {
    const repo = uniqueRepo("ttl");
    await createRepo(repo, { claims: { lease_ms: 200, firm_max_ms: 1000 }, session_ttl_ms: 60_000 });
    const t = await agentToken(repo, "a");
    const s = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t, hello("a", "C-a"));
    await wcp<Verdict>("POST", `/v1/repos/${repo}/sessions/${s.session}/events`, t, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: K.parse, kind: "body" }] } });
    const stub = env.WEFT_REPO.get(env.WEFT_REPO.idFromName(repo));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const page = await wcp<EventPage>("GET", `/v1/repos/${repo}/events`, await observerToken([repo]));
    expect(page.events.at(-1)).toMatchObject({ kind: "release", actor: { type: "system", id: "coordinator" }, payload: { keys: [K.parse], reason: "expired" }, summary: "a released parseJson (expired)" });
  });

  it("admin policy endpoint: applies the claims policy to a legacy repo, refuses bad input and unknown repos", async () => {
    const repo = uniqueRepo("policy");
    await createRepo(repo, { claims: null });
    const t = await agentToken(repo, "a");
    expect((await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t, hello("a", "C-a"))).policy).toEqual({ arbitration: "wound-wait", escalation: "auto" });
    const bad = await call("POST", `/v1/admin/repos/${repo}/policy`, ADMIN, { claims: { lease_ms: 0, firm_max_ms: 1 } });
    expect(bad.status).toBe(400);
    expect((await call("POST", `/v1/admin/repos/${repo}/policy`, "not-admin", { claims: { lease_ms: 1, firm_max_ms: 1 } })).status).toBe(401);
    expect((await call("POST", `/v1/admin/repos/${repo}-nope/policy`, ADMIN, { claims: { lease_ms: 1, firm_max_ms: 1 } })).status).toBe(404);
    const ok = await call("POST", `/v1/admin/repos/${repo}/policy`, ADMIN, { claims: { lease_ms: 120_000, firm_max_ms: 600_000 } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ arbitration: "wound-wait", escalation: "auto", claims: { lease_ms: 120_000, firm_max_ms: 600_000 } });
    const w = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t, hello("a", "C-a"));
    expect(w).toMatchObject({ claim_ttl_ms: 120_000, policy: { claims: { lease_ms: 120_000, firm_max_ms: 600_000 } } });
    expect((await call("POST", "/v1/admin/repos", ADMIN, { repo: uniqueRepo("badclaims"), claims: { lease_ms: "x" } })).status).toBe(400);
  });

  it("human pause blocks edits (agent_paused) but lets the agent stop; resume restores", async () => {
    const w = await world();
    const h = await humanToken([w.repo], "john");
    const p = await wcp<ActionResult>("POST", `${w.base}/actions`, h, { type: "action", action: "pause", agent: "codex-b", reason: "hold on" });
    expect(p.record).toMatchObject({ kind: "control", actor: { type: "human", id: "john" }, summary: "john paused codex-b" });
    const v = await w.submit("b", { kind: "edit", writes: [{ key: K.fetch, kind: "body" }] });
    expect(v.diagnostics[0]).toMatchObject({ code: "agent_paused", severity: "error" });
    expect((await w.gate("b")).allow).toBe(true);
    await wcp<ActionResult>("POST", `${w.base}/actions`, h, { type: "action", action: "resume", agent: "codex-b" });
    expect((await w.submit("b", { kind: "edit", writes: [{ key: K.fetch, kind: "body" }] })).verdict).toBe("accept");
  });
});
