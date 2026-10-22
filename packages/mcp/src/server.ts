// The Weft MCP server (docs/harness-coverage.md §2b). For harnesses that speak MCP but have
// no hooks, it gives the model tools to coordinate with, and it reports every edit whatever
// the model does:
//
//   - an embedded file watcher (packages/adapters/watcher) reports each changed file as a
//     WCP `commit` edit — L0 is guaranteed even if the model never calls a tool;
//   - weft_check / weft_claim / weft_status / weft_inbox / weft_feed / weft_negotiate /
//     weft_gate run on the same WCP session as the watcher (one agent, one change);
//   - every tool result ends with the session's pending inbox (delayed L1): squiggles the
//     watcher or the coordinator produced since the model last called a tool.
//
// One WCP session per server process, shared by the watcher and the tools (the shared core
// keys its state by session name: `.weft/state/mcp.json`). All coordinator work is serialized
// through one queue, so the watcher, the ticker and tool calls never interleave.
import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { claimKeyError, type Capabilities, type Diagnostic, type EventPage, type EventRecord, type NegotiateCommand, type NegotiationTerms } from "@weft/protocol";
import { HttpTransport, WcpError } from "../../adapters/claude-code/src/client";
import { readState, withLock, writeState, type Loaded } from "../../adapters/claude-code/src/config";
import type { Host } from "../../adapters/claude-code/src/host";
import type { HookOutput } from "../../adapters/claude-code/src/hooks";
import { renderDues, renderForModel, type RenderCtx } from "../../adapters/claude-code/src/render";
import { readCheckoutFile } from "../../adapters/claude-code/src/safe-read";
import { Watcher } from "../../adapters/watcher/src/watch";
import { applyPatch } from "./patch";

export const SESSION = "mcp";

/**
 * Declared capabilities (Hooks Core §3.3: declare only what is guaranteed). Edits are seen
 * after the fact by the watcher (observe async); the model may see diagnostics on its next
 * tool call (inject delayed) but the coordinator must not rely on it, so the level is 0;
 * nothing is denied, stop is not gated; git's own pre-commit hook is the commit gate.
 */
export const CAPABILITIES: Capabilities = {
  level: 0,
  observe: "async",
  inject: "delayed",
  deny_edit: false,
  refuse_stop: false,
  commit_gate: "native",
};

/** Server instructions (Claude Code truncates around 2 KB; keep this short). */
export const INSTRUCTIONS = [
  "Weft coordinates this checkout with other coding agents editing the same codebase in their own checkouts.",
  "Before you edit shared code, call weft_check with the path and the new content (or a unified diff patch): it returns the other agents' conflicts as compiler-style diagnostics (\"[weft error] <code> <file>:<line>: …\").",
  "If it reports an error, adapt your edit instead of making it as is. Every edit you make is reported to Weft anyway.",
  "Before you say the work is done, call weft_gate (gate \"stop\"): resolve each open error and answer each negotiation it lists.",
  "Every weft_* result ends with what is waiting for you; read it. Use weft_claim to reserve symbols before a large change, weft_status to see who is editing what, weft_negotiate to answer or make proposals (hints like `weft_negotiate propose overload \"…\" --wait 240` mean: call weft_negotiate with action, kind, terms, wait).",
].join(" ");

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

const KINDS = ["overload", "transfer", "share", "sequence", "merge_tasks", "other"];

export const TOOLS: ToolDef[] = [
  {
    name: "weft_check",
    description:
      "Check a proposed edit against the other agents' changes BEFORE you make it. Pass the file path and either the full new content or a unified diff patch. Returns accept/reject and Weft diagnostics (squiggles) with the other agent's change quoted. Nothing is written.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the checkout root (or absolute inside it)." },
        new_content: { type: "string", description: "The complete proposed file content." },
        patch: { type: "string", description: "A unified diff against the file's current content (alternative to new_content)." },
      },
      required: ["path"],
    },
  },
  {
    name: "weft_claim",
    description: "Claim symbols before you change them, so other agents are told (soft) or refused (firm). Keys are path#symbol (e.g. src/auth/session.ts#createSession, or path#* for a whole file).",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, minItems: 1, description: "Symbol keys path#symbol." },
        firm: { type: "boolean", description: "Firm claim: others' overlapping edits are refused until it expires or is released." },
        ttl_ms: { type: "integer", minimum: 1, description: "Firm claims only: how long, in ms (at most the repo's limit)." },
      },
      required: ["keys"],
    },
  },
  {
    name: "weft_status",
    description: "Your open Weft errors, the negotiations you owe, and what the other agents are editing right now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "weft_inbox",
    description: "Drain and acknowledge everything waiting for you: diagnostics, negotiation proposals and replies, messages; plus open errors and what you owe.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "weft_feed",
    description: "The newest records of the coordination log (edits, claims, negotiations, landings): the same rows the Weft feed UIs show.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name (default: this checkout's repo)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "How many records (default 20)." },
      },
    },
  },
  {
    name: "weft_negotiate",
    description:
      "Negotiate with the agent whose change conflicts with yours. propose (terms to another agent; without to/change/keys it targets your newest open error), accept/reject/counter a proposal by its #seq, or escalate (the coordinator merges both tasks).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["propose", "accept", "reject", "counter", "escalate"] },
        seq: { type: "integer", description: "accept/reject/counter: the #seq of the proposal or counter you answer." },
        kind: { type: "string", enum: KINDS, description: "propose/counter: the kind of terms (overload = they keep the old call shape working next to the new one)." },
        terms: { type: "string", description: "propose/counter: what you ask for, in plain words." },
        reason: { type: "string", description: "reject/escalate: why." },
        to: { type: "string", description: "propose/escalate: the other agent's id." },
        change: { type: "string", description: "propose/escalate: the other change id (instead of to)." },
        keys: { type: "array", items: { type: "string" }, description: "propose/escalate: the symbols (path#symbol) it is about." },
        wait: { type: "integer", minimum: 0, maximum: 120, description: "propose/counter: seconds to wait for the reply (default 0)." },
      },
      required: ["action"],
    },
  },
  {
    name: "weft_gate",
    description: "Ask whether you may finish (gate \"stop\") or commit (gate \"commit\"). Lists the open errors and owed negotiations that still hold you.",
    inputSchema: {
      type: "object",
      properties: { gate: { type: "string", enum: ["stop", "commit"] } },
      required: ["gate"],
    },
  },
];

export type ToolResult = { text: string; isError?: boolean };

export type ServerOptions = {
  /** Called with text the server wants pushed to the model now (Claude Code channels). */
  push?: (text: string) => Promise<void> | void;
  /** Human-facing log (stderr). */
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

function textOf(out: HookOutput): { text: string; deny: boolean } {
  const o = (out ?? {}) as { reason?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
  const h = o.hookSpecificOutput ?? {};
  return { text: [h.permissionDecisionReason, h.additionalContext, o.reason].filter(Boolean).join("\n"), deny: h.permissionDecision === "deny" };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export class WeftMcp {
  readonly watcher: Watcher;
  private queue: Promise<unknown> = Promise.resolve();
  /** Text produced in the background (watcher reports, ticks) that has not reached the model. */
  private carry: string[] = [];
  private checks = 0;
  private fsw?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private pending = new Set<string>();
  private started = false;
  private capture?: string[];

  constructor(
    readonly host: Host,
    readonly loaded: Loaded,
    private readonly opts: ServerOptions = {},
  ) {
    this.watcher = new Watcher(host, loaded, (l) => (this.capture ? this.capture.push(l) : this.log(l)), SESSION);
  }

  get root(): string {
    return this.loaded.root;
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
  }

  /** Serialize coordinator work. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private addCarry(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.opts.push) {
      void Promise.resolve(this.opts.push(t)).catch(() => this.carry.push(t));
      return;
    }
    this.carry.push(t);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Hello + snapshot. The welcome's agent-facing lines wait for the first tool result. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.run(async () => {
      const lines: string[] = (this.capture = []);
      try {
        await this.watcher.start();
      } finally {
        this.capture = undefined;
      }
      this.log(lines[0] ?? "");
      const rest = lines.slice(1).join("\n").trim();
      if (rest) this.addCarry(rest);
    });
  }

  /** Watch the checkout (fs.watch, debounced) and tick (inbox + checkpoint) in the background. */
  watch(debounceMs = 300, tickMs = 15_000): void {
    this.fsw = watch(this.root, { recursive: true }, (_ev, file) => {
      if (!file) return;
      this.pending.add(String(file));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush().catch((e) => this.log(`weft-mcp: ${String(e)}`)), debounceMs);
    });
    this.ticker = setInterval(() => void this.tick().catch(() => undefined), tickMs);
  }

  /** Report the files changed since the last flush (the watcher's L0 path). */
  async flush(): Promise<void> {
    if (!this.pending.size) return;
    const batch = [...this.pending];
    this.pending.clear();
    await this.run(async () => {
      const reports = await this.watcher.process(batch);
      for (const r of reports) if (r.text) this.addCarry(`[weft] your edit to ${r.rel} was reported:\n${r.text}`);
    });
  }

  async tick(): Promise<void> {
    await this.flush();
    await this.run(async () => this.addCarry(await this.watcher.tick()));
  }

  async stop(): Promise<void> {
    this.fsw?.close();
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    await this.flush().catch(() => undefined);
    await this.run(() => this.watcher.stop()).catch(() => undefined);
  }

  // ------------------------------------------------------------------ helpers

  private transport(): HttpTransport {
    const { config, token } = this.loaded;
    return new HttpTransport(config.url, token, config.repo, config.timeoutMs ?? 8000, this.opts.fetchImpl);
  }

  private ctx(): RenderCtx {
    const t = this.transport();
    return {
      root: this.root,
      prefix: this.loaded.config.prefix ?? "",
      fetchEvent: (s) => t.event(s).catch(() => undefined),
      change: this.loaded.config.change,
      cli: this.host.cliFor(this.root),
    };
  }

  /** The session's WCP session id (hello first if needed). */
  private async wcpSession(): Promise<string> {
    const st = readState(this.root, SESSION);
    if (st.wcpSession) return st.wcpSession;
    await this.host.run(this.loaded, { hook_event_name: "SessionStart", session_id: SESSION, cwd: this.root, source: "startup" }, { mcp: "hello" });
    const sid = readState(this.root, SESSION).wcpSession;
    if (!sid) throw new WcpError("unavailable", "could not open a Weft session");
    return sid;
  }

  /** A session call; on an expired session, hello again once. */
  private async withSession<T>(fn: (sid: string) => Promise<T>): Promise<T> {
    const sid = await this.wcpSession();
    try {
      return await fn(sid);
    } catch (err) {
      if (!(err instanceof WcpError) || (err.code !== "session_expired" && err.status !== 404)) throw err;
      await withLock(this.root, SESSION, async () => {
        const st = readState(this.root, SESSION);
        st.wcpSession = undefined;
        writeState(this.root, st);
      });
      return fn(await this.wcpSession());
    }
  }

  /** What is waiting for the model: background carry + a fresh inbox drain. */
  private async pendingInbox(drain = true): Promise<string> {
    const carried = this.carry.splice(0);
    let drained = "";
    if (drain) drained = textOf(await this.host.run(this.loaded, { hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: this.root }, { mcp: "inbox" })).text;
    return [...carried, drained].filter(Boolean).join("\n");
  }

  private target(path: string): { abs: string; rel: string } | undefined {
    const abs = resolve(isAbsolute(path) ? path : join(this.root, path));
    const rel = relative(this.root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    return { abs, rel: rel.split(sep).join("/") };
  }

  // ------------------------------------------------------------------ tools

  /** Run one tool; its result always ends with the pending inbox. Never throws. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.flush().catch(() => undefined); // the model's own edits first, so checks see them
    let res: ToolResult;
    try {
      res = await this.run(() => this.dispatch(name, args));
    } catch (err) {
      res = { text: `[weft] ${name} failed: ${err instanceof WcpError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    let inbox = "";
    try {
      inbox = await this.run(() => this.pendingInbox(name !== "weft_inbox"));
    } catch (err) {
      inbox = `[weft] inbox unavailable (${err instanceof Error ? err.message : String(err)})`;
    }
    const out = inbox ? { ...res, text: `${res.text}\n\n[weft inbox]\n${inbox}` } : res;
    return { ...out, text: this.toolHints(out.text) };
  }

  /** The shared core writes shell hints (`<checkout>/.weft/bin/weft negotiate …`); name the MCP tools instead. */
  private toolHints(text: string): string {
    const cli = this.host.cliFor(this.root);
    return text.split(`${cli} negotiate`).join("weft_negotiate").split(`${cli} inbox`).join("weft_inbox").split(`${cli} claim`).join("weft_claim");
  }

  private async dispatch(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case "weft_check":
        return this.check(a);
      case "weft_claim":
        return this.claim(a);
      case "weft_status":
        return this.status();
      case "weft_inbox": {
        const r = await this.host.adapter(this.loaded).inbox(SESSION);
        return { text: r.text, isError: r.code !== 0 };
      }
      case "weft_feed":
        return this.feed(a);
      case "weft_negotiate":
        return this.negotiate(a);
      case "weft_gate":
        return this.gate(a);
      default:
        return { text: `unknown tool ${name}`, isError: true };
    }
  }

  private async check(a: Record<string, unknown>): Promise<ToolResult> {
    const path = str(a.path);
    if (!path) return { text: "weft_check: path is required", isError: true };
    const t = this.target(path);
    if (!t) return { text: `weft_check: ${path} is outside this checkout (${this.root})`, isError: true };
    const before = readCheckoutFile(this.root, t.abs, 1 << 20);
    if (before === undefined) return { text: `weft_check: ${t.rel} cannot be read (symlink, too large, or not a file); not checked`, isError: true };
    let after: string;
    if (typeof a.new_content === "string") after = a.new_content;
    else if (typeof a.patch === "string") {
      const p = applyPatch(before, a.patch);
      if (!p.ok) return { text: `weft_check: ${p.error}`, isError: true };
      after = p.text;
    } else return { text: "weft_check: pass new_content (the whole proposed file) or patch (a unified diff)", isError: true };
    if (after === before) return { text: `[weft] check ${t.rel}: no change to check (the proposed content equals the file).` };
    const callId = `mcp-check-${Date.now()}-${++this.checks}`;
    const out = await this.host.run(this.loaded, { hook_event_name: "PreToolUse", session_id: SESSION, cwd: this.root, tool_name: "Write", tool_input: { file_path: t.abs, content: after }, tool_use_id: callId }, { mcp: "check" });
    // A check writes nothing: drop the pre-edit record the core keeps for a PostToolUse.
    await withLock(this.root, SESSION, async () => {
      const st = readState(this.root, SESSION);
      if (st.pending[callId]) {
        delete st.pending[callId];
        writeState(this.root, st);
      }
    });
    const { text, deny } = textOf(out);
    const reject = deny || text.includes("(advisory mode) this edit would be blocked");
    if (reject) {
      const body = text
        .replace(/^\[weft\] Edit to (\S+) blocked: it conflicts/, "[weft] check $1: REJECT — this edit conflicts")
        .replace(/Do not retry the same edit\.[^\n]*$/, "Do not make this edit as is: adapt it to the change above (or work around it) and check again.");
      return { text: body };
    }
    if (!text) return { text: `[weft] check ${t.rel}: accept — no conflict with the other agents' changes.` };
    return { text: `[weft] check ${t.rel}: accept, with diagnostics:\n${text.replace(/^\[weft diagnostics\]\n/, "")}` };
  }

  private async claim(a: Record<string, unknown>): Promise<ToolResult> {
    const keys = Array.isArray(a.keys) ? [...new Set(a.keys.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean))] : [];
    if (!keys.length) return { text: "weft_claim: keys is required (path#symbol, …)", isError: true };
    for (const k of keys) {
      const err = claimKeyError(k);
      if (err) return { text: `weft_claim: invalid key ${JSON.stringify(k)}: ${err}`, isError: true };
    }
    const firm = a.firm === true;
    const ttl = typeof a.ttl_ms === "number" ? a.ttl_ms : undefined;
    if (ttl !== undefined && (!firm || !Number.isSafeInteger(ttl) || ttl < 1)) return { text: "weft_claim: ttl_ms applies to firm claims only and must be a positive integer", isError: true };
    const r = await this.host.adapter(this.loaded).claim(SESSION, { keys, firm, ...(ttl !== undefined ? { ttl_ms: ttl } : {}) });
    return { text: r.text, isError: r.code === 2 };
  }

  private async events(repo: string, limit: number): Promise<EventRecord[]> {
    const { config, token } = this.loaded;
    const base = config.url.replace(/\/+$/, "").replace(/\/v1$/, "");
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${base}/v1/repos/${encodeURIComponent(repo)}/events?tail=1&limit=${limit}`, {
      headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1" },
      signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
    });
    const json = (await res.json().catch(() => undefined)) as (EventPage & { error?: { code?: string; message?: string } }) | undefined;
    if (!res.ok) throw new WcpError(json?.error?.code ?? "http", json?.error?.message ?? `HTTP ${res.status}`, res.status);
    return json?.events ?? [];
  }

  private async status(): Promise<ToolResult> {
    const g = await this.withSession((sid) => this.transport().gate(sid, "stop"));
    const ctx = this.ctx();
    const me = this.loaded.config.agent;
    const parts: string[] = [];
    parts.push(g.open_errors.length ? `Open errors (${g.open_errors.length}):\n${await renderForModel(g.open_errors, [], ctx)}` : "Open errors: none.");
    parts.push(g.negotiations?.length ? `Owed (${g.negotiations.length}):\n${renderDues(g.negotiations, ctx)}` : "Owed negotiations: none.");
    try {
      parts.push(editingNow(await this.events(this.loaded.config.repo, 100), me));
    } catch (err) {
      parts.push(`Who is editing what: unavailable (${err instanceof WcpError ? err.code : String(err)}; the token needs the observe scope).`);
    }
    return { text: `[weft] status for ${me} (task ${this.loaded.config.task.id}, change ${this.loaded.config.change}):\n${parts.join("\n")}` };
  }

  private async feed(a: Record<string, unknown>): Promise<ToolResult> {
    const repo = str(a.repo) ?? this.loaded.config.repo;
    const limit = Math.max(1, Math.min(100, typeof a.limit === "number" ? Math.floor(a.limit) : 20));
    const events = await this.events(repo, limit);
    if (!events.length) return { text: `[weft] feed ${repo}: no records yet.` };
    return { text: `[weft] feed ${repo} (newest ${events.length}, oldest first):\n${events.map(feedRow).join("\n")}` };
  }

  private async negotiate(a: Record<string, unknown>): Promise<ToolResult> {
    const action = str(a.action);
    const seq = typeof a.seq === "number" ? a.seq : undefined;
    const wait = typeof a.wait === "number" ? Math.max(0, Math.min(120, a.wait)) : undefined;
    const to = str(a.change) ? { change: str(a.change)! } : str(a.to) ? { agent: str(a.to)! } : undefined;
    const keys = Array.isArray(a.keys) ? a.keys.filter((k): k is string => typeof k === "string" && !!k.trim()) : undefined;
    const terms = (): NegotiationTerms | string => {
      const kind = str(a.kind) ?? "other";
      if (!KINDS.includes(kind)) return `kind must be one of ${KINDS.join(", ")}`;
      const text = str(a.terms)?.trim();
      if (!text) return "terms is required (what you ask for, in plain words)";
      return { kind: kind as NegotiationTerms["kind"], text };
    };
    let cmd: NegotiateCommand;
    switch (action) {
      case "propose": {
        const t = terms();
        if (typeof t === "string") return { text: `weft_negotiate: ${t}`, isError: true };
        cmd = { cmd: "propose", terms: t, ...(to ? { to } : {}), ...(keys?.length ? { keys } : {}), ...(wait !== undefined ? { wait } : {}) };
        break;
      }
      case "counter": {
        const t = terms();
        if (seq === undefined) return { text: "weft_negotiate: counter needs seq", isError: true };
        if (typeof t === "string") return { text: `weft_negotiate: ${t}`, isError: true };
        cmd = { cmd: "counter", reply_to: seq, terms: t, ...(wait !== undefined ? { wait } : {}) };
        break;
      }
      case "accept":
      case "reject":
        if (seq === undefined) return { text: `weft_negotiate: ${action} needs seq`, isError: true };
        cmd = action === "accept" ? { cmd: "accept", reply_to: seq } : { cmd: "reject", reply_to: seq, ...(str(a.reason) ? { reason: str(a.reason)! } : {}) };
        break;
      case "escalate":
        if (!str(a.reason)) return { text: "weft_negotiate: escalate needs reason", isError: true };
        cmd = { cmd: "escalate", reason: str(a.reason)!, ...(to ? { with: to } : {}), ...(keys?.length ? { keys } : {}) };
        break;
      default:
        return { text: "weft_negotiate: action must be propose | accept | reject | counter | escalate", isError: true };
    }
    const r = await this.host.adapter(this.loaded).negotiate(SESSION, cmd);
    return { text: r.text, isError: r.code !== 0 };
  }

  private async gate(a: Record<string, unknown>): Promise<ToolResult> {
    const gate = a.gate === "commit" ? "commit" : a.gate === "stop" ? "stop" : undefined;
    if (!gate) return { text: "weft_gate: gate must be \"stop\" or \"commit\"", isError: true };
    const g = await this.withSession((sid) => this.transport().gate(sid, gate));
    if (g.allow) return { text: `[weft] gate ${gate}: allowed — no open errors${gate === "stop" ? ", nothing owed" : ""}.` };
    const ctx = this.ctx();
    const errors = g.open_errors.length ? await renderForModel(g.open_errors, [], ctx) : "";
    const owed = g.negotiations?.length ? renderDues(g.negotiations, ctx) : "";
    const what = [g.open_errors.length ? `${g.open_errors.length} open error(s)` : "", g.negotiations?.length ? `${g.negotiations.length} negotiation(s) owed` : ""].filter(Boolean).join(", ");
    return {
      text:
        `[weft] gate ${gate}: NOT allowed — ${what || g.reason || "refused"}. You are not done yet.\n${[errors, owed].filter(Boolean).join("\n")}\n` +
        (g.open_errors.length ? "Resolve each error by re-editing the cited code against the change it names (an accepted edit touching the symbol clears it), or retreat from that code. " : "") +
        (g.negotiations?.length ? "Answer each proposal (weft_negotiate) and make every edit you agreed to." : ""),
    };
  }
}

// ------------------------------------------------------------------ rendering (feed + presence)

const hhmmss = (ts: string) => ts.slice(11, 19);

export function feedRow(r: EventRecord): string {
  const who = r.agent ?? r.actor.id;
  const errs = r.diagnostics.filter((d: Diagnostic) => d.severity === "error").length;
  const files = r.files.length ? ` [${r.files.slice(0, 3).join(", ")}${r.files.length > 3 ? ", …" : ""}]` : "";
  const status = r.status === "rejected" ? " REJECTED" : "";
  return `#${r.seq} ${hhmmss(r.ts)} ${who} ${r.kind}${r.mode === "check" ? " (check)" : ""}${status}: ${r.summary}${files}${errs ? ` — ${errs} error(s)` : ""}`;
}

/** Who else is editing what, from the newest log records (accepted edits/claims, by agent). */
export function editingNow(events: EventRecord[], me: string, now = Date.now(), windowMs = 30 * 60_000): string {
  const by = new Map<string, { last: string; keys: Set<string>; files: Set<string>; claims: Set<string>; left: boolean }>();
  for (const r of events) {
    const who = r.agent;
    if (!who || who === me || r.actor.type !== "agent") continue;
    if (now - Date.parse(r.ts) > windowMs) continue;
    const a = by.get(who) ?? { last: r.ts, keys: new Set(), files: new Set(), claims: new Set(), left: false };
    a.last = r.ts > a.last ? r.ts : a.last;
    if (r.kind === "edit" && r.status === "accepted" && r.mode !== "check") {
      for (const f of r.files) a.files.add(f);
      for (const w of r.writes) a.keys.add(w.key);
      a.left = false;
    }
    if (r.kind === "claim" && r.status === "accepted") for (const w of r.writes) a.claims.add(w.key);
    if (r.kind === "release") for (const k of (r.payload?.keys as string[] | undefined) ?? []) a.claims.delete(k);
    if (r.kind === "leave") a.left = true;
    by.set(who, a);
  }
  const rows = [...by.entries()].filter(([, a]) => !a.left && (a.files.size || a.claims.size));
  if (!rows.length) return "Other agents: no edits or claims in the last 30 minutes.";
  return (
    "Other agents (last 30 min):\n" +
    rows
      .map(([who, a]) => {
        const keys = [...a.keys].slice(0, 6);
        return `  ${who} (last ${hhmmss(a.last)}): ${a.files.size ? `editing ${[...a.files].join(", ")}` : ""}${keys.length ? ` — ${keys.join(", ")}${a.keys.size > keys.length ? ", …" : ""}` : ""}${a.claims.size ? `${a.files.size ? "; " : ""}claims ${[...a.claims].join(", ")}` : ""}`;
      })
      .join("\n")
  );
}
