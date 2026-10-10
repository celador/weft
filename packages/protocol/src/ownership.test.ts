// A conflict another agent's change caused: the agent that hit it may stop; its commit stays
// blocked; the owner of the change is told as a warning and is not blocked.
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

describe("conflicts: continue (opt-in): the hit agent may stop, the owner is told", () => {
  it("stop is allowed with the conflict open; commit is still refused; the owner gets a warning, not a block", () => {
    const coord = new ReferenceCoordinator({ repo: "demo", conflicts: "continue" });
    const a = hello(coord, "claude-a", "I-a");
    const b = hello(coord, "claude-b", "I-b");
    // A changes calcTotal's signature and it is accepted.
    coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    // B, still on the old base, calls calcTotal: stale_assumption, the edit is rejected.
    const r = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.map((d) => d.code)).toContain("stale_assumption");

    // B may stop with the conflict open; its commits are still refused.
    const stop = coord.gate(b.session, { type: "gate", gate: "stop" });
    expect(stop.allow).toBe(true);
    expect(stop.open_errors.length).toBeGreaterThan(0);
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
    const n = ownerNotice(d as never, "claude-b");
    expect(n.severity).toBe("warning");
    expect(n.suggestion).not.toContain("Keep working on your other tasks.");
    expect(n.suggestion).toContain("does not adopt your change");
    expect(n.message).toContain("conflicts with your change #4");
  });
});
