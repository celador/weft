#!/usr/bin/env node
// stdio MCP server: import the bundle in-process (a child process would need stdin/stdout piping).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.WEFT_MCP_ENTRY = "1";
await import(pathToFileURL(join(here, "..", "dist", "weft-mcp.mjs")).href);
