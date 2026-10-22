#!/usr/bin/env node
// End-to-end check of the `lsp` backend (card t_082661b7, docs/languages.md "LSP enrichment"):
// two Claude Code adapters on a small Python repo, a local gateway (`pnpm dev:local`), and a real
// language server (pyright-langserver or basedpyright-langserver on PATH). Hooks are driven with
// the JSON Claude Code sends (no model), exactly like scripts/local-quickstart.mjs --demo.
//
//   node scripts/lsp-e2e.mjs [--url http://localhost:8787] [--dir DIR] [--no-lsp]
//
// --no-lsp is the negative control: WEFT_LSP=off for every hook, so only tree-sitter runs, and
// agent-b is expected to hear nothing about agent-a's calc_total change.
//
// The case tree-sitter misses: agent-b calls `calc_total` through the package re-export
// (`from shop import calc_total`) and `Pricer.quote` through an instance attribute
// (`self.pricer.quote(...)`). agent-a then changes both signatures.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEdit, client, runHook, setup } from "./local-quickstart.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const url = opt("url", process.env.WEFT_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const base = opt("dir", mkdtempSync(join(tmpdir(), "weft-lsp-e2e-")));
const noLsp = args.includes("--no-lsp");
if (noLsp) process.env.WEFT_LSP = "off"; // inherited by the hook processes

const PRICING = `class Pricer:
    def __init__(self, rate: float = 0.2) -> None:
        self.rate = rate

    def quote(self, amount: float) -> float:
        return amount * (1 + self.rate)


def calc_total(prices: list[float]) -> float:
    return sum(prices)
`;
const CART = `from shop import calc_total
from shop.pricing import Pricer


class Cart:
    def __init__(self) -> None:
        self.pricer = Pricer()
        self.prices: list[float] = []

    def total(self) -> float:
        return 0.0
`;

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
const indent = (s) => (s ? s.split("\n").map((l) => `    ${l}`).join("\n") : "    (nothing)");

function makeRepo() {
  const a = join(base, "shop");
  const b = join(base, "shop-b");
  mkdirSync(join(a, "shop"), { recursive: true });
  writeFileSync(join(a, "shop/__init__.py"), 'from .pricing import Pricer, calc_total\n\n__all__ = ["Pricer", "calc_total"]\n');
  writeFileSync(join(a, "shop/pricing.py"), PRICING);
  writeFileSync(join(a, "shop/cart.py"), CART);
  git(base, "init", "-q", "-b", "main", a);
  git(a, "config", "user.email", "lsp-e2e@weft.invalid");
  git(a, "config", "user.name", "weft lsp e2e");
  git(a, "add", "-A");
  git(a, "commit", "-qm", "shop");
  git(a, "worktree", "add", "-q", b, "-b", "agent-b");
  return { a, b };
}

const log = (dir) => {
  try {
    return readFileSync(join(dir, ".weft/log/adapter.log"), "utf8");
  } catch {
    return "";
  }
};
async function waitFor(dir, re, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = log(dir).match(re);
    if (m) return m[0];
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${re} in ${dir}/.weft/log/adapter.log`);
}
async function event(dir, repo, seq) {
  const token = readFileSync(join(dir, ".weft/token"), "utf8").trim();
  const r = await fetch(`${url}/v1/repos/${encodeURIComponent(repo)}/events/${seq}`, { headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1" } });
  return r.json();
}
const brief = (rec) => `#${rec.seq} ${rec.status} ${rec.kind} ${rec.agent} reads=${JSON.stringify(rec.reads)} writes=${JSON.stringify(rec.writes.map((w) => [w.key, w.kind]))}`;

async function main() {
  await client(url).health();
  const { a, b } = makeRepo();
  const repo = `shop-lsp-${Date.now().toString(36)}`;
  await setup({ url, repo, dirs: [a, b], agents: ["agent-a", "agent-b"] }, client(url), () => {});
  console.log(`gateway ${url}, repo ${repo}\n  agent-a ${a}\n  agent-b ${b}`);
  for (const [dir, sid] of [[a, "sa"], [b, "sb"]]) await runHook(dir, { hook_event_name: "SessionStart", session_id: sid, source: "startup" });

  console.log("\n1) agent-b: Cart.total calls calc_total (via the package re-export) and Pricer.quote (via self.pricer)");
  const b1 = await claudeEdit(b, "sb", "b1", "shop/cart.py", "return 0.0", "return self.pricer.quote(calc_total(self.prices))");
  if (b1.denied) throw new Error(`agent-b's first edit was denied:\n${b1.reason}`);
  const editSeq = Number(/commit shop\/cart\.py base #\d+ -> accept #(\d+)/.exec(log(b))?.[1]);
  console.log(`  edit (tree-sitter keys): ${brief(await event(b, repo, editSeq))}`);

  console.log("\n2) agent-a: changes calc_total's signature (adds a required `tax`)");
  const a1 = await claudeEdit(a, "sa", "a1", "shop/pricing.py", "def calc_total(prices: list[float]) -> float:", "def calc_total(prices: list[float], tax: float) -> float:");
  if (a1.denied) throw new Error(a1.reason);
  const a1Seq = Number(/commit shop\/pricing\.py base #\d+ -> accept #(\d+)/.exec(log(a))?.[1]);
  console.log(`  ${brief(await event(a, repo, a1Seq))}`);

  if (noLsp) {
    await sleep(5000);
    const heard = [
      ctx(await runHook(b, { hook_event_name: "UserPromptSubmit", session_id: "sb", prompt: "continue" })),
      ctx(await runHook(b, { hook_event_name: "PostToolUse", session_id: "sb", tool_name: "Read", tool_use_id: "r0", tool_input: { file_path: join(b, "shop/cart.py") }, tool_response: {} })),
    ].join("\n");
    console.log("\n3) WEFT_LSP=off: what agent-b hears about agent-a's change in the next 5 s:");
    console.log(indent(heard.trim()));
    const missed = !heard.includes("calc_total") && !existsSync(join(b, ".weft/lsp"));
    console.log(`\nresult:\n  ${missed ? "ok  " : "FAIL"} without the language server, agent-b is not told (tree-sitter keyed the read to the re-export)`);
    for (const [dir, sid] of [[a, "sa"], [b, "sb"]]) await runHook(dir, { hook_event_name: "SessionEnd", session_id: sid, reason: "exit" });
    if (!missed) process.exitCode = 1;
    return;
  }

  console.log("\n3) the language server's answer for agent-b's edit (asynchronous, after PostToolUse)");
  console.log(`  ${await waitFor(b, /lsp enrich #\d+ \([^)]+\):[^\n]*/)}`);
  const amended = await waitFor(b, /lsp amendment for #\d+ -> accept #(\d+)[^\n]*/);
  console.log(`  ${amended}`);
  const amendment = await event(b, repo, Number(/accept #(\d+)/.exec(amended)[1]));
  console.log(`  amendment: ${brief(amendment)}`);
  await waitFor(b, new RegExp(`lsp breakage #${a1Seq} \\([^)]+\\)[^\\n]*`));
  await sleep(300);
  const inject1 = ctx(await runHook(b, { hook_event_name: "PostToolUse", session_id: "sb", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: join(b, "shop/cart.py") }, tool_response: {} }));
  console.log("  agent-b's next hook injects:");
  console.log(indent(inject1));

  console.log("\n4) agent-a: changes Pricer.quote's signature (adds a required `currency`)");
  const a2 = await claudeEdit(a, "sa", "a2", "shop/pricing.py", "def quote(self, amount: float) -> float:", "def quote(self, amount: float, currency: str) -> float:");
  if (a2.denied) throw new Error(a2.reason);
  const a2Seq = Number([...log(a).matchAll(/commit shop\/pricing\.py base #\d+ -> accept #(\d+)/g)].at(-1)?.[1]);
  const pushed = ctx(await runHook(b, { hook_event_name: "UserPromptSubmit", session_id: "sb", prompt: "continue" }));
  console.log("  agent-b's next prompt (the amendment's read is pushed like any read):");
  console.log(indent(pushed));
  console.log(`  ${await waitFor(b, new RegExp(`lsp breakage #${a2Seq} \\([^)]+\\)[^\\n]*`))}`);
  await sleep(300);
  const inject2 = ctx(await runHook(b, { hook_event_name: "PostToolUse", session_id: "sb", tool_name: "Read", tool_use_id: "r2", tool_input: { file_path: join(b, "shop/cart.py") }, tool_response: {} }));
  console.log("  agent-b's next hook injects:");
  console.log(indent(inject2));

  console.log("\n5) session end: the daemon shuts its server down");
  for (const [dir, sid] of [[a, "sa"], [b, "sb"]]) await runHook(dir, { hook_event_name: "SessionEnd", session_id: sid, reason: "exit" });
  const end = Date.now() + 15_000;
  while (Date.now() < end && (existsSync(join(b, ".weft/lsp/daemon.lock")) || existsSync(join(a, ".weft/lsp/daemon.lock")))) await sleep(200);
  console.log(`  daemon locks gone: ${!existsSync(join(b, ".weft/lsp/daemon.lock")) && !existsSync(join(a, ".weft/lsp/daemon.lock"))}`);

  const hooks = readFileSync(join(b, ".weft/log/hooks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const post = hooks.filter((h) => h.event === "PostToolUse" && h.tool === "Edit");
  const pre = hooks.filter((h) => h.event === "PreToolUse" && h.tool === "Edit");
  console.log(`\ntimings (agent-b): PreToolUse Edit ${pre.map((h) => h.total_ms)} ms; PostToolUse Edit ${post.map((h) => h.total_ms)} ms (incl. queueing the job)`);

  const checks = [
    ["tree-sitter alone read the re-export, not the declaration", (await event(b, repo, editSeq)).reads.includes("shop/__init__.py#calc_total")],
    ["the amendment (an accepted intent) adds shop/pricing.py#calc_total and shop/pricing.py#Pricer.quote", amendment.kind === "intent" && amendment.status === "accepted" && ["shop/pricing.py#calc_total", "shop/pricing.py#Pricer.quote"].every((k) => amendment.reads.includes(k))],
    ["agent-b is warned about agent-a's earlier calc_total change (R2a)", inject1.includes("[weft warning] contract_changed shop/pricing.py#calc_total")],
    ["pyright reports the missing `tax` argument in shop/cart.py", /type_breakage shop\/cart\.py:11:\d+: \S*pyright: .*tax/.test(inject1)],
    ["agent-a's Pricer.quote change is pushed to agent-b", pushed.includes("contract_changed shop/pricing.py#Pricer.quote")],
    ["pyright reports the missing `currency` argument", /type_breakage shop\/cart\.py:11:\d+: \S*pyright: .*currency/.test(inject2)],
  ];
  console.log("\nresult:");
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
