// `weft-mcp` (bundled to dist/weft-mcp.mjs).
//
//   weft-mcp [serve] [--dir D] [--url U --repo R --agent A --task T --title …] [--channels]
//            stdio MCP server (the default command). Configures the checkout on first start.
//   weft-mcp install --url U --repo R --agent A --task T   write .weft/mcp.json (+ token, git hooks)
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox, claim)
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { Host } from "../../adapters/claude-code/src/host";
import { ADAPTER_VERSION } from "../../adapters/claude-code/src/hooks";
import { CONFIG_REL, findCheckout, flag, gitTop, resolveConfig } from "./config";
import { CAPABILITIES, INSTRUCTIONS, TOOLS, WeftMcp } from "./server";

const SELF = fileURLToPath(import.meta.url);
export const VERSION = "0.1.0";

export function makeHost(client?: string): Host {
  return new Host({
    name: "mcp",
    bin: "weft-mcp",
    configRel: CONFIG_REL,
    // The MCP client's name (e.g. "zed", "claude-code") is the harness the feed shows.
    harness: client ? `mcp:${client}` : "mcp",
    adapter: `@weft/mcp@${VERSION} (core ${ADAPTER_VERSION})`,
    capabilities: CAPABILITIES,
    self: SELF,
    installHarness: (root) => [`MCP server: add {"command": "npx", "args": ["-y", "@weft/mcp", "--dir", "${root}"]} to your harness's MCP config (see the @weft/mcp README)`],
  });
}

export const host = makeHost();

export type ServeOptions = {
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  transport?: McpTransport;
  /** Start the fs watcher + ticker (default true; tests drive flush/tick by hand). */
  watch?: boolean;
  log?: (line: string) => void;
};

/** Build and connect the MCP server. Resolves once connected; the Weft session starts after `initialized`. */
export async function serve(o: ServeOptions): Promise<{ server: Server; ready: Promise<WeftMcp | undefined>; close: () => Promise<void> }> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const channels = o.args.includes("--channels") || env.WEFT_MCP_CHANNELS === "1";
  const server = new Server(
    { name: "weft", version: VERSION },
    { capabilities: { tools: {}, ...(channels ? { experimental: { "claude/channel": {} } } : {}) }, instructions: INSTRUCTIONS },
  );
  let weft: WeftMcp | undefined;
  let failure: string | undefined;
  let markReady!: (w: WeftMcp | undefined) => void;
  const ready = new Promise<WeftMcp | undefined>((r) => (markReady = r));

  const boot = async () => {
    try {
      let root = findCheckout(o.args, env, o.cwd);
      if (!root && server.getClientCapabilities()?.roots) {
        // Hosts that start servers outside the project (no cwd) still tell us their roots.
        const { roots } = await server.listRoots().catch(() => ({ roots: [] as Array<{ uri: string }> }));
        for (const r of roots) {
          if (!r.uri.startsWith("file:")) continue;
          root = gitTop(fileURLToPath(r.uri));
          if (root) break;
        }
      }
      if (!root) throw new Error("no checkout: start the server inside a git repo, or pass --dir /path/to/checkout (or WEFT_ROOT)");
      const client = server.getClientVersion()?.name?.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const h = makeHost(client);
      const r = resolveConfig(h, root, o.args, env);
      if ("error" in r) throw new Error(r.error);
      weft = new WeftMcp(h, r.loaded, {
        log,
        ...(channels
          ? { push: (text: string) => server.notification({ method: "notifications/claude/channel", params: { content: text, meta: { source: "weft" } } }) }
          : {}),
      });
      await weft.start();
      if (o.watch !== false) weft.watch(Number(flag(o.args, "debounce") ?? 300), Number(flag(o.args, "tick") ?? 15_000));
      log(`[weft-mcp] serving ${root} as ${r.loaded.config.agent} (repo ${r.loaded.config.repo}, task ${r.loaded.config.task.id}) for ${client ?? "an MCP client"}`);
      markReady(weft);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      log(`[weft-mcp] not coordinating: ${failure}`);
      markReady(undefined);
    }
  };
  server.oninitialized = () => void boot();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const w = await ready;
    if (!w) return { content: [{ type: "text", text: `[weft] Weft is not active in this session: ${failure ?? "not started"}` }], isError: true };
    const r = await w.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) };
  });

  await server.connect(o.transport ?? new StdioServerTransport());
  const close = async () => {
    const w = weft;
    weft = undefined;
    await w?.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return { server, ready, close };
}

async function serveStdio(args: string[]): Promise<number> {
  const { close } = await serve({ args });
  await new Promise<void>((done) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      void close().finally(done);
    };
    process.stdin.once("end", end);
    process.stdin.once("close", end);
    process.once("SIGINT", end);
    process.once("SIGTERM", end);
  });
  return 0;
}

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv;
  if (cmd === "--version" || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cmd === undefined || cmd.startsWith("--")) {
    process.exitCode = await serveStdio(argv);
    return;
  }
  if (cmd === "serve") {
    process.exitCode = await serveStdio(argv.slice(1));
    return;
  }
  await host.main(argv, async () => {
    process.stderr.write("weft-mcp has no harness hook; it is an MCP server (run it with no command)\n");
    process.exitCode = 2;
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (process.env.WEFT_MCP_ENTRY === "1" || entry === SELF || /weft-mcp(\.mjs)?$/.test(entry)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`weft-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
