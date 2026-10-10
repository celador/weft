// Weft gateway: the HTTP + WebSocket binding of WCP v0.1 (docs/protocol/wcp-v0.md §2,
// §8, §9). Authenticates bearer tokens (spec §3), enforces scopes, and routes each repo's
// traffic to its RepoCoordinator Durable Object (THE ordered log). Repos and tokens live
// in the Registry Durable Object, managed through /v1/admin with WEFT_ADMIN_TOKEN.

import { decodeCursor, mergeFeed, validate, WCP_VERSION, WcpProtocolError, type ErrorCode, type EventPage, type RepoSummary } from "@weft/protocol";
import {
  canAccessRepo,
  hasScope,
  SOCKET_HEADERS,
  visibleRepos,
  type CoordinatorInit,
  type EventFilters,
  type EventQuery,
  type Grant,
  type RepoCoordinator,
  type Result,
} from "@weft/sequencer";
import { REPO_NAME, Registry, sha256Hex, type TokenSpec } from "./registry";
import { artifactsAdmin, artifactsRoute, forwardApproval, handleArtifactsBatch, startRevert, type ArtifactsEnv, type Kit } from "./artifacts";

export { RepoCoordinator } from "@weft/sequencer";
export { Registry };

export interface Env extends ArtifactsEnv {
  WEFT_REPO: DurableObjectNamespace<RepoCoordinator>;
  WEFT_REGISTRY: DurableObjectNamespace<Registry>;
  /** Operator secret for /v1/admin (wrangler secret). The admin API is disabled when unset. */
  WEFT_ADMIN_TOKEN?: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const GRANT_CACHE_MS = 30_000;
const grantCache = new Map<string, { grant: Grant | null; exp: number }>();

class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const baseHeaders = { "content-type": "application/json; charset=utf-8", "wcp-version": WCP_VERSION, "cache-control": "no-store" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...extra } });
}

function errorResponse(code: ErrorCode, message: string, details?: Record<string, unknown>): Response {
  const err = new WcpProtocolError(code, message, details);
  return json(err.toJSON(), err.status, code === "rate_limited" ? { "retry-after": "1" } : {});
}

function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new HttpError(r.error.error.code, r.error.error.message, r.error.error.details);
}

function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m?.[1]?.trim();
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function registry(env: Env) {
  return env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
}

function repoStub(env: Env, repo: string) {
  return env.WEFT_REPO.get(env.WEFT_REPO.idFromName(repo));
}

async function authenticate(req: Request, env: Env): Promise<Grant> {
  const token = bearer(req);
  if (!token) throw new HttpError("unauthorized", "missing bearer token");
  const key = await sha256Hex(token);
  const hit = grantCache.get(key);
  let grant: Grant | null;
  if (hit && hit.exp > Date.now()) grant = hit.grant;
  else {
    grant = await registry(env).verify(token);
    grantCache.set(key, { grant, exp: Date.now() + GRANT_CACHE_MS });
  }
  if (!grant) throw new HttpError("unauthorized", "invalid token");
  return grant;
}

/** Scope + repo check. A repo outside the token's list is 404 (do not leak existence). */
function authorize(g: Grant, scope: "agent" | "observe" | "human" | "system", repo?: string): void {
  if (repo !== undefined && !canAccessRepo(g, repo)) throw new HttpError("repo_not_found", `repo ${repo} not found`);
  if (!hasScope(g, scope)) throw new HttpError("forbidden", `token lacks scope ${scope}`);
  if (scope === "agent" && !g.agent) throw new HttpError("forbidden", "agent token is not bound to an agent");
}

async function readJson(req: Request, optional = false): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError("payload_too_large", `body larger than ${MAX_BODY_BYTES} bytes`);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError("payload_too_large", `body larger than ${MAX_BODY_BYTES} bytes`);
  if (!text.trim()) {
    if (optional) return undefined;
    throw new HttpError("invalid_message", "empty body", { issues: [{ path: "", message: "body required" }] });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError("invalid_message", "body is not JSON", { issues: [{ path: "", message: "invalid JSON" }] });
  }
}

function check<T>(name: string, v: unknown): T {
  const r = validate<T>(name, v);
  if (!r.ok) throw new HttpError("invalid_message", `invalid ${name}`, { issues: r.issues });
  return v as T;
}

function checkVersion(req: Request): void {
  const v = req.headers.get("wcp-version");
  if (v && v.split(".")[0] !== WCP_VERSION.split(".")[0])
    throw new HttpError("unsupported_version", `server speaks WCP ${WCP_VERSION}`, { supported: [`wcp/${WCP_VERSION}`] });
}

const list = (s: string | null) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const int = (s: string | null, name: string): number | undefined => {
  if (s === null || s === "") return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new HttpError("invalid_message", `${name} must be a non-negative integer`, { issues: [{ path: `/${name}`, message: "integer" }] });
  return n;
};

function eventQuery(u: URL): EventQuery {
  const filters: EventFilters = {};
  for (const f of ["kind", "agent", "task", "change", "status"] as const) {
    const v = list(u.searchParams.get(f));
    if (v) filters[f] = v;
  }
  const after = int(u.searchParams.get("after"), "after");
  const before = int(u.searchParams.get("before"), "before");
  const limit = int(u.searchParams.get("limit"), "limit");
  const tail = ["1", "true"].includes(u.searchParams.get("tail") ?? "");
  const include = list(u.searchParams.get("include")) ?? [];
  return {
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(tail ? { tail } : {}),
    ...(include.includes("diff") ? { include_diff: true } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  };
}

/** Helpers handed to feature modules (./artifacts) so they share auth and error mapping. */
function kit(env: Env): Kit {
  return {
    fail(code, message, details) {
      throw new HttpError(code, message, details);
    },
    json,
    authenticate: (req) => authenticate(req, env),
    authorize,
    readJson,
  };
}

function forwardSocket(req: Request, env: Env, repo: string, headers: Record<string, string>): Promise<Response> {
  const h = new Headers(req.headers);
  h.delete("authorization");
  for (const v of Object.values(SOCKET_HEADERS)) h.delete(v);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return repoStub(env, repo).fetch(new Request(req.url, { method: "GET", headers: h }));
}

// ---------------------------------------------------------------------------- routes

async function route(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket";

  if (path === "/" || path === "/v1" || path === "/v1/health")
    return json({ type: "health", service: "weft-gateway", protocol: `wcp/${WCP_VERSION}`, ok: true });

  if (path.startsWith("/v1/admin")) return admin(req, env, path, m);

  checkVersion(req);

  // ----- observer: repo list + combined feed
  if (path === "/v1/repos" && m === "GET") {
    const g = await authenticate(req, env);
    authorize(g, "observe");
    const repos = visibleRepos(g, (await registry(env).listRepos()).map((r) => r.repo));
    const summaries = await Promise.all(repos.map(async (r) => unwrap(await repoStub(env, r).summary()) as RepoSummary));
    return json({ type: "repos", repos: summaries });
  }
  if (path === "/v1/feed" && m === "GET") {
    const g = await authenticate(req, env);
    authorize(g, "observe");
    return feed(u, env, g);
  }

  const rm = /^\/v1\/repos\/([^/]+)(\/.*)?$/.exec(path);
  if (!rm) throw new HttpError("not_found", `no route ${m} ${path}`);
  const repo = decodeURIComponent(rm[1]!);
  if (!REPO_NAME.test(repo)) throw new HttpError("repo_not_found", `repo ${repo} not found`);
  const rest = rm[2] ?? "";
  const stub = repoStub(env, repo);

  // Browsers cannot set upgrade headers: sockets may authenticate with a first `auth` frame.
  if (isWs && m === "GET") {
    const g = bearer(req) ? await authenticate(req, env) : undefined;
    if (rest === "/stream") {
      if (g) authorize(g, "observe", repo);
      const after = int(u.searchParams.get("after"), "after") ?? 0;
      return forwardSocket(req, env, repo, {
        [SOCKET_HEADERS.role]: "stream",
        [SOCKET_HEADERS.after]: String(after),
        ...(g ? { [SOCKET_HEADERS.grant]: JSON.stringify(g) } : {}),
      });
    }
    const wm = /^\/sessions\/([^/]+)\/ws$/.exec(rest);
    if (wm) {
      if (g) authorize(g, "agent", repo);
      return forwardSocket(req, env, repo, {
        [SOCKET_HEADERS.role]: "agent",
        [SOCKET_HEADERS.session]: decodeURIComponent(wm[1]!),
        ...(g ? { [SOCKET_HEADERS.grant]: JSON.stringify(g) } : {}),
      });
    }
    throw new HttpError("not_found", `no socket at ${path}`);
  }

  // ----- Artifacts: candidates (forks + tokens + Change-Ids), changes, trunk tokens
  const ar = await artifactsRoute(req, env, kit(env), repo, rest);
  if (ar) return ar;

  const g = await authenticate(req, env);

  // ----- agent sessions (spec §8.2)
  if (rest === "/sessions" && m === "POST") {
    authorize(g, "agent", repo);
    const body = (await readJson(req)) as { agent?: { id?: string }; change?: string };
    if (body?.agent?.id !== g.agent) throw new HttpError("forbidden", "hello.agent.id does not match the token's agent");
    if (g.change && body.change !== g.change) throw new HttpError("forbidden", "hello.change does not match the token's change");
    return json(unwrap(await stub.op("hello", [body])), 201);
  }
  const sm = /^\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(rest);
  if (sm) {
    authorize(g, "agent", repo);
    const sid = decodeURIComponent(sm[1]!);
    const sub = sm[2] ?? "";
    const owner = g.agent!;
    if (sub === "" && m === "DELETE") {
      const body = (await readJson(req, true)) as { reason?: string } | undefined;
      if (body !== undefined) check("Bye", body);
      unwrap(await stub.op("bye", [sid, body?.reason, owner]));
      return new Response(null, { status: 204, headers: { "wcp-version": WCP_VERSION } });
    }
    if (m !== "POST") throw new HttpError("not_found", `no route ${m} ${path}`);
    switch (sub) {
      case "/events": {
        const key = req.headers.get("idempotency-key") ?? undefined;
        if (key !== undefined && (key.length === 0 || key.length > 128))
          throw new HttpError("invalid_message", "Idempotency-Key must be 1..128 chars", { issues: [{ path: "", message: "Idempotency-Key" }] });
        const body = await readJson(req);
        return json(unwrap(await stub.op("submit", [sid, body, { owner, ...(key ? { idempotencyKey: key } : {}) }])));
      }
      case "/inbox": {
        const body = check<{ ack?: number }>("InboxDrain", (await readJson(req, true)) ?? { type: "inbox.drain" });
        return json(unwrap(await stub.op("drain", [sid, body.ack, owner])));
      }
      case "/heartbeat":
        check("Heartbeat", (await readJson(req, true)) ?? { type: "heartbeat" });
        return json(unwrap(await stub.op("heartbeat", [sid, owner])));
      case "/gate": {
        const body = check<{ gate: string }>("Gate", await readJson(req));
        return json(unwrap(await stub.op("gate", [sid, body, owner])));
      }
    }
    throw new HttpError("not_found", `no route ${m} ${path}`);
  }

  // ----- observer (spec §9.3)
  if (rest === "/events" && m === "GET") {
    authorize(g, "observe", repo);
    return json(unwrap(await stub.events(eventQuery(u))));
  }
  const em = /^\/events\/(\d+)$/.exec(rest);
  if (em && m === "GET") {
    authorize(g, "observe", repo);
    return json(unwrap(await stub.event(Number(em[1]))));
  }
  if (rest === "/stream") throw new HttpError("invalid_message", "stream requires a WebSocket upgrade", { issues: [{ path: "", message: "upgrade: websocket" }] });

  // ----- human actions (spec §9.6); attributed to the token's principal, never the body
  if (rest === "/actions" && m === "POST") {
    authorize(g, "human", repo);
    const body = (await readJson(req)) as { action?: string; change?: string; reason?: string };
    const res = unwrap(await stub.op("action", [g.principal, body])) as { record?: { status?: string; payload?: { target?: { seq?: number; op_id?: string } } } };
    const rec = res.record ?? {};
    // B8: `undo` starts RevertOperation; `approve` releases a waiting BestOfN.
    let workflow: string | null = null;
    if (rec.status === "accepted" && body.action === "undo" && env.WEFT_REVERT_OPERATION) {
      const t = rec.payload?.target ?? {};
      workflow = await startRevert(env, kit(env), { repo, ...(t.op_id ? { op_id: t.op_id } : { seq: t.seq! }), reason: body.reason ?? "undo", requested_by: g.principal, requested_by_type: "human" });
    }
    if (rec.status === "accepted" && body.action === "approve" && typeof body.change === "string") workflow = await forwardApproval(env, repo, body.change, g.principal);
    return json(workflow ? { ...res, workflow } : res);
  }

  // ----- system writers (spec §9.1): landing queue, revert workflow
  if (rest === "/system/events" && m === "POST") {
    authorize(g, "system", repo);
    const draft = check("EventDraft", await readJson(req));
    return json(unwrap(await stub.op("system", [draft, { type: "system", id: g.principal }])));
  }
  if (rest === "/system/queue" && m === "GET") {
    authorize(g, "system", repo);
    return json({ type: "queue", repo, entries: unwrap(await stub.queue(list(u.searchParams.get("status")))) });
  }
  if (rest === "/system/queue" && m === "POST") {
    authorize(g, "system", repo);
    const body = (await readJson(req)) as { change?: unknown; note?: unknown; id?: unknown; status?: unknown };
    const note = typeof body.note === "string" ? body.note : undefined;
    if (typeof body.id === "number" && typeof body.status === "string") {
      if (!["queued", "landing", "landed", "failed", "cancelled"].includes(body.status))
        throw new HttpError("invalid_message", "bad status", { issues: [{ path: "/status", message: "enum" }] });
      return json(unwrap(await stub.op("queue_status", [body.id, body.status, note])));
    }
    if (typeof body.change !== "string") throw new HttpError("invalid_message", "change required", { issues: [{ path: "/change", message: "string" }] });
    return json(unwrap(await stub.op("enqueue", [body.change, g.principal, note])), 201);
  }
  if (rest === "/system/ops" && m === "GET") {
    authorize(g, "system", repo);
    return json({ type: "ops", repo, ops: unwrap(await stub.ops()) });
  }

  throw new HttpError("not_found", `no route ${m} ${path}`);
}

/** Combined change log across visible repos (spec §9.5). */
async function feed(u: URL, env: Env, g: Grant): Promise<Response> {
  const all = visibleRepos(g, (await registry(env).listRepos()).map((r) => r.repo));
  const wanted = list(u.searchParams.get("repos"));
  const repos = wanted ? all.filter((r) => wanted.includes(r)) : all;
  const limit = Math.min(Math.max(1, int(u.searchParams.get("limit"), "limit") ?? 100), 500);
  const tail = ["1", "true"].includes(u.searchParams.get("tail") ?? "");
  let cursor: Record<string, number>;
  try {
    cursor = decodeCursor(u.searchParams.get("after"));
  } catch (e) {
    throw new HttpError("invalid_message", `bad cursor: ${(e as Error).message}`, { issues: [{ path: "/after", message: "cursor" }] });
  }
  const pages = await Promise.all(
    repos.map(async (r) => {
      const p = unwrap(await repoStub(env, r).events(tail ? { tail: true, limit } : { after: cursor[r] ?? 0, limit })) as EventPage;
      return [r, { events: p.events, has_more: p.has_more, head_seq: p.head_seq }] as const;
    }),
  );
  return json(mergeFeed(Object.fromEntries(pages), cursor, limit, tail ? { tail: true } : {}));
}

async function admin(req: Request, env: Env, path: string, m: string): Promise<Response> {
  const token = bearer(req);
  if (!env.WEFT_ADMIN_TOKEN) throw new HttpError("forbidden", "admin API disabled");
  if (!token || !timingSafeEqual(token, env.WEFT_ADMIN_TOKEN)) throw new HttpError("unauthorized", "admin token required");
  const reg = registry(env);
  if (path === "/v1/admin/repos" && m === "GET") return json({ repos: await reg.listRepos() });
  if (path === "/v1/admin/repos" && m === "POST") {
    const r = await reg.createRepo((await readJson(req)) as CoordinatorInit);
    if ("error" in r) throw new HttpError("invalid_message", r.error, { issues: [{ path: "", message: r.error }] });
    return json(r, r.created ? 201 : 200);
  }
  // Operator: apply the claims policy (spec §7.5) — the one journaled step that moves a repo
  // created before the policy onto claim leases. Body: {"claims": {"lease_ms", "firm_max_ms"}}.
  const pm = /^\/v1\/admin\/repos\/([^/]+)\/policy$/.exec(path);
  if (pm && m === "POST") {
    const repo = decodeURIComponent(pm[1]!);
    if (!REPO_NAME.test(repo) || !(await reg.listRepos()).some((r) => r.repo === repo)) throw new HttpError("repo_not_found", `unknown repo ${repo}`);
    const body = (await readJson(req)) as { claims?: unknown };
    return json(unwrap(await repoStub(env, repo).op("policy", [{ claims: body?.claims }])));
  }
  if (path === "/v1/admin/tokens" && m === "GET") return json({ tokens: await reg.listTokens() });
  if (path === "/v1/admin/tokens" && m === "POST") {
    const r = await reg.issueToken((await readJson(req)) as TokenSpec);
    if ("error" in r) throw new HttpError("invalid_message", r.error, { issues: [{ path: "", message: r.error }] });
    return json(r, 201);
  }
  const tm = /^\/v1\/admin\/tokens\/([^/]+)$/.exec(path);
  if (tm && m === "DELETE") {
    const ok = await reg.revoke(decodeURIComponent(tm[1]!));
    grantCache.clear();
    if (!ok) throw new HttpError("not_found", "no such active token");
    return new Response(null, { status: 204 });
  }
  const aa = await artifactsAdmin(req, env, kit(env), path);
  if (aa) return aa;
  throw new HttpError("not_found", `no route ${m} ${path}`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError || e instanceof WcpProtocolError) return errorResponse(e.code, e.message, e.details);
      console.error("gateway internal error", e instanceof Error ? e.stack : String(e));
      return errorResponse("internal", "internal error");
    }
  },
  /** Queue `weft-artifacts-events`: Artifacts `pushed` events -> revisions + WCP checkpoints. */
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleArtifactsBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
