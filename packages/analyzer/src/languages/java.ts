// Java on the tree-sitter backend (grammar: tree-sitter-java 0.23.5).
//
// Declarations: classes, interfaces, enums, records and annotation types (nested ones qualified,
// `Pricing.Kind`), methods (`Pricing.calcTotal`; overloads share one key, which the engine merges),
// fields (one key per declarator), enum constants (`Kind.A`) and record components (`Pair.a`).
// A type's signature is its header (modifiers, type parameters, `extends`/`implements`, record
// components) plus the signatures of its constructors: callers reach a constructor through the
// class name (`new Pricing(...)`), so a constructor change is a change to the class's contract.
// A method's signature is everything before its body: annotations, modifiers, type parameters,
// return type, parameters, `throws`. A field's signature is its modifiers, type and name; its
// initializer is the body. Comments and documentary annotations (`@Override`, `@Deprecated`,
// `@SuppressWarnings`, ...) are not part of any signature.
//
// References: method calls (`calcTotal(...)`, `this.tax()`, `Fmt.round(...)`), `new` and every
// type use (fields, parameters, returns, generics, `extends`/`implements`, casts, `throws`),
// annotations, field accesses (`Item.ZERO`), method references (`Pricing::calcTotal`) and bare
// identifiers that name a member of an enclosing class (unqualified `TAX_RATE`, `tax()`).
//
// Imports: `import a.b.C;`, `import a.b.C.Inner;`, `import static a.b.C.m;`, and `import a.b.*;`.
// Classes resolve by package path under src/main/java, src/main/kotlin, src/, the checkout root
// and the importing file's ancestors (multi-module builds), as `.java` then `.kt`. Classes of the
// file's own package and of wildcard-imported packages are visible without an import; they
// resolve to `Name.java`/`Name.kt` next to the file or in the wildcard package. Static wildcard
// imports (`import static a.b.C.*;`) are not followed.
import type { Definition, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { exact, header, implicitBindings, importBinding, named, perRoot, resolveJvmModule, sameNode } from "./jvm.js";

const TYPE_DECL = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const CONSTRUCTOR = new Set(["constructor_declaration", "compact_constructor_declaration"]);
const METHOD = new Set(["method_declaration", "annotation_type_element_declaration"]);
const FIELD = new Set(["field_declaration", "constant_declaration"]);
const BODY = new Set(["class_body", "interface_body", "enum_body", "enum_body_declarations", "annotation_type_body"]);

const definitions = perRoot((root: SyntaxNode): Definition[] => {
  const out: Definition[] = [];
  const walk = (node: SyntaxNode, scope: string[]): void => {
    for (const child of named(node)) {
      if (TYPE_DECL.has(child.type)) {
        const name = child.childForFieldName("name")?.text;
        if (!name) continue;
        const q = [...scope, name];
        const body = child.childForFieldName("body");
        const ctors = body ? constructors(body).map((c) => header(c, c.childForFieldName("body")?.startIndex ?? c.endIndex)) : [];
        out.push({ name: q.join("."), signature: [header(child, body?.startIndex ?? child.endIndex), ...ctors].join("\n"), body: body?.text ?? "" });
        if (child.type === "record_declaration") {
          for (const p of named(child.childForFieldName("parameters") ?? child)) {
            const pn = p.childForFieldName("name")?.text;
            if (p.type === "formal_parameter" && pn) out.push({ name: [...q, pn].join("."), signature: header(p), body: "" });
          }
        }
        if (body) walk(body, q);
      } else if (METHOD.has(child.type)) {
        const name = child.childForFieldName("name")?.text;
        const body = child.childForFieldName("body");
        if (name) out.push({ name: [...scope, name].join("."), signature: header(child, body?.startIndex ?? child.endIndex), body: body?.text ?? "" });
      } else if (FIELD.has(child.type)) {
        const declarators = child.childrenForFieldName("declarator").filter((d): d is SyntaxNode => d !== null);
        const prefix = declarators[0] ? header(child, declarators[0].startIndex) : "";
        for (const d of declarators) {
          const name = d.childForFieldName("name")?.text;
          if (!name) continue;
          const dims = d.childForFieldName("dimensions")?.text ?? "";
          out.push({ name: [...scope, name].join("."), signature: `${prefix} ${name}${dims}`, body: d.childForFieldName("value")?.text ?? "" });
        }
      } else if (child.type === "enum_constant") {
        const name = child.childForFieldName("name")?.text;
        if (name) out.push({ name: [...scope, name].join("."), signature: name, body: child.text });
      } else if (BODY.has(child.type)) {
        walk(child, scope);
      }
    }
  };
  walk(root, []);
  return out;
});

function constructors(body: SyntaxNode): SyntaxNode[] {
  return named(body).filter((c) => CONSTRUCTOR.has(c.type));
}

/** The class paths a bare name inside `classes` (`["Outer", "Inner"]`) may be a member of, innermost first. */
function enclosing(classes: string[]): string[][] {
  const out: string[][] = [];
  for (let n = classes.length; n >= 1; n--) out.push(classes.slice(0, n));
  return out;
}

/** `a.b.c` / `this.x` / `Outer.Inner` as a reference path; undefined for anything else. */
function dotted(node: SyntaxNode, classes: string[]): Reference | undefined {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return [node.text];
    case "this":
      return classes.length ? exact(classes) : undefined;
    case "field_access": {
      const object = node.childForFieldName("object");
      const field = node.childForFieldName("field");
      const head = object ? dotted(object, classes) : undefined;
      if (!head || !field) return undefined;
      const ref: Reference = [...head, field.text];
      if (head.exact) ref.exact = true;
      return ref;
    }
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const parts = named(node);
      const scope = parts.length > 1 ? dotted(parts[0]!, classes) : undefined;
      const last = parts[parts.length - 1];
      return scope && last ? [...scope, last.text] : undefined;
    }
    case "generic_type":
      return named(node)[0] ? dotted(named(node)[0]!, classes) : undefined;
    default:
      return undefined;
  }
}

/** Identifier parents where the identifier is a declaration, a label, or handled elsewhere. */
const NOT_A_USE = new Set([
  "scoped_identifier", "package_declaration", "import_declaration", "inferred_parameters", "lambda_expression",
  "labeled_statement", "break_statement", "continue_statement", "method_reference", "formal_parameter",
  "catch_formal_parameter", "spread_parameter", "enum_constant", "element_value_pair", "resource",
  "marker_annotation", "annotation",
]);

const references = perRoot((root: SyntaxNode): Reference[] => {
  const out: Reference[] = [];
  const add = (ref: Reference | undefined): void => {
    if (ref) out.push(ref);
  };
  const member = (classes: string[], name: string): void => {
    for (const cls of enclosing(classes)) out.push(exact([...cls, name]));
    out.push(exact([name])); // static import
  };
  const visit = (node: SyntaxNode, parent: SyntaxNode | null, classes: string[]): void => {
    let inner = classes;
    switch (node.type) {
      case "method_invocation": {
        const object = node.childForFieldName("object");
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        if (!object) member(classes, name);
        else if (object.type !== "super") {
          const head = dotted(object, classes);
          if (head) {
            const ref: Reference = [...head, name];
            if (head.exact) ref.exact = true;
            out.push(ref);
          }
        }
        break;
      }
      case "field_access":
        if (parent?.type !== "field_access" && !sameNode(parent?.childForFieldName("object"), node)) add(dotted(node, classes));
        break;
      case "type_identifier":
      case "scoped_type_identifier": {
        if (parent?.type === "scoped_type_identifier") break;
        const ref = dotted(node, classes);
        if (!ref) break;
        // `Kind` inside `Pricing` may be the nested `Pricing.Kind`.
        for (const cls of enclosing(classes)) out.push(exact([...cls, ...ref]));
        out.push(ref);
        break;
      }
      case "marker_annotation":
      case "annotation": {
        const name = node.childForFieldName("name");
        if (name) add(dotted(name, classes));
        break;
      }
      case "method_reference": {
        const parts = named(node);
        const head = parts[0] ? dotted(parts[0], classes) : undefined;
        const last = parts[parts.length - 1];
        if (head && last && parts.length > 1 && last.type === "identifier") out.push([...head, last.text]);
        break;
      }
      case "identifier": {
        // `name` of a declaration or call and `field` of an access are handled above; the
        // object of `items.size()` is a use (of `this.items` when the class declares it).
        if (!parent || NOT_A_USE.has(parent.type) || sameNode(parent.childForFieldName("name"), node) || sameNode(parent.childForFieldName("field"), node)) break;
        member(classes, node.text);
        break;
      }
      default:
        if (TYPE_DECL.has(node.type)) {
          const name = node.childForFieldName("name")?.text;
          if (name) inner = [...classes, name];
        }
    }
    for (const c of named(node)) visit(c, node, inner);
  };
  visit(root, null, []);
  return out;
});

const imports = perRoot((root: SyntaxNode): ImportBinding[] => {
  const explicit: ImportBinding[] = [];
  const wildcards: string[] = [];
  for (const node of named(root)) {
    if (node.type !== "import_declaration") continue;
    const path = named(node).find((c) => c.type === "scoped_identifier" || c.type === "identifier");
    if (!path) continue;
    const isStatic = node.children.some((c) => c?.type === "static");
    if (named(node).some((c) => c.type === "asterisk")) {
      if (!isStatic) wildcards.push(path.text);
      continue;
    }
    const b = importBinding(path.text.split("."));
    if (b) explicit.push(b);
  }
  const declared = new Set<string>();
  for (const d of definitions(root)) for (const part of d.name.split(".")) declared.add(part);
  const visit = (node: SyntaxNode): void => {
    if (node.type === "type_parameter") {
      const id = named(node).find((c) => c.type === "type_identifier" || c.type === "identifier");
      if (id) declared.add(id.text);
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return [...explicit, ...implicitBindings(references(root), explicit, declared, wildcards)];
});

export const java: TreeSitterLanguage = {
  id: "java",
  name: "Java",
  extensions: [".java"],
  grammar: "tree-sitter-java.wasm",
  definitions,
  references,
  imports,
  resolveModule: (module, fromRel, exists) => resolveJvmModule(module, fromRel, exists, [".java", ".kt"]),
};
