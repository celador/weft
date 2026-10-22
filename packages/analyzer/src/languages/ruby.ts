// Ruby on the tree-sitter backend (grammar: tree-sitter-ruby 0.23.1).
//
// Declarations: classes and modules qualified by their lexical nesting (`Shop.Cart`;
// `class Shop::Order` is `Shop.Order`), so a class reopened in several places is one key.
// Instance methods and singleton methods (`def self.build`, `class << self`) are both
// `Class.method`. Constants (`TAX = 0.2`) and `attr_reader`/`attr_writer`/`attr_accessor`
// attributes are declarations too. Signature: everything up to the end of the parameter list
// (a `private`/`protected`/`module_function` prefix included); for a class, its name and
// superclass; for a constant, nothing (its value is the body).
//
// References: method calls without a receiver or on `self` (resolved to the enclosing class),
// bare method names inside methods that are not local variables, constants and constant paths
// (`Pricing`, `Shop::Money.fmt`), with `Foo.new` read as `Foo.initialize`.
//
// Resolution: Ruby has no per-name import statement, so constants resolve the way Zeitwerk and
// Rails autoloading do: `Shop::Money` lives in `shop/money.rb` (or in `shop.rb`), looked up first
// among the files this file `require_relative`s / `require`s, then under `lib/`, the Rails
// autoload directories (`app/models`, `app/controllers`, `app/services`, ...), the checkout root
// and this file's directory. Inside `module Shop`, `Money` is tried as `Shop::Money` and as
// `::Money`. `require_relative "x"` resolves next to the file and `require "x"` under `lib/`.
import { posix } from "node:path";
import type { Definition, Exists, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage } from "../language.js";
import { firstExisting } from "../treesitter.js";

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

const ATTR = new Set(["attr_reader", "attr_writer", "attr_accessor"]);
const MODIFIER = new Set(["private", "protected", "public", "module_function", "private_class_method", "public_class_method"]);
/** Receiver-less calls that are Ruby built-ins in practice, not methods of this code base. */
const KERNEL = new Set([
  ...ATTR, ...MODIFIER, "require", "require_relative", "load", "include", "extend", "prepend", "puts", "print", "p", "pp",
  "raise", "loop", "lambda", "proc", "block_given?", "yield", "super", "new", "attr", "alias_method", "define_method",
]);

/** `Shop::Money` (constant or scope_resolution) → ["Shop", "Money"]; undefined if not a constant path. */
function constPath(node: SyntaxNode): { path: string[]; absolute: boolean } | undefined {
  if (node.type === "constant") return { path: [node.text], absolute: false };
  if (node.type !== "scope_resolution") return undefined;
  const name = node.childForFieldName("name");
  if (!name || name.type !== "constant") return undefined;
  const scope = node.childForFieldName("scope");
  if (!scope) return { path: [name.text], absolute: true }; // ::Foo
  const head = constPath(scope);
  return head ? { path: [...head.path, name.text], absolute: head.absolute } : undefined;
}

/** Text of `node` between absolute offsets `start` and `end`. */
function slice(node: SyntaxNode, start: number, end: number): string {
  return node.text.slice(start - node.startIndex, end - node.startIndex);
}

function methodDefinition(def: SyntaxNode, scope: string[]): Definition | undefined {
  const nameNode = def.childForFieldName("name");
  if (!nameNode) return undefined;
  let qualified = scope;
  if (def.type === "singleton_method") {
    const object = def.childForFieldName("object");
    const path = object ? constPath(object) : undefined;
    if (path) qualified = [...scope, ...path.path]; // def Foo.x (def self.x stays in scope)
  }
  // `private def x` / `module_function def x`: the modifier changes how it is called.
  const call = def.parent?.type === "argument_list" ? def.parent.parent : null;
  const modifier = call?.type === "call" && !call.childForFieldName("receiver") && MODIFIER.has(call.childForFieldName("method")?.text ?? "");
  const outer = modifier && call ? call : def;
  const params = def.childForFieldName("parameters");
  const sigEnd = Math.max(params?.endIndex ?? 0, nameNode.endIndex);
  return {
    name: [...qualified, nameNode.text].join("."),
    signature: slice(outer, outer.startIndex, sigEnd),
    body: slice(def, sigEnd, def.endIndex),
  };
}

const definitionsCache = new WeakMap<object, Definition[]>();
function definitions(root: SyntaxNode): Definition[] {
  const cached = definitionsCache.get(root);
  if (cached) return cached;
  const out: Definition[] = [];
  const walk = (node: SyntaxNode, scope: string[]): void => {
    for (const child of named(node)) {
      switch (child.type) {
        case "class":
        case "module": {
          const nameNode = child.childForFieldName("name");
          const path = nameNode ? constPath(nameNode) : undefined;
          if (!nameNode || !path) break;
          const qualified = path.absolute ? path.path : [...scope, ...path.path];
          const sigEnd = child.childForFieldName("superclass")?.endIndex ?? nameNode.endIndex;
          out.push({ name: qualified.join("."), signature: slice(child, child.startIndex, sigEnd), body: slice(child, sigEnd, child.endIndex) });
          const body = child.childForFieldName("body");
          if (body) walk(body, qualified);
          break;
        }
        case "singleton_class": {
          const body = child.childForFieldName("body");
          if (body) walk(body, scope);
          break;
        }
        case "method":
        case "singleton_method": {
          const def = methodDefinition(child, scope);
          if (def) out.push(def);
          break; // locals and nested defs inside a method are not declarations others depend on
        }
        case "assignment": {
          const left = child.childForFieldName("left");
          if (left?.type === "constant") {
            out.push({ name: [...scope, left.text].join("."), signature: "", body: child.childForFieldName("right")?.text ?? "" });
            break;
          }
          walk(child, scope);
          break;
        }
        case "call": {
          const method = child.childForFieldName("method")?.text;
          if (method && ATTR.has(method) && !child.childForFieldName("receiver")) {
            for (const arg of named(child.childForFieldName("arguments") ?? child)) {
              if (arg.type === "simple_symbol") out.push({ name: [...scope, arg.text.slice(1)].join("."), signature: `${method} ${arg.text}`, body: "" });
            }
            break;
          }
          walk(child, scope); // `private def x`, blocks (`included do ... end`)
          break;
        }
        default:
          walk(child, scope);
      }
    }
  };
  walk(root, []);
  definitionsCache.set(root, out);
  return out;
}

/** Local variable names of a method: parameters, block parameters, assignment targets. */
function methodLocals(method: SyntaxNode): Set<string> {
  const locals = new Set<string>();
  const ids = (node: SyntaxNode): void => {
    if (node.type === "identifier") locals.add(node.text);
    else if (node.type !== "call") for (const c of named(node)) ids(c); // `a.b = 1` assigns no local
  };
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "method_parameters":
      case "block_parameters":
      case "lambda_parameters":
      case "exception_variable":
        ids(node);
        return;
      case "assignment":
      case "operator_assignment": {
        const left = node.childForFieldName("left");
        if (left) ids(left);
        break;
      }
      case "for": {
        const pattern = node.childForFieldName("pattern");
        if (pattern) ids(pattern);
        break;
      }
    }
    for (const c of named(node)) visit(c);
  };
  visit(method);
  return locals;
}

function exact(path: string[]): Reference {
  const ref: Reference = [...path];
  ref.exact = true;
  return ref;
}

/** `Shop::Money` inside `module Billing` may be `Billing::Shop::Money` or `::Shop::Money`. */
function qualifications(path: string[], absolute: boolean, scope: string[]): string[][] {
  if (absolute) return [path];
  return [...scope.map((_, i) => [...scope.slice(0, scope.length - i), ...path]), path];
}

/**
 * A use of constant path `path` (optionally `.member`): one exact reference per lexical
 * qualification, never shorter than the constant itself (`Shop::Money.fmt` must not read the
 * enclosing `Shop` module).
 */
function constantRefs(path: string[], absolute: boolean, scope: string[], member?: string): Reference[] {
  const out: Reference[] = [];
  for (const q of qualifications(path, absolute, scope)) {
    if (member) out.push(exact([...q, member]));
    out.push(exact(q));
  }
  return out;
}

const REQUIRE = new Set(["require", "require_relative", "load"]);

const same = (a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean =>
  !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

type ConstantUse = { path: string[]; absolute: boolean; scope: string[] };
type Uses = { refs: Reference[]; constants: ConstantUse[]; requires: string[] };

/**
 * One top-down pass over a file for references, constant uses and requires (the engine asks
 * for references and imports of the same tree; tree access crosses into WASM, so walk once).
 */
const usesCache = new WeakMap<object, Uses>();
function uses(root: SyntaxNode): Uses {
  const cached = usesCache.get(root);
  if (cached) return cached;
  const refs: Reference[] = [];
  const constants: ConstantUse[] = [];
  const requires: string[] = [];
  const selfCall = (scope: string[], name: string): void => {
    if (scope.length) refs.push(exact([...scope, name]));
    refs.push([name]); // top-level methods are callable everywhere
  };
  const constant = (node: SyntaxNode, scope: string[], member?: string): boolean => {
    const path = constPath(node);
    if (!path) return false;
    refs.push(...constantRefs(path.path, path.absolute, scope, member));
    constants.push({ path: path.path, absolute: path.absolute, scope });
    return true;
  };
  /** `scope`: class/module nesting; `locals`: the enclosing method's locals (undefined outside methods). */
  const visit = (node: SyntaxNode, scope: string[], locals: Set<string> | undefined): void => {
    switch (node.type) {
      case "class":
      case "module": {
        const nameNode = node.childForFieldName("name");
        const path = nameNode ? constPath(nameNode) : undefined;
        const inner = path ? (path.absolute ? path.path : [...scope, ...path.path]) : scope;
        const superclass = node.childForFieldName("superclass");
        if (superclass) visit(superclass, scope, locals); // resolved in the enclosing scope
        const body = node.childForFieldName("body");
        if (body) visit(body, inner, undefined);
        return;
      }
      case "singleton_class": {
        const body = node.childForFieldName("body");
        if (body) visit(body, scope, undefined);
        return;
      }
      case "method":
      case "singleton_method": {
        const own = methodLocals(node);
        const params = node.childForFieldName("parameters");
        const body = node.childForFieldName("body");
        if (params) visit(params, scope, own);
        if (body) visit(body, scope, own);
        return;
      }
      case "call": {
        const method = node.childForFieldName("method");
        const receiver = node.childForFieldName("receiver");
        const name = method?.type === "identifier" || method?.type === "constant" ? method.text : undefined;
        let receiverDone = false;
        if (name && !receiver) {
          if (REQUIRE.has(name)) {
            const arg = named(node.childForFieldName("arguments") ?? node)[0];
            const content = arg?.type === "string" ? named(arg) : [];
            if (content.length === 1 && content[0].type === "string_content") {
              const spec = content[0].text.replace(/\.rb$/, "");
              requires.push(name === "require_relative" ? (spec.startsWith(".") ? spec : `./${spec}`) : spec);
            }
            return;
          }
          if (!KERNEL.has(name)) selfCall(scope, name);
        } else if (name && receiver?.type === "self") {
          if (scope.length) refs.push(exact([...scope, name]));
          receiverDone = true;
        } else if (name && receiver) {
          receiverDone = constant(receiver, scope, name === "new" ? "initialize" : name);
        }
        for (const c of named(node)) {
          if (same(c, method) || (receiverDone && same(c, receiver))) continue;
          visit(c, scope, locals);
        }
        return;
      }
      case "constant":
      case "scope_resolution":
        if (constant(node, scope)) return;
        break;
      case "assignment": {
        const left = node.childForFieldName("left");
        for (const c of named(node)) if (!(left?.type === "constant" && same(c, left))) visit(c, scope, locals);
        return;
      }
      case "identifier":
        if (locals && !locals.has(node.text)) selfCall(scope, node.text);
        return;
    }
    for (const c of named(node)) visit(c, scope, locals);
  };
  visit(root, [], undefined);
  const result = { refs, constants, requires };
  usesCache.set(root, result);
  return result;
}

function references(root: SyntaxNode): Reference[] {
  return uses(root).refs;
}

/**
 * Ruby binds no names on import, so one binding is synthesized per qualification of every
 * constant path the file uses and does not define:
 * `{ local: "Shop.Money", module: "Shop>Money@./pricing,shop/money", name: "Shop.Money" }`,
 * where the part after `@` lists this file's requires. `resolveModule` finds the file.
 */
function imports(root: SyntaxNode): ImportBinding[] {
  const defined = new Set(definitions(root).map((d) => d.name));
  const { constants, requires } = uses(root);
  const req = requires.join(",");
  const out: ImportBinding[] = [];
  const seen = new Set<string>();
  for (const { path, absolute, scope } of constants) {
    const qs = qualifications(path, absolute, scope);
    if (qs.some((q) => defined.has(q.join(".")))) continue;
    for (const q of qs) {
      const local = q.join(".");
      if (seen.has(local)) continue;
      seen.add(local);
      const nest = q.slice(0, q.length - path.length).join("::");
      out.push({ local, module: `${nest}>${path.join("::")}@${req}`, name: local });
    }
  }
  return out;
}

/** `HTTPClient` → `http_client` (Zeitwerk's default inflection). */
export function underscore(constant: string): string {
  return constant
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** Rails autoload roots, `lib/` (gems), and the checkout root. */
const AUTOLOAD = [
  "lib", "app/models", "app/models/concerns", "app/controllers", "app/controllers/concerns", "app/helpers", "app/jobs",
  "app/mailers", "app/services", "app/channels", "app/components", "app/policies", "app/serializers", "app/workers",
  "app/lib", "",
];

function resolveFile(spec: string, fromRel: string, exists?: Exists): string | undefined {
  if (spec.startsWith(".")) return firstExisting([`${posix.join(posix.dirname(fromRel), spec)}.rb`], exists);
  if (!exists) return undefined; // `require "json"` is a gem unless lib/json.rb is in the checkout
  return firstExisting([`lib/${spec}.rb`], exists);
}

const ROOTS_LONGEST_FIRST = AUTOLOAD.filter(Boolean).sort((a, b) => b.length - a.length);

/** The constant path a file defines by convention, underscored: `lib/shop/money.rb` → ["shop", "money"]. */
function impliedConstant(file: string): string[] {
  const root = ROOTS_LONGEST_FIRST.find((r) => file.startsWith(`${r}/`));
  const rel = root ? file.slice(root.length + 1) : posix.basename(file);
  return rel.replace(/\.rb$/, "").split("/");
}

const sameSegments = (a: string[], b: string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Module specs: `<nesting>><constant>@<requires>` for a constant (`Shop>Money@./money`: `Money`
 * written inside `module Shop`, tried as `Shop::Money`), else a require spec (`./pricing`,
 * `shop/money`). A file matches a constant when its path names it (Zeitwerk); only the constant
 * as written, unqualified, may also live in a parent's file (`Shop::Money` in `shop.rb`). A
 * required file outside the autoload roots names the constant of its base name.
 */
function resolveModule(module: string, fromRel: string, exists?: Exists): string | undefined {
  const at = module.indexOf("@");
  if (at < 0) return resolveFile(module, fromRel, exists);
  const [nest, written] = module.slice(0, at).split(">");
  const nested = nest !== "";
  const constant = [...(nested ? nest.split("::") : []), ...written.split("::")].map(underscore);
  const required = module
    .slice(at + 1)
    .split(",")
    .filter(Boolean)
    .map((spec) => resolveFile(spec, fromRel, exists))
    .filter((f): f is string => f !== undefined && f !== fromRel);
  const dir = posix.dirname(fromRel);
  const conventional = (segs: string[]): string | undefined => {
    if (!exists) return undefined; // constants resolve by file layout, which needs the checkout
    const file = `${segs.join("/")}.rb`;
    const hit = firstExisting([...AUTOLOAD.map((root) => (root ? `${root}/${file}` : file)), dir === "." ? file : `${dir}/${file}`], exists);
    return hit === fromRel ? undefined : hit;
  };
  const exact = required.find((r) => sameSegments(impliedConstant(r), constant)) ?? conventional(constant);
  if (exact || nested) return exact;
  for (let k = constant.length - 1; k >= 1; k--) {
    const parent = constant.slice(0, k);
    const hit = required.find((r) => sameSegments(impliedConstant(r), parent)) ?? conventional(parent);
    if (hit) return hit;
  }
  return undefined;
}

export const ruby: TreeSitterLanguage = {
  id: "ruby",
  name: "Ruby",
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  grammar: "tree-sitter-ruby.wasm",
  definitions,
  references,
  imports,
  resolveModule,
};
