// Affected-test selection in ProcessRevision (checkpoint feedback) vs the always-full land
// presubmit, end to end: real git, weft-job.mjs, the analyzer's selector, D1 evidence.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeStep, sub, world } from "./harness";
import type { RepoConfig } from "../src/core/types";

const here = dirname(fileURLToPath(import.meta.url));
// In the image the selector is a bundle next to weft-job.mjs; here it is the TypeScript source.
process.env.WEFT_TESTSELECT = join(here, "../../../packages/analyzer/src/testselect.ts");

const SELECT: RepoConfig = { tests: { command: ["node", "--test"], timeout_s: 120, select: true } };
const USERS = "export function displayName(first: string, last: string): string {\n  return `${first} ${last}`;\n}\n";
const USERS_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { displayName } from '../src/users.ts';\ntest('name', () => assert.strictEqual(displayName('a', 'b').length, 3));\n";
const CART_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { cart } from '../src/cart.ts';\ntest('cart', () => assert.ok(Array.isArray(cart)));\n";

async function shop(config: RepoConfig = SELECT) {
  const w = await world({ config });
  await w.trunkCommit({ "src/users.ts": USERS, "test/users.test.ts": USERS_TEST, "test/cart.test.ts": CART_TEST, "package.json": '{"name":"shop","type":"module"}\n' }, "users + cart tests");
  return w;
}
type Ev = { kind: string; status: string; data: string };
const evidence = (w: Awaited<ReturnType<typeof world>>, change: string, kind: string) =>
  w.q<Ev>(`SELECT kind, status, data FROM evidence WHERE change_id = ? AND kind = ? ORDER BY id`, change, kind).map((e) => ({ ...e, d: JSON.parse(e.data) as Record<string, any> }));

describe("affected-test selection", () => {
  it("a checkpoint runs only the tests that reach the written symbols; the land presubmit runs the full suite", async () => {
    const w = await shop();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/users.ts": sub(USERS, "${first} ${last}", "${last} ${first}") }, "users: last name first");
    const r = await w.wf.process(a, sha);
    expect(r).toMatchObject({ status: "processed", tests: "pass" });

    const [sel] = evidence(w, a.change, "test_selection");
    expect(sel!.d).toMatchObject({ stage: "checkpoint", mode: "subset", reason: null, selected: 1, total: 3, files: ["test/users.test.ts"], writes: [{ key: "src/users.ts#displayName", kind: "body" }] });
    expect(sel!.d.why).toEqual({ "test/users.test.ts": "reaches ../src/users.ts#displayName" });
    const [t] = evidence(w, a.change, "test");
    expect(t!.d.command).toBe("node --test test/users.test.ts");
    expect(t!.d.summary).toEqual({ pass: 1, fail: 0 });
    // the rebase job's sandbox spec carried the task's risk tier
    expect(w.jobs.started[0]!.req.spec).toMatchObject({ job: "rebase", select: { risk: "low" } });

    const land = await w.wf.land(a);
    expect(land.status).toBe("landed");
    const pre = evidence(w, a.change, "test_selection").find((e) => e.d.stage === "presubmit")!;
    expect(pre.d).toMatchObject({ mode: "full", reason: "land presubmit always runs the full suite", selected: 3, total: 3 });
    const [p] = evidence(w, a.change, "presubmit");
    expect(p!.d.command).toBe("node --test");
    expect(p!.d.summary).toEqual({ pass: 3, fail: 0 });

    // The next checkpoint reports time saved against that full presubmit run.
    const b = await w.candidate("t2", "codex-b");
    const shaB = await b.push({ "src/cart.ts": "export const cart: string[] = ['kiwi'];\n" }, "cart: kiwi");
    await w.wf.process(b, shaB);
    const [selB] = evidence(w, b.change, "test_selection");
    expect(selB!.d).toMatchObject({ mode: "subset", selected: 1, total: 3, files: ["test/cart.test.ts"], baseline: { ms: p!.d.ms, tests: 3, kind: "presubmit" } });
    expect(typeof selB!.d.saved_ms).toBe("number");
  });

  it("a change no test reaches runs nothing and passes, with the selection recorded", async () => {
    const w = await shop();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "README.md": "# shop\n" }, "docs");
    const r = await w.wf.process(a, sha);
    expect(r.tests).toBe("pass");
    const [sel] = evidence(w, a.change, "test_selection");
    expect(sel!.d).toMatchObject({ mode: "subset", selected: 0, total: 3, files: [] });
  });

  it("falls back to the full suite for a high-risk task", async () => {
    const w = await shop();
    const a = await w.candidate("t1", "claude-a", { risk: "high" });
    const sha = await a.push({ "src/users.ts": sub(USERS, "${first} ${last}", "${last} ${first}") }, "users");
    await w.wf.process(a, sha);
    const [sel] = evidence(w, a.change, "test_selection");
    expect(sel!.d).toMatchObject({ mode: "full", reason: "risk tier high", selected: 3, total: 3 });
    expect(evidence(w, a.change, "test")[0]!.d.summary).toEqual({ pass: 3, fail: 0 });
  });

  it("falls back to the full suite when deps/config change", async () => {
    const w = await shop();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "package.json": '{"name":"shop","type":"module","dependencies":{"left-pad":"1.3.0"}}\n', "src/users.ts": sub(USERS, "${first} ${last}", "${last}") }, "deps");
    await w.wf.process(a, sha);
    const [sel] = evidence(w, a.change, "test_selection");
    expect(sel!.d).toMatchObject({ mode: "full", reason: "config/deps/test infra changed: package.json", selected: 3 });
  });

  it("falls back to the full suite when the analyzer cannot parse a changed file (and the failure bounces)", async () => {
    const w = await shop();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/users.ts": "export function displayName(first: string {\n" }, "broken");
    const r = await w.wf.process(a, sha);
    expect(r.tests).toBe("fail");
    const [sel] = evidence(w, a.change, "test_selection");
    expect(sel!.d.mode).toBe("full");
    expect(sel!.d.reason).toMatch(/^analyzer cannot parse src\/users\.ts/);
  });

  it("a failing selected test still fails the checkpoint and bounces", async () => {
    const w = await shop();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/users.ts": sub(USERS, "${first} ${last}", "${first}${last}!!") }, "users: broken");
    const r = await w.wf.process(a, sha, new FakeStep());
    expect(r).toMatchObject({ tests: "fail" });
    expect(r.bounced_seq).toBeGreaterThan(0);
    expect(evidence(w, a.change, "test_selection")[0]!.d).toMatchObject({ mode: "subset", files: ["test/users.test.ts"] });
  });

  it("repos without tests.select keep running the full suite with no selection record", async () => {
    const w = await shop({ tests: { command: ["node", "--test"], timeout_s: 120 } });
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/users.ts": sub(USERS, "${first} ${last}", "${last} ${first}") }, "users");
    await w.wf.process(a, sha);
    expect(evidence(w, a.change, "test_selection")).toEqual([]);
    expect(evidence(w, a.change, "test")[0]!.d).toMatchObject({ command: "node --test", summary: { pass: 3, fail: 0 } });
  });
});
