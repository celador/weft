// End-to-end team join against the REAL gateway code: the CLI's own local gateway (wrangler dev of the bundled
// gateway), two config homes as two machines, two clones both called `shop`, and the real Claude Code hook.
// Usage: node e2e-team.mjs <weft worktree>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const wt = process.argv[2];
const cliBin = join(wt, "packages/cli/dist/weft.mjs");
const base = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "weft-e2e-team-"));
const homeA = join(base, "owner-home");
const homeB = join(base, "alice-home");
const PATH = `${join(wt, "node_modules/.bin")}:${process.env.PATH}`;
const env = (home) => ({ ...process.env, PATH, WEFT_HOME: home, WEFT_NO_OPEN: "1", WEFT_USE_GLOBAL_WRANGLER: "1", WEFT_CLI_MAIN: "1", NO_COLOR: "1", FORCE_COLOR: "0", CLOUDFLARE_API_TOKEN: "" });
const PRICING = "export type Item = { price: number; qty: number };\n\nexport function calcTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n";
const CART = 'import type { Item } from "./pricing";\n\nexport function renderCart(items: Item[]): string {\n  return items.map((i) => `${i.qty} x ${i.price}`).join("\\n");\n}\n';

function repo(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/pricing.ts"), PRICING);
  writeFileSync(join(dir, "src/cart.ts"), CART);
  writeFileSync(join(dir, "package.json"), '{ "name": "shop", "private": true, "type": "module" }\n');
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
  return dir;
}
const redact = (s) => s.replace(/weft_[A-Za-z0-9_-]{20,}/g, "weft_<redacted>");
function weft(home, args, cwd) {
  const r = spawnSync(process.execPath, [cliBin, ...args], { cwd, env: env(home), encoding: "utf8", timeout: 240_000 });
  const out = redact(`${r.stdout}${r.stderr}`);
  console.log(`\n$ weft ${args.join(" ")}   [${home === homeA ? "owner machine" : "teammate machine"}] -> exit ${r.status}\n${out.trim().split("\n").map((l) => "  " + l).join("\n")}`);
  return { status: r.status, out };
}
function hook(home, root, payload) {
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: root, env: env(home), input: JSON.stringify({ session_id: payload.session, cwd: root, ...payload }), encoding: "utf8", timeout: 60_000 });
  return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
}
async function edit(home, root, session, id, file, oldS, newS) {
  const input = { file_path: join(root, file), old_string: oldS, new_string: newS };
  const pre = hook(home, root, { hook_event_name: "PreToolUse", session, tool_name: "Edit", tool_input: input, tool_use_id: id });
  if (pre?.hookSpecificOutput?.permissionDecision === "deny") return { applied: false, pre };
  const p = join(root, file);
  writeFileSync(p, readFileSync(p, "utf8").replace(oldS, newS));
  hook(home, root, { hook_event_name: "PostToolUse", session, tool_name: "Edit", tool_input: input, tool_use_id: id, tool_response: {} });
  return { applied: true, pre };
}

const ownerRepo = repo(join(base, "owner", "shop"));
// The teammate's clone of the same repo (same commits), on "another machine".
mkdirSync(join(base, "alice"), { recursive: true });
execFileSync("git", ["clone", "-q", ownerRepo, join(base, "alice", "shop")]);
const aliceRepo = join(base, "alice", "shop");
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};
try {
  // 1. owner: a space on the gateway this machine runs (real gateway code), one checkout, Claude Code hooks
  const a = weft(homeA, ["--local", "--dir", ownerRepo, "--yes", "--no-open", "--harness", "claude-code", "--agents", "1"], ownerRepo);
  check(a.status === 0, "owner: npx @celador/weft set up the space");
  // 2. owner: an invite
  const inv = weft(homeA, ["invite", "--dir", ownerRepo], ownerRepo);
  const line = inv.out.split("\n").find((l) => l.includes("--join"));
  check(!!line && /one use, expires in 30 minutes/.test(inv.out), "owner: weft invite printed a code and the teammate's command");
  const cmd = line.trim().split(/\s+/).slice(2);
  // 3. teammate on "another machine": their own config home, their own clone, also called `shop`
  const b = weft(homeB, [...cmd, "--dir", aliceRepo, "--yes", "--no-open", "--harness", "claude-code", "--agents", "1", "--as", "Alice Test"], aliceRepo);
  check(b.status === 0 && /joined space sp\w+ as alice/.test(b.out), "teammate: --join traded the code for a member key");
  const agentA = JSON.parse(readFileSync(join(ownerRepo, ".weft/claude.json"), "utf8")).agent;
  const agentB = JSON.parse(readFileSync(join(aliceRepo, ".weft/claude.json"), "utf8")).agent;
  check(agentA === "shop" && agentB === "shop.alice", `agent ids differ: owner ${agentA}, teammate ${agentB}`);
  // the same code a second time
  const again = weft(join(base, "carol-home"), [...cmd, "--dir", repo(join(base, "carol", "shop")), "--yes", "--no-open", "--harness", "claude-code", "--agents", "1"], base);
  check(again.status !== 0 && /not valid or has expired/.test(again.out), "the code works once");
  // 4. both start Claude Code; the owner's agent changes calcTotal's signature; the teammate's agent then calls the old one
  hook(homeB, aliceRepo, { hook_event_name: "SessionStart", session: "sb", source: "startup" });
  hook(homeA, ownerRepo, { hook_event_name: "SessionStart", session: "sa", source: "startup" });
  const ea = await edit(homeA, ownerRepo, "sa", "tA1", "src/pricing.ts", "export function calcTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);", "export function calcTotal(items: Item[], opts: { taxRate: number }): number {\n  return items.reduce((s, i) => s + i.price * i.qty, 0) * (1 + opts.taxRate);");
  check(ea.applied, "owner's agent (shop) changed calcTotal's signature");
  const eb = await edit(homeB, aliceRepo, "sb", "tB1", "src/cart.ts", 'import type { Item } from "./pricing";', 'import { calcTotal, type Item } from "./pricing";\n\nexport function cartTotal(items: Item[]): string {\n  return calcTotal(items).toFixed(2);\n}');
  const reason = eb.pre?.hookSpecificOutput?.permissionDecisionReason ?? JSON.stringify(eb.pre ?? {});
  console.log(`\n  teammate's PreToolUse answer: ${redact(reason).split("\n").slice(0, 3).join(" | ").slice(0, 400)}`);
  check(!eb.applied && /stale_assumption/.test(reason) && /shop\b/.test(reason), "teammate's agent (shop.alice) was stopped with stale_assumption caused by shop");
  // 5. the owner sees and removes the member; the teammate is told
  const m = weft(homeA, ["members", "--dir", ownerRepo], ownerRepo);
  check(/alice\s+Alice Test on /.test(m.out), "owner: weft members lists alice");
  const st = weft(homeB, ["status", "--dir", aliceRepo], aliceRepo);
  check(st.status === 0 && /joined as alice/.test(st.out), "teammate: weft status reads the space as a member");
  const no = weft(homeB, ["members", "--dir", aliceRepo], aliceRepo);
  check(no.status !== 0 && /only the owner of space/.test(no.out), "teammate: weft members is the owner's");
  const rv = weft(homeA, ["members", "revoke", "alice", "--dir", ownerRepo], ownerRepo);
  check(rv.status === 0 && /removed alice/.test(rv.out), "owner: members revoke alice");
  await new Promise((r) => setTimeout(r, 5500)); // space grants are cached up to 5 s
  const gone = weft(homeB, ["status", "--dir", aliceRepo], aliceRepo);
  check(gone.status !== 0 && /no longer accepts this machine's member key/.test(gone.out), "teammate: removed, and told so");
  const agentTok = readFileSync(join(aliceRepo, ".weft/token"), "utf8").trim();
  const url = JSON.parse(readFileSync(join(aliceRepo, ".weft/space.json"), "utf8")).url;
  const ev = await fetch(`${url}/v1/repos/${JSON.parse(readFileSync(join(aliceRepo, ".weft/space.json"), "utf8")).repo}/events?limit=1`, { headers: { authorization: `Bearer ${agentTok}`, "wcp-version": "0.1" } });
  check(ev.status === 401, `teammate's agent key was revoked with the member (GET events -> ${ev.status})`);
} finally {
  weft(homeA, ["local", "stop"], base);
  console.log(`\n${failed ? `${failed} FAILED` : "ALL PASS"}   (scratch: ${base})`);
  process.exitCode = failed ? 1 : 0;
}
