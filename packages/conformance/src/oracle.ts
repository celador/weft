// The oracle: a WCP reference coordinator behind a local HTTP binding (spec wcp-v0 §8.2),
// plus the throwaway git workspace each fixture starts from. The hook under test talks to
// the oracle exactly as it would talk to a production coordinator; the oracle's log is
// the ground truth the runner checks observations against, and its deterministic rules
// (wcp-v0 §6) make the expected allow/advise/deny decisions known in advance.
import { ReferenceCoordinator, WcpProtocolError, type Capabilities, type Hello, type Submit } from "@weft/protocol";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type PeerChange = {
  agent: string;
  harness: string;
  task: string;
  files: string[];
  writes: Array<{ key: string; kind: "signature" | "body" | "new" | "deleted" }>;
  reads: string[];
  intent?: string;
  after: Record<string, string>;
};

/**
 * `language`: the language a fixture set under fixtures/languages tests; `interop`: other
 * languages its peers may edit (a Kotlin set whose peer changes a Java file).
 */
export type Workspace = { description?: string; language?: string; interop?: string[]; files: Record<string, string>; peers: Record<string, PeerChange> };

export const REPO = "conformance";

export class Oracle {
  readonly coord = new ReferenceCoordinator({ repo: REPO });
  readonly hellos: Hello[] = [];
  private server?: Server;
  url = "";

  async start(): Promise<void> {
    const c = this.coord;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const send = (status: number, payload?: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "wcp-version": "0.1" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      try {
        const json = body ? (JSON.parse(body) as Record<string, unknown>) : undefined;
        const path = (req.url ?? "").split("?")[0]!.replace(/^\/v1/, "");
        let m: RegExpExecArray | null;
        if (req.method === "POST" && /^\/repos\/[^/]+\/sessions$/.test(path)) {
          this.hellos.push(json as Hello);
          return send(201, c.hello(json as Hello));
        }
        if ((m = /^\/repos\/[^/]+\/sessions\/([^/]+)(\/\w+)?$/.exec(path))) {
          const [, sid, tail] = m;
          if (req.method === "POST" && tail === "/events") return send(200, c.submit(sid!, json as Submit));
          if (req.method === "POST" && tail === "/inbox") return send(200, c.drain(sid!, json?.ack as number | undefined));
          if (req.method === "POST" && tail === "/heartbeat") return send(200, c.heartbeat(sid!));
          if (req.method === "POST" && tail === "/gate") return send(200, c.gate(sid!, json as never));
          if (req.method === "DELETE" && !tail) {
            c.bye(sid!, json?.reason as string | undefined);
            return send(204);
          }
        }
        if (req.method === "GET" && (m = /^\/repos\/[^/]+\/events\/(\d+)$/.exec(path))) return send(200, c.event(Number(m[1])));
        return send(404, { type: "error", error: { code: "not_found", message: `no route ${req.method} ${path}`, retryable: false } });
      } catch (err) {
        if (err instanceof WcpProtocolError) return send(err.status, err.toJSON());
        return send(500, { type: "error", error: { code: "internal", message: String(err), retryable: true } });
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    this.server = server;
  }

  /** Simulate an unreachable backend: stop listening and drop every open connection. */
  async down(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  async stop(): Promise<void> {
    await this.down();
  }

  /** Apply a peer agent's change directly on the coordinator. Returns the edit's seq. */
  peer(p: PeerChange): number {
    const w = this.coord.hello({
      type: "hello",
      protocol: "wcp/0.1",
      agent: { id: p.agent, harness: p.harness, adapter: "wcp-hook-conformance/oracle" },
      capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" },
      task: { id: p.task },
    });
    const v = this.coord.submit(w.session, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: w.delivered_through, files: p.files, reads: p.reads, writes: p.writes, ...(p.intent ? { intent: p.intent } : {}) },
    });
    // The peer's change lives in the peer's own checkout, not in the agent's workspace.
    if (v.verdict !== "accept" || v.seq === null) throw new Error(`oracle: peer change rejected: ${JSON.stringify(v.diagnostics)}`);
    return v.seq;
  }

  /** Capabilities the hook declared (the first non-oracle hello). */
  declared(peerAgents: string[]): { agent?: string; harness?: string; adapter?: string; capabilities?: Capabilities } {
    const h = this.hellos.find((x) => !peerAgents.includes(x.agent?.id));
    return h ? { agent: h.agent.id, harness: h.agent.harness, adapter: h.agent.adapter, capabilities: h.capabilities } : {};
  }
}

/** A fresh git checkout holding the fixture files. */
export function makeWorkspace(ws: Workspace): string {
  const dir = mkdtempSync(join(tmpdir(), "wcp-hook-conf-"));
  for (const [rel, text] of Object.entries(ws.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "conformance@weft.invalid");
  g("config", "user.name", "wcp-hook-conformance");
  g("add", "-A");
  g("commit", "-qm", "fixture workspace");
  return dir;
}
