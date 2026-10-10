import { afterAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CART_LINE, NEW_CALL, OLD_CALL, PRICING_V1, PRICING_V2, coordinator, gitCommit, gitLog, installed, runBundle } from "../../claude-code/test/translator-kit";
import { Host } from "../../claude-code/src/host";
import { Watcher } from "../src/watch";
import { CAPABILITIES, CONFIG_REL, host } from "../src/cli";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-watch.mjs");

describe("file watcher (L0)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("declares L0 honestly: async observe, no injection, no deny, no stop gate, git's own commit gate", () => {
    expect(CAPABILITIES).toEqual({ level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: "native" });
  });

  it("reports changes after the fact, gets the conflict as a human-facing diagnostic, and gates the commit", async () => {
    const { coord, url, server, changeSignature } = await coordinator();
    servers.push(server);
    const { root, out } = installed(BUNDLE, "watch", url, "human-w");
    expect(out).toContain("installed file-watcher adapter");
    expect(existsSync(join(root, CONFIG_REL))).toBe(true);
    const printed: string[] = [];
    const loaded = (host as Host).load(root)!;
    const w = new Watcher(host, loaded, (l) => printed.push(l));
    await w.start();
    expect(coord.log.find((r) => r.kind === "join")?.payload).toMatchObject({ harness: "file-watcher", level: 0 });
    expect(printed[0]).toContain("L0: edits are reported after the fact");

    // another agent changes calcTotal; the human (or any unhooked agent) writes a stale call
    const sigSeq = changeSignature();
    const cart = join(root, "src/cart.ts");
    writeFileSync(cart, readFileSync(cart, "utf8").replace(CART_LINE, OLD_CALL));
    const reports = await w.process(["src/cart.ts", ".weft/state/x.json", "node_modules/a/index.js"]);
    expect(reports.map((r) => r.rel)).toEqual(["src/cart.ts"]);
    const ev = coord.log.find((r) => r.kind === "edit" && r.agent === "human-w")!;
    expect(ev.mode).toBe("commit");
    expect(ev.status).toBe("rejected"); // reported after the write: an open error, not a block
    expect(ev.diagnostics![0]).toMatchObject({ code: "stale_assumption", caused_by_seq: sigSeq });
    expect(readFileSync(cart, "utf8")).toContain(OLD_CALL); // nothing was blocked (L0)
    expect(printed.join("\n")).toContain("[weft error] stale_assumption src/cart.ts:4:19");

    // unchanged files are not re-reported
    expect(await w.process(["src/cart.ts"])).toEqual([]);

    // git's pre-commit hook refuses while the error is open
    const refused = await gitCommit(root, "wip");
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("weft: commit refused");

    // fix it on disk -> accepted -> commit passes with trailers
    writeFileSync(cart, readFileSync(cart, "utf8").replace(OLD_CALL, NEW_CALL));
    await w.process([cart]);
    expect(coord.log.filter((r) => r.kind === "edit" && r.agent === "human-w").pop()!.status).toBe("accepted");
    const ok = await gitCommit(root, "cart: total");
    expect(ok.ok).toBe(true);
    expect(gitLog(root)).toMatch(/Agent-Id: human-w/);
    // the tick notices HEAD moved and reports a checkpoint
    await w.tick();
    expect(coord.log.some((r) => r.kind === "checkpoint" && r.agent === "human-w")).toBe(true);
    await w.stop();
    // The session end is a leave; the coordinator may then release the change's claims (spec §7.5).
    expect(coord.log.filter((r) => r.kind !== "release").at(-1)!.kind).toBe("leave");
  }, 60_000);

  it("`run` (real bundle, fs.watch) reports an edit made while it watches; `scan` reports the dirty tree", async () => {
    const { coord, url, server } = await coordinator();
    servers.push(server);
    const { root } = installed(BUNDLE, "watch-run", url, "human-r");
    const child = spawn(process.execPath, [BUNDLE, "run", "--debounce", "150", "--tick", "60000"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const until = async (f: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      return f();
    };
    expect(await until(() => out.includes("[weft-watch] watching"))).toBe(true);
    // Linux arms recursive fs.watch asynchronously after "watching" is printed, so a
    // single write can land before the watch exists (flaky on CI). Re-touch until seen.
    const sawEdit = () => coord.log.some((r) => r.kind === "edit" && r.agent === "human-r");
    let seen = false;
    for (let attempt = 0; attempt < 10 && !seen; attempt++) {
      writeFileSync(join(root, "src/pricing.ts"), attempt % 2 ? PRICING_V2 + "\n" : PRICING_V2);
      seen = await until(sawEdit, 2_000);
    }
    expect(seen).toBe(true);
    const ev = coord.log.find((r) => r.kind === "edit" && r.agent === "human-r")!;
    expect(ev.writes).toContainEqual({ key: "src/pricing.ts#calcTotal", kind: "signature" });
    expect(ev.diff).toContain(`-${PRICING_V1.split("\n")[2]}`);
    child.kill("SIGINT");
    expect(await until(() => child.exitCode !== null)).toBe(true);
    expect(out).toContain("changed src/pricing.ts");

    const { root: r2 } = installed(BUNDLE, "watch-scan", url, "human-s");
    writeFileSync(join(r2, "src/pricing.ts"), PRICING_V2);
    const scanned = await new Promise<string>((res) => execFile(process.execPath, [BUNDLE, "scan"], { cwd: r2, encoding: "utf8" }, (_e, o) => res(o)));
    expect(scanned).toContain("changed src/pricing.ts");
    expect(coord.log.some((r) => r.kind === "edit" && r.agent === "human-s")).toBe(true);
    void runBundle;
  }, 60_000);
});
