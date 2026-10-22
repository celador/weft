// Which squiggles are still open: what an editor should keep underlined right now.
//
// WCP §6.5 keeps "open errors" per change on the coordinator. An observer only has the log,
// so this replays the clearing rules over it: a diagnostic on a change's record stays open
// until a later accepted record of the same change clears it:
//
//   1. an accepted `edit` that reads or writes the diagnostic's symbol key (the agent redid
//      the work against the current log);
//   2. an accepted `land` of the change;
//   3. an accepted agent `release` of the key (or of everything) when the diagnostic came from
//      a denied pre-edit check or a `claim_wounded` push (never for a `mode:"commit"` record:
//      that edit exists in the workspace);
//   4. a `revert` of the change's land does not reopen anything (a new change redoes it).
//
// Warnings and infos on accepted records follow the same rules: they say "this area moved
// under you" until the change touches the area again or lands. `agent_paused` is not a
// conflict (the human paused the agent) and is never shown as a squiggle.

import { type Squiggle, squiggleOf } from "./actions";
import type { FeedLog } from "./log";
import type { FeedEvent } from "./types";

export type OpenOptions = {
  /** Only these repos. */
  repos?: string[];
  /** Ignore diagnostics older than this many ms (default: no limit). */
  maxAgeMs?: number;
  now?: number;
};

const NOT_A_CONFLICT = new Set(["agent_paused"]);

function releasedKeys(e: FeedEvent): string[] | "all" | undefined {
  if (e.kind !== "release" || e.status !== "accepted" || e.actor.type !== "agent") return undefined;
  const keys = (e.payload as { keys?: unknown } | undefined)?.keys;
  return Array.isArray(keys) && keys.length ? (keys.filter((k) => typeof k === "string") as string[]) : "all";
}

/** The squiggles still open in the log (newest first), each linked to its cause. */
export function openSquiggles(source: FeedLog | FeedEvent[], o: OpenOptions = {}): Squiggle[] {
  const events = (Array.isArray(source) ? source : source.combined).filter((e) => !o.repos || o.repos.includes(e.repo));
  // Per repo + change, ascending seq.
  const byChange = new Map<string, FeedEvent[]>();
  for (const e of events) {
    if (!e.change) continue;
    const k = `${e.repo}\u0000${e.change}`;
    let list = byChange.get(k);
    if (!list) byChange.set(k, (list = []));
    list.push(e);
  }
  const now = o.now ?? Date.now();
  const out: Squiggle[] = [];
  for (const list of byChange.values()) {
    list.sort((a, b) => a.seq - b.seq);
    list.forEach((e, idx) => {
      e.diagnostics.forEach((d, i) => {
        if (NOT_A_CONFLICT.has(d.code)) return;
        const q = squiggleOf(e, d, i);
        if (o.maxAgeMs !== undefined && now - q.date > o.maxAgeMs) return;
        const origin = e.status === "rejected" ? (e.mode === "check" ? "check" : "commit") : d.code === "claim_wounded" ? "push" : "advice";
        for (const later of list.slice(idx + 1)) {
          if (later.status !== "accepted") continue;
          if (later.kind === "land") return;
          if (later.kind === "edit" && (later.reads.includes(d.symbol) || later.writes.some((w) => w.key === d.symbol))) return;
          const rel = releasedKeys(later);
          if (rel && (origin === "check" || origin === "push" || origin === "advice") && (rel === "all" || rel.includes(d.symbol))) return;
        }
        out.push(q);
      });
    });
  }
  return out.sort((a, b) => b.date - a.date || (a.repo === b.repo ? b.seq - a.seq : a.repo < b.repo ? 1 : -1));
}
