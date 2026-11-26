// `hook --by-path` (issue #11): Codex subagents run in the parent's cwd and their hooks carry the
// parent's session id, so a patch inside a subagent's own joined worktree is routed by its files.
// Real bundle, real git, local coordinator; payloads follow learn.chatgpt.com/docs/hooks.
import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterLog, byPathArgs, coordinator, joinedAgents } from "../../claude-code/test/translator-kit";
import { codexTargets } from "../src/cli";
import { CART_V1, checkout } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-codex.mjs");
const CART_LINE = "return `${items.length} items`;";
const OLD_CALL = "return `total ${calcTotal(items)}`;";
const NEW_CALL = "return `total ${calcTotal(items, { taxRate: 0 })}`;";

function install(root: string, url: string, agent: string, extra: string[] = []): string {
  return execFileSync(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", agent, "--task", `T-${agent}`, ...extra], {
    cwd: root,
    env: { ...process.env, WEFT_TOKEN: "local-test-token" },
    encoding: "utf8",
  });
}

function hook(cwd: string, input: Record<string, unknown>, args: string[] = ["hook"]): Promise<Record<string, any>> {
  return new Promise((res, rej) => {
    const child = execFile(process.execPath, [BUNDLE, ...args], { cwd, encoding: "utf8", env: { ...process.env, WEFT_TOKEN: "" } }, (err, stdout) => (err ? rej(err) : res(stdout.trim() ? JSON.parse(stdout) : {})));
    child.stdin!.end(JSON.stringify({ session_id: "thr_parent", cwd, ...input }));
  });
}

const patchOf = (file: string, from: string, to: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-  ${from}\n+  ${to}\n*** End Patch`;
const applyPatch = (id: string, command: string, event = "PreToolUse") => ({ hook_event_name: event, turn_id: "turn-1", tool_name: "apply_patch", tool_use_id: id, tool_input: { command } });

describe("codexTargets", () => {
  it("names every apply_patch file; a shell patch's files relative to its leading cd; else a Bash command's leading target", () => {
    const two = "*** Begin Patch\n*** Update File: /w/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch";
    expect(codexTargets({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "apply_patch", tool_input: { command: two } }, "/p")).toEqual(["/w/a.ts", "src/b.ts"]);
    const bash = (command: string) => ({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command } });
    expect(codexTargets(bash(`cd /w && apply_patch <<'EOF'\n${two}\nEOF`), "/p")).toEqual(["/w/a.ts", "/w/src/b.ts"]);
    expect(codexTargets(bash(`cd ../w && apply_patch <<'EOF'\n${two}\nEOF`), "/p")).toEqual([]);
    expect(codexTargets(bash("git -C /w commit -m x"), "/p")).toEqual(["/w"]);
    expect(codexTargets(bash("npm test"), "/p")).toEqual([]);
    expect(codexTargets({ hook_event_name: "Stop", session_id: "s" }, "/p")).toEqual([]);
  });
});

describe("Codex --by-path routing (issue #11, real bundle)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("install --by-path pins the hooks to this checkout's coordinator; a plain install is unchanged", async () => {
    const { url, server } = await coordinator();
    servers.push(server);
    const plain = checkout("bp-plain");
    install(plain, url, "codex-p");
    expect(JSON.parse(readFileSync(join(plain, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command).toMatch(/weft-codex\.mjs hook$/);
    const routed = checkout("bp-routed");
    expect(install(routed, url, "codex-q", ["--by-path"])).toContain("routing: by path");
    expect(JSON.parse(readFileSync(join(routed, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command).toContain(`weft-codex.mjs hook --by-path --url ${url} --repo demo --mode enforce`);
  }, 30_000);

  it("from a non-joined parent dir, a patch inside a joined worktree is checked as that worktree's agent; plain routing stays a no-op", async () => {
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const parent = checkout("parent"); // the session's cwd: never joined
    const wt = checkout("wt");
    install(wt, url, "worker-w");
    changeSignature();
    const cart = join(wt, "src/cart.ts");

    // plain: the parent has no .weft/codex.json, so nothing is coordinated (as before)
    expect(await hook(parent, applyPatch("call-1", patchOf(cart, CART_LINE, OLD_CALL)))).toEqual({});
    expect(joinedAgents(coord)).not.toContain("worker-w");

    // --by-path: the worktree's agent checks the patch and refuses the stale call
    const pre = await hook(parent, applyPatch("call-2", patchOf(cart, CART_LINE, OLD_CALL)), byPathArgs(url));
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(pre.hookSpecificOutput.permissionDecisionReason).toContain("[weft error] stale_assumption src/cart.ts:4:19");
    expect(joinedAgents(coord)).toContain("worker-w");

    // the fixed patch is committed as worker-w
    const fixed = patchOf(cart, CART_LINE, NEW_CALL);
    expect((await hook(parent, applyPatch("call-3", fixed), byPathArgs(url))).hookSpecificOutput?.permissionDecision).toBeUndefined();
    writeFileSync(cart, CART_V1.replace(CART_LINE, NEW_CALL));
    await hook(parent, { ...applyPatch("call-3", fixed, "PostToolUse"), tool_response: "Success" }, byPathArgs(url));
    expect(coord.log.filter((r) => r.kind === "edit" && r.mode === "commit").pop()).toMatchObject({ agent: "worker-w", status: "accepted", files: ["src/cart.ts"] });

    // a worktree joined to another coordinator than the pin is not coordinated; the model is told, the log says why
    const other = await hook(parent, applyPatch("call-4", patchOf(cart, NEW_CALL, OLD_CALL)), byPathArgs(url, "other-repo"));
    expect(other.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(other.hookSpecificOutput.additionalContext).toContain("not coordinated");
    expect(adapterLog(wt)).toContain("do not match the pinned coordinator");
  }, 60_000);

  it("a worktree nested in a joined parent (<main>/.worktrees/<task>) acts as its own agent, and one patch across both checkouts is refused", async () => {
    const { coord, url, server } = await coordinator();
    servers.push(server);
    const main = checkout("nested-main");
    install(main, url, "codex-main", ["--by-path"]);
    const wt = join(main, ".worktrees", "t1");
    mkdirSync(dirname(wt), { recursive: true });
    execFileSync("git", ["-C", main, "worktree", "add", "-q", wt, "-b", "t1"]);
    install(wt, url, "worker-t1");
    const inWt = join(wt, "src/cart.ts");
    const inMain = join(main, "src/cart.ts");

    // plain: the edit in the nested worktree is reported as the parent's agent (the bug #11 describes)
    await hook(main, applyPatch("n-1", patchOf(inWt, CART_LINE, NEW_CALL)));
    expect(joinedAgents(coord)).toEqual(["codex-main"]);

    // --by-path: the same patch is the worktree's agent's
    await hook(main, applyPatch("n-2", patchOf(inWt, CART_LINE, NEW_CALL)), byPathArgs(url));
    expect(joinedAgents(coord)).toEqual(["codex-main", "worker-t1"]);

    // the parent's own files stay the parent's
    await hook(main, applyPatch("n-3", patchOf(inMain, CART_LINE, NEW_CALL)), byPathArgs(url));
    expect(joinedAgents(coord)).toEqual(["codex-main", "worker-t1"]);

    // one patch writing into both checkouts cannot be one agent's: refused, with both named
    const both = `*** Begin Patch\n*** Update File: ${inWt}\n@@\n-  ${CART_LINE}\n+  ${NEW_CALL}\n*** Update File: ${inMain}\n@@\n-  ${CART_LINE}\n+  ${NEW_CALL}\n*** End Patch`;
    const split = await hook(main, applyPatch("n-4", both), byPathArgs(url));
    expect(split.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(split.hookSpecificOutput.permissionDecisionReason).toContain("more than one checkout");
    expect(split.hookSpecificOutput.permissionDecisionReason).toContain(wt);
    expect(split.hookSpecificOutput.permissionDecisionReason).toContain(main);
  }, 60_000);
});
