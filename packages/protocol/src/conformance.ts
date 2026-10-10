// Conformance scenario runner. Scenarios (fixtures/scenarios/*.json) are a sequence of
// protocol operations with partial expectations. Any coordinator implementation can be
// driven through the `ConformanceTarget` interface (sync or async), e.g. the sequencer
// Durable Object through its HTTP API.

import { WcpProtocolError } from "./errors";
import type {
  ActionResult,
  Actor,
  EventDraft,
  EventPage,
  EventRecord,
  Gate,
  GateResult,
  HeartbeatAck,
  Hello,
  HumanAction,
  InboxBatch,
  RepoPolicy,
  Submit,
  Verdict,
  Welcome,
} from "./types";
import type { ClaimsPolicy } from "./types";

type MaybePromise<T> = T | Promise<T>;

export interface ConformanceTarget {
  hello(h: Hello): MaybePromise<Welcome>;
  submit(session: string, s: Submit): MaybePromise<Verdict>;
  drain(session: string, ack?: number): MaybePromise<InboxBatch>;
  gate(session: string, g: Gate): MaybePromise<GateResult>;
  heartbeat(session: string): MaybePromise<HeartbeatAck>;
  bye(session: string, reason?: string): MaybePromise<void>;
  action(human: string, a: HumanAction): MaybePromise<ActionResult>;
  system(draft: EventDraft, actor?: Actor): MaybePromise<EventRecord>;
  tick(): MaybePromise<EventRecord[]>;
  events(after?: number, limit?: number, opts?: { include_diff?: boolean; tail?: boolean; before?: number }): MaybePromise<EventPage>;
  event(seq: number): MaybePromise<EventRecord>;
  /** Operator: apply repo policy (spec §7.5 claims policy; Weft journal op `policy`). */
  policy?(p: { claims: ClaimsPolicy }): MaybePromise<RepoPolicy>;
}

export type ScenarioStep =
  | { op: "hello"; as: string; hello: Hello; expect?: unknown }
  | { op: "submit"; as: string; submit: Submit; expect?: unknown }
  | { op: "drain"; as: string; ack?: number | "last"; expect?: unknown }
  | { op: "gate"; as: string; gate: Gate["gate"]; expect?: unknown }
  | { op: "heartbeat"; as: string; expect?: unknown }
  | { op: "bye"; as: string; reason?: string }
  | { op: "action"; human: string; action: HumanAction; expect?: unknown }
  | { op: "system"; draft: EventDraft; actor?: Actor; expect?: unknown }
  | { op: "advance"; ms: number }
  | { op: "tick"; expect?: unknown }
  | { op: "events"; after?: number; limit?: number; include_diff?: boolean; tail?: boolean; before?: number; expect?: unknown }
  | { op: "event"; seq: number; expect?: unknown }
  | { op: "policy"; policy: { claims: ClaimsPolicy }; expect?: unknown };

export type Scenario = {
  name: string;
  description: string;
  /** Spec sections exercised, e.g. ["6.2 R2", "7.2"]. */
  covers: string[];
  repo: string;
  policy?: "wound-wait" | "wait-die";
  escalation?: "auto" | "human";
  claim_ttl_ms?: number;
  session_ttl_ms?: number;
  /**
   * Claims policy (spec §7.5). Absent: the defaults of a new repo. `null`: a repo created
   * before the claims policy existed (legacy rules until a `policy` step applies one).
   */
  claims?: ClaimsPolicy | null;
  /** Clock start (ISO). Each step advances 1 ms unless `advance` is used. */
  start: string;
  steps: ScenarioStep[];
};

/** Coordinator options a scenario asks for (shared by every test harness). */
export function scenarioInit(sc: Scenario): {
  repo: string;
  policy?: "wound-wait" | "wait-die";
  escalation?: "auto" | "human";
  claim_ttl_ms?: number;
  session_ttl_ms?: number;
  claims?: ClaimsPolicy | null;
} {
  return {
    repo: sc.repo,
    ...(sc.policy ? { policy: sc.policy } : {}),
    ...(sc.escalation ? { escalation: sc.escalation } : {}),
    ...(sc.claim_ttl_ms ? { claim_ttl_ms: sc.claim_ttl_ms } : {}),
    ...(sc.session_ttl_ms ? { session_ttl_ms: sc.session_ttl_ms } : {}),
    ...(sc.claims !== undefined ? { claims: sc.claims } : {}),
  };
}

export type ScenarioClock = { now: () => number; advance: (ms: number) => void };

export function scenarioClock(start: string): ScenarioClock {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms) => void (t += ms) };
}

/**
 * Partial structural match: every key in `expected` must match in `actual`; arrays must have
 * equal length and match element-wise. `{"$len": n}` matches an array of length n;
 * `{"$contains": [...]}` matches an array containing elements matching each item; `"$any"`
 * matches anything present; `"$absent"` requires the key to be missing.
 */
export function partialMatch(actual: unknown, expected: unknown, path = ""): string[] {
  if (expected === "$any") return actual === undefined ? [`${path}: expected a value`] : [];
  if (expected === null || typeof expected !== "object") {
    return Object.is(actual, expected) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  const exp = expected as Record<string, unknown>;
  if (!Array.isArray(expected) && "$len" in exp) {
    return Array.isArray(actual) && actual.length === exp.$len
      ? []
      : [`${path}: expected length ${String(exp.$len)}, got ${Array.isArray(actual) ? actual.length : typeof actual}`];
  }
  if (!Array.isArray(expected) && "$contains" in exp) {
    if (!Array.isArray(actual)) return [`${path}: expected array`];
    const errs: string[] = [];
    (exp.$contains as unknown[]).forEach((want, i) => {
      if (!actual.some((a) => partialMatch(a, want).length === 0)) errs.push(`${path}: no element matches $contains[${i}] ${JSON.stringify(want)}`);
    });
    return errs;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${typeof actual}`];
    if (actual.length !== expected.length)
      return [`${path}: expected ${expected.length} items, got ${actual.length}: ${JSON.stringify(actual).slice(0, 400)}`];
    return expected.flatMap((e, i) => partialMatch(actual[i], e, `${path}/${i}`));
  }
  if (actual === null || typeof actual !== "object") return [`${path}: expected object, got ${JSON.stringify(actual)}`];
  const act = actual as Record<string, unknown>;
  return Object.entries(exp).flatMap(([k, v]) =>
    v === "$absent" ? (k in act ? [`${path}/${k}: expected absent`] : []) : partialMatch(act[k], v, `${path}/${k}`),
  );
}

export type StepResult = { index: number; op: string; ok: boolean; errors: string[]; actual: unknown };

/** Run a scenario; returns one result per step. Throws only on harness bugs. */
export async function runScenario(sc: Scenario, target: ConformanceTarget, clock: ScenarioClock): Promise<StepResult[]> {
  const sessions = new Map<string, string>();
  const lastInbox = new Map<string, number>();
  const sid = (as: string) => {
    const s = sessions.get(as);
    if (!s) throw new Error(`scenario ${sc.name}: no session for ${as}`);
    return s;
  };
  const results: StepResult[] = [];
  for (const [index, step] of sc.steps.entries()) {
    clock.advance(1);
    let actual: unknown;
    try {
      switch (step.op) {
        case "hello": {
          const w = await target.hello(step.hello);
          sessions.set(step.as, w.session);
          actual = w;
          break;
        }
        case "submit": {
          const v = await target.submit(sid(step.as), step.submit);
          if (v.inbox.length) lastInbox.set(step.as, v.inbox[v.inbox.length - 1]!.id);
          actual = v;
          break;
        }
        case "drain": {
          const ack = step.ack === "last" ? lastInbox.get(step.as) : step.ack;
          const b = await target.drain(sid(step.as), ack);
          if (b.items.length) lastInbox.set(step.as, b.items[b.items.length - 1]!.id);
          actual = b;
          break;
        }
        case "gate":
          actual = await target.gate(sid(step.as), { type: "gate", gate: step.gate });
          break;
        case "heartbeat":
          actual = await target.heartbeat(sid(step.as));
          break;
        case "bye":
          await target.bye(sid(step.as), step.reason);
          sessions.delete(step.as);
          actual = null;
          break;
        case "action":
          actual = await target.action(step.human, step.action);
          break;
        case "system":
          actual = await target.system(step.draft, step.actor);
          break;
        case "advance":
          clock.advance(step.ms);
          actual = null;
          break;
        case "tick":
          actual = await target.tick();
          break;
        case "events":
          actual = await target.events(step.after, step.limit, {
            ...(step.include_diff ? { include_diff: true } : {}),
            ...(step.tail ? { tail: true } : {}),
            ...(step.before !== undefined ? { before: step.before } : {}),
          });
          break;
        case "event":
          actual = await target.event(step.seq);
          break;
        case "policy":
          if (!target.policy) throw new Error(`scenario ${sc.name}: target cannot apply policy`);
          actual = await target.policy(step.policy);
          break;
      }
    } catch (e) {
      if (!(e instanceof WcpProtocolError)) throw e;
      actual = e.toJSON();
    }
    const expect = "expect" in step ? step.expect : undefined;
    const errors = expect === undefined ? [] : partialMatch(actual, expect);
    results.push({ index, op: step.op, ok: errors.length === 0, errors, actual });
  }
  return results;
}
