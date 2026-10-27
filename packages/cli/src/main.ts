// `npx @celador/weft`: one command from a git repo to coordinated coding agents.
//
//   weft [--local] [--url URL] [--agents N] [--harness a,b] [--repo NAME] [--yes] [--no-open]
//   weft demo [DIR]         a two-file sample repo (./weft-demo), set up, with the collision to try
//   weft add [NAME]         another worktree (one per parallel agent), Weft installed
//   weft status             gateway, space, checkouts, recent events, feed link
//   weft feed               live feed in the terminal
//   weft open               open the live feed in the browser
//   weft watch              report edits from this checkout (for tools without hooks)
//   weft mcp                stdio MCP server for this checkout (harnesses with MCP but no hooks)
//   weft uninstall [--space] remove Weft from this repo's checkouts (and delete the space)
//   weft deploy [--name N] [--domain HOST]   your own gateway on your Cloudflare account
//   weft local stop          stop the gateway started by --local
//   weft use hosted|local|URL   choose the default gateway
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Api, statusOf, type FeedEvent } from "./api";
import { MCP, WATCHER, adapterBin, detectHarnesses, ensureRuntime, harnessName, HARNESSES, installAdapter, installedIn, removeAdapters, startOrder, type HarnessId } from "./adapters";
import { deploy, ensureSpace, feedLink, hermesPointer, HOSTED_URL, HUMAN_TOKEN_FILE, kindOf, loadState, readPointer, saveState, sharedHumanToken, startLocal, stopLocal, writePointer, LOCAL_PORT, type HermesPointer } from "./gateways";
import { ask, c, configDir, git, info, mainCheckout, ok, openUrl, readJson, readSecret, slug, tilde, tryGit, VERSION, warn, WeftError, worktrees, writeJson } from "./util";

type Opts = {
  local: boolean;
  url?: string;
  agents?: number;
  harness?: HarnessId[];
  repo?: string;
  yes: boolean;
  open: boolean;
  space: boolean;
  name?: string;
  domain?: string;
  dir?: string;
  positional: string[];
};

export function parseArgs(argv: string[]): { cmd: string; o: Opts } {
  const o: Opts = { local: false, yes: false, open: true, space: false, positional: [] };
  let cmd = "init";
  const known = new Set(["init", "demo", "add", "status", "feed", "open", "watch", "uninstall", "deploy", "local", "use", "help", "version"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new WeftError(`${a} needs a value`);
      return v;
    };
    if (a === "--local") o.local = true;
    else if (a === "--url") o.url = val().replace(/\/+$/, "");
    else if (a === "--agents") o.agents = Number(val());
    else if (a === "--harness") o.harness = val().split(",").map((s) => s.trim()) as HarnessId[];
    else if (a === "--repo") o.repo = val();
    else if (a === "--name") o.name = val();
    else if (a === "--domain") o.domain = val();
    else if (a === "--dir") o.dir = val();
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--no-open") o.open = false;
    else if (a === "--space") o.space = true;
    else if (a === "-h" || a === "--help") cmd = "help";
    else if (a === "-v" || a === "--version") cmd = "version";
    else if (a.startsWith("-")) throw new WeftError(`unknown option ${a}`, "Run `npx @celador/weft help`.");
    else if (cmd === "init" && !o.positional.length && known.has(a)) cmd = a;
    else o.positional.push(a);
  }
  if (o.agents !== undefined && (!Number.isInteger(o.agents) || o.agents < 1 || o.agents > 8)) throw new WeftError("--agents must be 1-8");
  const ids = [...HARNESSES.map((h) => h.id), WATCHER.id];
  for (const h of o.harness ?? []) if (!ids.includes(h)) throw new WeftError(`unknown harness ${h}`, `Known: ${ids.join(", ")}`);
  return { cmd, o };
}

const HELP = `${c.bold("weft")} — red squiggles for teams of coding agents ${c.dim(`(v${VERSION})`)}

${c.bold("npx @celador/weft")}            in a git repo: free hosted space, hooks for your agents, live feed
  --agents N                  checkouts to coordinate (adds git worktrees next to the repo)
  --harness claude-code,codex only these harnesses (default: every one found on PATH)
  --local                     run the gateway on this machine instead (offline, nothing hosted)
  --url URL                   use another Weft gateway
  --yes / --no-open           no questions / do not open the browser

  demo [DIR]                  no repo handy? a two-file sample repo (./weft-demo) set up the same
                              way, with the two prompts that make the agents collide
  add [NAME]                  another worktree for one more parallel agent
  status                      what is set up here, and the feed link
  feed                        live feed in this terminal
  open                        open the live feed in your browser
  watch                       report edits made here by tools without hooks (file watcher)
  mcp                         MCP server for this checkout, for agents with MCP but no hooks
                              (Zed, Warp, JetBrains, Xcode, ...): {"command":"npx","args":["-y","@celador/weft","mcp","--dir","<checkout>"]}
  uninstall [--space]         remove Weft from this repo (--space also deletes your space)
  deploy [--name N] [--domain HOST]
                              your own gateway on your Cloudflare account (wrangler login)
  use hosted|local|URL        choose the default gateway
  local stop                  stop the local gateway

Docs: https://github.com/celador/weft/blob/main/docs/try-it.md`;

// ------------------------------------------------------------------ setup

function gitRoot(dir: string): string {
  const top = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new WeftError("this is not a git repository", "Run it inside your repo, or create one first: git init && git add -A && git commit -m init");
  return top;
}

function hasCommit(root: string): boolean {
  return tryGit(root, ["rev-parse", "--verify", "HEAD"]) !== undefined;
}

/** Add a linked worktree next to the main checkout: ../<repo>-<n> on branch <repo>-<n>. */
function addWorktree(main: string, name?: string): string {
  if (!hasCommit(main)) throw new WeftError("the repo has no commits yet, so there is nothing to check out in a second worktree", "Make a first commit: git add -A && git commit -m init");
  const base = basename(main);
  const taken = (d: string) => existsSync(join(dirname(main), d)) || tryGit(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${d}`]) !== undefined;
  const stem = name ? `${base}-${slug(name, 30)}` : base;
  let dirName = name ? stem : `${stem}-2`;
  for (let n = name ? 2 : 3; taken(dirName); n++) dirName = `${stem}-${n}`;
  const path = join(dirname(main), dirName);
  git(main, ["worktree", "add", "-q", "-b", dirName, path]);
  ok(`worktree ${c.bold(tilde(path))} ${c.dim(`(branch ${dirName})`)}`);
  return path;
}

const changeId = () => `I${createHash("sha1").update(randomBytes(32)).digest("hex")}`;

type Checkout = { root: string; agent: string; branch?: string };

function plan(roots: string[]): Checkout[] {
  const used = new Set<string>();
  return roots.map((root) => {
    let agent = slug(basename(root), 48);
    for (let i = 2; used.has(agent); i++) agent = `${slug(basename(root), 44)}-${i}`;
    used.add(agent);
    return { root, agent, branch: tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) };
  });
}

async function setupCheckout(api: Api, url: string, owner: string, space: string, repo: string, name: string, co: Checkout, harnesses: HarnessId[], rt: string): Promise<void> {
  const ptr = readPointer(co.root);
  const meta = readJson<{ tokenId?: string; agent?: string; change?: string; task?: string }>(join(co.root, ".weft", "space.json"), {});
  // Reuse a working agent token for the same gateway + repo; otherwise mint one.
  let token = ptr && ptr.url === url && ptr.repo === repo && meta.agent === co.agent ? readSecret(join(co.root, ".weft", "token")) : undefined;
  let tokenId = meta.tokenId;
  if (token) {
    try {
      await api.events(token, repo, "?limit=1");
    } catch (e) {
      if (statusOf(e) !== 401 && statusOf(e) !== 404) throw e;
      token = undefined;
    }
  }
  if (!token) {
    const t = await api.token(owner, { kind: "agent", repo, agent: co.agent, label: tilde(co.root) });
    token = t.token;
    tokenId = t.info.id;
  }
  const task = meta.task ?? `T-${slug(co.branch && co.branch !== "HEAD" ? co.branch : co.agent, 48)}`;
  const change = meta.change ?? changeId();
  const title = `${co.agent} (${co.branch ?? "detached"})`;
  for (const h of harnesses) installAdapter(rt, h, { root: co.root, url, repo, agent: co.agent, task, title, change, token });
  writePointer(co.root, { url, space, repo, name }, owner);
  writeJson(join(co.root, ".weft", "space.json"), { url, space, repo, name, agent: co.agent, tokenId, change, task, harnesses, weft: VERSION });
}

/** Under "Next": the other harnesses that work here, first-run prompts, MCP, the squiggle. Exported for tests. */
export function nextNotes(order: Array<{ id: string; name: string; run: string; note?: string }>, roots: string[]): string {
  const lines: string[] = [];
  if (order.length > 1) lines.push(`  ${c.dim("(or, in the same checkouts:")} ${order.slice(1).map((h) => h.run).join(c.dim(", "))}${c.dim(")")}`);
  const notes = order.filter((h) => h.note);
  if (notes.length) {
    lines.push("", c.bold("First run:"));
    for (const h of notes) lines.push(`  ${h.name} ${h.note}`);
  }
  lines.push(
    "",
    `When one agent changes code another agent depends on, the second one gets a red ${c.squiggle("squiggle")}`,
    `(a diagnostic with the other agent's diff) before it writes a conflicting edit.`,
    c.dim(`Agents with MCP but no hooks (Zed, Warp, JetBrains, Xcode, ...): add the MCP server ${MCP.run} --dir ${roots.length > 1 ? "<checkout>" : tilde(roots[0] ?? ".")}`),
    c.dim(`Agents already running must be restarted to load the hooks. More: npx @celador/weft status · feed · add · uninstall`),
    "",
  );
  return lines.join("\n");
}

async function init(o: Opts, addName?: string | true, fresh = false): Promise<string[]> {
  const cwd = resolve(o.dir ?? process.cwd());
  const top = gitRoot(cwd);
  const main = mainCheckout(top);
  console.log(`\n${c.bold("weft")} ${c.dim("·")} red ${c.squiggle("squiggles")} for teams of coding agents ${c.dim(`v${VERSION}`)}\n`);

  // 0. a Hermes adapter already reports this repo to a gateway: that is its feed. Use it rather than
  // creating a second, empty repo in a hosted space (--url / WEFT_URL / --local still choose).
  const hp = !fresh && !addName && !o.url && !process.env.WEFT_URL && !o.local && !readPointer(top) && !readPointer(main) ? hermesPointer([top, main]) : undefined;
  if (hp) {
    await hermesInit(hp);
    return [];
  }

  // 1. gateway
  const state = loadState();
  let url = o.local ? undefined : (o.url ?? process.env.WEFT_URL ?? state.default ?? HOSTED_URL);
  // --local, or `weft use local` as the default: start (or reuse) the gateway on this machine.
  const localDefault = !o.url && !process.env.WEFT_URL && url !== undefined && url === state.default && kindOf(url) === "local";
  if (o.local || localDefault) {
    const l = await startLocal();
    url = l.url;
    const s = loadState();
    s.gateways[url] = { ...(s.gateways[url] ?? { kind: "local" }), admin: l.admin };
    saveState(s);
  }
  const api = new Api(url!);
  await api.health();

  // 2. space + repo
  const name = slug(o.repo ?? basename(main), 48);
  const { gw, created } = await ensureSpace(api, url!, top, name);
  const where = kindOf(url!) === "hosted" ? "free hosted space on Cloudflare" : kindOf(url!) === "local" ? "local space" : "space";
  ok(`${created ? "created your" : "using your"} ${where} ${c.bold(gw.space!)} ${c.dim(`(${new URL(url!).host}; no account needed)`)}`);
  const r = await api.createRepo(gw.owner!, name);
  ok(`repo ${c.bold(name)} ${c.dim(r.created ? "(new)" : "(already there)")}`);

  // 3. checkouts: every worktree of the repo; offer a second one so two agents can work side by side
  let roots = worktrees(top).map((w) => w.path);
  if (addName !== undefined) roots = [addWorktree(main, addName === true ? undefined : addName)];
  else {
    let want = o.agents ?? roots.length;
    if (o.agents === undefined && roots.length === 1) {
      const two = o.yes ? true : await ask(`Add a second worktree (${tilde(join(dirname(main), `${basename(main)}-2`))}) so two agents can work side by side?`, true);
      if (two) want = 2;
    }
    while (roots.length < want) roots.push(addWorktree(main));
  }

  // 4. harnesses
  const det = detectHarnesses();
  let harnesses = o.harness ?? det.found;
  if (!harnesses.length) {
    warn(`no coding agent CLI found on PATH (${HARNESSES.map((h) => h.bins[0]).join(", ")}); installing the file watcher instead`);
    harnesses = [WATCHER.id];
  }
  const rt = ensureRuntime();
  const checkouts = plan(roots);
  for (const co of checkouts) {
    await setupCheckout(api, url!, gw.owner!, gw.space!, r.repo, name, co, harnesses, rt);
    ok(`${harnesses.map(harnessName).join(" + ")} ${c.dim("hooks in")} ${c.bold(tilde(co.root))} ${c.dim(`(agent ${co.agent})`)}`);
  }
  if (det.hermes && !o.harness) info(`Hermes Agent found: its Weft plugin installs per profile, see ${c.dim("https://github.com/celador/weft/tree/main/packages/adapters/hermes")}`);

  // 5. feed + next steps
  const link = feedLink(url!, gw.viewer!);
  console.log(`\n${c.bold("Live feed")} ${c.dim("(private to you; anyone with the link can read it)")}\n  ${c.cyan(link)}\n`);
  const order = startOrder(harnesses);
  const first = order[0]!;
  console.log(c.bold("Next:") + (checkouts.length > 1 ? " start one agent per checkout, each in its own terminal:" : " start your agent here:"));
  for (const co of checkouts) console.log(`  ${c.dim("$")} cd ${tilde(co.root)} && ${first.run}`);
  console.log(nextNotes(order, checkouts.map((co) => co.root)));
  if (o.open) openUrl(link);
  return checkouts.map((co) => co.root);
}

// ------------------------------------------------------------------ demo

/** The sample repo `weft demo` writes: one function, and a second file that will call it. Exported for tests. */
export const DEMO_FILES: Record<string, string> = {
  "package.json": '{ "name": "weft-demo", "private": true, "type": "module" }\n',
  "src/pricing.ts": "export type Item = { price: number; qty: number };\n\nexport function calcTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n",
  "src/cart.ts": 'import type { Item } from "./pricing";\n\nexport function renderCart(items: Item[]): string {\n  return items.map((i) => `${i.qty} x ${i.price}`).join("\\n");\n}\n',
  "README.md": "# weft-demo\n\nA two-file sample repo made by `npx @celador/weft demo`. See https://github.com/celador/weft/blob/main/docs/try-it.md\n",
};
export const DEMO_PROMPTS = [
  "In src/pricing.ts, make calcTotal take a second parameter opts: { taxRate: number } and multiply the total by (1 + opts.taxRate). Only edit src/pricing.ts.",
  "In src/cart.ts, add an exported function cartTotal(items: Item[]): string that returns calcTotal(items) from ./pricing formatted with toFixed(2).",
];

/** Create (or reuse) the sample repo with one commit. Works without a git identity. Returns its path. */
export function makeDemoRepo(dir: string): string {
  const root = resolve(dir);
  if (existsSync(join(root, ".git"))) {
    if (!existsSync(join(root, "src", "pricing.ts"))) throw new WeftError(`${tilde(root)} is already a git repo, and not a Weft demo`, "Pick another directory: npx @celador/weft demo <dir>");
    info(`demo repo ${c.bold(tilde(root))} ${c.dim("(already there)")}`);
    return root;
  }
  if (existsSync(root) && readdirSync(root).length) throw new WeftError(`${tilde(root)} exists and is not empty`, "Pick another directory: npx @celador/weft demo <dir>");
  for (const [f, text] of Object.entries(DEMO_FILES)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  // A first-time git user has no user.name/email; the demo commit must not fail on that.
  git(root, ["-c", "user.name=weft demo", "-c", "user.email=demo@weft.invalid", "commit", "-q", "-m", "weft demo"]);
  ok(`demo repo ${c.bold(tilde(root))} ${c.dim("(src/pricing.ts, src/cart.ts)")}`);
  return root;
}

async function demo(o: Opts): Promise<void> {
  const root = makeDemoRepo(o.positional[0] ?? join(resolve(o.dir ?? process.cwd()), "weft-demo"));
  const roots = await init({ ...o, dir: root, agents: Math.max(2, o.agents ?? 2) }, undefined, true);
  console.log(c.bold("Make them collide:") + " ask the agent in each checkout, in this order:");
  roots.slice(0, 2).forEach((r, i) => console.log(`  ${c.dim(tilde(r) + ":")} ${DEMO_PROMPTS[i]}`));
  console.log(c.dim("The second agent's edit is stopped with a stale_assumption squiggle and the first agent's diff; the feed shows both.\n"));
}

// ------------------------------------------------------------------ status / feed

function here(o: Opts): { root: string; main: string; ptr: ReturnType<typeof readPointer>; hp?: HermesPointer } {
  const root = gitRoot(resolve(o.dir ?? process.cwd()));
  const main = mainCheckout(root);
  const ptr = readPointer(root) ?? readPointer(main) ?? worktrees(root).map((w) => readPointer(w.path)).find(Boolean);
  return { root, main, ptr, hp: ptr ? undefined : hermesPointer([root, main]) };
}

const humanTokenHint = (url: string) =>
  `Put a human token for ${url} in ${tilde(join(configDir(), HUMAN_TOKEN_FILE))} as {"url","token"} (the hermes-ios relay writes it), or set WEFT_TOKEN.`;

/** `npx @celador/weft` in a repo the Hermes adapter already reports: show that feed, create nothing. */
async function hermesInit(hp: HermesPointer): Promise<void> {
  const api = new Api(hp.url);
  await api.health();
  ok(`this repo already reports to ${c.bold(hp.url)} as ${c.bold(hp.repo)} ${c.dim(`(Hermes adapter, ${tilde(hp.config)})`)}`);
  info("Using that feed. No hosted space was created and nothing was written to this repo.");
  const tok = process.env.WEFT_TOKEN?.trim() || sharedHumanToken(hp.url);
  if (!tok) {
    warn(`no human token for this gateway. ${humanTokenHint(hp.url)}`);
    return;
  }
  try {
    const ev = await api.events(tok, hp.repo, "?tail=1&limit=5");
    console.log(c.bold("recent events") + c.dim(` (head #${ev.head_seq})`));
    if (!ev.events.length) console.log(c.dim("  none yet"));
    for (const e of ev.events) console.log(formatEvent(e));
  } catch (e) {
    warn(`events unavailable: ${(e as Error).message}`);
  }
  console.log(`\n${c.bold("Next")}  ${c.cyan("npx @celador/weft feed")} ${c.dim("(the same events Otto and the VS Code extension show)")}`);
}

function viewerFor(url: string): string | undefined {
  return loadState().gateways[url]?.viewer;
}

const when = (ts: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : new Date(ts).toLocaleString();
};

export function formatEvent(e: FeedEvent, space?: string): string {
  const repo = space && e.repo.startsWith(`${space}-`) ? e.repo.slice(space.length + 1) : e.repo;
  const st = e.status === "accepted" ? c.green(e.status) : e.status === "rejected" ? c.red(e.status) : e.status ? c.yellow(e.status) : "";
  const who = e.agent ?? e.actor?.id ?? "system";
  const lines = [`${c.dim(`#${e.seq}`.padStart(6))} ${c.bold(who)} ${c.dim(e.kind)} ${st} ${c.blue(repo)} ${c.dim(when(e.ts))}`];
  if (e.summary) lines.push(`       ${c.dim(e.summary)}`);
  for (const d of e.diagnostics ?? []) {
    const at = d.file ? ` ${d.file}${d.range ? `:${d.range.start.line + 1}` : ""}` : "";
    lines.push(`       ${d.severity === "error" ? c.red(c.squiggle(d.code)) : c.yellow(c.squiggle(d.code))}${at}${d.caused_by_agent ? c.dim(` (caused by ${d.caused_by_agent})`) : ""}`);
    lines.push(`         ${d.message.split("\n")[0]!.slice(0, 220)}`);
  }
  return lines.join("\n");
}

async function status(o: Opts): Promise<void> {
  const { root, main, ptr, hp } = here(o);
  if (!ptr && hp) {
    let up = true;
    try {
      await new Api(hp.url).health();
    } catch {
      up = false;
    }
    console.log(`${c.bold("gateway")}  ${hp.url} ${up ? c.green("up") : c.red("unreachable")} ${c.dim(`(Hermes adapter, ${tilde(hp.config)})`)}`);
    console.log(`${c.bold("repo")}     ${hp.repo} ${c.dim(`(project ${tilde(hp.project)})`)}`);
    const tok = process.env.WEFT_TOKEN?.trim() || sharedHumanToken(hp.url);
    console.log(`${c.bold("token")}    ${tok ? `human ${c.dim(`(${process.env.WEFT_TOKEN?.trim() ? "WEFT_TOKEN" : tilde(join(configDir(), HUMAN_TOKEN_FILE))})`)}` : c.red("none")}`);
    if (tok && up) {
      try {
        const ev = await new Api(hp.url).events(tok, hp.repo, "?tail=1&limit=5");
        console.log(c.bold(`recent events`) + c.dim(` (head #${ev.head_seq})`));
        for (const e of ev.events) console.log(formatEvent(e));
      } catch (e) {
        console.log(c.dim(`  (events unavailable: ${(e as Error).message})`));
      }
    }
    return;
  }
  if (!ptr) {
    console.log(`Weft is not set up in ${tilde(root)}. Run ${c.bold("npx @celador/weft")} here.`);
    return;
  }
  const api = new Api(ptr.url);
  let up = true;
  try {
    await api.health();
  } catch {
    up = false;
  }
  console.log(`${c.bold("gateway")}  ${ptr.url} ${up ? c.green("up") : c.red("unreachable")} ${c.dim(`(${kindOf(ptr.url)})`)}`);
  console.log(`${c.bold("space")}    ${ptr.space}`);
  console.log(`${c.bold("repo")}     ${ptr.name} ${c.dim(`(${ptr.repo})`)}`);
  console.log(c.bold("checkouts"));
  for (const w of worktrees(main)) {
    const m = readJson<{ agent?: string; harnesses?: string[] }>(join(w.path, ".weft", "space.json"), {});
    const inst = installedIn(w.path);
    const tok = readSecret(join(w.path, ".weft", "token"));
    let tokOk = "";
    if (tok && up && m.agent) {
      try {
        await api.events(tok, ptr.repo, "?limit=1");
        tokOk = c.green("token ok");
      } catch {
        tokOk = c.red("token rejected (run npx @celador/weft again)");
      }
    }
    console.log(`  ${w.path === root ? c.cyan("›") : " "} ${tilde(w.path)}  ${m.agent ? `${c.bold(m.agent)} ${c.dim(inst.map(harnessName).join(", "))} ${tokOk}` : c.dim("not set up (npx @celador/weft adds it)")}`);
  }
  const viewer = viewerFor(ptr.url);
  if (viewer && up) {
    try {
      const ev = await api.events(viewer, ptr.repo, "?tail=1&limit=5");
      console.log(c.bold(`recent events`) + c.dim(` (head #${ev.head_seq})`));
      if (!ev.events.length) console.log(c.dim("  none yet: start an agent in one of the checkouts"));
      for (const e of ev.events) console.log(formatEvent(e, ptr.space));
    } catch (e) {
      console.log(c.dim(`  (events unavailable: ${(e as Error).message})`));
    }
    console.log(`${c.bold("feed")}     ${c.cyan(feedLink(ptr.url, viewer))}`);
  } else if (!viewer) console.log(c.dim("feed     (this machine does not hold the space's viewer key; run npx @celador/weft once to get a link)"));
}

async function feed(o: Opts): Promise<void> {
  const { ptr, hp } = here(o);
  if (!ptr && hp) return hermesFeed(hp);
  if (!ptr) throw new WeftError("Weft is not set up in this repo", "Run npx @celador/weft first.");
  const viewer = viewerFor(ptr.url);
  if (!viewer) throw new WeftError("this machine has no viewer key for the space", "Run npx @celador/weft once in this repo.");
  const api = new Api(ptr.url);
  console.log(c.dim(`live feed for space ${ptr.space} on ${ptr.url} (Ctrl-C to stop)\n`));
  let cursor: string | undefined;
  for (;;) {
    try {
      const page = await api.feed(viewer, cursor ? `?after=${encodeURIComponent(cursor)}&limit=200` : "?tail=1&limit=20");
      for (const e of page.events) console.log(formatEvent(e, ptr.space));
      if (page.cursor) cursor = page.cursor;
      if (page.has_more) continue;
    } catch (e) {
      console.log(c.red(`  ${(e as Error).message}; retrying`));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** The live feed of the repo the Hermes adapter reports to, read with the shared human token. */
async function hermesFeed(hp: HermesPointer): Promise<void> {
  const tok = process.env.WEFT_TOKEN?.trim() || sharedHumanToken(hp.url);
  if (!tok) throw new WeftError(`no human token for ${hp.url}`, humanTokenHint(hp.url));
  const api = new Api(hp.url);
  console.log(c.dim(`live feed for ${hp.repo} on ${hp.url} via the Hermes adapter (Ctrl-C to stop)\n`));
  let after: number | undefined;
  for (;;) {
    try {
      const page = await api.events(tok, hp.repo, after === undefined ? "?tail=1&limit=20" : `?after=${after}&limit=200`);
      for (const e of page.events) console.log(formatEvent(e));
      after = page.events.at(-1)?.seq ?? after ?? page.head_seq;
      if (page.has_more) continue;
    } catch (e) {
      console.log(c.red(`  ${(e as Error).message}; retrying`));
    }
    if (process.env.WEFT_FEED_ONCE === "1") return; // tests
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ------------------------------------------------------------------ uninstall / watch / use

async function uninstall(o: Opts): Promise<void> {
  const { main, ptr } = here(o);
  const owner = ptr ? (loadState().gateways[ptr.url]?.owner ?? readSecret(join(main, ".weft", "space-token"))) : undefined;
  const api = ptr ? new Api(ptr.url) : undefined;
  let n = 0;
  for (const w of worktrees(main)) {
    const m = readJson<{ tokenId?: string }>(join(w.path, ".weft", "space.json"), {});
    if (api && owner && m.tokenId) await api.revoke(owner, m.tokenId).catch(() => undefined);
    const touched = removeAdapters(w.path);
    if (touched.length) {
      n++;
      ok(`removed Weft from ${tilde(w.path)} ${c.dim(`(${touched.join(", ")})`)}`);
    }
  }
  if (!n) info("Weft was not installed in this repo's checkouts");
  if (o.space && ptr && api && owner) {
    const go = o.yes || (await ask(`Delete space ${ptr.space} and everything in it (all repos, every machine)?`, false));
    if (go) {
      await api.deleteSpace(owner);
      const s = loadState();
      delete s.gateways[ptr.url];
      saveState(s);
      ok(`deleted space ${ptr.space}`);
    }
  }
  console.log(c.dim("Worktrees Weft added are left as they are; remove one with: git worktree remove <path>"));
}

function watch(o: Opts): void {
  const root = gitRoot(resolve(o.dir ?? process.cwd()));
  if (!existsSync(join(root, WATCHER.config))) throw new WeftError("the file watcher is not installed in this checkout", "Run: npx @celador/weft --harness watcher");
  const rt = ensureRuntime();
  const r = spawnSync(process.execPath, [adapterBin(rt, "watcher"), "run"], { cwd: root, stdio: "inherit" });
  process.exitCode = r.status ?? 0;
}

/**
 * `weft mcp [--dir D] [server flags]`: the stdio MCP server (packages/mcp) for a checkout. Flags
 * not given are filled from what `weft` set up there (.weft/space.json); the server reads the
 * agent key from .weft/token. All arguments go to the server as they are, so the flag forms in
 * packages/mcp/README.md work. stdout belongs to MCP: print nothing.
 */
export function mcpArgs(args: string[], cwd: string): string[] {
  const at = args.indexOf("--dir");
  const dir = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : (process.env.WEFT_ROOT ?? cwd));
  const root = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  const m = root ? readJson<{ url?: string; repo?: string; agent?: string; task?: string }>(join(root, ".weft", "space.json"), {}) : {};
  const has = (f: string) => args.includes(`--${f}`);
  if (!m.agent && !has("agent") && !(root && existsSync(join(root, MCP.config))))
    throw new WeftError(`Weft is not set up in ${tilde(root ?? dir)}`, "Run npx @celador/weft in the repo first (it sets up every checkout), then start the MCP server with npx -y @celador/weft mcp --dir <checkout>.");
  const out = ["serve", ...args];
  if (root && at < 0) out.push("--dir", root);
  const fill: Array<[string, string | undefined]> = [["url", m.url], ["repo", m.repo], ["agent", m.agent], ["task", m.task], ["title", m.agent && `${m.agent} (MCP)`]];
  for (const [f, v] of fill) if (v && !has(f)) out.push(`--${f}`, v);
  return out;
}

function mcp(args: string[]): void {
  const argv = mcpArgs(args, process.cwd());
  const rt = ensureRuntime();
  const r = spawnSync(process.execPath, [adapterBin(rt, "mcp"), ...argv], { stdio: "inherit" });
  process.exitCode = r.status ?? 0;
}

function use(o: Opts): void {
  const target = o.positional[0];
  if (!target) throw new WeftError("use needs hosted, local or a gateway URL");
  const localPort = Number(readSecret(join(configDir(), "local", "port"))) || LOCAL_PORT;
  const url = target === "hosted" ? HOSTED_URL : target === "local" ? `http://127.0.0.1:${localPort}` : target.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new WeftError(`not a URL: ${target}`);
  const s = loadState();
  s.default = url;
  saveState(s);
  ok(`default gateway: ${url}. Run npx @celador/weft in a repo to move it there.`);
}

// ------------------------------------------------------------------ entry

export async function main(argv: string[]): Promise<number> {
  // `mcp` passes its flags to the MCP server untouched (see mcpArgs)
  if (argv[0] === "mcp") {
    mcp(argv.slice(1));
    return 0;
  }
  const { cmd, o } = parseArgs(argv);
  switch (cmd) {
    case "help":
      console.log(HELP);
      return 0;
    case "version":
      console.log(VERSION);
      return 0;
    case "init":
      await init(o);
      return 0;
    case "demo":
      await demo(o);
      return 0;
    case "add":
      await init({ ...o, open: false }, o.positional[0] ?? true);
      return 0;
    case "status":
      await status(o);
      return 0;
    case "feed":
      await feed(o);
      return 0;
    case "open": {
      const { ptr } = here(o);
      const v = ptr && viewerFor(ptr.url);
      if (!ptr || !v) throw new WeftError("no feed link here yet", "Run npx @celador/weft first.");
      console.log(feedLink(ptr.url, v));
      openUrl(feedLink(ptr.url, v));
      return 0;
    }
    case "watch":
      watch(o);
      return 0;
    case "uninstall":
      await uninstall(o);
      return 0;
    case "deploy": {
      const { url } = await deploy({ name: o.name ?? "weft-gateway", ...(o.domain ? { domain: o.domain } : {}) });
      console.log(`\nNext: run ${c.bold("npx @celador/weft")} in a repo; it now uses ${url}. Back to the free hosted one: npx @celador/weft use hosted`);
      return 0;
    }
    case "local":
      if (o.positional[0] === "stop") {
        console.log((await stopLocal()) ? "local gateway stopped" : "no local gateway was running");
        return 0;
      }
      throw new WeftError("usage: weft local stop   (start it with: npx @celador/weft --local)");
    case "use":
      use(o);
      return 0;
  }
  console.log(HELP);
  return 2;
}

const entry = process.argv[1] ? readFileSync(process.argv[1], "utf8").slice(0, 200) : "";
if (entry.includes("@celador/weft") || process.env.WEFT_CLI_MAIN === "1") {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      if (err instanceof WeftError) {
        console.error(`${c.red("✗")} ${err.message}`);
        if (err.hint) console.error(`  ${c.dim(err.hint)}`);
      } else console.error(err);
      process.exitCode = 1;
    },
  );
}
