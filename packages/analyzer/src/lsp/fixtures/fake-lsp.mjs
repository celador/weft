#!/usr/bin/env node
// A fake language server for the `lsp` backend's unit tests. Speaks LSP over stdio and knows a
// toy Python: a declaration is `def NAME(` / `class NAME` (methods qualified by nothing — the
// fake resolves by bare name across the workspace, so it "sees through" re-exports the way a real
// server does). Open documents override the disk.
//
//   definition   identifier at the position -> its `def`/`class` line in any workspace file
//                (never an `import` line)
//   references   every whole-word use of the name outside its declaration and import lines
//   diagnostics  on didOpen/didChange: `NAME(args)` whose arg count differs from the declared
//                parameter count (self excluded) -> error "fake: NAME takes N arguments"
//
// FAKE_LSP_LOG=<file> appends every received method (one per line) for assertions.
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let root = process.cwd();
const docs = new Map(); // uri -> { text, version }
const log = (m) => process.env.FAKE_LSP_LOG && appendFileSync(process.env.FAKE_LSP_LOG, `${m}\n`);

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function files(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (name.endsWith(".py")) out.push(p);
  }
  return out;
}
const uriOf = (p) => pathToFileURL(p).href;
const textOf = (uri) => docs.get(uri)?.text ?? readFileSync(fileURLToPath(uri), "utf8");
const allUris = () => [...new Set([...files().map(uriOf), ...docs.keys()])];

function wordAt(text, line, character) {
  const l = text.split("\n")[line] ?? "";
  let s = character;
  let e = character;
  while (s > 0 && /\w/.test(l[s - 1])) s--;
  while (e < l.length && /\w/.test(l[e])) e++;
  return l.slice(s, e);
}

function declaration(name) {
  for (const uri of allUris()) {
    const lines = textOf(uri).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = new RegExp(`^(\\s*)(?:def|class)\\s+(${name})\\b`).exec(lines[i]);
      if (m) {
        const character = lines[i].indexOf(name, m[1].length);
        return { uri, line: i, character, params: params(lines[i]) };
      }
    }
  }
  return undefined;
}
function params(line) {
  const m = /\(([^)]*)\)/.exec(line);
  if (!m) return 0;
  return m[1].split(",").map((s) => s.trim()).filter((s) => s && s !== "self" && s !== "cls").length;
}
const range = (line, character, length) => ({ start: { line, character }, end: { line, character: character + length } });

function references(name) {
  const decl = declaration(name);
  const out = [];
  for (const uri of allUris()) {
    const lines = textOf(uri).split("\n");
    lines.forEach((l, i) => {
      if (/^\s*(from|import)\b/.test(l)) return;
      for (const m of l.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
        if (decl && decl.uri === uri && decl.line === i) continue;
        out.push({ uri, range: range(i, m.index, name.length) });
      }
    });
  }
  return out;
}

function publish(uri) {
  const doc = docs.get(uri);
  const diagnostics = [];
  doc.text.split("\n").forEach((l, i) => {
    if (/^\s*(def|class|from|import)\b/.test(l)) return;
    for (const m of l.matchAll(/(\w+)\(/g)) {
      const d = declaration(m[1]);
      if (!d) continue;
      // Count top-level arguments up to the matching parenthesis.
      let depth = 0;
      let args = 0;
      let any = false;
      let end = m.index + m[0].length;
      for (; end < l.length; end++) {
        const ch = l[end];
        if (ch === "(") depth++;
        else if (ch === ")") {
          if (depth === 0) break;
          depth--;
        } else if (ch === "," && depth === 0) args++;
        if (!/\s/.test(ch)) any = true;
      }
      const n = any ? args + 1 : 0;
      if (n !== d.params) diagnostics.push({ range: range(i, m.index, end + 1 - m.index), severity: 1, source: "fake", message: `fake: ${m[1]} takes ${d.params} arguments` });
    }
  });
  send({ method: "textDocument/publishDiagnostics", params: { uri, version: doc.version, diagnostics } });
}

function handle(msg) {
  if (msg.method) log(msg.method);
  switch (msg.method) {
    case "initialize":
      root = fileURLToPath(msg.params.rootUri);
      return send({ id: msg.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, referencesProvider: true } } });
    case "initialized":
      // Exercise server -> client requests like a real server does.
      return send({ id: 9001, method: "workspace/configuration", params: { items: [{ section: "python.analysis" }] } });
    case "textDocument/didOpen":
      docs.set(msg.params.textDocument.uri, { text: msg.params.textDocument.text, version: msg.params.textDocument.version });
      return publish(msg.params.textDocument.uri);
    case "textDocument/didChange":
      docs.set(msg.params.textDocument.uri, { text: msg.params.contentChanges.at(-1).text, version: msg.params.textDocument.version });
      for (const uri of docs.keys()) publish(uri);
      return;
    case "textDocument/definition": {
      const { textDocument, position } = msg.params;
      const name = wordAt(textOf(textDocument.uri), position.line, position.character);
      const d = name ? declaration(name) : undefined;
      return send({ id: msg.id, result: d ? { uri: d.uri, range: range(d.line, d.character, name.length) } : null });
    }
    case "textDocument/references": {
      const { textDocument, position } = msg.params;
      const name = wordAt(textOf(textDocument.uri), position.line, position.character);
      return send({ id: msg.id, result: name ? references(name) : [] });
    }
    case "shutdown":
      return send({ id: msg.id, result: null });
    case "exit":
      return process.exit(0);
    default:
      if (msg.id !== undefined && msg.method) send({ id: msg.id, result: null });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + len) return;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + len).toString("utf8"));
    buffer = buffer.subarray(end + 4 + len);
    handle(msg);
  }
});
