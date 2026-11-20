// A linked worktree (e.g. a Hermes kanban worktree at <main>/.worktrees/<task>) must not borrow
// the main checkout's Weft identity: git runs the main checkout's shared commit-msg hook there,
// and before this fix it stamped the MAIN checkout's Task-Id / Change-Id on worktree commits.
// Joining the worktree (`install --dir <wt> --token-from <main token>`) gives it its own.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot, isLinkedWorktree, loadConfig, unjoinedWorktree } from "../src/config";
import { checkout } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "weft-claude-home-")); // pins.json goes here, not ~/.config/weft
  const env = { ...process.env, WEFT_HOME: home, WEFT_TOKEN: "main-token" };
  const main = checkout("join");
  execFileSync(process.execPath, [BUNDLE, "install", "--url", "http://127.0.0.1:9", "--repo", "sp1234-app", "--agent", "app", "--task", "T-main"], { cwd: main, env, encoding: "utf8" });
  const wt = join(main, ".worktrees", "t_1");
  // the Hermes dispatcher's `git worktree add` (hooks disabled: no post-checkout can join it)
  execFileSync("git", ["-C", main, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "wt/t_1", wt], { stdio: "pipe" });
  const commit = (dir: string, file: string) => {
    writeFileSync(join(dir, file), `${file}\n`);
    execFileSync("git", ["-C", dir, "add", file]);
    execFileSync("git", ["-C", dir, "commit", "-qm", `add ${file}`], { env: { ...process.env, WEFT_HOME: home }, stdio: "pipe" });
    return execFileSync("git", ["-C", dir, "log", "-1", "--format=%B"], { encoding: "utf8" });
  };
  const { WEFT_TOKEN: _drop, ...noToken } = env;
  return { home, env, noToken, main, wt, commit };
}

describe("linked worktrees and the commit-msg hook", () => {
  it("an unjoined linked worktree inside the main checkout is not the main checkout", () => {
    const { main, wt } = setup();
    expect(isLinkedWorktree(wt)).toBe(true);
    expect(isLinkedWorktree(main)).toBe(false);
    mkdirSync(join(wt, "src", "deep"), { recursive: true });
    expect(findRoot(join(wt, "src", "deep"))).toBeUndefined();
    expect(loadConfig(wt)).toBeUndefined();
    expect(findRoot(join(main, "src"))).toBe(main);
  }, 30_000);

  it("commit-msg skips an unjoined worktree, and stamps the worktree's own task once it joined", () => {
    const { noToken, main, wt, commit } = setup();
    const mainCfg = JSON.parse(readFileSync(join(main, ".weft/claude.json"), "utf8"));
    expect(commit(main, "a.txt")).toContain(`Change-Id: ${mainCfg.change}\nTask-Id: T-main\nAgent-Id: app`);

    // the shared .git/hooks/commit-msg runs here too: it must not borrow the main checkout's identity
    const before = commit(wt, "b.txt");
    expect(before).not.toContain("Task-Id:");
    expect(before).not.toContain("Change-Id:");

    // join (what the Hermes plugin's on_kanban_worker_spawned hook runs): no token in the environment
    const out = execFileSync(process.execPath, [BUNDLE, "install", "--dir", wt, "--url", mainCfg.url, "--repo", mainCfg.repo, "--agent", mainCfg.agent,
      "--task", "t_1", "--mode", "enforce", "--token-from", join(main, ".weft/token")], { cwd: wt, env: noToken, encoding: "utf8" });
    expect(out).toContain("installed Claude Code adapter");
    expect(out).not.toContain("no token yet");
    expect(readFileSync(join(wt, ".weft/token"), "utf8").trim()).toBe("main-token");
    expect(statSync(join(wt, ".weft/token")).mode & 0o777).toBe(0o600);
    const wtCfg = JSON.parse(readFileSync(join(wt, ".weft/claude.json"), "utf8"));
    expect(wtCfg.change).toMatch(/^I[0-9a-f]{40}$/);
    expect(wtCfg.change).not.toBe(mainCfg.change);
    expect(JSON.stringify(wtCfg)).not.toContain("main-token");

    const after = commit(wt, "c.txt");
    expect(after).toContain(`Change-Id: ${wtCfg.change}\nTask-Id: t_1\nAgent-Id: app`);
    // the main checkout keeps its own identity
    expect(commit(main, "d.txt")).toContain(`Change-Id: ${mainCfg.change}\nTask-Id: T-main`);
  }, 30_000);

  it("install --token-from refuses an empty token file", () => {
    const { noToken, main, wt } = setup();
    const empty = join(main, ".weft", "empty");
    writeFileSync(empty, "\n");
    expect(() =>
      execFileSync(process.execPath, [BUNDLE, "install", "--dir", wt, "--url", "http://127.0.0.1:9", "--repo", "r", "--agent", "a", "--task", "t", "--token-from", empty], { env: noToken, stdio: "pipe" }),
    ).toThrow(/is empty/);
  }, 30_000);

  // `git worktree add` inside an enforced checkout must not be a way around enforcement.
  const hookIn = (cwd: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv) => {
    const out = execFileSync(process.execPath, [BUNDLE, "hook"], { cwd, env, encoding: "utf8", input: JSON.stringify({ cwd, session_id: "s1", hook_event_name: "PreToolUse", ...input }) });
    return out.trim() ? JSON.parse(out) : undefined;
  };
  const denied = (o: any) => o?.hookSpecificOutput?.permissionDecision === "deny" ? String(o.hookSpecificOutput.permissionDecisionReason) : undefined;

  it("an unjoined worktree of an enforcing checkout refuses edits and commands until it joins", () => {
    const { noToken, main, wt } = setup();
    expect(unjoinedWorktree(join(wt, "src"))).toEqual({ worktree: wt, owner: main });
    expect(unjoinedWorktree(main)).toBeUndefined();
    const edit = hookIn(wt, { tool_name: "Write", tool_input: { file_path: join(wt, "a.txt"), content: "x" } }, noToken);
    const why = denied(edit);
    expect(why).toContain("has not joined Weft");
    expect(why).toContain(`${main}/.weft/bin/weft`);
    expect(why).toContain(`--dir ${wt}`);
    expect(why).not.toContain("main-token");
    expect(denied(hookIn(wt, { tool_name: "Bash", tool_input: { command: "rm -f a.txt" } }, noToken))).toContain("has not joined Weft");
    // the join itself, and commands that work elsewhere, still run
    const mainCfg = JSON.parse(readFileSync(join(main, ".weft/claude.json"), "utf8"));
    const joinCmd = `${main}/.weft/bin/weft install --dir ${wt} --url ${mainCfg.url} --repo ${mainCfg.repo} --agent ${mainCfg.agent} --task t_1 --token-from ${main}/.weft/token`;
    expect(denied(hookIn(wt, { tool_name: "Bash", tool_input: { command: joinCmd } }, noToken))).toBeUndefined();
    expect(denied(hookIn(wt, { tool_name: "Bash", tool_input: { command: `${joinCmd}; rm -rf src` } }, noToken))).toContain("has not joined Weft");
    expect(denied(hookIn(wt, { tool_name: "Bash", tool_input: { command: `cd ${main} && git status` } }, noToken))).toBeUndefined();
    expect(denied(hookIn(wt, { tool_name: "Read", tool_input: { file_path: join(wt, "a.txt") } }, noToken))).toBeUndefined();
    // once joined, the worktree is its own agent and the refusal is gone
    execFileSync(process.execPath, [BUNDLE, "install", "--dir", wt, "--url", mainCfg.url, "--repo", mainCfg.repo, "--agent", mainCfg.agent,
      "--task", "t_1", "--mode", "enforce", "--token-from", join(main, ".weft/token")], { cwd: wt, env: noToken, encoding: "utf8" });
    expect(unjoinedWorktree(wt)).toBeUndefined();
    expect(String(denied(hookIn(wt, { tool_name: "Bash", tool_input: { command: "rm -f a.txt" } }, noToken)) ?? "")).not.toContain("has not joined Weft");
  }, 30_000);

  it("an advise-mode checkout's unjoined worktree is not refused", () => {
    const { noToken, main, wt } = setup();
    const cfgPath = join(main, ".weft/claude.json");
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), mode: "advise" }));
    expect(hookIn(wt, { tool_name: "Write", tool_input: { file_path: join(wt, "a.txt"), content: "x" } }, noToken)).toBeUndefined();
  }, 30_000);

  it("a worktree outside the main checkout is refused too when the main checkout enforces", () => {
    const { noToken, main } = setup();
    const outside = join(mkdtempSync(join(tmpdir(), "weft-outside-")), "wt2");
    execFileSync("git", ["-C", main, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "wt/t_2", outside], { stdio: "pipe" });
    const real = execFileSync("git", ["-C", outside, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    expect(unjoinedWorktree(real)?.owner).toBe(execFileSync("git", ["-C", main, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    expect(denied(hookIn(real, { tool_name: "Edit", tool_input: { file_path: join(real, "a.txt"), old_string: "a", new_string: "b" } }, noToken))).toContain("has not joined Weft");
  }, 30_000);
});
