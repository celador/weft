// The feed webview: @weft/feed/view on a FeedSession whose client is a bridge to the extension
// host (which owns the gateway connection and the token). Bundled to media/dist/webview.js and
// loaded with a nonce; no inline script or style anywhere (the view sets text with textContent
// and colours with classes).

import { type FeedEvent, type FeedStreamOptions, FeedSession, type HumanAction, normalize, ObserverClient, type RepoStreamOptions, type StreamHandle, type StreamStatus, WeftHttpError } from "@weft/feed";
import { mountFeed } from "@weft/feed/view";
import type { RpcError, RpcMethod, ToHost, ToView } from "../bridge";

declare function acquireVsCodeApi(): { postMessage(m: ToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: ToHost) => vscode.postMessage(m);

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc<T>(m: RpcMethod, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ t: "rpc", id, m, args });
  });
}
const toError = (e: RpcError) => new WeftHttpError(e.status, e.code, e.message);

/** An ObserverClient whose calls go to the extension host instead of the network. */
class BridgeClient extends ObserverClient {
  feedListener?: FeedStreamOptions;
  status: StreamStatus = "connecting";
  constructor() {
    super({
      baseUrl: "http://weft.bridge.invalid",
      token: "none",
      fetch: () => Promise.reject(new Error("the feed webview has no network access")),
    });
  }
  override repos() {
    return rpc<Awaited<ReturnType<ObserverClient["repos"]>>>("repos");
  }
  override async event(repo: string, seq: number): Promise<FeedEvent> {
    return normalize(await rpc<unknown>("event", repo, seq));
  }
  override async act(repo: string, action: HumanAction) {
    const res = await rpc<{ record: unknown }>("act", repo, action);
    return { ...(res as object), record: normalize(res.record) } as Awaited<ReturnType<ObserverClient["act"]>>;
  }
  override streamFeed(o: FeedStreamOptions): StreamHandle {
    this.feedListener = o;
    for (const m of early.splice(0)) onMessage(m);
    const self = this;
    return {
      close: () => {
        if (self.feedListener === o) self.feedListener = undefined;
      },
      wake: () => post({ t: "command", command: "reconnect" }),
      get status() {
        return self.status;
      },
    };
  }
  override streamRepo(_repo: string, _o: RepoStreamOptions): StreamHandle {
    throw new Error("the webview mirrors the host's combined feed");
  }
}

const client = new BridgeClient();
const session = new FeedSession(client, {});
const early: ToView[] = [];

const app = document.getElementById("app")!;
const bar = document.getElementById("bar")!;
let canAct = true;
let tokenWhere: string | undefined;
let selected: string | undefined;

const view = mountFeed(app, {
  session,
  title: "Weft",
  onSelect: (id) => {
    selected = id;
    post({ t: "selected", ...(id ? { id } : {}) });
    renderBar();
    vscode.setState({ selected: id });
  },
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** VS Code-only strip above the feed: open the selected change in the diff editor, token notice. */
function renderBar(): void {
  bar.replaceChildren();
  if (selected) {
    const sep = selected.lastIndexOf("#");
    const repo = selected.slice(0, sep);
    const seq = Number(selected.slice(sep + 1));
    const e = session.log.event(repo, seq);
    const label = el("span", "wv-sel", `${repo} #${seq}`);
    bar.append(label);
    if (e && (e.has_diff || e.diff !== undefined)) {
      const b = el("button", "wv-btn", "Open diff in editor");
      b.type = "button";
      b.dataset.cmd = "openDiff";
      b.addEventListener("click", () => post({ t: "openDiff", id: selected! }));
      bar.append(b);
    }
    for (const f of (e?.files ?? []).slice(0, 3)) {
      const b = el("button", "wv-btn wv-link", f);
      b.type = "button";
      b.title = `Open ${f} in this workspace`;
      b.addEventListener("click", () => post({ t: "openFile", repo, file: f }));
      bar.append(b);
    }
  }
  if (!canAct) {
    const n = el("span", "wv-note", `Read-only token${tokenWhere ? ` (${tokenWhere})` : ""}: Approve, Undo, Pause, Resume and Message need a token with the human scope.`);
    const b = el("button", "wv-btn", "Set token…");
    b.type = "button";
    b.addEventListener("click", () => post({ t: "command", command: "setToken" }));
    bar.append(n, b);
  }
  bar.hidden = !bar.childElementCount;
}

function onMessage(m: ToView): void {
  switch (m.t) {
    case "rpc": {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(toError(m.error));
      return;
    }
    case "init":
    case "events":
    case "status":
      if (!client.feedListener) {
        early.push(m);
        return;
      }
  }
  switch (m.t) {
    case "init":
      canAct = m.canAct;
      tokenWhere = m.tokenWhere;
      session.repoList = m.repos;
      // init carries the host's whole log for the workspace's repos: drop rows of repos that
      // fell out of scope (e.g. the folder's repo became known after an unscoped start).
      {
        const keep = new Set([...m.events.map((e) => e.repo), ...m.repos.map((r) => r.repo)]);
        for (const r of session.log.repos) if (!keep.has(r)) session.log.reset(r);
      }
      client.status = m.status;
      client.feedListener!.onStatus?.(m.status, m.error);
      client.feedListener!.onEvents(m.events.map(normalize), "");
      if (m.selected) view.select(m.selected);
      renderBar();
      break;
    case "events":
      client.feedListener!.onEvents(m.events.map(normalize), "");
      renderBar();
      break;
    case "repos":
      session.repoList = m.repos;
      view.render();
      break;
    case "status":
      client.status = m.status;
      client.feedListener!.onStatus?.(m.status, m.detail);
      break;
    case "select":
      view.select(m.id);
      break;
    case "acted":
      canAct = true;
      renderBar();
      break;
  }
}

window.addEventListener("message", (ev: MessageEvent<ToView>) => onMessage(ev.data));
const st = vscode.getState() as { selected?: string } | undefined;
if (st?.selected) view.select(st.selected);
void session.start();
post({ t: "ready" });
(window as unknown as { weftFeed: unknown }).weftFeed = { session, view };
