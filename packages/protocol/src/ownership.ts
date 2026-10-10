// A conflict another agent's change caused does not hold the agent that hit it: that agent may
// stop and finish its other work with the conflict open. The owner of the change is told, as an
// informational diagnostic, and the owner is never blocked by it. Commits stay gated on every open
// error (the commit gate is unchanged), so a conflicting symbol cannot land while it is open.
import type { Diagnostic } from "./types";

/**
 * `hold` (default, today's behaviour): a conflict on the agent's own symbols holds its stop, and the
 * owner is not told. `continue` (per-repo opt-in: `conflicts: "continue"` in the repo's config): another agent's
 * conflict does not hold the stop, the owner is told, and the wording says to keep working.
 */
export type ConflictMode = "hold" | "continue";

/** True when this open error was caused by a change of another agent (not the agent's own). */
export function ownedElsewhere(d: Diagnostic, agent: string): boolean {
  return d.severity === "error" && d.code !== "agent_paused" && d.caused_by_agent !== undefined && d.caused_by_agent !== agent;
}

/** What the owner of the causing change sees: a warning, so it never blocks the owner. */
export function ownerNotice(d: Diagnostic, editor: string): Diagnostic {
  // Built field by field: the editor's diagnostic (and its suggestion, which is written for the editor)
  // is not copied to the owner.
  return {
    severity: "warning",
    code: d.code,
    file: d.file,
    symbol: d.symbol,
    message: `${editor}'s edit to ${d.symbol} conflicts with your change #${d.caused_by_seq}.`,
    suggestion: `${editor} keeps working on its other tasks and does not adopt your change. Negotiate with ${editor} if the contract needs to change; otherwise no action is needed.`,
    caused_by_seq: d.caused_by_seq,
    caused_by_agent: editor,
  };
}
