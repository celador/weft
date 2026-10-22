import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FeedEvent, normalize } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..");

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** A recorded coordinator log (`{url?, repo, events}`) from demo/evidence. */
export function evidenceLog(rel: string): { repo: string; events: FeedEvent[] } {
  const d = readJson<{ repo: string; events: unknown[] }>(join(repoRoot, "demo", "evidence", rel));
  return { repo: d.repo, events: d.events.map(normalize) };
}

/** A pinned WCP message from packages/protocol/fixtures/messages/valid (its `value`). */
export function protocolFixture<T = unknown>(name: string): T {
  return readJson<{ value: T }>(join(repoRoot, "packages", "protocol", "fixtures", "messages", "valid", `${name}.json`)).value;
}

export function localFixture<T = unknown>(name: string): T {
  return readJson<T>(join(here, "fixtures", name));
}

/** Otto's test record builder (HermesTests/WeftTests.swift `WeftFixture.record`). */
export function record(o: {
  seq: number;
  repo?: string;
  kind?: string;
  ts?: string;
  agent?: string;
  status?: string;
  task?: string;
  change?: string;
  payload?: Record<string, unknown>;
  diagnostics?: unknown[];
  diff?: string;
}): FeedEvent {
  const seq = o.seq;
  const agent = o.agent ?? "a";
  const kind = o.kind ?? "edit";
  return normalize({
    seq,
    repo: o.repo ?? "r",
    status: o.status ?? "accepted",
    kind,
    ts: o.ts ?? `2026-10-05T14:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`,
    actor: { type: "agent", id: agent, harness: "codex" },
    agent,
    summary: `${agent} did ${kind} #${seq}`,
    diagnostics: o.diagnostics ?? [],
    ...(o.task ? { task: o.task } : {}),
    ...(o.change ? { change: o.change } : {}),
    ...(o.payload ? { payload: o.payload } : {}),
    ...(o.diff !== undefined ? { diff: o.diff } : {}),
  });
}

/** Otto's strip test builder (HermesTests/WeftStripTests.swift `ev`). */
export const STRIP_NOW = Date.parse("2026-10-18T05:00:00.000Z");
export function ev(
  seq: number,
  kind: string,
  minutesAgo: number,
  o: {
    status?: string;
    change?: string | null;
    task?: string | null;
    files?: string[];
    intent?: string;
    payload?: Record<string, unknown>;
    diagnostics?: unknown[];
    agent?: string;
    actor?: "agent" | "system";
  } = {},
): FeedEvent {
  const agent = o.agent ?? "hermes-default";
  const actor = o.actor ?? "agent";
  const change = o.change === undefined ? "hermes-default/t_aaaaaaaa" : o.change;
  const task = o.task === undefined ? "t_aaaaaaaa" : o.task;
  return normalize({
    seq,
    repo: "hermes-ios",
    status: o.status ?? "accepted",
    kind,
    ts: new Date(STRIP_NOW - minutesAgo * 60_000).toISOString(),
    actor: { type: actor, id: actor === "system" ? "weft-pm-land" : agent },
    agent,
    summary: "s",
    diagnostics: o.diagnostics ?? [],
    files: o.files ?? [],
    ...(change ? { change } : {}),
    ...(task ? { task } : {}),
    ...(o.intent ? { intent: o.intent } : {}),
    ...(o.payload ? { payload: o.payload } : {}),
  });
}
