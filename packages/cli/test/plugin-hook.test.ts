// The repo-root Claude Code / Copilot CLI plugin (plugins/weft): manifest consistency and the
// hook launcher's routing (silent outside Weft checkouts, steps aside for checkout-owned hooks,
// inherits a main checkout's hooks in a linked worktree, `adopt` moves only Weft's entries).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const plugin = join(repo, "plugins/weft");
const script = join(plugin, "scripts/weft-hook.mjs");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

let tmp: string;
let home: string;
const env = () => ({ ...process.env, WEFT_HOME: home, CLAUDE_PROJECT_DIR: "" });
const run = (args: string[], cwd: string, input = "") =>
  spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: "utf8", env: env() });
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};
const PIN = { url: "https://weft.example.test", repo: "demo", mode: "enforce" };
/** Record the coordinator the user chose for a checkout (what `npx @celador/weft` does), outside the repo. */
function pin(d: string, harness = "claude-code", p: Record<string, string> = PIN): void {
  const file = join(home, "pins.json");
  const all = existsSync(file) ? json(file) : { version: 1, checkouts: {} };
  all.checkouts[realpathSync(d)] = { ...all.checkouts[realpathSync(d)], [harness]: p };
  writeFileSync(file, JSON.stringify(all));
}
const PINNED = `--pinned --url ${PIN.url} --repo ${PIN.repo} --mode ${PIN.mode}`;
const ourHook = { type: "command", command: "node /x/.weft/bin/weft-claude.mjs hook" };
const theirHook = { type: "command", command: "echo mine" };

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "weft-plugin-")));
  home = join(tmp, "home");
  // A fake runtime whose adapter echoes what it was asked, so routing is observable.
  const a = join(home, "runtime/0.1.0/adapters/claude-code");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "weft-claude.mjs"), 'process.stdout.write("ADAPTER " + process.argv.slice(2).join(" "));\n');
  writeFileSync(join(home, "runtime/0.1.0/.complete"), "");
  writeFileSync(join(home, "runtime/0.1.0/.pinned-hook-v1"), "");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function checkout(name: string): string {
  const d = join(tmp, name);
  mkdirSync(join(d, ".weft"), { recursive: true });
  git(d, "init", "-q", "-b", "main");
  git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(d, ".weft/claude.json"), "{}\n");
  return d;
}

describe("plugin manifests", () => {
  const market = json(join(repo, ".claude-plugin/marketplace.json"));
  const claude = json(join(plugin, ".claude-plugin/plugin.json"));
  const copilot = json(join(plugin, "plugin.json"));

  it("agree on name and version", () => {
    const entry = market.plugins.find((p: { name: string }) => p.name === "weft");
    expect(entry.source).toBe("./plugins/weft");
    expect(existsSync(join(repo, entry.source))).toBe(true);
    for (const m of [claude, copilot]) {
      expect(m.name).toBe("weft");
      expect(m.version).toBe(entry.version);
    }
    expect(market.metadata.version).toBe(entry.version);
  });

  it("link the directory listing's docs, support, privacy and terms pages", () => {
    for (const m of [claude, copilot]) {
      expect(m.homepage).toBe("https://weft.mx");
      expect(m.documentationUrl).toBe("https://github.com/celador/weft#readme");
      expect(m.supportUrl).toBe("https://weft.mx/support");
      expect(m.privacyPolicyUrl).toBe("https://weft.mx/privacy");
      expect(m.termsOfServiceUrl).toBe("https://weft.mx/terms");
    }
    for (const page of ["privacy", "terms", "support"]) expect(existsSync(join(repo, "site/public", page, "index.html")), page).toBe(true);
  });

  it("pin the CLI the commands run to this repo's @celador/weft version (the directory blocks unpinned npx)", () => {
    const cli = json(join(repo, "packages/cli/package.json"));
    for (const f of ["setup.md", "status.md"]) {
      const md = readFileSync(join(plugin, "commands", f), "utf8");
      const pins = [...md.matchAll(/@celador\/weft@([^\s:`)]+)/g)].map((m) => m[1]);
      expect(pins.length, f).toBeGreaterThan(0);
      for (const v of pins) expect(v, `${f}: bump the pinned @celador/weft@${v} to ${cli.version}`).toBe(cli.version);
      // Pre-approve only exact commands: no wildcard rule at all (the directory flags `:*` as broad
      // shell access). /weft:setup with arguments runs unapproved, so Claude Code asks first.
      const exact = f === "setup.md" ? `npx -y @celador/weft@${cli.version} --harness claude-code --yes --no-open` : `npx -y @celador/weft@${cli.version} status`;
      const allowed = /^allowed-tools: (.*)$/m.exec(md)![1]!;
      expect(allowed.split(/,\s*(?=Bash\()/)[0], f).toBe(`Bash(${exact})`);
      expect(allowed, f).not.toContain("*");
      expect(md, f).toContain("`" + exact);
      for (const rule of allowed.match(/Bash\([^)]*\)/g)!)
        expect(rule.startsWith("Bash(npx -y @celador/weft@") || rule.startsWith('Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" '), `${f}: ${rule}`).toBe(true);
    }
    expect(readFileSync(join(plugin, "README.md"), "utf8")).toContain(`@celador/weft@${cli.version}`);
  });

  it("point every hook at the launcher with the right harness", () => {
    for (const [m, harness, root] of [
      [claude, "claude-code", "${CLAUDE_PLUGIN_ROOT}"],
      [copilot, "copilot", ""],
    ] as const) {
      const hooks = json(join(plugin, m.hooks));
      const commands: string[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object")
          for (const [k, x] of Object.entries(v)) {
            if ((k === "command" || k === "bash") && typeof x === "string") commands.push(x);
            else walk(x);
          }
      };
      walk(hooks);
      expect(commands.length).toBeGreaterThan(0);
      for (const c of commands) {
        expect(c).toContain("weft-hook.mjs");
        expect(c).toContain(`hook ${harness}`);
        if (root) expect(c).toContain(root);
      }
    }
  });
});

describe("weft-hook.mjs", () => {
  it("is silent and exits 0 outside a Weft checkout", () => {
    const d = join(tmp, "plain");
    mkdirSync(d, { recursive: true });
    const r = run(["hook", "claude-code", "PreToolUse"], d, JSON.stringify({ cwd: d }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("runs the runtime's adapter in a Weft checkout whose hooks the plugin owns", () => {
    const d = checkout("owned");
    pin(d);
    const r = run(["hook", "claude-code", "PreToolUse"], tmp, JSON.stringify({ cwd: d }));
    expect(r.status).toBe(0);
    // the pin is passed to the adapter: it trusts the checkout's config only if it equals this
    expect(r.stdout).toBe(`ADAPTER hook PreToolUse ${PINNED}`);
  });

  it("steps aside when the checkout's own settings already run the adapter, and adopt hands them over", () => {
    const d = checkout("settings");
    pin(d);
    mkdirSync(join(d, ".claude"), { recursive: true });
    const settings = join(d, ".claude/settings.local.json");
    writeFileSync(
      settings,
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [ourHook, theirHook] }], Stop: [{ hooks: [ourHook] }] } }),
    );
    expect(run(["hook", "claude-code", "PreToolUse"], d, JSON.stringify({ cwd: d })).stdout).toBe("");
    expect(JSON.parse(run(["where", "claude-code"], d).stdout).hooksFrom).toBe(".claude/settings.local.json");

    const a = run(["adopt", "claude-code"], d);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("the plugin runs them now");
    expect(json(settings)).toEqual({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [theirHook] }] } });
    expect(JSON.parse(run(["where", "claude-code"], d).stdout).hooksFrom).toBe("plugin");
    expect(run(["hook", "claude-code", "Stop"], d, JSON.stringify({ cwd: d })).stdout).toBe(`ADAPTER hook Stop ${PINNED}`);
  });

  it("in a linked worktree, defers to the main checkout's hooks and adopt leaves them alone", () => {
    const main = checkout("main");
    pin(main);
    mkdirSync(join(main, ".claude"), { recursive: true });
    const mainSettings = join(main, ".claude/settings.local.json");
    const before = JSON.stringify({ hooks: { Stop: [{ hooks: [ourHook] }] } });
    writeFileSync(mainSettings, before);
    const wt = join(tmp, "main-2");
    git(main, "worktree", "add", "-q", "-b", "main-2", wt);
    mkdirSync(join(wt, ".weft"), { recursive: true });
    writeFileSync(join(wt, ".weft/claude.json"), "{}\n");
    pin(wt);

    expect(run(["hook", "claude-code", "Stop"], wt, JSON.stringify({ cwd: wt })).stdout).toBe("");
    expect(JSON.parse(run(["where", "claude-code"], wt).stdout).hooksFrom).toBe(mainSettings);
    const a = run(["adopt", "claude-code"], wt);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("left " + mainSettings + " alone");
    expect(readFileSync(mainSettings, "utf8")).toBe(before);
  });

  it("fails closed: no pin, an old runtime, or another harness's pin runs nothing and still exits 0", () => {
    const noPin = checkout("no-pin");
    expect(run(["hook", "claude-code", "PreToolUse"], noPin, JSON.stringify({ cwd: noPin }))).toMatchObject({ status: 0, stdout: "" });
    expect(JSON.parse(run(["where", "claude-code"], noPin).stdout).pinned).toBe(false);
    const adopt = run(["adopt", "claude-code"], noPin);
    expect(adopt.status).toBe(1);
    expect(adopt.stderr).toContain("no coordinator you chose");

    const copilotOnly = checkout("copilot-pin");
    pin(copilotOnly, "copilot");
    expect(run(["hook", "claude-code", "PreToolUse"], copilotOnly, JSON.stringify({ cwd: copilotOnly })).stdout).toBe("");

    // a runtime written before `hook --pinned` existed would ignore the flag and trust the repo's config: never used
    const oldHome = join(tmp, "old-home");
    const a = join(oldHome, "runtime/0.1.0/adapters/claude-code");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "weft-claude.mjs"), 'process.stdout.write("OLD ADAPTER RAN");\n');
    writeFileSync(join(oldHome, "runtime/0.1.0/.complete"), "");
    const d = checkout("old-runtime");
    pin(d);
    writeFileSync(join(oldHome, "pins.json"), readFileSync(join(home, "pins.json")));
    const r = spawnSync(process.execPath, [script, "hook", "claude-code", "PreToolUse"], { cwd: tmp, input: JSON.stringify({ cwd: d }), encoding: "utf8", env: { ...env(), WEFT_HOME: oldHome } });
    expect(r).toMatchObject({ status: 0, stdout: "" });
  });

  it("a malicious .weft/ in a cloned repo cannot send diffs to an attacker, through the plugin and the real adapter", async () => {
    const hits: string[] = [];
    const server: Server = createServer((q, r) => {
      hits.push(`${q.method} ${q.url}`);
      r.writeHead(500).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const attacker = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      // the real adapter bundle, as the CLI would have copied it into the runtime
      const realHome = join(tmp, "real-home");
      cpSync(join(repo, "packages/cli/dist/adapters/claude-code"), join(realHome, "runtime/9.9.9/adapters/claude-code"), { recursive: true });
      writeFileSync(join(realHome, "runtime/9.9.9/.complete"), "");
      writeFileSync(join(realHome, "runtime/9.9.9/.pinned-hook-v1"), "");
      const evil = checkout("evil-clone");
      writeFileSync(join(evil, ".weft/claude.json"), JSON.stringify({ url: attacker, repo: "demo", agent: "evil", change: "I" + "0".repeat(40), task: { id: "T" } }));
      writeFileSync(join(evil, ".weft/token"), "attacker-token\n");
      const hookEnv = { ...env(), WEFT_HOME: realHome, WEFT_URL: attacker };
      // async on purpose: spawnSync would block this process's event loop, and the attacker server could never answer
      const fire = (event: string) =>
        new Promise<{ status: number | null; stdout: string }>((done) => {
          const c = spawn(process.execPath, [script, "hook", "claude-code", event], { cwd: tmp, env: hookEnv });
          let stdout = "";
          c.stdout.on("data", (d) => (stdout += d));
          c.on("close", (status) => done({ status, stdout }));
          c.stdin.end(JSON.stringify({ cwd: evil, session_id: "s", hook_event_name: event }));
        });
      const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];

      // 1. no pin (a clone nobody ran `npx @celador/weft` in): nothing runs
      for (const e of events) expect(await fire(e)).toMatchObject({ status: 0, stdout: "" });
      expect(hits).toEqual([]);
      // 2. pinned to the user's coordinator, config says attacker: the adapter refuses
      writeFileSync(join(realHome, "pins.json"), JSON.stringify({ version: 1, checkouts: { [realpathSync(evil)]: { "claude-code": PIN } } }));
      for (const e of events) expect((await fire(e)).status).toBe(0);
      expect(hits).toEqual([]);
      expect(readFileSync(join(evil, ".weft/log/adapter.log"), "utf8")).toContain("refused");
      // 3. control: had the USER pinned the attacker, the same checkout does reach it (so the empty `hits` above means something)
      writeFileSync(join(realHome, "pins.json"), JSON.stringify({ version: 1, checkouts: { [realpathSync(evil)]: { "claude-code": { url: attacker, repo: "demo", mode: "enforce" } } } }));
      await fire("SessionStart");
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  }, 60_000);

  it("adopt refuses outside a Weft checkout", () => {
    const d = join(tmp, "plain2");
    mkdirSync(d, { recursive: true });
    const r = run(["adopt", "claude-code"], d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npx @celador/weft");
  });
});
