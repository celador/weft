#!/usr/bin/env node
// A real run for the @weft/feed demo: two Claude Code agents with the Weft adapter on a local
// gateway (`pnpm dev:local`) produce a conflict, while demo/server.mjs shows it live.
//
//   node packages/feed/demo/live-run.mjs setup  --url http://localhost:8817 --dir DIR
//   node packages/feed/demo/live-run.mjs agents --dir DIR        # claude-b plans, claude-a changes
//                                                                # calcTotal, claude-b implements
//   node packages/feed/demo/live-run.mjs record --dir DIR --out FILE   # the log, with diffs
//
// setup reuses scripts/local-quickstart.mjs: a tiny TypeScript repo with two worktrees, one agent
// token each (Claude Code adapter installed), plus a human token (observe + human) for the feed
// page at DIR/human-token (0600). Tokens are never printed. Needs `claude` logged in.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminToken, client, makeSampleRepo, setup } from "../../../scripts/local-quickstart.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n, d) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : d;
};
const dir = resolve(opt("dir", join(here, ".run")));
const runFile = join(dir, "run.json");
const log = (m) => console.log(`[live-run] ${m}`);

if (cmd === "setup") {
  const url = opt("url", "http://localhost:8787").replace(/\/+$/, "");
  mkdirSync(dir, { recursive: true });
  const { wa, wb } = makeSampleRepo(dir);
  const repo = `shop-feed-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const r = await setup({
    url,
    repo,
    dirs: [wa, wb],
    agents: ["claude-a", "claude-b"],
    tasks: [
      { id: "T-1", title: "Prices include tax" },
      { id: "T-2", title: "Show the cart total" },
    ],
  });
  const api = client(url);
  const human = await api.token(adminToken(), { principal: "john", scopes: ["observe", "human"], repos: [repo] });
  const tokenFile = join(dir, "human-token");
  writeFileSync(tokenFile, human.token + "\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  writeFileSync(runFile, JSON.stringify({ url, repo, wa, wb, agents: r.agents.map(({ agent, change, task }) => ({ agent, change, task })) }, null, 2));
  log(`repo ${repo} ready; human token at ${tokenFile}`);
} else if (cmd === "agents") {
  const run = JSON.parse(readFileSync(runFile, "utf8"));
  const out = (n) => join(dir, n);
  // claude-b plans first (its change's base predates claude-a's edit) ...
  const b1 = await claude(run.wb, out("b1-plan.jsonl"), [
    "Task T-2: src/cart.ts needs `export function cartTotal(items: Item[]): number` that returns the cart total,",
    "computed with the existing `calcTotal` helper from src/pricing.ts. For now only read src/pricing.ts and",
    "src/cart.ts and reply with a 3-line plan including the exact line you will write. Do not edit any file yet.",
  ].join(" "));
  log(`claude-b planned (session ${b1.session})`);
  // ... claude-a changes calcTotal's signature, and claude-b implements while claude-a works.
  const a = claude(run.wa, out("a-signature.jsonl"), [
    "Task T-1: prices must include tax. In src/pricing.ts add `export type PriceOptions = { taxRate: number }` and",
    "change calcTotal to `calcTotal(items: Item[], opts: PriceOptions): number` returning the net sum multiplied by",
    "(1 + opts.taxRate). Keep it minimal, then reply with a one-line summary.",
  ].join(" "));
  await waitForEdit(run, "claude-a");
  log("claude-a's calcTotal edit is in the log; claude-b implements now");
  const b2 = claude(
    run.wb,
    out("b2-implement.jsonl"),
    "Go ahead and implement the plan now. If the Weft coordinator reports a conflict, adapt your code to it. When you are done, reply with the final function and one sentence on anything that changed from your plan.",
    ["--resume", b1.session, "--max-turns", "20"],
  );
  const [ra, rb] = await Promise.all([a, b2]);
  log(`claude-a: ${ra.result}`);
  log(`claude-b: ${rb.result}`);
} else if (cmd === "record") {
  const run = JSON.parse(readFileSync(runFile, "utf8"));
  const token = readFileSync(join(dir, "human-token"), "utf8").trim();
  const h = { authorization: `Bearer ${token}`, "wcp-version": "0.1" };
  const page = await (await fetch(`${run.url}/v1/repos/${run.repo}/events?limit=500`, { headers: h })).json();
  const events = [];
  for (const e of page.events) events.push(e.has_diff ? await (await fetch(`${run.url}/v1/repos/${run.repo}/events/${e.seq}`, { headers: h })).json() : e);
  // Scrub local paths (temp dirs) from transcripts and text; nothing else is machine-specific.
  const text = JSON.stringify({ repo: run.repo, recorded: new Date().toISOString(), events }, null, 1).split(dir).join("<run>");
  const file = resolve(opt("out", join(dir, "log.json")));
  writeFileSync(file, text + "\n");
  log(`recorded ${events.length} records to ${file}`);
} else {
  console.error("usage: live-run.mjs setup|agents|record --dir DIR [--url URL] [--out FILE]");
  process.exit(2);
}

async function waitForEdit(run, agent, ms = 240_000) {
  const token = readFileSync(join(dir, "human-token"), "utf8").trim();
  const t = Date.now();
  while (Date.now() - t < ms) {
    const page = await (await fetch(`${run.url}/v1/repos/${run.repo}/events?limit=500`, { headers: { authorization: `Bearer ${token}` } })).json();
    if (page.events.some((e) => e.kind === "edit" && e.agent === agent && e.status === "accepted" && e.files.includes("src/pricing.ts"))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no edit from ${agent} after ${ms / 1000}s`);
}

function claude(cwd, out, prompt, extra = []) {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    // Only the checkout's settings (the adapter's hooks), never the user's own hooks.
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Edit,Write,MultiEdit,Glob,Grep,Bash(.weft/bin/weft:*),Bash(git status:*),Bash(git diff:*)",
    ...extra,
    "--",
    prompt,
  ];
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `claude ${extra.join(" ")} -p …\n\n${prompt}\n`);
  return new Promise((res, rej) => {
    const env = { ...process.env };
    delete env.WEFT_TOKEN;
    const p = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const lines = [];
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      writeFileSync(out, lines.join("\n") + "\n");
      const msgs = lines.flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      const result = msgs.findLast((m) => m.type === "result");
      if (code !== 0 && !result) return rej(new Error(`claude exited ${code}: ${err.slice(-400)}`));
      res({ session: result?.session_id ?? msgs.find((m) => m.session_id)?.session_id, result: String(result?.result ?? "").slice(0, 300) });
    });
  });
}
