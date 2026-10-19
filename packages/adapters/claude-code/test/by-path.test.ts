// `hook --by-path` routing (issue #8c): a weft-worker subagent runs in the parent session's cwd
// but edits inside its own joined worktree. Only a checkout pinned to the parent's coordinator is
// trusted, and a Bash command must name its worktree in an accepted form. Real bundle throughout.
import { describe, expect, it, afterAll } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_REL, bashTargetDir, configStarts } from "../src/config";
import type { HookInput } from "../src/hooks";
import { checkout, serve } from "./helpers";

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

/** A checkout joined to the coordinator at `url` as `agent` (installed through the bundle). */
async function joined(url: string, name: string, agent: string): Promise<string> {
  const root = checkout(name);
  await run(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", agent, "--task", `T-${name}`], {
    cwd: root,
    env: { ...process.env, WEFT_TOKEN: "local-test-token" },
  });
  return root;
}

/** `weft-claude hook <args>` on one hook input from `cwd`; the parsed stdout (undefined when empty). */
async function hook(args: string[], cwd: string, input: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  const child = run(process.execPath, [BUNDLE, "hook", ...args], { cwd, encoding: "utf8" });
  child.child.stdin!.end(JSON.stringify({ cwd, session_id: "parent-s", ...input }));
  const { stdout } = await child;
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

function logOf(root: string): string {
  try {
    return readFileSync(join(root, ".weft", "log", "adapter.log"), "utf8");
  } catch {
    return "";
  }
}

const pinned = (url: string) => ["--by-path", "--url", url, "--repo", "demo"];

describe("bashTargetDir and configStarts (issue #8c)", () => {
  it("bashTargetDir accepts only a leading `cd <abs|~> &&` or `git -C <abs|~>`", () => {
    const home = homedir();
    expect(bashTargetDir("cd /wt/a && npm test", "/repo")).toBe("/wt/a");
    expect(bashTargetDir(`cd "/wt/a b" && sed -i s/x/y/ f`, "/repo")).toBe("/wt/a b");
    expect(bashTargetDir(`cd '/wt/q' && ls`, "/repo")).toBe("/wt/q");
    expect(bashTargetDir("cd ~/wt && ls", "/repo")).toBe(join(home, "wt"));
    expect(bashTargetDir("cd ~ && ls", "/repo")).toBe(home);
    expect(bashTargetDir("git -C /wt/c commit -m x", "/repo")).toBe("/wt/c");
    expect(bashTargetDir("git -C ~/wt status", "/repo")).toBe(join(home, "wt"));
  });

  it("bashTargetDir refuses every other form (relative, $VAR, not leading, no &&): fail closed", () => {
    for (const cmd of [
      "ls -la",
      "echo cd /not/this",
      "echo hi; cd /wt && ls", // cd not leading
      "cd /wt", // no &&
      "cd ../wt && ls", // relative
      "cd src && ls",
      `cd "$WEFT_TEST_WT" && ls`, // variable
      "cd $HOME/wt && ls",
      "cd ${HOME}/wt && ls",
      "git -C ../wt status",
      "git -C $HOME status",
      "git status", // no -C
    ]) expect(bashTargetDir(cmd, "/repo"), cmd).toBeUndefined();
  });

  it("configStarts: --by-path looks in the edited file's own joined checkout (Bash: the cd target's), else cwd", () => {
    const joinedDir = checkout("cs-joined");
    mkdirSync(join(joinedDir, ".weft"));
    writeFileSync(join(joinedDir, ".weft/claude.json"), "{}");
    const parent = checkout("cs-parent");
    const edit = (file: string) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Edit", tool_input: { file_path: file } }) as HookInput;
    const bash = (command: string) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Bash", tool_input: { command } }) as HookInput;
    expect(configStarts(edit(join(joinedDir, "src/cart.ts")), false)).toEqual([parent]);
    expect(configStarts(edit(join(joinedDir, "src/cart.ts")), true)).toEqual([joinedDir]);
    expect(configStarts(edit("/tmp/outside-any-checkout.ts"), true)).toEqual([]);
    // An unjoined checkout (it has .git, no config) is not coordinated; it must not fall back to the parent's config.
    const unjoined = checkout("cs-unjoined");
    expect(configStarts(edit(join(unjoined, "src/x.ts")), true)).toEqual([]);
    expect(configStarts(bash(`cd ${joinedDir} && echo x > src/n.ts`), true)).toEqual([joinedDir]);
    expect(configStarts(bash("echo x > src/n.ts"), true)).toEqual([parent]);
    // A glob or brace is expanded by the shell before cd: not a target.
    expect(bashTargetDir("cd /wt/* && sed -i s/a/b/ f", "/repo")).toBeUndefined();
    expect(bashTargetDir("cd /wt/{a,b} && sed -i s/a/b/ f", "/repo")).toBeUndefined();
  });
});

describe("install-agent and the coordinator pin (issue #8c, real bundle)", () => {
  it("install-agent pins the parent session's coordinator; with no config to pin it needs --url and --repo", async () => {
    const parent = checkout("ia-parent");
    expect(() => execFileSync(process.execPath, [BUNDLE, "install-agent"], { cwd: parent, stdio: "pipe" })).toThrow();
    execFileSync(process.execPath, [BUNDLE, "install-agent", "--url", "https://weft.example.test", "--repo", "demo"], { cwd: parent });
    expect(readFileSync(join(parent, ".claude/agents/weft-worker.md"), "utf8")).toContain("hook --by-path --url https://weft.example.test --repo demo");
    // a joined parent: its own config wins over flags
    const joinedRoot = await joined("https://weft.example.test", "ia-joined", "parent-a");
    execFileSync(process.execPath, [BUNDLE, "install-agent", "--url", "https://other.example.test", "--repo", "demo"], { cwd: joinedRoot });
    const md = readFileSync(join(joinedRoot, ".claude/agents/weft-worker.md"), "utf8");
    expect(md).toContain("--url https://weft.example.test --repo demo");
    expect(md).not.toContain("other.example.test");
  }, 30_000);

  it("the worker definition runs the pinned hook on Edit/Write/MultiEdit/Bash and on Bash failures", () => {
    const parent = checkout("ia-md");
    execFileSync(process.execPath, [BUNDLE, "install-agent", "--url", "https://weft.example.test", "--repo", "demo"], { cwd: parent });
    const md = readFileSync(join(parent, ".claude/agents/weft-worker.md"), "utf8");
    expect(md).toMatch(/^---\nname: weft-worker\n/);
    expect(md).toContain('matcher: "Edit|Write|MultiEdit|Bash"');
    expect(md).toContain("PostToolUseFailure:");
  });
});

describe("--by-path coordinates only the pinned checkout (issue #8c, real bundle)", () => {
  it("a checkout whose config has another url is refused and logged; the pinned one is coordinated; an unpinned hook trusts nothing", async () => {
    const { url } = await coordinator();
    const good = await joined(url, "pin-good", "worker-pin");
    const evil = await joined("https://attacker.example.test", "pin-evil", "worker-evil");
    const parent = checkout("pin-parent");
    const write = (wt: string, name: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_use_id: `w-${name}`,
      tool_input: { file_path: join(wt, `src/${name}.ts`), content: `export function ${name}(n: number) { return n; }\n` },
    });

    const refused = await hook(pinned(url), parent, write(evil, "fe"));
    expect(refused?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(refused?.hookSpecificOutput?.additionalContext).toContain("not coordinated");
    expect(logOf(evil)).toContain("hook --by-path refused");
    expect(logOf(evil)).not.toContain("hello worker-evil");

    await hook(pinned(url), parent, write(good, "fg"));
    expect(logOf(good)).toContain("hello worker-pin");
    expect(logOf(good)).toContain("check src/fg.ts");

    await hook(["--by-path"], parent, write(good, "fh"));
    expect(logOf(good)).toContain("hook --by-path refused");
    expect(logOf(good)).not.toContain("src/fh.ts");
  }, 30_000);

  it("--by-path Bash: an accepted target is attributed; any other form is denied before it runs; plain hook never denies (real bundle)", async () => {
    const { url } = await coordinator();
    const wt = await joined(url, "bf-wt", "worker-bf");
    const parent = checkout("bf-parent");
    const pre = (command: string) => hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "bf", tool_input: { command } });

    for (const command of [`cd ${wt} && ls`, `cd "${wt}" && npm test`, `cd '${wt}' && ls`, `git -C ${wt} status`]) {
      expect((await pre(command))?.hookSpecificOutput?.permissionDecision, command).toBeUndefined();
    }
    for (const command of ["ls -la", "cd src && ls", "cd $HOME/x && ls", `echo hi; cd ${wt} && ls`, `cd ${wt}`, "git -C src status"]) {
      const out = await pre(command);
      expect(out?.hookSpecificOutput?.permissionDecision, command).toBe("deny");
      expect(out?.hookSpecificOutput?.permissionDecisionReason, command).toContain("cd <worktree> &&");
    }
    expect(await hook([], parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } })).toBeUndefined();
  }, 60_000);

  it("a subagent's first call is a shell edit (no SessionStart of its own): the file is coordinated as the worktree's agent (real bundle)", async () => {
    const { coord, url } = await coordinator();
    const wt = await joined(url, "bf-first", "worker-first");
    const parent = checkout("first-parent");
    const command = `cd ${wt} && printf 'export function newFn(n: number) { return n; }\\n' > src/new.ts`;
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "f1", tool_input: { command } };
    await hook(pinned(url), parent, input);
    await run("sh", ["-c", command]); // what Claude's Bash tool does
    await hook(pinned(url), parent, { ...input, hook_event_name: "PostToolUse", tool_response: {} });
    const edits = (coord.events(0, 1000).events as Array<{ kind: string; agent?: string; files: string[] }>).filter((e) => e.kind === "edit" && e.agent === "worker-first");
    expect(edits.map((e) => e.files)).toEqual([["src/new.ts"]]);
  }, 30_000);
});

describe("token file location under --by-path (issue #8c, review)", () => {
  it("a tokenFile outside .weft/ is not read: the config does not load", async () => {
    const { loadConfig } = await import("../src/config");
    const root = checkout("token-outside");
    writeFileSync(join(root, "outside-token"), "secret\n");
    const cfg = { url: "http://localhost:1", repo: "demo", agent: "a", change: "I" + "0".repeat(40), task: { id: "T" }, tokenFile: "outside-token" };
    mkdirSync(join(root, ".weft"), { recursive: true });
    writeFileSync(join(root, ".weft", "claude.json"), JSON.stringify(cfg));
    expect(loadConfig(root, {} as NodeJS.ProcessEnv, CONFIG_REL, true)).toBeUndefined();
    // plain hook and the other commands keep reading it (install --token-file may put it anywhere)
    expect(loadConfig(root, {} as NodeJS.ProcessEnv)?.token).toBe("secret");
  });

  it("a symlink under .weft/ that points outside it is refused", async () => {
    const { loadConfig } = await import("../src/config");
    const root = checkout("token-symlink");
    mkdirSync(join(root, ".weft"), { recursive: true });
    writeFileSync(join(root, "outside-token"), "secret\n");
    symlinkSync(join(root, "outside-token"), join(root, ".weft", "token"));
    const cfg = { url: "http://localhost:1", repo: "demo", agent: "a", change: "I" + "0".repeat(40), task: { id: "T" } };
    writeFileSync(join(root, ".weft", "claude.json"), JSON.stringify(cfg));
    expect(loadConfig(root, {} as NodeJS.ProcessEnv, CONFIG_REL, true)).toBeUndefined();
  });

  it("a real token under .weft/ loads", async () => {
    const { loadConfig } = await import("../src/config");
    const root = checkout("token-inside");
    mkdirSync(join(root, ".weft"), { recursive: true });
    writeFileSync(join(root, ".weft", "token"), "secret\n");
    writeFileSync(join(root, ".weft", "claude.json"), JSON.stringify({ url: "http://localhost:1", repo: "demo", agent: "a", change: "I" + "0".repeat(40), task: { id: "T" } }));
    expect(loadConfig(root, {} as NodeJS.ProcessEnv, CONFIG_REL, true)?.token).toBe("secret");
  });
});

describe("the pin covers mode and ignores env overrides (issue #8c, review)", () => {
  it("a checkout whose config is advise is refused by an enforce pin", async () => {
    const { url } = await coordinator();
    const root = checkout("pin-mode");
    await run(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "advisor", "--task", "T-mode", "--mode", "advise"], {
      cwd: root,
      env: { ...process.env, WEFT_TOKEN: "local-test-token" },
    });
    const out = await hook([...pinned(url), "--mode", "enforce"], root, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "f.ts"), content: "export const x = 1;\n" } });
    expect(out?.hookSpecificOutput?.additionalContext).toContain("not coordinated");
    expect(logOf(root)).toMatch(/hook --by-path refused.*do not match the pinned coordinator/);
  });

  it("WEFT_URL does not redirect a pinned hook: the edit is still coordinated at the pinned url", async () => {
    const { url } = await coordinator();
    const root = await joined(url, "pin-env", "pinned-agent");
    const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "g.ts"), content: "export const y = 1;\n" }, cwd: root, session_id: "parent-s" };
    const child = run(process.execPath, [BUNDLE, "hook", ...pinned(url)], { cwd: root, encoding: "utf8", env: { ...process.env, WEFT_URL: "http://127.0.0.1:9" } });
    child.child.stdin!.end(JSON.stringify(input));
    await child;
    expect(logOf(root)).toMatch(/check g\.ts .* -> accept/);
    expect(logOf(root)).not.toMatch(/127\.0\.0\.1:9/);
  });
});

describe("review: quoted tilde, no fallback, .weft must be a real directory (#21)", () => {
  it("a quoted ~ is not a home target; a bare ~ is", () => {
    expect(bashTargetDir(`cd "~/wt" && sed -i s/a/b/ f`, "/repo")).toBeUndefined();
    expect(bashTargetDir(`cd '~/wt' && sed -i s/a/b/ f`, "/repo")).toBeUndefined();
    expect(bashTargetDir(`cd ~/wt && sed -i s/a/b/ f`, "/repo")).toBe(join(homedir(), "wt"));
  });

  it("a checkout whose config is broken or JSON null is not coordinated, and the parent cwd's config is not used instead", async () => {
    const { url } = await coordinator();
    const parent = await joined(url, "nf-parent", "parent-agent");
    for (const [name, text] of [["nf-broken", "{ not json"], ["nf-null", "null"]] as const) {
      const wt = checkout(name);
      mkdirSync(join(wt, ".weft"), { recursive: true });
      writeFileSync(join(wt, ".weft", "claude.json"), text);
      const out = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: `w-${name}`, tool_input: { file_path: join(wt, "src/x.ts"), content: "export const x = 1;\n" } });
      expect(out, name).toBeUndefined();
      expect(configStarts({ hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Write", tool_input: { file_path: join(wt, "src/x.ts") } } as HookInput, true)).toEqual([wt]);
    }
    expect(logOf(parent)).not.toMatch(/ hello | check /);
  }, 30_000);

  it("a double-quoted target with a backslash is refused (the shell would unescape it)", () => {
    expect(bashTargetDir(String.raw`cd "/wt/a\\b" && ls`, "/repo")).toBeUndefined();
    expect(bashTargetDir(String.raw`cd "/wt/a\"b" && ls`, "/repo")).toBeUndefined();
    expect(bashTargetDir(String.raw`git -C "/wt/a\$b" status`, "/repo")).toBeUndefined();
    // single quotes keep every character literal: \, $ and backquote are part of the path
    expect(bashTargetDir(String.raw`cd '/wt/a\b' && ls`, "/repo")).toBe(String.raw`/wt/a\b`);
    expect(bashTargetDir("cd '/wt/a$b`c' && ls", "/repo")).toBe("/wt/a$b`c");
    // a `..` segment is refused in every form
    for (const cmd of ["cd /wt/a/.. && ls", `cd "/wt/a/../b" && ls`, "git -C '/wt/..' status"]) expect(bashTargetDir(cmd, "/repo"), cmd).toBeUndefined();
    expect(bashTargetDir("cd /wt/a..b && ls", "/repo")).toBe("/wt/a..b");
  });

  it("a newline is a command separator, not a word separator; git -C must be followed directly by its subcommand", () => {
    for (const cmd of [
      "git -C /wt/worker\nprintf x > f",
      "git -C /wt/worker\n status",
      "cd /wt/worker\n&& ls",
      "\ncd /wt/worker && ls",
      `cd "/wt/a\nb" && ls`,
      `cd '/wt/a\nb' && ls`,
      "git -C /wt/a -C /parent/x add -A",
      "git -C /wt/a --work-tree=/parent/x checkout -- .",
      "git -C /wt/a --git-dir=/parent/.git status",
      "git -C /wt/a -c core.worktree=/parent status",
    ]) expect(bashTargetDir(cmd, "/repo"), JSON.stringify(cmd)).toBeUndefined();
    expect(bashTargetDir("git -C /wt/a commit -m x", "/repo")).toBe("/wt/a");
    expect(bashTargetDir("\tcd /wt/a\t&& ls", "/repo")).toBe("/wt/a");
  });

  it("an edit through a symlink below the worktree is denied: the write would land outside it (real bundle)", async () => {
    const { coord, url } = await coordinator();
    const parent = await joined(url, "sl-parent", "parent-agent");
    const wt = await joined(url, "sl-wt", "worker-sl");
    writeFileSync(join(parent, "total.ts"), "export const total = 1;\n");
    symlinkSync(join(parent, "total.ts"), join(wt, "src", "alias.ts"));
    symlinkSync(parent, join(wt, "linked"));
    for (const file of [join(wt, "src", "alias.ts"), join(wt, "linked", "total.ts")]) {
      const out = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "sl", tool_input: { file_path: file, content: "export const total = 2;\n" } });
      expect(out?.hookSpecificOutput?.permissionDecision, file).toBe("deny");
      expect(out?.hookSpecificOutput?.permissionDecisionReason, file).toContain("symlink");
    }
    // a Bash target through the link is denied too: it would load the parent's config as this worktree
    const bash = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "slb", tool_input: { command: `cd ${join(wt, "linked")} && sed -i s/1/2/ total.ts` } });
    expect(bash?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect((coord.events(0, 1000).events as Array<{ kind: string }>).filter((e) => e.kind === "edit")).toEqual([]);
    // `..` after a link is resolved by the kernel against the link target: refused before any lexical resolve
    mkdirSync(join(parent, "sub"));
    symlinkSync(join(parent, "sub"), join(wt, "up"));
    const dotdot = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "dd", tool_input: { file_path: `${wt}/up/../total.ts`, content: "export const total = 3;\n" } });
    expect(dotdot?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const ddBash = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "ddb", tool_input: { command: `cd ${wt}/up/.. && sed -i s/1/2/ total.ts` } });
    expect(ddBash?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect((coord.events(0, 1000).events as Array<{ kind: string }>).filter((e) => e.kind === "edit")).toEqual([]);
    // a link outside any checkout is not this check's business (macOS /tmp, /var): not denied
    const loose = mkdtempSync(join(tmpdir(), "weft-loose-"));
    symlinkSync(tmpdir(), join(loose, "l"));
    const outside = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(loose, "l", "x.txt"), content: "x" } });
    expect(outside?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // a plain file in the worktree is still coordinated
    const ok = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "ok", tool_input: { file_path: join(wt, "src", "fresh.ts"), content: "export const f = 1;\n" } });
    expect(ok?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(logOf(wt)).toContain("check src/fresh.ts");
  }, 30_000);

  it("a pinned hook that refuses a checkout tells the agent its edit is not coordinated", async () => {
    const { url } = await coordinator();
    const other = await joined("https://other.example.test", "fb-other", "worker-other");
    const out = await hook(pinned(url), other, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(other, "x.ts"), content: "export const x = 1;\n" } });
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput?.additionalContext).toContain("not coordinated");
  }, 30_000);

  it("a non-string tokenFile does not make loadConfig throw", async () => {
    const { loadConfig } = await import("../src/config");
    const root = checkout("token-nonstring");
    mkdirSync(join(root, ".weft"), { recursive: true });
    writeFileSync(join(root, ".weft", "claude.json"), JSON.stringify({ url: "http://localhost:1", repo: "demo", agent: "a", change: "I" + "0".repeat(40), task: { id: "T" }, tokenFile: 7 }));
    expect(() => loadConfig(root, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(loadConfig(root, {} as NodeJS.ProcessEnv, CONFIG_REL, true)).toBeUndefined();
  });

  it("a JSON null config is not a config", async () => {
    const { loadConfig } = await import("../src/config");
    const root = checkout("null-config");
    mkdirSync(join(root, ".weft"), { recursive: true });
    writeFileSync(join(root, ".weft", "claude.json"), "null");
    expect(loadConfig(root, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("a .weft that is a symlink to another directory is refused", async () => {
    const { loadConfig } = await import("../src/config");
    const root = checkout("weft-symlink");
    const elsewhere = checkout("weft-symlink-target");
    mkdirSync(join(elsewhere, "x"), { recursive: true });
    writeFileSync(join(elsewhere, "x", "token"), "secret\n");
    symlinkSync(elsewhere, join(root, ".weft"));
    writeFileSync(join(elsewhere, "claude.json"), JSON.stringify({ url: "http://localhost:1", repo: "demo", agent: "a", change: "I" + "0".repeat(40), task: { id: "T" }, tokenFile: "x/token" }));
    expect(loadConfig(root, {} as NodeJS.ProcessEnv, CONFIG_REL, true)).toBeUndefined();
  });
});

describe("review: subagent text and inherited token (#21)", () => {
  it("WEFT_TOKEN is ignored under --by-path: the checkout's own token is used, not the parent's", async () => {
    const { loadConfig, withoutPinnedOverrides } = await import("../src/config");
    const root = checkout("by-path-token");
    mkdirSync(join(root, ".weft"), { recursive: true });
    writeFileSync(join(root, ".weft", "claude.json"), JSON.stringify({ url: "http://localhost:1", repo: "demo", agent: "worker", change: "I" + "0".repeat(40), task: { id: "T" }, tokenFile: ".weft/token" }));
    writeFileSync(join(root, ".weft", "token"), "worker-token\n");
    const env = { WEFT_TOKEN: "parent-token" } as NodeJS.ProcessEnv;
    expect(withoutPinnedOverrides(env).WEFT_TOKEN).toBeUndefined();
    expect(loadConfig(root, withoutPinnedOverrides(env), CONFIG_REL, true)?.token).toBe("worker-token");
    // without --by-path, WEFT_TOKEN still overrides the token file (unchanged)
    expect(loadConfig(root, env)?.token).toBe("parent-token");
  });

  it("the default weft-worker text is pinned and does not depend on the repo's conflicts mode", async () => {
    const { workerAgent } = await import("../src/cli");
    const text = workerAgent("weft-claude hook --by-path");
    expect(text.slice(text.indexOf("\n---\n") + 5)).toBe(`
You work on one task inside one git worktree that is joined to Weft (it has \`.weft/claude.json\`).
The task message gives you its absolute path.

- Edit only files under that worktree, always by absolute path and never through a symlink.
  Weft checks each edit as that worktree's agent; edits elsewhere are not coordinated.
- Start every Bash command with \`cd <worktree> && …\` (or use \`git -C <worktree> …\`). Weft finds
  the worktree from that; a command without it is denied ("names no checkout Weft can
  coordinate"), so every command must start with it. Its git \`pre-commit\` hook refuses commits
  while Weft has open errors.
- If an edit is denied with \`[weft error]\`, do not retry it unchanged: the diagnostic says what
  to do next.
- \`<worktree>/.weft/bin/weft inbox\` shows what is waiting for you.
`);
  });
});

describe("review: no uncoordinated escape from a pinned worktree (#21)", () => {
  it("a Bash command whose leading target is in no joined checkout is denied (it could write a joined one later)", async () => {
    const { url } = await coordinator();
    const parent = await joined(url, "nc-parent", "parent-agent");
    const wt = await joined(url, "nc-wt", "worker-nc");
    const loose = mkdtempSync(join(tmpdir(), "weft-nc-"));
    for (const command of [`cd ${loose} && echo x > ${wt}/src/f.ts`, `git -C ${loose} status && echo x > ${wt}/src/f.ts`]) {
      const out = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "nc", tool_input: { command } });
      expect(out?.hookSpecificOutput?.permissionDecision, command).toBe("deny");
    }
    // the worktree itself is still accepted
    const ok = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "nc-ok", tool_input: { command: `cd ${wt} && ls` } });
    expect(ok?.hookSpecificOutput?.permissionDecision).toBeUndefined();
  }, 30_000);

  it("an edit to a pinned checkout's own .weft/ is denied (it would rewrite the identity the hook trusts)", async () => {
    const { url } = await coordinator();
    const parent = await joined(url, "wd-parent", "parent-agent");
    const wt = await joined(url, "wd-wt", "worker-wd");
    // .WEFT is the same directory on a case-insensitive filesystem (macOS, Windows defaults)
    for (const file of [join(wt, ".weft", "claude.json"), join(wt, ".weft", "token"), join(wt, ".WEFT", "token"), join(wt, ".Weft", "claude.json")]) {
      const out = await hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "wd", tool_input: { file_path: file, content: "{}" } });
      expect(out?.hookSpecificOutput?.permissionDecision, file).toBe("deny");
    }
  }, 30_000);

  it("a .weft/claude.json that is a symlink is not loaded under --by-path", async () => {
    const { loadConfig } = await import("../src/config");
    const { url } = await coordinator();
    const parent = await joined(url, "cl-parent", "parent-agent");
    const wt = checkout("cl-wt");
    mkdirSync(join(wt, ".weft"), { recursive: true });
    writeFileSync(join(wt, ".weft", "token"), "worker-token\n");
    symlinkSync(join(parent, ".weft", "claude.json"), join(wt, ".weft", "claude.json"));
    expect(loadConfig(wt, {} as NodeJS.ProcessEnv, CONFIG_REL, true)).toBeUndefined();
    expect(loadConfig(wt, {} as NodeJS.ProcessEnv)?.config.agent).toBe("parent-agent"); // plain hook: unchanged
  }, 30_000);
});
