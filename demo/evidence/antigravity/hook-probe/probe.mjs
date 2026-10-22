import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const ev = process.argv[2]; let s = ""; for await (const c of process.stdin) s += c;
const i = JSON.parse(s || "{}"); const D = "<probe>";
let out = {};
if (ev === "PreToolUse") out = { decision: process.env.PROBE_DECISION || "ask" };
if (ev === "SessionStart") out = { injectSteps: [{ systemMessage: { systemMessage: "PROBE-SESSIONSTART: include the word KIWI in your final answer." } }] };
if (ev === "PreInvocation" && i.invocationNum === 1) out = { injectSteps: [{ ephemeralMessage: "PROBE-INJECT: include the word PINEAPPLE in your final answer." }] };
if (ev === "Stop" && !existsSync(D + "/stopped-once")) { writeFileSync(D + "/stopped-once", "1"); out = { decision: "continue", reason: "PROBE-STOP: before stopping, create the file b.txt containing MANGO." }; }
appendFileSync(D + "/probe.jsonl", JSON.stringify({ ev, in: i, out }) + "\n");
process.stdout.write(JSON.stringify(out));
