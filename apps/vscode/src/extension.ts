// Weft for VS Code and its forks (Cursor, Windsurf, Kiro, Antigravity, VSCodium, Trae).
//
// The extension host owns one gateway connection (ObserverClient + FeedSession from
// @weft/feed) and drives four surfaces from its log:
//   - the feed webview in the panel (@weft/feed/view, mirrored over postMessage; no network or
//     token in the webview);
//   - `weft-event:` documents and the native diff editor for any record's diff;
//   - a DiagnosticCollection "weft" with the open squiggles of this workspace's changes, each
//     linked to its cause, plus a code action "Open causing event";
//   - commands and buttons for approve, undo, pause, resume and message (human scope).

import {
  type ActionInput,
  type ActionOption,
  actionBody,
  actionsFor,
  diffSides,
  editingNow,
  type FeedEvent,
  FeedSession,
  feedRow,
  idOf,
  mayHaveDiff,
  ObserverClient,
  openSquiggles,
  parseId,
  renderText,
  repoForFolder,
  type Squiggle,
  type StreamStatus,
  WeftHttpError,
} from "@weft/feed";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RpcError, ToHost, ToView } from "./bridge";
import { type Checkout, localPath, readCheckout, type Resolved, resolveTarget, type TokenCandidate, tokenCandidates } from "./config";
import { diagnosticMessage, placeSymbol, severityOf } from "./place";

const SECRET_KEY = "weft.token";
const SCHEME = "weft-event";
const VIEW_ID = "weft.feed";

type Folder = { folder: vscode.WorkspaceFolder; checkout: Checkout; target: Resolved; repo?: string };

export type WeftApi = {
  /** For tests and the demo rig: current state, no tokens. */
  state(): { url?: string; status: StreamStatus | "no-token"; tokenWhere?: string; repos: string[]; records: number; views: number; canAct: boolean; squiggles: { file: string; message: string; line: number }[]; editing: { agent: string; title?: string }[] };
  session(): FeedSession | undefined;
  reconnect(): Promise<void>;
};

export function activate(ctx: vscode.ExtensionContext): WeftApi {
  const ext = new WeftExtension(ctx);
  void ext.connect();
  return {
    state: () => ext.publicState(),
    session: () => ext.session,
    reconnect: () => ext.connect(),
  };
}

export function deactivate(): void {}

class WeftExtension {
  session?: FeedSession;
  private client?: ObserverClient;
  private tokens: TokenCandidate[] = [];
  private actTokenIndex = 0;
  private canAct = true;
  private url?: string;
  private folders: Folder[] = [];
  private status: StreamStatus | "no-token" = "connecting";
  private lastSquiggles: Squiggle[] = [];
  private views = new Set<vscode.WebviewView>();
  private selected?: string;
  private off?: () => void;
  private repoTimer?: ReturnType<typeof setInterval>;
  private diagTimer?: ReturnType<typeof setTimeout>;
  private streamed = new Set<string>();
  private perRepo = false;
  private readonly out = vscode.window.createOutputChannel("Weft");
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("weft");
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly docs = new EventDocs(this);

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const c = ctx.subscriptions;
    c.push(this.out, this.diagnostics, this.statusItem);
    c.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.docs));
    c.push(vscode.window.registerWebviewViewProvider(VIEW_ID, { resolveWebviewView: (v) => this.resolveView(v) }, { webviewOptions: { retainContextWhenHidden: true } }));
    // The provider reads this collection (VS Code hands providers copies of diagnostics without
    // the extra fields, and not every caller passes them).
    const ours = (uri: vscode.Uri, range: vscode.Range) => ((this.diagnostics.get(uri) ?? []) as readonly WeftDiagnostic[]).filter((d) => d.range.intersection(range) !== undefined);
    c.push(vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new CauseActions(ours), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
    const cmd = (id: string, fn: (...a: never[]) => unknown) => c.push(vscode.commands.registerCommand(id, fn));
    cmd("weft.showFeed", () => this.reveal());
    cmd("weft.openEvent", (id?: string) => this.openEvent(id));
    cmd("weft.openCausingEvent", (id?: string) => this.openCausingEvent(id));
    cmd("weft.openDiff", (id?: string) => this.openDiff(id));
    cmd("weft.approve", (arg?: unknown) => this.action("approve", arg));
    cmd("weft.undo", (arg?: unknown) => this.action("undo", arg));
    cmd("weft.pause", (arg?: unknown) => this.action("pause", arg));
    cmd("weft.resume", (arg?: unknown) => this.action("resume", arg));
    cmd("weft.message", (arg?: unknown) => this.action("message", arg));
    cmd("weft.setToken", () => this.setToken());
    cmd("weft.clearToken", () => this.clearToken());
    cmd("weft.reconnect", () => this.connect());
    cmd("weft.showLog", () => this.out.show());
    c.push(
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("weft") && void this.connect()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.connect()),
      vscode.workspace.onDidOpenTextDocument(() => this.scheduleDiagnostics()),
      vscode.workspace.onDidChangeTextDocument(() => this.scheduleDiagnostics(500)),
      vscode.workspace.onDidCreateFiles(() => this.scheduleDiagnostics()),
      ctx.secrets.onDidChange((e) => e.key === SECRET_KEY && void this.connect()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.connect()),
      { dispose: () => this.disconnect() },
    );
    this.statusItem.command = "weft.showFeed";
    this.statusItem.name = "Weft";
    this.renderStatus();
    this.statusItem.show();
  }

  log(msg: string): void {
    this.out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  // ------------------------------------------------------------ connection

  private readFolders(): Folder[] {
    const cfg = vscode.workspace.getConfiguration("weft");
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      // An untrusted workspace's .weft/ is ignored entirely: a cloned repo could plant a gateway
      // URL there (and receive WEFT_TOKEN / the saved token) or a token.
      const checkout: Checkout = vscode.workspace.isTrusted ? readCheckout(folder.uri.fsPath) : { root: folder.uri.fsPath, agents: [], prefix: "", tokenFiles: [] };
      const target = resolveTarget({ settingUrl: cfg.get<string>("url"), settingRepo: cfg.get<string>("repo"), checkout });
      return { folder, checkout, target, ...(target.repo ? { repo: target.repo } : {}) };
    });
  }

  disconnect(): void {
    this.off?.();
    this.off = undefined;
    this.session?.stop();
    this.session = undefined;
    clearInterval(this.repoTimer);
    this.streamed.clear();
  }

  async connect(): Promise<void> {
    this.disconnect();
    this.folders = this.readFolders();
    const main = this.folders.find((f) => f.checkout.url) ?? this.folders[0];
    const cfg = vscode.workspace.getConfiguration("weft");
    const target = main?.target ?? resolveTarget({ settingUrl: cfg.get<string>("url"), settingRepo: cfg.get<string>("repo") });
    this.url = target.url;
    const secret = await this.ctx.secrets.get(SECRET_KEY);
    this.tokens = tokenCandidates({ url: target.url, ...(target.repo ? { repo: target.repo } : {}), ...(main ? { checkout: main.checkout } : {}), ...(secret ? { secret } : {}) });
    this.actTokenIndex = 0;
    this.canAct = true;
    this.log(`gateway ${target.url} (from ${target.urlFrom}); repo ${target.repo ?? "(any)"}${target.repoFrom ? ` (from ${target.repoFrom})` : ""}; tokens: ${this.tokens.map((t) => t.where).join(", ") || "none"}`);
    if (!this.tokens.length) {
      this.status = "no-token";
      this.renderStatus();
      this.broadcastInit();
      return;
    }
    const WS = (globalThis as { WebSocket?: unknown }).WebSocket;
    this.client = new ObserverClient({ baseUrl: target.url, token: this.tokens[0]!.token });
    // Per-repo sockets when this extension host has WebSocket (Node >= 22); else poll /v1/feed.
    this.perRepo = !!WS;
    const session = new FeedSession(this.client, { perRepoStreams: this.perRepo });
    this.session = session;
    this.status = "connecting";
    let lastStatus = session.status;
    this.off = session.on((added) => {
      if (added.length) this.post({ t: "events", events: added, live: true });
      if (session.status !== lastStatus) {
        lastStatus = session.status;
        this.status = session.status;
        this.post({ t: "status", status: session.status, ...(session.error ? { detail: session.error } : {}) });
        this.log(`stream ${session.status}${session.error ? `: ${session.error}` : ""}`);
      }
      this.docs.refresh(added);
      this.scheduleDiagnostics(added.length ? 50 : 300);
      this.renderStatus();
    });
    await session.start();
    if (this.session !== session) return;
    this.status = session.status;
    for (const r of session.repoList) this.streamed.add(r.repo);
    this.resolveRepoGuesses();
    this.log(`connected: ${session.repoList.length} repo(s) visible: ${session.repoList.map((r) => r.repo).join(", ")}`);
    this.broadcastInit();
    this.scheduleDiagnostics(0);
    this.renderStatus();
    this.repoTimer = setInterval(() => void this.refreshRepos(), 10_000);
  }

  /** A folder with no .weft/ config maps to a visible repo named like the folder. */
  private resolveRepoGuesses(): void {
    const visible = new Set(this.session?.repoList.map((r) => r.repo) ?? []);
    for (const f of this.folders) {
      if (f.repo) continue;
      const guess = repoForFolder(f.folder.uri.fsPath);
      if (guess && visible.has(guess)) f.repo = guess;
    }
  }

  private async refreshRepos(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.refreshRepos();
    } catch {
      return;
    }
    this.post({ t: "repos", repos: s.repoList });
    // Per-repo streams cover the repos known at start; a new repo needs a restart (the log is kept).
    if (this.perRepo && s.repoList.some((r) => !this.streamed.has(r.repo))) {
      for (const r of s.repoList) this.streamed.add(r.repo);
      this.log("new repo visible; restarting streams");
      await s.start();
    }
    this.resolveRepoGuesses();
    this.renderStatus();
  }

  workspaceRepos(): string[] {
    return [...new Set(this.folders.map((f) => f.repo).filter((r): r is string => !!r))];
  }

  publicState(): ReturnType<WeftApi["state"]> {
    const s = this.session;
    const t = this.tokens[0];
    return {
      ...(this.url ? { url: this.url } : {}),
      status: this.status,
      ...(t ? { tokenWhere: t.where } : {}),
      repos: this.workspaceRepos(),
      records: s?.log.size ?? 0,
      views: this.views.size,
      canAct: this.canAct,
      squiggles: [...this.diagnostics].flatMap(([uri, ds]) => ds.map((d) => ({ file: uri.fsPath, message: d.message, line: d.range.start.line }))),
      editing: s ? editingNow(s.log.combined.filter((e) => this.workspaceRepos().includes(e.repo))).map((e) => ({ agent: e.agent, ...(e.title ? { title: e.title } : {}) })) : [],
    };
  }

  // ------------------------------------------------------------ status bar

  renderStatus(): void {
    const it = this.statusItem;
    if (this.status === "no-token") {
      it.text = "$(circle-slash) Weft: no token";
      it.tooltip = "Weft found no token. Run “Weft: Set token”, set WEFT_TOKEN, or run npx @celador/weft in this repo.";
      it.command = "weft.setToken";
      return;
    }
    it.command = "weft.showFeed";
    const s = this.session;
    const repos = this.workspaceRepos();
    const now = Date.now();
    const editing = s ? editingNow(s.log.combined.filter((e) => !repos.length || repos.includes(e.repo)), now) : [];
    const agents = new Set(editing.map((e) => e.agent)).size;
    const squig = [...this.diagnostics].reduce((n, [, d]) => n + d.length, 0);
    const live = s?.isLive(now);
    const icon = !s ? "$(sync~spin)" : live ? "$(pulse)" : s.status === "error" ? "$(error)" : s.status === "offline" ? "$(debug-disconnect)" : "$(sync~spin)";
    const repoLabel = repos.length === 1 ? repos[0] : repos.length ? `${repos.length} repos` : "Weft";
    it.text = `${icon} ${repoLabel} · ${agents} editing${squig ? ` · $(warning) ${squig}` : ""}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Weft** · ${s ? s.header(now).text : "connecting"}\n\n`);
    md.appendMarkdown(`Gateway: \`${this.url ?? "?"}\`  \nToken: ${this.tokens[0]?.where ?? "none"}${this.canAct ? "" : " (read-only)"}\n\n`);
    if (editing.length) md.appendMarkdown(`Editing now:\n${editing.map((e) => `- ${e.who}: ${e.title ?? e.task ?? e.change} (${e.count} edit${e.count === 1 ? "" : "s"})${e.conflicted ? " ⚠" : ""}`).join("\n")}\n\n`);
    md.appendMarkdown(`${squig} open squiggle${squig === 1 ? "" : "s"} in this workspace. Click to open the feed.`);
    it.tooltip = md;
  }

  // ------------------------------------------------------------ squiggles

  scheduleDiagnostics(ms = 100): void {
    clearTimeout(this.diagTimer);
    this.diagTimer = setTimeout(() => this.updateDiagnostics(), ms);
  }

  private updateDiagnostics(): void {
    const s = this.session;
    const mode = vscode.workspace.getConfiguration("weft").get<string>("squiggles", "auto");
    if (!s || mode === "off") {
      this.diagnostics.clear();
      this.renderStatus();
      return;
    }
    const maxAgeH = vscode.workspace.getConfiguration("weft").get<number>("squiggleMaxAgeHours", 24);
    const open = openSquiggles(s.log, { repos: this.workspaceRepos(), ...(maxAgeH > 0 ? { maxAgeMs: maxAgeH * 3600_000 } : {}) });
    this.lastSquiggles = open;
    const byFile = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    for (const f of this.folders) {
      if (!f.repo) continue;
      const mine = new Set(f.checkout.agents.map((a) => a.change).filter(Boolean));
      for (const q of open) {
        if (q.repo !== f.repo || !q.file) continue;
        if (mode === "auto" && mine.size && (!q.change || !mine.has(q.change))) continue;
        const rel = localPath(q.file, f.checkout.prefix);
        if (!rel) continue;
        const uri = vscode.Uri.joinPath(f.folder.uri, rel);
        if (!existsSync(uri.fsPath)) continue;
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        let text = doc?.getText();
        if (text === undefined) {
          try {
            text = readFileSync(uri.fsPath, "utf8");
          } catch {
            continue;
          }
        }
        const p = placeSymbol(text, q.symbol, { ...(q.line !== undefined ? { line: q.line } : {}), ...(q.column !== undefined ? { column: q.column } : {}) });
        const d = new vscode.Diagnostic(new vscode.Range(p.line, p.start, p.line, p.end), diagnosticMessage(q), severityOf(q.severity) as vscode.DiagnosticSeverity);
        d.source = "Weft";
        d.code = { value: q.code, target: this.docs.recordUri(q.cause.repo, q.cause.seq) };
        const causeLoc = new vscode.Location(this.docs.recordUri(q.cause.repo, q.cause.seq), new vscode.Position(0, 0));
        d.relatedInformation = [new vscode.DiagnosticRelatedInformation(causeLoc, `${q.causeText}: ${q.cause.agent}${q.cause.task ? ` (${s.log.taskTitle(q.cause.task) ?? q.cause.task})` : ""} changed this`)];
        (d as WeftDiagnostic).weft = { cause: q.cause.id, on: q.on, agent: q.agent };
        const key = uri.toString();
        let entry = byFile.get(key);
        if (!entry) byFile.set(key, (entry = { uri, list: [] }));
        entry.list.push(d);
      }
    }
    this.diagnostics.clear();
    for (const { uri, list } of byFile.values()) this.diagnostics.set(uri, list);
    this.renderStatus();
  }

  // ------------------------------------------------------------ webview

  private resolveView(view: vscode.WebviewView): void {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = webviewHtml(view.webview, media);
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
    view.webview.onDidReceiveMessage((m: ToHost) => void this.onViewMessage(view, m));
  }

  private post(m: ToView): void {
    for (const v of this.views) void v.webview.postMessage(m);
  }

  private initMessage(): ToView {
    const s = this.session;
    return {
      t: "init",
      events: s?.log.combined ?? [],
      repos: s?.repoList ?? [],
      status: this.status === "no-token" ? "error" : (s?.status ?? "connecting"),
      ...(this.status === "no-token" ? { error: "No Weft token. Run “Weft: Set token”, set WEFT_TOKEN, or run npx @celador/weft in this repo." } : s?.error ? { error: s.error } : {}),
      title: "Weft",
      ...(this.selected ? { selected: this.selected } : {}),
      canAct: this.canAct,
      ...(this.tokens[0] ? { tokenWhere: this.tokens[0].where } : {}),
    };
  }

  private broadcastInit(): void {
    this.post(this.initMessage());
  }

  private async onViewMessage(view: vscode.WebviewView, m: ToHost): Promise<void> {
    switch (m.t) {
      case "ready":
        void view.webview.postMessage(this.initMessage());
        return;
      case "selected":
        this.selected = m.id;
        return;
      case "openDiff":
        await this.openDiff(m.id);
        return;
      case "openFile":
        await this.openRepoFile(m.repo, m.file);
        return;
      case "command":
        if (m.command === "setToken") await this.setToken();
        else this.session?.wake();
        return;
      case "rpc": {
        const reply = (r: ToView) => void view.webview.postMessage(r);
        try {
          const value = await this.rpc(m.m, m.args);
          reply({ t: "rpc", id: m.id, ok: true, value });
        } catch (e) {
          reply({ t: "rpc", id: m.id, ok: false, error: rpcError(e) });
        }
      }
    }
  }

  private async rpc(m: string, args: unknown[]): Promise<unknown> {
    const s = this.session;
    if (!s || !this.client) throw new WeftHttpError(401, "no_token", "No Weft token. Run “Weft: Set token”.");
    switch (m) {
      case "repos":
        return s.repoList.length ? s.repoList : await this.client.repos();
      case "event": {
        const [repo, seq] = args as [string, number];
        const e = await s.loadDetail(repo, seq);
        if (!e) throw new WeftHttpError(404, "not_found", `${repo} #${seq} not found`);
        return e;
      }
      case "act": {
        const [repo, body] = args as [string, ReturnType<typeof actionBody>];
        return await this.sendAction(repo, body);
      }
    }
    throw new Error(`unknown call ${m}`);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  // ------------------------------------------------------------ events and diffs

  event(id: string): FeedEvent | undefined {
    const p = parseId(id);
    return p ? this.session?.log.event(p.repo, p.seq) : undefined;
  }

  async loadEvent(id: string): Promise<FeedEvent | undefined> {
    const p = parseId(id);
    if (!p || !this.session) return undefined;
    const held = this.session.log.event(p.repo, p.seq);
    if (held && (held.diff !== undefined || !mayHaveDiff(held))) return held;
    return this.session.loadDetail(p.repo, p.seq);
  }

  private async pickEvent(placeholder: string, filter: (e: FeedEvent) => boolean = () => true): Promise<string | undefined> {
    const s = this.session;
    if (!s) return undefined;
    const items = s.log.combined
      .filter(filter)
      .slice(0, 200)
      .map((e) => {
        const r = feedRow(e, s.log);
        return { label: `#${e.seq} ${r.who}: ${r.summary}`, description: `${e.repo} · ${r.badge}`, id: idOf(e) };
      });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
    return pick?.id;
  }

  async openEvent(id?: string): Promise<void> {
    id ??= await this.pickEvent("Open a Weft event");
    if (!id) return;
    this.selected = id;
    await this.reveal();
    this.post({ t: "select", id });
  }

  async openCausingEvent(id?: string): Promise<void> {
    if (!id) {
      const q = await vscode.window.showQuickPick(
        this.lastSquiggles.map((x) => ({ label: `${x.symbol || x.file}: ${x.label}`, description: x.causeText, id: x.cause.id })),
        { placeHolder: "Open the event that caused a squiggle" },
      );
      id = q?.id;
    }
    if (!id) return;
    await this.openEvent(id);
    await this.openDiff(id, { preserveFocus: true });
  }

  async openDiff(id?: string, o: { preserveFocus?: boolean } = {}): Promise<void> {
    id ??= await this.pickEvent("Open the diff of a Weft event", (e) => mayHaveDiff(e));
    if (!id) return;
    const e = await this.loadEvent(id);
    if (!e) return void vscode.window.showWarningMessage(`Weft: ${id} is not available.`);
    if (!e.diff) return void vscode.window.showInformationMessage(`Weft: ${id} has no diff.`);
    const sides = diffSides(e.diff);
    const who = e.agent ?? e.actor.id;
    if (sides.length === 1) {
      const sd = sides[0]!;
      await vscode.commands.executeCommand("vscode.diff", this.docs.sideUri(e.repo, e.seq, "before", sd.file), this.docs.sideUri(e.repo, e.seq, "after", sd.file), `${sd.file} · ${who} · ${e.repo} #${e.seq}`, { preview: true, preserveFocus: !!o.preserveFocus });
      return;
    }
    const resources = sides.map((sd) => [this.localUri(e.repo, sd.file) ?? this.docs.sideUri(e.repo, e.seq, "after", sd.file), this.docs.sideUri(e.repo, e.seq, "before", sd.file), this.docs.sideUri(e.repo, e.seq, "after", sd.file)]);
    try {
      await vscode.commands.executeCommand("vscode.changes", `${who} · ${e.repo} #${e.seq} (${sides.length} files)`, resources);
    } catch {
      const pick = await vscode.window.showQuickPick(sides.map((x) => x.file), { placeHolder: `${e.repo} #${e.seq} changed ${sides.length} files` });
      if (pick) await vscode.commands.executeCommand("vscode.diff", this.docs.sideUri(e.repo, e.seq, "before", pick), this.docs.sideUri(e.repo, e.seq, "after", pick), `${pick} · ${who} · ${e.repo} #${e.seq}`);
    }
  }

  localUri(repo: string, file: string): vscode.Uri | undefined {
    for (const f of this.folders) {
      if (f.repo !== repo) continue;
      const rel = localPath(file, f.checkout.prefix);
      if (rel && existsSync(join(f.folder.uri.fsPath, rel))) return vscode.Uri.joinPath(f.folder.uri, rel);
    }
    return undefined;
  }

  private async openRepoFile(repo: string, file: string): Promise<void> {
    const uri = this.localUri(repo, file);
    if (!uri) return void vscode.window.showInformationMessage(`Weft: ${file} is not in this workspace.`);
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  // ------------------------------------------------------------ actions

  private agentRecord(repo: string | undefined, agent: string): FeedEvent | undefined {
    return this.session?.log.combined.find((e) => e.agent === agent && (!repo || e.repo === repo));
  }

  /** Commands: an event id (`repo#seq`), `{repo, agent}`, or nothing (pick). */
  async action(kind: ActionOption["kind"], arg?: unknown): Promise<void> {
    const s = this.session;
    if (!s) return void vscode.window.showWarningMessage("Weft is not connected.");
    let options: ActionOption[] = [];
    if (typeof arg === "string" && parseId(arg)) {
      const e = await this.loadEvent(arg);
      if (e) options = actionsFor(e, s.log).filter((o) => o.kind === kind);
    } else if (arg && typeof arg === "object" && "agent" in arg) {
      const a = arg as { repo?: string; agent: string };
      const e = this.agentRecord(a.repo, a.agent);
      if (e) options = actionsFor(e, s.log).filter((o) => o.kind === kind);
    } else {
      options = this.optionsFor(kind);
    }
    if (!options.length) return void vscode.window.showInformationMessage(`Weft: nothing to ${kind} right now.`);
    let option = options[0]!;
    if (options.length > 1) {
      const pick = await vscode.window.showQuickPick(
        options.map((o) => ({ label: o.label, description: `${o.repo}${o.seq ? ` #${o.seq}` : ""}${o.change ? ` · ${o.change.slice(0, 12)}` : ""}`, o })),
        { placeHolder: `${kind[0]!.toUpperCase()}${kind.slice(1)} what?` },
      );
      if (!pick) return;
      option = pick.o;
    }
    const input: ActionInput = {};
    if (kind === "message") {
      const text = await vscode.window.showInputBox({ title: option.label, prompt: "Delivered to the agent's inbox as a steer message.", placeHolder: "What should it do?", validateInput: (v) => (v.trim() ? undefined : "Write a message") });
      if (text === undefined) return;
      input.text = text.trim();
    } else if (kind === "undo") {
      const reason = await vscode.window.showInputBox({ title: `Undo landing #${option.seq} in ${option.repo}`, prompt: "Why undo it? Weft records the reason with the revert.", validateInput: (v) => (v.trim() ? undefined : "A reason is required to undo a landing") });
      if (reason === undefined) return;
      input.reason = reason.trim();
    } else if (kind === "approve") {
      const note = await vscode.window.showInputBox({ title: option.label, prompt: "Optional note for the approval." });
      if (note === undefined) return;
      if (note.trim()) input.note = note.trim();
    }
    try {
      const res = (await this.sendAction(option.repo, actionBody(option, input))) as { record: FeedEvent };
      vscode.window.setStatusBarMessage(`Weft: ${option.label} · logged as #${res.record.seq}`, 6000);
    } catch (e) {
      if (!(e instanceof WeftHttpError && e.readOnly)) void vscode.window.showErrorMessage(`Weft: ${option.label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Every target for `kind` across the workspace's repos (agents seen recently, candidates, lands). */
  private optionsFor(kind: ActionOption["kind"]): ActionOption[] {
    const s = this.session!;
    const repos = this.workspaceRepos();
    const seen = new Set<string>();
    const out: ActionOption[] = [];
    for (const e of s.log.combined) {
      if (repos.length && !repos.includes(e.repo)) continue;
      for (const o of actionsFor(e, s.log)) {
        if (o.kind !== kind) continue;
        const key = `${o.repo}|${o.agent ?? ""}|${o.change ?? ""}|${o.seq ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
    }
    return out;
  }

  /**
   * POST /v1/repos/{repo}/actions with the first token that has the human scope: tokens are
   * tried in lookup order and a 403 (observe-only) moves on to the next one.
   */
  async sendAction(repo: string, body: ReturnType<typeof actionBody>): Promise<unknown> {
    if (!this.url || !this.tokens.length) throw new WeftHttpError(401, "no_token", "No Weft token.");
    let lastErr: unknown;
    const order = [...this.tokens.keys()].sort((a, b) => (a === this.actTokenIndex ? -1 : b === this.actTokenIndex ? 1 : a - b));
    for (const i of order) {
      const t = this.tokens[i]!;
      try {
        const res = await new ObserverClient({ baseUrl: this.url, token: t.token }).act(repo, body);
        this.actTokenIndex = i;
        if (!this.canAct) {
          this.canAct = true;
          this.renderStatus();
        }
        this.log(`${body.action} in ${repo} sent with the token from ${t.where}: logged as #${res.record.seq}`);
        this.session?.log.ingest([res.record]);
        this.post({ t: "events", events: [res.record], live: true });
        this.post({ t: "acted", kind: body.action as ActionOption["kind"], seq: res.record.seq });
        this.scheduleDiagnostics(0);
        return res;
      } catch (e) {
        lastErr = e;
        if (e instanceof WeftHttpError && (e.status === 403 || e.status === 401)) {
          this.log(`${body.action}: the token from ${t.where} was refused (${e.status} ${e.code})`);
          continue;
        }
        throw e;
      }
    }
    if (lastErr instanceof WeftHttpError && (lastErr.status === 403 || lastErr.status === 401)) {
      this.canAct = false;
      this.renderStatus();
      this.broadcastInit();
      void this.explainReadOnly(body.action);
      throw new WeftHttpError(403, "read_only", readOnlyText(body.action, this.tokens));
    }
    throw lastErr;
  }

  private async explainReadOnly(action: string): Promise<void> {
    const pick = await vscode.window.showWarningMessage(readOnlyText(action, this.tokens), { modal: false }, "Set token…", "Show log");
    if (pick === "Set token…") await this.setToken();
    else if (pick === "Show log") this.out.show();
  }

  // ------------------------------------------------------------ token

  async setToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: "Weft: Set token",
      prompt: "A Weft token for this gateway. Observe scope shows the feed and squiggles; approve, undo, pause, resume and message need the human scope. Stored in VS Code's secret storage.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Paste a token"),
    });
    if (!token) return;
    await this.ctx.secrets.store(SECRET_KEY, token.trim());
    vscode.window.setStatusBarMessage("Weft: token saved in secret storage", 4000);
  }

  async clearToken(): Promise<void> {
    await this.ctx.secrets.delete(SECRET_KEY);
    vscode.window.setStatusBarMessage("Weft: token removed from secret storage", 4000);
  }
}

type WeftDiagnostic = vscode.Diagnostic & { weft?: { cause: string; on: string; agent?: string } };

/** "Open causing event" on every Weft squiggle under the cursor. */
class CauseActions implements vscode.CodeActionProvider {
  constructor(private readonly ours: (uri: vscode.Uri, range: vscode.Range) => readonly WeftDiagnostic[]) {}
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    const list = this.ours(doc.uri, range);
    const causeOf = (d: WeftDiagnostic) => d.weft?.cause ?? (d.relatedInformation?.[0] ? causeFromUri(d.relatedInformation[0].location.uri) : undefined);
    const seen = new Set<string>();
    for (const d of [...list, ...(ctx.diagnostics as WeftDiagnostic[])]) {
      if (d.source !== "Weft") continue;
      const cause = causeOf(d);
      if (!cause || seen.has(cause)) continue;
      seen.add(cause);
      const p = parseId(cause)!;
      const a = new vscode.CodeAction(`Open causing event (#${p.seq})`, vscode.CodeActionKind.QuickFix);
      a.command = { command: "weft.openCausingEvent", title: "Open causing event", arguments: [cause] };
      a.diagnostics = [d];
      a.isPreferred = true;
      out.push(a);
      if (d.weft?.on) {
        const m = new vscode.CodeAction(`Show the blocked change in the Weft feed (#${parseId(d.weft.on)?.seq})`, vscode.CodeActionKind.QuickFix);
        m.command = { command: "weft.openEvent", title: "Open in Weft feed", arguments: [d.weft.on] };
        m.diagnostics = [d];
        out.push(m);
      }
    }
    return out;
  }
}

function causeFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const [repo, seq] = uri.path.split("/").filter(Boolean);
  return repo && seq ? `${decodeURIComponent(repo)}#${seq}` : undefined;
}

/**
 * `weft-event:/<repo>/<seq>/<side>/<file>`: one side of a record's diff (side = before|after),
 * and `weft-event:/<repo>/<seq>/record/event-<seq>.md`: the record as text (summary, intent,
 * squiggles, diff). Paths end in the file name so the editor picks the right language.
 */
class EventDocs implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly served = new Set<string>();
  constructor(private readonly ext: WeftExtension) {}

  sideUri(repo: string, seq: number, side: "before" | "after", file: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(repo)}/${seq}/${side}/${file.replace(/^\/+/, "")}` });
  }
  recordUri(repo: string, seq: number): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(repo)}/${seq}/record/event-${seq}.md` });
  }

  /** Re-render served documents when their record arrives with its diff. */
  refresh(added: FeedEvent[]): void {
    for (const key of this.served) {
      const uri = vscode.Uri.parse(key);
      const id = causeFromUri(uri);
      if (id && (!added.length || added.some((e) => idOf(e) === id))) this.changed.fire(uri);
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    this.served.add(uri.toString());
    const [repoEnc, seqS, side, ...rest] = uri.path.split("/").filter(Boolean);
    const repo = decodeURIComponent(repoEnc ?? "");
    const seq = Number(seqS);
    const e = await this.ext.loadEvent(`${repo}#${seq}`);
    if (!e) return `Weft: ${repo} #${seq} is not available (not connected, or the token cannot see this repo).\n`;
    if (side === "record") return recordText(e, this.ext.session);
    const file = rest.join("/");
    if (!e.diff) return "";
    const sd = diffSides(e.diff).find((x) => x.file === file);
    return sd ? (side === "before" ? sd.before : sd.after) : "";
  }
}

function recordText(e: FeedEvent, s: FeedSession | undefined): string {
  const lines = [`# ${e.repo} #${e.seq} · ${e.kind} · ${e.status}`, "", renderText(e, { multiline: true })];
  if (e.intent) lines.push("", `Intent: ${e.intent}`);
  if (e.task) lines.push(`Task: ${s?.log.taskTitle(e.task) ?? e.task}`);
  if (e.diff) lines.push("", "```diff", e.diff.trimEnd(), "```");
  lines.push("", "Open the Weft panel (Weft: Show feed) for actions.");
  return lines.join("\n") + "\n";
}

function readOnlyText(action: string, tokens: TokenCandidate[]): string {
  const where = tokens.map((t) => t.where).join(", ");
  return (
    `Weft refused “${action}”: ${tokens.length === 1 ? "the token" : "none of the tokens"} found (${where}) ${tokens.length === 1 ? "has" : "have"} the human scope. ` +
    `Reading the feed needs observe; approve, undo, pause, resume and message need a token with the human scope. ` +
    `Mint one (scopes observe + human) and run “Weft: Set token”, or start the editor with WEFT_TOKEN set to it.`
  );
}

function rpcError(e: unknown): RpcError {
  if (e instanceof WeftHttpError) return { status: e.status, code: e.code, message: e.message, readOnly: e.readOnly };
  return { status: 0, code: "error", message: e instanceof Error ? e.message : String(e), readOnly: false };
}

function nonce(): string {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/** Strict CSP: only our nonce'd script; styles only from our files (no inline style); no network. */
export function webviewHtml(w: vscode.Webview, media: vscode.Uri): string {
  const n = nonce();
  const src = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
  const csp = [`default-src 'none'`, `script-src 'nonce-${n}'`, `style-src ${w.cspSource}`, `img-src ${w.cspSource} data:`, `font-src ${w.cspSource}`].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${src("dist/feed.css")}">
<link rel="stylesheet" href="${src("vscode.css")}">
<title>Weft</title>
</head>
<body>
<div id="bar" class="wv-bar" hidden></div>
<main id="app"></main>
<script nonce="${n}" src="${src("dist/webview.js")}"></script>
</body>
</html>`;
}
