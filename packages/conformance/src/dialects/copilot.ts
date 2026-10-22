// GitHub Copilot hook dialect (Copilot CLI and Copilot cloud agent; camelCase hook files).
// Wire shapes: https://docs.github.com/en/copilot/reference/hooks-reference, checked against
// live Copilot CLI 1.0.102 payloads (demo/evidence/copilot/): camelCase fields, no event name
// and no tool call id in the payload, and edits sent as `apply_patch` with the raw patch as a
// STRING `toolArgs` (`create` {path, file_text} and `edit` {path, old_str, new_str} also occur).
//
// Output: preToolUse `permissionDecision` ("deny" needs `permissionDecisionReason`; "ask" is a
// deny in the cloud agent); postToolUse / sessionStart `additionalContext`; agentStop
// `decision:"block"` + `reason` (the reason becomes the next prompt). A preToolUse command
// hook that exits non-zero DENIES the tool call (fail-closed); other events fail open.
//
// Kept out of dialects.ts (shared registry) on purpose; registered there with one line.
import { isAbsolute, join } from "node:path";
import { HOOKS_CORE_VERSION, type CoreDecision, type CoreEvent, type CoreTool } from "../core";
import type { Decoded, Dialect, RawResult } from "../dialects";

const abs = (ev: CoreEvent, p: string | undefined) => (p === undefined ? undefined : isAbsolute(p) ? p : join(ev.cwd, p));
const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const mk = (decision: CoreDecision["decision"], explanation?: string): CoreDecision => ({ hooks: HOOKS_CORE_VERSION, decision, ...(explanation ? { explanation } : {}) });

function parse(raw: RawResult): { o: Record<string, unknown>; problems: string[] } {
  // Copilot strips `{"type":"progress",...}` lines, then JSON.parses the rest; unparseable = no output.
  const text = raw.stdout
    .split("\n")
    .filter((l) => {
      try {
        const v = JSON.parse(l.trim()) as { type?: unknown };
        return !(v && typeof v === "object" && v.type === "progress");
      } catch {
        return true;
      }
    })
    .join("\n")
    .trim();
  if (!text) return { o: {}, problems: [] };
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? { o: v as Record<string, unknown>, problems: [] } : { o: {}, problems: ["stdout is JSON but not an object (Copilot ignores it)"] };
  } catch {
    return { o: {}, problems: [`stdout is not JSON (Copilot ignores it): ${text.slice(0, 80)}`] };
  }
}

/** Codex patch grammar, as Copilot's default `apply_patch` tool sends it. */
function patch(lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");
}

function tool(ev: CoreEvent, t: CoreTool): { toolName: string; toolArgs: unknown } {
  const path = abs(ev, t.path) ?? "";
  const split = (x: string) => x.replace(/\n$/, "").split("\n");
  switch (t.kind) {
    case "edit":
      return { toolName: "apply_patch", toolArgs: patch([`*** Update File: ${path}`, "@@", ...split(t.old_text ?? "").map((l) => `-${l}`), ...split(t.new_text ?? "").map((l) => `+${l}`)]) };
    case "write":
      return { toolName: "create", toolArgs: { path, file_text: t.content ?? "" } };
    case "delete":
      return { toolName: "apply_patch", toolArgs: patch([`*** Delete File: ${path}`]) };
    case "shell":
      return { toolName: "bash", toolArgs: { command: t.command ?? "", description: "conformance" } };
    case "read":
      return { toolName: "view", toolArgs: { path } };
    default:
      return { toolName: t.name ?? "web_fetch", toolArgs: {} };
  }
}

export const copilot: Dialect = {
  name: "copilot",
  encode(ev) {
    const base = { sessionId: ev.session, timestamp: Date.now(), cwd: ev.cwd };
    switch (ev.event) {
      case "session.start":
        return { ...base, source: "new" };
      case "prompt.submit":
        return { ...base, prompt: ev.prompt ?? "" };
      case "tool.pre":
        return { ...base, ...tool(ev, ev.tool!) };
      case "tool.post":
        return { ...base, ...tool(ev, ev.tool!), toolResult: { resultType: "success", textResultForLlm: ev.tool!.output ?? "" } };
      case "agent.stop":
        return { ...base, transcriptPath: join(ev.cwd, ".conformance-transcript.jsonl"), stopReason: "end_turn", stop_hook_active: (ev.stop?.repeat ?? 0) > 0 };
      case "session.end":
        return { ...base, reason: ev.reason ?? "complete" };
    }
  },
  decode(ev, raw): Decoded {
    if (ev.event === "tool.pre" && raw.code !== 0 && !raw.timedOut) {
      // Fail-closed: exit 2 or a crash denies; exit 2's stderr is shown to the user, not the model.
      const why = s(raw.stderr) ?? "Denied by preToolUse hook (hook errored)";
      return { decision: mk("deny", why), problems: raw.code === 2 ? [] : [`exit ${raw.code} denies the tool call (Copilot fails closed)`] };
    }
    const { o, problems } = parse(raw);
    const ctx = s(o.additionalContext);
    if (ev.event === "tool.pre") {
      if (o.permissionDecision === "deny" || o.permissionDecision === "ask") {
        const why = s(o.permissionDecisionReason);
        if (!why) problems.push(`permissionDecision "${String(o.permissionDecision)}" without permissionDecisionReason`);
        return { decision: mk("deny", why), problems };
      }
      // preToolUse has no context field: text here never reaches the model.
      return { decision: mk("allow"), problems };
    }
    if (ev.event === "agent.stop") {
      if (o.decision === "block") {
        const why = s(o.reason);
        if (!why) problems.push('decision "block" without a reason (Copilot ignores it)');
        return { decision: why ? mk("deny", why) : mk("allow"), problems };
      }
      return { decision: mk("allow"), problems };
    }
    // userPromptSubmitted and sessionEnd outputs are dropped by Copilot's command hooks.
    if (ev.event === "prompt.submit" || ev.event === "session.end") return { decision: mk("allow"), problems };
    return { decision: ctx ? mk("advise", ctx) : mk("allow"), problems };
  },
};
