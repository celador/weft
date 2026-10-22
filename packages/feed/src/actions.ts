// Squiggles with their cause, and the human actions a record allows, ported from Otto
// (ChangesView.swift `WeftDiagnosticCallout`, WeftEventDetailView.swift `availableActions`,
// WeftModels.swift `WeftAction`).

import type { FeedLog } from "./log";
import { codeLabel, symbolName } from "./summary";
import type { Diagnostic, FeedEvent, HumanAction } from "./types";
import { epochMs, idOf } from "./types";

export type Squiggle = {
  /** `repo#seq#index`: stable per diagnostic. */
  id: string;
  /** The record that carries the diagnostic (`repo#seq`). */
  on: string;
  repo: string;
  seq: number;
  agent?: string;
  task?: string;
  change?: string;
  rejected: boolean;
  severity: Diagnostic["severity"];
  code: string;
  /** Plain-words code ("contract changed under you"). */
  label: string;
  file: string;
  /** Short symbol name (`calcTotal`), the squiggled text. */
  symbol: string;
  symbolKey: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  /** The causing record (`repo#seq`): open it to see what changed. */
  cause: { id: string; repo: string; seq: number; agent: string; task?: string };
  /** "caused by <agent> · event #N" (Otto's link text). */
  causeText: string;
  date: number;
  diagnostic: Diagnostic;
  record: FeedEvent;
};

export function squiggleOf(e: FeedEvent, d: Diagnostic, i: number): Squiggle {
  const r = d.range?.start;
  return {
    id: `${idOf(e)}#${i}`,
    on: idOf(e),
    repo: e.repo,
    seq: e.seq,
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.task ? { task: e.task } : {}),
    ...(e.change ? { change: e.change } : {}),
    rejected: e.status === "rejected",
    severity: d.severity,
    code: d.code,
    label: codeLabel(d.code),
    file: d.file ?? "",
    symbol: symbolName(d.symbol ?? ""),
    symbolKey: d.symbol ?? "",
    ...(r ? { line: r.line + 1, column: r.character + 1 } : {}),
    message: d.message,
    ...(d.suggestion ? { suggestion: d.suggestion } : {}),
    cause: {
      id: `${e.repo}#${d.caused_by_seq}`,
      repo: e.repo,
      seq: d.caused_by_seq,
      agent: d.caused_by_agent,
      ...(d.caused_by_task ? { task: d.caused_by_task } : {}),
    },
    causeText: `caused by ${d.caused_by_agent} · event #${d.caused_by_seq}`,
    date: epochMs(e.ts),
    diagnostic: d,
    record: e,
  };
}

/** Every squiggle in the records, newest first, each linked to the record that caused it. */
export function squiggles(source: FeedLog | FeedEvent[], opts: { minSeverity?: Diagnostic["severity"] } = {}): Squiggle[] {
  const events = Array.isArray(source) ? source : source.combined;
  const rank = { info: 0, warning: 1, error: 2 } as const;
  const min = rank[opts.minSeverity ?? "info"];
  const out: Squiggle[] = [];
  for (const e of events) e.diagnostics.forEach((d, i) => rank[d.severity] >= min && out.push(squiggleOf(e, d, i)));
  return out.sort((a, b) => b.date - a.date || (a.repo === b.repo ? b.seq - a.seq : a.repo < b.repo ? 1 : -1));
}

/** The record a squiggle points at, if held (fetch it with `client.event(repo, seq)` if not). */
export const causeOf = (log: FeedLog, s: Squiggle): FeedEvent | undefined => log.event(s.cause.repo, s.cause.seq);

// ---------------------------------------------------------------- human actions (spec §9.6)

export type ActionKind = "message" | "pause" | "resume" | "approve" | "undo";

export type ActionOption = {
  kind: ActionKind;
  /** Button title ("Pause"). */
  title: string;
  /** Longer label ("Pause claude-b", "Undo landing…"). */
  label: string;
  repo: string;
  /** Who/what it targets. */
  agent?: string;
  change?: string;
  task?: string;
  seq?: number;
  destructive: boolean;
  /** Needs text from the human before sending (message text, undo reason, approve note). */
  needsText?: "text" | "reason" | "note";
};

/**
 * The actions a record allows, in Otto's order: Message and Pause/Resume for an agent's
 * record (Resume when the last pause/resume on that agent in that repo was a pause),
 * Approve for a candidate's record that is not yet approved (never on land/revert), and
 * Undo only on a `land` that no `revert` has undone.
 */
export function actionsFor(e: FeedEvent, log: FeedLog): ActionOption[] {
  const out: ActionOption[] = [];
  const repo = e.repo;
  if (e.agent) {
    const agent = e.agent;
    out.push({ kind: "message", title: "Message", label: `Message ${agent}`, repo, agent, destructive: false, needsText: "text" });
    out.push(
      log.isPaused(agent, repo)
        ? { kind: "resume", title: "Resume", label: `Resume ${agent}`, repo, agent, destructive: false }
        : { kind: "pause", title: "Pause", label: `Pause ${agent}`, repo, agent, destructive: false },
    );
  }
  if (e.change && e.kind !== "revert" && e.kind !== "land") {
    const approved = log.candidates(e.task ?? "", repo).find((c) => c.change === e.change)?.approved ?? false;
    if (!approved)
      out.push({
        kind: "approve",
        title: "Approve",
        label: "Approve candidate",
        repo,
        change: e.change,
        ...(e.task ? { task: e.task } : {}),
        destructive: false,
        needsText: "note",
      });
  }
  if (e.kind === "land" && e.status === "accepted" && !log.revertOf(e))
    out.push({ kind: "undo", title: "Undo", label: "Undo landing…", repo, seq: e.seq, destructive: true, needsText: "reason" });
  return out;
}

export type ActionInput = { text?: string; reason?: string; note?: string; intent?: "steer" | "negotiate" | "info" };

/** The exact `HumanAction` wire body for an option (matches the spec's pinned fixtures). */
export function actionBody(o: ActionOption, input: ActionInput = {}): HumanAction {
  switch (o.kind) {
    case "message":
      return { type: "action", action: "message", to: { agent: o.agent! }, text: input.text ?? "", intent: input.intent ?? "steer" };
    case "pause":
      return { type: "action", action: "pause", agent: o.agent!, ...(input.reason ? { reason: input.reason } : {}) };
    case "resume":
      return { type: "action", action: "resume", agent: o.agent! };
    case "approve":
      return { type: "action", action: "approve", change: o.change!, ...(o.task ? { task: o.task } : {}), ...(input.note ? { note: input.note } : {}) };
    case "undo":
      return { type: "action", action: "undo", seq: o.seq!, reason: input.reason || "undone from the Weft feed" };
  }
}
