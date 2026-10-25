// The reverse of claude-code/test/shared-state.test.ts: a state file the Claude Code core wrote
// (Cursor, Copilot, Gemini, OpenCode and Antigravity all use it) read by the Codex adapter.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState, stateDir, writeState } from "./config";

describe("state written by the Claude Code core in the same checkout", () => {
  it("reads it under the id it was asked for and writes it back", () => {
    const root = mkdtempSync(join(tmpdir(), "weft-shared-state-"));
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(join(stateDir(root), "s1.json"), JSON.stringify({ claudeSession: "s1", base: 3, acked: 0, pending: {}, lastContact: 0 }));
    const st = readState(root, "s1");
    expect(st.codexSession).toBe("s1");
    expect(() => writeState(root, st)).not.toThrow();
  });
});
