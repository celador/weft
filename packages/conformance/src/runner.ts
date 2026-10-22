// Fixture runner: drives one hook command through the core fixtures in a dialect and
// computes the capability report (hooks-core-v0 §11).
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities, CapabilityLevel } from "@weft/protocol";
import { HOOKS_CORE_VERSION, type CoreDecision, type CoreEvent, type CoreEventName, type CoreTool } from "./core";
import { dialect as getDialect, type Dialect, type RawResult } from "./dialects";
import { Oracle, REPO, makeWorkspace, type Workspace } from "./oracle";

export const RUNNER_VERSION = "0.1.0";

type DecisionExpect = { decision: "allow" | "advise" | "deny" | "not-deny" | "any"; explanation?: string[] };

export type Step =
  | { event: CoreEventName; prompt?: string; expect?: DecisionExpect }
  | { tool: Omit<CoreTool, "call_id">; expect_pre?: DecisionExpect; expect_post?: DecisionExpect; expect_any?: DecisionExpect; expect_applied?: boolean; apply?: boolean }
  | { peer: string; leave?: boolean }
  | { oracle: "down" }
  | { expect_join: Record<string, never> }
  | { expect_log: { agent?: string; kind?: string; status?: string; mode?: string; files_include?: string; reads_include?: string; min?: number; max?: number } }
  | { expect_file: { path: string; unchanged: boolean } }
  | { raw: string; expect_raw: { valid_output: boolean } };

export type Fixture = {
  id: string;
  level: CapabilityLevel | null;
  required: boolean;
  failure?: boolean;
  spec?: string;
  title: string;
  steps: Step[];
};

export type Check = { name: string; pass: boolean; detail?: string };
export type FixtureResult = { id: string; level: CapabilityLevel | null; required: boolean; title: string; spec?: string; pass: boolean; ms: number; checks: Check[]; decisions: Array<{ event: string; decision: string; ms: number }> };

export type Report = {
  tool: "wcp-hook-conformance";
  version: string;
  hooks_core: string;
  generated_at: string;
  subject: string;
  dialect: string;
  command: string;
  setup?: string;
  env?: Record<string, string>;
  declared: { agent?: string; harness?: string; adapter?: string; capabilities?: Capabilities };
  levels: Record<"L0" | "L1" | "L2" | "L3", "pass" | "fail">;
  verified_level: number;
  honest: boolean | null;
  commit_gate: "pass" | "fail" | "n/a";
  failure_policy: string;
  latency_ms: { invocations: number; p50: number; p95: number; max: number };
  fixtures: FixtureResult[];
};

export type RunOptions = {
  dialect: string;
  command: string[];
  setup?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  only?: string[];
  subject?: string;
  fixturesDir?: string;
  keepWorkspaces?: boolean;
  log?: (line: string) => void;
};

const SELF_AGENT = "conf-agent";
const SELF_TASK = "T-2";

export function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "fixtures", "core"), join(here, "..", "fixtures", "core")]) if (existsSync(join(c, "workspace.json"))) return c;
  throw new Error("core fixtures not found");
}

/**
 * A fixture set by name or path: `core` (the default), a language set under
 * `fixtures/languages/<name>` (e.g. `python`, see docs/languages.md), or a directory.
 */
export function fixtureSetDir(name: string): string {
  if (name === "core") return fixturesDir();
  if (existsSync(join(name, "workspace.json"))) return resolve(name);
  const core = fixturesDir();
  const dir = join(core, "..", "languages", name);
  if (existsSync(join(dir, "workspace.json"))) return dir;
  throw new Error(`fixture set ${name} not found (core, a language under fixtures/languages, or a directory)`);
}

/** Language fixture sets shipped with the runner. */
export function languageFixtureSets(): string[] {
  const dir = join(fixturesDir(), "..", "languages");
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "workspace.json"))).sort() : [];
}

const ORDER = (f: Fixture) => (f.level ?? 9) * 10 + (f.required ? 0 : 1) + (f.failure ? 5 : 0);

export function loadFixtures(dir = fixturesDir()): { workspace: Workspace; fixtures: Fixture[] } {
  const workspace = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as Workspace;
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "workspace.json")
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture)
    .sort((a, b) => ORDER(a) - ORDER(b) || a.id.localeCompare(b.id));
  return { workspace, fixtures };
}

/** Make relative paths in argv absolute (the hook runs with cwd = the fixture workspace). */
export function absolutize(argv: string[], base = process.cwd()): string[] {
  return argv.map((a) => (!isAbsolute(a) && /[/\\.]/.test(a) && existsSync(resolve(base, a)) ? resolve(base, a) : a));
}

export function invoke(argv: string[], stdin: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RawResult> {
  const start = performance.now();
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      res({ stdout: "", stderr: String(err), code: null, timedOut: false, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => (stderr += String(err)));
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ stdout, stderr, code, timedOut, ms: Math.round(performance.now() - start) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function matchDecision(d: CoreDecision, e: DecisionExpect): string | undefined {
  const ok =
    e.decision === "any" ||
    (e.decision === "not-deny" ? d.decision !== "deny" : d.decision === e.decision);
  if (!ok) return `expected ${e.decision}, got ${d.decision}${d.explanation ? `: ${d.explanation.slice(0, 160).replace(/\s+/g, " ")}` : ""}`;
  for (const re of e.explanation ?? []) {
    if (!new RegExp(re, "i").test(d.explanation ?? "")) return `explanation does not match /${re}/: ${(d.explanation ?? "(none)").slice(0, 160).replace(/\s+/g, " ")}`;
  }
  return undefined;
}

function applyTool(root: string, t: Omit<CoreTool, "call_id">): string | undefined {
  const p = t.path ? (isAbsolute(t.path) ? t.path : join(root, t.path)) : undefined;
  if (t.kind === "edit" && p) {
    const text = readFileSync(p, "utf8");
    if (!text.includes(t.old_text ?? "\u0000")) return `fixture edit: old_text not found in ${t.path}`;
    writeFileSync(p, text.replace(t.old_text!, t.new_text ?? ""));
  } else if (t.kind === "write" && p) {
    writeFileSync(p, t.content ?? "");
  } else if (t.kind === "delete" && p) {
    rmSync(p, { force: true });
  }
  return undefined;
}

/**
 * Kill the heartbeat loops the adapter under test started in this workspace (they write
 * `.weft/state/<session>.heartbeat.pid`). They would exit on their own once the runner or
 * the workspace is gone; this just does it now.
 */
function stopHeartbeats(root: string): void {
  const dir = join(root, ".weft", "state");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".heartbeat.pid"));
  } catch {
    return;
  }
  for (const f of files) {
    const pid = Number(readFileSync(join(dir, f), "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export async function runFixture(fx: Fixture, ws: Workspace, d: Dialect, opts: RunOptions, latencies: number[]): Promise<{ result: FixtureResult; declared: Report["declared"]; policy: string[] }> {
  const t0 = performance.now();
  const checks: Check[] = [];
  const decisions: FixtureResult["decisions"] = [];
  const policy: string[] = [];
  const oracle = new Oracle();
  await oracle.start();
  const root = makeWorkspace(ws);
  const peers = Object.values(ws.peers).map((p) => p.agent);
  const session = `conf-${fx.id}-${Math.random().toString(36).slice(2, 8)}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const env: NodeJS.ProcessEnv = { ...process.env, WCP_URL: oracle.url, WCP_REPO: REPO, WCP_AGENT: SELF_AGENT, WCP_TASK: SELF_TASK, WCP_TOKEN: "conformance-token", WCP_WORKSPACE: root };
  for (const k of ["WEFT_TOKEN", "WEFT_URL", "WEFT_ROOT", "WEFT_MODE", "CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR", "GEMINI_PROJECT_DIR"]) delete env[k];
  Object.assign(env, opts.env ?? {});
  const argv = absolutize(opts.command);
  let n = 0;
  let stopRefusals = 0;

  const check = (name: string, err: string | undefined) => checks.push({ name, pass: !err, ...(err ? { detail: err } : {}) });

  const send = async (ev: CoreEvent, label: string): Promise<CoreDecision | undefined> => {
    const native = d.encode(ev);
    if (native === undefined) {
      decisions.push({ event: ev.event, decision: "unsupported", ms: 0 });
      return undefined;
    }
    const raw = await invoke(argv, JSON.stringify(native), root, env, timeoutMs);
    latencies.push(raw.ms);
    if (raw.timedOut) {
      check(`${label}: answers within ${timeoutMs} ms`, `timed out after ${timeoutMs} ms`);
      decisions.push({ event: ev.event, decision: "timeout", ms: raw.ms });
      return undefined;
    }
    const { decision, problems } = d.decode(ev, raw);
    if (problems.length) check(`${label}: wire output conforms (${d.name})`, problems.join("; "));
    decisions.push({ event: ev.event, decision: decision.decision, ms: raw.ms });
    return decision;
  };

  const event = (name: CoreEventName, extra: Partial<CoreEvent> = {}): CoreEvent => ({ hooks: HOOKS_CORE_VERSION, event: name, id: `${session}-${++n}`, session, cwd: root, harness: { name: "wcp-hook-conformance" }, ...extra });

  try {
    if (opts.setup) {
      const cmd = opts.setup.replaceAll("{url}", oracle.url).replaceAll("{repo}", REPO).replaceAll("{agent}", SELF_AGENT).replaceAll("{task}", SELF_TASK).replaceAll("{workspace}", root);
      try {
        execSync(cmd, { cwd: root, env, stdio: "pipe", timeout: 60_000 });
      } catch (err) {
        const e = err as { stderr?: Buffer; message: string };
        check("setup command succeeds", (e.stderr?.toString() || e.message).slice(0, 300));
        throw new Error("setup failed");
      }
    }
    for (const step of fx.steps) {
      if ("event" in step) {
        const ev = event(step.event, {
          ...(step.event === "prompt.submit" ? { prompt: step.prompt ?? "continue" } : {}),
          ...(step.event === "agent.stop" ? { stop: { repeat: stopRefusals } } : {}),
          ...(step.event === "session.end" ? { reason: "exit" } : {}),
        });
        const dec = await send(ev, step.event);
        if (step.event === "agent.stop") stopRefusals = dec?.decision === "deny" ? stopRefusals + 1 : 0;
        if (fx.failure && dec && (step.event === "agent.stop")) policy.push(dec.decision);
        if (step.expect) {
          const unsupported = decisions.at(-1)?.decision === "unsupported";
          if (dec) check(`${step.event}: ${step.expect.decision}`, matchDecision(dec, step.expect));
          else if (unsupported) check(`${step.event}: ${step.expect.decision}`, step.expect.decision === "any" || step.expect.decision === "not-deny" ? undefined : "host has no hook point for this event");
          else if (step.expect.decision !== "any") check(`${step.event}: ${step.expect.decision}`, "no decision (timed out)");
        }
      } else if ("tool" in step) {
        const call_id = `call-${n + 1}`;
        const tool: CoreTool = { ...step.tool, call_id };
        const pre = await send(event("tool.pre", { tool }), `tool.pre ${tool.kind}`);
        if (fx.failure && pre) policy.push(pre.decision);
        if (step.expect_pre) check(`tool.pre ${tool.kind}: ${step.expect_pre.decision}`, pre ? matchDecision(pre, step.expect_pre) : step.expect_pre.decision === "not-deny" || step.expect_pre.decision === "any" ? undefined : "no decision (unsupported or timed out)");
        const applied = pre?.decision !== "deny" && step.apply !== false;
        if (step.expect_applied !== undefined) check(`tool ${tool.kind} ${step.expect_applied ? "runs" : "does not run"}`, applied === step.expect_applied ? undefined : `tool ${applied ? "ran" : "was blocked"}`);
        let post: CoreDecision | undefined;
        if (applied) {
          const err = applyTool(root, step.tool);
          if (err) check("fixture applies", err);
          post = await send(event("tool.post", { tool: { ...tool, output: "ok" } }), `tool.post ${tool.kind}`);
          if (step.expect_post) check(`tool.post ${tool.kind}: ${step.expect_post.decision}`, post ? matchDecision(post, step.expect_post) : step.expect_post.decision === "any" ? undefined : "no decision");
        } else if (step.expect_post) check(`tool.post ${tool.kind}: ${step.expect_post.decision}`, "tool did not run");
        if (step.expect_any) {
          const errs = [pre, post].filter((x): x is CoreDecision => !!x).map((x) => matchDecision(x, step.expect_any!));
          check(`tool ${tool.kind} (pre or post): ${step.expect_any.decision}`, errs.some((e) => !e) ? undefined : errs.at(-1) ?? "no decision");
        }
      } else if ("peer" in step) {
        const p = ws.peers[step.peer];
        if (!p) throw new Error(`unknown peer ${step.peer}`);
        oracle.peer(p, { leave: step.leave === true });
      } else if ("oracle" in step) {
        await oracle.down();
      } else if ("expect_join" in step) {
        const decl = oracle.declared(peers);
        const join = oracle.coord.log.find((r) => r.kind === "join" && r.agent && !peers.includes(r.agent));
        const lvl = decl.capabilities?.level;
        check("session joined with a capability declaration", join && typeof lvl === "number" && lvl >= 0 && lvl <= 3 ? undefined : join ? "hello without a valid capabilities.level" : "no session opened (no join record)");
      } else if ("expect_log" in step) {
        const q = step.expect_log;
        const self = oracle.declared(peers).agent;
        const recs = oracle.coord.log.filter((r) => {
          if (q.agent === "$SELF" ? !r.agent || peers.includes(r.agent) || (self !== undefined && r.agent !== self) : q.agent && r.agent !== q.agent) return false;
          if (q.kind && r.kind !== q.kind) return false;
          if (q.status && r.status !== q.status) return false;
          if (q.mode && r.mode !== q.mode) return false;
          if (q.files_include && !r.files.some((f) => f.endsWith(q.files_include!))) return false;
          if (q.reads_include && !r.reads.includes(q.reads_include)) return false;
          return true;
        });
        const min = q.min ?? 0;
        const max = q.max ?? Infinity;
        const desc = [q.kind, q.status, q.mode, q.files_include, q.reads_include].filter(Boolean).join(" ");
        check(`coordinator log: ${max === 0 ? "no" : `≥${min}`} ${desc || "record"} by the agent`, recs.length >= min && recs.length <= max ? undefined : `found ${recs.length}`);
      } else if ("expect_file" in step) {
        const now = readFileSync(join(root, step.expect_file.path), "utf8");
        check(`${step.expect_file.path} unchanged on disk`, now === ws.files[step.expect_file.path] ? undefined : "file changed");
      } else if ("raw" in step) {
        const raw = await invoke(argv, step.raw, root, env, timeoutMs);
        latencies.push(raw.ms);
        decisions.push({ event: "raw", decision: raw.timedOut ? "timeout" : `exit ${raw.code}`, ms: raw.ms });
        let err: string | undefined;
        if (raw.timedOut) err = `timed out after ${timeoutMs} ms`;
        else if (raw.code !== 0 && raw.code !== 1) err = `exit ${raw.code}`;
        else if (raw.stdout.trim()) {
          try {
            JSON.parse(raw.stdout);
          } catch {
            err = `stdout is not JSON: ${raw.stdout.slice(0, 80)}`;
          }
        }
        check("malformed input: exits in time with empty or JSON output", err);
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.message === "setup failed")) check("fixture ran", err instanceof Error ? err.message : String(err));
  } finally {
    // Close the session politely (unchecked), then tear down.
    try {
      if (!fx.failure) await send(event("session.end", { reason: "exit" }), "session.end");
    } catch {
      /* ignore */
    }
    await oracle.stop();
    stopHeartbeats(root);
    if (!opts.keepWorkspaces) rmSync(root, { recursive: true, force: true });
  }
  const declared = oracle.declared(peers);
  // session.end is a courtesy call; its wire problems still count, its decision does not.
  const result: FixtureResult = { id: fx.id, level: fx.level, required: fx.required, title: fx.title, ...(fx.spec ? { spec: fx.spec } : {}), pass: checks.length > 0 && checks.every((c) => c.pass), ms: Math.round(performance.now() - t0), checks, decisions };
  return { result, declared, policy };
}

export async function run(opts: RunOptions): Promise<Report> {
  const d = getDialect(opts.dialect);
  const { workspace, fixtures } = loadFixtures(opts.fixturesDir);
  const chosen = opts.only?.length ? fixtures.filter((f) => opts.only!.includes(f.id)) : fixtures;
  const latencies: number[] = [];
  const results: FixtureResult[] = [];
  let declared: Report["declared"] = {};
  const policy: string[] = [];
  for (const fx of chosen) {
    opts.log?.(`… ${fx.id}`);
    const r = await runFixture(fx, workspace, d, opts, latencies);
    results.push(r.result);
    if (!declared.capabilities && r.declared.capabilities) declared = r.declared;
    policy.push(...r.policy);
    opts.log?.(`${r.result.pass ? "PASS" : "FAIL"} ${fx.id} (${r.result.ms} ms)${r.result.pass ? "" : `\n${r.result.checks.filter((c) => !c.pass).map((c) => `     ✗ ${c.name}: ${c.detail ?? ""}`).join("\n")}`}`);
  }
  const levelPass = (l: number) => results.filter((r) => r.required && r.level === l).every((r) => r.pass) && results.some((r) => r.required && r.level === l);
  const levels = { L0: levelPass(0), L1: levelPass(1), L2: levelPass(2), L3: levelPass(3) };
  let verified = -1;
  for (const l of [0, 1, 2, 3]) {
    if (levels[`L${l}` as keyof typeof levels]) verified = l;
    else break;
  }
  const cg = results.find((r) => r.id === "X.commit-gate");
  const failRes = results.find((r) => r.id === "F.coordinator-unreachable");
  const failure_policy = !failRes ? "not tested" : policy.length === 0 ? "no decisions" : policy.every((p) => p !== "deny") ? "fail-open" : policy.every((p) => p === "deny") ? "fail-closed" : "mixed";
  const declaredLevel = declared.capabilities?.level;
  // Reports are committed: show paths relative to where the runner was started.
  const rel = (s: string) => s.replaceAll(`${process.cwd()}/`, "");
  return {
    tool: "wcp-hook-conformance",
    version: RUNNER_VERSION,
    hooks_core: HOOKS_CORE_VERSION,
    generated_at: new Date().toISOString(),
    subject: opts.subject ?? rel(opts.command.join(" ")),
    dialect: d.name,
    command: rel(opts.command.join(" ")),
    ...(opts.setup ? { setup: rel(opts.setup) } : {}),
    ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
    declared,
    levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, v ? "pass" : "fail"])) as Report["levels"],
    verified_level: verified,
    honest: typeof declaredLevel === "number" ? declaredLevel <= verified : null,
    commit_gate: cg ? (cg.pass ? "pass" : "fail") : "n/a",
    failure_policy: failRes && !failRes.pass ? `${failure_policy} (with failures)` : failure_policy,
    latency_ms: { invocations: latencies.length, p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(0, ...latencies) },
    fixtures: results,
  };
}

const lvl = (n: number) => (n < 0 ? "none" : `L${n}`);

export function renderMarkdown(r: Report): string {
  const c = r.declared.capabilities;
  const lines = [
    `# Hook conformance report — ${r.subject}`,
    "",
    `Generated by \`wcp-hook-conformance ${r.version}\` (Agent Hooks Core v${r.hooks_core}) on ${r.generated_at.slice(0, 10)}.`,
    "",
    "| | |",
    "|---|---|",
    `| Dialect | \`${r.dialect}\` |`,
    `| Hook command | \`${r.command}\` |`,
    ...(r.setup ? [`| Setup | \`${r.setup}\` |`] : []),
    ...(r.env ? [`| Environment | ${Object.entries(r.env).map(([k, v]) => `\`${k}=${v}\``).join(" ")} |`] : []),
    `| Declared | ${c ? `**${lvl(c.level)}** (${r.declared.harness ?? "?"}; observe ${c.observe}, inject ${String(c.inject)}, deny_edit ${c.deny_edit}, refuse_stop ${c.refuse_stop}, commit_gate ${String(c.commit_gate)})` : "nothing (no session opened)"} |`,
    `| **Verified** | **${lvl(r.verified_level)}** — L0 ${r.levels.L0}, L1 ${r.levels.L1}, L2 ${r.levels.L2}, L3 ${r.levels.L3} |`,
    `| Declaration honest | ${r.honest === null ? "n/a" : r.honest ? "yes (declared ≤ verified)" : "**no — declares more than it delivers**"} |`,
    `| Commit gate (optional) | ${r.commit_gate} |`,
    `| Failure policy (backend down) | ${r.failure_policy} |`,
    `| Hook latency | ${r.latency_ms.invocations} invocations, p50 ${r.latency_ms.p50} ms, p95 ${r.latency_ms.p95} ms, max ${r.latency_ms.max} ms |`,
    "",
    "| Fixture | Level | Result | Decisions |",
    "|---|---|---|---|",
    ...r.fixtures.map((f) => `| \`${f.id}\` | ${f.level === null ? "failure" : `L${f.level}${f.required ? "" : " (optional)"}`} | ${f.pass ? "pass" : "**fail**"} | ${f.decisions.map((x) => `${x.event}→${x.decision}`).join(", ")} |`),
  ];
  const failed = r.fixtures.filter((f) => !f.pass);
  if (failed.length) {
    lines.push("", "## Failed checks", "");
    for (const f of failed) for (const ch of f.checks.filter((x) => !x.pass)) lines.push(`- \`${f.id}\` — ${ch.name}: ${(ch.detail ?? "").replace(/\|/g, "\\|")}`);
  }
  lines.push("", "Machine-readable: the `.json` file next to this one.", "");
  return lines.join("\n");
}
