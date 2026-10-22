// Stages the extension into out/stage (the manifest from package.json "weftExtension", the
// built files, README, CHANGELOG, LICENSE) and packs it with vsce into out/weft-<version>.vsix.
// The workspace package is "@weft/vscode"; the shipped extension is "celador.weft".
// Publishing (Marketplace, Open VSX) is NOT done here: it needs John's OK.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "out", "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const manifest = { ...pkg.weftExtension, version: pkg.version, scripts: {}, dependencies: {}, devDependencies: {} };
delete manifest.scripts;
delete manifest.dependencies;
delete manifest.devDependencies;
writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const f of ["README.md", "CHANGELOG.md"]) cpSync(join(root, f), join(stage, f));
cpSync(join(root, "..", "..", "LICENSE"), join(stage, "LICENSE"));
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (s) => !s.endsWith(".map") });
cpSync(join(root, "media"), join(stage, "media"), { recursive: true, filter: (s) => !s.endsWith(".map") });
writeFileSync(join(stage, ".vscodeignore"), "**/*.map\n");

if (process.argv.includes("--stage-only")) {
  console.log(`staged ${stage}`);
  process.exit(0);
}
const vsce = join(root, "node_modules", "@vscode", "vsce", "vsce");
const out = join(root, "out", `weft-${pkg.version}.vsix`);
const r = spawnSync(process.execPath, [vsce, "package", "--no-dependencies", "--allow-missing-repository", "--out", out], { cwd: stage, stdio: "inherit" });
if (r.status !== 0 || !existsSync(out)) process.exit(r.status ?? 1);
console.log(`packed ${out}`);
