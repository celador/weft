// Files Codex writes from the shell (`cat > f <<'EOF'`, `sed -i`, `python -`) instead of apply_patch.
// The adapter snapshots the dirty files at PreToolUse Bash and submits what the command changed at
// PostToolUse Bash, like the Claude Code adapter (cold run 2026-11, friction #2).
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { CodexAdapter, type HookInput } from "../src/hooks";
import type { Loaded } from "../src/config";
import type { Transport } from "../src/client";
import { PRICING_V2, checkout, refTransport } from "./helpers";

function adapter(root: string, agent: string, task: string, transport: Transport): CodexAdapter {
  const loaded: Loaded = { root, token: "test", config: { url: "http://unused", repo: "demo", agent, task: { id: task, title: `${task} work` }, change: `I-${agent}` } };
  // 100 ms per clock read: a pending apply_patch stays younger than the adapter's 60 s flush window.
  let t = 1_790_000_000_000;
  return new CodexAdapter(loaded, { transport, analyze: (c, r, p) => analyzeChanges(c, r, p), diff: (rel, b, a) => unifiedDiff(rel, b, a), now: () => (t += 100) });
}
const hook = (session: string, cwd: string, extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, cwd, ...extra });

const TOTAL_STALE = `import { calcTotal, type Item } from "./pricing";

export function total(items: Item[]): number {
  return calcTotal(items);
}
`;

/** Codex wraps every shell call like this (codex-cli 0.167, cold run t_673b52cf). */
const zsh = (script: string) => `/bin/zsh -lc ${JSON.stringify(script)}`;

/** One shell call the way Codex runs it: PreToolUse Bash, the command's effect, PostToolUse Bash. */
async function shell(a: CodexAdapter, session: string, root: string, id: string, command: string, effect: () => void = () => {}) {
  const pre = (await a.handle(hook(session, root, { tool_name: "Bash", tool_input: { command }, tool_use_id: id }))) as any;
  effect();
  const post = (await a.handle(hook(session, root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id, tool_response: "" }))) as any;
  return { pre, post, context: (post?.hookSpecificOutput?.additionalContext ?? "") as string };
}

/** Two Codex agents; A has committed calcTotal's new signature, B has not seen it. */
async function twoAgents(name: string) {
  const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
  const t = refTransport(coord);
  const rootA = checkout(`${name}-a`);
  const rootB = checkout(`${name}-b`);
  const A = adapter(rootA, "codex-a", "T-1", t);
  const B = adapter(rootB, "codex-b", "T-2", t);
  await B.handle(hook("sb", rootB, { hook_event_name: "SessionStart", source: "startup" }));
  await A.handle(hook("sa", rootA, { hook_event_name: "SessionStart", source: "startup" }));
  // A changes the signature with a heredoc too: its own shell write must reach the log.
  const a = await shell(A, "sa", rootA, "exec-a1", zsh(`cat > src/pricing.ts <<'EOF'\n${PRICING_V2}EOF`), () => writeFileSync(join(rootA, "src/pricing.ts"), PRICING_V2));
  expect(a.pre).toBeUndefined();
  const sig = coord.log.find((e) => e.agent === "codex-a" && e.kind === "edit");
  expect(sig).toMatchObject({ status: "accepted", mode: "commit", files: ["src/pricing.ts"], tool: { name: "Bash", call_id: "exec-a1" } });
  expect(sig!.writes.some((w) => w.key === "src/pricing.ts#calcTotal" && w.kind === "signature")).toBe(true);
  expect(sig!.diff).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {");
  return { coord, rootA, rootB, A, B };
}

const edits = (coord: ReferenceCoordinator, agent: string) => coord.log.filter((e) => e.agent === agent && e.kind === "edit" && e.mode === "commit");

// Each test loads the TypeScript analyzer and runs git several times: slow under a busy full gate.
describe("Codex shell writes (PreToolUse/PostToolUse Bash snapshot)", { timeout: 30_000 }, () => {
  it("a heredoc that creates a new file calling a symbol another agent just changed gets a stale_assumption; a sed -i fix clears it", async () => {
    const { coord, rootB, B } = await twoAgents("heredoc");
    const path = join(rootB, "src/total.ts");
    const b = await shell(B, "sb", rootB, "exec-b1", zsh(`cat > src/total.ts <<'EOF'\n${TOTAL_STALE}EOF`), () => writeFileSync(path, TOTAL_STALE));
    expect(b.context).toContain("[weft] Files your shell command changed (src/total.ts) were applied in your checkout but REJECTED");
    expect(b.context).toMatch(/\[weft error\] stale_assumption src\/total\.ts:4:\d+/);
    expect(b.context).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {"); // A's diff, quoted
    const [created] = edits(coord, "codex-b");
    expect(created).toMatchObject({ files: ["src/total.ts"], tool: { name: "Bash", call_id: "exec-b1", harness_event: "PostToolUse" } });
    expect(created!.diff).toContain("+  return calcTotal(items);");
    expect(created!.reads).toContain("src/pricing.ts#calcTotal");
    const gate = (await B.handle(hook("sb", rootB, { tool_name: "Bash", tool_input: { command: "git commit -am wip" }, tool_use_id: "exec-b2" }))) as any;
    expect(gate.hookSpecificOutput.permissionDecision).toBe("deny");

    // The file is untracked now: the next command's change is measured against the snapshot, not HEAD.
    const fixed = TOTAL_STALE.replace("calcTotal(items)", "calcTotal(items, { taxRate: 0 })");
    const f = await shell(B, "sb", rootB, "exec-b3", zsh("sed -i '' 's/calcTotal(items)/calcTotal(items, { taxRate: 0 })/' src/total.ts"), () => writeFileSync(path, fixed));
    expect(f.context).not.toContain("REJECTED");
    const last = edits(coord, "codex-b").at(-1)!;
    expect(last).toMatchObject({ status: "accepted", files: ["src/total.ts"], tool: { call_id: "exec-b3" } });
    expect(last.diff).toContain("-  return calcTotal(items);");
    expect(last.diff).toContain("+  return calcTotal(items, { taxRate: 0 });");
    const open = (await B.handle(hook("sb", rootB, { tool_name: "Bash", tool_input: { command: "git commit -am wip" }, tool_use_id: "exec-b4" }))) as any;
    expect(open?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(fixed);
  });

  it("a shell command that changes nothing submits nothing (dirty files untouched)", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const root = checkout("noop");
    const B = adapter(root, "codex-b", "T-2", refTransport(coord));
    await B.handle(hook("sb", root, { hook_event_name: "SessionStart", source: "startup" }));
    writeFileSync(join(root, "src/cart.ts"), readFileSync(join(root, "src/cart.ts"), "utf8") + "export const dirty = 1;\n"); // dirty before the call
    const before = coord.log.length;
    await shell(B, "sb", root, "exec-1", zsh("ls src && cat src/cart.ts"));
    await shell(B, "sb", root, "exec-2", zsh("rg calcTotal src"));
    expect(coord.log.slice(before).filter((e) => e.kind === "edit")).toEqual([]);
    expect(readFileSync(join(root, ".weft/state/sb.json"), "utf8")).not.toContain("exec-"); // snapshots consumed
  });

  it("an apply_patch sent through the shell is submitted once, with or without a PostToolUse", async () => {
    const { coord, rootB, B } = await twoAgents("viashell");
    // B's first try uses the old call shape: denied at PreToolUse, which also tells B about A's change.
    const cart = join(rootB, "src/cart.ts");
    const line = (call?: string) => (call ? `  return \`\${items.length} items, total \${${call}}\`;` : "  return `${items.length} items`;");
    const patch = (from: string | undefined, to: string) => `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/cart.ts\n@@\n-${line(from)}\n+${line(to)}\n*** End Patch\nPATCH`;
    const denied = (await B.handle(hook("sb", rootB, { tool_name: "Bash", tool_input: { command: patch(undefined, "calcTotal(items)") }, tool_use_id: "exec-p0" }))) as any;
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(edits(coord, "codex-b")).toEqual([]);
    const apply = (from: string | undefined, to: string) => writeFileSync(cart, readFileSync(cart, "utf8").replace(line(from), line(to)));

    // (a) Codex sends a PostToolUse Bash for it: routed as apply_patch, committed once.
    const a = await shell(B, "sb", rootB, "exec-p1", patch(undefined, "calcTotal(items, { taxRate: 0 })"), () => apply(undefined, "calcTotal(items, { taxRate: 0 })"));
    expect(a.pre?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(edits(coord, "codex-b").map((e) => e.tool?.name)).toEqual(["apply_patch"]);

    // (b) no PostToolUse (codex-cli 0.154): a parallel shell call snapshots before Codex applies the
    // patch; its PostToolUse flushes the patch from disk and leaves the file to that edit.
    await B.handle(hook("sb", rootB, { tool_name: "Bash", tool_input: { command: patch("calcTotal(items, { taxRate: 0 })", "calcTotal(items, { taxRate: 1 })") }, tool_use_id: "exec-p2" }));
    await B.handle(hook("sb", rootB, { tool_name: "Bash", tool_input: { command: zsh("npm test") }, tool_use_id: "exec-t1" }));
    apply("calcTotal(items, { taxRate: 0 })", "calcTotal(items, { taxRate: 1 })");
    expect(readFileSync(cart, "utf8")).toContain("taxRate: 1");
    await B.handle(hook("sb", rootB, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: zsh("npm test") }, tool_use_id: "exec-t1", tool_response: "ok" }));
    const after = edits(coord, "codex-b");
    expect(after.map((e) => `${e.tool?.name}:${e.tool?.call_id}`)).toEqual(["apply_patch:exec-p1", "apply_patch:exec-p2"]);

    // (c) later shell calls see the patched file in their snapshot: still nothing new.
    await shell(B, "sb", rootB, "exec-t2", zsh("git status --short"));
    expect(edits(coord, "codex-b")).toHaveLength(2);
  });

  it("replays the hook payloads codex-cli 0.167 sent for a heredoc write (same tool_use_id in Pre and Post)", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const root = checkout("fixture");
    const B = adapter(root, "codex-b", "T-2", refTransport(coord));
    const [pre, post] = readFileSync(join(__dirname, "fixtures/codex-0.167-bash-heredoc.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => ({ ...(JSON.parse(l) as HookInput), cwd: root }));
    expect(pre!.tool_use_id).toBe(post!.tool_use_id);
    await B.handle({ ...pre!, hook_event_name: "SessionStart", source: "exec" });
    await B.handle(pre!);
    writeFileSync(join(root, "hello.ts"), "export const hello = 1;\n"); // what the command did
    await B.handle(post!);
    expect(edits(coord, "codex-b")).toEqual([
      expect.objectContaining({ status: "accepted", files: ["hello.ts"], tool: expect.objectContaining({ name: "Bash", call_id: pre!.tool_use_id }) }),
    ]);
  });

  it("skips a huge dirty tree with a log line and submits nothing for that call", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const root = checkout("huge");
    const B = adapter(root, "codex-b", "T-2", refTransport(coord));
    await B.handle(hook("sb", root, { hook_event_name: "SessionStart", source: "startup" }));
    mkdirSync(join(root, "gen"));
    for (let i = 0; i < 501; i++) writeFileSync(join(root, `gen/f${i}.txt`), `${i}\n`);
    const before = coord.log.length;
    await shell(B, "sb", root, "exec-h1", zsh("cat > src/total.ts <<'EOF'\n...\nEOF"), () => writeFileSync(join(root, "src/total.ts"), TOTAL_STALE));
    expect(readFileSync(join(root, ".weft/log/adapter.log"), "utf8")).toMatch(/bash snapshot skipped: 5\d\d dirty files/);
    expect(coord.log.slice(before).filter((e) => e.kind === "edit")).toEqual([]);
  });
});
