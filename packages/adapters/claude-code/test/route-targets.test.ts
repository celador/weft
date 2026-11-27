// routeTargets (issue #11): the one path-routing rule behind `hook --by-path` in Cursor, OpenCode,
// Gemini and Codex, whose single hook config serves a session and the work it delegates.
import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byPathHookArgs, callTargets, configStarts, pinFromArgs, routeTargets, type Pin } from "../src/config";
import type { HookInput } from "../src/hooks";
import { checkout } from "./helpers";
import { adapterLog } from "./translator-kit";

const REL = ".weft/cursor.json";
const URL = "https://weft.example.test";
const PIN: Pin = { url: URL, repo: "demo", mode: "enforce" };

/** A checkout joined with REL as `agent` (token file under .weft/). */
function joined(name: string, agent: string, over: Record<string, unknown> = {}): string {
  const root = checkout(name);
  mkdirSync(join(root, ".weft"), { recursive: true });
  writeFileSync(join(root, REL), JSON.stringify({ url: URL, repo: "demo", agent, task: { id: `T-${agent}` }, change: `I${agent}`, mode: "enforce", ...over }));
  writeFileSync(join(root, ".weft/token"), "tok-" + agent);
  return root;
}

const route = (targets: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => routeTargets(targets, cwd, PIN, REL, env);

describe("routeTargets (issue #11)", () => {
  it("an edit in another joined checkout is that checkout's agent; the session's own checkout, an unjoined one, or no checkout stays plain", () => {
    const parent = checkout("rt-parent");
    const wt = joined("rt-wt", "worker-w");
    const r = route([join(wt, "src/cart.ts")], parent);
    expect(r.kind).toBe("routed");
    expect(r.kind === "routed" && r.loaded).toMatchObject({ root: wt, token: "tok-worker-w", config: { agent: "worker-w" } });
    expect(route([join(parent, "src/cart.ts")], parent)).toEqual({ kind: "plain" });
    expect(route([join(checkout("rt-unjoined"), "src/x.ts")], parent)).toEqual({ kind: "plain" });
    expect(route(["/nonexistent-weft-dir/x.ts"], parent)).toEqual({ kind: "plain" });
    expect(route([], parent)).toEqual({ kind: "plain" });
    // the session's own joined checkout is plain too (its config loads as without --by-path)
    const own = joined("rt-own", "parent-a");
    expect(route([join(own, "src/cart.ts")], own)).toEqual({ kind: "plain" });
  });

  it("a parent's WEFT_TOKEN, WEFT_URL and WEFT_MODE never reach the routed checkout", () => {
    const wt = joined("rt-env", "worker-e");
    const r = route([join(wt, "src/a.ts")], checkout("rt-env-parent"), { WEFT_TOKEN: "parent-token", WEFT_URL: "https://evil.example", WEFT_MODE: "advise" });
    expect(r.kind === "routed" && r.loaded).toMatchObject({ token: "tok-worker-e", config: { url: URL, mode: "enforce" } });
  });

  it("a config that does not match the pin, or with no pin at all, is refused and logged in that checkout; so is one that does not load", () => {
    const parent = checkout("rt-pin-parent");
    const other = joined("rt-other", "worker-o", { url: "https://elsewhere.example" });
    expect(route([join(other, "src/a.ts")], parent)).toMatchObject({ kind: "refused", root: other });
    expect(adapterLog(other)).toContain("do not match the pinned coordinator");
    const advise = joined("rt-advise", "worker-a", { mode: "advise" });
    expect(route([join(advise, "src/a.ts")], parent).kind).toBe("refused");
    const nopin = joined("rt-nopin", "worker-n");
    expect(routeTargets([join(nopin, "src/a.ts")], parent, undefined, REL, {}).kind).toBe("refused");
    const broken = checkout("rt-broken");
    mkdirSync(join(broken, ".weft"));
    writeFileSync(join(broken, REL), "{not json");
    expect(route([join(broken, "src/a.ts")], parent)).toMatchObject({ kind: "refused", root: broken });
    expect(adapterLog(broken)).toContain("exists but does not load (.weft/cursor.json is unreadable or not JSON (invalid JSON))");
    // a token file outside .weft/ is not read (a repo-shipped config must not send another file as the token)
    const leak = joined("rt-leak", "worker-l", { tokenFile: "src/cart.ts" });
    expect(route([join(leak, "src/a.ts")], parent).kind).toBe("refused");
  });

  it("a path with `..` or through a symlink cannot be placed lexically: plain, as without --by-path", () => {
    const parent = checkout("rt-link-parent");
    const wt = joined("rt-link-wt", "worker-s");
    expect(route([`${wt}/src/../src/a.ts`], parent)).toEqual({ kind: "plain" });
    symlinkSync(join(wt, "src"), join(parent, "linked"));
    expect(route([join(parent, "linked/a.ts")], parent)).toEqual({ kind: "plain" });
    symlinkSync(join(parent, "src"), join(wt, "back"));
    expect(route([join(wt, "back/cart.ts")], parent)).toEqual({ kind: "plain" });
  });

  it("targets in two checkouts, or in one routed checkout and the session's own, are split", () => {
    const own = joined("rt-split-own", "parent-s");
    const a = joined("rt-split-a", "worker-a");
    const b = joined("rt-split-b", "worker-b");
    expect(route([join(a, "x.ts"), join(b, "y.ts")], own)).toEqual({ kind: "split", roots: [a, b] });
    expect(route([join(a, "x.ts"), join(own, "y.ts")], own)).toEqual({ kind: "split", roots: [a, own] });
    // a file in no checkout next to a routed one does not split it (plain would ignore it too)
    expect(route([join(a, "x.ts"), "/nonexistent-weft-dir/y.ts"], own).kind).toBe("routed");
  });

  it("callTargets: the edited file or a Bash command's leading target; configStarts keeps its Claude Code meaning for any config name", () => {
    const parent = checkout("rt-ct-parent");
    const wt = joined("rt-ct-wt", "worker-c");
    const edit = { hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Edit", tool_input: { file_path: join(wt, "src/a.ts") } } as HookInput;
    const bash = (command: string) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Bash", tool_input: { command } }) as HookInput;
    expect(callTargets(edit, parent)).toEqual([join(wt, "src/a.ts")]);
    expect(callTargets(bash(`cd ${wt} && npm test`), parent)).toEqual([wt]);
    expect(callTargets(bash("npm test"), parent)).toEqual([]);
    expect(callTargets({ hook_event_name: "Stop", session_id: "s" }, parent)).toEqual([]);
    expect(configStarts(edit, true, parent, REL)).toEqual([wt]);
    expect(configStarts(edit, true, parent)).toEqual([]); // no .weft/claude.json there
    expect(configStarts(edit, false, parent, REL)).toEqual([parent]);
  });

  it("byPathHookArgs round-trips through pinFromArgs", () => {
    expect(pinFromArgs(byPathHookArgs({ url: URL, repo: "demo" }))).toEqual(PIN);
    expect(pinFromArgs(byPathHookArgs({ url: URL, repo: "demo", mode: "advise" }))).toEqual({ ...PIN, mode: "advise" });
  });
});
