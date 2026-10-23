// A signature change / deletion of a symbol that another change already uses (spec §6.3 step 6).
// The use came first, so R2 never saw it; the coordinator opens this error on the user's change
// instead, which closes its gates exactly as a rejected stale_assumption would in the reverse order.
import type { Diagnostic, EventRecord, SymbolKey, WriteKind } from "./types";
import { fileOf } from "./summary";

/** Open-error origins a change's own `release` may clear (spec §6.5 rule 4). */
export const RELEASABLE: readonly string[] = ["check", "push"];

/** The `stale_assumption` pushed to (and opened on) a change whose code uses `w.key`. */
export function contractError(rec: EventRecord, w: { key: SymbolKey; kind: WriteKind }, continueMode: boolean): Diagnostic {
  const who = rec.agent ?? rec.actor.id;
  return {
    severity: "error",
    code: "stale_assumption",
    file: fileOf(w.key),
    symbol: w.key,
    message: `${who} ${w.kind === "deleted" ? "removed" : "changed the signature of"} ${w.key} (#${rec.seq}) after your change started using it; your call sites may no longer match.`,
    suggestion: continueMode
      ? `Keep editing your other tasks, but the commit gate stays closed while this error is open: report it instead of working around it. Do not adapt your call sites to ${who}'s new ${w.key} (event #${rec.seq}) or adopt their partial work: ${who} owns the conflict.`
      : `Read the new ${w.key} (event #${rec.seq}) and update your call sites; the commit gate stays closed until an edit of yours that uses ${w.key} is accepted. Or negotiate with ${who} (e.g. keep the old signature as an overload).`,
    caused_by_seq: rec.seq,
    caused_by_agent: who,
    ...(rec.task ? { caused_by_task: rec.task } : {}),
  };
}
