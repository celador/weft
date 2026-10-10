// Claude Code hook handlers -> WCP v0.1 (spec §8.3, §8.5; docs/research/hooks.md).
//
//   SessionStart       hello (or resume), inject welcome + inbox            (L1)
//   UserPromptSubmit   drain inbox, inject                                   (L1)
//   PreToolUse  Edit|Write|MultiEdit
//                      analyze proposed text -> submit mode:"check";
//                      reject -> permissionDecision "deny" + diagnostics     (L2)
//                      accept with warnings -> allow + additionalContext
//   PreToolUse  Bash `git commit`  gate commit -> deny while errors are open (L3, commit_gate)
//   PostToolUse Edit|Write|MultiEdit
//                      real before/after -> submit mode:"commit" with diff,
//                      inject verdict + inbox as additionalContext           (L1)
//   PostToolUse (other) drain inbox (throttled); Bash HEAD move -> checkpoint
//   Stop               gate stop -> decision "block" while errors are open   (L3)
//   SessionEnd         bye (unless errors are open: then the session stays for the git gate)
//
// base_seq (spec §5.2) advances only when coordinator text actually reaches the model
// (a deny reason, additionalContext, a stop reason) — never on a silent response. So an
// agent that read a file before another agent changed a signature in it still submits
// with the old base, and R2 flags its call site.
//
// Fail open: any coordinator/transport failure lets the tool run (logged, and noted to the
// model) — an unreachable coordinator must never wedge the agent.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentRef, Capabilities, Diagnostic, EventDraft, EventRecord, InboxItem, NegotiateCommand, NegotiationDue, SymbolKey, Verdict } from "@weft/protocol";
import { WcpError, PROTOCOL, type Transport } from "./client";
import { readState, withLock, writeState, type Loaded, type SessionState } from "./config";
import { EDIT_TOOLS, editPath, isGitCommit, proposedText } from "./edits";
import { renderDues, renderForModel, type EditedFile, type RenderCtx } from "./render";
import type { Sets, FileChange } from "./analysis";

export const ADAPTER_VERSION = "0.1.0";
export const CAPABILITIES: Capabilities = {
  level: 3,
  observe: "sync",
  inject: "immediate",
  deny_edit: true,
  refuse_stop: true,
  commit_gate: "tool_interception",
};
/**
 * Declared when the loaded config is advisory (`mode: "advise"` / WEFT_MODE=advise): denials
 * become advise text and the stop/commit gates stay open, so the adapter delivers L1 and,
 * per Agent Hooks Core §3.3, MUST NOT declare L2/L3.
 */
export const ADVISORY_CAPABILITIES: Capabilities = {
  level: 1,
  observe: "sync",
  inject: "immediate",
  deny_edit: false,
  refuse_stop: false,
  commit_gate: false,
};
const SKIP_PARTS = new Set([".git", ".weft", ".claude", ".cursor", ".opencode", ".gemini", "node_modules", ".wrangler", "dist", ".turbo"]);
const DRAIN_MIN_INTERVAL_MS = 2000;
const MAX_FILE_BYTES = 1 << 20;

export type HookInput = {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
  transcript_path?: string;
  reason?: string;
};
export type HookOutput = Record<string, unknown> | undefined;

export type AdapterDeps = {
  transport: Transport;
  /** Analyzer entry (lazy so non-edit hooks never load the TypeScript compiler). */
  analyze: (changes: FileChange[], root: string, prefix: string) => Promise<Sets> | Sets;
  diff: (rel: string, before: string | null, after: string | null) => Promise<string> | string;
  now?: () => number;
  harnessVersion?: string;
  model?: string;
  /** Spawn the background heartbeat for a Claude session (no-op in tests). */
  startHeartbeat?: (claudeSession: string) => void;
  /** Shell command the model runs for `negotiate` / `inbox` (e.g. `<checkout>/.weft/bin/weft`). */
  cli?: string;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Who is speaking WCP. Defaults to Claude Code; harness translators that reuse this
   * core (Cursor CLI, OpenCode, Gemini CLI) pass their own identity and the capabilities
   * they actually achieve on that harness (spec §8.1: declare what you deliver).
   */
  identity?: { harness: string; adapter: string; capabilities: Capabilities };
};

export type CliResult = { text: string; code: number };
/** `weft claim --keys k1,k2 [--firm] [--ttl MS]` (see claim()). */
export type ClaimCommand = { keys: string[]; firm: boolean; ttl_ms?: number };

type Target = { abs: string; rel: string };

export class ClaudeAdapter {
  private readonly root: string;
  private readonly prefix: string;
  private readonly now: () => number;
  private readonly eventCache = new Map<number, EventRecord | undefined>();

  constructor(
    private readonly loaded: Loaded,
    private readonly deps: AdapterDeps,
  ) {
    this.root = loaded.root;
    this.prefix = loaded.config.prefix ?? "";
    this.now = deps.now ?? Date.now;
  }

  get enforce(): boolean {
    return (this.loaded.config.mode ?? "enforce") === "enforce";
  }

  // ------------------------------------------------------------------ infra

  log(message: string): void {
    try {
      const dir = join(this.root, ".weft", "log");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "adapter.log");
      if (existsSync(path) && statSync(path).size > 2_000_000) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date(this.now()).toISOString()} ${message}\n`);
    } catch {
      /* logging must never break a hook */
    }
  }

  git(args: string[]): string | undefined {
    try {
      return execFileSync("git", ["-C", this.root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    } catch {
      return undefined;
    }
  }

  private target(path: string, cwd?: string): Target | undefined {
    const abs = resolve(isAbsolute(path) ? path : join(cwd ?? this.root, path));
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const parts = rel.split(sep);
    if (parts.some((p) => SKIP_PARTS.has(p))) return undefined;
    return { abs, rel: parts.join("/") };
  }

  private readText(abs: string): string | null {
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) return null;
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  private async fetchEvent(seq: number): Promise<EventRecord | undefined> {
    if (this.eventCache.has(seq)) return this.eventCache.get(seq);
    let rec: EventRecord | undefined;
    try {
      rec = await this.deps.transport.event(seq);
    } catch (err) {
      this.log(`event #${seq} unavailable: ${String(err)}`);
    }
    this.eventCache.set(seq, rec);
    return rec;
  }

  private ctx(edited?: EditedFile): RenderCtx {
    return {
      root: this.root,
      prefix: this.prefix,
      edited,
      fetchEvent: (s) => this.fetchEvent(s),
      change: this.loaded.config.change,
      ...(this.deps.cli ? { cli: this.deps.cli } : {}),
    };
  }

  // ------------------------------------------------------------------ session + base bookkeeping

  private async hello(st: SessionState): Promise<string> {
    const { config } = this.loaded;
    const t = this.deps.transport;
    const agent = {
      id: config.agent,
      harness: this.deps.identity?.harness ?? "claude-code",
      adapter: this.deps.identity?.adapter ?? `@weft/adapter-claude-code@${ADAPTER_VERSION}`,
      ...(this.deps.harnessVersion ? { harness_version: this.deps.harnessVersion } : {}),
      ...(this.deps.model ? { model: this.deps.model } : {}),
    };
    const task = { id: config.task.id, ...(config.task.title ? { title: config.task.title } : {}), ...(config.task.priority !== undefined ? { priority: config.task.priority } : {}) };
    const welcome = await t.hello({ type: "hello", protocol: PROTOCOL, agent, capabilities: this.enforce ? (this.deps.identity?.capabilities ?? CAPABILITIES) : ADVISORY_CAPABILITIES, task, change: config.change });
    // A new session cannot claim more than it was delivered; an older base (what this
    // Claude conversation actually saw) is kept so stale knowledge stays visible to R1/R2.
    st.base = st.wcpSession === undefined && st.base === 0 ? welcome.delivered_through : Math.min(st.base || welcome.delivered_through, welcome.delivered_through);
    st.wcpSession = welcome.session;
    st.acked = 0;
    st.lastContact = this.now();
    this.log(`hello ${config.agent} change ${config.change} -> ${welcome.session} head #${welcome.head_seq} base #${st.base}`);
    return welcome.session;
  }

  private async ensure(st: SessionState): Promise<string> {
    return st.wcpSession ?? (await this.hello(st));
  }

  /** Run a session call; re-hello once if the coordinator forgot the session (410). */
  private async call<T>(st: SessionState, fn: (session: string) => Promise<T>): Promise<T> {
    const session = await this.ensure(st);
    try {
      const r = await fn(session);
      st.lastContact = this.now();
      return r;
    } catch (err) {
      if (!(err instanceof WcpError) || (err.code !== "session_expired" && err.status !== 404)) throw err;
      this.log(`session ${session} expired; re-hello`);
      st.wcpSession = undefined;
      const fresh = await this.hello(st);
      const r = await fn(fresh);
      st.lastContact = this.now();
      return r;
    }
  }

  private effectiveBase(st: SessionState): number {
    const floor = st.rebaseFloor ? st.rebaseFloor.seq - 1 : Infinity;
    return Math.max(0, Math.min(st.base, floor));
  }

  /** Note trunk items (spec §5.2): keep base below a landing until the checkout has it. */
  private noteItems(st: SessionState, items: InboxItem[]): number {
    let top = 0;
    for (const item of items) {
      top = Math.max(top, item.id);
      if (item.kind === "trunk" && item.requires_rebase) {
        const sha = typeof item.record?.payload?.sha === "string" ? (item.record.payload.sha as string) : undefined;
        if (!st.rebaseFloor || item.seq < st.rebaseFloor.seq) st.rebaseFloor = { seq: item.seq, ...(sha ? { sha } : {}) };
      }
    }
    return top;
  }

  private refreshFloor(st: SessionState): void {
    if (!st.rebaseFloor) return;
    const sha = st.rebaseFloor.sha;
    if (sha && this.git(["merge-base", "--is-ancestor", sha, "HEAD"]) !== undefined) {
      this.log(`checkout contains landing #${st.rebaseFloor.seq} (${sha.slice(0, 10)}); base floor cleared`);
      st.rebaseFloor = undefined;
    }
  }

  /** Text is about to reach the model: advance base to what the response delivered, ack items. */
  private delivered(st: SessionState, text: string, deliveredThrough: number, items: InboxItem[]): string {
    const top = this.noteItems(st, items);
    if (!text) return text;
    st.base = Math.max(st.base, deliveredThrough);
    st.acked = Math.max(st.acked, top);
    return text;
  }

  private ack(st: SessionState): number | undefined {
    return st.acked > 0 ? st.acked : undefined;
  }

  private draft(st: SessionState, kind: EventDraft["kind"], extra: Partial<EventDraft>): EventDraft {
    const { task } = this.loaded.config;
    return {
      kind,
      base_seq: this.effectiveBase(st),
      ...(task.title ? { intent: `${task.id}: ${task.title}`, summary_hint: task.title.slice(0, 100) } : {}),
      ...extra,
    };
  }

  private async submit(st: SessionState, mode: "check" | "commit", event: EventDraft, key: string): Promise<Verdict> {
    return this.call(st, (s) => this.deps.transport.submit(s, { type: "submit", mode, event, ...(this.ack(st) ? { inbox_ack: st.acked } : {}) }, `${this.loaded.config.change}:${key}:${mode}`));
  }

  // ------------------------------------------------------------------ entry

  async handle(input: HookInput): Promise<HookOutput> {
    if (!input?.session_id || !input.hook_event_name) return undefined;
    return withLock(this.root, input.session_id, async () => {
      const st = readState(this.root, input.session_id);
      try {
        const out = await this.dispatch(input, st);
        return out;
      } catch (err) {
        this.log(`${input.hook_event_name} ${input.tool_name ?? ""} failed open: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return this.failOpen(input, err);
      } finally {
        writeState(this.root, st);
      }
    });
  }

  private failOpen(input: HookInput, err: unknown): HookOutput {
    const event = input.hook_event_name;
    if (event !== "PreToolUse" && event !== "PostToolUse") return undefined;
    if (event === "PreToolUse" && !EDIT_TOOLS.has(input.tool_name ?? "")) return undefined;
    const msg = `[weft] coordinator unavailable (${err instanceof WcpError ? err.code : "error"}); this edit was not coordinated.`;
    return { hookSpecificOutput: { hookEventName: event, additionalContext: msg } };
  }

  private async dispatch(input: HookInput, st: SessionState): Promise<HookOutput> {
    this.refreshFloor(st);
    switch (input.hook_event_name) {
      case "SessionStart":
        return this.sessionStart(input, st);
      case "UserPromptSubmit":
        return this.promptSubmit(st);
      case "PreToolUse":
        if (EDIT_TOOLS.has(input.tool_name ?? "")) return this.preEdit(input, st);
        if (input.tool_name === "Bash") return this.preBash(input, st);
        return undefined;
      case "PostToolUse":
        if (EDIT_TOOLS.has(input.tool_name ?? "")) return this.postEdit(input, st);
        return this.postOther(input, st);
      case "Stop":
      case "SubagentStop":
        return this.stop(input, st);
      case "SessionEnd":
        return this.sessionEnd(input, st);
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------------------ hooks

  private async sessionStart(input: HookInput, st: SessionState): Promise<HookOutput> {
    const { config } = this.loaded;
    const fresh = !st.wcpSession;
    await this.ensure(st);
    st.head = this.git(["rev-parse", "HEAD"])?.trim();
    const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
    const inbox = await renderForModel([], batch.items, this.ctx());
    const open = batch.open_errors.length ? await renderForModel(batch.open_errors, [], this.ctx()) : "";
    const lines = [
      `[weft] This checkout is coordinated by Weft (repo ${config.repo}; you are agent ${config.agent}, task ${config.task.id}${config.task.title ? ` "${config.task.title}"` : ""}, change ${config.change}). ` +
        `Other agents edit the same codebase concurrently in their own checkouts. Every edit you make is checked against their work: ` +
        `lines like "[weft error] <code> <file>:<line>: …" are multi-agent compiler diagnostics. An edit with errors is blocked, and you cannot finish while errors are open — fix the cited code (or retreat from it) instead of retrying the same edit.` +
        (this.deps.cli
          ? ` When another agent's change is in your way you may also negotiate with it (\`${this.deps.cli} negotiate propose|accept|reject|counter|escalate …\`, see \`${this.deps.cli} negotiate --help\`); proposals addressed to you arrive as "[weft negotiation]" lines and must be answered before you finish. \`${this.deps.cli} inbox\` shows what is waiting for you.`
          : ""),
      ...(open ? [`Open errors:\n${open}`] : []),
      ...(inbox ? [inbox] : []),
    ];
    this.delivered(st, inbox || open, batch.delivered_through, batch.items);
    if (fresh) this.deps.startHeartbeat?.(input.session_id);
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } };
  }

  private async promptSubmit(st: SessionState): Promise<HookOutput> {
    const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
    const text = this.delivered(st, await renderForModel([], batch.items, this.ctx()), batch.delivered_through, batch.items);
    return text ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `[weft diagnostics]\n${text}` } } : undefined;
  }

  private async preEdit(input: HookInput, st: SessionState): Promise<HookOutput> {
    const tool = input.tool_name!;
    const args = input.tool_input ?? {};
    const path = editPath(args);
    const t = path ? this.target(path, input.cwd) : undefined;
    if (!t) return undefined; // outside the coordinated checkout
    const callId = input.tool_use_id ?? `anon-${this.now()}`;
    const before = existsSync(t.abs) ? this.readText(t.abs) : null;
    st.pending[callId] = { tool, before: { [t.rel]: before }, shown: [], at: this.now() };
    const after = proposedText(tool, args, before);
    if (after === undefined || after === before) return undefined;
    const sets = await this.deps.analyze([{ rel: t.rel, before, after }], this.root, this.prefix);
    if (!sets.writes.length) return undefined; // comment/import-only change: nothing to conflict with
    const diff = await this.deps.diff(this.prefix + t.rel, before, after);
    const event = this.draft(st, "edit", {
      files: [this.prefix + t.rel],
      reads: sets.reads,
      writes: sets.writes,
      diff,
      tool: { name: tool, call_id: callId.slice(0, 200), harness_event: "PreToolUse" },
    });
    const verdict = await this.submit(st, "check", event, callId);
    const text = await renderForModel(verdict.diagnostics, verdict.inbox, this.ctx({ rel: t.rel, before, after }));
    this.log(`check ${t.rel} base #${event.base_seq} -> ${verdict.verdict}${verdict.seq ? ` #${verdict.seq}` : ""} (${verdict.diagnostics.map((d) => d.code).join(",") || "clean"})`);
    if (verdict.verdict === "reject" && this.enforce) {
      delete st.pending[callId];
      this.delivered(st, text, verdict.delivered_through, verdict.inbox);
      const reason =
        `[weft] Edit to ${this.prefix + t.rel} blocked: it conflicts with another agent's change (Weft edit-time coordination, log #${verdict.seq}).\n${text}\n` +
        `Do not retry the same edit. Adapt your code to the change described above (or work around it), then edit again — your next attempt is checked against the current log.`;
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    }
    if (!text) return undefined;
    this.delivered(st, text, verdict.delivered_through, verdict.inbox);
    st.pending[callId].shown = text.split("\n");
    const prefix = verdict.verdict === "reject" ? "[weft] (advisory mode) this edit would be blocked:\n" : "[weft diagnostics]\n";
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: prefix + text } };
  }

  private async preBash(input: HookInput, st: SessionState): Promise<HookOutput> {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    st.head = this.git(["rev-parse", "HEAD"])?.trim() ?? st.head;
    if (!isGitCommit(command) || !st.wcpSession || !this.enforce) return undefined;
    const result = await this.call(st, (s) => this.deps.transport.gate(s, "commit"));
    if (result.allow) return undefined;
    const errors = await renderForModel(result.open_errors, [], this.ctx());
    this.log(`commit gate refused (${result.open_errors.length} open errors)`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[weft] git commit refused by the Weft commit gate: ${result.open_errors.length} open error(s).\n${errors}\nResolve them (an accepted edit that touches the cited symbol clears it), then commit.`,
      },
    };
  }

  private async postEdit(input: HookInput, st: SessionState): Promise<HookOutput> {
    const tool = input.tool_name!;
    const args = input.tool_input ?? {};
    const path = editPath(args);
    const t = path ? this.target(path, input.cwd) : undefined;
    const callId = input.tool_use_id ?? "";
    const pend = st.pending[callId];
    delete st.pending[callId];
    if (!t) return undefined;
    let before: string | null | undefined = pend?.before[t.rel];
    if (before === undefined) {
      const original = (input.tool_response as { originalFile?: unknown } | undefined)?.originalFile;
      before = typeof original === "string" ? original : this.git(["show", `HEAD:${t.rel}`]) ?? null;
    }
    const after = existsSync(t.abs) ? this.readText(t.abs) : null;
    if (before === after) return this.postOther(input, st);
    const sets = await this.deps.analyze([{ rel: t.rel, before, after }], this.root, this.prefix);
    if (!sets.writes.length) return this.postOther(input, st);
    let diff = await this.deps.diff(this.prefix + t.rel, before, after);
    if (Buffer.byteLength(diff) > 900_000) diff = "";
    const event = this.draft(st, "edit", {
      files: [this.prefix + t.rel],
      reads: sets.reads,
      writes: sets.writes,
      ...(diff ? { diff } : {}),
      tool: { name: tool, call_id: (callId || `anon-${this.now()}`).slice(0, 200), harness_event: "PostToolUse" },
    });
    const verdict = await this.submit(st, "commit", event, callId || `anon-${this.now()}`);
    st.lastContact = this.now();
    this.log(`commit ${t.rel} base #${event.base_seq} -> ${verdict.verdict} #${verdict.seq} (${verdict.diagnostics.map((d) => d.code).join(",") || "clean"})`);
    const full = await renderForModel(verdict.diagnostics, verdict.inbox, this.ctx({ rel: t.rel, before, after }));
    const shown = new Set(pend?.shown ?? []);
    const fresh = full.split("\n").filter((l) => l && !shown.has(l)).join("\n");
    const header =
      verdict.verdict === "reject"
        ? `[weft] Your edit to ${this.prefix + t.rel} was applied in your checkout but REJECTED by the coordinator (log #${verdict.seq}); it stays an open error until you rework it:\n`
        : "[weft diagnostics]\n";
    const text = this.delivered(st, fresh ? header + fresh : "", verdict.delivered_through, verdict.inbox);
    return text ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } } : undefined;
  }

  private async postOther(input: HookInput, st: SessionState): Promise<HookOutput> {
    if (!st.wcpSession) return undefined; // nothing coordinated yet in this conversation
    let checkpointText = "";
    if (input.tool_name === "Bash") {
      const head = this.git(["rev-parse", "HEAD"])?.trim();
      if (head && st.head && head !== st.head) {
        st.head = head;
        const verdict = await this.submit(st, "commit", this.draft(st, "checkpoint", { payload: { sha: head }, tool: { name: "Bash", harness_event: "PostToolUse" } }), `checkpoint-${head}`);
        this.log(`checkpoint ${head.slice(0, 10)} -> #${verdict.seq}`);
        if (st.rebaseFloor && !st.rebaseFloor.sha) st.rebaseFloor = undefined; // assume the new commit is rebased
        checkpointText = this.delivered(st, await renderForModel(verdict.diagnostics, verdict.inbox, this.ctx()), verdict.delivered_through, verdict.inbox);
      } else if (head) st.head = head;
    }
    if (!checkpointText && this.now() - st.lastContact < DRAIN_MIN_INTERVAL_MS) return undefined;
    let text = checkpointText;
    if (!text) {
      const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
      text = this.delivered(st, await renderForModel([], batch.items, this.ctx()), batch.delivered_through, batch.items);
    }
    return text ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `[weft diagnostics]\n${text}` } } : undefined;
  }

  private async stop(input: HookInput, st: SessionState): Promise<HookOutput> {
    if (!st.wcpSession || !this.enforce) return undefined;
    const result = await this.call(st, (s) => this.deps.transport.gate(s, "stop"));
    if (result.allow) {
      st.stopRefusals = undefined;
      return undefined;
    }
    const dues: NegotiationDue[] = result.negotiations ?? [];
    const fingerprint = [...new Set([...result.open_errors.map((d: Diagnostic) => `${d.code}:${d.symbol}`), ...dues.map((d) => `${d.due}:#${d.seq}`)])].sort().join(",");
    const count = st.stopRefusals?.fingerprint === fingerprint ? st.stopRefusals.count + 1 : 1;
    st.stopRefusals = { fingerprint, count };
    const max = this.loaded.config.maxStopRefusals ?? 5;
    if (count > max) {
      this.log(`stop gate: letting the agent stop after ${max} refusals; open errors stay visible in the feed (${fingerprint})`);
      return undefined;
    }
    const errors = result.open_errors.length ? await renderForModel(result.open_errors, [], this.ctx()) : "";
    const owed = dues.length ? renderDues(dues, this.ctx()) : "";
    this.log(`stop gate refused #${count} (${fingerprint})`);
    const text = [errors, owed].filter(Boolean).join("\n");
    this.delivered(st, text, st.base, []);
    return {
      decision: "block",
      reason:
        `[weft] Not done (stop refusal ${count}/${max}): ${[
          result.open_errors.length ? `${result.open_errors.length} open Weft error(s)` : "",
          dues.length ? `${dues.length} negotiation(s) owed` : "",
        ]
          .filter(Boolean)
          .join(", ")}.\n${text}\n` +
        (result.open_errors.length ? `Resolve each error by re-editing the cited code against the change it names (an accepted edit touching the symbol clears it), or retreat from that code.` : "") +
        (dues.length ? `${result.open_errors.length ? " " : ""}Answer each proposal and make every edit you agreed to.` : ""),
    };
  }

  private async sessionEnd(input: HookInput, st: SessionState): Promise<HookOutput> {
    if (!st.wcpSession) return undefined;
    // Open errors live on the WCP session (spec §6.5). Closing it would silently forgive
    // them, so a session with open errors stays alive (heartbeat loop, 30 min idle limit):
    // the git pre-commit gate and a resumed conversation still see them.
    try {
      const g = await this.call(st, (s) => this.deps.transport.gate(s, "commit"));
      if (!g.allow) {
        this.log(`session end: keeping ${st.wcpSession} open (${g.open_errors.length} open errors)`);
        return undefined;
      }
    } catch (err) {
      this.log(`session end gate check failed: ${String(err)}`);
    }
    try {
      await this.deps.transport.bye(st.wcpSession, `${this.deps.identity?.harness ?? "claude-code"} session end${input.reason ? `: ${input.reason}` : ""}`);
    } catch (err) {
      this.log(`bye failed: ${String(err)}`);
    }
    this.log(`bye ${st.wcpSession}`);
    st.wcpSession = undefined;
    st.pending = {};
    return undefined;
  }

  // ------------------------------------------------------------------ shell CLI: negotiate + inbox

  private async causeChange(seq: number): Promise<string | undefined> {
    return (await this.fetchEvent(seq))?.change;
  }

  /**
   * Default counterpart of `propose` / `escalate` without --to: the agent behind this
   * session's newest open error, with the keys it blocks (spec §7.2: the loser acts).
   */
  private async defaultCounterpart(open: Diagnostic[]): Promise<{ to: AgentRef; keys: string[] } | undefined> {
    const theirs = open.filter((d) => d.caused_by_agent !== this.loaded.config.agent).sort((a, b) => b.caused_by_seq - a.caused_by_seq);
    if (!theirs.length) return undefined;
    const change = await this.causeChange(theirs[0]!.caused_by_seq);
    const agent = theirs[0]!.caused_by_agent;
    const keys: string[] = [];
    for (const d of theirs) {
      if (!d.symbol || keys.includes(d.symbol)) continue;
      const c = await this.causeChange(d.caused_by_seq);
      if ((change && c === change) || (!change && d.caused_by_agent === agent)) keys.push(d.symbol);
    }
    return { to: change ? { change } : { agent }, keys };
  }

  /** `weft negotiate …` run by the model through its shell. Never throws. */
  async negotiate(claudeSession: string, cmd: NegotiateCommand): Promise<CliResult> {
    let sent: number | null = null;
    let out: CliResult;
    try {
      out = await withLock(this.root, claudeSession, async () => {
        const st = readState(this.root, claudeSession);
        try {
          const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
          const pre = this.delivered(st, await renderForModel([], batch.items, this.ctx()), batch.delivered_through, batch.items);
          let kind: EventDraft["kind"];
          let payload: Record<string, unknown>;
          switch (cmd.cmd) {
            case "propose":
            case "escalate": {
              const dflt = cmd.cmd === "propose" ? (cmd.to && cmd.keys ? undefined : await this.defaultCounterpart(batch.open_errors)) : cmd.with ? undefined : await this.defaultCounterpart(batch.open_errors);
              const to = cmd.cmd === "propose" ? cmd.to ?? dflt?.to : cmd.with ?? dflt?.to;
              const keys = cmd.keys ?? dflt?.keys ?? [];
              if (!to) return { text: "weft: no open conflict to negotiate about here; pass --to AGENT (or --change CHANGE) and --keys path#symbol", code: 2 };
              if (cmd.cmd === "propose") {
                if (!keys.length) return { text: "weft: which symbols? pass --keys path#symbol[,…]", code: 2 };
                kind = "negotiate.propose";
                payload = { to, keys, terms: cmd.terms };
              } else {
                kind = "negotiate.escalate";
                payload = { with: to, reason: cmd.reason, ...(keys.length ? { keys } : {}) };
              }
              break;
            }
            case "counter":
              kind = "negotiate.counter";
              payload = { reply_to: cmd.reply_to, terms: cmd.terms };
              break;
            case "accept":
              kind = "negotiate.accept";
              payload = { reply_to: cmd.reply_to };
              break;
            case "reject":
              kind = "negotiate.reject";
              payload = { reply_to: cmd.reply_to, ...(cmd.reason ? { reason: cmd.reason } : {}) };
              break;
          }
          const event: EventDraft = { kind, base_seq: this.effectiveBase(st), payload, tool: { name: "weft-cli", harness_event: "Bash" } };
          const verdict = await this.submit(st, "commit", event, `${kind}-${this.now()}`);
          sent = verdict.seq;
          this.log(`${kind} -> #${verdict.seq} ${verdict.verdict}`);
          const after = this.delivered(st, await renderForModel(verdict.diagnostics, verdict.inbox, this.ctx()), verdict.delivered_through, verdict.inbox);
          const head = `[weft] sent #${verdict.seq}: ${verdict.summary ?? kind}`;
          return { text: [pre, head, after].filter(Boolean).join("\n"), code: 0 };
        } catch (err) {
          if (err instanceof WcpError) return { text: `weft: ${err.code}: ${err.message}`, code: 1 };
          throw err;
        } finally {
          writeState(this.root, st);
        }
      });
    } catch (err) {
      this.log(`negotiate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { text: `weft: coordinator unavailable (${err instanceof Error ? err.message : String(err)})`, code: 1 };
    }
    const wait = cmd.cmd === "propose" || cmd.cmd === "counter" ? cmd.wait ?? 0 : 0;
    if (out.code !== 0 || !wait || sent === null) return out;
    const reply = await this.waitFor(claudeSession, wait, (i) => i.kind === "negotiation" && Number(i.record?.payload?.reply_to) === sent);
    return { text: `${out.text}\n${reply.text}`, code: reply.code };
  }

  /**
   * `weft claim …` run by the model through its shell: an explicit claim on symbols it intends
   * to write (spec §7.5). `firm` makes an overlapping junior edit an error instead of a warning.
   * Opt-in: nothing claims unless the agent runs this. Never throws.
   */
  /** `path#symbol` as the coordinator keys it for this checkout (same prefix rule as edits). */
  private claimKey(key: string): string {
    const hash = key.indexOf("#");
    const path = (hash < 0 ? key : key.slice(0, hash)).replace(/^\.\//, "");
    const symbol = hash < 0 ? "" : key.slice(hash);
    if (path.split("/").includes("..") || isAbsolute(path)) throw new Error(`claim: ${key} is outside this checkout`);
    return this.prefix + path + symbol;
  }

  async claim(claudeSession: string, cmd: ClaimCommand): Promise<CliResult> {
    // Keys are checked before anything is drained or written: a refused key must not consume the inbox.
    let writes: Array<{ key: SymbolKey; kind: "body" }>;
    try {
      writes = cmd.keys.map((key) => ({ key: this.claimKey(key), kind: "body" as const }));
    } catch (err) {
      return { text: `weft: ${err instanceof Error ? err.message : String(err)}`, code: 1 };
    }
    try {
      return await withLock(this.root, claudeSession, async () => {
        const st = readState(this.root, claudeSession);
        try {
          const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
          const pre = this.delivered(st, await renderForModel([], batch.items, this.ctx()), batch.delivered_through, batch.items);
          const event = this.draft(st, "claim", {
            writes,
            payload: { firm: cmd.firm, source: "explicit", ...(cmd.ttl_ms ? { ttl_ms: cmd.ttl_ms } : {}) },
            tool: { name: "weft-cli", harness_event: "Bash" },
          });
          const verdict = await this.submit(st, "commit", event, `claim-${this.now()}`);
          this.log(`claim ${cmd.keys.join(",")}${cmd.firm ? " (firm)" : ""} -> #${verdict.seq} ${verdict.verdict}`);
          const after = this.delivered(st, await renderForModel(verdict.diagnostics, verdict.inbox, this.ctx()), verdict.delivered_through, verdict.inbox);
          const head = `[weft] ${verdict.verdict === "reject" ? "claim refused" : "claimed"} #${verdict.seq}${cmd.firm ? " (firm)" : ""}: ${verdict.summary ?? cmd.keys.join(", ")}`;
          return { text: [pre, head, after].filter(Boolean).join("\n"), code: verdict.verdict === "reject" ? 1 : 0 };
        } catch (err) {
          if (err instanceof WcpError) return { text: `weft: ${err.code}: ${err.message}`, code: 1 };
          throw err;
        } finally {
          writeState(this.root, st);
        }
      });
    } catch (err) {
      this.log(`claim failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { text: `weft: coordinator unavailable (${err instanceof Error ? err.message : String(err)})`, code: 1 };
    }
  }

  /** Poll the inbox (lock released between polls) until `match` or the deadline. */
  private async waitFor(claudeSession: string, seconds: number, match: (i: InboxItem) => boolean): Promise<CliResult> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = this.now() + seconds * 1000;
    const shown: string[] = [];
    for (;;) {
      const found = await withLock(this.root, claudeSession, async () => {
        const st = readState(this.root, claudeSession);
        try {
          const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
          const text = this.delivered(st, await renderForModel([], batch.items, this.ctx()), batch.delivered_through, batch.items);
          if (text) shown.push(text);
          return batch.items.some(match);
        } finally {
          writeState(this.root, st);
        }
      }).catch(() => false);
      if (found) return { text: shown.join("\n"), code: 0 };
      if (this.now() >= deadline) return { text: [...shown, `[weft] no reply after ${seconds}s. Do other work and check with \`${this.deps.cli ?? "weft"} inbox\`, or choose another option.`].join("\n"), code: 0 };
      await sleep(3000);
    }
  }

  /** `weft inbox [--wait S]`: what is waiting for this agent (items, open errors, negotiations owed). */
  async inbox(claudeSession: string, waitSec = 0): Promise<CliResult> {
    try {
      if (waitSec > 0) {
        const r = await this.waitFor(claudeSession, waitSec, () => true);
        if (r.text && !r.text.startsWith("[weft] no reply")) return r;
      }
      return await withLock(this.root, claudeSession, async () => {
        const st = readState(this.root, claudeSession);
        try {
          const batch = await this.call(st, (s) => this.deps.transport.drain(s, this.ack(st)));
          const g = await this.call(st, (s) => this.deps.transport.gate(s, "stop"));
          const items = await renderForModel([], batch.items, this.ctx());
          const open = batch.open_errors.length ? await renderForModel(batch.open_errors, [], this.ctx()) : "";
          const owed = g.negotiations?.length ? renderDues(g.negotiations, this.ctx()) : "";
          const text = [items, open ? `Open errors:\n${open}` : "", owed ? `Owed:\n${owed}` : ""].filter(Boolean).join("\n");
          this.delivered(st, text, batch.delivered_through, batch.items);
          return { text: text || "[weft] inbox empty: no open errors, nothing owed.", code: 0 };
        } finally {
          writeState(this.root, st);
        }
      });
    } catch (err) {
      return { text: `weft: ${err instanceof WcpError ? `${err.code}: ${err.message}` : `coordinator unavailable (${String(err)})`}`, code: 1 };
    }
  }

  // ------------------------------------------------------------------ git hooks + heartbeat

  /** pre-commit hook: the last gate. Returns a refusal message or undefined (allow). */
  async commitGate(claudeSession: string): Promise<string | undefined> {
    if (!this.enforce) return undefined;
    return withLock(this.root, claudeSession, async () => {
      const st = readState(this.root, claudeSession);
      if (!st.wcpSession) return undefined;
      try {
        const result = await this.call(st, (s) => this.deps.transport.gate(s, "commit"));
        if (result.allow) return undefined;
        return `weft: commit refused — ${result.open_errors.length} open error(s):\n${await renderForModel(result.open_errors, [], this.ctx())}`;
      } catch (err) {
        this.log(`pre-commit gate failed open: ${String(err)}`);
        return undefined;
      } finally {
        writeState(this.root, st);
      }
    });
  }

  /** One heartbeat for a Claude session; false when the loop should end. */
  async beat(claudeSession: string, idleLimitMs: number): Promise<boolean> {
    return withLock(this.root, claudeSession, async () => {
      const st = readState(this.root, claudeSession);
      if (!st.wcpSession || this.now() - st.lastContact > idleLimitMs) return false;
      try {
        await this.deps.transport.heartbeat(st.wcpSession);
        return true;
      } catch (err) {
        this.log(`heartbeat failed: ${String(err)}`);
        return !(err instanceof WcpError && (err.code === "session_expired" || err.status === 404));
      }
    });
  }
}

export type { Target };
