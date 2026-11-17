// weft-site Worker. Static assets serve everything except POST /e, the funnel-event
// endpoint (run_worker_first in wrangler.toml). Events go to Workers Analytics Engine.
// Stored per event: name, page placement, traffic source, command variant, utm campaign.
// No IP, no user agent, no cookies, no identifiers. Query: site/funnel.mjs, docs/launch/README.md.
//
// The same code runs as `weft-site-preview` (wrangler.toml [env.preview]): there CANONICAL_HOST is
// the preview host, PREVIEW = "1" adds a banner and noindex, and events go to a separate dataset.
export const EVENTS = new Set(["view", "copy", "pricing_view", "buy_click", "welcome_view", "claim_ok"]);
const clip = (v, n) => String(v ?? "").replace(/[^\w.\-]/g, "").slice(0, n);

/** The Analytics Engine data point for one POST /e body, or null for an unknown event. */
export function eventPoint(body) {
  const event = clip(body?.e, 16);
  if (!EVENTS.has(event)) return null;
  return {
    indexes: [event],
    // blob1 event, blob2 placement, blob3 source, blob4 command variant, blob5 utm_campaign
    blobs: [event, clip(body.w, 32), clip(body.s, 64).toLowerCase(), clip(body.c, 16), clip(body.k, 64).toLowerCase()],
    doubles: [1],
  };
}

const BANNER = '<div class="preview-banner">Preview of weft.mx. Not live: prices are a proposal and checkout is not open.</div>';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const canonical = env.CANONICAL_HOST || "weft.mx";
    // weft.mx is the canonical host; www and the old weft-site.elier.ai 301 there.
    if (url.hostname !== canonical && url.pathname !== "/e") {
      url.hostname = canonical; url.protocol = "https:"; url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/e") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      let body = {};
      try { body = JSON.parse((await request.text()).slice(0, 1024)); } catch {}
      const point = eventPoint(body);
      if (point && env.EVENTS) env.EVENTS.writeDataPoint(point);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    let res = await env.ASSETS.fetch(request);
    const welcome = url.pathname.startsWith("/welcome");
    if (!welcome && env.PREVIEW !== "1") return res;
    res = new Response(res.body, res);
    // The welcome address carries a Checkout session id until the page strips it.
    if (welcome) {
      res.headers.set("cache-control", "no-store");
      res.headers.set("referrer-policy", "no-referrer");
    }
    if (welcome || env.PREVIEW === "1") res.headers.set("x-robots-tag", "noindex, nofollow");
    if (env.PREVIEW === "1" && (res.headers.get("content-type") || "").includes("text/html")) {
      res = new HTMLRewriter().on("body", { element(el) { el.prepend(BANNER, { html: true }); } }).transform(res);
    }
    return res;
  },
};
