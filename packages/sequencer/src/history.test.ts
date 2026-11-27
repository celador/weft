// Revert history in the SQL coordinator (spec §6.6, §9.7): the key -> history index is kept on
// append and rebuilt once for databases from before it existed; reads and pre-edit notes use the
// index, never a scan of the log. Behaviour itself is pinned by the conformance scenarios
// (revert-history, history-refused-and-negotiated), which run through both coordinators.

import { describe, expect, it } from "vitest";
import { scenarioClock, validate, type Hello, type HistoryPage, type Submit, type Verdict, type Welcome } from "@weft/protocol";
import { SqlCoordinator } from "./coordinator";
import { JournaledCoordinator } from "./journal";
import { nodeSql } from "./node-sqlite";
import type { Sql, SqlValue } from "./sql";

const F = "src/x.ts#f";
const DAY = 86_400_000;
const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (agent: string, change: string): Hello => ({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: caps, task: { id: `T-${agent}` }, change });
const edit = (base: number, key: string, mode: "check" | "commit" = "commit"): Submit => ({ type: "submit", mode, event: { kind: "edit", base_seq: base, writes: [{ key, kind: "body" }] } });

/** A repo where claude-a's change to f landed and was reverted; then `filler` unrelated edits. */
function reverted(filler = 0) {
  const sql = nodeSql();
  const clock = scenarioClock("2026-11-01T10:00:00.000Z");
  SqlCoordinator.init(sql, { repo: "demo" });
  const j = new JournaledCoordinator(sql, clock.now);
  const a = j.call<Welcome>("hello", hello("claude-a", "I-a"));
  let base = j.call<Verdict>("submit", a.session, edit(a.delivered_through, F)).delivered_through;
  const land = j.call<{ seq: number }>("system", { kind: "land", base_seq: 2, change: "I-a", payload: { sha: "1a2b3c4d", op_id: "op_1" } });
  const rev = j.call<{ seq: number }>("system", { kind: "revert", base_seq: 3, change: "I-a", payload: { op_id: "op_2", reverts_op_id: "op_1", sha: "5e6f7a8b", reason: "broke login\n  at f (src/x.ts:3:7)", requested_by: { type: "human", id: "john" } } }, { type: "system", id: "revert-workflow" });
  for (let i = 0; i < filler; i++) base = j.call<Verdict>("submit", a.session, edit(base, `src/other${i % 50}.ts#g${i}`)).delivered_through;
  return { sql, clock, j, land: land.seq, revert: rev.seq };
}

/** Wrap a Sql so every statement it runs is recorded. */
function recorded(sql: Sql): { sql: Sql; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    sql: {
      exec<T>(q: string, ...b: SqlValue[]) {
        queries.push(q.replace(/\s+/g, " ").trim());
        return sql.exec<T>(q, ...b);
      },
    },
  };
}

describe("history index (SqlCoordinator)", () => {
  it("derives a revert's keys from its op (by op id: revert -> land -> change -> accepted edits)", () => {
    const { j, revert, land } = reverted();
    const page = j.coord.history({ keys: [F] });
    expect(validate("HistoryPage", page)).toMatchObject({ ok: true });
    expect(page.entries).toEqual([
      expect.objectContaining({ seq: revert, kind: "revert", keys: [F], reason: "broke login", requested_by: { type: "human", id: "john" }, reverts_op_id: "op_1", evidence: "at f (src/x.ts:3:7)" }),
    ]);
    expect(page.entries[0]!.reverts_seq).toBeUndefined(); // only what the record says
    expect(land).toBe(revert - 1);
  });

  it("a history read and a pre-edit note run on the index: no statement scans the events table", () => {
    const { sql, clock, j } = reverted(400);
    clock.advance(2 * DAY);
    const b = j.call<Welcome>("hello", hello("codex-b", "I-b"));
    const r = recorded(sql);
    const coord = new SqlCoordinator(r.sql, clock.now);
    r.queries.length = 0;
    const v = coord.submit(b.session, edit(b.delivered_through, F, "check"));
    expect(v.diagnostics).toEqual([expect.objectContaining({ severity: "info", code: "previously_reverted", message: expect.stringMatching(/^previously reverted 2d ago: broke login \(by john, #4\)$/) })]);
    const page = coord.history({ keys: ["src/x.ts"] });
    expect(page.entries.map((e) => e.seq)).toEqual([4]);
    const eventsReads = r.queries.filter((q) => /\bFROM events\b/.test(q));
    // Only point lookups by seq and the head (MAX(seq)), never a filter over the log.
    for (const q of eventsReads) expect(q).toMatch(/FROM events WHERE seq = \?|SELECT MAX\(seq\) AS h FROM events/);
    // And the index is searched, not scanned.
    const plan = (q: string, ...args: SqlValue[]) => sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${q}`, ...args).toArray().map((x) => x.detail).join(" | ");
    const note = plan(`SELECT seq FROM key_history WHERE kind = 'revert' AND at >= ? AND (key IN (?, ?) OR (key >= ? AND key < ?)) ORDER BY seq DESC LIMIT 1`, 0, F, "src/x.ts#*", `${F}.`, `${F}/`);
    const read = plan(`SELECT DISTINCT seq FROM key_history WHERE at >= ? AND ((key >= ? AND key < ?)) ORDER BY seq DESC LIMIT ?`, 0, "src/x.ts#", "src/x.ts$", 21);
    for (const p of [note, read]) {
      expect(p).toMatch(/^SEARCH key_history USING/);
      expect(p).not.toMatch(/\bSCAN\b/);
    }
  });

  it("a v5 database gets its history index built once from the log", () => {
    const { sql, clock, revert } = reverted(3);
    sql.exec(`DELETE FROM key_history`).toArray();
    sql.exec(`UPDATE meta SET v = '5' WHERE k = 'schema_version'`).toArray();
    expect(new SqlCoordinator(sql, clock.now).history({ keys: [F] }).entries.map((e) => e.seq)).toEqual([revert]); // migrate() flagged it, the constructor rebuilt it
    expect(sql.exec(`SELECT 1 FROM meta WHERE k = 'history_backfill'`).toArray()).toEqual([]);
    expect(sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'schema_version'`).toArray()[0]!.v).toBe("6");
  });

  it("notes once per key per session, info only, and the stored record keeps no note", () => {
    const { clock, j } = reverted();
    clock.advance(DAY);
    const b = j.call<Welcome>("hello", hello("codex-b", "I-b"));
    const first = j.call<Verdict>("submit", b.session, edit(b.delivered_through, F, "check"));
    expect(first.diagnostics.map((d) => [d.severity, d.code])).toEqual([["info", "previously_reverted"]]);
    expect(validate("Verdict", first)).toMatchObject({ ok: true });
    const commit = j.call<Verdict>("submit", b.session, edit(b.delivered_through, F));
    expect(commit.diagnostics).toEqual([]);
    expect(j.coord.event(commit.seq!).diagnostics).toEqual([]);
    expect(j.coord.dump().session_noted).toEqual([{ session: b.session, key: F }]);
    j.call("bye", b.session);
    expect(j.coord.dump().session_noted).toEqual([]);
  });

  it("refuses a malformed query with invalid_message", () => {
    const { j } = reverted();
    for (const keys of [[], ["#f"], ["a b"], ["src/x.ts#f#g"]]) expect(() => j.coord.history({ keys })).toThrow(/invalid history query/);
    expect(() => j.coord.history({ keys: [F], since: "yesterday" })).toThrow(/since/);
    expect(() => j.coord.history({ keys: [F], limit: 0 })).toThrow(/limit/);
    const capped: HistoryPage = j.coord.history({ keys: [F], limit: 10_000 });
    expect(capped.entries).toHaveLength(1);
  });
});
