// The `lsp` backend: language-server enrichment of an edit's read set, and type-aware breakage
// from a peer's change. Asynchronous by design — the adapter runs it after PostToolUse has
// committed the edit, never on the PreToolUse (edit-time) path.
//
// One server per language per checkout, started lazily on first use and shut down by `close()`.
// Server locations are mapped back to WCP keys (`path#Qualified.name`) with the language's
// tree-sitter spec: a location inside a declaration's name (or, failing that, the innermost
// declaration containing it) is that declaration.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Definition, SourceChange, TreeSitterLanguage } from "../language.js";
import { treeSitterLanguageFor } from "../languages/index.js";
import { outlineTreeSitter, type Outline } from "../treesitter.js";
import { spawnServer, type ServerProcess } from "./jsonrpc.js";
import { detectServer, lspServers, type DetectedServer, type LspServerSpec } from "./servers.js";

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetRange: Range; targetSelectionRange?: Range };
export type LspDiagnostic = { range: Range; severity?: number; code?: string | number; source?: string; message: string };

export type LspOptions = {
  /** Absolute checkout root (the server's workspace folder). */
  root: string;
  /** Prepended to every key (the checkout's path inside the repository). */
  prefix?: string;
  env?: NodeJS.ProcessEnv;
  /** Server registry (tests pass a fake server). */
  servers?: LspServerSpec[];
  /** Per-request timeout. */
  timeoutMs?: number;
  /** How long to wait for a file's diagnostics after a change. */
  diagnosticsTimeoutMs?: number;
  /** Quiet period that ends the wait for a file's diagnostics (servers may publish twice). */
  settleMs?: number;
  /** Most identifiers asked about per edit. */
  maxIdentifiers?: number;
  /** Path parts never mapped to keys (virtualenvs, vendored code). */
  skipParts?: string[];
  log?: (message: string) => void;
};

export type EnrichResult = {
  /** Keys the server resolved identifiers in the changed ranges to (all of them, not only new ones). */
  reads: string[];
  /** For each signature/deleted write: keys of the declarations that use it (callers to adapt). */
  dependents: Record<string, string[]>;
  /** `name` of the server(s) used, e.g. `pyright`. Empty when no server applied. */
  servers: string[];
};

export type Breakage = {
  /** Checkout-relative file (prefix included) that uses the peer-changed key. */
  file: string;
  range: Range;
  message: string;
  /** The peer-changed key whose new version breaks this use. */
  key: string;
  server: string;
};

const DEFAULT_SKIP = [".git", ".weft", "node_modules", ".venv", "venv", "site-packages", "__pypackages__", ".tox", "dist", "build", "target"];

type OpenDoc = { version: number; text: string; languageId: string };
type Server = {
  detected: DetectedServer;
  proc: ServerProcess;
  ready: Promise<void>;
  docs: Map<string, OpenDoc>;
  diagnostics: Map<string, { version?: number; items: LspDiagnostic[]; at: number }>;
  waiters: Array<{ uri: string; version?: number; after: number; resolve: () => void }>;
};

/** Line-start table for offset <-> LSP position conversion (UTF-16 characters, the LSP default). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
export function positionAt(text: string, offset: number, starts = lineStarts(text)): Position {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo]! };
}
export function offsetAt(text: string, pos: Position, starts = lineStarts(text)): number {
  const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
  return Math.min(starts[line]! + Math.max(pos.character, 0), text.length);
}

/** Offsets [start, end) of `after` that differ from `before` (common prefix/suffix trimmed to whole lines). */
export function changedSpan(before: string | null, after: string): [number, number] | undefined {
  if (before === null || before === "") return after ? [0, after.length] : undefined;
  if (before === after) return undefined;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  const start = after.lastIndexOf("\n", p - 1) + 1;
  let end = after.indexOf("\n", after.length - s);
  if (end < 0) end = after.length;
  return [start, Math.max(end, start)];
}

/** The declaration a location falls in: the one whose name contains it, else the innermost containing one. */
export function declarationAt(defs: Definition[], offset: number): Definition | undefined {
  const byName = defs.find((d) => d.nameStart !== undefined && d.nameEnd !== undefined && offset >= d.nameStart && offset <= d.nameEnd);
  if (byName) return byName;
  let best: Definition | undefined;
  for (const d of defs) {
    if (d.start === undefined || d.end === undefined || offset < d.start || offset >= d.end) continue;
    if (!best || d.end - d.start < best.end! - best.start!) best = d;
  }
  return best;
}

export class LspEnricher {
  private readonly servers = new Map<string, Promise<Server | undefined>>();
  private readonly outlines = new Map<string, { text: string; outline: Outline }>();
  private readonly prefix: string;
  private readonly skip: Set<string>;

  constructor(private readonly opts: LspOptions) {
    this.prefix = opts.prefix ?? "";
    this.skip = new Set(opts.skipParts ?? DEFAULT_SKIP);
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** Is there a server for this checkout-relative path (installed, and its language has a spec)? */
  available(rel: string): DetectedServer | undefined {
    const language = treeSitterLanguageFor(rel);
    if (!language) return undefined;
    return detectServer(language.id, this.opts.env ?? process.env, this.opts.servers ?? lspServers);
  }

  // ------------------------------------------------------------------ server lifecycle

  private server(language: string): Promise<Server | undefined> {
    let s = this.servers.get(language);
    if (!s) {
      s = this.start(language).catch((err: unknown) => {
        this.log(`lsp ${language}: start failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      this.servers.set(language, s);
    }
    return s;
  }

  private async start(language: string): Promise<Server | undefined> {
    const detected = detectServer(language, this.opts.env ?? process.env, this.opts.servers ?? lspServers);
    if (!detected) return undefined;
    const proc = spawnServer(detected.command, detected.args, this.opts.root, this.opts.env ?? process.env, this.opts.timeoutMs ?? 20_000);
    const server: Server = { detected, proc, ready: Promise.resolve(), docs: new Map(), diagnostics: new Map(), waiters: [] };
    const rpc = proc.rpc;
    const settings = detected.spec.settings ?? {};
    rpc.handle("workspace/configuration", (params) => {
      const items = (params as { items?: Array<{ section?: string }> })?.items ?? [];
      return items.map((it) => {
        if (!it.section) return settings;
        let v: unknown = settings;
        for (const part of it.section.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
        return v ?? null;
      });
    });
    rpc.handle("workspace/workspaceFolders", () => [{ uri: pathToFileURL(this.opts.root).href, name: "checkout" }]);
    rpc.on("textDocument/publishDiagnostics", (params) => {
      const p = params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
      server.diagnostics.set(p.uri, { version: p.version, items: p.diagnostics ?? [], at: Date.now() });
      server.waiters = server.waiters.filter((w) => {
        const hit = w.uri === p.uri && (w.version === undefined || p.version === undefined || p.version >= w.version);
        if (hit) w.resolve();
        return !hit;
      });
    });
    const rootUri = pathToFileURL(this.opts.root).href;
    server.ready = (async () => {
      await rpc.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "weft-analyzer", version: "0.1.0" },
          rootUri,
          rootPath: this.opts.root,
          workspaceFolders: [{ uri: rootUri, name: "checkout" }],
          initializationOptions: detected.spec.initializationOptions ?? null,
          capabilities: {
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: false },
              definition: { dynamicRegistration: false, linkSupport: true },
              references: { dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: false, versionSupport: true },
            },
            general: { positionEncodings: ["utf-16"] },
          },
        },
        60_000,
      );
      rpc.notify("initialized", {});
      rpc.notify("workspace/didChangeConfiguration", { settings });
    })();
    await server.ready;
    this.log(`lsp ${language}: started ${detected.name} (${detected.command})`);
    return server;
  }

  /** Shut every server down (the adapter calls this when the session ends). */
  async close(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      all.map(async (p) => {
        const s = await p;
        if (!s) return;
        try {
          if (!s.proc.rpc.closed) {
            await s.proc.rpc.request("shutdown", null, 3000).catch(() => undefined);
            s.proc.rpc.notify("exit");
          }
        } finally {
          // Give the server a moment to exit on its own, then make sure it is gone.
          const child = s.proc.child;
          const exited = () => child.exitCode !== null || child.signalCode !== null;
          if (!exited()) {
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(term);
                clearTimeout(kill);
                resolve();
              };
              child.once("exit", done);
              const term = setTimeout(() => child.kill("SIGTERM"), 1000);
              const kill = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 3000);
            });
          }
        }
      }),
    );
  }

  // ------------------------------------------------------------------ documents

  private abs(rel: string): string {
    return join(this.opts.root, rel);
  }
  private uri(rel: string): string {
    return pathToFileURL(this.abs(rel)).href;
  }
  /** Checkout-relative `/` path of a server URI, or undefined when it is outside the checkout or skipped. */
  relOf(uri: string): string | undefined {
    if (!uri.startsWith("file:")) return undefined;
    let abs: string;
    try {
      abs = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const rel = relative(this.opts.root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const parts = rel.split(sep);
    if (parts.some((p) => this.skip.has(p))) return undefined;
    return parts.join("/");
  }

  private diskText(rel: string): string | undefined {
    try {
      return readFileSync(this.abs(rel), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Make the server see `text` for `rel` (open or change). Returns the new version. */
  private sync(s: Server, rel: string, text: string): number {
    const uri = this.uri(rel);
    const doc = s.docs.get(uri);
    if (!doc) {
      s.docs.set(uri, { version: 1, text, languageId: s.detected.spec.languageId });
      s.proc.rpc.notify("textDocument/didOpen", { textDocument: { uri, languageId: s.detected.spec.languageId, version: 1, text } });
      return 1;
    }
    doc.version++;
    doc.text = text;
    s.proc.rpc.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    return doc.version;
  }

  /** The text the server currently has for `rel` (open document, else disk). */
  private textOf(s: Server | undefined, rel: string): string | undefined {
    return s?.docs.get(this.uri(rel))?.text ?? this.diskText(rel);
  }

  /** Declarations (with offsets) and identifiers of `text`, cached per file while the text is unchanged. */
  private async outline(language: TreeSitterLanguage, rel: string, text: string): Promise<Outline> {
    const cached = this.outlines.get(rel);
    if (cached && cached.text === text) return cached.outline;
    const outline = await outlineTreeSitter(language, text);
    this.outlines.set(rel, { text, outline });
    if (this.outlines.size > 500) this.outlines.delete(this.outlines.keys().next().value!);
    return outline;
  }

  /** Map a server location to a key (`prefix + path#Name`). */
  private async keyAt(s: Server, uri: string, pos: Position): Promise<string | undefined> {
    const rel = this.relOf(uri);
    if (!rel) return undefined;
    const language = treeSitterLanguageFor(rel);
    const text = language ? this.textOf(s, rel) : undefined;
    if (!language || text === undefined) return undefined;
    const outline = await this.outline(language, rel, text);
    const def = declarationAt(outline.definitions, offsetAt(text, pos));
    return def ? `${this.prefix}${rel}#${def.name}` : undefined;
  }

  private locations(result: unknown): Location[] {
    if (!result) return [];
    const list = (Array.isArray(result) ? result : [result]) as Array<Location | LocationLink>;
    return list
      .map((l): Location | undefined => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : "uri" in l ? l : undefined))
      .filter((l): l is Location => l !== undefined);
  }

  /**
   * Diagnostics for `uri` at `version` or later, published after `after`. Servers may publish
   * more than once per version (pyright re-checks a file when a dependency it imports changes),
   * so after the first match this waits until the file has been quiet for `settleMs`.
   */
  private async waitDiagnostics(s: Server, uri: string, version: number | undefined, after: number): Promise<LspDiagnostic[]> {
    const deadline = Date.now() + (this.opts.diagnosticsTimeoutMs ?? 10_000);
    const settle = this.opts.settleMs ?? 400;
    const fresh = (at: number) => {
      const c = s.diagnostics.get(uri);
      return !!c && c.at >= at && (version === undefined || c.version === undefined || c.version >= version);
    };
    const next = (at: number, ms: number) =>
      new Promise<boolean>((resolve) => {
        if (fresh(at)) return resolve(true);
        const timer = setTimeout(() => {
          s.waiters = s.waiters.filter((w) => w !== waiter);
          resolve(false);
        }, Math.max(0, ms));
        timer.unref?.();
        const waiter = {
          uri,
          version,
          after: at,
          resolve: () => {
            clearTimeout(timer);
            resolve(true);
          },
        };
        s.waiters.push(waiter);
      });
    if (!(await next(after, deadline - Date.now()))) return s.diagnostics.get(uri)?.items ?? [];
    for (;;) {
      const last = s.diagnostics.get(uri)!.at;
      const remaining = Math.min(settle, deadline - Date.now());
      if (remaining <= 0 || !(await next(last + 1, remaining))) break;
    }
    return s.diagnostics.get(uri)?.items ?? [];
  }

  // ------------------------------------------------------------------ enrichment

  /**
   * Precise reads for one committed edit: for every identifier in the changed ranges of each file,
   * `textDocument/definition`, mapped back to a key. For every `signature`/`deleted` write,
   * `textDocument/references` gives the declarations that use it (`dependents`).
   * Files without an installed server (or without a tree-sitter spec) are skipped.
   */
  async enrich(changes: SourceChange[], writes: Array<{ key: string; kind: string }> = []): Promise<EnrichResult> {
    const reads = new Set<string>();
    const dependents: Record<string, string[]> = {};
    const used = new Set<string>();
    for (const change of changes) {
      if (change.after === null) continue;
      const language = treeSitterLanguageFor(change.path);
      if (!language) continue;
      const s = await this.server(language.id);
      if (!s) continue;
      used.add(s.detected.name);
      const text = change.after;
      this.sync(s, change.path, text);
      const outline = await this.outline(language, change.path, text);
      const starts = lineStarts(text);
      const span = changedSpan(change.before, text);
      const nameOffsets = new Set(outline.definitions.map((d) => d.nameStart));
      const seen = new Set<string>();
      const targets = span
        ? outline.identifiers.filter((id) => {
            if (id.start < span[0] || id.end > span[1] || nameOffsets.has(id.start) || id.text === "self" || id.text === "cls") return false;
            // One question per (name, line): repeats of a name on one line resolve alike.
            const k = `${id.text}@${positionAt(text, id.start, starts).line}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
        : [];
      const limited = targets.slice(0, this.opts.maxIdentifiers ?? 300);
      if (targets.length > limited.length) this.log(`lsp: ${change.path}: asked about ${limited.length} of ${targets.length} identifiers`);
      const uri = this.uri(change.path);
      const results = await Promise.all(
        limited.map(async (id) => {
          try {
            const pos = positionAt(text, id.start, starts);
            return this.locations(await s.proc.rpc.request("textDocument/definition", { textDocument: { uri }, position: pos }));
          } catch (err) {
            this.log(`lsp: definition ${change.path}:${id.text} failed: ${String(err)}`);
            return [];
          }
        }),
      );
      for (const locs of results) {
        for (const loc of locs) {
          const key = await this.keyAt(s, loc.uri, loc.range.start);
          if (key) reads.add(key);
        }
      }
      // Callers of each contract change in this file.
      for (const w of writes) {
        if (w.kind !== "signature" && w.kind !== "deleted") continue;
        const [path, name] = splitKey(w.key, this.prefix);
        if (path !== change.path || !name) continue;
        const def = outline.definitions.find((d) => d.name === name);
        if (!def || def.nameStart === undefined) continue; // deleted: no position in the new text
        const users = await this.usersOf(s, change.path, text, def.nameStart);
        users.delete(w.key);
        if (users.size) dependents[w.key] = [...users].sort();
      }
    }
    for (const w of writes) reads.delete(w.key);
    return { reads: [...reads].sort(), dependents, servers: [...used].sort() };
  }

  private async referenceLocations(s: Server, rel: string, text: string, offset: number): Promise<Location[]> {
    try {
      return this.locations(
        await s.proc.rpc.request("textDocument/references", { textDocument: { uri: this.uri(rel) }, position: positionAt(text, offset), context: { includeDeclaration: false } }),
      );
    } catch (err) {
      this.log(`lsp: references ${rel} failed: ${String(err)}`);
      return [];
    }
  }

  /** Keys of the declarations that reference the symbol at `offset` of `rel` (declaration excluded). */
  private async usersOf(s: Server, rel: string, text: string, offset: number): Promise<Set<string>> {
    const out = new Set<string>();
    for (const loc of await this.referenceLocations(s, rel, text, offset)) {
      const key = await this.keyAt(s, loc.uri, loc.range.start);
      if (key) out.add(key);
    }
    return out;
  }

  /**
   * Type-aware breakage of a peer's change in this checkout. `overlays` are the peer's versions
   * of the files it changed (applied in the server's memory only; the disk is untouched and the
   * overlays are reverted afterwards); `keys` are the peer-changed keys. Every file in the
   * checkout that references one of the keys is checked: an error-level diagnostic that the
   * server reports with the overlays and did not report without them is a breakage.
   */
  async breakage(overlays: Array<{ path: string; text: string }>, keys: string[]): Promise<Breakage[]> {
    const out: Breakage[] = [];
    const byLanguage = new Map<string, Array<{ path: string; text: string }>>();
    for (const o of overlays) {
      const language = treeSitterLanguageFor(o.path);
      if (!language) continue;
      byLanguage.set(language.id, [...(byLanguage.get(language.id) ?? []), o]);
    }
    for (const [languageId, files] of byLanguage) {
      const language = treeSitterLanguageFor(files[0]!.path)!;
      const s = await this.server(languageId);
      if (!s) continue;
      const original = new Map<string, string | undefined>(files.map((f) => [f.path, this.textOf(s, f.path)]));
      try {
        // 1. Who uses the keys in this checkout (positions from this checkout's version).
        const readers = new Map<string, Array<{ key: string; range: Range }>>(); // reader file -> uses of the keys
        for (const key of keys) {
          const [path, name] = splitKey(key, this.prefix);
          const text = files.some((x) => x.path === path) ? original.get(path) : undefined;
          if (text === undefined || !name) continue;
          this.sync(s, path, text);
          const def = (await this.outline(language, path, text)).definitions.find((d) => d.name === name);
          if (!def || def.nameStart === undefined) continue;
          for (const loc of await this.referenceLocations(s, path, text, def.nameStart)) {
            const rel = this.relOf(loc.uri);
            if (!rel || files.some((x) => x.path === rel)) continue;
            readers.set(rel, [...(readers.get(rel) ?? []), { key, range: loc.range }]);
          }
        }
        this.log(`lsp breakage: ${keys.join(", ")} used in ${[...readers.keys()].join(", ") || "no other file"}`);
        if (!readers.size) continue;
        // 2. Their diagnostics as they are...
        const without = await this.diagnose(s, [...readers.keys()]);
        // 3. ...and with the peer's version of its files.
        for (const f of files) this.sync(s, f.path, f.text);
        const withPeer = await this.diagnose(s, [...readers.keys()]);
        const count = (m: Map<string, LspDiagnostic[]>) => [...m.values()].reduce((n, d) => n + d.length, 0);
        this.log(`lsp breakage: ${count(withPeer)} diagnostic(s) with the peer's version, ${count(without)} without`);
        for (const [rel, uses] of readers) {
          const before = new Set((without.get(rel) ?? []).map(fingerprint));
          for (const d of withPeer.get(rel) ?? []) {
            if ((d.severity ?? 1) !== 1 || before.has(fingerprint(d))) continue;
            out.push({ file: `${this.prefix}${rel}`, range: d.range, message: d.message, key: attribute(d.range, uses), server: s.detected.name });
          }
        }
      } finally {
        for (const f of files) {
          const text = original.get(f.path);
          if (text !== undefined && s.docs.get(this.uri(f.path))?.text !== text) this.sync(s, f.path, text);
        }
      }
    }
    return out;
  }

  /** Fresh diagnostics for each file: open (or touch) it so the server re-checks it, then wait. */
  private async diagnose(s: Server, rels: string[]): Promise<Map<string, LspDiagnostic[]>> {
    const out = new Map<string, LspDiagnostic[]>();
    await Promise.all(
      rels.map(async (rel) => {
        const text = this.textOf(s, rel);
        if (text === undefined) return;
        const after = Date.now();
        const version = this.sync(s, rel, text);
        out.set(rel, await this.waitDiagnostics(s, this.uri(rel), version, after));
      }),
    );
    return out;
  }
}

const notAfter = (a: Position, b: Position): boolean => a.line < b.line || (a.line === b.line && a.character <= b.character);

/**
 * The key a diagnostic is about: of the uses inside its range, the first one (in
 * `quote(calc_total(x))` the callee `quote` comes first); else a use on its first line; else the
 * file's first use.
 */
export function attribute(range: Range, uses: Array<{ key: string; range: Range }>): string {
  const inside = uses.filter((u) => notAfter(range.start, u.range.start) && notAfter(u.range.start, range.end));
  inside.sort((a, b) => (notAfter(a.range.start, b.range.start) ? -1 : 1));
  return (inside[0] ?? uses.find((u) => u.range.start.line === range.start.line) ?? uses[0]!).key;
}

function fingerprint(d: LspDiagnostic): string {
  return `${d.range.start.line}:${d.code ?? ""}:${d.message}`;
}

/** `[path, name]` of a key, with the checkout prefix removed. */
export function splitKey(key: string, prefix = ""): [string, string] {
  const i = key.indexOf("#");
  const path = i < 0 ? key : key.slice(0, i);
  return [prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path, i < 0 ? "" : key.slice(i + 1)];
}
