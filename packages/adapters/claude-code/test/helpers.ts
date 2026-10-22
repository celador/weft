// Test helpers: a coordinator (the protocol's ReferenceCoordinator) reachable in-process
// and over a tiny local HTTP binding of spec §8.2/§9.3, plus throwaway git checkouts.
import { ReferenceCoordinator, WcpProtocolError, type Hello, type Submit } from "@weft/protocol";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WcpError, type Transport } from "../src/client";

function wrap<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    if (err instanceof WcpProtocolError) return Promise.reject(new WcpError(err.code, err.message, err.status, err.details ?? {}));
    return Promise.reject(err);
  }
}

export function refTransport(c: ReferenceCoordinator, observe = true): Transport {
  return {
    hello: (h) => wrap(() => c.hello(h)),
    submit: (s, m) => wrap(() => c.submit(s, m)),
    drain: (s, ack) => wrap(() => c.drain(s, ack)),
    heartbeat: (s) => wrap(() => c.heartbeat(s)),
    gate: (s, g) => wrap(() => c.gate(s, { type: "gate", gate: g })),
    bye: (s, r) => wrap(() => c.bye(s, r)),
    event: (seq) => (observe ? wrap(() => c.event(seq)) : Promise.reject(new WcpError("forbidden", "no observe scope", 403))),
  };
}

/** Local HTTP binding over a ReferenceCoordinator (no auth; enough for adapter e2e tests). */
export async function serve(c: ReferenceCoordinator): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    try {
      const path = (req.url ?? "").replace(/^\/v1/, "");
      let m: RegExpExecArray | null;
      if (req.method === "POST" && /^\/repos\/[^/]+\/sessions$/.test(path)) return send(201, c.hello(json as Hello));
      if ((m = /^\/repos\/[^/]+\/sessions\/([^/]+)(\/\w+)?$/.exec(path))) {
        const [, sid, tail] = m;
        if (req.method === "POST" && tail === "/events") return send(200, c.submit(sid, json as Submit));
        if (req.method === "POST" && tail === "/inbox") return send(200, c.drain(sid, json?.ack));
        if (req.method === "POST" && tail === "/heartbeat") return send(200, c.heartbeat(sid));
        if (req.method === "POST" && tail === "/gate") return send(200, c.gate(sid, json));
        if (req.method === "DELETE" && !tail) {
          c.bye(sid, json?.reason);
          return send(204);
        }
      }
      if (req.method === "GET" && (m = /^\/repos\/[^/]+\/events\/(\d+)$/.exec(path))) return send(200, c.event(Number(m[1])));
      if (req.method === "GET" && /^\/repos\/[^/]+\/events(\?|$)/.test(path)) {
        const q = new URL(path, "http://x").searchParams;
        return send(200, c.events(Number(q.get("after") ?? 0), Number(q.get("limit") ?? 100), { tail: q.get("tail") === "1" }));
      }
      return send(404, { type: "error", error: { code: "not_found", message: `no route ${req.method} ${path}` } });
    } catch (err) {
      if (err instanceof WcpProtocolError) return send(err.status, err.toJSON());
      return send(500, { type: "error", error: { code: "internal", message: String(err) } });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

export const PRICING_V1 = `export type Item = { price: number; qty: number };

export function calcTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`;

export const PRICING_V2 = `export type Item = { price: number; qty: number };
export type PriceOptions = { taxRate: number };

export function calcTotal(items: Item[], opts: PriceOptions): number {
  const net = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return net * (1 + opts.taxRate);
}
`;

export const CART_V1 = `import { calcTotal, type Item } from "./pricing";

export function cartSummary(items: Item[]): string {
  return \`\${items.length} items\`;
}
`;

/** A git checkout with the demo files committed. */
export function checkout(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `weft-claude-${name}-`));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/pricing.ts"), PRICING_V1);
  writeFileSync(join(dir, "src/cart.ts"), CART_V1);
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@weft.invalid");
  g("config", "user.name", "weft test");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}
