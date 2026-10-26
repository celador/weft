// @ts-check
// Weft web UI. Views: Live (event log + squiggle feed over the repo DO's WebSocket),
// Board (tasks with candidate counts/status), Task (side-by-side candidates with evidence
// and approve), Ops (land/revert op log with undo). Hash routes: #/r/<repo>/<view>[/<arg>].

import { h, mount, icon } from "./lib/dom.js";
import {
  agentHue, ago, approvals, changeStats, deriveAgents, deriveBoard, deriveMetrics, deriveOps, diffLines, diffStats,
  isSquiggly, KIND_LABEL, shortChange, shortSha, symbolFile, symbolName, upsert, worstSeverity, WRITE_TAG,
} from "./lib/model.js";
import { fixLegacyUrls } from "./lib/urls.js";

/** @typedef {import("./lib/model.js").WcpEvent} WcpEvent */
/** @typedef {import("./lib/model.js").D1Task} D1Task */

const MAX_ROWS = 600;
const TAIL = 500;

const S = {
  /** @type {any} */ me: null,
  /** @type {any[]} */ repos: [],
  repo: "",
  /** @type {Map<number, WcpEvent>} */ store: new Map(),
  head: 0,
  /** @type {D1Task[]} */ tasks: [],
  conn: "idle",
  /** @type {WebSocket|null} */ ws: null,
  retry: 0,
  /** @type {{view: string, arg?: string}} */ route: { view: "live" },
  filter: { squigglesOnly: false, text: "" },
  /** @type {{timer: any, speed: number, i: number, list: WcpEvent[]} | null} */ replay: null,
  epoch: 0,
  rate: /** @type {number[]} */ ([]),
};

const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

// ------------------------------------------------------------------ API

/** @param {string} path @param {RequestInit} [init] */
async function api(path, init) {
  const r = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("login required");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ?? `${r.status}`);
  return body;
}

/** Public read-only demo (demo.weft.mx): no approve/undo/policy controls. */
const readOnly = () => Boolean(S.me?.readOnly);

const repoPath = (/** @type {string} */ p = "") => `/repos/${encodeURIComponent(S.repo)}${p}`;

/** @param {Record<string, unknown>} body */
async function action(body) {
  return api(repoPath("/actions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ------------------------------------------------------------------ routing

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "r" && parts[1]) return { repo: parts[1], view: parts[2] || "live", arg: parts.slice(3).join("/") || undefined };
  return { repo: "", view: "live", arg: undefined };
}
export function href(/** @type {string} */ view, /** @type {string} */ arg = "") {
  return `#/r/${encodeURIComponent(S.repo)}/${view}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

async function onRoute() {
  const r = parseHash();
  const repo = r.repo || localStorage.getItem("weft.repo") || pickDefaultRepo();
  if (!repo) return render();
  if (!r.repo) {
    location.replace(`#/r/${encodeURIComponent(repo)}/${r.view}`);
    return;
  }
  S.route = { view: r.view, arg: r.arg };
  if (repo !== S.repo) await loadRepo(repo);
  render();
}

function pickDefaultRepo() {
  const sorted = [...S.repos].sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""));
  return sorted.find((r) => r.repo === "weft")?.repo ?? sorted[0]?.repo ?? "";
}

// ------------------------------------------------------------------ data + live stream

async function loadRepo(/** @type {string} */ repo) {
  S.epoch++;
  const epoch = S.epoch;
  S.repo = repo;
  localStorage.setItem("weft.repo", repo);
  S.store = new Map();
  S.tasks = [];
  S.head = 0;
  stopReplay();
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
    S.ws = null;
  }
  setConn("loading");
  try {
    const page = await api(repoPath(`/events?tail=1&limit=${TAIL}`));
    if (epoch !== S.epoch) return;
    for (const e of page.events) upsert(S.store, e);
    S.head = page.head_seq ?? 0;
  } catch (e) {
    toast(`Could not load ${repo}: ${/** @type {Error} */ (e).message}`, "error");
  }
  loadTasks();
  connect(epoch);
}

async function loadTasks() {
  try {
    const t = await api(repoPath("/tasks"));
    S.tasks = t.tasks ?? [];
  } catch {
    S.tasks = []; // repo without an Artifacts trunk / D1: the board falls back to the log
  }
  scheduleSide();
  if (S.route.view === "board" || S.route.view === "task") render();
}

function connect(/** @type {number} */ epoch) {
  const after = Math.max(0, ...S.store.keys());
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api${repoPath(`/stream?after=${after}`)}`);
  S.ws = ws;
  setConn("replaying");
  let replayed = 0;
  ws.onmessage = (m) => {
    if (epoch !== S.epoch) return;
    let f;
    try {
      f = JSON.parse(fixLegacyUrls(String(m.data)));
    } catch {
      return;
    }
    if (f.type === "event" && f.event) {
      const fresh = upsert(S.store, f.event);
      S.head = Math.max(S.head, f.event.seq);
      if (S.conn === "live" && fresh) onLive(f.event);
      else if (fresh) replayed++;
    } else if (f.type === "replay.done") {
      S.head = Math.max(S.head, f.head_seq ?? 0);
      S.retry = 0;
      setConn("live");
      if (replayed) render();
    }
  };
  ws.onclose = (ev) => {
    if (epoch !== S.epoch) return;
    S.ws = null;
    if (ev.code === 4413) toast("Replay too large; paging instead.", "info");
    setConn("reconnecting");
    const delay = Math.min(15000, 500 * 2 ** S.retry++);
    setTimeout(() => epoch === S.epoch && connect(epoch), delay);
  };
}

function setConn(/** @type {string} */ c) {
  S.conn = c;
  const pill = document.getElementById("conn");
  if (!pill) return;
  pill.className = `conn ${c}`;
  mount(pill, h("span.dot"), c === "live" ? `live · #${S.head}` : c);
}

/** A record arrived live: animate it into the log and refresh side panels. */
function onLive(/** @type {WcpEvent} */ e) {
  S.rate.push(Date.now());
  if (S.replay) return; // replay owns the log view; the event is stored and shown afterwards
  if (S.route.view === "live") {
    insertRow(e, true);
    if (isSquiggly(e)) flashSquiggle(e);
  } else if (S.route.view === "ops" && (e.kind === "land" || e.kind === "revert" || e.kind === "control")) render();
  else if (S.route.view === "task" && e.task === S.route.arg) renderSoon();
  else if (S.route.view === "board") renderSoon();
  scheduleSide();
  setConn("live");
}

let renderTimer = 0;
function renderSoon() {
  clearTimeout(renderTimer);
  renderTimer = /** @type {any} */ (setTimeout(render, 400));
}
let sideTimer = 0;
function scheduleSide() {
  if (sideTimer) return;
  sideTimer = /** @type {any} */ (setTimeout(() => {
    sideTimer = 0;
    if (S.route.view === "live") renderSide();
    renderStats();
  }, 250));
}

const events = () => [...S.store.values()].sort((a, b) => a.seq - b.seq);

// ------------------------------------------------------------------ shell

function render() {
  renderTop();
  const main = $("#main");
  main.dataset.view = S.route.view;
  if (!S.repo) return mount(main, h("div.empty", null, S.repos.length ? "Pick a repo." : "No repos visible to this token yet."));
  if (S.route.view === "board") renderBoard(main);
  else if (S.route.view === "ops") renderOps(main);
  else if (S.route.view === "policy") renderPolicy(main);
  else if (S.route.view === "analytics") renderAnalytics(main);
  else if (S.route.view === "task" && S.route.arg) renderTask(main, S.route.arg);
  else renderLive(main);
  renderStats();
}

function renderTop() {
  const nav = $("#nav");
  const v = S.route.view;
  mount(
    nav,
    [["live", "Live"], ["board", "Board"], ["ops", "Ops"], ["policy", "Policy"], ["analytics", "Analytics"]].map(([id, label]) =>
      h("a", { href: href(id), class: v === id || (id === "board" && v === "task") ? "active" : "" }, icon(id === "policy" ? "check" : id), label),
    ),
  );
  const sel = /** @type {HTMLSelectElement} */ ($("#repo"));
  if (sel.options.length !== S.repos.length) {
    mount(sel, S.repos.map((r) => h("option", { value: r.repo }, r.repo)));
  }
  sel.value = S.repo;
  const who = $("#who");
  if (S.me?.readOnly) {
    if (!document.querySelector(".demo-strip"))
      document.body.prepend(h("div.demo-strip", { role: "note" }, h("a", { href: "https://github.com/celador/weft", target: "_blank", rel: "noopener" }, "Public read-only demo of Weft — github.com/celador/weft")));
  } else if (S.me)
    mount(
      who,
      h("span.muted", null, S.me.identity.via === "access" ? "Access · " : ""),
      S.me.identity.email,
      S.me.identity.via === "key" ? h("button", { type: "submit", title: "Sign out" }, "Sign out") : null,
    );
}

function renderStats() {
  const el = document.getElementById("stats");
  if (!el) return;
  const evs = events();
  const r = S.repos.find((x) => x.repo === S.repo);
  const now = Date.now();
  S.rate = S.rate.filter((t) => now - t < 60_000);
  const sq = evs.reduce((n, e) => n + e.diagnostics.length, 0);
  const blocked = evs.filter((e) => e.status === "rejected").length;
  const lands = evs.filter((e) => e.kind === "land" && e.status === "accepted").length;
  const live = deriveAgents(evs).filter((a) => a.sessions.size > 0).length;
  mount(
    el,
    stat("head", `#${S.head}`),
    stat("agents live", String(live || r?.active_agents || 0)),
    stat("squiggles", String(sq), sq ? "warn" : ""),
    stat("blocked", String(blocked), blocked ? "err" : ""),
    stat("landed", String(lands), lands ? "ok" : ""),
    stat("events/min", String(S.rate.length)),
  );
}
const stat = (/** @type {string} */ label, /** @type {string} */ value, cls = "") => h(`div.stat${cls ? "." + cls : ""}`, null, h("b", null, value), h("span", null, label));

// ------------------------------------------------------------------ shared bits

function agentChip(/** @type {string|undefined} */ agent, small = false) {
  if (!agent) return null;
  const hue = agentHue(agent);
  return h(`span.agent${small ? ".sm" : ""}`, { style: { "--hue": String(hue) }, title: agent }, h("span.av", null, agent.replace(/^(hermes|claude|codex|gemini)-/, "").slice(0, 1).toUpperCase() || "?"), agent);
}

function kindBadge(/** @type {WcpEvent} */ e) {
  const k = KIND_LABEL[e.kind] ?? e.kind;
  const iconName = { checkpoint: "push", "negotiate.propose": "propose", "negotiate.counter": "propose", "negotiate.accept": "check", "negotiate.reject": "close" }[e.kind] ?? e.kind;
  return h(`span.kind.k-${e.kind.replace(/\./g, "-")}`, null, icon(iconName), k);
}

function seqLink(/** @type {number} */ seq, label = `#${seq}`) {
  return h("a.seq", { href: "#", onclick: (/** @type {Event} */ ev) => (ev.preventDefault(), focusSeq(seq)) }, label);
}

/** The squiggle: a diagnostic rendered like an editor's wavy underline, with its cause. */
function squiggle(/** @type {import("./lib/model.js").Diagnostic} */ d, /** @type {WcpEvent} */ e, big = false) {
  const arb = d.arbitration;
  return h(
    `div.sq.sev-${d.severity}${big ? ".big" : ""}`,
    null,
    h(
      "div.sq-head",
      null,
      h("span.sev", null, d.severity),
      h("code.sq-sym", { title: d.symbol ?? "" }, symbolName(d.symbol) || d.file || "—"),
      d.file || d.symbol ? h("span.sq-file", null, d.file ?? symbolFile(d.symbol)) : null,
      h("span.code", null, d.code),
    ),
    h("div.sq-msg", null, d.message),
    h(
      "div.sq-cause",
      null,
      big ? [agentChip(e.agent, true), h("span.arrow", null, "←")] : null,
      "caused by ",
      typeof d.caused_by_seq === "number" ? seqLink(d.caused_by_seq) : "?",
      " ",
      agentChip(d.caused_by_agent, true),
      d.caused_by_task ? h("span.muted", null, ` ${d.caused_by_task}`) : null,
      arb?.outcome ? h("span.arb", null, `${arb.outcome}`) : null,
    ),
    d.suggestion && big ? h("div.sq-sugg", null, d.suggestion) : null,
  );
}

function toast(/** @type {string} */ msg, kind = "info") {
  const t = h(`div.toast.${kind}`, null, msg);
  $("#toasts").appendChild(t);
  setTimeout(() => t.classList.add("out"), 3800);
  setTimeout(() => t.remove(), 4400);
}

// ------------------------------------------------------------------ Live view

function renderLive(/** @type {HTMLElement} */ main) {
  const q = h("input.search", { type: "search", placeholder: "Filter: agent, file, symbol, task…", value: S.filter.text });
  q.addEventListener("input", () => {
    S.filter.text = /** @type {HTMLInputElement} */ (q).value.toLowerCase();
    fillLog();
  });
  const only = h("button.toggle", { class: S.filter.squigglesOnly ? "on" : "", title: "Only records with squiggles" }, "Squiggles only");
  only.addEventListener("click", () => {
    S.filter.squigglesOnly = !S.filter.squigglesOnly;
    only.classList.toggle("on", S.filter.squigglesOnly);
    fillLog();
  });
  const speed = /** @type {HTMLSelectElement} */ (h("select.speed", { title: "Replay speed" }, [1, 4, 16, 64].map((s) => h("option", { value: s, selected: s === 16 }, `${s}×`))));
  const replayBtn = h("button.replay", { title: "Replay the log from the start, animated (for demos)" }, icon(S.replay ? "pause" : "replay"), S.replay ? "Stop" : "Replay");
  replayBtn.addEventListener("click", () => (S.replay ? stopReplay(true) : startReplay(Number(speed.value))));
  mount(
    main,
    h(
      "section.liveview",
      null,
      h(
        "div.logcol",
        null,
        h("div.toolbar", null, h("h2", null, "Change log"), q, only, h("span.grow"), speed, replayBtn),
        h("div#replaybar.replaybar", { hidden: !S.replay }),
        h("ol#log.log", { "aria-live": "polite" }),
      ),
      h("aside.side", null, h("div#squiggles.panel"), h("div#agents.panel")),
    ),
  );
  fillLog();
  renderSide();
}

function matches(/** @type {WcpEvent} */ e) {
  if (S.filter.squigglesOnly && !isSquiggly(e)) return false;
  const t = S.filter.text;
  if (!t) return true;
  const hay = [e.summary, e.agent, e.task, e.change, e.kind, ...e.files, ...e.writes.map((w) => w.key), ...e.diagnostics.map((d) => `${d.code} ${d.symbol} ${d.message}`)].join(" ").toLowerCase();
  return hay.includes(t);
}

function fillLog() {
  const log = document.getElementById("log");
  if (!log) return;
  // during a replay the log shows only what the replay has reached so far (render() during a
  // replay would otherwise refill it with the whole log and the animation would be invisible)
  const src = S.replay ? S.replay.list.slice(0, S.replay.i) : events();
  const list = src.filter(matches).slice(-MAX_ROWS).reverse();
  mount(log, list.length ? list.map((e) => rowFor(e)) : h("li.empty", null, S.conn === "loading" ? "Loading…" : "No records yet. Agents' edits will stream in here live."));
}

function insertRow(/** @type {WcpEvent} */ e, animate = false) {
  const log = document.getElementById("log");
  if (!log || !matches(e)) return;
  log.querySelector(".empty")?.remove();
  const row = rowFor(e);
  if (animate) row.classList.add("enter");
  // newest first; keep seq order if an older seq arrives late
  let before = /** @type {Element|null} */ (log.firstElementChild);
  while (before && Number(/** @type {HTMLElement} */ (before).dataset.seq) > e.seq) before = before.nextElementSibling;
  log.insertBefore(row, before);
  while (log.children.length > MAX_ROWS) log.lastElementChild?.remove();
}

function rowFor(/** @type {WcpEvent} */ e) {
  const sev = worstSeverity(e);
  const actorType = e.actor?.type ?? "agent";
  const row = h(
    `li.row.kind-${e.kind.replace(/\./g, "-")}${e.status === "rejected" ? ".rejected" : ""}${sev ? `.has-${sev}` : ""}`,
    { dataset: { seq: String(e.seq) }, style: { "--hue": String(agentHue(e.agent ?? e.actor?.id ?? "?")) } },
    h("div.rail", null, h("span.seqno", null, `#${e.seq}`), h("time", { datetime: e.ts, title: e.ts }, new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }))),
    h(
      "div.body",
      null,
      h(
        "div.line1",
        null,
        actorType === "agent" ? agentChip(e.agent) : h(`span.actor.${actorType}`, null, e.actor?.id ?? actorType),
        kindBadge(e),
        e.status === "rejected" ? h("span.blocked", null, "blocked") : null,
        e.mode === "check" ? h("span.mode", null, "pre-edit check") : null,
        h("span.grow"),
        e.task ? h("a.task", { href: href("task", e.task), title: e.change ?? "" }, e.task) : null,
      ),
      h("div.summary", null, e.summary),
      e.writes.length
        ? h(
            "div.keys",
            null,
            e.writes.slice(0, 6).map((w) => h(`span.key.w-${w.kind}`, { title: w.key }, h("i", null, WRITE_TAG[w.kind] ?? w.kind), symbolName(w.key))),
            e.writes.length > 6 ? h("span.more", null, `+${e.writes.length - 6}`) : null,
          )
        : e.kind === "checkpoint" && e.payload?.sha
          ? h("div.keys", null, h("code.sha", null, shortSha(e.payload.sha)))
          : null,
      e.diagnostics.length ? h("div.sqs", null, e.diagnostics.slice(0, 3).map((d) => squiggle(d, e))) : null,
    ),
  );
  row.addEventListener("click", (ev) => {
    if (/** @type {HTMLElement} */ (ev.target).closest("a")) return;
    openEvent(e.seq);
  });
  row.addEventListener("mouseenter", () => highlightCauses(e, true));
  row.addEventListener("mouseleave", () => highlightCauses(e, false));
  return row;
}

function highlightCauses(/** @type {WcpEvent} */ e, on = false) {
  for (const d of e.diagnostics) {
    if (typeof d.caused_by_seq !== "number") continue;
    document.querySelector(`.row[data-seq="${d.caused_by_seq}"]`)?.classList.toggle("cause", on);
  }
}

function focusSeq(/** @type {number} */ seq) {
  if (S.route.view !== "live") {
    location.hash = href("live");
    setTimeout(() => focusSeq(seq), 200);
    return;
  }
  const row = /** @type {HTMLElement|null} */ (document.querySelector(`.row[data-seq="${seq}"]`));
  if (!row) return void openEvent(seq);
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("focus");
  void row.offsetWidth;
  row.classList.add("focus");
}

let sideKey = "";
function renderSide() {
  const sqEl = document.getElementById("squiggles");
  const agEl = document.getElementById("agents");
  if (!sqEl || !agEl) return;
  // re-render only when the log changed or relative times would (once a minute)
  const key = `${S.repo}|${S.head}|${S.store.size}|${Math.floor(Date.now() / 60000)}|${sqEl.childElementCount}`;
  if (key === sideKey && sqEl.childElementCount) return;
  sideKey = key;
  const evs = events();
  const items = [];
  for (let i = evs.length - 1; i >= 0 && items.length < 14; i--) {
    const e = evs[i];
    for (const d of e.diagnostics) if (items.length < 14) items.push({ e, d });
    if (e.status === "rejected" && !e.diagnostics.length) items.push({ e, d: /** @type {any} */ ({ severity: "error", code: "rejected", message: e.summary }) });
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const e of evs) for (const d of e.diagnostics) counts[d.severity]++;
  mount(
    sqEl,
    h("div.panel-head", null, h("h3", null, "Squiggles"), h("span.counts", null, h("span.c-error", null, counts.error), h("span.c-warning", null, counts.warning), h("span.c-info", null, counts.info))),
    items.length
      ? h("div.sqfeed", null, items.map(({ e, d }) => h("div.sqitem", { dataset: { seq: String(e.seq) } }, h("div.sqmeta", null, seqLink(e.seq), h("span.muted", null, ago(e.ts))), squiggle(d, e, true))))
      : h("p.muted.pad", null, "No conflicts. When two agents' edits collide, the diagnostic lands here, before any commit exists."),
  );
  const agents = deriveAgents(evs).slice(0, 12);
  mount(
    agEl,
    h("div.panel-head", null, h("h3", null, "Agents"), h("span.muted", null, `${agents.filter((a) => a.sessions.size).length} live`)),
    agents.length
      ? h(
          "ul.agents",
          null,
          agents.map((a) =>
            h(
              "li",
              { class: a.sessions.size ? "on" : "" },
              h("div.a1", null, h("span.pres"), agentChip(a.agent), a.harness ? h("span.harness", null, `${a.harness}${a.level ? ` · L${a.level}` : ""}`) : null, h("span.grow"), h("span.muted", null, ago(a.last_ts))),
              h("div.a2", null, a.task ? h("a", { href: href("task", a.task) }, a.task) : null, " ", h("span.muted", null, a.last_summary)),
            ),
          ),
        )
      : h("p.muted.pad", null, "No agents yet."),
  );
}

function flashSquiggle(/** @type {WcpEvent} */ e) {
  document.body.classList.remove("flash-error", "flash-warning");
  void document.body.offsetWidth;
  const sev = worstSeverity(e);
  if (sev === "error" || sev === "warning") document.body.classList.add(`flash-${sev}`);
}

// ----- replay (demo): re-animate the stored log at N× speed

function startReplay(/** @type {number} */ speed) {
  // replay what the filter shows: gaps between matching records only, so a filtered replay of
  // one run in a busy repo doesn't sit through every other run's records
  const list = events().filter(matches);
  if (!list.length) return;
  S.replay = { timer: 0, speed, i: 0, list };
  const log = document.getElementById("log");
  if (log) mount(log);
  render();
  step();
}
function step() {
  const r = S.replay;
  if (!r) return;
  const e = r.list[r.i];
  if (!e) return stopReplay(true);
  if (matches(e)) {
    insertRow(e, true);
    if (isSquiggly(e)) flashSquiggle(e);
  }
  const bar = document.getElementById("replaybar");
  if (bar) {
    bar.hidden = false;
    mount(bar, h("span", null, `Replaying #${e.seq} of #${r.list.at(-1)?.seq} · ${r.speed}×`), h("span.prog", { style: { width: `${((r.i + 1) / r.list.length) * 100}%` } }));
  }
  r.i++;
  const next = r.list[r.i];
  const gap = next ? Date.parse(next.ts) - Date.parse(e.ts) : 0;
  r.timer = setTimeout(step, Math.max(60, Math.min(1600, gap / r.speed)));
}
function stopReplay(rerender = false) {
  if (!S.replay) return;
  clearTimeout(S.replay.timer);
  S.replay = null;
  if (rerender) render();
}

// ------------------------------------------------------------------ event drawer

async function openEvent(/** @type {number} */ seq) {
  const drawer = $("#drawer");
  drawer.hidden = false;
  document.body.classList.add("drawer-open");
  mount(drawer, h("div.drawer-inner", null, h("p.muted.pad", null, `Loading #${seq}…`)));
  let e;
  try {
    e = await api(repoPath(`/events/${seq}`));
    upsert(S.store, e);
  } catch (err) {
    mount(drawer, h("div.drawer-inner", null, closeBtn(), h("p.err.pad", null, /** @type {Error} */ (err).message)));
    return;
  }
  const ds = diffStats(e.diff);
  mount(
    drawer,
    h(
      "div.drawer-inner",
      null,
      closeBtn(),
      h("div.dhead", null, h("span.seqno.big", null, `#${e.seq}`), kindBadge(e), e.status === "rejected" ? h("span.blocked", null, "blocked") : h("span.accepted", null, "accepted"), h("time.muted", null, new Date(e.ts).toLocaleString())),
      h("h2.dsum", null, e.summary),
      h(
        "dl.meta",
        null,
        kv("actor", e.actor?.type === "agent" ? agentChip(e.agent) : `${e.actor?.type}: ${e.actor?.id}`),
        e.actor?.harness ? kv("harness", e.actor.harness) : null,
        e.task ? kv("task", h("a", { href: href("task", e.task), onclick: closeDrawer }, e.task)) : null,
        e.change ? kv("change", h("code", null, e.change)) : null,
        kv("base", `#${e.base_seq ?? 0}`),
        e.mode ? kv("mode", e.mode) : null,
        e.payload?.sha ? kv("sha", h("code", null, e.payload.sha)) : null,
        e.tool?.name ? kv("tool", `${e.tool.name}${e.tool.harness_event ? ` (${e.tool.harness_event})` : ""}`) : null,
      ),
      e.intent ? h("section", null, h("h4", null, "Intent"), h("p.intent", null, e.intent)) : null,
      e.diagnostics.length ? h("section", null, h("h4", null, "Diagnostics"), e.diagnostics.map((/** @type {any} */ d) => squiggle(d, e, true))) : null,
      e.writes.length ? h("section", null, h("h4", null, `Writes (${e.writes.length})`), h("div.keys.wrap", null, e.writes.map((/** @type {any} */ w) => h(`span.key.w-${w.kind}`, { title: w.key }, h("i", null, WRITE_TAG[w.kind] ?? w.kind), w.key)))) : null,
      e.reads.length ? h("section", null, h("h4", null, `Reads (${e.reads.length})`), h("div.keys.wrap", null, e.reads.slice(0, 60).map((/** @type {string} */ r) => h("span.key.read", null, r)))) : null,
      e.diff ? h("section", null, h("h4", null, "Diff ", h("span.add", null, `+${ds.add}`), " ", h("span.del", null, `−${ds.del}`)), diffView(e.diff)) : null,
      e.payload && !e.payload.sha ? h("section", null, h("h4", null, "Payload"), h("pre.json", null, JSON.stringify(e.payload, null, 2))) : null,
    ),
  );
}
const kv = (/** @type {string} */ k, /** @type {any} */ v) => [h("dt", null, k), h("dd", null, v)];
function closeBtn() {
  return h("button.close", { onclick: closeDrawer, title: "Close (Esc)" }, icon("close"));
}
function closeDrawer() {
  $("#drawer").hidden = true;
  document.body.classList.remove("drawer-open");
}
function diffView(/** @type {string} */ diff) {
  return h("pre.diff", null, diffLines(diff).slice(0, 1500).map((l) => h(`span.dl.${l.type}`, null, l.text || " ")));
}

// ------------------------------------------------------------------ Board

const COLUMNS = [
  ["queued", "Queued"],
  ["working", "Working"],
  ["conflict", "Squiggled"],
  ["review", "Review"],
  ["landed", "Landed"],
  ["reverted", "Reverted"],
];

function renderBoard(/** @type {HTMLElement} */ main) {
  const cards = deriveBoard(events(), S.tasks);
  mount(
    main,
    h(
      "section.board",
      null,
      COLUMNS.map(([id, label]) => {
        const list = cards.filter((c) => c.column === id);
        return h(
          `div.col.col-${id}`,
          null,
          h("div.col-head", null, h("h3", null, label), h("span.count", null, list.length)),
          h("div.cards", null, list.length ? list.map(taskCard) : h("p.muted.pad", null, "—")),
        );
      }),
    ),
  );
}

function taskCard(/** @type {ReturnType<typeof deriveBoard>[number]} */ c) {
  return h(
    "a.card",
    { href: href("task", c.task) },
    h("div.card-title", null, c.title),
    h("div.card-id", null, c.task),
    h(
      "div.card-meta",
      null,
      h("span.ccount", { title: "candidates" }, h("b", null, c.candidates), c.candidates === 1 ? " candidate" : " candidates"),
      c.squiggles.error ? h("span.pill.err", null, `${c.squiggles.error} err`) : null,
      c.squiggles.warning ? h("span.pill.warn", null, `${c.squiggles.warning} warn`) : null,
      c.blocked ? h("span.pill.err", null, `${c.blocked} blocked`) : null,
      c.approved.length ? h("span.pill.ok", null, "approved") : null,
    ),
    h("div.card-foot", null, h("span.agents-row", null, c.agents.slice(0, 4).map((a) => agentChip(a, true))), h("span.grow"), c.last_ts ? h("span.muted", null, ago(c.last_ts)) : null),
  );
}

// ------------------------------------------------------------------ Task detail: candidates side by side

async function renderTask(/** @type {HTMLElement} */ main, /** @type {string} */ task) {
  const evs = events().filter((e) => e.task === task);
  const card = deriveBoard(events(), S.tasks).find((c) => c.task === task);
  const meta = S.tasks.find((t) => t.task === task);
  mount(
    main,
    h(
      "section.taskview",
      null,
      h("a.back", { href: href("board") }, "← Board"),
      h("div.task-head", null, h("h2", null, card?.title ?? task), h("span.card-id", null, task), card ? h(`span.colpill.col-${card.column}`, null, COLUMNS.find((x) => x[0] === card.column)?.[1] ?? card.column) : null),
      h("div#cands.cands", null, h("p.muted.pad", null, "Loading candidates…")),
      h("h3.sub", null, "Activity"),
      h("ol.log.compact", null, evs.slice(-80).reverse().map((e) => rowFor(e))),
    ),
  );
  // Enrich: D1 candidates (+ revisions/evidence) and per-change diffs from the log.
  /** @type {any[]} */
  let d1 = meta?.candidates ?? [];
  try {
    const r = await api(repoPath(`/tasks/${encodeURIComponent(task)}/candidates`));
    d1 = r.candidates ?? d1;
  } catch {
    /* task not in D1 (log-only) */
  }
  const details = await Promise.all(d1.map((c) => api(repoPath(`/changes/${encodeURIComponent(c.change)}`)).catch(() => null)));
  let withDiffs = evs;
  try {
    const page = await api(repoPath(`/events?task=${encodeURIComponent(task)}&kind=edit&include=diff&limit=500`));
    for (const e of page.events) upsert(S.store, e);
    withDiffs = events().filter((e) => e.task === task);
  } catch {
    /* diff stats fall back to 0 */
  }
  if (S.route.view !== "task" || S.route.arg !== task) return;
  const changeIds = [...new Set([...d1.map((c) => c.change), ...withDiffs.map((e) => e.change).filter(Boolean)])];
  const approved = approvals(events());
  const el = document.getElementById("cands");
  if (!el) return;
  if (!changeIds.length) return void mount(el, h("p.muted.pad", null, "No candidates yet."));
  mount(
    el,
    changeIds.map((id, i) => {
      const c = d1.find((x) => x.change === id);
      const det = details[d1.indexOf(c)] ?? null;
      return candidateCard(task, /** @type {string} */ (id), i + 1, c, det, changeStats(withDiffs, /** @type {string} */ (id)), approved.get(/** @type {string} */ (id)));
    }),
  );
}

function candidateCard(/** @type {string} */ task, /** @type {string} */ change, /** @type {number} */ idx, /** @type {any} */ d1, /** @type {any} */ det, /** @type {ReturnType<typeof changeStats>} */ st, /** @type {number|undefined} */ approvedSeq) {
  const evidence = /** @type {any[]} */ (det?.evidence ?? []).map((e) => ({ ...e, data: typeof e.data === "string" ? safeJson(e.data) : e.data }));
  const revisions = /** @type {any[]} */ (det?.revisions ?? []);
  const by = (/** @type {string} */ k) => evidence.filter((e) => e.kind === k);
  const tests = by("test");
  const previews = by("preview");
  const shots = by("screenshot");
  const reviews = by("review");
  const risk = by("risk").slice(-1)[0];
  const visual = by("visual_diff").slice(-1)[0];
  const cost = by("cost").reduce((n, e) => n + (Number(e.data?.usd ?? e.data?.cost_usd ?? 0) || 0), 0);
  const agent = d1?.agent ?? st.agent;
  const status = st.reverted ? "reverted" : st.landed ? "landed" : d1?.status ?? (st.blocked && !st.edits ? "blocked" : "open");
  const sq = st.squiggles;
  const approveBtn = h("button.approve", { disabled: Boolean(approvedSeq || st.landed || status === "abandoned" || status === "reverted") || undefined }, icon("check"), approvedSeq ? `Approved (#${approvedSeq})` : "Approve");
  approveBtn.addEventListener("click", async () => {
    if (!confirm(`Approve candidate ${d1?.n ?? idx} (${shortChange(change)}) for ${task}?`)) return;
    approveBtn.setAttribute("disabled", "");
    try {
      const r = await action({ action: "approve", change, task });
      toast(`Approved ${shortChange(change)} · #${r.seq}${r.workflow ? ` · workflow ${r.workflow}` : ""}`, "ok");
      mount(approveBtn, icon("check"), `Approved (#${r.seq})`);
    } catch (e) {
      approveBtn.removeAttribute("disabled");
      toast(`Approve failed: ${/** @type {Error} */ (e).message}`, "error");
    }
  });
  return h(
    `article.cand.st-${status}${approvedSeq ? ".approved" : ""}`,
    { style: { "--hue": String(agentHue(agent ?? change)) } },
    h("header", null, h("span.cn", null, `#${d1?.n ?? idx}`), agentChip(agent), st.harness ? h("span.harness", null, st.harness) : null, h("span.grow"), h(`span.status.s-${status}`, null, status)),
    h("code.cid", { title: change }, shortChange(change)),
    h(
      "div.metrics",
      null,
      metric(h("span", null, h("span.add", null, `+${st.add}`), " ", h("span.del", null, `−${st.del}`)), "diff"),
      metric(String(st.files.size), "files"),
      metric(String(st.edits), "edits"),
      metric(h("span", null, sq.error ? h("span.c-error", null, sq.error) : "0", sq.warning ? h("span.c-warning", null, ` ${sq.warning}`) : null), "squiggles"),
      metric(cost ? `$${cost.toFixed(2)}` : "—", "cost"),
      risk?.data?.risk ? metric(h(`span.risk.risk-${risk.data.risk}`, { title: (risk.data.reasons ?? []).join("\n") }, risk.data.risk), "risk") : null,
    ),
    shots.length
      ? h(
          "div.shots",
          null,
          shots
            .filter((s) => s.uri)
            .slice(-4)
            .map((s) =>
              h(
                "figure.shot",
                null,
                h("a", { href: fixLegacyUrls(s.uri), target: "_blank", rel: "noopener" }, h("img", { src: fixLegacyUrls(s.uri), alt: `screenshot ${s.data?.route ?? ""} ${shortSha(s.sha)}`, loading: "lazy" })),
                h(
                  "figcaption",
                  null,
                  h("code", null, s.data?.route ?? "/"),
                  typeof s.data?.diff_ratio === "number" ? h(`span.vd${s.data.diff_ratio > 0.001 ? ".changed" : ""}`, null, ` Δ ${(s.data.diff_ratio * 100).toFixed(2)}%`) : null,
                  s.data?.trunk_uri ? extLink(s.data.trunk_uri, "trunk") : null,
                  s.data?.diff_uri ? extLink(s.data.diff_uri, "diff") : null,
                ),
              ),
            ),
        )
      : h("div.shots.empty", null, h("span.muted", null, "no screenshots yet")),
    h(
      "ul.evidence",
      null,
      tests.map((t) => {
        const pass = t.data?.passed ?? t.data?.summary?.pass;
        const fail = t.data?.failed ?? t.data?.summary?.fail;
        return h(`li.ev.ev-${t.status}`, null, h("span.evk", null, "tests"), h("span", null, t.status), pass !== undefined ? h("span.muted", null, ` ${pass}✓ ${fail ?? 0}✗`) : null, t.uri ? extLink(t.uri, "log") : null);
      }),
      previews.map((p) =>
        h(
          `li.ev.ev-${p.status}`,
          null,
          h("span.evk", null, "preview"),
          p.uri ? extLink(p.uri, "candidate") : h("span", null, p.data?.reason ?? p.data?.error ?? p.status),
          p.data?.trunk_url ? extLink(p.data.trunk_url, "trunk") : null,
        ),
      ),
      visual ? h(`li.ev.ev-info`, null, h("span.evk", null, "visual"), h("span", null, (visual.data?.routes ?? []).map((/** @type {any} */ r) => `${r.route} ${r.ratio === null ? "—" : `${(r.ratio * 100).toFixed(2)}%`}`).join(" · "))) : null,
      reviews.map((r) =>
        h(
          `li.ev.ev-${r.status}`,
          null,
          h("span.evk", null, "review"),
          h("span", null, r.data?.verdict ?? r.status),
          typeof r.data?.score === "number" ? h("span.muted", null, ` ${r.data.score}/100`) : null,
          r.data?.summary || r.data?.reason || r.data?.error ? h("span.muted", null, ` ${String(r.data.summary ?? r.data.reason ?? r.data.error).slice(0, 160)}`) : null,
          Array.isArray(r.data?.criteria) && r.data.criteria.length
            ? h(
                "ul.criteria",
                null,
                r.data.criteria.map((/** @type {any} */ c) => h(`li.crit.${c.met === true ? "met" : c.met === false ? "unmet" : "unknown"}`, { title: c.note ?? "" }, c.met === true ? "✓ " : c.met === false ? "✗ " : "? ", c.criterion)),
              )
            : null,
        ),
      ),
      evidence
        .filter((e) => !["test", "preview", "screenshot", "review", "cost", "risk", "visual_diff"].includes(e.kind))
        .map((e) => h(`li.ev.ev-${e.status}`, null, h("span.evk", null, e.kind), h("span", null, e.status), e.uri ? extLink(e.uri, "open") : null)),
      !evidence.length ? h("li.muted", null, "No evidence recorded yet (tests, previews, review arrive from ProcessRevision).") : null,
    ),
    revisions.length || st.checkpoints.length
      ? h(
          "div.revs",
          null,
          h("h5", null, "Revisions"),
          (revisions.length ? revisions : st.checkpoints).slice(-5).map((/** @type {any} */ r) => h("div.rev", null, h("code.sha", null, shortSha(r.sha)), h("span", null, r.subject ?? ""), r.status ? h("span.muted", null, ` ${r.status}`) : null)),
        )
      : null,
    st.diagnostics.length ? h("div.csq", null, h("h5", null, "Squiggles"), st.diagnostics.slice(-3).map(({ d, ev }) => squiggle(d, ev))) : null,
    st.files.size ? h("div.files", null, [...st.files].slice(0, 8).map((f) => h("code.fchip", null, f))) : null,
    h("footer", null, readOnly() ? null : approveBtn, d1?.fork?.remote ? h("span.muted.fork", { title: d1.fork.remote }, d1.fork.name) : null),
  );
}
const metric = (/** @type {any} */ v, /** @type {string} */ label) => h("div.metric", null, h("b", null, v), h("span", null, label));
const extLink = (/** @type {string} */ uri, /** @type {string} */ label) => h("a.ext", { href: fixLegacyUrls(uri), target: "_blank", rel: "noopener noreferrer" }, label, icon("ext"));
function safeJson(/** @type {string} */ s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Ops: op log with undo

function renderPolicy(/** @type {HTMLElement} */ main) {
  const evs = events();
  const accepted = evs.filter((e) => e.status === "accepted").length;
  const rejected = evs.filter((e) => e.status === "rejected").length;
  const errors = evs.reduce((n, e) => n + e.diagnostics.filter((d) => d.severity === "error").length, 0);
  const sample = {
    repo: S.repo,
    task: "demo-policy",
    change: "candidate-demo",
    evidence: { tests: { passed: 24, failed: 0 }, review: { approved: true }, cost_usd: 0.42, squiggles: { error: 0, warning: 1 } },
  };
  const input = /** @type {HTMLTextAreaElement} */ (h("textarea.policy-input", { spellcheck: "false" }, JSON.stringify(sample, null, 2)));
  const output = h("pre.policy-output.muted", null, "Run an evaluation to see the isolated policy decision.");
  const run = /** @type {HTMLButtonElement} */ (h("button.primary", {
    onclick: async () => {
      run.disabled = true;
      output.className = "policy-output muted";
      output.textContent = "Evaluating…";
      try {
        const decision = await api("/policy/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: input.value });
        output.className = `policy-output ${decision.allow ? "ok" : "err"}`;
        output.textContent = JSON.stringify(decision, null, 2);
      } catch (e) {
        output.className = "policy-output err";
        output.textContent = /** @type {Error} */ (e).message;
      } finally { run.disabled = false; }
    },
  }, "Evaluate candidate"));
  if (readOnly()) {
    run.disabled = true;
    run.title = "Disabled in the public read-only demo";
    output.textContent = "Policy evaluation is disabled in the public read-only demo.";
  }
  mount(main, h("section.policy", null,
    h("div.toolbar", null, h("h2", null, "weft.policy.ts"), h("span.muted", null, "Per-repository code runs in an isolated dynamic Worker.")),
    h("div.telemetry", null, stat("events queried", String(evs.length)), stat("accepted", String(accepted), "ok"), stat("rejected", String(rejected), rejected ? "err" : ""), stat("error squiggles", String(errors), errors ? "err" : "")),
    h("div.policy-grid", null,
      h("div.panel", null, h("h3", null, "Input"), input, run),
      h("div.panel", null, h("h3", null, "Decision"), output),
    ),
    h("p.muted", null, "Operational actions, policy decisions, and email intake also write latency/outcome points to Analytics Engine."),
  ));
}

function duration(/** @type {number} */ ms) {
  if (!ms) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function renderAnalytics(/** @type {HTMLElement} */ main) {
  const m = deriveMetrics(events());
  mount(main, h("section.analytics", null,
    h("div.toolbar", null, h("h2", null, "Analytics Engine"), h("span.muted", null, "Operational outcomes for the loaded repository.")),
    h("div.telemetry", null,
      stat("landing rate", m.attempts ? `${Math.round(m.landingRate * 100)}%` : "—", m.landingRate ? "ok" : ""),
      stat("landed", `${m.landed}/${m.attempts}`),
      stat("conflicts caught", String(m.conflictsCaught), m.conflictsCaught ? "warn" : ""),
      stat("avg time-to-land", duration(m.averageTimeToLandMs))),
    h("div.panel.analytics-table", null, h("h3", null, "Success by harness / model"),
      m.byHarnessModel.length ? h("table.optable", null,
        h("thead", null, h("tr", null, ["harness", "model", "landed", "attempts", "success"].map((x) => h("th", null, x)))),
        h("tbody", null, m.byHarnessModel.map((g) => h("tr", null,
          h("td", null, g.harness), h("td", null, g.model), h("td", null, String(g.landed)), h("td", null, String(g.attempts)), h("td", null, `${Math.round(g.successRate * 100)}%`)))))
        : h("p.muted.pad", null, "No candidate activity yet.")),
    h("p.muted", null, "Platform operations are written to the weft_operations Analytics Engine dataset; this live view derives outcome metrics from the repository event stream.")));
}

function renderOps(/** @type {HTMLElement} */ main) {
  const ops = deriveOps(events());
  mount(
    main,
    h(
      "section.ops",
      null,
      h("div.toolbar", null, h("h2", null, "Operation log"), h("span.muted", null, "Every landing on trunk is an operation. Undo appends a revert; history is never rewritten.")),
      ops.length
        ? h(
            "table.optable",
            null,
            h("thead", null, h("tr", null, ["", "op", "when", "change", "summary", "sha", "state", ""].map((x) => h("th", null, x)))),
            h("tbody", null, ops.map(opRow)),
          )
        : h("p.empty", null, "No landings yet."),
    ),
  );
}

function opRow(/** @type {any} */ op) {
  const undo = h("button.undo", { disabled: op.type !== "land" || op.state !== "live" || undefined }, icon("undo"), "Undo");
  undo.addEventListener("click", async () => {
    const reason = prompt(`Undo landing #${op.seq} (${shortSha(op.sha)})? Reason:`, "");
    if (reason === null) return;
    undo.setAttribute("disabled", "");
    try {
      const r = await action({ action: "undo", seq: op.seq, reason: reason || "undo from web UI" });
      toast(`Undo requested · #${r.seq}. The revert workflow appends the revert.`, "ok");
    } catch (e) {
      undo.removeAttribute("disabled");
      toast(`Undo failed: ${/** @type {Error} */ (e).message}`, "error");
    }
  });
  return h(
    `tr.op.op-${op.type}.state-${op.state}`,
    null,
    h("td", null, icon(op.type === "land" ? "land" : "revert")),
    h("td", null, seqLink(op.seq), h("div.muted.small", null, op.type)),
    h("td", null, h("time", { title: op.ts }, ago(op.ts)), " ago"),
    h("td", null, op.task ? h("a", { href: href("task", op.task) }, op.task) : "—", h("div.muted.small", null, shortChange(op.change))),
    h("td.opsum", null, op.summary, op.reason ? h("div.muted.small", null, op.reason) : null),
    h("td", null, h("code.sha", null, shortSha(op.sha))),
    h("td", null, h(`span.state.s-${op.state}`, null, op.state.replace("_", " ")), op.revert_seq ? h("div.small", null, "by ", seqLink(op.revert_seq)) : op.undo_seq ? h("div.small", null, "req ", seqLink(op.undo_seq)) : null),
    h("td", null, op.type === "land" && !readOnly() ? undo : null),
  );
}

// ------------------------------------------------------------------ boot

async function boot() {
  $("#repo").addEventListener("change", (ev) => {
    const v = /** @type {HTMLSelectElement} */ (ev.target).value;
    location.hash = `#/r/${encodeURIComponent(v)}/${S.route.view === "task" ? "board" : S.route.view}`;
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeDrawer();
  });
  window.addEventListener("hashchange", onRoute);
  setInterval(() => {
    // keep counters and relative times fresh
    renderStats();
    if (S.route.view === "live" && !S.replay) renderSide();
  }, 5000);
  try {
    S.me = await api("/me");
    const r = await api("/repos");
    S.repos = (r.repos ?? []).sort((/** @type {any} */ a, /** @type {any} */ b) => a.repo.localeCompare(b.repo));
  } catch (e) {
    mount($("#main"), h("div.empty.err", null, `Cannot reach the gateway: ${/** @type {Error} */ (e).message}`));
    return;
  }
  setInterval(async () => {
    try {
      S.repos = ((await api("/repos")).repos ?? []).sort((/** @type {any} */ a, /** @type {any} */ b) => a.repo.localeCompare(b.repo));
    } catch {
      /* transient */
    }
  }, 30000);
  await onRoute();
}

if (typeof document !== "undefined" && document.getElementById("main")) boot();
