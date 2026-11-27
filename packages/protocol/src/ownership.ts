// Under `conflicts: continue` the owner of a change that caused a conflict is told, as an
// informational diagnostic, and is never blocked by it. The agent that hit the conflict is gated
// exactly as in `hold`: its stop and its commits are refused while the error is open. Only the
// wording and the owner's notice differ.
import type { Diagnostic } from "./types";

/**
 * `hold` (default, today's behaviour): the owner is not told. `continue` (per-repo opt-in:
 * `conflicts: "continue"` in the repo's config): the owner is told and the suggestions say to keep
 * working on other tasks instead of adapting to the other agent's change. Gates are the same in both.
 */
export type ConflictMode = "hold" | "continue";

/** True when this open error was caused by a change of another agent (not the agent's own). */
export function ownedElsewhere(d: Diagnostic, agent: string): boolean {
  return d.severity === "error" && d.code !== "agent_paused" && d.caused_by_agent !== undefined && d.caused_by_agent !== agent;
}

/** What the owner of the causing change sees: a warning, so it never blocks the owner. */
export function ownerNotice(d: Diagnostic, editor: string, kind: string): Diagnostic {
  // Built field by field: the editor's diagnostic (and its suggestion, which is written for the editor)
  // is not copied to the owner. `kind` is the rejected event's kind, so a claim is not called an edit.
  const act = kind === "edit" ? "edit to" : kind === "claim" ? "claim on" : kind === "land" ? "landing touching" : `${kind} on`;
  return {
    severity: "warning",
    code: d.code,
    file: d.file,
    symbol: d.symbol,
    message: `${editor}'s ${act} ${d.symbol} conflicts with your change #${d.caused_by_seq}.`,
    suggestion: `${editor} keeps working on its other tasks and does not adopt your change. Negotiate with ${editor} if the contract needs to change; otherwise no action is needed.`,
    caused_by_seq: d.caused_by_seq,
    caused_by_agent: editor,
  };
}

// ---- harness text about open errors (issue #15) ----
//
// What an adapter says around the coordinator's diagnostics (blocked edit, stop/commit gate
// refusal, session preamble). The diagnostics' suggestions carry the repo's `conflicts` mode
// (§8.4): under `hold` they say to update the code against the other agent's change, under
// `continue` they say that agent owns the conflict and the hit agent stops and reports it. The
// adapter does not know the mode, so its own text defers to the suggestion and never tells the
// agent, by itself, to adapt to, rebase onto or work around another agent's change. Every harness
// uses these strings (the Hermes plugin keeps byte-identical copies, pinned by its tests).

/** After the rendered errors of a stop or commit gate refusal. */
export const OPEN_ERROR_ADVICE =
  "Do what each error's suggestion says. If it says another agent owns the conflict, stop working on that code and report it " +
  "(negotiate with that agent, or say so in your task report): do not adapt your code to their change, rebase onto it or work around it to clear the error. " +
  "Otherwise re-edit the cited code as the suggestion says (an accepted edit that touches the symbol clears the error), or retreat from that code.";

/** After the rendered errors of a blocked (pre-edit denied) edit. */
export const BLOCKED_EDIT_ADVICE =
  "Do not retry the same edit. Do what each error's suggestion says. If it says another agent owns the conflict, leave this edit and report it " +
  "(negotiate with that agent, or say so in your task report): do not adapt your code to their change or work around it. " +
  "Otherwise change your code as the suggestion says, then edit again: your next attempt is checked against the current log.";

/** The session preamble's one-line rule for `[weft error]` lines. */
export const ERROR_RULE =
  "An edit with errors is blocked, and you cannot finish or commit while errors are open. Do not retry the same edit: do what the error's suggestion says. " +
  "When it says another agent owns the conflict, stop working on that code and report it instead of adapting to their change.";

/** Two owner notices are the same when they name the same conflict (no repeat on each resubmission). */
export function sameNotice(a: Diagnostic, b: Diagnostic): boolean {
  return a.code === b.code && a.symbol === b.symbol && a.caused_by_seq === b.caused_by_seq && a.message === b.message;
}
