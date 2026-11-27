import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CART_LINE, NEW_CALL, OLD_CALL, PRICING_V1, adapterLog, checkout, coordinator, gitCommit, gitLog, installed, joinedAgents } from "../../claude-code/test/translator-kit";
import { byPathHookArgs } from "../../claude-code/src/config";
import { pluginSource } from "../src/plugin";
import { fromCore, patchFiles, toCore } from "../src/translate";
import { CAPABILITIES, PLUGIN_REL } from "../src/cli";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-opencode.mjs");

describe("OpenCode message translation", () => {
  it("maps OpenCode tools (edit/write/multiedit/bash) onto the core", () => {
    const [edit] = toCore({ kind: "before", sessionID: "s", callID: "c", tool: "edit", args: { filePath: "/p/a.ts", oldString: "a", newString: "b", replaceAll: false }, directory: "/p" });
    expect(edit).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b", replace_all: false }, tool_use_id: "c", cwd: "/p" });
    expect(toCore({ kind: "before", sessionID: "s", tool: "write", args: { filePath: "/p/a.ts", content: "x" } })[0]).toMatchObject({ tool_name: "Write", tool_input: { file_path: "/p/a.ts", content: "x" } });
    expect(toCore({ kind: "before", sessionID: "s", tool: "multiedit", args: { filePath: "/p/a.ts", edits: [{ filePath: "/p/a.ts", oldString: "a", newString: "b" }] } })[0]).toMatchObject({ tool_name: "MultiEdit", tool_input: { edits: [{ old_string: "a", new_string: "b" }] } });
    expect(toCore({ kind: "before", sessionID: "s", tool: "bash", args: { command: "git commit -m x", description: "commit" } })[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
    expect(toCore({ kind: "before", sessionID: "s", tool: "read", args: { filePath: "/p/a.ts" } })).toEqual([]);
    expect(toCore({ kind: "idle", sessionID: "s" })).toEqual([{ hook_event_name: "Stop", session_id: "s", cwd: undefined }]);
  });

  it("apply_patch: no pre-edit check, one post-edit commit per file", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch\n";
    expect(patchFiles(patch)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(toCore({ kind: "before", sessionID: "s", callID: "c", tool: "apply_patch", args: { patchText: patch } })).toEqual([]);
    expect(toCore({ kind: "after", sessionID: "s", callID: "c", tool: "apply_patch", args: { patchText: patch } }).map((h) => [h.tool_name, h.tool_input?.file_path, h.tool_use_id])).toEqual([
      ["Write", "src/a.ts", "c#0"],
      ["Write", "src/b.ts", "c#1"],
    ]);
  });

  it("maps answers: deny throws, warnings carry to the after-hook, stop block becomes a prompt", () => {
    expect(fromCore("before", [{ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } }]).answer).toEqual({ deny: "no" });
    expect(fromCore("before", [{ hookSpecificOutput: { additionalContext: "warn" } }])).toEqual({ answer: {}, carry: "warn" });
    expect(fromCore("after", [{ hookSpecificOutput: { additionalContext: "ctx" } }], "warn").answer).toEqual({ append: "warn\nctx" });
    expect(fromCore("idle", [{ decision: "block", reason: "not done" }]).answer).toEqual({ prompt: "not done" });
    expect(fromCore("system", [{ hookSpecificOutput: { additionalContext: "welcome" } }]).answer).toEqual({ system: "welcome" });
    expect(CAPABILITIES.level).toBe(3);
  });
});

type Plugin = (ctx: { client: unknown; directory: string }) => Promise<Record<string, (...a: any[]) => Promise<void>>>;

describe("OpenCode plugin end to end (generated plugin loaded as OpenCode would, real bundle, local coordinator)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("welcome in the system prompt; stale edit throws; commit/stop refused while open; fixed edit committed; trailers", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root, out } = installed(BUNDLE, "opencode", url, "opencode-c");
    expect(out).toContain("installed opencode adapter");
    const pluginPath = join(root, PLUGIN_REL);
    expect(readFileSync(pluginPath, "utf8")).toContain("weft-opencode: generated");
    expect(readFileSync(join(root, ".git/info/exclude"), "utf8")).toContain(PLUGIN_REL);

    const prompts: Array<{ id: string; text: string }> = [];
    const client = { session: { prompt: async (r: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => void prompts.push({ id: r.path.id, text: r.body.parts[0]!.text }) } };
    const mod = (await import(pathToFileURL(pluginPath).href)) as { WeftPlugin: Plugin };
    const hooks = await mod.WeftPlugin({ client, directory: root });

    const sys = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_1", model: {} }, sys);
    expect(sys.system[0]).toContain("agent opencode-c");
    const sys2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_1", model: {} }, sys2);
    expect(sys2.system[0]!.split("\n")).toHaveLength(1); // later requests: the one-line notice only
    expect(coord.log.find((r) => r.kind === "join")?.payload).toMatchObject({ harness: "opencode", level: 3 });

    const sigSeq = changeSignature();
    const cart = join(root, "src/cart.ts");
    const stale = { filePath: cart, oldString: CART_LINE, newString: OLD_CALL, replaceAll: false };
    await expect(hooks["tool.execute.before"]!({ tool: "edit", sessionID: "ses_1", callID: "call_1" }, { args: stale })).rejects.toThrow(/stale_assumption src\/cart\.ts:4:19[\s\S]*event #/);
    expect(readFileSync(cart, "utf8")).not.toContain("calcTotal(items)");
    expect(coord.log.find((r) => r.agent === "opencode-c" && r.status === "rejected")!.diagnostics![0]!.caused_by_seq).toBe(sigSeq);

    await expect(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "call_2" }, { args: { command: "git commit -am wip", description: "commit" } })).rejects.toThrow(/commit refused by the Weft commit gate/);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Not done (stop refusal 1/5)");

    // fixed edit: allowed, then the after-hook commits it and appends nothing alarming
    const fixed = { filePath: cart, oldString: CART_LINE, newString: NEW_CALL, replaceAll: false };
    await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "ses_1", callID: "call_3" }, { args: fixed });
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    const after = { title: "src/cart.ts", output: "Edit applied successfully.", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "ses_1", callID: "call_3", args: fixed }, after);
    const ev = coord.log.filter((r) => r.kind === "edit" && r.agent === "opencode-c" && r.mode === "commit").pop()!;
    expect(ev.status).toBe("accepted");
    expect(ev.diff).toContain(`+  ${NEW_CALL}`);

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    expect(prompts).toHaveLength(1); // nothing open: the session may stop
    const c = await gitCommit(root, "cart: total");
    expect(c.ok).toBe(true);
    expect(gitLog(root)).toMatch(/Task-Id: T-2\nAgent-Id: opencode-c/);
    await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } });
    // The session end is a leave; the coordinator may then release the change's claims (spec §7.5).
    expect(coord.log.filter((r) => r.kind !== "release").at(-1)!.kind).toBe("leave");
  }, 60_000);

  it("apply_patch is accounted after the fact against the stashed before-text", async () => {
    const { coord, url, server } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "opencode-patch", url, "opencode-d");
    const mod = (await import(pathToFileURL(join(root, PLUGIN_REL)).href + "?patch")) as { WeftPlugin: Plugin };
    const hooks = await mod.WeftPlugin({ client: { session: { prompt: async () => {} } }, directory: root });
    const patch = `*** Begin Patch\n*** Update File: src/pricing.ts\n@@\n-export function calcTotal(items: Item[]): number {\n+export function calcTotal(items: Item[], scale = 1): number {\n*** End Patch\n`;
    await hooks["tool.execute.before"]!({ tool: "apply_patch", sessionID: "ses_p", callID: "p1" }, { args: { patchText: patch } });
    const p = join(root, "src/pricing.ts");
    writeFileSync(p, PRICING_V1.replace("calcTotal(items: Item[]): number", "calcTotal(items: Item[], scale = 1): number"));
    await hooks["tool.execute.after"]!({ tool: "apply_patch", sessionID: "ses_p", callID: "p1", args: { patchText: patch } }, { title: "", output: "Success", metadata: {} });
    const ev = coord.log.find((r) => r.kind === "edit" && r.agent === "opencode-d")!;
    expect(ev.writes).toContainEqual({ key: "src/pricing.ts#calcTotal", kind: "signature" });
    expect(ev.tool).toMatchObject({ name: "Write", harness_event: "PostToolUse" });
  }, 30_000);
});

describe("OpenCode --by-path routing (issue #11: a child session edits its own joined worktree)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  /** The generated plugin, loaded as OpenCode would with `directory` = the session's directory. */
  async function plugin(dir: string, hookArgs: string[], name: string) {
    const p = join(dir, `${name}.mjs`);
    writeFileSync(p, pluginSource(process.execPath, BUNDLE, "weft-opencode", hookArgs));
    const mod = (await import(pathToFileURL(p).href)) as { WeftPlugin: Plugin };
    return mod.WeftPlugin({ client: { session: { prompt: async () => {} } }, directory: dir });
  }

  it("from a non-joined parent dir, an edit inside a joined worktree is checked as that worktree's agent; plain routing stays a no-op", async () => {
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const routed = installed(BUNDLE, "opencode-bp", url, "opencode-q", ["--by-path"]);
    expect(readFileSync(join(routed.root, PLUGIN_REL), "utf8")).toContain(JSON.stringify(["hook", "--by-path", "--url", url, "--repo", "demo", "--mode", "enforce"]));

    const parent = checkout("opencode-parent");
    const wt = installed(BUNDLE, "opencode-wt", url, "worker-w").root;
    changeSignature();
    const cart = join(wt, "src/cart.ts");
    const args = (newString: string) => ({ args: { filePath: cart, oldString: CART_LINE, newString } });

    const plainHooks = await plugin(parent, [], "plain");
    await expect(plainHooks["tool.execute.before"]!({ sessionID: "ses_child", callID: "c1", tool: "edit" }, args(OLD_CALL))).resolves.toBeUndefined();
    expect(joinedAgents(coord)).not.toContain("worker-w");

    const hooks = await plugin(parent, byPathHookArgs({ url, repo: "demo" }), "routed");
    await expect(hooks["tool.execute.before"]!({ sessionID: "ses_child", callID: "c2", tool: "edit" }, args(OLD_CALL))).rejects.toThrow(/stale_assumption src\/cart\.ts:4:19/);
    expect(joinedAgents(coord)).toContain("worker-w");

    await hooks["tool.execute.before"]!({ sessionID: "ses_child", callID: "c3", tool: "edit" }, args(NEW_CALL));
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    await hooks["tool.execute.after"]!({ sessionID: "ses_child", callID: "c3", tool: "edit", args: args(NEW_CALL).args }, { title: "", output: "ok", metadata: {} });
    expect(coord.log.filter((r) => r.kind === "edit" && r.mode === "commit").pop()).toMatchObject({ agent: "worker-w", status: "accepted", files: ["src/cart.ts"] });

    const other = await plugin(parent, byPathHookArgs({ url, repo: "other-repo" }), "other");
    await expect(other["tool.execute.before"]!({ sessionID: "ses_child", callID: "c4", tool: "edit" }, args(OLD_CALL))).resolves.toBeUndefined();
    expect(adapterLog(wt)).toContain("do not match the pinned coordinator");
  }, 60_000);

  it("apply_patch on a worktree file is stashed and accounted in that worktree, as its agent", async () => {
    const { coord, url, server } = await coordinator();
    servers.push(server);
    const parent = checkout("opencode-patch-parent");
    const wt = installed(BUNDLE, "opencode-patch-wt", url, "worker-p").root;
    const hooks = await plugin(parent, byPathHookArgs({ url, repo: "demo" }), "patch");
    const p = join(wt, "src/pricing.ts");
    const patch = `*** Begin Patch\n*** Update File: ${p}\n@@\n-export function calcTotal(items: Item[]): number {\n+export function calcTotal(items: Item[], scale = 1): number {\n*** End Patch\n`;
    await hooks["tool.execute.before"]!({ tool: "apply_patch", sessionID: "ses_c", callID: "p1" }, { args: { patchText: patch } });
    writeFileSync(p, PRICING_V1.replace("calcTotal(items: Item[]): number", "calcTotal(items: Item[], scale = 1): number"));
    await hooks["tool.execute.after"]!({ tool: "apply_patch", sessionID: "ses_c", callID: "p1", args: { patchText: patch } }, { title: "", output: "Success", metadata: {} });
    const ev = coord.log.find((r) => r.kind === "edit" && r.agent === "worker-p")!;
    expect(ev.writes).toContainEqual({ key: "src/pricing.ts#calcTotal", kind: "signature" });
    // diffed against the stashed before-text: exactly the one changed line
    expect(ev.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toEqual(["+export function calcTotal(items: Item[], scale = 1): number {"]);
  }, 30_000);
});
