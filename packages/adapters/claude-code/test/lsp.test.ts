// Asynchronous language-server enrichment through the hooks (src/lsp.ts), against the reference
// coordinator and the analyzer's fake language server. A real-pyright run of the same story is in
// scripts/lsp-e2e.mjs (against `pnpm dev:local`).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lspServers, type LspServerSpec } from "@weft/analyzer";
import { ReferenceCoordinator } from "@weft/protocol";
import { describe, expect, it } from "vitest";
import { analyzeChangesAsync, unifiedDiff } from "../src/analysis";
import type { Transport } from "../src/client";
import { readState, type Loaded } from "../src/config";
import { ClaudeAdapter, type HookInput } from "../src/hooks";
import { applyFileDiff, daemonPid, enqueue, LspWorker, lspEligible, runDaemon, type LspJob } from "../src/lsp";
import { refTransport } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "../../../analyzer/src/lsp/fixtures/fake-lsp.mjs");
const servers: LspServerSpec[] = [{ ...lspServers[0]!, commands: [{ name: "fake", command: process.execPath, args: [FAKE] }] }, ...lspServers.slice(1)];

const PRICING = `class Pricer:
    def __init__(self, rate):
        self.rate = rate

    def quote(self, amount):
        return amount * (1 + self.rate)


def calc_total(prices):
    return sum(prices)
`;
const CART = `from shop import calc_total
from shop.pricing import Pricer


class Cart:
    def __init__(self):
        self.pricer = Pricer()
        self.prices = []

    def total(self):
        return 0.0
`;

function pyCheckout(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `weft-lsp-${name}-`));
  mkdirSync(join(dir, "shop"));
  writeFileSync(join(dir, "shop/__init__.py"), "from .pricing import calc_total, Pricer\n");
  writeFileSync(join(dir, "shop/pricing.py"), PRICING);
  writeFileSync(join(dir, "shop/cart.py"), CART);
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@weft.invalid");
  g("config", "user.name", "weft test");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

function agent(root: string, id: string, task: string, transport: Transport) {
  const loaded: Loaded = { root, token: "test", config: { url: "http://unused", repo: "demo", agent: id, task: { id: task }, change: `I-${id}` } };
  const jobs: LspJob[] = [];
  let t = 1_790_000_000_000;
  const adapter = new ClaudeAdapter(loaded, {
    transport,
    analyze: (changes, r, p) => analyzeChangesAsync(changes, r, p),
    diff: (rel, b, a) => unifiedDiff(rel, b, a),
    now: () => (t += 5_000),
    lsp: (job) => jobs.push(job),
  });
  return { loaded, adapter, jobs };
}

const hook = (session: string, cwd: string, extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, cwd, ...extra });
const context = (out: unknown) => ((out as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext ?? "");

async function edit(a: ClaudeAdapter, session: string, root: string, id: string, file: string, oldS: string, newS: string) {
  const input = { file_path: join(root, file), old_string: oldS, new_string: newS };
  const pre = await a.handle(hook(session, root, { tool_name: "Edit", tool_input: input, tool_use_id: id }));
  if ((pre as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision === "deny") return { pre, post: undefined };
  const p = join(root, file);
  writeFileSync(p, readFileSync(p, "utf8").replace(oldS, newS));
  const post = await a.handle(hook(session, root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input, tool_use_id: id, tool_response: {} }));
  return { pre, post };
}

describe("applyFileDiff", () => {
  it("applies a peer's hunks forward, with prefix paths and line drift", () => {
    const diff = unifiedDiff("svc/shop/pricing.py", PRICING, PRICING.replace("(prices)", "(prices, tax)"));
    expect(applyFileDiff(PRICING, diff, "svc/shop/pricing.py")).toBe(PRICING.replace("(prices)", "(prices, tax)"));
    const drifted = `# a comment this checkout added\n\n${PRICING}`;
    expect(applyFileDiff(drifted, diff, "svc/shop/pricing.py")).toBe(drifted.replace("(prices)", "(prices, tax)"));
    expect(applyFileDiff(PRICING.replace("return sum(prices)", "return 0"), diff.replace("     return sum(prices)", "     return 1"), "svc/shop/pricing.py")).toBeUndefined();
    expect(applyFileDiff(PRICING, diff, "other.py")).toBeUndefined();
    expect(applyFileDiff("", unifiedDiff("n.py", null, "x = 1\n"), "n.py")).toBe("x = 1\n");
  });

  it("knows which files a server can enrich", () => {
    expect(lspEligible("shop/cart.py", process.env, servers)).toBe(true);
    expect(lspEligible("src/cart.ts", process.env, servers)).toBe(false);
    expect(lspEligible("shop/cart.py", { ...process.env, WEFT_LSP: "off" }, servers)).toBe(false);
  });
});

describe("hooks + LspWorker (fake language server)", () => {
  it("amends reads tree-sitter missed, warns about a peer's earlier signature change, pushes later ones, and reports type breakage", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
    const t = refTransport(coord);
    const A = agent(pyCheckout("a"), "claude-a", "T-1", t);
    const B = agent(pyCheckout("b"), "claude-b", "T-2", t);
    await A.adapter.handle(hook("sa", A.loaded.root, { hook_event_name: "SessionStart", source: "startup" }));
    await B.adapter.handle(hook("sb", B.loaded.root, { hook_event_name: "SessionStart", source: "startup" }));

    // B calls calc_total (through the package re-export) and Pricer.quote (through self.pricer).
    await edit(B.adapter, "sb", B.loaded.root, "b1", "shop/cart.py", "return 0.0", "return self.pricer.quote(calc_total(self.prices))");
    expect(B.jobs).toHaveLength(1);
    const job = B.jobs[0]!;
    expect(job).toMatchObject({ type: "enrich", session: "sb", seq: 3, changes: [{ rel: "shop/cart.py" }] });
    if (job.type !== "enrich") throw new Error("unreachable");
    expect(job.reads).toContain("shop/__init__.py#calc_total"); // tree-sitter's view
    expect(job.reads).not.toContain("shop/pricing.py#calc_total");

    // A changes calc_total's signature. B never read that key, so B hears nothing.
    await edit(A.adapter, "sa", A.loaded.root, "a1", "shop/pricing.py", "def calc_total(prices):", "def calc_total(prices, tax):");
    expect(context(await B.adapter.handle(hook("sb", B.loaded.root, { hook_event_name: "UserPromptSubmit", prompt: "go on" })))).toBe("");

    // The daemon's work for B's edit.
    const worker = new LspWorker(B.loaded, { transport: t, servers });
    try {
      await worker.process(job);
      const amendment = coord.log.find((r) => r.kind === "intent" && r.agent === "claude-b")!;
      expect(amendment).toMatchObject({ status: "accepted", base_seq: job.base, tool: { name: "lsp:fake" } });
      expect(amendment.reads).toEqual(["shop/pricing.py#Pricer.quote", "shop/pricing.py#calc_total"]);
      expect(amendment.diagnostics.map((d) => [d.severity, d.code, d.symbol])).toEqual([["warning", "contract_changed", "shop/pricing.py#calc_total"]]);

      // B's next hook injects what the daemon found, once.
      const injected = context(await B.adapter.handle(hook("sb", B.loaded.root, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "r1" })));
      expect(injected).toContain("[weft warning] contract_changed shop/pricing.py#calc_total");
      expect(injected).toContain("+def calc_total(prices, tax):"); // the peer's diff, quoted
      expect(injected).toMatch(/\[weft warning\] type_breakage shop\/cart\.py:11:\d+: fake: fake: calc_total takes 2 arguments — once claude-a's change #4 to shop\/pricing\.py#calc_total lands/);
      expect(readState(B.loaded.root, "sb").lspNotes).toBeUndefined();
      expect(readFileSync(join(B.loaded.root, "shop/pricing.py"), "utf8")).toBe(PRICING); // overlay was in memory only

      // A later signature change to an amended key is pushed to B; that queues a breakage check.
      await edit(A.adapter, "sa", A.loaded.root, "a2", "shop/pricing.py", "def quote(self, amount):", "def quote(self, amount, currency):");
      const pushed = context(await B.adapter.handle(hook("sb", B.loaded.root, { hook_event_name: "UserPromptSubmit", prompt: "go on" })));
      expect(pushed).toContain("contract_changed shop/pricing.py#Pricer.quote");
      const breakage = B.jobs.find((j) => j.type === "breakage")!;
      expect(breakage).toEqual({ type: "breakage", session: "sb", seq: expect.any(Number), keys: ["shop/pricing.py#Pricer.quote"] });
      await worker.process(breakage);
      const notes = readState(B.loaded.root, "sb").lspNotes ?? [];
      expect(notes.join("\n")).toMatch(/type_breakage shop\/cart\.py:11:\d+: fake: fake: quote takes 2 arguments — once claude-a's change #\d+ to shop\/pricing\.py#Pricer\.quote/);
      // Redelivery of the same item does not queue it twice.
      await B.adapter.handle(hook("sb", B.loaded.root, { hook_event_name: "UserPromptSubmit", prompt: "again" }));
      expect(B.jobs.filter((j) => j.type === "breakage")).toHaveLength(1);
    } finally {
      await worker.close();
    }
  }, 30_000);

  it("tells the writer who uses its signature change, and queues end at SessionEnd", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
    const t = refTransport(coord);
    const A = agent(pyCheckout("w"), "claude-a", "T-1", t);
    writeFileSync(join(A.loaded.root, "shop/cart.py"), CART.replace("return 0.0", "return calc_total(self.prices)"));
    await A.adapter.handle(hook("sa", A.loaded.root, { hook_event_name: "SessionStart", source: "startup" }));
    await edit(A.adapter, "sa", A.loaded.root, "a1", "shop/pricing.py", "def calc_total(prices):", "def calc_total(prices, tax):");
    const worker = new LspWorker(A.loaded, { transport: t, servers });
    try {
      await worker.process(A.jobs[0]!);
      expect(coord.log.some((r) => r.kind === "intent")).toBe(false); // nothing new to amend
      expect(readState(A.loaded.root, "sa").lspNotes).toEqual([
        "[weft info] lsp_dependents shop/pricing.py#calc_total: fake finds 1 use(s) of this signature change outside the edit: shop/cart.py#Cart.total. Update them in this change, or keep the old signature compatible.",
      ]);
    } finally {
      await worker.close();
    }
    await A.adapter.handle(hook("sa", A.loaded.root, { hook_event_name: "SessionEnd", reason: "exit" }));
    expect(A.jobs.at(-1)).toEqual({ type: "end", session: "sa" });
  }, 30_000);
});

describe("daemon", () => {
  it("runs queued jobs in order, holds one lock per checkout, and stops when the last session ends", async () => {
    const root = pyCheckout("d");
    const seen: string[] = [];
    let spawned = 0;
    const worker = { process: async (j: LspJob) => void seen.push(`${j.type}:${j.session}`), close: async () => void seen.push("close") } as unknown as LspWorker;
    enqueue(root, { type: "breakage", session: "s1", seq: 9, keys: ["k#x"] }, () => spawned++);
    enqueue(root, { type: "breakage", session: "s2", seq: 10, keys: ["k#y"] }, () => spawned++);
    expect(spawned).toBe(2); // no daemon yet: each enqueue asks for one; the lock lets only one run
    const run = runDaemon(root, worker, { pollMs: 10 });
    await new Promise((r) => setTimeout(r, 100));
    expect(daemonPid(root)).toBe(process.pid);
    expect(await Promise.race([runDaemon(root, worker, { pollMs: 10 }).then(() => "second exited"), new Promise((r) => setTimeout(() => r("timeout"), 200))])).toBe("second exited");
    enqueue(root, { type: "breakage", session: "s1", seq: 11, keys: ["k#z"] }, () => spawned++);
    expect(spawned).toBe(2); // a live daemon: no spawn
    enqueue(root, { type: "end", session: "s1" }, () => spawned++);
    enqueue(root, { type: "end", session: "s2" }, () => spawned++);
    await run;
    expect(seen).toEqual(["breakage:s1", "breakage:s2", "breakage:s1", "end:s1", "end:s2", "close"]);
    expect(daemonPid(root)).toBeUndefined();
    expect(existsSync(join(root, ".weft/lsp/daemon.lock"))).toBe(false);
  });
});

describe("breakage input from other agents", () => {
  it("ignores keys outside the checkout", async () => {
    const root = pyCheckout("x");
    const loaded: Loaded = { root, token: "t", config: { url: "http://unused", repo: "demo", agent: "b", task: { id: "T" }, change: "I-b" } };
    const asked: number[] = [];
    const transport = { event: async (seq: number) => (asked.push(seq), { seq, agent: "a", actor: { id: "a" }, diff: unifiedDiff("../evil.py", "x = 1\n", "x = 2\n") }) } as unknown as Transport;
    const worker = new LspWorker(loaded, { transport, servers });
    try {
      expect(await worker.breakageLines(7, ["../evil.py#x", "shop/../../evil.py#x", "/etc/evil.py#x"])).toEqual([]);
      expect(asked).toEqual([7]);
    } finally {
      await worker.close();
    }
  });
});
