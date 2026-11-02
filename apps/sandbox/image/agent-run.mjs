#!/usr/bin/env node
// weft agent-run: the in-container orchestrator for ONE agent run (one candidate change).
//
//   node /opt/weft/agent-run.mjs <run-dir>
//
// Reads <run-dir>/spec.json (never contains secrets), then:
//   clone the candidate's Artifacts fork -> git identity + trailers -> inject task/AGENTS.md
//   -> install the WCP adapter (claude-code) -> run the harness headless -> push new commits
//   -> write <run-dir>/result.json (atomically; its existence means "finished").
//
// Logs (the Worker ships them to R2 while the run is live):
//   <run-dir>/runner.log         NDJSON timeline: {t, step, ms?, ...}
//   <run-dir>/agent.stdout.log   harness stdout (Claude: stream-json events; Codex: --json events)
//   <run-dir>/agent.stderr.log   harness stderr
//
// Secrets: on Cloudflare the container holds none. git (fork token), the Weft adapter (agent
// token) and model calls (provider key / gateway token) authenticate because the Worker's
// Outbound entrypoint adds the credentials to matching requests. Outside Cloudflare (local
// runs, tests) WEFT_GIT_TOKEN / WEFT_TOKEN may be set in the environment; they are passed via
// GIT_CONFIG_* env / the adapter token file and never written to logs.
//
// Node >= 22, no dependencies (runs from the image and from the repo's tests).

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

const PLACEHOLDER_TOKEN = "weft-outbound-injected";

/** Exit codes of agent-run itself (the harness exit code is in result.json). */
export const EXIT = { ok: 0, spec: 2, infra: 3 };

function now() {
  return Date.now();
}

/** Redact anything that looks like a credential before it reaches a log line. */
export function redact(s, extra = []) {
  let out = String(s);
  for (const x of extra) if (x && x.length >= 8) out = out.split(x).join("***");
  return out
    .replace(/art_v1_[0-9a-f]{16,}(\?expires=\d+)?/g, "art_v1_***")
    .replace(/(authorization:\s*(bearer|basic)\s+)[^\s"']+/gi, "$1***")
    .replace(/sk-(ant-)?[A-Za-z0-9_-]{16,}/g, "sk-***");
}

export function validateSpec(spec) {
  const errs = [];
  const need = (k, v) => (typeof v === "string" && v.length > 0) || errs.push(`${k} required`);
  need("run", spec.run);
  need("harness", spec.harness);
  if (!["claude-code", "codex", "script"].includes(spec.harness)) errs.push(`unknown harness ${spec.harness}`);
  if (spec.harness === "script" && !(Array.isArray(spec.command) && spec.command.length > 0)) errs.push("script harness needs command[]");
  if (spec.harness !== "script") need("prompt", spec.prompt);
  if (spec.fork) need("fork.remote", spec.fork.remote);
  if (spec.harness !== "script" && !spec.fork) errs.push("fork required for agent harnesses");
  return errs;
}

/** The prompt handed to the harness: task, injected rules, and how to finish. */
export function buildPrompt(spec) {
  const parts = [];
  parts.push(`# Task ${spec.task ?? ""}${spec.title ? `: ${spec.title}` : ""}`.trim());
  if (spec.prompt) parts.push(spec.prompt.trim());
  if (spec.agents_md) parts.push(`## Rules for this repository (AGENTS.md injected by Weft)\n\n${spec.agents_md.trim()}`);
  const branch = spec.fork?.branch ?? "main";
  parts.push(
    [
      "## How to finish",
      "- Work in this checkout. Commit your work with `git commit` (trailers are added automatically).",
      `- You may push checkpoints with \`git push origin HEAD:${branch}\`; the runner pushes your final commits when you exit.`,
      "- Weft may report conflicts with other agents as diagnostics; resolve them before you stop.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

/** argv + env for the harness. `aig` = AI Gateway base URL (…/v1/<account>/<gateway>). */
export function harnessCommand(spec, prompt) {
  const aig = spec.ai_gateway?.base_url;
  if (spec.harness === "script") return { argv: spec.command, env: aig ? { WEFT_AIG_BASE_URL: aig } : {} };
  if (spec.harness === "claude-code") {
    const argv = ["claude", "--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--setting-sources", "user,project,local"];
    if (spec.model) argv.push("--model", spec.model);
    if (spec.max_turns) argv.push("--max-turns", String(spec.max_turns));
    argv.push("--", prompt);
    const env = {
      IS_SANDBOX: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    if (aig) {
      env.ANTHROPIC_BASE_URL = `${aig}/anthropic`;
      env.ANTHROPIC_API_KEY = PLACEHOLDER_TOKEN; // Outbound swaps in the real key (or gateway BYOK)
    }
    return { argv, env };
  }
  // codex
  const argv = ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
  if (spec.model) argv.push("-m", spec.model);
  if (aig) {
    argv.push("-c", 'model_provider="weft"');
    argv.push("-c", `model_providers.weft={name="weft-ai-gateway",base_url="${aig}/openai",env_key="OPENAI_API_KEY",wire_api="responses"}`);
  }
  argv.push(prompt);
  return { argv, env: aig ? { OPENAI_API_KEY: PLACEHOLDER_TOKEN } : {} };
}

/** Parse the harness's final outcome from its JSON event stream (best effort). */
export function parseOutcome(harness, stdout) {
  let result;
  if (harness === "script") {
    // System jobs (weft-job.mjs) print one `{"weft_job": …}` line: lift it into result.json.
    for (const line of stdout.split("\n")) {
      if (!line.startsWith('{"weft_job"')) continue;
      try {
        result = { is_error: false, weft_job: JSON.parse(line).weft_job };
      } catch {}
    }
    return result;
  }
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (harness === "claude-code" && ev.type === "result") {
      result = {
        is_error: Boolean(ev.is_error),
        subtype: ev.subtype,
        result: typeof ev.result === "string" ? ev.result.slice(0, 4000) : undefined,
        num_turns: ev.num_turns,
        duration_ms: ev.duration_ms,
        total_cost_usd: ev.total_cost_usd,
        session_id: ev.session_id,
      };
    }
    if (harness === "codex") {
      if (ev.type === "turn.completed") result = { is_error: false, usage: ev.usage };
      if (ev.type === "turn.failed" || ev.type === "error") result = { is_error: true, error: ev.error?.message ?? ev.message };
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && result === undefined) result = { is_error: false };
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") result = { ...(result ?? { is_error: false }), result: String(ev.item.text ?? "").slice(0, 4000) };
    }
  }
  return result;
}

function run(argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", opts.stdout ? "pipe" : "pipe", "pipe"],
      detached: opts.detached ?? false,
    });
    let out = "";
    let err = "";
    let timedOut = false;
    let timer;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(opts.detached ? -child.pid : child.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(opts.detached ? -child.pid : child.pid, "SIGKILL");
          } catch {}
        }, 10_000).unref();
      }, opts.timeoutMs);
    }
    if (opts.stdout) child.stdout.pipe(opts.stdout, { end: false });
    else child.stdout.on("data", (d) => (out += d));
    if (opts.stderr) child.stderr.pipe(opts.stderr, { end: false });
    else child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: out, stderr: err + String(e.message), timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), signal, stdout: out, stderr: err, timedOut });
    });
  });
}

export async function agentRun(runDir, opts = {}) {
  const spec = JSON.parse(await readFile(join(runDir, "spec.json"), "utf8"));
  const baseEnv = { ...(opts.env ?? process.env) };
  const secrets = [baseEnv.WEFT_GIT_TOKEN, baseEnv.WEFT_TOKEN].filter(Boolean);
  const runnerLog = join(runDir, "runner.log");
  const t0 = now();
  const timings = {};
  const log = async (step, extra = {}) => appendFile(runnerLog, redact(JSON.stringify({ t: now(), step, ...extra }), secrets) + "\n");
  const finish = async (result) => {
    result.timings = { ...timings, total_ms: now() - t0 };
    // Log "finished" BEFORE result.json appears: the controller treats result.json as the end of
    // every stream and does one final drain, so anything appended after it can be lost or torn.
    await log("finished", { state: result.state, harness_exit: result.harness_exit ?? null });
    await writeFile(join(runDir, "result.json.tmp"), JSON.stringify(result, null, 2));
    await rename(join(runDir, "result.json.tmp"), join(runDir, "result.json"));
    return result;
  };
  const timed = async (name, fn) => {
    const s = now();
    try {
      return await fn();
    } finally {
      timings[`${name}_ms`] = now() - s;
    }
  };

  await log("start", { run: spec.run, harness: spec.harness, task: spec.task, change: spec.change, agent: spec.agent });
  const errs = validateSpec(spec);
  if (errs.length) return finish({ state: "failed", reason: "invalid_spec", errors: errs });

  const repoDir = spec.workdir ?? join(spec.work_root ?? "/workspace", "repo");
  const gitEnv = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  if (baseEnv.WEFT_GIT_TOKEN) {
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = "http.extraHeader";
    gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${baseEnv.WEFT_GIT_TOKEN}`;
  }
  delete gitEnv.WEFT_GIT_TOKEN;
  delete gitEnv.WEFT_TOKEN;
  const g = (args, cwd = repoDir) => run(["git", ...args], { cwd, env: gitEnv });

  let base;
  const branch = spec.fork?.branch ?? "main";
  if (spec.fork) {
    // 1. clone the candidate fork
    await mkdir(dirname(repoDir), { recursive: true });
    const cl = await timed("clone", () => g(["clone", "--quiet", "--branch", branch, spec.fork.remote, repoDir], dirname(repoDir)));
    if (cl.code !== 0) {
      await log("clone_failed", { code: cl.code, stderr: redact(cl.stderr, secrets).slice(-2000) });
      return finish({ state: "failed", reason: "clone_failed", detail: redact(cl.stderr, secrets).slice(-2000) });
    }
    base = (await g(["rev-parse", "HEAD"])).stdout.trim();
    await log("cloned", { ms: timings.clone_ms, base });

    // 2. identity + trailers + local excludes
    const who = spec.git_user ?? { name: spec.agent ?? "weft-agent", email: `${spec.agent ?? "agent"}@agents.weft.dev` };
    await g(["config", "user.name", who.name]);
    await g(["config", "user.email", who.email]);
    await appendFile(join(repoDir, ".git", "info", "exclude"), "\n# weft (runner-injected)\n.weft/\nCLAUDE.local.md\n.claude/settings.local.json\n");
    const trailers = spec.trailers ?? {};
    const useAdapter = spec.harness === "claude-code" && spec.weft;
    if (!useAdapter && Object.keys(trailers).length) {
      const hook = ["#!/bin/sh", ...Object.entries(trailers).map(([k, v]) => `git interpret-trailers --in-place --if-exists doNothing --trailer ${shq(`${k}: ${v}`)} "$1"`)].join("\n") + "\n";
      await writeFile(join(repoDir, ".git", "hooks", "commit-msg"), hook);
      await chmod(join(repoDir, ".git", "hooks", "commit-msg"), 0o755);
    }

    // 3. inject task + rules
    await mkdir(join(repoDir, ".weft"), { recursive: true });
    await writeFile(join(repoDir, ".weft", "task.md"), buildPrompt(spec) + "\n");
    if (spec.agents_md) await writeFile(join(repoDir, ".weft", "AGENTS.md"), spec.agents_md);
    if (spec.harness === "claude-code") {
      const imports = [];
      if (existsSync(join(repoDir, "AGENTS.md")) && !existsSync(join(repoDir, "CLAUDE.md"))) imports.push("@AGENTS.md");
      if (spec.agents_md) imports.push("@.weft/AGENTS.md");
      if (imports.length) await writeFile(join(repoDir, "CLAUDE.local.md"), `${imports.join("\n")}\n`);
    }
    await log("context_injected", { agents_md: Boolean(spec.agents_md) });

    // 4. WCP adapter
    if (useAdapter) {
      const bundle = spec.adapter_bundle ?? "/opt/weft/adapters/claude-code/dist/weft-claude.mjs";
      const args = [process.execPath, bundle, "install", "--dir", repoDir, "--url", spec.weft.url, "--repo", spec.weft.repo ?? spec.repo, "--agent", spec.agent, "--task", spec.task ?? "adhoc"];
      if (spec.title) args.push("--title", spec.title);
      if (spec.change) args.push("--change", spec.change);
      if (spec.weft.priority !== undefined) args.push("--priority", String(spec.weft.priority));
      if (spec.weft.mode) args.push("--mode", spec.weft.mode);
      const inst = await timed("adapter", () => run(args, { cwd: repoDir, env: { ...gitEnv, WEFT_TOKEN: baseEnv.WEFT_TOKEN ?? PLACEHOLDER_TOKEN } }));
      if (inst.code !== 0) {
        await log("adapter_failed", { code: inst.code, stderr: redact(inst.stderr, secrets).slice(-2000) });
        return finish({ state: "failed", reason: "adapter_install_failed", base, detail: redact(inst.stderr + inst.stdout, secrets).slice(-2000) });
      }
      await log("adapter_installed", { ms: timings.adapter_ms, out: redact(inst.stdout, secrets).trim().slice(0, 500) });
    }
  }

  // 5. harness
  const prompt = spec.prompt ? buildPrompt(spec) : "";
  const { argv, env } = harnessCommand(spec, prompt);
  const stdoutPath = join(runDir, "agent.stdout.log");
  const stderrPath = join(runDir, "agent.stderr.log");
  const so = createWriteStream(stdoutPath, { flags: "a" });
  const se = createWriteStream(stderrPath, { flags: "a" });
  const hEnv = { ...gitEnv, ...env, WEFT_RUN: spec.run, WEFT_TASK: spec.task ?? "", WEFT_CHANGE: spec.change ?? "", WEFT_AGENT: spec.agent ?? "", HOME: baseEnv.HOME ?? "/root" };
  await log("harness_start", { argv: argv.slice(0, -1).concat(spec.harness === "script" ? argv.slice(-1) : ["<prompt>"]).map((a) => redact(a, secrets)) });
  const cwd = spec.fork ? repoDir : (spec.work_root ?? runDir);
  const h = await timed("agent", () => run(argv, { cwd, env: hEnv, stdout: so, stderr: se, detached: true, timeoutMs: (spec.timeout_s ?? 3600) * 1000 }));
  await new Promise((r) => so.end(r));
  await new Promise((r) => se.end(r));
  const outcome = parseOutcome(spec.harness, await readFile(stdoutPath, "utf8").catch(() => ""));
  await log("harness_exit", { code: h.code, timed_out: h.timedOut, ms: timings.agent_ms, outcome_error: outcome?.is_error ?? null });

  // 6. push new commits (the checkpoint Artifacts turns into a WCP `checkpoint`)
  let head = base;
  let pushed = null;
  let dirty = false;
  if (spec.fork) {
    head = (await g(["rev-parse", "HEAD"])).stdout.trim();
    dirty = (await g(["status", "--porcelain", "--untracked-files=normal"])).stdout.trim().length > 0;
    if (head !== base && spec.push !== false) {
      const p = await timed("push", () => g(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`]));
      pushed = p.code === 0 ? head : null;
      await log(p.code === 0 ? "pushed" : "push_failed", { sha: head, ms: timings.push_ms, ...(p.code === 0 ? {} : { stderr: redact(p.stderr, secrets).slice(-1000) }) });
    }
  }

  const failed = h.code !== 0 || h.timedOut || outcome?.is_error === true || (spec.fork && head !== base && spec.push !== false && !pushed);
  return finish({
    state: failed ? "failed" : "succeeded",
    reason: h.timedOut ? "timeout" : h.code !== 0 ? "harness_exit" : outcome?.is_error ? "harness_error" : failed ? "push_failed" : undefined,
    harness: spec.harness,
    harness_exit: h.code,
    outcome,
    base,
    head,
    pushed,
    dirty,
  });
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// CLI
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: agent-run.mjs <run-dir>");
    process.exit(EXIT.spec);
  }
  agentRun(dir).then(
    (r) => process.exit(r.reason === "invalid_spec" ? EXIT.spec : EXIT.ok),
    async (e) => {
      try {
        await writeFile(join(dir, "result.json"), JSON.stringify({ state: "failed", reason: "runner_crashed", detail: redact(String(e?.stack ?? e)).slice(-2000) }));
      } catch {}
      process.exit(EXIT.infra);
    },
  );
}
