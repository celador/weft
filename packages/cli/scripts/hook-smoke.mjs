// Play Claude Code hook calls through the hooks `weft` installed in two checkouts (no LLM):
// agent A changes calcTotal's signature, agent B then calls the old one -> B is denied.
//   node scripts/hook-smoke.mjs <checkout-a> <checkout-b>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [wa, wb] = process.argv.slice(2);
const hookCmd = (dir) => JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")).hooks.PreToolUse.at(-1).hooks[0].command;

function runHook(dir, payload) {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", ["-c", hookCmd(dir)], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", fail);
    child.on("close", () => done(out.trim() ? JSON.parse(out) : undefined));
    child.stdin.end(JSON.stringify({ cwd: dir, ...payload }));
  });
}

async function edit(dir, session, id, rel, oldS, newS) {
  const tool_input = { file_path: join(dir, rel), old_string: oldS, new_string: newS };
  const pre = await runHook(dir, { hook_event_name: "PreToolUse", session_id: session, tool_name: "Edit", tool_use_id: id, tool_input });
  const deny = pre?.hookSpecificOutput?.permissionDecision === "deny" ? pre.hookSpecificOutput.permissionDecisionReason : undefined;
  if (deny) return { denied: true, reason: deny };
  const p = join(dir, rel);
  writeFileSync(p, readFileSync(p, "utf8").replace(oldS, newS));
  await runHook(dir, { hook_event_name: "PostToolUse", session_id: session, tool_name: "Edit", tool_use_id: id, tool_input, tool_response: {} });
  return { denied: false };
}

await runHook(wb, { hook_event_name: "SessionStart", session_id: "smoke-b", source: "startup" });
await runHook(wa, { hook_event_name: "SessionStart", session_id: "smoke-a", source: "startup" });
const a = await edit(wa, "smoke-a", "a1", "src/pricing.ts", "export function calcTotal(items: Item[]): number {", "export type PriceOptions = { taxRate: number };\n\nexport function calcTotal(items: Item[], opts: PriceOptions): number {");
console.log("A edit pricing.ts:", a.denied ? "DENIED" : "allowed");
const b = await edit(wb, "smoke-b", "b1", "src/cart.ts", "return `${items.length} items`;", "return `${items.length} items, total ${calcTotal(items)}`;");
console.log("B edit cart.ts:", b.denied ? "DENIED" : "allowed");
if (b.denied) console.log(b.reason.split("\n").slice(0, 6).join("\n"));
await runHook(wa, { hook_event_name: "SessionEnd", session_id: "smoke-a", reason: "exit" });
await runHook(wb, { hook_event_name: "SessionEnd", session_id: "smoke-b", reason: "exit" });
process.exitCode = !a.denied && b.denied && /stale_assumption/.test(b.reason) ? 0 : 1;
