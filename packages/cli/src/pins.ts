// Forget a checkout's pinned coordinator (~/.config/weft/pins.json) when its adapters are removed.
// The adapters write the pin on install (packages/adapters/claude-code/src/pins.ts documents the shape);
// the Claude Code / Copilot plugin runs hooks only in checkouts that have one.
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./util";

export function forgetPins(root: string, env = process.env): boolean {
  const path = join(configDir(env), "pins.json");
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as { checkouts?: Record<string, unknown> };
    let real = root;
    try {
      real = realpathSync(root);
    } catch {
      /* the checkout is already gone: match the path as given */
    }
    const keys = [real, root].filter((k) => file.checkouts && k in file.checkouts);
    if (!file.checkouts || !keys.length) return false;
    for (const k of keys) delete file.checkouts[k];
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false; // no pins file: nothing to forget
  }
}
