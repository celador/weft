// Runs inside the VS Code extension host (loaded by @vscode/test-electron). Checks the glue:
// activation, the feed view, squiggles with cause links, the code action, weft-event
// documents and the diff editor, live updates clearing a squiggle, and an action that falls
// through from an observe-only token to a human token.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const STUB = process.env.WEFT_SMOKE_STUB;
const WS = process.env.WEFT_SMOKE_WS;
const REPO = process.env.WEFT_SMOKE_REPO;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20000) {
  const t = Date.now();
  let last;
  while (Date.now() - t < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✓ ${name}`);
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("celador.weft");
  assert.ok(ext, "celador.weft is installed");
  const api = await ext.activate();
  const pricing = vscode.Uri.file(path.join(WS, "src", "pricing.ts"));

  await check("activates and connects with the observe token from WEFT_TOKEN", async () => {
    const st = await until("records", () => (api.state().records >= 8 ? api.state() : undefined));
    assert.equal(st.tokenWhere, "WEFT_TOKEN");
    assert.deepEqual(st.repos, [REPO]);
    await until("live socket", () => api.state().status === "live");
  });

  await check("the feed view opens in the panel", async () => {
    await vscode.commands.executeCommand("weft.showFeed");
    await until("webview", () => api.state().views >= 1);
  });

  let diag;
  await check("open squiggle on calcTotal's declaration, linked to its cause", async () => {
    const ds = await until("weft diagnostics", () => vscode.languages.getDiagnostics(pricing).filter((d) => d.source === "Weft").length && vscode.languages.getDiagnostics(pricing).filter((d) => d.source === "Weft"));
    assert.equal(ds.length, 1);
    diag = ds[0];
    assert.equal(diag.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(diag.range.start.line, 2);
    const doc = await vscode.workspace.openTextDocument(pricing);
    assert.equal(doc.getText(diag.range), "calcTotal");
    assert.match(diag.message, /caused by claude-a · event #4/);
    assert.equal(diag.code.value, "stale_assumption");
    assert.equal(diag.code.target.scheme, "weft-event");
    assert.equal(diag.relatedInformation.length, 1);
    assert.match(diag.relatedInformation[0].message, /^caused by claude-a · event #4/);
    assert.equal(diag.relatedInformation[0].location.uri.scheme, "weft-event");
  });

  await check("code action “Open causing event” on the squiggle", async () => {
    await vscode.window.showTextDocument(pricing);
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", pricing, diag.range);
    const open = actions.find((a) => a.title === "Open causing event (#4)");
    assert.ok(open, `actions: ${actions.map((a) => a.title).join(", ")}`);
    assert.deepEqual(open.command.arguments, [`${REPO}#4`]);
  });

  await check("weft-event documents: the cause's record and both sides of its diff", async () => {
    const rec = await vscode.workspace.openTextDocument(diag.relatedInformation[0].location.uri);
    assert.match(rec.getText(), new RegExp(`# ${REPO} #4 · edit · accepted`));
    const after = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "weft-event", path: `/${encodeURIComponent(REPO)}/4/after/src/pricing.ts` }));
    const before = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "weft-event", path: `/${encodeURIComponent(REPO)}/4/before/src/pricing.ts` }));
    assert.match(after.getText(), /opts: PriceOptions/);
    assert.doesNotMatch(before.getText(), /opts: PriceOptions/);
    assert.equal(after.languageId, "typescript");
  });

  await check("Open causing event opens the native diff editor", async () => {
    await vscode.commands.executeCommand("weft.openCausingEvent", `${REPO}#4`);
    const tab = await until("diff tab", () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === "weft-event"));
    assert.match(tab.label, /src\/pricing\.ts · claude-a/);
  });

  await check("Pause falls through the observe-only token to .weft/human-token and lands in the log", async () => {
    await vscode.commands.executeCommand("weft.pause", { repo: REPO, agent: "claude-b" });
    const { actions } = await (await fetch(`${STUB}/__test/actions`)).json();
    assert.deepEqual(actions.map((a) => [a.who, a.action.action, a.action.agent]), [
      ["observe", "pause", "claude-b"],
      ["human", "pause", "claude-b"],
    ]);
    await until("pause record in the log", () => api.session().log.combined.find((e) => e.kind === "control" && e.payload?.action === "pause"));
  });

  await check("a live record (claude-b redoes the edit, #9) clears the squiggle", async () => {
    const res = await fetch(`${STUB}/__test/append`, { method: "POST", body: JSON.stringify({ seq: 9 }) });
    assert.equal(res.status, 200);
    await until("squiggle cleared", () => vscode.languages.getDiagnostics(pricing).filter((d) => d.source === "Weft").length === 0);
    assert.ok(api.session().log.event(REPO, 9));
  });

  await check("status bar state: repo, agents editing, squiggles", async () => {
    const st = api.state();
    assert.deepEqual(st.editing.map((e) => e.agent).sort(), ["claude-a", "claude-b"]);
    assert.equal(st.squiggles.length, 0);
  });

  console.log(`smoke: ${results.length} checks passed`);
};
