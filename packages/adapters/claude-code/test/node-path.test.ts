// Installed hooks pin a node path; the pinned node must actually run (a binary can exist and
// abort in dyld after a `brew upgrade` of one of its dylibs).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeRuns, stableNodePath } from "../src/node-path";

const CELLAR = "/opt/homebrew/Cellar/node@24/24.21.0/bin/node";
const OPT = "/opt/homebrew/opt/node@24/bin/node";

/** A fake node that dies like dyld did on 2026-11-17 (and counts how often it was started). */
function brokenNode(): { path: string; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "weft-broken-node-"));
  const path = join(dir, "node");
  const count = join(dir, "calls");
  writeFileSync(count, "");
  writeFileSync(path, `#!/bin/sh\necho x >> '${count}'\necho "dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib" >&2\nexit 1\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => readFileSync(count, "utf8").split("\n").filter(Boolean).length };
}

describe("stableNodePath prefers a node that runs", () => {
  it("keeps the Cellar path when the opt link exists but is broken", () => {
    expect(stableNodePath(CELLAR, (p) => p === OPT, (p) => p !== OPT)).toBe(CELLAR);
  });

  it("uses the opt link when it exists and runs", () => {
    expect(stableNodePath(CELLAR, (p) => p === OPT, () => true)).toBe(OPT);
  });

  it("does not probe when there is no opt link to switch to", () => {
    let probes = 0;
    const runs = () => (probes++, true);
    expect(stableNodePath(CELLAR, () => false, runs)).toBe(CELLAR);
    expect(stableNodePath("/Users/x/.nvm/versions/node/v24.1.0/bin/node", () => true, runs)).toBe("/Users/x/.nvm/versions/node/v24.1.0/bin/node");
    expect(probes).toBe(0);
  });
});

describe("nodeRuns", () => {
  it("is false for a node that exits 1 with a dyld error, and probes it once per process", () => {
    const fake = brokenNode();
    expect(nodeRuns(fake.path)).toBe(false);
    expect(nodeRuns(fake.path)).toBe(false);
    expect(fake.calls()).toBe(1);
  });

  it("is false for a missing binary and true for the node running this test", () => {
    expect(nodeRuns(join(tmpdir(), "weft-no-such-node", "node"))).toBe(false);
    expect(nodeRuns(process.execPath)).toBe(true);
  });

  it("drives stableNodePath end to end: a broken opt link is never pinned", () => {
    const fake = brokenNode();
    // The opt link "is" the broken fake: probed for real, it fails, so the Cellar path stays.
    expect(stableNodePath(CELLAR, (p) => p === OPT, (p) => nodeRuns(p === OPT ? fake.path : p))).toBe(CELLAR);
    expect(fake.calls()).toBe(1);
  });
});
