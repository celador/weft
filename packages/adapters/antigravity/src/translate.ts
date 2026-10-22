// Google Antigravity hook payloads <-> the shared WCP core's Claude-shaped hook input/output.
// Wire shapes: https://antigravity.google/docs/hooks (one format for Antigravity 2.0, the
// Antigravity CLI `agy` and the Antigravity IDE). Payload fields are camelCase; tool
// arguments are PascalCase.
//
//   PreInvocation  -> SessionStart (first call of a conversation) | UserPromptSubmit
//                     drain the inbox + carried text -> injectSteps[{ephemeralMessage}]  (delayed L1)
//   PreToolUse     -> PreToolUse   decision:"deny" + reason (shown to the agent)        (L2)
//                     write_to_file {TargetFile, CodeContent}            -> Write
//                     replace_file_content {TargetFile, TargetContent,
//                       ReplacementContent, AllowMultiple}                -> Edit
//                     multi_replace_file_content {TargetFile,
//                       ReplacementChunks[]}                              -> MultiEdit
//                     run_command {CommandLine, Cwd}                     -> Bash (git commit gate)
//   PostToolUse    -> PostToolUse  output is `{}` by contract: the core's context is
//                     carried to the next PreInvocation
//   Stop           -> Stop         decision:"continue" + reason (re-enters the loop)     (L3)
import { isAbsolute, join, resolve, sep } from "node:path";
import type { HookInput, HookOutput } from "../../claude-code/src/hooks";
import { obj, str } from "../../claude-code/src/tools";

export type AntigravityInput = {
  /** Present on every documented event. */
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  /** PreToolUse / PostToolUse */
  toolCall?: { name?: string; args?: Record<string, unknown> | string };
  stepIdx?: number;
  error?: string;
  /** PreInvocation / PostInvocation */
  invocationNum?: number;
  initialNumSteps?: number;
  /** Stop */
  executionNum?: number;
  terminationReason?: string;
  fullyIdle?: boolean;
  /** Not on the wire: set by the hook command from its `hook <Event>` argument. */
  hookEvent?: AntigravityEvent;
};

export type AntigravityEvent = "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop";
export const EVENTS: AntigravityEvent[] = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"];

/** The hook payload does not name its event; infer it from the fields when no argument says. */
export function eventOf(i: AntigravityInput): AntigravityEvent | undefined {
  if (i.hookEvent) return i.hookEvent;
  if (typeof i.terminationReason === "string" || typeof i.fullyIdle === "boolean" || typeof i.executionNum === "number") return "Stop";
  if (typeof i.invocationNum === "number") return "PreInvocation";
  if (i.toolCall) return typeof i.error === "string" ? "PostToolUse" : "PreToolUse";
  return undefined;
}

export const EDIT_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content"];
export const SHELL_TOOL = "run_command";

/** The workspace root a payload is about: the mounted workspace containing the target file, else the first one. */
export function rootOf(i: AntigravityInput, env: NodeJS.ProcessEnv = process.env): string {
  const roots = (i.workspacePaths ?? []).filter((p) => typeof p === "string" && p);
  const target = str(obj(i.toolCall?.args).TargetFile) ?? str(obj(i.toolCall?.args).Cwd);
  if (target && isAbsolute(target)) {
    const hit = roots.filter((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep)).sort((a, b) => b.length - a.length)[0];
    if (hit) return hit;
  }
  return roots[0] ?? env.WEFT_ROOT ?? process.cwd();
}

/** Antigravity tool -> core tool vocabulary (undefined: not a tool the core checks). */
export function toCoreTool(name: string, args: Record<string, unknown>, root: string): { tool_name: string; tool_input: Record<string, unknown> } | undefined {
  if (name === SHELL_TOOL) {
    const command = str(args.CommandLine);
    return command !== undefined ? { tool_name: "Bash", tool_input: { command, ...(str(args.Cwd) ? { cwd: args.Cwd } : {}) } } : undefined;
  }
  if (!EDIT_TOOLS.includes(name)) return undefined;
  const target = str(args.TargetFile);
  if (!target) return undefined;
  const file_path = isAbsolute(target) ? target : resolve(root, target);
  switch (name) {
    case "write_to_file":
      return str(args.CodeContent) !== undefined ? { tool_name: "Write", tool_input: { file_path, content: args.CodeContent } } : { tool_name: "Write", tool_input: { file_path } };
    case "replace_file_content": {
      const old_string = str(args.TargetContent);
      const new_string = str(args.ReplacementContent);
      if (old_string === undefined || new_string === undefined) return { tool_name: "Write", tool_input: { file_path } };
      return { tool_name: "Edit", tool_input: { file_path, old_string, new_string, replace_all: args.AllowMultiple === true } };
    }
    default: {
      const chunks = Array.isArray(args.ReplacementChunks) ? (args.ReplacementChunks as unknown[]).map(obj) : [];
      const edits = chunks.map((c) => ({ old_string: str(c.TargetContent), new_string: str(c.ReplacementContent), replace_all: c.AllowMultiple === true }));
      if (!edits.length || edits.some((e) => e.old_string === undefined || e.new_string === undefined)) return { tool_name: "Write", tool_input: { file_path } };
      return { tool_name: "MultiEdit", tool_input: { file_path, edits } };
    }
  }
}

/**
 * Antigravity tool calls carry `stepIdx` but no call id, and nothing documents that Pre and
 * Post report the same index, so Pre/Post pair up by a key derived from the arguments.
 */
export function callIdOf(i: AntigravityInput): string {
  const a = obj(i.toolCall?.args);
  return `${i.toolCall?.name ?? "tool"}:${JSON.stringify(a).length}:${String(a.TargetFile ?? a.CommandLine ?? "")}`;
}

/** Antigravity event -> core hook input (undefined: nothing for the core to do). */
export function toCore(i: AntigravityInput, event = eventOf(i)): HookInput | undefined {
  const session_id = i.conversationId;
  if (!session_id || !event) return undefined;
  const cwd = rootOf(i);
  const base = { session_id, cwd };
  switch (event) {
    case "PreInvocation":
      return (i.invocationNum ?? 0) === 0 ? { ...base, hook_event_name: "SessionStart", source: "startup" } : { ...base, hook_event_name: "UserPromptSubmit", prompt: "" };
    case "PreToolUse":
    case "PostToolUse": {
      const name = i.toolCall?.name ?? "";
      const mapped = toCoreTool(name, obj(i.toolCall?.args), cwd);
      const hook_event_name = event === "PreToolUse" ? "PreToolUse" : i.error ? "PostToolUseFailure" : "PostToolUse";
      if (!mapped) return event === "PostToolUse" ? { ...base, hook_event_name: "PostToolUse", tool_name: name || "unknown", tool_input: {}, tool_use_id: callIdOf(i) } : undefined;
      return { ...base, hook_event_name, ...mapped, tool_use_id: callIdOf(i), ...(event === "PostToolUse" ? { tool_response: i.error ? { error: i.error } : { success: true } } : {}) };
    }
    case "Stop":
      // Only a model-initiated stop is gated; max steps, errors and cancellations are the host's call.
      if (i.terminationReason && i.terminationReason !== "model_stop") return undefined;
      return { ...base, hook_event_name: "Stop", stop_hook_active: (i.executionNum ?? 0) > 1 };
    default:
      return undefined;
  }
}

type CoreOut = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

/**
 * Core output -> Antigravity output. Only PreInvocation can put text in front of the model
 * outside a denial, so context produced anywhere else is returned as `carry` and delivered
 * by the next PreInvocation (delayed L1). An allowed tool call answers `{}`: no opinion, the
 * user's own permission settings decide (a Weft `allow` must not auto-approve anything).
 */
export function fromCore(event: AntigravityEvent, out: HookOutput, carried = ""): { json: Record<string, unknown>; carry?: string } {
  const o = (out ?? {}) as CoreOut;
  const hso = o.hookSpecificOutput ?? {};
  const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n");
  switch (event) {
    case "PreToolUse":
      if (hso.permissionDecision === "deny") return { json: { decision: "deny", reason: hso.permissionDecisionReason ?? "[weft] blocked" } };
      return { json: {}, ...(hso.additionalContext ? { carry: hso.additionalContext } : {}) };
    case "PostToolUse":
      return { json: {}, ...(hso.additionalContext ? { carry: hso.additionalContext } : {}) };
    case "PreInvocation": {
      const text = join(carried, hso.additionalContext);
      return { json: text ? { injectSteps: [{ ephemeralMessage: text }] } : {} };
    }
    case "Stop":
      if (o.decision === "block" && o.reason) return { json: { decision: "continue", reason: join(carried, o.reason) } };
      return { json: {}, ...(carried ? { carry: carried } : {}) };
    default:
      return { json: {} };
  }
}

/** Where an install writes the workspace hooks file. */
export const hooksPath = (root: string) => join(root, ".agents", "hooks.json");
