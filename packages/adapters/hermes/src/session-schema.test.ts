// One Hermes gateway process serves many chats: each chat's edits go out under its own WCP task
// and change (hook ids, not process state). Those ids must stay valid WCP Hello/Submit bodies, or
// the gateway answers invalid_message and the fail-open plugin silently reports nothing.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../../protocol/src/index";

const here = dirname(fileURLToPath(import.meta.url));

describe("hermes plugin per-conversation sessions", () => {
  it("hello and submit bodies validate against the WCP schema", () => {
    const out = execFileSync("python3", [resolve(here, "../tests/emit_session_events.py")], { encoding: "utf8" });
    const bodies = JSON.parse(out) as Array<{ type: string; change?: string; task?: { id: string }; event?: { kind: string; files?: string[] } }>;
    const hellos = bodies.filter((b) => b.type === "hello");
    expect(hellos.map((h) => h.change)).toEqual([
      "hermes-default/adhoc-api_1700000001_aaaa1111",
      "hermes-default/adhoc-api_1700000002_bbbb2222",
      expect.stringMatching(/^hermes-default\/hermes-[0-9a-f]{12}\/20261120_101500_abcd$/),
    ]);
    const edits = bodies.filter((b) => b.type === "submit");
    expect(edits.map((b) => b.event?.files)).toEqual([["src/a.md"], ["src/a.md"]]);
    for (const body of bodies) {
      const v = validate(body.type === "hello" ? "Hello" : "Submit", body);
      expect(v.ok ? [] : v.issues, JSON.stringify(body)).toEqual([]);
    }
  });
});
