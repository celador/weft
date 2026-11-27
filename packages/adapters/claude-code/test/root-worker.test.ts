// Issues #8 and #10: a per-worktree weft-worker (`install-agent --worktree W`, hooks run
// `hook --root W`) acts for its worktree on every call: edits reach the coordinator as that
// worktree's agent (GET /v1/repos/<repo>/events), its Bash `git commit` is gated against the
// worktree's session, its Stop (SubagentStop) runs the stop gate and ends its WCP session, and a
// worktree config that exists but does not load is logged there and coordinates nothing.
// Real bundle; each hook runs the exact command written into the agent file, through `sh -c`.
import { describe, expect, it, afterAll } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { excludeFromGit, loadConfigResult, namedCheckouts } from "../src/config";
import { PRICING_V1, PRICING_V2, checkout, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");
const run = promisify(execFile);
const servers: Array<{ close: () => void }> = [];
afterAll(() => servers.forEach((s) => s.close()));

async function coordinator(): Promise<{ coord: ReferenceCoordinator; url: string }> {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  const { url, server } = await serve(coord);
  servers.push(server);
  return { coord, url };
}

async function join_(url: string, dir: string, agent: string, task: string): Promise<void> {
  await run(process.execPath, [BUNDLE, "install", "--dir", dir, "--url", url, "--repo", "demo", "--agent", agent, "--task", task], { env: { ...process.env, WEFT_TOKEN: "local-test-token" } });
}

/** A joined main checkout with a joined linked worktree inside it (the kanban layout), and the per-worktree agent. */
async function layout(url: string, name: string) {
  const parent = checkout(name);
  await join_(url, parent, "parent-agent", `T-${name}`);
  const wt = join(parent, ".worktrees", "w1");
  execFileSync("git", ["-C", parent, "worktree", "add", "-q", wt, "-b", `w1-${name}`], { stdio: "pipe" });
  await join_(url, wt, "worker-1", `T-${name}-w1`);
  execFileSync(process.execPath, [BUNDLE, "install-agent", "--dir", parent, "--worktree", wt], { stdio: "pipe" });
  const md = readFileSync(join(parent, ".claude", "agents", "weft-worker-w1.md"), "utf8");
  const command = JSON.parse(/command: (".*")$/m.exec(md)![1]!) as string;
  return { parent, wt, md, command };
}

/** Run the agent file's hook command the way Claude Code runs a command hook: `sh -c`, JSON on stdin. */
async function agentHook(command: string, cwd: string, input: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  const child = run("sh", ["-c", command], { cwd, encoding: "utf8" });
  child.child.stdin!.end(JSON.stringify({ cwd, session_id: "parent-s", agent_id: "ag-1", agent_type: "weft-worker-w1", ...input }));
  const { stdout } = await child;
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

const logOf = (root: string) => (existsSync(join(root, ".weft/log/adapter.log")) ? readFileSync(join(root, ".weft/log/adapter.log"), "utf8") : "");

async function eventsOverHttp(url: string): Promise<Array<{ seq: number; kind: string; agent?: string; files?: string[]; status?: string }>> {
  const res = await fetch(`${url}/v1/repos/demo/events?after=0&limit=1000`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: Array<{ seq: number; kind: string; agent?: string; files?: string[]; status?: string }> }).events;
}

/** Write a file through the worker the way Claude Code's Write tool does, around its Pre/Post hooks. */
async function workerWrite(command: string, cwd: string, file: string, content: string, id: string) {
  const input = { tool_name: "Write", tool_use_id: id, tool_input: { file_path: file, content } };
  const pre = await agentHook(command, cwd, { hook_event_name: "PreToolUse", ...input });
  if (pre?.hookSpecificOutput?.permissionDecision === "deny") return pre;
  writeFileSync(file, content);
  await agentHook(command, cwd, { hook_event_name: "PostToolUse", ...input, tool_response: {} });
  return pre;
}

describe("install-agent --worktree (#10)", () => {
  it("writes weft-worker-<dir> into the parent's .claude/agents: hooks run `hook --root <worktree>` pinned, and Stop (SubagentStop) too", async () => {
    const { url } = await coordinator();
    const { parent, wt, md, command } = await layout(url, "ia-root");
    expect(md).toMatch(/^---\nname: weft-worker-w1\n/);
    expect(command).toContain(`hook --root ${wt} --url ${url} --repo demo --mode enforce`);
    for (const event of ["PreToolUse:", "PostToolUse:", "PostToolUseFailure:", "Stop:"]) expect(md).toContain(`\n  ${event}\n`);
    expect(md).toContain(`cd ${wt} && …`);
    expect(readFileSync(join(parent, ".git/info/exclude"), "utf8").split("\n").filter((l) => l === ".claude/agents/weft-worker-w1.md")).toHaveLength(1);
    // the same definition for `claude --agents` (a -p session skips untrusted project agents' frontmatter hooks)
    const json = JSON.parse(execFileSync(process.execPath, [BUNDLE, "install-agent", "--dir", parent, "--worktree", wt, "--print-json"], { encoding: "utf8" }));
    expect(Object.keys(json)).toEqual(["weft-worker-w1"]);
    expect(json["weft-worker-w1"].hooks.Stop[0].hooks[0].command).toBe(command);
    expect(json["weft-worker-w1"].prompt).toContain(wt);
  }, 60_000);

  it("refuses a symlinked .claude, .claude/agents or agent file, and a --worktree that is not a checkout top", async () => {
    const parent = checkout("ia-links");
    const outside = mkdtempSync(join(tmpdir(), "weft-ia-outside-"));
    const flags = ["install-agent", "--dir", parent, "--url", "https://weft.example.test", "--repo", "demo"];
    const refused = () => {
      try {
        execFileSync(process.execPath, [BUNDLE, ...flags], { stdio: "pipe" });
        return "";
      } catch (err) {
        return String((err as { stderr?: Buffer }).stderr);
      }
    };
    symlinkSync(outside, join(parent, ".claude"));
    expect(refused()).toContain("is a symlink");
    rmSync(join(parent, ".claude"));
    mkdirSync(join(parent, ".claude"));
    symlinkSync(outside, join(parent, ".claude", "agents"));
    expect(refused()).toContain("is a symlink");
    rmSync(join(parent, ".claude", "agents"));
    mkdirSync(join(parent, ".claude", "agents"));
    symlinkSync(join(outside, "x.md"), join(parent, ".claude", "agents", "weft-worker.md"));
    expect(refused()).toContain("is a symlink");
    expect(readdirSync(outside)).toEqual([]); // nothing was written through any link
    expect(() => execFileSync(process.execPath, [BUNDLE, ...flags, "--worktree", join(parent, "src")], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync(process.execPath, [BUNDLE, ...flags, "--worktree", "relative/wt"], { stdio: "pipe" })).toThrow();
  }, 30_000);
});

describe("hook --root: a worker in a joined worktree (#8, #10)", () => {
  it("#8: the worker's edits reach the coordinator as the worktree's agent (GET /v1/repos/demo/events), from a session whose cwd is the parent checkout", async () => {
    const { url } = await coordinator();
    const { parent, wt, command } = await layout(url, "ev");
    await workerWrite(command, parent, join(wt, "src/fresh.ts"), "export function fresh(n: number): number {\n  return n;\n}\n", "w1");
    // a shell edit: reconciled against the worktree after it runs
    const sh = `cd ${wt} && printf 'export const shell = 1;\\n' > src/shell.ts`;
    const bash = { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: sh } };
    expect(await agentHook(command, parent, { hook_event_name: "PreToolUse", ...bash })).toBeUndefined();
    await run("sh", ["-c", sh]);
    await agentHook(command, parent, { hook_event_name: "PostToolUse", ...bash, tool_response: {} });
    const edits = (await eventsOverHttp(url)).filter((e) => e.kind === "edit");
    expect(edits.map((e) => [e.agent, e.files, e.status])).toEqual([
      ["worker-1", ["src/fresh.ts"], "accepted"],
      ["worker-1", ["src/shell.ts"], "accepted"],
    ]);
    expect(logOf(parent)).not.toMatch(/ hello | check | commit /); // nothing went to the parent's agent
    // each subagent gets its own state (the parent session id + its agent_id)
    expect(readdirSync(join(wt, ".weft/state")).filter((f) => f.endsWith(".json"))).toEqual(["parent-s.agent-ag-1.json"]);
  }, 60_000);

  it("#10: the worker's Bash `git commit` is gated against the worktree's session; its SubagentStop is refused while errors are open, then ends its WCP session", async () => {
    const { coord, url } = await coordinator();
    const { parent, wt, command } = await layout(url, "gate");
    const other = checkout("gate-other");
    await join_(url, other, "agent-a", "T-a");
    // the worker starts (its base is before agent-a's change)
    await workerWrite(command, parent, join(wt, "src/note.ts"), "export const note = 1;\n", "w0");
    // agent-a changes calcTotal's signature
    const pricing = { file_path: join(other, "src/pricing.ts"), content: PRICING_V2 };
    const plain = (input: Record<string, unknown>) => {
      const c = run(process.execPath, [BUNDLE, "hook"], { cwd: other, encoding: "utf8" });
      c.child.stdin!.end(JSON.stringify({ cwd: other, session_id: "a-s", ...input }));
      return c;
    };
    await plain({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "a1", tool_input: pricing });
    writeFileSync(pricing.file_path, PRICING_V2);
    await plain({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "a1", tool_input: pricing, tool_response: {} });
    // the worker calls it the old way: denied, an open error on its change
    const cart = join(wt, "src/cart.ts");
    const stale = readFileSync(cart, "utf8").replace("return `${items.length} items`;", "return `total ${calcTotal(items)}`;");
    const denied = await workerWrite(command, parent, cart, stale, "w1");
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain("stale_assumption");

    const commit = await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: `cd ${wt} && git commit -am wip` } });
    expect(commit?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(commit?.hookSpecificOutput?.permissionDecisionReason).toContain("commit gate");

    const stop = await agentHook(command, parent, { hook_event_name: "SubagentStop", stop_hook_active: false });
    expect(stop?.decision).toBe("block");
    expect(stop?.reason).toContain("stale_assumption");
    expect(coord.log.filter((r) => r.kind === "leave")).toEqual([]);

    // the worker adapts: accepted, the error clears; the commit gate and the stop gate open; bye
    const fixed = readFileSync(cart, "utf8").replace("return `${items.length} items`;", "return `total ${calcTotal(items, { taxRate: 0 })}`;");
    expect((await workerWrite(command, parent, cart, fixed, "w2"))?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c2", tool_input: { command: `cd ${wt} && git commit -am wip` } })).toBeUndefined();
    expect(await agentHook(command, parent, { hook_event_name: "SubagentStop", stop_hook_active: true })).toBeUndefined();
    expect(coord.log.filter((r) => r.kind === "leave" && r.agent === "worker-1")).toHaveLength(1);
    expect(logOf(wt)).toMatch(/bye \S+/);
    // nothing of this was the parent agent's
    expect(coord.log.filter((r) => r.agent === "parent-agent")).toEqual([]);
    void PRICING_V1;
  }, 90_000);

  it("#10: a worktree config that exists but does not load is logged in that worktree and coordinates nothing (no fallback to the parent's agent)", async () => {
    const { coord, url } = await coordinator();
    const { parent, wt, command } = await layout(url, "broken");
    const cfg = join(wt, ".weft/claude.json");
    const good = readFileSync(cfg, "utf8");
    for (const [what, breakIt, reason] of [
      ["invalid JSON", () => writeFileSync(cfg, "{ not json"), "invalid JSON"],
      ["no token", () => (writeFileSync(cfg, good), rmSync(join(wt, ".weft/token"))), "no token"],
    ] as const) {
      breakIt();
      const out = await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: `x-${what}`, tool_input: { file_path: join(wt, "src/x.ts"), content: "export const x = 1;\n" } });
      expect(out?.hookSpecificOutput?.permissionDecision, what).toBeUndefined();
      expect(out?.hookSpecificOutput?.additionalContext, what).toContain("exists but does not load");
      expect(logOf(wt), what).toContain(`hook --root: ${cfg} exists but does not load (`);
      expect(logOf(wt), what).toContain(reason);
    }
    expect(logOf(wt)).not.toContain("local-test-token");
    expect(coord.log).toEqual([]);
    expect(logOf(parent)).toBe("");
  }, 60_000);

  it("the worker is bound to its worktree: edits in another checkout and Bash commands that start elsewhere are refused", async () => {
    const { url } = await coordinator();
    const { parent, wt, command } = await layout(url, "bound");
    const parentEdit = await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "p1", tool_input: { file_path: join(parent, "src/cart.ts"), old_string: "items", new_string: "xs" } });
    expect(parentEdit?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parentEdit?.hookSpecificOutput?.permissionDecisionReason).toContain(`bound to the worktree ${wt}`);
    for (const cmd of ["ls", "git commit -am x", `cd ${parent} && ls`, `cd ${wt}/.. && ls`]) {
      const out = await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "p2", tool_input: { command: cmd } });
      expect(out?.hookSpecificOutput?.permissionDecision, cmd).toBe("deny");
    }
    expect(await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "p3", tool_input: { command: `git -C ${wt} status` } })).toBeUndefined();
    // a scratch file in no checkout is not coordinated, and not refused
    const scratch = join(mkdtempSync(join(tmpdir(), "weft-scratch-")), "notes.txt");
    expect(await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "p4", tool_input: { file_path: scratch, content: "x" } })).toBeUndefined();
    // the worktree's own .weft/ (its identity) is refused
    const weft = await agentHook(command, parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "p5", tool_input: { file_path: join(wt, ".weft/claude.json"), content: "{}" } });
    expect(weft?.hookSpecificOutput?.permissionDecision).toBe("deny");
  }, 60_000);

  it("Bash is reconciled opaquely: a write in a subshell, and in another joined checkout the command names, are each coordinated as their own agent", async () => {
    const { coord, url } = await coordinator();
    const { parent, wt, command } = await layout(url, "opaque");
    const other = checkout("opaque-other");
    await join_(url, other, "agent-o", "T-o");
    const sh = `cd ${wt} && (cd src && printf 'export const sub = 1;\\n' > sub.ts)\nprintf 'export const there = 1;\\n' > "${other}/src/there.ts"`;
    const bash = { tool_name: "Bash", tool_use_id: "o1", tool_input: { command: sh } };
    expect(await agentHook(command, parent, { hook_event_name: "PreToolUse", ...bash })).toBeUndefined();
    await run("sh", ["-c", sh]);
    await agentHook(command, parent, { hook_event_name: "PostToolUse", ...bash, tool_response: {} });
    const edits = coord.log.filter((r) => r.kind === "edit").map((r) => [r.agent, r.files]);
    expect(edits).toEqual(expect.arrayContaining([["worker-1", ["src/sub.ts"]], ["agent-o", ["src/there.ts"]]]));
    expect(edits).toHaveLength(2);
  }, 60_000);
});

describe("helpers (#18)", () => {
  it("namedCheckouts reads every absolute or ~ path in a command, whatever the shell syntax around it", () => {
    const a = checkout("nc-a");
    const b = checkout("nc-b");
    expect(namedCheckouts(`cd ${a} && ls`)).toEqual([a]);
    expect(namedCheckouts(`echo hi; (cd "${b}/src" && sed -i s/x/y/ f)\ncat ${a}/README`).sort()).toEqual([a, b].sort());
    expect(namedCheckouts(`cp x --target=${b}/src 2>${a}/err.log`).sort()).toEqual([a, b].sort());
    expect(namedCheckouts(`cd ${a}/../x && ls`)).toEqual([]); // `..` is resolved after symlinks: skipped
    expect(namedCheckouts("ls src && sed -i 's/a/b/' f")).toEqual([]);
  });

  it("excludeFromGit appends each line once", () => {
    const root = checkout("excl");
    excludeFromGit(root, [".weft/", ".claude/agents/a.md"]);
    excludeFromGit(root, [".weft/", ".claude/agents/a.md", ".claude/agents/b.md"]);
    const lines = readFileSync(join(root, ".git/info/exclude"), "utf8").split("\n");
    for (const l of [".weft/", ".claude/agents/a.md", ".claude/agents/b.md"]) expect(lines.filter((x) => x === l), l).toHaveLength(1);
  });

  it("loadConfigResult says why a config does not load, never with the token in it", () => {
    const root = checkout("lcr");
    mkdirSync(join(root, ".weft"));
    writeFileSync(join(root, ".weft/claude.json"), JSON.stringify({ url: "http://x", repo: "demo", agent: "a", task: { id: "T" } }));
    writeFileSync(join(root, ".weft/token"), "sekrit\n");
    expect(loadConfigResult(root, {} as NodeJS.ProcessEnv).problem).toBe(".weft/claude.json lacks change");
    writeFileSync(join(root, ".weft/claude.json"), JSON.stringify({ url: "http://x", repo: "demo", agent: "a", task: { id: "T" }, change: "I1", tokenFile: "src/outside-token" }));
    writeFileSync(join(root, "src/outside-token"), "sekrit\n");
    const r = loadConfigResult(root, {} as NodeJS.ProcessEnv, ".weft/claude.json", true);
    expect(r.problem).toBe("token not read: tokenFile outside .weft/");
    expect(JSON.stringify(r)).not.toContain("sekrit");
  });
});
