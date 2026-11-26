// FIXTURE TESTS ONLY: payloads follow https://geminicli.com/docs/hooks/reference; no live
// Gemini CLI run backs this adapter (no usable Gemini auth on the build machine).
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CART_LINE, NEW_CALL, OLD_CALL, coordinator, installed, runBundle } from "../../claude-code/test/translator-kit";
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

  it("`.weft/bin/weft claim --firm` (shared host CLI) sends a firm claim that refuses another agent's edit", async () => {
    const { coord, url, server } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "gemini-claim", url, "gemini-c");
    const weft = join(root, ".weft/bin/weft");
    const sh = promisify(execFile);
    const run = async (args: string[]) => {
      try {
        const r = await sh(weft, args, { cwd: root, env: { ...process.env, WEFT_TOKEN: "" } });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (err) {
        const e = err as { code: number; stdout?: string; stderr?: string };
        return { code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) };
      }
    };
    expect(await run(["claim"])).toMatchObject({ code: 2, stdout: expect.stringContaining("--firm") });
    expect(await run(["claim", "--keys", "../x.ts#f"])).toMatchObject({ code: 2, stderr: expect.stringContaining("'..' is not allowed") });
    const key = "src/pricing.ts#calcTotal";
    const ok = await run(["claim", "--keys", key, "--firm", "--ttl", "60000"]);
    expect(ok).toMatchObject({ code: 0, stdout: expect.stringContaining("gemini-c firmly claimed calcTotal") });
    expect(coord.log.filter((r) => r.kind === "claim")).toMatchObject([{ agent: "gemini-c", status: "accepted", payload: { firm: true, source: "explicit", ttl_ms: 60_000 } }]);
    const b = coord.hello({
      type: "hello",
      protocol: "wcp/0.1",
      agent: { id: "codex-b", harness: "codex" },
      capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" },
      task: { id: "T-9" },
    });
    const v = coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key, kind: "body" }] } });
    expect(v).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error", caused_by_agent: "gemini-c" }] });
  }, 60_000);
});
