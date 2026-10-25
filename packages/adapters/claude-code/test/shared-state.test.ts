// `npx @celador/weft` installs every harness's adapter in one checkout, and .weft/bin/weft is the
// Claude Code adapter's CLI. When a Codex agent runs `weft negotiate`, that CLI reads the state
// file the Codex adapter wrote (session under `codexSession`). Found in the 2026-10 cold run:
// writeState threw "Cannot read properties of undefined (reading 'replace')" after the proposal
// was already sent.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentSession, readState, stateDir, writeState } from "../src/config";

describe("state written by another adapter (Codex) in the same checkout", () => {
  it("reads it under the id it was asked for and writes it back", () => {
    const root = mkdtempSync(join(tmpdir(), "weft-shared-state-"));
    mkdirSync(stateDir(root), { recursive: true });
    const id = "01a1708e-4e72-7a63-a559-60ee9a5563ac";
    writeFileSync(join(stateDir(root), `${id}.json`), JSON.stringify({ codexSession: id, base: 4, acked: 2, pending: {}, lastContact: 1, wcpSession: "S-9" }));
    writeFileSync(join(stateDir(root), "current"), id);
    const st = readState(root, currentSession(root)!);
    expect(st.claudeSession).toBe(id);
    expect(st.wcpSession).toBe("S-9");
    st.base = 5;
    expect(() => writeState(root, st)).not.toThrow();
    const back = JSON.parse(readFileSync(join(stateDir(root), `${id}.json`), "utf8"));
    expect(back).toMatchObject({ codexSession: id, claudeSession: id, base: 5, wcpSession: "S-9" });
  });
});
