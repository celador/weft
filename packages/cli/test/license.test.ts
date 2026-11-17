// The license split (root LICENSE, per-directory LICENSE files, package.json `license` fields) and
// the LICENSE that ships in the npm package (packages/cli/scripts/build.mjs, generated from
// licenses/ and the bundled packages by scripts/third-party-notices.mjs). `pnpm test` builds first.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(repo, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

/** Stays MIT so anyone can implement the protocol and catalogs keep listing the plugins. */
const MIT_DIRS = ["docs/protocol", "packages/protocol", "packages/conformance", "plugins/weft", "packages/adapters/hermes/plugin/weft"];
const MIT_PACKAGES = ["packages/protocol", "packages/conformance"];
/** The product: AGPL-3.0-only. Every TS adapter bundles the Claude Code adapter core and @weft/analyzer. */
const AGPL_PACKAGES = [
  "apps/gateway", "apps/policy", "apps/previews", "apps/production-signal", "apps/sandbox", "apps/vscode", "apps/web", "apps/workflows",
  "packages/analyzer", "packages/artifacts", "packages/feed", "packages/mcp", "packages/sequencer",
  "packages/adapters/antigravity", "packages/adapters/claude-code", "packages/adapters/codex", "packages/adapters/copilot",
  "packages/adapters/cursor", "packages/adapters/gemini", "packages/adapters/hermes", "packages/adapters/opencode", "packages/adapters/watcher",
];

describe("license split", () => {
  it("the root LICENSE names every MIT directory and carries the full AGPL-3.0 text", () => {
    const root = read("LICENSE");
    for (const d of ["docs/protocol", "packages/protocol", "packages/conformance", "plugins/weft", ".claude-plugin", "packages/adapters/hermes/plugin"]) {
      expect(root).toContain(`\n    ${d}/\n`);
    }
    expect(root).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(root).toContain("Version 3, 19 November 2007");
    expect(root).toContain("END OF TERMS AND CONDITIONS");
    expect(root).toContain("up to and including @celador/weft 0.3.0");
    expect(root).toContain("docs/commercial-license.md");
  });

  it("keeps the original MIT notice for everything released up to 0.3.0", () => {
    const mit = read("licenses/LICENSE-MIT");
    expect(mit).toContain("Copyright (c) 2026 John Aaron Nelson\n");
    expect(mit).toContain("Permission is hereby granted, free of charge");
    expect(mit).toContain("@celador/weft 0.3.0");
  });

  it("each MIT directory has an MIT LICENSE file", () => {
    for (const d of MIT_DIRS) {
      const f = join(repo, d, "LICENSE");
      expect(existsSync(f), f).toBe(true);
      expect(readFileSync(f, "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) 2026 John Aaron Nelson and Weft contributors\n/);
    }
  });

  it("package.json license fields follow the split", () => {
    for (const d of MIT_PACKAGES) expect(json(`${d}/package.json`).license, d).toBe("MIT");
    for (const d of AGPL_PACKAGES) expect(json(`${d}/package.json`).license, d).toBe("AGPL-3.0-only");
    // the builds Weft distributes carry the build terms (free for personal use, commercial use needs a license)
    expect(json("packages/cli/package.json").license).toBe("SEE LICENSE IN LICENSE");
    expect(json("packages/cli/package.json").files).toContain("LICENSE");
    expect(json("apps/vscode/package.json").weftExtension.license).toBe("SEE LICENSE IN LICENSE");
  });

  it("plugin manifests stay MIT", () => {
    expect(json("plugins/weft/plugin.json").license).toBe("MIT");
    expect(json("plugins/weft/.claude-plugin/plugin.json").license).toBe("MIT");
    expect(json(".claude-plugin/marketplace.json").plugins[0].license).toBe("MIT");
    expect(read("packages/adapters/hermes/plugin/weft/plugin.yaml")).toMatch(/^license: MIT$/m);
  });
});

describe("npm package LICENSE", () => {
  const license = read("packages/cli/LICENSE");

  it("starts with the build terms, then the MIT notice", () => {
    expect(license.startsWith("# Weft build license\n")).toBe(true);
    expect(license).toContain("Using the Build for commercial purposes");
    expect(license).toContain("GNU Affero General Public License version 3 only");
    expect(license.indexOf("Copyright (c) 2026 John Aaron Nelson\n")).toBeGreaterThan(license.indexOf("# Weft build license"));
  });

  it("lists every bundled third-party package with its license text, and the grammars", () => {
    for (const name of ["@modelcontextprotocol/sdk", "ajv", "zod", "web-tree-sitter"]) expect(license).toMatch(new RegExp(`^${name.replace("/", "\\/")} \\d+\\.\\d+\\.\\d+ \\(`, "m"));
    expect(license).toContain("tree-sitter grammars (packages/analyzer/grammars/*.wasm)");
    expect(license).toContain("Copyright (c) 2021 alex-pinkus");
  });

  it("the allow-list refuses copyleft and source-available licenses", () => {
    const probe = `import { licenseAllowed as a } from ${JSON.stringify(join(repo, "scripts/third-party-notices.mjs"))};
      console.log(JSON.stringify(["MIT", "(MIT OR Apache-2.0)", "MIT AND Zlib", "(MIT OR GPL-3.0-or-later)", "GPL-3.0-only", "AGPL-3.0-only", "LGPL-3.0-or-later", "SSPL-1.0", "BUSL-1.1", "MIT AND GPL-2.0-only", "", undefined].map(a)));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([true, true, true, true, false, false, false, false, false, false, false, false]);
  });
});
