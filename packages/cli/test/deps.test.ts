// `weft deps [--pr]` (spec §6.7, issue #6): what a change relies on, read from the coordinator's
// record over HTTP; --pr prints the pull request lines. No GitHub access. Runs against a real
// ReferenceCoordinator behind the adapters' stand-in WCP server.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ReferenceCoordinator, type Hello } from "@weft/protocol";
import { serve } from "../../adapters/claude-code/test/helpers";
import { main, parseArgs } from "../src/main";

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (agent: string, task: string): Hello => ({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "codex" }, capabilities: caps, task: { id: task } });
const NEW = "src/auth/session.ts#createSession";

describe("weft deps", () => {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  let server: Server;
  let url = "";
  const base = mkdtempSync(join(tmpdir(), "weft-deps-"));
  const repo = join(base, "shop");
  const logs: string[] = [];
  const run = async (...args: string[]) => {
    logs.length = 0;
    expect(await main(["deps", "--dir", repo, ...args])).toBe(0);
    return logs.join("\n");
  };

  beforeAll(async () => {
    ({ url, server } = await serve(coord));
    process.env.WEFT_HOME = join(base, "config");
    delete process.env.WEFT_TOKEN;
    // claude-a adds createSession (#3); codex-b's edit calls it (#4): its record depends on claude-a/T-1.
    const a = coord.hello(hello("claude-a", "T-1"));
    const b = coord.hello(hello("codex-b", "T-2"));
    coord.submit(a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, writes: [{ key: NEW, kind: "new" }] } });
    coord.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: "src/routes/signup.ts#signup", kind: "body" }], reads: [NEW] } });
    // codex-b's checkout: its adapter config names the gateway, repo and change; its token in .weft/token.
    mkdirSync(join(repo, ".weft"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, ".weft", "codex.json"), JSON.stringify({ url: `${url}/v1`, repo: "demo", agent: "codex-b", change: "codex-b/T-2", task: { id: "T-2" } }));
    writeFileSync(join(repo, ".weft", "token"), "weft_agent_test\n");
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterAll(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("parses deps, --pr, --change and --json", () => {
    expect(parseArgs(["deps", "--pr", "--change", "I4f2a", "--json"])).toMatchObject({ cmd: "deps", o: { pr: true, change: "I4f2a", json: true } });
    expect(parseArgs(["deps"]).o).toMatchObject({ pr: false, json: false });
  });

  it("--pr prints the pull request line for the unlanded dependency, from the record only", async () => {
    expect(await run("--pr")).toBe("Relies on claude-a/T-1 (claude-a, task T-1), not yet in main: src/auth/session.ts#createSession");
  });

  it("without --pr, lists each dependency and the hold on the landing", async () => {
    expect(await run()).toBe(
      [
        "codex-b/T-2 (codex-b, task T-2): landing held until claude-a/T-1 lands",
        "  claude-a/T-1 (claude-a, task T-1) — not landed; holds the landing: src/auth/session.ts#createSession (recorded at #3)",
      ].join("\n"),
    );
    expect(JSON.parse(await run("--json"))).toMatchObject({ type: "dependencies", change: "codex-b/T-2", held: true, held_by: ["claude-a/T-1"] });
    expect(await run("--change", "claude-a/T-1")).toBe("claude-a/T-1 (claude-a, task T-1): landing not held\n  no recorded dependencies on other changes.");
  });

  it("once the dependency lands, --pr says nothing is outstanding", async () => {
    coord.system({ kind: "land", base_seq: coord.events(0, 1, { tail: true }).head_seq, change: "claude-a/T-1", payload: { sha: "a".repeat(40), op_id: "op-a" } });
    expect(await run("--pr")).toBe("No recorded dependencies on changes that are not in main yet.");
    expect(await run()).toContain("claude-a/T-1 (claude-a, task T-1) — landed (#");
  });

  it("an unknown change is the gateway's not_found, and with no change to name it says what to pass", async () => {
    await expect(main(["deps", "--dir", repo, "--change", "nobody/T-9"])).rejects.toThrow(/unknown change nobody\/T-9/);
    const bare = join(base, "bare");
    execFileSync("git", ["init", "-q", "-b", "main", bare]);
    await expect(main(["deps", "--dir", bare])).rejects.toThrow(/no change to report/);
  });

  it("a repo-shipped .weft/ cannot make it send another credential: a symlinked token is not read", async () => {
    const shipped = join(base, "shipped");
    mkdirSync(join(shipped, ".weft"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", shipped]);
    const secret = join(base, "my-real-token");
    writeFileSync(secret, "weft_secret_elsewhere\n");
    writeFileSync(join(shipped, ".weft", "codex.json"), JSON.stringify({ url, repo: "demo", agent: "x", change: "codex-b/T-2" }));
    symlinkSync(secret, join(shipped, ".weft", "token"));
    process.env.WEFT_TOKEN = "weft_env_token";
    try {
      // No usable token for that URL, and no space or Hermes feed here: nothing is sent.
      await expect(main(["deps", "--dir", shipped])).rejects.toThrow(/not set up/);
    } finally {
      delete process.env.WEFT_TOKEN;
    }
  });
});
