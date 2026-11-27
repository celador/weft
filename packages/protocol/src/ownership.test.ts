// A conflict another agent's change caused: the agent that hit it is gated like any other (its stop
// and its commit are refused while the error is open), in both modes. Under `continue` the owner of
// the change is told as a warning and is not blocked.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "./reference";
import { ownedElsewhere, ownerNotice } from "./ownership";

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (c: ReferenceCoordinator, agent: string, change: string) =>
  c.hello({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: caps, task: { id: `T-${agent}` }, change });

/** The same scenario: A's signature change lands, then B (old base) calls it. Returns the coordinator and B's stale result. */
function staleCall(conflicts?: "hold" | "continue") {
  const coord = new ReferenceCoordinator({ repo: "demo", ...(conflicts ? { conflicts } : {}) });
  const a = hello(coord, "claude-a", "I-a");
  const b = hello(coord, "claude-b", "I-b");
  coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
  const r = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
  return { coord, a, b, r };
}

describe("default (hold): unchanged from today", () => {
  it("the stale agent's stop is refused, and the owner is not told", () => {
    const { coord, a, b, r } = staleCall();
    expect(r.verdict).toBe("reject");
    expect(coord.gate(b.session, { type: "gate", gate: "stop" }).allow).toBe(false);
    expect(coord.drain(a.session, 0).items.filter((i) => i.kind === "diagnostic")).toEqual([]);
    expect(r.diagnostics.find((d) => d.code === "stale_assumption")?.suggestion).toContain("Read the new src/pricing.ts#calcTotal");
  });
});

describe("reads amendment (§6.2 R2a) contract_changed suggestion per mode", () => {
  /** B's change started before A's signature change of calcTotal; B's amendment then adds the read. */
  function amended(conflicts?: "hold" | "continue") {
    const coord = new ReferenceCoordinator({ repo: "demo", ...(conflicts ? { conflicts } : {}) });
    const a = hello(coord, "claude-a", "I-a");
    const b = hello(coord, "claude-b", "I-b");
    const eb = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: [], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    const r = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "intent", base_seq: eb.seq!, reads: ["src/pricing.ts#calcTotal"] } });
    return r.diagnostics.find((d) => d.code === "contract_changed")!;
  }

  it("continue: keep editing other tasks instead of adapting; hold keeps 'adapt your call sites'", () => {
    expect(amended("continue").suggestion).toBe(
      "Keep editing your other tasks instead of adapting your call sites to claude-a's new src/pricing.ts#calcTotal (event #4); do not adopt their partial work. claude-a owns the change; negotiate with claude-a if you need the old contract.",
    );
    expect(amended("hold").suggestion).toBe(amended().suggestion);
    expect(amended().suggestion).toContain("adapt your call sites, or negotiate");
    // A warning: it is not an open error, so it must not use the phrase harnesses stop on (#15).
    expect(amended("continue").suggestion).not.toContain("owns the conflict");
  });
});

describe("pushed contract_changed (§6.3) suggestion per mode", () => {
  /** As in the R2a test, B's reads amendment adds calcTotal and quote; A then changes quote's signature, so B is pushed a warning. */
  function pushed(conflicts?: "hold" | "continue") {
    const coord = new ReferenceCoordinator({ repo: "demo", ...(conflicts ? { conflicts } : {}) });
    const a = hello(coord, "claude-a", "I-a");
    const b = hello(coord, "claude-b", "I-b");
    const eb = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: [], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    const ea = coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    const am = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "intent", base_seq: eb.seq!, reads: ["src/pricing.ts#calcTotal", "src/pricing.ts#Pricer.quote"] } });
    const before = coord.drain(a.session, 0).items.length;
    coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: Math.max(ea.seq!, am.seq!), files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#Pricer.quote", kind: "signature" }] } });
    const d = coord.drain(b.session, 0).items.flatMap((i) => (i.kind === "diagnostic" && i.diagnostic?.code === "contract_changed" && i.diagnostic.symbol === "src/pricing.ts#Pricer.quote" ? [i.diagnostic] : []))[0]!;
    const owner = coord.drain(a.session, 0).items.slice(before).filter((i) => i.kind === "diagnostic");
    return { d, owner };
  }

  it("continue: no claim that the owner is told, and the owner really gets nothing; hold text unchanged", () => {
    const cont = pushed("continue");
    expect(cont.d.severity).toBe("warning");
    expect(cont.d.suggestion).toBe(
      "Keep editing your other tasks instead of adapting your call sites to claude-a's change; do not adopt their partial work. claude-a owns the change; negotiate with claude-a if you need the old contract.",
    );
    expect(cont.d.suggestion).not.toContain("is told about it");
    // Warnings never notify the owner (only open errors do), even under continue.
    expect(cont.owner).toEqual([]);
    expect(pushed("hold").d.suggestion).toBe(
      "Re-read src/pricing.ts#Pricer.quote and adapt your call sites before your next edit, or negotiate (e.g. keep the old signature as an overload).",
    );
    expect(pushed().d.suggestion).toBe(pushed("hold").d.suggestion);
  });
});

describe("conflicts: continue (opt-in): the hit agent is still gated, the owner is told", () => {
  it("stop and commit are refused with the conflict open; the owner gets a warning, not a block", () => {
    const coord = new ReferenceCoordinator({ repo: "demo", conflicts: "continue" });
    const a = hello(coord, "claude-a", "I-a");
    const b = hello(coord, "claude-b", "I-b");
    // A changes calcTotal's signature and it is accepted.
    coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    // B, still on the old base, calls calcTotal: stale_assumption, the edit is rejected.
    const r = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.map((d) => d.code)).toContain("stale_assumption");

    // B's stop and its commits are refused while the conflict is open (same gate as hold).
    const stop = coord.gate(b.session, { type: "gate", gate: "stop" });
    expect(stop.allow).toBe(false);
    expect(stop.open_errors.map((d) => d.code)).toContain("stale_assumption");
    expect(coord.gate(b.session, { type: "gate", gate: "commit" }).allow).toBe(false);

    // A, the owner, is told as a warning and is not blocked by it.
    const told = coord.drain(a.session, 0).items.filter((i) => i.kind === "diagnostic");
    expect(told.map((i) => i.diagnostic?.severity)).toContain("warning");
    expect(told.find((i) => i.diagnostic?.code === "stale_assumption")?.diagnostic?.message).toContain("conflicts with your change");
    expect(coord.gate(a.session, { type: "gate", gate: "commit" }).allow).toBe(true);
    expect(coord.gate(a.session, { type: "gate", gate: "stop" }).allow).toBe(true);
  });
});

describe("ownership rules", () => {
  const d = { severity: "error", code: "stale_assumption", file: "src/a.ts", symbol: "src/a.ts#f", message: "editor's message", suggestion: "Keep working on your other tasks.", caused_by_seq: 4, caused_by_agent: "claude-a" } as const;
  it("a conflict with no cause agent is never treated as another agent's", () => {
    const { caused_by_agent: _ignored, ...noCause } = d;
    expect(ownedElsewhere(noCause as never, "claude-b")).toBe(false);
    expect(ownedElsewhere(d as never, "claude-b")).toBe(true);
    expect(ownedElsewhere(d as never, "claude-a")).toBe(false);
  });
  it("the owner's notice carries owner-directed text, not the editor's suggestion", () => {
    const n = ownerNotice(d as never, "claude-b", "edit");
    expect(n.severity).toBe("warning");
    expect(n.suggestion).not.toContain("Keep working on your other tasks.");
    expect(n.suggestion).toContain("does not adopt your change");
    expect(n.message).toContain("conflicts with your change #4");
  });
});
