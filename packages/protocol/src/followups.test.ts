// #18 follow-ups in the protocol package: one parser and one default for the repo modes, the
// mode-aware claim_wait suggestion, and which session an agent's own command acts in.
import { describe, expect, it } from "vitest";
import {
  claimWaitSuggestion,
  conflictModeFromEnv,
  conflictModeOf,
  DEFAULT_CONFLICT_MODE,
  DEFAULT_ENFORCEMENT_MODE,
  enforcementModeFromEnv,
  enforcementModeOf,
  parseConflictMode,
  parseEnforcementMode,
} from "./modes";
import { cliSessionId, pickCliSession, takeSessionFlag } from "./cli-session";
import { ReferenceCoordinator } from "./reference";

describe("repo modes: one parser, one default (#18)", () => {
  it("absent means the default; only exact mode names parse", () => {
    expect(DEFAULT_CONFLICT_MODE).toBe("hold");
    expect(DEFAULT_ENFORCEMENT_MODE).toBe("advise");
    expect(parseConflictMode(undefined)).toEqual({ ok: true, mode: undefined });
    expect(parseConflictMode(null)).toEqual({ ok: true, mode: undefined });
    expect(parseConflictMode("continue")).toEqual({ ok: true, mode: "continue" });
    expect(parseEnforcementMode("block")).toEqual({ ok: true, mode: "block" });
    for (const bad of ["", "Continue", "HOLD", 1, true, {}]) expect(parseConflictMode(bad)).toEqual({ ok: false, error: "conflicts must be hold or continue" });
    for (const bad of ["", "Block", "enforce"]) expect(parseEnforcementMode(bad)).toEqual({ ok: false, error: "enforcement must be advise or block" });
    expect(conflictModeOf(undefined)).toBe("hold");
    expect(enforcementModeOf(undefined)).toBe("advise");
  });

  it("an env var: unset or empty is the default, a typo throws instead of silently running the default", () => {
    expect(conflictModeFromEnv(undefined)).toBe("hold");
    expect(conflictModeFromEnv("")).toBe("hold");
    expect(conflictModeFromEnv("continue")).toBe("continue");
    expect(() => conflictModeFromEnv("contineu", "DEMO_CONFLICTS")).toThrow("DEMO_CONFLICTS: conflicts must be hold or continue");
    expect(enforcementModeFromEnv("block")).toBe("block");
    expect(() => enforcementModeFromEnv("strict")).toThrow("WEFT_ENFORCEMENT: enforcement must be advise or block");
  });

  it("the reference coordinator takes its defaults from the same place", () => {
    const c = new ReferenceCoordinator({ repo: "r" });
    expect(c.conflicts).toBe(DEFAULT_CONFLICT_MODE);
    expect(c.enforcement).toBe(DEFAULT_ENFORCEMENT_MODE);
  });
});

describe("claim_wait suggestion follows the conflicts mode (#18)", () => {
  it("hold may say wait; continue never does", () => {
    expect(claimWaitSuggestion("a.ts#f", "claude-a", "hold")).toBe("Wait for claude-a to land or release a.ts#f, work elsewhere, or negotiate (negotiate.propose to claude-a).");
    const c = claimWaitSuggestion("a.ts#f", "claude-a", "continue");
    expect(c).not.toMatch(/\bwait/i);
    expect(c).toBe("Leave a.ts#f to claude-a and keep working on your other tasks; negotiate (negotiate.propose to claude-a) if your task needs a.ts#f.");
  });

  it("both modes put it on the verdict the reference coordinator returns", () => {
    for (const conflicts of ["hold", "continue"] as const) {
      const c = new ReferenceCoordinator({ repo: "r", conflicts });
      const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
      const a = c.hello({ type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "claude-code" }, capabilities: caps, task: { id: "T-1" } });
      const b = c.hello({ type: "hello", protocol: "wcp/0.1", agent: { id: "codex-b", harness: "codex" }, capabilities: caps, task: { id: "T-2" } });
      c.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, writes: [{ key: "a.ts#f", kind: "body" }] } });
      const v = c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: "a.ts#f", kind: "body" }] } });
      expect(v.diagnostics.find((d) => d.code === "claim_wait")?.suggestion).toBe(claimWaitSuggestion("a.ts#f", "claude-a", conflicts));
    }
  });
});

describe("the session an agent's own command acts in (#18)", () => {
  const me = { agent: "claude-a", change: "I-claude-a" };
  it("uses the marker when it is this agent's session", () => {
    expect(pickCliSession({ ...me, marker: "s1", states: [{ session: "s1", agent: "claude-a", mtimeMs: 1 }, { session: "c1", agent: "codex-b", mtimeMs: 2 }] })).toEqual({ session: "s1" });
  });
  it("never falls back to another agent's session: its own newest one instead", () => {
    const states = [
      { session: "s1", agent: "claude-a", mtimeMs: 1 },
      { session: "s2", agent: "claude-a", mtimeMs: 3 },
      { session: "c1", agent: "codex-b", mtimeMs: 9 },
    ];
    expect(pickCliSession({ ...me, marker: "c1", states })).toEqual({ session: "s2" });
  });
  it("refuses when the checkout's sessions are another agent's and none is this agent's", () => {
    const r = pickCliSession({ ...me, marker: "c1", states: [{ session: "c1", agent: "codex-b", mtimeMs: 9 }] });
    expect(r).toEqual({ refused: expect.stringContaining("(c1) is codex-b's, not claude-a's") });
    expect((r as { refused: string }).refused).toContain("--session new to open a new session of your change I-claude-a");
    // No marker, but the only state is another agent's: same answer.
    expect(pickCliSession({ ...me, states: [{ session: "c1", agent: "codex-b", mtimeMs: 9 }] })).toHaveProperty("refused");
    // An untagged (pre-#18) marker in a checkout another agent is known to share is not trusted either.
    expect(pickCliSession({ ...me, marker: "old", states: [{ session: "old", mtimeMs: 1 }, { session: "c1", agent: "codex-b", mtimeMs: 9 }] })).toHaveProperty("refused");
  });
  it("an explicit --session wins unless it is another agent's; `new` opens one of this agent's own", () => {
    const states = [{ session: "c1", agent: "codex-b", mtimeMs: 9 }];
    expect(pickCliSession({ ...me, states, explicit: "new" })).toEqual({ session: cliSessionId("claude-a") });
    expect(pickCliSession({ ...me, states, explicit: "x9" })).toEqual({ session: "x9" });
    expect(pickCliSession({ ...me, states, explicit: "c1" })).toEqual({ refused: "weft: session c1 belongs to codex-b, not claude-a; nothing was sent." });
  });
  it("keeps the old behaviour in a single-agent checkout (untagged state) and with no state at all", () => {
    expect(pickCliSession({ ...me, marker: "old", states: [{ session: "old", mtimeMs: 1 }] })).toEqual({ session: "old" });
    expect(pickCliSession({ ...me, states: [{ session: "a", mtimeMs: 1 }, { session: "b", mtimeMs: 2 }] })).toEqual({ session: "b" });
    expect(pickCliSession({ ...me, states: [] })).toEqual({ session: "cli-claude-a" });
    expect(cliSessionId("codex-b")).not.toBe(cliSessionId("claude-a"));
  });
  it("--session is stripped before the subcommand parser sees the arguments", () => {
    expect(takeSessionFlag(["--keys", "a.ts#f", "--session", "s1", "--firm"])).toEqual({ explicit: "s1", rest: ["--keys", "a.ts#f", "--firm"] });
    expect(takeSessionFlag(["--keys", "a.ts#f"])).toEqual({ rest: ["--keys", "a.ts#f"] });
    expect(takeSessionFlag(["--session"])).toMatchObject({ error: "--session needs a session id (or `new`)" });
    expect(takeSessionFlag(["--session", "--firm"])).toMatchObject({ error: expect.any(String) });
  });
});
