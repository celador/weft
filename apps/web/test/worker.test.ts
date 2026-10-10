// B9 web Worker: auth gate (Access JWT, operator key, fail-closed), allow-listed gateway
// proxy with the server-held token, CSRF-guarded human actions, WebSocket stream proxy,
// static assets + SPA fallback, security headers.

import { describe, expect, it, beforeEach } from "vitest";
import worker, { bestOfNInstanceId, handle, type Env } from "../src/index";
import { b64url, clearJwksCache, mintSession, SESSION_COOKIE, verifyAccessJwt, type JwksFetcher } from "../src/auth";

const ORIGIN = "https://weft-web.example.workers.dev";
const TEAM = "weft-test.cloudflareaccess.com";
const AUD = "aud-tag-123";

type Call = { url: string; method: string; auth: string | null; body?: string; upgrade: string | null };

function fakeGateway(responder?: (req: Request) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const req = input instanceof Request ? input : new Request(input, init);
      const body = req.method === "POST" ? await req.clone().text() : undefined;
      calls.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), upgrade: req.headers.get("upgrade"), ...(body !== undefined ? { body } : {}) });
      if (responder) return responder(req);
      return Response.json({ ok: true, path: new URL(req.url).pathname });
    },
    connect() {
      throw new Error("no");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function fakeAssets() {
  return {
    async fetch(input: RequestInfo) {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === "/" || u.pathname === "/index.html") return new Response("<!doctype html><title>Weft</title>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/app.js") return new Response("// app", { headers: { "content-type": "text/javascript" } });
      return new Response("nf", { status: 404 });
    },
    connect() {
      throw new Error("no");
    },
  } as unknown as Fetcher;
}

const baseEnv = (extra: Partial<Env> = {}): Env => ({ ASSETS: fakeAssets(), WEFT_WEB_TOKEN: "web-secret-token", WEFT_WEB_KEY: "operator-key", ...extra });

async function keyCookie(env: Env) {
  return `${SESSION_COOKIE}=${await mintSession(env)}`;
}

// ----- Access JWT helpers: a real RS256 keypair, JWKS served by an injected fetcher.
async function accessKit() {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const kid = "kid-1";
  let fetches = 0;
  const fetcher: JwksFetcher = async (url) => {
    fetches++;
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return { keys: [{ ...jwk, kid }] };
  };
  const sign = async (claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}) => {
    const enc = new TextEncoder();
    const h = b64url(enc.encode(JSON.stringify({ alg: "RS256", kid: opts.kid ?? kid, typ: "JWT" })));
    const p = b64url(enc.encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? kp.privateKey, enc.encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, iat: now, email: "john@elier.ai" };
  return { fetcher, sign, good, fetches: () => fetches };
}

beforeEach(() => clearJwksCache());

describe("auth gate", () => {
  it("fails closed when neither Access nor an operator key is configured", async () => {
    const env: Env = { ASSETS: fakeAssets(), WEFT_WEB_TOKEN: "t" };
    expect((await handle(new Request(`${ORIGIN}/`), env)).status).toBe(503);
    const api = await handle(new Request(`${ORIGIN}/api/repos`), env);
    expect(api.status).toBe(503);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe("unavailable");
    // dev mode only when explicitly set
    expect((await handle(new Request(`${ORIGIN}/`), { ...env, WEFT_WEB_DEV: "1" })).status).toBe(200);
  });

  it("operator key: login sets an HttpOnly signed cookie; wrong key and forged cookies are refused", async () => {
    const env = baseEnv();
    expect((await handle(new Request(`${ORIGIN}/`), env)).headers.get("location")).toBe("/login");
    expect((await handle(new Request(`${ORIGIN}/api/repos`), env)).status).toBe(401);
    const bad = await handle(new Request(`${ORIGIN}/login`, { method: "POST", body: new URLSearchParams({ key: "nope" }) }), env);
    expect(bad.status).toBe(401);
    const ok = await handle(new Request(`${ORIGIN}/login`, { method: "POST", body: new URLSearchParams({ key: "operator-key" }) }), env);
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toContain("operator-key");
    const c = cookie.split(";")[0]!;
    expect((await handle(new Request(`${ORIGIN}/`, { headers: { cookie: c } }), env)).status).toBe(200);
    const forged = c.replace(/\.[^.]+$/, ".AAAA");
    expect((await handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie: forged } }), env)).status).toBe(401);
    // a cookie signed with another key is refused
    const other = await mintSession({ WEFT_WEB_KEY: "other" });
    expect((await handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${other}` } }), env)).status).toBe(401);
  });

  it("expired operator sessions are refused", async () => {
    const env = baseEnv();
    const old = await mintSession(env, Date.now() - 13 * 3600_000);
    expect((await handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${old}` } }), env)).status).toBe(401);
  });

  it("Cloudflare Access: verifies RS256 signature, audience, issuer, expiry and the allow-list", async () => {
    const k = await accessKit();
    const env = baseEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, WEFT_WEB_KEY: undefined, GATEWAY: fakeGateway().fetcher });
    const jwt = await k.sign(k.good);
    const me = await handle(new Request(`${ORIGIN}/api/me`, { headers: { "cf-access-jwt-assertion": jwt } }), env, k.fetcher);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { identity: unknown }).identity).toEqual({ email: "john@elier.ai", via: "access" });
    // CF_Authorization cookie also accepted
    expect((await handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `CF_Authorization=${jwt}` } }), env, k.fetcher)).status).toBe(200);

    const reject = async (token: string) => (await handle(new Request(`${ORIGIN}/api/me`, { headers: { "cf-access-jwt-assertion": token } }), env, k.fetcher)).status;
    expect(await reject(await k.sign({ ...k.good, aud: ["other-app"] }))).toBe(401);
    expect(await reject(await k.sign({ ...k.good, iss: "https://evil.cloudflareaccess.com" }))).toBe(401);
    expect(await reject(await k.sign({ ...k.good, exp: Math.floor(Date.now() / 1000) - 120 }))).toBe(401);
    expect(await reject(await k.sign(k.good, { kid: "unknown" }))).toBe(401);
    const stranger = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    expect(await reject(await k.sign(k.good, { key: stranger.privateKey }))).toBe(401);
    expect(await reject(jwt.slice(0, -4) + "abcd")).toBe(401);
    // no JWT at all (someone hitting workers.dev directly)
    expect((await handle(new Request(`${ORIGIN}/api/me`), env, k.fetcher)).status).toBe(401);
    // allow-list
    const listed = { ...env, WEFT_ALLOWED_EMAILS: "someone@else.com" };
    expect((await handle(new Request(`${ORIGIN}/api/me`, { headers: { "cf-access-jwt-assertion": jwt } }), listed, k.fetcher)).status).toBe(403);
    // JWKS is cached
    expect(k.fetches()).toBeLessThanOrEqual(3);
    await expect(verifyAccessJwt("a.b", env, k.fetcher)).rejects.toThrow(/malformed/);
  });
});

describe("gateway proxy", () => {
  it("relays allow-listed reads with the server token, never exposing it, and passes only known query params", async () => {
    const gw = fakeGateway();
    const env = baseEnv({ GATEWAY: gw.fetcher });
    const cookie = await keyCookie(env);
    const get = (p: string) => handle(new Request(`${ORIGIN}${p}`, { headers: { cookie } }), env);
    for (const p of ["/api/repos", "/api/repos/weft/events?tail=1&limit=500&evil=1", "/api/repos/weft/events/42", "/api/repos/weft/tasks", "/api/repos/weft/tasks/t_1/candidates", "/api/repos/weft/changes/I0123"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(await r.text()).not.toContain("web-secret-token");
    }
    expect(gw.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual([
      "/v1/repos",
      "/v1/repos/weft/events?tail=1&limit=500",
      "/v1/repos/weft/events/42",
      "/v1/repos/weft/tasks",
      "/v1/repos/weft/tasks/t_1/candidates",
      "/v1/repos/weft/changes/I0123",
    ]);
    expect(gw.calls.every((c) => c.auth === "Bearer web-secret-token")).toBe(true);
    // not allow-listed: admin, system, sessions, writes
    for (const p of ["/api/admin/tokens", "/api/repos/weft/system/ops", "/api/repos/weft/sessions", "/api/repos/..%2Fadmin/events"]) expect((await get(p)).status, p).toBe(404);
    expect((await handle(new Request(`${ORIGIN}/api/repos/weft/system/events`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), env)).status).toBe(404);
    expect(gw.calls).toHaveLength(6);
  });

  it("rewrites legacy *.workers.dev previews origins in relayed JSON (append-only x_evidence)", async () => {
    // Synthetic subdomain: the real one is never written down (AGENTS.md rule 7).
    const legacy = "https://weft-previews-preview.acme-co.workers.dev";
    const legacyProd = "https://weft-previews.acme-co.workers.dev";
    const body = {
      events: [{ seq: 1, x_evidence: { preview_url: `${legacy}/p/r/${"a".repeat(40)}/SIG/`, screenshots: [`${legacy}/e/SIG/shots/x.png`, `${legacyProd}/e/S2/k.png`] } }],
      other: "https://weft-web.example.workers.dev/untouched",
    };
    const gw = fakeGateway(() => Response.json(body));
    const env = baseEnv({ GATEWAY: gw.fetcher });
    const r = await handle(new Request(`${ORIGIN}/api/repos/weft/events?tail=1`, { headers: { cookie: await keyCookie(env) } }), env);
    const text = await r.text();
    expect(text).not.toContain("acme-co");
    const out = JSON.parse(text);
    expect(out.events[0].x_evidence.preview_url).toBe(`https://weft-previews-preview.elier.ai/p/r/${"a".repeat(40)}/SIG/`);
    expect(out.events[0].x_evidence.screenshots).toEqual(["https://weft-previews-preview.elier.ai/e/SIG/shots/x.png", "https://weft-previews.elier.ai/e/S2/k.png"]);
    expect(out.other).toBe(body.other); // only the previews worker's origin is mapped
  });

  it("keeps gateway error statuses", async () => {
    const gw = fakeGateway(() => Response.json({ type: "error", error: { code: "repo_not_found", message: "x" } }, { status: 404 }));
    const env = baseEnv({ GATEWAY: gw.fetcher });
    const r = await handle(new Request(`${ORIGIN}/api/repos/nope/events`, { headers: { cookie: await keyCookie(env) } }), env);
    expect(r.status).toBe(404);
  });

  it("returns 503 when the web token is missing", async () => {
    const env = baseEnv({ GATEWAY: fakeGateway().fetcher, WEFT_WEB_TOKEN: undefined });
    expect((await handle(new Request(`${ORIGIN}/api/repos`, { headers: { cookie: await keyCookie(env) } }), env)).status).toBe(503);
  });
});

describe("human actions", () => {
  const post = (env: Env, cookie: string, body: unknown, headers: Record<string, string> = {}) =>
    handle(new Request(`${ORIGIN}/api/repos/weft/actions`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);

  it("approve and undo are forwarded as WCP HumanActions, annotated with who clicked", async () => {
    const gw = fakeGateway((req) => Response.json({ type: "action.result", seq: 77 }, { status: 200 }));
    const env = baseEnv({ GATEWAY: gw.fetcher });
    const cookie = await keyCookie(env);
    const a = await post(env, cookie, { action: "approve", change: "Iabc", task: "t1" });
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ seq: 77 });
    expect(JSON.parse(gw.calls[0]!.body!)).toEqual({ type: "action", action: "approve", change: "Iabc", task: "t1", note: "via web by operator" });
    expect(new URL(gw.calls[0]!.url).pathname).toBe("/v1/repos/weft/actions");
    await post(env, cookie, { action: "undo", seq: 12, reason: "error spike" });
    expect(JSON.parse(gw.calls[1]!.body!)).toEqual({ type: "action", action: "undo", seq: 12, reason: "error spike (via web by operator)" });
  });

  it("refuses cross-origin, non-JSON and unknown actions", async () => {
    const gw = fakeGateway();
    const env = baseEnv({ GATEWAY: gw.fetcher });
    const cookie = await keyCookie(env);
    expect((await post(env, cookie, { action: "approve", change: "I1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await handle(new Request(`${ORIGIN}/api/repos/weft/actions`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }), env)).status).toBe(403);
    expect((await post(env, cookie, { action: "approve", change: "I1" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(env, cookie, { action: "land", change: "I1" })).status).toBe(400);
    expect(gw.calls).toHaveLength(0);
  });

  it("approve signals the task's BestOfN workflow instance when bound", async () => {
    const gw = fakeGateway(() => Response.json({ type: "action.result", seq: 9 }));
    const sent: Array<{ id: string; e: unknown }> = [];
    const env = baseEnv({
      GATEWAY: gw.fetcher,
      BESTOFN: { get: async (id: string) => ({ sendEvent: async (e: unknown) => void sent.push({ id, e }) }) } as Env["BESTOFN"],
    });
    const r = await post(env, await keyCookie(env), { action: "approve", change: "Iabc", task: "t_93448400" });
    expect(await r.json()).toMatchObject({ seq: 9, workflow: "signalled" });
    expect(sent).toEqual([{ id: bestOfNInstanceId("weft", "t_93448400"), e: { type: "approve", payload: { repo: "weft", task: "t_93448400", change: "Iabc", seq: 9, by: "operator" } } }]);
    expect(bestOfNInstanceId("weft", "t_93448400")).toBe("bestofn-weft-t_93448400");
  });
});

describe("live stream", () => {
  it("proxies the WebSocket upgrade to the repo stream with the server token and resume point", async () => {
    const gw = fakeGateway((req) => {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      server.send(JSON.stringify({ type: "replay.done", head_seq: 5 }));
      return new Response(null, { status: 101, webSocket: client });
    });
    const env = baseEnv({ GATEWAY: gw.fetcher });
    const cookie = await keyCookie(env);
    const res = await worker.fetch(new Request(`${ORIGIN}/api/repos/weft/stream?after=5`, { headers: { cookie, upgrade: "websocket" } }), env);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const got = new Promise<string>((resolve) => ws.addEventListener("message", (m) => resolve(String(m.data))));
    ws.accept();
    expect(JSON.parse(await got)).toEqual({ type: "replay.done", head_seq: 5 });
    expect(gw.calls[0]).toMatchObject({ auth: "Bearer web-secret-token", upgrade: "websocket" });
    expect(new URL(gw.calls[0]!.url).pathname + new URL(gw.calls[0]!.url).search).toBe("/v1/repos/weft/stream?after=5");
    ws.close();
    // a non-numeric resume point becomes 0; plain GET is refused
    await worker.fetch(new Request(`${ORIGIN}/api/repos/weft/stream?after=x`, { headers: { cookie, upgrade: "websocket" } }), env);
    expect(new URL(gw.calls[1]!.url).search).toBe("?after=0");
    expect((await handle(new Request(`${ORIGIN}/api/repos/weft/stream`, { headers: { cookie } }), env)).status).toBe(426);
    // unauthenticated upgrade never reaches the gateway
    expect((await worker.fetch(new Request(`${ORIGIN}/api/repos/weft/stream`, { headers: { upgrade: "websocket" } }), env)).status).toBe(401);
    expect(gw.calls).toHaveLength(2);
  });
});

describe("policy evaluation", () => {
  it("requires authenticated same-origin JSON and dispatches validated evidence", async () => {
    const fetch = async () => Response.json({ type: "policy.decision", policy: "customer", allow: true, reasons: [], evaluated_at: "now", isolate: "dispatch" });
    const points: unknown[] = [];
    const env = baseEnv({
      POLICY_DISPATCH: { get: () => ({ fetch }) },
      WEFT_ANALYTICS: { writeDataPoint: (point) => points.push(point) },
    });
    const body = JSON.stringify({ repo: "acme", task: "t-1", change: "c-1" });
    const cookie = await keyCookie(env);
    const denied = await handle(new Request(`${ORIGIN}/api/policy/evaluate`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body }), env);
    expect(denied.status).toBe(403);
    const ok = await handle(new Request(`${ORIGIN}/api/policy/evaluate`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body }), env);
    expect(ok.status).toBe(200);
    expect((await ok.json()) as object).toMatchObject({ allow: true, isolate: "dispatch" });
    expect(points).toHaveLength(1);
  });
});

describe("static app", () => {
  it("serves assets behind the gate with security headers, SPA fallback for routes", async () => {
    const env = baseEnv();
    const cookie = await keyCookie(env);
    const r = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } }), env);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>Weft</title>");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`wss://${new URL(ORIGIN).host}`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await worker.fetch(new Request(`${ORIGIN}/app.js`, { headers: { cookie } }), env)).status).toBe(200);
    expect(await (await worker.fetch(new Request(`${ORIGIN}/some/route`, { headers: { cookie } }), env)).text()).toContain("Weft");
    expect((await worker.fetch(new Request(`${ORIGIN}/missing.png`, { headers: { cookie } }), env)).status).toBe(404);
    // static files are gated too
    expect((await worker.fetch(new Request(`${ORIGIN}/app.js`), env)).status).toBe(302);
    expect((await worker.fetch(new Request(`${ORIGIN}/healthz`), env)).status).toBe(200);
  });
});

describe("public read-only demo (WEFT_PUBLIC_DEMO=1)", () => {
  const repos = { type: "repos", repos: [{ repo: "weft" }, { repo: "weft-demo" }, { repo: "secret-repo" }] };
  const pubEnv = (gw: Fetcher, extra: Partial<Env> = {}): Env =>
    baseEnv({ GATEWAY: gw, WEFT_PUBLIC_DEMO: "1", WEFT_PUBLIC_TOKEN: "public-observe-token", WEFT_PUBLIC_REPOS: "weft,weft-demo", ...extra });
  const responder = (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/repos") return Response.json(repos);
    if (path === "/v1/health") return Response.json({ ok: true });
    return Response.json({ ok: true, path });
  };

  it("needs no login: guest identity, /login redirects home, /api/me reports readOnly", async () => {
    const gw = fakeGateway(responder);
    const env = pubEnv(gw.fetcher);
    const home = await worker.fetch(new Request(`${ORIGIN}/`), env);
    expect(home.status).toBe(200);
    for (const method of ["GET", "POST"]) {
      const r = await handle(new Request(`${ORIGIN}/login`, { method }), env);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/");
    }
    const me = (await (await handle(new Request(`${ORIGIN}/api/me`), env)).json()) as Record<string, any>;
    expect(me).toMatchObject({ identity: { email: "guest", via: "public" }, readOnly: true, token: true });
  });

  it("allows GET routes with the public token and only the allow-listed repos", async () => {
    const gw = fakeGateway(responder);
    const env = pubEnv(gw.fetcher);
    const list = (await (await handle(new Request(`${ORIGIN}/api/repos`), env)).json()) as { repos: { repo: string }[] };
    expect(list.repos.map((r) => r.repo)).toEqual(["weft", "weft-demo"]);
    for (const p of ["/api/repos/weft/events?tail=1&limit=5", "/api/repos/weft/events/3", "/api/repos/weft-demo/tasks", "/api/repos/weft/changes/Iabc"]) {
      expect((await handle(new Request(`${ORIGIN}${p}`), env)).status).toBe(200);
    }
    const hidden = await handle(new Request(`${ORIGIN}/api/repos/secret-repo/events`), env);
    expect(hidden.status).toBe(404);
    expect(gw.calls.some((c) => c.url.includes("secret-repo"))).toBe(false);
  });

  it("fails closed when the public repo allow-list is missing or empty", async () => {
    for (const list of [undefined, "", " , "]) {
      const gw = fakeGateway(responder);
      const env = pubEnv(gw.fetcher, { WEFT_PUBLIC_REPOS: list });
      const response = await handle(new Request(`${ORIGIN}/api/repos`), env);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { repos: unknown[] }).repos).toEqual([]);
      for (const path of ["/api/repos/secret-repo/events", "/api/repos/weft/events", "/api/repos/weft/stream"]) {
        expect((await handle(new Request(`${ORIGIN}${path}`, { headers: { upgrade: "websocket" } }), env)).status).toBe(404);
      }
      expect(gw.calls).toHaveLength(0);
    }
  });

  it("refuses every POST with 403 read_only and never reaches the gateway", async () => {
    const gw = fakeGateway(responder);
    const env = pubEnv(gw.fetcher);
    const post = (path: string, body = "{}") => handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body }), env);
    for (const path of ["/api/repos/weft/actions", "/api/policy/evaluate", "/logout", "/api/repos"]) {
      const r = await post(path, JSON.stringify({ action: "approve", change: "Iabc", task: "t1" }));
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe("read_only");
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) expect((await handle(new Request(`${ORIGIN}/api/repos/weft/actions`, { method, headers: { origin: ORIGIN } }), env)).status).toBe(403);
    expect(gw.calls).toHaveLength(0);
  });

  it("token isolation: uses WEFT_PUBLIC_TOKEN only, never falls back to WEFT_WEB_TOKEN", async () => {
    const gw = fakeGateway(responder);
    await handle(new Request(`${ORIGIN}/api/repos`), pubEnv(gw.fetcher));
    await handle(new Request(`${ORIGIN}/api/repos/weft/events`), pubEnv(gw.fetcher));
    await handle(new Request(`${ORIGIN}/api/me`), pubEnv(gw.fetcher));
    expect(gw.calls.length).toBe(3);
    for (const c of gw.calls) expect(c.auth).toBe("Bearer public-observe-token");
    // public token missing: 503, and WEFT_WEB_TOKEN (still present in env) is not used
    const gw2 = fakeGateway(responder);
    const env2 = pubEnv(gw2.fetcher, { WEFT_PUBLIC_TOKEN: undefined });
    const r = await handle(new Request(`${ORIGIN}/api/repos`), env2);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("WEFT_PUBLIC_TOKEN");
    await handle(new Request(`${ORIGIN}/api/me`), env2);
    expect(gw2.calls.every((c) => !c.auth?.includes("web-secret-token"))).toBe(true);
  });

  it("scrubs workers.dev hostnames and redact terms from relayed JSON and stream frames", async () => {
    const leak = "see https://weft-gateway-preview.acme-corp.workers.dev/v1 and acme-corp.workers.dev and https://weft-web.acme-co... and ACME-corp";
    const gw = fakeGateway((req) => {
      if (req.headers.get("upgrade") === "websocket") {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        server.accept();
        server.send(JSON.stringify({ type: "event", event: { summary: leak } }));
        return new Response(null, { status: 101, webSocket: client });
      }
      return Response.json({ summary: leak });
    });
    const env = pubEnv(gw.fetcher, { WEFT_REDACT: "acme-corp" });
    const text = await (await handle(new Request(`${ORIGIN}/api/repos/weft/events/1`), env)).text();
    expect(text).not.toMatch(/workers\.dev|acme/i);
    expect(text).toContain("https://weft-gateway-preview.elier.ai/v1");
    const res = await worker.fetch(new Request(`${ORIGIN}/api/repos/weft/stream?after=0`, { headers: { upgrade: "websocket" } }), env);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const got = new Promise<string>((resolve) => ws.addEventListener("message", (m) => resolve(String(m.data))));
    ws.accept();
    const frame = await got;
    expect(frame).not.toMatch(/workers\.dev|acme/i);
    expect(frame).toContain("weft-gateway-preview.elier.ai");
    expect(gw.calls.at(-1)).toMatchObject({ auth: "Bearer public-observe-token", upgrade: "websocket" });
    ws.close();
  });

  it("non-public mode is unchanged: login required, web token used, no readOnly, POST allowed", async () => {
    const gw = fakeGateway(responder);
    const env = baseEnv({ GATEWAY: gw.fetcher, WEFT_PUBLIC_TOKEN: "public-observe-token" });
    expect((await handle(new Request(`${ORIGIN}/api/repos`), env)).status).toBe(401);
    expect((await handle(new Request(`${ORIGIN}/login`), env)).status).toBe(200);
    const cookie = await keyCookie(env);
    const me = (await (await handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }), env)).json()) as Record<string, any>;
    expect(me.readOnly).toBe(false);
    expect(me.identity).toEqual({ email: "operator", via: "key" });
    const list = (await (await handle(new Request(`${ORIGIN}/api/repos`, { headers: { cookie } }), env)).json()) as { repos: unknown[] };
    expect(list.repos).toHaveLength(3);
    const act = await handle(new Request(`${ORIGIN}/api/repos/weft/actions`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) }), env);
    expect(act.status).toBe(200);
    for (const c of gw.calls) expect(c.auth).toBe("Bearer web-secret-token");
  });
});
