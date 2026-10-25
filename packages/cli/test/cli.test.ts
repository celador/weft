// CLI tests: argument parsing, hook pruning, and the whole `weft` flow (space, repo,
// worktree, adapter install, status, uninstall) against a stand-in gateway on localhost.
// The real gateway's space API is tested in apps/gateway/test/spaces.test.ts.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectHarnesses, HARNESSES, pruneHooks, startOrder } from "../src/adapters";
import { main, mcpArgs, nextNotes, parseArgs } from "../src/main";
import { slug } from "../src/util";

describe("parseArgs", () => {
  it("defaults to init and reads options", () => {
    expect(parseArgs([]).cmd).toBe("init");
    const { cmd, o } = parseArgs(["--local", "--agents", "3", "--harness", "claude-code,codex", "--no-open", "-y"]);
    expect(cmd).toBe("init");
    expect(o).toMatchObject({ local: true, agents: 3, harness: ["claude-code", "codex"], open: false, yes: true });
    expect(parseArgs(["status"]).cmd).toBe("status");
    expect(parseArgs(["add", "reviewer"]).o.positional).toEqual(["reviewer"]);
    expect(parseArgs(["deploy", "--domain", "weft.example.com"]).o.domain).toBe("weft.example.com");
    expect(parseArgs(["--harness", "antigravity"]).o.harness).toEqual(["antigravity"]);
  });
  it("rejects unknown options and harnesses", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--harness", "vim"])).toThrow(/unknown harness/);
    expect(() => parseArgs(["--agents", "0"])).toThrow(/1-8/);
  });
});

describe("harness detection and the Next lines (2026-10 cold run)", () => {
  it("finds every harness on PATH, Antigravity's agy included", () => {
    const bin = mkdtempSync(join(tmpdir(), "weft-path-"));
    for (const b of ["claude", "codex", "cursor-agent", "opencode", "gemini", "copilot", "agy"]) {
      writeFileSync(join(bin, b), "#!/bin/sh\n");
      chmodSync(join(bin, b), 0o755);
    }
    expect(detectHarnesses({ PATH: bin }).found.sort()).toEqual(["antigravity", "claude-code", "codex", "copilot", "cursor", "gemini", "opencode"]);
    expect(detectHarnesses({ PATH: mkdtempSync(join(tmpdir(), "weft-path-")) }).found).toEqual([]);
  });
  it("starts with Claude Code, lists the other harnesses, and says what each asks on first run", () => {
    const order = startOrder(["codex", "antigravity", "claude-code", "cursor"]);
    expect(order.map((h) => h.id)).toEqual(["claude-code", "codex", "antigravity", "cursor"]);
    const out = nextNotes(order, ["/r/shop", "/r/shop-2"]);
    expect(out).toContain("codex, agy, cursor-agent");
    // Codex skips untrusted project hooks silently (codex exec) or asks once (TUI)
    expect(out).toMatch(/Codex asks once to review the new hooks: choose "Trust all and continue"/);
    expect(out).toContain("--dangerously-bypass-hook-trust");
    expect(out).toContain("npx -y @celador/weft mcp --dir <checkout>");
    expect(nextNotes(startOrder(["claude-code"]), ["/r/shop"])).not.toContain("First run");
    expect(HARNESSES.every((h) => h.run)).toBe(true);
  });
});

describe("slug", () => {
  it("makes safe repo and agent names", () => {
    expect(slug("My App!")).toBe("my-app");
    expect(slug("--x")).toBe("x");
    expect(slug("")).toBe("repo");
    expect(slug("a".repeat(80), 48)).toHaveLength(48);
  });
});

describe("pruneHooks", () => {
  it("drops only Weft hook commands and the groups they leave empty", () => {
    const settings = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "/usr/bin/node /x/adapters/claude-code/weft-claude.mjs hook" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "./my-lint.sh" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "node /x/weft-claude.mjs hook" }] }],
      },
    };
    expect(pruneHooks(settings)).toEqual({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./my-lint.sh" }] }] } });
  });
  it("prunes to empty when everything was Weft's", () => {
    expect(pruneHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node weft-cursor.mjs hook" }] }] } })).toEqual({});
  });
});

// ---------------------------------------------------------------- the flow, against a stand-in gateway

type Tok = { id: string; kind: string; repo?: string; agent?: string; revoked?: boolean };
function fakeGateway() {
  const spaces = new Map<string, { repos: Set<string> }>();
  const tokens = new Map<string, Tok & { space: string }>();
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const ch of req) body += ch;
    const send = (status: number, j?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(j === undefined ? "" : JSON.stringify(j));
    };
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const t = tokens.get(auth);
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/v1/health") return send(200, { type: "health", service: "weft-gateway", ok: true });
    if (u.pathname === "/v1/spaces" && req.method === "POST") {
      const id = `sp${String(++n).padStart(10, "0")}`;
      spaces.set(id, { repos: new Set() });
      const tok = `weft_owner_${n}`;
      tokens.set(tok, { id: `tok_o${n}`, kind: "owner", space: id });
      return send(201, { type: "space", space: { id, created_at: new Date().toISOString() }, token: tok });
    }
    if (!t || t.revoked) return send(401, { type: "error", error: { code: "unauthorized", message: "invalid token" } });
    const sp = spaces.get(t.space)!;
    if (u.pathname === "/v1/space" && req.method === "GET") return send(200, { space: { id: t.space, repos: [...sp.repos].map((r) => ({ repo: r, name: r.slice(13) })), tokens: tokens.size } });
    if (u.pathname === "/v1/space" && req.method === "DELETE") {
      for (const x of tokens.values()) if (x.space === t.space) x.revoked = true;
      return send(204);
    }
    if (u.pathname === "/v1/space/repos") {
      const name = JSON.parse(body).name;
      const repo = `${t.space}-${name}`;
      const created = !sp.repos.has(repo);
      sp.repos.add(repo);
      return send(created ? 201 : 200, { name, repo, created });
    }
    if (u.pathname === "/v1/space/tokens" && req.method === "POST") {
      const spec = JSON.parse(body);
      const tok = `weft_${spec.kind}_${++n}`;
      tokens.set(tok, { id: `tok_${n}`, ...spec, space: t.space });
      return send(201, { token: tok, info: { id: `tok_${n}`, principal: spec.agent ?? spec.kind } });
    }
    const dm = /^\/v1\/space\/tokens\/(.+)$/.exec(u.pathname);
    if (dm && req.method === "DELETE") {
      for (const x of tokens.values()) if (x.id === dm[1]) x.revoked = true;
      return send(204);
    }
    if (/^\/v1\/repos\/[^/]+\/events$/.test(u.pathname)) return send(200, { type: "events", events: [], head_seq: 0, has_more: false });
    return send(404, { type: "error", error: { code: "not_found", message: u.pathname } });
  });
  return { server, tokens, spaces };
}

describe("weft (init / status / add / uninstall) against a stand-in gateway", () => {
  const gw = fakeGateway();
  let url = "";
  const base = mkdtempSync(join(tmpdir(), "weft-cli-"));
  const repo = join(base, "shop");
  const logs: string[] = [];

  beforeAll(async () => {
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
    process.env.WEFT_HOME = join(base, "config");
    process.env.WEFT_NO_OPEN = "1";
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterAll(() => {
    gw.server.close();
    vi.restoreAllMocks();
  });

  it("creates a space, the repo, a second worktree, and installs Claude Code hooks in both", async () => {
    expect(await main(["--url", url, "--dir", repo, "--yes", "--no-open", "--harness", "claude-code"])).toBe(0);
    const wt = join(base, "shop-2");
    for (const dir of [repo, wt]) {
      const ptr = JSON.parse(readFileSync(join(dir, ".weft/space.json"), "utf8"));
      expect(ptr).toMatchObject({ url, repo: "sp0000000001-shop", name: "shop", harnesses: ["claude-code"] });
      const cfg = JSON.parse(readFileSync(join(dir, ".weft/claude.json"), "utf8"));
      expect(cfg).toMatchObject({ url, repo: "sp0000000001-shop", agent: dir === repo ? "shop" : "shop-2" });
      expect(readFileSync(join(dir, ".weft/token"), "utf8").trim()).toMatch(/^weft_agent_/);
      expect(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")).toContain("weft-claude.mjs hook");
      // hooks run the per-version runtime copy, not npx's cache
      expect(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")).toContain(join(realpathSync(base), "config", "runtime"));
    }
    expect(existsSync(join(base, "config", "runtime", "0.0.0-dev", "node_modules", "typescript", "package.json"))).toBe(true);
    // no token is printed except the viewer link
    const out = logs.join("\n");
    expect(out).toContain(`${url}/feed#t=weft_viewer_`);
    expect(out).not.toMatch(/weft_(owner|agent)_/);
    // .weft/ is git-ignored
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("is idempotent: a second run reuses the space, repo, tokens and Change-Ids", async () => {
    const before = JSON.parse(readFileSync(join(repo, ".weft/space.json"), "utf8"));
    const nTokens = gw.tokens.size;
    expect(await main(["--url", url, "--dir", repo, "--yes", "--no-open", "--harness", "claude-code"])).toBe(0);
    const after = JSON.parse(readFileSync(join(repo, ".weft/space.json"), "utf8"));
    expect(after).toMatchObject({ space: before.space, tokenId: before.tokenId, change: before.change });
    expect(gw.tokens.size).toBe(nTokens);
    expect(gw.spaces.size).toBe(1);
  });

  it("finds the space again from the repo when ~/.config/weft is lost", async () => {
    process.env.WEFT_HOME = join(base, "config-new-machine");
    expect(await main(["--url", url, "--dir", repo, "--yes", "--no-open", "--harness", "claude-code", "--agents", "2"])).toBe(0);
    expect(gw.spaces.size).toBe(1);
    process.env.WEFT_HOME = join(base, "config");
  });

  it("add creates one more worktree with Weft installed", async () => {
    expect(await main(["add", "reviewer", "--url", url, "--dir", repo, "--harness", "claude-code"])).toBe(0);
    expect(JSON.parse(readFileSync(join(base, "shop-reviewer/.weft/space.json"), "utf8"))).toMatchObject({ agent: "shop-reviewer" });
  });

  it("status prints the setup without secrets", async () => {
    logs.length = 0;
    expect(await main(["status", "--dir", repo])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("sp0000000001");
    expect(out).toContain("shop-reviewer");
    expect(out).not.toMatch(/weft_(owner|agent)_/);
  });

  it("uninstall removes hooks, git hooks and .weft/ from every checkout and revokes agent tokens", async () => {
    expect(await main(["uninstall", "--dir", repo, "--space", "--yes"])).toBe(0);
    for (const dir of [repo, join(base, "shop-2"), join(base, "shop-reviewer")]) {
      expect(existsSync(join(dir, ".weft"))).toBe(false);
      expect(existsSync(join(dir, ".claude/settings.local.json"))).toBe(false);
    }
    expect(existsSync(join(repo, ".git/hooks/pre-commit"))).toBe(false);
    expect([...gw.tokens.values()].every((t) => t.revoked)).toBe(true);
  });
});

describe("every harness in one checkout, and weft mcp", () => {
  const gw = fakeGateway();
  let url = "";
  const base = mkdtempSync(join(tmpdir(), "weft-cli-all-"));
  const repo = join(base, "app");
  const cli = join(__dirname, "..", "dist", "weft.mjs");

  beforeAll(async () => {
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
    process.env.WEFT_HOME = join(base, "config");
    process.env.WEFT_NO_OPEN = "1";
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "a.py"), "def a():\n    return 1\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterAll(() => {
    gw.server.close();
    vi.restoreAllMocks();
  });

  it("installs all seven hook adapters (Antigravity's .agents/hooks.json too) and keeps git status clean", async () => {
    const all = HARNESSES.map((h) => h.id).join(",");
    expect(await main(["--url", url, "--dir", repo, "--yes", "--no-open", "--agents", "1", "--harness", all])).toBe(0);
    expect(readFileSync(join(repo, ".agents/hooks.json"), "utf8")).toContain("weft-antigravity.mjs hook");
    for (const h of HARNESSES) expect(existsSync(join(repo, h.config))).toBe(true);
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("weft mcp serves MCP on stdio for the checkout (stdout carries only JSON-RPC)", async () => {
    const child = spawn(process.execPath, [cli, "mcp", "--dir", repo], { env: { ...process.env, WEFT_CLI_MAIN: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
    const reply = await new Promise<string>((done, fail) => {
      const t = setTimeout(() => fail(new Error(`no initialize reply; stdout: ${out}`)), 20_000);
      child.stdout.on("data", () => {
        if (out.includes("\n")) {
          clearTimeout(t);
          done(out);
        }
      });
    });
    child.kill();
    const lines = reply.trim().split("\n");
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: "weft" } } });
  }, 30_000);

  it("weft mcp outside a set-up checkout says what to run", async () => {
    const other = mkdtempSync(join(tmpdir(), "weft-cli-none-"));
    execFileSync("git", ["init", "-q", other]);
    await expect(main(["mcp", "--dir", other])).rejects.toThrow(/not set up/);
  });

  it("weft mcp fills the server flags from the setup and keeps the ones given (packages/mcp/README.md forms)", () => {
    const m = JSON.parse(readFileSync(join(repo, ".weft/space.json"), "utf8"));
    const a = mcpArgs([], repo);
    expect(a.slice(0, 3)).toEqual(["serve", "--dir", realpathSync(repo)]);
    expect(a).toEqual(expect.arrayContaining(["--url", url, "--repo", m.repo, "--agent", "app", "--task", m.task]));
    const b = mcpArgs(["--dir", repo, "--agent", "zed-a", "--channels"], "/");
    expect(b.filter((x) => x === "--dir")).toHaveLength(1);
    expect(b[b.indexOf("--agent") + 1]).toBe("zed-a");
    expect(b).toContain("--channels");
    expect(b.filter((x) => x === "--agent")).toHaveLength(1);
  });

  it("uninstall removes Antigravity's hooks file", async () => {
    expect(await main(["uninstall", "--dir", repo, "--yes"])).toBe(0);
    expect(existsSync(join(repo, ".agents/hooks.json"))).toBe(false);
    expect(existsSync(join(repo, ".weft"))).toBe(false);
  });
});
