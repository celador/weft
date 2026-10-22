// `wcp-hook-conformance` — standalone conformance runner for Agent Hooks Core v0.
//
//   wcp-hook-conformance run --dialect <d> [--setup '<shell>'] [--json F] [--md F] [--env K=V]…
//                            [--timeout MS] [--only ID,ID] [--subject NAME] [--require-level N] -- <hook command…>
//   wcp-hook-conformance bridge --dialect <d> -- <native hook command…>
//   wcp-hook-conformance fixtures [core|python|<dir>]
//
// `run` drives the hook command (stdin JSON -> stdout JSON, one process per event, the
// way every reviewed harness runs command hooks) through the core fixtures, spelled in
// the chosen host dialect, against a local WCP reference coordinator (the oracle), and
// prints which capability levels the hook actually delivers.
//
// `bridge` turns a native hook into a core-binding hook: it reads a core event on stdin,
// re-spells it in the dialect, runs the native command, and answers a core decision.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HOOKS_CORE_VERSION, type CoreEvent } from "./core";
import { DIALECTS, dialect } from "./dialects";
import { absolutize, fixtureSetDir, invoke, loadFixtures, renderMarkdown, run, RUNNER_VERSION } from "./runner";

const USAGE = `wcp-hook-conformance ${RUNNER_VERSION} — Agent Hooks Core v${HOOKS_CORE_VERSION} conformance

usage:
  wcp-hook-conformance run --dialect <${Object.keys(DIALECTS).join("|")}> [options] -- <hook command…>
      --setup '<shell>'   run once per fixture in the fresh workspace before any event;
                          {url} {repo} {agent} {task} {workspace} are substituted, and the same
                          values are in the environment as WCP_URL WCP_REPO WCP_AGENT WCP_TASK
                          WCP_TOKEN WCP_WORKSPACE (the oracle coordinator for this fixture)
      --json <file>       write the machine-readable report
      --md <file>         write the Markdown report
      --env K=V           extra environment for setup and hook (repeatable)
      --timeout <ms>      per-invocation budget (default 30000, Cursor's default hook timeout)
      --only <ids>        comma-separated fixture ids
      --fixtures <set>    fixture set: core (default), a language (python, ...), or a directory
      --subject <name>    name shown in the report
      --require-level N   exit 1 unless at least L<N> is verified
  wcp-hook-conformance bridge --dialect <d> -- <native hook command…>
  wcp-hook-conformance fixtures [core|python|<dir>]

Exit status of run: 0 when the declaration is honest (declared level <= verified level)
and --require-level (if given) is met; 1 otherwise.`;

function split(argv: string[]): { opts: string[]; command: string[] } {
  const i = argv.indexOf("--");
  return i < 0 ? { opts: argv, command: [] } : { opts: argv.slice(0, i), command: argv.slice(i + 1) };
}

function opt(opts: string[], name: string): string | undefined {
  const i = opts.indexOf(`--${name}`);
  return i >= 0 ? opts[i + 1] : undefined;
}

function opts_all(opts: string[], name: string): string[] {
  const out: string[] = [];
  opts.forEach((o, i) => o === `--${name}` && opts[i + 1] !== undefined && out.push(opts[i + 1]!));
  return out;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { opts, command } = split(argv);
  const d = opt(opts, "dialect");
  if (!d || !command.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const env = Object.fromEntries(opts_all(opts, "env").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  const report = await run({
    dialect: d,
    command,
    setup: opt(opts, "setup"),
    timeoutMs: opt(opts, "timeout") ? Number(opt(opts, "timeout")) : undefined,
    env,
    only: opt(opts, "only")?.split(","),
    subject: opt(opts, "subject"),
    ...(opt(opts, "fixtures") ? { fixturesDir: fixtureSetDir(opt(opts, "fixtures")!) } : {}),
    log: (l) => process.stderr.write(`${l}\n`),
  });
  const md = renderMarkdown(report);
  for (const [flag, body] of [["json", JSON.stringify(report, null, 2) + "\n"], ["md", md]] as const) {
    const p = opt(opts, flag);
    if (p) {
      mkdirSync(dirname(resolve(p)), { recursive: true });
      writeFileSync(resolve(p), body);
    }
  }
  process.stdout.write(md);
  const need = opt(opts, "require-level");
  const ok = report.honest !== false && (need === undefined || report.verified_level >= Number(need));
  return ok ? 0 : 1;
}

async function cmdBridge(argv: string[]): Promise<number> {
  const { opts, command } = split(argv);
  const name = opt(opts, "dialect");
  if (!name || !command.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const d = dialect(name);
  let ev: CoreEvent;
  try {
    ev = JSON.parse(await readStdin()) as CoreEvent;
  } catch {
    process.stdout.write(JSON.stringify({ hooks: HOOKS_CORE_VERSION, decision: "allow" }));
    return 0;
  }
  const native = d.encode(ev);
  if (native === undefined) {
    process.stdout.write(JSON.stringify({ hooks: HOOKS_CORE_VERSION, decision: "allow", reply_to: ev.id }));
    return 0;
  }
  const raw = await invoke(absolutize(command), JSON.stringify(native), ev.cwd || process.cwd(), process.env, 60_000);
  const { decision } = d.decode(ev, raw);
  process.stdout.write(JSON.stringify({ ...decision, reply_to: ev.id }));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case "run":
      return cmdRun(argv.slice(1));
    case "bridge":
      return cmdBridge(argv.slice(1));
    case "fixtures": {
      const { fixtures } = loadFixtures(argv[1] ? fixtureSetDir(argv[1]) : undefined);
      for (const f of fixtures) process.stdout.write(`${f.id.padEnd(28)} ${f.level === null ? "failure" : `L${f.level}${f.required ? "" : "?"}`}  ${f.title}\n`);
      return 0;
    }
    case "--version":
      process.stdout.write(`${RUNNER_VERSION}\n`);
      return 0;
    default:
      process.stdout.write(`${USAGE}\n`);
      return argv.length ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    process.stderr.write(`wcp-hook-conformance: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  },
);
