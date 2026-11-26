// Issue #18 (subagent items): the Bash pre-snapshot is bounded and dropped when PostToolUse never
// fires, an Edit that runs in parallel with a Bash call is submitted once, and a Bash call without
// a tool_use_id is not reconciled. In-process ClaudeAdapter against the reference coordinator.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { ClaudeAdapter, PENDING_TTL_MS, type HookInput } from "../src/hooks";
import { readState, type Loaded } from "../src/config";
import { checkout, refTransport } from "./helpers";

function setup(name: string) {
  const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
  const root = checkout(name);
  let t = 1_790_000_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const loaded: Loaded = { root, token: "test", config: { url: "http://unused", repo: "demo", agent: "worker", task: { id: "T-w" }, change: "I-worker" } };
  const a = new ClaudeAdapter(loaded, {
    transport: refTransport(coord),
    analyze: (changes, r, p) => analyzeChanges(changes, r, p),
    diff: (rel, b, af) => unifiedDiff(rel, b, af),
    now: () => (t += 1_000),
  });
  const h = (extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: root, ...extra });
  const edits = () => coord.log.filter((r) => r.kind === "edit" && r.mode === "commit");
  return { coord, root, a, h, edits, clock };
}

const NEW_FN = "export function added(n: number): number {\n  return n + 1;\n}\n";

describe("Bash reconcile next to a parallel Edit (#18)", () => {
  it("Edit's PostToolUse before the Bash's: the edit is submitted once, by the Edit", async () => {
    const { root, a, h, edits } = setup("par-edit-first");
    const file = join(root, "src/pricing.ts");
    const input = { file_path: file, old_string: "export type Item", new_string: `${NEW_FN}export type Item` };
    await a.handle(h({ tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "sleep 1 && echo done" } }));
    await a.handle(h({ tool_name: "Edit", tool_use_id: "e1", tool_input: input }));
    writeFileSync(file, readFileSync(file, "utf8").replace("export type Item", `${NEW_FN}export type Item`));
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: input, tool_response: {} }));
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "sleep 1 && echo done" }, tool_response: {} }));
    expect(edits().map((e) => [e.tool?.name, e.files])).toEqual([["Edit", ["src/pricing.ts"]]]);
  });

  it("Bash's PostToolUse first: the file the Edit is writing is left to the Edit's PostToolUse (submitted once)", async () => {
    const { root, a, h, edits } = setup("par-bash-first");
    const file = join(root, "src/pricing.ts");
    const input = { file_path: file, old_string: "export type Item", new_string: `${NEW_FN}export type Item` };
    await a.handle(h({ tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "echo hi" } }));
    await a.handle(h({ tool_name: "Edit", tool_use_id: "e1", tool_input: input }));
    writeFileSync(file, readFileSync(file, "utf8").replace("export type Item", `${NEW_FN}export type Item`));
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "echo hi" }, tool_response: {} }));
    expect(edits()).toEqual([]);
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: input, tool_response: {} }));
    expect(edits().map((e) => [e.tool?.name, e.files])).toEqual([["Edit", ["src/pricing.ts"]]]);
  });

  it("the Bash call's own change to another file is still submitted, by the Bash reconcile", async () => {
    const { root, a, h, edits } = setup("par-both");
    const file = join(root, "src/pricing.ts");
    const input = { file_path: file, old_string: "export type Item", new_string: `${NEW_FN}export type Item` };
    await a.handle(h({ tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "printf > src/extra.ts" } }));
    await a.handle(h({ tool_name: "Edit", tool_use_id: "e1", tool_input: input }));
    writeFileSync(file, readFileSync(file, "utf8").replace("export type Item", `${NEW_FN}export type Item`));
    writeFileSync(join(root, "src/extra.ts"), "export const extra = 1;\n");
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: input, tool_response: {} }));
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "printf > src/extra.ts" }, tool_response: {} }));
    expect(edits().map((e) => [e.tool?.name, e.files])).toEqual([
      ["Edit", ["src/pricing.ts"]],
      ["Bash", ["src/extra.ts"]],
    ]);
  });
});

describe("Bash pre-snapshot bounds (#18)", () => {
  it("a snapshot whose PostToolUse never fires is dropped after PENDING_TTL_MS", async () => {
    const { root, a, h, clock } = setup("ttl");
    writeFileSync(join(root, "src/pricing.ts"), "export const dirty = 1;\n");
    await a.handle(h({ tool_name: "Bash", tool_use_id: "lost", tool_input: { command: "echo" } }));
    expect(Object.keys(readState(root, "s").pending)).toEqual(["lost"]);
    expect(readState(root, "s").pending.lost!.before["src/pricing.ts"]).toBe("export const dirty = 1;\n");
    clock.advance(PENDING_TTL_MS + 1);
    await a.handle(h({ hook_event_name: "UserPromptSubmit", prompt: "next" }));
    expect(readState(root, "s").pending).toEqual({});
    expect(readFileSync(join(root, ".weft/log/adapter.log"), "utf8")).toContain("dropped the Bash snapshot of call lost");
  });

  it("at most 8 Bash snapshots are kept; the oldest go first", async () => {
    const { root, a, h } = setup("bound");
    writeFileSync(join(root, "src/pricing.ts"), "export const dirty = 1;\n");
    for (let i = 1; i <= 11; i++) await a.handle(h({ tool_name: "Bash", tool_use_id: `b${i}`, tool_input: { command: "echo" } }));
    const ids = Object.keys(readState(root, "s").pending);
    expect(ids.length).toBe(8);
    expect(ids).not.toContain("b1");
    expect(ids).toContain("b11");
  });

  it("a Bash call without a tool_use_id takes no snapshot and reconciles nothing (dirty files are not this call's edit)", async () => {
    const { root, a, h, edits } = setup("no-id");
    writeFileSync(join(root, "src/pricing.ts"), `${NEW_FN}`);
    await a.handle(h({ tool_name: "Bash", tool_input: { command: "echo" } }));
    expect(readState(root, "s").pending).toEqual({});
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo" }, tool_response: {} }));
    await a.handle(h({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "", tool_input: { command: "echo" }, tool_response: {} }));
    expect(edits()).toEqual([]);
  });
});
