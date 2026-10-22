#!/usr/bin/env node
// Real Google Antigravity CLI (`agy`) + real Claude Code, one local Weft gateway: the demo
// collision with Antigravity as the agent that holds the stale assumption.
//
//   agy-b    (task T-2, Antigravity CLI) reads the shop code and plans a cart total that calls calcTotal().
//   agent A  (task T-1) then changes calcTotal's signature in ITS checkout: Claude Code
//            (claude-a, default) or a second Antigravity CLI agent (agy-a, WEFT_DEMO_A=agy).
//   agy-b resumes (`--conversation`) and writes the call the old way -> the Weft PreToolUse hook
//   answers decision:"deny" with the stale_assumption squiggle as the reason.
//     stop-gate : B is told to give up when blocked -> its Stop is answered decision:"continue"
//                 (re-enters the loop with the open error as a system message).
//     reroute   : B is told to adapt -> its next edit is accepted.
//   Then (both scenarios) claude-a changes a symbol agy-b's accepted code now depends on and
//   agy-b gets one more turn: the peer change reaches it through PreInvocation injectSteps.
//
// Usage (repo root; `agy` (and for the default A, `claude`) logged in; a local gateway running):
//   (cd apps/gateway && pnpm dev:local --port 8799) &
//   WEFT_URL=http://localhost:8799 [WEFT_DEMO_A=agy] node demo/antigravity-live.mjs [stop-gate|reroute]
//
// Admin token: $WEFT_ADMIN_TOKEN or apps/gateway/.dev.vars.test. Tokens are never printed.
// Evidence -> demo/evidence/antigravity/<scenario>/.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminToken } from "../scripts/local-quickstart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLAUDE_BUNDLE = join(REPO, "packages/adapters/claude-code/dist/weft-claude.mjs");
const AGY_BUNDLE = join(REPO, "packages/adapters/antigravity/dist/weft-antigravity.mjs");
const TSC = join(REPO, "packages/adapters/claude-code/node_modules/.bin/tsc");
const URL_ = (process.env.WEFT_URL ?? "http://localhost:8799").replace(/\/+$/, "");
const ADMIN = adminToken();
const SCENARIO = process.argv[2] ?? "stop-gate";
if (!["reroute", "stop-gate"].includes(SCENARIO)) throw new Error(`unknown scenario ${SCENARIO}`);
const A_HARNESS = process.env.WEFT_DEMO_A === "agy" ? "agy" : "claude";
const agentA = `${A_HARNESS}-a`;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const repo = `demo-agy-${SCENARIO}-${stamp.toLowerCase()}`;
const work = join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-agy-demo-${stamp}`);
const evidence = join(REPO, "demo/evidence/antigravity", A_HARNESS === "agy" ? `${SCENARIO}-agy-x2` : SCENARIO);

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
      if (stderr.trim()) writeFileSync(out.replace(/\.json$/, ".stderr.txt"), redact(stderr));
      res({ code, stdout, stderr });
    });
    child.on("error", rej);
  });
}

/** One `agy -p` turn (JSON result). The sandboxed demo checkout runs with --dangerously-skip-permissions: Weft's "ask" then defers to that. */
async function agy(cwd, name, prompt, conversation) {
  const out = join(evidence, `${name}.json`);
  const flags = ["--output-format", "json", "--dangerously-skip-permissions", "--print-timeout", "600s", ...(conversation ? ["--conversation", conversation] : [])];
  writeFileSync(join(evidence, `${name}.prompt.txt`), `cwd: ${redact(cwd)}\nagy -p … ${flags.join(" ")}\n\n${prompt}\n`);
  const r = await run("agy", ["-p", prompt, ...flags], cwd, out);
  let j = {};
  try {
    j = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
  } catch {
    /* keep {} */
  }
  if (r.code !== 0) log(`agy exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  return { conversation: j.conversation_id ?? conversation, result: j.response ?? "", code: r.code };
}

/**
 * Env for `claude -p`. A headless worker cannot always use Claude Code's own keychain login
 * (`claude auth status` says loggedIn:false); fall back to the OAuth access token in that keychain
 * item (plain JSON, or hex with a binary prefix on newer builds). Passed via env only, never printed.
 */
let claudeEnvCache;
function claudeEnv() {
  if (claudeEnvCache) return claudeEnvCache;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return (claudeEnvCache = {});
  try {
    const st = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "{}");
    if (st.loggedIn) return (claudeEnvCache = {});
  } catch {
    /* exits 1 when logged out */
  }
  try {
    let raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]+$/i.test(raw)) raw = Buffer.from(raw, "hex").toString("utf8");
    const tok = /"accessToken":"([^"]+)"/.exec(raw)?.[1];
    if (tok) return (claudeEnvCache = { CLAUDE_CODE_OAUTH_TOKEN: tok });
  } catch {
    /* use the environment as is */
  }
  return (claudeEnvCache = {});
}

async function claude(cwd, name, prompt) {
  const out = join(evidence, `${name}.json`);
  // The Weft CLI (inbox / negotiate) must be runnable headless, or claude-a cannot answer proposals.
  const weftBin = [join(cwd, ".weft/bin/weft"), join("/private", cwd, ".weft/bin/weft"), ".weft/bin/weft"];
  const allowed = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", ...weftBin.flatMap((b) => [`Bash(${b})`, `Bash(${b} *)`])].join(",");
  const args = ["-p", "--verbose", "--output-format", "stream-json", "--setting-sources", "project,local", "--permission-mode", "acceptEdits", "--allowedTools", allowed, "--", prompt];
  writeFileSync(join(evidence, `${name}.prompt.txt`), `cwd: ${redact(cwd)}\nclaude -p …\n\n${prompt}\n`);
  const r = await run("claude", args, cwd, out, claudeEnv());
  const lines = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  return { sessionId: lines.find((l) => l.session_id)?.session_id, result: lines.find((l) => l.type === "result")?.result ?? "" };
}

// ------------------------------------------------------------------ setup
for (const b of [CLAUDE_BUNDLE, AGY_BUNDLE]) if (!existsSync(b)) execFileSync(process.execPath, [join(dirname(dirname(b)), "scripts/build.mjs")], { stdio: "inherit" });
// Two concurrent runs of one scenario would wipe each other's evidence: refuse to start then.
const lock = `${evidence}.lock`;
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    /* stale lock */
  }
  if (alive) throw new Error(`another ${SCENARIO} run (pid ${pid}) is writing ${evidence}`);
}
mkdirSync(dirname(lock), { recursive: true });
writeFileSync(lock, String(process.pid));
process.on("exit", () => rmSync(lock, { force: true }));
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
const tokA = await token({ principal: agentA, scopes: ["agent", "observe"], repos: [repo], agent: agentA, label: `demo ${stamp}` });
const tokB = await token({ principal: "agy-b", scopes: ["agent", "observe"], repos: [repo], agent: "agy-b", label: `demo ${stamp}` });
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
  redact(install(A_HARNESS === "agy" ? AGY_BUNDLE : CLAUDE_BUNDLE, dirA, tokA, agentA, "T-1", "Apply tax in calcTotal", 1) + install(AGY_BUNDLE, dirB, tokB, "agy-b", "T-2", "Show the cart total", 0)) +
    `\n--- agent-b/.agents/hooks.json\n${redact(readFileSync(join(dirB, ".agents/hooks.json"), "utf8"))}`,
);

// ------------------------------------------------------------------ the scenario
log("B (agy) turn 1: read + plan (no edits)");
const b1 = await agy(
  dirB,
  "b1-plan",
  "Task T-2: the Cart class in src/cart.ts needs a `total(): number` method that returns the cart total, computed with the existing `calcTotal` helper from src/pricing.ts. " +
    "For now only read src/pricing.ts and src/cart.ts and reply with a 3-line plan including the exact code line you will write for the method body. Do not edit any file and do not run any command yet.",
);
log(`B conversation ${b1.conversation}: ${b1.result.split("\n")[0]}`);

/** Agent A's turn in its own harness (agy: a fresh conversation per turn). */
const runA = async (name, prompt) => {
  if (A_HARNESS === "claude") return claude(dirA, name, prompt);
  const r = await agy(dirA, name, prompt + " Do not run any command.");
  return { sessionId: r.conversation, result: r.result };
};

log(`A (${agentA}): change calcTotal's signature`);
const a = await runA(
  "a1-signature",
  "Task T-1: prices must include tax. In src/pricing.ts add `export type PriceOptions = { taxRate: number }` and change calcTotal to `calcTotal(items: Item[], opts: PriceOptions): number` returning the net sum multiplied by (1 + opts.taxRate). " +
    "Update the existing caller in src/orders.ts (use taxRate 0.22). Keep it minimal, then reply with a one-line summary.",
);
log(`A: ${a.result.split("\n")[0]}`);

log("B (agy) turn 2: implement (resumed conversation — still believes the old signature)");
const b2 = await agy(
  dirB,
  "b2-implement",
  SCENARIO === "reroute"
    ? "Go ahead and implement the plan now with your file edit tool, without re-reading the files first and without running commands. If the Weft coordinator reports a conflict, adapt your code to it. When you are done, reply with the final method and one sentence on anything that changed from your plan."
    : "Implement the plan now with your file edit tool, exactly as planned, without re-reading the files first and without running commands. If a hook blocks or denies one of your edits, do not retry or adapt anything: reply with what the hook said and end your turn.",
  b1.conversation,
);
log(`B: ${b2.result.split("\n")[0]}`);

log(`A (${agentA}): rename PriceOptions.taxRate -> rate (B now depends on it; the coordinator queues that for B)`);
const a2 = await runA(
  "a2-followup",
  "Task T-1, follow-up: in src/pricing.ts rename the PriceOptions field `taxRate` to `rate` (update calcTotal and the caller in src/orders.ts). Keep it minimal, then reply with a one-line summary.",
);
log(`A2: ${a2.result.split("\n")[0]}`);

log("B (agy) turn 3: a status question; whatever the coordinator queued arrives via PreInvocation injectSteps");
const b3 = await agy(
  dirB,
  "b3-status",
  "Before you do anything else: quote verbatim every line that starts with \"[weft\" that you can see in your context since my last message, or say NONE. Then, if any of them reports a problem with your code, fix it with your file edit tool (no commands) and reply with the final total() method.",
  b1.conversation,
);
log(`B3: ${b3.result.split("\n")[0]}`);

// ------------------------------------------------------------------ evidence
const obs = async (path) => (await fetch(URL_ + path, { headers: { authorization: `Bearer ${tokObs}`, "wcp-version": "0.1" } })).json();
const page = await obs(`/v1/repos/${repo}/events?after=0&limit=300`);
const events = [];
for (const e of page.events ?? []) events.push(e.has_diff ? await obs(`/v1/repos/${repo}/events/${e.seq}`) : e);
writeFileSync(join(evidence, "coordinator-log.json"), JSON.stringify({ url: URL_, repo, events }, null, 2));
for (const [who, dir] of [["a", dirA], ["b", dirB]]) {
  for (const [f, name] of [[".weft/log/adapter.log", `adapter-${who}.log`], [".weft/log/hooks.jsonl", `hooks-${who}.jsonl`]]) {
    const p = join(dir, f);
    if (existsSync(p)) writeFileSync(join(evidence, name), redact(readFileSync(p, "utf8")));
  }
}
if (b1.conversation) {
  const t = join(homedir(), ".gemini/antigravity-cli/brain", b1.conversation, ".system_generated/logs/transcript_full.jsonl");
  if (existsSync(t)) writeFileSync(join(evidence, "agy-b-transcript.jsonl"), redact(readFileSync(t, "utf8")));
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
landing.push(`--- agent-b:src/cart.ts\n${readFileSync(join(dirB, "src/cart.ts"), "utf8")}`);
try {
  git(origin, "merge", "-q", "--no-edit", "agent-a");
  git(origin, "merge", "-q", "--no-edit", "agent-b");
  landing.push(`--- main after merging agent-a then agent-b:\n${git(origin, "log", "--oneline", "-5")}`);
  landing.push(tsc(origin));
} catch (err) {
  landing.push(`merge: ${String(err.stderr ?? err)}`);
}
writeFileSync(join(evidence, "landing.txt"), redact(landing.join("\n") + "\n"));
writeFileSync(
  join(evidence, "run.json"),
  JSON.stringify({ scenario: SCENARIO, agent_a: agentA, agent_b: "agy-b", stamp, url: URL_, repo, agy: execFileSync("agy", ["--version"], { encoding: "utf8" }).trim(), ...(A_HARNESS === "claude" ? { claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim() } : {}), b_conversation: b1.conversation, a_session: a.sessionId, a2_session: a2.sessionId }, null, 2),
);
log(`evidence in ${evidence}`);
console.log(landing.join("\n"));
