// The reducers on REAL recorded coordinator logs from demo/evidence:
//  - claude-collision: two Claude Code sessions (claude-a, claude-b) on one repo; claude-b's
//    edit of Cart is denied with stale_assumption caused by claude-a's calcTotal change.
//  - m2/run-5: the M2 scenario (claude, codex, opencode on six tasks): squiggles, negotiation,
//    merge, approvals, lands, auto-reverts and the revert messages.

import { renderContext, renderDiagnostic } from "@weft/protocol";
import {
  actionsFor,
  editingNow,
  epochMs,
  FeedLog,
  feedRows,
  renderText,
  squiggles,
  stripModel,
  summaryLine,
} from "../src";
import { evidenceLog } from "./helpers";

describe("claude-collision (two Claude Code agents, one conflict)", () => {
  const { repo, events } = evidenceLog("claude-collision/coordinator-log.json");
  const log = new FeedLog(events);
  const end = Math.max(...events.map((e) => epochMs(e.ts)));

  it("the Changes feed shows the work and hides join/leave by default", () => {
    const rows = feedRows(log);
    expect(rows.map((r) => r.seq)).toEqual([11, 10, 9, 6, 5, 4]);
    const blocked = rows.find((r) => r.seq === 9)!;
    expect([blocked.who, blocked.badge, blocked.tint, blocked.rejected]).toEqual(["claude-b", "blocked", "red", true]);
    expect(blocked.summary.startsWith("Blocked: claude-b edited Cart")).toBe(true);
    expect(blocked.symbols.map((s) => s.name)).toEqual(["Cart", "Cart.total"]);
    expect(feedRows(log, { showSessionEvents: true })).toHaveLength(12);
  });

  it("Editing now has a row for each running task", () => {
    const editing = editingNow(log, end + 60_000);
    expect(editing.map((e) => [e.agent, e.task, e.count, e.conflicted])).toEqual([
      ["claude-b", "T-2", 3, true],
      ["claude-a", "T-1", 3, false],
    ]);
    expect(editing[0]!.title).toBe("Show the cart total");
    expect(editing[0]!.files).toEqual(["src/cart.ts"]); // the blocked edit never reached a file twice
    expect(editing[1]!.files).toEqual(["src/orders.ts", "src/pricing.ts"]);
    // Three hours later nothing is "now".
    expect(editingNow(log, end + 3 * 3600_000 + 1)).toEqual([]);
  });

  it("the squiggle links to the edit that caused it", () => {
    const [s, ...rest] = squiggles(log);
    expect(rest).toEqual([]);
    expect([s!.on, s!.code, s!.severity, s!.symbol, s!.causeText]).toEqual([`${repo}#9`, "stale_assumption", "error", "calcTotal", "caused by claude-a · event #4"]);
    const cause = log.event(s!.cause.repo, s!.cause.seq)!;
    expect(cause.agent).toBe("claude-a");
    expect(cause.writes.some((w) => w.key === s!.symbolKey && w.kind === "signature")).toBe(true);
    expect(cause.diff).toContain("calcTotal");
  });

  it("text form of the squiggle is the line the adapter put in claude-b's context", () => {
    const [s] = squiggles(log);
    expect(renderText(s!)).toBe(renderDiagnostic(s!.diagnostic));
    expect(renderText(s!)).toBe(renderContext([s!.diagnostic]));
    expect(renderText(s!)).toMatch(/^\[weft error\] stale_assumption .* \(caused by claude-a · task T-1 · event #4\)\./);
    const multi = renderText(s!, { multiline: true }).split("\n");
    expect(multi[0]).toBe("error contract changed under you · calcTotal  src/pricing.ts");
    expect(multi.at(-1)).toBe(`  caused by claude-a · event #4  (on ${repo}#9, blocked)`);
  });

  it("one-line text of a row and an Editing now row", () => {
    const row = feedRows(log).find((r) => r.seq === 9)!;
    expect(renderText(row)).toBe(`${repo}#9 claude-b · Show the cart total [blocked] ${row.summary} (1 squiggle)`);
    expect(renderText(editingNow(log, end)[0]!)).toBe("⚠ Show the cart total — claude-b · 3 edits · cart.ts");
  });

  it("agent records offer Message and Pause; nothing landed, so no Undo", () => {
    expect(actionsFor(log.event(repo, 9)!, log).map((a) => a.kind)).toEqual(["message", "pause", "approve"]);
    for (const e of events) expect(actionsFor(e, log).some((a) => a.kind === "undo")).toBe(false);
  });
});

describe("m2/run-5 (claude, codex, opencode: negotiation, lands, auto-reverts)", () => {
  const { repo, events } = evidenceLog("m2/run-5/coordinator-log.json");
  const log = new FeedLog(events);
  const kinds = (seq: number) => actionsFor(log.event(repo, seq)!, log).map((a) => a.kind);

  it("Undo is offered only on lands no revert has undone", () => {
    const lands = events.filter((e) => e.kind === "land").map((e) => e.seq);
    expect(lands).toEqual([866, 871, 872, 873, 874, 875, 881]);
    const undoable = lands.filter((s) => kinds(s).includes("undo"));
    expect(undoable).toEqual([866, 871, 872, 873]);
    expect(log.revertOf(log.event(repo, 881)!)?.seq).toBe(882);
    expect(log.revertOf(log.event(repo, 875)!)?.seq).toBe(884);
    expect(log.revertOf(log.event(repo, 874)!)?.seq).toBe(886);
  });

  it("Approve disappears once a human approved the candidate", () => {
    // 867 approved Ifb0d19f8… (claude-t3-r5); 780 is that candidate's blocked edit.
    expect(log.event(repo, 780)!.change!.startsWith("Ifb0d19f88d1")).toBe(true);
    expect(kinds(780)).toEqual(["message", "pause"]);
    // opencode-t3-r5's competing candidate for the same task is not approved.
    expect(kinds(786)).toEqual(["message", "pause", "approve"]);
    const cands = log.candidates("m2-mutwfm7d-t3", repo);
    expect(cands.filter((c) => c.approved).map((c) => c.agent)).toEqual(["claude-t3-r5"]);
    expect(cands.find((c) => c.agent === "claude-t3-r5")!.landedSeq).toBe(873);
  });

  it("every squiggle's cause is a record by the agent it names (or older than the window held)", () => {
    const all = squiggles(log);
    const first = Math.min(...events.map((e) => e.seq));
    expect(all.length).toBeGreaterThan(20);
    let held = 0;
    for (const s of all) {
      expect(s.cause.seq).toBeLessThan(s.seq);
      expect(renderText(s)).toBe(renderDiagnostic(s.diagnostic));
      const cause = log.event(s.cause.repo, s.cause.seq);
      // Claims left by run 4 cause run 5's claim_wait squiggles: the UI fetches those by seq.
      if (!cause) {
        expect(s.cause.seq, s.id).toBeLessThan(first);
        continue;
      }
      held++;
      expect(cause.agent ?? cause.actor.id).toBe(s.cause.agent);
    }
    expect(held).toBeGreaterThan(0);
  });

  it("negotiation threads resolve through reply_to", () => {
    const accepts = events.filter((e) => e.kind === "negotiate.accept");
    expect(accepts.length).toBe(6);
    for (const a of accepts) {
      const t = log.thread(a);
      expect(t[0]!.kind).toBe("negotiate.propose");
      expect(t.at(-1)!.seq).toBe(a.seq);
    }
  });

  it("the strip: landed changes leave Editing now; lands and reverts are rows", () => {
    const end = Math.max(...events.map((e) => epochMs(e.ts)));
    const m = stripModel(log.combined, end);
    const landedChanges = new Set(events.filter((e) => e.kind === "land" && e.change).map((e) => e.change));
    for (const card of m.editing) {
      const lastLand = Math.max(0, ...events.filter((e) => e.kind === "land" && e.change === card.change).map((e) => e.seq));
      if (landedChanges.has(card.change)) expect(Number(card.latest.split("#")[1])).toBeGreaterThan(lastLand);
    }
    expect(m.feed.filter((i) => i.tone === "landed").map((i) => i.seq)).toEqual([881, 875, 874, 873, 872, 871, 866]);
    expect(m.feed.find((i) => i.seq === 866)!.title).toBe("Landed Signup endpoint");
  });

  it("control and revert rows read like Otto's", () => {
    const rows = feedRows(log, { showSessionEvents: true });
    const merge = rows.find((r) => r.seq === 857)!;
    expect([merge.badge, merge.actorType]).toEqual(["merge", "system"]);
    const approve = rows.find((r) => r.seq === 867)!;
    expect([approve.badge, approve.who, approve.summary]).toEqual(["approve", "john", "Approved Ifb0d19f88d124b2fd38ee5b733077a5a14cf59cb"]);
    const revert = rows.find((r) => r.seq === 882)!;
    expect([revert.badge, revert.tint]).toEqual(["revert", "red"]);
    expect(summaryLine(log.event(repo, 882)!)).toMatch(/^Reverted #881: production error spike/);
  });
});
