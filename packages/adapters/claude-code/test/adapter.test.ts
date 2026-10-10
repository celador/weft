import { describe, expect, it, afterAll } from "vitest";
import { ReferenceCoordinator, parseNegotiate } from "@weft/protocol";
import { analyzeDiff } from "@weft/analyzer";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeChanges, unifiedDiff, importReads } from "../src/analysis";
import { ADVISORY_CAPABILITIES, CAPABILITIES, ClaudeAdapter, type HookInput } from "../src/hooks";
import { proposedText, isGitCommit } from "../src/edits";
import { locateUse, locateDeclaration, quoteDiff } from "../src/render";
import { mergeSettings } from "../src/cli";
import type { Loaded } from "../src/config";
import { CART_V1, PRICING_V1, PRICING_V2, checkout, refTransport, serve } from "./helpers";
import type { Transport } from "../src/client";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");

function adapter(root: string, agent: string, task: string, transport: Transport, priority?: number, extra: { cli?: string; sleep?: (ms: number) => Promise<void> } = {}): ClaudeAdapter {
  const loaded: Loaded = {
    root,
    token: "test",
    config: { url: "http://unused", repo: "demo", agent, task: { id: task, title: `${task} work`, ...(priority !== undefined ? { priority } : {}) }, change: `I-${agent}` },
  };
  return new ClaudeAdapter(loaded, {
    transport,
    analyze: (changes, r, p) => analyzeChanges(changes, r, p),
    diff: (rel, b, a) => unifiedDiff(rel, b, a),
    now: (() => {
      let t = 1_790_000_000_000;
      return () => (t += 5_000);
    })(),
    ...extra,
  });
}

const hook = (session: string, cwd: string, extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, cwd, ...extra });

/** Apply an Edit the way Claude Code would, around the Pre/Post hooks. */
async function edit(a: ClaudeAdapter, session: string, root: string, id: string, file: string, oldS: string, newS: string) {
  const input = { file_path: join(root, file), old_string: oldS, new_string: newS };
  const pre = await a.handle(hook(session, root, { tool_name: "Edit", tool_input: input, tool_use_id: id }));
  const spec = (pre as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput;
  if (spec?.permissionDecision === "deny") return { pre, post: undefined, applied: false };
  const p = join(root, file);
  writeFileSync(p, readFileSync(p, "utf8").replace(oldS, newS));
  const post = await a.handle(hook(session, root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input, tool_use_id: id, tool_response: {} }));
  return { pre, post, applied: true };
}

describe("analysis", () => {
  it("adds cross-file reads for relative imports and detects signature writes", () => {
    const root = checkout("an");
    const after = CART_V1.replace("return `${items.length} items`;", "return `total ${calcTotal(items)}`;");
    const sets = analyzeChanges([{ rel: "src/cart.ts", before: CART_V1, after }], root, "");
    expect(sets.reads).toContain("src/pricing.ts#calcTotal");
    expect(sets.writes).toEqual([{ key: "src/cart.ts#cartSummary", kind: "body" }]);
    const sig = analyzeChanges([{ rel: "src/pricing.ts", before: PRICING_V1, after: PRICING_V2 }], root, "");
    expect(sig.writes).toEqual(expect.arrayContaining([{ key: "src/pricing.ts#calcTotal", kind: "signature" }, { key: "src/pricing.ts#PriceOptions", kind: "new" }]));
    expect(importReads(`import * as p from "./pricing"; p.calcTotal([]);`, "src/x.ts", root)).toEqual(["src/pricing.ts#calcTotal"]);
    expect(analyzeChanges([{ rel: "README.md", before: null, after: "hi" }]).writes).toEqual([{ key: "README.md#*", kind: "new" }]);
  });

  it("unifiedDiff round-trips through the analyzer's diff reader", () => {
    const diff = unifiedDiff("src/pricing.ts", PRICING_V1, PRICING_V2);
    expect(diff).toContain("-export function calcTotal(items: Item[]): number {");
    expect(diff).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {");
    const viaDiff = analyzeDiff(diff, () => PRICING_V2);
    expect(viaDiff.writes).toEqual(analyzeChanges([{ rel: "src/pricing.ts", before: PRICING_V1, after: PRICING_V2 }]).writes);
    const created = unifiedDiff("src/new.ts", null, "export const x = 1;\n");
    expect(analyzeDiff(created, () => "export const x = 1;\n").writes).toEqual([{ key: "src/new.ts#x", kind: "new" }]);
  });
});

describe("edit tools", () => {
  it("derives proposed text for Edit, MultiEdit and Write", () => {
    expect(proposedText("Write", { content: "x" }, "old")).toBe("x");
    expect(proposedText("Edit", { old_string: "a", new_string: "b" }, "a a")).toBe("b a");
    expect(proposedText("Edit", { old_string: "a", new_string: "$&b", replace_all: true }, "a a")).toBe("$&b $&b");
    expect(proposedText("Edit", { old_string: "zz", new_string: "b" }, "a")).toBeUndefined();
    expect(proposedText("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "b c", new_string: "d" }] }, "a c")).toBe("d");
    expect(isGitCommit("git add -A && git commit -m x")).toBe(true);
    expect(isGitCommit("git -c user.name=x commit")).toBe(true);
    expect(isGitCommit("git log --grep commit")).toBe(false);
  });

  it("locates call sites and declarations, quotes the causing diff", () => {
    const after = CART_V1.replace("return `${items.length} items`;", "return `total ${calcTotal(items)}`;");
    expect(locateUse(after, CART_V1, "calcTotal")).toEqual({ start: { line: 3, character: 18 }, end: { line: 3, character: 27 } });
    expect(locateDeclaration(PRICING_V1, "calcTotal")?.start.line).toBe(2);
    const q = quoteDiff({ diff: unifiedDiff("src/pricing.ts", PRICING_V1, PRICING_V2) } as never, "src/pricing.ts#calcTotal");
    expect(q).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {");
  });
});

describe("Claude Code hooks against the reference coordinator", () => {
  it("A changes a signature; B's stale call is denied with a positioned squiggle; B adapts; gates follow open errors", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
    const t = refTransport(coord);
    const rootA = checkout("a");
    const rootB = checkout("b");
    const A = adapter(rootA, "claude-a", "T-1", t);
    const B = adapter(rootB, "claude-b", "T-2", t);

    // B starts first (its model now knows pricing.ts as of base #h)
    const startB = (await B.handle(hook("sb", rootB, { hook_event_name: "SessionStart", source: "startup" }))) as any;
    expect(startB.hookSpecificOutput.additionalContext).toContain("coordinated by Weft");
    await A.handle(hook("sa", rootA, { hook_event_name: "SessionStart", source: "startup" }));

    // A changes calcTotal's signature
    const a1 = await edit(A, "sa", rootA, "tA1", "src/pricing.ts", PRICING_V1, PRICING_V2);
    expect(a1.applied).toBe(true);
    const sigSeq = coord.log.find((r) => r.kind === "edit" && r.agent === "claude-a")!.seq;
    expect(coord.log.find((r) => r.seq === sigSeq)!.writes).toContainEqual({ key: "src/pricing.ts#calcTotal", kind: "signature" });

    // B (unaware) calls calcTotal the old way -> denied before the edit happens
    const oldCall = "return `total ${calcTotal(items)}`;";
    const b1 = await edit(B, "sb", rootB, "tB1", "src/cart.ts", "return `${items.length} items`;", oldCall);
    expect(b1.applied).toBe(false);
    const reason = (b1.pre as any).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toMatch(/\[weft error\] stale_assumption src\/cart\.ts:4:19: You use src\/pricing\.ts#calcTotal, whose signature changed/);
    expect(reason).toContain(`caused by claude-a · task T-1 · event #${sigSeq}`);
    expect(reason).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {");
    expect(readFileSync(join(rootB, "src/cart.ts"), "utf8")).toBe(CART_V1);

    // B tries to stop: refused while the error is open
    const stop1 = (await B.handle(hook("sb", rootB, { hook_event_name: "Stop", stop_hook_active: false }))) as any;
    expect(stop1.decision).toBe("block");
    expect(stop1.reason).toContain("stale_assumption");
    // and the commit gate refuses `git commit`
    const commit = (await B.handle(hook("sb", rootB, { tool_name: "Bash", tool_input: { command: "git commit -am wip" }, tool_use_id: "tB2" }))) as any;
    expect(commit.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await B.commitGate("sb")).toContain("stale_assumption");

    // the conversation ends with the error open: the session is kept for the git gate
    await B.handle(hook("sb", rootB, { hook_event_name: "SessionEnd", reason: "other" }));
    expect(coord.log.at(-1)!.kind).not.toBe("leave");
    expect(await B.commitGate("sb")).toContain("stale_assumption");

    // B adapts to the new signature -> accepted (its base advanced when the deny reached it)
    const newCall = "return `total ${calcTotal(items, { taxRate: 0 })}`;";
    const b2 = await edit(B, "sb", rootB, "tB3", "src/cart.ts", "return `${items.length} items`;", newCall);
    expect(b2.applied).toBe(true);
    expect(b2.pre).toBeUndefined();
    const bEdit = coord.log.filter((r) => r.kind === "edit" && r.agent === "claude-b" && r.mode === "commit").pop()!;
    expect(bEdit.status).toBe("accepted");
    expect(bEdit.base_seq).toBeGreaterThanOrEqual(sigSeq);
    expect(bEdit.diff).toContain("+  return `total ${calcTotal(items, { taxRate: 0 })}`;");

    // open error cleared -> stop and commit allowed
    expect(await B.handle(hook("sb", rootB, { hook_event_name: "Stop", stop_hook_active: true }))).toBeUndefined();
    expect(await B.commitGate("sb")).toBeUndefined();

    // A gets contract news? No: B only read calcTotal after A's change. A's own gate is clean.
    expect(await A.handle(hook("sa", rootA, { hook_event_name: "Stop" }))).toBeUndefined();

    // SessionEnd -> leave, then the coordinator releases the change's claims (spec §7.5).
    await B.handle(hook("sb", rootB, { hook_event_name: "SessionEnd", reason: "exit" }));
    expect(coord.log.slice(-2).map((r) => `${r.kind}${r.payload?.reason ? `:${String(r.payload.reason)}` : ""}`)).toEqual(["leave", "release:session_ended"]);
  });

  it("pushes contract_changed to a change that already uses the symbol (PostToolUse injection)", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
    const t = refTransport(coord);
    const rootA = checkout("a2");
    const rootB = checkout("b2");
    const A = adapter(rootA, "claude-a", "T-1", t);
    const B = adapter(rootB, "claude-b", "T-2", t);
    await B.handle(hook("sb", rootB, { hook_event_name: "SessionStart" }));
    await A.handle(hook("sa", rootA, { hook_event_name: "SessionStart" }));
    // B first uses calcTotal (accepted: nothing changed yet)
    const b1 = await edit(B, "sb", rootB, "tB1", "src/cart.ts", "return `${items.length} items`;", "return `total ${calcTotal(items)}`;");
    expect(b1.applied).toBe(true);
    // then A changes its signature -> B gets a pushed warning on its next hook
    await edit(A, "sa", rootA, "tA1", "src/pricing.ts", PRICING_V1, PRICING_V2);
    const post = (await B.handle(hook("sb", rootB, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(rootB, "src/pricing.ts") }, tool_use_id: "tB2" }))) as any;
    const ctx = post.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/\[weft warning\] contract_changed src\/pricing\.ts:3:17: claude-a changed the signature of src\/pricing\.ts#calcTotal/);
    expect(ctx).toContain("opts: PriceOptions");
  });

  it("fails open when the coordinator is unreachable", async () => {
    const root = checkout("fo");
    const down: Transport = new Proxy({} as Transport, { get: () => () => Promise.reject(new Error("ECONNREFUSED")) });
    const A = adapter(root, "claude-a", "T-1", down);
    const pre = (await A.handle(hook("s", root, { tool_name: "Write", tool_input: { file_path: join(root, "src/x.ts"), content: "export const x = 1;\n" }, tool_use_id: "t1" }))) as any;
    expect(pre.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(pre.hookSpecificOutput.additionalContext).toContain("coordinator unavailable");
    expect(await A.handle(hook("s", root, { hook_event_name: "Stop" }))).toBeUndefined();
  });

  it("declares L1, not L3, in hello when configured advisory (Agent Hooks Core §3.3)", async () => {
    const seen: Record<string, unknown> = {};
    for (const mode of ["enforce", "advise"] as const) {
      const root = checkout(`caps-${mode}`);
      const rec: Transport = new Proxy({} as Transport, {
        get: (_t, k) => (msg: any) => {
          if (k === "hello") seen[mode] = msg.capabilities;
          return Promise.reject(new Error("ECONNREFUSED"));
        },
      });
      const a = adapter(root, "claude-a", "T-1", rec);
      (a as any).loaded.config.mode = mode;
      await a.handle(hook("s", root, { tool_name: "Write", tool_input: { file_path: join(root, "src/x.ts"), content: "export const x = 1;\n" }, tool_use_id: "t1" }));
    }
    expect(seen.enforce).toEqual(CAPABILITIES);
    expect(seen.advise).toEqual(ADVISORY_CAPABILITIES);
    expect(ADVISORY_CAPABILITIES).toMatchObject({ level: 1, deny_edit: false, refuse_stop: false, commit_gate: false });
  });

  it("ignores files outside the checkout and inside .weft/.claude/node_modules", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const root = checkout("scope");
    const A = adapter(root, "claude-a", "T-1", refTransport(coord));
    for (const p of ["/etc/hosts.ts", join(root, ".claude/settings.json"), join(root, "node_modules/x/index.ts")])
      expect(await A.handle(hook("s", root, { tool_name: "Write", tool_input: { file_path: p, content: "x" }, tool_use_id: "t" }))).toBeUndefined();
    expect(coord.log.length).toBe(0);
  });
});

describe("installer, git hooks and the bundled CLI", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("mergeSettings replaces previous weft entries and keeps foreign hooks", () => {
    const merged = mergeSettings({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }, { hooks: [{ type: "command", command: "node /old/weft-claude.mjs hook" }] }] } }, "node /new/weft-claude.mjs hook") as any;
    expect(merged.model).toBe("x");
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("echo mine");
    expect(merged.hooks.Stop[1].hooks[0].command).toBe("node /new/weft-claude.mjs hook");
    expect(merged.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|Bash");
  });

  it("install + hook over HTTP + commit-msg trailers + pre-commit gate (real bundle, real git)", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const { url, server } = await serve(coord);
    servers.push(server);
    const root = checkout("cli");
    const env = { ...process.env, WEFT_TOKEN: "local-test-token" };
    const out = execFileSync(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "claude-b", "--task", "T-2", "--title", "cart total"], { cwd: root, env, encoding: "utf8" });
    expect(out).toContain("installed Claude Code adapter");
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(readFileSync(join(root, ".git/info/exclude"), "utf8")).toContain(".weft/\n.claude/settings.local.json\n");
    const cfg = JSON.parse(readFileSync(join(root, ".weft/claude.json"), "utf8"));
    expect(cfg.change).toMatch(/^I[0-9a-f]{40}$/);
    expect(JSON.stringify(cfg)).not.toContain("local-test-token");

    // async: the coordinator's HTTP server lives in this process
    const run = (input: object) =>
      new Promise<string>((res, rej) => {
        const child = execFile(process.execPath, [BUNDLE, "hook"], { cwd: root, encoding: "utf8" }, (err, stdout) => (err ? rej(err) : res(stdout)));
        child.stdin!.end(JSON.stringify(input));
      });
    const sh = promisify(execFile);
    const started = JSON.parse(await run({ hook_event_name: "SessionStart", session_id: "c1", cwd: root, source: "startup" }));
    expect(started.hookSpecificOutput.additionalContext).toContain("agent claude-b");

    // another agent changes the signature meanwhile (directly on the coordinator)
    const other = coord.hello({ type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: "T-1" } });
    coord.submit(other.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: other.delivered_through, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }], diff: unifiedDiff("src/pricing.ts", PRICING_V1, PRICING_V2) } });

    const pre = JSON.parse(await run({ hook_event_name: "PreToolUse", session_id: "c1", cwd: root, tool_name: "Edit", tool_use_id: "x1", tool_input: { file_path: join(root, "src/cart.ts"), old_string: "return `${items.length} items`;", new_string: "return `${calcTotal(items)}`;" } }));
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(pre.hookSpecificOutput.permissionDecisionReason).toContain("[weft error] stale_assumption src/cart.ts:4:13");

    // pre-commit refuses while the error is open; commit-msg adds trailers
    writeFileSync(join(root, "notes.txt"), "x\n");
    execFileSync("git", ["-C", root, "add", "notes.txt"]);
    let refused = "";
    try {
      await sh("git", ["-C", root, "commit", "-qm", "wip"], { cwd: root });
    } catch (err) {
      refused = String((err as { stderr?: string }).stderr);
    }
    expect(refused).toContain("weft: commit refused");
    // resolve the error by an accepted edit that reads the key
    const fixed = JSON.parse((await run({ hook_event_name: "PreToolUse", session_id: "c1", cwd: root, tool_name: "Edit", tool_use_id: "x2", tool_input: { file_path: join(root, "src/cart.ts"), old_string: "return `${items.length} items`;", new_string: "return `${calcTotal(items, { taxRate: 0 })}`;" } })) || "{}");
    expect(fixed.hookSpecificOutput?.permissionDecision).toBeUndefined();
    const cart = join(root, "src/cart.ts");
    writeFileSync(cart, readFileSync(cart, "utf8").replace("return `${items.length} items`;", "return `${calcTotal(items, { taxRate: 0 })}`;"));
    await run({ hook_event_name: "PostToolUse", session_id: "c1", cwd: root, tool_name: "Edit", tool_use_id: "x2", tool_input: { file_path: cart, old_string: "", new_string: "" }, tool_response: {} });
    await sh("git", ["-C", root, "commit", "-qam", "cart: show total"], { cwd: root });
    const msg = execFileSync("git", ["-C", root, "log", "-1", "--format=%B"], { encoding: "utf8" });
    expect(msg).toMatch(new RegExp(`Change-Id: ${cfg.change}\\nTask-Id: T-2\\nAgent-Id: claude-b`));
    await run({ hook_event_name: "SessionEnd", session_id: "c1", cwd: root });
  }, 30_000);
});

describe("negotiation from the agent's shell (spec §7.4, §7.6, §8.4)", () => {
  const CART_CALL = "return `total ${calcTotal(items)}`;";
  const OVERLOAD = `export type Item = { price: number; qty: number };
export type PriceOptions = { taxRate: number };

export function calcTotal(items: Item[]): number;
export function calcTotal(items: Item[], opts: PriceOptions): number;
export function calcTotal(items: Item[], opts: PriceOptions = { taxRate: 0 }): number {
  const net = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return net * (1 + opts.taxRate);
}
`;

  async function setup(extraB: { sleep?: (ms: number) => Promise<void> } = {}) {
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const t = refTransport(coord);
    const rootA = checkout("na");
    const rootB = checkout("nb");
    const A = adapter(rootA, "claude-a", "T-1", t, 1, { cli: "/w/a/.weft/bin/weft" });
    const B = adapter(rootB, "claude-b", "T-2", t, 0, { cli: "/w/b/.weft/bin/weft", ...extraB });
    await A.handle(hook("sa", rootA, { hook_event_name: "SessionStart" }));
    await B.handle(hook("sb", rootB, { hook_event_name: "SessionStart" }));
    // B uses calcTotal(items); A then changes its signature; B's next use is denied.
    const b1 = await edit(B, "sb", rootB, "b1", "src/cart.ts", "return `${items.length} items`;", CART_CALL);
    expect(b1.applied).toBe(true);
    writeFileSync(join(rootA, "src/pricing.ts"), PRICING_V1);
    const a1 = await edit(A, "sa", rootA, "a1", "src/pricing.ts", PRICING_V1, PRICING_V2);
    expect(a1.applied).toBe(true);
    const b2 = await edit(B, "sb", rootB, "b2", "src/cart.ts", CART_CALL, "return `sum ${calcTotal(items)}`;");
    expect(b2.applied).toBe(false);
    return { coord, rootA, rootB, A, B, b2 };
  }

  it("losing agent gets options; proposal is injected into the owner; accept binds the owner until the overload lands", async () => {
    const { coord, rootA, rootB, A, B, b2 } = await setup();
    const deny = (b2.pre as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
    expect(deny).toContain("stale_assumption");
    expect(deny).toContain("Your options: retreat");
    expect(deny).toContain('/w/b/.weft/bin/weft negotiate propose overload');
    expect(deny).toContain("negotiate escalate");

    // B proposes without naming the target: it defaults to the agent behind its open error.
    const sent = await B.negotiate("sb", parseNegotiate(["propose", "overload", "Keep calcTotal(items) compiling as an overload"]));
    expect(sent.code).toBe(0);
    const propose = coord.log.find((r) => r.kind === "negotiate.propose")!;
    expect(sent.text).toContain(`[weft] sent #${propose.seq}`);
    expect(propose.payload).toEqual({ to: { change: "I-claude-a" }, keys: ["src/pricing.ts#calcTotal"], terms: { kind: "overload", text: "Keep calcTotal(items) compiling as an overload" } });

    // A cannot stop while the proposal is unanswered; the refusal carries it and how to answer.
    const stop1 = (await A.handle(hook("sa", rootA, { hook_event_name: "Stop" }))) as { decision: string; reason: string };
    expect(stop1.decision).toBe("block");
    expect(stop1.reason).toContain(`[weft negotiation due] #${propose.seq} from claude-b`);
    expect(stop1.reason).toContain(`/w/a/.weft/bin/weft negotiate accept ${propose.seq}`);
    // ...and the next tool call injects it as context too.
    const injected = (await A.handle(hook("sa", rootA, { hook_event_name: "UserPromptSubmit" }))) as { hookSpecificOutput: { additionalContext: string } };
    expect(injected.hookSpecificOutput.additionalContext).toContain(`[weft negotiation] #${propose.seq} claude-b (change I-claude-b, task T-2) proposes to you: overload`);

    const acc = await A.negotiate("sa", parseNegotiate(["accept", String(propose.seq)]));
    expect(acc.code).toBe(0);
    const accept = coord.log.find((r) => r.kind === "negotiate.accept")!;
    expect(accept.payload).toEqual({ reply_to: propose.seq });

    // Bound by the agreement: stop is refused until the overload edit is in the log.
    const stop2 = (await A.handle(hook("sa", rootA, { hook_event_name: "Stop" }))) as { decision: string; reason: string };
    expect(stop2.reason).toContain(`agreement #${accept.seq}`);
    const a2 = await edit(A, "sa", rootA, "a2", "src/pricing.ts", PRICING_V2, OVERLOAD);
    expect(a2.applied).toBe(true);
    expect(await A.handle(hook("sa", rootA, { hook_event_name: "Stop" }))).toBeUndefined();

    // B learns of the acceptance (with what it means for it) and its old-API edit now passes.
    const inbox = await B.inbox("sb");
    expect(inbox.text).toContain(`ACCEPTED #${propose.seq}`);
    expect(inbox.text).toContain("agreed");
    const b3 = await edit(B, "sb", rootB, "b3", "src/cart.ts", CART_CALL, "return `sum ${calcTotal(items)}`;");
    expect(b3.applied).toBe(true);
    expect(await B.handle(hook("sb", rootB, { hook_event_name: "Stop" }))).toBeUndefined();
    expect(coord.log.filter((r) => r.kind.startsWith("negotiate.")).map((r) => r.summary)).toEqual([
      `claude-b → I-claude-a: proposes overload on calcTotal`,
      `claude-a accepted #${propose.seq}`,
    ]);
  });

  it("propose --wait blocks until the owner replies; escalate merges the two tasks", async () => {
    let A: ClaudeAdapter | undefined;
    let replied = false;
    const { coord, B } = await setup({
      sleep: async () => {
        if (replied || !A) return;
        replied = true;
        const p = coord.log.find((r) => r.kind === "negotiate.propose")!;
        const r = await A.negotiate("sa", parseNegotiate(["reject", String(p.seq), "I need the new signature everywhere"]));
        expect(r.code).toBe(0);
      },
    }).then((x) => ((A = x.A), x));
    const sent = await B.negotiate("sb", parseNegotiate(["propose", "overload", "Keep calcTotal(items)", "--wait", "60"]));
    expect(sent.text).toContain("rejected");
    expect(sent.text).toContain("I need the new signature everywhere");

    const esc = await B.negotiate("sb", parseNegotiate(["escalate", "We both need calcTotal; make it one task"]));
    expect(esc.code).toBe(0);
    expect(esc.text).toContain("tasks merged by the coordinator");
    const merge = coord.log.find((r) => r.kind === "control")!;
    expect(merge.payload).toMatchObject({ action: "merge", target: { changes: ["I-claude-a", "I-claude-b"] } });
    const again = await B.negotiate("sb", parseNegotiate(["escalate", "again", "--to", "claude-a"]));
    expect(again.code).toBe(1);
    expect(again.text).toContain("invalid_reference");
  });

  it("parses the CLI grammar and refuses bad input", () => {
    expect(parseNegotiate(["counter", "#12", "share", "both", "of", "us"])).toEqual({ cmd: "counter", reply_to: 12, terms: { kind: "share", text: "both of us" } });
    expect(parseNegotiate(["propose", "transfer", "give it", "--to", "codex-b", "--keys", "a.ts#x,b.ts#y"])).toEqual({
      cmd: "propose",
      terms: { kind: "transfer", text: "give it" },
      to: { agent: "codex-b" },
      keys: ["a.ts#x", "b.ts#y"],
    });
    expect(() => parseNegotiate(["propose", "bribe", "x"])).toThrow(/terms kind/);
    expect(() => parseNegotiate(["accept", "x"])).toThrow(/event number/);
  });
});
