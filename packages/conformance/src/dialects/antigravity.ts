// Google Antigravity dialect (Antigravity 2.0, Antigravity CLI `agy`, Antigravity IDE).
// Wire: https://antigravity.google/docs/hooks. camelCase payloads, PascalCase tool args.
// Payload shapes as observed from agy 1.4.5 (demo/evidence/antigravity/hook-probe/).
//
//   session.start  -> SessionStart (common fields only); advise = injectSteps
//   prompt.submit  -> PreInvocation (invocationNum); advise = injectSteps
//   tool.pre       -> PreToolUse; deny = decision:"deny" + reason. `decision` is required:
//                     agy denies a call whose hook answered `{}` ("tool call denied by
//                     pre-tool hook"), so a missing decision decodes as deny + a problem.
//   tool.post      -> PostToolUse (same stepIdx, error ""); output is `{}` by contract
//   agent.stop     -> Stop (terminationReason NO_TOOL_CALL, executionNum 0, 1, …);
//                     deny = decision:"continue" + reason
//   session.end    -> no hook point
//
// PostToolUse cannot inject, so advise text produced by a tool reaches the model at the next
// model call (`inject: "delayed"`): the dialect sets `deferredInject`, and the runner fires a
// prompt.submit (PreInvocation) after each tool.post and credits its advise to that tool.
// Self-contained (no imports from ../dialects) to keep the registry free of import cycles.
import { isAbsolute, join } from "node:path";
import { HOOKS_CORE_VERSION, type CoreDecision, type CoreEvent, type CoreTool } from "../core";
import type { Decoded, Dialect, RawResult } from "../dialects";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const mk = (decision: CoreDecision["decision"], explanation?: string): CoreDecision => ({ hooks: HOOKS_CORE_VERSION, decision, ...(explanation ? { explanation } : {}) });
const abs = (ev: CoreEvent, p: string | undefined) => (p === undefined ? undefined : isAbsolute(p) ? p : join(ev.cwd, p));

function parse(raw: RawResult): { o: Record<string, unknown>; problems: string[] } {
  const text = raw.stdout.trim();
  if (!text) return { o: {}, problems: [] };
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? { o: v as Record<string, unknown>, problems: [] } : { o: {}, problems: ["stdout is JSON but not an object"] };
  } catch {
    return { o: {}, problems: [`stdout is not JSON: ${text.slice(0, 80)}`] };
  }
}

/** agy CLI tool names and arguments (observed), e.g. edit_file {Path, Target, Replacement}. */
function tool(ev: CoreEvent, t: CoreTool): { name: string; args: Record<string, unknown> } {
  const Path = abs(ev, t.path);
  switch (t.kind) {
    case "edit":
      return { name: "edit_file", args: { Path, Target: t.old_text ?? "", Replacement: t.new_text ?? "" } };
    case "write":
      return { name: "write_file", args: { Path, Content: t.content ?? "", Overwrite: true } };
    case "delete":
      return { name: "run_command", args: { CommandLine: `rm -f ${JSON.stringify(t.path ?? "")}`, WaitMsBeforeAsync: 5000, toolSummary: "conformance" } };
    case "shell":
      return { name: "run_command", args: { CommandLine: t.command ?? "", WaitMsBeforeAsync: 5000, toolSummary: "conformance" } };
    case "read":
      return { name: "read_file", args: { Path } };
    default:
      return { name: t.name ?? "read_url_content", args: {} };
  }
}

let invocations = new Map<string, number>();
const steps = new Map<string, number>();

export const antigravity: Dialect & { deferredInject: true } = {
  name: "antigravity",
  deferredInject: true,
  encode(ev) {
    const base = { conversationId: ev.session, workspacePaths: [ev.cwd], transcriptPath: join(ev.cwd, ".conformance-transcript.jsonl"), artifactDirectoryPath: join(ev.cwd, ".conformance-artifacts"), modelName: "conformance" };
    switch (ev.event) {
      case "session.start":
        if (invocations.size > 1000) invocations = new Map();
        invocations.set(ev.session, 0);
        steps.set(ev.session, 0);
        return base;
      case "prompt.submit": {
        const n = invocations.get(ev.session) ?? 0;
        invocations.set(ev.session, n + 1);
        return { ...base, invocationNum: n, initialNumSteps: n * 2 + 1 };
      }
      case "tool.pre":
      case "tool.post": {
        // A tool's Pre and Post share stepIdx; each Pre takes a new step.
        if (ev.event === "tool.pre") steps.set(ev.session, (steps.get(ev.session) ?? 0) + 1);
        const step = steps.get(ev.session) ?? 0;
        return { ...base, toolCall: tool(ev, ev.tool!), stepIdx: step, ...(ev.event === "tool.post" ? { error: "" } : {}) };
      }
      case "agent.stop":
        return { ...base, executionNum: ev.stop?.repeat ?? 0, terminationReason: "NO_TOOL_CALL", error: "", fullyIdle: true };
      case "session.end":
        return undefined;
    }
  },
  decode(ev, raw): Decoded {
    const { o, problems } = parse(raw);
    switch (ev.event) {
      case "tool.pre": {
        if (o.decision === "deny" || o.decision === "deny_unless_prior_grant") {
          const why = s(o.reason);
          if (!why) problems.push(`decision "${String(o.decision)}" without a reason`);
          return { decision: mk("deny", why), problems };
        }
        if (o.decision === undefined) return { decision: mk("deny", "no decision (agy denies the call)"), problems: [...problems, "PreToolUse output has no decision: agy treats that as deny"] };
        if (!["allow", "ask", "force_ask"].includes(String(o.decision))) problems.push(`unknown PreToolUse decision ${JSON.stringify(o.decision)}`);
        return { decision: mk("allow"), problems };
      }
      case "tool.post":
        if (Object.keys(o).length) problems.push("PostToolUse output must be {}");
        return { decision: mk("allow"), problems };
      case "agent.stop":
        return { decision: o.decision === "continue" ? mk("deny", s(o.reason)) : mk("allow"), problems: o.decision === "continue" && !s(o.reason) ? [...problems, 'decision "continue" without a reason'] : problems };
      default: {
        const steps = Array.isArray(o.injectSteps) ? (o.injectSteps as Array<Record<string, unknown>>) : [];
        const text = steps.map((st) => s(obj(st.systemMessage).systemMessage) ?? s(st.ephemeralMessage) ?? s(st.userMessage)).filter(Boolean).join("\n");
        return { decision: text ? mk("advise", text) : mk("allow"), problems };
      }
    }
  },
};
