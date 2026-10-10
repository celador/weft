// Weft web UI Worker (B9): serves the static app (./public via the ASSETS binding) and a
// thin, allow-listed API in front of weft-gateway. The browser never holds a WCP token:
// this Worker authenticates the human (Cloudflare Access, or the operator-key fallback,
// see ./auth.ts) and calls the gateway with its own human-scope token (WEFT_WEB_TOKEN)
// over a service binding. Human actions are therefore attributed to that token's
// principal; the Access email is appended to the action's note/reason for the record.
//
//   GET  /api/me                                   who am I, auth mode, gateway health
//   GET  /api/repos                                RepoList (spec §9.2)
//   GET  /api/repos/{repo}/events[?…]              EventPage (spec §9.3)
//   GET  /api/repos/{repo}/events/{seq}            full EventRecord (with diff)
//   GET  /api/repos/{repo}/tasks                   board: tasks + candidates (gateway, D1)
//   GET  /api/repos/{repo}/tasks/{task}/candidates candidates of a task
//   GET  /api/repos/{repo}/changes/{change}        change + revisions + evidence
//   POST /api/repos/{repo}/actions                 approve | undo | pause | resume | message
//   WS   /api/repos/{repo}/stream?after=N          live log (spec §9.4), proxied to the repo DO
//
// Public read-only demo (WEFT_PUBLIC_DEMO=1, env `public`, weft.elier.ai): no login (guest),
// GET routes + the stream only (every other method: 403 read_only), gateway calls use the
// observe-only WEFT_PUBLIC_TOKEN and never WEFT_WEB_TOKEN, repos limited to WEFT_PUBLIC_REPOS,
// and every relayed body / stream frame is scrubbed (./scrub.ts).

import { EmailMessage } from "cloudflare:email";
import { accessConfigured, authenticate, publicDemo, mintSession, sessionCookie, timingSafeEqual, type AuthEnv, type Identity, type JwksFetcher } from "./auth";
import { fixLegacyUrls } from "../public/lib/urls.js";
import { redactTerms, scrubPublic } from "./scrub";
import { emailBody, emailSubject, emailTaskId, evaluatePolicy, metric, validatePolicyInput, type AnalyticsEngine, type DispatchNamespace } from "./platform";

export interface Env extends AuthEnv {
  ASSETS?: Fetcher;
  /** Service binding to weft-gateway (preview: weft-gateway-preview). */
  GATEWAY?: Fetcher;
  /** Local dev: gateway base URL, used instead of the service binding when set. */
  GATEWAY_URL?: string;
  /** Gateway token with scopes observe+human, repos "*" (wrangler secret). */
  WEFT_WEB_TOKEN?: string;
  /** Optional: Workflows binding to BestOfN (apps/workflows); approve also sends it an event. */
  BESTOFN?: { get(id: string): Promise<{ sendEvent(e: { type: string; payload: unknown }): Promise<void> }> };
  POLICY_DISPATCH?: DispatchNamespace;
  WEFT_ANALYTICS?: AnalyticsEngine;
  /** Dedicated observe+system token, never exposed to fetch requests. */
  WEFT_EMAIL_TOKEN?: string;
  WEFT_EMAIL_REPO?: string;
  WEFT_EMAIL_FROM?: string;
  /** Public demo: observe-only gateway token (the only token used when WEFT_PUBLIC_DEMO=1). */
  WEFT_PUBLIC_TOKEN?: string;
  /** Public demo: comma-separated repo allow-list, enforced here on top of the token's repos. */
  WEFT_PUBLIC_REPOS?: string;
  /** Public demo: extra literal terms scrubbed from every response (secret, comma-separated). */
  WEFT_REDACT?: string;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const ACTIONS = new Set(["approve", "undo", "pause", "resume", "message"]);
const MAX_ACTION_BYTES = 16 * 1024;

function securityHeaders(req: Request): Record<string, string> {
  const host = new URL(req.url).host;
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' https: data:",
      `connect-src 'self' wss://${host} ws://${host}`,
      "frame-src https:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  if (res.status === 101) return res; // WebSocket upgrade: pass through untouched
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

const apiError = (status: number, code: string, message: string) => json({ type: "error", error: { code, message } }, status);

/** The gateway token for fetch requests: public demo mode only ever uses WEFT_PUBLIC_TOKEN. */
export function webToken(env: Env): string | undefined {
  return publicDemo(env) ? env.WEFT_PUBLIC_TOKEN : env.WEFT_WEB_TOKEN;
}

const tokenName = (env: Env) => (publicDemo(env) ? "WEFT_PUBLIC_TOKEN" : "WEFT_WEB_TOKEN");

function publicRepos(env: Env): string[] {
  return (env.WEFT_PUBLIC_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Public demo: explicit opt-in only; missing or empty allow-list exposes nothing. */
function repoAllowed(env: Env, repo: string): boolean {
  if (!publicDemo(env)) return true;
  return publicRepos(env).includes(repo);
}

/** Call weft-gateway with the Worker's token. */
function gateway(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return gatewayWithToken(env, path, webToken(env), init);
}

function gatewayWithToken(env: Env, path: string, token: string | undefined, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token ?? ""}`);
  headers.set("wcp-version", "0.1");
  headers.set("user-agent", "weft-web/0.1");
  // GATEWAY_URL (local dev) wins over the service binding, which has no target under `wrangler dev`.
  if (env.GATEWAY_URL) return fetch(new Request(`${env.GATEWAY_URL.replace(/\/+$/, "")}${path}`, { ...init, headers }));
  if (env.GATEWAY) return env.GATEWAY.fetch(new Request(`https://weft-gateway${path}`, { ...init, headers }));
  return Promise.resolve(apiError(503, "unavailable", "no gateway configured (GATEWAY binding or GATEWAY_URL)"));
}

/** Relay a gateway response, keeping status + JSON body, dropping hop headers. JSON bodies get
 *  legacy *.workers.dev previews origins rewritten (old x_evidence in the append-only log). */
async function relay(res: Response, env: Env = {}, filter?: (body: string) => string): Promise<Response> {
  const type = res.headers.get("content-type") ?? "application/json";
  const headers = { "content-type": type, "cache-control": "no-store" };
  if (!type.includes("json")) {
    if (publicDemo(env)) return new Response(scrubPublic(await res.text(), redactTerms(env.WEFT_REDACT)), { status: res.status, headers });
    return new Response(res.body, { status: res.status, headers });
  }
  let text = fixLegacyUrls(await res.text());
  if (filter && res.ok) text = filter(text);
  if (publicDemo(env)) text = scrubPublic(text, redactTerms(env.WEFT_REDACT));
  return new Response(text, { status: res.status, headers });
}

/** Public demo: proxy the stream frame by frame (gateway -> browser only) so every frame is
 *  scrubbed; browser -> gateway messages are dropped (read-only). */
async function publicStream(env: Env, path: string): Promise<Response> {
  const up = await gateway(env, path, { headers: { upgrade: "websocket", connection: "Upgrade" } });
  const upstream = up.webSocket;
  if (up.status !== 101 || !upstream) return relay(up, env);
  const terms = redactTerms(env.WEFT_REDACT);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  upstream.accept();
  server.accept();
  const code = (c: number) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
  upstream.addEventListener("message", (m) => {
    const data = typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer);
    try {
      server.send(scrubPublic(fixLegacyUrls(data), terms));
    } catch {
      /* browser gone */
    }
  });
  upstream.addEventListener("close", (e) => {
    try { server.close(code(e.code), "upstream closed"); } catch { /* already closed */ }
  });
  upstream.addEventListener("error", () => {
    try { server.close(1011, "upstream error"); } catch { /* already closed */ }
  });
  server.addEventListener("close", (e) => {
    try { upstream.close(code(e.code), "client closed"); } catch { /* already closed */ }
  });
  return new Response(null, { status: 101, webSocket: client });
}

const pass = (u: URL, keys: string[]) => {
  const q = new URLSearchParams();
  for (const k of keys) {
    const v = u.searchParams.get(k);
    if (v !== null && v.length <= 512) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};

async function api(req: Request, env: Env, who: Identity, path: string, u: URL): Promise<Response> {
  const m = req.method;
  const pub = publicDemo(env);
  if (pub && m !== "GET") return apiError(403, "read_only", "this is a public read-only demo of Weft");
  if (path === "/api/me" && m === "GET") {
    let gw: unknown = null;
    try {
      const h = await gateway(env, "/v1/health");
      gw = h.ok ? await h.json() : { ok: false, status: h.status };
    } catch (e) {
      gw = { ok: false, error: (e as Error).message };
    }
    return json({ type: "me", identity: who, access: accessConfigured(env), token: Boolean(webToken(env)), gateway: gw, bestofn: Boolean(env.BESTOFN), readOnly: pub });
  }
  if (path === "/api/policy/evaluate" && m === "POST") {
    const origin = req.headers.get("origin");
    if (!origin || origin !== u.origin) return apiError(403, "forbidden", "cross-origin policy request refused");
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return apiError(415, "invalid_message", "JSON required");
    const started = Date.now();
    const text = await req.text();
    if (text.length > MAX_ACTION_BYTES) return apiError(413, "payload_too_large", "policy input too large");
    let input: unknown;
    try { input = JSON.parse(text); } catch { return apiError(400, "invalid_message", "body is not JSON"); }
    const valid = validatePolicyInput(input);
    if (!valid) return apiError(400, "invalid_message", "repo, task, and change are required");
    try {
      const decision = await evaluatePolicy(valid, env.POLICY_DISPATCH);
      metric(env.WEFT_ANALYTICS, valid.repo, "policy.evaluate", decision.allow ? "allow" : "deny", started);
      return json(decision);
    } catch (e) {
      metric(env.WEFT_ANALYTICS, valid.repo, "policy.evaluate", "error", started);
      return apiError(502, "bad_gateway", (e as Error).message);
    }
  }
  if (!webToken(env)) return apiError(503, "unavailable", `${tokenName(env)} is not configured`);
  if (path === "/api/repos" && m === "GET") {
    if (!pub) return relay(await gateway(env, "/v1/repos"), env);
    if (!publicRepos(env).length) return json({ type: "repos", repos: [] });
    return relay(await gateway(env, "/v1/repos"), env, (text) => {
      const body = JSON.parse(text) as { repos?: { repo: string }[] };
      return JSON.stringify({ ...body, repos: (body.repos ?? []).filter((r) => repoAllowed(env, r.repo)) });
    });
  }

  const rm = /^\/api\/repos\/([^/]+)(\/.*)?$/.exec(path);
  if (!rm) return apiError(404, "not_found", `no route ${m} ${path}`);
  const repo = decodeURIComponent(rm[1]!);
  if (!REPO.test(repo)) return apiError(404, "repo_not_found", "bad repo");
  if (!repoAllowed(env, repo)) return apiError(404, "repo_not_found", "repo is not part of the public demo");
  const rest = rm[2] ?? "";
  const base = `/v1/repos/${encodeURIComponent(repo)}`;

  if (rest === "/stream") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return apiError(426, "invalid_message", "stream requires a WebSocket upgrade");
    // The gateway authenticates the Authorization header on upgrade; the DO replays then streams live.
    const after = /^\d+$/.test(u.searchParams.get("after") ?? "") ? u.searchParams.get("after")! : "0";
    if (pub) return publicStream(env, `${base}/stream?after=${after}`);
    return gateway(env, `${base}/stream?after=${after}`, { headers: { upgrade: "websocket", connection: "Upgrade" } });
  }

  if (m === "GET") {
    if (rest === "/events") return relay(await gateway(env, `${base}/events${pass(u, ["after", "before", "tail", "limit", "include", "kind", "agent", "task", "change", "status"])}`), env);
    const em = /^\/events\/(\d{1,12})$/.exec(rest);
    if (em) return relay(await gateway(env, `${base}/events/${em[1]}`), env);
    if (rest === "/tasks") return relay(await gateway(env, `${base}/tasks`), env);
    const tm = /^\/tasks\/([^/]+)\/candidates$/.exec(rest);
    if (tm && ID.test(decodeURIComponent(tm[1]!))) return relay(await gateway(env, `${base}/tasks/${tm[1]}/candidates`), env);
    const cm = /^\/changes\/([^/]+)$/.exec(rest);
    if (cm && ID.test(decodeURIComponent(cm[1]!))) return relay(await gateway(env, `${base}/changes/${cm[1]}`), env);
  }

  if (rest === "/actions" && m === "POST") {
    const started = Date.now();
    // CSRF: same-origin JSON only (SameSite=Strict cookie + Origin check + JSON content type).
    const origin = req.headers.get("origin");
    if (!origin || origin !== u.origin) return apiError(403, "forbidden", "cross-origin action refused");
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return apiError(415, "invalid_message", "JSON required");
    const text = await req.text();
    if (text.length > MAX_ACTION_BYTES) return apiError(413, "payload_too_large", "action too large");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return apiError(400, "invalid_message", "body is not JSON");
    }
    if (!body || typeof body !== "object" || typeof body.action !== "string" || !ACTIONS.has(body.action)) return apiError(400, "invalid_message", "unsupported action");
    const by = `via web by ${who.email}`;
    const action: Record<string, unknown> = { ...body, type: "action" };
    if (body.action === "approve") action.note = typeof body.note === "string" && body.note ? `${body.note} (${by})` : by;
    if (body.action === "undo") action.reason = typeof body.reason === "string" && body.reason ? `${body.reason} (${by})` : by;
    if ((body.action === "pause" || body.action === "resume") && typeof body.reason === "string") action.reason = `${body.reason} (${by})`;
    const res = await gateway(env, `${base}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
    const out = (await res.json()) as Record<string, unknown>;
    // Approve also wakes the task's BestOfN workflow instance (Workflows waitForEvent), if bound.
    if (res.ok && body.action === "approve" && env.BESTOFN && typeof body.task === "string") {
      try {
        const inst = await env.BESTOFN.get(bestOfNInstanceId(repo, body.task));
        await inst.sendEvent({ type: "approve", payload: { repo, task: body.task, change: body.change, seq: out.seq, by: who.email } });
        out.workflow = "signalled";
      } catch (e) {
        out.workflow = `not signalled: ${(e as Error).message}`;
      }
    }
    metric(env.WEFT_ANALYTICS, repo, `action.${String(body.action)}`, res.ok ? "ok" : "error", started);
    return json(out, res.status);
  }
  return apiError(404, "not_found", `no route ${m} ${path}`);
}

/** Workflow instance id convention shared with apps/workflows BestOfN: one instance per task. */
export function bestOfNInstanceId(repo: string, task: string): string {
  return `bestofn-${repo}-${task}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
}

type InboundEmail = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  headers: Headers;
  reply(message: EmailMessage): Promise<void>;
  setReject(reason: string): void;
};

/** Email Routing adapter: one inbound message becomes one queued WCP task intent. */
export async function handleEmail(message: InboundEmail, env: Env): Promise<void> {
  const started = Date.now();
  const repo = env.WEFT_EMAIL_REPO || "weft";
  if (publicDemo(env)) {
    message.setReject("Weft public demo does not accept email");
    return;
  }
  if (!env.WEFT_EMAIL_TOKEN || !REPO.test(repo)) {
    message.setReject("Weft email intake is not configured");
    metric(env.WEFT_ANALYTICS, repo, "email.intake", "unconfigured", started, "email");
    return;
  }
  const raw = await new Response(message.raw).text();
  const subject = emailSubject(raw);
  const task = emailTaskId(message.headers.get("message-id") ?? `${message.from}:${subject}`, subject);
  try {
    const page = await gatewayWithToken(env, `/v1/repos/${encodeURIComponent(repo)}/events?tail=1&limit=1`, env.WEFT_EMAIL_TOKEN);
    const state = page.ok ? ((await page.json()) as { head_seq?: number }) : {};
    const draft = {
      kind: "intent",
      base_seq: state.head_seq ?? 0,
      task,
      intent: emailBody(raw),
      summary_hint: subject,
      payload: { source: "email", from: message.from, to: message.to, subject },
    };
    const created = await gatewayWithToken(env, `/v1/repos/${encodeURIComponent(repo)}/system/events`, env.WEFT_EMAIL_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!created.ok) throw new Error(`gateway returned ${created.status}`);
    const from = env.WEFT_EMAIL_FROM || message.to;
    const response = `From: ${from}\r\nTo: ${message.from}\r\nSubject: Re: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nWeft created task ${task} in ${repo}.\r\n`;
    await message.reply(new EmailMessage(from, message.from, response));
    metric(env.WEFT_ANALYTICS, repo, "email.intake", "created", started, "email");
  } catch (e) {
    metric(env.WEFT_ANALYTICS, repo, "email.intake", "error", started, "email");
    throw e;
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/app.css"></head><body class="gate">${body}</body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(error?: string): Response {
  const html = page(
    "Weft · sign in",
    `<form class="login" method="post" action="/login">
      <div class="brand big"><span class="mark"></span>weft</div>
      <p class="muted">Operator key required. Production uses Cloudflare Access.</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
      <input type="password" name="key" autocomplete="current-password" placeholder="Operator key" autofocus required>
      <button type="submit">Sign in</button>
    </form>`,
  );
  return new Response(html, { status: error ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function handle(req: Request, env: Env, fetcher?: JwksFetcher): Promise<Response> {
  const u = new URL(req.url);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (path === "/healthz") return json({ ok: true, service: "weft-web" });

  if (publicDemo(env)) {
    if (path === "/login") return new Response(null, { status: 302, headers: { location: "/" } });
    if (path === "/logout") return apiError(403, "read_only", "this is a public read-only demo of Weft");
  }
  if (path === "/login") {
    if (!env.WEFT_WEB_KEY) return new Response(null, { status: 302, headers: { location: "/" } });
    if (m === "GET") return loginPage();
    if (m === "POST") {
      const form = await req.formData().catch(() => null);
      const key = form?.get("key");
      if (typeof key !== "string" || !timingSafeEqual(key.trim(), env.WEFT_WEB_KEY)) return loginPage("Wrong key.");
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": sessionCookie(await mintSession(env)), "cache-control": "no-store" } });
    }
  }
  if (path === "/logout" && m === "POST") return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": sessionCookie("", 0) } });

  const auth = await authenticate(req, env, fetcher);
  if (!auth.ok) {
    if (path.startsWith("/api/")) return apiError(auth.status, auth.status === 503 ? "unavailable" : auth.status === 403 ? "forbidden" : "unauthorized", auth.reason);
    if (auth.status === 401 && env.WEFT_WEB_KEY) return new Response(null, { status: 302, headers: { location: "/login" } });
    return new Response(page("Weft", `<div class="login"><div class="brand big"><span class="mark"></span>weft</div><p class="err">${escapeHtml(auth.reason)}</p></div>`), {
      status: auth.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path.startsWith("/api/")) {
    try {
      return await api(req, env, auth.identity, path, u);
    } catch (e) {
      console.error("weft-web api error", e instanceof Error ? e.stack : String(e));
      return apiError(502, "bad_gateway", "gateway request failed");
    }
  }
  if (!env.ASSETS) return new Response("assets not configured", { status: 500 });
  // SPA with hash routing: unknown non-file paths serve index.html.
  const res = await env.ASSETS.fetch(req);
  if (res.status === 404 && !/\.[a-z0-9]+$/i.test(path)) return env.ASSETS.fetch(new Request(new URL("/", u), req));
  return res;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return withHeaders(await handle(req, env), securityHeaders(req));
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message as unknown as InboundEmail, env);
  },
} satisfies ExportedHandler<Env>;
