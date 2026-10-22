// @weft/feed/view: a dependency-free DOM component for the Weft feed. Used by the web feed,
// the VS Code webview and the JetBrains tool window (JCEF).
//
// CSP-safe like apps/web: no inline script, no inline style, no innerHTML. Every piece of
// agent-provided text (summaries, intents, diffs, messages) is set with textContent. Colours
// come from classes in feed.css (`@weft/feed/view.css`), including the per-agent palette.

import {
  type ActionOption,
  actionsFor,
  type Squiggle,
  squiggleOf,
} from "../actions";
import { parseDiff } from "../diff";
import type { FeedFilter } from "../log";
import { repoSummary } from "../repo";
import type { FeedSession } from "../session";
import { type Editing, type FeedRow, feedRow, fileNames, lineStats, relTime, stripModel, trailOf } from "../strip";
import { agentColorIndex, codeLabel, displayKey, symbolFile, summaryWithActor } from "../summary";
import { type FeedEvent, epochMs, idOf, mayHaveDiff, parseId } from "../types";

type Child = Node | string | number | null | undefined | false | Child[];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  add(el, children);
  return el;
}
function add(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === "") continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
function button(cls: string, label: Child, onClick: (ev: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick(ev);
  });
  return b;
}
const agentClass = (agent: string) => `wf-agent wf-c${agentColorIndex(agent)}`;

export type FeedViewOptions = {
  session: FeedSession;
  /** Heading text. Default "Weft". */
  title?: string;
  /** Initial filter (Otto's default hides session bookkeeping). */
  filter?: FeedFilter;
  /** Open this record's detail at start (`repo#seq`). */
  selected?: string;
  /** Called when the selection changes (e.g. to sync a URL hash). */
  onSelect?: (id: string | undefined) => void;
  now?: () => number;
};

export type FeedView = {
  /** Open a record's detail (`repo#seq`), loading it if needed. */
  select(id: string | undefined): void;
  setFilter(f: FeedFilter): void;
  render(): void;
  destroy(): void;
  readonly root: HTMLElement;
};

type Composer = { option: ActionOption; value: string; sending: boolean; error?: string };

/**
 * Mounts the feed into `root`: header with status and per-repo summary lines, "Editing now",
 * the Changes feed with inline squiggles (each linking to its cause), and a detail pane with
 * the coloured diff and the action buttons the record allows.
 */
export function mountFeed(root: HTMLElement, o: FeedViewOptions): FeedView {
  const s = o.session;
  const now = o.now ?? (() => Date.now());
  let filter: FeedFilter = o.filter ?? {};
  let selected: string | undefined = o.selected;
  let composer: Composer | undefined;
  let notice: { text: string; error: boolean } | undefined;
  const expanded = new Set<string>();
  let scheduled: ReturnType<typeof setTimeout> | undefined;

  root.classList.add("wf-root");
  const header = h("header", "wf-header");
  const list = h("section", "wf-list");
  const detail = h("section", "wf-detail");
  list.setAttribute("aria-label", "Changes");
  detail.setAttribute("aria-label", "Selected change");
  const body = h("div", "wf-body", list, detail);
  root.replaceChildren(header, body);

  const off = s.on(() => schedule());
  const ticker = setInterval(() => render(), 5000);

  function schedule(): void {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      render();
    }, 30);
  }

  function select(id: string | undefined): void {
    selected = id;
    composer = undefined;
    notice = undefined;
    o.onSelect?.(id);
    const p = id ? parseId(id) : undefined;
    if (p) {
      const held = s.log.event(p.repo, p.seq);
      if (!held || (held.diff === undefined && mayHaveDiff(held))) void s.loadDetail(p.repo, p.seq).then(() => render());
    }
    render();
  }

  // ------------------------------------------------------------ header

  function renderHeader(t: number): void {
    const st = s.header(t);
    const filters = h(
      "div",
      "wf-filters",
      toggle("Only conflicts", !!filter.onlyConflicts, (v) => (filter = { ...filter, onlyConflicts: v })),
      toggle("Session events", !!filter.showSessionEvents, (v) => (filter = { ...filter, showSessionEvents: v })),
    );
    const repos = h(
      "ul",
      "wf-repos",
      s.repoList.map((r) => {
        const line = repoSummary(r, { log: s.log, now: t });
        return h("li", line.attention ? "wf-repo wf-attention" : "wf-repo", line.text);
      }),
    );
    header.replaceChildren();
    add(header, [
      h(
        "div",
        "wf-titlebar",
        h("h1", "wf-title", o.title ?? "Weft"),
        h("span", `wf-status wf-status-${st.tone}`, h("span", "wf-dot"), st.text),
        filters,
      ),
      s.repoList.length ? repos : null,
      s.error && st.tone !== "live" ? h("p", "wf-error", s.error) : null,
    ]);
  }

  function toggle(label: string, on: boolean, set: (v: boolean) => void): HTMLElement {
    const b = button(on ? "wf-chip wf-on" : "wf-chip", label, () => {
      set(!on);
      render();
    });
    b.setAttribute("aria-pressed", String(on));
    return b;
  }

  // ------------------------------------------------------------ list

  function renderList(t: number): void {
    const model = stripModel(s.log.combined, t);
    const rows = s.log.filtered(filter).map((e) => feedRow(e, s.log));
    const scroll = list.scrollTop;
    const parts: Child[] = [];
    if (model.editing.length) {
      parts.push(h("h2", "wf-section", "Editing now"));
      for (const card of model.editing) {
        parts.push(editingRow(card, t));
        if (expanded.has(`${card.repo}#${card.change}`))
          parts.push(h("div", "wf-trail", trailOf(model, card).map((i) => trailRow(i.id, i.title, i.badge?.label, i.date, t))));
      }
    }
    parts.push(h("h2", "wf-section", "Changes"));
    if (!rows.length) parts.push(h("p", "wf-empty", s.log.size ? "Nothing matches these filters." : s.status === "error" ? "Weft didn't connect." : "No changes yet. When an agent starts work, its intent and edits show up here."));
    for (const r of rows) parts.push(eventRow(r, t));
    list.replaceChildren();
    add(list, parts);
    list.scrollTop = scroll;
  }

  function editingRow(card: Editing, t: number): HTMLElement {
    const key = `${card.repo}#${card.change}`;
    const open = expanded.has(key);
    const row = button(
      `wf-editing${card.conflicted ? " wf-conflicted" : ""}`,
      [
        h("span", open ? "wf-chevron wf-open" : "wf-chevron", "›"),
        card.conflicted ? h("span", "wf-warn-icon", "⚠") : h("span", "wf-pulse"),
        h(
          "span",
          "wf-editing-main",
          h("span", "wf-editing-title", card.title ?? card.task ?? card.change),
          h("span", "wf-editing-sub", [card.who, card.count === 1 ? "1 edit" : `${card.count} edits`, fileNames(card.files, 3)].filter(Boolean).join(" · ")),
        ),
        h("time", "wf-time", relTime(card.lastEdit, t)),
      ],
      () => {
        if (open) expanded.delete(key);
        else expanded.add(key);
        render();
      },
      open ? "Hide this task's edits" : `Show all ${card.count} edits from this task`,
    );
    row.dataset.change = card.change;
    row.dataset.agent = card.agent;
    return row;
  }

  function trailRow(id: string, title: string, badge: string | undefined, date: number, t: number): HTMLElement {
    const r = button(`wf-trail-row${selected === id ? " wf-selected" : ""}`, [h("span", "wf-trail-title", title || "edit"), badge ? h("span", "wf-badge wf-badge-warn", badge) : null, h("time", "wf-time", relTime(date, t))], () => select(id));
    r.dataset.id = id;
    return r;
  }

  function eventRow(r: FeedRow, t: number): HTMLElement {
    const fresh = s.isFresh(r.id, t);
    const el = h(
      "article",
      `wf-row${selected === r.id ? " wf-selected" : ""}${fresh ? " wf-fresh" : ""}${r.rejected ? " wf-rejected" : ""}`,
      h("span", `wf-avatar ${agentClass(r.who)} wf-actor-${r.actorType}`, avatarText(r)),
      h(
        "div",
        "wf-row-main",
        h(
          "div",
          "wf-row-head",
          h("span", "wf-who", r.who),
          r.taskLabel ? h("span", "wf-task", `· ${r.taskLabel}`) : null,
          h("time", "wf-time", relTime(r.date, t)),
        ),
        h("p", "wf-summary", r.summary),
        h(
          "div",
          "wf-row-meta",
          r.symbols.length
            ? r.symbols.map((c) => h("span", c.write ? "wf-sym wf-sym-write" : "wf-sym", `${c.write ? "✎" : "◉"} ${c.name}`))
            : r.file
              ? h("span", "wf-file", `${r.file}${r.moreFiles ? `  +${r.moreFiles}` : ""}`)
              : null,
          r.moreSymbols ? h("span", "wf-more", `+${r.moreSymbols}`) : null,
          s.log.repos.length > 1 ? h("span", "wf-repo-tag", r.repo) : null,
          h("span", `wf-kind${r.tint ? ` wf-tint-${r.tint}` : ""}`, r.badge),
        ),
        r.record.diagnostics.map((d, i) => callout(squiggleOf(r.record, d, i), true)),
      ),
    );
    el.dataset.id = r.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.addEventListener("click", () => select(r.id));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        select(r.id);
      }
    });
    return el;
  }

  function avatarText(r: { who: string; actorType: string; harness?: string }): string {
    if (r.actorType === "human") return "👤";
    if (r.actorType === "system") return "⚙";
    return (r.harness ?? r.who).slice(0, 2).toUpperCase();
  }

  /** A squiggle the way an editor shows it, with "caused by <agent> · event #N" → the cause. */
  function callout(q: Squiggle, compact: boolean): HTMLElement {
    const el = h(
      "div",
      `wf-callout wf-sev-${q.severity}`,
      h("span", "wf-sev-icon", q.severity === "error" ? "⛔" : q.severity === "warning" ? "⚠" : "ℹ"),
      h(
        "div",
        "wf-callout-main",
        h("div", "wf-callout-head", h("span", "wf-squiggle", q.symbol || displayKey(q.symbolKey)), h("span", "wf-code", codeLabel(q.code))),
        h("p", compact ? "wf-message wf-clamp" : "wf-message", q.message),
        !compact && q.suggestion ? h("p", "wf-suggestion", q.suggestion) : null,
        button("wf-cause", [q.causeText, " ›"], () => select(q.cause.id), "Open the event that caused this"),
      ),
    );
    el.dataset.cause = q.cause.id;
    return el;
  }

  // ------------------------------------------------------------ detail

  function renderDetail(t: number): void {
    const p = selected ? parseId(selected) : undefined;
    if (!p) {
      detail.replaceChildren(h("p", "wf-empty", "Select a change to see its diff, squiggles and actions."));
      return;
    }
    const e = s.log.event(p.repo, p.seq);
    if (!e) {
      detail.replaceChildren(h("p", "wf-empty", `Loading ${p.repo} #${p.seq}…`));
      return;
    }
    const paused = e.agent ? s.log.isPaused(e.agent, e.repo) : false;
    const opts = actionsFor(e, s.log);
    const parts: Child[] = [
      h(
        "div",
        "wf-detail-head",
        h("span", `wf-avatar wf-avatar-lg ${agentClass(e.agent ?? e.actor.id)} wf-actor-${e.actor.type}`, avatarText({ who: e.agent ?? e.actor.id, actorType: e.actor.type, ...(e.actor.harness ? { harness: e.actor.harness } : {}) })),
        h(
          "div",
          "wf-detail-who",
          h("div", null, h("strong", null, e.agent ?? e.actor.id), e.actor.harness ? h("span", "wf-dim", ` ${e.actor.harness}`) : null, paused ? h("span", "wf-paused", "PAUSED") : null),
          h("div", "wf-dim wf-detail-meta", `${e.repo} · #${e.seq} · ${new Date(epochMs(e.ts)).toLocaleString()} · ${relTime(epochMs(e.ts), t)}`),
        ),
        h("span", `wf-kind${feedRow(e).tint ? ` wf-tint-${feedRow(e).tint}` : ""}`, feedRow(e).badge),
      ),
      h("p", "wf-detail-summary", summaryWithActor(e)),
      e.status === "rejected" ? h("p", "wf-blocked", e.mode === "check" ? "✋ Weft stopped this edit before it was made." : "✋ Weft rejected this submission.") : null,
      opts.length ? actionBar(opts) : null,
      composer ? composerForm(composer) : null,
      notice ? h("p", notice.error ? "wf-notice wf-notice-error" : "wf-notice", notice.text) : null,
    ];
    if (e.kind === "edit") parts.push(diffSection(e));
    if (e.intent) parts.push(section("Intent", h("p", null, e.intent)));
    if (e.diagnostics.length) parts.push(section("Squiggles", e.diagnostics.map((d, i) => callout(squiggleOf(e, d, i), false))));
    parts.push(kindSection(e));
    if (e.kind !== "edit") parts.push(diffSection(e));
    if (e.writes.length) parts.push(section("Writes", h("ul", "wf-keys", e.writes.map((w) => h("li", null, h("code", null, displayKey(w.key)), h("span", "wf-dim", ` ${symbolFile(w.key)}`), h("span", w.kind === "signature" || w.kind === "deleted" ? "wf-tag wf-tag-strong" : "wf-tag", w.kind))))));
    if (e.reads.length) parts.push(section("Reads", h("ul", "wf-keys", e.reads.map((k) => h("li", null, h("code", null, displayKey(k)), h("span", "wf-dim", ` ${symbolFile(k)}`))))));
    const thread = s.log.thread(e);
    if (thread.length > 1 || (e.kind.startsWith("negotiate.") && thread.length)) parts.push(section("Negotiation", thread.map((x) => linkRow(x, x.seq === e.seq))));
    if (e.task) {
      const cands = s.log.candidates(e.task, e.repo);
      parts.push(
        section(
          cands.length > 1 ? `Task · ${cands.length} candidates` : "Task",
          h("p", null, s.log.taskTitle(e.task) ?? e.task),
          e.change ? h("p", "wf-dim", h("code", null, e.change)) : null,
          cands.map((c) =>
            button(
              "wf-candidate",
              [h("span", agentClass(c.agent), c.agent), h("code", "wf-dim", ` ${c.change.slice(0, 12)}`), c.reverted ? h("span", "wf-tag wf-tint-red", "reverted") : c.landedSeq ? h("span", "wf-tag wf-tint-green", "landed") : null, c.approved ? h("span", "wf-tag", "approved") : null],
              () => select(`${e.repo}#${c.latest}`),
            ),
          ),
        ),
      );
    }
    parts.push(
      section(
        "Provenance",
        h(
          "dl",
          "wf-dl",
          e.tool ? [h("dt", null, "Tool"), h("dd", null, [e.tool.name, e.tool.harness_event].filter(Boolean).join(" · "))] : null,
          e.base_seq !== undefined ? [h("dt", null, "Based on"), h("dd", null, e.base_seq ? button("wf-link", `#${e.base_seq}`, () => select(`${e.repo}#${e.base_seq}`)) : "#0")] : null,
          e.mode ? [h("dt", null, "Mode"), h("dd", null, e.mode === "check" ? "pre-edit check" : "commit")] : null,
          e.session ? [h("dt", null, "Session"), h("dd", null, h("code", null, e.session))] : null,
        ),
      ),
    );
    const scroll = detail.scrollTop;
    detail.replaceChildren();
    add(detail, parts);
    detail.scrollTop = scroll;
  }

  function section(title: string, ...children: Child[]): HTMLElement {
    return h("section", "wf-detail-section", h("h3", null, title), children);
  }

  function linkRow(x: FeedEvent, current: boolean): HTMLElement {
    const r = feedRow(x);
    return button(current ? "wf-link-row wf-selected" : "wf-link-row", [h("span", agentClass(r.who), r.who), h("span", `wf-kind${r.tint ? ` wf-tint-${r.tint}` : ""}`, r.badge), h("span", "wf-link-text", r.summary), h("span", "wf-dim", `#${x.seq}`)], () => select(idOf(x)));
  }

  function kindSection(e: FeedEvent): Child {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const target = (p.target ?? {}) as Record<string, unknown>;
    const to = (p.to ?? {}) as Record<string, unknown>;
    const dl = (rows: [string, Child][]) => h("dl", "wf-dl", rows.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
    switch (e.kind) {
      case "land": {
        const rv = s.log.revertOf(e);
        return section("Landing", dl([["Commit", str(p.sha)], ["Trunk", str(p.trunk_ref)], ["Operation", str(p.op_id)]]), rv ? button("wf-link wf-tint-red", `Reverted in #${rv.seq}: ${str(rv.payload?.reason) ?? rv.summary}`, () => select(idOf(rv))) : null);
      }
      case "revert":
        return section("Revert", dl([["Undoes", typeof p.reverts_seq === "number" ? button("wf-link", `landing #${p.reverts_seq}`, () => select(`${e.repo}#${p.reverts_seq}`)) : undefined], ["Reason", str(p.reason)], ["Commit", str(p.sha)]]));
      case "message":
        return section("Message", dl([["To", str(to.agent) ?? str(to.change)], ["Kind", str(p.intent)]]), str(p.text) ? h("p", "wf-message-text", str(p.text)) : null);
      case "control":
        return section("Human action", dl([["Action", str(p.action)], ["Target", str(target.agent) ?? str(target.change) ?? (typeof target.seq === "number" ? `#${target.seq}` : undefined)], ["Reason", str(p.reason)]]));
      case "checkpoint":
        return section("Checkpoint", dl([["Commit", str(p.sha)], ["Branch", str(p.ref)]]));
      default:
        return null;
    }
  }

  function diffSection(e: FeedEvent): Child {
    if (!mayHaveDiff(e)) return null;
    if (e.diff === undefined) return section("Diff", h("p", "wf-dim", "Loading diff…"));
    const stats = lineStats(e.diff);
    const table = h("div", "wf-diff");
    table.setAttribute("role", "table");
    for (const l of parseDiff(e.diff)) {
      if (l.kind === "file") table.appendChild(h("div", "wf-diff-file", l.text));
      else if (l.kind === "hunk") table.appendChild(h("div", "wf-diff-hunk", l.text));
      else
        table.appendChild(
          h("div", `wf-diff-line wf-diff-${l.kind}`, h("span", "wf-ln", l.old ?? ""), h("span", "wf-ln", l.new ?? ""), h("span", "wf-sign", l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "), h("code", "wf-code-text", l.text)),
        );
    }
    const head = h("h3", null, "Diff ", h("span", "wf-add", `+${stats.added}`), " ", h("span", "wf-del", `−${stats.removed}`));
    return h("section", "wf-detail-section", head, table, e.files.length ? h("p", "wf-dim wf-files", e.files.join(", ")) : null);
  }

  // ------------------------------------------------------------ actions

  function actionBar(opts: ActionOption[]): HTMLElement {
    return h(
      "div",
      "wf-actions",
      opts.map((op) => {
        const b = button(`wf-action wf-action-${op.kind}${op.destructive ? " wf-destructive" : ""}`, [h("span", "wf-action-icon", ICON[op.kind]), op.title], () => {
          notice = undefined;
          if (op.needsText) {
            composer = { option: op, value: "", sending: false };
            render();
            return;
          }
          void run(op, {});
        }, op.label);
        b.dataset.action = op.kind;
        return b;
      }),
    );
  }

  function composerForm(c: Composer): HTMLElement {
    const form = h("form", "wf-composer");
    const input = c.option.kind === "message" ? h("textarea", "wf-input") : h("input", "wf-input");
    input.setAttribute("name", c.option.needsText ?? "text");
    input.setAttribute("aria-label", c.option.label);
    (input as HTMLInputElement).placeholder =
      c.option.kind === "message" ? `Message ${c.option.agent} (steer: delivered to its inbox)` : c.option.kind === "undo" ? "Why undo this landing?" : "Note (optional)";
    (input as HTMLInputElement).value = c.value;
    input.addEventListener("input", () => (c.value = (input as HTMLInputElement).value));
    const send = h("button", c.option.destructive ? "wf-action wf-destructive" : "wf-action wf-primary", c.sending ? "Sending…" : c.option.kind === "message" ? "Send" : c.option.title);
    send.type = "submit";
    send.disabled = c.sending;
    const cancel = button("wf-action", "Cancel", () => {
      composer = undefined;
      render();
    });
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (c.option.kind === "message" && !c.value.trim()) return;
      void run(c.option, c.option.kind === "message" ? { text: c.value.trim() } : c.option.kind === "undo" ? { reason: c.value.trim() } : { note: c.value.trim() });
    });
    add(form, [h("label", "wf-composer-label", c.option.label), input, h("div", "wf-composer-buttons", send, cancel), c.error ? h("p", "wf-notice wf-notice-error", c.error) : null]);
    queueMicrotask(() => input.focus());
    return form;
  }

  async function run(op: ActionOption, input: { text?: string; reason?: string; note?: string }): Promise<void> {
    if (composer) composer.sending = true;
    render();
    try {
      const rec = await s.act(op, input);
      composer = undefined;
      notice = { text: `${op.title} sent · logged as #${rec.seq}`, error: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (composer) {
        composer.sending = false;
        composer.error = msg;
      } else notice = { text: msg, error: true };
    }
    render();
  }

  // ------------------------------------------------------------ lifecycle

  function render(): void {
    const t = now();
    // Keep focus/typing in the composer across live re-renders.
    const active = document.activeElement;
    const typing = !!composer && !!active && detail.contains(active) && !!active.closest(".wf-composer");
    renderHeader(t);
    renderList(t);
    if (!typing) renderDetail(t);
  }

  render();
  if (selected) select(selected);

  return {
    select,
    setFilter(f) {
      filter = f;
      render();
    },
    render,
    destroy() {
      off();
      clearInterval(ticker);
      clearTimeout(scheduled);
      root.replaceChildren();
      root.classList.remove("wf-root");
    },
    root,
  };
}

const ICON: Record<ActionOption["kind"], string> = { message: "💬", pause: "⏸", resume: "▶", approve: "✓", undo: "↶" };
