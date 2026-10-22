// Swift on the tree-sitter backend (grammar: tree-sitter-swift 0.7.3, alex-pinkus).
//
// Declarations: struct / class / enum / actor / protocol, their members, top-level and member
// functions, initializers (`Cart.init`), subscripts, properties, enum cases, typealiases and
// associated types. Members are qualified by their type (`Cart.total`); members declared in an
// `extension Cart` are keyed on the extended type (`Cart.rate`) in the extension's file. An
// extension itself is not a declaration.
//
// Signature vs body: a function's signature is everything before its body, so argument labels,
// parameter types, defaults, `throws`/`async`, generics and attributes are signature. A
// parameter's internal name is not (`func f(by k: Int)` -> `func f(by k2: Int)` is a body change
// only): callers never see it. Overloads share one key (`calcTotal`), as in TypeScript. For a
// property the type annotation (and `let`/`var`) is the signature and the value or computed
// block the body. For a type, the header (inheritance, generics) is the signature.
//
// References: identifiers in expressions, type names, navigation chains (`Pricing.calcTotal`,
// `self.tax`), with Swift's lexical lookup: an unqualified `tax()` inside `Cart` is `Cart.tax`
// when Cart has it, else a top-level `tax`. `Cart(...)` reads `Cart.init` when declared.
// Parameters, closure parameters and local bindings are not references.
//
// Cross-file: Swift has no per-file imports; every file of a module sees every declaration of
// the module. Reads resolve through the module index (src/moduleindex.ts) of the file's module:
// the SwiftPM target directory (`<pkg>/Sources/<Target>/`, `<pkg>/Tests/<Target>/`), else the
// Xcode group folder next to the `.xcodeproj`, else the file's directory. `import Other`
// adds `Sources/Other` (SwiftPM) or the `Other/` folder next to the project.
import { posix } from "node:path";
import type { CheckoutFs, Definition, ImportBinding, ModuleIndex, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { cut, isFieldOf, named, nodeId, same, scoped } from "./lexical.js";

const TYPE_DECL = new Set(["class_declaration", "protocol_declaration"]);
const FUNC_LIKE = new Set([
  "function_declaration", "init_declaration", "deinit_declaration", "subscript_declaration", "lambda_literal",
  "computed_property", "computed_getter", "computed_setter", "computed_modify", "willset_didset_block",
]);

/** `struct` / `class` / `enum` / `actor` / `extension` for a class_declaration. */
function declKind(node: SyntaxNode): string {
  for (const c of node.children) if (c && !c.type.includes("_") && /^(?:struct|class|enum|actor|extension)$/.test(c.type)) return c.type;
  return "class";
}

/** Name segments of a type name node (`Outer.Inner<T>` -> ["Outer", "Inner"]). */
function typePath(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "type_identifier" || node.type === "simple_identifier") return [node.text];
  if (node.type === "user_type") return named(node).filter((c) => c.type === "type_identifier").map((c) => c.text);
  return [];
}

function patternNames(p: SyntaxNode): string[] {
  const out: string[] = [];
  for (const b of p.childrenForFieldName("bound_identifier")) if (b) out.push(b.text);
  for (const c of named(p)) {
    if (c.type === "simple_identifier" && !out.includes(c.text)) out.push(c.text);
    else if (c.type === "pattern") out.push(...patternNames(c));
  }
  return out;
}

/** Function header up to the body, without internal parameter names (callers never see them). */
function functionSignature(node: SyntaxNode, body: SyntaxNode | null): string {
  const internal: SyntaxNode[] = [];
  for (const p of named(node)) {
    if (p.type !== "parameter" || !p.childForFieldName("external_name")) continue;
    const name = p.childrenForFieldName("name").find((n) => n?.type === "simple_identifier");
    if (name) internal.push(name);
  }
  return cut(node, internal, body ? body.startIndex : node.endIndex);
}

function definitions(root: SyntaxNode): Definition[] {
  const out: Definition[] = [];
  const add = (scope: string[], name: string, signature: string, body: string): void => {
    out.push({ name: [...scope, name].join("."), signature, body });
  };
  const walk = (node: SyntaxNode, scope: string[]): void => {
    for (const child of named(node)) {
      const body = child.childForFieldName("body");
      switch (child.type) {
        case "class_declaration":
        case "protocol_declaration": {
          const names = typePath(child.childForFieldName("name"));
          if (!names.length) break;
          if (child.type === "class_declaration" && declKind(child) === "extension") {
            if (body) walk(body, names);
            break;
          }
          const q = [...scope, ...names];
          out.push({ name: q.join("."), signature: body ? child.text.slice(0, body.startIndex - child.startIndex) : child.text, body: body?.text ?? "" });
          if (body) walk(body, q);
          break;
        }
        case "function_declaration": {
          const name = child.childForFieldName("name");
          if (name) add(scope, name.text, functionSignature(child, body), body?.text ?? "");
          break;
        }
        case "init_declaration":
          add(scope, "init", functionSignature(child, body), body?.text ?? "");
          break;
        case "subscript_declaration": {
          const block = named(child).find((c) => c.type === "computed_property") ?? null;
          add(scope, "subscript", functionSignature(child, block), block?.text ?? "");
          break;
        }
        case "protocol_function_declaration": {
          const name = child.childForFieldName("name");
          if (name) add(scope, name.text, functionSignature(child, null), "");
          break;
        }
        case "property_declaration":
        case "protocol_property_declaration": {
          const value = child.childForFieldName("computed_value") ?? child.childForFieldName("value")
            ?? named(child).find((c) => c.type === "willset_didset_block") ?? null;
          const signature = value ? child.text.slice(0, value.startIndex - child.startIndex).replace(/\s*=\s*$/, "") : child.text;
          const bodyText = value ? child.text.slice(value.startIndex - child.startIndex) : "";
          for (const p of child.childrenForFieldName("name")) if (p) for (const n of patternNames(p)) add(scope, n, signature, bodyText);
          break;
        }
        case "typealias_declaration":
        case "associatedtype_declaration": {
          const name = child.childForFieldName("name");
          if (name) add(scope, name.text, child.text, "");
          break;
        }
        case "enum_entry":
          for (const n of child.childrenForFieldName("name")) if (n) add(scope, n.text, child.text, "");
          break;
        case "class_body":
        case "enum_class_body":
        case "protocol_body":
          walk(child, scope);
          break;
      }
    }
  };
  walk(root, []);
  return out;
}

/** Is `node` (child of `parent`) the name being declared rather than a use? */
function isBinder(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case "navigation_suffix":
    case "value_argument_label":
    case "pattern":
    case "enum_entry":
    case "identifier": // import paths, constraint subjects
    case "lambda_parameter":
    case "parameter":
    case "function_declaration":
    case "protocol_function_declaration":
    case "typealias_declaration":
    case "associatedtype_declaration":
    case "class_declaration":
    case "protocol_declaration":
      return true;
  }
  return isFieldOf(parent, node, ["bound_identifier", "name", "external_name"]);
}

/** Names a function-like node binds locally: parameters, closure parameters, let/var, patterns. */
function bindersOf(fn: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const visit = (n: SyntaxNode): void => {
    if (n.type === "parameter" || n.type === "lambda_parameter") {
      for (const c of n.childrenForFieldName("name")) if (c?.type === "simple_identifier") out.add(c.text);
    }
    for (const b of n.childrenForFieldName("bound_identifier")) if (b) out.add(b.text);
    if (n.type === "pattern") for (const c of named(n)) if (c.type === "simple_identifier") out.add(c.text);
    for (const c of named(n)) visit(c);
  };
  visit(fn);
  return out;
}

/** Binary-operator misparses: `a + Kind.x` can come out as `(a + Kind).x`; the operand is the rhs. */
function operand(node: SyntaxNode): SyntaxNode {
  let n = node;
  for (let rhs = n.childForFieldName("rhs"); rhs; rhs = n.childForFieldName("rhs")) n = rhs;
  return n;
}

// The traversal carries its ancestors, enclosing type path and local bindings: web-tree-sitter
// computes `node.parent` by descending from the root, so walking parents per identifier is
// quadratic on large files.
type Ctx = { stack: SyntaxNode[]; scope: string[]; locals: Set<string>[] };

function isLocal(ctx: Ctx, name: string): boolean {
  return name.startsWith("$") || ctx.locals.some((l) => l.has(name));
}

/** Is `node` (its ancestors on `ctx.stack`) the callee of a call? */
function isCallee(node: SyntaxNode, ctx: Ctx): boolean {
  let n = node;
  let i = ctx.stack.length - 1;
  while (i >= 0 && same(ctx.stack[i].childForFieldName("rhs"), n)) n = ctx.stack[i--];
  const p = ctx.stack[i];
  return !!p && p.type === "call_expression" && same(named(p)[0], n);
}

function references(root: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  const consumed = new Set<string>();

  /** A navigation chain as a path; head says how to resolve it. */
  type Chain = { path: string[]; head: "bare" | "self" };
  const chain = (node: SyntaxNode, ctx: Ctx): Chain | undefined => {
    const n = operand(node);
    if (n.type === "simple_identifier") {
      if (isLocal(ctx, n.text)) return undefined;
      consumed.add(nodeId(n));
      return { path: [n.text], head: "bare" };
    }
    if (n.type === "self_expression") return ctx.scope.length ? { path: ctx.scope, head: "self" } : undefined;
    if (n.type === "navigation_expression") {
      const target = n.childForFieldName("target");
      const suffix = n.childForFieldName("suffix")?.childForFieldName("suffix");
      if (!target || suffix?.type !== "simple_identifier") return undefined;
      const base = chain(target, ctx);
      if (!base) return undefined;
      consumed.add(nodeId(suffix));
      return { ...base, path: [...base.path, suffix.text] };
    }
    return undefined;
  };
  const emit = (c: Chain, ctx: Ctx, call: boolean): void => {
    const path = call && /^[A-Z]/.test(c.path[c.path.length - 1]) && c.head !== "self" ? [...c.path, "init"] : c.path;
    if (c.head === "self") {
      const r: Reference = [...path];
      r.min = Math.min(path.length, ctx.scope.length + 1);
      r.anchored = true;
      out.push(r);
    } else out.push(scoped(path, ctx.scope));
  };

  const visit = (node: SyntaxNode, ctx: Ctx): void => {
    const parent = ctx.stack[ctx.stack.length - 1];
    switch (node.type) {
      case "import_declaration":
        return;
      case "user_type": {
        const path = typePath(node);
        const extended = parent?.type === "class_declaration" && isFieldOf(parent, node, ["name"]) && declKind(parent) === "extension";
        if (path.length) out.push(extended ? [...path] : scoped(path, ctx.scope)); // `extension Cart` depends on Cart
        break;
      }
      case "navigation_expression": {
        if (parent?.type === "navigation_expression" && same(operand(parent.childForFieldName("target") ?? parent), node)) break;
        const c = chain(node, ctx);
        if (c && c.path.length) emit(c, ctx, isCallee(node, ctx));
        break;
      }
      case "simple_identifier": {
        if (consumed.has(nodeId(node)) || isBinder(node, parent) || isLocal(ctx, node.text)) break;
        emit({ path: [node.text], head: "bare" }, ctx, isCallee(node, ctx));
        break;
      }
    }
    let inner = ctx;
    if (TYPE_DECL.has(node.type)) inner = { ...ctx, scope: [...ctx.scope, ...typePath(node.childForFieldName("name"))] };
    if (FUNC_LIKE.has(node.type)) inner = { ...inner, locals: [...inner.locals, bindersOf(node)] };
    ctx.stack.push(node);
    const childCtx = inner === ctx ? ctx : { ...inner, stack: ctx.stack };
    for (const c of named(node)) visit(c, childCtx);
    ctx.stack.pop();
  };
  visit(root, { stack: [], scope: [], locals: [] });
  return out;
}

function imports(root: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const c of named(root)) {
    if (c.type !== "import_declaration") continue;
    const id = named(c).find((n) => n.type === "identifier");
    const module = id ? named(id).map((s) => s.text)[0] : undefined;
    if (module) out.push({ local: module, module });
  }
  return out;
}

/** SwiftPM target of a path: `<pkg>/Sources/<Target>/...` or `<pkg>/Tests/<Target>/...`. */
function swiftpmTarget(rel: string): { pkg: string[]; dir: string; name: string } | undefined {
  const segs = rel.split("/");
  for (let i = segs.length - 3; i >= 0; i--) {
    if (segs[i] === "Sources" || segs[i] === "Tests") return { pkg: segs.slice(0, i), dir: segs.slice(0, i + 2).join("/"), name: segs[i + 1] };
  }
  return undefined;
}

function scopes(fromRel: string, imported: ImportBinding[], fs: CheckoutFs): string[] {
  const target = swiftpmTarget(fromRel);
  if (target) {
    const dirs = [target.dir];
    for (const b of imported) {
      for (const kind of ["Sources", "Tests"]) {
        const dir = [...target.pkg, kind, b.module].join("/");
        if (fs.list(dir)) dirs.push(dir);
      }
    }
    return dirs;
  }
  // Xcode: the group folder (child of the directory holding the .xcodeproj) containing the file.
  const fileDir = posix.dirname(fromRel) === "." ? "" : posix.dirname(fromRel);
  const parts = fileDir ? fileDir.split("/") : [];
  for (let n = parts.length; n >= 0; n--) {
    const dir = parts.slice(0, n).join("/");
    const entries = fs.list(dir);
    if (!entries?.some((e) => e.endsWith(".xcodeproj/"))) continue;
    const group = n < parts.length ? parts.slice(0, n + 1).join("/") : dir;
    const dirs = [group];
    for (const b of imported) {
      const other = dir ? `${dir}/${b.module}` : b.module;
      if (entries.includes(`${b.module}/`) && other !== group) dirs.push(other);
    }
    return dirs;
  }
  return [fileDir];
}

const DECLARED = /^(?:(?:@\w+(?:\([^)\n]*\))?|public|private|fileprivate|internal|open|package|final|static|class|indirect|nonisolated|override|convenience|required|mutating|lazy|weak|unowned|dynamic)\s+)*(?:struct|class|enum|protocol|actor|extension|typealias|func|var|let|macro)\s+`?([A-Za-z_]\w*)/gm;

export const swiftIndex: ModuleIndex = {
  scopes,
  declaredNames: (text) => Array.from(text.matchAll(DECLARED), (m) => m[1]),
  namespaces(root, rel) {
    const module = swiftpmTarget(rel)?.name ?? "";
    const map = new Map<string, string>();
    for (const d of definitions(root)) map.set(d.name.split(".")[0], module);
    return map;
  },
  visibleNamespaces(_root, rel, imported) {
    return [...new Set([swiftpmTarget(rel)?.name ?? "", ...imported.map((b) => b.module), ""])];
  },
};

export const swift: TreeSitterLanguage = {
  id: "swift",
  name: "Swift",
  extensions: [".swift"],
  grammar: "tree-sitter-swift.wasm",
  definitions,
  references,
  imports,
  resolveModule: () => undefined, // modules are not files; see `index`
  index: swiftIndex,
};
