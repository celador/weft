// Owner's review of #13: a junior agent's overlapping edit gets a claim_wait WARNING when the
// senior's claim is soft, and is DENIED (error) when the claim is --firm.
// This file is kept identical on main, where the `claim` command does not exist, so it fails there.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { ClaudeAdapter, type HookInput } from "../src/hooks";
import { parseClaim } from "../src/cli";
import type { Loaded } from "../src/config";
import { PRICING_V1, PRICING_V2, checkout, refTransport } from "./helpers";

function agent(root: string, id: string, task: string, priority: number, transport: ReturnType<typeof refTransport>): ClaudeAdapter {
  const loaded: Loaded = {
    root,
    token: "test",
    config: { url: "http://unused", repo: "demo", agent: id, task: { id: task, title: task, priority }, change: `I-${id}` },
  };
  let now = 1_790_000_000_000;
  return new ClaudeAdapter(loaded, {
    transport,
    analyze: (changes, r, p) => analyzeChanges(changes, r, p),
    diff: (rel, b, a) => unifiedDiff(rel, b, a),
    now: () => (now += 5_000),
  });
}

const hook = (session: string, cwd: string, extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, cwd, ...extra });

/** The junior's Edit as Claude Code would send it to PreToolUse; returns the hook's verdict. */
async function juniorEdit(junior: ClaudeAdapter, root: string) {
  const file = `${root}/src/pricing.ts`;
  const pre = await junior.handle(hook("sb", root, {
    tool_name: "Edit",
    tool_use_id: "b1",
    tool_input: { file_path: file, old_string: PRICING_V1, new_string: PRICING_V2 },
  }));
  const spec = (pre as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } } | undefined)?.hookSpecificOutput;
  const text = JSON.stringify(pre ?? {});
  return { denied: spec?.permissionDecision === "deny", text };
}

async function overlap(firm: boolean) {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  const transport = refTransport(coord);
  const seniorRoot = checkout(firm ? "claim-firm-senior" : "claim-soft-senior");
  const juniorRoot = checkout(firm ? "claim-firm-junior" : "claim-soft-junior");
  const senior = agent(seniorRoot, "claude-a", "T-1", 1, transport);
  const junior = agent(juniorRoot, "claude-b", "T-2", 0, transport);
  await senior.handle(hook("sa", seniorRoot, { hook_event_name: "SessionStart" }));
  await junior.handle(hook("sb", juniorRoot, { hook_event_name: "SessionStart" }));
  const claimed = await senior.claim("sa", parseClaim(["--keys", "src/pricing.ts#calcTotal", ...(firm ? ["--firm"] : [])]));
  expect(claimed.code).toBe(0);
  return juniorEdit(junior, juniorRoot);
}

describe("claim_wait: a soft claim warns, a firm claim denies", () => {
  it("a soft claim: the junior's overlapping edit gets a claim_wait warning and is not denied", async () => {
    const r = await overlap(false);
    expect(r.denied).toBe(false);
    expect(r.text).toContain("being edited");
    expect(r.text).not.toContain("[weft error]");
  });

  it("a firm claim: the junior's overlapping edit is denied with a claim_wait error", async () => {
    const r = await overlap(true);
    expect(r.denied).toBe(true);
    expect(r.text).toContain("firmly claimed");
    expect(r.text).toContain("[weft error] claim_wait");
  });
});
