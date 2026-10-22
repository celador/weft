// The log recorded by the demo's live run (demo/live-run.mjs, see README "Demo"): two Claude Code
// agents with the Weft adapter on a local gateway. claude-b planned cartTotal against
// calcTotal(items); claude-a then changed calcTotal's signature (#4); claude-b's edit was denied
// with stale_assumption (#6) and it adapted (#9). From the demo page a human then sent a Message
// to claude-a (#12) and paused (#13) and resumed (#14) claude-b.

import { renderDiagnostic } from "@weft/protocol";
import { actionsFor, editingNow, epochMs, FeedLog, feedRows, normalize, renderText, squiggles, summaryLine } from "../src";
import { localFixture } from "./helpers";

const fx = localFixture<{ repo: string; events: unknown[] }>("live-run.json");
const events = fx.events.map(normalize);
const repo = fx.repo;
const log = new FeedLog(events);
const at = (seq: number) => log.event(repo, seq)!;
// The moment the conflict landed (claude-b's denied edit), and the end of the run.
const conflictAt = epochMs(at(6).ts);
const end = Math.max(...events.map((e) => epochMs(e.ts)));

it("the feed row for the conflict", () => {
  const row = feedRows(log).find((r) => r.seq === 6)!;
  expect([row.who, row.badge, row.tint, row.taskLabel]).toEqual(["claude-b", "blocked", "red", "Show the cart total"]);
  expect(row.summary).toBe("Blocked: claude-b added cartTotal in src/cart.ts — Show the cart total");
  expect(feedRows(log).map((r) => r.seq)).toEqual([14, 13, 12, 9, 6, 4]);
});

it("Editing now: both tasks, at the moment of the conflict and at the end", () => {
  const live = editingNow(log.combined.filter((e) => e.seq <= 6), conflictAt);
  expect(live.map((e) => [e.agent, e.title, e.count, e.conflicted])).toEqual([
    ["claude-b", "Show the cart total", 1, true],
    ["claude-a", "Prices include tax", 1, false],
  ]);
  expect(editingNow(log, end).map((e) => [e.agent, e.count, e.files])).toEqual([
    ["claude-b", 2, ["src/cart.ts"]],
    ["claude-a", 1, ["src/pricing.ts"]],
  ]);
});

it("the squiggle links to claude-a's signature change, whose diff shows the new parameter", () => {
  const [s, ...more] = squiggles(log);
  expect(more).toEqual([]);
  expect([s!.on, s!.code, s!.symbol, s!.causeText]).toEqual([`${repo}#6`, "stale_assumption", "calcTotal", "caused by claude-a · event #4"]);
  const cause = log.event(s!.cause.repo, s!.cause.seq)!;
  expect(cause.writes).toContainEqual({ key: "src/pricing.ts#calcTotal", kind: "signature" });
  expect(cause.diff).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {");
  expect(renderText(s!)).toBe(renderDiagnostic(s!.diagnostic));
});

it("Message, Pause and Resume from the page are in the log, attributed to the human", () => {
  const [msg, pause, resume] = [at(12), at(13), at(14)];
  expect([msg.kind, msg.actor.type, msg.actor.id, (msg.payload?.to as { agent?: string }).agent]).toEqual(["message", "human", "john", "claude-a"]);
  expect(summaryLine(msg)).toMatch(/^→ claude-a: Heads up from the feed/);
  expect([pause.payload?.action, (pause.payload?.target as { agent?: string }).agent, pause.actor.type]).toEqual(["pause", "claude-b", "human"]);
  expect(resume.payload?.action).toBe("resume");
  // Paused between #13 and #14: the conflict record offered Resume then, Pause again after.
  const upToPause = new FeedLog(events.filter((e) => e.seq <= 13));
  expect(actionsFor(upToPause.event(repo, 6)!, upToPause).map((a) => a.kind)).toEqual(["message", "resume", "approve"]);
  expect(actionsFor(at(6), log).map((a) => a.kind)).toEqual(["message", "pause", "approve"]);
});
