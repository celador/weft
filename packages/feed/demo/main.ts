// Demo page for @weft/feed/view: a local gateway's live feed. The demo server (server.mjs)
// serves this page, proxies /v1 (HTTP + WebSocket) to the gateway, and hands the page a token
// from /config.json (local use only).
import { FeedSession, ObserverClient } from "../src/index";
import { mountFeed } from "../src/view/index";

type Config = { token: string; repos?: string[]; title?: string };

async function main(): Promise<void> {
  const cfg = (await (await fetch("config.json", { cache: "no-store" })).json()) as Config;
  const client = new ObserverClient({ baseUrl: location.origin, token: cfg.token });
  const session = new FeedSession(client, { perRepoStreams: true, ...(cfg.repos ? { repos: cfg.repos } : {}) });
  const view = mountFeed(document.getElementById("app")!, {
    session,
    title: cfg.title ?? "Weft",
    ...(location.hash.length > 1 ? { selected: decodeURIComponent(location.hash.slice(1)) } : {}),
    onSelect: (id) => history.replaceState(null, "", id ? `#${encodeURIComponent(id)}` : location.pathname),
  });
  window.addEventListener("hashchange", () => view.select(location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : undefined));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && session.wake());
  await session.start();
  // Live counts for the per-repo summary lines.
  setInterval(() => void session.refreshRepos().catch(() => {}), 10_000);
  (window as unknown as { weftFeed: unknown }).weftFeed = { session, view };
}

void main();
