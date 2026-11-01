// The coordinator a person chose for a checkout, kept OUTSIDE the checkout.
//
// A repo can ship its own `.weft/<harness>.json` (and `.weft/token`), so that file alone cannot say
// where a checkout's diffs may go. `install` (run by `npx @celador/weft`, i.e. by the user) writes
// the url/repo/mode it was given to `<config dir>/pins.json`; the Claude Code / Copilot plugin runs
// the adapter as `hook --pinned --url U --repo R --mode M` with exactly that pin, and the adapter
// trusts a checkout's config only when it equals the pin (config.ts loadPinned). No pin, no hook.
//
// Shape: { "version": 1, "checkouts": { "<real path of the checkout>": { "<harness>": { url, repo, mode } } } }
// plugins/weft/scripts/weft-hook.mjs (reader) and packages/cli/src/pins.ts (eraser) read the same file.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Pin } from "./config";

/** `~/.config/weft` (or `$XDG_CONFIG_HOME/weft`, or `$WEFT_HOME`): the same directory the CLI and the plugin use. */
export function weftConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WEFT_HOME) return env.WEFT_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "weft");
}

export const pinsPath = (env: NodeJS.ProcessEnv = process.env): string => join(weftConfigDir(env), "pins.json");

type PinsFile = { version: 1; checkouts: Record<string, Record<string, Required<Pin>>> };

function readPins(path: string): PinsFile {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<PinsFile>;
    if (j && typeof j === "object" && j.checkouts && typeof j.checkouts === "object") return { version: 1, checkouts: j.checkouts };
  } catch {
    /* none yet, or unreadable: start over */
  }
  return { version: 1, checkouts: {} };
}

/** Record the coordinator the user chose for `root` and `harness` (an explicit `install --url/--repo`). */
export function recordPin(root: string, harness: string, pin: Pin, env: NodeJS.ProcessEnv = process.env): void {
  const path = pinsPath(env);
  const file = readPins(path);
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* keep the path as given */
  }
  file.checkouts[real] = { ...file.checkouts[real], [harness]: { url: pin.url, repo: pin.repo, mode: pin.mode ?? "enforce" } };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function pinsFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(pinsPath(env));
}
