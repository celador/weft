// Asynchronous language-server enrichment for the hooks (spec §6.2 R2a, §8.3 step 3a;
// docs/languages.md "LSP enrichment"). Never on the edit-time path:
//
//   PostToolUse (edit accepted)   -> enqueue {type:"enrich"}    -> the daemon asks the server for
//                                    definitions in the changed lines, submits the extra keys as a
//                                    reads amendment (`intent` with `reads`), and leaves the
//                                    verdict's warnings (+ the callers of a signature change) as
//                                    notes for the next hook to inject.
//   contract_changed reaches us   -> enqueue {type:"breakage"}  -> the daemon applies the peer's
//                                    diff in the server's memory and reports new type errors in
//                                    files that use the changed key, as notes.
//   SessionEnd                    -> enqueue {type:"end"}       -> servers shut down with the last session.
//
// Hooks are short processes, so the servers live in one detached daemon per checkout
// (`weft-adapter-claude lsp-daemon`), fed through a queue directory `.weft/lsp/queue/`. Enqueueing
// is a file write (plus a spawn when no daemon runs); hooks never wait for it.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectServer, LspEnricher, splitKey, treeSitterLanguageFor, type Breakage, type LspServerSpec } from "@weft/analyzer";
import type { Diagnostic, EventRecord } from "@weft/protocol";
import type { Transport } from "./client";
import { appendAdapterLog, readState, withLock, writeState, type Loaded } from "./config";
import { renderForModel } from "./render";
import { alive, lockDir, lspDir, queueDir } from "./lsp-queue";

export { daemonPid, enqueue, lspDir, spawnDaemonProcess } from "./lsp-queue";

export type { FileText, LspJob } from "./lsp-queue";
import type { LspJob } from "./lsp-queue";
const MAX_NOTES = 50;
const MAX_DEPENDENTS = 8;

/** Does this checkout-relative path have an installed language server (and a tree-sitter spec)? */
export function lspEligible(rel: string, env: NodeJS.ProcessEnv = process.env, servers?: LspServerSpec[]): boolean {
  const language = treeSitterLanguageFor(rel);
  return !!language && !!detectServer(language.id, env, servers);
}

// ------------------------------------------------------------------ daemon

/** Take the checkout's daemon lock; false when another live daemon holds it. */
function takeLock(root: string): boolean {
  mkdirSync(lspDir(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir(root));
      writeFileSync(join(lockDir(root), "pid"), String(process.pid));
      return true;
    } catch {
      let pid = NaN;
      try {
        pid = Number(readFileSync(join(lockDir(root), "pid"), "utf8"));
      } catch {
        /* being created, or stale without a pid */
      }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return false;
      rmSync(lockDir(root), { recursive: true, force: true });
    }
  }
  return false;
}

export type DaemonOptions = { pollMs?: number; idleMs?: number };

/**
 * The daemon loop: process queued jobs in order until every session that sent work has ended
 * (and the queue is empty), or nothing arrived for `idleMs`. Shuts the servers down on exit.
 */
export async function runDaemon(root: string, worker: LspWorker, opts: DaemonOptions = {}): Promise<void> {
  if (!takeLock(root)) return;
  const pollMs = opts.pollMs ?? 200;
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const sessions = new Set<string>();
  let last = Date.now();
  appendAdapterLog(root, `lsp daemon ${process.pid} started`);
  try {
    for (;;) {
      let names: string[] = [];
      try {
        names = readdirSync(queueDir(root)).filter((n) => n.endsWith(".json")).sort();
      } catch {
        /* no queue yet */
      }
      for (const name of names) {
        const path = join(queueDir(root), name);
        let job: LspJob;
        try {
          job = JSON.parse(readFileSync(path, "utf8")) as LspJob;
        } catch {
          rmSync(path, { force: true });
          continue;
        }
        rmSync(path, { force: true });
        last = Date.now();
        if (job.type === "end") sessions.delete(job.session);
        else sessions.add(job.session);
        await worker.process(job).catch((err: unknown) => appendAdapterLog(root, `lsp ${job.type} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
      }
      if (names.length && sessions.size === 0) break; // the last session ended
      if (Date.now() - last > idleMs) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    await worker.close();
    rmSync(lockDir(root), { recursive: true, force: true });
    appendAdapterLog(root, `lsp daemon ${process.pid} stopped`);
  }
}

// ------------------------------------------------------------------ the work

/** Forward-apply the hunks of one file's unified diff to `text` (context must match, ±50 lines of fuzz). */
export function applyFileDiff(text: string, diff: string, path: string): string | undefined {
  const sections = diff.split(/^(?=diff --git )/m);
  const section = sections.find((s) => s.startsWith(`diff --git a/${path} b/${path}\n`) || s.startsWith(`diff --git a/${path} `));
  if (!section) return undefined;
  if (/^\+\+\+ \/dev\/null$/m.test(section)) return undefined;
  const created = /^--- \/dev\/null$/m.test(section);
  const trailing = created ? true : text.endsWith("\n");
  const lines = created ? [] : text.replace(/\n$/, "").split("\n");
  const hunks: Array<{ oldStart: number; lines: string[] }> = [];
  for (const line of section.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h) hunks.push({ oldStart: Number(h[1]), lines: [] });
    else if (hunks.length && /^[ +-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---")) hunks.at(-1)!.lines.push(line);
  }
  let shift = 0;
  for (const h of hunks) {
    const old = h.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    const neu = h.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const want = Math.max(0, h.oldStart - 1 + shift);
    const matches = (at: number) => at >= 0 && at + old.length <= lines.length && old.every((l, i) => lines[at + i] === l);
    let at = -1;
    for (let d = 0; d <= 50 && at < 0; d++) {
      if (matches(want - d)) at = want - d;
      else if (matches(want + d)) at = want + d;
    }
    if (at < 0) return undefined;
    lines.splice(at, old.length, ...neu);
    shift += neu.length - old.length + (at - want);
  }
  return lines.join("\n") + (trailing && lines.length ? "\n" : "");
}

export type WorkerDeps = {
  transport: Transport;
  /** Override the server registry / env (tests). */
  servers?: LspServerSpec[];
  env?: NodeJS.ProcessEnv;
  enricher?: LspEnricher;
};

/** Does the jobs: talks to the language servers and the coordinator, writes notes into session state. */
export class LspWorker {
  readonly enricher: LspEnricher;
  private readonly prefix: string;
  private readonly checked = new Set<string>();

  constructor(
    private readonly loaded: Loaded,
    private readonly deps: WorkerDeps,
  ) {
    this.prefix = loaded.config.prefix ?? "";
    this.enricher =
      deps.enricher ??
      new LspEnricher({ root: loaded.root, prefix: this.prefix, ...(deps.servers ? { servers: deps.servers } : {}), ...(deps.env ? { env: deps.env } : {}), log: (m) => this.log(m) });
  }

  private log(message: string): void {
    appendAdapterLog(this.loaded.root, message);
  }

  close(): Promise<void> {
    return this.enricher.close();
  }

  async process(job: LspJob): Promise<void> {
    if (job.type === "enrich") return this.enrich(job);
    if (job.type === "breakage") return this.breakage(job.session, job.seq, job.keys);
  }

  private async note(session: string, lines: string[]): Promise<void> {
    if (!lines.length) return;
    await withLock(this.loaded.root, session, async () => {
      const st = readState(this.loaded.root, session);
      const notes = [...(st.lspNotes ?? []), ...lines.filter((l) => !(st.lspNotes ?? []).includes(l))];
      st.lspNotes = notes.slice(-MAX_NOTES);
      writeState(this.loaded.root, st);
    });
  }

  private ctx() {
    return {
      root: this.loaded.root,
      prefix: this.prefix,
      change: this.loaded.config.change,
      fetchEvent: (seq: number) => this.deps.transport.event(seq).catch(() => undefined),
    };
  }

  private async enrich(job: Extract<LspJob, { type: "enrich" }>): Promise<void> {
    const started = Date.now();
    const result = await this.enricher.enrich(
      job.changes.map((c) => ({ path: c.rel, before: c.before, after: c.after })),
      job.writes,
    );
    if (!result.servers.length) return;
    const known = new Set([...job.reads, ...job.writes.map((w) => w.key)]);
    const extra = result.reads.filter((k) => !known.has(k));
    const server = result.servers.join(",");
    const lines: string[] = [];
    this.log(`lsp enrich #${job.seq} (${server}, ${Date.now() - started} ms): ${result.reads.length} reads, ${extra.length} new${extra.length ? ` [${extra.join(", ")}]` : ""}`);
    if (extra.length) {
      try {
        const verdict = await this.deps.transport.submit(
          job.wcpSession,
          {
            type: "submit",
            mode: "commit",
            event: {
              kind: "intent",
              base_seq: job.base,
              files: job.changes.map((c) => this.prefix + c.rel),
              reads: extra,
              intent: `reads amendment for #${job.seq} (${server})`,
              summary_hint: `precise reads for #${job.seq} from ${server}`,
              tool: { name: `lsp:${server}`, call_id: `lsp-${job.seq}`, harness_event: "PostToolUse" },
            },
          },
          `${this.loaded.config.change}:lsp:${job.seq}`,
        );
        this.log(`lsp amendment for #${job.seq} -> ${verdict.verdict} #${verdict.seq} (${verdict.diagnostics.map((d) => d.code).join(",") || "clean"})`);
        if (verdict.diagnostics.length) {
          const text = await renderForModel(verdict.diagnostics, [], this.ctx());
          if (text) lines.push(`[weft] ${server} found more uses in your edit (#${job.seq}) than the edit-time check saw:`, ...text.split("\n"));
          // The peer's change is in the log, not in this checkout: check what it breaks here.
          await this.breakageFrom(verdict.diagnostics, lines);
        }
      } catch (err) {
        this.log(`lsp amendment for #${job.seq} failed: ${String(err)}`);
      }
    }
    for (const [key, users] of Object.entries(result.dependents)) {
      const shown = users.slice(0, MAX_DEPENDENTS);
      lines.push(
        `[weft info] lsp_dependents ${key}: ${server} finds ${users.length} use(s) of this signature change outside the edit: ${shown.join(", ")}${users.length > shown.length ? ", …" : ""}. Update them in this change, or keep the old signature compatible.`,
      );
    }
    await this.note(job.session, lines);
  }

  private async breakageFrom(diagnostics: Diagnostic[], lines: string[]): Promise<void> {
    const bySeq = new Map<number, string[]>();
    for (const d of diagnostics) if (d.code === "contract_changed") bySeq.set(d.caused_by_seq, [...(bySeq.get(d.caused_by_seq) ?? []), d.symbol]);
    for (const [seq, keys] of bySeq) lines.push(...(await this.breakageLines(seq, keys)));
  }

  private async breakage(session: string, seq: number, keys: string[]): Promise<void> {
    await this.note(session, await this.breakageLines(seq, keys));
  }

  /** Type errors the peer's event `seq` would cause in this checkout, as `[weft warning] type_breakage` lines. */
  async breakageLines(seq: number, keys: string[]): Promise<string[]> {
    const todo = keys.filter((k) => !this.checked.has(`${seq}:${k}`));
    if (!todo.length) return [];
    for (const k of todo) this.checked.add(`${seq}:${k}`);
    let record: EventRecord | undefined;
    try {
      record = await this.deps.transport.event(seq);
    } catch (err) {
      this.log(`lsp breakage: event #${seq} unavailable: ${String(err)}`);
      return [];
    }
    if (!record?.diff) return [];
    const overlays: Array<{ path: string; text: string }> = [];
    for (const file of new Set(todo.map((k) => splitKey(k, this.prefix)[0]))) {
      if (!lspEligible(file, this.deps.env, this.deps.servers)) continue;
      let current: string | null = null;
      try {
        current = readFileSync(join(this.loaded.root, file), "utf8");
      } catch {
        current = "";
      }
      const peer = applyFileDiff(current ?? "", record.diff, this.prefix + file);
      if (peer === undefined) {
        this.log(`lsp breakage: #${seq}'s diff does not apply to ${file} here; skipped`);
        continue;
      }
      overlays.push({ path: file, text: peer });
    }
    if (!overlays.length) return [];
    const started = Date.now();
    const found: Breakage[] = await this.enricher.breakage(overlays, todo);
    this.log(`lsp breakage #${seq} (${Date.now() - started} ms): ${found.length} new error(s)`);
    const who = record.agent ?? record.actor.id;
    return found.map(
      (b) =>
        `[weft warning] type_breakage ${b.file}:${b.range.start.line + 1}:${b.range.start.character + 1}: ${b.server}: ${b.message} — once ${who}'s change #${seq} to ${b.key} lands (not in your checkout yet). Adapt this use, or negotiate with ${who}.`,
    );
  }
}
