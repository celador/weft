// The live run's driver, inside the editor's extension host (VS Code or a fork). celador.weft is
// installed from the .vsix; this suite only uses its public commands and api.state(), the way a
// person would, and takes window screenshots at each beat:
//   1. the feed live while the two Claude Code agents work;
//   2. the squiggle on claude-b's checkout, hovered (cause link + quick fix);
//   3. Open causing event: claude-a's diff in the native diff editor;
//   4. Pause claude-b, Message claude-b, Resume claude-b (human actions in the log);
//   5. the feed at the end, with Editing now listing both tasks.
// The orchestrator (run.mjs) starts the agents when READY appears and writes AGENTS_DONE.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

const RUN = process.env.WEFT_LIVE_RUN;
const OUT = process.env.WEFT_LIVE_OUT;
const WS = process.env.WEFT_LIVE_WS;
// The editor's main process owns its windows; the extension host is its child. Matching windows
// by that pid (not the app name) never captures another VS Code/Cursor window on the machine.
const OWNER = String(process.ppid);
const WINID = process.env.WEFT_LIVE_WINID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const notes = [];
function note(m) {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`;
  notes.push(line);
  console.log(`live: ${line}`);
  fs.writeFileSync(path.join(OUT, "driver.log"), notes.join("\n") + "\n");
}
async function until(what, fn, ms = 600_000, every = 250) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}
function shot(name) {
  const file = path.join(OUT, name);
  try {
    const ids = windowIds(OWNER);
    if (!ids.length) throw new Error(`no window owned by pid ${OWNER} or its parent`);
    execFileSync("screencapture", ["-x", "-o", `-l${ids[0]}`, file]);
    note(`screenshot ${name}`);
  } catch (e) {
    note(`screenshot ${name} FAILED: ${e.message}`);
  }
}
// The workbench window (its title names the workspace folder) wins over any other window of the
// same process, such as Cursor's sign-in window; then the largest window.
function windowIds(pid) {
  const list = (p, title = "") => execFileSync(WINID, [p, title], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  const parent = execFileSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" }).trim();
  const pids = [pid, ...(parent && parent !== "1" ? [parent] : [])];
  for (const p of pids) {
    const ids = list(p, path.basename(WS));
    if (ids.length) return ids;
  }
  for (const p of pids) {
    const ids = list(p);
    if (ids.length) return ids;
  }
  return [];
}
const weftDiags = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "Weft");

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("celador.weft");
  if (!ext) throw new Error("celador.weft is not installed");
  note(`celador.weft ${ext.packageJSON.version} from ${ext.extensionPath} in ${vscode.env.appName} ${vscode.version}`);
  const api = await ext.activate();
  const pricing = vscode.Uri.file(path.join(WS, "src", "pricing.ts"));
  const cart = vscode.Uri.file(path.join(WS, "src", "cart.ts"));
  const st0 = await until("live", () => (api.state().status === "live" ? api.state() : undefined), 60_000);
  note(`connected: ${st0.url} repos=${st0.repos.join(",")} token=${st0.tokenWhere} records=${st0.records}`);

  await vscode.window.showTextDocument(cart, { viewColumn: vscode.ViewColumn.One });
  await vscode.window.showTextDocument(pricing, { viewColumn: vscode.ViewColumn.Two });
  await vscode.commands.executeCommand("weft.showFeed");
  await until("feed view", () => api.state().views >= 1, 30_000);
  // devhost (Cursor): run.mjs skips the first-run overlay first; wait for it (or give up after 90 s).
  if (process.env.WEFT_LIVE_MODE === "devhost") await until("first-run overlay", () => fs.existsSync(path.join(RUN, "FIRSTRUN_DONE")), 90_000, 500).catch(() => note("first-run overlay: no answer"));
  await sleep(1500);
  shot("0-ready.png");
  fs.writeFileSync(path.join(RUN, "READY"), String(Date.now()));
  note("READY: the orchestrator starts the agents now");

  // 1. The feed live: claude-a's calcTotal edit arrives.
  const repo = st0.repos[0];
  const a4 = await until("claude-a's edit", () => api.session()?.log.combined.find((e) => e.kind === "edit" && e.agent === "claude-a" && e.status === "accepted"));
  note(`live: ${repo} #${a4.seq} ${a4.summary}`);
  await sleep(800);
  shot("1-feed-live.png");

  // 2. The squiggle: claude-b's edit is refused; the diagnostic lands on calcTotal in this checkout.
  const diag = await until("Weft squiggle", () => weftDiags(pricing)[0] || weftDiags(cart)[0], 600_000, 100);
  note(`squiggle: ${diag.message} | related: ${diag.relatedInformation?.[0]?.message}`);
  const st = api.state();
  // A human sees it and pauses claude-b before it tries again.
  await vscode.commands.executeCommand("weft.pause", { repo, agent: "claude-b" });
  note("Pause claude-b sent");
  const file = weftDiags(pricing).length ? pricing : cart;
  const ed = await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.Two });
  ed.selection = new vscode.Selection(diag.range.start, diag.range.start);
  ed.revealRange(diag.range, vscode.TextEditorRevealType.InCenter);
  await sleep(300);
  await vscode.commands.executeCommand("editor.action.showHover");
  await sleep(1500);
  shot("2-squiggle-hover.png");
  const actions = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", file, diag.range, vscode.CodeActionKind.QuickFix.value)) ?? [];
  note(`code actions: ${actions.map((a) => a.title).join(" | ")}`);
  await vscode.commands.executeCommand("workbench.actions.view.problems");
  await sleep(1200);
  shot("3-problems.png");

  // 3. Open causing event: the feed selects the cause, and its diff opens.
  const cause = diag.relatedInformation[0].location.uri.path.split("/").filter(Boolean);
  const causeId = `${decodeURIComponent(cause[0])}#${cause[1]}`;
  await vscode.commands.executeCommand("weft.openCausingEvent", causeId);
  await until("diff tab", () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === "weft-event"), 20_000);
  await sleep(1500);
  shot("4-cause-diff.png");
  note(`opened ${causeId} (feed selection + diff)`);

  // 4. Message claude-b, then resume it.
  await vscode.commands.executeCommand("weft.message", { repo, agent: "claude-b", text: "calcTotal now takes (items, opts: PriceOptions). Call calcTotal(items, { taxRate: 0 }) so the cart total stays net." });
  note("Message claude-b sent");
  await sleep(1500);
  shot("5-paused-message.png");
  await vscode.commands.executeCommand("weft.resume", { repo, agent: "claude-b" });
  note("Resume claude-b sent");

  // 5. Wait for the agents; the end state.
  await until("agents done", () => fs.existsSync(path.join(RUN, "AGENTS_DONE")), 900_000, 1000);
  await sleep(4000);
  const end = api.state();
  note(`end: records=${end.records} editing=${end.editing.map((e) => `${e.agent}:${e.title ?? ""}`).join(", ")} squiggles=${end.squiggles.length}`);
  const humans = api.session().log.combined.filter((e) => e.actor?.type === "human").map((e) => `#${e.seq} ${e.kind} ${e.summary}`);
  note(`human records: ${humans.join(" | ")}`);
  const pauseRec = api.session().log.combined.find((e) => e.kind === "control" && /pause/.test(e.summary ?? ""));
  if (pauseRec) await vscode.commands.executeCommand("weft.openEvent", `${pauseRec.repo}#${pauseRec.seq}`);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("weft.showFeed");
  await sleep(1500);
  await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
  await sleep(2000);
  shot("6-feed-end.png");
  fs.writeFileSync(
    path.join(OUT, "state.json"),
    JSON.stringify({ app: vscode.env.appName, version: vscode.version, atSquiggle: st, end, squiggle: { message: diag.message, related: diag.relatedInformation?.[0]?.message, code: diag.code?.value }, codeActions: actions.map((a) => a.title), humans }, null, 2) + "\n",
  );
  note("done");
};
