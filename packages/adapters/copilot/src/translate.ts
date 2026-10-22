// GitHub Copilot hook payloads <-> the shared WCP core's Claude-shaped hook input/output.
// Wire shapes: https://docs.github.com/en/copilot/reference/hooks-reference (Copilot CLI,
// Copilot cloud agent, VS Code "Copilot" sessions on the Agent Host) and
// https://code.visualstudio.com/docs/agents/reference/hooks-reference (VS Code Local harness).
//
// One hook command serves three payload dialects:
//
//   copilot  camelCase events + fields (`sessionId`, `toolName`, `toolArgs`): what Copilot CLI
//            and the cloud agent send for the camelCase `.github/hooks/weft.json` we install.
//   compat   Copilot's "VS Code compatible" PascalCase form (`hook_event_name`, `session_id`,
//            `tool_name` mapped to Claude names, no `tool_use_id`): sent when a hook file uses
//            PascalCase event names.
//   local    VS Code Local harness: same PascalCase shape plus `tool_use_id`; VS Code's own
//            tool names (`create_file`, `replace_string_in_file`, `run_in_terminal`, ...). The
//            Local parser maps our camelCase Copilot file onto these events.
//
//   sessionStart         -> SessionStart       additionalContext                      (L1)
//   userPromptSubmitted  -> UserPromptSubmit   (output dropped by Copilot: carried)
//   preToolUse  edit     -> PreToolUse check   permissionDecision:"deny" + reason      (L2)
//   preToolUse  bash     -> PreToolUse Bash    git commit -> deny while errors open (commit_gate)
//   postToolUse(Failure) -> PostToolUse        additionalContext (appended to the tool result) (L1)
//   agentStop            -> Stop               decision:"block" + reason -> next turn  (L3)
//   sessionEnd           -> SessionEnd
//
// Verified live (Copilot CLI 1.0.102, default model): edits arrive as `apply_patch` with the
// raw Codex patch as a STRING `toolArgs` (PascalCase: tool_name "Edit", tool_input = the same
// string), and no payload carries a tool call id. Edits are therefore detected by argument
// shape (patch text, old/new strings, file text) rather than by tool name, a multi-file patch
// becomes one core call per file, and the call id is derived from the arguments (pre and post
// of one call carry identical arguments).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HookInput, HookOutput } from "../../claude-code/src/hooks";
import { obj, str, toCoreTool } from "../../claude-code/src/tools";
import { proposedFiles } from "../../codex/src/edits";

export type Dialect = "copilot" | "compat" | "local";

/** Any of the three payload shapes (fields are optional; normalized by `normalize`). */
export type CopilotInput = Record<string, unknown> & {
  hook_event_name?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  toolName?: string;
  tool_name?: string;
  toolArgs?: unknown;
  tool_input?: unknown;
  tool_use_id?: string;
  toolResult?: unknown;
  tool_result?: unknown;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  reason?: string;
  source?: string;
  prompt?: string;
  error?: unknown;
};

export type Normalized = {
  dialect: Dialect;
  /** Core event name (PascalCase), or undefined when the event is not coordinated. */
  event: string | undefined;
  /** The event name as the harness sent/configured it (for output shaping and logs). */
  native: string;
  session?: string;
  cwd: string;
  tool?: string;
  args: unknown;
  callId?: string;
  result?: unknown;
  stopActive: boolean;
  reason?: string;
  source?: string;
  prompt?: string;
  error?: unknown;
};

const CAMEL: Record<string, string> = {
  sessionStart: "SessionStart",
  userPromptSubmitted: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  agentStop: "Stop",
  sessionEnd: "SessionEnd",
};
const PASCAL = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);

/**
 * The camelCase event a payload belongs to, from its documented field set (camelCase payloads
 * carry no event name). Used when the hook was registered without its event argument.
 * Events Weft does not coordinate (subagentStop, errorOccurred, notification, ...) -> "".
 */
export function inferEvent(i: CopilotInput): string {
  const has = (k: string) => i[k] !== undefined;
  if (has("agentName") || has("notification_type") || has("errorContext") || has("trigger") || has("transformedPrompt")) return "";
  if (has("toolName")) return has("toolResult") ? "postToolUse" : has("error") ? "postToolUseFailure" : "preToolUse";
  if (has("stopReason") || has("transcriptPath")) return "agentStop";
  if (has("source")) return "sessionStart";
  if (has("prompt")) return "userPromptSubmitted";
  if (has("reason")) return "sessionEnd";
  return "";
}

/**
 * Normalize a payload. `configured` is the event name the hook was registered under (our
 * install passes it as an argument because camelCase payloads carry no event name); without
 * it the event is inferred from the payload's fields.
 */
export function normalize(i: CopilotInput, configured?: string, env: NodeJS.ProcessEnv = process.env): Normalized {
  const pascal = typeof i.hook_event_name === "string";
  const dialect: Dialect = !pascal ? "copilot" : typeof i.tool_use_id === "string" || !env.COPILOT_CLI ? "local" : "compat";
  const native = pascal ? i.hook_event_name! : configured && CAMEL[configured] ? configured : inferEvent(i);
  const event = pascal ? (PASCAL.has(native) ? native : undefined) : CAMEL[native];
  return {
    dialect,
    event,
    native,
    session: str(i.sessionId) ?? str(i.session_id),
    cwd: str(i.cwd) ?? env.COPILOT_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    tool: str(i.toolName) ?? str(i.tool_name),
    args: i.toolArgs ?? i.tool_input,
    callId: str(i.tool_use_id),
    result: i.toolResult ?? i.tool_result ?? i.tool_response,
    stopActive: i.stop_hook_active === true,
    reason: str(i.reason),
    source: str(i.source),
    prompt: str(i.prompt),
    error: i.error,
  };
}

const SHELL = /^(bash|powershell|shell|run_in_terminal|runInTerminal|run_terminal_cmd|terminal)$/i;

/** The Codex patch text in a tool call, whatever wraps it (string args, {input}, {patch}, {command}). */
export function patchText(args: unknown): string | undefined {
  const pick = (v: unknown) => (typeof v === "string" && /\*\*\* (Begin Patch|(Add|Update|Delete) File:)/.test(v) ? v : undefined);
  if (typeof args === "string") return pick(args);
  const a = obj(args);
  return pick(a.input) ?? pick(a.patch) ?? pick(a.command);
}

/** Stable id for a call that carries none: pre and post of one call send identical arguments. */
export function deriveCallId(session: string, tool: string, args: unknown): string {
  const h = createHash("sha1").update(`${session}\0${tool}\0${typeof args === "string" ? args : JSON.stringify(args ?? null)}`).digest("hex");
  return `cp-${h.slice(0, 16)}`;
}

export type CoreCall = { tool_name: string; tool_input: Record<string, unknown> };

/**
 * One Copilot tool call -> the core tool calls it amounts to (one per file for multi-file
 * edits). [] = a tool the core has no opinion about (view, grep, MCP, ...).
 */
export function coreCalls(tool: string, args: unknown, cwd: string, read: (abs: string) => string | null = readOrNull): CoreCall[] {
  const patch = patchText(args);
  if (patch !== undefined) {
    return proposedFiles(patch, (p) => read(resolve(cwd, p))).map((f) => {
      const file_path = resolve(cwd, f.path);
      // after: string = proposed text (checked before it lands); null = deletion; undefined =
      // a hunk that does not apply (Copilot rejects it too). Both of the latter are accounted
      // for after the fact only.
      return { tool_name: "Write", tool_input: typeof f.after === "string" ? { file_path, content: f.after } : { file_path } };
    });
  }
  const a = obj(args);
  if (SHELL.test(tool)) {
    const command = str(a.command) ?? str(a.cmd) ?? (typeof args === "string" ? args : undefined);
    return command !== undefined ? [{ tool_name: "Bash", tool_input: { command } }] : [];
  }
  // VS Code multi_replace_string_in_file: {replacements: [{filePath, oldString, newString}]}.
  if (Array.isArray(a.replacements)) {
    const byFile = new Map<string, Array<{ old_string?: string; new_string?: string }>>();
    for (const r of a.replacements as Array<Record<string, unknown>>) {
      const p = str(r.filePath) ?? str(r.file_path) ?? str(r.path);
      if (!p) continue;
      const file_path = resolve(cwd, p);
      byFile.set(file_path, [...(byFile.get(file_path) ?? []), { old_string: str(r.oldString) ?? str(r.old_string) ?? str(r.old_str), new_string: str(r.newString) ?? str(r.new_string) ?? str(r.new_str) }]);
    }
    return [...byFile].map(([file_path, edits]) => ({ tool_name: "MultiEdit", tool_input: { file_path, edits } }));
  }
  // Copilot `str_replace_editor` / `edit` with a non-editing command (view) is not an edit.
  if (typeof a.command === "string" && /^(view|undo_edit)$/.test(a.command)) return [];
  const mapped = toCoreTool(tool, a);
  if (!mapped || mapped.tool_name === "Bash") return [];
  const p = mapped.tool_input.file_path;
  if (typeof p === "string") mapped.tool_input.file_path = resolve(cwd, p);
  return [mapped];
}

function readOrNull(abs: string): string | null {
  try {
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

/** Normalized Copilot event -> core hook inputs (empty: nothing for the core to do). */
export function toCore(n: Normalized, read?: (abs: string) => string | null): HookInput[] {
  if (!n.session || !n.event) return [];
  const base = { session_id: n.session, cwd: n.cwd };
  switch (n.event) {
    case "SessionStart":
      return [{ ...base, hook_event_name: "SessionStart", source: n.source === "resume" ? "resume" : "startup" }];
    case "UserPromptSubmit":
      return [{ ...base, hook_event_name: "UserPromptSubmit", prompt: n.prompt }];
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = n.tool ?? "unknown";
      const id = n.callId ?? deriveCallId(n.session, tool, n.args);
      const calls = coreCalls(tool, n.args, n.cwd, read);
      const post = n.event !== "PreToolUse";
      const extra = post ? (n.event === "PostToolUseFailure" ? { error: n.error } : { tool_response: n.result }) : {};
      if (!calls.length) return post ? [{ ...base, hook_event_name: n.event, tool_name: tool, tool_input: {}, tool_use_id: id, ...extra }] : [];
      return calls.map((c, k) => ({ ...base, hook_event_name: n.event!, ...c, tool_use_id: calls.length > 1 ? `${id}#${k}` : id, ...extra }));
    }
    case "Stop":
      return [{ ...base, hook_event_name: "Stop", stop_hook_active: n.stopActive }];
    case "SessionEnd":
      return [{ ...base, hook_event_name: "SessionEnd", ...(n.reason ? { reason: n.reason } : {}) }];
    default:
      return [];
  }
}

type CoreOut = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n");

/**
 * Core outputs (one per core call) -> the harness's output. `carry` is model-visible text the
 * hook point cannot deliver (an allowed preToolUse; userPromptSubmitted, whose output Copilot
 * drops); the caller delivers it at the next postToolUse / agentStop / sessionStart.
 *
 * Copilot's camelCase output is flat (`permissionDecision`, `additionalContext`, `decision`).
 * VS Code Local reads Claude's `hookSpecificOutput`; PascalCase payloads get both shapes.
 */
export function fromCore(n: Normalized, outs: HookOutput[], carried = ""): { json: Record<string, unknown>; carry?: string } {
  const os = outs.map((o) => (o ?? {}) as CoreOut);
  const deny = os.map((o) => o.hookSpecificOutput).filter((h) => h?.permissionDecision === "deny");
  const ctx = join(...os.map((o) => o.hookSpecificOutput?.additionalContext));
  const pascal = n.dialect !== "copilot";
  const hso = (fields: Record<string, unknown>) => (pascal ? { hookSpecificOutput: { hookEventName: n.native, ...fields } } : {});
  switch (n.event) {
    case "PreToolUse": {
      if (deny.length) {
        const reason = join(...deny.map((h) => h!.permissionDecisionReason ?? "[weft] blocked"));
        return { json: { permissionDecision: "deny", permissionDecisionReason: reason, ...hso({ permissionDecision: "deny", permissionDecisionReason: reason }) }, ...(ctx ? { carry: ctx } : {}) };
      }
      return { json: {}, ...(ctx ? { carry: ctx } : {}) };
    }
    case "PostToolUse":
    case "PostToolUseFailure":
    case "SessionStart": {
      const text = join(carried, ctx, ...os.map((o) => (o.decision === "block" ? o.reason : undefined)));
      return { json: text ? { additionalContext: text, ...hso({ additionalContext: text }) } : {} };
    }
    case "UserPromptSubmit":
      return { json: {}, ...(ctx ? { carry: ctx } : {}) };
    case "Stop": {
      const block = os.find((o) => o.decision === "block" && o.reason);
      if (!block) return { json: {}, ...(carried ? { carry: carried } : {}) };
      const reason = join(carried, block.reason);
      return { json: { decision: "block", reason, ...hso({ decision: "block", reason }) } };
    }
    default:
      return { json: {} };
  }
}
