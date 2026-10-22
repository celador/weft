// Small shared helpers: terminal output, config paths, files, git, process.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

declare const __WEFT_VERSION__: string;
export const VERSION = typeof __WEFT_VERSION__ === "string" ? __WEFT_VERSION__ : "0.0.0-dev";

export class WeftError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ output

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  cyan: paint("36"),
  orange: paint("38;5;215"),
  squiggle: (s: string) => (color ? `\x1b[4:3m\x1b[58;5;203m${s}\x1b[0m` : s),
};
export const ok = (msg: string) => console.log(`${c.green("✓")} ${msg}`);
export const info = (msg: string) => console.log(`${c.dim("·")} ${msg}`);
export const warn = (msg: string) => console.log(`${c.yellow("!")} ${msg}`);
export const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);

// ------------------------------------------------------------------ config + files

/** ~/.config/weft (or $XDG_CONFIG_HOME/weft, or $WEFT_HOME). */
export function configDir(env = process.env): string {
  if (env.WEFT_HOME) return env.WEFT_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "weft");
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown, secret = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
}

export function writeSecret(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value.trim() + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readSecret(path: string): string | undefined {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ git

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

export type Worktree = { path: string; branch?: string; bare: boolean };

export function worktrees(cwd: string): Worktree[] {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  const list: Worktree[] = [];
  let cur: Worktree | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), bare: false };
      list.push(cur);
    } else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line === "bare") cur.bare = true;
  }
  return list.filter((w) => !w.bare && existsSync(w.path));
}

/** The repo's main checkout (the first worktree). */
export function mainCheckout(cwd: string): string {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.endsWith("/.git") ? dirname(common) : (worktrees(cwd)[0]?.path ?? git(cwd, ["rev-parse", "--show-toplevel"]));
}

// ------------------------------------------------------------------ process

export function which(cmd: string, env = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function openUrl(url: string): void {
  if (process.env.CI || process.env.WEFT_NO_OPEN === "1" || !process.stdout.isTTY) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  } catch {
    /* best effort */
  }
}

export async function ask(question: string, def: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return def;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${c.cyan("?")} ${question} ${c.dim(def ? "(Y/n)" : "(y/N)")} `)).trim().toLowerCase();
    return a ? a.startsWith("y") : def;
  } finally {
    rl.close();
  }
}

/** A safe id fragment: lowercase letters, digits, '-', at most `max` chars. */
export function slug(s: string, max = 40): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .slice(0, max)
    .replace(/[-._]+$/, "");
  return v || "repo";
}
