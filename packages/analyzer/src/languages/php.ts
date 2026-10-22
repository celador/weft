// PHP on the tree-sitter backend (grammar: tree-sitter-php 0.24.2, the `php` dialect with
// inline HTML).
//
// Declarations: functions, classes, interfaces, traits and enums, their methods (`Cart.total`),
// properties (`Cart.items`, without the `$`; constructor-promoted ones included), constants
// (top-level and `Cart.MAX`) and enum cases (`Suit.Hearts`). Keys are qualified within the file
// and leave the namespace out: under PSR-4 the path already names it. Signature: everything up
// to the body (attributes, modifiers, parameters, return type; `extends`/`implements` for a
// class); for a property or constant, its modifiers and type (the value is the body).
//
// References: function calls, static calls and constant/property access (`Calculator::rate()`,
// `self::MAX`, `T::of()`), `$this->method()` / `$this->prop` (the enclosing class),
// `new Foo(...)` (read as `Foo.__construct`), type declarations, `extends`/`implements`,
// trait `use`, attributes, `instanceof`, and bare constants.
//
// Resolution: `use` statements (aliases, group uses, `use function` / `use const`), fully
// qualified names (`\App\Util\Fmt`), and names in the file's own namespace, mapped to files by
// the nearest composer.json's PSR-4 map (`autoload` and `autoload-dev`; needs
// `AnalyzeOptions.read`, which the adapters pass), then PSR-4 convention: `App\Models\User` is
// tried under `src/`, `app/`, `lib/`, the checkout root and `tests/`, with 0..n leading namespace
// segments dropped (`app/Models/User.php` for Laravel, `src/Models/User.php` for `App\` =>
// `src/`). Same-namespace classes are also tried next to the file.
import { posix } from "node:path";
import type { Checkout, Definition, Exists, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { firstExisting } from "../treesitter.js";

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function slice(node: SyntaxNode, start: number, end: number): string {
  return node.text.slice(start - node.startIndex, end - node.startIndex);
}

const SELF = new Set(["self", "static"]);
const NOT_A_CLASS = new Set(["self", "static", "parent", "class"]);

const varName = (node: SyntaxNode | null | undefined): string | undefined => node?.text.replace(/^\$/, "");

const definitionsCache = new WeakMap<object, Definition[]>();
function definitions(root: SyntaxNode): Definition[] {
  const cached = definitionsCache.get(root);
  if (cached) return cached;
  const out: Definition[] = [];
  const push = (scope: string[], name: string, signature: string, body: string): void => {
    out.push({ name: [...scope, name].join("."), signature, body });
  };
  const walk = (node: SyntaxNode, scope: string[]): void => {
    for (const child of named(node)) {
      switch (child.type) {
        case "function_definition":
        case "method_declaration": {
          const name = child.childForFieldName("name")?.text;
          if (!name) break;
          const body = child.childForFieldName("body");
          push(scope, name, body ? slice(child, child.startIndex, body.startIndex) : child.text, body?.text ?? "");
          if (name === "__construct") {
            for (const p of named(child.childForFieldName("parameters") ?? child)) {
              if (p.type !== "property_promotion_parameter") continue;
              const prop = varName(p.childForFieldName("name"));
              const value = p.childForFieldName("default_value");
              if (prop) push(scope, prop, value ? slice(p, p.startIndex, value.startIndex) : p.text, value?.text ?? "");
            }
          }
          break; // nothing inside a function body is a declaration others depend on
        }
        case "class_declaration":
        case "interface_declaration":
        case "trait_declaration":
        case "enum_declaration": {
          const name = child.childForFieldName("name")?.text;
          const body = child.childForFieldName("body");
          if (!name) break;
          push(scope, name, body ? slice(child, child.startIndex, body.startIndex) : child.text, body?.text ?? "");
          if (body) walk(body, [...scope, name]);
          break;
        }
        case "property_declaration": {
          const elements = named(child).filter((c) => c.type === "property_element");
          const signature = elements.length ? slice(child, child.startIndex, elements[0].startIndex) : child.text;
          for (const e of elements) {
            const prop = varName(e.childForFieldName("name"));
            if (prop) push(scope, prop, signature, e.childForFieldName("default_value")?.text ?? "");
          }
          break;
        }
        case "const_declaration": {
          const elements = named(child).filter((c) => c.type === "const_element");
          const signature = elements.length ? slice(child, child.startIndex, elements[0].startIndex) : "";
          for (const e of elements) {
            const [nameNode, ...value] = named(e);
            if (nameNode?.type === "name") push(scope, nameNode.text, signature, value.map((v) => v.text).join(" "));
          }
          break;
        }
        case "enum_case": {
          const name = child.childForFieldName("name")?.text;
          if (name) push(scope, name, "", child.childForFieldName("value")?.text ?? "");
          break;
        }
        default:
          walk(child, scope); // namespace blocks, `if (!function_exists(...)) { function ... }`
      }
    }
  };
  walk(root, []);
  definitionsCache.set(root, out);
  return out;
}

/** `\App\Util\Fmt` as written (whitespace removed); a class name is one reference segment. */
const nameText = (node: SyntaxNode): string => node.text.replace(/\s+/g, "");

/** The class-name node of a static access or `new` expression. */
function classNameNode(node: SyntaxNode): SyntaxNode | undefined {
  switch (node.type) {
    case "scoped_call_expression":
    case "scoped_property_access_expression":
      return node.childForFieldName("scope") ?? undefined;
    case "class_constant_access_expression":
      return named(node)[0];
    case "object_creation_expression":
      return named(node).find((c) => c.type === "name" || c.type === "qualified_name" || c.type === "relative_scope");
    default:
      return undefined;
  }
}

const NAMEISH = new Set(["name", "qualified_name"]);
/** Parents under which a `name` is a type/class name. */
const CLASS_LIST = new Set(["named_type", "base_clause", "class_interface_clause", "use_declaration", "attribute"]);
/** Parents under which a `name` is a constant in an expression. */
const EXPRESSION = new Set([
  "binary_expression", "argument", "return_statement", "assignment_expression", "array_element_initializer",
  "expression_statement", "parenthesized_expression", "conditional_expression", "unary_op_expression",
  "match_condition_list", "match_conditional_expression", "echo_statement", "subscript_expression",
  // default values: `float $rate = TAX_RATE`, `private int $x = LIMIT`
  "simple_parameter", "property_promotion_parameter", "property_element",
]);

type Use = { kind: "class" | "function" | "const"; fqn: string; local: string };
type ClassUse = { text: string; ns: string };
type Scan = { refs: Reference[]; classUses: ClassUse[]; uses: Use[] };

function useClauses(node: SyntaxNode, out: Use[]): void {
  const declKind = node.childForFieldName("type")?.text;
  const group = node.childForFieldName("body");
  const prefixNode = group ? named(node).find((c) => c.type === "namespace_name") : undefined;
  const prefix = prefixNode ? nameText(prefixNode).replace(/^\\/, "") : "";
  for (const clause of named(group ?? node)) {
    if (clause.type !== "namespace_use_clause") continue;
    const alias = clause.childForFieldName("alias");
    const target = named(clause).find((c) => NAMEISH.has(c.type) && c.startIndex !== alias?.startIndex);
    if (!target) continue;
    const written = nameText(target).replace(/^\\/, "");
    const fqn = prefix ? `${prefix}\\${written}` : written;
    const kind = clause.childForFieldName("type")?.text ?? declKind;
    out.push({ kind: kind === "function" || kind === "const" ? kind : "class", fqn, local: alias?.text ?? lastSegment(fqn) });
  }
}

/**
 * One top-down pass for references, class-position names (with their namespace) and `use`
 * statements: the engine asks for references and imports of the same tree, and tree access
 * crosses into WASM, so walk once.
 */
const scans = new WeakMap<object, Scan>();
function scan(root: SyntaxNode): Scan {
  const cached = scans.get(root);
  if (cached) return cached;
  const refs: Reference[] = [];
  const classUses: ClassUse[] = [];
  const useList: Use[] = [];
  const exact = (path: string[]): void => {
    const ref: Reference = path;
    ref.exact = true;
    refs.push(ref);
  };
  const classUse = (node: SyntaxNode | null | undefined, ns: string): void => {
    if (!node || !NAMEISH.has(node.type)) return;
    const text = nameText(node);
    if (!NOT_A_CLASS.has(text.toLowerCase())) classUses.push({ text, ns });
  };
  /** `Foo::member`: [Foo, member]; `self::member` / `static::member`: the enclosing class, exact. */
  const scoped = (scope: SyntaxNode | null | undefined, member: string | undefined, ns: string, cls: string | undefined): void => {
    if (!scope) return;
    const text = nameText(scope);
    const m = member && member !== "class" ? member : undefined;
    if (SELF.has(text.toLowerCase())) {
      if (cls) exact(m ? [cls, m] : [cls]);
      return;
    }
    if (!NAMEISH.has(scope.type) || NOT_A_CLASS.has(text.toLowerCase())) return; // $obj::x, parent::x
    refs.push(m ? [text, m] : [text]);
    classUse(scope, ns);
  };
  /** Visits `node` (whose parent has type `parent`); returns the namespace in effect after it. */
  const visit = (node: SyntaxNode, parent: string, ns: string, cls: string | undefined): string => {
    switch (node.type) {
      case "namespace_definition": {
        const name = node.childForFieldName("name");
        const body = node.childForFieldName("body");
        const inner = name ? nameText(name) : "";
        if (!body) return inner; // `namespace X;` applies to the rest of the file
        visit(body, node.type, inner, undefined);
        return ns;
      }
      case "namespace_use_declaration":
        useClauses(node, useList);
        return ns;
      case "class_declaration":
      case "interface_declaration":
      case "trait_declaration":
      case "enum_declaration":
        cls = node.childForFieldName("name")?.text ?? cls;
        break;
      case "function_call_expression": {
        const fn = node.childForFieldName("function");
        if (fn && NAMEISH.has(fn.type)) refs.push([nameText(fn)]);
        break;
      }
      case "scoped_call_expression":
        scoped(node.childForFieldName("scope"), node.childForFieldName("name")?.text, ns, cls);
        break;
      case "scoped_property_access_expression":
        scoped(node.childForFieldName("scope"), varName(node.childForFieldName("name")), ns, cls);
        break;
      case "class_constant_access_expression": {
        const [scope, member] = named(node);
        scoped(scope, member?.type === "name" ? member.text : undefined, ns, cls);
        break;
      }
      case "object_creation_expression":
        scoped(classNameNode(node), "__construct", ns, cls);
        break;
      case "member_call_expression":
      case "nullsafe_member_call_expression":
      case "member_access_expression":
      case "nullsafe_member_access_expression": {
        const object = node.childForFieldName("object");
        const member = node.childForFieldName("name");
        if (cls && object?.type === "variable_name" && object.text === "$this" && member?.type === "name") exact([cls, member.text]);
        break;
      }
      case "name":
      case "qualified_name": {
        const text = nameText(node);
        if (NOT_A_CLASS.has(text.toLowerCase())) return ns;
        if (CLASS_LIST.has(parent)) {
          refs.push([text]);
          classUse(node, ns);
        } else if (EXPRESSION.has(parent)) refs.push([text]); // bare constant: RATE, \App\LIMIT
        return ns;
      }
    }
    let current = ns;
    for (const c of named(node)) current = visit(c, node.type, current, cls);
    return ns;
  };
  let ns = "";
  for (const c of named(root)) ns = visit(c, root.type, ns, undefined);
  const result = { refs, classUses, uses: useList };
  scans.set(root, result);
  return result;
}

function references(root: SyntaxNode): Reference[] {
  return scan(root).refs;
}

const lastSegment = (fqn: string): string => fqn.split("\\").filter(Boolean).pop() ?? fqn;
const namespaceOf = (fqn: string): string => fqn.split("\\").filter(Boolean).slice(0, -1).join("\\");

/**
 * `use` statements bind names as written; class names used without a `use` bind to the file's
 * namespace (or, fully qualified, to themselves). Modules are fully qualified class names
 * (`App\Pricing\Calculator`), `fn:<namespace>` for functions and constants, and `~<fqn>` for a
 * class assumed to be in the file's own namespace (tried next to the file first).
 */
function imports(root: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  const { uses: useList, classUses } = scan(root);
  const locals = new Set<string>();
  for (const u of useList) {
    locals.add(u.local);
    if (u.kind === "class") out.push({ local: u.local, module: u.fqn, name: lastSegment(u.fqn) });
    else out.push({ local: u.local, module: `fn:${namespaceOf(u.fqn)}`, name: lastSegment(u.fqn) });
  }
  const defined = new Set(definitions(root).map((d) => d.name));
  const classUseByLocal = new Map(useList.filter((u) => u.kind === "class").map((u) => [u.local, u.fqn]));
  for (const { text, ns } of classUses) {
    if (locals.has(text)) continue;
    let module: string;
    if (text.startsWith("\\")) module = text.slice(1);
    else {
      const [first, ...rest] = text.split("\\");
      const used = classUseByLocal.get(first);
      if (used) module = [used, ...rest].join("\\");
      else if (!rest.length && defined.has(text)) continue;
      else module = ns ? `~${ns}\\${text}` : `~${text}`;
    }
    locals.add(text);
    out.push({ local: text, module, name: lastSegment(module) });
  }
  return out;
}

const ROOTS = ["src", "app", "lib", "", "tests"];

type Read = (rel: string) => string | undefined;
type Composer = { dir: string; psr4: Array<[prefix: string, dirs: string[]]>; files: string[] };
const composerCache = new Map<string, { text: string; composer: Composer }>();

/** The nearest composer.json at or above `fromRel`'s directory, with its PSR-4 map (longest prefix first). */
function composerFor(fromRel: string, read: Read): Composer | undefined {
  for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
    const rel = dir === "." || dir === "" ? "composer.json" : `${dir}/composer.json`;
    const text = read(rel);
    if (text !== undefined) {
      const hit = composerCache.get(rel);
      if (hit?.text === text) return hit.composer;
      const composer: Composer = { dir: dir === "." ? "" : dir, psr4: [], files: [] };
      try {
        const json = JSON.parse(text) as Record<string, { "psr-4"?: Record<string, string | string[]>; files?: string[] } | undefined>;
        for (const section of [json.autoload, json["autoload-dev"]]) {
          for (const [prefix, dirs] of Object.entries(section?.["psr-4"] ?? {})) composer.psr4.push([prefix.replace(/^\\/, ""), Array.isArray(dirs) ? dirs : [dirs]]);
          composer.files.push(...(section?.files ?? []));
        }
      } catch {
        /* unparsable composer.json: fall back to convention */
      }
      composer.psr4.sort((a, b) => b[0].length - a[0].length);
      composerCache.set(rel, { text, composer });
      return composer;
    }
    if (dir === "." || dir === "" || dir === "/") return undefined;
  }
}

/** Files composer.json's PSR-4 map assigns to class `fqn` (most specific prefix first). */
function psr4Candidates(composer: Composer, fqn: string): string[] {
  const out: string[] = [];
  for (const [prefix, dirs] of composer.psr4) {
    if (!fqn.startsWith(prefix)) continue;
    const rest = `${fqn.slice(prefix.length).split("\\").filter(Boolean).join("/")}.php`;
    for (const d of dirs) out.push(posix.join(composer.dir || ".", d, rest));
  }
  return out;
}

/**
 * Classes: composer.json's PSR-4 map when `read` is available, then (and without it) PSR-4
 * convention. Functions/constants (`fn:<namespace>`): `<namespace path>.php`,
 * `<namespace path>/functions.php`, `helpers.php`, then a lone composer `files` entry.
 */
function resolveModule(module: string, fromRel: string, exists?: Exists, checkout?: Checkout): string | undefined {
  if (!exists) return undefined; // PSR-4 resolution needs the checkout
  const read = checkout?.read;
  const composer = read ? composerFor(fromRel, read) : undefined;
  const candidates: string[] = [];
  const at = (root: string, tail: string): string => (root ? `${root}/${tail}` : tail);
  if (module.startsWith("fn:")) {
    const segs = module.slice(3).split("\\").filter(Boolean);
    for (let k = 0; k < segs.length; k++) {
      const tail = segs.slice(k).join("/");
      for (const root of ROOTS) candidates.push(at(root, `${tail}.php`), at(root, `${tail}/functions.php`), at(root, `${tail}/helpers.php`));
    }
    for (const root of ROOTS) candidates.push(at(root, "functions.php"), at(root, "helpers.php"));
    if (composer?.files.length === 1) candidates.push(posix.join(composer.dir || ".", composer.files[0]));
  } else {
    const sameNamespace = module.startsWith("~");
    const fqn = module.replace(/^~/, "");
    const segs = fqn.split("\\").filter(Boolean);
    if (!segs.length) return undefined;
    if (composer) candidates.push(...psr4Candidates(composer, fqn));
    if (sameNamespace) candidates.push(posix.join(posix.dirname(fromRel), `${segs[segs.length - 1]}.php`));
    for (let k = 0; k < segs.length; k++) {
      const tail = `${segs.slice(k).join("/")}.php`;
      for (const root of ROOTS) candidates.push(at(root, tail));
    }
  }
  return firstExisting(
    candidates.filter((c) => posix.normalize(c) !== fromRel),
    exists,
  );
}

export const php: TreeSitterLanguage = {
  id: "php",
  name: "PHP",
  extensions: [".php", ".phtml", ".php8", ".phpt"],
  grammar: "tree-sitter-php.wasm",
  definitions,
  references,
  imports,
  resolveModule,
};
