import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CART_LINE, NEW_CALL, OLD_CALL, coordinator, gitCommit, gitLog, installed, runBundle } from "../../claude-code/test/translator-kit";
import { beforeFromEdits, fromCore, toCore, toCoreTool } from "../src/translate";
import { CAPABILITIES, mergeHooks } from "../src/cli";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-cursor.mjs");

describe("Cursor payload translation (fixtures from cursor.com/docs/hooks)", () => {
  it("maps edit tools by argument shape and Shell to Bash", () => {
    expect(toCoreTool("Shell", { command: "git commit -m x", working_directory: "/p" })).toEqual({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
    expect(toCoreTool("Write", { file_path: "/p/a.ts", contents: "x" })).toEqual({ tool_name: "Write", tool_input: { file_path: "/p/a.ts", content: "x" } });
    expect(toCoreTool("StrReplace", { path: "/p/a.ts", old_string: "a", new_string: "b" })).toEqual({ tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b", replace_all: false } });
    expect(toCoreTool("Delete", { path: "/p/a.ts" })).toEqual({ tool_name: "Write", tool_input: { file_path: "/p/a.ts", weft_delete: true } });
    expect(toCoreTool("Read", { path: "/p/a.ts" })).toBeUndefined();
    expect(toCoreTool("MCP:search", { q: "x" })).toBeUndefined();
  });

  it("maps events: conversation_id is the session, workspace root the cwd, stop only when completed", () => {
    const pre = toCore({ hook_event_name: "preToolUse", conversation_id: "c1", workspace_roots: ["/p"], tool_name: "Write", tool_input: { file_path: "/p/a.ts", contents: "x" }, tool_use_id: "t1" });
    expect(pre).toMatchObject({ hook_event_name: "PreToolUse", session_id: "c1", cwd: "/p", tool_name: "Write", tool_use_id: "t1" });
    expect(toCore({ hook_event_name: "stop", conversation_id: "c1", status: "aborted", loop_count: 0 })).toBeUndefined();
    expect(toCore({ hook_event_name: "stop", conversation_id: "c1", status: "completed", loop_count: 2 })).toMatchObject({ hook_event_name: "Stop", stop_hook_active: true });
    expect(toCore({ hook_event_name: "beforeSubmitPrompt", conversation_id: "c1", prompt: "x" })).toBeUndefined();
  });

  it("maps outputs: deny -> permission/agent_message, allow carries warnings, block -> followup_message", () => {
    const deny = fromCore("preToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[weft] Edit blocked\n[weft error] x" } });
    expect(deny.json).toEqual({ permission: "deny", agent_message: "[weft] Edit blocked\n[weft error] x", user_message: "[weft] Edit blocked" });
    const warn = fromCore("preToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "[weft warning] w" } });
    expect(warn).toEqual({ json: { permission: "allow" }, carry: "[weft warning] w" });
    expect(fromCore("preToolUse", undefined).json).toEqual({ permission: "allow" });
    expect(fromCore("postToolUse", { hookSpecificOutput: { additionalContext: "ctx" } }, "carried").json).toEqual({ additional_context: "carried\nctx" });
    expect(fromCore("stop", { decision: "block", reason: "not done" }).json).toEqual({ followup_message: "not done" });
    expect(fromCore("stop", undefined).json).toEqual({});
  });

  it("reverse-applies afterFileEdit edit records to recover the pre-edit text", () => {
    expect(beforeFromEdits("a NEW c NEW2", [{ old_string: "b", new_string: "NEW" }, { old_string: "d", new_string: "NEW2" }])).toBe("a b c d");
    expect(beforeFromEdits("abc", [{ old_string: "x", new_string: "zz" }])).toBeUndefined();
  });

  it("declares documented L3 (schema-consistent) and merges hooks.json idempotently", () => {
    expect(CAPABILITIES).toEqual({ level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" });
    const once = mergeHooks({ version: 1, hooks: { stop: [{ command: "./mine.sh" }] } }, "node /x/weft-cursor.mjs hook # weft-cursor");
    const twice = mergeHooks(once, "node /y/weft-cursor.mjs hook # weft-cursor");
    expect(twice.hooks.stop).toEqual([{ command: "./mine.sh" }, { command: "node /y/weft-cursor.mjs hook # weft-cursor", timeout: 30, loop_limit: 5 }]);
    expect(Object.keys(twice.hooks).sort()).toEqual(["afterFileEdit", "postToolUse", "preToolUse", "sessionEnd", "sessionStart", "stop"]);
  });
});

describe("Cursor adapter end to end (real bundle, real git, local coordinator)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("stale call denied in preToolUse; Shell git commit and stop refused while open; fixed edit accepted; trailers", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root, out } = installed(BUNDLE, "cursor", url, "cursor-b");
    expect(out).toContain("installed cursor-cli adapter");
    const hooks = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8"));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.preToolUse[0].command).toContain("weft-cursor.mjs hook");
    expect(readFileSync(join(root, ".git/info/exclude"), "utf8")).toContain(".cursor/hooks.json");
    const common = { conversation_id: "conv-1", generation_id: "g1", model: "composer-2.5", cursor_version: "2026.04.17", workspace_roots: [root] };
    const run = async (p: object) => JSON.parse((await runBundle(BUNDLE, root, { ...common, ...p })) || "{}");

    const started = await run({ hook_event_name: "sessionStart", session_id: "conv-1", is_background_agent: false, composer_mode: "agent" });
    expect(started.additional_context).toContain("agent cursor-b");
    expect(coord.log.find((r) => r.kind === "join")?.payload).toMatchObject({ harness: "cursor-cli", level: 3 });
    const sigSeq = changeSignature();

    const cart = join(root, "src/cart.ts");
    const pre = await run({ hook_event_name: "preToolUse", tool_name: "StrReplace", tool_use_id: "t1", cwd: root, tool_input: { path: cart, old_string: CART_LINE, new_string: OLD_CALL } });
    expect(pre.permission).toBe("deny");
    expect(pre.agent_message).toContain("[weft error] stale_assumption src/cart.ts:4:19");
    expect(pre.agent_message).toContain(`event #${sigSeq}`);

    const commit = await run({ hook_event_name: "preToolUse", tool_name: "Shell", tool_use_id: "t2", tool_input: { command: "git commit -am wip", working_directory: root } });
    expect(commit.permission).toBe("deny");
    expect(commit.agent_message).toContain("commit refused by the Weft commit gate");
    const stop = await run({ hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(stop.followup_message).toContain("stale_assumption");

    // a read-only tool is allowed with a valid permission answer (Cursor blocks on invalid JSON)
    expect(await run({ hook_event_name: "preToolUse", tool_name: "Read", tool_use_id: "t3", tool_input: { path: cart } })).toEqual({ permission: "allow" });

    const fix = await run({ hook_event_name: "preToolUse", tool_name: "StrReplace", tool_use_id: "t4", tool_input: { path: cart, old_string: CART_LINE, new_string: NEW_CALL } });
    expect(fix).toEqual({ permission: "allow" });
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    await run({ hook_event_name: "postToolUse", tool_name: "StrReplace", tool_use_id: "t4", tool_input: { path: cart, old_string: CART_LINE, new_string: NEW_CALL }, tool_output: "{}", duration: 5 });
    // the afterFileEdit for the same edit is deduplicated (postToolUse already accounted for it)
    const edits = coord.log.filter((r) => r.kind === "edit" && r.agent === "cursor-b" && r.mode === "commit").length;
    await run({ hook_event_name: "afterFileEdit", file_path: cart, edits: [{ old_string: CART_LINE, new_string: NEW_CALL }] });
    expect(coord.log.filter((r) => r.kind === "edit" && r.agent === "cursor-b" && r.mode === "commit").length).toBe(edits);
    const accepted = coord.log.filter((r) => r.kind === "edit" && r.agent === "cursor-b" && r.mode === "commit").pop()!;
    expect(accepted.status).toBe("accepted");
    expect(accepted.tool).toMatchObject({ name: "Edit", harness_event: "PostToolUse" });

    expect(await run({ hook_event_name: "stop", status: "completed", loop_count: 1 })).toEqual({});
    const c = await gitCommit(root, "cart: total");
    expect(c.ok).toBe(true);
    expect(gitLog(root)).toMatch(/Task-Id: T-2\nAgent-Id: cursor-b/);
    await run({ hook_event_name: "sessionEnd", session_id: "conv-1", reason: "completed", duration_ms: 1 });
    // The session end is a leave; the coordinator may then release the change's claims (spec §7.5).
    expect(coord.log.filter((r) => r.kind !== "release").at(-1)!.kind).toBe("leave");
  }, 60_000);

  it("afterFileEdit alone (an edit no pre/postToolUse saw) is committed with the reconstructed before-text", async () => {
    const { coord, url, server } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "cursor-afe", url, "cursor-c");
    const cart = join(root, "src/cart.ts");
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    await runBundle(BUNDLE, root, { hook_event_name: "afterFileEdit", conversation_id: "conv-2", workspace_roots: [root], file_path: cart, edits: [{ old_string: CART_LINE, new_string: NEW_CALL }] });
    const ev = coord.log.find((r) => r.kind === "edit" && r.agent === "cursor-c")!;
    expect(ev.status).toBe("accepted");
    expect(ev.diff).toContain(`-  ${CART_LINE}`);
    expect(ev.diff).toContain(`+  ${NEW_CALL}`);
    expect(ev.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length).toBe(1);
  }, 30_000);
});
