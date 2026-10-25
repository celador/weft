#!/usr/bin/env node
// Lists `npx @celador/weft mcp` in the official MCP registry (registry.modelcontextprotocol.io)
// as io.github.celador/weft, for the @celador/weft version in package.json, then checks the
// listing. Run it after that version is on npm:
//
//   node scripts/mcp-registry.mjs           # publish + check
//   node scripts/mcp-registry.mjs --check   # only check the live listing
//
// Needs `mcp-publisher` on PATH (brew install mcp-publisher) and a GitHub login that owns the
// `celador` namespace: it logs in with `gh auth token` (never printed). The registry checks that
// the npm tarball's package.json has "mcpName": "io.github.celador/weft".
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const serverPath = join(root, "server.json");
const server = JSON.parse(readFileSync(serverPath, "utf8"));
const check = process.argv.includes("--check");
const api = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(server.name)}`;

async function listed() {
  const r = await fetch(api);
  const j = r.ok ? await r.json() : { servers: [] };
  return (j.servers ?? []).map((s) => s.server ?? s).filter((s) => s.name === server.name).map((s) => s.version);
}

if (!check) {
  const npm = await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}/${pkg.version}`);
  if (!npm.ok) throw new Error(`${pkg.name}@${pkg.version} is not on npm yet: publish it first`);
  const published = await npm.json();
  if (published.mcpName !== server.name) throw new Error(`${pkg.name}@${pkg.version} on npm has mcpName ${published.mcpName ?? "(none)"}, the registry needs ${server.name}`);
  server.version = pkg.version;
  for (const p of server.packages) if (p.identifier === pkg.name) p.version = pkg.version;
  writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (gh.status !== 0) throw new Error("gh is not logged in (gh auth login)");
  const run = (args) => spawnSync("mcp-publisher", args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  if (run(["login", "github", "--token", gh.stdout.trim()]).status !== 0) process.exit(1);
  if (run(["publish"]).status !== 0) process.exit(1);
}
const versions = await listed();
const ok = versions.includes(pkg.version);
console.log(`${ok ? "✓" : "✗"} MCP registry ${server.name}: ${versions.join(", ") || "not listed"} (want ${pkg.version}) ${api}`);
process.exit(ok ? 0 : 1);
