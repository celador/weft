// The Python plugin's retreat release must be a valid WCP Submit: the gateway rejects anything
// else as invalid_message, which silently left claim_wounded errors open (t_cd92b07c).
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../../protocol/src/index";

const here = dirname(fileURLToPath(import.meta.url));

describe("hermes plugin release events", () => {
  it("validate against the WCP Submit schema", () => {
    const out = execFileSync("python3", [resolve(here, "../tests/emit_release_events.py")], { encoding: "utf8" });
    const bodies = JSON.parse(out) as Array<{ event: { kind: string; payload: { reason: string } } }>;
    const releases = bodies.filter((b) => b.event.kind === "release");
    expect(releases).toHaveLength(2);
    for (const body of releases) {
      const v = validate("Submit", body);
      expect(v.ok ? [] : v.issues, JSON.stringify(body)).toEqual([]);
      expect(body.event.payload.reason).toBe("abandoned");
    }
    expect(validate("Submit", { ...releases[0], event: { ...releases[0]!.event, payload: { reason: "retreat: x" } } }).ok).toBe(false);
  });
});
