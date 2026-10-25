import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { analyzeChanges, unifiedDiff } from "../../adapters/claude-code/src/analysis";
import { CART_LINE, NEW_CALL, OLD_CALL, PRICING_V2, checkout, coordinator } from "../../adapters/claude-code/test/translator-kit";
import { serve } from "../src/cli";
import { CONFIG_REL, resolveConfig, userToken } from "../src/config";
import { makeHost } from "../src/cli";
import { applyPatch } from "../src/patch";
import { CAPABILITIES, INSTRUCTIONS, TOOLS, editingNow, feedRow } from "../src/server";

const PRICING_V3 = PRICING_V2.replace("opts: PriceOptions)", "opts: PriceOptions, currency: string)");
const V3_CALL = "return `total ${calcTotal(items, { taxRate: 0 }, \"USD\")}`;";
const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-mcp.mjs");
const until = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return f();
};
type Text = { content: Array<{ type: string; text: string }>; isError?: boolean };
const text = (r: unknown) => (r as Text).content.map((c) => c.text).join("\n");

describe("declared surface", () => {
  it("declares L0 honestly with delayed injection (Hooks Core §3.3)", () => {
    expect(CAPABILITIES).toEqual({ level: 0, observe: "async", inject: "delayed", deny_edit: false, refuse_stop: false, commit_gate: "native" });
  });
  it("exposes exactly the tools named in harness-coverage §2b", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["weft_check", "weft_claim", "weft_status", "weft_inbox", "weft_feed", "weft_negotiate", "weft_gate"]);
  });
  it("keeps the server instructions short and names weft_check + weft_gate", () => {
    expect(Buffer.byteLength(INSTRUCTIONS)).toBeLessThan(2000);
    expect(INSTRUCTIONS).toContain("weft_check");
    expect(INSTRUCTIONS).toContain("weft_gate");
  });
});

describe("applyPatch", () => {
  const before = "a\nb\nc\nd\n";
  it("applies a unified diff", () => {
    expect(applyPatch(before, "--- a/x\n+++ b/x\n@@ -2,2 +2,2 @@\n b\n-c\n+C\n")).toEqual({ ok: true, text: "a\nb\nC\nd\n" });
  });
  it("tolerates a shifted hunk start", () => {
    expect(applyPatch(before, "@@ -1,2 +1,3 @@\n c\n+c2\n d\n")).toEqual({ ok: true, text: "a\nb\nc\nc2\nd\n" });
  });
  it("creates a file from /dev/null", () => {
    expect(applyPatch(null, "--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n")).toEqual({ ok: true, text: "x\ny\n" });
  });
  it("keeps 'no newline at end of file'", () => {
    expect(applyPatch("a\nb", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n")).toEqual({ ok: true, text: "a\nB" });
  });
  it("refuses a hunk that does not match instead of guessing", () => {
    const r = applyPatch(before, "@@ -2,1 +2,1 @@\n-zzz\n+y\n");
    expect(r.ok).toBe(false);
  });
  it("refuses text that is not a diff", () => {
    expect(applyPatch(before, "hello").ok).toBe(false);
  });
});

describe("config", () => {
  it("token lookup: ~/.config/weft/<repo>.token before ~/.config/weft/token", () => {
    const home = mkdtempSync(join(tmpdir(), "weft-mcp-home-"));
    expect(userToken("demo", home)).toBeUndefined();
    mkdirSync(join(home, ".config", "weft"), { recursive: true });
    writeFileSync(join(home, ".config/weft/token"), "default-tok\n");
    expect(userToken("demo", home)).toBe("default-tok");
    writeFileSync(join(home, ".config/weft/demo.token"), "repo-tok\n");
    expect(userToken("demo", home)).toBe("repo-tok");
  });

  it("configures an unconfigured checkout from env alone, then reads the token from ~/.config/weft", () => {
    const root = checkout("mcp-cfg");
    const home = mkdtempSync(join(tmpdir(), "weft-mcp-home-"));
    const h = makeHost("zed");
    const env = { WEFT_URL: "http://127.0.0.1:9", WEFT_REPO: "demo", WEFT_AGENT: "zed-a", WEFT_TASK: "T-9" };
    const missing = resolveConfig(h, root, [], env, home);
    expect("error" in missing && missing.error).toMatch(/no Weft token/);
    expect(JSON.parse(readFileSync(join(root, CONFIG_REL), "utf8"))).toMatchObject({ repo: "demo", agent: "zed-a", task: { id: "T-9" } });
    expect(existsSync(join(root, ".weft/bin/weft"))).toBe(true); // same layout as every adapter
    mkdirSync(join(home, ".config/weft"), { recursive: true });
    writeFileSync(join(home, ".config/weft/demo.token"), "tok-from-home\n");
    const ok = resolveConfig(h, root, [], env, home);
    expect("loaded" in ok && ok.loaded.token).toBe("tok-from-home");
    // WEFT_TOKEN wins over everything
    const env2 = { ...env, WEFT_TOKEN: "tok-env" };
    const ok2 = resolveConfig(h, root, [], env2, home);
    expect("loaded" in ok2 && ok2.loaded.token).toBe("tok-env");
    // the change id is stable across restarts with the same task
    const change = JSON.parse(readFileSync(join(root, CONFIG_REL), "utf8")).change;
    resolveConfig(h, root, ["--title", "new title"], env2, home);
    expect(JSON.parse(readFileSync(join(root, CONFIG_REL), "utf8")).change).toBe(change);
  });

  it("says what is missing when nothing is configured", () => {
    const root = checkout("mcp-cfg2");
    const r = resolveConfig(makeHost(), root, [], {});
    expect("error" in r && r.error).toMatch(/--url, --repo, --agent/);
  });
});

describe("feed + presence rendering", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const rec = (seq: number, agent: string, kind: string, extra: Record<string, unknown> = {}) =>
    ({ seq, repo: "demo", status: "accepted", kind, ts: "2026-10-22T11:59:0" + (seq % 10) + "Z", actor: { type: "agent", id: agent }, agent, files: [], reads: [], writes: [], summary: `${kind} ${seq}`, diagnostics: [], ...extra }) as never;
  it("renders feed rows like the feed UIs", () => {
    expect(feedRow(rec(4, "claude-a", "edit", { files: ["src/pricing.ts"], mode: "commit" }))).toBe("#4 11:59:04 claude-a edit: edit 4 [src/pricing.ts]");
  });
  it("lists who else is editing and claiming what", () => {
    const out = editingNow(
      [
        rec(1, "claude-a", "edit", { files: ["src/pricing.ts"], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }], mode: "commit" }),
        rec(2, "claude-b", "claim", { writes: [{ key: "src/cart.ts#*", kind: "body" }] }),
        rec(3, "zed-a", "edit", { files: ["src/x.ts"], mode: "commit" }),
        rec(5, "codex-c", "edit", { files: ["src/y.ts"], mode: "check" }),
      ],
      "zed-a",
      now,
    );
    expect(out).toContain("claude-a (last 11:59:01): editing src/pricing.ts — src/pricing.ts#calcTotal");
    expect(out).toContain("claude-b (last 11:59:02): claims src/cart.ts#*");
    expect(out).not.toContain("zed-a");
    expect(out).not.toContain("codex-c"); // a check is not an edit
  });
});

describe("MCP server against a coordinator (in-process MCP transport, real HTTP coordinator)", () => {
  const closers: Array<() => unknown> = [];
  afterAll(async () => {
    for (const c of closers.reverse()) await c();
  });

  it("checks, appends the inbox to every result, reports unannounced edits, gates, claims, negotiates", async () => {
    const { coord, url, server: http, changeSignature } = await coordinator();
    closers.push(() => http.close());
    const root = checkout("mcp-e2e");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];
    const s = await serve({
      args: ["--dir", root, "--url", url, "--repo", "demo", "--agent", "zed-a", "--task", "T-2", "--title", "cart total", "--debounce", "100", "--tick", "600000"],
      env: { WEFT_TOKEN: "local-test-token" },
      transport: serverT,
      log: (l) => logs.push(l),
    });
    closers.push(() => s.close());
    const client = new Client({ name: "zed", version: "0.209.0" });
    await client.connect(clientT);
    closers.push(() => client.close());
    expect(client.getInstructions()).toContain("weft_check");
    const weft = await s.ready;
    expect(weft).toBeDefined();

    // hello: L0 with delayed injection, the MCP client's name as the harness
    const join_ = coord.log.find((r) => r.kind === "join" && r.agent === "zed-a")!;
    expect(join_.payload).toMatchObject({ harness: "mcp:zed", level: 0 });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("weft_check");

    // another agent changes calcTotal; the model checks a stale call before writing it
    const sigSeq = changeSignature();
    const cart = join(root, "src/cart.ts");
    const stale = readFileSync(cart, "utf8").replace(CART_LINE, OLD_CALL);
    const r1 = text(await client.callTool({ name: "weft_check", arguments: { path: "src/cart.ts", new_content: stale } }));
    expect(r1).toContain("check src/cart.ts: REJECT");
    expect(r1).toMatch(/\[weft error\] stale_assumption src\/cart\.ts:4:\d+/);
    expect(r1).toContain(`event #${sigSeq} by claude-a changed src/pricing.ts`); // their diff, quoted
    expect(r1).toContain("negotiate: `weft_negotiate propose overload"); // option hints name the MCP tool, not a shell path
    expect(r1).not.toContain(".weft/bin/weft");
    expect(readFileSync(cart, "utf8")).not.toContain(OLD_CALL); // a check writes nothing
    const checkRec = coord.log.filter((r) => r.agent === "zed-a" && r.kind === "edit").pop()!;
    expect(checkRec.mode).toBe("check");

    // the fixed call passes, as a patch
    const fixed = readFileSync(cart, "utf8").replace(CART_LINE, NEW_CALL);
    const patch = unifiedDiff("src/cart.ts", readFileSync(cart, "utf8"), fixed);
    const r2 = text(await client.callTool({ name: "weft_check", arguments: { path: "src/cart.ts", patch } }));
    expect(r2).toContain("check src/cart.ts: accept");

    // every result carries the pending inbox: claude-a proposes something to zed-a
    const a = coord.hello({ type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: "T-1" } });
    const prop = coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "negotiate.propose", base_seq: a.delivered_through, payload: { to: { agent: "zed-a" }, keys: ["src/cart.ts#cartSummary"], terms: { kind: "share", text: "let me touch cartSummary too" } } } });
    const r3 = text(await client.callTool({ name: "weft_feed", arguments: { limit: 5 } }));
    expect(r3).toContain("[weft] feed demo");
    expect(r3).toContain("[weft inbox]");
    expect(r3).toContain(`[weft negotiation] #${prop.seq} claude-a`);
    // delivered once: the next result does not repeat it
    expect(text(await client.callTool({ name: "weft_feed", arguments: { limit: 1 } }))).not.toContain(`[weft negotiation] #${prop.seq}`);

    // claude-a changes calcTotal again; the model ignores weft_check and writes a call against
    // the old signature with its own edit tool: the embedded watcher reports it (L0), and the
    // squiggle arrives with the next tool result
    const sig2 = coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: coord.events(0, 1, { tail: true }).head_seq, files: ["src/pricing.ts"], ...analyzeChanges([{ rel: "src/pricing.ts", before: PRICING_V2, after: PRICING_V3 }]), diff: unifiedDiff("src/pricing.ts", PRICING_V2, PRICING_V3) } }).seq!;
    writeFileSync(cart, fixed);
    expect(await until(() => coord.log.some((r) => r.agent === "zed-a" && r.kind === "edit" && r.mode === "commit"))).toBe(true);
    const unannounced = coord.log.filter((r) => r.agent === "zed-a" && r.kind === "edit" && r.mode === "commit").pop()!;
    expect(unannounced.status).toBe("rejected");
    expect(unannounced.files).toEqual(["src/cart.ts"]);
    expect(unannounced.diagnostics[0]).toMatchObject({ code: "stale_assumption", caused_by_seq: sig2 });

    // weft_gate stop is refused while the error is open and the proposal is unanswered
    const g = text(await client.callTool({ name: "weft_gate", arguments: { gate: "stop" } }));
    expect(g).toContain("gate stop: NOT allowed");
    expect(g).toContain("your edit to src/cart.ts was reported"); // the watcher's verdict, carried
    expect(g).toMatch(/stale_assumption src\/cart\.ts:4/);

    // weft_status: open errors, owed negotiation, who is editing what
    const st = text(await client.callTool({ name: "weft_status", arguments: {} }));
    expect(st).toContain("Open errors (1)");
    expect(st).toContain(`#${prop.seq}`);
    expect(st).toMatch(/claude-a \(last [\d:]+\): editing src\/pricing\.ts/);

    // answer the proposal, fix the code on disk, and the gate opens
    const n = text(await client.callTool({ name: "weft_negotiate", arguments: { action: "accept", seq: prop.seq } }));
    expect(n).toContain("[weft] sent #");
    expect(coord.log.some((r) => r.kind === "negotiate.accept" && r.agent === "zed-a")).toBe(true);
    writeFileSync(cart, readFileSync(cart, "utf8").replace(NEW_CALL, V3_CALL));
    expect(await until(() => coord.log.filter((r) => r.agent === "zed-a" && r.kind === "edit" && r.mode === "commit").pop()!.status === "accepted")).toBe(true);
    const g2 = text(await client.callTool({ name: "weft_gate", arguments: { gate: "commit" } }));
    expect(g2).toContain("gate commit: allowed");

    // claims: valid keys go to the log, invalid keys are refused before they reach it
    const c = text(await client.callTool({ name: "weft_claim", arguments: { keys: ["src/cart.ts#cartSummary"] } }));
    expect(c).toContain("[weft] sent #");
    expect(coord.log.some((r) => r.kind === "claim" && r.agent === "zed-a")).toBe(true);
    const bad = (await client.callTool({ name: "weft_claim", arguments: { keys: ["/etc/passwd#x"] } })) as Text;
    expect(bad.isError).toBe(true);

    // inbox tool + argument errors never throw
    expect(text(await client.callTool({ name: "weft_inbox", arguments: {} }))).toMatch(/inbox empty|weft/);
    const noArgs = (await client.callTool({ name: "weft_check", arguments: {} })) as Text;
    expect(noArgs.isError).toBe(true);
    expect(logs.join("\n")).toContain("[weft-mcp] serving");
  }, 60_000);

  it("weft_negotiate propose with wait returns at once when the other agent has left (counterpart_away)", async () => {
    const { coord, url, server: http, changeSignature } = await coordinator();
    closers.push(() => http.close());
    changeSignature();
    coord.bye(coord.log.find((r) => r.kind === "join" && r.agent === "claude-a")!.session!);
    const left = coord.log.filter((r) => r.kind === "leave").at(-1)!;
    const root = checkout("mcp-away");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const s = await serve({
      args: ["--dir", root, "--url", url, "--repo", "demo", "--agent", "zed-a", "--task", "T-2", "--title", "cart total", "--debounce", "100", "--tick", "600000"],
      env: { WEFT_TOKEN: "local-test-token" },
      transport: serverT,
      log: () => undefined,
    });
    closers.push(() => s.close());
    const client = new Client({ name: "zed", version: "0.209.0" });
    await client.connect(clientT);
    closers.push(() => client.close());
    await s.ready;
    const t0 = Date.now();
    const r = text(
      await client.callTool({ name: "weft_negotiate", arguments: { action: "propose", kind: "overload", terms: "keep calcTotal(items)", to: "claude-a", keys: ["src/pricing.ts#calcTotal"], wait: 120 } }),
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toContain("[weft] sent #");
    expect(r).toContain(`claude-a is not in a session (left at #${left.seq}); nobody will answer until it starts again: retreat, wait, or escalate`);
    expect(r).toContain("[weft] not waiting 120s for a reply");
    expect(r).toContain('`weft_negotiate escalate "<why>"`');
    expect(r).not.toContain(".weft/bin/weft");
    expect(coord.log.some((x) => x.kind === "negotiate.propose" && x.agent === "zed-a" && x.status === "accepted")).toBe(true);
  }, 60_000);

  it("the bundled stdio server starts, lists the tools and answers weft_status", async () => {
    const { url, server: http } = await coordinator();
    closers.push(() => http.close());
    const root = checkout("mcp-stdio");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, "--url", url, "--repo", "demo", "--agent", "warp-a", "--task", "T-3"],
      cwd: root,
      env: { ...(process.env as Record<string, string>), WEFT_TOKEN: "local-test-token" },
      stderr: "pipe",
    });
    const client = new Client({ name: "warp", version: "1" });
    await client.connect(transport);
    closers.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(7);
    const st = text(await client.callTool({ name: "weft_status", arguments: {} }));
    expect(st).toContain("[weft] status for warp-a");
    expect(st).toContain("Open errors: none.");
    expect(JSON.parse(readFileSync(join(root, CONFIG_REL), "utf8"))).toMatchObject({ agent: "warp-a" });
  }, 30_000);

  it("refuses tool calls with a clear reason when the checkout is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-mcp-nogit-"));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const s = await serve({ args: [], env: {}, cwd: dir, transport: serverT, watch: false, log: () => {} });
    closers.push(() => s.close());
    const client = new Client({ name: "zed", version: "1" });
    await client.connect(clientT);
    expect(await s.ready).toBeUndefined();
    const r = (await client.callTool({ name: "weft_status", arguments: {} })) as Text;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no checkout");
  });
});

