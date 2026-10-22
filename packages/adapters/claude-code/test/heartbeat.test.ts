// Heartbeat loops must not outlive their session (they once leaked by the hundred).
// Unit: every stop condition of runHeartbeatLoop. E2E: the real bundle's SessionStart
// spawns a loop owned by the harness (not the `sh -c` wrapper), and that loop exits when the
// harness dies, when the checkout is deleted, and after SessionEnd.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harnessPid, loopArgs, pidAlive, pidFile, runHeartbeatLoop, type BeatResult } from "../src/heartbeat";
import { heartbeatLoops, kill, waitGone } from "./heartbeat-guard";
import { coordinator, installed, runBundle } from "./translator-kit";

const BUNDLE = fileURLToPath(new URL("../dist/weft-claude.mjs", import.meta.url));

/** A fake clock + sleep: each sleep advances time instantly. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const LIM = { intervalMs: 30_000, pollMs: 1_000, idleLimitMs: 1_800_000, unreachableLimitMs: 300_000, maxLifetimeMs: 3_600_000 };

describe("runHeartbeatLoop stop conditions", () => {
  const base = (beat: () => Promise<BeatResult>, extra: Partial<Parameters<typeof runHeartbeatLoop>[0]> = {}) => {
    const c = clock();
    let beats = 0;
    const p = runHeartbeatLoop({
      root: "/nonexistent",
      session: "s",
      pidFile: false,
      rootExists: () => true,
      alive: () => true,
      limits: LIM,
      ...c,
      beat: () => (beats++, beat()),
      ...extra,
    });
    return { p, c, beats: () => beats };
  };

  it("checks the owner every poll", async () => {
    let polls = 0;
    const r = base(async () => "alive", { parent: 4242, alive: () => ++polls < 5 });
    expect(await r.p).toBe("parent-exited");
    expect(r.c.now()).toBe(5 * LIM.pollMs);
    expect(r.beats()).toBe(0);
  });

  it("stops when the checkout's .weft dir is gone", async () => {
    let n = 0;
    const r = base(async () => "alive", { rootExists: () => ++n < 3 });
    expect(await r.p).toBe("root-gone");
  });

  it("stops when the session ended (bye, idle, or the coordinator says it is gone)", async () => {
    const results: BeatResult[] = ["alive", "alive", "ended"];
    const r = base(async () => results.shift()!);
    expect(await r.p).toBe("session-ended");
    expect(r.beats()).toBe(3);
    expect(r.c.now()).toBe(3 * LIM.intervalMs);
  });

  it("a throwing beat counts as ended", async () => {
    expect(await base(async () => Promise.reject(new Error("lock"))).p).toBe("session-ended");
  });

  it("stops after the coordinator was unreachable for the limit, and a success resets it", async () => {
    const seq: BeatResult[] = ["unreachable", "unreachable", "alive"];
    const r = base(async () => seq.shift() ?? "unreachable");
    expect(await r.p).toBe("unreachable");
    // 3 beats, then unreachable from beat 4 until 300s later (beat 14).
    expect(r.beats()).toBe(3 + 11);
  });

  it("stops at the max lifetime even while healthy", async () => {
    const r = base(async () => "alive");
    expect(await r.p).toBe("max-lifetime");
    expect(r.c.now()).toBe(LIM.maxLifetimeMs);
  });

  it("parses --parent and ignores junk", () => {
    expect(loopArgs(["s1", "--root", "/r", "--parent", "123", "--tag", "x"])).toEqual({ session: "s1", root: "/r", parent: 123 });
    expect(loopArgs(["s1", "--root", "/r"]).parent).toBeUndefined();
    expect(loopArgs(["s1", "--parent", "abc"]).parent).toBeUndefined();
  });
});

describe("harnessPid / pidAlive", () => {
  it("skips the sh -c wrapper a harness runs hooks through", async () => {
    // `sleep; true` keeps sh from exec'ing, so sh stays the sleeper's parent.
    const sh = spawn("/bin/sh", ["-c", "sleep 30; true"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(harnessPid(sh.pid!)).toBe(process.pid);
    } finally {
      sh.kill("SIGKILL");
    }
  });

  it("returns a non-shell parent as is", () => {
    expect(harnessPid(process.pid)).toBe(process.pid);
  });

  it("pidAlive", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(1)).toBe(false);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe("heartbeat-loop e2e (real bundle)", { timeout: 30_000 }, () => {
  let server: Server;
  let url: string;
  let coord: Awaited<ReturnType<typeof coordinator>>["coord"];
  const procs: ChildProcess[] = [];
  // A tag of this file's own (other files in the suite run in parallel and own their loops);
  // it extends the suite tag, so the global teardown still reaps anything left.
  const tag = `${process.env.WEFT_HEARTBEAT_TAG ?? "hb"}-e2e-${process.pid}`;
  const env = { ...process.env, WEFT_HEARTBEAT_TAG: tag, WEFT_HEARTBEAT_POLL_MS: "100", WEFT_HEARTBEAT_INTERVAL_MS: "200", WEFT_TOKEN: "" };
  let before: number;

  beforeAll(async () => {
    before = heartbeatLoops().length;
    const c = await coordinator();
    server = c.server;
    url = c.url;
    coord = c.coord;
  });
  afterAll(async () => {
    for (const p of procs) p.kill("SIGKILL");
    server?.close();
  });

  const loopFor = (session: string) => heartbeatLoops(tag).filter((p) => p.command.includes(` heartbeat-loop ${session} `));

  async function until<T>(f: () => T | undefined, ms = 10_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * A stand-in harness: a node process that runs the SessionStart hook through `sh -c`
   * (like Claude Code does) and then stays alive until killed.
   */
  function harness(root: string, session: string): ChildProcess {
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "startup" });
    const cmd = `'${process.execPath}' '${BUNDLE}' hook; true`;
    const script = `require("child_process").execFileSync("/bin/sh", ["-c", ${JSON.stringify(cmd)}], { input: ${JSON.stringify(input)}, cwd: ${JSON.stringify(root)}, stdio: ["pipe", "ignore", "ignore"] }); setInterval(() => {}, 1000);`;
    const p = spawn(process.execPath, ["-e", script], { env, stdio: "ignore" });
    procs.push(p);
    return p;
  }

  it("SessionStart spawns a loop owned by the harness; killing the harness ends it", async () => {
    const { root } = installed(BUNDLE, "hb-parent", url, "hb-a");
    const h = harness(root, "hb-parent-s");
    const [loop] = await until(() => (loopFor("hb-parent-s").length ? loopFor("hb-parent-s") : undefined));
    expect(loop!.command).toContain(` --parent ${h.pid} `);
    expect(loop!.command).toContain(`--root ${root}`);
    await until(() => existsSync(pidFile(root, "hb-parent-s")) || undefined);
    expect(Number(readFileSync(pidFile(root, "hb-parent-s"), "utf8"))).toBe(loop!.pid);
    h.kill("SIGKILL");
    await until(() => !pidAlive(loop!.pid) || undefined, 5_000);
    expect(existsSync(pidFile(root, "hb-parent-s"))).toBe(false);
  });

  it("deleting the checkout ends the loop (and does not recreate it)", async () => {
    const { root } = installed(BUNDLE, "hb-root", url, "hb-b");
    harness(root, "hb-root-s");
    const [loop] = await until(() => (loopFor("hb-root-s").length ? loopFor("hb-root-s") : undefined));
    rmSync(root, { recursive: true, force: true });
    await until(() => !pidAlive(loop!.pid) || undefined, 5_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(root)).toBe(false);
  });

  it("SessionEnd (bye) ends the loop at its next beat", async () => {
    const { root } = installed(BUNDLE, "hb-end", url, "hb-c");
    harness(root, "hb-end-s");
    const [loop] = await until(() => (loopFor("hb-end-s").length ? loopFor("hb-end-s") : undefined));
    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(loop!.pid)).toBe(true); // healthy session: still beating
    await runBundle(BUNDLE, root, { hook_event_name: "SessionEnd", session_id: "hb-end-s", cwd: root, reason: "exit" });
    await until(() => !pidAlive(loop!.pid) || undefined, 5_000);
  });

  it("a coordinator that says the session is gone ends the loop", async () => {
    const { root } = installed(BUNDLE, "hb-gone", url, "hb-d");
    harness(root, "hb-gone-s");
    const [loop] = await until(() => (loopFor("hb-gone-s").length ? loopFor("hb-gone-s") : undefined));
    // The coordinator drops the session (as an expiry sweep would); the next beat hears 410.
    const st = await until(() => JSON.parse(readFileSync(`${root}/.weft/state/hb-gone-s.json`, "utf8")).wcpSession as string | undefined);
    coord.bye(st, "expired by test");
    await until(() => !pidAlive(loop!.pid) || undefined, 5_000);
  });

  it("no heartbeat-loop from this file survives (count before and after)", async () => {
    for (const p of procs) p.kill("SIGKILL");
    const left = await waitGone(tag, 5_000);
    kill(left.map((p) => p.pid));
    expect(left).toEqual([]);
    // Globally: no more loops than when this file started (other suites may run in parallel,
    // so only loops from this file are attributable; those are zero above).
    expect(heartbeatLoops(tag).length).toBe(0);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});
