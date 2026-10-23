// Default (`hold`) wording, pinned exactly. The `conflicts: continue` wording is pinned in
// ownership.test.ts and conflicts.test.ts. Changing any string below is a deliberate protocol change
// and must update this file (and the sequencer, which must produce the same results).
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "./reference";

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (c: ReferenceCoordinator, agent: string, change: string) =>
  c.hello({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: caps, task: { id: `T-${agent}` }, change });

describe("default (hold) wording", () => {
  it("landing rejected by a trunk change: 'rebase and retry the landing.'", () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = hello(c, "claude-a", "I-a");
    const ea = c.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    c.system({ kind: "land", base_seq: ea.seq, change: "I-a", payload: { sha: "a".repeat(40), op_id: "op-1" } } as never);
    const b = hello(c, "claude-b", "I-b");
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    // B lands with the base it had before A's landing: trunk CAS fails.
    const landing = c.system({ kind: "land", base_seq: ea.seq, change: "I-b", payload: { sha: "b".repeat(40), op_id: "op-2" } } as never);
    expect(landing.status).toBe("rejected");
    expect(landing.diagnostics).toEqual([
      {
        severity: "error",
        code: "stale_overwrite",
        file: "src/x.ts",
        symbol: "src/x.ts#f",
        message: "Trunk changed src/x.ts#f in #3 after the landing base #2; rebase and retry the landing.",
        caused_by_seq: 3,
        caused_by_agent: "claude-a",
        caused_by_task: "T-claude-a",
      },
    ]);
  });

  it("use first, contract change second: a stale_assumption pushed to the user's change closes its gates", () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = hello(c, "claude-a", "I-a");
    const b = hello(c, "claude-b", "I-b");
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    c.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    const items = c.drain(b.session, 0).items.filter((i) => i.kind === "diagnostic");
    expect(items.map((i) => i.diagnostic?.code)).toEqual(["stale_assumption"]);
    const error = {
      severity: "error",
      code: "stale_assumption",
      file: "src/pricing.ts",
      symbol: "src/pricing.ts#calcTotal",
      message: "claude-a changed the signature of src/pricing.ts#calcTotal (#4) after your change started using it; your call sites may no longer match.",
      suggestion:
        "Read the new src/pricing.ts#calcTotal (event #4) and update your call sites; the commit gate stays closed until an edit of yours that uses src/pricing.ts#calcTotal is accepted. Or negotiate with claude-a (e.g. keep the old signature as an overload).",
      caused_by_seq: 4,
      caused_by_agent: "claude-a",
      caused_by_task: "T-claude-a",
    };
    expect(items[0]!.diagnostic).toEqual(error);
    expect(c.gate(b.session, { type: "gate", gate: "commit" })).toMatchObject({ allow: false, open_errors: [error] });
    // Releasing does not clear it: the call site is in the workspace (origin contract, §6.5).
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "release", base_seq: 4, payload: {} } });
    expect(c.gate(b.session, { type: "gate", gate: "commit" }).allow).toBe(false);
    // Redoing the call site against the new signature does.
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 5, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    expect(c.gate(b.session, { type: "gate", gate: "commit" })).toMatchObject({ allow: true });
  });

  it("contract_changed stays a warning for a change that writes (not uses) the symbol", () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = hello(c, "claude-a", "I-a");
    const b = hello(c, "claude-b", "I-b");
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "body" }] } });
    c.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    const told = c.drain(b.session, 0).items.filter((i) => i.kind === "diagnostic" && i.diagnostic?.code === "contract_changed");
    expect(told).toHaveLength(1);
    expect(told[0]!.diagnostic).toEqual({
      severity: "warning",
      code: "contract_changed",
      file: "src/pricing.ts",
      symbol: "src/pricing.ts#calcTotal",
      message: "claude-a changed the signature of src/pricing.ts#calcTotal (#4), which your change uses.",
      suggestion: "Re-read src/pricing.ts#calcTotal and adapt your call sites before your next edit, or negotiate (e.g. keep the old signature as an overload).",
      caused_by_seq: 4,
      caused_by_agent: "claude-a",
      caused_by_task: "T-claude-a",
    });
  });

  it("hold gate result for a stale stop: the full object, reason and open_errors", () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = hello(c, "claude-a", "I-a");
    const b = hello(c, "claude-b", "I-b");
    c.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    expect(c.gate(b.session, { type: "gate", gate: "stop" })).toEqual({
      type: "gate.result",
      gate: "stop",
      allow: false,
      reason:
        "1 open Weft error(s) must be resolved first:\n" +
        "[weft error] stale_assumption src/pricing.ts#calcTotal: You use src/pricing.ts#calcTotal, whose signature changed in #3 by claude-a after your base #2. " +
        "(caused by claude-a · task T-claude-a · event #3). Suggestion: Read the new src/pricing.ts#calcTotal (event #3) and update this call site, or negotiate with claude-a.",
      open_errors: [
        {
          severity: "error",
          code: "stale_assumption",
          file: "src/pricing.ts",
          symbol: "src/pricing.ts#calcTotal",
          message: "You use src/pricing.ts#calcTotal, whose signature changed in #3 by claude-a after your base #2.",
          suggestion: "Read the new src/pricing.ts#calcTotal (event #3) and update this call site, or negotiate with claude-a.",
          caused_by_seq: 3,
          caused_by_agent: "claude-a",
          caused_by_task: "T-claude-a",
        },
      ],
    });
  });
});
