// The repo-list refresh runs only while a Weft repo is mapped AND the Weft view is visible AND the window is
// focused; every 60 s, backing off while nothing changes. A manual clock stands in for setTimeout.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWeftWorkspace, readCheckout } from "../../src/config";
import { RepoRefresher } from "../../src/refresh";

function rig(results: boolean[] = []) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const runs: number[] = [];
  const r = new RepoRefresher({
    run: async () => {
      runs.push(now);
      return results.shift() ?? false;
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  /** Advance the clock, firing due timers (and letting their async runs settle). */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = end;
  };
  return { r, runs, timers, advance };
}

describe("RepoRefresher", () => {
  it("sets no timer and makes no call unless a repo is mapped, the view is visible and the window is focused", async () => {
    const { r, runs, timers, advance } = rig();
    expect(timers.size).toBe(0);
    r.setVisible(true);
    r.setFocused(true); // visible + focused, but nothing mapped
    expect(timers.size).toBe(0);
    r.setMapped(true);
    expect(r.active).toBe(true);
    expect(timers.size).toBe(1);
    r.setMapped(false);
    expect(timers.size).toBe(0);
    r.setMapped(true);
    r.setVisible(false); // panel hidden
    expect(timers.size).toBe(0);
    r.setVisible(true);
    r.setFocused(false); // window in the background
    expect(timers.size).toBe(0);
    await advance(10 * 60_000);
    expect(runs).toEqual([]);
    expect(r.armed).toBe(false);
  });

  it("refreshes at once when it becomes active, then every 60 s, never at 10 s", async () => {
    const { r, runs, advance } = rig([true, true, true, true]);
    r.setMapped(true);
    r.setVisible(true);
    r.setFocused(true);
    await advance(0);
    expect(runs).toHaveLength(1);
    await advance(59_000);
    expect(runs).toHaveLength(1);
    await advance(1_000);
    expect(runs).toHaveLength(2);
    await advance(60_000);
    expect(runs).toHaveLength(3);
  });

  it("backs off x2 up to 5 minutes while nothing changes, and resets when the list changes", async () => {
    const { r, runs, advance } = rig([false, false, false, false, false, true, false]);
    r.setMapped(true);
    r.setVisible(true);
    r.setFocused(true);
    await advance(0); // run 1 (unchanged) -> next in 120 s
    await advance(120_000); // run 2 -> next in 240 s
    await advance(240_000); // run 3 -> next in 300 s (cap)
    await advance(300_000); // run 4 -> 300 s
    await advance(300_000); // run 5 -> 300 s
    expect(runs).toHaveLength(5);
    await advance(300_000); // run 6 (changed) -> back to 60 s
    expect(runs).toHaveLength(6);
    await advance(60_000);
    expect(runs).toHaveLength(7);
  });

  it("stops the timer when the view is hidden or the window loses focus, and does not run a stale refresh on return", async () => {
    const { r, runs, timers, advance } = rig();
    r.setMapped(true);
    r.setVisible(true);
    r.setFocused(true);
    await advance(0);
    expect(runs).toHaveLength(1);
    r.setFocused(false);
    expect(timers.size).toBe(0);
    await advance(30_000);
    r.setFocused(true); // 30 s after the last read: it is not due yet (next at 120 s after the unchanged read)
    expect(runs).toHaveLength(1);
    expect(timers.size).toBe(1);
    await advance(10 * 60_000);
    r.setVisible(false);
    expect(timers.size).toBe(0);
    const n = runs.length;
    await advance(10 * 60_000);
    expect(runs).toHaveLength(n);
    r.setVisible(true); // long stale: refresh right away
    await advance(0);
    expect(runs).toHaveLength(n + 1);
  });

  it("dispose clears the timer for good", async () => {
    const { r, timers } = rig();
    r.setMapped(true);
    r.setVisible(true);
    r.setFocused(true);
    expect(timers.size).toBe(1);
    r.dispose();
    expect(timers.size).toBe(0);
    r.setVisible(true);
    expect(timers.size).toBe(0);
  });
});

describe("isWeftWorkspace", () => {
  const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "weft-ws-"));
  it("is false for a folder with no .weft/, no Hermes mapping, no settings and no WEFT_REPO", () => {
    const root = scratch();
    const home = scratch();
    expect(isWeftWorkspace({ env: {}, checkouts: [readCheckout(root, { env: { WEFT_HOME: join(home, "weft") }, home })] })).toBe(false);
  });
  it("is true with .weft/ config, a Hermes-mapped folder, weft.repo / weft.url, or WEFT_REPO", () => {
    const home = scratch();
    const env = { WEFT_HOME: join(home, "weft") };
    const withWeft = scratch();
    mkdirSync(join(withWeft, ".weft"));
    writeFileSync(join(withWeft, ".weft", "claude.json"), JSON.stringify({ url: "http://localhost:8817", repo: "shop", agent: "a" }));
    expect(isWeftWorkspace({ env: {}, checkouts: [readCheckout(withWeft, { env, home })] })).toBe(true);

    const mapped = scratch();
    mkdirSync(join(home, "weft"), { recursive: true });
    writeFileSync(join(home, "weft", "hermes-adapter.json"), JSON.stringify({ url: "https://gw.test", projects: { repos: { [mapped]: "proj" } } }));
    const c = readCheckout(mapped, { env, home });
    expect(c.repo).toBe("proj");
    expect(isWeftWorkspace({ env: {}, checkouts: [c] })).toBe(true);

    const bare = readCheckout(scratch(), { env: { WEFT_HOME: join(home, "nothing") }, home });
    expect(isWeftWorkspace({ env: {}, settingRepo: "x", checkouts: [bare] })).toBe(true);
    expect(isWeftWorkspace({ env: {}, settingUrl: "https://gw.test", checkouts: [bare] })).toBe(true);
    expect(isWeftWorkspace({ env: { WEFT_REPO: "x" }, checkouts: [bare] })).toBe(true);
    expect(isWeftWorkspace({ env: {}, checkouts: [bare] })).toBe(false);
  });
});
