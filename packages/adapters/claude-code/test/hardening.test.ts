// Adapter hardening (failing on main before this change):
//  (a) the adapter never reads a file through a symlink, and never one whose real path is
//      outside the checkout: a file outside could otherwise leak into a diff on the log;
//  (b) edits made by a Bash command are reconciled into the log after it runs — also when
//      the command FAILED partway (Claude Code fires PostToolUseFailure, not PostToolUse).
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { ClaudeAdapter, type HookInput } from "../src/hooks";
import { mergeSettings } from "../src/cli";
import type { Loaded } from "../src/config";
import { PRICING_V1, PRICING_V2, checkout, refTransport } from "./helpers";

function adapter(root: string, c: ReferenceCoordinator, agent = "claude-a"): ClaudeAdapter {
  const loaded: Loaded = { root, token: "test", config: { url: "http://unused", repo: "demo", agent, task: { id: "T-1", title: "work" }, change: `I-${agent}` } };
  let t = 1_790_000_000_000;
  return new ClaudeAdapter(loaded, {
    transport: refTransport(c),
    analyze: (changes, r, p) => analyzeChanges(changes, r, p),
    diff: (rel, b, a) => unifiedDiff(rel, b, a),
    now: () => (t += 5_000),
  });
}

const hook = (cwd: string, extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: "s", cwd, ...extra });
const SECRET = `export const apiKey = "TOP-SECRET-7f3a";\nexport function leak(): string {\n  return apiKey;\n}\n`;

/** A directory outside the checkout holding a "secret" TypeScript file. */
function outside(): string {
  const dir = mkdtempSync(join(tmpdir(), "weft-outside-"));
  writeFileSync(join(dir, "secret.ts"), SECRET);
  return dir;
}

const leaked = (c: ReferenceCoordinator) => c.log.filter((r) => JSON.stringify(r).includes("TOP-SECRET"));

describe("(a) reads never follow symlinks or leave the checkout", () => {
  it("a Write through a symlinked file does not put the outside file's text on the log", async () => {
    const root = checkout("symlink-file");
    const out = outside();
    symlinkSync(join(out, "secret.ts"), join(root, "src/secret.ts"));
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = adapter(root, c);
    await a.handle(hook(root, { hook_event_name: "SessionStart", source: "startup" }));
    const input = { file_path: join(root, "src/secret.ts"), content: `export const apiKey = "rotated";\nexport function leak(): string {\n  return "";\n}\n` };
    await a.handle(hook(root, { tool_name: "Write", tool_input: input, tool_use_id: "w1" }));
    writeFileSync(join(root, "src/secret.ts"), input.content); // Claude Code writes through the link
    await a.handle(hook(root, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input, tool_use_id: "w1", tool_response: {} }));
    expect(leaked(c)).toEqual([]);
  });

  it("an Edit inside a symlinked directory that points outside reads nothing", async () => {
    const root = checkout("symlink-dir");
    const out = outside();
    symlinkSync(out, join(root, "src/vendor"));
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = adapter(root, c);
    await a.handle(hook(root, { hook_event_name: "SessionStart", source: "startup" }));
    const input = { file_path: join(root, "src/vendor/secret.ts"), old_string: "return apiKey;", new_string: "return apiKey.trim();" };
    await a.handle(hook(root, { tool_name: "Edit", tool_input: input, tool_use_id: "e1" }));
    const p = join(out, "secret.ts");
    writeFileSync(p, readFileSync(p, "utf8").replace(input.old_string, input.new_string));
    await a.handle(hook(root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input, tool_use_id: "e1", tool_response: {} }));
    expect(leaked(c)).toEqual([]);
  });

  it("regular files in the checkout are still coordinated", async () => {
    const root = checkout("regular");
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = adapter(root, c);
    await a.handle(hook(root, { hook_event_name: "SessionStart", source: "startup" }));
    const input = { file_path: join(root, "src/pricing.ts"), content: PRICING_V2 };
    await a.handle(hook(root, { tool_name: "Write", tool_input: input, tool_use_id: "w2" }));
    writeFileSync(join(root, "src/pricing.ts"), PRICING_V2);
    await a.handle(hook(root, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input, tool_use_id: "w2", tool_response: {} }));
    expect(c.log.filter((r) => r.kind === "edit").map((r) => r.writes.find((w) => w.key === "src/pricing.ts#calcTotal"))).toEqual([{ key: "src/pricing.ts#calcTotal", kind: "signature" }]);
  });
});

describe("(b) edits made by Bash are reconciled, also when the command fails partway", () => {
  async function bash(event: "PostToolUse" | "PostToolUseFailure") {
    const root = checkout(`bash-${event}`);
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = adapter(root, c);
    await a.handle(hook(root, { hook_event_name: "SessionStart", source: "startup" }));
    const command = `node scripts/codemod.js && npm test`;
    await a.handle(hook(root, { tool_name: "Bash", tool_input: { command }, tool_use_id: "b1" }));
    // The command rewrote pricing.ts (a signature change) and created a file, then (for
    // the failure case) the test step exited non-zero.
    writeFileSync(join(root, "src/pricing.ts"), PRICING_V2);
    mkdirSync(join(root, "src/util"), { recursive: true });
    writeFileSync(join(root, "src/util/round.ts"), `export function round2(n: number): number {\n  return Math.round(n * 100) / 100;\n}\n`);
    const out = await a.handle(
      hook(root, {
        hook_event_name: event,
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "b1",
        ...(event === "PostToolUse" ? { tool_response: { stdout: "", stderr: "", interrupted: false } } : { error: "Command failed with exit code 1" }),
      }),
    );
    return { c, out };
  }

  for (const event of ["PostToolUse", "PostToolUseFailure"] as const) {
    it(`${event}: the files the command changed are submitted as one edit`, async () => {
      const { c } = await bash(event);
      const edits = c.log.filter((r) => r.kind === "edit");
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ status: "accepted", mode: "commit", tool: { name: "Bash", call_id: "b1", harness_event: event } });
      expect(edits[0]!.files.sort()).toEqual(["src/pricing.ts", "src/util/round.ts"]);
      expect(edits[0]!.writes).toEqual(
        expect.arrayContaining([
          { key: "src/pricing.ts#calcTotal", kind: "signature" },
          { key: "src/util/round.ts#round2", kind: "new" },
        ]),
      );
    });
  }

  it("a Bash command that changed nothing submits nothing", async () => {
    const root = checkout("bash-noop");
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = adapter(root, c);
    await a.handle(hook(root, { hook_event_name: "SessionStart", source: "startup" }));
    writeFileSync(join(root, "src/pricing.ts"), PRICING_V1.replace("qty: number", "qty: number /* dirty before */"));
    await a.handle(hook(root, { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "b2" }));
    await a.handle(hook(root, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "b2", error: "exit 2" }));
    expect(c.log.filter((r) => r.kind === "edit")).toEqual([]);
  });

  it("the installer registers PostToolUseFailure for Bash and the edit tools", () => {
    const merged = mergeSettings({}, "node /x/weft-claude.mjs hook") as { hooks: Record<string, Array<{ matcher?: string }>> };
    expect(merged.hooks.PostToolUseFailure?.[0]?.matcher).toBe("Bash|Edit|Write|MultiEdit");
  });
});
