// Go on the tree-sitter backend (grammar: tree-sitter-go 0.25.0).
//
// Declarations: functions, methods qualified by their receiver type (`func (c *Cart) Total()`
// is `Cart.Total`), types and interfaces (`type_spec`, `type_alias`), and package-level
// consts/vars. A function's or method's signature is its text up to the body (receiver,
// type parameters, parameters, results). A type's whole declaration is its signature: struct
// fields and interface methods are what other code builds on. For a const/var the type is the
// signature and the value the body.
//
// References: call targets, selector chains (`pricing.CalcTotal`, `c.Tax()` with `c` the
// method's receiver resolved to `Cart.Tax`), type uses (`Item`, `pricing.Item`, composite
// literals). Bare value uses of package-level names (`DefaultRate`) are not reads, as in Python.
//
// Packages. A Go package is a directory whose files share one namespace, so an import path
// names no file. Keys stay file-level (`shop/pricing/pricing.go#CalcTotal`, the file that
// declares the name), which keeps reads identical to writes, to the whole-file fallback and to
// diff quoting. The engine finds the declaring file through a declaration index of the package
// directory (`packageFiles`; see `TreeSitterLanguage.packageFiles`), which needs the adapter's
// `read`/`list`. A name the edited file uses but does not declare resolves through the index
// of its own package; files of another package in the same directory (`package x_test`) and
// `_test.go` files of imported packages are not indexed.
//
// Imports resolve through the nearest `go.mod` (its `module` path) to a package directory in
// the checkout; anything else (stdlib, other modules) is outside the checkout. Not handled:
// dot imports (`import . "x"`), `replace` directives, `go.work` multi-module workspaces.
import { posix } from "node:path";
import type { Checkout, Definition, Exists, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";

function named(node: SyntaxNode | null | undefined): SyntaxNode[] {
  return node ? node.namedChildren.filter((c): c is SyntaxNode => c !== null) : [];
}

const same = (a: SyntaxNode | null | undefined, b: SyntaxNode): boolean =>
  !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

/** `*Cart`, `Cart[T]`, `pkg.Cart` -> "Cart". */
function typeName(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "pointer_type":
    case "parenthesized_type":
      return typeName(named(node)[0]);
    case "generic_type":
      return typeName(node.childForFieldName("type"));
    case "qualified_type":
      return node.childForFieldName("name")?.text;
  }
  return undefined;
}

/** The receiver of a method declaration: its type name and the variable that names it. */
function receiver(method: SyntaxNode): { type?: string; variable?: string } {
  const param = named(method.childForFieldName("receiver")).find((c) => c.type === "parameter_declaration");
  return { type: typeName(param?.childForFieldName("type")), variable: param?.childForFieldName("name")?.text };
}

function head(decl: SyntaxNode): string {
  const body = decl.childForFieldName("body");
  return body ? decl.text.slice(0, body.startIndex - decl.startIndex) : decl.text;
}

function def(name: string, node: SyntaxNode, nameNode: SyntaxNode, signature: string, body: string): Definition {
  return { name, signature, body, start: node.startIndex, end: node.endIndex, nameStart: nameNode.startIndex, nameEnd: nameNode.endIndex };
}

function definitions(root: SyntaxNode): Definition[] {
  const out: Definition[] = [];
  for (const node of named(root)) {
    switch (node.type) {
      case "function_declaration": {
        const n = node.childForFieldName("name");
        if (n) out.push(def(n.text, node, n, head(node), node.childForFieldName("body")?.text ?? ""));
        break;
      }
      case "method_declaration": {
        const n = node.childForFieldName("name");
        const type = receiver(node).type;
        if (n && type) out.push(def(`${type}.${n.text}`, node, n, head(node), node.childForFieldName("body")?.text ?? ""));
        break;
      }
      case "type_declaration":
        for (const spec of named(node)) {
          if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
          const n = spec.childForFieldName("name");
          if (n) out.push(def(n.text, spec, n, spec.text, ""));
        }
        break;
      case "const_declaration":
      case "var_declaration": {
        const specs = named(node).flatMap((c) => (c.type === "var_spec_list" ? named(c) : [c]));
        for (const spec of specs) {
          if (spec.type !== "const_spec" && spec.type !== "var_spec") continue;
          const type = spec.childForFieldName("type")?.text ?? "";
          const value = spec.childForFieldName("value")?.text ?? "";
          for (const n of spec.childrenForFieldName("name")) if (n) out.push(def(n.text, spec, n, type, value));
        }
        break;
      }
    }
  }
  return out;
}

/** The receiver of the method enclosing `node`, if any. */
function enclosingReceiver(node: SyntaxNode): { type?: string; variable?: string } | undefined {
  for (let p = node.parent; p; p = p.parent) if (p.type === "method_declaration") return receiver(p);
  return undefined;
}

/** `a.b.c` -> ["a","b","c"]; `c.Tax` with receiver `c *Cart` -> ["Cart","Tax"] (exact). */
function dotted(node: SyntaxNode): Reference | undefined {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return [node.text];
    case "qualified_type": {
      const pkg = node.childForFieldName("package")?.text;
      const name = node.childForFieldName("name")?.text;
      return pkg && name ? [pkg, name] : undefined;
    }
    case "generic_type": {
      const t = node.childForFieldName("type");
      return t ? dotted(t) : undefined;
    }
    case "selector_expression": {
      const operand = node.childForFieldName("operand");
      const field = node.childForFieldName("field")?.text;
      if (!operand || !field) return undefined;
      if (operand.type === "identifier") {
        const recv = enclosingReceiver(node);
        if (recv?.type && recv.variable === operand.text) {
          const ref: Reference = [recv.type, field];
          ref.exact = true;
          return ref;
        }
      }
      const left = dotted(operand);
      if (!left) return undefined;
      const ref: Reference = [...left, field];
      if (left.exact) ref.exact = true;
      return ref;
    }
  }
  return undefined;
}

/** Type parameter names in scope at `node` (`[T any]` of the enclosing func/method/type). */
function typeParamsAt(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (let p: SyntaxNode | null = node; p; p = p.parent) {
    if (p.type !== "function_declaration" && p.type !== "method_declaration" && p.type !== "type_spec") continue;
    for (const list of named(p).filter((c) => c.type === "type_parameter_list")) {
      for (const decl of named(list)) for (const n of decl.childrenForFieldName("name")) if (n) names.add(n.text);
    }
    // a method's receiver `(c *Cart[T])` also introduces T
    const recv = p.type === "method_declaration" ? p.childForFieldName("receiver") : null;
    const stack = recv ? [recv] : [];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === "type_arguments") for (const a of named(n)) names.add(a.text);
      else stack.push(...named(n));
    }
  }
  return names;
}

function references(root: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  const add = (node: SyntaxNode | null | undefined): void => {
    const ref = node ? dotted(node) : undefined;
    if (!ref) return;
    if (ref.length === 1 && node && typeParamsAt(node).has(ref[0])) return;
    out.push(ref);
  };
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "import_declaration":
      case "package_clause":
        return;
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier") add(fn);
        break;
      }
      case "selector_expression":
        // only the outermost link of a chain: `a.b.c`, not `a.b`
        if (!(node.parent?.type === "selector_expression" && same(node.parent.childForFieldName("operand"), node))) add(node);
        break;
      case "type_identifier": {
        const p = node.parent;
        const isName = (p?.type === "type_spec" || p?.type === "type_alias") && same(p.childForFieldName("name"), node);
        if (!isName) add(node);
        break;
      }
      case "qualified_type":
        add(node);
        return;
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return out;
}

/** The name an import binds without an alias: the last path element, minus a `/vN` suffix. */
function defaultLocal(path: string): string {
  const parts = path.split("/");
  let last = parts.pop() ?? path;
  if (/^v\d+$/.test(last) && parts.length) last = parts.pop()!;
  return last.replace(/\.v\d+$/, "").replace(/^go-/, "").replace(/[.-]go$/, "").replace(/[^\p{L}\p{N}_]/gu, "_");
}

function imports(root: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const decl of named(root)) {
    if (decl.type !== "import_declaration") continue;
    const specs = named(decl).flatMap((c) => (c.type === "import_spec_list" ? named(c) : [c])).filter((c) => c.type === "import_spec");
    for (const spec of specs) {
      const module = spec.childForFieldName("path")?.text.replace(/^["`]|["`]$/g, "");
      if (!module) continue;
      const alias = spec.childForFieldName("name");
      if (!alias) out.push({ local: defaultLocal(module), module, guessed: true });
      else if (alias.type === "package_identifier") out.push({ local: alias.text, module });
      // `_` (side effects only) and `.` (dot import) bind no name tracked here.
    }
  }
  return out;
}

/** `package x` of a file (the first one outside comments). */
function packageName(text: string): string | undefined {
  return /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(text.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1];
}

const IDENT = "[\\p{L}_][\\p{L}\\p{N}_]*";
const FUNC = new RegExp(`^func\\s*(?:\\(\\s*(?:${IDENT}\\s+)?\\*?\\s*(${IDENT})[^)]*\\)\\s*)?(${IDENT})`, "gmu");
const SINGLE = new RegExp(`^(?:type|const|var)\\s+(${IDENT})`, "gmu");
const GROUP = /^(?:type|const|var)\s*\(([\s\S]*?)^\)/gmu;
const GROUP_NAME = new RegExp(`^\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)`, "gmu");

/** Top-level names a Go file may declare, from its text (over-approximate; the index parses to confirm). */
function packageDeclaredNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FUNC)) out.push(m[1] ? `${m[1]}.${m[2]}` : m[2]);
  for (const m of text.matchAll(SINGLE)) out.push(m[1]);
  for (const g of text.matchAll(GROUP)) for (const m of g[1].matchAll(GROUP_NAME)) out.push(...m[1].split(",").map((s) => s.trim()));
  return out;
}

/**
 * The package directory (checkout-relative, `""` = root) an import path names, through the
 * nearest go.mod above `fromRel`. Needs `checkout.read`.
 */
function resolveModule(module: string, fromRel: string, exists?: Exists, checkout?: Checkout): string | undefined {
  const read = checkout?.read;
  if (!read || module.startsWith(".")) return undefined;
  for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
    const d = dir === "." || dir === "/" ? "" : dir;
    const gomod = d ? `${d}/go.mod` : "go.mod";
    const text = !exists || exists(gomod) ? read(gomod) : undefined;
    const path = text ? /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1] : undefined;
    if (path) {
      if (module === path) return d;
      if (!module.startsWith(`${path}/`)) return undefined; // another module: outside this checkout's module
      const rest = module.slice(path.length + 1);
      return d ? `${d}/${rest}` : rest;
    }
    if (!d) return undefined;
  }
}

/** The files of package directory `dir`: its `.go` files, `_test.go` only for the package's own tests. */
function packageFiles(dir: string, entries: string[], fromRel: string): string[] {
  const ownTest = fromRel.endsWith("_test.go") && (posix.dirname(fromRel) === "." ? "" : posix.dirname(fromRel)) === dir;
  return entries.filter((e) => e.endsWith(".go") && (ownTest || !e.endsWith("_test.go")));
}

export const go: TreeSitterLanguage = {
  id: "go",
  name: "Go",
  extensions: [".go"],
  grammar: "tree-sitter-go.wasm",
  definitions,
  references,
  imports,
  resolveModule,
  identifierTypes: ["identifier", "type_identifier", "field_identifier", "package_identifier"],
  packageFiles,
  packageName,
  packageDeclaredNames,
};
