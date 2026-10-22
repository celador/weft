// Smoke test: the packaged extension (out/stage, exactly what goes into the .vsix) in a real
// VS Code (the installed one, or VSCODE_EXECUTABLE, or a downloaded build), against a WCP
// gateway double serving the @weft/feed live-run log. See suite.cjs for the checks.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { startStub } from "./stub-gateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const r = spawnSync(process.execPath, [join(root, "scripts", "package.mjs"), "--stage-only"], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const fx = JSON.parse(readFileSync(join(root, "..", "..", "packages", "feed", "test", "fixtures", "live-run.json"), "utf8"));
const observeToken = "smoke-observe-token";
const humanToken = "smoke-human-token";
// Records up to #8 are served at start (claude-b's denied edit #6 is an open squiggle);
// #9 (claude-b redoes the edit) is released live by the suite and must clear it.
// Timestamps are shifted so the run ends a minute ago ("Editing now" looks back 3 h).
const lastTs = Math.max(...fx.events.map((e) => Date.parse(e.ts)));
const shift = Date.now() - 60_000 - lastTs;
const events = fx.events.filter((e) => e.seq <= 11).map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() }));
const stub = await startStub({ repo: fx.repo, events, holdFrom: 9, observeToken, humanToken });

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "weft-vscode-smoke-"));
const ws = join(tmp, "checkout-b");
mkdirSync(join(ws, ".weft"), { recursive: true });
mkdirSync(join(ws, "src"), { recursive: true });
const b = fx.events.find((e) => e.agent === "claude-b" && e.change)?.change;
writeFileSync(join(ws, ".weft", "claude.json"), JSON.stringify({ url: stub.url, repo: fx.repo, agent: "claude-b", task: { id: "T-2", title: "Show the cart total" }, change: b }, null, 2));
writeFileSync(join(ws, ".weft", "human-token"), humanToken + "\n", { mode: 0o600 });
writeFileSync(join(ws, "src", "pricing.ts"), ["export type Item = { price: number; qty: number };", "", "export function calcTotal(items: Item[]): number {", "  return items.reduce((s, i) => s + i.price * i.qty, 0);", "}", ""].join("\n"));
writeFileSync(join(ws, "src", "cart.ts"), ['import { type Item } from "./pricing";', "", "export const items: Item[] = [];", ""].join("\n"));

const candidates = [process.env.VSCODE_EXECUTABLE, "/Applications/Visual Studio Code.app/Contents/MacOS/Code", "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
let code = 0;
try {
  await runTests({
    ...(exe ? { vscodeExecutablePath: exe } : {}),
    extensionDevelopmentPath: join(root, "out", "stage"),
    extensionTestsPath: join(here, "suite.cjs"),
    launchArgs: [ws, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", `--user-data-dir=${join(tmp, "user-data")}`, `--extensions-dir=${join(tmp, "extensions")}`],
    // WEFT_TOKEN is observe-only: reading uses it, actions must fall through to .weft/human-token.
    extensionTestsEnv: { WEFT_TOKEN: observeToken, WEFT_SMOKE_STUB: stub.url, WEFT_SMOKE_WS: ws, WEFT_SMOKE_REPO: fx.repo },
  });
  console.log("smoke: passed");
} catch (e) {
  console.error("smoke: failed", e);
  code = 1;
} finally {
  await stub.close();
}
process.exit(code);
