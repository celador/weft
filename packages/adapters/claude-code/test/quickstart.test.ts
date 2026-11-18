// scripts/local-quickstart.mjs (docs/try-it.md §3): argument parsing, the error messages a
// first-time user sees (no gateway, wrong program on the port, missing admin token), and the
// full --demo against a local HTTP stand-in for `pnpm dev:local` (ReferenceCoordinator +
// the admin/system routes the script uses). Both collisions must be denied.
import { ReferenceCoordinator, WcpProtocolError, type EventDraft, type Hello, type Submit } from "@weft/protocol";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stableNodePath } from "../src/node-path";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/local-quickstart.mjs", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
let Q: Q;

beforeAll(async () => {
  Q = await import(SCRIPT);
});

/** Stand-in for the local gateway: one ReferenceCoordinator per repo, auth not checked. */
async function fakeGateway(): Promise<{ url: string; server: Server; tokens: number }> {
  const repos = new Map<string, ReferenceCoordinator>();
  const state = { tokens: 0 };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    try {
      const u = new URL(req.url ?? "/", "http://x");
      const path = u.pathname.replace(/^\/v1/, "");
      if (path === "/health") return send(200, { type: "health", service: "weft-gateway", protocol: "wcp/0.1", ok: true });
      if (req.method === "POST" && path === "/admin/repos") {
        const created = !repos.has(json.repo);
        if (created) repos.set(json.repo, new ReferenceCoordinator({ repo: json.repo }));
        return send(created ? 201 : 200, { created, repo: { repo: json.repo } });
      }
      if (req.method === "POST" && path === "/admin/tokens") {
        state.tokens++;
        return send(201, { token: `tok-${state.tokens}`, info: { principal: json.principal, scopes: json.scopes } });
      }
      const m = /^\/repos\/([^/]+)(\/.*)$/.exec(path);
      const c = m ? repos.get(decodeURIComponent(m[1]!)) : undefined;
      if (!m || !c) return send(404, { type: "error", error: { code: "not_found", message: `no route ${req.method} ${path}` } });
      const rest = m[2]!;
      let s: RegExpExecArray | null;
      if (req.method === "GET" && rest === "/events") return send(200, c.events(0, Number(u.searchParams.get("limit") ?? 100), { tail: true }));
      if (req.method === "GET" && (s = /^\/events\/(\d+)$/.exec(rest))) return send(200, c.event(Number(s[1])));
      if (req.method === "POST" && rest === "/system/events") return send(200, c.system(json as EventDraft, { type: "system", id: "lander" }));
      if (req.method === "POST" && rest === "/sessions") return send(201, c.hello(json as Hello));
      if ((s = /^\/sessions\/([^/]+)(\/\w+)?$/.exec(rest))) {
        const [, sid, tail] = s;
        if (req.method === "POST" && tail === "/events") return send(200, c.submit(sid!, json as Submit));
        if (req.method === "POST" && tail === "/inbox") return send(200, c.drain(sid!, json?.ack));
        if (req.method === "POST" && tail === "/heartbeat") return send(200, c.heartbeat(sid!));
        if (req.method === "POST" && tail === "/gate") return send(200, c.gate(sid!, json));
        if (req.method === "DELETE" && !tail) {
          c.bye(sid!, json?.reason);
          return send(204);
        }
      }
      return send(404, { type: "error", error: { code: "not_found", message: `no route ${req.method} ${path}` } });
    } catch (err) {
      if (err instanceof WcpProtocolError) return send(err.status, err.toJSON());
      return send(500, { type: "error", error: { code: "internal", message: String(err) } });
    }
  });
  server.keepAliveTimeout = 120_000; // fetch reuses sockets across the slow hook steps
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    get tokens() {
      return state.tokens;
    },
  };
}

describe("parseArgs", () => {
  it("defaults to localhost:8787 and resolves checkouts", () => {
    const o = Q.parseArgs(["a", "b"]);
    expect(o.url).toBe(process.env.WEFT_URL ?? "http://localhost:8787");
    expect(o.dirs).toEqual([resolve("a"), resolve("b")]);
  });
  it("takes --url (trailing slash trimmed), --repo, --agents, --demo, --dir", () => {
    const o = Q.parseArgs(["--url", "http://localhost:8797/", "--repo", "r", "--agents", "x, y", "p", "q"]);
    expect(o).toMatchObject({ url: "http://localhost:8797", repo: "r", agents: ["x", "y"] });
    expect(Q.parseArgs(["--demo", "--dir", "/tmp/d"])).toMatchObject({ demo: true, dir: "/tmp/d" });
  });
  it("explains bad input", () => {
    expect(() => Q.parseArgs(["--agents", "x", "p", "q"])).toThrow(/names 1 agent\(s\) but 2 checkout/);
    expect(() => Q.parseArgs(["--url", "localhost:8787"])).toThrow(/must start with http/);
    expect(() => Q.parseArgs(["--url"])).toThrow(/--url needs a value/);
    expect(() => Q.parseArgs(["--bogus"])).toThrow(/unknown option --bogus/);
  });
  it("names agents agent-a, agent-b, ...", () => {
    expect([0, 1, 25, 26].map(Q.agentName)).toEqual(["agent-a", "agent-b", "agent-z", "agent-27"]);
  });
});

describe("adminToken", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-qs-admin-"));
  it("prefers $WEFT_ADMIN_TOKEN, else reads .dev.vars.test (quotes stripped)", () => {
    expect(Q.adminToken({ WEFT_ADMIN_TOKEN: " env-tok \n" }, join(dir, "none"))).toBe("env-tok");
    const f = join(dir, ".dev.vars.test");
    writeFileSync(f, 'OTHER=1\nWEFT_ADMIN_TOKEN="file-tok"\n');
    expect(Q.adminToken({}, f)).toBe("file-tok");
  });
  it("says how to create the file when it is missing", () => {
    expect(() => Q.adminToken({}, join(dir, "missing"))).toThrow(/openssl rand -hex 16\)" > \.dev\.vars\.test/);
    const f = join(dir, "empty");
    writeFileSync(f, "X=1\n");
    expect(() => Q.adminToken({}, f)).toThrow(/no WEFT_ADMIN_TOKEN=/);
  });
});

describe("gateway errors say what to do", () => {
  it("nothing listening -> start dev:local (and how to pick another port)", async () => {
    const api = Q.client("http://127.0.0.1:9", () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));
    await expect(api.health()).rejects.toThrow(/ECONNREFUSED[\s\S]*pnpm dev:local[\s\S]*--port 8797/);
  });
  it("another program on the port -> run the gateway on a free port and pass --url", async () => {
    const api = Q.client("http://localhost:8787", async () => new Response("<html>hi</html>", { status: 404 }));
    await expect(api.health()).rejects.toThrow(/not a Weft gateway[\s\S]*dev:local --port 8797[\s\S]*--url http:\/\/localhost:8797/);
  });
  it("admin 401 / admin disabled -> restart dev:local after writing .dev.vars.test", async () => {
    const reply = (status: number, message: string) => async () =>
      new Response(JSON.stringify({ type: "error", error: { code: status === 401 ? "unauthorized" : "forbidden", message } }), { status });
    await expect(Q.client("http://x", reply(401, "invalid token")).createRepo("t", "r")).rejects.toThrow(/differs from apps\/gateway\/\.dev\.vars\.test/);
    await expect(Q.client("http://x", reply(403, "admin API disabled")).createRepo("t", "r")).rejects.toThrow(/has no WEFT_ADMIN_TOKEN/);
    await expect(Q.client("http://x", reply(422, "unknown change Iabc")).system("t", "r", {})).rejects.toThrow(/session starts[\s\S]*then land/);
  });
  it("never puts the token in an error message", async () => {
    const api = Q.client("http://x", async () => new Response("{}", { status: 500 }));
    await expect(api.token("secret-admin-token", { principal: "p" })).rejects.toThrow(/500/);
    await api.token("secret-admin-token", { principal: "p" }).catch((e: Error) => expect(e.message).not.toContain("secret-admin-token"));
  });
});

describe("setup checks the checkouts before touching the gateway", () => {
  it("rejects a non-git directory and the same checkout twice", async () => {
    const plain = mkdtempSync(join(tmpdir(), "weft-qs-plain-"));
    await expect(Q.setup({ url: "http://x", dirs: [plain] }, {}, () => {})).rejects.toThrow(/not inside a git repository/);
    execFileSync("git", ["init", "-q", plain]);
    await expect(Q.setup({ url: "http://x", dirs: [plain, plain] }, {}, () => {})).rejects.toThrow(/given twice[\s\S]*git worktree add/);
    await expect(Q.setup({ url: "http://x", dirs: [] }, {}, () => {})).rejects.toThrow(/at least one checkout/);
  });
});

describe("--demo end to end (no LLM)", () => {
  let gw: Awaited<ReturnType<typeof fakeGateway>>;
  const saved = process.env.WEFT_ADMIN_TOKEN;
  beforeAll(async () => {
    gw = await fakeGateway();
    process.env.WEFT_ADMIN_TOKEN = "test-admin";
  });
  afterAll(() => {
    gw?.server.close();
    if (saved === undefined) delete process.env.WEFT_ADMIN_TOKEN;
    else process.env.WEFT_ADMIN_TOKEN = saved;
  });

  it("installs two worktrees and gets both collisions denied", async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "weft-qs-demo-"));
    const r = await Q.demo({ url: gw.url, dir }, (l: string) => lines.push(l));
    const out = lines.join("\n");
    try {
      expect(r.ok, out).toBe(true);
      expect(out).toMatch(/\[weft error\] stale_assumption src\/cart\.ts/);
      expect(out).toMatch(/\[weft error\] stale_overwrite src\/pricing\.ts/);
      expect(out).toMatch(/ok {3}agent-b's stale call is denied/);
      expect(gw.tokens).toBe(3); // two agents + the system token
      for (const a of r.agents) {
        const tok = join(a.dir, ".weft/token");
        expect(statSync(tok).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(join(a.dir, ".weft/claude.json"), "utf8"))).toMatchObject({ url: gw.url, repo: r.repo, agent: a.agent });
        const settings = readFileSync(join(a.dir, ".claude/settings.local.json"), "utf8");
        expect(settings).toMatch(/weft-claude\.mjs/);
        expect(settings).toContain(JSON.stringify(stableNodePath()).slice(1, -1));
      }
      // tokens never reach the output
      expect(out).not.toMatch(/tok-\d/);
      expect(statSync(r.systemTokenFile).mode & 0o777).toBe(0o600);
      // a second land from the CLI path posts on top of the current head
      const again = await Q.land({ url: gw.url, repo: r.repo, change: r.agents[1].change, sha: "b".repeat(40) });
      expect(again.kind).toBe("land");
      expect(Q.nextSteps({ url: gw.url, ...r })).toMatch(/local-quickstart\.mjs land --url/);
    } finally {
      if (existsSync(r.systemTokenFile)) rmSync(r.systemTokenFile);
    }
  }, 60_000);

  it("refuses to reuse a --dir that already holds the sample repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-qs-demo2-"));
    Q.makeSampleRepo(dir);
    await expect(Q.demo({ url: gw.url, dir }, () => {})).rejects.toThrow(/already exists; pass a new --dir/);
  });
});

describe("installed hooks survive a Homebrew node upgrade", () => {
  it("maps a versioned Cellar node to the stable opt/<formula> link when it exists", () => {
    const cellar = "/opt/homebrew/Cellar/node@24/24.21.0/bin/node";
    expect(stableNodePath(cellar, (p) => p === "/opt/homebrew/opt/node@24/bin/node", () => true)).toBe("/opt/homebrew/opt/node@24/bin/node");
    expect(stableNodePath("/usr/local/Cellar/node/25.1.0/bin/node", (p) => p === "/usr/local/opt/node/bin/node", () => true)).toBe("/usr/local/opt/node/bin/node");
  });
  it("keeps the real path otherwise", () => {
    expect(stableNodePath("/opt/homebrew/Cellar/node@24/24.21.0/bin/node", () => false)).toBe("/opt/homebrew/Cellar/node@24/24.21.0/bin/node");
    expect(stableNodePath("/Users/x/.nvm/versions/node/v24.1.0/bin/node", () => true)).toBe("/Users/x/.nvm/versions/node/v24.1.0/bin/node");
  });
});
