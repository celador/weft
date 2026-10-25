// Publishes out/weft-<version>.vsix to the Visual Studio Marketplace (publisher `celador`) and to
// Open VSX (namespace `celador`), then checks each listing serves that version.
//
//   pnpm --filter @weft/vscode release            # build + package + publish both
//   node scripts/publish.mjs --only ovsx|vsce     # one of them
//   node scripts/publish.mjs --check              # only check the live listings
//
// Tokens, first match wins (never printed, never written to disk by this script):
//   VS Code Marketplace: VSCE_PAT, else the macOS keychain item `weft-vsce-pat`
//   Open VSX:            OVSX_PAT, else the macOS keychain item `weft-ovsx-pat`
// Store one once with: security add-generic-password -U -a celador -s weft-ovsx-pat -w
// (it prompts for the token).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const id = `${pkg.weftExtension.publisher}.${pkg.weftExtension.name}`;
const vsix = join(root, "out", `weft-${version}.vsix`);
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const checkOnly = args.includes("--check");

function keychain(service) {
  if (process.platform !== "darwin") return undefined;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

async function marketplaceVersion() {
  const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json;api-version=7.2-preview.1" },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 1 }),
  });
  const j = await res.json();
  return j.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
}
async function openVsxVersion() {
  const res = await fetch(`https://open-vsx.org/api/${id.replace(".", "/")}`);
  return res.ok ? (await res.json()).version : undefined;
}

const targets = [
  { key: "vsce", name: "Visual Studio Marketplace", env: "VSCE_PAT", item: "weft-vsce-pat", bin: join(root, "node_modules", "@vscode", "vsce", "vsce"), cmd: ["publish", "--packagePath", vsix], live: marketplaceVersion, url: `https://marketplace.visualstudio.com/items?itemName=${id}` },
  { key: "ovsx", name: "Open VSX", env: "OVSX_PAT", item: "weft-ovsx-pat", bin: join(root, "node_modules", "ovsx", "bin", "ovsx"), cmd: ["publish", vsix], live: openVsxVersion, url: `https://open-vsx.org/extension/${id.replace(".", "/")}` },
].filter((t) => !only || t.key === only);

let failed = false;
for (const t of targets) {
  if (!checkOnly) {
    if (!existsSync(vsix)) throw new Error(`no ${vsix}: run \`pnpm --filter @weft/vscode package\``);
    const token = process.env[t.env] || keychain(t.item);
    if (!token) {
      console.error(`✗ ${t.name}: no token (set ${t.env} or the keychain item ${t.item})`);
      failed = true;
      continue;
    }
    const env = { ...process.env, [t.env]: token };
    if (t.key === "ovsx" && (await fetch(`https://open-vsx.org/api/${pkg.weftExtension.publisher}`)).status === 404) {
      // First publish: the namespace must exist (the token's owner becomes its owner).
      spawnSync(process.execPath, [t.bin, "create-namespace", pkg.weftExtension.publisher], { cwd: root, env, stdio: "inherit" });
    }
    const r = spawnSync(process.execPath, [t.bin, ...t.cmd], { cwd: root, env, stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`✗ ${t.name}: publish failed`);
      failed = true;
      continue;
    }
  }
  let live;
  for (let i = 0; i < (checkOnly ? 1 : 30); i++) {
    live = await t.live().catch(() => undefined);
    if (live === version) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`${live === version ? "✓" : "✗"} ${t.name}: ${live ?? "not listed"} (want ${version}) ${t.url}`);
  if (live !== version) failed = true;
}
process.exit(failed ? 1 : 0);
