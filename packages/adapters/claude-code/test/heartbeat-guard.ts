// Vitest globalSetup shared by every package whose tests run adapter bundles (hooks spawn
// detached `heartbeat-loop` processes on SessionStart). It tags this run's loops through
// WEFT_HEARTBEAT_TAG (spawnHeartbeat passes it on as `--tag`). On teardown it kills every
// tagged loop still alive (their owner, a vitest process, may legitimately still be running)
// and then fails the run if any tagged loop survives. Count before = count after = 0.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export type LoopProc = { pid: number; command: string };

/** Live `heartbeat-loop` processes, optionally only those carrying `--tag <tag>`. */
export function heartbeatLoops(tag?: string): LoopProc[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const procs: LoopProc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[2]!;
    if (!/\sheartbeat-loop\s/.test(command)) continue;
    if (tag && !command.includes(` --tag ${tag}`)) continue;
    procs.push({ pid: Number(m[1]), command });
  }
  return procs;
}

export function kill(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function waitGone(tag: string, ms: number): Promise<LoopProc[]> {
  const deadline = Date.now() + ms;
  let left = heartbeatLoops(tag);
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    left = heartbeatLoops(tag);
  }
  return left;
}

export default function setup(): () => Promise<void> {
  const tag = process.env.WEFT_HEARTBEAT_TAG ?? `weft-test-${process.pid}-${randomBytes(4).toString("hex")}`;
  process.env.WEFT_HEARTBEAT_TAG = tag;
  // Loops notice a dead owner / deleted checkout within one poll.
  process.env.WEFT_HEARTBEAT_POLL_MS ??= "200";
  const before = heartbeatLoops(tag).length;
  return async () => {
    const alive = heartbeatLoops(tag);
    kill(alive.map((p) => p.pid));
    const survivors = await waitGone(tag, 5_000);
    const line = `[heartbeat-guard] tag ${tag}: ${before} loop(s) before, ${alive.length} reaped at teardown, ${survivors.length} survived`;
    process.stderr.write(`${line}\n`);
    if (survivors.length || before) {
      throw new Error(`${line}\n${survivors.map((p) => `  ${p.pid} ${p.command}`).join("\n")}`);
    }
  };
}
