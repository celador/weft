// Python on the tree-sitter backend (grammar: tree-sitter-python 0.25.0).
//
// Declarations: functions, classes (methods and nested classes qualified, `Cart.total`), and
// module- or class-level assignments (`RATE = 0.2`, `size: int = 3`). Decorators are part of a
// declaration's signature (`@staticmethod` changes how it is called). For an assignment the
// annotation is the signature and the value is the body.
//
// References: call targets, decorators, base classes, type annotations, and attribute chains
// (`pricing.calc_total`, `self.tax` resolved to the enclosing class).
//
// Imports: `import a.b`, `import a.b as c`, `from m import x as y`, relative imports.
// Modules resolve to `m.py` or `m/__init__.py`, relative to the file for relative imports and,
// for absolute ones, against the checkout root, `src/`, and the importing file's ancestors.
import { posix } from "node:path";
import type { Definition, Exists, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { firstExisting } from "../treesitter.js";

const DEF = new Set(["function_definition", "class_definition"]);

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function definitions(root: SyntaxNode): Definition[] {
  const out: Definition[] = [];
  const walk = (node: SyntaxNode, scope: string[], inFunction: boolean): void => {
    for (const child of named(node)) {
      const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (def && DEF.has(def.type)) {
        const nameNode = def.childForFieldName("name");
        const body = def.childForFieldName("body");
        if (!nameNode) continue;
        const qualified = [...scope, nameNode.text];
        const outer = child; // includes decorators when decorated
        const signature = body ? outer.text.slice(0, body.startIndex - outer.startIndex) : outer.text;
        out.push({ name: qualified.join("."), signature, body: body?.text ?? "", start: outer.startIndex, end: outer.endIndex, nameStart: nameNode.startIndex, nameEnd: nameNode.endIndex });
        if (body) walk(body, qualified, def.type === "function_definition");
        continue;
      }
      if (child.type === "expression_statement") {
        if (inFunction) continue; // locals are not declarations other agents can depend on
        for (const assignment of named(child)) {
          if (assignment.type !== "assignment") continue;
          const left = assignment.childForFieldName("left");
          if (left?.type !== "identifier") continue;
          out.push({
            name: [...scope, left.text].join("."),
            signature: assignment.childForFieldName("type")?.text ?? "",
            body: assignment.childForFieldName("right")?.text ?? "",
            start: assignment.startIndex,
            end: assignment.endIndex,
            nameStart: left.startIndex,
            nameEnd: left.endIndex,
          });
        }
        continue;
      }
      // if / try / with / for blocks at module or class level can declare too.
      if (/_statement$|_clause$|^block$/.test(child.type)) walk(child, scope, inFunction);
    }
  };
  walk(root, [], false);
  return out;
}

/** Enclosing class path for `self`/`cls`, e.g. ["Outer", "Cart"]. */
function enclosingClass(node: SyntaxNode): string[] | undefined {
  const names: string[] = [];
  let classFound = false;
  for (let p = node.parent; p; p = p.parent) {
    if (!DEF.has(p.type)) continue;
    const name = p.childForFieldName("name")?.text;
    if (!name) continue;
    if (p.type === "class_definition") classFound = true;
    if (classFound) names.unshift(name);
  }
  return classFound ? names : undefined;
}

/** `a.b.c` → ["a","b","c"]; `self.x` → [...class, "x"]; undefined for anything else. */
function dotted(node: SyntaxNode): Reference | undefined {
  if (node.type === "identifier") return [node.text];
  if (node.type !== "attribute") return undefined;
  const object = node.childForFieldName("object");
  const attribute = node.childForFieldName("attribute");
  if (!object || !attribute) return undefined;
  if (object.type === "identifier" && (object.text === "self" || object.text === "cls")) {
    const cls = enclosingClass(node);
    if (!cls) return undefined;
    const ref: Reference = [...cls, attribute.text];
    ref.exact = true;
    return ref;
  }
  const head = dotted(object);
  if (!head) return undefined;
  const ref: Reference = [...head, attribute.text];
  if (head.exact) ref.exact = true;
  return ref;
}

function references(root: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  const add = (node: SyntaxNode | null | undefined): void => {
    const ref = node ? dotted(node) : undefined;
    if (ref) out.push(ref);
  };
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "call":
        add(node.childForFieldName("function"));
        break;
      case "decorator":
        for (const c of named(node)) add(c.type === "call" ? c.childForFieldName("function") : c);
        break;
      case "class_definition":
      {
        const bases = node.childForFieldName("superclasses");
        if (bases) for (const c of named(bases)) add(c);
        break;
      }
      case "type":
        for (const id of [node, ...descendants(node)]) {
          if ((id.type === "identifier" && id.parent?.type !== "attribute") || (id.type === "attribute" && id.parent?.type !== "attribute")) add(id);
        }
        break;
      case "attribute":
        if (node.parent?.type !== "attribute") add(node);
        break;
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return out;
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const c of named(node)) out.push(c, ...descendants(c));
  return out;
}

function imports(root: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "import_statement") {
      for (const n of node.childrenForFieldName("name")) {
        if (!n) continue;
        if (n.type === "aliased_import") {
          const module = n.childForFieldName("name")?.text;
          const alias = n.childForFieldName("alias")?.text;
          if (module && alias) out.push({ local: alias, module });
        } else out.push({ local: n.text, module: n.text });
      }
      return;
    }
    if (node.type === "import_from_statement") {
      const module = node.childForFieldName("module_name")?.text;
      if (!module) return;
      for (const n of node.childrenForFieldName("name")) {
        if (!n) continue;
        if (n.type === "aliased_import") {
          const name = n.childForFieldName("name")?.text;
          const alias = n.childForFieldName("alias")?.text;
          if (name && alias) out.push({ local: alias, module, name });
        } else out.push({ local: n.text, module, name: n.text });
      }
      return;
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return out;
}

function candidates(dir: string, parts: string[]): string[] {
  const base = parts.length ? posix.join(dir, ...parts) : dir;
  return parts.length ? [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`] : [`${base}/__init__.py`];
}

function resolveModule(module: string, fromRel: string, exists?: Exists): string | undefined {
  const dots = /^\.*/.exec(module)![0].length;
  const parts = module.slice(dots).split(".").filter(Boolean);
  if (dots > 0) {
    let dir = posix.dirname(fromRel);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    return firstExisting(candidates(dir, parts), exists);
  }
  if (!exists) return undefined; // cannot tell `typing` from a local module without the checkout
  const roots = ["", "src"];
  for (let dir = posix.dirname(fromRel); dir !== "." && dir !== "/" && dir !== ""; dir = posix.dirname(dir)) roots.push(dir);
  for (const root of roots) {
    const hit = firstExisting(candidates(root || ".", parts), exists);
    if (hit) return hit;
  }
  return undefined;
}

export const python: TreeSitterLanguage = {
  id: "python",
  name: "Python",
  extensions: [".py", ".pyi"],
  grammar: "tree-sitter-python.wasm",
  definitions,
  references,
  imports,
  resolveModule,
  memberModule: (module, name) => (module.endsWith(".") ? `${module}${name}` : `${module}.${name}`),
};
