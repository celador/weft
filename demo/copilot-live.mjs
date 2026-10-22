#!/usr/bin/env node
// Real GitHub Copilot CLI + real Claude Code, one local Weft gateway: the demo collision with
// Copilot as the agent that holds the stale assumption.
//
//   copilot-b (task T-2, Copilot CLI) reads the shop code and plans a cart total that calls calcTotal().
//   agent A   (task T-1) then changes calcTotal's signature in ITS checkout: a second Copilot CLI
//             agent (copilot-a, default) or Claude Code (claude-a, WEFT_DEMO_A=claude).
//   copilot-b resumes and writes the call the old way -> the Weft preToolUse hook denies the
//   edit with the stale_assumption squiggle as permissionDecisionReason.
//     reroute    : B is told to adapt -> its next edit is accepted.
//     stop-gate  : B is told to give up when blocked -> agentStop is refused (decision "block").
//
// Usage (repo root; `copilot` (and for WEFT_DEMO_A=claude, `claude`) logged in; a local gateway running):
//   (cd apps/gateway && pnpm dev:local --port 8797) &
//   WEFT_URL=http://localhost:8797 node demo/copilot-live.mjs [reroute|stop-gate]
//
// Admin token: $WEFT_ADMIN_TOKEN or apps/gateway/.dev.vars.test. Tokens are never printed.
// Evidence -> demo/evidence/copilot/<scenario>/.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminToken } from "../scripts/local-quickstart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLAUDE_BUNDLE = join(REPO, "packages/adapters/claude-code/dist/weft-claude.mjs");
const COPILOT_BUNDLE = join(REPO, "packages/adapters/copilot/dist/weft-copilot.mjs");
const TSC = join(REPO, "packages/adapters/claude-code/node_modules/.bin/tsc");
const URL_ = (process.env.WEFT_URL ?? "http://localhost:8797").replace(/\/+$/, "");
const ADMIN = adminToken();
const SCENARIO = process.argv[2] ?? "reroute";
if (!["reroute", "stop-gate"].includes(SCENARIO)) throw new Error(`unknown scenario ${SCENARIO}`);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const repo = `demo-copilot-${SCENARIO}-${stamp.toLowerCase()}`;
const work = join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-copilot-demo-${stamp}`);
const evidence = join(REPO, "demo/evidence/copilot", SCENARIO);

const log = (m) => console.log(`[demo] ${m}`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const redact = (s) => s.replaceAll(work, "<work>").replaceAll(homedir(), "~");

async function admin(method, path, body) {
  const r = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "wcp-version": "0.1", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

function run(cmd, args, cwd, out, env = {}) {
  return new Promise((res, rej) => {
    const e = { ...process.env, WEFT_HOOK_TRACE: "1", ...env };
    delete e.WEFT_TOKEN;
    const child = spawn(cmd, args, { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      writeFileSync(out, redact(stdout));
      if (stderr.trim()) writeFileSync(out.replace(/\.jsonl$/, ".stderr.txt"), redact(stderr));
      res({ code, stdout, stderr });
    });
    child.on("error", rej);
  });
}

async function copilot(cwd, name, prompt, sessionId) {
  const out = join(evidence, `${name}.jsonl`);
  // Repository hooks (.github/hooks) load only in a trusted folder; in prompt mode an untrusted
  // folder silently runs with NO hooks. --trust-folder cannot be combined with --resume, so a
  // resumed session gets COPILOT_ALLOW_ALL=true (which also counts as trusted) instead.
  const flags = ["--output-format", "json", "--allow-all-tools", "--no-ask-user", ...(sessionId ? ["--resume", sessionId] : ["--trust-folder"])];
  const env = sessionId ? { COPILOT_ALLOW_ALL: "true" } : {};
  const args = ["-p", prompt, ...flags];
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${redact(cwd)}\n${sessionId ? "COPILOT_ALLOW_ALL=true " : ""}copilot -p … ${flags.join(" ")}\n\n${prompt}\n`);
  const r = await run("copilot", args, cwd, out, env);
  const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const sid = sessionId ?? lines.map((l) => l.sessionId ?? l.data?.sessionId).find(Boolean) ?? latestCopilotSession(cwd);
  const final = lines.filter((l) => l.type === "assistant.message").map((l) => l.data?.content ?? "").filter(Boolean).pop() ?? "";
  if (r.code !== 0) log(`copilot exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  return { sessionId: sid, result: final, code: r.code };
}

/** The newest Copilot session whose workspace is `cwd` (fallback when the JSON stream has no id). */
function latestCopilotSession(cwd) {
  const dir = join(homedir(), ".copilot/session-state");
  const ids = execFileSync("ls", ["-t", dir], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const id of ids.slice(0, 20)) {
    const ev = join(dir, id, "events.jsonl");
    if (existsSync(ev) && readFileSync(ev, "utf8").includes(cwd)) return id;
  }
  return undefined;
}

async function claude(cwd, name, prompt) {
  const out = join(evidence, `${name}.jsonl`);
  const args = ["-p", "--verbose", "--output-format", "stream-json", "--setting-sources", "project,local", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,MultiEdit,Glob,Grep", "--", prompt];
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${redact(cwd)}\nclaude -p …\n\n${prompt}\n`);
  const r = await run("claude", args, cwd, out);
  const lines = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  return { sessionId: lines.find((l) => l.session_id)?.session_id, result: lines.find((l) => l.type === "result")?.result ?? "" };
}

// ------------------------------------------------------------------ setup
for (const b of [CLAUDE_BUNDLE, COPILOT_BUNDLE]) if (!existsSync(b)) execFileSync(process.execPath, [join(dirname(dirname(b)), "scripts/build.mjs")], { stdio: "inherit" });
rmSync(evidence, { recursive: true, force: true });
mkdirSync(evidence, { recursive: true });
mkdirSync(work, { recursive: true });
const origin = join(work, "origin");
cpSync(join(REPO, "demo/ts-shop"), origin, { recursive: true });
git(origin, "init", "-q", "-b", "main");
git(origin, "config", "user.email", "demo@weft.invalid");
git(origin, "config", "user.name", "weft demo");
git(origin, "add", "-A");
git(origin, "commit", "-qm", "ts-shop: initial");
const dirA = join(work, "agent-a");
const dirB = join(work, "agent-b");
git(origin, "worktree", "add", "-q", dirA, "-b", "agent-a");
git(origin, "worktree", "add", "-q", dirB, "-b", "agent-b");
log(`checkouts: ${dirA}, ${dirB}`);

await admin("POST", "/v1/admin/repos", { repo });
const token = async (spec) => (await admin("POST", "/v1/admin/tokens", spec)).token;
const A_HARNESS = process.env.WEFT_DEMO_A === "claude" ? "claude" : "copilot";
const agentA = `${A_HARNESS}-a`;
const tokA = await token({ principal: agentA, scopes: ["agent", "observe"], repos: [repo], agent: agentA, label: `demo ${stamp}` });
const tokB = await token({ principal: "copilot-b", scopes: ["agent", "observe"], repos: [repo], agent: "copilot-b", label: `demo ${stamp}` });
const tokObs = await token({ principal: `demo-evidence-${stamp}`, scopes: ["observe"], repos: [repo], label: `demo ${stamp}` });
log(`coordinator ${URL_} repo ${repo} (tokens minted, not printed)`);

const install = (bundle, dir, tok, agent, task, title, priority) =>
  execFileSync(process.execPath, [bundle, "install", "--url", URL_, "--repo", repo, "--agent", agent, "--task", task, "--title", title, "--priority", String(priority)], {
    cwd: dir,
    env: { ...process.env, WEFT_TOKEN: tok },
    encoding: "utf8",
  });
writeFileSync(
  join(evidence, "install.txt"),
  redact(install(A_HARNESS === "claude" ? CLAUDE_BUNDLE : COPILOT_BUNDLE, dirA, tokA, agentA, "T-1", "Apply tax in calcTotal", 1) + install(COPILOT_BUNDLE, dirB, tokB, "copilot-b", "T-2", "Show the cart total", 0)) +
    `\n--- agent-b/.github/hooks/weft.json\n${redact(readFileSync(join(dirB, ".github/hooks/weft.json"), "utf8"))}`,
);

// ------------------------------------------------------------------ the scenario
log("B (Copilot) turn 1: read + plan (no edits)");
const b1 = await copilot(
  dirB,
  "b1-plan",
  "Task T-2: the Cart class in src/cart.ts needs a `total(): number` method that returns the cart total, computed with the existing `calcTotal` helper from src/pricing.ts. " +
    "For now only read src/pricing.ts and src/cart.ts and reply with a 3-line plan including the exact code line you will write for the method body. Do not edit any file yet.",
);
log(`B session ${b1.sessionId}: ${b1.result.split("\n")[0]}`);

log(`A (${A_HARNESS}): change calcTotal's signature`);
const a = await (A_HARNESS === "claude" ? claude : copilot)(
  dirA,
  "a-signature",
  "Task T-1: prices must include tax. In src/pricing.ts add `export type PriceOptions = { taxRate: number }` and change calcTotal to `calcTotal(items: Item[], opts: PriceOptions): number` returning the net sum multiplied by (1 + opts.taxRate). " +
    "Update the existing caller in src/orders.ts (use taxRate 0.22). Keep it minimal, then reply with a one-line summary.",
);
log(`A: ${a.result.split("\n")[0]}`);

log("B (Copilot) turn 2: implement (resumed session — still believes the old signature)");
const b2 = await copilot(
  dirB,
  "b2-implement",
  SCENARIO === "reroute"
    ? "Go ahead and implement the plan now, without re-reading the files first. If the Weft coordinator reports a conflict, adapt your code to it. When you are done, reply with the final method and one sentence on anything that changed from your plan."
    : "Implement the plan now, exactly as planned, without re-reading the files first. If a hook blocks or denies one of your edits, do not retry or adapt anything: reply with what the hook said and end your turn.",
  b1.sessionId,
);
log(`B: ${b2.result.split("\n")[0]}`);

// ------------------------------------------------------------------ evidence
const obs = async (path) => (await fetch(URL_ + path, { headers: { authorization: `Bearer ${tokObs}`, "wcp-version": "0.1" } })).json();
const page = await obs(`/v1/repos/${repo}/events?after=0&limit=200`);
const events = [];
for (const e of page.events ?? []) events.push(e.has_diff ? await obs(`/v1/repos/${repo}/events/${e.seq}`) : e);
writeFileSync(join(evidence, "coordinator-log.json"), JSON.stringify({ url: URL_, repo, events }, null, 2));
for (const [who, dir] of [["a", dirA], ["b", dirB]]) {
  for (const [f, name] of [[".weft/log/adapter.log", `adapter-${who}.log`], [".weft/log/hooks.jsonl", `hooks-${who}.jsonl`]]) {
    const p = join(dir, f);
    if (existsSync(p)) writeFileSync(join(evidence, name), redact(readFileSync(p, "utf8")));
  }
}
if (b1.sessionId) {
  const ev = join(homedir(), ".copilot/session-state", b1.sessionId, "events.jsonl");
  if (existsSync(ev)) writeFileSync(join(evidence, "copilot-b-session-events.jsonl"), redact(readFileSync(ev, "utf8")));
}

const commit = (dir, msg) => {
  git(dir, "add", "-A");
  try {
    return git(dir, "commit", "-qm", msg) || "committed";
  } catch (err) {
    return `commit refused: ${String(err.stderr ?? err)}`;
  }
};
const tsc = (cwd) => {
  try {
    execFileSync(TSC, ["-p", "."], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "tsc: exit 0 (clean)";
  } catch (err) {
    return `tsc: exit ${err.status}\n${err.stdout}`;
  }
};
const landing = [];
landing.push(`agent-a: ${commit(dirA, "pricing: apply tax in calcTotal")}`);
landing.push(`agent-b: ${commit(dirB, "cart: add total()")}`);
landing.push(`agent-b git diff vs base:\n${git(dirB, "diff", "HEAD~0", "--stat") || git(dirB, "log", "-1", "--format=%B")}`);
landing.push(`--- agent-b:src/cart.ts\n${readFileSync(join(dirB, "src/cart.ts"), "utf8")}`);
if (SCENARIO === "reroute") {
  try {
    git(origin, "merge", "-q", "--no-edit", "agent-a");
    git(origin, "merge", "-q", "--no-edit", "agent-b");
    landing.push(`--- main after merging agent-a then agent-b:\n${git(origin, "log", "--oneline", "-4")}`);
    landing.push(tsc(origin));
  } catch (err) {
    landing.push(`merge: ${String(err.stderr ?? err)}`);
  }
}
writeFileSync(join(evidence, "landing.txt"), redact(landing.join("\n") + "\n"));
writeFileSync(join(evidence, "run.json"), JSON.stringify({ scenario: SCENARIO, agent_a: agentA, agent_b: "copilot-b", stamp, url: URL_, repo, copilot: execFileSync("copilot", ["--version"], { encoding: "utf8" }).trim(), b_session: b1.sessionId, a_session: a.sessionId }, null, 2));
log(`evidence in ${evidence}`);
console.log(landing.join("\n"));
