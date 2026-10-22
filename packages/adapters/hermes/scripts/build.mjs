// Bundle src/analyze-cli.ts (+ @weft/analyzer + typescript) into one self-contained ESM file
// that the Python plugin can spawn with plain `node`, without the weft checkout or node_modules.
// The tree-sitter runtime + grammars (Python, ...) go to `<outdir>/grammars/*.wasm`, where the
// bundle looks for them at runtime; install.py copies that directory next to analyze.mjs.
//
//   node scripts/build.mjs [outfile]      (default: dist/analyze.mjs)
import { build } from "esbuild";
import { copyAnalyzerAssets } from "../../../analyzer/scripts/copy-assets.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(process.argv[2] ?? resolve(here, "../dist/analyze.mjs"));

await build({
  entryPoints: [resolve(here, "../src/analyze-cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  // typescript is CommonJS and calls require() for node builtins; give the ESM bundle a require.
  banner: {
    js: [
      "import { createRequire as __weftCreateRequire } from 'node:module';",
      "import { fileURLToPath as __weftFileURLToPath } from 'node:url';",
      "import { dirname as __weftDirname } from 'node:path';",
      "const require = __weftCreateRequire(import.meta.url);",
      "const __filename = __weftFileURLToPath(import.meta.url);",
      "const __dirname = __weftDirname(__filename);",
    ].join(" "),
  },
});
const grammars = copyAnalyzerAssets(dirname(outfile));
console.log(`built ${outfile} (+ ${grammars})`);
