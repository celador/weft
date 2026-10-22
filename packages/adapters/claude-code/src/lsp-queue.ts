// The hook side of the language-server enrichment (src/lsp.ts): job types, the per-checkout queue
// and the daemon's lock. Kept free of the analyzer's heavy imports (TypeScript compiler,
// tree-sitter) so that queueing from any hook costs a file write, not a module load.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectServer, lspSpecFor } from "@weft/analyzer/lsp/servers";
import { appendAdapterLog, type Loaded } from "./config";

export type FileText = { rel: string; before: string | null; after: string | null };
export type LspJob =
  | {
      type: "enrich";
      session: string;
      wcpSession: string;
      base: number;
      /** The accepted edit this amends. */
      seq: number;
      changes: FileText[];
      /** Keys the edit already sent (tree-sitter): only new keys are amended. */
      reads: string[];
      writes: Array<{ key: string; kind: string }>;
    }
  | { type: "breakage"; session: string; seq: number; keys: string[] }
  | { type: "end"; session: string };

/**
 * Cheap pre-check in the hook: is a language server installed for this file's extension? The
 * daemon checks again with the full rule (a tree-sitter spec must exist too).
 */
export function lspMaybe(rel: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const spec = lspSpecFor(rel);
  return !!spec && !!detectServer(spec.language, env);
}

export function lspDir(root: string): string {
  return join(root, ".weft", "lsp");
}
export const queueDir = (root: string) => join(lspDir(root), "queue");
export const lockDir = (root: string) => join(lspDir(root), "daemon.lock");

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** pid of the checkout's running daemon, if any. */
export function daemonPid(root: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(lockDir(root), "pid"), "utf8"));
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

let counter = 0;
/**
 * Queue a job and make sure a daemon runs (`spawnDaemon` is called only when none does; never for
 * `end`, which is dropped when no daemon runs). Never throws.
 */
export function enqueue(root: string, job: LspJob, spawnDaemon: () => void): void {
  try {
    const running = daemonPid(root) !== undefined;
    if (job.type === "end" && !running) return;
    const dir = queueDir(root);
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${counter++}.json`;
    writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(job));
    renameSync(join(dir, `.${name}.tmp`), join(dir, name));
    if (!running) spawnDaemon();
  } catch (err) {
    appendAdapterLog(root, `lsp enqueue failed: ${String(err)}`);
  }
}

/** Spawn `node <cli> lsp-daemon --root <root>` detached. */
export function spawnDaemonProcess(cli: string, root: string): void {
  try {
    spawn(process.execPath, [cli, "lsp-daemon", "--root", root], { detached: true, stdio: "ignore", cwd: root }).unref();
  } catch (err) {
    appendAdapterLog(root, `lsp daemon spawn failed: ${String(err)}`);
  }
}

/**
 * Queue a hook's enrichment jobs for the checkout's daemon (call after the hook's answer is
 * written). Only files with an installed language server count; nothing is awaited but the
 * queue write (and a detached `<cli> lsp-daemon` spawn when no daemon runs).
 */
export function flushJobs(loaded: Loaded, jobs: LspJob[], cli: string, env: NodeJS.ProcessEnv = process.env): void {
  if ((env.WEFT_LSP ?? "").toLowerCase() === "off") return;
  const root = loaded.root;
  const prefix = loaded.config.prefix ?? "";
  const strip = (key: string) => {
    const path = key.slice(0, Math.max(0, key.indexOf("#")));
    return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  for (const job of jobs) {
    if (job.type === "enrich" && !job.changes.some((c) => lspMaybe(c.rel, env))) continue;
    if (job.type === "breakage" && !job.keys.some((k) => lspMaybe(strip(k), env))) continue;
    enqueue(root, job, () => spawnDaemonProcess(cli, root));
  }
}
