// A signature change / deletion of a symbol that another change already uses (spec §6.3 step 6).
// The use came first, so R2 never saw it; the coordinator opens this error on the user's change
// instead, which closes its gates exactly as a rejected stale_assumption would in the reverse order.
import type { Diagnostic, EventRecord, SymbolKey, WriteKind } from "./types";
import { fileOf } from "./summary";

/**
 * Open-error origins whose code never reached the workspace: a denied check, or a wound (spec §6.5).
 * Informational only — no origin is releasable (#17) — but a later one of these never replaces a
 * `commit`/`contract` origin on the same key, so the entry keeps saying the code is in the workspace.
 */
export const NOT_IN_WORKSPACE: readonly string[] = ["check", "push"];

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

/**
 * Suggestion of the `contract_changed` warning on a reads amendment (spec §6.2 R2a): `who` changed
 * the signature of (or removed) `key` in #`seq` after the amending change's base. Under
 * `conflicts: continue` it says to keep editing other tasks instead of adapting (spec §8.4); the
 * `hold` text is unchanged.
 */
export function amendmentSuggestion(key: SymbolKey, seq: number, who: string, continueMode: boolean): string {
  return continueMode
    ? `Keep editing your other tasks instead of adapting your call sites to ${who}'s new ${key} (event #${seq}); do not adopt their partial work. ${who} owns the change; negotiate with ${who} if you need the old contract.`
    : `Re-read ${key} (event #${seq}) and adapt your call sites, or negotiate with ${who}.`;
}

/**
 * Suggestion of the `contract_changed` warning pushed to a live change that uses `key` after `who`
 * changed its signature or removed it (spec §6.3). Under `conflicts: continue` it says to keep
 * editing other tasks instead of adapting (spec §8.4). It does not claim the owner is told: only
 * open errors notify the owner, and this is a warning. The `hold` text is unchanged.
 */
export function signatureChangeSuggestion(key: SymbolKey, who: string, continueMode: boolean): string {
  return continueMode
    ? `Keep editing your other tasks instead of adapting your call sites to ${who}'s change; do not adopt their partial work. ${who} owns the change; negotiate with ${who} if you need the old contract.`
    : `Re-read ${key} and adapt your call sites before your next edit, or negotiate (e.g. keep the old signature as an overload).`;
}
