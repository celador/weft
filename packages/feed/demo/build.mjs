// Bundles the demo page (demo/main.ts + @weft/feed) into demo/dist with esbuild.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "dist"), { recursive: true });
await build({
  entryPoints: [join(here, "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  outfile: join(here, "dist", "main.js"),
  sourcemap: true,
  logLevel: "warning",
});
copyFileSync(join(here, "..", "src", "view", "feed.css"), join(here, "dist", "feed.css"));
console.log("built demo/dist/main.js + feed.css");
