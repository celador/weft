// A small WCP gateway double for the smoke test: serves a recorded log (the @weft/feed live
// run) over GET /v1/repos, /events, /events/{seq}, /v1/feed, the per-repo WebSocket stream
// (first-frame auth, replay, live) and POST /actions (observe token → 403, human token → 200).
// Test hooks: POST /__test/append {seq} releases a held record live; GET /__test/actions.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

// `extraRepos`: more repos the token sees (idle, no records), like a token with repos "*".
export function startStub({ repo, events, holdFrom, observeToken, humanToken, extraRepos = [] }) {
  const streamed = [];
  const held = events.filter((e) => e.seq >= holdFrom);
  const log = events.filter((e) => e.seq < holdFrom);
  const actions = [];
  const sockets = new Set();
  const brief = (e) => {
    const { diff, ...rest } = e;
    return { ...rest, has_diff: diff !== undefined };
  };
  const head = () => Math.max(0, ...log.map((e) => e.seq));
  const authOk = (req, scopes) => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (t === humanToken) return "human";
    if (t === observeToken) return scopes.includes("observe") ? "observe" : undefined;
    return undefined;
  };
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const append = (e) => {
    log.push(e);
    for (const s of sockets) if (s.authed && s.repo === repo && e.seq > s.after) sendFrame(s.sock, { type: "event", event: e });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const p = url.pathname;
    let body = "";
    for await (const c of req) body += c;
    if (p === "/__test/append") {
      const { seq } = JSON.parse(body || "{}");
      const e = held.find((x) => x.seq === seq);
      if (e) append(e);
      return json(res, e ? 200 : 404, { ok: !!e });
    }
    if (p === "/__test/actions") return json(res, 200, { actions });
    if (p === "/__test/streams") return json(res, 200, { streamed });
    const who = authOk(req, ["observe"]);
    if (!who) return json(res, 401, { error: { code: "unauthorized", message: "bad token" } });
    if (p === "/v1/repos") return json(res, 200, { repos: [{ repo, head_seq: head(), agents: 2, active_changes: 2, open_conflicts: 1, last_event_at: log.at(-1)?.ts }, ...extraRepos.map((r) => ({ repo: r, head_seq: 0, active_agents: 0, active_changes: 0, open_conflicts: 0 }))] });
    const extra = p.match(/^\/v1\/repos\/([^/]+)\/events$/);
    if (extra && extraRepos.includes(decodeURIComponent(extra[1]))) return json(res, 200, { repo: decodeURIComponent(extra[1]), events: [], head_seq: 0, next_after: 0, has_more: false });
    const m = p.match(/^\/v1\/repos\/([^/]+)\/(events|actions)(?:\/(\d+))?$/);
    if (m && decodeURIComponent(m[1]) === repo) {
      if (m[2] === "events" && m[3]) {
        const e = log.find((x) => x.seq === Number(m[3]));
        return e ? json(res, 200, e) : json(res, 404, { error: { code: "not_found", message: "no such event" } });
      }
      if (m[2] === "events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const list = log.filter((e) => e.seq > after).slice(-limit).map(brief);
        return json(res, 200, { repo, events: list, head_seq: head(), next_after: head(), has_more: false });
      }
      if (m[2] === "actions" && req.method === "POST") {
        const a = JSON.parse(body);
        actions.push({ who, action: a });
        if (who !== "human") return json(res, 403, { error: { code: "forbidden", message: "token lacks the human scope" } });
        const seq = head() + 1;
        const record = {
          v: "0.1",
          repo,
          seq,
          ts: new Date().toISOString(),
          kind: a.action === "message" ? "message" : "control",
          status: "accepted",
          actor: { type: "human", id: "john" },
          summary: a.action === "message" ? `john messaged ${a.to?.agent}` : `john ${a.action}d ${a.agent ?? a.change ?? `#${a.seq}`}`,
          payload: a.action === "message" ? { to: a.to, text: a.text, intent: a.intent } : { action: a.action, target: { ...(a.agent ? { agent: a.agent } : {}), ...(a.change ? { change: a.change } : {}) }, ...(a.reason ? { reason: a.reason } : {}) },
          files: [],
          reads: [],
          writes: [],
          diagnostics: [],
        };
        append(record);
        return json(res, 200, { record });
      }
    }
    if (p === "/v1/feed") return json(res, 200, { events: log.slice(-200).map(brief), cursor: "c", has_more: false });
    json(res, 404, { error: { code: "not_found", message: p } });
  });

  // Minimal RFC 6455: text frames only, which is all WCP streams use.
  server.on("upgrade", (req, sock) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const m = url.pathname.match(/^\/v1\/repos\/([^/]+)\/stream$/);
    const key = req.headers["sec-websocket-key"];
    if (!m || !key) return sock.destroy();
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const s = { sock, repo: decodeURIComponent(m[1]), after: Number(url.searchParams.get("after") ?? 0), authed: false };
    streamed.push(s.repo);
    sockets.add(s);
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.size);
        if (f.op === 8) return sock.end();
        if (f.op !== 1) continue;
        let msg;
        try {
          msg = JSON.parse(f.text);
        } catch {
          continue;
        }
        if (msg.type === "auth" && !s.authed) {
          if (msg.token !== observeToken && msg.token !== humanToken) {
            sendClose(sock, 4401, "bad token");
            return;
          }
          s.authed = true;
          sendFrame(sock, { type: "auth.ok" });
          for (const e of log.filter((x) => x.seq > s.after)) sendFrame(sock, { type: "event", event: e });
          sendFrame(sock, { type: "replay.done", head_seq: head() });
        }
      }
    });
    sock.on("close", () => sockets.delete(s));
    sock.on("error", () => sockets.delete(s));
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, actions, close: () => new Promise((r) => { for (const s of sockets) s.sock.destroy(); server.close(r); }) });
    }),
  );
}

function sendFrame(sock, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255])]);
  sock.write(Buffer.concat([head, data]));
}

function sendClose(sock, code, reason) {
  const r = Buffer.from(reason);
  sock.end(Buffer.concat([Buffer.from([0x88, 2 + r.length, code >> 8, code & 255]), r]));
}

function readFrame(buf) {
  if (buf.length < 2) return undefined;
  const op = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let len = buf[1] & 127;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const mask = masked ? buf.subarray(off, off + 4) : undefined;
  if (masked) off += 4;
  if (buf.length < off + len) return undefined;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { op, text: payload.toString("utf8"), size: off + len };
}
