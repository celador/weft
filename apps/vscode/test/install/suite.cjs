// Runs in the editor's extension host (see run.mjs). Reads the installed celador.weft's API.
const { writeFileSync } = require("node:fs");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const out = { pass: false, checks: [] };
  const done = () => writeFileSync(process.env.WEFT_INSTALL_OUT, JSON.stringify(out, null, 2));
  try {
    const ext = vscode.extensions.getExtension("celador.weft");
    if (!ext) throw new Error("celador.weft is not installed");
    out.version = ext.packageJSON.version;
    const api = await ext.activate();
    out.checks.push("installed and activated");
    let st;
    for (let i = 0; i < 150; i++) {
      st = api.state();
      if (st.status === "live" && st.repos.length) break;
      await sleep(200);
    }
    out.state = { url: st.url, status: st.status, tokenWhere: st.tokenWhere, repos: st.repos, records: st.records, canAct: st.canAct };
    if (st.status !== "live") throw new Error(`not live: ${st.status}`);
    out.checks.push(`live on ${st.url}`);
    if (!st.repos.includes(process.env.WEFT_INSTALL_REPO)) throw new Error(`repo ${process.env.WEFT_INSTALL_REPO} not in ${st.repos.join(",")}`);
    out.checks.push(`found the space's repo from .weft/ (token: ${st.tokenWhere})`);
    await vscode.commands.executeCommand("weft.showFeed");
    for (let i = 0; i < 50 && api.state().views < 1; i++) await sleep(200);
    if (api.state().views < 1) throw new Error("feed view did not open");
    out.checks.push("feed view opened");
    out.pass = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  done();
  if (!out.pass) throw new Error(out.error);
};
