// C# on the tree-sitter backend (grammar: tree-sitter-c-sharp 0.23.5).
//
// Declarations: classes, structs, interfaces, records, enums and delegates; their methods,
// constructors (`Cart.new`), properties, indexers (`Cart.this`), events, fields and enum
// members. Members are qualified by their type (`PriceCalculator.CalcTotal`); namespaces are
// not part of the key (the file path already is): a key is `path#Type.Member`. Partial classes
// declare the same type name in several files; each file keys its own members. Operators and
// finalizers are not declarations (nothing calls them by name).
//
// Signature vs body: a method's signature is everything before its body (attributes,
// modifiers, return type, name, generics, parameters, constraints); the block or `=> expr` is
// the body. For a property, indexer or event, accessor bodies, `=> expr` and the initializer
// are the body; the type, name and accessor list (`{ get; set; }`) are the signature. For a
// field, modifiers + type + name are the signature and the initializer the body. For a type,
// the header (modifiers, base list, record parameters, constraints).
//
// References: identifiers in expressions and types, member-access chains
// (`PriceCalculator.CalcTotal`, `this.Rate`), qualified names (`Shop.Pricing.PriceCalculator`),
// `new Cart(...)` (reads the constructor `Cart.new` when declared, else `Cart`), with C#'s
// lexical lookup: an unqualified `Tax()` inside `Cart` is `Cart.Tax` when Cart has it.
// `using static T;` makes T's members candidates for unqualified names; `using A = N.T;`
// aliases are expanded. Parameters, locals, lambda and pattern variables are not references.
//
// Cross-file: `using` names a namespace, not a file, so reads resolve through the module index
// (src/moduleindex.ts) of the solution directory (nearest `.sln`/`.slnx`), else the project
// directory (nearest `.csproj`), else the file's directory. A type matches when its namespace is
// the file's own (or an enclosing one), a `using`, or written out (`Shop.Pricing.X`). Project-wide
// `global using`s and implicit usings live in other files, so an unqualified name that matches
// no visible namespace falls back to any namespace in scope (`looseNamespaces`).
import { posix } from "node:path";
import type { CheckoutFs, Definition, ImportBinding, ModuleIndex, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { cut, isFieldOf, named, nodeId, same, scoped } from "./lexical.js";

const TYPES = new Set([
  "class_declaration", "struct_declaration", "interface_declaration", "record_declaration",
  "record_struct_declaration", "enum_declaration",
]);
const FUNC_LIKE = new Set([
  "method_declaration", "constructor_declaration", "destructor_declaration", "local_function_statement",
  "lambda_expression", "anonymous_method_expression", "accessor_declaration", "property_declaration",
  "indexer_declaration", "operator_declaration", "conversion_operator_declaration", "query_expression",
]);

function stripTail(text: string): string {
  return text.replace(/\s*=?\s*;?\s*$/, "");
}

function definitions(root: SyntaxNode): Definition[] {
  const out: Definition[] = [];
  const add = (scope: string[], name: string, signature: string, body: string): void => {
    out.push({ name: [...scope, name].join("."), signature, body });
  };
  const walk = (node: SyntaxNode, scope: string[]): void => {
    for (const child of named(node)) {
      const nameNode = child.childForFieldName("name");
      const body = child.childForFieldName("body");
      if (TYPES.has(child.type)) {
        if (!nameNode) continue;
        const q = [...scope, nameNode.text];
        out.push({ name: q.join("."), signature: body ? child.text.slice(0, body.startIndex - child.startIndex) : stripTail(child.text), body: body?.text ?? "" });
        if (body) walk(body, q);
        continue;
      }
      switch (child.type) {
        case "namespace_declaration":
          if (body) walk(body, scope);
          break;
        case "method_declaration":
        case "constructor_declaration":
          // A constructor is keyed `Type.new` (`new` cannot be a member name, so no collision).
          if (nameNode) add(scope, child.type === "constructor_declaration" ? "new" : nameNode.text, body ? child.text.slice(0, body.startIndex - child.startIndex) : stripTail(child.text), body?.text ?? "");
          break;
        case "property_declaration":
        case "event_declaration":
        case "indexer_declaration": {
          const name = child.type === "indexer_declaration" ? "this" : nameNode?.text;
          if (!name) break;
          const value = child.childForFieldName("value");
          const accessors = child.childForFieldName("accessors");
          const bodies = accessors ? named(accessors).map((a) => a.childForFieldName("body")).filter((b): b is SyntaxNode => !!b) : [];
          const removed = [...bodies, ...(value ? [value] : [])];
          add(scope, name, stripTail(cut(child, removed)), removed.map((r) => r.text).join("\n"));
          break;
        }
        case "field_declaration":
        case "event_field_declaration": {
          const decl = named(child).find((c) => c.type === "variable_declaration");
          const type = decl?.childForFieldName("type");
          if (!decl || !type) break;
          const head = child.text.slice(0, type.endIndex - child.startIndex);
          for (const v of named(decl)) {
            if (v.type !== "variable_declarator") continue;
            const vName = v.childForFieldName("name");
            if (!vName) continue;
            add(scope, vName.text, `${head} ${vName.text}`, v.text.slice(vName.endIndex - v.startIndex));
          }
          break;
        }
        case "enum_member_declaration":
          if (nameNode) add(scope, nameNode.text, nameNode.text, child.text.slice(nameNode.endIndex - child.startIndex));
          break;
        case "delegate_declaration":
          if (nameNode) add(scope, nameNode.text, stripTail(child.text), "");
          break;
        case "declaration_list":
        case "enum_member_declaration_list":
          walk(child, scope);
          break;
      }
    }
  };
  walk(root, []);
  return out;
}

/** Dotted name of a name node (`identifier`, `qualified_name`, `generic_name`, `alias_qualified_name`). */
function namePath(node: SyntaxNode | null): string[] {
  if (!node) return [];
  switch (node.type) {
    case "identifier":
      return [node.text];
    case "generic_name":
      return named(node).filter((c) => c.type === "identifier").slice(0, 1).map((c) => c.text);
    case "qualified_name":
      return [...namePath(node.childForFieldName("qualifier")), ...namePath(node.childForFieldName("name"))];
    case "alias_qualified_name":
      return namePath(node.childForFieldName("name"));
  }
  return [];
}

type Using = { kind: "namespace" | "static" | "alias"; path: string[]; alias?: string };

function usings(root: SyntaxNode): Using[] {
  const out: Using[] = [];
  const visit = (node: SyntaxNode): void => {
    for (const c of named(node)) {
      if (c.type === "using_directive") {
        const aliasNode = c.childForFieldName("name");
        const target = named(c).find((n) => !same(n, aliasNode) && /identifier|qualified_name|generic_name/.test(n.type));
        const path = namePath(target ?? null);
        if (!path.length) continue;
        const isStatic = c.children.some((t) => t?.type === "static");
        out.push(aliasNode ? { kind: "alias", path, alias: aliasNode.text } : { kind: isStatic ? "static" : "namespace", path });
      } else if (c.type === "namespace_declaration" || c.type === "declaration_list") visit(c);
    }
  };
  visit(root);
  return out;
}

const NOT_A_USE_PARENT = new Set([
  "using_directive", "namespace_declaration", "file_scoped_namespace_declaration", "type_parameter",
  "name_colon", "name_equals", "labeled_statement", "goto_statement", "attribute_target_specifier",
  "extern_alias_directive", "type_parameter_constraints_clause",
]);

function isBinder(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  if (!parent) return false;
  if (NOT_A_USE_PARENT.has(parent.type)) return true;
  if (parent.type === "member_access_expression" || parent.type === "qualified_name" || parent.type === "attribute" || parent.type === "generic_name") return false;
  return isFieldOf(parent, node, ["name", "left"]);
}

/** Names a function-like node binds locally: parameters, locals, pattern and lambda variables. */
function bindersOf(fn: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const visit = (n: SyntaxNode): void => {
    switch (n.type) {
      case "parameter":
      case "variable_declarator":
      case "declaration_pattern":
      case "declaration_expression":
      case "catch_declaration":
      case "local_function_statement":
      case "from_clause":
      case "let_clause":
      case "join_clause": {
        const name = n.childForFieldName("name");
        if (name) out.add(name.text);
        break;
      }
      case "foreach_statement": {
        const left = n.childForFieldName("left");
        if (left?.type === "identifier") out.add(left.text);
        break;
      }
      case "implicit_parameter":
      case "single_variable_designation":
        out.add(n.text);
        break;
    }
    for (const c of named(n)) visit(c);
  };
  visit(fn);
  return out;
}

// The traversal carries its ancestors, enclosing type path and local bindings: web-tree-sitter
// computes `node.parent` by descending from the root, so walking parents per identifier is
// quadratic on large files.
type Ctx = { stack: SyntaxNode[]; scope: string[]; locals: Set<string>[] };

function references(root: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  const consumed = new Set<string>();
  const us = usings(root);
  const aliases = new Map(us.filter((u) => u.kind === "alias").map((u) => [u.alias!, u.path] as const));
  const statics = us.filter((u) => u.kind === "static").map((u) => u.path);
  const isLocal = (ctx: Ctx, name: string): boolean => ctx.locals.some((l) => l.has(name));

  type Chain = { path: string[]; head: "bare" | "this" | "qualified" };
  const bare = (name: string, ctx: Ctx): Chain | undefined => {
    if (isLocal(ctx, name)) return undefined;
    const alias = aliases.get(name);
    if (alias) return { path: [...alias], head: "qualified" };
    return { path: [name], head: "bare" };
  };
  const chain = (node: SyntaxNode, ctx: Ctx): Chain | undefined => {
    switch (node.type) {
      case "identifier":
        consumed.add(nodeId(node));
        return bare(node.text, ctx);
      case "generic_name": {
        const id = named(node).find((c) => c.type === "identifier");
        if (!id) return undefined;
        consumed.add(nodeId(id));
        return bare(id.text, ctx);
      }
      case "this_expression":
      case "this":
        return ctx.scope.length ? { path: ctx.scope, head: "this" } : undefined;
      case "member_access_expression": {
        const expression = node.childForFieldName("expression") ?? (node.children[0]?.type === "this" ? node.children[0] : null);
        const name = node.childForFieldName("name");
        const member = name ? namePath(name)[0] : undefined;
        if (!expression || !member || !name) return undefined;
        const base = chain(expression, ctx);
        if (!base) return undefined;
        consumed.add(nodeId(name));
        if (name.type === "generic_name") for (const c of named(name)) if (c.type === "identifier") consumed.add(nodeId(c));
        return { ...base, path: [...base.path, member] };
      }
      case "qualified_name": {
        const mark = (q: SyntaxNode | null): void => {
          if (!q) return;
          consumed.add(nodeId(q));
          if (q.type === "qualified_name") {
            mark(q.childForFieldName("qualifier"));
            mark(q.childForFieldName("name"));
          } else if (q.type === "generic_name") for (const c of named(q)) if (c.type === "identifier") consumed.add(nodeId(c));
        };
        mark(node);
        const path = namePath(node);
        if (!path.length) return undefined;
        const alias = aliases.get(path[0]);
        return alias ? { path: [...alias, ...path.slice(1)], head: "qualified" } : { path, head: "bare" };
      }
    }
    return undefined;
  };
  const emit = (c: Chain, ctx: Ctx, ctor: boolean): void => {
    const path = ctor ? [...c.path, "new"] : c.path;
    if (c.head === "this") {
      const r: Reference = [...path];
      r.min = Math.min(path.length, ctx.scope.length + 1);
      r.anchored = true;
      out.push(r);
    } else if (c.head === "bare") out.push(scoped(path, ctx.scope, c.path.length === 1 ? statics : []));
    else out.push([...path]);
  };
  const isCtor = (node: SyntaxNode, parent: SyntaxNode | undefined): boolean =>
    !!parent && parent.type === "object_creation_expression" && same(parent.childForFieldName("type"), node);

  const visit = (node: SyntaxNode, ctx: Ctx): void => {
    const parent = ctx.stack[ctx.stack.length - 1];
    switch (node.type) {
      case "using_directive":
      case "file_scoped_namespace_declaration":
      case "extern_alias_directive":
        return;
      case "namespace_declaration": {
        const body = node.childForFieldName("body");
        if (body) visit(body, ctx);
        return;
      }
      case "member_access_expression": {
        if (parent?.type === "member_access_expression" && same(parent.childForFieldName("expression"), node)) break;
        const c = chain(node, ctx);
        if (c) emit(c, ctx, false);
        break;
      }
      case "qualified_name": {
        if (parent?.type === "qualified_name") break;
        const c = chain(node, ctx);
        if (c) emit(c, ctx, isCtor(node, parent));
        break;
      }
      case "generic_name": {
        if (consumed.has(nodeId(node)) || parent?.type === "member_access_expression" || parent?.type === "qualified_name") break;
        consumed.add(nodeId(node));
        const c = chain(node, ctx);
        if (c) emit(c, ctx, isCtor(node, parent));
        break;
      }
      case "identifier": {
        if (consumed.has(nodeId(node)) || isBinder(node, parent)) break;
        const c = chain(node, ctx);
        if (c) emit(c, ctx, isCtor(node, parent));
        break;
      }
    }
    let inner = ctx;
    if (TYPES.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (name) inner = { ...ctx, scope: [...ctx.scope, name] };
    }
    if (FUNC_LIKE.has(node.type)) inner = { ...inner, locals: [...inner.locals, bindersOf(node)] };
    ctx.stack.push(node);
    for (const c of named(node)) visit(c, inner);
    ctx.stack.pop();
  };
  visit(root, { stack: [], scope: [], locals: [] });
  return out;
}

function imports(root: SyntaxNode): ImportBinding[] {
  return usings(root)
    .filter((u) => u.kind === "namespace")
    .map((u) => ({ local: u.path.join("."), module: u.path.join(".") }));
}

const join = (...parts: string[]): string => parts.filter(Boolean).join(".");

/** Top-level type name -> its namespace (file-scoped or block, nested blocks joined). */
function typeNamespaces(root: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: SyntaxNode, ns: string): void => {
    let current = ns;
    for (const c of named(node)) {
      if (c.type === "file_scoped_namespace_declaration") {
        current = join(ns, namePath(c.childForFieldName("name")).join("."));
      } else if (c.type === "namespace_declaration") {
        const body = c.childForFieldName("body");
        if (body) walk(body, join(current, namePath(c.childForFieldName("name")).join(".")));
      } else if (TYPES.has(c.type) || c.type === "delegate_declaration") {
        const name = c.childForFieldName("name")?.text;
        if (name && !out.has(name)) out.set(name, current);
      }
    }
  };
  walk(root, "");
  return out;
}

/** Namespaces this file declares, and their enclosing namespaces (visible unqualified inside). */
function declaredNamespaces(root: SyntaxNode): string[] {
  const out = new Set<string>();
  const walk = (node: SyntaxNode, ns: string): void => {
    for (const c of named(node)) {
      if (c.type !== "file_scoped_namespace_declaration" && c.type !== "namespace_declaration") continue;
      const inner = join(ns, namePath(c.childForFieldName("name")).join("."));
      out.add(inner);
      const body = c.childForFieldName("body");
      if (body) walk(body, inner);
    }
  };
  walk(root, "");
  for (const ns of [...out]) {
    const parts = ns.split(".");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return [...out];
}

function scopes(fromRel: string, _imports: ImportBinding[], fs: CheckoutFs): string[] {
  const fileDir = posix.dirname(fromRel) === "." ? "" : posix.dirname(fromRel);
  const parts = fileDir ? fileDir.split("/") : [];
  let project: string | undefined;
  for (let n = parts.length; n >= 0; n--) {
    const dir = parts.slice(0, n).join("/");
    const entries = fs.list(dir) ?? [];
    if (entries.some((e) => /\.slnx?$/i.test(e))) return [dir];
    if (project === undefined && entries.some((e) => /\.csproj$/i.test(e))) project = dir;
  }
  return [project ?? fileDir];
}

const DECLARED = /\b(?:class|struct|interface|enum|record)\s+([A-Za-z_]\w*)|\bdelegate\s+[\w<>[\]?,.\s]+?\s([A-Za-z_]\w*)\s*[<(]/g;

export const csharpIndex: ModuleIndex = {
  scopes,
  declaredNames: (text) => Array.from(text.matchAll(DECLARED), (m) => m[1] ?? m[2]),
  namespaces: (root) => typeNamespaces(root),
  visibleNamespaces(root, _rel, imported) {
    return [...new Set([...imported.map((b) => b.module), ...declaredNamespaces(root), ""])];
  },
  looseNamespaces: true,
};

export const csharp: TreeSitterLanguage = {
  id: "csharp",
  name: "C#",
  extensions: [".cs"],
  grammar: "tree-sitter-c_sharp.wasm",
  definitions,
  references,
  imports,
  resolveModule: () => undefined, // `using` names namespaces; see `index`
  index: csharpIndex,
};
