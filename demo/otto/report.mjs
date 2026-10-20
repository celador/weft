#!/usr/bin/env node
// Otto demo report: reads demo/evidence/otto/run-N/{lanes/*/state.json,trunk.json,cards.json} plus the
// Weft log for the run's sequence range, writes run-N/run.json and demo/evidence/otto-report.md.
//
//   node demo/otto/report.mjs --run N [--runs 1,2,3]     (--runs: which runs go in the report table)
//
// Every beat is scored from recorded events and lane state, never from the scenario's intent.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANTED, TASKS } from "./scenario.mjs";
import { ROOT, events, scrub } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const RUN = Number(opt("run", "1"));
const RUNS = String(opt("runs", String(RUN))).split(",").map(Number);
const EV = join(ROOT, "demo/evidence/otto");
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

async function build(run) {
  const dir = join(EV, `run-${run}`);
  const lanesDir = join(dir, "lanes");
  const lanes = {};
  for (const k of existsSync(lanesDir) ? readdirSync(lanesDir) : []) {
    if (!/^t\d+$/.test(k)) continue; // t1.fork503 etc: aborted attempts, reported below
    const s = read(join(lanesDir, k, "state.json"));
    if (s) lanes[k] = s;
  }
  const aborted = (existsSync(lanesDir) ? readdirSync(lanesDir) : []).filter((k) => !/^t\d+$/.test(k)).map((k) => ({ lane: k, final: read(join(lanesDir, k, "state.json"))?.final ?? null }));
  const firsts = Object.values(lanes).map((s) => s.first_seq).filter(Boolean);
  const from = firsts.length ? Math.min(...firsts) - 1 : 0;
  const ev = (await events(from)).filter((e) => e.kind !== "heartbeat");
  const agentTask = new Map();
  for (const [k, s] of Object.entries(lanes)) for (const a of s.agents ?? []) agentTask.set(a.agent, k);
  const ours = (e) => agentTask.has(e.agent) || e.kind === "land" || e.kind === "revert" || e.kind === "control";
  const runEv = ev.filter(ours);
  const t0 = Math.min(...Object.values(lanes).map((s) => Date.parse(s.started_at)));
  const at = (iso) => +((Date.parse(iso) - t0) / 1000).toFixed(1);

  // squiggles: rejected edits with diagnostics, and whether the same agent's next edit was accepted
  const squiggles = runEv.filter((e) => e.kind === "edit" && e.status === "rejected" && e.diagnostics?.length).map((e) => {
    const next = runEv.find((x) => x.seq > e.seq && x.agent === e.agent && x.kind === "edit" && x.status === "accepted");
    const d = e.diagnostics[0];
    return { seq: e.seq, at_s: at(e.ts), agent: e.agent, task: agentTask.get(e.agent), code: d.code, symbol: d.symbol, caused_by: d.caused_by_agent ?? null, caused_by_task: d.caused_by_task ?? null, rerouted_seq: next?.seq ?? null, rerouted_after_s: next ? +((Date.parse(next.ts) - Date.parse(e.ts)) / 1000).toFixed(1) : null };
  });
  const negotiation = runEv.filter((e) => e.kind.startsWith("negotiate.")).map((e) => ({ seq: e.seq, at_s: at(e.ts), kind: e.kind.slice(10), agent: e.agent, task: agentTask.get(e.agent), to: e.payload?.to?.change ? [...agentTask.keys()].find((a) => Object.values(lanes).some((s) => (s.agents ?? []).some((x) => x.agent === a && x.change === e.payload.to.change))) ?? e.payload.to.change : e.payload?.to?.agent ?? e.payload?.with?.change ?? null, reply_to: e.payload?.reply_to ?? null, terms: e.payload?.terms?.kind ?? null, text: scrub(e.payload?.terms?.text ?? e.payload?.reason ?? "").slice(0, 200) }));
  const harnesses = {};
  for (const s of Object.values(lanes)) for (const a of s.agents ?? []) harnesses[a.harness] = (harnesses[a.harness] ?? 0) + 1;
  const cards = read(join(dir, "cards.json"));
  const per = Object.fromEntries(Object.entries(lanes).map(([k, s]) => {
    const ev6 = s.evidence ?? {};
    return [k, {
      card: s.card, title: s.title, beat: s.beat, harnesses: s.harnesses,
      agents: (s.agents ?? []).map((a) => ({ agent: a.agent, harness: a.harness, pushed: a.push?.ok ?? (k === PLANTED.key ? true : null), push_reason: a.push?.reason ?? null, turns: a.turns?.map((t) => ({ name: t.name, code: t.code, s: Math.round(t.ms / 1000) })) })),
      evidence: Object.fromEntries(Object.entries(ev6).map(([a, e]) => [a, { revision: e.revision, kinds: e.rows.map((r) => `${r.kind}:${r.status}`), review: e.rows.find((r) => r.kind === "review")?.data ?? null, visual_diff: e.rows.find((r) => r.kind === "visual_diff")?.data?.routes ?? null, preview: e.rows.find((r) => r.kind === "preview")?.data?.url ?? null, risk: e.rows.find((r) => r.kind === "risk")?.data?.risk ?? null }])),
      ranking: s.selection?.ranking ?? null, awaiting: s.awaiting ?? null, approved: s.approved ?? null,
      land: s.selection?.land ? { status: s.selection.land.status, op: s.selection.land.op_id, layer: s.selection.land.layer, attempts: s.selection.land.attempts } : null,
      final: s.final ?? null, started_at: s.started_at, finished_at: s.finished_at ?? null, start_s: at(s.started_at), end_s: s.finished_at ? at(s.finished_at) : null,
      marks: s.marks, fork_retries: s.fork_retries ?? [], push_events_replayed: s.push_events_replayed ?? [],
    }];
  }));
  const trunk = read(join(dir, "trunk.json"));
  const landed = (k) => ["landed"].includes(lanes[k]?.final?.status);
  const sessionTs = trunk?.files?.["src/auth/session.ts"] ?? "";
  const overloadOnTrunk = /createSession\(\s*userId: string\s*\)\s*:\s*Session\s*;/.test(sessionTs) || /opts\?\s*:/.test(sessionTs) || /opts: SessionOptions\s*=/.test(sessionTs);
  const t2Squig = squiggles.filter((q) => q.task === "t2" && q.code === "stale_assumption");
  const accepts = negotiation.filter((n) => n.kind === "accept");
  const t3Props = negotiation.filter((n) => n.kind === "propose" && n.task === "t3");
  const mergeLayers = ["t4", "t5"].map((k) => per[k]?.land?.layer).concat(["t4", "t5"].flatMap((k) => Object.values(per[k]?.evidence ?? {}).map((e) => e.revision?.layer)));
  const t6ev = Object.values(per.t6?.evidence ?? {});
  const t6full = t6ev.filter((e) => ["preview", "screenshot", "visual_diff", "risk", "review"].every((kind) => e.kinds.some((x) => x.startsWith(kind + ":"))));
  const t8 = lanes[PLANTED.key]?.final;
  const beats = {
    live_agents: { ok: Object.values(lanes).filter((s) => s.task !== PLANTED.key).every((s) => (s.agents ?? []).length >= 2) && Object.keys(harnesses).filter((h) => h !== "planted").length >= 3, detail: { cards: Object.keys(lanes).length, agents: [...agentTask.keys()].length, harnesses } },
    squiggle_reroute: { ok: t2Squig.some((q) => q.rerouted_seq) && landed("t2"), detail: t2Squig },
    structural_merge: { ok: mergeLayers.includes("mergiraf") && landed("t4") && landed("t5"), detail: { layers: mergeLayers } },
    negotiation_both_land: { ok: t3Props.length > 0 && accepts.some((a) => a.task === "t1") && landed("t1") && landed("t3") && overloadOnTrunk, detail: { proposals: t3Props.length, accepts: accepts.length, overload_on_trunk: overloadOnTrunk } },
    evidence_and_human_approval: { ok: t6full.length >= 2 && !!lanes.t6?.approved && landed("t6"), detail: { candidates_with_full_evidence: t6full.length, approved: lanes.t6?.approved ?? null } },
    trunk_green: { ok: trunk?.tsc?.exit === 0 && /fail 0/.test((trunk?.test?.summary ?? []).join(" ")), detail: trunk ? { head: trunk.head, tsc: trunk.tsc.exit, test: trunk.test.summary } : null },
    planted_bug_auto_revert: { ok: t8?.status === "reverted" && t8?.weft_task_status === "open", detail: t8 ?? null },
  };
  const all = Object.values(beats).every((b) => b.ok);
  const endIso = Object.values(lanes).map((s) => s.finished_at).filter(Boolean).sort().pop();
  return { run, generated_at: new Date().toISOString(), started_at: new Date(t0).toISOString(), finished_at: endIso ?? null, total_s: endIso ? at(endIso) : null, cards, beats, all_beats: all, harnesses, lanes: per, squiggles, negotiation, aborted_attempts: aborted, seq_range: [from + 1, ev.at(-1)?.seq ?? null], events_in_run: runEv.length };
}

const fmt = (b) => (b === undefined ? "—" : b.ok ? "PASS" : "FAIL");
const rows = [];
const built = {};
for (const r of RUNS) {
  const p = join(EV, `run-${r}`, "run.json");
  if (r === RUN || !existsSync(p)) {
    built[r] = await build(r);
    writeFileSync(p, scrub(JSON.stringify(built[r], null, 2)) + "\n");
  } else built[r] = JSON.parse(readFileSync(p, "utf8"));
}
const BEATS = [
  ["live_agents", "many cards at once, 2-3 candidates each on different harnesses"],
  ["squiggle_reroute", "stale call caught mid-edit (squiggle) → reroute (t2 × t1)"],
  ["structural_merge", "adjacent one-liners in one file: Mergiraf structural merge (t4 × t5)"],
  ["negotiation_both_land", "negotiation: overload proposed, accepted, both land (t3 × t1)"],
  ["evidence_and_human_approval", "previews + screenshots + pixel diff + risk + review, human approval (t6)"],
  ["trunk_green", "trunk typechecks + tests green after the landings"],
  ["planted_bug_auto_revert", "planted bug → production errors → auto-revert → task reopened (t8)"],
];
rows.push("# Otto demo report: Northbound Coffee, many cards and harnesses through Weft", "");
rows.push("Generated by `node demo/otto/report.mjs` from `demo/evidence/otto/run-*/run.json`. Scenario: `demo/otto/scenario.md`.", "");
rows.push("## Beats per run", "", `| beat | ${RUNS.map((r) => `run-${r}`).join(" | ")} |`, `|---|${RUNS.map(() => "---").join("|")}|`);
for (const [k, label] of BEATS) rows.push(`| ${label} | ${RUNS.map((r) => fmt(built[r].beats[k])).join(" | ")} |`);
rows.push(`| **all beats** | ${RUNS.map((r) => (built[r].all_beats ? "**PASS**" : "**FAIL**")).join(" | ")} |`, "");
for (const r of RUNS) {
  const b = built[r];
  rows.push(`## run-${r}`, "");
  rows.push(`Started ${b.started_at}, last lane finished ${b.finished_at ?? "—"} (${b.total_s ?? "—"} s). Weft log #${b.seq_range[0]}–#${b.seq_range[1]}, ${b.events_in_run} events from this run's agents and landings.`);
  if (b.cards) rows.push(`Kanban: board \`${b.cards.board}\`, cards ${Object.entries(b.cards.cards ?? {}).map(([k, c]) => `${k}=${c}`).join(", ")}.`);
  if (b.cards?.notes?.length) rows.push("", "Run notes (honest failures and how the run was driven):", "", ...b.cards.notes.map((n) => `- ${n}`), "");
  rows.push(`Harnesses: ${Object.entries(b.harnesses).map(([h, n]) => `${h} ×${n}`).join(", ")}.`, "");
  rows.push("| card | title | candidates (pushed) | result | winner | approval | land layer | start → end (s) |", "|---|---|---|---|---|---|---|---|");
  for (const [k, l] of Object.entries(b.lanes).sort()) {
    const cands = l.agents.map((a) => `${a.agent}${a.pushed === false ? ` (not pushed: ${a.push_reason})` : ""}`).join(", ");
    rows.push(`| ${k} | ${l.title} | ${cands} | ${l.final?.status ?? "—"}${l.final?.error ? `: ${String(l.final.error).slice(0, 120)}` : ""} | ${l.final?.winner ?? "—"} | ${l.approved?.by ? (/fallback/.test(l.approved.by) ? "scripted fallback (human token)" : l.approved.by) : l.final?.status === "landed" ? "auto (low risk)" : "—"} | ${l.land?.layer ?? (l.final?.status === "reverted" ? "—" : "—")} | ${l.start_s} → ${l.end_s ?? "—"} |`);
  }
  rows.push("");
  rows.push(`Squiggles: ${b.squiggles.map((q) => `#${q.seq} ${q.code} on ${q.agent} (${q.symbol}, by ${q.caused_by ?? "?"})${q.rerouted_seq ? ` → rerouted #${q.rerouted_seq} after ${q.rerouted_after_s} s` : ""}`).join("; ") || "none"}.`, "");
  rows.push(`Negotiation: ${b.negotiation.map((n) => `#${n.seq} ${n.agent} ${n.kind}${n.to ? ` → ${n.to}` : ""}${n.reply_to ? ` (re #${n.reply_to})` : ""}`).join("; ") || "none"}.`, "");
  const t6 = b.lanes.t6;
  if (t6) {
    rows.push("t6 evidence:", "");
    for (const [a, e] of Object.entries(t6.evidence)) rows.push(`- ${a}: ${e.kinds.join(", ")}; review ${e.review?.verdict ?? "—"} ${e.review?.score ?? ""}; menu pixel diff ${e.visual_diff?.find((x) => x.route === "/menu.html")?.pixels ?? "—"} px; risk ${e.risk ?? "—"}`);
    rows.push("");
  }
  if (b.lanes.t8?.final) rows.push(`Planted bug: ${JSON.stringify(b.lanes.t8.final.timings ?? {})}; land ${b.lanes.t8.final.land_op}, revert ${b.lanes.t8.final.revert_op}, Weft task ${b.lanes.t8.final.weft_task_status}.`, "");
  if (b.aborted_attempts.length) rows.push(`Aborted lane attempts (restarted): ${b.aborted_attempts.map((a) => `${a.lane}: ${String(a.final?.error ?? a.final?.status ?? "?").slice(0, 160)}`).join("; ")}.`, "");
  const retries = Object.entries(b.lanes).flatMap(([k, l]) => l.fork_retries.map((f) => `${k} ${f.agent} attempt ${f.attempt}`));
  if (retries.length) rows.push(`Artifacts fork retries (503): ${retries.join("; ")}.`, "");
  const failed = Object.values(b.beats).filter((x) => !x.ok);
  if (failed.length) rows.push(`Failed beats detail: ${Object.entries(b.beats).filter(([, x]) => !x.ok).map(([k, x]) => `${k}: ${scrub(JSON.stringify(x.detail)).slice(0, 300)}`).join("; ")}`, "");
}
writeFileSync(join(ROOT, "demo/evidence/otto-report.md"), scrub(rows.join("\n")) + "\n");
console.log(JSON.stringify(Object.fromEntries(RUNS.map((r) => [r, { all: built[r].all_beats, beats: Object.fromEntries(Object.entries(built[r].beats).map(([k, v]) => [k, v.ok])) }]))));
