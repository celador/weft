// HTTP client for a Weft gateway: health, hosted spaces, observer feed. Never logs tokens.
import { WeftError } from "./util";

export type SpaceCreated = { space: { id: string; created_at: string }; token: string; limits?: Record<string, number> };
export type SpaceRepo = { name: string; repo: string; created: boolean };
/** What DELETE /v1/space (and the operator's DELETE /v1/admin/spaces/{id}) reports: the space is erased, only a tombstone stays. */
export type SpaceErased = { type?: string; space: string; status: "erased"; already_erased: boolean; erased: { repos: string[]; events: number; tokens: number } };
export type IssuedToken = { token: string; info: { id: string; principal: string } };
export type Pairing = { code: string; url: string; expires_in: number; expires_at: string; space: string };
export type Viewer = { id: string; label: string; created_at: string; last_seen_at: string; expires_at: string; by?: string };
/** A teammate who joined the space with an invite code (`weft members`). */
export type Member = { id: string; label: string; handle: string; created_at: string; last_seen_at: string };
export type Invite = { code: string; expires_at: string; expires_in: number; space: string };
export type Joined = { space: { id: string }; role: "member"; token: string; member: Member };
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

/** `GET /v1/space` -> usage: agent events this month, the free allowance, and Weft Pro's seats (docs/pricing.md). Older gateways omit the Pro fields. */
export type SpaceUsage = {
  month: string;
  events: number;
  allowance: number;
  plan: "free" | "paid";
  has_billing_account: boolean;
  seats?: number | null;
  interval?: "month" | "year" | null;
  fair_use_events?: number | null;
  over_fair_use?: boolean;
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
      const w = new WeftError(`cannot reach the Weft gateway at ${this.url} (${e.cause?.code ?? e.message ?? String(err)})`, "Check your connection. To run on this machine instead: npx @celador/weft use local");
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
      const e = j?.error as { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
      const err = new WeftError(`${e?.message ?? text.slice(0, 200) ?? r.statusText} (${r.status}${e?.code ? ` ${e.code}` : ""})`) as WeftError & { status?: number; code?: string; details?: Record<string, unknown> };
      err.status = r.status;
      err.code = e?.code;
      if (e?.details && typeof e.details === "object") err.details = e.details;
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
  /** The space, asked with its owner key or a member key (`role` says which; older gateways omit it: owner). */
  space(key: string) {
    return this.call<{ role?: "owner" | "member"; member?: Member; space: { id: string; repos: Array<{ name: string; repo: string }>; tokens: number; members?: number }; usage?: SpaceUsage; billing?: { enabled: boolean }; account?: string | null; accounts?: boolean }>("GET", "/v1/space", key);
  }
  /** `weft login` step 1 (no auth): the polling secret and the code the person confirms on weft.mx/cli/. Not retried. */
  loginStart() {
    return this.once<{ device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number }>("POST", "/v1/login", undefined, {});
  }
  /** `weft login` polls; `owner` (optional) is this machine's current owner key, so that space joins the account. */
  loginPoll(device: string, owner: string | undefined, label: string) {
    return this.call<{ type: "login.pending" } | { type: "login.approved"; space: string; attached: boolean; created: boolean; token?: string }>("POST", "/v1/login/poll", owner, { device_code: device, label });
  }
  /** Revoke this owner key (spaces on an account only). */
  logout(owner: string) {
    return this.once<void>("POST", "/v1/space/logout", owner, {});
  }
  // ----- team join: invite codes, members (owner key); join and leave (a teammate)
  /** A one-time invite code (30 minutes, single use) a teammate trades for their own member key. */
  invite(owner: string) {
    return this.call<Invite>("POST", "/v1/space/invites", owner, {});
  }
  cancelInvites(owner: string) {
    return this.call<{ cancelled: number }>("DELETE", "/v1/space/invites", owner);
  }
  members(owner: string) {
    return this.call<{ members: Member[] }>("GET", "/v1/space/members", owner).then((r) => r.members);
  }
  removeMember(owner: string, id: string) {
    return this.call<{ revoked: number }>("DELETE", `/v1/space/members/${encodeURIComponent(id)}`, owner);
  }
  removeAllMembers(owner: string) {
    return this.call<{ revoked: number }>("DELETE", "/v1/space/members", owner);
  }
  /** Trade an invite code for a member key. Not retried: a lost answer after the code was used would only turn into a 401. */
  join(space: string, code: string, label: string, handle: string) {
    return this.once<Joined>("POST", "/v1/join", undefined, { space, code, label, handle });
  }
  /** A member leaves: its key and everything it minted are revoked. */
  leave(member: string) {
    return this.call<{ revoked: number }>("DELETE", "/v1/space/members/me", member);
  }
  // Billing calls are not retried: a 503 here means "billing is off" or "Stripe is down", and the person is waiting.
  checkout(owner: string, choice: { seats: number; interval: "month" | "year" }) {
    return this.once<{ url: string }>("POST", "/v1/space/billing/checkout", owner, choice);
  }
  portal(owner: string) {
    return this.once<{ url: string }>("POST", "/v1/space/billing/portal", owner, {});
  }
  createRepo(owner: string, name: string) {
    return this.call<SpaceRepo>("POST", "/v1/space/repos", owner, { name });
  }
  token(owner: string, spec: { kind: "agent" | "system" | "viewer"; repo?: string; agent?: string; label?: string }) {
    return this.call<IssuedToken>("POST", "/v1/space/tokens", owner, spec);
  }
  /** A one-time code (10 minutes, single use) a browser trades for its own session at the feed page. */
  pairing(owner: string) {
    return this.call<Pairing>("POST", "/v1/space/pairings", owner, {});
  }
  /** The paired devices: browsers, and this CLI's own read session. */
  viewers(owner: string) {
    return this.call<{ viewers: Viewer[] }>("GET", "/v1/space/viewers", owner).then((r) => r.viewers);
  }
  /** A read-only device session for this machine's CLI (expires, slides with use, revocable). */
  mintViewer(owner: string, label: string) {
    return this.call<{ token: string; device: Viewer }>("POST", "/v1/space/viewers", owner, { label });
  }
  revokeViewer(owner: string, id: string) {
    return this.call<void>("DELETE", `/v1/space/viewers/${encodeURIComponent(id)}`, owner);
  }
  revokeAllViewers(owner: string) {
    return this.call<{ revoked: number }>("DELETE", "/v1/space/viewers", owner);
  }
  revoke(owner: string, id: string) {
    return this.call<void>("DELETE", `/v1/space/tokens/${encodeURIComponent(id)}`, owner);
  }
  /** Erase the space and everything the gateway stores for it. Older gateways answer 204 (they only disabled it): undefined. */
  eraseSpace(owner: string) {
    return this.call<SpaceErased | undefined>("DELETE", "/v1/space", owner);
  }
  events(token: string, repo: string, q = "") {
    return this.call<{ events: FeedEvent[]; head_seq: number; has_more?: boolean }>("GET", `/v1/repos/${encodeURIComponent(repo)}/events${q}`, token);
  }
  feed(token: string, q: string) {
    return this.call<{ events: FeedEvent[]; cursor?: string; has_more?: boolean }>("GET", `/v1/feed${q}`, token);
  }
  system(token: string, repo: string, draft: unknown) {
    return this.call<{ record?: { seq: number; status: string } }>("POST", `/v1/repos/${encodeURIComponent(repo)}/system/events`, token, draft);
  }
}

export const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
