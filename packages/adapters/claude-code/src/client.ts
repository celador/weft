// Minimal WCP v0.1 client (spec docs/protocol/wcp-v0.md §2, §8.2, §9.3, §11).
// Hooks are short-lived processes, so every call has a short timeout and the adapter
// fails open on transport errors (an unreachable coordinator must not wedge Claude Code).
import type {
  EventRecord,
  GateResult,
  Hello,
  HeartbeatAck,
  InboxBatch,
  Submit,
  Verdict,
  Welcome,
} from "@weft/protocol";

export const PROTOCOL = "wcp/0.1";

export class WcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
  }
}

/** What the hooks need from a coordinator. HTTP in production, in-process in tests. */
export interface Transport {
  hello(h: Hello): Promise<Welcome>;
  submit(session: string, msg: Submit, idempotencyKey?: string): Promise<Verdict>;
  drain(session: string, ack?: number): Promise<InboxBatch>;
  heartbeat(session: string): Promise<HeartbeatAck>;
  gate(session: string, gate: "stop" | "commit"): Promise<GateResult>;
  bye(session: string, reason?: string): Promise<void>;
  /** Full record (with diff). Needs `observe` scope; callers treat failure as "no detail". */
  event(seq: number): Promise<EventRecord>;
}

export class HttpTransport implements Transport {
  private readonly base: string;
  constructor(
    url: string,
    private readonly token: string,
    private readonly repo: string,
    private readonly timeoutMs = 5000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const trimmed = url.replace(/\/+$/, "");
    this.base = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "wcp-version": "0.1",
        "user-agent": "weft-adapter-claude/0.1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, init);
    } catch (err) {
      // One quick retry for a failed connection (DNS blip, reset socket, busy machine), never
      // for a timeout: the request is idempotent (submits carry an Idempotency-Key) and the
      // signal still bounds the total time.
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (timedOut || (init.signal as AbortSignal).aborted) throw new WcpError("transport", err instanceof Error ? err.message : String(err));
      try {
        await new Promise((r) => setTimeout(r, 250));
        res = await this.fetchImpl(this.base + path, init);
      } catch (err2) {
        throw new WcpError("transport", err2 instanceof Error ? err2.message : String(err2));
      }
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!res.ok) throw new WcpError("http", `HTTP ${res.status}`, res.status);
        throw new WcpError("transport", "response is not JSON", res.status);
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
      throw new WcpError(e?.code ?? "http", e?.message ?? `HTTP ${res.status}`, res.status, e?.details ?? {});
    }
    return json as T;
  }

  private s(session: string, suffix = ""): string {
    return `/repos/${encodeURIComponent(this.repo)}/sessions/${encodeURIComponent(session)}${suffix}`;
  }

  hello(h: Hello): Promise<Welcome> {
    return this.request("POST", `/repos/${encodeURIComponent(this.repo)}/sessions`, h);
  }
  submit(session: string, msg: Submit, idempotencyKey?: string): Promise<Verdict> {
    return this.request("POST", this.s(session, "/events"), msg, idempotencyKey ? { "idempotency-key": idempotencyKey.slice(0, 128) } : {});
  }
  drain(session: string, ack?: number): Promise<InboxBatch> {
    return this.request("POST", this.s(session, "/inbox"), ack ? { type: "inbox.drain", ack } : { type: "inbox.drain" });
  }
  heartbeat(session: string): Promise<HeartbeatAck> {
    return this.request("POST", this.s(session, "/heartbeat"), { type: "heartbeat" });
  }
  gate(session: string, gate: "stop" | "commit"): Promise<GateResult> {
    return this.request("POST", this.s(session, "/gate"), { type: "gate", gate });
  }
  async bye(session: string, reason?: string): Promise<void> {
    await this.request("DELETE", this.s(session), reason ? { type: "bye", reason } : { type: "bye" });
  }
  event(seq: number): Promise<EventRecord> {
    return this.request("GET", `/repos/${encodeURIComponent(this.repo)}/events/${seq}`);
  }
}
