// HTTP client for a Weft gateway: health, hosted spaces, observer feed. Never logs tokens.
import { WeftError } from "./util";

export type SpaceCreated = { space: { id: string; created_at: string }; token: string; limits?: Record<string, number> };
export type SpaceRepo = { name: string; repo: string; created: boolean };
export type IssuedToken = { token: string; info: { id: string; principal: string } };
export type FeedEvent = {
  seq: number;
  repo: string;
  status?: string;
  kind: string;
  ts: string;
  agent?: string;
  actor?: { id?: string };
  summary?: string;
  files?: string[];
  diagnostics?: Array<{ severity: string; code: string; file?: string; message: string; caused_by_agent?: string; range?: { start: { line: number } } }>;
};

export class Api {
  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
    // Transient gateway errors (cold starts, 5xx, network blips) get two retries.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, token, body);
      } catch (e) {
        const s = statusOf(e);
        const transient = s === undefined ? (e as { network?: boolean }).network === true : s >= 500;
        if (!transient || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1) ** 2));
      }
    }
  }

  private async once<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await this.fetchImpl(this.url + path, {
        method,
        headers: {
          "wcp-version": "0.1",
          "user-agent": "weft-cli",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const e = err as { cause?: { code?: string }; message?: string };
      const w = new WeftError(`cannot reach the Weft gateway at ${this.url} (${e.cause?.code ?? e.message ?? String(err)})`, "Check your connection. To run without the hosted gateway: npx @celador/weft --local");
      (w as WeftError & { network?: boolean }).network = true;
      throw w;
    }
    if (r.status === 204) return undefined as T;
    const text = await r.text();
    let j: { error?: { code?: string; message?: string } } | undefined;
    try {
      j = text ? JSON.parse(text) : undefined;
    } catch {
      j = undefined;
    }
    if (!r.ok) {
      const err = new WeftError(`${j?.error?.message ?? text.slice(0, 200) ?? r.statusText} (${r.status}${j?.error?.code ? ` ${j.error.code}` : ""})`);
      (err as WeftError & { status?: number; code?: string }).status = r.status;
      (err as WeftError & { status?: number; code?: string }).code = j?.error?.code;
      throw err;
    }
    return j as T;
  }

  async health(): Promise<void> {
    const j = await this.call<{ service?: string }>("GET", "/v1/health");
    if (j?.service !== "weft-gateway") throw new WeftError(`${this.url} answers, but it is not a Weft gateway`);
  }

  createSpace(label?: string, admin?: string) {
    return this.call<SpaceCreated>("POST", "/v1/spaces", admin, label ? { label } : {});
  }
  space(owner: string) {
    return this.call<{ space: { id: string; repos: Array<{ name: string; repo: string }>; tokens: number } }>("GET", "/v1/space", owner);
  }
  createRepo(owner: string, name: string) {
    return this.call<SpaceRepo>("POST", "/v1/space/repos", owner, { name });
  }
  token(owner: string, spec: { kind: "agent" | "system" | "viewer"; repo?: string; agent?: string; label?: string }) {
    return this.call<IssuedToken>("POST", "/v1/space/tokens", owner, spec);
  }
  revoke(owner: string, id: string) {
    return this.call<void>("DELETE", `/v1/space/tokens/${encodeURIComponent(id)}`, owner);
  }
  deleteSpace(owner: string) {
    return this.call<void>("DELETE", "/v1/space", owner);
  }
  events(token: string, repo: string, q = "") {
    return this.call<{ events: FeedEvent[]; head_seq: number }>("GET", `/v1/repos/${encodeURIComponent(repo)}/events${q}`, token);
  }
  feed(token: string, q: string) {
    return this.call<{ events: FeedEvent[]; cursor?: string; has_more?: boolean }>("GET", `/v1/feed${q}`, token);
  }
  system(token: string, repo: string, draft: unknown) {
    return this.call<{ record?: { seq: number; status: string } }>("POST", `/v1/repos/${encodeURIComponent(repo)}/system/events`, token, draft);
  }
}

export const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
