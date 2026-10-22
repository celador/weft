// Language conformance (docs/languages.md): for every language fixture set,
//   1. the peers' declared writes are exactly what @weft/analyzer derives from their edits, so
//      the fixture tests the same analysis on both sides of the conflict; and
//   2. the Claude Code adapter (the core every bundled adapter shares) passes every fixture.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource, treeSitterLanguageFor } from "@weft/analyzer";
import { fixtureSetDir, languageFixtureSets, loadFixtures, run } from "../src/runner";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const CLAUDE = join(repo, "packages/adapters/claude-code/dist/weft-claude.mjs");

describe("language fixture sets", () => {
  it("ship Python, C, C++, Ruby and PHP", () => {
    expect(languageFixtureSets()).toEqual(expect.arrayContaining(["c", "cpp", "php", "python", "ruby"]));
  });

  for (const set of languageFixtureSets()) {
    describe(set, () => {
      const { workspace, fixtures } = loadFixtures(fixtureSetDir(set));

      it("has a deny, an adapt-and-allow and an unrelated-allow fixture", () => {
        const ids = fixtures.map((f) => f.id);
        expect(ids.some((id) => /deny-stale-signature/.test(id))).toBe(true);
        expect(ids.some((id) => /allow-after-adapting/.test(id))).toBe(true);
        expect(ids.some((id) => /allow-unrelated/.test(id))).toBe(true);
      });

      for (const [name, peer] of Object.entries(workspace.peers)) {
        it(`peer ${name}: declared reads/writes = analyzer output`, async () => {
          const exists = (rel: string) => rel in workspace.files;
          // The same checkout access the adapters give the analyzer (exists / read). C/C++ read
          // included headers; like the adapters, a change sees its own other changed files.
          const read = (rel: string): string | undefined => peer.after?.[rel] ?? workspace.files[rel];
          const reads = new Set<string>();
          // One key per symbol, as the adapters merge them (a header and its .c share keys).
          const writes = new Map<string, { key: string; kind: string }>();
          for (const [path, after] of Object.entries(peer.after ?? {})) {
            expect(treeSitterLanguageFor(path, after)?.id).toBe(set);
            const r = await analyzeSource({ path, before: workspace.files[path] ?? null, after }, { exists, read });
            r.reads.forEach((k) => reads.add(k));
            for (const w of r.writes) writes.set(w.key, w);
          }
          for (const k of writes.keys()) reads.delete(k);
          expect([...peer.writes].sort((a, b) => a.key.localeCompare(b.key))).toEqual([...writes.values()].sort((a, b) => a.key.localeCompare(b.key)));
          expect([...peer.reads].sort()).toEqual([...reads].sort());
        });
      }

      it("the Claude Code adapter passes every fixture", async () => {
        if (!existsSync(CLAUDE)) execFileSync(process.execPath, [join(repo, "packages/adapters/claude-code/scripts/build.mjs")]);
        const r = await run({
          dialect: "claude-code",
          command: [process.execPath, CLAUDE, "hook"],
          setup: `"${process.execPath}" "${CLAUDE}" install --url {url} --repo {repo} --agent {agent} --task {task} --title conformance`,
          env: { WEFT_TOKEN: "conformance-token" },
          fixturesDir: fixtureSetDir(set),
        });
        expect(r.fixtures.filter((f) => !f.pass).map((f) => [f.id, f.checks.filter((c) => !c.pass)])).toEqual([]);
        expect(r.fixtures.length).toBe(fixtures.length);
      }, 180_000);
    });
  }
});
