// The hackathon-demo finding (card t_d2411129), end to end: the real Hermes plugin (real WcpClient,
// the bundled Python analysis of a catalog install, enforce mode) in two git worktrees of one repo,
// against a local WCP gateway backed by the reference coordinator. B's stale `calc_total(items)` call
// is rejected; B re-reads pricing.py in its own worktree (still the old signature) and retries the
// identical edit. The diagnostic must carry A's new declaration, and the stale call must not land.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReferenceCoordinator, validate, type Hello, type Submit } from "../../../protocol/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

type Rec = { seq: number; kind: string; status: string; agent?: string; files: string[]; diff?: string; diagnostics: Array<{ code: string }> };
type Seen = { principal: string; route: string; status: number; message?: string; body?: unknown };

/** Minimal gateway: agent tokens (scopes agent + observe, one repo, like space agent tokens). */
function startGateway(coord: ReferenceCoordinator, auth: Record<string, string>) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const who = auth[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/v1/, "");
    const route = `${req.method} ${path.replace(/\/sessions\/[^/]+/, "/sessions/:id")}`;
    const send = (status: number, payload?: unknown, message?: string) => {
      seen.push({ principal: who ?? "?", route, status, ...(message ? { message } : {}), ...(payload !== undefined ? { body: payload } : {}) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const fail = (status: number, code: string, message: string) => send(status, { type: "error", error: { code, message } });
    try {
      if (!who) return fail(401, "unauthorized", "bad token");
      const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      let m: RegExpExecArray | null;
      if (req.method === "GET" && (m = /^\/repos\/shop\/events\/(\d+)$/.exec(path))) return send(200, coord.event(Number(m[1])), "EventRecord");
      if (req.method === "POST" && path === "/repos/shop/sessions") {
        const v = validate("Hello", json);
        if (!v.ok) return fail(400, "invalid_message", JSON.stringify(v.issues));
        return send(201, coord.hello(json as unknown as Hello), "Welcome");
      }
      if ((m = /^\/repos\/shop\/sessions\/([^/]+)(\/\w+)?$/.exec(path))) {
        const [, sid, tail] = m;
        if (req.method === "POST" && tail === "/events") {
          const v = validate("Submit", json);
          if (!v.ok) return fail(400, "invalid_message", JSON.stringify(v.issues));
          return send(200, coord.submit(sid!, json as unknown as Submit), "Verdict");
        }
        if (req.method === "POST" && tail === "/inbox") return send(200, coord.drain(sid!, json?.ack as number | undefined), "InboxBatch");
        if (req.method === "POST" && tail === "/heartbeat") return send(200, coord.heartbeat(sid!), "HeartbeatAck");
        if (req.method === "POST" && tail === "/gate") return send(200, coord.gate(sid!, json as never), "GateResult");
        if (req.method === "DELETE" && !tail) {
          coord.bye(sid!, json?.reason as string | undefined);
          return send(204);
        }
      }
      return fail(404, "not_found", `no route ${req.method} ${path}`);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return fail(400, e.code ?? "error", e.message ?? String(err));
    }
  });
  return { server, seen };
}

describe("hermes: stale_assumption carries the new declaration (separate worktrees)", () => {
  const coord = new ReferenceCoordinator({ repo: "shop" });
  const { server, seen } = startGateway(coord, { "tok-a": "shop", "tok-b": "shop-2" });
  let url = "";
  const tmp = mkdtempSync(join(tmpdir(), "weft-stale-sig-e2e-"));

  beforeAll(async () => {
    await new Promise<void>((ok) => (server as Server).listen(0, "127.0.0.1", ok));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a retry after re-reading a stale worktree is not accepted; the informed edit is", async () => {
    const { stdout } = await run("python3", [resolve(here, "../tests/e2e_stale_signature.py"), url, tmp], { timeout: 120_000 });
    type Block = { action: string; message: string } | null;
    const out = JSON.parse(stdout.trim().split("\n").pop()!) as {
      a_block: Block; block1: Block; block2: Block; block3: Block; pricing_seen_by_b: string;
      cart_after_block1: string; cart_after_block2: string; cart_final: string; b_log: string[];
    };
    const ctx = JSON.stringify(out.b_log);
    expect(out.a_block, ctx).toBeNull();

    // step 2: rejected before the write, and the injected text shows A's new signature
    expect(out.block1?.action, ctx).toBe("block");
    expect(out.block1!.message).toContain("stale_assumption pricing.py#calc_total");
    expect(out.block1!.message).toContain("calc_total(items, opts)");
    expect(out.block1!.message).toContain("NOT in your checkout yet");
    expect(out.block1!.message).not.toContain("Re-read the cited symbols");
    expect(out.cart_after_block1).not.toContain("cart_total");

    // step 3: B's own copy still has the old signature; the identical retry is blocked again
    expect(out.pricing_seen_by_b).toContain("def calc_total(items):");
    expect(out.block2?.action, ctx).toBe("block");
    expect(out.block2!.message).toContain("calc_total(items, opts)");
    expect(out.cart_after_block2).not.toContain("cart_total");

    // step 4: the informed edit is accepted and lands
    expect(out.block3, ctx).toBeNull();
    expect(out.cart_final).toContain("calc_total(items, opts or {})");

    // the log: no accepted edit carries the stale call; B's accepted edit is the fixed one
    const log = coord.events(0, 100000, { include_diff: true }).events as unknown as Rec[];
    const accepted = log.filter((e) => e.kind === "edit" && e.status === "accepted");
    expect(accepted.map((e) => [e.agent, e.files])).toEqual([["shop", ["pricing.py"]], ["shop-2", ["cart.py"]]]);
    expect(accepted.some((e) => e.diff?.includes("round(calc_total(items), 2)"))).toBe(false);
    expect(accepted[1]!.diff).toContain("calc_total(items, opts or {})");
    const rejected = log.filter((e) => e.kind === "edit" && e.status === "rejected");
    expect(rejected.map((e) => e.diagnostics.map((d) => d.code))).toEqual([["stale_assumption"]]);

    // B read A's event (same repo, its own agent token); every gateway response is valid WCP
    expect(seen.filter((s) => s.principal === "shop-2" && s.route.startsWith("GET /repos/shop/events/")).map((s) => s.status)).toEqual([200]);
    for (const s of seen) {
      expect(s.status, `${s.route}: ${JSON.stringify(s.body)}`).toBeLessThan(400);
      if (s.message) expect(validate(s.message, s.body).ok, `${s.message} from ${s.route}`).toBe(true);
    }
  }, 150_000);
});
