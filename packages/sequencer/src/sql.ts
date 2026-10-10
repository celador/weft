// Minimal synchronous SQL surface shared by the Durable Object (ctx.storage.sql) and the
// node:sqlite adapter used in fast unit tests. Only the subset the coordinator needs.

export type SqlValue = string | number | null;

export interface SqlCursor<T> {
  toArray(): T[];
}

export interface Sql {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** Normalize JS values for binding: booleans → 0/1, undefined → null. */
export function b(v: string | number | boolean | null | undefined): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function all<T>(sql: Sql, q: string, ...args: Array<string | number | boolean | null | undefined>): T[] {
  return sql.exec<T>(q, ...args.map(b)).toArray();
}

export function one<T>(sql: Sql, q: string, ...args: Array<string | number | boolean | null | undefined>): T | undefined {
  return all<T>(sql, q, ...args)[0];
}

export function run(sql: Sql, q: string, ...args: Array<string | number | boolean | null | undefined>): void {
  sql.exec(q, ...args.map(b)).toArray();
}

/**
 * Schema of one repo's coordinator. Every table is owned by exactly one Durable Object
 * (one repo), so no table carries a repo column.
 */
export const SCHEMA_VERSION = 3;

export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // The ordered log. `record` is the full EventRecord JSON (immutable once written).
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY,
     kind TEXT NOT NULL, status TEXT NOT NULL, ts TEXT NOT NULL,
     actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
     agent TEXT, change_id TEXT, task TEXT, session TEXT,
     record TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_kind ON events(kind, seq)`,
  // Write index of accepted edit/land/revert records: the W set of spec §6.1.
  `CREATE TABLE IF NOT EXISTS event_writes (
     seq INTEGER NOT NULL, key TEXT NOT NULL, wkind TEXT NOT NULL,
     change_id TEXT, committed INTEGER NOT NULL,
     PRIMARY KEY (seq, key))`,
  `CREATE INDEX IF NOT EXISTS event_writes_key ON event_writes(key, seq)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, ord INTEGER NOT NULL,
     agent TEXT NOT NULL, harness TEXT NOT NULL, change_id TEXT NOT NULL, task TEXT,
     capabilities TEXT NOT NULL,
     delivered_through INTEGER NOT NULL, next_inbox_id INTEGER NOT NULL,
     paused_by INTEGER, last_seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS changes (
     id TEXT PRIMARY KEY, ord INTEGER NOT NULL,
     agent TEXT NOT NULL, task TEXT, priority INTEGER NOT NULL, birth INTEGER,
     landed INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
     merged_into TEXT)`,
  `CREATE TABLE IF NOT EXISTS change_reads (change_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (change_id, key))`,
  `CREATE TABLE IF NOT EXISTS change_writes (
     change_id TEXT NOT NULL, key TEXT NOT NULL, wkind TEXT NOT NULL, ord INTEGER NOT NULL,
     PRIMARY KEY (change_id, key))`,
  // Claims. `ord` preserves creation order (arbitration and info diagnostics depend on it).
  `CREATE TABLE IF NOT EXISTS claims (
     ord INTEGER PRIMARY KEY,
     change_id TEXT NOT NULL, agent TEXT NOT NULL, task TEXT, key TEXT NOT NULL,
     firm INTEGER NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL,
     expires_at INTEGER NOT NULL, shared TEXT NOT NULL DEFAULT '[]')`,
  `CREATE INDEX IF NOT EXISTS claims_key ON claims(key)`,
  `CREATE INDEX IF NOT EXISTS claims_change ON claims(change_id)`,
  `CREATE TABLE IF NOT EXISTS inbox (
     session TEXT NOT NULL, id INTEGER NOT NULL, seq INTEGER NOT NULL, item TEXT NOT NULL,
     PRIMARY KEY (session, id))`,
  // v1–v2 kept open errors per session; v3 moves them to change_errors (spec §6.5). The
  // old table is still created so migrate() can read a v2 database's rows.
  `CREATE TABLE IF NOT EXISTS open_errors (
     session TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, diagnostic TEXT NOT NULL,
     PRIMARY KEY (session, key))`,
  // Open errors per change (spec §6.5). origin: check | commit | push; seq: the record
  // that opened it (redelivered to new sessions with that seq).
  `CREATE TABLE IF NOT EXISTS change_errors (
     change_id TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, origin TEXT NOT NULL,
     seq INTEGER NOT NULL, diagnostic TEXT NOT NULL,
     PRIMARY KEY (change_id, key))`,
  `CREATE TABLE IF NOT EXISTS idempotency (
     session TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, verdict TEXT NOT NULL,
     PRIMARY KEY (session, key))`,
  // Input journal: every state-changing call with the clock it saw. Replaying it into an
  // empty coordinator reproduces the log and all state (spec §5.1 replay determinism).
  `CREATE TABLE IF NOT EXISTS journal (n INTEGER PRIMARY KEY, at INTEGER NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL)`,
  // Operation log (design §3 "Operation"): one row per accepted land/revert.
  `CREATE TABLE IF NOT EXISTS ops (
     op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, change_id TEXT,
     sha TEXT, trunk_ref TEXT, reverts_seq INTEGER, reverts_op_id TEXT, at TEXT NOT NULL)`,
  // Submit queue (landing itself is B8): approved/requested changes waiting to land.
  `CREATE TABLE IF NOT EXISTS submit_queue (
     id INTEGER PRIMARY KEY, change_id TEXT NOT NULL, status TEXT NOT NULL,
     requested_by TEXT NOT NULL, enqueued_seq INTEGER, landed_seq INTEGER, note TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS submit_queue_change ON submit_queue(change_id, status)`,
];

/** Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS never adds them). */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // v2 (B11): merged task groups, spec §7.6.
  { table: "changes", column: "merged_into", ddl: `ALTER TABLE changes ADD COLUMN merged_into TEXT` },
];

export function migrate(sql: Sql): void {
  for (const q of DDL) run(sql, q);
  for (const c of ADDED_COLUMNS) {
    const cols = all<{ name: string }>(sql, `PRAGMA table_info(${c.table})`).map((r) => r.name);
    if (!cols.includes(c.column)) run(sql, c.ddl);
  }
  // v3: per-session open errors become per-change ones. Their origin is unknown, so they
  // are treated as commit-mode (the strictest: only an accepted edit or land clears them).
  run(
    sql,
    `INSERT OR IGNORE INTO change_errors (change_id, key, ord, origin, seq, diagnostic)
     SELECT s.change_id, o.key, o.ord, 'commit', COALESCE(json_extract(o.diagnostic, '$.caused_by_seq'), 0), o.diagnostic
     FROM open_errors o JOIN sessions s ON s.id = o.session ORDER BY o.ord`,
  );
  run(sql, `DELETE FROM open_errors`);
  run(sql, `INSERT OR IGNORE INTO meta (k, v) VALUES ('schema_version', ?)`, String(SCHEMA_VERSION));
  run(sql, `UPDATE meta SET v = ? WHERE k = 'schema_version' AND CAST(v AS INTEGER) < ?`, String(SCHEMA_VERSION), SCHEMA_VERSION);
}
