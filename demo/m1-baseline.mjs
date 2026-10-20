#!/usr/bin/env node
// M1 baseline: the same two-agent scenario as demo/m1-collision.mjs, with Weft OFF.
// No coordinator repo, no adapter install, no hooks: Claude Code (agent A) and Codex (agent B)
// each work in their own git worktree of demo/target-app, exactly as two agents would today.
//
//   claude-a  T-1 "Session expiry"   changes createSession(userId) -> createSession(userId, opts)
//   codex-b   T-2 "Signup endpoint"  adds POST /api/signup, which must start a session
//
// Timeline: B turn 1 plans (reads the code, still the old signature); A runs to completion;
// B turn 2 implements (same conversation). Then both branches are committed, A then B are
// merged into main, and tsc + node --test run on main. The failure this records is the one
// Weft exists to prevent: git merges cleanly, the build breaks only after the merge.
//
// Usage: node demo/m1-baseline.mjs [--out demo/evidence/m1-baseline]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TSC = join(REPO, "node_modules/.bin/tsc");
const argv = process.argv.slice(2);
const OUT = resolve(REPO, argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "demo/evidence/m1-baseline");
const TIMEOUT_MS = 15 * 60_000;
const log = (m) => console.log(`[m1-baseline ${new Date().toISOString().slice(11, 19)}] ${m}`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (cmd, args, cwd) => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

function harness(cmd, args, cwd, outFile) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, stdout);
      if (stderr.trim()) writeFileSync(outFile.replace(/\.jsonl$/, ".stderr.txt"), stderr);
      const lines = stdout.split("\n").filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
      res({ code, lines, ms: Date.now() - started });
    });
  });
}
// Agent A harness: claude by default; WEFT_BASELINE_A=codex if claude is not authenticated on this host.
const A_HARNESS = process.env.WEFT_BASELINE_A ?? "claude";
const claude = (cwd, out, prompt) =>
  harness("claude", ["-p", "--verbose", "--output-format", "stream-json", "--setting-sources", "project,local", "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Edit,Write,MultiEdit,Glob,Grep,Bash(node --test:*),Bash(git status:*),Bash(git diff:*)", "--", prompt], cwd, out);
const codex = (cwd, out, prompt, resumeId) => {
  const common = ["--json", "-c", 'sandbox_mode="workspace-write"'];
  return harness("codex", resumeId ? ["exec", "resume", ...common, resumeId, prompt] : ["exec", ...common, "--cd", cwd, prompt], cwd, out);
};

// Same task prompts as m1-collision.mjs; B2 drops only the sentences about Weft.
const PROMPT_A =
  'Task T-1 (session expiry): sessions must expire. In src/auth/session.ts add `export type SessionOptions = { ttlMs: number }`, add `expiresAt: number` to Session, ' +
  "change createSession to `createSession(userId: string, opts: SessionOptions): Session` (expiresAt = createdAt + opts.ttlMs), and make getSession return undefined " +
  "(and forget the session) once Date.now() >= expiresAt. Update the existing caller in src/api/routes.ts to pass `{ ttlMs: 60 * 60 * 1000 }`, and update " +
  'test/session.test.ts for the new signature with one extra test for expiry. Run `node --test "test/**/*.test.ts"`, then reply with a one-line summary. Only touch those three files.';
const PROMPT_B1 =
  "Task T-2 (signup): add `POST /api/signup` taking a JSON body {email, name, password}. It registers the user with createUser from src/auth/users.ts and signs them in " +
  "right away by starting a session the same way login in src/api/routes.ts does, responding 201 with {token, user: publicUser(user)}; a UserError becomes 400 {error}. " +
  "Add the route to the accountRoutes array in src/api/account.ts and add test/signup.test.ts. For now ONLY read the relevant files and reply with a short plan that " +
  "includes the exact code you will write. Do not edit any file yet.";
const PROMPT_B2 = 'Implement your plan now (use apply_patch for edits). Run `node --test "test/**/*.test.ts"`, then reply with what you changed and anything that differed from your plan.';

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").toLowerCase();
const work = join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-m1-baseline-${stamp}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(work, { recursive: true });
symlinkSync(join(REPO, "node_modules"), join(work, "node_modules"));
const origin = join(work, "origin");
cpSync(join(REPO, "demo/target-app"), origin, { recursive: true });
git(origin, "init", "-q", "-b", "main");
git(origin, "config", "user.email", "demo@weft.invalid");
git(origin, "config", "user.name", "weft demo");
git(origin, "add", "-A");
git(origin, "commit", "-qm", "target-app: initial");
const dirA = join(work, "agent-a");
const dirB = join(work, "agent-b");
git(origin, "worktree", "add", "-q", dirA, "-b", "agent-a");
git(origin, "worktree", "add", "-q", dirB, "-b", "agent-b");
log(`work ${work} — Weft OFF (no coordinator, no hooks)`);

const t0 = Date.now();
const marks = {};
const mark = (k) => (marks[k] = Math.round((Date.now() - t0) / 1000));
log("B1 (codex): read + plan");
const b1 = await codex(dirB, join(OUT, "b1-plan.jsonl"), PROMPT_B1);
mark("b1_done_s");
const thread = b1.lines.find((l) => l.thread_id)?.thread_id;
log("A (claude): change createSession's signature");
const a = A_HARNESS === "codex" ? await codex(dirA, join(OUT, "a-expiry.jsonl"), PROMPT_A) : await claude(dirA, join(OUT, "a-expiry.jsonl"), PROMPT_A);
mark("a_done_s");
log(`B2 (codex resume ${thread}): implement`);
const b2 = thread ? await codex(dirB, join(OUT, "b2-implement.jsonl"), PROMPT_B2, thread) : { code: -1, lines: [] };
mark("b2_done_s");

const commit = (dir, msg) => {
  git(dir, "add", "-A");
  return tryRun("git", ["-C", dir, "commit", "-qm", msg], dir).code === 0 ? git(dir, "rev-parse", "--short", "HEAD") : null;
};
const shaA = commit(dirA, "auth: sessions expire (T-1)");
const shaB = commit(dirB, "api: POST /api/signup (T-2)");
const checks = (cwd) => ({ tsc: tryRun(TSC, ["-p", "."], cwd), test: tryRun(process.execPath, ["--test", "test/**/*.test.ts"], cwd) });
const perBranch = { a: checks(dirA), b: checks(dirB) };
const merge = (branch) => {
  const r = tryRun("git", ["-C", origin, "merge", "--no-ff", "--no-edit", branch], origin);
  if (r.code !== 0) tryRun("git", ["-C", origin, "merge", "--abort"], origin);
  return { ok: r.code === 0, out: r.out.trim() };
};
const mergeA = merge("agent-a");
const mergeB = merge("agent-b");
const merged = checks(origin);
const bCall = (tryRun("grep", ["-rn", "createSession(", "src/api/account.ts"], origin).out || "").trim();
writeFileSync(
  join(OUT, "landing.txt"),
  [
    `--- Weft OFF. agent-a commit ${shaA}, agent-b commit ${shaB}`,
    `--- agent-a alone: tsc exit ${perBranch.a.tsc.code}, tests exit ${perBranch.a.test.code}`,
    `--- agent-b alone: tsc exit ${perBranch.b.tsc.code}, tests exit ${perBranch.b.test.code}`,
    `--- merge agent-a: ${mergeA.ok ? "ok" : "CONFLICT"}; merge agent-b: ${mergeB.ok ? "ok" : "CONFLICT"}`,
    `--- main after both merges: tsc exit ${merged.tsc.code}`,
    merged.tsc.out.trim(),
    `--- main: node --test exit ${merged.test.code}`,
    merged.test.out.split("\n").filter((l) => /^(ℹ|✔|✖)/.test(l)).join("\n"),
    `--- main:src/api/account.ts createSession calls`,
    bCall,
    "",
  ].join("\n"),
);
const summary = {
  weft: "off",
  agents: { a: A_HARNESS, b: "codex" },
  work,
  harness_exit: { a: a.code, b1: b1.code, b2: b2.code },
  seconds: marks,
  merged_cleanly: mergeA.ok && mergeB.ok,
  checks: { a: { tsc: perBranch.a.tsc.code, test: perBranch.a.test.code }, b: { tsc: perBranch.b.tsc.code, test: perBranch.b.test.code }, main: { tsc: merged.tsc.code, test: merged.test.code } },
  broken_after_merge: mergeA.ok && mergeB.ok && (merged.tsc.code !== 0 || merged.test.code !== 0),
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
log(JSON.stringify(summary));
console.log(`WORK=${work}`);
