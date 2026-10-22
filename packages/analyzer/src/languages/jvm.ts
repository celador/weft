// Shared by the Java and Kotlin specs: declaration headers, import paths, and module resolution
// for JVM source trees (Maven/Gradle layouts, Java <-> Kotlin interop).
//
// Module strings. A JVM import names a class (or a member of one), not a file, so the specs
// encode where the file may be as a `|`-separated list of candidates that `resolveModule` tries in
// order:
//   - `com.shop.model.Item`  a fully qualified class: `com/shop/model/Item.java` or `.kt` under a
//                            source root (src/main/java, src/main/kotlin, src, the checkout root,
//                            or an ancestor of the importing file, e.g. app/src/main/java);
//   - `./Item`               a class of the importing file's own package: `Item.java`/`Item.kt`
//                            next to the importing file;
//   - `kt:com.shop.pricing.Pricing`  like a class, but only a `.kt` file: where a Kotlin
//                            top-level function or property may be declared, and the fallback
//                            for a Kotlin class declared in a file named after its package.
// Packages under java., javax., jdk., sun., kotlin., kotlinx., android. and androidx. are never in
// the checkout and are skipped without touching the file system.
import { posix } from "node:path";
import type { Exists, ImportBinding, Reference, SyntaxNode } from "../language.js";

export function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

export function children(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((c): c is SyntaxNode => c !== null);
}

export function sameNode(a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean {
  return !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

/**
 * Annotations that do not change how a declaration is called. They are dropped from signatures
 * so adding `@Override` or `@Deprecated` is a body-level change, not a broken contract. Every
 * other annotation (`@JvmStatic`, `@JvmName`, `@Nullable`, `@Throws`, ...) stays in.
 */
const DOCUMENTARY = new Set(["Override", "Deprecated", "SuppressWarnings", "Suppress", "FunctionalInterface", "SafeVarargs", "Generated"]);
const COMMENT = new Set(["comment", "line_comment", "block_comment", "multiline_comment"]);
const ANNOTATION = new Set(["annotation", "marker_annotation"]);

export function annotationName(node: SyntaxNode): string {
  const m = /^@(?:\w+:)?([\w.]+)/.exec(node.text);
  return m ? m[1]!.split(".").pop()! : "";
}

/**
 * The declaration's text from its start up to `end` (the body's start), without comments and
 * documentary annotations. The engine normalizes whitespace.
 */
export function header(node: SyntaxNode, end: number = node.endIndex): string {
  const drop: Array<[number, number]> = [];
  const visit = (n: SyntaxNode): void => {
    for (const c of children(n)) {
      if (c.startIndex >= end) break;
      if (COMMENT.has(c.type) || (ANNOTATION.has(c.type) && DOCUMENTARY.has(annotationName(c)))) drop.push([c.startIndex, c.endIndex]);
      else visit(c);
    }
  };
  visit(node);
  let out = "";
  let at = node.startIndex;
  for (const [s, e] of drop) {
    out += node.text.slice(at - node.startIndex, s - node.startIndex);
    at = e;
  }
  return out + node.text.slice(at - node.startIndex, Math.max(at, end) - node.startIndex);
}

/** The text of `node` from `start` to its end. */
export function tail(node: SyntaxNode, start: number): string {
  return node.text.slice(start - node.startIndex);
}

const capitalized = (s: string): boolean => /^[A-Z]/.test(s);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The binding for one single-name import, `parts` being its dotted path. Java and Kotlin name
 * classes in UpperCamelCase and packages in lowercase, so the first capitalized segment is the
 * class (and the file): `com.shop.Outer.Inner` binds member `Outer.Inner` of `com.shop.Outer`,
 * `import static com.shop.Fmt.money` binds `Fmt.money`; when `com/shop/Outer.{java,kt}` does not
 * exist, `com/shop/Shop.kt` is tried (Kotlin). A path with no capitalized segment is a
 * Kotlin top-level declaration (`com.shop.pricing.calcTotal`); its file is guessed from the
 * package's last segment (`pricing/Pricing.kt`) or the declaration's own name.
 */
export function importBinding(parts: string[], alias?: string): ImportBinding | undefined {
  if (parts.length < 2) return undefined;
  const local = alias ?? parts[parts.length - 1]!;
  const i = parts.findIndex((p, n) => n > 0 && capitalized(p));
  if (i > 0) {
    // Kotlin files may declare classes under another file name: `Cart` in `pricing/Pricing.kt`.
    const pkg = parts.slice(0, i);
    const last = pkg[pkg.length - 1]!;
    const fallbacks = [...new Set([cap(last), last])].map((s) => `kt:${[...pkg, s].join(".")}`);
    return { local, module: [parts.slice(0, i + 1).join("."), ...fallbacks].join("|"), name: parts.slice(i).join(".") };
  }
  const pkg = parts.slice(0, -1);
  const name = parts[parts.length - 1]!;
  const stems = [cap(pkg[pkg.length - 1]!), cap(name), pkg[pkg.length - 1]!];
  return { local, module: [...new Set(stems)].map((s) => `kt:${[...pkg, s].join(".")}`).join("|"), name };
}

const EXTERNAL = /^(?:java|javax|jdk|sun|kotlin|kotlinx|android|androidx)\./;

/** Class names that are never files of the checkout (java.lang, kotlin, common annotations). */
const BUILTIN = new Set(
  (
    "String Object Integer Long Double Float Boolean Character Byte Short Number Math System Thread Runnable Class Enum Record Void " +
    "Iterable Comparable CharSequence StringBuilder Throwable Exception Error RuntimeException IllegalArgumentException " +
    "IllegalStateException UnsupportedOperationException NullPointerException IndexOutOfBoundsException " +
    "Override Deprecated SuppressWarnings Suppress FunctionalInterface SafeVarargs " +
    "Any Unit Nothing Int Array List Map Set MutableList MutableMap MutableSet Collection Sequence Pair Triple Lazy Result " +
    "JvmStatic JvmName JvmField JvmOverloads Throws"
  ).split(" "),
);

/**
 * Bindings for capitalized names this file uses without importing them: a class of its own
 * package (a file next to it) or of a wildcard-imported package (`import com.shop.util.*`).
 * `references` are the file's references, `explicit` its explicit import bindings, `declared`
 * the type names it declares or binds itself (classes, type parameters).
 */
export function implicitBindings(references: Reference[], explicit: ImportBinding[], declared: Set<string>, wildcards: string[]): ImportBinding[] {
  const taken = new Set([...explicit.map((b) => b.local), ...declared]);
  const out: ImportBinding[] = [];
  for (const ref of references) {
    const head = ref[0]!;
    if (!capitalized(head) || head.length < 2 || taken.has(head) || BUILTIN.has(head)) continue;
    taken.add(head);
    out.push({ local: head, module: [`./${head}`, ...wildcards.map((w) => `${w}.${head}`)].join("|"), name: head });
  }
  return out;
}

/** Source roots to try for a fully qualified class, from the importing file's position. */
function roots(fromRel: string): string[] {
  const out = ["src/main/java", "src/main/kotlin", "src", ""];
  for (let dir = posix.dirname(fromRel); dir && dir !== "." && dir !== "/"; dir = posix.dirname(dir)) {
    out.push(dir);
    const m = /^(.*\/)?src\/(main|test)\/(java|kotlin)$/.exec(dir);
    if (m) out.push(`${m[1] ?? ""}src/${m[2]}/${m[3] === "java" ? "kotlin" : "java"}`);
  }
  return [...new Set(out)];
}

/** Resolve a module string (see the top of this file) to a checkout file. */
export function resolveJvmModule(module: string, fromRel: string, exists: Exists | undefined, extensions: string[]): string | undefined {
  if (!exists) return undefined; // without the checkout, `Item` could be anything on the classpath
  for (let spec of module.split("|")) {
    let exts = extensions;
    if (spec.startsWith("kt:")) {
      spec = spec.slice(3);
      exts = [".kt"];
    }
    if (spec.startsWith("./")) {
      const dir = posix.dirname(fromRel);
      for (const ext of extensions) {
        const c = posix.join(dir, `${spec.slice(2)}${ext}`);
        if (exists(c)) return c;
      }
      continue;
    }
    if (EXTERNAL.test(spec)) continue;
    const rel = spec.split(".").join("/");
    for (const root of roots(fromRel)) {
      for (const ext of exts) {
        const c = root ? `${root}/${rel}${ext}` : `${rel}${ext}`;
        if (exists(c)) return c;
      }
    }
  }
  return undefined;
}

/** Memoize a per-tree computation (the engine passes the same root to every spec method). */
export function perRoot<T>(fn: (root: SyntaxNode) => T): (root: SyntaxNode) => T {
  const cache = new WeakMap<SyntaxNode, T>();
  return (root) => {
    let v = cache.get(root);
    if (v === undefined) {
      v = fn(root);
      cache.set(root, v);
    }
    return v;
  };
}

export function exact(path: string[]): Reference {
  const ref: Reference = [...path];
  ref.exact = true;
  return ref;
}
