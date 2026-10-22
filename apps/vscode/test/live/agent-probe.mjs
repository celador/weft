#!/usr/bin/env node
// Does the editor's own agent read Weft's squiggles? (docs/harness-coverage.md §7 Q5)
//
//   node apps/vscode/test/live/agent-probe.mjs --app vscode|cursor --url http://localhost:8831
//
// 1. A real conflict on the local gateway: live-run.mjs setup + agents (two Claude Code agents);
//    as soon as claude-b's edit is refused, john pauses claude-b, so the squiggle stays open.
// 2. The editor starts on claude-b's checkout with celador.weft from the .vsix, in a clean
//    profile seeded with this machine's signed-in editor session (Copilot for VS Code, Cursor's
//    own for Cursor; the profile is deleted at the end), with a DevTools port for the driver.
// 3. With src/pricing.ts open (the squiggle is on calcTotal), the driver asks the editor's agent
//    "what errors are in this file?" and records the answer and screenshots in
//    demo/evidence/vscode/agent-probe-<app>/.
//
// Cursor: its agent stayed signed out in the seeded clean profile ("Log in" in the agent pane),
// and Cursor 3 opens its own profile in the Agents window rather than on the folder, so the Cursor
// probe has not produced an answer yet (docs/harness-coverage.md §7 Q5).
//
// Needs PLAYWRIGHT (path to playwright-core's index.mjs) or playwright-core resolvable, plus the
// run.mjs prerequisites. Tokens are never printed.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "..");
const root = join(ext, "..", "..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const app = opt("app", "vscode");
const url = opt("url", "http://localhost:8831");
const question = opt("question", "what errors are in this file?");
const support = join(process.env.HOME, "Library", "Application Support");
const APPS = {
  vscode: {
    exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    cli: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    authFrom: join(support, "Code", "User", "globalStorage", "state.vscdb"),
    // GitHub sign-in (encrypted with this app's own Keychain key) and Copilot's account state.
    authKeys: ["secret://{\"extensionId\":\"vscode.github-authentication\",\"key\":\"github.auth\"}", "vscode.github-authentication", "github.copilot%", "GitHub.copilot%"],
    openChat: "Control+Meta+I",
  },
  cursor: {
    exe: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    cli: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    authFrom: join(support, "Cursor", "User", "globalStorage", "state.vscdb"),
    authKeys: ["cursorAuth/%", "%reactivestorage%applicationUser%", "workbench.contrib.onboarding%", "cursor/glass.%", "cursor/hasShown%"],
    openChat: "Meta+L",
  },
};
const a = APPS[app];
if (!a || !existsSync(a.exe)) throw new Error(`${app} is not installed`);
const version = JSON.parse(readFileSync(join(ext, "package.json"), "utf8")).version;
const vsix = join(ext, "out", `weft-${version}.vsix`);
const run = resolve(opt("dir", `/tmp/wp-${app}-${Date.now().toString(36)}`));
const out = resolve(opt("out", join(root, "demo", "evidence", "vscode", `agent-probe-${app}`)));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(run, { recursive: true });
const notes = [];
const log = (m) => {
  notes.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  console.log(`[probe ${app}] ${m}`);
  writeFileSync(join(out, "probe.log"), notes.join("\n") + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const liveRun = join(root, "packages", "feed", "demo", "live-run.mjs");

// 1. The conflict, held open by a pause.
let r = spawnSync(process.execPath, [liveRun, "setup", "--url", url, "--dir", run], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
const info = JSON.parse(readFileSync(join(run, "run.json"), "utf8"));
const human = readFileSync(join(run, "human-token"), "utf8").trim();
const ws = info.wb;
copyFileSync(join(run, "human-token"), join(ws, ".weft", "human-token"));
const H = { authorization: `Bearer ${human}`, "wcp-version": "0.1", "content-type": "application/json" };
const events = async () => (await (await fetch(`${url}/v1/repos/${info.repo}/events?limit=500`, { headers: H })).json()).events;
const agents = spawn(process.execPath, [liveRun, "agents", "--dir", run], { stdio: ["ignore", "pipe", "pipe"] });
let agentLog = "";
agents.stdout.on("data", (d) => (agentLog += d));
agents.stderr.on("data", (d) => (agentLog += d));
const agentsDone = new Promise((res) => agents.on("close", res));
let denied;
for (const t = Date.now(); !denied; await sleep(500)) {
  if (Date.now() - t > 600_000) throw new Error("no refused edit from claude-b");
  denied = (await events()).find((e) => e.agent === "claude-b" && e.kind === "edit" && e.status !== "accepted");
}
const pause = await fetch(`${url}/v1/repos/${info.repo}/actions`, { method: "POST", headers: H, body: JSON.stringify({ type: "action", action: "pause", agent: "claude-b", reason: "hold the conflict open for the agent probe" }) });
log(`claude-b's edit #${denied.seq} was ${denied.status}; pause claude-b → HTTP ${pause.status}`);
await agentsDone;
writeFileSync(join(out, "agents.log"), agentLog.split(run).join("<run>"));
log("agents done; the squiggle stays open (claude-b is paused)");

// 2. The editor, signed in, with the .vsix.
const userData = join(run, `${app}-user`);
const extDir = join(run, `${app}-ext`);
const profileArgs = [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`];
const cliProfile = ["--user-data-dir", userData, "--extensions-dir", extDir];
{
  mkdirSync(join(userData, "User", "globalStorage"), { recursive: true });
  writeFileSync(
    join(userData, "User", "settings.json"),
    JSON.stringify({ "workbench.startupEditor": "none", "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "workbench.tips.enabled": false, "window.restoreWindows": "none", "editor.minimap.enabled": false, "chat.tools.autoApprove": false }, null, 2),
  );
  const where = a.authKeys.map((k) => `key LIKE '${k.replace(/'/g, "''")}'`).join(" OR ");
  r = spawnSync("sqlite3", [join(userData, "User", "globalStorage", "state.vscdb"), `ATTACH '${a.authFrom}' AS src; CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable SELECT key, value FROM src.ItemTable WHERE ${where}; SELECT count(*) FROM ItemTable;`], { encoding: "utf8" });
  log(`profile seeded with ${r.stdout.trim()} session rows`);
  r = spawnSync(a.cli, ["--user-data-dir", userData, "--extensions-dir", extDir, "--install-extension", vsix, "--force"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}
const port = 9400 + Math.floor(Math.random() * 400);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WEFT_TOKEN;
const editor = spawn(a.exe, [ws, "--new-window", "--skip-welcome", "--skip-release-notes", ...profileArgs, `--remote-debugging-port=${port}`], { env, stdio: "ignore" });
let browser;
try {
  for (const t = Date.now(); !browser; await sleep(1000)) {
    if (Date.now() - t > 60_000) throw new Error("no DevTools endpoint");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  let page;
  for (const t = Date.now(); !page; await sleep(1000)) {
    if (Date.now() - t > 60_000) throw new Error("no workbench page");
    const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => /workbench/.test(p.url()));
    // The window on the probe's checkout (the editor's own profile may restore other windows).
    for (const p of pages) if ((await p.title().catch(() => "")).includes(basename(ws))) page = p;
    if (!page) page = pages[0];
  }
  await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  await sleep(6000);
  spawnSync(a.cli, [...cliProfile, "-r", join(ws, "src", "pricing.ts")]);
  // The squiggle: wait for the Weft item in the status bar / the marker in the editor.
  const squiggle = await page.waitForSelector(".squiggly-error, .squiggly-warning", { timeout: 60_000 }).then(() => true, () => false);
  log(`pricing.ts open; squiggle in the editor: ${squiggle}`);
  await sleep(1500);
  await page.screenshot({ path: join(out, "1-squiggle.png") });

  // 3. Ask the editor's own agent.
  await page.bringToFront();
  await page.keyboard.press(a.openChat);
  await sleep(2500);
  await page.keyboard.insertText(question);
  await sleep(500);
  await page.screenshot({ path: join(out, "2-question.png") });
  await page.keyboard.press("Enter");
  log(`asked: "${question}"`);
  // Collect the answer: wait until the chat text stops changing (or 3 minutes).
  const chatText = () =>
    page.evaluate(() => {
      const sel = [".interactive-session", ".interactive-list", "[class*='composer']", "[class*='aichat']", "[class*='agent-panel']", ".chat-widget"];
      const nodes = sel.flatMap((s) => [...document.querySelectorAll(s)]);
      return nodes.map((n) => n.innerText || "").sort((x, y) => y.length - x.length)[0] ?? "";
    });
  let last = "";
  let stable = 0;
  for (const t = Date.now(); Date.now() - t < 180_000 && stable < 6; await sleep(2500)) {
    const now = await chatText();
    stable = now === last && now.length > question.length + 20 ? stable + 1 : 0;
    last = now;
  }
  writeFileSync(join(out, "answer.txt"), last + "\n");
  await page.screenshot({ path: join(out, "3-answer.png") });
  const mentions = /calcTotal|contract changed|claude-a|Weft|stale_assumption|event #4/i.test(last);
  log(`answer captured (${last.length} chars); mentions the Weft squiggle: ${mentions}`);
} finally {
  await browser?.close().catch(() => {});
  editor.kill();
  await sleep(1500);
  rmSync(userData, { recursive: true, force: true }); // the seeded session goes with the profile
  log("editor closed; profile deleted");
}
