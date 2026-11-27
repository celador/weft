// The Hermes plugin is a standalone Python package (catalog install), so it keeps its own copies of
// the harness text every adapter puts around Weft's diagnostics (issue #15). They must stay
// byte-identical to @weft/protocol's: the text defers to each error's suggestion and never tells
// the agent, by itself, to adapt to another agent's change.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCKED_EDIT_ADVICE, OPEN_ERROR_ADVICE } from "../../../protocol/src/index";

const here = dirname(fileURLToPath(import.meta.url));

describe("hermes plugin advice text (#15)", () => {
  it("is byte-identical to @weft/protocol's OPEN_ERROR_ADVICE and BLOCKED_EDIT_ADVICE", () => {
    const script = "import json, sys; sys.path.insert(0, sys.argv[1]); from weft import adapter; print(json.dumps([adapter.OPEN_ERROR_ADVICE, adapter.BLOCKED_EDIT_ADVICE]))";
    const [open, blocked] = JSON.parse(execFileSync("python3", ["-c", script, resolve(here, "../plugin")], { encoding: "utf8" })) as [string, string];
    expect(open).toBe(OPEN_ERROR_ADVICE);
    expect(blocked).toBe(BLOCKED_EDIT_ADVICE);
  });
});
