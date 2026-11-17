// Team join from the CLI: `weft invite` (owner) -> the teammate's `--join <space>:<code>` on another machine (another
// WEFT_HOME, another clone) -> their own member key, agent ids `<checkout>.<handle>`, `weft members` / `members revoke`,
// leaving. Against a stand-in gateway that enforces the same member rules as the real one (the real routes are tested
// in apps/gateway/test/members.test.ts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseJoin } from "../src/gateways";
import { main, parseArgs, plan } from "../src/main";
import { pairingStub } from "./pairing-stub";

type Tok = { id: string; kind: "owner" | "member" | "agent"; space: string; handle?: string; label?: string; member?: string; agent?: string; revoked?: boolean; created_at: string };

/** A stand-in gateway with the member rules of apps/gateway/src/spaces.ts + registry.ts. */
function teamGateway() {
  const spaces = new Map<string, { repos: Set<string>; invites: string[]; handles: Set<string> }>();
  const tokens = new Map<string, Tok>();
  const pairing = pairingStub();
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const ch of req) body += ch;
    const send = (status: number, j?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(j === undefined ? "" : JSON.stringify(j));
    };
    const err = (status: number, code: string, message: string) => send(status, { type: "error", error: { code, message } });
    const u = new URL(req.url!, "http://x");
    const p = u.pathname;
    const m = req.method!;
    const b = body ? JSON.parse(body) : {};
    const now = new Date().toISOString();
    if (p === "/v1/health") return send(200, { type: "health", service: "weft-gateway", ok: true });
    if (p === "/v1/spaces" && m === "POST") {
      const id = `sp${String(++n).padStart(10, "0")}`;
      spaces.set(id, { repos: new Set(), invites: [], handles: new Set() });
      const tok = `weft_owner_${n}`;
      tokens.set(tok, { id: `tok_o${n}`, kind: "owner", space: id, created_at: now });
      return send(201, { type: "space", space: { id, created_at: now }, token: tok });
    }
    if (p === "/v1/join" && m === "POST") {
      const sp = spaces.get(b.space);
      const i = sp ? sp.invites.indexOf(String(b.code).toUpperCase()) : -1;
      if (!sp || i < 0) return err(401, "unauthorized", "that invite code is not valid or has expired");
      sp.invites.splice(i, 1);
      let handle = String(b.handle || "member");
      for (let k = 2; sp.handles.has(handle); k++) handle = `${b.handle}-${k}`;
      sp.handles.add(handle);
      const id = `mem_${++n}`;
      const tok = `weft_member_${n}`;
      tokens.set(tok, { id, kind: "member", space: b.space, handle, label: b.label, created_at: now });
      return send(201, { type: "space.member", role: "member", space: { id: b.space }, token: tok, member: { id, handle, label: b.label, created_at: now, last_seen_at: now } });
    }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (/^\/v1\/(repos\/[^/]+\/events|feed)$/.test(p) && pairing.accepts(auth)) return send(200, { type: "events", events: [], head_seq: 0, has_more: false });
    const t = tokens.get(auth);
    if (!t || t.revoked) return err(401, "unauthorized", "invalid token");
    if (t.kind === "agent" && /^\/v1\/repos\/[^/]+\/events$/.test(p)) return send(200, { type: "events", events: [], head_seq: 0, has_more: false });
    const sp = spaces.get(t.space)!;
    const member = t.kind === "member";
    const memberOk =
      (m === "GET" && p === "/v1/space") ||
      (m === "POST" && ["/v1/space/repos", "/v1/space/tokens", "/v1/space/pairings", "/v1/space/viewers"].includes(p)) ||
      (m === "DELETE" && (p === "/v1/space/members/me" || /^\/v1\/space\/tokens\//.test(p)));
    if (t.kind === "agent" || (member && !memberOk)) return err(403, "forbidden", "only the space's owner can do this");
    const live = (x: Tok) => x.space === t.space && !x.revoked;
    const memberView = (x: Tok) => ({ id: x.id, handle: x.handle, label: x.label, created_at: x.created_at, last_seen_at: x.created_at });
    const members = () => [...tokens.values()].filter((x) => live(x) && x.kind === "member");
    const removeMember = (id: string) => {
      let k = 0;
      for (const x of tokens.values())
        if (live(x) && (x.id === id || x.member === id)) {
          x.revoked = true;
          k++;
        }
      return k;
    };
    if (p === "/v1/space" && m === "GET")
      return send(200, {
        type: "space",
        role: member ? "member" : "owner",
        ...(member ? { member: memberView(t) } : {}),
        space: { id: t.space, repos: [...sp.repos].map((r) => ({ repo: r, name: r.slice(13) })), tokens: tokens.size, members: members().length },
      });
    if (pairing.handle(m, p, body, t.space, `http://${req.headers.host}`, send)) return;
    if (p === "/v1/space/repos") {
      const repo = `${t.space}-${b.name}`;
      if (member && !sp.repos.has(repo)) return err(403, "forbidden", `this space has no repo ${b.name}; only the space's owner can add one`);
      const created = !sp.repos.has(repo);
      sp.repos.add(repo);
      return send(created ? 201 : 200, { name: b.name, repo, created });
    }
    if (p === "/v1/space/tokens" && m === "POST") {
      if (member && (b.kind !== "agent" || !String(b.agent).endsWith(`.${t.handle}`))) return err(403, "forbidden", `a member's agent ids end in .${t.handle}`);
      const tok = `weft_agent_${++n}`;
      tokens.set(tok, { id: `tok_${n}`, kind: "agent", space: t.space, agent: b.agent, ...(member ? { member: t.id } : {}), created_at: now });
      return send(201, { token: tok, info: { id: `tok_${n}`, principal: b.agent } });
    }
    const dm = /^\/v1\/space\/tokens\/(.+)$/.exec(p);
    if (dm && m === "DELETE") {
      const x = [...tokens.values()].find((y) => live(y) && y.id === dm[1] && (!member || y.member === t.id));
      if (!x) return err(404, "not_found", "no such active token in this space");
      x.revoked = true;
      return send(204);
    }
    if (p === "/v1/space/invites" && m === "POST") {
      const code = `INV${String(++n).padStart(2, "0")}-QRSTU`;
      sp.invites.push(code);
      return send(201, { type: "space.invite", space: t.space, code, expires_at: new Date(Date.now() + 1_800_000).toISOString(), expires_in: 1800 });
    }
    if (p === "/v1/space/invites" && m === "DELETE") {
      const k = sp.invites.length;
      sp.invites.length = 0;
      return send(200, { type: "space.invites.cancelled", cancelled: k });
    }
    if (p === "/v1/space/members" && m === "GET") return send(200, { type: "space.members", members: members().map(memberView) });
    if (p === "/v1/space/members" && m === "DELETE") return send(200, { revoked: members().reduce((k, x) => k + removeMember(x.id), 0) });
    if (p === "/v1/space/members/me" && m === "DELETE") return send(200, { type: "space.member.left", revoked: removeMember(t.id) });
    const mm = /^\/v1\/space\/members\/(.+)$/.exec(p);
    if (mm && m === "DELETE") {
      const k = members().some((x) => x.id === mm[1]) ? removeMember(mm[1]!) : 0;
      return k ? send(200, { type: "space.member.removed", member: mm[1], revoked: k }) : err(404, "not_found", "no such member in this space");
    }
    return err(404, "not_found", p);
  });
  return { server, tokens, spaces, pairing };
}

function gitRepo(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/pricing.ts"), "export function calcTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
  return dir;
}

describe("parseArgs / parseJoin / plan for team join", () => {
  it("reads --join <space>:<code> (it implies --hosted unless --url names the gateway) and --as", () => {
    expect(parseJoin("sp0abc1def2g:k7m2p-9xq4t")).toEqual({ space: "sp0abc1def2g", code: "K7M2P-9XQ4T" });
    expect(parseJoin("sp0abc1def2g:K7M2P9XQ4T")).toEqual({ space: "sp0abc1def2g", code: "K7M2P9XQ4T" });
    for (const bad of ["", "K7M2P-9XQ4T", "sp0abc1def2g", "sp0abc1def2g:", "https://x/sp0abc1def2g:K7M2P-9XQ4T", "sp0abc1def2g:K7M2P-9XQ4T-AAAA"]) expect(parseJoin(bad)).toBeUndefined();
    const a = parseArgs(["--join", "sp0abc1def2g:K7M2P-9XQ4T", "--as", "Alice"]);
    expect(a.o).toMatchObject({ hosted: true, join: { space: "sp0abc1def2g", code: "K7M2P-9XQ4T" }, as: "Alice" });
    expect(parseArgs(["--url", "https://weft.example.com", "--join", "sp0abc1def2g:K7M2P-9XQ4T"]).o.hosted).toBe(false);
    expect(parseArgs(["invite"]).cmd).toBe("invite");
    expect(parseArgs(["members", "revoke", "alice"]).o.positional).toEqual(["revoke", "alice"]);
    expect(() => parseArgs(["--join", "nope"])).toThrow(/<space>:<code>/);
    expect(() => parseArgs(["--local", "--join", "sp0abc1def2g:K7M2P-9XQ4T"])).toThrow(/shared gateway/);
    expect(() => parseArgs(["--claim", "AAAA-BBBB-CCCC", "--join", "sp0abc1def2g:K7M2P-9XQ4T"])).toThrow(/unknown option --claim/);
  });

  it("a member's agent ids carry the handle, unique per checkout and at most 64 chars", () => {
    expect(plan(["/a/shop", "/b/shop"], "alice").map((x) => x.agent)).toEqual(["shop.alice", "shop-2.alice"]);
    expect(plan(["/a/shop"]).map((x) => x.agent)).toEqual(["shop"]);
    const long = plan([`/a/${"x".repeat(60)}`], "a-twenty-char-handle")[0]!.agent;
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith(".a-twenty-char-handle")).toBe(true);
  });
});

describe("team join end to end: two machines, one space", () => {
  const gw = teamGateway();
  let url = "";
  const base = mkdtempSync(join(tmpdir(), "weft-team-"));
  const ownerHome = join(base, "owner-config");
  const aliceHome = join(base, "alice-config");
  const bobHome = join(base, "bob-config");
  const ownerRepo = gitRepo(join(base, "owner", "shop"));
  const aliceRepo = gitRepo(join(base, "alice", "shop"));
  const bobRepo = gitRepo(join(base, "bob", "storefront")); // a clone under another name
  const logs: string[] = [];
  const out = () => logs.join("\n");
  const as = (home: string) => (process.env.WEFT_HOME = home);
  const cli = (home: string) =>
    JSON.parse(readFileSync(join(home, "cli.json"), "utf8")) as { gateways: Record<string, { owner?: string; space?: string }>; spaces?: Record<string, { key: string; handle: string; viewer?: string }> };
  const ptr = (dir: string) => JSON.parse(readFileSync(join(dir, ".weft/space.json"), "utf8")) as Record<string, string>;
  let space = "";
  // Always name the stand-in: it listens on 127.0.0.1, which the CLI would otherwise treat as "start a local gateway".
  const run = (args: string[]) => main(["--url", url, ...args, "--harness", "claude-code", "--agents", "1", "--yes", "--no-open"]);

  /** `weft invite` as the owner: the code and the command it prints. */
  async function invite(): Promise<{ code: string; cmd: string[] }> {
    as(ownerHome);
    logs.length = 0;
    expect(await main(["invite", "--dir", ownerRepo])).toBe(0);
    const line = out()
      .split("\n")
      .find((l) => l.includes("--join"))!;
    const cmd = line.trim().split(/\s+/).slice(2); // drop "npx @celador/weft"
    return { code: /--join sp\d+:(\S+)/.exec(line)![1]!, cmd };
  }

  beforeAll(async () => {
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
    process.env.WEFT_NO_OPEN = "1";
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    as(ownerHome);
    expect(await run(["--dir", ownerRepo])).toBe(0);
    space = ptr(ownerRepo).space!;
  });
  afterAll(() => {
    gw.server.close();
    vi.restoreAllMocks();
    delete process.env.WEFT_HOME;
  });

  it("invite prints a one-time code and the teammate's command, with no key and no URL carrying the code", async () => {
    const { code, cmd } = await invite();
    expect(cmd).toEqual(["--url", url, "--join", `${space}:${code}`, "--repo", "shop"]);
    expect(out()).toContain("one use, expires in 30 minutes");
    expect(out()).not.toMatch(/weft_(owner|agent|member|dev)_/);
    expect(out()).not.toMatch(new RegExp(`https?://\\S*${code}`));
    expect(out()).toMatch(/cannot reach it/); // a 127.0.0.1 gateway is said to be this machine's only
  });

  it("the teammate joins from another machine: their own member key, agent shop.alice, nothing of the owner's", async () => {
    const { cmd } = await invite();
    as(aliceHome);
    logs.length = 0;
    expect(await run([...cmd, "--dir", aliceRepo, "--as", "Alice Smith"])).toBe(0);
    expect(out()).toContain(`joined space ${space} as alice`);
    expect(ptr(aliceRepo)).toMatchObject({ url, space, repo: `${space}-shop`, name: "shop", role: "member", handle: "alice", agent: "shop.alice" });
    expect(JSON.parse(readFileSync(join(aliceRepo, ".weft/claude.json"), "utf8"))).toMatchObject({ agent: "shop.alice", repo: `${space}-shop` });
    // Both clones are on `main`: the task ids differ too, or the sequencer would take the two changes for alternatives
    // of one task (best-of-N, spec §7.7) and never check them against each other.
    expect(ptr(ownerRepo).task).toBe("T-main");
    expect(ptr(aliceRepo).task).toBe("T-main.alice");
    const key = readFileSync(join(aliceRepo, ".weft/space-token"), "utf8").trim();
    expect(key).toMatch(/^weft_member_/);
    expect(key).not.toBe(readFileSync(join(ownerRepo, ".weft/space-token"), "utf8").trim());
    // kept apart from this machine's own spaces: `gateways` holds no owner for this URL
    const st = cli(aliceHome);
    expect(st.spaces?.[space]).toMatchObject({ key, handle: "alice" });
    expect(st.gateways[url]?.owner).toBeUndefined();
    // the owner's agent is `shop`: the two are distinct, so they are checked against each other
    expect(ptr(ownerRepo).agent).toBe("shop");
    expect(out()).not.toMatch(/weft_(owner|agent|member|dev)_/);
    // a second run in the clone reuses the member key and token
    const before = ptr(aliceRepo).tokenId;
    logs.length = 0;
    expect(await run(["--dir", aliceRepo])).toBe(0);
    expect(out()).toContain(`using space ${space} as member alice`);
    expect(ptr(aliceRepo).tokenId).toBe(before);
    expect(gw.spaces.size).toBe(1); // no space was created for the teammate
  });

  it("a code works once; a clone with another name picks the repo from --repo (or the space's only repo)", async () => {
    const { cmd } = await invite();
    as(bobHome);
    logs.length = 0;
    const noRepo = cmd.filter((x, i, a) => x !== "--repo" && a[i - 1] !== "--repo");
    expect(await run([...noRepo, "--dir", bobRepo, "--as", "Bob"])).toBe(0);
    expect(ptr(bobRepo)).toMatchObject({ name: "shop", handle: "bob", agent: "storefront.bob" });
    expect(out()).toMatch(/the space's repo is .*shop/);
    // the same code again, on a third machine
    as(join(base, "carol-config"));
    const carol = gitRepo(join(base, "carol", "shop"));
    await expect(run([...cmd, "--dir", carol])).rejects.toThrow(/not valid or has expired/);
    expect(existsSync(join(carol, ".weft"))).toBe(false);
  });

  it("a teammate reads the feed with their own session; owner-only commands say who can run them", async () => {
    as(aliceHome);
    logs.length = 0;
    expect(await main(["status", "--dir", aliceRepo])).toBe(0);
    expect(out()).toContain("joined as alice");
    expect(out()).toContain("recent events");
    expect(cli(aliceHome).spaces?.[space]?.viewer).toMatch(/^weft_dev_/);
    for (const cmd of [["invite"], ["members"], ["viewers"], ["billing"], ["upgrade"]]) await expect(main([...cmd, "--dir", aliceRepo])).rejects.toThrow(/only the owner of space/);
  });

  it("the owner lists members and removes one; the removed teammate is told, and no space is created for them", async () => {
    as(ownerHome);
    logs.length = 0;
    expect(await main(["members", "--dir", ownerRepo])).toBe(0);
    expect(out()).toMatch(/alice\s+Alice Smith on /);
    expect(out()).toMatch(/bob\s+Bob on /);
    logs.length = 0;
    expect(await main(["members", "revoke", "alice", "--dir", ownerRepo])).toBe(0);
    expect(out()).toMatch(/removed alice .*2 keys revoked/); // member key + agent key (the CLI session is a stand-in device)
    await expect(main(["members", "revoke", "nobody", "--dir", ownerRepo])).rejects.toThrow(/no member nobody/);

    as(aliceHome);
    await expect(main(["status", "--dir", aliceRepo])).rejects.toThrow(/no longer accepts this machine's member key/);
    await expect(run(["--dir", aliceRepo])).rejects.toThrow(/no longer accepts this machine's member key/);
    expect(gw.spaces.size).toBe(1);
  });

  it("a removed teammate rejoins with a new code; a teammate can leave (uninstall --space), which never erases the space", async () => {
    const { cmd } = await invite();
    as(aliceHome);
    expect(await run([...cmd, "--dir", aliceRepo, "--as", "Alice Smith"])).toBe(0);
    expect(ptr(aliceRepo)).toMatchObject({ handle: "alice-2", agent: "shop.alice-2" }); // never the removed member's handle again
    logs.length = 0;
    expect(await main(["uninstall", "--space", "--yes", "--dir", aliceRepo])).toBe(0);
    expect(out()).toContain(`left space ${space}`);
    expect(cli(aliceHome).spaces?.[space]).toBeUndefined();
    expect(existsSync(join(aliceRepo, ".weft/space-token"))).toBe(false);
    // the owner's space is intact
    as(ownerHome);
    expect(await main(["status", "--dir", ownerRepo])).toBe(0);
    expect([...gw.tokens.values()].find((t) => t.kind === "owner")!.revoked).toBeUndefined();
  });

  it("joining never replaces this machine's own space, and never drops an owner key kept only in the repo", async () => {
    // Bob has a space of his own in another repo on the same gateway.
    as(bobHome);
    const own = gitRepo(join(base, "bob", "own"));
    expect(await run(["--dir", own])).toBe(0);
    const bobSpace = ptr(own).space!;
    expect(bobSpace).not.toBe(space);
    expect(cli(bobHome).gateways[url]?.owner).toMatch(/^weft_owner_/);
    // his member repo still uses the team space; his own repo still uses his own
    expect(await run(["--dir", bobRepo])).toBe(0);
    expect(ptr(bobRepo).space).toBe(space);
    expect(await run(["--dir", own])).toBe(0);
    expect(ptr(own).space).toBe(bobSpace);

    // A repo whose only copy of its owner key is .weft/space-token (this machine lost cli.json) is not overwritten.
    const { cmd } = await invite();
    as(join(base, "fresh-config"));
    await expect(run([...cmd, "--dir", own])).rejects.toThrow(/owner key is kept only in/);
    expect(ptr(own).space).toBe(bobSpace);
  });
});
