// Parity with Otto: these are Otto's own test cases (HermesTests/WeftStripTests.swift,
// WeftTests.swift, WeftFeedTests.swift) run against the TypeScript port, with the same inputs
// and the same expected outputs. A failure here means a Weft UI would disagree with Otto.

import {
  actionBody,
  actionsFor,
  catchUpPlan,
  codeLabel,
  displayKey,
  editingNow,
  FeedLog,
  feedRows,
  fileNames,
  filterIsEmpty,
  headerStatus,
  isSessionBookkeeping,
  isWholeFile,
  lineStats,
  lineStatsFromPayload,
  names,
  nextPage,
  normalize,
  parseDiff,
  PER_REPO_LIMIT,
  rebuildSummary,
  relTime,
  repoForFolder,
  shortAgent,
  stripModel,
  summaryLine,
  summaryWithActor,
  symbolFile,
  symbolName,
  tickMs,
  trailOf,
  FEED_LIMIT,
  type ActionOption,
  type FeedEvent,
} from "../src";
import { ev, localFixture, protocolFixture, record, STRIP_NOW as now } from "./helpers";

const ids = (xs: { seq: number }[]) => xs.map((x) => x.seq);

describe("WeftStripTests → stripModel / editingNow", () => {
  it("repo name follows the adapter", () => {
    expect(repoForFolder("/Users/sam/code/hermes-ios")).toBe("hermes-ios");
    expect(repoForFolder("~/github/gascity.nvim/")).toBe("gascity.nvim");
    expect(repoForFolder("/x/My Project!")).toBe("My-Project");
    expect(repoForFolder(undefined)).toBeUndefined();
    expect(shortAgent("hermes-default")).toBe("default");
    expect(shortAgent("claude-a")).toBe("claude-a");
  });

  it("Editing now lists unlanded changes with their files and counts", () => {
    const m = stripModel(
      [
        ev(1, "edit", 20, { files: ["ios/Hermes/Views/WorkspaceDashboard.swift"], intent: "t_aaaaaaaa: Weft strip in the dashboard" }),
        ev(2, "edit", 5, { files: ["ios/Hermes/Weft/WeftStrip.swift", "ios/Hermes/Views/WorkspaceDashboard.swift"], intent: "t_aaaaaaaa: Weft strip in the dashboard" }),
        ev(3, "edit", 2, { change: "hermes-backend/t_bbbbbbbb", task: "t_bbbbbbbb", files: ["relay/x.py"], agent: "hermes-backend" }),
      ],
      now,
    );
    expect(m.editing.map((e) => e.change)).toEqual(["hermes-backend/t_bbbbbbbb", "hermes-default/t_aaaaaaaa"]);
    const a = m.editing[1]!;
    expect(a.who).toBe("default");
    expect(a.title).toBe("Weft strip in the dashboard");
    expect(a.files).toEqual(["ios/Hermes/Weft/WeftStrip.swift", "ios/Hermes/Views/WorkspaceDashboard.swift"]);
    expect(a.latest).toBe("hermes-ios#2");
    expect(a.count).toBe(2);
    expect(a.lastEdit).toBe(now - 5 * 60_000);
    expect(a.conflicted).toBe(false);
  });

  it("every edit is its own row, newest first", () => {
    const m = stripModel(
      [
        ev(10, "edit", 3, { files: ["scratch.txt"], intent: "t_aaaaaaaa: Every edit visible" }),
        ev(12, "edit", 1, { files: ["scratch.txt"] }),
        ev(11, "edit", 2, { files: ["scratch.txt"] }),
        ev(13, "join", 1),
        ev(14, "checkpoint", 0.5, { payload: { sha: "abc1234" } }),
      ],
      now,
    );
    expect(m.feed.map((i) => i.seq)).toEqual([12, 11, 10]);
    expect(m.feed.every((i) => i.tone === "edit" && i.title === "scratch.txt")).toBe(true);
    expect(m.feed.every((i) => i.cardTitle === "Every edit visible" && i.task === "t_aaaaaaaa" && i.who === "default")).toBe(true);
    expect(m.editing).toHaveLength(1);
    expect(m.editing[0]!.count).toBe(3);
  });

  it("feed interleaves lands, installs and edits by time", () => {
    const m = stripModel(
      [
        ev(1, "edit", 30, { files: ["a.swift"] }),
        ev(2, "land", 20, { payload: { sha: "25f7af6abcdef", op_id: "x" }, actor: "system" }),
        ev(3, "checkpoint", 10, { change: null, task: null, payload: { sha: "abc1234", x_install: { build: "90", target: "mac", devices: ["Nano"] } }, actor: "system" }),
        ev(4, "edit", 1, { change: "hermes-default/t_cccccccc", task: "t_cccccccc", files: ["b.swift", "c.md"] }),
      ],
      now,
    );
    expect(m.feed.map((i) => i.tone)).toEqual(["edit", "install", "landed", "edit"]);
    expect(m.feed[0]!.title).toBe("b.swift · c.md");
    expect(m.feed[1]!.title).toBe("Build 90 → Mac");
  });

  it("expanding a card shows its full trail", () => {
    const m = stripModel(
      [
        ev(1, "edit", 9, { files: ["a.swift"] }),
        ev(2, "edit", 8, { change: "hermes-backend/t_bbbbbbbb", task: "t_bbbbbbbb", files: ["x.py"], agent: "hermes-backend" }),
        ev(3, "edit", 7, { files: ["b.swift"] }),
        ev(4, "edit", 6, { files: ["a.swift"] }),
      ],
      now,
    );
    const a = m.editing.find((e) => e.change === "hermes-default/t_aaaaaaaa")!;
    expect(a.trail).toEqual(["hermes-ios#4", "hermes-ios#3", "hermes-ios#1"]);
    expect(trailOf(m, a).map((i) => i.seq)).toEqual([4, 3, 1]);
    expect(trailOf(m, a).every((i) => i.task === "t_aaaaaaaa")).toBe(true);
  });

  it("landed or stale changes are not Editing now but stay in the feed", () => {
    const m = stripModel(
      [
        ev(1, "edit", 30, { files: ["a.swift"] }),
        ev(2, "land", 10, { payload: { sha: "25f7af6abcdef", op_id: "x", trunk_ref: "refs/heads/rebrand/otto" }, actor: "system" }),
        ev(3, "edit", 600, { change: "hermes-default/t_cccccccc", task: "t_cccccccc", files: ["old.swift"] }),
      ],
      now,
    );
    expect(m.editing).toEqual([]);
    expect(m.feed.map((i) => i.seq)).toEqual([2, 1, 3]);
    expect(m.feed[0]!.tone).toBe("landed");
    expect(m.feed[0]!.detail).toBe("default · 25f7af6");
  });

  it("only task intents name the card", () => {
    const m = stripModel(
      [
        ev(1, "edit", 9, { files: ["a.swift"], intent: "t_aaaaaaaa: Real title" }),
        ev(2, "leave", 8, { intent: "hermes process exit" }),
        ev(3, "land", 7, { payload: { sha: "95eafa8aaaa" }, actor: "system" }),
      ],
      now,
    );
    expect(m.feed[0]!.title).toBe("Landed Real title");
    expect(m.feed.at(-1)!.cardTitle).toBe("Real title");
  });

  it("blocked and warned edits carry an inline badge", () => {
    const stale = [{ severity: "error", code: "stale_overwrite", file: "ios/A.swift", symbol: "ios/A.swift#*", message: "m", caused_by_seq: 4, caused_by_agent: "hermes-default" }];
    const wait = [{ severity: "warning", code: "claim_wait", file: "ios/B.swift", symbol: "ios/B.swift#*", message: "m", caused_by_seq: 4, caused_by_agent: "hermes-default" }];
    const m = stripModel(
      [
        ev(5, "edit", 2, { status: "rejected", change: "hermes-backend/t_bbbbbbbb", task: "t_bbbbbbbb", files: ["ios/A.swift"], diagnostics: stale, agent: "hermes-backend" }),
        ev(6, "edit", 1, { files: ["ios/B.swift"], diagnostics: wait }),
      ],
      now,
    );
    expect(m.feed).toHaveLength(2);
    expect(m.feed[1]!.tone).toBe("edit");
    expect(m.feed[1]!.badge).toEqual({ type: "blocked", label: "stale overwrite" });
    expect(m.feed[0]!.badge).toEqual({ type: "warned", label: "claim wait" });
    const backend = m.editing.find((e) => e.change === "hermes-backend/t_bbbbbbbb")!;
    expect(backend.conflicted).toBe(true);
    expect(backend.files).toEqual([]); // a rejected edit never reached the file
  });

  it("non-edit conflicts are amber rows", () => {
    const diag = [{ severity: "error", code: "land_conflict", file: "ios/A.swift", symbol: "ios/A.swift#*", message: "m", caused_by_seq: 4, caused_by_agent: "hermes-default" }];
    const m = stripModel([ev(5, "land", 1, { status: "rejected", files: ["ios/A.swift"], diagnostics: diag })], now);
    expect(m.feed[0]!.tone).toBe("conflict");
    expect(m.feed[0]!.title).toBe("land conflict · A.swift");
    expect(m.feed[0]!.detail).toBe("default blocked");
  });

  it("installs are blue with build and device", () => {
    const m = stripModel(
      [
        ev(7, "checkpoint", 1, { change: null, task: null, payload: { sha: "abc1234", ref: "refs/heads/rebrand/otto", x_install: { build: "87", target: "mac", devices: ["Nano"] } }, actor: "system" }),
        ev(6, "checkpoint", 2, { payload: { sha: "abc1234" } }),
      ],
      now,
    );
    expect(m.feed).toHaveLength(1);
    expect(m.feed[0]).toMatchObject({ tone: "install", title: "Build 87 → Mac", detail: "Nano" });
  });

  it("probe runs are hidden and the feed is capped", () => {
    const events = [ev(1, "edit", 1, { change: "hermes-default/weft-probe-a-1", task: "weft-probe-a-1", files: ["p.swift"] })];
    for (let i = 0; i < FEED_LIMIT + 40; i++) events.push(ev(10 + i, "edit", 10 - i / 100, { files: [`f${i}.swift`] }));
    const m = stripModel(events, now);
    expect(m.feed).toHaveLength(FEED_LIMIT);
    expect(m.feed[0]!.seq).toBe(10 + FEED_LIMIT + 39);
    expect(m.feed.at(-1)!.seq).toBe(50);
    expect(m.feed.some((i) => i.seq === 1)).toBe(false);
  });

  it("paging reveals held rows, then fetches older until the cap", () => {
    expect(nextPage(60, 200, 210, false)).toEqual({ type: "reveal", shown: 120 });
    expect(nextPage(180, 200, 210, false)).toEqual({ type: "reveal", shown: 200 });
    expect(nextPage(200, 200, 210, false)).toEqual({ type: "fetchOlder" });
    expect(nextPage(200, 200, 210, true)).toEqual({ type: "end" });
    expect(nextPage(500, 500, PER_REPO_LIMIT, false)).toEqual({ type: "end" });
  });

  it("relative times tick live", () => {
    const t = now;
    expect(relTime(t, t)).toBe("now");
    expect(relTime(t, t + 12_000)).toBe("12s");
    expect(relTime(t, t + 13_000)).toBe("13s");
    expect(relTime(t, t + 4 * 60_000 + 5000)).toBe("4m");
    expect(relTime(t, t + 2 * 3_600_000)).toBe("2h");
    expect(relTime(t, t + 3 * 86_400_000)).toBe("3d");
    expect(tickMs(t, t + 10_000)).toBe(1000);
    expect(tickMs(t, t + 120_000)).toBe(15_000);
  });

  it("line stats count the diff", () => {
    const diff = "--- a/ios/A.swift\n+++ b/ios/A.swift\n@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+more";
    expect(lineStats(diff)).toEqual({ added: 2, removed: 1 });
    expect(lineStatsFromPayload({ x_lines: { added: 5, removed: 0 } })).toEqual({ added: 5, removed: 0 });
    expect(lineStatsFromPayload(undefined)).toBeUndefined();
  });

  it("file names", () => {
    expect(fileNames(["src/a/B.swift", "c.md"])).toBe("B.swift · c.md");
    expect(fileNames(["a", "b", "c", "d", "e"])).toBe("a · b · c · +2");
  });

  it("editingNow accepts a FeedLog", () => {
    const log = new FeedLog([ev(1, "edit", 1, { files: ["a.ts"] })]);
    expect(editingNow(log, now).map((e) => e.count)).toEqual([1]);
  });
});

describe("WeftTests → decoding, actions, resume, derived views", () => {
  it("decodes the events page", () => {
    const page = protocolFixture<{ repo: string; head_seq: number; next_after: number; has_more: boolean; events: unknown[] }>("events-page");
    expect([page.repo, page.head_seq, page.next_after, page.has_more]).toEqual(["weft-demo", 20, 13, true]);
    const [edit, blocked] = page.events.map(normalize) as [FeedEvent, FeedEvent];
    expect(edit.actor.harness).toBe("claude-code");
    expect(edit.writes).toEqual([{ key: "src/auth/session.ts#refreshToken", kind: "signature" }]);
    expect(edit.has_diff).toBe(true);
    expect(edit.diff).toBeUndefined();
    const d = blocked.diagnostics[0]!;
    expect([d.severity, d.code, d.caused_by_seq, d.caused_by_agent, d.caused_by_task]).toEqual(["error", "stale_assumption", 12, "claude-a", "T-1"]);
    expect([symbolName(d.symbol), symbolFile(d.symbol)]).toEqual(["refreshToken", "src/auth/session.ts"]);
  });

  it("tolerates unknown kinds and fields", () => {
    const e = normalize({ seq: 5, repo: "r", status: "accepted", kind: "x_teleport", ts: "2026-10-05T14:00:00Z", actor: { type: "agent", id: "z", x_new: 1 }, summary: "z teleported", x_whatever: { a: [1, null] } });
    expect(feedRows([e], { showSessionEvents: true })[0]!.group).toBe("other");
    expect([e.files, e.writes, e.diagnostics]).toEqual([[], [], []]);
  });

  it("encodes human actions exactly like the spec's pinned fixtures", () => {
    const opt = (o: Partial<ActionOption> & Pick<ActionOption, "kind">): ActionOption => ({ title: "", label: "", repo: "r", destructive: false, ...o });
    expect(actionBody(opt({ kind: "approve", change: "I4f2a" }), { note: "screenshots look right" })).toEqual(protocolFixture("action-approve"));
    expect(actionBody(opt({ kind: "message", agent: "codex-b" }), { text: "Use the overload, don't touch session.ts", intent: "steer" })).toEqual(protocolFixture("action-message"));
    expect(actionBody(opt({ kind: "pause", agent: "codex-b" }), { reason: "wrong approach" })).toEqual(protocolFixture("action-pause"));
    expect(actionBody(opt({ kind: "undo", seq: 31 }), { reason: "error spike after landing" })).toEqual(protocolFixture("action-undo"));
  });

  it("ingest de-duplicates by seq and tracks the high-water mark", () => {
    const log = new FeedLog();
    expect(log.ingest([1, 2, 3, 4, 5].map((seq) => record({ seq })))).toHaveLength(5);
    expect(log.resumePoint("r")).toBe(5);
    expect(ids(log.ingest([4, 5, 6, 7].map((seq) => record({ seq }))))).toEqual([6, 7]);
    expect(log.combined).toHaveLength(7);
    expect(log.resumePoint("r")).toBe(7);
    expect(log.ingest([record({ seq: 7 })])).toEqual([]);
  });

  it("a detail copy replaces the list copy without counting as new", () => {
    const log = new FeedLog([record({ seq: 3 })]);
    expect(log.ingest([record({ seq: 3, diff: "+x" })])).toEqual([]);
    expect(log.event("r", 3)?.diff).toBe("+x");
  });

  it("high-water is per repo", () => {
    const log = new FeedLog([record({ seq: 9, repo: "a" }), record({ seq: 2, repo: "b" })]);
    expect([log.resumePoint("a"), log.resumePoint("b"), log.resumePoint("c")]).toEqual([9, 2, 0]);
  });

  it("trims to the cache size but keeps the high-water mark", () => {
    const log = new FeedLog(Array.from({ length: PER_REPO_LIMIT + 40 }, (_, i) => record({ seq: i + 1 })));
    expect(log.events("r")).toHaveLength(PER_REPO_LIMIT);
    expect(log.oldestSeq("r")).toBe(41);
    expect(log.resumePoint("r")).toBe(PER_REPO_LIMIT + 40);
  });

  it("catch-up plan", () => {
    expect(catchUpPlan(0, 20)).toEqual({ mode: "tail" });
    expect(catchUpPlan(18, 20)).toEqual({ mode: "after", after: 18 });
    expect(catchUpPlan(20, 20)).toEqual({ mode: "after", after: 20 });
    expect(catchUpPlan(10, 10 + PER_REPO_LIMIT + 1)).toEqual({ mode: "tail" });
  });

  it("reset drops a repo for a contiguous window", () => {
    const log = new FeedLog([record({ seq: 4, repo: "a" }), record({ seq: 4, repo: "b" })]);
    log.reset("a");
    expect([log.resumePoint("a"), log.repos, log.combined.length]).toEqual([0, ["b"], 1]);
  });

  it("combined order is newest first across repos", () => {
    const log = new FeedLog([
      record({ seq: 1, repo: "a", ts: "2026-10-05T14:00:01.000Z" }),
      record({ seq: 7, repo: "b", ts: "2026-10-05T14:00:02.000Z" }),
      record({ seq: 2, repo: "a", ts: "2026-10-05T14:00:03.500Z" }),
    ]);
    expect(log.combined.map((e) => `${e.repo}#${e.seq}`)).toEqual(["a#2", "b#7", "a#1"]);
  });

  it("filters", () => {
    const diag = [{ severity: "warning", code: "stale_read", file: "f.ts", symbol: "f.ts#g", message: "m", caused_by_seq: 1, caused_by_agent: "x" }];
    const log = new FeedLog([
      record({ seq: 1, kind: "intent", agent: "a", task: "T-1" }),
      record({ seq: 2, kind: "edit", agent: "b", task: "T-2", diagnostics: diag }),
      record({ seq: 3, kind: "edit", agent: "b", status: "rejected", task: "T-2" }),
      record({ seq: 4, kind: "negotiate.propose", agent: "a", task: "T-1" }),
      record({ seq: 5, repo: "other", kind: "land", agent: "a" }),
    ]);
    expect(ids(log.filtered({ onlyConflicts: true }))).toEqual([3, 2]);
    expect(ids(log.filtered({ kinds: ["negotiate"] }))).toEqual([4]);
    expect(ids(log.filtered({ agents: ["a"], kinds: ["intent", "land"] }))).toEqual([5, 1]);
    expect(ids(log.filtered({ repos: ["other"] }))).toEqual([5]);
    expect(log.filtered({ tasks: ["T-2"], onlyConflicts: true })).toHaveLength(2);
    expect([log.agents, log.tasks]).toEqual([
      ["a", "b"],
      ["T-1", "T-2"],
    ]);
  });

  it("a negotiation thread follows reply_to", () => {
    const log = new FeedLog([
      record({ seq: 10, kind: "negotiate.propose", agent: "b", payload: { to: { agent: "a" }, keys: ["f#g"], terms: { kind: "overload", text: "x" } } }),
      record({ seq: 11, kind: "edit" }),
      record({ seq: 12, kind: "negotiate.counter", agent: "a", payload: { reply_to: 10, terms: { kind: "sequence", text: "y" } } }),
      record({ seq: 13, kind: "negotiate.accept", agent: "b", payload: { reply_to: 12 } }),
      record({ seq: 14, kind: "negotiate.reject", agent: "c", payload: { reply_to: 99 } }),
    ]);
    expect(ids(log.thread(log.event("r", 13)!))).toEqual([10, 12, 13]);
    expect(ids(log.thread(log.event("r", 10)!))).toEqual([10, 12, 13]);
    expect(log.thread(log.event("r", 11)!)).toEqual([]);
  });

  it("candidates: approval, land, revert, pause", () => {
    const base = [
      record({ seq: 1, agent: "a", task: "T-1", change: "Ia" }),
      record({ seq: 2, agent: "c", task: "T-1", change: "Ic" }),
      record({ seq: 3, kind: "control", agent: "john", payload: { action: "approve", target: { change: "Ia" } } }),
      record({ seq: 4, kind: "land", agent: "a", task: "T-1", change: "Ia", payload: { sha: "s", op_id: "o" } }),
      record({ seq: 5, kind: "revert", agent: "a", payload: { op_id: "o2", reverts_seq: 4, reason: "boom" } }),
      record({ seq: 6, kind: "control", agent: "john", payload: { action: "pause", target: { agent: "c" } } }),
    ];
    const log = new FeedLog(base);
    const c = log.candidates("T-1", "r");
    expect(c.map((x) => x.change)).toEqual(["Ia", "Ic"]);
    expect([c[0]!.approved, c[0]!.landedSeq, c[0]!.reverted]).toEqual([true, 4, true]);
    expect([c[1]!.approved, c[1]!.landedSeq]).toEqual([false, undefined]);
    expect(log.revertOf(log.event("r", 4)!)?.seq).toBe(5);
    expect([log.isPaused("c", "r"), log.isPaused("a", "r")]).toEqual([true, false]);
    const resumed = new FeedLog([...base, record({ seq: 7, kind: "control", agent: "john", payload: { action: "resume", target: { agent: "c" } } })]);
    expect(resumed.isPaused("c", "r")).toBe(false);
  });

  it("the diff parser numbers lines", () => {
    const lines = parseDiff("diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+more\n");
    expect(lines.map((l) => l.kind)).toEqual(["file", "hunk", "ctx", "del", "add", "add"]);
    expect(lines[0]!.text).toBe("src/x.ts");
    expect([lines[2]!.old, lines[2]!.new]).toEqual([10, 10]);
    expect([lines[3]!.old, lines[4]!.new, lines[5]!.new]).toEqual([11, 11, 12]);
  });

  it("the summary drops the repeated actor name", () => {
    expect(summaryLine(record({ seq: 1, agent: "claude-a" }))).toBe("Did edit #1");
  });
});

describe("WeftFeedTests → summaries and default filter on Otto's live feed tail", () => {
  const page = localFixture<{ events: unknown[]; cursor: string; has_more: boolean }>("otto-live-feed-tail.json");
  const events = page.events.map(normalize);
  const get = (repo: string, seq: number) => events.find((e) => e.repo === repo && e.seq === seq)!;

  it("decodes the live feed page", () => {
    expect(events).toHaveLength(14);
    expect(page.has_more).toBe(false);
    expect(page.cursor.startsWith("v0.")).toBe(true);
    expect(new Set(events.map((e) => e.repo))).toEqual(new Set(["cto", "weft", "weft-demo"]));
    const log = new FeedLog(events);
    expect(log.resumePoint("cto")).toBe(8);
    expect(`${log.combined[0]!.repo}#${log.combined[0]!.seq}`).toBe("cto#8");
  });

  it("whole-file edits and releases name the file", () => {
    expect(summaryLine(get("cto", 4))).toBe("Created weft-probe-2.md");
    expect(summaryLine(get("cto", 7))).toBe("Released its claim on weft-probe.md (expired)");
    expect(summaryLine(get("cto", 8))).toBe("Released its claim on weft-probe-2.md (expired)");
    expect(summaryWithActor(get("cto", 2))).toBe("hermes-webmaster created weft-probe.md");
    const big = summaryLine(get("weft", 603));
    expect(big.startsWith("Edited run-4.driver.log, created ")).toBe(true);
    expect(big.includes(" more") && big.endsWith("— M2 milestone: full demo scenario end to end")).toBe(true);
    expect(summaryLine(get("weft", 652))).toContain("removed b, base +4 more in .probe.mjs");
    expect(summaryLine(get("weft", 638))).toBe("Landed hermes-backend/t_dc8956a4 (4 files)");
    for (const e of events) {
      expect(summaryLine(e)).not.toContain("*");
      expect(summaryWithActor(e)).not.toContain("*");
    }
  });

  it("parsed symbols keep the coordinator's summary", () => {
    const blocked = get("weft-demo", 578);
    expect(rebuildSummary(blocked)).toBeUndefined();
    expect(summaryLine(blocked).startsWith("Blocked: claude-t3-r4 added refreshSession")).toBe(true);
    expect(summaryLine(get("weft", 608)).startsWith("Pushed checkpoint 8430787")).toBe(true);
  });

  it("whole-file keys display as the file", () => {
    expect(isWholeFile("docs/try-it.md#*") && !isWholeFile("src/a.ts#f")).toBe(true);
    expect(displayKey("docs/try-it.md#*")).toBe("try-it.md");
    expect(displayKey("src/a.ts#Store.get")).toBe("Store.get");
    expect(names(["a/x.md#*", "b/y.json#*", "c/z.py#*"])).toBe("x.md, y.json +1 more");
  });

  it("the default feed hides session bookkeeping", () => {
    const log = new FeedLog(events);
    const shown = log.filtered({});
    expect(new Set(shown.map((e) => e.kind))).toEqual(new Set(["edit", "checkpoint", "land"]));
    expect(shown.some((e) => ["join", "leave", "release", "claim"].includes(e.kind))).toBe(false);
    expect(shown.some((e) => e.repo === "weft-demo" && e.seq === 578)).toBe(true);
    expect(log.filtered({ showSessionEvents: true })).toHaveLength(events.length);
    expect(log.filtered({ kinds: ["claim"] }).map((e) => e.kind)).toEqual(["release", "release"]);
    expect(filterIsEmpty({}) && !filterIsEmpty({ showSessionEvents: true })).toBe(true);
  });

  it("blocked or squiggled bookkeeping is never hidden", () => {
    const e = normalize({ seq: 9, repo: "r", status: "rejected", kind: "claim", ts: "2026-10-09T10:00:00Z", actor: { type: "agent", id: "a" }, agent: "a", writes: [{ key: "x.md#*", kind: "body" }], summary: "Blocked: a claimed *" });
    expect(isSessionBookkeeping(e)).toBe(false);
    expect(new FeedLog([e]).filtered({})).toHaveLength(1);
    expect(summaryLine(e)).toBe("Blocked: Claimed x.md");
  });

  it("repos sort by activity; the header counts the last 7 days", () => {
    const log = new FeedLog(events);
    expect(log.reposByActivity).toEqual(["cto", "weft", "weft-demo"]);
    const t = Date.parse("2026-10-09T15:00:00Z");
    expect(log.activeRepos(7, t)).toEqual(["cto", "weft", "weft-demo"]);
    expect(log.activeRepos(1, t)).toEqual(["cto"]);
    expect(headerStatus({ configured: true, live: true, loading: false, everSucceeded: true, active: ["cto", "weft"], hasSaved: true })).toEqual({ text: "Live · 2 repos", tone: "live" });
    expect(headerStatus({ configured: true, live: true, loading: false, everSucceeded: true, active: ["cto"], hasSaved: true }).text).toBe("Live · cto");
    expect(headerStatus({ configured: true, live: false, loading: true, everSucceeded: false, active: [], hasSaved: false })).toEqual({ text: "Connecting", tone: "connecting" });
    expect(headerStatus({ configured: true, live: false, loading: true, everSucceeded: true, active: ["cto"], hasSaved: true })).toEqual({ text: "Offline · saved changes", tone: "offline" });
  });

  it("code labels", () => {
    expect(codeLabel("stale_assumption")).toBe("contract changed under you");
    expect(codeLabel("land_conflict")).toBe("land conflict");
  });
});

describe("ChangesView / detail action rules", () => {
  it("Message + Pause/Resume for agents, Approve for unapproved candidates, Undo only on an un-reverted land", () => {
    const log = new FeedLog([
      record({ seq: 1, agent: "a", task: "T-1", change: "Ia" }),
      record({ seq: 2, kind: "land", agent: "a", task: "T-1", change: "Ia", payload: { sha: "s", op_id: "o" } }),
      record({ seq: 3, kind: "land", agent: "b", task: "T-2", change: "Ib", payload: { sha: "t", op_id: "p" } }),
      record({ seq: 4, kind: "revert", agent: "a", payload: { op_id: "o2", reverts_seq: 2, reason: "boom" } }),
      record({ seq: 5, kind: "control", agent: "john", payload: { action: "pause", target: { agent: "a" } } }),
    ]);
    const kinds = (seq: number) => actionsFor(log.event("r", seq)!, log).map((a) => a.kind);
    expect(kinds(1)).toEqual(["message", "resume", "approve"]);
    expect(kinds(2)).toEqual(["message", "resume"]); // reverted land: no Undo, never Approve
    expect(kinds(3)).toEqual(["message", "pause", "undo"]);
    log.ingest([record({ seq: 6, kind: "control", agent: "john", payload: { action: "approve", target: { change: "Ia" } } })]);
    expect(kinds(1)).toEqual(["message", "resume"]);
  });
});
