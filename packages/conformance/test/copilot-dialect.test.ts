import { describe, expect, it } from "vitest";
import type { CoreEvent } from "../src/core";
import { DIALECTS, type RawResult } from "../src/dialects";
import { copilot } from "../src/dialects/copilot";

const raw = (stdout: unknown, code = 0, stderr = ""): RawResult => ({ stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr, code, timedOut: false, ms: 1 });
const ev = (event: CoreEvent["event"], extra: Partial<CoreEvent> = {}): CoreEvent => ({ hooks: "0.1", event, id: "e1", session: "s1", cwd: "/w", ...extra });

describe("Copilot dialect", () => {
  const pre = ev("tool.pre", { tool: { kind: "edit", call_id: "c1", path: "src/a.ts", old_text: "a", new_text: "b" } });

  it("is registered", () => expect(DIALECTS.copilot).toBe(copilot));

  it("encodes the camelCase payloads Copilot CLI sends (apply_patch as a string, no call id, no event name)", () => {
    expect(copilot.encode(pre)).toMatchObject({ sessionId: "s1", cwd: "/w", toolName: "apply_patch", toolArgs: "*** Begin Patch\n*** Update File: /w/src/a.ts\n@@\n-a\n+b\n*** End Patch\n" });
    expect(copilot.encode(pre)).not.toHaveProperty("hook_event_name");
    expect(copilot.encode(ev("tool.pre", { tool: { kind: "write", call_id: "c", path: "n.ts", content: "x" } }))).toMatchObject({ toolName: "create", toolArgs: { path: "/w/n.ts", file_text: "x" } });
    expect(copilot.encode(ev("tool.post", { tool: { kind: "shell", call_id: "c", command: "ls", output: "ok" } }))).toMatchObject({ toolName: "bash", toolArgs: { command: "ls" }, toolResult: { resultType: "success", textResultForLlm: "ok" } });
    expect(copilot.encode(ev("agent.stop", { stop: { repeat: 1 } }))).toMatchObject({ stopReason: "end_turn", stop_hook_active: true });
  });

  it("decodes permissionDecision, additionalContext and agentStop block; non-zero preToolUse exits deny", () => {
    expect(copilot.decode(pre, raw({ permissionDecision: "deny", permissionDecisionReason: "stale" })).decision).toMatchObject({ decision: "deny", explanation: "stale" });
    expect(copilot.decode(pre, raw({ permissionDecision: "deny" })).problems[0]).toMatch(/without permissionDecisionReason/);
    expect(copilot.decode(pre, raw({ additionalContext: "lost" })).decision.decision).toBe("allow");
    expect(copilot.decode(pre, raw("", 1)).decision.decision).toBe("deny");
    expect(copilot.decode(ev("tool.post", { tool: pre.tool }), raw('{"type":"progress","message":"x"}\n{"additionalContext":"fyi"}')).decision).toMatchObject({ decision: "advise", explanation: "fyi" });
    expect(copilot.decode(ev("tool.post", { tool: pre.tool }), raw("", 1)).decision.decision).toBe("allow");
    expect(copilot.decode(ev("agent.stop"), raw({ decision: "block", reason: "open errors" })).decision).toMatchObject({ decision: "deny", explanation: "open errors" });
    expect(copilot.decode(ev("agent.stop"), raw({ decision: "block" })).decision.decision).toBe("allow");
    expect(copilot.decode(ev("prompt.submit"), raw({ additionalContext: "dropped" })).decision.decision).toBe("allow");
  });
});
