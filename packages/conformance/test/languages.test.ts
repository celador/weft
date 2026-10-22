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
  it("ship Python, Java and Kotlin", () => {
    expect(languageFixtureSets()).toEqual(expect.arrayContaining(["python", "java", "kotlin"]));
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
          const reads = new Set<string>();
          const writes: Array<{ key: string; kind: string }> = [];
          for (const [path, after] of Object.entries(peer.after ?? {})) {
            expect([set, ...(workspace.interop ?? [])]).toContain(treeSitterLanguageFor(path)?.id);
            const r = await analyzeSource({ path, before: workspace.files[path] ?? null, after }, { exists });
            r.reads.forEach((k) => reads.add(k));
            writes.push(...r.writes);
          }
          for (const w of writes) reads.delete(w.key);
          expect([...peer.writes].sort((a, b) => a.key.localeCompare(b.key))).toEqual(writes.sort((a, b) => a.key.localeCompare(b.key)));
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
