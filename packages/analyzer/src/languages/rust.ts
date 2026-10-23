// Rust on the tree-sitter backend (grammar: tree-sitter-rust 0.24.0).
//
// Declarations: functions, methods qualified by their impl or trait type (`impl Cart { fn
// total() }` and `impl Display for Cart { fn fmt() }` are `Cart.total` / `Cart.fmt`; a trait's
// methods are `Shape.area`), structs, enums, unions, traits, type aliases, consts and statics,
// and the items of inline modules (`mod tests { fn t() }` is `tests.t`). Items inside function
// bodies are not declarations. Outer attributes (`#[derive(Clone)]`, `#[inline]`) are part of
// the item's signature. A function's signature is its text up to the body; a struct's, enum's
// or type alias's whole text is its signature (fields and variants are the contract); a trait's
// signature is its header (its methods are separate declarations); for a const/static the type
// is the signature and the value the body.
//
// References: call targets, paths (`pricing::calc_total`, `Kind::A`, `Self::new`), method
// calls on `self` (`self.tax()` in `impl Cart` reads `Cart.tax`), type uses (including
// `pricing::Item`, struct literals, trait bounds and `impl Trait for Type`), and calls inside
// macro arguments (`format!("{}", calc_total(x))`, a token-level scan).
//
// Imports: `use` trees (`use crate::a::b::{self, x, y as z}`), `mod name;`, and paths spelled
// from `crate::`, `self::` or `super::` in code. Modules resolve to `src/a/b.rs` or
// `src/a/b/mod.rs` under the crate's `src/` (the nearest `Cargo.toml`), relative to the file's
// own module for `self::`/`super::`/`mod`. A bare first segment (`use pricing::x` in the crate
// root) is tried as a child of the current module, then of the crate root; anything else is an
// external crate. Not handled: glob imports (`use a::*`), `#[path]` attributes, re-exports
// through `pub use` (the key is the file that `use` names).
import { posix } from "node:path";
import type { Definition, Exists, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { firstExisting } from "../treesitter.js";

function named(node: SyntaxNode | null | undefined): SyntaxNode[] {
  return node ? node.namedChildren.filter((c): c is SyntaxNode => c !== null) : [];
}

const same = (a: SyntaxNode | null | undefined, b: SyntaxNode): boolean =>
  !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

/** `Cart`, `Cart<T>`, `fmt::Formatter`, `&mut Cart` -> the type's own name. */
function typeName(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "type_identifier":
    case "primitive_type":
      return node.text;
    case "generic_type":
      return typeName(node.childForFieldName("type"));
    case "scoped_type_identifier":
      return node.childForFieldName("name")?.text;
    case "reference_type":
    case "pointer_type":
      return typeName(node.childForFieldName("type"));
  }
  return undefined;
}

function head(decl: SyntaxNode): string {
  const body = decl.childForFieldName("body");
  return body ? decl.text.slice(0, body.startIndex - decl.startIndex) : decl.text;
}

const COMMENT = new Set(["line_comment", "block_comment"]);
const WHOLE = new Set(["struct_item", "enum_item", "union_item", "type_item"]);

function definitions(root: SyntaxNode): Definition[] {
  const out: Definition[] = [];
  const walk = (container: SyntaxNode, scope: string[]): void => {
    let attrs: SyntaxNode[] = [];
    for (const node of named(container)) {
      if (node.type === "attribute_item") {
        attrs.push(node);
        continue;
      }
      if (COMMENT.has(node.type)) continue;
      const pending = attrs;
      attrs = [];
      const prefix = pending.map((a) => `${a.text}\n`).join("");
      const start = pending[0]?.startIndex ?? node.startIndex;
      const push = (nameNode: SyntaxNode, signature: string, body: string): void => {
        out.push({ name: [...scope, nameNode.text].join("."), signature: prefix + signature, body, start, end: node.endIndex, nameStart: nameNode.startIndex, nameEnd: nameNode.endIndex });
      };
      const nameNode = node.childForFieldName("name");
      switch (node.type) {
        case "function_item":
          if (nameNode) push(nameNode, head(node), node.childForFieldName("body")?.text ?? "");
          break;
        case "function_signature_item":
          if (nameNode) push(nameNode, node.text, "");
          break;
        case "const_item":
        case "static_item":
          if (nameNode) push(nameNode, node.childForFieldName("type")?.text ?? "", node.childForFieldName("value")?.text ?? "");
          break;
        case "trait_item":
          if (nameNode) {
            push(nameNode, head(node), "");
            walk(node.childForFieldName("body") ?? node, [...scope, nameNode.text]);
          }
          break;
        case "impl_item": {
          const type = typeName(node.childForFieldName("type"));
          const body = node.childForFieldName("body");
          if (type && body) walk(body, [...scope, type]);
          break;
        }
        case "mod_item": {
          const body = node.childForFieldName("body");
          if (nameNode && body) walk(body, [...scope, nameNode.text]);
          break;
        }
        default:
          if (WHOLE.has(node.type) && nameNode) push(nameNode, node.text, "");
      }
    }
  };
  walk(root, []);
  return out;
}

/** The impl or trait type enclosing `node` (what `Self` and `self` mean), with its scope. */
function selfType(node: SyntaxNode): string[] | undefined {
  const names: string[] = [];
  let found = false;
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "impl_item") {
      const t = typeName(p.childForFieldName("type"));
      if (!t) return undefined;
      names.unshift(t);
      found = true;
    } else if (p.type === "trait_item") {
      const t = p.childForFieldName("name")?.text;
      if (!t) return undefined;
      names.unshift(t);
      found = true;
    } else if (p.type === "mod_item" && found) {
      const m = p.childForFieldName("name")?.text;
      if (m) names.unshift(m);
    }
  }
  return found ? names : undefined;
}

/** Type parameters in scope at `node` (`<T: Shape>` of enclosing items). */
function typeParamsAt(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (let p: SyntaxNode | null = node; p; p = p.parent) {
    const params = p.childForFieldName("type_parameters");
    if (!params) continue;
    for (const tp of named(params)) {
      const n = tp.type === "type_parameter" ? tp.childForFieldName("name") : tp.type === "type_identifier" ? tp : null;
      if (n) names.add(n.text);
    }
  }
  return names;
}

/** `a::b::c` -> ["a","b","c"]; `Self::new` -> [...impl type, "new"] (exact). */
function pathParts(node: SyntaxNode | null | undefined): Reference | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "crate":
    case "self":
    case "super": {
      if (node.text === "Self") {
        const t = selfType(node);
        if (!t) return undefined;
        const ref: Reference = [...t];
        ref.exact = true;
        return ref;
      }
      return [node.text];
    }
    case "generic_type": {
      const t = node.childForFieldName("type");
      return t ? pathParts(t) : undefined;
    }
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const name = node.childForFieldName("name")?.text;
      if (!name) return undefined;
      const path = node.childForFieldName("path");
      if (!path) return [name]; // `::name`
      const left = pathParts(path);
      if (!left) return undefined;
      const ref: Reference = [...left, name];
      if (left.exact) ref.exact = true;
      return ref;
    }
  }
  return undefined;
}

const SCOPED = new Set(["scoped_identifier", "scoped_type_identifier"]);
const DECLARED_NAME = new Set(["struct_item", "enum_item", "union_item", "type_item", "trait_item", "type_parameter", "associated_type"]);

/** Outermost path nodes and identifiers in use position, outside `use`/`mod` declarations. */
function references(root: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  const add = (ref: Reference | undefined, at: SyntaxNode): void => {
    if (!ref || !ref.length) return;
    if (ref.length === 1 && typeParamsAt(at).has(ref[0])) return;
    out.push(ref);
  };
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "use_declaration":
      case "attribute_item":
      case "extern_crate_declaration":
        return;
      case "mod_item":
        if (!node.childForFieldName("body")) return;
        break;
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const target = fn?.type === "generic_function" ? fn.childForFieldName("function") : fn;
        if (target?.type === "identifier") add([target.text], target);
        else if (target?.type === "field_expression" && target.childForFieldName("value")?.type === "self") {
          const t = selfType(target);
          const field = target.childForFieldName("field")?.text;
          if (t && field) {
            const ref: Reference = [...t, field];
            ref.exact = true;
            add(ref, target);
          }
        }
        break;
      }
      case "scoped_identifier":
      case "scoped_type_identifier":
        if (!(node.parent && SCOPED.has(node.parent.type) && same(node.parent.childForFieldName("path"), node))) add(pathParts(node), node);
        return;
      case "type_identifier": {
        const p = node.parent;
        if (p && DECLARED_NAME.has(p.type) && same(p.childForFieldName("name"), node)) break;
        add(pathParts(node), node);
        break;
      }
      case "token_tree":
        out.push(...macroPaths(node));
        return;
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return out;
}

/**
 * Paths inside macro arguments (token trees are not parsed as expressions): calls
 * (`calc_total(` / `pricing::calc_total(`), multi-segment paths (`crate::pricing::RATE`), and
 * method calls on `self` (`self.total(` in `impl Cart` -> `Cart.total`, exact). Recursive.
 */
function macroPaths(tree: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  let path: string[] = [];
  let expectName = true;
  let selfDot = false;
  const flush = (call: boolean): void => {
    if (path.length && (call || path.length > 1)) out.push(path);
    path = [];
  };
  for (const c of tree.children) {
    if (!c) continue;
    if (c.type === "identifier" || c.type === "crate" || c.type === "self" || c.type === "super") {
      if (selfDot) {
        const t = selfType(c);
        selfDot = false;
        if (t) {
          const ref: Reference = [...t, c.text];
          ref.exact = true;
          path = ref;
          expectName = false;
          continue;
        }
      }
      if (!expectName) flush(false);
      path = [...path, c.text];
      expectName = false;
      continue;
    }
    if (c.type === "::") {
      expectName = true;
      continue;
    }
    if (c.type === "." && path.length === 1 && path[0] === "self") {
      selfDot = true;
      path = [];
      continue;
    }
    const call = c.type === "token_tree" && c.text.startsWith("(");
    const exact = (path as Reference).exact;
    if (exact) {
      if (call) out.push(path);
      path = [];
    } else flush(call);
    selfDot = false;
    expectName = true;
    if (c.type === "token_tree") out.push(...macroPaths(c));
  }
  if (!(path as Reference).exact) flush(false);
  return out;
}

/** Bindings a `use` tree introduces, under module path `prefix`. */
function useBindings(node: SyntaxNode, prefix: string[], out: ImportBinding[]): void {
  const bind = (parts: string[], local?: string): void => {
    if (!parts.length) return;
    const last = parts[parts.length - 1];
    if (last === "self") {
      const module = parts.slice(0, -1);
      if (module.length) out.push({ local: local ?? module[module.length - 1], module: module.join("::") });
    } else if (parts.length === 1) out.push({ local: local ?? last, module: last });
    else out.push({ local: local ?? last, module: parts.slice(0, -1).join("::"), name: last });
  };
  switch (node.type) {
    case "identifier":
    case "crate":
    case "self":
    case "super":
    case "scoped_identifier": {
      const parts = pathParts(node);
      if (parts && !parts.exact) bind([...prefix, ...parts]);
      break;
    }
    case "use_as_clause": {
      const parts = pathParts(node.childForFieldName("path"));
      const alias = node.childForFieldName("alias")?.text;
      if (parts && alias && alias !== "_") bind([...prefix, ...parts], alias);
      break;
    }
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const parts = path ? pathParts(path) : [];
      const list = node.childForFieldName("list");
      if (parts && list) for (const c of named(list)) useBindings(c, [...prefix, ...parts], out);
      break;
    }
    case "use_list":
      for (const c of named(node)) useBindings(c, prefix, out);
      break;
    // use_wildcard (`a::*`): not tracked.
  }
}

const ROOTED = new Set(["crate", "self", "super"]);

function imports(root: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  // A path spelled from the crate root or the current module in code
  // (`crate::pricing::calc_total(..)`) binds itself: the item is the first CamelCase segment
  // (a type, whose members follow) or else the last one.
  const rooted = (parts: Reference | undefined): void => {
    if (!parts || parts.exact || parts.length < 2 || !ROOTED.has(parts[0])) return;
    let item = parts.findIndex((p, i) => i > 0 && /^[A-Z]/.test(p));
    if (item < 0) item = parts.length - 1;
    out.push({ local: parts.slice(0, item + 1).join("."), module: parts.slice(0, item).join("::"), name: parts[item] });
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg) useBindings(arg, [], out);
      return;
    }
    if (node.type === "mod_item" && !node.childForFieldName("body")) {
      const name = node.childForFieldName("name")?.text;
      if (name) out.push({ local: name, module: `self::${name}` });
      return;
    }
    if (SCOPED.has(node.type)) {
      rooted(pathParts(node));
      return;
    }
    if (node.type === "token_tree") {
      macroPaths(node).forEach(rooted);
      return;
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return out;
}

/** The crate's `src/` directory for `fromRel`: next to the nearest Cargo.toml, else the nearest `src` ancestor. */
function crateSrc(fromRel: string, exists?: Exists): string | undefined {
  if (exists) {
    for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
      const d = dir === "." || dir === "/" ? "" : dir;
      if (exists(d ? `${d}/Cargo.toml` : "Cargo.toml")) return d ? `${d}/src` : "src";
      if (!d) break;
    }
  }
  const segs = fromRel.split("/");
  const i = segs.lastIndexOf("src", segs.length - 2);
  return i >= 0 ? segs.slice(0, i + 1).join("/") : undefined;
}

/** Module path of file `fromRel` under `src`: src/a/b.rs and src/a/b/mod.rs are ["a","b"]; lib.rs/main.rs []. */
function modulePath(fromRel: string, src: string): string[] | undefined {
  if (!fromRel.startsWith(`${src}/`)) return undefined;
  const segs = fromRel.slice(src.length + 1).replace(/\.rs$/, "").split("/");
  if (segs[segs.length - 1] === "mod") segs.pop();
  else if (segs.length === 1 && (segs[0] === "lib" || segs[0] === "main")) segs.pop();
  return segs;
}

function moduleFile(src: string, parts: string[], fromRel: string, current: string[], exists?: Exists): string | undefined {
  if (parts.join("/") === current.join("/")) return fromRel;
  const base = posix.join(src, ...parts);
  return firstExisting(parts.length ? [`${base}.rs`, `${base}/mod.rs`] : [`${src}/lib.rs`, `${src}/main.rs`], exists);
}

function resolveModule(module: string, fromRel: string, exists?: Exists): string | undefined {
  const src = crateSrc(fromRel, exists);
  if (src === undefined) return undefined;
  const current = modulePath(fromRel, src);
  if (!current) return undefined;
  const parts = module.split("::").filter(Boolean);
  if (parts[0] === "crate") return moduleFile(src, parts.slice(1), fromRel, current, exists);
  if (parts[0] === "self" || parts[0] === "super") {
    let base = [...current];
    let i = parts[0] === "self" ? 1 : 0;
    for (; parts[i] === "super"; i++) {
      if (!base.length) return undefined;
      base = base.slice(0, -1);
    }
    return moduleFile(src, [...base, ...parts.slice(i)], fromRel, current, exists);
  }
  // A bare first segment: a child module of this one, else of the crate root, else external.
  if (!exists) return undefined;
  for (const base of [current, []]) {
    const file = moduleFile(src, [...base, ...parts], fromRel, current, exists);
    if (file && file !== fromRel && exists(file)) return file;
  }
  return undefined;
}

export const rust: TreeSitterLanguage = {
  id: "rust",
  name: "Rust",
  extensions: [".rs"],
  grammar: "tree-sitter-rust.wasm",
  definitions,
  references,
  imports,
  resolveModule,
  memberModule: (module, name) => `${module}::${name}`,
  identifierTypes: ["identifier", "type_identifier", "field_identifier"],
};
