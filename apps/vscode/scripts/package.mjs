// Stages the extension into out/stage (the manifest from package.json "weftExtension", the
// built files, README, CHANGELOG, LICENSE) and packs it with vsce into out/weft-<version>.vsix.
// The workspace package is "@weft/vscode"; the shipped extension is "celador.weft-agents".
// Publishing (Marketplace, Open VSX) is NOT done here: it needs John's OK.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (s) => !s.endsWith(".map") });
cpSync(join(root, "media"), join(stage, "media"), { recursive: true, filter: (s) => !s.endsWith(".map") });
// LICENSE: the terms for builds Weft distributes (free for personal use, commercial use needs a
// license; source under AGPL-3.0-only), the MIT notice for code released up to 0.3.0, and the
// notices of any bundled third-party package (scripts/third-party-notices.mjs).
const { buildLicense } = await import(pathToFileURL(join(root, "..", "..", "scripts", "third-party-notices.mjs")).href);
writeFileSync(join(stage, "LICENSE"), buildLicense({ dists: [join(stage, "dist"), join(stage, "media")], root: join(root, "..", "..") }));
writeFileSync(join(stage, ".vscodeignore"), "**/*.map\n");
// No source maps ship (they name the original source files): none copied above, no dangling sourceMappingURL trailers, and a hard stop if one slips in.
for (const f of readdirSync(stage, { recursive: true }).map(String)) {
  if (f.endsWith(".map")) throw new Error(`source map in the package: ${f}`);
  if (/\.c?js$/.test(f)) writeFileSync(join(stage, f), readFileSync(join(stage, f), "utf8").replace(/^\/\/# sourceMappingURL=.*\n?/gm, ""));
}

if (process.argv.includes("--stage-only")) {
  console.log(`staged ${stage}`);
  process.exit(0);
}
const vsce = join(root, "node_modules", "@vscode", "vsce", "vsce");
const out = join(root, "out", `weft-${pkg.version}.vsix`);
const r = spawnSync(process.execPath, [vsce, "package", "--no-dependencies", "--allow-missing-repository", "--out", out], { cwd: stage, stdio: "inherit" });
if (r.status !== 0 || !existsSync(out)) process.exit(r.status ?? 1);
console.log(`packed ${out}`);
