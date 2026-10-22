// Builds the extension: dist/extension.cjs (extension host, Node, CommonJS), media/dist/webview.js
// (the feed webview, browser IIFE) and media/dist/feed.css (@weft/feed/view.css).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
mkdirSync(join(root, "dist"), { recursive: true });
mkdirSync(join(root, "media", "dist"), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "warning", legalComments: "none" };
await build({
  ...common,
  entryPoints: [join(root, "src", "extension.ts")],
  outfile: join(root, "dist", "extension.cjs"),
  platform: "node",
  format: "cjs",
  // Cursor, Windsurf and older forks ship Node 20; VS Code 1.143 ships Node 22+.
  target: "node20",
  external: ["vscode"],
});
await build({
  ...common,
  entryPoints: [join(root, "src", "webview", "main.ts")],
  outfile: join(root, "media", "dist", "webview.js"),
  platform: "browser",
  format: "iife",
  target: "es2022",
});
const feedCss = join(root, "..", "..", "packages", "feed", "src", "view", "feed.css");
copyFileSync(feedCss, join(root, "media", "dist", "feed.css"));
console.log(`built dist/extension.cjs, media/dist/webview.js, media/dist/feed.css${watch ? " (watch not supported; rerun)" : ""}`);
