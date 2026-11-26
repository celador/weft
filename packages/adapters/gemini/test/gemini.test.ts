// FIXTURE TESTS ONLY: payloads follow https://geminicli.com/docs/hooks/reference; no live
// Gemini CLI run backs this adapter (no usable Gemini auth on the build machine).
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CART_LINE, NEW_CALL, OLD_CALL, adapterLog, byPathArgs, checkout, coordinator, installed, joinedAgents, runBundle } from "../../claude-code/test/translator-kit";
import { callIdOf, fromCore, toCore } from "../src/translate";
import { mergeSettings } from "../src/cli";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-gemini.mjs");

describe("Gemini CLI translation (fixtures)", () => {
  it("maps write_file / replace / run_shell_command and the agent events", () => {
    const base = { session_id: "g1", cwd: "/p", transcript_path: "/t.json", timestamp: "2026-10-04T00:00:00Z" };
    expect(toCore({ ...base, hook_event_name: "BeforeTool", tool_name: "write_file", tool_input: { file_path: "/p/a.ts", content: "x" } })).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/p/a.ts", content: "x" } });
    expect(toCore({ ...base, hook_event_name: "BeforeTool", tool_name: "replace", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b", expected_replacements: 2 } })).toMatchObject({ tool_name: "Edit", tool_input: { replace_all: true } });
    expect(toCore({ ...base, hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "git commit -m x" } })).toMatchObject({ tool_name: "Bash" });
    expect(toCore({ ...base, hook_event_name: "BeforeTool", tool_name: "read_file", tool_input: { file_path: "/p/a.ts" } })).toBeUndefined();
    expect(toCore({ ...base, hook_event_name: "AfterAgent", prompt: "p", prompt_response: "r", stop_hook_active: true })).toMatchObject({ hook_event_name: "Stop", stop_hook_active: true });
    expect(toCore({ ...base, hook_event_name: "BeforeAgent", prompt: "p" })).toMatchObject({ hook_event_name: "UserPromptSubmit" });
    const a = { ...base, hook_event_name: "BeforeTool", tool_name: "replace", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } };
    expect(callIdOf(a)).toBe(callIdOf({ ...a, hook_event_name: "AfterTool" }));
  });

  it("maps outputs to the documented fields", () => {
    expect(fromCore("BeforeTool", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } }).json).toEqual({ decision: "deny", reason: "no" });
    expect(fromCore("BeforeTool", { hookSpecificOutput: { additionalContext: "w" } })).toEqual({ json: {}, carry: "w" });
    expect(fromCore("AfterTool", { hookSpecificOutput: { additionalContext: "c" } }, "w").json).toEqual({ hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: "w\nc" } });
    expect(fromCore("AfterAgent", { decision: "block", reason: "not done" }).json).toEqual({ decision: "deny", reason: "not done" });
    const s = mergeSettings({ hooks: { BeforeTool: [{ matcher: "x", hooks: [{ type: "command", command: "mine" }] }] } }, "node w.mjs hook # weft-gemini") as { hooks: Record<string, unknown[]> };
    expect(s.hooks.BeforeTool).toHaveLength(2);
    expect(mergeSettings(s, "node w2.mjs hook # weft-gemini").hooks).toMatchObject({ BeforeTool: [{ matcher: "x" }, { matcher: "write_file|replace|run_shell_command" }] });
  });
});

describe("Gemini adapter end to end with fixture payloads (real bundle, local coordinator)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("BeforeTool deny for a stale replace; AfterAgent retry while open; fixed replace accepted", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root, out } = installed(BUNDLE, "gemini", url, "gemini-e");
    expect(out).toContain("fixture-tested only");
    expect(JSON.parse(readFileSync(join(root, ".gemini/settings.json"), "utf8")).hooks.AfterAgent).toHaveLength(1);
    const base = { session_id: "g-1", cwd: root, transcript_path: "/tmp/t.json", timestamp: "2026-10-04T00:00:00Z" };
    const run = async (p: object) => JSON.parse((await runBundle(BUNDLE, root, { ...base, ...p })) || "{}");
    const start = await run({ hook_event_name: "SessionStart", source: "startup" });
    expect(start.hookSpecificOutput.additionalContext).toContain("agent gemini-e");
    changeSignature();
    const cart = join(root, "src/cart.ts");
    const deny = await run({ hook_event_name: "BeforeTool", tool_name: "replace", tool_input: { file_path: cart, old_string: CART_LINE, new_string: OLD_CALL } });
    expect(deny.decision).toBe("deny");
    expect(deny.reason).toContain("[weft error] stale_assumption src/cart.ts:4:19");
    const retry = await run({ hook_event_name: "AfterAgent", prompt: "do it", prompt_response: "done", stop_hook_active: false });
    expect(retry).toMatchObject({ decision: "deny" });
    const fixIn = { file_path: cart, old_string: CART_LINE, new_string: NEW_CALL };
    expect(await run({ hook_event_name: "BeforeTool", tool_name: "replace", tool_input: fixIn })).toEqual({});
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    await run({ hook_event_name: "AfterTool", tool_name: "replace", tool_input: fixIn, tool_response: { llmContent: "ok", returnDisplay: "ok" } });
    expect(coord.log.filter((r) => r.agent === "gemini-e" && r.kind === "edit" && r.mode === "commit").pop()!.status).toBe("accepted");
    expect(await run({ hook_event_name: "AfterAgent", prompt: "do it", prompt_response: "done", stop_hook_active: true })).toEqual({});
    expect(coord.log.find((r) => r.kind === "join")?.payload).toMatchObject({ harness: "gemini-cli" });
  }, 60_000);
});

describe("Gemini --by-path routing (issue #11: an edit in another joined worktree, fixtures)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("from a non-joined parent dir, an edit inside a joined worktree is checked as that worktree's agent; plain routing stays a no-op", async () => {
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const routed = installed(BUNDLE, "gemini-bp", url, "gemini-q", ["--by-path"]);
    const groups = JSON.parse(readFileSync(join(routed.root, ".gemini/settings.json"), "utf8")).hooks.BeforeTool;
    expect(groups.at(-1).hooks[0].command).toContain(`weft-gemini.mjs hook --by-path --url ${url} --repo demo --mode enforce # weft-gemini`);

    const parent = checkout("gemini-parent");
    const wt = installed(BUNDLE, "gemini-wt", url, "worker-w").root;
    changeSignature();
    const cart = join(wt, "src/cart.ts");
    const before = (newString: string) => ({ hook_event_name: "BeforeTool", session_id: "gs-p", cwd: parent, tool_name: "replace", tool_input: { file_path: cart, old_string: CART_LINE, new_string: newString } });
    const run = async (p: object, args?: string[]) => JSON.parse((await runBundle(BUNDLE, parent, p, args)) || "{}");

    expect(await run(before(OLD_CALL))).toEqual({});
    expect(joinedAgents(coord)).not.toContain("worker-w");

    const pre = await run(before(OLD_CALL), byPathArgs(url));
    expect(pre.decision).toBe("deny");
    expect(pre.reason).toContain("[weft error] stale_assumption src/cart.ts:4:19");
    expect(joinedAgents(coord)).toContain("worker-w");

    expect(await run(before(NEW_CALL), byPathArgs(url))).toEqual({});
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    await run({ ...before(NEW_CALL), hook_event_name: "AfterTool", tool_response: { llmContent: "ok" } }, byPathArgs(url));
    expect(coord.log.filter((r) => r.kind === "edit" && r.mode === "commit").pop()).toMatchObject({ agent: "worker-w", status: "accepted", files: ["src/cart.ts"] });

    expect(await run(before(OLD_CALL), byPathArgs(url, "other-repo"))).toEqual({});
    expect(adapterLog(wt)).toContain("do not match the pinned coordinator");
  }, 60_000);
});
