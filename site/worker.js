// weft-site Worker. Static assets serve everything except POST /e, the funnel-event
// endpoint (run_worker_first in wrangler.toml). Events go to Workers Analytics Engine.
// Stored per event: name, page placement, traffic source, command variant. No IP, no user
// agent, no cookies, no identifiers. Query: docs/launch/README.md.
const CANONICAL = "weft.mx";
const EVENTS = new Set(["view", "copy"]);
const clip = (v, n) => String(v ?? "").replace(/[^\w.\-]/g, "").slice(0, n);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // weft.mx is the canonical host; www and the old weft-site.elier.ai 301 there.
    if (url.hostname !== CANONICAL && url.pathname !== "/e") {
      url.hostname = CANONICAL; url.protocol = "https:"; url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname !== "/e") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    let body = {};
    try { body = JSON.parse((await request.text()).slice(0, 1024)); } catch {}
    const event = clip(body.e, 16);
    if (EVENTS.has(event) && env.EVENTS) {
      env.EVENTS.writeDataPoint({
        indexes: [event],
        blobs: [event, clip(body.w, 32), clip(body.s, 64).toLowerCase(), clip(body.c, 16)],
        doubles: [1],
      });
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
};
