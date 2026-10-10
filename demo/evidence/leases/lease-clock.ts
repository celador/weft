// Fake-clock demo of claim leases, the firm-claim limit and the #17 audit, run against the
// SqlCoordinator the gateway's Durable Object uses (journaled, as in production). The same
// file is bundled once against `main` (before) and once against this branch (after):
//
//   node scripts/build.mjs <tree> <out.mjs>      (see demo/evidence/leases/README.md)
//   node <out.mjs> soft|firm|audit
//
// Only the clock is fake: every verdict, release and gate result comes from the coordinator.
import { SqlCoordinator } from "@weft/sequencer/coordinator";
import { JournaledCoordinator } from "@weft/sequencer/journal";
import { nodeSql } from "@weft/sequencer/node-sqlite";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const X = "src/auth/session.ts#refreshToken";
const Y = "src/api/client.ts#fetchWithAuth";
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" };
const hello = (agent: string, harness: string, task: string, change: string) => ({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness }, capabilities: caps, task: { id: task }, change });
const edit = (base: number, key: string, mode = "commit", reads: string[] = [], kind = "body") => ({
  type: "submit",
  mode,
  event: { kind: "edit", base_seq: base, writes: [{ key, kind }], reads },
});

function world() {
  let t = T0;
  const sql = nodeSql();
  SqlCoordinator.init(sql, { repo: "demo" });
  const j = new JournaledCoordinator(sql, () => t);
  const call = <T = Any>(op: string, ...args: unknown[]): T => {
    try {
      return j.call(op as Any, ...args) as T;
    } catch (e) {
      return { error: (e as Error).message } as T;
    }
  };
  return { j, call, now: () => t, set: (ms: number) => void (t = T0 + ms), welcomeOf: (w: Any) => w };
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const say = (ms: number, text: string) => console.log(`[${clock(ms)}] ${text}`);

function soft(): void {
  const w = world();
  const a = w.call("hello", hello("claude-a", "claude-code", "T-1", "I-a"));
  const b = w.call("hello", hello("codex-b", "codex", "T-2", "I-b"));
  console.log(`repo policy: claim_ttl_ms=${a.claim_ttl_ms} claims=${JSON.stringify(a.policy.claims ?? "(none: one 30-min renewable TTL)")}`);
  const v = w.call("submit", a.session, edit(1, X));
  say(0, `claude-a edits refreshToken -> #${v.seq} ${v.verdict} (soft claim)`);
  say(0, "claude-a's process is killed: no more heartbeats, no bye");
  let base = b.delivered_through;
  let prev = "";
  for (let min = 0; min <= 40; min++) {
    w.set(min * 60_000 + 1);
    const ticked = w.call<Any[]>("tick");
    for (const r of ticked) say(min * 60_000, `coordinator #${r.seq}: ${r.summary}`);
    w.call("heartbeat", b.session);
    const c = w.call("submit", b.session, edit(base, X, "check"));
    base = c.delivered_through ?? base;
    const blocked = (c.diagnostics ?? []).find((d: Any) => d.code.startsWith("claim_"));
    const state = blocked ? `codex-b wants refreshToken: ${blocked.code} (${blocked.severity}), claimed by ${blocked.caused_by_agent} — told to wait` : "codex-b wants refreshToken: free, no claim in the way";
    if (state !== prev || min <= 2 || min % 5 === 0) say(min * 60_000, state);
    if (!blocked) {
      console.log(`\n=> a dead agent's soft claim blocked others for ${min} min`);
      return;
    }
    prev = state;
  }
  console.log("\n=> still blocked after 40 min");
}

function firm(): void {
  const w = world();
  const a = w.call("hello", hello("claude-a", "claude-code", "T-1", "I-a"));
  const b = w.call("hello", hello("codex-b", "codex", "T-2", "I-b"));
  console.log(`repo policy: claim_ttl_ms=${a.claim_ttl_ms} claims=${JSON.stringify(a.policy.claims ?? "(none: one 30-min renewable TTL)")}`);
  const c = w.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "claim", base_seq: 1, writes: [{ key: X, kind: "signature" }], payload: { firm: true, source: "explicit", ttl_ms: 3_600_000 } } });
  say(0, `claude-a firmly claims refreshToken for 1 h -> #${c.seq}: ${c.summary}`);
  say(0, "claude-a stays alive: heartbeat every 30 s, and edits refreshToken itself at +04:00");
  let base = b.delivered_through;
  let aBase = c.delivered_through;
  let prev = "";
  for (let half = 1; half <= 80; half++) {
    const ms = half * 30_000;
    w.set(ms);
    for (const r of w.call<Any[]>("tick")) say(ms, `coordinator #${r.seq}: ${r.summary}`);
    w.call("heartbeat", a.session);
    w.call("heartbeat", b.session);
    if (ms === 240_000) {
      const e = w.call("submit", a.session, edit(aBase, X));
      aBase = e.delivered_through;
      say(ms, `claude-a edits refreshToken -> #${e.seq} ${e.verdict}`);
    }
    if (half % 2) continue; // codex-b retries once a minute
    const v = w.call("submit", b.session, edit(base, X, "check"));
    base = v.delivered_through ?? base;
    const err = (v.diagnostics ?? []).find((d: Any) => d.severity === "error");
    const state = err ? `codex-b edit of refreshToken: REJECTED (${err.code}, firm claim of ${err.caused_by_agent})` : "codex-b edit of refreshToken: accepted";
    if (state !== prev || (ms / 60_000) % 5 === 0) say(ms, state);
    prev = state;
    if (!err) {
      console.log(`\n=> the firm claim ended at ${clock(ms)} although claude-a kept heartbeating`);
      return;
    }
  }
  console.log("\n=> still firmly held after 40 min: heartbeats keep renewing it");
}

function audit(): void {
  type W = ReturnType<typeof world>;
  const setup = (mode: "check" | "commit" = "commit") => {
    const w = world();
    const a = w.call("hello", hello("claude-a", "claude-code", "T-1", "I-a"));
    const b = w.call("hello", hello("codex-b", "codex", "T-2", "I-b"));
    w.call("submit", b.session, edit(2, Y, "commit", [X]));
    w.call("submit", a.session, edit(1, X, "commit", [], "signature"));
    const r = w.call("submit", b.session, edit(3, Y, mode, [X]));
    return { w, b: b.session as string, rejected: r };
  };
  const gate = (w: W, s: string) => {
    const g = w.call("gate", s, { type: "gate", gate: "stop" });
    return g.error ? `error: ${g.error}` : g.allow ? "allow=true " : `allow=false (${g.open_errors.map((d: Any) => d.code).join(",")})`;
  };
  const first = setup();
  console.log(`setup: codex-b's commit-mode edit is rejected: #${first.rejected.seq} ${first.rejected.diagnostics[0].code}; its stop gate: ${gate(first.w, first.b)}\n`);
  const vectors: Array<[string, (w: W, b: string) => string, boolean]> = [
    ["release (no keys)", (w, b) => (w.call("submit", b, { type: "submit", mode: "commit", event: { kind: "release", base_seq: 5, payload: {} } }), b), false],
    ["release of the key", (w, b) => (w.call("submit", b, { type: "submit", mode: "commit", event: { kind: "release", base_seq: 5, payload: { keys: [X] } } }), b), false],
    ["intent naming the key", (w, b) => (w.call("submit", b, { type: "submit", mode: "commit", event: { kind: "intent", base_seq: 5, reads: [X], intent: "hmm" } }), b), false],
    ["claim on the key", (w, b) => (w.call("submit", b, { type: "submit", mode: "commit", event: { kind: "claim", base_seq: 5, writes: [{ key: X, kind: "body" }], payload: { firm: false, source: "explicit" } } }), b), false],
    ["bye + new hello", (w, b) => (w.call("bye", b), w.call("hello", hello("codex-b", "codex", "T-2", "I-b")).session), false],
    ["session expiry + new hello", (w) => (w.set(10 * 60_000), w.call("tick"), w.call("hello", hello("codex-b", "codex", "T-2", "I-b")).session), false],
    ["(intended) redo the edit on the current log", (w, b) => (w.call("submit", b, edit(5, Y, "commit", [X])), b), true],
  ];
  for (const [name, act, clears] of vectors) {
    const { w, b } = setup();
    const s = act(w, b);
    const g = gate(w, s);
    const opened = g.startsWith("allow=true");
    const verdict = clears ? (opened ? "ok: resolved" : "?? still closed") : opened ? "BYPASS: the open error is gone" : "kept: the open error persists";
    console.log(`${name.padEnd(46)} stop gate ${g.padEnd(34)} ${verdict}`);
  }
  const chk = setup("check");
  chk.w.call("submit", chk.b, { type: "submit", mode: "commit", event: { kind: "release", base_seq: 5, payload: { keys: [X] } } });
  console.log(`${"(retreat) release after a check-mode denial".padEnd(46)} stop gate ${gate(chk.w, chk.b).padEnd(34)} the edit never reached the workspace`);
}

const which = process.argv[2];
if (which === "soft") soft();
else if (which === "firm") firm();
else if (which === "audit") audit();
else {
  console.error("usage: node lease-clock.mjs soft|firm|audit");
  process.exitCode = 2;
}
