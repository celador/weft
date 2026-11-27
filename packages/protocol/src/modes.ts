// Per-repo modes (`conflicts`, `enforcement`): one default and one parser for every entry point
// (both coordinators, the gateway's admin API, local demo coordinators reading an env var), so a
// value means the same thing everywhere and the default literal lives here only (#18).
//
// Both modes are part of the repo's stored configuration, recorded at init, so a journal replays
// under the mode it was written with (spec §5.1).
import type { ConflictMode } from "./ownership";
import type { EnforcementMode, SymbolKey } from "./types";

/** `conflicts` of a repo whose config has no such field (spec §8.4): today's behaviour. */
export const DEFAULT_CONFLICT_MODE: ConflictMode = "hold";
/** `enforcement` of a repo whose config has no such field (spec §7.2). */
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = "advise";

export const CONFLICT_MODES: readonly ConflictMode[] = ["hold", "continue"];
export const ENFORCEMENT_MODES: readonly EnforcementMode[] = ["advise", "block"];

export type ModeParse<M> = { ok: true; mode: M | undefined } | { ok: false; error: string };

function parse<M extends string>(name: string, allowed: readonly M[], v: unknown): ModeParse<M> {
  if (v === undefined || v === null) return { ok: true, mode: undefined };
  // Exact, case-sensitive: "" or "Continue" is a mistake to report, not the default.
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return { ok: true, mode: v as M };
  return { ok: false, error: `${name} must be ${allowed.join(" or ")}` };
}

/** Parse a `conflicts` value from any source. Absent (`undefined`/`null`) → `mode: undefined` (the default applies). */
export function parseConflictMode(v: unknown): ModeParse<ConflictMode> {
  return parse("conflicts", CONFLICT_MODES, v);
}

/** Parse an `enforcement` value from any source. Absent (`undefined`/`null`) → `mode: undefined` (the default applies). */
export function parseEnforcementMode(v: unknown): ModeParse<EnforcementMode> {
  return parse("enforcement", ENFORCEMENT_MODES, v);
}

/** The effective mode of a stored config field. */
export const conflictModeOf = (v: ConflictMode | undefined): ConflictMode => v ?? DEFAULT_CONFLICT_MODE;
export const enforcementModeOf = (v: EnforcementMode | undefined): EnforcementMode => v ?? DEFAULT_ENFORCEMENT_MODE;

/**
 * A mode from an environment variable (local demo coordinators): unset or empty means the default;
 * anything else must be a valid mode, so a typo fails loudly instead of silently running `hold`/`advise`.
 */
export function conflictModeFromEnv(raw: string | undefined, name = "WEFT_CONFLICTS"): ConflictMode {
  const p = parseConflictMode(raw === "" ? undefined : raw);
  if (!p.ok) throw new Error(`${name}: ${p.error}`);
  return conflictModeOf(p.mode);
}

export function enforcementModeFromEnv(raw: string | undefined, name = "WEFT_ENFORCEMENT"): EnforcementMode {
  const p = parseEnforcementMode(raw === "" ? undefined : raw);
  if (!p.ok) throw new Error(`${name}: ${p.error}`);
  return enforcementModeOf(p.mode);
}

/**
 * The `claim_wait` suggestion (spec §7.2), shared by both coordinators. Under `hold` the requester
 * may wait for the holder; under `continue` it is told to keep working elsewhere, never to wait.
 */
export function claimWaitSuggestion(key: SymbolKey, holder: string, mode: ConflictMode): string {
  return mode === "continue"
    ? `Leave ${key} to ${holder} and keep working on your other tasks; negotiate (negotiate.propose to ${holder}) if your task needs ${key}.`
    : `Wait for ${holder} to land or release ${key}, work elsewhere, or negotiate (negotiate.propose to ${holder}).`;
}

/**
 * Diagnostics that a rejected record does not leave open on the change (spec §6.5): a
 * `claim_wait` is a wait for the holder, not a conflict in the requester's code, so it never
 * holds the requester's stop or commit gate (#18). `agent_paused` is a human pause.
 */
export const NOT_OPENED: ReadonlySet<string> = new Set(["agent_paused", "claim_wait"]);

/** Owner notices are sent once per (owner change, editor, symbol, causing record) (spec §8.4, #18). */
export function noticeKey(editor: string, symbol: SymbolKey, causeSeq: number): string {
  return `${editor}\u0000${symbol}\u0000${causeSeq}`;
}
