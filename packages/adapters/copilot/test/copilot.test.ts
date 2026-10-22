// Payload fixtures below are the shapes captured from a live Copilot CLI 1.0.102 run
// (demo/evidence/copilot/payloads.jsonl); VS Code Local shapes follow its hooks reference.
import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CART_LINE, NEW_CALL, OLD_CALL, coordinator, gitCommit, installed, runBundle } from "../../claude-code/test/translator-kit";
import { coreCalls, deriveCallId, fromCore, inferEvent, normalize, patchText, toCore } from "../src/translate";
import { EVENTS, mergeHooks } from "../src/cli";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-copilot.mjs");
const CLI = { COPILOT_CLI: "1" };
const patch = (file: string, from: string, to: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-${from}\n+${to}\n*** End Patch\n`;

describe("Copilot payload normalization", () => {
  it("reads the camelCase CLI/cloud payload, the PascalCase compat payload and the VS Code Local payload", () => {
    const camel = normalize({ sessionId: "s", timestamp: 1, cwd: "/p", toolName: "apply_patch", toolArgs: "*** Begin Patch\n*** Add File: n.txt\n+x\n*** End Patch\n" }, "preToolUse", CLI);
    expect(camel).toMatchObject({ dialect: "copilot", event: "PreToolUse", native: "preToolUse", session: "s", tool: "apply_patch" });
    const compat = normalize({ hook_event_name: "PreToolUse", session_id: "s", timestamp: "t", cwd: "/p", tool_name: "Edit", tool_input: "*** Begin Patch" }, undefined, CLI);
    expect(compat).toMatchObject({ dialect: "compat", event: "PreToolUse", tool: "Edit" });
    const local = normalize({ hook_event_name: "Stop", session_id: "s", cwd: "/p", stop_hook_active: true }, "agentStop", {});
    expect(local).toMatchObject({ dialect: "local", event: "Stop", stopActive: true });
    expect(normalize({ sessionId: "s", cwd: "/p" }, "notification", CLI).event).toBeUndefined();
    expect(normalize({ sessionId: "s", cwd: "/p", stop_hook_active: false, stopReason: "end_turn" }, "agentStop", CLI).event).toBe("Stop");
  });

  it("infers the camelCase event from the payload when the hook has no event argument", () => {
    const b = { sessionId: "s", timestamp: 1, cwd: "/p" };
    expect(inferEvent({ ...b, source: "new" })).toBe("sessionStart");
    expect(inferEvent({ ...b, prompt: "x" })).toBe("userPromptSubmitted");
    expect(inferEvent({ ...b, toolName: "bash", toolArgs: {} })).toBe("preToolUse");
    expect(inferEvent({ ...b, toolName: "bash", toolArgs: {}, toolResult: {} })).toBe("postToolUse");
    expect(inferEvent({ ...b, toolName: "bash", toolArgs: {}, error: "boom" })).toBe("postToolUseFailure");
    expect(inferEvent({ ...b, transcriptPath: "/t", stopReason: "end_turn", stop_hook_active: false })).toBe("agentStop");
    expect(inferEvent({ ...b, reason: "complete" })).toBe("sessionEnd");
    expect(inferEvent({ ...b, transcriptPath: "/t", agentId: "a", agentName: "explore", stopReason: "end_turn" })).toBe(""); // subagentStop
    expect(inferEvent({ ...b, error: { message: "x" }, errorContext: "system", recoverable: true })).toBe(""); // errorOccurred
    expect(normalize({ ...b, toolName: "apply_patch", toolArgs: "x" }, undefined, { COPILOT_CLI: "1" }).event).toBe("PreToolUse");
  });

  it("maps every edit shape to core calls by argument shape", () => {
    const files: Record<string, string | null> = { "/p/m.ts": "a\nb\n", "/p/gone.ts": "x\n" };
    const read = (p: string) => files[p] ?? null;
    // apply_patch (string args), multi-file: one core Write per file with the proposed text
    const multi = "*** Begin Patch\n*** Update File: m.ts\n@@\n-b\n+c\n*** Add File: n.txt\n+hello\n*** Delete File: gone.ts\n*** End Patch\n";
    expect(coreCalls("apply_patch", multi, "/p", read)).toEqual([
      { tool_name: "Write", tool_input: { file_path: "/p/m.ts", content: "a\nc\n" } },
      { tool_name: "Write", tool_input: { file_path: "/p/n.txt", content: "hello\n" } },
      { tool_name: "Write", tool_input: { file_path: "/p/gone.ts" } },
    ]);
    expect(patchText({ input: multi })).toBe(multi); // VS Code apply_patch {input}
    // Copilot edit / str_replace_editor {path, old_str, new_str}; create {path, file_text}
    expect(coreCalls("edit", { path: "m.ts", old_str: "b", new_str: "c" }, "/p")).toEqual([{ tool_name: "Edit", tool_input: { file_path: "/p/m.ts", old_string: "b", new_string: "c", replace_all: false } }]);
    expect(coreCalls("create", { path: "/p/n.ts", file_text: "x" }, "/p")).toEqual([{ tool_name: "Write", tool_input: { file_path: "/p/n.ts", content: "x" } }]);
    expect(coreCalls("str_replace_editor", { command: "view", path: "/p/m.ts" }, "/p")).toEqual([]);
    // VS Code Local tools
    expect(coreCalls("replace_string_in_file", { filePath: "/p/m.ts", oldString: "b", newString: "c" }, "/p")[0]).toMatchObject({ tool_name: "Edit" });
    expect(coreCalls("create_file", { filePath: "/p/k.ts", content: "k" }, "/p")[0]).toEqual({ tool_name: "Write", tool_input: { file_path: "/p/k.ts", content: "k" } });
    expect(coreCalls("multi_replace_string_in_file", { replacements: [{ filePath: "/p/m.ts", oldString: "a", newString: "A" }, { filePath: "/p/m.ts", oldString: "b", newString: "B" }] }, "/p")).toEqual([
      { tool_name: "MultiEdit", tool_input: { file_path: "/p/m.ts", edits: [{ old_string: "a", new_string: "A" }, { old_string: "b", new_string: "B" }] } },
    ]);
    // shells
    expect(coreCalls("bash", { command: "git commit -m x", description: "c" }, "/p")).toEqual([{ tool_name: "Bash", tool_input: { command: "git commit -m x" } }]);
    expect(coreCalls("run_in_terminal", { command: "ls", explanation: "e", isBackground: false }, "/p")).toEqual([{ tool_name: "Bash", tool_input: { command: "ls" } }]);
    // not edits
    expect(coreCalls("view", { path: "/p/m.ts" }, "/p")).toEqual([]);
    expect(coreCalls("rg", { pattern: "x", paths: "." }, "/p")).toEqual([]);
  });

  it("derives one call id for a pre/post pair and splits multi-file calls", () => {
    const args = patch("m.ts", "b", "c");
    expect(deriveCallId("s", "apply_patch", args)).toBe(deriveCallId("s", "apply_patch", args));
    expect(deriveCallId("s", "apply_patch", args)).not.toBe(deriveCallId("s2", "apply_patch", args));
    const read = (p: string) => (p === "/p/m.ts" ? "b\n" : null);
    const pre = toCore(normalize({ sessionId: "s", cwd: "/p", toolName: "apply_patch", toolArgs: args }, "preToolUse", CLI), read);
    const post = toCore(normalize({ sessionId: "s", cwd: "/p", toolName: "apply_patch", toolArgs: args, toolResult: { resultType: "success", textResultForLlm: "ok" } }, "postToolUse", CLI), read);
    expect(pre[0].tool_use_id).toBe(post[0].tool_use_id);
    expect(post[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_response: { resultType: "success" } });
    const two = toCore(normalize({ sessionId: "s", cwd: "/p", toolName: "apply_patch", toolArgs: "*** Begin Patch\n*** Add File: a\n+1\n*** Add File: b\n+2\n*** End Patch" }, "preToolUse", CLI), read);
    expect(two.map((i) => i.tool_use_id!.split("#")[1])).toEqual(["0", "1"]);
    expect(toCore(normalize({ sessionId: "s", cwd: "/p", toolName: "view", toolArgs: { path: "/p/m.ts" } }, "preToolUse", CLI))).toEqual([]);
    expect(toCore(normalize({ sessionId: "s", cwd: "/p", toolName: "view", toolArgs: { path: "/p/m.ts" } }, "postToolUse", CLI))[0]).toMatchObject({ tool_name: "view", tool_input: {} });
    // VS Code Local carries its own id
    expect(toCore(normalize({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "create_file", tool_input: { filePath: "/p/x", content: "" }, tool_use_id: "call_1" }, undefined, {}))[0].tool_use_id).toBe("call_1");
  });

  it("shapes outputs per dialect", () => {
    const camel = normalize({ sessionId: "s", cwd: "/p" }, "preToolUse", CLI);
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[weft] no" } };
    expect(fromCore(camel, [undefined, deny]).json).toEqual({ permissionDecision: "deny", permissionDecisionReason: "[weft] no" });
    expect(fromCore(camel, [{ hookSpecificOutput: { additionalContext: "w" } }])).toEqual({ json: {}, carry: "w" });
    const post = normalize({ sessionId: "s", cwd: "/p" }, "postToolUse", CLI);
    expect(fromCore(post, [{ hookSpecificOutput: { additionalContext: "c" } }], "w").json).toEqual({ additionalContext: "w\nc" });
    const stop = normalize({ sessionId: "s", cwd: "/p" }, "agentStop", CLI);
    expect(fromCore(stop, [{ decision: "block", reason: "open" }]).json).toEqual({ decision: "block", reason: "open" });
    expect(fromCore(stop, [undefined], "w")).toEqual({ json: {}, carry: "w" });
    const local = normalize({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_use_id: "t" }, undefined, {});
    expect(fromCore(local, [deny]).json).toEqual({ permissionDecision: "deny", permissionDecisionReason: "[weft] no", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[weft] no" } });
    const lstop = normalize({ hook_event_name: "Stop", session_id: "s", cwd: "/p" }, undefined, {});
    expect(fromCore(lstop, [{ decision: "block", reason: "open" }]).json).toEqual({ decision: "block", reason: "open", hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason: "open" } });
    const prompt = normalize({ sessionId: "s", cwd: "/p", prompt: "x" }, "userPromptSubmitted", CLI);
    expect(fromCore(prompt, [{ hookSpecificOutput: { additionalContext: "inbox" } }])).toEqual({ json: {}, carry: "inbox" });
  });

  it("merges the hooks file without touching foreign hooks", () => {
    const mine = { type: "command", bash: "./audit.sh" };
    const once = mergeHooks({ version: 1, hooks: { preToolUse: [mine] } }, "node /x/weft-copilot.mjs hook");
    expect(once.hooks.preToolUse).toHaveLength(2);
    expect(Object.keys(once.hooks).sort()).toEqual([...EVENTS].sort());
    const twice = mergeHooks(once, "node /y/weft-copilot.mjs hook");
    expect(twice.hooks.preToolUse).toEqual([mine, expect.objectContaining({ bash: "node /y/weft-copilot.mjs hook preToolUse # weft-copilot" })]);
    expect(twice.version).toBe(1);
  });
});

describe("Copilot adapter end to end (real bundle, local coordinator, captured payload shapes)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("preToolUse deny for a stale apply_patch; agentStop block while open; commit gate; fixed patch accepted", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "copilot", url, "copilot-e");
    const hooks = JSON.parse(readFileSync(join(root, ".github/hooks/weft.json"), "utf8"));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.agentStop[0].bash).toContain("hook agentStop # weft-copilot");
    expect(readFileSync(join(root, ".git/info/exclude"), "utf8")).toContain(".github/hooks/weft.json");
    const base = { sessionId: "cp-1", cwd: root };
    const run = async (event: string, p: object) => JSON.parse((await runBundle(BUNDLE, root, { ...base, timestamp: Date.now(), ...p }, ["hook", event])) || "{}");
    const start = await run("sessionStart", { source: "new", initialPrompt: "x" });
    expect(start.additionalContext).toContain("agent copilot-e");
    changeSignature();
    const stale = patch("src/cart.ts", `  ${CART_LINE}`, `  ${OLD_CALL}`);
    const deny = await run("preToolUse", { toolName: "apply_patch", toolArgs: stale });
    expect(deny.permissionDecision).toBe("deny");
    expect(deny.permissionDecisionReason).toContain("[weft error] stale_assumption src/cart.ts:4:");
    const stop = await run("agentStop", { transcriptPath: "/tmp/t", stopReason: "end_turn", stop_hook_active: false });
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("open Weft error");
    const commit = await run("preToolUse", { toolName: "bash", toolArgs: { command: "git commit -am wip", description: "commit" } });
    expect(commit.permissionDecision).toBe("deny");
    expect(commit.permissionDecisionReason).toContain("commit gate");
    const fix = patch("src/cart.ts", `  ${CART_LINE}`, `  ${NEW_CALL}`);
    expect(await run("preToolUse", { toolName: "apply_patch", toolArgs: fix })).toEqual({});
    const cart = join(root, "src/cart.ts");
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL));
    await run("postToolUse", { toolName: "apply_patch", toolArgs: fix, toolResult: { resultType: "success", textResultForLlm: "Modified 1 file(s)" } });
    expect(coord.log.filter((r) => r.agent === "copilot-e" && r.kind === "edit" && r.mode === "commit").pop()!.status).toBe("accepted");
    expect(await run("agentStop", { transcriptPath: "/tmp/t", stopReason: "end_turn", stop_hook_active: true })).toEqual({});
    expect((await gitCommit(root, "cart total")).ok).toBe(true);
    expect(coord.log.find((r) => r.kind === "join")?.payload).toMatchObject({ harness: "copilot" });
  }, 60_000);

  it("the Claude Code adapter stays silent under Copilot CLI when the Copilot adapter owns the checkout", async () => {
    const CLAUDE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "claude-code", "dist", "weft-claude.mjs");
    if (!existsSync(CLAUDE)) execFileSync(process.execPath, [join(dirname(dirname(CLAUDE)), "scripts", "build.mjs")]);
    const { url, server } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "copilot-double", url, "copilot-d");
    execFileSync(process.execPath, [CLAUDE, "install", "--url", url, "--repo", "demo", "--agent", "copilot-d", "--task", "T-2"], { cwd: root, env: { ...process.env, WEFT_TOKEN: "local-test-token" } });
    const start = { hook_event_name: "SessionStart", session_id: "dbl", cwd: root, source: "new", timestamp: new Date().toISOString() };
    const claude = (env: NodeJS.ProcessEnv) =>
      new Promise<string>((res, rej) => {
        const child = execFile(process.execPath, [CLAUDE, "hook"], { cwd: root, env: { ...process.env, WEFT_TOKEN: "", COPILOT_CLI: "", ...env }, encoding: "utf8" }, (err, out) => (err ? rej(err) : res(out)));
        child.stdin!.end(JSON.stringify(start));
      });
    expect(await claude({ COPILOT_CLI: "1" })).toBe(""); // Copilot CLI: the Copilot adapter answers instead
    expect(await claude({})).toContain("agent copilot-d"); // Claude Code itself: unchanged
  }, 60_000);

  it("VS Code Local payloads (PascalCase + tool_use_id) get hookSpecificOutput decisions", async () => {
    const { url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "copilot-vscode", url, "copilot-v");
    const base = { session_id: "vs-1", cwd: root, timestamp: new Date().toISOString() };
    const run = async (event: string, p: object) => JSON.parse((await runBundle(BUNDLE, root, { ...base, ...p }, ["hook", event])) || "{}");
    expect((await run("sessionStart", { hook_event_name: "SessionStart", source: "new" })).hookSpecificOutput.additionalContext).toContain("agent copilot-v");
    changeSignature();
    const cart = join(root, "src/cart.ts");
    const deny = await run("preToolUse", { hook_event_name: "PreToolUse", tool_name: "replace_string_in_file", tool_input: { filePath: cart, oldString: CART_LINE, newString: OLD_CALL }, tool_use_id: "call_a" });
    expect(deny.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(deny.hookSpecificOutput.permissionDecisionReason).toContain("stale_assumption");
    const stop = await run("agentStop", { hook_event_name: "Stop", stop_hook_active: false });
    expect(stop.hookSpecificOutput).toMatchObject({ hookEventName: "Stop", decision: "block" });
  }, 60_000);
});
