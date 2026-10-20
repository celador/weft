#!/usr/bin/env node
// One card's lane in the Otto demo. The Hermes worker the dispatcher spawned for a card on board
// `weft-demo-site` runs this for its own card only; no lane knows about the other cards.
//
//   node demo/otto/lane.mjs start --run N --task t4 --card t_abc123     # detaches `run`, returns
//   node demo/otto/lane.mjs wait  --run N --task t4 [--timeout 540]      # progress; last line FINAL {...} or PENDING
//   node demo/otto/lane.mjs run   --run N --task t4 --card t_abc123     # (what `start` detaches)
//
// run: candidates for the card (Weft forks, one per harness), each harness in its own clone of its
// fork with its Weft adapter, the card's turns, commit + push, ProcessRevision evidence, BestOfN,
// the human's approval (Otto's Approve button; scripted fallback after --approve-wait s, flagged),
// LandChange. The planted-bug card (t8) instead lands a scripted change that throws in
// production and waits for the auto-revert.
//
// Cues between cards come only from the shared Weft log (a peer reads the log, nobody tells it):
// the plan-first cards (t2, t3) implement once an accepted signature change to
// src/auth/session.ts#createSession is in the log; the t1 lane resumes an idle agent when a
// negotiation proposal for it arrives.
//
// Output: demo/evidence/otto/run-N/lanes/<task>/{state.json,lane.log,agents/*}. Tokens never printed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANTED, REPO, TASKS } from "./scenario.mjs";
import { Agent, DEMO_URL, ROOT, TOK, api, cf, events, git, headSeq, prepare, queueId, releaseAll, replayPush, scrub, sleep, summarize, wf } from "./lib.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const RUN = Number(opt("run", "1"));
const KEY = opt("task");
const CARD = opt("card");
const APPROVE_WAIT_S = Number(opt("approve-wait", process.env.WEFT_OTTO_APPROVE_WAIT_S ?? "1200"));
const CUE_WAIT_S = Number(opt("cue-wait", "1200"));
const T = KEY === PLANTED.key ? PLANTED : TASKS[KEY];
if (!T) throw new Error(`unknown task ${KEY}`);
T.key = KEY;
const OUT = join(ROOT, "demo/evidence/otto", `run-${RUN}`, "lanes", KEY);
mkdirSync(OUT, { recursive: true });
const STATE = join(OUT, "state.json");

const T0 = Date.now();
const secs = () => +((Date.now() - T0) / 1000).toFixed(1);
const state = existsSync(STATE) && cmd !== "run" ? JSON.parse(readFileSync(STATE, "utf8")) : { run: RUN, task: KEY, card: CARD, title: T.title, harnesses: T.harnesses, beat: T.beat, started_at: new Date().toISOString(), phase: "starting", marks: {}, steps: [] };
const save = () => writeFileSync(STATE, scrub(JSON.stringify(state, null, 2)) + "\n");
const log = (...a) => console.log(`[lane ${KEY} run-${RUN} +${secs()}s]`, ...a.map((x) => scrub(typeof x === "string" ? x : JSON.stringify(x))));
const phase = (p, data) => {
  state.phase = p;
  state.marks[p] ??= secs();
  state.steps.push({ name: p, at_s: secs(), at: new Date().toISOString(), ...(data ? { data } : {}) });
  log(p, data ?? "");
  save();
};
const SUBS = [];

// ------------------------------------------------------------------------------ start / wait

if (cmd === "start") {
  if (!CARD) throw new Error("--card required");
  if (existsSync(STATE) && JSON.parse(readFileSync(STATE, "utf8")).pid) {
    console.log(`lane ${KEY} already started (see ${STATE})`);
    process.exit(0);
  }
  const fd = openSync(join(OUT, "lane.log"), "a");
  const child = spawn(process.execPath, [process.argv[1], "run", ...argv.slice(1)], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  writeFileSync(STATE, JSON.stringify({ ...state, pid: child.pid, phase: "starting" }, null, 2) + "\n");
  console.log(`lane ${KEY} started (pid ${child.pid}); progress: node demo/otto/lane.mjs wait --run ${RUN} --task ${KEY}`);
  process.exit(0);
}
if (cmd === "wait") {
  const until = Date.now() + Number(opt("timeout", "540")) * 1000;
  let last = "";
  for (;;) {
    const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
    const line = `${s.phase ?? "?"}${s.note ? ` — ${s.note}` : ""}`;
    if (line !== last) console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    last = line;
    if (s.final) {
      console.log(`FINAL ${JSON.stringify(s.final)}`);
      process.exit(0);
    }
    let alive = true;
    try {
      process.kill(s.pid, 0);
    } catch {
      alive = false;
    }
    if (s.pid && !alive && !s.final) {
      console.log(`FINAL ${JSON.stringify({ status: "lane_died", error: s.error ?? "lane process exited without a result; see lane.log" })}`);
      process.exit(0);
    }
    if (Date.now() > until) {
      console.log("PENDING (run wait again)");
      process.exit(0);
    }
    await sleep(5000);
  }
}
if (cmd !== "run") throw new Error("usage: lane.mjs start|wait|run --run N --task tK [--card ID]");

// ------------------------------------------------------------------------------ run

async function createCandidates(work) {
  const queue = await queueId();
  const names = T.harnesses.map((h) => `${h}-${KEY}-r${RUN}`);
  const created = await api("POST", `/v1/repos/${REPO}/tasks/${CARD}/candidates`, TOK.sys, { count: names.length, agents: names, title: T.title, acceptance: T.acceptance, ttl: 7200 }, 201);
  const agents = [];
  for (const [i, c] of created.candidates.entries()) {
    if (c.subscription.status !== "active") {
      const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: queue }, events: ["pushed"] });
      await api("POST", "/v1/admin/artifacts/subscriptions", TOK.admin, { change: c.change, subscription_id: sub.id }, 200);
      SUBS.push(sub.id);
    }
    agents.push(new Agent({ task: T, card: CARD, harness: T.harnesses[i], cand: c, work, ev: OUT, run: RUN }));
  }
  return agents;
}

const isSigEdit = (e) => e.kind === "edit" && e.status === "accepted" && (e.writes ?? []).some((w) => w.key === "src/auth/session.ts#createSession" && w.kind === "signature");

async function waitCue(head0, mine) {
  const t = Date.now();
  for (;;) {
    const ev = await events(head0).catch(() => []);
    const hit = ev.find((e) => isSigEdit(e) && !mine.has(e.agent));
    if (hit) return { seq: hit.seq, agent: hit.agent, waited_s: Math.round((Date.now() - t) / 1000) };
    if (Date.now() - t > CUE_WAIT_S * 1000) return { seq: null, timeout: true, waited_s: Math.round((Date.now() - t) / 1000) };
    await sleep(3000);
  }
}

async function waitEvidence(pushed) {
  const evidence = {};
  await Promise.all(
    pushed.map(async (a) => {
      const t = Date.now();
      for (;;) {
        const ch = await api("GET", `/v1/repos/${REPO}/changes/${a.cand.change}`, TOK.sys, undefined, 200);
        const rev = ch.revisions.find((r) => r.sha === a.push.sha);
        if (!rev && !a.replayed && Date.now() - (a.push.at_ms ?? 0) > 90_000) (state.push_events_replayed ??= []).push(await replayPush(a));
        const rows = ch.evidence.filter((e) => e.sha === a.push.sha);
        const done = rows.some((e) => e.kind === "review") || (rev?.status === "processed" && rows.some((e) => e.kind === "test" && e.status === "fail"));
        if ((rev && ["conflict", "failed", "superseded"].includes(rev.status)) || done || Date.now() - t > 20 * 60_000) {
          evidence[a.id] = { revision: rev ? { status: rev.status, layer: rev.layer } : null, rows: rows.map((e) => ({ kind: e.kind, status: e.status, data: summarize(e) })), waited_s: Math.round((Date.now() - t) / 1000) };
          return;
        }
        await sleep(5000);
      }
    }),
  );
  return evidence;
}

/** Prefer, for t1, the candidate that accepted another card's overload request (both cards rely on it). */
async function acceptorChange(head0, agents) {
  const ev = await events(head0).catch(() => []);
  const mine = new Set(agents.map((a) => a.cand.change));
  const props = ev.filter((e) => e.kind === "negotiate.propose" && e.status === "accepted" && mine.has(e.payload?.to?.change ?? ""));
  for (const p of props) {
    const ans = ev.find((r) => r.kind === "negotiate.accept" && r.payload?.reply_to === p.seq);
    if (ans) return p.payload.to.change;
  }
  const byAgent = ev.filter((e) => e.kind === "negotiate.accept" && agents.some((a) => a.id === e.agent));
  return byAgent.length ? agents.find((a) => a.id === byAgent[0].agent).cand.change : undefined;
}

async function selectAndLand(head0, agents, pushed) {
  const sel = await api("POST", `/v1/repos/${REPO}/tasks/${CARD}/select`, TOK.sys, { n: pushed.length, risk: T.risk, poll_s: 10, approval_timeout_s: 7200 }, 202);
  state.selection = { workflow: sel.workflow, n: pushed.length, risk: T.risk };
  phase("selecting", { workflow: sel.workflow });
  const t0 = Date.now();
  let bon;
  let askedAt;
  for (;;) {
    bon = await wf("best-of-n", sel.workflow);
    if (["complete", "errored", "terminated"].includes(bon.status)) break;
    const ranks = [];
    for (const a of pushed) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${a.cand.change}`, TOK.sys, undefined, 200);
      const r = ch.evidence.filter((e) => e.kind === "rank").pop();
      if (r) ranks.push({ a, d: JSON.parse(r.data ?? "{}") });
    }
    if (ranks.length && !askedAt) {
      await sleep(10_000);
      bon = await wf("best-of-n", sel.workflow);
      if (["complete", "errored", "terminated"].includes(bon.status)) break;
      askedAt = Date.now();
      const eligible = ranks.filter((r) => r.d.eligible !== false).sort((x, y) => (y.d.score ?? 0) - (x.d.score ?? 0));
      const acceptor = KEY === "t1" ? await acceptorChange(head0, agents) : undefined;
      const suggest = eligible.find((r) => r.a.cand.change === acceptor) ?? eligible[0] ?? ranks[0];
      state.awaiting = { since: new Date().toISOString(), ranking: ranks.map((r) => ({ agent: r.a.id, harness: r.a.harness, change: r.a.cand.change, score: r.d.score, eligible: r.d.eligible })), suggest: { agent: suggest.a.id, change: suggest.a.cand.change, why: suggest.a.cand.change === acceptor ? "accepted the overload another card relies on" : "highest-ranked eligible" } };
      state.note = `waiting for your approval in Otto (Weft panel → ${suggest.a.id} → Approve); scripted fallback in ${APPROVE_WAIT_S}s`;
      phase("awaiting_approval", state.awaiting);
    }
    if (askedAt && !state.approved && Date.now() - askedAt > APPROVE_WAIT_S * 1000) {
      const s = state.awaiting.suggest;
      const res = await api("POST", `/v1/repos/${REPO}/actions`, TOK.human, { type: "action", action: "approve", change: s.change, note: `otto demo run ${RUN}: scripted fallback approval (no click within ${APPROVE_WAIT_S}s)` }, [200, 201]);
      state.approved = { by: "scripted fallback (John's human token, same action as Otto's Approve)", change: s.change, agent: s.agent, forwarded_to: res.workflow ?? null, at: new Date().toISOString() };
      phase("approved_by_fallback", state.approved);
    }
    if (Date.now() - t0 > 90 * 60_000) break;
    await sleep(4000);
  }
  const out = { status: bon.status, result: bon.output?.status ?? null, winner: bon.output?.winner ?? null, approved_by: bon.output?.approved_by ?? null, ranking: bon.output?.ranking?.map((r) => ({ agent: r.agent, score: r.score, eligible: r.eligible, layer: r.layer, reasons: r.reasons })) };
  out.winner_agent = agents.find((a) => a.cand.change === out.winner)?.id ?? null;
  if (out.approved_by && !state.approved) state.approved = { by: out.approved_by, via: "Otto / web Approve (human action not sent by this lane)" };
  state.note = undefined;
  phase("selected", out);
  if (bon.output?.land_instance) {
    let land;
    for (const t1 = Date.now(); ; ) {
      land = await wf("land", bon.output.land_instance);
      if (["complete", "errored", "terminated"].includes(land.status) || Date.now() - t1 > 30 * 60_000) break;
      await sleep(4000);
    }
    out.land = { workflow_status: land.status, ...(land.output ?? {}), ...(land.error ? { error: String(land.error?.message ?? land.error).slice(0, 300) } : {}) };
  }
  return out;
}

async function cardLane() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), `weft-otto-r${RUN}-${KEY}-`)));
  const head0 = await headSeq();
  state.first_seq = head0 + 1;
  const agents = await createCandidates(work);
  state.agents = agents.map((a) => ({ agent: a.id, harness: a.harness, change: a.cand.change, fork: a.cand.fork.name }));
  phase("candidates", state.agents);
  await Promise.all(agents.map((a) => prepare(a, `run ${RUN} ${KEY}`)));
  phase("agents_ready");
  const mine = new Set(agents.map((a) => a.id));
  const done = {};

  // t1: a peer resumes its idle agent when another card's proposal for it lands in the log
  let watching = KEY === "t1";
  const resumed = new Set();
  const watcher = (async () => {
    while (watching) {
      const ev = await events(head0).catch(() => []);
      for (const p of ev.filter((e) => e.kind === "negotiate.propose" && e.status === "accepted")) {
        const to = p.payload?.to ?? {};
        const owner = agents.find((a) => (to.change ? a.cand.change === to.change : a.id === to.agent));
        if (!owner || resumed.has(`${owner.id}#${p.seq}`)) continue;
        if (ev.some((r) => ["negotiate.accept", "negotiate.reject", "negotiate.counter"].includes(r.kind) && r.payload?.reply_to === p.seq)) continue;
        if (!done[owner.id]) continue; // still running: the adapter injects the proposal at its next hook
        resumed.add(`${owner.id}#${p.seq}`);
        done[owner.id] = false;
        phase("resume_for_proposal", { owner: owner.id, proposal_seq: p.seq, from: p.agent });
        await owner.turn("resume", T.resume);
        done[owner.id] = true;
      }
      await sleep(3000);
    }
  })();

  if (T.plan) {
    phase("planning");
    await Promise.all(agents.map((a) => a.turn("plan", T.plan)));
    state.note = "plans done; implementing once the createSession signature change is in the Weft log";
    phase("waiting_for_cue");
    state.cue = await waitCue(head0, mine);
    state.note = undefined;
    phase("implementing", state.cue);
    await Promise.all(agents.map((a) => (a.session ? a.turn("implement", T.prompt) : a.turn("implement", `${T.plan}\n\n${T.prompt}`))));
  } else {
    phase("working");
    await Promise.all(agents.map((a) => a.turn("work", T.prompt).then(() => (done[a.id] = true))));
    if (KEY === "t1") {
      // stay available for proposals from other cards for a while (their agents implement after us)
      state.note = "edits done; answering other agents' requests via Weft";
      phase("answering");
      const until = Date.now() + Number(process.env.WEFT_OTTO_T1_LISTEN_S ?? 600) * 1000;
      while (Date.now() < until) {
        const ev = await events(head0).catch(() => []);
        const props = ev.filter((e) => e.kind === "negotiate.propose" && e.status === "accepted" && agents.some((a) => a.cand.change === e.payload?.to?.change));
        const open = props.filter((p) => !ev.some((r) => ["negotiate.accept", "negotiate.reject", "negotiate.counter"].includes(r.kind) && r.payload?.reply_to === p.seq));
        if (props.length && !open.length && Object.values(done).every(Boolean)) break;
        await sleep(5000);
      }
    }
  }
  watching = false;
  await watcher;
  for (const a of agents) {
    const p = a.commitAndPush();
    phase(`pushed ${a.id}`, p.ok ? { sha: p.sha } : p);
    a.stop();
  }
  const pushed = agents.filter((a) => a.push?.ok);
  state.agents = agents.map((a) => ({ agent: a.id, harness: a.harness, change: a.cand.change, fork: a.cand.fork.name, turns: a.turns, push: a.push ? { ok: a.push.ok, sha: a.push.sha, reason: a.push.reason } : null }));
  if (!pushed.length) return { status: "no_candidates", detail: state.agents };
  phase("evidence");
  state.evidence = await waitEvidence(pushed);
  phase("evidence_done");
  const sel = await selectAndLand(head0, agents, pushed);
  state.selection = { ...state.selection, ...sel };
  for (const a of agents) for (const f of ["adapter.log", "hooks.jsonl"]) {
    const p = join(a.dir, ".weft/log", f);
    if (existsSync(p)) writeFileSync(join(a.ev, f), scrub(readFileSync(p, "utf8").replaceAll(work, "$WORK")));
  }
  await releaseAll(agents, CARD);
  const landed = ["landed", "already_landed"].includes(sel.land?.status);
  return { status: landed ? "landed" : sel.result ?? sel.status, winner: sel.winner_agent, harness: agents.find((a) => a.id === sel.winner_agent)?.harness ?? null, approved_by: state.approved?.by ?? sel.approved_by ?? null, land_op: sel.land?.op_id ?? null, layer: sel.land?.layer ?? null, trunk: sel.land?.trunk_sha ?? sel.land?.sha ?? null };
}

// ------------------------------------------------------------------------------ the planted bug (t8)

async function demo(path) {
  const t = Date.now();
  try {
    const r = await fetch(`${DEMO_URL}${path}`, { headers: { "cache-control": "no-cache" } });
    return { status: r.status, ms: Date.now() - t, body: (await r.text()).slice(0, 200) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, body: String(e.message ?? e) };
  }
}
async function waitDemo(path, ok, label, maxMs = 900_000) {
  const t = Date.now();
  for (;;) {
    const r = await demo(path);
    if (ok(r)) return { ...r, waited_s: (Date.now() - t) / 1000 };
    if (Date.now() - t > maxMs) throw new Error(`demo ${label}: still ${r.status} ${r.body}`);
    await sleep(5000);
  }
}
const PLANT_FROM = `      const qty = Number(url.searchParams.get("qty") ?? "1");\n`;
const PLANT_TO = `      const qty = Number(url.searchParams.get("qty") ?? "1");\n      const unit = url.searchParams.get("unit")!.toLowerCase(); // throws when ?unit is absent\n      if (unit === "g") return Response.json({ sku, qty, total: calcTotal([{ sku, price: priceOf(sku) / 340, qty }]) });\n`;

async function plantedLane() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), `weft-otto-r${RUN}-${KEY}-`)));
  const pre = await waitDemo("/quote?sku=house-blend&qty=2", (r) => r.status === 200, "preflight", 180_000);
  phase("preflight", { quote: pre });
  const agent = `planted-${KEY}-r${RUN}`;
  const r = await api("POST", `/v1/repos/${REPO}/tasks/${CARD}/candidates`, TOK.sys, { count: 1, agents: [agent], title: T.title, acceptance: T.acceptance, ttl: 3600 }, 201);
  const [c] = r.candidates;
  if (c.subscription.status !== "active") {
    const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: await queueId() }, events: ["pushed"] });
    await api("POST", "/v1/admin/artifacts/subscriptions", TOK.admin, { change: c.change, subscription_id: sub.id }, 200);
    SUBS.push(sub.id);
  }
  const tok = (await api("POST", "/v1/admin/tokens", TOK.admin, { principal: agent, scopes: ["agent"], repos: [REPO], agent }, 201)).token;
  await api("POST", `/v1/repos/${REPO}/sessions`, tok, { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "scripted" }, capabilities: { level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: false }, task: { id: CARD, title: T.title, priority: 0 }, change: c.change }, 201);
  state.agents = [{ agent, harness: "planted", change: c.change, fork: c.fork.name }];
  phase("candidate", state.agents[0]);
  await sleep(45_000); // let a fresh fork subscription settle (m2-report.md); the replay below is the backstop
  const d = join(work, agent);
  git(["clone", "-q", c.fork.remote, d], { token: c.token.plaintext });
  const src = readFileSync(join(d, "src/worker.ts"), "utf8");
  if (!src.includes(PLANT_FROM)) throw new Error("trunk src/worker.ts has no quote handler to plant into");
  writeFileSync(join(d, "src/worker.ts"), src.replace(PLANT_FROM, PLANT_TO));
  git(["add", "-A"], { cwd: d });
  git(["commit", "-qm", `quote: price by the gram (?unit=g)\n\n${Object.entries(c.trailers).map(([k, v]) => `${k}: ${v}`).join("\n")}`], { cwd: d, id: agent });
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: d, token: c.token.plaintext });
  const sha = git(["rev-parse", "HEAD"], { cwd: d });
  const a = { id: agent, dir: d, cand: c, push: { sha, at_ms: Date.now() } };
  phase("planted_pushed", { sha, diff: git(["show", "--format=", "--unified=0", "HEAD", "--", "src/worker.ts"], { cwd: d }).split("\n").filter((l) => /^[+-][^+-]/.test(l)) });
  const t = Date.now();
  let rev;
  for (;;) {
    const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, TOK.sys, undefined, 200);
    rev = ch.revisions.find((x) => x.sha === sha);
    if (rev && ["processed", "conflict", "failed"].includes(rev.status)) break;
    if (!rev && !a.replayed && Date.now() - t > 90_000) (state.push_events_replayed ??= []).push(await replayPush(a, "lane.mjs t8"));
    if (Date.now() - t > 600_000) throw new Error(`planted revision still ${rev?.status ?? "unseen"}`);
    await sleep(3000);
  }
  phase("processed", { revision: rev.status });
  if (rev.status !== "processed") throw new Error(`planted revision ${rev.status}`);
  const land = await api("POST", `/v1/repos/${REPO}/changes/${c.change}/land`, TOK.human, { note: `otto demo run ${RUN}: land the gram option` }, 202);
  let landed;
  for (;;) {
    landed = await wf("land", land.workflow);
    if (["complete", "errored", "terminated"].includes(landed.status)) break;
    await sleep(3000);
  }
  if (landed.output?.status !== "landed") throw new Error(`land: ${JSON.stringify(landed.output ?? landed.error)}`);
  const landedAt = Date.now();
  const opId = landed.output.op_id;
  phase("landed", { op: opId, workflow: land.workflow });
  const broken = await waitDemo("/quote?sku=house-blend&qty=2", (x) => x.status >= 500, "bug deploy");
  phase("production_broken", { land_to_broken_s: (Date.now() - landedAt) / 1000, sample: broken });
  const hits = [];
  for (let i = 0; i < 8; i++) hits.push((await demo(`/quote?sku=house-blend&qty=${i + 1}`)).status);
  phase("production_traffic", { statuses: hits });
  const revertId = `prod-revert-${opId}`;
  const tr = Date.now();
  let started;
  for (;;) {
    started = await wf("revert", revertId);
    if (started.status !== "absent") break;
    if (Date.now() - tr > 300_000) throw new Error(`no ${revertId} after 300 s`);
    await sleep(3000);
  }
  phase("revert_started", { workflow: revertId, land_to_trigger_s: (Date.now() - landedAt) / 1000 });
  let rv;
  for (;;) {
    rv = await wf("revert", revertId);
    if (["complete", "errored", "terminated"].includes(rv.status)) break;
    await sleep(3000);
  }
  if (rv.output?.status !== "reverted") throw new Error(`revert: ${JSON.stringify(rv.output ?? rv.error)}`);
  phase("reverted", { output: rv.output });
  const healed = await waitDemo("/quote?sku=house-blend&qty=2", (x) => x.status === 200, "revert deploy");
  phase("production_healed", { land_to_healed_s: (Date.now() - landedAt) / 1000, sample: healed });
  const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, TOK.sys, undefined, 200);
  const prod = ch.evidence.filter((e) => e.kind === "production_tail_error").map((e) => JSON.parse(e.data ?? "{}"));
  const tasks = (await api("GET", `/v1/repos/${REPO}/tasks`, TOK.sys, undefined, 200)).tasks.filter((x) => (x.task ?? x.id) === CARD);
  const stack = String(prod[0]?.stack ?? prod[0]?.sample_stack ?? "").split("\n").slice(0, 3).join("\n");
  return { status: "reverted", land_op: opId, revert_op: rv.output.op_id ?? null, change_status: ch.change?.status ?? ch.status, weft_task_status: tasks[0]?.status ?? null, stack, timings: { land_to_broken_s: state.steps.find((s) => s.name === "production_broken")?.data?.land_to_broken_s, land_to_healed_s: (Date.now() - landedAt) / 1000 } };
}

// ------------------------------------------------------------------------------ main

(async () => {
  state.pid = process.pid;
  save();
  try {
    state.final = KEY === PLANTED.key ? await plantedLane() : await cardLane();
    state.final.at = new Date().toISOString();
    state.finished_at = state.final.at;
    state.duration_s = secs();
    phase("final", state.final);
  } catch (e) {
    console.error(scrub(e.stack ?? e));
    state.error = scrub(String(e.message ?? e));
    state.final = { status: "error", error: state.error };
    phase("final", state.final);
  } finally {
    for (const id of SUBS) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
    save();
  }
  process.exit(0);
})();
