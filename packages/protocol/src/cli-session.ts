// Which session an agent's own Weft command (`.weft/bin/weft negotiate | claim | inbox`) acts in.
//
// Adapters keep one state file per harness session under `<checkout>/.weft/state/` plus a
// `current` marker naming the most recently active one. Several agents can share a checkout (one
// adapter per harness, each with its own agent id and change), and they share that directory and
// marker: the newest session may be another agent's. Acting in it would attach a claim, a
// negotiation or an inbox ack to the other agent's change (#18). So the command uses the marker
// only when it is this agent's session, else this agent's newest session, and refuses when the
// checkout's sessions are known to be someone else's: the agent must then name the session.
// Pure (no fs): each adapter reads its state directory and calls this.

/** One state file as an adapter read it. `agent` is absent in files written before #18. */
export type CliSessionState = { session: string; agent?: string; mtimeMs: number };

/** `session: cliSessionId(agent)` = a session of this agent's own change that the command opens itself. */
export type CliSessionPick = { session: string } | { refused: string };

/** `--session new`: act in a new session of the agent's own change. */
export const NEW_CLI_SESSION = "new";
/**
 * The harness-session id (state file) for a session the command opens itself: one per agent, since
 * agents sharing a checkout share `.weft/state/` (a single `cli` state would be resumed by the next agent).
 */
export const cliSessionId = (agent: string): string => `cli-${agent}`;

export function pickCliSession(o: { agent: string; change: string; marker?: string; states: CliSessionState[]; explicit?: string }): CliSessionPick {
  const byId = new Map(o.states.map((s) => [s.session, s]));
  if (o.explicit !== undefined) {
    if (o.explicit === NEW_CLI_SESSION) return { session: cliSessionId(o.agent) };
    const st = byId.get(o.explicit);
    if (st?.agent !== undefined && st.agent !== o.agent) return { refused: `weft: session ${o.explicit} belongs to ${st.agent}, not ${o.agent}; nothing was sent.` };
    return { session: o.explicit };
  }
  const marker = o.marker ? byId.get(o.marker) ?? { session: o.marker, mtimeMs: 0 } : undefined;
  if (marker?.agent === o.agent) return { session: marker.session };
  const mine = o.states.filter((s) => s.agent === o.agent).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (mine.length) return { session: mine[0]!.session };
  const others = o.states.filter((s) => s.agent !== undefined && s.agent !== o.agent);
  // Untagged (pre-#18) state in a checkout nobody else is known to share: the old behaviour.
  if (!others.length) {
    if (marker) return { session: marker.session };
    const newest = [...o.states].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return { session: newest?.session ?? cliSessionId(o.agent) };
  }
  const latest = marker ?? [...o.states].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
  const whose = latest.agent !== undefined ? `is ${latest.agent}'s` : "is not known to be yours";
  return {
    refused:
      `weft: the latest Weft session in this checkout (${latest.session}) ${whose}, not ${o.agent}'s, and this checkout has no session of yours; nothing was sent. ` +
      `Pass --session <id> to act in one of your sessions, or --session ${NEW_CLI_SESSION} to open a new session of your change ${o.change}.`,
  };
}

/** Remove `--session <id>` from command arguments (the subcommand parsers do not know it). */
export function takeSessionFlag(args: string[]): { explicit?: string; rest: string[]; error?: string } {
  const i = args.indexOf("--session");
  if (i < 0) return { rest: args };
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--") || !v.trim()) return { rest: args, error: "--session needs a session id (or `new`)" };
  return { explicit: v, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}
