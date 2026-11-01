// Local is the default gateway; hosted is opt-in (John, 2026-11-01). `chooseGateway` as a table,
// and `weft` end to end against two stand-in gateways: the one startLocal() "starts" (this
// machine) and one that answers for the hosted URL (fetch is rewritten, nothing leaves the test).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ url: "", started: 0 }));
vi.mock("../src/gateways", async (orig) => ({
  ...(await orig<typeof import("../src/gateways")>()),
  startLocal: vi.fn(async () => {
    local.started++;
    return { url: local.url, admin: "admin-for-test" };
  }),
}));

import { HOSTED_URL, kindOf, loadState, type CliState } from "../src/gateways";
import { chooseGateway, KEPT_HOSTED, main, parseArgs } from "../src/main";
import { pairingStub } from "./pairing-stub";

const opts = (o: Partial<{ local: boolean; hosted: boolean; url: string }> = {}) => ({ local: false, hosted: false, ...o });
const empty: CliState = { gateways: {} };
const hostedUser: CliState = { gateways: { [HOSTED_URL]: { kind: "hosted", space: "sp1", owner: "weft_owner_x" } } };

describe("parseArgs: --hosted, and --local stays accepted", () => {
  it("reads --hosted and keeps --local as an alias", () => {
    expect(parseArgs([]).o).toMatchObject({ local: false, hosted: false });
    expect(parseArgs(["--hosted"]).o).toMatchObject({ hosted: true, local: false });
    expect(parseArgs(["--local"]).o).toMatchObject({ local: true, hosted: false });
  });
  it("refuses both at once", () => {
    expect(() => parseArgs(["--local", "--hosted"])).toThrow(/contradict/);
  });
});

describe("chooseGateway", () => {
  it("no flags, nothing set up: local", () => {
    expect(chooseGateway(opts(), undefined, empty, [])).toEqual({ local: true });
  });
  it("--local is the same as no flag", () => {
    expect(chooseGateway(opts({ local: true }), undefined, empty, [])).toEqual({ local: true });
  });
  it("--hosted opts in, with no notice", () => {
    expect(chooseGateway(opts({ hosted: true }), undefined, empty, [])).toEqual({ url: HOSTED_URL });
  });
  it("--url and WEFT_URL name a gateway (--url first)", () => {
    expect(chooseGateway(opts({ url: "https://gw.example" }), "https://env.example", empty, [])).toEqual({ url: "https://gw.example" });
    expect(chooseGateway(opts(), "https://env.example", hostedUser, [])).toEqual({ url: "https://env.example" });
  });
  it("an existing hosted space (cli.json) is kept, with the notice", () => {
    expect(chooseGateway(opts(), undefined, hostedUser, [])).toEqual({ url: HOSTED_URL, keptHosted: true });
  });
  it("a repo already pointing at a hosted space (.weft/space-token) is kept, with the notice", () => {
    expect(chooseGateway(opts(), undefined, empty, [HOSTED_URL])).toEqual({ url: HOSTED_URL, keptHosted: true });
  });
  it("a repo pointing at your own gateway is kept, without the hosted notice", () => {
    expect(chooseGateway(opts(), undefined, empty, ["https://weft.example.com"])).toEqual({ url: "https://weft.example.com" });
  });
  it("a repo pointing at a local gateway is local again", () => {
    expect(chooseGateway(opts(), undefined, empty, ["http://127.0.0.1:7878"])).toEqual({ local: true });
  });
  it("`weft use local` beats an old hosted space; `weft use hosted` / `use URL` are respected without the notice", () => {
    expect(chooseGateway(opts(), undefined, { ...hostedUser, default: "http://127.0.0.1:7879" }, [HOSTED_URL])).toEqual({ local: true });
    expect(chooseGateway(opts(), undefined, { ...hostedUser, default: HOSTED_URL }, [])).toEqual({ url: HOSTED_URL });
    expect(chooseGateway(opts(), undefined, { gateways: {}, default: "https://weft.example.com" }, [])).toEqual({ url: "https://weft.example.com" });
  });
  it("explicit --local wins over an existing hosted space", () => {
    expect(chooseGateway(opts({ local: true }), undefined, hostedUser, [HOSTED_URL])).toEqual({ local: true });
  });
});

// ------------------------------------------------------------------ end to end

function fakeGateway(): { server: Server; spaces: () => number; hits: string[] } {
  const spaces = new Map<string, Set<string>>();
  const tokens = new Map<string, { id: string; space: string; kind: string }>();
  const hits: string[] = [];
  const pairing = pairingStub();
  let n = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const ch of req) body += ch;
    const send = (status: number, j?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(j === undefined ? "" : JSON.stringify(j));
    };
    const u = new URL(req.url!, "http://x");
    hits.push(`${req.method} ${u.pathname}`);
    if (u.pathname === "/v1/health") return send(200, { type: "health", service: "weft-gateway", ok: true });
    if (u.pathname === "/v1/spaces" && req.method === "POST") {
      const id = `sp${String(++n).padStart(10, "0")}`;
      spaces.set(id, new Set());
      tokens.set(`weft_owner_${n}`, { id: `tok_o${n}`, space: id, kind: "owner" });
      return send(201, { type: "space", space: { id, created_at: new Date().toISOString() }, token: `weft_owner_${n}` });
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (/^\/v1\/repos\/[^/]+\/events$/.test(u.pathname) && pairing.accepts(bearer)) return send(200, { type: "events", events: [], head_seq: 0, has_more: false });
    const t = tokens.get(bearer);
    if (!t) return send(401, { type: "error", error: { code: "unauthorized", message: "invalid token" } });
    if (pairing.handle(req.method!, u.pathname, body, t.space, `http://${req.headers.host}`, send)) return;
    if (u.pathname === "/v1/space" && req.method === "GET") return send(200, { space: { id: t.space, repos: [], tokens: tokens.size } });
    if (u.pathname === "/v1/space/repos") {
      const name = JSON.parse(body).name as string;
      const repo = `${t.space}-${name}`;
      const created = !spaces.get(t.space)!.has(repo);
      spaces.get(t.space)!.add(repo);
      return send(created ? 201 : 200, { name, repo, created });
    }
    if (u.pathname === "/v1/space/tokens" && req.method === "POST") {
      const spec = JSON.parse(body);
      const tok = `weft_${spec.kind}_${++n}`;
      tokens.set(tok, { id: `tok_${n}`, space: t.space, kind: spec.kind });
      return send(201, { token: tok, info: { id: `tok_${n}`, principal: spec.agent ?? spec.kind } });
    }
    if (/^\/v1\/repos\/[^/]+\/events$/.test(u.pathname)) return send(200, { type: "events", events: [], head_seq: 0, has_more: false });
    return send(404, { type: "error", error: { code: "not_found", message: u.pathname } });
  });
  return { server, spaces: () => spaces.size, hits };
}

describe("weft with no flags: local by default, existing hosted users keep their space", () => {
  const localGw = fakeGateway();
  const hostedGw = fakeGateway();
  const base = mkdtempSync(join(tmpdir(), "weft-default-"));
  const logs: string[] = [];
  const realFetch = globalThis.fetch;
  let hostedUrl = "";

  const newRepo = (name: string): string => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
    return dir;
  };
  const weft = (dir: string, ...extra: string[]) => main([...extra, "--dir", dir, "--yes", "--no-open", "--harness", "claude-code", "--agents", "1"]);
  const pointer = (dir: string) => JSON.parse(readFileSync(join(dir, ".weft/space.json"), "utf8")) as { url: string; space: string };
  const freshHome = (name: string) => {
    process.env.WEFT_HOME = join(base, name);
    rmSync(process.env.WEFT_HOME, { recursive: true, force: true });
  };

  beforeAll(async () => {
    for (const g of [localGw, hostedGw]) await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", () => r()));
    local.url = `http://127.0.0.1:${(localGw.server.address() as { port: number }).port}`;
    hostedUrl = `http://127.0.0.1:${(hostedGw.server.address() as { port: number }).port}`;
    // Requests for the real hosted URL go to the stand-in; nothing else is rewritten.
    vi.stubGlobal("fetch", ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(input);
      return realFetch(u.startsWith(HOSTED_URL) ? hostedUrl + u.slice(HOSTED_URL.length) : u, init);
    }) as typeof fetch);
    process.env.WEFT_NO_OPEN = "1";
    delete process.env.WEFT_URL;
    process.env.WEFT_HERMES_CONFIG = join(base, "no-hermes-adapter.json");
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterAll(() => {
    for (const g of [localGw, hostedGw]) g.server.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.WEFT_HERMES_CONFIG;
    rmSync(base, { recursive: true, force: true });
  });
  beforeEach(() => {
    logs.length = 0;
    local.started = 0;
  });

  it("a new user: no flags starts the local gateway and creates the space there, never on hosted", async () => {
    freshHome("home-new");
    const repo = newRepo("new");
    expect(await weft(repo)).toBe(0);
    expect(local.started).toBe(1);
    expect(pointer(repo).url).toBe(local.url);
    expect(hostedGw.hits).toEqual([]);
    const out = logs.join("\n");
    expect(out).toContain("local space");
    expect(out).toContain(`${local.url}/feed?space=`);
    expect(out).not.toContain("#t=");
    expect(out).not.toContain(KEPT_HOSTED);
    expect(loadState().default).toBeUndefined();
    expect(JSON.parse(readFileSync(join(repo, ".claude/settings.local.json"), "utf8")).hooks).toBeTruthy();
  });

  it("--local is the same as no flag", async () => {
    freshHome("home-local-flag");
    const repo = newRepo("localflag");
    expect(await weft(repo, "--local")).toBe(0);
    expect(local.started).toBe(1);
    expect(pointer(repo).url).toBe(local.url);
  });

  it("--hosted opts in: the space is created on the hosted gateway and the local one is not started", async () => {
    freshHome("home-hosted");
    const repo = newRepo("optin");
    const before = hostedGw.spaces();
    expect(await weft(repo, "--hosted")).toBe(0);
    expect(local.started).toBe(0);
    expect(pointer(repo).url).toBe(HOSTED_URL);
    expect(hostedGw.spaces()).toBe(before + 1);
    expect(logs.join("\n")).not.toContain(KEPT_HOSTED);
    expect(loadState().gateways[HOSTED_URL]?.owner).toBeTruthy();
  });

  it("an existing hosted user (cli.json) keeps their hosted space in a new repo and sees the one-line notice", async () => {
    // home-hosted (above) holds a hosted space
    process.env.WEFT_HOME = join(base, "home-hosted");
    const spacesBefore = hostedGw.spaces();
    const repo = newRepo("existing-cli");
    expect(await weft(repo)).toBe(0);
    expect(local.started).toBe(0);
    expect(pointer(repo).url).toBe(HOSTED_URL);
    expect(hostedGw.spaces()).toBe(spacesBefore);
    expect(logs.filter((l) => l.includes(KEPT_HOSTED))).toHaveLength(1);
    expect(KEPT_HOSTED).toBe("Using your hosted space. Local is now the default for new projects: npx @celador/weft use local");
  });

  it("a repo whose .weft/space-token points at a hosted space keeps it even when ~/.config/weft is lost", async () => {
    process.env.WEFT_HOME = join(base, "home-hosted");
    const repo = newRepo("existing-repo");
    expect(await weft(repo)).toBe(0); // hosted, via cli.json
    expect(existsSync(join(repo, ".weft/space-token"))).toBe(true);
    freshHome("home-lost");
    const spacesBefore = hostedGw.spaces();
    logs.length = 0;
    expect(await weft(repo)).toBe(0);
    expect(local.started).toBe(0);
    expect(pointer(repo).url).toBe(HOSTED_URL);
    expect(hostedGw.spaces()).toBe(spacesBefore);
    expect(logs.filter((l) => l.includes(KEPT_HOSTED))).toHaveLength(1);
  });

  it("explicit --local moves an existing hosted user to this machine", async () => {
    process.env.WEFT_HOME = join(base, "home-hosted");
    const repo = newRepo("move");
    expect(await weft(repo, "--local")).toBe(0);
    expect(local.started).toBe(1);
    expect(pointer(repo).url).toBe(local.url);
    expect(logs.join("\n")).not.toContain(KEPT_HOSTED);
  });

  it("`use local` and `use hosted` set the default that no-flag runs follow", async () => {
    process.env.WEFT_HOME = join(base, "home-hosted");
    expect(await main(["use", "local"])).toBe(0);
    expect(kindOf(loadState().default!)).toBe("local");
    expect(logs.join("\n")).toContain("default gateway: local");
    let repo = newRepo("use-local");
    expect(await weft(repo)).toBe(0);
    expect(local.started).toBe(1);
    expect(pointer(repo).url).toBe(local.url);
    expect(logs.join("\n")).not.toContain(KEPT_HOSTED);

    logs.length = 0;
    local.started = 0;
    expect(await main(["use", "hosted"])).toBe(0);
    expect(loadState().default).toBe(HOSTED_URL);
    expect(logs.join("\n")).toContain("default gateway: hosted");
    repo = newRepo("use-hosted");
    expect(await weft(repo)).toBe(0);
    expect(local.started).toBe(0);
    expect(pointer(repo).url).toBe(HOSTED_URL);
    expect(logs.join("\n")).not.toContain(KEPT_HOSTED);
  });
});
