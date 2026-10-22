// C and C++ on the tree-sitter backend (grammars: tree-sitter-c 0.24.1, tree-sitter-cpp 0.23.4).
//
// One spec serves both languages; C++ adds classes, namespaces, templates and `::`.
//
// Declarations: functions (definitions and prototypes), structs / classes / unions / enums and
// their members (`Cart.total`, `Cart.items`), enumerators (unscoped enums declare `RED` in the
// enclosing scope, `enum class Color` declares `Color.Red`), typedefs, `using` aliases, global
// variables, and macros (`#define`). Namespaces qualify (`shop.Cart.total`); an out-of-line
// definition `int shop::Cart::total() const { ... }` is keyed `shop.Cart.total`, like its
// in-class declaration.
//
// Signature vs body: a function's signature is everything before its body (return type,
// qualified name, parameters, `const`, the `template <...>` parameter list, `static`/`inline`);
// constructor initializer lists count as body. A member's access (`public:` / `private:`) is
// part of its signature. A variable's or field's initializer is its body, as is a macro's value
// (a function-like macro's parameter list is its signature). A struct's/class's/enum's
// signature is its head (`class Cart : public Base`), its body the `{ ... }`.
//
// Headers carry the contract: `#include "x.h"` brings every declaration of x.h into scope (the
// engine reads it, and its includes, through `AnalyzeOptions.read`), and a definition in a
// .c/.cpp file that an included header also declares is keyed to the header
// (`shop/pricing.h#calc_total`): callers read the header. A body-only change in the .c is a body
// write on the header's key; a prototype change in the .h is a signature write.
//
// Includes resolve relative to the including file, then against `include/` and `src/` at the
// checkout root (`#include <x.h>` only against those two). System headers resolve nowhere.
//
// References: every identifier and type name used outside a declarator position (calls,
// arguments, types, macro uses, enumerators), qualified names (`shop::calc`, `Color::Red`),
// `this->member`, members of parameters and locals whose declared type is named
// (`cart.total()` with `const shop::Cart &cart` reads `shop.Cart.total`; `auto` and
// expressions are not inferred), and identifiers in macro bodies. An unqualified name inside a class or
// namespace (or an out-of-line member definition) is also tried in each enclosing scope
// (`tax()` in `Cart::total` reads `Cart.tax`).
import { posix } from "node:path";
import type { Definition, Exists, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { firstExisting } from "../treesitter.js";

function named(node: SyntaxNode | null | undefined): SyntaxNode[] {
  return node ? node.namedChildren.filter((c): c is SyntaxNode => c !== null) : [];
}

function same(a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean {
  return !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

/** `text` of `outer` with the ranges of `cut` removed (bodies, initializers). */
function without(outer: SyntaxNode, cut: Array<SyntaxNode | null | undefined>): string {
  const ranges = cut
    .filter((c): c is SyntaxNode => !!c)
    .map((c) => [c.startIndex - outer.startIndex, c.endIndex - outer.startIndex] as const)
    .sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    out += outer.text.slice(at, start);
    at = end;
  }
  return out + outer.text.slice(at);
}

const SPECIFIERS = new Set(["struct_specifier", "class_specifier", "union_specifier", "enum_specifier"]);
const NAME_LEAVES = new Set(["identifier", "field_identifier", "type_identifier", "namespace_identifier", "primitive_type"]);

/** Path segments of a (possibly qualified) name node: `shop::Cart<T>::make` → shop, Cart, make. */
function nameSegments(node: SyntaxNode | null | undefined): string[] | undefined {
  if (!node) return undefined;
  if (NAME_LEAVES.has(node.type)) return [node.text];
  switch (node.type) {
    case "qualified_identifier": {
      const scope = node.childForFieldName("scope");
      const name = nameSegments(node.childForFieldName("name"));
      if (!name) return undefined;
      return scope ? [...(nameSegments(scope) ?? []), ...name] : name; // `::f` (global) has no scope
    }
    case "template_type":
    case "template_function":
    case "template_method":
      return nameSegments(node.childForFieldName("name"));
    case "destructor_name": {
      const id = named(node)[0];
      return id ? [`~${id.text}`] : undefined;
    }
    case "operator_name":
      return [node.text.replace(/\s+/g, "")];
    case "nested_namespace_specifier":
      return named(node).flatMap((c) => nameSegments(c) ?? []);
  }
  return undefined;
}

const DECLARATORS = new Set([
  "function_declarator",
  "pointer_declarator",
  "reference_declarator",
  "array_declarator",
  "init_declarator",
  "attributed_declarator",
  "parenthesized_declarator",
]);

/** The name a declarator declares, and whether it declares a function. */
function declaratorName(node: SyntaxNode | null | undefined): { segments: string[]; fn: boolean } | undefined {
  let fn = false;
  let current = node;
  let depth = 0;
  while (current && DECLARATORS.has(current.type) && depth++ < 32) {
    if (current.type === "function_declarator") fn = true;
    const next: SyntaxNode | null | undefined = current.childForFieldName("declarator") ?? named(current)[0];
    // `int (*fp)(int)` is a variable holding a function pointer, not a function.
    if (current.type === "parenthesized_declarator") fn = false;
    current = next;
  }
  const segments = nameSegments(current);
  return segments ? { segments, fn } : undefined;
}

/** Declarators of a declaration / field_declaration / type_definition. */
function declaratorsOf(node: SyntaxNode): SyntaxNode[] {
  return node.childrenForFieldName("declarator").filter((c): c is SyntaxNode => c !== null);
}

/** Initializer of a declarator (`= 0`, `{1, 2}`, `(3)`), if any. */
function initializerOf(declarator: SyntaxNode): SyntaxNode | null {
  return declarator.type === "init_declarator" ? declarator.childForFieldName("value") : null;
}

type Scope = { path: string[]; access?: string };

function definitions(root: SyntaxNode): Definition[] {
  const out: Definition[] = [];
  const push = (scope: Scope, segments: string[], signature: string, body: string): void => {
    const sig = scope.access ? `${scope.access}: ${signature}` : signature;
    out.push({ name: [...scope.path, ...segments].join("."), signature: sig, body });
  };

  /** A struct/class/union/enum with a body: the type, then its members. */
  const specifier = (spec: SyntaxNode, scope: Scope, outer: SyntaxNode, asName?: string[]): string[] | undefined => {
    const body = spec.childForFieldName("body");
    const segments = asName ?? nameSegments(spec.childForFieldName("name"));
    if (!body || !segments) return undefined;
    push(scope, segments, without(outer, [body]), body.text);
    const inner = [...scope.path, ...segments];
    if (spec.type === "enum_specifier") {
      const scoped = spec.children.some((c) => c?.type === "class" || c?.type === "struct");
      for (const e of named(body)) {
        if (e.type !== "enumerator") continue;
        const name = e.childForFieldName("name")?.text;
        if (!name) continue;
        const enumScope = scoped ? { path: inner } : { path: scope.path, access: scope.access };
        push(enumScope, [name], "", e.childForFieldName("value")?.text ?? "");
      }
    } else {
      walk(body, { path: inner, access: spec.type === "class_specifier" ? "private" : "public" });
    }
    return segments;
  };

  /** Type specifiers declared inline (`struct X {...} x;`, `typedef struct {...} Item;`). */
  const inlineSpecifier = (node: SyntaxNode): SyntaxNode | undefined => {
    const type = node.childForFieldName("type");
    if (!type || !SPECIFIERS.has(type.type) || !type.childForFieldName("body")) return undefined;
    return type;
  };

  const declaration = (node: SyntaxNode, scope: Scope, outer: SyntaxNode): void => {
    const spec = inlineSpecifier(node);
    const specBody = spec?.childForFieldName("body");
    const declarators = declaratorsOf(node);
    if (node.type === "type_definition") {
      // `typedef struct { ... } Item;`: the anonymous struct is Item.
      if (spec && !spec.childForFieldName("name") && declarators.length) {
        const first = nameSegments(declarators[0]) ?? declaratorName(declarators[0])?.segments;
        if (first) specifier(spec, scope, outer, first);
        for (const d of declarators.slice(1)) {
          const n = declaratorName(d) ?? (nameSegments(d) ? { segments: nameSegments(d)!, fn: false } : undefined);
          if (n) push(scope, n.segments, without(outer, [specBody]), "");
        }
        return;
      }
      if (spec) specifier(spec, scope, spec);
      for (const d of declarators) {
        const segments = nameSegments(d) ?? declaratorName(d)?.segments;
        if (segments) push(scope, segments, without(outer, [specBody]), "");
      }
      return;
    }
    if (spec) specifier(spec, scope, spec);
    const value = node.childForFieldName("default_value"); // field_declaration `int n = 0;`
    for (const d of declarators) {
      const n = declaratorName(d);
      if (!n) continue;
      const init = initializerOf(d);
      // Each declarator's signature: the shared head (type, storage) plus its own declarator.
      const head = outer.text.slice(0, declarators[0].startIndex - outer.startIndex);
      const headSig = specBody ? head.replace(specBody.text, "") : head;
      const declSig = without(d, [init]);
      push(scope, n.segments, `${headSig}${declSig}`, (init ?? (declarators.length === 1 ? value : null))?.text ?? "");
    }
  };

  const walk = (node: SyntaxNode, scope: Scope, outerOverride?: SyntaxNode): void => {
    let access = scope.access;
    for (const child of named(node)) {
      const here: Scope = { path: scope.path, access };
      const outer = outerOverride ?? child;
      switch (child.type) {
        case "access_specifier":
          access = child.text.replace(/:$/, "").trim();
          break;
        case "preproc_def":
        case "preproc_function_def": {
          const name = child.childForFieldName("name")?.text;
          if (!name) break;
          const params = child.childForFieldName("parameters")?.text ?? "";
          push({ path: scope.path }, [name], `#define ${name}${params}`, child.childForFieldName("value")?.text.trim() ?? "");
          break;
        }
        case "function_definition": {
          const n = declaratorName(child.childForFieldName("declarator"));
          const body = child.childForFieldName("body");
          if (!n) break;
          const init = named(child).find((c) => c.type === "field_initializer_list");
          push(here, n.segments, without(outer, [body, init]), [init?.text, body?.text].filter(Boolean).join(" "));
          break;
        }
        case "declaration":
        case "field_declaration":
        case "type_definition":
          declaration(child, here, outer);
          break;
        case "alias_declaration": {
          const segments = nameSegments(child.childForFieldName("name"));
          if (segments) push(here, segments, outer.text, "");
          break;
        }
        case "struct_specifier":
        case "class_specifier":
        case "union_specifier":
        case "enum_specifier":
          specifier(child, here, outer);
          break;
        case "template_declaration":
          // The template parameter list is part of the signature of what it declares.
          walk(child, here, outerOverride ?? child);
          break;
        case "namespace_definition": {
          const segments = nameSegments(child.childForFieldName("name")) ?? [];
          const body = child.childForFieldName("body");
          if (body) walk(body, { path: [...scope.path, ...segments] });
          break;
        }
        case "linkage_specification": {
          const body = child.childForFieldName("body");
          if (body?.type === "declaration_list") walk(body, here);
          else if (body) walk(child, here); // `extern "C" int f(void);`
          break;
        }
        case "preproc_ifdef":
        case "preproc_if":
        case "preproc_else":
        case "preproc_elif":
        case "preproc_elifdef":
        case "declaration_list":
          walk(child, here);
          break;
      }
    }
  };
  walk(root, { path: [] });
  return out;
}

const NAME_WRAPPERS = new Set(["qualified_identifier", "template_type", "template_function", "template_method", "destructor_name"]);
const IDENT = /[A-Za-z_]\w*/g;
const KEYWORDS = new Set(["defined", "sizeof", "if", "else", "return", "while", "for", "do", "int", "char", "void", "long", "short", "unsigned", "signed", "const", "static", "struct", "union", "enum"]);
const VARIABLE_DECLARATIONS = new Set(["parameter_declaration", "optional_parameter_declaration", "declaration", "for_range_loop", "field_declaration"]);

/** Where a reference is: enclosing namespaces/classes, and the declared types of locals. */
type Context = { scope: string[]; types?: Map<string, string[]> };

// One top-down pass: scopes and declarator positions are known on the way down, so no node
// ever walks back up the tree (each parent hop is a WASM call; this keeps 2,000 lines at a few ms).
function references(root: SyntaxNode): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  const emit = (ref: Reference): void => {
    const id = `${ref.exact ? "=" : "~"}${ref.join(".")}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(ref);
  };
  /** `path` as written, plus the same path inside each enclosing scope (innermost first). */
  const add = (path: string[], ctx: Context): void => {
    for (let k = ctx.scope.length; k >= 1; k--) {
      const ref: Reference = [...ctx.scope.slice(0, k), ...path];
      ref.exact = true;
      emit(ref);
    }
    emit([...path]);
  };
  const visitAll = (node: SyntaxNode | null | undefined, ctx: Context): void => {
    for (const c of named(node)) visit(c, ctx);
  };
  /** Template arguments inside a (qualified) name are uses: `std::vector<Item>`. */
  const templateArguments = (node: SyntaxNode, ctx: Context): void => {
    for (const c of named(node)) {
      if (c.type === "template_argument_list") visit(c, ctx);
      else if (NAME_WRAPPERS.has(c.type)) templateArguments(c, ctx);
    }
  };
  /** A declarator: the declared name is not a use; sizes, parameters and initializers are. */
  const declarator = (node: SyntaxNode | null | undefined, ctx: Context): void => {
    if (!node) return;
    if (NAME_WRAPPERS.has(node.type)) return templateArguments(node, ctx);
    if (!DECLARATORS.has(node.type)) return; // the name itself
    const inner = node.childForFieldName("declarator");
    for (const c of named(node)) {
      if (same(c, inner) || (node.type === "parenthesized_declarator" || node.type === "attributed_declarator")) declarator(c, ctx);
      else visit(c, ctx);
    }
  };
  /** Record `x` → its declared type, for `x.member` / `x->member`. */
  const declareTypes = (node: SyntaxNode, ctx: Context): void => {
    if (!ctx.types) return;
    let type = node.childForFieldName("type");
    if (type && SPECIFIERS.has(type.type)) type = type.childForFieldName("name");
    const segments = nameSegments(type);
    if (!segments || type?.type === "primitive_type") return;
    for (const d of declaratorsOf(node)) {
      const n = declaratorName(d) ?? (nameSegments(d) ? { segments: nameSegments(d)!, fn: false } : undefined);
      if (n && n.segments.length === 1) ctx.types.set(n.segments[0], segments);
    }
  };
  const specifier = (node: SyntaxNode, ctx: Context): void => {
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!body) {
      const segments = nameSegments(name);
      if (segments) add(segments, ctx); // `struct Cart *c`: a use
      return;
    }
    const inner: Context = { scope: [...ctx.scope, ...(nameSegments(name) ?? [])] };
    for (const c of named(node)) {
      if (same(c, name)) continue;
      visit(c, same(c, body) ? inner : ctx);
    }
  };
  const visit = (node: SyntaxNode, ctx: Context): void => {
    switch (node.type) {
      case "identifier":
      case "type_identifier":
        add([node.text], ctx);
        return;
      case "qualified_identifier":
      case "template_type":
      case "template_function":
      case "template_method": {
        const path = nameSegments(node);
        if (path) add(path, ctx);
        templateArguments(node, ctx);
        return;
      }
      case "namespace_definition":
        visitAll(node.childForFieldName("body"), { scope: [...ctx.scope, ...(nameSegments(node.childForFieldName("name")) ?? [])] });
        return;
      case "struct_specifier":
      case "class_specifier":
      case "union_specifier":
      case "enum_specifier":
        specifier(node, ctx);
        return;
      case "function_definition": {
        const decl = node.childForFieldName("declarator");
        const n = declaratorName(decl);
        const fnCtx: Context = { scope: n && n.segments.length > 1 ? [...ctx.scope, ...n.segments.slice(0, -1)] : ctx.scope, types: new Map() };
        for (const c of named(node)) {
          if (same(c, decl)) declarator(c, fnCtx);
          else visit(c, same(c, node.childForFieldName("type")) ? ctx : fnCtx);
        }
        return;
      }
      case "declaration":
      case "field_declaration":
      case "parameter_declaration":
      case "optional_parameter_declaration":
      case "type_definition":
      case "for_range_loop": {
        if (VARIABLE_DECLARATIONS.has(node.type)) declareTypes(node, ctx);
        const declarators = declaratorsOf(node);
        for (const c of named(node)) {
          if (declarators.some((d) => same(d, c))) declarator(c, ctx);
          else visit(c, ctx);
        }
        return;
      }
      case "lambda_expression":
        visitAll(node, { scope: ctx.scope, types: new Map(ctx.types) });
        return;
      case "enumerator":
      case "alias_declaration":
      case "namespace_alias_definition":
      case "preproc_ifdef": { // `#ifndef PRICING_H`: an include guard is not a use
        const name = node.childForFieldName("name");
        for (const c of named(node)) if (!same(c, name)) visit(c, ctx);
        return;
      }
      case "field_expression": {
        const argument = node.childForFieldName("argument");
        const field = node.childForFieldName("field");
        const member = field ? (nameSegments(field) ?? [field.text]) : undefined;
        if (argument?.type === "this" && member && ctx.scope.length) {
          const ref: Reference = [...ctx.scope, ...member];
          ref.exact = true;
          emit(ref);
        } else if (argument?.type === "identifier" && member) {
          // `cart.total()` / `item->price` where `cart` is a parameter or local of a named type.
          const type = ctx.types?.get(argument.text);
          if (type) add([...type, ...member], ctx);
        }
        if (argument) visit(argument, ctx);
        return; // otherwise the object's type is unknown to a one-file parse
      }
      case "preproc_def":
      case "preproc_function_def": {
        const value = node.childForFieldName("value");
        const params = new Set(named(node.childForFieldName("parameters")).map((p) => p.text));
        if (value) for (const m of value.text.matchAll(IDENT)) if (!KEYWORDS.has(m[0]) && !params.has(m[0])) emit([m[0]]);
        return;
      }
      case "preproc_arg":
        for (const m of node.text.matchAll(IDENT)) if (!KEYWORDS.has(m[0])) emit([m[0]]);
        return;
      case "type_parameter_declaration":
      case "variadic_type_parameter_declaration":
      case "preproc_include":
      case "field_identifier":
      case "namespace_identifier":
      case "labeled_statement":
      case "goto_statement":
        return;
    }
    visitAll(node, ctx);
  };
  visitAll(root, { scope: [] });
  return out;
}

function imports(root: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "preproc_include") {
      const path = node.childForFieldName("path");
      if (path?.type === "string_literal") {
        const content = named(path).find((c) => c.type === "string_content")?.text ?? path.text.slice(1, -1);
        out.push({ local: "*", module: content, all: true });
      } else if (path?.type === "system_lib_string") {
        out.push({ local: "*", module: path.text, all: true }); // `<x.h>`, brackets kept
      }
      return;
    }
    for (const c of named(node)) visit(c);
  };
  visit(root);
  return out;
}

const INCLUDE_ROOTS = ["include", "src"];

function resolveModule(module: string, fromRel: string, exists?: Exists): string | undefined {
  if (module.startsWith("<") && module.endsWith(">")) {
    if (!exists) return undefined; // system headers resolve nowhere without the checkout
    return firstExisting(INCLUDE_ROOTS.map((r) => posix.join(r, module.slice(1, -1))), exists);
  }
  const candidates = [posix.join(posix.dirname(fromRel), module), ...INCLUDE_ROOTS.map((r) => posix.join(r, module))];
  return firstExisting(candidates, exists);
}

const HEADER = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/i;

/** C++ constructs a C header cannot contain. */
const CPP_ONLY = /\b(?:class|namespace|template\s*<|public\s*:|private\s*:|protected\s*:|virtual|constexpr|nullptr)\b|::|\busing\s+\w+\s*=/;

export const c: TreeSitterLanguage = {
  id: "c",
  name: "C",
  extensions: [".c", ".h"],
  grammar: "tree-sitter-c.wasm",
  definitions,
  references,
  imports,
  resolveModule,
  keyToIncludes: (path) => !HEADER.test(path),
  refine: (path, text) => (/\.h$/i.test(path) && CPP_ONLY.test(text) ? "cpp" : undefined),
};

export const cpp: TreeSitterLanguage = {
  id: "cpp",
  name: "C++",
  extensions: [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".ipp", ".tpp", ".inl"],
  grammar: "tree-sitter-cpp.wasm",
  definitions,
  references,
  imports,
  resolveModule,
  keyToIncludes: (path) => !HEADER.test(path),
};
