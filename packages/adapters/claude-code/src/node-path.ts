// The node binary that installed hooks and wrappers should call. process.execPath is the
// resolved binary, which under Homebrew is a versioned Cellar path
// (/opt/homebrew/Cellar/node@24/24.21.0/bin/node) that disappears on the next `brew upgrade`,
// silently breaking every installed hook. Prefer Homebrew's stable `opt/<formula>` link, but
// only when it actually runs: a binary can exist and still abort in dyld before running a line
// (a `brew upgrade` of simdjson 4 -> 5 left /opt/homebrew/opt/node@24/bin/node dead on
// 2026-11-17). process.execPath is the node running this code, so it is known to run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const probed = new Map<string, boolean>();

/** True when `path` starts and exits cleanly (`node -e 0`, 5 s cap). Cached per process. */
export function nodeRuns(path: string): boolean {
  let ok = probed.get(path);
  if (ok === undefined) {
    const r = spawnSync(path, ["-e", "0"], { stdio: "ignore", timeout: 5_000 });
    ok = !r.error && r.status === 0;
    probed.set(path, ok);
  }
  return ok;
}

export function stableNodePath(
  execPath: string = process.execPath,
  exists: (p: string) => boolean = existsSync,
  runs: (p: string) => boolean = nodeRuns,
): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/(node[^/]*)$/.exec(execPath);
  if (m) {
    const opt = `${m[1]}/opt/${m[2]}/bin/${m[3]}`;
    if (exists(opt) && runs(opt)) return opt;
  }
  return execPath;
}
