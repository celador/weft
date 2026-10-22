// Google Antigravity hook payloads <-> the shared WCP core's Claude-shaped hook input/output.
// Wire shapes: https://antigravity.google/docs/hooks and the copy shipped with the CLI
// (~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md). One format for
// Antigravity 2.0, the Antigravity CLI `agy` and the Antigravity IDE. Payload fields are
// camelCase; tool arguments are PascalCase. Verified live against agy 1.4.5
// (demo/evidence/antigravity/).
//
//   SessionStart   -> SessionStart     welcome + inbox -> injectSteps[{systemMessage}]       (L1)
//   PreInvocation  -> UserPromptSubmit drain the inbox + carried text -> injectSteps        (delayed L1)
//   PreToolUse     -> PreToolUse       decision:"deny" + reason (shown to the agent)        (L2)
//                     no opinion = decision:"ask" (the field is REQUIRED: agy 1.4.5 treats
//                     `{}` as a hard deny of every tool call; "ask" defers to the user's own
//                     permission settings, "allow" would bypass them)
//                     agy CLI: edit_file {Path, Target, Replacement}       -> Edit
//                              write_file {Path, Content, Overwrite}       -> Write
//                     IDE/2.0: write_to_file {TargetFile, CodeContent}      -> Write
//                              replace_file_content {TargetFile, TargetContent,
//                                ReplacementContent, AllowMultiple}         -> Edit
//                              multi_replace_file_content {TargetFile,
//                                ReplacementChunks[]}                       -> MultiEdit
//                     run_command {CommandLine, Cwd?}                      -> Bash (git commit gate)
//   PostToolUse    -> PostToolUse      output is `{}` by contract: the core's context is
//                     carried to the next PreInvocation. Same stepIdx as its PreToolUse;
//                     `error` is always present ("" on success).
//   Stop           -> Stop             decision:"continue" + reason (re-enters the loop as a
//                     system message)                                                     (L3)
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

export type AntigravityEvent = "SessionStart" | "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop";
export const EVENTS: AntigravityEvent[] = ["SessionStart", "PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"];

/** The hook payload does not name its event; infer it from the fields when no argument says (SessionStart has only the common fields: it needs the argument). */
export function eventOf(i: AntigravityInput): AntigravityEvent | undefined {
  if (i.hookEvent) return i.hookEvent;
  if (typeof i.terminationReason === "string" || typeof i.fullyIdle === "boolean" || typeof i.executionNum === "number") return "Stop";
  if (typeof i.invocationNum === "number") return "PreInvocation";
  if (i.toolCall) return typeof i.error === "string" ? "PostToolUse" : "PreToolUse";
  // Only SessionStart carries nothing but the common fields.
  if (typeof i.conversationId === "string" && i.stepIdx === undefined && i.initialNumSteps === undefined) return "SessionStart";
  return undefined;
}

/** agy CLI names first (edit_file, write_file), then the Antigravity 2.0 / IDE names. */
export const EDIT_TOOLS = ["edit_file", "write_file", "write_to_file", "replace_file_content", "multi_replace_file_content"];
export const SHELL_TOOL = "run_command";

/** The workspace root a payload is about: the mounted workspace containing the target file, else the first one. */
export function rootOf(i: AntigravityInput, env: NodeJS.ProcessEnv = process.env): string {
  const roots = (i.workspacePaths ?? []).filter((p) => typeof p === "string" && p);
  const a = obj(i.toolCall?.args);
  const target = targetOf(a) ?? str(a.Cwd);
  if (target && isAbsolute(target)) {
    const hit = roots.filter((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep)).sort((a, b) => b.length - a.length)[0];
    if (hit) return hit;
  }
  return roots[0] ?? env.WEFT_ROOT ?? process.cwd();
}

/** The file a tool call is about (`Path` in agy, `TargetFile` in 2.0 / the IDE). */
export const targetOf = (a: Record<string, unknown>) => str(a.Path) ?? str(a.TargetFile) ?? str(a.AbsolutePath);

/** Antigravity tool -> core tool vocabulary (undefined: not a tool the core checks). */
export function toCoreTool(name: string, args: Record<string, unknown>, root: string): { tool_name: string; tool_input: Record<string, unknown> } | undefined {
  if (name === SHELL_TOOL) {
    const command = str(args.CommandLine);
    return command !== undefined ? { tool_name: "Bash", tool_input: { command, ...(str(args.Cwd) ? { cwd: args.Cwd } : {}) } } : undefined;
  }
  if (!EDIT_TOOLS.includes(name)) return undefined;
  const target = targetOf(args);
  if (!target) return undefined;
  const file_path = isAbsolute(target) ? target : resolve(root, target);
  const whole = { tool_name: "Write", tool_input: { file_path } }; // the core reconciles the file after the fact
  switch (name) {
    case "write_file":
    case "write_to_file": {
      const content = str(args.Content) ?? str(args.CodeContent) ?? (args.Content === "" || args.CodeContent === "" ? "" : undefined);
      return content !== undefined ? { tool_name: "Write", tool_input: { file_path, content } } : whole;
    }
    case "edit_file":
    case "replace_file_content": {
      const old_string = str(args.Target) ?? str(args.TargetContent);
      const new_string = typeof args.Replacement === "string" ? args.Replacement : typeof args.ReplacementContent === "string" ? args.ReplacementContent : undefined;
      if (old_string === undefined || new_string === undefined) return whole; // e.g. edit_file {CodeEdit, Instruction}
      return { tool_name: "Edit", tool_input: { file_path, old_string, new_string, replace_all: args.AllowMultiple === true || args.ReplaceAll === true } };
    }
    default: {
      const chunks = Array.isArray(args.ReplacementChunks) ? (args.ReplacementChunks as unknown[]).map(obj) : [];
      const edits = chunks.map((c) => ({ old_string: str(c.TargetContent), new_string: typeof c.ReplacementContent === "string" ? c.ReplacementContent : undefined, replace_all: c.AllowMultiple === true }));
      if (!edits.length || edits.some((e) => e.old_string === undefined || e.new_string === undefined)) return whole;
      return { tool_name: "MultiEdit", tool_input: { file_path, edits } };
    }
  }
}

/**
 * Antigravity tool calls carry no call id. agy 1.4.5 reports the same `stepIdx` on a tool's
 * PreToolUse and PostToolUse (observed live), so that pairs them; without one, a key derived
 * from the arguments does.
 */
export function callIdOf(i: AntigravityInput): string {
  const a = obj(i.toolCall?.args);
  if (typeof i.stepIdx === "number") return `${i.toolCall?.name ?? "tool"}@${i.stepIdx}`;
  return `${i.toolCall?.name ?? "tool"}:${JSON.stringify(a).length}:${String(targetOf(a) ?? a.CommandLine ?? "")}`;
}

/** Stops that are the model finishing its turn (gated); limits, errors and cancellations are the host's call. */
export const MODEL_STOPS = ["NO_TOOL_CALL", "model_stop"];

/** Antigravity event -> core hook input (undefined: nothing for the core to do). */
export function toCore(i: AntigravityInput, event = eventOf(i)): HookInput | undefined {
  const session_id = i.conversationId;
  if (!session_id || !event) return undefined;
  const cwd = rootOf(i);
  const base = { session_id, cwd };
  switch (event) {
    case "SessionStart":
      return { ...base, hook_event_name: "SessionStart", source: "startup" };
    case "PreInvocation":
      return { ...base, hook_event_name: "UserPromptSubmit", prompt: "" };
    case "PreToolUse":
    case "PostToolUse": {
      const name = i.toolCall?.name ?? "";
      const mapped = toCoreTool(name, obj(i.toolCall?.args), cwd);
      const hook_event_name = event === "PreToolUse" ? "PreToolUse" : i.error ? "PostToolUseFailure" : "PostToolUse";
      if (!mapped) return event === "PostToolUse" ? { ...base, hook_event_name: "PostToolUse", tool_name: name || "unknown", tool_input: {}, tool_use_id: callIdOf(i) } : undefined;
      return { ...base, hook_event_name, ...mapped, tool_use_id: callIdOf(i), ...(event === "PostToolUse" ? { tool_response: i.error ? { error: i.error } : { success: true } } : {}) };
    }
    case "Stop":
      if (i.terminationReason && !MODEL_STOPS.includes(i.terminationReason)) return undefined;
      // executionNum counts Stop hooks already run in this turn (0 on the first stop).
      return { ...base, hook_event_name: "Stop", stop_hook_active: (i.executionNum ?? 0) > 0 };
    default:
      return undefined;
  }
}

type CoreOut = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

/** PreToolUse "no opinion": `decision` is required (agy treats `{}` as deny); "ask" leaves it to the user's permission settings. */
export const NO_OPINION = { decision: "ask" } as const;

/** Text in front of the model: a systemMessage step (persists in the trajectory, like the Stop reason). */
export const injectStep = (text: string) => ({ systemMessage: { systemMessage: text } });

/**
 * Core output -> Antigravity output. Only SessionStart / PreInvocation can put text in front of
 * the model outside a denial, so context produced anywhere else is returned as `carry` and
 * delivered by the next PreInvocation (delayed L1). A tool call Weft has no objection to answers
 * `decision:"ask"`: the user's own permission settings decide (a Weft `allow` must not
 * auto-approve anything).
 */
export function fromCore(event: AntigravityEvent, out: HookOutput, carried = ""): { json: Record<string, unknown>; carry?: string } {
  const o = (out ?? {}) as CoreOut;
  const hso = o.hookSpecificOutput ?? {};
  const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n");
  switch (event) {
    case "PreToolUse":
      if (hso.permissionDecision === "deny") return { json: { decision: "deny", reason: hso.permissionDecisionReason ?? "[weft] blocked" } };
      return { json: { ...NO_OPINION }, ...(hso.additionalContext ? { carry: hso.additionalContext } : {}) };
    case "PostToolUse":
      return { json: {}, ...(hso.additionalContext ? { carry: hso.additionalContext } : {}) };
    case "SessionStart":
    case "PreInvocation": {
      const text = join(carried, hso.additionalContext);
      return { json: text ? { injectSteps: [injectStep(text)] } : {} };
    }
    case "Stop":
      if (o.decision === "block" && o.reason) return { json: { decision: "continue", reason: join(carried, o.reason) } };
      return { json: {}, ...(carried ? { carry: carried } : {}) };
    default:
      return { json: {} };
  }
}

/** What a hook answers when it cannot decide (bad input, unconfigured workspace, crash): fail open. */
export const failOpen = (event: AntigravityEvent | undefined): Record<string, unknown> => (event === "PreToolUse" ? { ...NO_OPINION } : {});

/** Where an install writes the workspace hooks file. */
export const hooksPath = (root: string) => join(root, ".agents", "hooks.json");
