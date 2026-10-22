// Host dialects: how a core event (hooks-core-v0 §4) is spelled on one harness's native
// hook wire, and how that harness's native hook output is read back as a core decision
// (§5). The conformance runner speaks a dialect to the hook command under test; `bridge`
// uses the same codecs to wrap a native hook so that it speaks the core stdio binding.
//
// Native shapes follow docs/research/hooks.md (official docs, 2026-10-03) and the
// mapping table in hooks-core-v0.md §10.
import { isAbsolute, join } from "node:path";
import { HOOKS_CORE_VERSION, checkDecision, type CoreDecision, type CoreEvent, type CoreTool } from "./core";
import { copilot } from "./dialects/copilot";

/** What a hook process returned. */
export type RawResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean; ms: number };

export type Decoded = { decision: CoreDecision; problems: string[] };

export type Dialect = {
  name: string;
  /** Native stdin for a core event; undefined = the host has no hook point for it. */
  encode(ev: CoreEvent): unknown | undefined;
  /** Native output -> core decision; `problems` lists wire-level non-conformities. */
  decode(ev: CoreEvent, raw: RawResult): Decoded;
};

const abs = (ev: CoreEvent, p: string | undefined) => (p === undefined ? undefined : isAbsolute(p) ? p : join(ev.cwd, p));

function parseJson(raw: RawResult): { value: Record<string, unknown>; problems: string[] } {
  const text = raw.stdout.trim();
  if (!text) return { value: {}, problems: [] };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { value: {}, problems: ["stdout is JSON but not an object"] };
    return { value: v as Record<string, unknown>, problems: [] };
  } catch {
    return { value: {}, problems: [`stdout is not JSON: ${text.slice(0, 80)}`] };
  }
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const mk = (decision: CoreDecision["decision"], explanation?: string): CoreDecision => ({ hooks: HOOKS_CORE_VERSION, decision, ...(explanation ? { explanation } : {}) });
const join2 = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n") || undefined;

// ---------------------------------------------------------------- core (stdio binding)

export const core: Dialect = {
  name: "core",
  encode: (ev) => ev,
  decode: (_ev, raw) => {
    const { value, problems } = parseJson(raw);
    if (!raw.stdout.trim()) return { decision: mk("allow"), problems: ["empty stdout: the core stdio binding requires a decision object"] };
    const p = checkDecision(value);
    const d = value as unknown as CoreDecision;
    return { decision: p.length ? mk(d.decision === "deny" ? "deny" : "allow", s(d.explanation)) : d, problems: [...problems, ...p] };
  },
};

// ---------------------------------------------------------------- Claude Code / Codex family

function ccTool(t: CoreTool, ev: CoreEvent, codex: boolean): { tool_name: string; tool_input: Record<string, unknown> } {
  const path = abs(ev, t.path);
  if (codex && (t.kind === "edit" || t.kind === "write" || t.kind === "delete")) return { tool_name: "apply_patch", tool_input: { command: applyPatch(t) } };
  switch (t.kind) {
    case "edit":
      return { tool_name: "Edit", tool_input: { file_path: path, old_string: t.old_text ?? "", new_string: t.new_text ?? "", replace_all: false } };
    case "write":
      return { tool_name: "Write", tool_input: { file_path: path, content: t.content ?? "" } };
    case "delete":
      return { tool_name: "Bash", tool_input: { command: `rm -f ${JSON.stringify(t.path ?? "")}` } };
    case "shell":
      return { tool_name: "Bash", tool_input: { command: t.command ?? "" } };
    case "read":
      return codex ? { tool_name: "Bash", tool_input: { command: `cat ${JSON.stringify(t.path ?? "")}` } } : { tool_name: "Read", tool_input: { file_path: path } };
    default:
      return { tool_name: t.name ?? "WebFetch", tool_input: {} };
  }
}

/** Codex `apply_patch` body for a core edit/write/delete (line-granular hunks). */
export function applyPatch(t: CoreTool): string {
  const p = t.path ?? "";
  const lines = (x: string) => x.replace(/\n$/, "").split("\n");
  if (t.kind === "write") return ["*** Begin Patch", `*** Add File: ${p}`, ...lines(t.content ?? "").map((l) => `+${l}`), "*** End Patch"].join("\n");
  if (t.kind === "delete") return ["*** Begin Patch", `*** Delete File: ${p}`, "*** End Patch"].join("\n");
  return ["*** Begin Patch", `*** Update File: ${p}`, "@@", ...lines(t.old_text ?? "").map((l) => `-${l}`), ...lines(t.new_text ?? "").map((l) => `+${l}`), "*** End Patch"].join("\n");
}

function claudeFamily(name: string, codex: boolean): Dialect {
  return {
    name,
    encode(ev) {
      const base = { session_id: ev.session, cwd: ev.cwd, transcript_path: join(ev.cwd, ".conformance-transcript.jsonl") };
      switch (ev.event) {
        case "session.start":
          return { ...base, hook_event_name: "SessionStart", source: "startup" };
        case "prompt.submit":
          return { ...base, hook_event_name: "UserPromptSubmit", prompt: ev.prompt ?? "" };
        case "tool.pre":
        case "tool.post": {
          const t = ccTool(ev.tool!, ev, codex);
          return {
            ...base,
            hook_event_name: ev.event === "tool.pre" ? "PreToolUse" : "PostToolUse",
            ...t,
            tool_use_id: ev.tool!.call_id,
            ...(ev.event === "tool.post" ? { tool_response: codex ? ev.tool!.output ?? "Success" : { success: true, output: ev.tool!.output ?? "" } } : {}),
          };
        }
        case "agent.stop":
          return { ...base, hook_event_name: "Stop", stop_hook_active: (ev.stop?.repeat ?? 0) > 0 };
        case "session.end":
          return { ...base, hook_event_name: "SessionEnd", reason: ev.reason ?? "other" };
      }
    },
    decode(ev, raw) {
      // Exit 2 is the documented blocking path: stderr is the model-visible reason.
      if (raw.code === 2) {
        const why = s(raw.stderr);
        const problems = why ? [] : ["exit 2 without a stderr reason"];
        return { decision: ev.event === "tool.post" || ev.event === "session.start" ? mk("advise", why) : mk("deny", why), problems };
      }
      const { value: o, problems } = parseJson(raw);
      const hso = obj(o.hookSpecificOutput);
      const ctx = s(hso.additionalContext);
      if (hso.permissionDecision === "deny") {
        const why = s(hso.permissionDecisionReason);
        if (!why) problems.push("permissionDecision deny without permissionDecisionReason");
        return { decision: mk("deny", why), problems };
      }
      if (o.decision === "block") {
        const why = s(o.reason);
        if (!why) problems.push('decision "block" without a reason');
        // A post-tool block cannot undo the tool: it is model-visible feedback (advise).
        return { decision: ev.event === "tool.post" ? mk("advise", join2(why, ctx)) : mk("deny", why), problems };
      }
      if (o.continue === false) return { decision: mk("deny", s(o.stopReason) ?? "continue: false"), problems };
      return { decision: ctx ? mk("advise", ctx) : mk("allow"), problems };
    },
  };
}

export const claudeCode = claudeFamily("claude-code", false);
export const codex = claudeFamily("codex", true);

// ---------------------------------------------------------------- Cursor

export const cursor: Dialect = {
  name: "cursor",
  encode(ev) {
    const base = { conversation_id: ev.session, generation_id: `gen-${ev.id}`, workspace_roots: [ev.cwd], cursor_version: "conformance" };
    const tool = (t: CoreTool): { tool_name: string; tool_input: Record<string, unknown> } => {
      const path = abs(ev, t.path);
      switch (t.kind) {
        case "edit":
          return { tool_name: "edit_file", tool_input: { file_path: path, old_string: t.old_text ?? "", new_string: t.new_text ?? "" } };
        case "write":
          return { tool_name: "write", tool_input: { file_path: path, contents: t.content ?? "" } };
        case "delete":
          return { tool_name: "delete_file", tool_input: { file_path: path } };
        case "shell":
          return { tool_name: "Shell", tool_input: { command: t.command ?? "", working_directory: ev.cwd } };
        case "read":
          return { tool_name: "read_file", tool_input: { target_file: path } };
        default:
          return { tool_name: t.name ?? "web_search", tool_input: {} };
      }
    };
    switch (ev.event) {
      case "session.start":
        return { ...base, hook_event_name: "sessionStart" };
      case "prompt.submit":
        return { ...base, hook_event_name: "beforeSubmitPrompt", prompt: ev.prompt ?? "" };
      case "tool.pre":
        return { ...base, hook_event_name: "preToolUse", ...tool(ev.tool!), tool_use_id: ev.tool!.call_id };
      case "tool.post":
        return { ...base, hook_event_name: "postToolUse", ...tool(ev.tool!), tool_use_id: ev.tool!.call_id, tool_output: ev.tool!.output ?? "" };
      case "agent.stop":
        return { ...base, hook_event_name: "stop", status: "completed", loop_count: ev.stop?.repeat ?? 0 };
      case "session.end":
        return { ...base, hook_event_name: "sessionEnd", reason: ev.reason ?? "completed" };
    }
  },
  decode(ev, raw) {
    const { value: o, problems } = parseJson(raw);
    // Cursor: a permission hook with invalid output blocks the action.
    if (ev.event === "tool.pre" && problems.length) return { decision: mk("deny", "invalid hook output (Cursor blocks)"), problems };
    if (ev.event === "tool.pre") {
      if (o.permission === "deny" || o.permission === "ask") {
        const why = s(o.agent_message) ?? s(o.user_message);
        if (!why) problems.push(`permission "${String(o.permission)}" without agent_message`);
        return { decision: mk("deny", why), problems };
      }
      if (o.permission !== "allow") problems.push("preToolUse answered without a permission field");
      return { decision: s(o.agent_message) ? mk("advise", s(o.agent_message)) : mk("allow"), problems };
    }
    if (ev.event === "agent.stop") return { decision: s(o.followup_message) ? mk("deny", s(o.followup_message)) : mk("allow"), problems };
    const ctx = s(o.additional_context);
    return { decision: ctx ? mk("advise", ctx) : mk("allow"), problems };
  },
};

// ---------------------------------------------------------------- Gemini CLI

export const gemini: Dialect = {
  name: "gemini",
  encode(ev) {
    const base = { session_id: ev.session, cwd: ev.cwd, timestamp: new Date().toISOString(), transcript_path: join(ev.cwd, ".conformance-transcript.json") };
    const tool = (t: CoreTool): { tool_name: string; tool_input: Record<string, unknown> } => {
      const path = abs(ev, t.path);
      switch (t.kind) {
        case "edit":
          return { tool_name: "replace", tool_input: { file_path: path, old_string: t.old_text ?? "", new_string: t.new_text ?? "", expected_replacements: 1 } };
        case "write":
          return { tool_name: "write_file", tool_input: { file_path: path, content: t.content ?? "" } };
        case "delete":
          return { tool_name: "run_shell_command", tool_input: { command: `rm -f ${JSON.stringify(t.path ?? "")}` } };
        case "shell":
          return { tool_name: "run_shell_command", tool_input: { command: t.command ?? "" } };
        case "read":
          return { tool_name: "read_file", tool_input: { absolute_path: path } };
        default:
          return { tool_name: t.name ?? "web_fetch", tool_input: {} };
      }
    };
    switch (ev.event) {
      case "session.start":
        return { ...base, hook_event_name: "SessionStart", source: "startup" };
      case "prompt.submit":
        return { ...base, hook_event_name: "BeforeAgent", prompt: ev.prompt ?? "" };
      case "tool.pre":
        return { ...base, hook_event_name: "BeforeTool", ...tool(ev.tool!) };
      case "tool.post":
        return { ...base, hook_event_name: "AfterTool", ...tool(ev.tool!), tool_response: { llmContent: ev.tool!.output ?? "" } };
      case "agent.stop":
        return { ...base, hook_event_name: "AfterAgent", prompt: "", prompt_response: "done", stop_hook_active: (ev.stop?.repeat ?? 0) > 0 };
      case "session.end":
        return { ...base, hook_event_name: "SessionEnd", reason: ev.reason ?? "exit" };
    }
  },
  decode(ev, raw) {
    if (raw.code === 2) {
      const why = s(raw.stderr);
      return { decision: ev.event === "tool.post" ? mk("advise", why) : mk("deny", why), problems: why ? [] : ["exit 2 without a stderr reason"] };
    }
    const { value: o, problems } = parseJson(raw);
    const ctx = s(obj(o.hookSpecificOutput).additionalContext);
    if (o.decision === "deny" || o.decision === "block") {
      const why = s(o.reason);
      if (!why) problems.push(`decision "${String(o.decision)}" without a reason`);
      return { decision: ev.event === "tool.post" ? mk("advise", join2(why, ctx)) : mk("deny", why), problems };
    }
    if (o.continue === false) return { decision: mk("deny", s(o.stopReason) ?? "continue: false"), problems };
    return { decision: ctx ? mk("advise", ctx) : mk("allow"), problems };
  },
};

// ---------------------------------------------------------------- OpenCode (plugin bridge messages)

export const opencode: Dialect = {
  name: "opencode",
  encode(ev) {
    const base = { sessionID: ev.session, directory: ev.cwd };
    const tool = (t: CoreTool): { tool: string; args: Record<string, unknown> } => {
      const filePath = abs(ev, t.path);
      switch (t.kind) {
        case "edit":
          return { tool: "edit", args: { filePath, oldString: t.old_text ?? "", newString: t.new_text ?? "", replaceAll: false } };
        case "write":
          return { tool: "write", args: { filePath, content: t.content ?? "" } };
        case "delete":
        case "shell":
          return { tool: "bash", args: { command: t.kind === "delete" ? `rm -f ${JSON.stringify(t.path ?? "")}` : t.command ?? "", description: "conformance" } };
        case "read":
          return { tool: "read", args: { filePath } };
        default:
          return { tool: t.name ?? "webfetch", args: {} };
      }
    };
    switch (ev.event) {
      case "session.start":
        return { ...base, kind: "system" };
      case "prompt.submit":
        return undefined; // OpenCode plugins have no prompt hook point the bridge forwards
      case "tool.pre":
        return { ...base, kind: "before", callID: ev.tool!.call_id, ...tool(ev.tool!) };
      case "tool.post":
        return { ...base, kind: "after", callID: ev.tool!.call_id, ...tool(ev.tool!), output: ev.tool!.output ?? "" };
      case "agent.stop":
        return { ...base, kind: "idle" };
      case "session.end":
        return { ...base, kind: "end" };
    }
  },
  decode(ev, raw) {
    const { value: o, problems } = parseJson(raw);
    if (s(o.deny)) return { decision: mk("deny", s(o.deny)), problems };
    if (ev.event === "agent.stop" && s(o.prompt)) return { decision: mk("deny", s(o.prompt)), problems };
    const ctx = join2(s(o.system), s(o.append));
    return { decision: ctx ? mk("advise", ctx) : mk("allow"), problems };
  },
};

export const DIALECTS: Record<string, Dialect> = { core, "claude-code": claudeCode, codex, cursor, gemini, opencode, copilot };

export function dialect(name: string): Dialect {
  const d = DIALECTS[name];
  if (!d) throw new Error(`unknown dialect ${name} (known: ${Object.keys(DIALECTS).join(", ")})`);
  return d;
}
