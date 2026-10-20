#!/usr/bin/env node
// Trunk tools for the Otto demo (repo weft-demo-site, Artifacts trunk weft-preview/weft-demo-site).
//
//   node demo/otto/trunk.mjs seed [--run N]     reset trunk to ~/github/weft-demo-site HEAD (one commit, CAS push)
//   node demo/otto/trunk.mjs check --run N      clone trunk: tsc + node --test -> run-N/trunk.json + trunk.txt
//   node demo/otto/trunk.mjs pull               fast-forward ~/github/weft-demo-site main to trunk (Otto shows the landed code)
//   node demo/otto/trunk.mjs follow [--deploy]  print each new trunk head; with --deploy, `wrangler deploy` it
//                                               (only for when Workers Builds is not connected to the trunk)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REPO, REPO_CONFIG } from "./scenario.mjs";
import { GW, MAIN_ROOT, ROOT, SITE, TOK, api, git, scrub, sleep, tryRun } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const RUN = Number(opt("run", "0"));

async function trunkClone(scope = "write") {
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, TOK.sys, { scope, ttl: 900 }, 201);
  const d = mkdtempSync(join(tmpdir(), "weft-otto-trunk-"));
  git(["clone", "-q", tt.remote, d], { token: tt.token.plaintext });
  return { dir: d, token: tt.token.plaintext, remote: tt.remote };
}
function listFiles(dir, base = dir) {
  const acc = [];
  for (const e of readdirSync(dir)) {
    if (e === ".git" || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) acc.push(...listFiles(p, base));
    else acc.push(relative(base, p));
  }
  return acc;
}

async function seed() {
  // bind/create the trunk only when the repo has none (the admin call 500s on an existing trunk)
  const probe = await fetch(`${GW}/v1/repos/${REPO}/system/trunk-token`, { method: "POST", headers: { authorization: `Bearer ${TOK.sys}`, "wcp-version": "0.1", "content-type": "application/json" }, body: JSON.stringify({ scope: "read", ttl: 60 }) });
  if (probe.status === 404) await api("POST", "/v1/admin/artifacts/repos", TOK.admin, { repo: REPO, trunk: REPO, create: true, config: REPO_CONFIG }, [200, 201]);
  const { dir, token } = await trunkClone();
  const before = git(["rev-parse", "HEAD"], { cwd: dir, allowFail: true });
  for (const f of listFiles(dir)) rmSync(join(dir, f));
  // exactly the committed site (git archive of HEAD), nothing local
  const tar = join(dir, "..", `site-${Date.now()}.tar`);
  git(["archive", "-o", tar, "HEAD"], { cwd: SITE });
  tryRun("tar", ["-xf", tar, "-C", dir], dir);
  rmSync(tar);
  git(["add", "-A"], { cwd: dir });
  let head = before.code === 0 ? before.out : null;
  if (git(["status", "--porcelain"], { cwd: dir })) {
    git(["commit", "-qm", `demo: seed Northbound Coffee${RUN ? ` (otto run ${RUN})` : ""}`], { cwd: dir, id: "weft-otto-seed" });
    git(["push", "-q", ...(head ? [`--force-with-lease=refs/heads/main:${head}`] : []), "origin", "HEAD:refs/heads/main"], { cwd: dir, token });
    head = git(["rev-parse", "HEAD"], { cwd: dir });
  }
  const tests = tryRun(process.execPath, ["--test"], dir);
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ seeded: true, before: before.out ?? null, head, site_head: git(["rev-parse", "HEAD"], { cwd: SITE }), tests_exit: tests.code }));
}

async function check() {
  const { dir } = await trunkClone("read");
  symlinkSync(join(MAIN_ROOT, "node_modules"), join(dir, "node_modules"));
  const tsc = tryRun(join(MAIN_ROOT, "node_modules/.bin/tsc"), ["-p", "."], dir);
  const test = tryRun(process.execPath, ["--test"], dir);
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
  const r = {
    head: git(["rev-parse", "HEAD"], { cwd: dir }),
    log: git(["log", "--format=%h %an %s", "-20"], { cwd: dir }).split("\n"),
    tsc: { exit: tsc.code, out: tsc.out.trim().split("\n").slice(0, 15) },
    test: { exit: test.code, summary: test.out.split("\n").filter((l) => /^ℹ (tests|pass|fail)/.test(l)) },
    files: {
      "src/auth/session.ts": read("src/auth/session.ts"),
      "src/auth/refresh.ts": read("src/auth/refresh.ts"),
      "src/pricing.ts": read("src/pricing.ts"),
      "src/freshness.ts": read("src/freshness.ts") !== null,
      "public/menu.html#guji": /guji/i.test(read("public/menu.html") ?? ""),
      "src/worker.ts": read("src/worker.ts"),
    },
  };
  const out = join(ROOT, "demo/evidence/otto", `run-${RUN}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "trunk.json"), scrub(JSON.stringify(r, null, 2)) + "\n");
  writeFileSync(join(out, "trunk.txt"), scrub([`head ${r.head}`, ...r.log, "--- tsc", tsc.out, "--- node --test", test.out, "--- src/auth/session.ts", r.files["src/auth/session.ts"], "--- src/pricing.ts", r.files["src/pricing.ts"]].join("\n")));
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ head: r.head, tsc: r.tsc.exit, test: r.test }));
}

async function pull() {
  const { dir } = await trunkClone("read");
  const head = git(["rev-parse", "HEAD"], { cwd: dir });
  // the site repo keeps its own history; trunk's tree becomes a commit on top (Otto shows the files)
  const tar = join(dir, "..", `trunk-${Date.now()}.tar`);
  git(["archive", "-o", tar, "HEAD"], { cwd: dir });
  for (const f of git(["ls-files"], { cwd: SITE }).split("\n").filter(Boolean)) rmSync(join(SITE, f), { force: true });
  tryRun("tar", ["-xf", tar, "-C", SITE], SITE);
  rmSync(tar);
  git(["add", "-A"], { cwd: SITE });
  if (git(["status", "--porcelain"], { cwd: SITE })) git(["commit", "-qm", `sync from Weft trunk ${head.slice(0, 7)}`], { cwd: SITE, id: "weft-otto-sync" });
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ trunk: head, site: git(["rev-parse", "HEAD"], { cwd: SITE }) }));
}

async function follow() {
  const deploy = argv.includes("--deploy");
  let last;
  for (;;) {
    try {
      const { dir } = await trunkClone("read");
      const head = git(["rev-parse", "HEAD"], { cwd: dir });
      if (head !== last) {
        const msg = git(["log", "-1", "--format=%s"], { cwd: dir });
        console.log(`[${new Date().toISOString()}] trunk ${head.slice(0, 9)} ${msg}`);
        if (deploy) {
          symlinkSync(join(MAIN_ROOT, "node_modules"), join(dir, "node_modules"));
          const env = { ...process.env };
          delete env.CLOUDFLARE_API_TOKEN;
          const r = tryRun("npx", ["wrangler", "deploy", "--message", `trunk ${head.slice(0, 9)}: ${msg}`.slice(0, 100)], dir, 180_000, env);
          console.log(`  deploy exit ${r.code} ${scrub(r.out.split("\n").filter((l) => /Current Version|Deployed|error/i.test(l)).join(" | "))}`);
        }
        last = head;
      }
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.log(`[${new Date().toISOString()}] follow error ${scrub(e.message ?? e).slice(0, 200)}`);
    }
    await sleep(5000);
  }
}

async function releaseAll() {
  // Between runs: every agent that ever edited in this repo releases its claims (claims outlive
  // sessions; a previous run's losing candidates would otherwise hold symbols).
  const seen = new Map();
  let after = 0;
  for (;;) {
    const p = await api("GET", `/v1/repos/${REPO}/events?after=${after}&limit=500`, TOK.sys, undefined, 200);
    for (const e of p.events) if (e.agent && e.change && ["edit", "intent", "claim"].includes(e.kind)) seen.set(`${e.agent} ${e.change}`, { agent: e.agent, change: e.change, task: e.task });
    if (!p.has_more) break;
    after = p.next_after;
  }
  const out = [];
  for (const { agent, change, task } of seen.values()) {
    if (agent.startsWith("hermes-") && !/-r\d+$/.test(agent)) continue; // John's own Hermes profiles: not ours to release
    try {
      const tok = (await api("POST", "/v1/admin/tokens", TOK.admin, { principal: agent, scopes: ["agent"], repos: [REPO], agent, label: "otto demo release" }, 201)).token;
      const w = await api("POST", `/v1/repos/${REPO}/sessions`, tok, { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "otto-release" }, capabilities: { level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: false }, task: { id: task ?? "release" }, change }, 201);
      await api("POST", `/v1/repos/${REPO}/sessions/${w.session}/events`, tok, { type: "submit", mode: "commit", event: { kind: "release", base_seq: w.delivered_through } });
      await api("POST", `/v1/repos/${REPO}/sessions/${w.session}/bye`, tok, { type: "bye", reason: "otto demo reset" }).catch(() => undefined);
      out.push(agent);
    } catch (e) {
      out.push(`${agent}: ${scrub(e.message).slice(0, 80)}`);
    }
  }
  console.log(JSON.stringify({ released: out }));
}

const cmd = argv[0];
(cmd === "seed" ? seed() : cmd === "check" ? check() : cmd === "pull" ? pull() : cmd === "follow" ? follow() : cmd === "release-all" ? releaseAll() : Promise.reject(new Error("usage: trunk.mjs seed|check|pull|follow|release-all"))).catch((e) => {
  console.error(scrub(e.stack ?? e));
  process.exit(1);
});
