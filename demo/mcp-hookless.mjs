#!/usr/bin/env node
// @weft/mcp real run (card t_70b3d8fe, docs/harness-coverage.md §2b): a hookless MCP agent next
// to a hooked Claude Code agent, against a local gateway (`pnpm dev:local`).
//
//   claude-a  worktree A, Claude Code WITH the Weft hooks adapter (L3). Changes calcTotal's
//             signature.
//   mcp-b     worktree B, Claude Code with NO Weft hooks; only the Weft MCP server is configured
//             (--strict-mcp-config, --setting-sources project, no .claude/ in the worktree).
//             Stands in for a hookless MCP harness (Zed's agent, Warp, …): it can only call
//             weft_* tools, and its own Edit/Write calls reach Weft through the embedded watcher.
//
// Timeline:
//   1. B turn 1: read + plan (its MCP server says hello, pinning B's base before A's change).
//   2. A changes calcTotal(items) -> calcTotal(items, opts) (hooked, accepted).
//   3. B turn 2 (resumed): implements a cart total. Per the server instructions it calls
//      weft_check first and receives A's squiggle (stale_assumption + A's diff). Its edits are
//      made with Claude Code's own Edit tool; the watcher reports each as a `commit` edit.
//   4. Evidence: both transcripts, the event log, the MCP server's hooks.jsonl, summary.json.
//
// Usage: node demo/mcp-hookless.mjs [--url http://localhost:8796] [--out demo/evidence/mcp]
// Env:   WEFT_ADMIN_TOKEN, else apps/gateway/.dev.vars.test. Tokens are minted per run and never
//        printed or saved in the evidence.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminToken, client, ensureBundle, BUNDLE, makeSampleRepo } from "../scripts/local-quickstart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MCP_BUNDLE = join(REPO_ROOT, "packages/mcp/dist/weft-mcp.mjs");
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const URL_ = opt("url", process.env.WEFT_URL ?? "http://localhost:8796").replace(/\/+$/, "");
const OUT = resolve(REPO_ROOT, opt("out", "demo/evidence/mcp"));
const MODEL = opt("model", "sonnet");
const log = (m) => console.log(`[mcp-demo ${new Date().toISOString().slice(11, 19)}] ${m}`);

/**
 * Env for the `claude` children. Headless runs (a launchd worker) cannot always read Claude
 * Code's keychain item themselves; on macOS fall back to its OAuth token via `security` (passed
 * through the environment only, never printed or saved).
 */
function claudeEnv() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return process.env;
  try {
    const r = spawnSync("claude", ["auth", "status"], { encoding: "utf8" }); // exits 1 when logged out
    if (JSON.parse(r.stdout || "{}").loggedIn) return process.env;
    const creds = JSON.parse(execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const token = creds?.claudeAiOauth?.accessToken;
    if (token) return { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  } catch {
    /* use the environment as is */
  }
  return process.env;
}
const CLAUDE_ENV = claudeEnv();

function claude(cwd, args, outFile, env = CLAUDE_ENV) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, scrub(out));
      if (err.trim()) writeFileSync(outFile.replace(/\.jsonl$/, ".stderr.txt"), err);
      const lines = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
      res({ code, ms: Date.now() - started, lines });
    });
  });
}

/**
 * The evidence is committed to a public repo: keep the init line's essentials only (the full
 * one lists this machine's MCP servers, plugins, skills and tools) and drop other hooks' output.
 */
function scrub(jsonl) {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      let d;
      try {
        d = JSON.parse(l);
      } catch {
        return l;
      }
      if (d.type === "system" && d.subtype === "init")
        return JSON.stringify({ type: d.type, subtype: d.subtype, session_id: d.session_id, cwd: d.cwd, model: d.model, permissionMode: d.permissionMode, claude_code_version: d.claude_code_version, mcp_servers: (d.mcp_servers ?? []).filter((m) => m.name === "weft") });
      if (d.type === "system" && /^hook_/.test(d.subtype ?? "") && !JSON.stringify(d).includes("weft")) return undefined;
      return l;
    })
    .filter(Boolean)
    .join("\n") + "\n";
}

const sessionOf = (lines) => lines.find((l) => l.type === "system" && l.subtype === "init")?.session_id;
const resultOf = (lines) => lines.findLast((l) => l.type === "result");

/** tool_use blocks (name + input) and their tool_result text, in order. */
function toolCalls(lines) {
  const calls = [];
  const byId = new Map();
  for (const l of lines) {
    for (const c of l.message?.content ?? []) {
      if (c.type === "tool_use") {
        const call = { name: c.name, input: c.input, result: undefined };
        byId.set(c.id, call);
        calls.push(call);
      }
      if (c.type === "tool_result" && byId.has(c.tool_use_id)) {
        const r = c.content;
        byId.get(c.tool_use_id).result = typeof r === "string" ? r : (r ?? []).map((x) => x.text ?? "").join("\n");
      }
    }
  }
  return calls;
}

async function main() {
  ensureBundle();
  if (!existsSync(MCP_BUNDLE)) execFileSync(process.execPath, [join(REPO_ROOT, "packages/mcp/scripts/build.mjs")], { stdio: "inherit" });
  const api = client(URL_);
  await api.health();
  const admin = adminToken();
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const repo = `mcp-demo-${stamp}`;
  await api.createRepo(admin, repo);
  const base = mkdtempSync(join(tmpdir(), "weft-mcp-demo-"));
  const { wa, wb } = makeSampleRepo(base);
  const mint = async (agent) => (await api.token(admin, { principal: agent, scopes: ["agent", "observe"], repos: [repo], agent })).token;
  const tokA = await mint("claude-a");
  const tokB = await mint("mcp-b");
  const tokObs = (await api.token(admin, { principal: `mcp-evidence-${stamp}`, scopes: ["observe"], repos: [repo] })).token;
  log(`repo ${repo} on ${URL_}; worktrees ${wa} (hooked) and ${wb} (MCP only); tokens minted, not printed`);

  // A: the Claude Code hooks adapter (L3)
  execFileSync(process.execPath, [BUNDLE, "install", "--dir", wa, "--url", URL_, "--repo", repo, "--agent", "claude-a", "--task", "T-1", "--title", "Tax-aware totals", "--priority", "1"], { env: { ...process.env, WEFT_TOKEN: tokA }, stdio: "ignore" });
  // B: no hooks. Only an MCP config; the server configures .weft/ itself on first start.
  mkdirSync(join(wb, ".weft"), { recursive: true });
  writeFileSync(join(wb, ".weft/token"), `${tokB}\n`, { mode: 0o600 });
  const mcpConfig = {
    mcpServers: {
      weft: { command: process.execPath, args: [MCP_BUNDLE, "--dir", wb, "--url", URL_, "--repo", repo, "--agent", "mcp-b", "--task", "T-2", "--title", "Cart total line"] },
    },
  };
  writeFileSync(join(base, "mcp-b.json"), JSON.stringify(mcpConfig, null, 2));
  if (existsSync(join(wb, ".claude"))) throw new Error("worktree B must not have .claude/ (no hooks)");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const common = ["--output-format", "stream-json", "--verbose", "--model", MODEL];
  const bArgs = ["--mcp-config", join(base, "mcp-b.json"), "--strict-mcp-config", "--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "mcp__weft", ...common];

  log("B turn 1: read + plan (MCP server hello pins B's base)");
  const b1 = await claude(wb, ["-p", "Read src/cart.ts and src/pricing.ts and tell me in two sentences how you would add a line with the cart total to cartSummary. Do not edit anything yet.", ...bArgs, "--max-turns", "8"], join(OUT, "b-turn1.jsonl"));
  const bSession = sessionOf(b1.lines);
  log(`B turn 1 done (exit ${b1.code}, ${Math.round(b1.ms / 1000)}s, session ${bSession})`);

  log("A: change calcTotal's signature (hooked Claude Code)");
  const a = await claude(wa, ["-p", "In src/pricing.ts, change calcTotal to take a second required parameter `opts: PriceOptions` where `export type PriceOptions = { taxRate: number }`, and return the net total times (1 + opts.taxRate). Only edit src/pricing.ts. Then commit with git.", "--setting-sources", "project,local", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(git:*)", ...common, "--max-turns", "12"], join(OUT, "a.jsonl"));
  log(`A done (exit ${a.code}, ${Math.round(a.ms / 1000)}s)`);

  log("B turn 2: implement (should weft_check first and get A's squiggle)");
  const b2 = await claude(wb, ["-p", "Now implement it: in src/cart.ts, make cartSummary also show the cart total computed with calcTotal(items) from ./pricing. Follow the Weft instructions. If Weft reports a conflict with another agent's change, adapt your code to that change instead of waiting for them. When you are done, make sure Weft lets you finish.", ...bArgs, ...(bSession ? ["--resume", bSession] : []), "--max-turns", "25"], join(OUT, "b-turn2.jsonl"));
  log(`B turn 2 done (exit ${b2.code}, ${Math.round(b2.ms / 1000)}s)`);
  await new Promise((r) => setTimeout(r, 2000)); // let the watcher's last debounce flush (the server exits with claude)

  // ----- evidence
  const page = await api.events(tokObs, repo, "?limit=500&include=diff");
  const events = page.events;
  writeFileSync(join(OUT, "events.json"), JSON.stringify(events, null, 2));
  const hooksB = existsSync(join(wb, ".weft/log/hooks.jsonl")) ? readFileSync(join(wb, ".weft/log/hooks.jsonl"), "utf8") : "";
  writeFileSync(join(OUT, "b-hooks.jsonl"), hooksB);
  if (existsSync(join(wb, ".weft/log/adapter.log"))) cpSync(join(wb, ".weft/log/adapter.log"), join(OUT, "b-adapter.log"));
  if (existsSync(join(wa, ".weft/log/adapter.log"))) cpSync(join(wa, ".weft/log/adapter.log"), join(OUT, "a-adapter.log"));
  writeFileSync(join(OUT, "b-cart.ts"), readFileSync(join(wb, "src/cart.ts"), "utf8"));
  writeFileSync(join(OUT, "a-pricing.ts"), readFileSync(join(wa, "src/pricing.ts"), "utf8"));

  const calls = [...toolCalls(b1.lines), ...toolCalls(b2.lines)];
  const weftCalls = calls.filter((c) => c.name.startsWith("mcp__weft__"));
  const checks = weftCalls.filter((c) => c.name === "mcp__weft__weft_check");
  const squiggled = checks.find((c) => /\[weft error\] stale_assumption/.test(c.result ?? ""));
  const sig = events.find((e) => e.agent === "claude-a" && e.kind === "edit" && e.status === "accepted" && e.writes.some((w) => w.kind === "signature" && w.key.endsWith("#calcTotal")));
  const bJoin = events.find((e) => e.kind === "join" && e.agent === "mcp-b");
  const aJoin = events.find((e) => e.kind === "join" && e.agent === "claude-a");
  const bEdits = events.filter((e) => e.agent === "mcp-b" && e.kind === "edit" && e.mode === "commit");
  const bChecks = events.filter((e) => e.agent === "mcp-b" && e.kind === "edit" && e.mode === "check");
  const nativeEdits = calls.filter((c) => ["Edit", "Write", "MultiEdit"].includes(c.name));
  const hookHarnesses = [...new Set(hooksB.split("\n").filter(Boolean).map((l) => JSON.parse(l).harness))];
  const summary = {
    run_at: new Date().toISOString(),
    gateway: URL_,
    repo,
    model: MODEL,
    claude_version: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    harness_b: "Claude Code with NO Weft hooks (--strict-mcp-config, --setting-sources project, no .claude/ in the worktree); only the weft MCP server",
    a_join: aJoin?.payload,
    b_join: bJoin?.payload,
    b_hooks_jsonl_harnesses: hookHarnesses,
    signature_change: sig ? { seq: sig.seq, summary: sig.summary } : null,
    b_weft_tool_calls: weftCalls.map((c) => c.name.replace("mcp__weft__", "")),
    b_native_edit_calls: nativeEdits.map((c) => `${c.name} ${c.input?.file_path ?? ""}`),
    b_check_with_squiggle: squiggled ? { input_path: squiggled.input.path, result_excerpt: squiggled.result.split("\n").filter((l) => /\[weft (error|warning)\]|REJECT|changed src\/pricing/.test(l)).slice(0, 6) } : null,
    b_check_records: bChecks.map((e) => ({ seq: e.seq, status: e.status, codes: e.diagnostics.map((d) => d.code), caused_by: e.diagnostics.map((d) => d.caused_by_seq) })),
    b_watcher_edits: bEdits.map((e) => ({ seq: e.seq, status: e.status, files: e.files, tool: e.tool, codes: e.diagnostics.map((d) => d.code) })),
    b_final_result: resultOf(b2.lines)?.result?.slice(0, 600) ?? null,
    exit: { b1: b1.code, a: a.code, b2: b2.code },
  };
  summary.checks = {
    b_is_l0_mcp: bJoin?.payload?.level === 0 && /^mcp/.test(bJoin?.payload?.harness ?? ""),
    a_is_hooked_l3: aJoin?.payload?.level === 3,
    no_claude_code_hooks_in_b: !hookHarnesses.includes("claude-code"),
    b_called_weft_check: checks.length > 0,
    b_got_a_squiggle: !!squiggled && !!sig && squiggled.result.includes(`#${sig.seq}`),
    b_unannounced_edits_in_log: bEdits.length > 0 && bEdits.every((e) => e.tool?.name === "Write" && String(e.tool?.call_id).startsWith("watch-")),
    b_used_native_edit_tool: nativeEdits.length > 0,
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  for (const [k, v] of Object.entries(summary.checks)) log(`${v ? "ok  " : "FAIL"} ${k}`);
  log(`evidence: ${OUT}`);
  if (!Object.values(summary.checks).every(Boolean)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
