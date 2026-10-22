#!/usr/bin/env node
// Local demo server for @weft/feed/view. Serves demo/ and proxies /v1 (HTTP and WebSocket) to a
// Weft gateway so the page is same-origin (the gateway sends no CORS headers). Binds 127.0.0.1.
//
//   WEFT_URL=http://localhost:8787 WEFT_TOKEN_FILE=path/to/human-token node demo/server.mjs [--port 8790]
//
// The token (observe + human scope) is handed to the page via /config.json: local use only.
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const port = Number(arg("port", process.env.PORT ?? 8790));
const upstream = new URL(process.env.WEFT_URL ?? "http://localhost:8787");
const token = (process.env.WEFT_TOKEN ?? (process.env.WEFT_TOKEN_FILE ? readFileSync(process.env.WEFT_TOKEN_FILE, "utf8") : "")).trim();
if (!token) {
  console.error("set WEFT_TOKEN or WEFT_TOKEN_FILE (a token with observe + human scope)");
  process.exit(2);
}
const repos = process.env.WEFT_REPOS ? process.env.WEFT_REPOS.split(",") : undefined;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".json": "application/json" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/v1/")) {
    const p = request(
      { hostname: upstream.hostname, port: upstream.port, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: upstream.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    p.on("error", (e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unavailable", message: `gateway: ${e.message}` } }));
    });
    req.pipe(p);
    return;
  }
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ token, ...(repos ? { repos } : {}), title: process.env.WEFT_TITLE ?? "Weft" }));
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = normalize(join(here, rel));
  if (!file.startsWith(here) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": CSP, "cache-control": "no-store" });
  res.end(readFileSync(file));
});

// WebSocket upgrades: replay the request to the gateway and pipe both ways.
server.on("upgrade", (req, sock, head) => {
  const up = connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      lines.push(`${k}: ${k.toLowerCase() === "host" ? upstream.host : req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  const end = () => {
    up.destroy();
    sock.destroy();
  };
  up.on("error", end);
  sock.on("error", end);
});

server.listen(port, "127.0.0.1", () => console.log(`@weft/feed demo: http://127.0.0.1:${port}/  (gateway ${upstream.origin})`));
