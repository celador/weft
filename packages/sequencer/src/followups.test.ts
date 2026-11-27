// #18 follow-ups (block mode, claims, conflicts: continue), each checked on the SqlCoordinator
// and on the reference coordinator with the same calls: the two must answer identically.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator, type Gate, type GateResult, type Hello, type InboxBatch, type Submit, type Verdict, type Welcome } from "@weft/protocol";
import { SqlCoordinator, type CoordinatorInit } from "./coordinator";
import { JournaledCoordinator, replay } from "./journal";
import { nodeSql } from "./node-sqlite";

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (id: string, change: string, task = `T-${id}`): Hello => ({ type: "hello", protocol: "wcp/0.1", agent: { id, harness: "claude-code" }, capabilities: caps, task: { id: task }, change });
const MODE = { c: "commit", k: "check" } as const;
const edit = (base: number, key: string, o: { reads?: string[]; kind?: "body" | "signature"; mode?: "c" | "k" } = {}): Submit => ({
  type: "submit",
  mode: MODE[o.mode ?? "c"],
  event: { kind: "edit", base_seq: base, ...(o.reads ? { reads: o.reads } : {}), writes: [{ key, kind: o.kind ?? "body" }] },
});
const claim = (base: number, key: string, firm: boolean): Submit => ({
  type: "submit",
  mode: MODE.c,
  event: { kind: "claim", base_seq: base, writes: [{ key, kind: "body" }], payload: { firm, source: "explicit" } },
});

/** The calls a test makes, on either coordinator. */
type Target = {
  hello(h: Hello): Welcome;
  submit(s: string, m: Submit): Verdict;
  drain(s: string, ack?: number): InboxBatch;
  gate(s: string, g: Gate["gate"]): GateResult;
  bye(s: string): void;
};

/** A fixed clock: the two coordinators read it a different number of times per call. */
const START = Date.parse("2026-10-05T12:00:00.000Z");

function sqlTarget(init: CoordinatorInit): Target & { j: JournaledCoordinator } {
  const t = START;
  const sql = nodeSql();
  SqlCoordinator.init(sql, init);
  const j = new JournaledCoordinator(sql, () => t);
  return {
    j,
    hello: (h) => j.call<Welcome>("hello", h),
    submit: (s, m) => j.call<Verdict>("submit", s, m),
    drain: (s, ack) => j.call<InboxBatch>("drain", s, ack ?? 0),
    gate: (s, g) => j.call<GateResult>("gate", s, { type: "gate", gate: g }),
    bye: (s) => void j.call("bye", s),
  };
}

function refTarget(init: CoordinatorInit): Target {
  const t = START;
  const c = new ReferenceCoordinator({ ...init, now: () => t });
  return {
    hello: (h) => c.hello(h),
    submit: (s, m) => c.submit(s, m),
    drain: (s, ack) => c.drain(s, ack ?? 0),
    gate: (s, g) => c.gate(s, { type: "gate", gate: g }),
    bye: (s) => c.bye(s),
  };
}

/** Run `fn` on both coordinators; their results must be equal. Returns the sequencer's. */
function both<T>(init: CoordinatorInit, fn: (t: Target) => T): T {
  const a = fn(sqlTarget(init));
  const b = fn(refTarget(init));
  expect(a).toEqual(b);
  return a;
}

const X = "src/x.ts#f";
const Y = "src/y.ts#g";
const notices = (b: InboxBatch, code?: string) => b.items.filter((i) => i.kind === "diagnostic" && (!code || i.diagnostic?.code === code));

describe("block mode (#12 follow-ups)", () => {
  it("an agent's own claim never denies its other task's edit under block; advise output is unchanged", () => {
    const run = (enforcement: "advise" | "block") =>
      both({ repo: "r", enforcement }, (t) => {
        const a1 = t.hello(hello("claude-a", "I-a1", "T-1"));
        const a2 = t.hello(hello("claude-a", "I-a2", "T-9"));
        t.submit(a1.session, edit(a1.delivered_through, X));
        return t.submit(a2.session, edit(a2.delivered_through, X));
      });
    expect(run("block")).toMatchObject({ verdict: "accept", diagnostics: [] });
    // advise: the same agent's other change still gets its warning, as before.
    expect(run("advise")).toMatchObject({ verdict: "accept", diagnostics: [{ code: "claim_wait", severity: "warning" }] });
  });

  it("a claim_wait never holds the stop or commit gate: soft hold under block, firm hold under advise", () => {
    for (const [enforcement, firm] of [["block", false], ["advise", true]] as const) {
      const out = both({ repo: "r", enforcement }, (t) => {
        const a = t.hello(hello("claude-a", "I-a"));
        const b = t.hello(hello("codex-b", "I-b"));
        t.submit(a.session, claim(a.delivered_through, X, firm));
        const v = t.submit(b.session, edit(b.delivered_through, X));
        // A new session of the same change inherits open errors (§6.5): there are none to inherit.
        t.bye(b.session);
        const b2 = t.hello(hello("codex-b", "I-b"));
        return { v, stop: t.gate(b2.session, "stop"), commit: t.gate(b2.session, "commit"), inbox: notices(t.drain(b2.session)) };
      });
      expect(out.v).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error", caused_by_agent: "claude-a" }] });
      expect(out.stop).toMatchObject({ allow: true, open_errors: [] });
      expect(out.commit).toMatchObject({ allow: true, open_errors: [] });
      expect(out.inbox).toEqual([]);
    }
  });

  it("block never refuses a claim: an overlapping claim is accepted with a warning naming the holder", () => {
    const v = both({ repo: "r", enforcement: "block" }, (t) => {
      const a = t.hello(hello("claude-a", "I-a"));
      const b = t.hello(hello("codex-b", "I-b"));
      t.submit(a.session, edit(a.delivered_through, X));
      return t.submit(b.session, claim(b.delivered_through, X, false));
    });
    expect(v).toMatchObject({ verdict: "accept", diagnostics: [{ code: "claim_wait", severity: "warning", message: `${X} is being edited by claude-a (I-a), which has precedence.` }] });
  });

  it("after a claim_wait the requester can still escalate by naming the held key", () => {
    const v = both({ repo: "r" }, (t) => {
      const a = t.hello(hello("claude-a", "I-a"));
      const b = t.hello(hello("codex-b", "I-b"));
      t.submit(a.session, claim(a.delivered_through, X, true));
      const w = t.submit(b.session, edit(b.delivered_through, X));
      expect(w.verdict).toBe("reject");
      return t.submit(b.session, { type: "submit", mode: "commit", event: { kind: "negotiate.escalate", base_seq: w.delivered_through, payload: { with: { agent: "claude-a" }, keys: [X], reason: "need f" } } });
    });
    expect(v).toMatchObject({ verdict: "accept", inbox: [{ kind: "control", record: { payload: { action: "merge" } } }] });
  });
});

describe("conflicts: continue (#16 follow-ups)", () => {
  const init: CoordinatorInit = { repo: "r", conflicts: "continue" };
  /** A changes X's signature; B (old base) edits Y calling X: stale_assumption, owned by A. */
  const setup = (t: Target) => {
    const a = t.hello(hello("claude-a", "I-a"));
    const b = t.hello(hello("codex-b", "I-b"));
    t.submit(a.session, edit(a.delivered_through, X, { kind: "signature" }));
    return { a, b, stale: edit(b.delivered_through, Y, { reads: [X] }) };
  };

  it("the owner is told once per (editor, symbol, cause), even after it acked the notice", () => {
    const out = both(init, (t) => {
      const { a, b, stale } = setup(t);
      expect(t.submit(b.session, stale).verdict).toBe("reject");
      const first = t.drain(a.session);
      t.drain(a.session, first.items.at(-1)!.id); // acked: the inbox is empty again
      for (let n = 0; n < 3; n++) expect(t.submit(b.session, stale).verdict).toBe("reject");
      return { first: notices(first), again: notices(t.drain(a.session)) };
    });
    expect(out.first).toMatchObject([{ diagnostic: { severity: "warning", code: "stale_assumption", caused_by_agent: "codex-b", message: `codex-b's edit to ${X} conflicts with your change #3.` } }]);
    expect(out.again).toEqual([]);
  });

  it("a check-mode submission never tells the owner", () => {
    const out = both(init, (t) => {
      const { a, b } = setup(t);
      const v = t.submit(b.session, edit(b.delivered_through, Y, { reads: [X], mode: "k" }));
      return { v, told: notices(t.drain(a.session)) };
    });
    expect(out.v).toMatchObject({ verdict: "reject", mode: "check" });
    expect(out.told).toEqual([]);
  });

  it("another editor hitting the same cause is a separate notice", () => {
    const out = both(init, (t) => {
      const { a, b, stale } = setup(t);
      const c = t.hello(hello("gemini-c", "I-c"));
      t.submit(b.session, stale);
      t.submit(c.session, edit(1, Y, { reads: [X] }));
      return notices(t.drain(a.session)).map((i) => i.diagnostic?.message);
    });
    expect(out).toEqual([`codex-b's edit to ${X} conflicts with your change #3.`, `gemini-c's edit to ${X} conflicts with your change #3.`]);
  });

  it("an owner with no live session is not marked as told: it hears of the conflict once it is back", () => {
    const out = both(init, (t) => {
      const { a, b, stale } = setup(t);
      t.bye(a.session);
      t.submit(b.session, stale); // nobody to tell
      const a2 = t.hello(hello("claude-a", "I-a"));
      const before = notices(t.drain(a2.session));
      t.submit(b.session, stale);
      return { before, after: notices(t.drain(a2.session)) };
    });
    expect(out.before).toEqual([]);
    expect(out.after).toMatchObject([{ diagnostic: { code: "stale_assumption", caused_by_agent: "codex-b" } }]);
  });

  it("the owner's notice carries owner-directed text, not the editor's suggestion (mirrors ownership.test.ts)", () => {
    const out = both(init, (t) => {
      const { a, b, stale } = setup(t);
      const v = t.submit(b.session, stale);
      return { editor: v.diagnostics.find((d) => d.code === "stale_assumption")!.suggestion, owner: notices(t.drain(a.session))[0]!.diagnostic! };
    });
    expect(out.owner.severity).toBe("warning");
    expect(out.owner.suggestion).not.toBe(out.editor);
    expect(out.owner.suggestion).toContain("does not adopt your change");
  });

  it("the claim_wait suggestion does not tell the requester to wait", () => {
    const v = both(init, (t) => {
      const a = t.hello(hello("claude-a", "I-a"));
      const b = t.hello(hello("codex-b", "I-b"));
      t.submit(a.session, claim(a.delivered_through, X, true));
      return t.submit(b.session, edit(b.delivered_through, X));
    });
    const s = v.diagnostics.find((d) => d.code === "claim_wait")!.suggestion!;
    expect(s).not.toMatch(/\bwait/i);
    expect(s).toContain("keep working on your other tasks");
  });
});

describe("replay reproduces the repo's modes from its stored config (#16 follow-up)", () => {
  it("a journal replayed against the stored config (nothing else passed) keeps conflicts and enforcement", () => {
    const live = sqlTarget({ repo: "r", conflicts: "continue", enforcement: "block" });
    const a = live.hello(hello("claude-a", "I-a"));
    const b = live.hello(hello("codex-b", "I-b"));
    live.submit(a.session, edit(a.delivered_through, X, { kind: "signature" }));
    live.submit(b.session, edit(b.delivered_through, Y, { reads: [X] }));
    live.submit(b.session, edit(b.delivered_through, X));
    live.drain(a.session);
    const stored = live.j.coord.config;
    expect(stored).toMatchObject({ conflicts: "continue", enforcement: "block" });
    const re = replay(nodeSql(), stored, live.j.journal());
    expect(re.coord.conflicts).toBe("continue");
    expect(re.coord.enforcement).toBe("block");
    expect(JSON.stringify(re.coord.dump())).toBe(JSON.stringify(live.j.coord.dump()));
    expect(re.coord.dump().owner_notices).toHaveLength(1);
  });
});
