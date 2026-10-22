// Where the MCP server's configuration comes from. MCP hosts start servers from a JSON config
// with args/env, often without a shell or an install step, so the server configures the
// checkout itself on first start (the same `.weft/` layout and git hooks as every adapter).
//
//   checkout  --dir, WEFT_ROOT, else the git toplevel of the cwd (else the client's MCP roots)
//   settings  --url/--repo/--agent/--task/--title/--priority/--prefix flags, then WEFT_URL,
//             WEFT_REPO, WEFT_AGENT, WEFT_TASK, WEFT_TITLE env, then .weft/mcp.json
//   token     WEFT_TOKEN env, then the checkout's .weft/token (config.tokenFile), then
//             ~/.config/weft/<repo>.token, then ~/.config/weft/token (the files `npx weft` writes)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, readConfigFile, type Loaded } from "../../adapters/claude-code/src/config";
import type { Host } from "../../adapters/claude-code/src/host";

export const CONFIG_REL = ".weft/mcp.json";

const FLAGS = ["url", "repo", "agent", "task", "title", "priority", "prefix", "change"] as const;
const ENV: Record<(typeof FLAGS)[number], string> = {
  url: "WEFT_URL",
  repo: "WEFT_REPO",
  agent: "WEFT_AGENT",
  task: "WEFT_TASK",
  title: "WEFT_TITLE",
  priority: "WEFT_PRIORITY",
  prefix: "WEFT_PREFIX",
  change: "WEFT_CHANGE",
};

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

export function gitTop(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The checkout to coordinate, or undefined when none is given and the cwd is not in git. */
export function findCheckout(args: string[], env: NodeJS.ProcessEnv, cwd: string = process.cwd()): string | undefined {
  const given = flag(args, "dir") ?? env.WEFT_ROOT;
  if (given) return gitTop(resolve(cwd, given.replace(/^~(?=$|\/)/, homedir()))) ?? resolve(cwd, given);
  return gitTop(cwd);
}

/** Token from ~/.config/weft (per repo first, then the default one). */
export function userToken(repo: string | undefined, home: string = homedir()): string | undefined {
  const dir = join(home, ".config", "weft");
  const files = [...(repo ? [join(dir, `${repo}.token`)] : []), join(dir, "token")];
  for (const f of files) {
    try {
      const t = readFileSync(f, "utf8").trim();
      if (t) return t;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Install flags for `host.install`, from flags then env (only the ones given). */
export function installArgs(root: string, args: string[], env: NodeJS.ProcessEnv): string[] {
  const out = ["--dir", root];
  for (const f of FLAGS) {
    const v = flag(args, f) ?? env[ENV[f]];
    if (v !== undefined && v !== "") out.push(`--${f}`, v);
  }
  return out;
}

/** True when flags/env name a setting that differs from the checkout's config file. */
function differs(root: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  const cfg = readConfigFile(root, CONFIG_REL);
  if (!cfg) return true;
  const cur: Record<string, unknown> = { url: cfg.url, repo: cfg.repo, agent: cfg.agent, task: cfg.task?.id, title: cfg.task?.title, prefix: cfg.prefix, change: cfg.change, priority: cfg.task?.priority === undefined ? undefined : String(cfg.task.priority) };
  return FLAGS.some((f) => {
    const v = flag(args, f) ?? env[ENV[f]];
    return v !== undefined && v !== "" && v !== cur[f];
  });
}

/** Run `fn` with process.stdout writes sent to stderr (stdout is the MCP channel). */
export function quietStdout<T>(fn: () => T): T {
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  try {
    return fn();
  } finally {
    process.stdout.write = write;
  }
}

export type Resolved = { loaded: Loaded } | { error: string };

/**
 * Configure (when needed) and load the checkout. Writes .weft/mcp.json, .weft/token (from
 * WEFT_TOKEN), the commit-msg/pre-commit git hooks and the .weft/bin/weft wrapper — exactly
 * what `weft-mcp install` does — when the checkout is not configured yet or flags/env changed.
 */
export function resolveConfig(host: Host, root: string, args: string[], env: NodeJS.ProcessEnv, home: string = homedir()): Resolved {
  if (!existsSync(root)) return { error: `checkout ${root} does not exist` };
  if (differs(root, args, env)) {
    const cfg = readConfigFile(root, CONFIG_REL);
    const want = installArgs(root, args, env);
    const has = (f: string) => want.includes(`--${f}`) || !!(cfg as Record<string, unknown> | undefined)?.[f];
    const missing = ["url", "repo", "agent"].filter((f) => !has(f));
    if (missing.length) return { error: `not configured: pass --${missing.join(", --")} (or ${missing.map((f) => ENV[f as (typeof FLAGS)[number]]).join(", ")}) in the MCP server config, or run \`weft-mcp install\` in ${root}` };
    try {
      quietStdout(() => host.install(want));
    } catch (err) {
      return { error: `install failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const repo = readConfigFile(root, CONFIG_REL)?.repo;
  const e = { ...env, WEFT_ROOT: root };
  let loaded = loadConfig(root, e, CONFIG_REL);
  if (!loaded && !env.WEFT_TOKEN) {
    const t = userToken(repo, home);
    if (t) loaded = loadConfig(root, { ...e, WEFT_TOKEN: t }, CONFIG_REL);
  }
  if (!loaded) return { error: `no Weft token for ${root}: set WEFT_TOKEN, write ${join(root, ".weft/token")} (mode 600), or ~/.config/weft/${repo ?? "<repo>"}.token` };
  return { loaded };
}
