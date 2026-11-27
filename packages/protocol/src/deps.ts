// Recorded dependencies on unlanded changes (spec §6.7, issues #5–#7). Both coordinators share
// this module: the rule for when an accepted edit relies on a neighbor's change, how one change's
// records merge into one entry per neighbor, the cycle test that keeps mutually dependent changes
// from holding each other's landing, the notice sent when a dependency is abandoned, and the
// text `weft deps --pr` prints. Everything here is computed from the log; nothing calls out.

import type { Dependencies, Dependency, DependencyRef, DependencyState, EventRecord, Seq, SymbolKey, WriteKind } from "./types";

/**
 * Does an edit rely on a neighbor change whose net write to a key is `theirs`? `read`: the edit
 * reads the key; `mine`: the edit's own write kind on it (undefined when it does not write it).
 *
 * - The edit writes the key: only when the declaration exists solely in the neighbor's change
 *   (`new`) and the edit does not introduce it too. Writing a symbol both changes changed is a
 *   conflict (claims arbitrate it), not reliance.
 * - The edit only reads the key: when the neighbor added it or changed its signature. Code that
 *   calls a body-only change works without it, and nobody relies on a deletion.
 */
export function reliesOn(theirs: WriteKind, read: boolean, mine?: WriteKind): boolean {
  if (mine !== undefined) return theirs === "new" && mine !== "new";
  return read && (theirs === "new" || theirs === "signature");
}

/**
 * Collect an edit's dependency entries, one per neighbor change, in the order their first key
 * appears (the edit's reads, then its writes). `neighbors(key)` yields the candidate changes
 * (in creation order) with their net write kind on the key and the seq of their latest accepted
 * edit writing it; the caller has already left out the submitter's change, its merged group, its
 * alternatives, landed and abandoned changes.
 */
export function collectDependsOn(
  reads: SymbolKey[],
  writes: Array<{ key: SymbolKey; kind: WriteKind }>,
  neighbors: (key: SymbolKey) => Array<{ change: string; agent: string; task?: string; kind: WriteKind; seq: Seq }>,
): DependencyRef[] {
  const read = new Set(reads);
  const mine = new Map<SymbolKey, WriteKind>();
  for (const w of writes) if (!mine.has(w.key)) mine.set(w.key, w.kind);
  const out = new Map<string, DependencyRef>();
  for (const key of new Set([...reads, ...mine.keys()])) {
    for (const n of neighbors(key)) {
      if (!reliesOn(n.kind, read.has(key), mine.get(key))) continue;
      const e = out.get(n.change);
      if (e) {
        e.keys.push(key);
        e.seq = Math.max(e.seq, n.seq);
      } else out.set(n.change, { change: n.change, agent: n.agent, ...(n.task ? { task: n.task } : {}), seq: n.seq, keys: [key] });
    }
  }
  return [...out.values()];
}

/** Merge the `depends_on` of one change's records (ascending seq): one entry per neighbor, keys in first-recorded order. */
export function mergeDependencies(records: Array<Pick<EventRecord, "depends_on">>): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  for (const r of records)
    for (const d of r.depends_on ?? []) {
      const e = out.get(d.change);
      if (!e) {
        out.set(d.change, { ...d, keys: [...d.keys] });
        continue;
      }
      for (const k of d.keys) if (!e.keys.includes(k)) e.keys.push(k);
      e.seq = Math.max(e.seq, d.seq);
    }
  return [...out.values()];
}

/** A system `release` with reason `abandoned` and no `keys` marks its change abandoned (spec §6.7). */
export function isAbandonment(r: Pick<EventRecord, "kind" | "status" | "actor" | "payload">): boolean {
  return r.kind === "release" && r.status === "accepted" && r.actor.type === "system" && r.payload?.reason === "abandoned" && r.payload?.keys === undefined;
}

/** What a coordinator tells `dependenciesOf` about its state. */
export type DependencyLookup = {
  repo: string;
  change: { id: string; agent: string; task?: string; landed: boolean };
  /** The accepted `edit` records of a change that carry `depends_on`, ascending seq. */
  records(change: string): Array<Pick<EventRecord, "depends_on">>;
  /** Whether a change landed or was abandoned, and the record that did it. */
  state(change: string): { status: DependencyState; status_seq?: Seq };
  sameGroup(a: string, b: string): boolean;
};

/**
 * A change's dependencies and whether they hold its landing (spec §6.7). A dependency holds while
 * it is pending (neither landed nor abandoned), unless it is mutual: it relies on the dependent too
 * (directly, or through other pending dependencies), or the two changes are in one merged group.
 * Holding a cycle would keep every member queued forever; its members land in queue order (a
 * batch lands them together), and presubmit decides whether the result builds.
 */
export function dependenciesOf(l: DependencyLookup): Dependencies {
  const c = l.change;
  const pending = (x: string) =>
    mergeDependencies(l.records(x))
      .filter((d) => !l.sameGroup(d.change, x) && l.state(d.change).status === "pending")
      .map((d) => d.change);
  const reaches = (from: string, target: string) => {
    const seen = new Set([from]);
    const todo = [from];
    while (todo.length) {
      const x = todo.pop()!;
      if (x === target) return true;
      for (const y of pending(x))
        if (!seen.has(y)) {
          seen.add(y);
          todo.push(y);
        }
    }
    return false;
  };
  const depends_on: Dependency[] = mergeDependencies(l.records(c.id)).map((d) => {
    const st = l.state(d.change);
    const mutual = st.status === "pending" && (l.sameGroup(d.change, c.id) || reaches(d.change, c.id));
    return {
      ...d,
      status: st.status,
      ...(st.status_seq !== undefined ? { status_seq: st.status_seq } : {}),
      holds: st.status === "pending" && !mutual && !c.landed,
      ...(mutual ? { mutual: true } : {}),
    };
  });
  const held_by = depends_on.filter((d) => d.holds).map((d) => d.change);
  return {
    type: "dependencies",
    repo: l.repo,
    change: c.id,
    agent: c.agent,
    ...(c.task ? { task: c.task } : {}),
    landed: c.landed,
    held: held_by.length > 0,
    held_by,
    depends_on,
  };
}

const who = (d: { change: string; agent: string; task?: string }) => `${d.change} (${d.agent}${d.task ? `, task ${d.task}` : ""})`;

/**
 * The text of the system `message` a dependent's owner gets when a change it relies on is abandoned
 * (spec §6.7). `cause` is the record that abandoned it: a system release, or the landing of one of
 * its alternatives (it lost the selection, §7.7).
 */
export function abandonedNotice(
  dep: { change: string; agent: string; task?: string },
  dependent: string,
  keys: SymbolKey[],
  cause: Pick<EventRecord, "seq" | "kind" | "change">,
): string {
  const why = cause.kind === "land" ? `${cause.change ?? "another candidate"} landed instead (#${cause.seq})` : `abandoned in #${cause.seq}`;
  return (
    `${who(dep)} will not land: ${why}. Your change ${dependent} relies on it for ${keys.join(", ")}. ` +
    `Its landing no longer waits for ${dep.change}; those symbols will not reach main through it.`
  );
}

/**
 * `weft deps` text, from the record only (no GitHub access). With `pr`, the lines an agent pastes
 * into its pull request description: one per dependency not in main yet, e.g.
 * `Relies on claude-a/T-1 (claude-a, task T-1), not yet in main: src/auth/session.ts#createSession`.
 * Landed dependencies are in main already and are left out; abandoned ones are named, since what
 * the change relies on will not arrive.
 */
export function dependencyText(d: Dependencies, opts: { pr?: boolean } = {}): string {
  const keys = (x: Dependency) => x.keys.join(", ");
  if (opts.pr) {
    const lines = d.depends_on.flatMap((x) =>
      x.status === "pending"
        ? [`Relies on ${who(x)}, not yet in main: ${keys(x)}`]
        : x.status === "abandoned"
          ? [`Relied on ${who(x)}, which was abandoned and will not land: ${keys(x)}`]
          : [],
    );
    return lines.length ? lines.join("\n") : `No recorded dependencies on changes that are not in main yet.`;
  }
  const self = who({ change: d.change, agent: d.agent, ...(d.task ? { task: d.task } : {}) });
  const head = `${self}: ${d.landed ? "landed" : d.held ? `landing held until ${d.held_by.join(", ")} land${d.held_by.length === 1 ? "s" : ""}` : "landing not held"}`;
  if (!d.depends_on.length) return `${head}\n  no recorded dependencies on other changes.`;
  const rows = d.depends_on.map((x) => {
    const state =
      x.status === "landed"
        ? `landed (#${x.status_seq})`
        : x.status === "abandoned"
          ? `abandoned (#${x.status_seq})`
          : x.mutual
            ? "not landed; relies on this change too, so it does not hold it"
            : x.holds
              ? "not landed; holds the landing"
              : "not landed";
    return `  ${who(x)} — ${state}: ${keys(x)} (recorded at #${x.seq})`;
  });
  return [head, ...rows].join("\n");
}
