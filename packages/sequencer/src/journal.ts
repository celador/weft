// Input journal + replay. Every state-changing call is recorded with the clock value it
// ran under, then dispatched. Replaying the journal into an empty database reproduces the
// log, every verdict and all derived state byte-for-byte (spec §5.1: replay determinism).

import { WcpProtocolError, type Actor, type EventDraft, type Gate, type Hello, type HumanAction, type Submit } from "@weft/protocol";
import { SqlCoordinator, type CoordinatorInit, type QueueEntry } from "./coordinator";
import { all, run, type Sql } from "./sql";

export type JournalEntry = { n: number; at: number; op: JournalOp; args: unknown[] };

export type JournalOp =
  | "hello"
  | "submit"
  | "drain"
  | "gate"
  | "heartbeat"
  | "bye"
  | "action"
  | "system"
  | "tick"
  | "enqueue"
  | "queue_status";

/** Dispatch one journaled operation (the only entry point for state changes). */
export function dispatch(c: SqlCoordinator, op: JournalOp, args: unknown[]): unknown {
  const a = args as never[];
  switch (op) {
    case "hello":
      return c.hello(a[0] as Hello);
    case "submit":
      return c.submit(a[0] as string, a[1] as Submit, (a[2] ?? {}) as { owner?: string; idempotencyKey?: string });
    case "drain":
      return c.drain(a[0] as string, (a[1] ?? undefined) as number | undefined, (a[2] ?? undefined) as string | undefined);
    case "gate":
      return c.gate(a[0] as string, a[1] as Gate, (a[2] ?? undefined) as string | undefined);
    case "heartbeat":
      return c.heartbeat(a[0] as string, (a[1] ?? undefined) as string | undefined);
    case "bye":
      return c.bye(a[0] as string, (a[1] ?? undefined) as string | undefined, (a[2] ?? undefined) as string | undefined);
    case "action":
      return c.action(a[0] as string, a[1] as HumanAction);
    case "system":
      return c.system(a[0] as EventDraft, (a[1] ?? undefined) as Actor | undefined);
    case "tick":
      return c.tick();
    case "enqueue":
      return c.enqueue(a[0] as string, a[1] as string, (a[2] ?? undefined) as string | undefined);
    case "queue_status":
      return c.setQueueStatus(a[0] as number, a[1] as QueueEntry["status"], (a[2] ?? undefined) as string | undefined);
  }
}

/** A coordinator whose mutations all go through the journal. */
export class JournaledCoordinator {
  readonly coord: SqlCoordinator;
  /** One operation happens at one instant: the clock is frozen for its duration. */
  private frozen: number | undefined;
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number,
  ) {
    this.coord = new SqlCoordinator(sql, () => this.frozen ?? now());
  }

  call<T = unknown>(op: JournalOp, ...args: unknown[]): T {
    const outer = this.frozen;
    const at = outer ?? this.now();
    // JSON drops `undefined`; store explicit nulls so argument positions survive.
    run(this.sql, `INSERT INTO journal (at, op, args) VALUES (?, ?, ?)`, at, op, JSON.stringify(args.map((x) => (x === undefined ? null : x))));
    this.frozen = at;
    try {
      return dispatch(this.coord, op, args) as T;
    } finally {
      this.frozen = outer;
    }
  }

  journal(after = 0, limit = 10_000): JournalEntry[] {
    return all<{ n: number; at: number; op: JournalOp; args: string }>(this.sql, `SELECT * FROM journal WHERE n > ? ORDER BY n LIMIT ?`, after, limit).map((r) => ({
      ...r,
      args: JSON.parse(r.args) as unknown[],
    }));
  }
}

/**
 * Replay a journal into an empty database. Returns the rebuilt coordinator and the
 * result (or protocol error) of every entry.
 */
export function replay(
  sql: Sql,
  init: CoordinatorInit,
  entries: JournalEntry[],
): { coord: SqlCoordinator; results: unknown[] } {
  let t = 0;
  SqlCoordinator.init(sql, init);
  const coord = new SqlCoordinator(sql, () => t);
  const results: unknown[] = [];
  for (const e of entries) {
    t = e.at;
    try {
      results.push(dispatch(coord, e.op, e.args) ?? null);
    } catch (err) {
      if (!(err instanceof WcpProtocolError)) throw err;
      results.push(err.toJSON());
    }
  }
  return { coord, results };
}
