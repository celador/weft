// Auto-land end to end: the real Hermes plugin router (real WcpClient, real land.py subprocess)
// against a local WCP gateway backed by the reference coordinator. A throwaway git repo gets an
// edit on a branch, a commit and a `git merge --no-ff` into master, run from a scratch workdir with
// `cd <repo> &&` (how kanban workers did it on lawnstarter-take-home). Expect exactly one accepted
// `land`, signed by the system token, at the merge commit, with the deterministic op_id.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReferenceCoordinator, validate, type EventDraft, type Hello, type Submit } from "../../../protocol/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

type Rec = { seq: number; kind: string; status: string; change?: string; actor?: { type: string; id: string }; payload?: Record<string, unknown> };

/** Minimal gateway: agent token -> sessions, system token -> system events, both may read. */
function startGateway(coord: ReferenceCoordinator, auth: Array<{ token: string; principal: string }>) {
  const seen: Array<{ principal: string; path: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const fail = (status: number, code: string, message: string) => send(status, { type: "error", error: { code, message } });
    try {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const who = auth.find((a) => a.token === token)?.principal;
      if (!who) return fail(401, "unauthorized", "bad token");
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname.replace(/^\/v1/, "");
      seen.push({ principal: who, path: `${req.method} ${path}` });
      const json = body ? (JSON.parse(body) as Record<string, unknown>) : undefined;
      let m: RegExpExecArray | null;
      if (req.method === "GET" && /^\/repos\/[^/]+\/events$/.test(path)) {
        const after = Number(url.searchParams.get("after") ?? 0);
        const kinds = (url.searchParams.get("kind") ?? "").split(",").filter(Boolean);
        const change = url.searchParams.get("change");
        const all = coord.events(0, 100000).events as unknown as Rec[];
        const head = coord.events(0, 1, { tail: true }).head_seq;
        if (url.searchParams.get("tail")) return send(200, { type: "events", events: all.slice(-1), head_seq: head, next_after: head, has_more: false });
        const events = all.filter((e) => e.seq > after && (!kinds.length || kinds.includes(e.kind)) && (!change || e.change === change));
        return send(200, { type: "events", events, head_seq: head, next_after: head, has_more: false });
      }
      if (req.method === "POST" && /^\/repos\/[^/]+\/system\/events$/.test(path)) {
        if (who !== "system") return fail(403, "forbidden", "token lacks scope system");
        return send(200, coord.system(json as unknown as EventDraft, { type: "system", id: who }));
      }
      if (who !== "agent") return fail(403, "forbidden", "token lacks scope agent");
      if (req.method === "POST" && /^\/repos\/[^/]+\/sessions$/.test(path)) return send(201, coord.hello(json as unknown as Hello));
      if ((m = /^\/repos\/[^/]+\/sessions\/([^/]+)(\/\w+)?$/.exec(path))) {
        const [, sid, tail] = m;
        if (req.method === "POST" && tail === "/events") {
          const v = validate("Submit", json);
          if (!v.ok) return send(400, { type: "error", error: { code: "invalid_message", message: "invalid Submit", details: { issues: v.issues } } });
          return send(200, coord.submit(sid!, json as unknown as Submit));
        }
        if (req.method === "POST" && tail === "/inbox") return send(200, coord.drain(sid!, json?.ack as number | undefined));
        if (req.method === "POST" && tail === "/heartbeat") return send(200, coord.heartbeat(sid!));
        if (req.method === "POST" && tail === "/gate") return send(200, coord.gate(sid!, json as never));
        if (req.method === "DELETE" && !tail) {
          coord.bye(sid!, json?.reason as string | undefined);
          return send(204);
        }
      }
      return fail(404, "not_found", `no route ${req.method} ${path}`);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return send(400, { type: "error", error: { code: e.code ?? "error", message: e.message ?? String(err) } });
    }
  });
  return { server, seen };
}

describe("hermes auto-land (local gateway)", () => {
  const coord = new ReferenceCoordinator({ repo: "proj" });
  const { server, seen } = startGateway(coord, [
    { token: "agent-tok", principal: "agent" },
    { token: "sys-tok", principal: "system" },
  ]);
  let url = "";
  const tmp = mkdtempSync(join(tmpdir(), "weft-autoland-e2e-"));

  beforeAll(async () => {
    await new Promise<void>((ok) => (server as Server).listen(0, "127.0.0.1", ok));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a branch merged to master produces exactly one accepted land", async () => {
    const { stdout } = await run("python3", [resolve(here, "../tests/e2e_autoland.py"), url, tmp], { timeout: 120_000 });
    const out = JSON.parse(stdout.trim().split("\n").pop()!) as { change: string; work: string; merge: string; op_id: string; rerun_exit: number; log_tail: string[] };
    const log = coord.events(0, 100000).events as unknown as Rec[];
    const mine = log.filter((e) => e.change === out.change);
    const kinds = mine.map((e) => `${e.kind}:${e.status}`);
    expect(kinds, JSON.stringify(out.log_tail)).toContain("edit:accepted");
    // checkpoints were recorded although every git command ran from a scratch workdir
    const cps = mine.filter((e) => e.kind === "checkpoint");
    expect(cps.map((e) => [e.payload?.sha, e.payload?.x_work])).toContainEqual([out.work, true]);
    const lands = log.filter((e) => e.kind === "land");
    expect(lands, JSON.stringify(out.log_tail)).toHaveLength(1);
    expect(lands[0]).toMatchObject({
      status: "accepted",
      change: out.change,
      actor: { type: "system", id: "system" },
      payload: { sha: out.merge, op_id: out.op_id, trunk_ref: "refs/heads/master" },
    });
    expect(Object.keys(lands[0]!.payload!).sort()).toEqual(["op_id", "sha", "trunk_ref"]);
    // join -> edit -> ... -> land, in log order
    expect(mine.findIndex((e) => e.kind === "edit")).toBeLessThan(mine.findIndex((e) => e.kind === "land"));
    expect(out.rerun_exit).toBe(0);
    // the agent token never posted a system event; the system token never opened a session
    expect(seen.filter((s) => s.principal === "agent" && s.path.includes("/system/"))).toEqual([]);
    expect(seen.filter((s) => s.principal === "system" && s.path.includes("/sessions"))).toEqual([]);
  }, 150_000);
});
