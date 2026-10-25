#!/usr/bin/env node
// Install test: the extension as a user gets it, in a clean editor profile, opened on a checkout
// that `npx @celador/weft` just set up (hosted space, nothing configured by hand). Passes when
// the extension connects live, finds the space's repo and a token from .weft/, and shows the
// feed, with no settings, no env vars and no "Set token".
//
//   node apps/vscode/test/install/run.mjs --app vscode|cursor [--from vsix|marketplace] [--checkout DIR]
//
// --from vsix (default): installs out/weft-<version>.vsix (run `pnpm --filter @weft/vscode package`).
// --from marketplace: `<editor> --install-extension celador.weft` (VS Code: Visual Studio
//   Marketplace; Cursor/VSCodium/Windsurf: Open VSX). Use after publishing.
// --checkout DIR: an existing checkout set up by `npx @celador/weft`; default: a new repo in
//   $TMPDIR, set up with `npx -y @celador/weft --yes --no-open --harness claude-code --agents 1`.
// Prints a JSON summary (never a token). Exit 0 = pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const app = opt("app", "vscode");
const from = opt("from", "vsix");
const APPS = {
  vscode: { exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Code", cli: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" },
  cursor: { exe: "/Applications/Cursor.app/Contents/MacOS/Cursor", cli: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" },
};
const a = APPS[app];
if (!a || !existsSync(a.exe)) throw new Error(`${app} is not installed (${a?.exe})`);
const log = (m) => console.error(`[install ${app}/${from}] ${m}`);

// 1. A checkout set up by npx @celador/weft (or the one given).
let checkout = opt("checkout");
if (!checkout) {
  checkout = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "weft-install-"));
  const git = (...g) => spawnSync("git", g, { cwd: checkout, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(checkout, "pricing.ts"), "export function calcTotal(xs: number[]): number {\n  return xs.reduce((s, x) => s + x, 0);\n}\n");
  git("add", "-A");
  git("-c", "user.name=weft-test", "-c", "user.email=test@weft.invalid", "commit", "-qm", "init");
  log(`npx @celador/weft in ${checkout}`);
  const r = spawnSync("npx", ["-y", "@celador/weft@latest", "--yes", "--no-open", "--harness", "claude-code", "--agents", "1"], { cwd: checkout, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npx @celador/weft failed:\n${r.stderr || r.stdout}`);
}
checkout = resolve(checkout);
const space = JSON.parse(readFileSync(join(checkout, ".weft", "claude.json"), "utf8"));

// 2. A clean profile; the extension installed the way a user installs it.
const run = mkdtempSync("/tmp/wi-"); // short: the editor's IPC socket lives under --user-data-dir
const userData = join(run, "user");
const extDir = join(run, "ext");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({ "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "workbench.startupEditor": "none" }));
let source;
if (from === "vsix") {
  const version = JSON.parse(readFileSync(join(ext, "package.json"), "utf8")).version;
  source = join(ext, "out", `weft-${version}.vsix`);
  if (!existsSync(source)) throw new Error(`build the .vsix first: ${source}`);
} else source = "celador.weft";
const inst = spawnSync(a.cli, [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, "--install-extension", source, "--force"], { encoding: "utf8" });
log((inst.stdout + inst.stderr).trim().split("\n").slice(-1)[0] ?? "");
if (inst.status !== 0) throw new Error(`install failed: ${inst.stderr || inst.stdout}`);

// 3. Open the checkout; the probe (a throwaway development extension) reads celador.weft's API.
const probe = join(run, "probe");
mkdirSync(probe, { recursive: true });
writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "weft-install-probe", publisher: "weft-test", version: "0.0.0", engines: { vscode: "^1.88.0" }, main: "./noop.js", activationEvents: [] }));
writeFileSync(join(probe, "noop.js"), "exports.activate = () => {};\n");
const outFile = join(run, "result.json");
let code = 0;
try {
  await runTests({
    vscodeExecutablePath: a.exe,
    extensionDevelopmentPath: probe,
    extensionTestsPath: join(here, "suite.cjs"),
    launchArgs: [checkout, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`],
    extensionTestsEnv: { WEFT_INSTALL_OUT: outFile, WEFT_INSTALL_REPO: space.repo, WEFT_TOKEN: "", WEFT_URL: "", WEFT_REPO: "" },
  });
} catch (e) {
  log(`failed: ${e instanceof Error ? e.message : e}`);
  code = 1;
}
const result = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : { pass: false };
console.log(JSON.stringify({ app, from, source: from === "vsix" ? source.split("/").pop() : source, checkout, gateway: space.url, ...result }, null, 2));
process.exit(code || (result.pass ? 0 : 1));
