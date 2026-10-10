// Bundle lease-clock.ts against a given checkout of Weft (its own coordinator code):
//   node demo/evidence/leases/build.mjs <weft tree> <out.mjs>
// e.g. once for a `main` worktree (before) and once for this branch (after).
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [tree, out] = process.argv.slice(2).map((p) => resolve(p));
if (!tree || !out) throw new Error("usage: node build.mjs <weft tree> <out.mjs>");
const here = dirname(fileURLToPath(import.meta.url));
const { build } = createRequire(join(tree, "packages/conformance/package.json"))("esbuild");
await build({
  entryPoints: [join(here, "lease-clock.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  alias: { "@weft/sequencer": join(tree, "packages/sequencer/src") },
  nodePaths: [join(tree, "packages/sequencer/node_modules")],
  logLevel: "warning",
});
console.log(`built ${out} against ${tree}`);
