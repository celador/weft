// Builds the LICENSE file that ships in the builds Weft distributes (the @celador/weft npm package
// and the VS Code extension):
//   1. licenses/WEFT-BUILDS.md   the terms for those builds (free for personal use; commercial use
//                                needs a license; source under AGPL-3.0-only)
//   2. licenses/LICENSE-MIT      the MIT notice that still covers code released up to 0.3.0
//   3. third-party notices       every npm package esbuild bundled into the given dist directories,
//                                found by the `node_modules/.pnpm/<dir>/node_modules/<name>` path
//                                comments esbuild leaves in unminified output, plus the vendored
//                                tree-sitter grammars when a grammars directory ships
//
// The distributed builds are not under the AGPL, so they may only bundle permissively licensed
// third-party code: a bundled package whose license is not in ALLOWED fails the build.
//
//   node scripts/third-party-notices.mjs <dist dir>...   prints the LICENSE text (for checks)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Licenses a distributed build may bundle (SPDX ids). Copyleft and source-available ones stay out. */
export const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "Zlib", "CC0-1.0", "Unlicense"]);

const BUNDLED = /node_modules\/\.pnpm\/([^/\s"'`]+)\/node_modules\/((?:@[^/\s"'`]+\/)?[^/\s"'`]+)/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

/** The SPDX ids an expression like "(MIT OR Apache-2.0)" or "MIT AND Zlib" uses, and whether it is satisfiable from ALLOWED. */
export function licenseAllowed(expr) {
  if (!expr || typeof expr !== "string") return false;
  const clean = expr.replace(/[()]/g, " ").trim();
  // OR: any branch allowed; AND: every part allowed.
  return clean.split(/\s+OR\s+/).some((branch) => branch.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

/** Third-party npm packages bundled into the given dist directories: [{ name, version, license, dir }]. */
export function bundledPackages(dists, root = repoRoot) {
  const found = new Map();
  for (const dist of dists) {
    if (!existsSync(dist)) continue;
    for (const f of files(dist)) {
      if (!/\.(m|c)?js$/.test(f)) continue;
      for (const m of readFileSync(f, "utf8").matchAll(BUNDLED)) {
        const dir = join(root, "node_modules", ".pnpm", m[1], "node_modules", m[2]);
        if (found.has(dir)) continue;
        const pkgFile = join(dir, "package.json");
        if (!existsSync(pkgFile)) throw new Error(`bundled package ${m[2]} (${m[1]}): ${pkgFile} not found; run pnpm install`);
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
        const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
        found.set(dir, { name: pkg.name, version: pkg.version, license, dir });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function hasGrammars(dists) {
  for (const dist of dists) {
    if (!existsSync(dist)) continue;
    for (const f of files(dist)) if (/tree-sitter-[a-z_]+\.wasm$/.test(f)) return true;
  }
  return false;
}

function licenseText(dir) {
  const name = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return name ? readFileSync(join(dir, name), "utf8").trim() : undefined;
}

/** The full LICENSE text for a distributed build whose files are in `dists`. */
export function buildLicense({ dists, root = repoRoot }) {
  const pkgs = bundledPackages(dists, root);
  const bad = pkgs.filter((p) => !licenseAllowed(p.license));
  if (bad.length) {
    throw new Error(`bundled packages with a license the distributed builds may not carry: ${bad.map((p) => `${p.name}@${p.version} (${p.license ?? "none"})`).join(", ")}`);
  }
  const grammars = hasGrammars(dists);
  const parts = [
    readFileSync(join(root, "licenses", "WEFT-BUILDS.md"), "utf8").trim(),
    "-".repeat(78),
    readFileSync(join(root, "licenses", "LICENSE-MIT"), "utf8").trim(),
    "-".repeat(78),
    pkgs.length || grammars
      ? "Third-party notices\n\nThis build includes the following third-party software, each under its own license."
      : "Third-party notices\n\nThis build includes no third-party code.",
  ];
  for (const p of pkgs) {
    const text = licenseText(p.dir);
    parts.push(`${p.name} ${p.version} (${p.license})\n\n${text ?? `Licensed under ${p.license}. The package ships no license file.`}`);
  }
  if (grammars) parts.push(readFileSync(join(root, "licenses", "third-party", "tree-sitter-grammars.txt"), "utf8").trim());
  return parts.join("\n\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dists = process.argv.slice(2);
  if (!dists.length) {
    process.stderr.write("usage: node scripts/third-party-notices.mjs <dist dir>...\n");
    process.exit(2);
  }
  process.stdout.write(buildLicense({ dists }));
}
