// weft-job.mjs against real git + real Mergiraf on local bare repos (the git-backed Artifacts fake).
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { GitArtifacts } from "@weft/artifacts/git";
import { runJob, summarizeTests, stripFences, validateJob } from "../image/weft-job.mjs";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...ID }, encoding: "utf8" }).trim();
const hasMergiraf = (() => {
  try {
    execFileSync("mergiraf", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const BASE = {
  "src/pricing.ts": "export const PRICES = {\n  apple: 1,\n  pear: 2,\n};\n\nexport function calcTotal(items: string[]): number {\n  return items.reduce((s, i) => s + (PRICES as Record<string, number>)[i]!, 0);\n}\n",
  "src/cart.ts": "export const cart: string[] = [];\n",
  "test/pricing.test.ts": "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { calcTotal } from '../src/pricing.ts';\ntest('total', () => assert.ok(calcTotal(['apple']) > 0));\n",
};
const TESTS = { command: ["node", "--test"], timeout_s: 120 };

async function world() {
  const a = await GitArtifacts.create();
  await a.create("weft-demo");
  const seed = await mkdtemp(join(tmpdir(), "weft-seed-"));
  g(seed, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(BASE)) {
    await mkdir(dirname(join(seed, f)), { recursive: true });
    await writeFile(join(seed, f), c);
  }
  g(seed, "add", ".");
  g(seed, "commit", "-qm", "base");
  g(seed, "push", "-q", a.remote("weft-demo"), "HEAD:main");
  const trunk = a.remote("weft-demo");
  let n = 0;
  /** A clone of `remote` where `edit` makes one commit, pushed back. */
  async function commit(remote: string, files: Record<string, string>, msg: string) {
    const d = await mkdtemp(join(tmpdir(), "weft-wc-"));
    g(d, "clone", "-q", remote, ".");
    for (const [f, c] of Object.entries(files)) {
      await mkdir(dirname(join(d, f)), { recursive: true });
      await writeFile(join(d, f), c);
    }
    g(d, "add", ".");
    g(d, "commit", "-qm", msg);
    g(d, "push", "-q", "origin", "HEAD:main");
    return g(d, "rev-parse", "HEAD");
  }
  async function fork() {
    const name = `weft-demo-t1-${++n}`;
    await (await a.get("weft-demo")).fork(name, { defaultBranchOnly: true });
    return a.remote(name);
  }
  const tip = (remote: string, ref = "refs/heads/main") => execFileSync("git", ["ls-remote", remote, ref], { encoding: "utf8" }).split("\t")[0]!.trim();
  const show = async (remote: string, sha: string, file: string) => {
    const d = await mkdtemp(join(tmpdir(), "weft-show-"));
    g(d, "init", "-q");
    g(d, "fetch", "-q", remote, sha);
    return g(d, "show", `${sha}:${file}`);
  };
  return { a, trunk, commit, fork, tip, show };
}

const sub = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`no ${from}`);
  return s.replace(from, to);
};

describe("weft-job rebase (layered merge)", () => {
  it("validates specs", () => {
    expect(validateJob({ job: "nope" })).toContain("job must be rebase|land|revert|land_batch");
    expect(validateJob({ job: "rebase", trunk: { remote: "x" } })).toContain("fork.remote required");
    expect(validateJob({ job: "land_batch", trunk: { remote: "x" } })).toContain("changes required (non-empty array)");
    expect(validateJob({ job: "land_batch", trunk: { remote: "x" }, changes: [{ change: "c" }] })).toContain("every change needs change + remote");
    expect(validateJob({ job: "land_batch", trunk: { remote: "x" }, changes: [{ change: "c", remote: "y" }] })).toEqual([]);
  });

  it("up_to_date when the change already contains trunk; tests run on the head", async () => {
    const w = await world();
    const f = await w.fork();
    const head = await w.commit(f, { "src/cart.ts": "export const cart: string[] = ['apple'];\n" }, "cart: seed apple");
    const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, tests: TESTS }, { log: () => {} });
    expect(r.status).toBe("up_to_date");
    expect(r.rebased).toBe(head);
    expect(r.tests.status).toBe("pass");
    expect(r.tests.summary.pass).toBe(1);
  });

  it("git layer: different files replay cleanly onto the new trunk", async () => {
    const w = await world();
    const f = await w.fork();
    const head = await w.commit(f, { "src/cart.ts": "export const cart: string[] = ['pear'];\n" }, "cart: pear");
    const onto = await w.commit(w.trunk, { "README.md": "# shop\n" }, "readme");
    const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, tests: TESTS, push_rebased: true }, { log: () => {} });
    expect(r.status).toBe("clean");
    expect(r.layer).toBe("git");
    expect(r.onto).toBe(onto);
    expect(r.commits).toHaveLength(1);
    expect(r.diffstat).toEqual({ files: 1, insertions: 1, deletions: 1 });
    expect(r.pushed).toEqual({ ref: "refs/heads/weft/rebased", sha: r.rebased });
    expect(w.tip(f, "refs/heads/weft/rebased")).toBe(r.rebased);
    expect(w.tip(f)).toBe(head); // the agent's branch is never rewritten
  });

  it.skipIf(!hasMergiraf)("mergiraf layer: adjacent edits git cannot merge are merged structurally", async () => {
    const w = await world();
    const f = await w.fork();
    const p = BASE["src/pricing.ts"];
    const head = await w.commit(f, { "src/pricing.ts": sub(p, "pear: 2", "pear: 3") }, "pricing: pear 3");
    await w.commit(w.trunk, { "src/pricing.ts": sub(p, "apple: 1", "apple: 5") }, "pricing: apple 5");
    const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, tests: TESTS }, { log: () => {} });
    expect(r.status).toBe("clean");
    expect(r.layer).toBe("mergiraf");
    expect(await w.show(f, head, "src/pricing.ts")).toContain("pear: 3");
    const rebasedPricing = execFileSync("git", ["show", `${r.rebased}:src/pricing.ts`], { cwd: r.workdir, encoding: "utf8" });
    expect(rebasedPricing).toContain("apple: 5");
    expect(rebasedPricing).toContain("pear: 3");
    expect(r.tests.status).toBe("pass");
  });

  it("resolver layer: a command resolver fixes a true conflict; without one the conflict bounces with hunks", async () => {
    const w = await world();
    const f = await w.fork();
    const p = BASE["src/pricing.ts"];
    const head = await w.commit(f, { "src/pricing.ts": sub(p, "apple: 1", "apple: 2") }, "pricing: apple 2");
    await w.commit(w.trunk, { "src/pricing.ts": sub(p, "apple: 1", "apple: 3") }, "pricing: apple 3");

    const bounced = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head } }, { log: () => {} });
    expect(bounced.status).toBe("conflict");
    expect(bounced.conflicts[0].file).toBe("src/pricing.ts");
    expect(bounced.conflicts[0].hunks[0].text).toContain("<<<<<<<");

    const dir = await mkdtemp(join(tmpdir(), "weft-resolver-"));
    const script = join(dir, "resolve.sh");
    // "Agent": settle on a new price for every conflicted file.
    await writeFile(script, `#!/bin/sh\nfor f in $WEFT_CONFLICT_FILES; do node -e "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/<<<<<<<[^]*?>>>>>>>[^\\n]*\\n/,'  apple: 4,\\n'))" "$f"; done\n`);
    await chmod(script, 0o755);
    const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, resolver: { kind: "command", argv: [script] }, tests: TESTS }, { log: () => {} });
    expect(r.status, JSON.stringify(r.resolver ?? r.commits)).toBe("resolved");
    expect(r.layer).toBe("resolver");
    expect(r.commits[0].resolver.files).toEqual(["src/pricing.ts"]);
    expect(execFileSync("git", ["show", `${r.rebased}:src/pricing.ts`], { cwd: r.workdir, encoding: "utf8" })).toContain("apple: 4,\n  pear: 2");
    // Trailers / authorship of the change survive the replay.
    expect(execFileSync("git", ["log", "-1", "--format=%s", r.rebased], { cwd: r.workdir, encoding: "utf8" }).trim()).toBe("pricing: apple 2");
  });

  it("llm resolver: posts the conflicted file to an OpenAI-compatible endpoint and applies the answer", async () => {
    const { createServer } = await import("node:http");
    const seen: Array<{ model: string; user: string }> = [];
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const body = JSON.parse(b);
        seen.push({ model: body.model, user: body.messages[1].content });
        const u: string = body.messages[1].content;
        const file = u.slice(u.indexOf("\n\n", u.indexOf("File: ")) + 2);
        if (body.model === "@cf/test/one-sided") {
          // answer = the change's side only (drops trunk's apple: 3)
          const theirs = file.replace(/<<<<<<<[^]*?=======\n([^]*?)>>>>>>>[^\n]*\n/, "$1");
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ response: theirs }));
        }
        const resolved = (body.model === "@cf/test/truncating" ? file.slice(0, 20) : file).replace(/<<<<<<<[^]*?>>>>>>>[^\n]*\n/, "  apple: 3 * 2,\n");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ response: "```ts\n" + resolved.trimEnd() + "\n```", usage: { total_tokens: 42 } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1/chat/completions`;
    try {
      const w = await world();
      const f = await w.fork();
      const head = await w.commit(f, { "src/pricing.ts": sub(BASE["src/pricing.ts"], "apple: 1", "apple: 1 * 2") }, "apple doubled");
      await w.commit(w.trunk, { "src/pricing.ts": sub(BASE["src/pricing.ts"], "apple: 1", "apple: 3") }, "apple 3");
      const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, resolver: { kind: "llm", url, model: "@cf/test/model" }, tests: TESTS }, { log: () => {} });
      expect(r.status).toBe("resolved");
      expect(r.commits[0].resolver).toMatchObject({ kind: "llm", model: "@cf/test/model", files: ["src/pricing.ts"] });
      expect(seen[0]!.user).toContain("Change being replayed:\napple doubled");
      expect(execFileSync("git", ["show", `${r.rebased}:src/pricing.ts`], { cwd: r.workdir, encoding: "utf8" })).toContain("apple: 3 * 2,\n  pear: 2");
      expect(r.tests.status).toBe("pass");
      // A truncated answer is rejected (fails closed -> bounce), never committed.
      const bad = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, resolver: { kind: "llm", url, model: "@cf/test/truncating" } }, { log: () => {} });
      expect(bad.status).toBe("conflict");
      expect(bad.resolver.error).toMatch(/suspiciously short/);
      const one = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, resolver: { kind: "llm", url, model: "@cf/test/one-sided" } }, { log: () => {} });
      expect(one.status).toBe("conflict");
      expect(one.resolver.error).toMatch(/drops trunk's edit/);
      // the prompt explains each hunk (base -> trunk, base -> change)
      expect(seen[0]!.user).toContain("- trunk changed it to:\n  apple: 3,");
      expect(seen[0]!.user).toContain("- the change changed it to:\n  apple: 1 * 2,");
    } finally {
      srv.close();
    }
  });

  it("a resolver that leaves markers fails closed (bounce)", async () => {
    const w = await world();
    const f = await w.fork();
    const p = BASE["src/pricing.ts"];
    const head = await w.commit(f, { "src/pricing.ts": sub(p, "apple: 1", "apple: 2") }, "a2");
    await w.commit(w.trunk, { "src/pricing.ts": sub(p, "apple: 1", "apple: 3") }, "a3");
    const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, resolver: { kind: "command", argv: ["true"] } }, { log: () => {} });
    expect(r.status).toBe("conflict");
    expect(r.layer).toBe("resolver");
    expect(r.resolver.error).toMatch(/still has conflict markers/);
  });
});

describe("weft-job land + revert", () => {
  it("land: rebase + presubmit + CAS push; then revert the landed range on a moved trunk", async () => {
    const w = await world();
    const f = await w.fork();
    await w.commit(f, { "src/cart.ts": "export const cart: string[] = ['pear'];\n" }, "cart: pear");
    const head = await w.commit(f, { "src/extra.ts": "export const extra = 1;\n" }, "extra");
    const before = await w.commit(w.trunk, { "README.md": "# shop\n" }, "readme");
    const r = await runJob({ job: "land", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, tests: TESTS }, { log: () => {} });
    expect(r.status).toBe("landed");
    expect(r.before).toBe(before);
    expect(w.tip(w.trunk)).toBe(r.after);
    expect(r.commits).toHaveLength(2);

    // trunk moves on, then the landing is reverted
    await w.commit(w.trunk, { "docs.md": "later\n" }, "later work");
    const rv = await runJob({ job: "revert", trunk: { remote: w.trunk }, revert: { before: r.before, after: r.after, op_id: "op-1", change: "Iabc", reason: "error spike" } }, { log: () => {} });
    expect(rv.status).toBe("reverted");
    expect(w.tip(w.trunk)).toBe(rv.after);
    expect(await w.show(w.trunk, rv.after, "src/cart.ts")).toBe(BASE["src/cart.ts"].trim());
    expect(await w.show(w.trunk, rv.after, "docs.md")).toBe("later");
    const msg = execFileSync("git", ["log", "-1", "--format=%B", rv.after], { cwd: rv.workdir, encoding: "utf8" });
    expect(msg).toContain("Revert change Iabc");
    expect(msg).toContain("Weft-Reverts-Op: op-1");
    expect(() => execFileSync("git", ["cat-file", "-e", `${rv.after}:src/extra.ts`], { cwd: rv.workdir, stdio: "ignore" })).toThrow();
    // re-running the same revert op (e.g. after a failure to log it) finds the existing revert commit
    const again = await runJob({ job: "revert", trunk: { remote: w.trunk }, revert: { before: r.before, after: r.after, op_id: "op-1", reason: "retry" } }, { log: () => {} });
    expect(again).toMatchObject({ status: "reverted", already: true, sha: rv.after });
    expect(w.tip(w.trunk)).toBe(rv.after);
  });

  it("land: failing presubmit never touches trunk", async () => {
    const w = await world();
    const f = await w.fork();
    const head = await w.commit(f, { "src/pricing.ts": BASE["src/pricing.ts"].replace("s + (", "s - (") }, "pricing: broken");
    const t0 = w.tip(w.trunk);
    const r = await runJob({ job: "land", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, tests: TESTS }, { log: () => {} });
    expect(r.status).toBe("tests_failed");
    expect(r.tests.status).toBe("fail");
    expect(r.tests.summary.fail).toBe(1);
    expect(w.tip(w.trunk)).toBe(t0);
  });

  it("land: losing the CAS race (trunk moved during presubmit) is stale_trunk, trunk keeps the winner", async () => {
    const w = await world();
    const f = await w.fork();
    const head = await w.commit(f, { "src/cart.ts": "export const cart: string[] = ['x'];\n" }, "cart x");
    // The presubmit itself lands a competing commit on trunk (a concurrent landing).
    const racer = await mkdtemp(join(tmpdir(), "weft-racer-"));
    g(racer, "clone", "-q", w.trunk, ".");
    await writeFile(join(racer, "race.txt"), "won\n");
    g(racer, "add", ".");
    g(racer, "commit", "-qm", "racer");
    const winner = g(racer, "rev-parse", "HEAD");
    const r = await runJob({ job: "land", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, tests: { command: ["git", "-C", racer, "push", "-q", "origin", "HEAD:main"] } }, { log: () => {} });
    expect(r.status).toBe("stale_trunk");
    expect(r.current).toBe(winner);
    expect(w.tip(w.trunk)).toBe(winner);
  });

  it("land reuses a resolver's rebase when it sits exactly on today's trunk", async () => {
    const w = await world();
    const f = await w.fork();
    const head = await w.commit(f, { "src/cart.ts": "export const cart: string[] = ['y'];\n" }, "cart y");
    await w.commit(w.trunk, { "README.md": "r\n" }, "readme");
    const rb = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, push_rebased: true }, { log: () => {} });
    const r = await runJob({ job: "land", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, rebased: { sha: rb.rebased, onto: rb.onto, layer: "resolver" } }, { log: () => {} });
    expect(r.status).toBe("landed");
    expect(r.reused).toBe(true);
    expect(r.after).toBe(rb.rebased);
  });

  it("land with a stale or missing rebased hint just rebases again", async () => {
    const w = await world();
    const f = await w.fork();
    const head = await w.commit(f, { "src/cart.ts": "export const cart: string[] = ['z'];\n" }, "cart z");
    const r = await runJob({ job: "land", trunk: { remote: w.trunk }, fork: { remote: f, sha: head }, rebased: { sha: head, onto: "0".repeat(40), layer: "none" } }, { log: () => {} });
    expect(r.status).toBe("landed");
    expect(r.reused).toBeUndefined();
    expect(r.after).toBe(head);
  });
});

describe("weft-job helpers", () => {
  it("summarizes node:test and vitest output; strips fences", () => {
    expect(summarizeTests("ℹ tests 3\nℹ pass 2\nℹ fail 1\n")).toEqual({ pass: 2, fail: 1 });
    expect(summarizeTests(" Tests  4 passed (4)\n")).toEqual({ pass: 4 });
    expect(stripFences("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(stripFences("plain\n")).toBe("plain\n");
  });

  it("never leaks WEFT_GIT_AUTH tokens into results", async () => {
    const w = await world();
    const secret = "art_v1_" + "ab".repeat(20);
    const r = await runJob({ job: "rebase", trunk: { remote: w.trunk }, fork: { remote: "file:///nonexistent/fork.git" } }, { env: { ...process.env, WEFT_GIT_AUTH: JSON.stringify({ "https://example.invalid/": secret }) }, log: () => {} });
    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(await readFile(join(r.workdir, ".git", "config"), "utf8")).not.toContain(secret);
  });
});
