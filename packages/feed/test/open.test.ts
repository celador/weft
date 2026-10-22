// openSquiggles (WCP §6.5 clearing rules replayed over the log) and diffSides (before/after
// text for side-by-side diff editors), on the demo's live-run log and small hand-made logs.

import { diffSides, epochMs, FeedLog, normalize, openSquiggles } from "../src";
import { localFixture } from "./helpers";

const fx = localFixture<{ repo: string; events: unknown[] }>("live-run.json");
const events = fx.events.map(normalize);
const upTo = (seq: number) => events.filter((e) => e.seq <= seq);

it("live run: the stale_assumption squiggle is open from the denial until claude-b redoes the edit", () => {
  const open = openSquiggles(new FeedLog(upTo(8)));
  expect(open.map((q) => [q.seq, q.code, q.file, q.symbol, q.causeText])).toEqual([[6, "stale_assumption", "src/pricing.ts", "calcTotal", "caused by claude-a · event #4"]]);
  // #9 is claude-b's accepted edit that reads src/pricing.ts#calcTotal again: rule 1 clears it.
  expect(openSquiggles(new FeedLog(upTo(9)))).toEqual([]);
  expect(openSquiggles(new FeedLog(events))).toEqual([]);
});

it("repo filter and age limit", () => {
  const log = new FeedLog(upTo(8));
  expect(openSquiggles(log, { repos: ["other"] })).toEqual([]);
  const t6 = epochMs(log.event(fx.repo, 6)!.ts);
  expect(openSquiggles(log, { maxAgeMs: 1000, now: t6 + 500 })).toHaveLength(1);
  expect(openSquiggles(log, { maxAgeMs: 1000, now: t6 + 5000 })).toHaveLength(0);
});

const rec = (seq: number, o: Record<string, unknown>) =>
  normalize({ repo: "r", seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), actor: { type: "agent", id: "b" }, agent: "b", change: "Cb", ...o });
const diag = (o: Record<string, unknown> = {}) => ({ severity: "error", code: "stale_overwrite", file: "src/a.ts", symbol: "src/a.ts#f", message: "m", caused_by_seq: 1, caused_by_agent: "a", ...o });

it("a land clears everything; a release clears check-origin errors but never commit-origin ones", () => {
  const commitDenied = rec(2, { kind: "edit", status: "rejected", mode: "commit", diagnostics: [diag()] });
  const checkDenied = rec(3, { kind: "edit", status: "rejected", mode: "check", diagnostics: [diag({ symbol: "src/a.ts#g" })] });
  const release = rec(4, { kind: "release", status: "accepted", payload: {} });
  expect(openSquiggles([commitDenied, checkDenied, release]).map((q) => q.seq)).toEqual([2]);
  expect(openSquiggles([commitDenied, checkDenied, release, rec(5, { kind: "land", status: "accepted" })])).toEqual([]);
  // A release of other keys leaves g open.
  expect(openSquiggles([checkDenied, rec(4, { kind: "release", status: "accepted", payload: { keys: ["src/a.ts#h"] } })]).map((q) => q.seq)).toEqual([3]);
});

it("an edit by a different change does not clear; agent_paused is never a squiggle", () => {
  const denied = rec(2, { kind: "edit", status: "rejected", mode: "check", diagnostics: [diag()] });
  const other = rec(3, { kind: "edit", status: "accepted", change: "Ca", agent: "a", reads: ["src/a.ts#f"] });
  expect(openSquiggles([denied, other])).toHaveLength(1);
  const paused = rec(4, { kind: "edit", status: "rejected", mode: "check", diagnostics: [diag({ code: "agent_paused" })] });
  expect(openSquiggles([paused])).toEqual([]);
});

it("an accepted record's warning stays until the change touches the key again", () => {
  const warned = rec(2, { kind: "edit", status: "accepted", writes: [{ key: "src/a.ts#x", kind: "body" }], diagnostics: [diag({ severity: "warning" })] });
  expect(openSquiggles([warned])).toHaveLength(1);
  expect(openSquiggles([warned, rec(3, { kind: "edit", status: "accepted", writes: [{ key: "src/a.ts#f", kind: "body" }] })])).toEqual([]);
});

it("diffSides keeps real line numbers on both sides", () => {
  const diff = ["--- a/src/p.ts", "+++ b/src/p.ts", "@@ -3,3 +3,4 @@", " a", "-b", "+B", "+B2", " c", ""].join("\n");
  const [s, ...more] = diffSides(diff);
  expect(more).toEqual([]);
  expect(s!.file).toBe("src/p.ts");
  expect(s!.before.split("\n")).toEqual(["", "", "a", "b", "c", ""]);
  expect(s!.after.split("\n")).toEqual(["", "", "a", "B", "B2", "c", ""]);
  expect([s!.added, s!.deleted]).toEqual([false, false]);
});

it("diffSides splits multi-file git diffs and flags new files", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/x.ts",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/y.ts b/y.ts",
    "--- a/y.ts",
    "+++ b/y.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const sides = diffSides(diff);
  expect(sides.map((s) => [s.file, s.added, s.before, s.after])).toEqual([
    ["x.ts", true, "", "one\ntwo\n"],
    ["y.ts", false, "old\n", "new\n"],
  ]);
});

it("diffSides on the live run's calcTotal change", () => {
  const e = events.find((x) => x.seq === 4)!;
  const [s] = diffSides(e.diff!);
  expect(s!.file).toBe("src/pricing.ts");
  expect(s!.after).toContain("opts: PriceOptions");
  expect(s!.before).not.toContain("opts: PriceOptions");
});
