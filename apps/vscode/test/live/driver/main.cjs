// Dev-host mode for the live run (`run.mjs --mode devhost`, the default for Cursor): Cursor ends
// an --extensionTestsPath run early (the app exited ~35 s in, before the agents were done), so the
// driver runs as a plain development extension instead and reports through files in the run dir.
const fs = require("node:fs");
const path = require("node:path");
exports.activate = function activate() {
  const run = process.env.WEFT_LIVE_RUN;
  if (!run || process.env.WEFT_LIVE_MODE !== "devhost") return;
  require("../suite.cjs")
    .run()
    .then(
      () => fs.writeFileSync(path.join(run, "DRIVER_DONE"), "ok"),
      (e) => fs.writeFileSync(path.join(run, "DRIVER_DONE"), `failed: ${e?.stack ?? e}`),
    );
};
exports.deactivate = function deactivate() {};
