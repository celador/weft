// Fixture tests: payloads follow https://antigravity.google/docs/hooks. The live run against a
// real `agy` is recorded separately under demo/evidence/antigravity/.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CART_LINE, NEW_CALL, OLD_CALL, coordinator, installed, runBundle } from "../../claude-code/test/translator-kit";
import { callIdOf, eventOf, fromCore, rootOf, toCore } from "../src/translate";
import { mergeHooks } from "../src/cli";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-antigravity.mjs");
const common = { conversationId: "c1", workspacePaths: ["/p"], transcriptPath: "/t.jsonl", artifactDirectoryPath: "/a", modelName: "gemini-3.6-flash-medium" };

describe("Antigravity translation (fixtures)", () => {
  it("maps the file tools, run_command and the loop events", () => {
    const pre = (name: string, args: Record<string, unknown>) => toCore({ ...common, stepIdx: 3, toolCall: { name, args } }, "PreToolUse");
    expect(pre("write_to_file", { TargetFile: "/p/a.ts", Overwrite: true, CodeContent: "x", Description: "d" })).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/p/a.ts", content: "x" } });
    expect(pre("replace_file_content", { TargetFile: "/p/a.ts", TargetContent: "a", ReplacementContent: "b", AllowMultiple: true, StartLine: 1, EndLine: 9 })).toMatchObject({ tool_name: "Edit", tool_input: { old_string: "a", new_string: "b", replace_all: true } });
    expect(pre("multi_replace_file_content", { TargetFile: "a.ts", ReplacementChunks: [{ TargetContent: "a", ReplacementContent: "b" }, { TargetContent: "c", ReplacementContent: "d", AllowMultiple: true }] })).toMatchObject({
      tool_name: "MultiEdit",
      tool_input: { file_path: "/p/a.ts", edits: [{ old_string: "a", new_string: "b", replace_all: false }, { old_string: "c", new_string: "d", replace_all: true }] },
    });
    expect(pre("run_command", { CommandLine: "git commit -m x", Cwd: "/p" })).toMatchObject({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
    expect(pre("view_file", { AbsolutePath: "/p/a.ts" })).toBeUndefined();
    expect(toCore({ ...common, invocationNum: 0, initialNumSteps: 1 }, "PreInvocation")).toMatchObject({ hook_event_name: "SessionStart" });
    expect(toCore({ ...common, invocationNum: 4, initialNumSteps: 9 }, "PreInvocation")).toMatchObject({ hook_event_name: "UserPromptSubmit" });
    expect(toCore({ ...common, executionNum: 1, terminationReason: "model_stop", fullyIdle: true }, "Stop")).toMatchObject({ hook_event_name: "Stop" });
    expect(toCore({ ...common, executionNum: 1, terminationReason: "max_steps_exceeded", fullyIdle: true }, "Stop")).toBeUndefined();
    expect(toCore({ ...common, stepIdx: 3, toolCall: { name: "write_to_file", args: { TargetFile: "/p/a.ts", CodeContent: "x" } }, error: "boom" }, "PostToolUse")).toMatchObject({ hook_event_name: "PostToolUseFailure" });
    const a = { ...common, stepIdx: 2, toolCall: { name: "replace_file_content", args: { TargetFile: "/p/a.ts", TargetContent: "a", ReplacementContent: "b" } } };
    expect(callIdOf(a)).toBe(callIdOf({ ...a, stepIdx: 3, error: "" }));
  });

  it("infers the event from the payload when the command does not name it, and picks the right workspace", () => {
    expect(eventOf({ ...common, invocationNum: 0 })).toBe("PreInvocation");
    expect(eventOf({ ...common, terminationReason: "model_stop", fullyIdle: true, executionNum: 1 })).toBe("Stop");
    expect(eventOf({ ...common, toolCall: { name: "x" }, stepIdx: 1 })).toBe("PreToolUse");
    expect(eventOf({ ...common, toolCall: { name: "x" }, stepIdx: 1, error: "" })).toBe("PostToolUse");
    expect(rootOf({ workspacePaths: ["/w/a", "/w/ab"], toolCall: { name: "write_to_file", args: { TargetFile: "/w/ab/x.ts" } } })).toBe("/w/ab");
  });

  it("maps outputs to the documented fields; context waits for the next PreInvocation", () => {
    expect(fromCore("PreToolUse", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } }).json).toEqual({ decision: "deny", reason: "no" });
    expect(fromCore("PreToolUse", { hookSpecificOutput: { additionalContext: "w" } })).toEqual({ json: {}, carry: "w" });
    expect(fromCore("PostToolUse", { hookSpecificOutput: { additionalContext: "c" } })).toEqual({ json: {}, carry: "c" });
    expect(fromCore("PreInvocation", { hookSpecificOutput: { additionalContext: "i" } }, "w\nc").json).toEqual({ injectSteps: [{ ephemeralMessage: "w\nc\ni" }] });
    expect(fromCore("PreInvocation", undefined).json).toEqual({});
    expect(fromCore("Stop", { decision: "block", reason: "not done" }).json).toEqual({ decision: "continue", reason: "not done" });
    expect(fromCore("Stop", undefined, "left")).toEqual({ json: {}, carry: "left" });
  });

  it("merges into .agents/hooks.json without touching foreign hooks", () => {
    const cmd = (e: string) => `node w.mjs hook ${e} # weft-antigravity`;
    const merged = mergeHooks({ lint: { PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh" }] }] } }, cmd);
    expect(Object.keys(merged)).toEqual(["lint", "weft"]);
    expect(merged.weft!.PreToolUse).toEqual([{ matcher: "write_to_file|replace_file_content|multi_replace_file_content|run_command", hooks: [{ type: "command", command: cmd("PreToolUse"), timeout: 30 }] }]);
    expect(merged.weft!.PreInvocation).toEqual([{ type: "command", command: cmd("PreInvocation"), timeout: 30 }]);
    const again = mergeHooks({ ...merged, renamed: merged.weft! }, cmd);
    expect(Object.keys(again)).toEqual(["lint", "weft"]);
  });
});

describe("Antigravity adapter end to end with fixture payloads (real bundle, local coordinator)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("deny a stale replace; the peer change reaches the model via injectSteps; Stop continues while open; fix accepted", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "antigravity", url, "agy-e");
    const hooks = JSON.parse(readFileSync(join(root, ".agents/hooks.json"), "utf8"));
    expect(hooks.weft.Stop).toHaveLength(1);
    const base = { conversationId: "agy-1", workspacePaths: [root], transcriptPath: "/tmp/t.jsonl", artifactDirectoryPath: "/tmp/a", modelName: "gemini" };
    const run = async (event: string, p: object) => JSON.parse((await runBundle(BUNDLE, root, { ...base, ...p }, ["hook", event])) || "{}");
    const start = await run("PreInvocation", { invocationNum: 0, initialNumSteps: 1 });
    expect(start.injectSteps[0].ephemeralMessage).toContain("agent agy-e");
    changeSignature();
    const cart = join(root, "src/cart.ts");
    const stale = { TargetFile: cart, TargetContent: CART_LINE, ReplacementContent: OLD_CALL, AllowMultiple: false, Instruction: "i", Description: "d" };
    const deny = await run("PreToolUse", { stepIdx: 4, toolCall: { name: "replace_file_content", args: stale } });
    expect(deny.decision).toBe("deny");
    expect(deny.reason).toContain("[weft error] stale_assumption src/cart.ts:4:19");
    const stop = await run("Stop", { executionNum: 1, terminationReason: "model_stop", fullyIdle: true });
    expect(stop.decision).toBe("continue");
    expect(stop.reason).toContain("[weft] Not done");
    const fix = { ...stale, ReplacementContent: NEW_CALL };
    expect(await run("PreToolUse", { stepIdx: 6, toolCall: { name: "replace_file_content", args: fix } })).toEqual({});
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    expect(await run("PostToolUse", { stepIdx: 6, toolCall: { name: "replace_file_content", args: fix }, error: "" })).toEqual({});
    expect(coord.log.filter((r) => r.agent === "agy-e" && r.kind === "edit" && r.mode === "commit").pop()!.status).toBe("accepted");
    expect(await run("Stop", { executionNum: 2, terminationReason: "model_stop", fullyIdle: true })).toEqual({});
    expect(coord.log.find((r) => r.kind === "join")?.payload).toMatchObject({ harness: "antigravity", level: 3 });
  }, 60_000);

  it("fails open on garbage and on an unconfigured workspace", async () => {
    expect(await runBundle(BUNDLE, "/", "not json", ["hook", "PreToolUse"])).toBe("{}");
    expect(await runBundle(BUNDLE, "/", { conversationId: "x", workspacePaths: ["/nonexistent"], toolCall: { name: "write_to_file", args: { TargetFile: "/nonexistent/a", CodeContent: "" } } }, ["hook", "PreToolUse"])).toBe("{}");
  });
});
