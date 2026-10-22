#!/usr/bin/env node
// A REAL run of the packaged extension: two Claude Code agents (the Weft adapter, `claude -p`)
// collide on a local gateway while celador.weft, installed from out/weft-<v>.vsix into a clean
// profile, runs in VS Code or Cursor. Screenshots and the driver log go to
// demo/evidence/vscode/<app>/.
//
//   node apps/vscode/test/live/run.mjs --app vscode|cursor --url http://localhost:8831
//
// Needs: the gateway (`cd apps/gateway && pnpm dev:local --port 8831`), apps/gateway/.dev.vars.test
// (admin token, for the quickstart setup), `pnpm --filter @weft/vscode package`, the Claude Code
// adapter built, and `claude` logged in (or CLAUDE_CODE_OAUTH_TOKEN). Tokens are never printed.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "..");
const root = join(ext, "..", "..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const app = opt("app", "vscode");
const url = opt("url", "http://localhost:8831");
const APPS = {
  vscode: { exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Code", cli: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", owner: "Code" },
  cursor: { exe: "/Applications/Cursor.app/Contents/MacOS/Cursor", cli: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", owner: "Cursor", authFrom: join(process.env.HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"), authKeys: ["cursorAuth/%", "%reactivestorage%applicationUser%", "workbench.contrib.onboarding%", "cursor/glass.%", "cursor/hasShown%"] },
};
const a = APPS[app];
if (!a || !existsSync(a.exe)) throw new Error(`${app} is not installed (${a?.exe})`);
const version = JSON.parse(readFileSync(join(ext, "package.json"), "utf8")).version;
const vsix = join(ext, "out", `weft-${version}.vsix`);
if (!existsSync(vsix)) throw new Error(`build the .vsix first: ${vsix}`);
const scratch = process.env.TMPDIR ?? "/tmp";
// A short path: the editor puts its IPC socket under --user-data-dir (macOS caps those at 104 bytes).
const run = resolve(opt("dir", `/tmp/wl-${app}-${Date.now().toString(36)}`));
const out = resolve(opt("out", join(root, "demo", "evidence", "vscode", app)));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(run, { recursive: true });
const log = (m) => console.log(`[live ${app}] ${m}`);

// 1. A fresh repo, two worktrees with the Claude Code adapter, a human token (observe + human).
const liveRun = join(root, "packages", "feed", "demo", "live-run.mjs");
let r = spawnSync(process.execPath, [liveRun, "setup", "--url", url, "--dir", run], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
const runInfo = JSON.parse(readFileSync(join(run, "run.json"), "utf8"));
const ws = runInfo.wb; // claude-b's checkout: the one that gets the squiggle
copyFileSync(join(run, "human-token"), join(ws, ".weft", "human-token"));
log(`repo ${runInfo.repo}; workspace ${ws}`);

// 2. A clean profile with the .vsix installed (the same file for every editor).
const userData = join(run, `${app}-user`);
const extDir = join(run, `${app}-ext`);
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({ "window.newWindowDimensions": "maximized", "workbench.startupEditor": "none", "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "workbench.tips.enabled": false, "chat.commandCenter.enabled": false, "editor.minimap.enabled": false, "window.restoreWindows": "none" }, null, 2),
);
// Cursor puts sign-in and first-run cards (plugins, data sharing) over the workbench in a clean
// profile. Seeding the profile from this machine's own Cursor (the cursorAuth/* rows, its
// application state blob with the choices already made, and the onboarding flags of its
// state.vscdb; they stay in the run dir and are deleted at the end) keeps the workbench in front.
if (a.authFrom && !args.includes("--no-auth")) seedAuth(a.authFrom, a.authKeys, join(userData, "User", "globalStorage", "state.vscdb"));
r = spawnSync(a.cli, ["--user-data-dir", userData, "--extensions-dir", extDir, "--install-extension", vsix, "--force"], { encoding: "utf8" });
log(`install: ${(r.stdout + r.stderr).trim().split("\n").at(-1)}`);
if (r.status !== 0) process.exit(r.status ?? 1);

// 3. Start the editor with the driver; the agents start when the driver says READY.
// Always rebuilt: a stale binary of the same name elsewhere in $TMPDIR once broke every screenshot.
const winid = join(scratch, "weft-live-winid");
r = spawnSync("swiftc", ["-O", join(here, "winid.swift"), "-o", winid], { stdio: "inherit" });
if (r.status !== 0) throw new Error("swiftc winid.swift failed");
// test: @vscode/test-electron (--extensionTestsPath). devhost: the driver as a plain development
// extension (driver/main.cjs); Cursor ends test-mode runs early, so it defaults to devhost.
const mode = opt("mode", app === "cursor" ? "devhost" : "test");
const liveEnv = { WEFT_LIVE_RUN: run, WEFT_LIVE_OUT: out, WEFT_LIVE_WS: ws, WEFT_LIVE_WINID: winid, WEFT_LIVE_MODE: mode };
const editorArgs = [ws, "--new-window", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`];
let editor;
if (mode === "test") {
  editor = runTests({ vscodeExecutablePath: a.exe, extensionDevelopmentPath: join(here, "driver"), extensionTestsPath: join(here, "suite.cjs"), launchArgs: editorArgs, extensionTestsEnv: liveEnv });
} else {
  const env = { ...process.env, ...liveEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const port = 9400 + Math.floor(Math.random() * 400);
  const p = spawn(a.exe, [...editorArgs, `--extensionDevelopmentPath=${join(here, "driver")}`, `--remote-debugging-port=${port}`], { env, stdio: "ignore" });
  dismissFirstRun(port)
    .catch((e) => log(`first-run overlay: ${e.message}`))
    .finally(() => writeFileSync(join(run, "FIRSTRUN_DONE"), "1"));
  editor = (async () => {
    const done = join(run, "DRIVER_DONE");
    const t = Date.now();
    while (!existsSync(done)) {
      if (p.exitCode !== null) throw new Error(`${app} exited ${p.exitCode} before the driver finished`);
      if (Date.now() - t > 1_200_000) throw new Error("the driver never finished");
      await new Promise((res) => setTimeout(res, 1000));
    }
    p.kill();
    const result = readFileSync(done, "utf8");
    if (result !== "ok") throw new Error(result);
  })();
}
editor.catch(() => {}); // awaited below, after the agents; this only stops an early unhandled rejection
const t = Date.now();
while (!existsSync(join(run, "READY"))) {
  if (Date.now() - t > 180_000) throw new Error("the editor never became ready");
  await new Promise((res) => setTimeout(res, 500));
}
log("editor ready; starting the agents");
const agents = spawn(process.execPath, [liveRun, "agents", "--dir", run], { stdio: ["ignore", "pipe", "pipe"] });
let agentLog = "";
agents.stdout.on("data", (d) => ((agentLog += d), process.stdout.write(d)));
agents.stderr.on("data", (d) => ((agentLog += d), process.stderr.write(d)));
const code = await new Promise((res) => agents.on("close", res));
writeFileSync(join(out, "agents.log"), agentLog.split(run).join("<run>"));
writeFileSync(join(run, "AGENTS_DONE"), String(code));
log(`agents exited ${code}`);
let failed = 0;
try {
  await editor;
} catch (e) {
  console.error(e);
  failed = 1;
}
r = spawnSync(process.execPath, [liveRun, "record", "--dir", run, "--out", join(out, "log.json")], { stdio: "inherit" });
for (const f of ["a-signature.prompt.txt", "b1-plan.prompt.txt", "b2-implement.prompt.txt"]) if (existsSync(join(run, f))) copyFileSync(join(run, f), join(out, f));
rmSync(userData, { recursive: true, force: true }); // the profile (and any seeded session) goes
log(failed ? "FAILED" : `done: ${out}`);
process.exit(failed || code ? 1 : 0);

function seedAuth(from, keys, to) {
  if (!existsSync(from)) return log(`no ${from}; the editor starts signed out`);
  mkdirSync(dirname(to), { recursive: true });
  const where = keys.map((k) => `key LIKE '${k.replace(/'/g, "''")}'`).join(" OR ");
  const sql = `ATTACH '${from.replace(/'/g, "''")}' AS src; CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable SELECT key, value FROM src.ItemTable WHERE ${where};`;
  const s = spawnSync("sqlite3", [to, sql], { encoding: "utf8" });
  if (s.status !== 0) throw new Error(`seeding the profile failed: ${s.stderr}`);
  log(`profile seeded with this machine's signed-in session (${keys.join(", ")})`);
}

// Cursor's clean profile puts a first-run card ("Plugins give your agents important context",
// Continue / Skip) over the workbench, which would hide every screenshot. Skip it over the DevTools
// port, the way a person would click Skip. Needs playwright-core (PLAYWRIGHT=<path to index.mjs>).
async function dismissFirstRun(port) {
  let pw;
  try {
    pw = await import(process.env.PLAYWRIGHT ?? "playwright-core");
  } catch {
    return log("no playwright-core: the first-run overlay stays (set PLAYWRIGHT)");
  }
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  if (!browser) return log("first-run overlay: no DevTools endpoint");
  try {
    for (let i = 0; i < 60; i++) {
      for (const page of browser.contexts().flatMap((c) => c.pages())) {
        const skip = page.getByRole("button", { name: /^Skip$/ }).or(page.locator("text=/^Skip$/"));
        if (await skip.first().isVisible().catch(() => false)) {
          await skip.first().click();
          await new Promise((r) => setTimeout(r, 1000));
          return log("first-run overlay skipped");
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    log("first-run overlay: none seen");
  } finally {
    await browser.close().catch(() => {});
  }
}
