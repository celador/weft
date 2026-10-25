#!/usr/bin/env node
// The Weft plugin's hook launcher (Claude Code and GitHub Copilot CLI). No dependencies.
//
//   weft-hook.mjs hook <claude-code|copilot> [event]   hook entry: payload on stdin, answer on stdout
//   weft-hook.mjs adopt <claude-code|copilot> [dir]    let the plugin own this checkout's hooks
//   weft-hook.mjs where <claude-code|copilot> [dir]    print the checkout and adapter it would use
//
// `hook` runs the Weft adapter that `npx @celador/weft` installed (~/.config/weft/runtime/<v>/)
// in a checkout it set up (one with .weft/claude.json or .weft/copilot.json). Anywhere else it
// answers nothing and exits 0, so the plugin is silent in repos without Weft. When the checkout's
// own hook file already runs the adapter (`npx @celador/weft` writes .claude/settings.local.json or
// .github/hooks/weft.json), the plugin steps aside so each hook runs once.
//
// `adopt` removes the adapter's entries from the checkout's hook file, so the plugin's hooks
// (loaded at session start) take over: Weft works in the running session with no restart.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HARNESS = {
  "claude-code": { config: ".weft/claude.json", entry: "weft-claude.mjs", mark: "weft-claude", files: [".claude/settings.local.json", ".claude/settings.json"] },
  copilot: { config: ".weft/copilot.json", entry: "weft-copilot.mjs", mark: "weft-copilot", files: [".github/hooks/weft.json"], dir: ".github/hooks" },
};

const [cmd, harnessId, arg] = process.argv.slice(2);
const h = HARNESS[harnessId];
if (!h || !["hook", "adopt", "where"].includes(cmd)) {
  process.stderr.write("usage: weft-hook.mjs hook|adopt|where claude-code|copilot [event|dir]\n");
  process.exit(cmd === "hook" ? 0 : 2); // a hook never fails the harness
}

function findRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, h.config))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function configDir() {
  if (process.env.WEFT_HOME) return process.env.WEFT_HOME;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "weft");
}

const semver = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
function newer(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The newest complete runtime's adapter for this harness. */
function adapter() {
  const rt = join(configDir(), "runtime");
  let best;
  try {
    for (const v of readdirSync(rt)) {
      const p = join(rt, v, "adapters", harnessId, h.entry);
      if (existsSync(join(rt, v, ".complete")) && existsSync(p) && (!best || newer(v, best.v))) best = { v, p: realpathSync(p) };
    }
  } catch {
    /* no runtime yet */
  }
  return best?.p;
}

/** Hook files in the checkout that already run the adapter. */
function ownHookFiles(root) {
  return h.files.filter((rel) => {
    try {
      return readFileSync(join(root, rel), "utf8").includes(h.mark);
    } catch {
      return false;
    }
  });
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (cmd === "hook") {
  const input = readStdin();
  let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const j = JSON.parse(input);
    if (typeof j.cwd === "string" && j.cwd) cwd = j.cwd;
  } catch {
    /* not JSON: use the process cwd */
  }
  const root = findRoot(cwd);
  const bin = root && !ownHookFiles(root).length ? adapter() : undefined;
  if (!bin) process.exit(0);
  const r = spawnSync(process.execPath, [bin, "hook", ...(arg ? [arg] : [])], { input, cwd, stdio: ["pipe", "inherit", "inherit"], env: process.env });
  process.exit(r.status ?? 0);
}

const root = findRoot(arg ? resolve(arg) : process.cwd());
if (cmd === "where") {
  const own = root ? ownHookFiles(root) : [];
  console.log(JSON.stringify({ checkout: root ?? null, adapter: adapter() ?? null, hooksFrom: !root ? "none (run npx @celador/weft)" : own.length ? own.join(", ") : "plugin" }, null, 2));
  process.exit(0);
}

// adopt
if (!root) {
  console.error(`No Weft checkout here (no ${h.config}). Run \`npx @celador/weft\` first.`);
  process.exit(1);
}
if (!adapter()) {
  console.error("No Weft runtime in ~/.config/weft/runtime. Run `npx @celador/weft` first.");
  process.exit(1);
}
const isOurs = (e) => e && typeof e === "object" && [e.command, e.bash].some((c) => typeof c === "string" && c.includes(h.mark));
for (const rel of ownHookFiles(root)) {
  const p = join(root, rel);
  if (harnessId === "copilot") {
    unlinkSync(p); // .github/hooks/weft.json holds only the adapter's entries
    try {
      if (!readdirSync(join(root, h.dir)).length) rmSync(join(root, h.dir), { recursive: true });
    } catch {
      /* fine */
    }
  } else {
    const j = JSON.parse(readFileSync(p, "utf8"));
    for (const [event, groups] of Object.entries(j.hooks ?? {})) {
      const kept = (Array.isArray(groups) ? groups : [])
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((x) => !isOurs(x)) }))
        .filter((g) => g.hooks.length);
      if (kept.length) j.hooks[event] = kept;
      else delete j.hooks[event];
    }
    if (j.hooks && !Object.keys(j.hooks).length) delete j.hooks;
    if (!Object.keys(j).length) unlinkSync(p);
    else writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  }
  console.log(`moved Weft's hooks out of ${rel}: the plugin runs them now`);
}
console.log(`Weft is on in ${root} (hooks from the plugin).`);
