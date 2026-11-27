// Recorded dependencies (spec §6.7, issues #5–#7): the reliance rule, the schema of the new field,
// that a client cannot forge one, the hold rule's cycle test, and the PR text of `weft deps --pr`.
import { describe, expect, it } from "vitest";
import { dependenciesOf, dependencyText, mergeDependencies, reliesOn } from "./deps";
import { ReferenceCoordinator } from "./reference";
import type { Capabilities, Dependencies, EventRecord, Hello } from "./types";
import { validate } from "./validate";

const caps: Capabilities = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" };
const hello = (agent: string, task: string): Hello => ({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: caps, task: { id: task } });
const NEW = "src/auth/session.ts#createSession";
const SIG = "src/auth/session.ts#refreshToken";
const BODY = "src/auth/session.ts#hashToken";

function coord() {
  let t = Date.parse("2026-11-26T12:00:00.000Z");
  return new ReferenceCoordinator({ repo: "deps", now: () => (t += 1) });
}

describe("reliesOn (spec §6.7)", () => {
  it("a read relies on a symbol the neighbor added or whose signature it changed, not on a body change or a deletion", () => {
    expect(reliesOn("new", true)).toBe(true);
    expect(reliesOn("signature", true)).toBe(true);
    expect(reliesOn("body", true)).toBe(false);
    expect(reliesOn("deleted", true)).toBe(false);
    expect(reliesOn("new", false)).toBe(false);
  });
  it("a write relies only on a declaration that exists solely in the neighbor's change", () => {
    expect(reliesOn("new", false, "body")).toBe(true);
    expect(reliesOn("new", true, "signature")).toBe(true);
    expect(reliesOn("new", false, "new")).toBe(false); // both introduced it: a conflict, not reliance
    expect(reliesOn("signature", true, "body")).toBe(false); // both changed it: claims arbitrate
    expect(reliesOn("body", false, "body")).toBe(false);
  });
});

describe("depends_on on the record (#5)", () => {
  it("an accepted edit that uses a neighbor's unlanded symbols records the change and the keys; nothing else changes", () => {
    const c = coord();
    const a = c.hello(hello("claude-a", "T-1")).session;
    const b = c.hello(hello("codex-b", "T-2")).session;
    c.submit(a, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: NEW, kind: "new" }, { key: BODY, kind: "body" }] } }); // #3
    const v = c.submit(b, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 2, reads: [BODY, NEW], writes: [{ key: "src/routes/signup.ts#signup", kind: "body" }] } });
    // Annotation only: the verdict is the same as without it (a body change is a warning, a new symbol nothing).
    expect(v).toMatchObject({ verdict: "accept", seq: 4 });
    expect(v.diagnostics.map((d) => d.code)).toEqual(["stale_read"]);
    const rec = c.event(4);
    expect(rec.depends_on).toEqual([{ change: "claude-a/T-1", agent: "claude-a", task: "T-1", seq: 3, keys: [NEW] }]);
    expect(validate("EventRecord", rec)).toMatchObject({ ok: true });
    // The events API (list view) carries it too.
    expect(c.events(0, 10).events.find((e) => e.seq === 4)?.depends_on).toEqual(rec.depends_on);
  });

  it("an accepting check appends nothing, so it records nothing", () => {
    const c = coord();
    const a = c.hello(hello("claude-a", "T-1")).session;
    const b = c.hello(hello("codex-b", "T-2")).session;
    c.submit(a, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: NEW, kind: "new" }] } });
    const v = c.submit(b, { type: "submit", mode: "check", event: { kind: "edit", base_seq: 2, reads: [NEW], writes: [{ key: "src/x.ts#x", kind: "body" }] } });
    expect(v).toMatchObject({ verdict: "accept", seq: null });
    expect(c.log.some((r) => r.depends_on)).toBe(false);
  });

  it("a client cannot forge one: a draft's depends_on validates (unknown fields are ignored, §10) and is never copied", () => {
    const forged = {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#x", kind: "body" }], depends_on: [{ change: "victim/T-9", agent: "victim", seq: 1, keys: ["src/x.ts#x"] }] },
    };
    expect(validate("Submit", forged)).toMatchObject({ ok: true });
    const c = coord();
    const a = c.hello(hello("claude-a", "T-1")).session;
    c.submit(a, forged as never);
    expect(c.event(2).depends_on).toBeUndefined();
    expect(c.dependencies("claude-a/T-1").depends_on).toEqual([]);
  });

  it("the schema types the field: change, agent, seq and at least one key", () => {
    const base = c0();
    expect(validate("EventRecord", { ...base, depends_on: [{ change: "a/T-1", agent: "a", task: "T-1", seq: 3, keys: [NEW] }] })).toMatchObject({ ok: true });
    const bad = validate("EventRecord", { ...base, depends_on: [{ change: "a/T-1", agent: "a", seq: 3, keys: ["no-hash"] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path)).toContain("/depends_on/0/keys/0");
    expect(validate("EventRecord", { ...base, depends_on: [{ change: "a/T-1", agent: "a", seq: 3, keys: [] }] }).ok).toBe(false);
    expect(validate("EventRecord", { ...base, depends_on: [{ change: "a/T-1", seq: 3, keys: [NEW] }] }).ok).toBe(false);
  });
});

function c0(): EventRecord {
  return {
    seq: 4,
    repo: "deps",
    status: "accepted",
    kind: "edit",
    ts: "2026-11-26T12:00:00.004Z",
    actor: { type: "agent", id: "b" },
    files: ["src/x.ts"],
    reads: [NEW],
    writes: [{ key: "src/x.ts#x", kind: "body" }],
    summary: "b edited x in src/x.ts",
    diagnostics: [],
  };
}

describe("hold rule (#7)", () => {
  const records = (m: Record<string, string[]>) => (x: string) => (m[x] ?? []).map((d) => ({ depends_on: [{ change: d, agent: d, seq: 1, keys: [`src/${d}.ts#f`] }] }));
  const pendingAll = () => ({ status: "pending" as const });
  it("a pending dependency holds; one that relies back (a cycle, also through a third change) does not", () => {
    const l = (m: Record<string, string[]>, id: string) =>
      dependenciesOf({ repo: "r", change: { id, agent: id, landed: false }, records: records(m), state: pendingAll, sameGroup: (a, b) => a === b });
    expect(l({ b: ["a"] }, "b")).toMatchObject({ held: true, held_by: ["a"] });
    expect(l({ b: ["a"], a: ["b"] }, "b")).toMatchObject({ held: false, held_by: [], depends_on: [{ change: "a", mutual: true, holds: false }] });
    expect(l({ b: ["a"], a: ["c"], c: ["b"] }, "b")).toMatchObject({ held: false, depends_on: [{ change: "a", mutual: true }] });
    // a -> c, c -> a is a cycle that does not include b: b is still held by a.
    expect(l({ b: ["a"], a: ["c"], c: ["a"] }, "b")).toMatchObject({ held: true, held_by: ["a"] });
  });
  it("landed and abandoned dependencies do not hold; a merged one is mutual", () => {
    const d = dependenciesOf({
      repo: "r",
      change: { id: "b", agent: "b", landed: false },
      records: records({ b: ["a", "c", "m"] }),
      state: (x) => (x === "a" ? { status: "landed", status_seq: 9 } : x === "c" ? { status: "abandoned", status_seq: 7 } : { status: "pending" }),
      sameGroup: (x, y) => x === y || (x === "b" && y === "m") || (x === "m" && y === "b"),
    });
    expect(d).toMatchObject({ held: false, held_by: [] });
    expect(d.depends_on.map((x) => [x.change, x.status, x.holds, x.mutual ?? false])).toEqual([
      ["a", "landed", false, false],
      ["c", "abandoned", false, false],
      ["m", "pending", false, true],
    ]);
  });
  it("merges one change's records: one entry per neighbor, keys in first-recorded order, latest seq", () => {
    expect(
      mergeDependencies([
        { depends_on: [{ change: "a", agent: "a", seq: 3, keys: ["s#f", "s#g"] }] },
        {},
        { depends_on: [{ change: "c", agent: "c", seq: 5, keys: ["t#h"] }, { change: "a", agent: "a", seq: 6, keys: ["s#g", "s#k"] }] },
      ]),
    ).toEqual([
      { change: "a", agent: "a", seq: 6, keys: ["s#f", "s#g", "s#k"] },
      { change: "c", agent: "c", seq: 5, keys: ["t#h"] },
    ]);
  });
});

describe("PR text (#6, `weft deps --pr`)", () => {
  const deps: Dependencies = {
    type: "dependencies",
    repo: "deps",
    change: "codex-b/T-2",
    agent: "codex-b",
    task: "T-2",
    landed: false,
    held: true,
    held_by: ["claude-a/T-1"],
    depends_on: [
      { change: "claude-a/T-1", agent: "claude-a", task: "T-1", seq: 4, keys: [NEW, SIG], status: "pending", holds: true },
      { change: "gemini-c/T-3", agent: "gemini-c", task: "T-3", seq: 7, keys: ["src/billing/plan.ts#Plan"], status: "abandoned", status_seq: 9, holds: false },
      { change: "kimi-d/T-4", agent: "kimi-d", seq: 8, keys: ["src/x.ts#x"], status: "landed", status_seq: 11, holds: false },
    ],
  };
  it("names each dependency not in main yet with its symbols; landed ones are left out", () => {
    expect(dependencyText(deps, { pr: true })).toBe(
      [
        "Relies on claude-a/T-1 (claude-a, task T-1), not yet in main: src/auth/session.ts#createSession, src/auth/session.ts#refreshToken",
        "Relied on gemini-c/T-3 (gemini-c, task T-3), which was abandoned and will not land: src/billing/plan.ts#Plan",
      ].join("\n"),
    );
  });
  it("says so when nothing is outstanding", () => {
    expect(dependencyText({ ...deps, held: false, held_by: [], depends_on: [deps.depends_on[2]!] }, { pr: true })).toBe("No recorded dependencies on changes that are not in main yet.");
    expect(dependencyText({ ...deps, held: false, held_by: [], depends_on: [] }, { pr: true })).toBe("No recorded dependencies on changes that are not in main yet.");
  });
  it("the plain listing shows the hold and every dependency's state", () => {
    expect(dependencyText(deps)).toBe(
      [
        "codex-b/T-2 (codex-b, task T-2): landing held until claude-a/T-1 lands",
        "  claude-a/T-1 (claude-a, task T-1) — not landed; holds the landing: src/auth/session.ts#createSession, src/auth/session.ts#refreshToken (recorded at #4)",
        "  gemini-c/T-3 (gemini-c, task T-3) — abandoned (#9): src/billing/plan.ts#Plan (recorded at #7)",
        "  kimi-d/T-4 (kimi-d) — landed (#11): src/x.ts#x (recorded at #8)",
      ].join("\n"),
    );
  });
  it("is produced from the reference coordinator's record end to end", () => {
    const c = coord();
    const a = c.hello(hello("claude-a", "T-1")).session;
    const b = c.hello(hello("codex-b", "T-2")).session;
    c.submit(a, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: NEW, kind: "new" }] } });
    c.submit(b, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 2, reads: [NEW], writes: [{ key: "src/routes/signup.ts#signup", kind: "body" }] } });
    expect(dependencyText(c.dependencies("codex-b/T-2"), { pr: true })).toBe("Relies on claude-a/T-1 (claude-a, task T-1), not yet in main: src/auth/session.ts#createSession");
    expect(validate("Dependencies", c.dependencies("codex-b/T-2"))).toMatchObject({ ok: true });
  });
});
