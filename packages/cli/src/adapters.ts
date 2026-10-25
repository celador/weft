// Adapters: where their bundles live, which harnesses are installed, install and removal.
//
// Hooks run long after `npx` exits, and npx's cache can be cleared, so the adapter bundles
// (and the `typescript` they load) are copied once per version to
// ~/.config/weft/runtime/<version>/ and every hook points there.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, readJson, tryGit, VERSION, WeftError, which } from "./util";

export type HarnessId = "antigravity" | "claude-code" | "codex" | "copilot" | "cursor" | "gemini" | "opencode" | "watcher";

/**
 * `run`: the command a person types to start that harness in a checkout. `note`: what it asks
 * the first time before Weft's hooks run (printed under "Next"), when it asks anything.
 */
export const HARNESSES: Array<{ id: HarnessId; name: string; bins: string[]; entry: string; config: string; mark: string; run: string; note?: string }> = [
  {
    id: "codex",
    name: "Codex",
    bins: ["codex"],
    entry: "weft-codex.mjs",
    config: ".weft/codex.json",
    mark: "weft-codex",
    run: "codex",
    // codex-cli 0.154: project hooks need persisted trust; `codex exec` skips untrusted hooks silently.
    note: "asks once to review the new hooks: choose \"Trust all and continue\" (headless: codex exec --dangerously-bypass-hook-trust)",
  },
  { id: "antigravity", name: "Antigravity", bins: ["agy"], entry: "weft-antigravity.mjs", config: ".weft/antigravity.json", mark: "weft-antigravity", run: "agy" },
  { id: "copilot", name: "GitHub Copilot CLI", bins: ["copilot"], entry: "weft-copilot.mjs", config: ".weft/copilot.json", mark: "weft-copilot", run: "copilot", note: "asks once to trust the folder: say yes (hooks only run in trusted folders)" },
  { id: "cursor", name: "Cursor CLI", bins: ["cursor-agent"], entry: "weft-cursor.mjs", config: ".weft/cursor.json", mark: "weft-cursor", run: "cursor-agent", note: "asks once to trust the workspace: say yes (project hooks only run in trusted workspaces)" },
  { id: "gemini", name: "Gemini CLI", bins: ["gemini"], entry: "weft-gemini.mjs", config: ".weft/gemini.json", mark: "weft-gemini", run: "gemini", note: "asks once to trust the folder: say yes (project settings and hooks are ignored in untrusted folders; headless: gemini --skip-trust)" },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], entry: "weft-opencode.mjs", config: ".weft/opencode.json", mark: "weft-opencode", run: "opencode" },
  // Claude Code last: it owns .weft/bin/weft and the git hooks when several are installed.
  { id: "claude-code", name: "Claude Code", bins: ["claude"], entry: "weft-claude.mjs", config: ".weft/claude.json", mark: "weft-claude", run: "claude" },
];
export const WATCHER = { id: "watcher" as const, name: "file watcher", bins: [], entry: "weft-watch.mjs", config: ".weft/watcher.json", mark: "weft-watch", run: "npx @celador/weft watch" };
/** The MCP server for harnesses without hooks (`npx @celador/weft mcp`); configured by the harness, not installed by init. */
export const MCP = { id: "mcp" as const, name: "MCP server", bins: [], entry: "weft-mcp.mjs", config: ".weft/mcp.json", mark: "weft-mcp", run: "npx -y @celador/weft mcp" };
const MARKS = [...HARNESSES.map((h) => h.mark), WATCHER.mark, MCP.mark];

export function harnessName(id: string): string {
  return [...HARNESSES, WATCHER, MCP].find((h) => h.id === id)?.name ?? id;
}

/** The order people should try them in "Next": Claude Code first, then the rest as listed. */
export function startOrder(ids: HarnessId[]): Array<(typeof HARNESSES)[number] | typeof WATCHER> {
  const all = [...HARNESSES, WATCHER].filter((h) => ids.includes(h.id));
  return all.sort((a, b) => (a.id === "claude-code" ? -1 : b.id === "claude-code" ? 1 : 0));
}

/** Harnesses found on PATH (`--harness a,b` overrides). Hermes is reported separately: its adapter is a profile plugin. */
export function detectHarnesses(env = process.env): { found: HarnessId[]; hermes: boolean } {
  const found = HARNESSES.filter((h) => h.bins.some((b) => which(b, env))).map((h) => h.id);
  return { found, hermes: Boolean(which("hermes", env)) };
}

/** dist/ of this package (where weft.mjs lives); in the monorepo, packages/cli/dist. */
export function packageDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, "adapters"))) return here;
  const dev = resolve(here, "..", "dist");
  if (existsSync(join(dev, "adapters"))) return dev;
  throw new WeftError("adapter bundles not found next to the CLI", "Run `pnpm --filter @celador/weft build` (monorepo) or reinstall the package.");
}

export function runtimeDir(env = process.env): string {
  return join(configDir(env), "runtime", VERSION);
}

/** Copy adapters + typescript into the per-version runtime (once). Returns the runtime dir. */
export function ensureRuntime(env = process.env): string {
  const rt = runtimeDir(env);
  const done = join(rt, ".complete");
  if (existsSync(done) && !VERSION.includes("dev")) return rt;
  const dist = packageDist();
  const tmp = `${rt}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(join(dist, "adapters"), join(tmp, "adapters"), { recursive: true });
  const req = createRequire(join(dist, "weft.mjs"));
  let tsDir: string;
  try {
    tsDir = dirname(req.resolve("typescript/package.json"));
  } catch {
    throw new WeftError("the `typescript` package is missing", "Reinstall: npx @celador/weft@latest");
  }
  cpSync(tsDir, join(tmp, "node_modules", "typescript"), { recursive: true, dereference: true });
  writeFileSync(join(tmp, ".complete"), new Date().toISOString() + "\n");
  rmSync(rt, { recursive: true, force: true });
  renameSync(tmp, rt);
  return rt;
}

/** Real path: the adapters only run their CLI when argv[1] equals their own (resolved) file. */
export function adapterBin(rt: string, id: HarnessId | "mcp"): string {
  const h = [...HARNESSES, WATCHER, MCP].find((x) => x.id === id)!;
  const p = join(rt, "adapters", id, h.entry);
  return existsSync(p) ? realpathSync(p) : p;
}

export type InstallSpec = { root: string; url: string; repo: string; agent: string; task: string; title: string; change: string; token: string };

/** Run one adapter's `install` in a checkout (writes .weft/<harness>.json, hooks, git hooks). */
export function installAdapter(rt: string, id: HarnessId, s: InstallSpec): void {
  const args = [adapterBin(rt, id), "install", "--dir", s.root, "--url", s.url, "--repo", s.repo, "--agent", s.agent, "--task", s.task, "--title", s.title, "--change", s.change];
  const r = spawnSync(process.execPath, args, { env: { ...process.env, WEFT_TOKEN: s.token }, encoding: "utf8" });
  if (process.env.WEFT_DEBUG) process.stderr.write(`[weft debug] ${args.slice(1).join(" ")}\n${r.stdout}${r.stderr}`);
  if (r.status !== 0) throw new WeftError(`${harnessName(id)} adapter install failed in ${s.root}:\n${(r.stderr || r.stdout).trim()}`);
}

/** Which adapters are installed in a checkout (by their .weft/<harness>.json). */
export function installedIn(root: string): Array<HarnessId | "mcp"> {
  return [...HARNESSES, WATCHER, MCP].filter((h) => existsSync(join(root, h.config))).map((h) => h.id);
}

// ------------------------------------------------------------------ removal

const hasMark = (v: unknown) => typeof v === "string" && MARKS.some((m) => v.includes(m));

/** Claude Code `permissions.allow` rules the adapter adds for the agent's Weft command. */
const isWeftAllow = (v: unknown) => typeof v === "string" && /^Bash\(.*\.weft\/bin\/weft:\*\)$/.test(v);

/** Drop hook entries whose command runs a Weft adapter (and Weft's allow rules); drop entries/groups left empty. */
export function pruneHooks(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        if (hasMark(o.command) || hasMark(o.bash)) continue;
        const pruned = pruneHooks(o) as Record<string, unknown>;
        if (Array.isArray(o.hooks) && o.hooks.length && !(Array.isArray(pruned.hooks) && pruned.hooks.length)) continue;
        out.push(pruned);
      } else if (!hasMark(item) && !isWeftAllow(item)) out.push(item);
    }
    return out;
  }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = pruneHooks(val);
      if (Array.isArray(val) && val.length && Array.isArray(p) && !p.length) continue; // e.g. hooks.PreToolUse emptied
      if (val && typeof val === "object" && !Array.isArray(val) && Object.keys(val).length && p && typeof p === "object" && !Array.isArray(p) && !Object.keys(p).length) continue;
      o[k] = p;
    }
    return o;
  }
  return v;
}

const HOOK_FILES = [".claude/settings.local.json", ".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json", ".gemini/settings.json", ".agents/hooks.json"];

/** Remove every Weft adapter from a checkout: harness hook entries, plugin, git hooks, .weft/. Returns what it touched. */
export function removeAdapters(root: string): string[] {
  const touched: string[] = [];
  for (const rel of HOOK_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    if (!hasMark(raw)) continue;
    const pruned = pruneHooks(readJson<unknown>(p, {})) as Record<string, unknown>;
    if (!Object.keys(pruned).length || (Object.keys(pruned).length === 1 && pruned.hooks && !Object.keys(pruned.hooks as object).length)) {
      unlinkSync(p);
      try {
        if (!readdirSync(dirname(p)).length) rmSync(dirname(p), { recursive: true });
      } catch {
        /* fine */
      }
    } else writeFileSync(p, JSON.stringify(pruned, null, 2) + "\n");
    touched.push(rel);
  }
  for (const rel of [".opencode/plugin/weft.js", ".github/hooks/weft.json"]) {
    const f = join(root, rel);
    if (existsSync(f) && hasMark(readFileSync(f, "utf8"))) {
      unlinkSync(f);
      touched.push(rel);
    }
  }
  // git hooks: ours are removed; a hook we had moved aside (.pre-weft) is put back.
  const hooksDir = tryGit(root, ["config", "core.hooksPath"]) ?? tryGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  if (hooksDir) {
    const dir = resolve(root, hooksDir);
    for (const name of ["commit-msg", "pre-commit"]) {
      const p = join(dir, name);
      if (existsSync(p) && hasMark(readFileSync(p, "utf8"))) {
        unlinkSync(p);
        if (existsSync(`${p}.pre-weft`)) renameSync(`${p}.pre-weft`, p);
        touched.push(`git hook ${name}`);
      }
    }
    // the per-worktree hooksPath the adapters set for linked worktrees
    const gitDir = tryGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    if (gitDir && resolve(root, hooksDir) === join(gitDir, "hooks")) {
      tryGit(root, ["config", "--worktree", "--unset", "core.hooksPath"]);
      try {
        if (!readdirSync(join(gitDir, "hooks")).length) rmSync(join(gitDir, "hooks"), { recursive: true });
      } catch {
        /* fine */
      }
    }
  }
  const weft = join(root, ".weft");
  if (existsSync(weft) && statSync(weft).isDirectory()) {
    rmSync(weft, { recursive: true, force: true });
    touched.push(".weft/");
  }
  return touched;
}
