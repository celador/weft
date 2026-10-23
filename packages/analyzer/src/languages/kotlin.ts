// Kotlin on the tree-sitter backend (grammar: @tree-sitter-grammars/tree-sitter-kotlin 1.1.0).
//
// Declarations: classes, interfaces, objects, enum classes (entries as `Kind.A`), type aliases,
// functions and properties at top level and inside classes/objects (`Cart.total`), and
// `val`/`var` primary-constructor parameters (`Cart.items`). Companion-object members are
// qualified by the class (`Cart.create`), the way callers name them. A class's signature is its
// header (modifiers, type parameters, primary constructor, supertypes) plus its secondary
// constructors' headers: `Cart(...)` calls a constructor through the class name. A function's
// signature is everything before its body; an expression body (`= ...`) is the body. A
// property's signature is its modifiers, `val`/`var`, receiver, name and type; the initializer,
// getter/setter or delegate is the body. Comments and documentary annotations (`@Deprecated`,
// `@Suppress`) are not part of any signature; `@JvmStatic`, `@JvmName`, `@Throws` etc. are.
//
// Extension functions and properties (`fun Cart.discount()`) are keyed by their name
// (`discount`), not `Cart.discount`: Kotlin imports them by name (`import shop.discount`) and
// calls them as `cart.discount()`, so the name is what both sides can see. The receiver is part
// of the signature. Extensions of the same name on different receivers share the key, like
// overloads.
//
// References: calls (`calcTotal(...)`, `Cart(...)`, `this.tax()`, `Pricing.create()`,
// `cart.discount()` as the extension `discount`), every type use (`user_type`: parameters,
// returns, generics, supertypes, `is`, annotations), navigation (`Item.ZERO`, `Cart::total`) and
// bare identifiers that name a top-level declaration or a member of an enclosing class
// (or of an extension's receiver).
//
// Imports: `import a.b.C`, `import a.b.C as D`, `import a.b.C.member`, `import a.b.topLevelFn`,
// `import a.b.*`. Classes resolve by package path under src/main/kotlin, src/main/java, src/,
// the checkout root and the importing file's ancestors, as `.kt` then `.java` (Kotlin code
// importing a Java class resolves to the `.java` file). A top-level function or property is
// looked for in the package's `<LastSegment>.kt` (`pricing/Pricing.kt`) or `<Name>.kt`.
// Classes of the file's own directory and of wildcard-imported packages are visible without an
// import.
//
// Same package, no import: a Kotlin package spans files, and any file may declare top-level
// functions, properties and classes under any name. A name the file neither declares nor
// imports resolves through the engine's package index of the file's own directory (the Go
// one: `packageFiles`, `packageName`, `packageDeclaredNames`, with `importsFiles` so imports
// keep naming files): `calcTotal(items)` in `pricing/Checkout.kt` reads
// `pricing/Pricing.kt#calcTotal`. Files of another `package` in the directory and `private`
// top-level declarations are skipped. Same package in another directory (a test source set) is
// not indexed.
import type { Definition, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { children, exact, header, implicitBindings, importBinding, named, perRoot, resolveJvmModule, tail } from "./jvm.js";

const CLASS = new Set(["class_declaration", "object_declaration"]);
const CLASS_BODY = new Set(["class_body", "enum_class_body"]);

function nameOf(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

/** `fun Cart.total()` / `val Cart.size`: the receiver type (a `user_type` before the name's `.`). */
function receiver(node: SyntaxNode): SyntaxNode | undefined {
  const kids = children(node);
  const dot = kids.findIndex((c, i) => c.type === "." && i > 0);
  if (dot < 0) return undefined;
  const r = kids[dot - 1];
  return r && (r.type === "user_type" || r.type === "nullable_type") ? r : undefined;
}

/** First identifier of a user_type (`List<T>` -> `List`, `a.B` -> `a`... the last for dotted). */
function typeName(node: SyntaxNode): string | undefined {
  const ut = node.type === "nullable_type" ? named(node).find((c) => c.type === "user_type") : node;
  const ids = ut ? named(ut).filter((c) => c.type === "identifier") : [];
  return ids[ids.length - 1]?.text;
}

function propertyName(node: SyntaxNode): string | undefined {
  const v = named(node).find((c) => c.type === "variable_declaration");
  return v ? named(v).find((c) => c.type === "identifier")?.text : undefined;
}

/** Where a property's body (initializer, accessors, delegate) starts. */
function propertyBodyStart(node: SyntaxNode): number {
  for (const c of children(node)) if (c.type === "=" || c.type === "getter" || c.type === "setter" || c.type === "property_delegate") return c.startIndex;
  return node.endIndex;
}

const definitions = perRoot((root: SyntaxNode): Definition[] => {
  const out: Definition[] = [];
  const walk = (node: SyntaxNode, scope: string[]): void => {
    for (const child of named(node)) {
      if (CLASS.has(child.type)) {
        const name = nameOf(child);
        if (!name) continue;
        const q = [...scope, name];
        const body = named(child).find((c) => CLASS_BODY.has(c.type));
        const secondary = body ? named(body).filter((c) => c.type === "secondary_constructor") : [];
        const ctors = secondary.map((c) => header(c, children(c).find((k) => k.type === ":" || k.type === "block")?.startIndex ?? c.endIndex));
        out.push({ name: q.join("."), signature: [header(child, body?.startIndex ?? child.endIndex), ...ctors].join("\n"), body: body?.text ?? "" });
        const params = named(child).find((c) => c.type === "primary_constructor");
        for (const p of params ? named(named(params).find((c) => c.type === "class_parameters") ?? params) : []) {
          if (p.type !== "class_parameter" || !children(p).some((c) => c.type === "val" || c.type === "var")) continue;
          const pn = named(p).find((c) => c.type === "identifier")?.text;
          const eq = children(p).find((c) => c.type === "=");
          if (pn) out.push({ name: [...q, pn].join("."), signature: header(p, eq?.startIndex ?? p.endIndex), body: eq ? tail(p, eq.startIndex) : "" });
        }
        if (body) walk(body, q);
      } else if (child.type === "companion_object") {
        const body = named(child).find((c) => c.type === "class_body");
        if (body) walk(body, scope); // `Cart.create()`, not `Cart.Companion.create()`
      } else if (child.type === "function_declaration") {
        const name = nameOf(child);
        const body = named(child).find((c) => c.type === "function_body");
        const q = receiver(child) && scope.length === 0 ? [name] : [...scope, name];
        if (name) out.push({ name: q.join("."), signature: header(child, body?.startIndex ?? child.endIndex), body: body?.text ?? "" });
      } else if (child.type === "property_declaration") {
        const name = propertyName(child);
        if (!name) continue;
        const start = propertyBodyStart(child);
        const q = receiver(child) && scope.length === 0 ? [name] : [...scope, name];
        out.push({ name: q.join("."), signature: header(child, start), body: tail(child, start) });
      } else if (child.type === "type_alias") {
        const name = child.childForFieldName("type")?.text;
        if (name) out.push({ name: [...scope, name].join("."), signature: header(child), body: "" });
      } else if (child.type === "enum_entry") {
        const name = named(child).find((c) => c.type === "identifier")?.text;
        if (name) out.push({ name: [...scope, name].join("."), signature: name, body: child.text });
      }
    }
  };
  walk(root, []);
  return out;
});

/**
 * Where a name is used: the enclosing classes/objects (`["Outer", "Cart"]`) and the receiver
 * of the innermost extension (`fun Cart.discount() { total() }` reads `Cart.total`).
 */
type Scope = { classes: string[]; receiver?: string };

/** The class paths a bare name may be a member of, innermost first. */
function enclosing(scope: Scope): string[][] {
  const out: string[][] = [];
  if (scope.receiver) out.push([scope.receiver]);
  for (let n = scope.classes.length; n >= 1; n--) out.push(scope.classes.slice(0, n));
  return out;
}

/** `a.b.c` / `this.x` / `Cart::total` as a reference path; undefined for anything else. */
function dotted(node: SyntaxNode, scope: Scope): Reference | undefined {
  if (node.type === "identifier") return [node.text];
  if (node.type === "this_expression") {
    const cls = enclosing(scope)[0];
    return cls ? exact(cls) : undefined;
  }
  if (node.type !== "navigation_expression") return undefined;
  const parts = named(node);
  const last = parts[parts.length - 1];
  const head = parts.length === 2 ? dotted(parts[0]!, scope) : undefined;
  if (!head || last?.type !== "identifier") return undefined;
  const ref: Reference = [...head, last.text];
  if (head.exact) ref.exact = true;
  return ref;
}

/** Identifier parents where the identifier is a declaration, a type (see user_type), or handled elsewhere. */
const NOT_A_USE = new Set([
  "variable_declaration", "parameter", "class_parameter", "function_declaration", "class_declaration",
  "object_declaration", "companion_object", "user_type", "qualified_identifier", "import", "package_header",
  "navigation_expression", "type_alias", "enum_entry", "type_parameter", "annotation", "label",
  "call_expression", "lambda_parameters", "callable_reference", "jump_expression",
]);

const references = perRoot((root: SyntaxNode): Reference[] => {
  const out: Reference[] = [];
  const member = (scope: Scope, name: string): void => {
    for (const cls of enclosing(scope)) out.push(exact([...cls, name]));
    out.push(exact([name])); // a top-level declaration of this file, or an imported name
  };
  const visit = (node: SyntaxNode, parent: SyntaxNode | null, scope: Scope): void => {
    let inner = scope;
    switch (node.type) {
      case "class_declaration":
      case "object_declaration": {
        const name = nameOf(node);
        if (name) inner = { classes: [...scope.classes, name] };
        break;
      }
      case "function_declaration":
      case "property_declaration": {
        const r = receiver(node);
        const name = r ? typeName(r) : undefined;
        if (name) inner = { classes: scope.classes, receiver: name };
        break;
      }
      case "call_expression": {
        const callee = named(node)[0];
        if (!callee) break;
        if (callee.type === "identifier") member(scope, callee.text);
        else {
          const ref = dotted(callee, scope);
          if (ref) {
            out.push(ref);
            // `cart.discount()` may be the extension `discount` (top-level or imported).
            if (ref.length > 1 && !ref.exact) out.push(exact([ref[ref.length - 1]!]));
          }
        }
        break;
      }
      case "navigation_expression": {
        const isCallee = parent?.type === "call_expression" && named(parent)[0]?.startIndex === node.startIndex;
        if (parent?.type !== "navigation_expression" && !isCallee) {
          const ref = dotted(node, scope);
          if (ref) out.push(ref);
        }
        break;
      }
      case "user_type": {
        if (parent?.type === "user_type") break;
        const ids = named(node).filter((c) => c.type === "identifier").map((c) => c.text);
        if (!ids.length) break;
        for (const cls of enclosing(scope)) out.push(exact([...cls, ...ids])); // nested `Cart.Line`
        out.push(ids);
        break;
      }
      case "identifier": {
        if (!parent || NOT_A_USE.has(parent.type)) break;
        // The name of a named argument (`f(name = x)`) is not a use.
        if (parent.type === "value_argument" && children(parent).some((c) => c.type === "=") && named(parent)[0]?.startIndex === node.startIndex) break;
        member(scope, node.text);
        break;
      }
    }
    for (const c of named(node)) visit(c, node, inner);
  };
  visit(root, null, { classes: [] });
  return out;
});

const imports = perRoot((root: SyntaxNode): ImportBinding[] => {
  const explicit: ImportBinding[] = [];
  const wildcards: string[] = [];
  for (const node of named(root)) {
    if (node.type !== "import") continue;
    const path = named(node).find((c) => c.type === "qualified_identifier");
    if (!path) continue;
    const parts = named(path).map((c) => c.text);
    if (children(node).some((c) => c.type === "*")) {
      wildcards.push(parts.join("."));
      continue;
    }
    const alias = children(node).some((c) => c.type === "as") ? named(node).filter((c) => c.type === "identifier").pop()?.text : undefined;
    const b = importBinding(parts, alias);
    if (b) explicit.push(b);
  }
  const declared = new Set<string>();
  for (const d of definitions(root)) for (const part of d.name.split(".")) declared.add(part);
  const visit = (node: SyntaxNode): void => {
    if (node.type === "type_parameter") {
      const id = named(node).find((c) => c.type === "identifier");
      if (id) declared.add(id.text);
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return [...explicit, ...implicitBindings(references(root), explicit, declared, wildcards)];
});

function packageName(text: string): string | undefined {
  return /^\s*package\s+([\w.]+)/m.exec(text.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1];
}

const IDENT = "[\\p{L}_][\\p{L}\\p{N}_]*";
// `fun <T> List<T>.second(`, `fun Cart.discount(`, `fun calcTotal(`: the name right before `(`.
const FUN = new RegExp(`\\bfun\\b[^(={\\n]*?(${IDENT})\\s*\\(`, "gu");
// `val TAX_RATE`, `var Cart.note`, `val <T> List<T>.head`: the last identifier before `:`/`=`/`by`/EOL.
const PROP = new RegExp(`\\b(?:val|var)\\b[^:=\\n]*?(${IDENT})\\s*(?=[:=\\n]|\\bby\\b|$)`, "gmu");
const TYPE = new RegExp(`\\b(?:class|interface|object|typealias)\\s+(${IDENT})`, "gu");

/** Names a Kotlin file may declare at top level, from its text (over-approximate; the index parses to confirm). */
function packageDeclaredNames(text: string): string[] {
  const out: string[] = [];
  for (const re of [FUN, PROP, TYPE]) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** `private` top-level declarations are file-private; everything else is visible package-wide. */
function packageVisible(d: Definition): boolean {
  const kw = /\b(?:fun|val|var|class|interface|object|typealias)\b/.exec(d.signature);
  return !/\bprivate\b/.test(kw ? d.signature.slice(0, kw.index) : d.signature);
}

export const kotlin: TreeSitterLanguage = {
  id: "kotlin",
  name: "Kotlin",
  extensions: [".kt", ".kts"],
  grammar: "tree-sitter-kotlin.wasm",
  definitions,
  references,
  imports,
  resolveModule: (module, fromRel, exists, checkout) => resolveJvmModule(module, fromRel, exists, [".kt", ".java"], checkout),
  packageFiles: (_dir, entries) => entries.filter((e) => e.endsWith(".kt")),
  importsFiles: true,
  packageVisible,
  packageName,
  packageDeclaredNames,
};
