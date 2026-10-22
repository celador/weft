// `weft-adapter-watcher` CLI (bundled to dist/weft-watch.mjs).
//
//   install   .weft/watcher.json (+ token), git hooks (commit-msg trailers + pre-commit gate)
//   run       watch the checkout until SIGINT/SIGTERM (fs.watch, debounced)
//   scan      one pass: report files that differ from git HEAD (no long-running process)
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox)
import { watch } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, arg } from "../../claude-code/src/host";
import { ADAPTER_VERSION } from "../../claude-code/src/hooks";
import { Watcher } from "./watch";

const SELF = fileURLToPath(import.meta.url);
export const CONFIG_REL = ".weft/watcher.json";

/**
 * L0 by construction: reports arrive after the write (observe "async"), nothing reaches a
 * model (inject false), nothing is denied, the agent's stop is not gated. The one gate is
 * git's own pre-commit hook ("native" to git, bypassable with --no-verify).
 */
export const CAPABILITIES: Capabilities = {
  level: 0,
  observe: "async",
  inject: false,
  deny_edit: false,
  refuse_stop: false,
  commit_gate: "native",
};

export const host = new Host({
  name: "watcher",
  bin: "weft-adapter-watcher",
  configRel: CONFIG_REL,
  harness: "file-watcher",
  adapter: `@weft/adapter-watcher@${ADAPTER_VERSION}`,
  capabilities: CAPABILITIES,
  self: SELF,
  sessionOwner: "self",
  installHarness: () => [`run: ${process.execPath} ${SELF} run   (from the checkout; Ctrl-C to stop)`],
});

function loadOrDie() {
  const loaded = host.load();
  if (!loaded) {
    process.stderr.write(`weft: not configured here (no ${CONFIG_REL} or no token); run install first\n`);
    process.exit(2);
  }
  return loaded;
}

async function run(args: string[]): Promise<number> {
  const loaded = loadOrDie();
  const debounceMs = Number(arg(args, "debounce") ?? 400);
  const tickMs = Number(arg(args, "tick") ?? 15_000);
  const w = new Watcher(host, loaded);
  await w.start();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let busy: Promise<unknown> = Promise.resolve();
  const flush = () => {
    const batch = [...pending];
    pending.clear();
    busy = busy.then(() => w.process(batch)).catch((err) => process.stderr.write(`weft-watch: ${String(err)}\n`));
  };
  // macOS and Windows support recursive fs.watch natively; Node >= 20 also on Linux.
  const watcher = watch(loaded.root, { recursive: true }, (_ev, file) => {
    if (!file) return;
    pending.add(String(file));
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  const ticker = setInterval(() => {
    busy = busy.then(() => w.tick()).catch(() => {});
  }, tickMs);
  await new Promise<void>((done) => {
    const end = () => {
      watcher.close();
      clearInterval(ticker);
      clearTimeout(timer);
      if (pending.size) flush();
      busy.then(() => w.stop()).finally(done);
    };
    process.once("SIGINT", end);
    process.once("SIGTERM", end);
  });
  return 0;
}

async function scan(): Promise<number> {
  const loaded = loadOrDie();
  const w = new Watcher(host, loaded);
  const entries = execFileSync("git", ["-C", loaded.root, "status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8" }).split("\0");
  const changed: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e) continue;
    changed.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") changed.push(entries[++i]!); // -z: rename source follows
  }
  // scan compares against HEAD: start() would snapshot the dirty tree and see no change.
  await w.process(changed);
  await w.tick();
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-watcher(\.mjs)?$/.test(entry)) {
  host
    .main(process.argv.slice(2), async () => {
      process.stderr.write("weft-watch has no harness hook; use `run` or `scan`\n");
      process.exitCode = 2;
    }, { run, scan })
    .catch((err) => {
      process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
