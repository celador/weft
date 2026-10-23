// Affected-test selection (CI load). Given a candidate tree, the trunk it was rebased onto and the
// changed files, pick the test files that can reach any symbol the candidate writes, instead of
// running the whole suite on every checkpoint push.
//
//   writes  = analyzer write set of the changed TS/JS files (`analyze(before, after, path)`)
//   graph   = per-file facts from the TS parser (no type checker): top-level declarations and the
//             identifiers each one references, import/export bindings, module-level statements
//   affected = fixed point: a written symbol taints the declarations of its file that reference it,
//             any binding in another file that imports it (named, default, namespace, re-export,
//             `export *`), and so on transitively (callers of callers)
//   selected = test files that are changed themselves, or hold a tainted binding, or reach an
//             "opaque" file (non-literal dynamic import / unresolvable alias import)
//
// Anything the graph cannot see falls back to the full suite with a reason: risk tier high,
// config/deps/test-infra files, a changed file the parser rejects, a changed non-code file that
// no module imports (tests may read it at runtime), a changed file in a language without a TS/JS
// graph. The land queue presubmit never calls this: it always runs the full suite.
//
// Runtime: Node (sandbox job container, adapters, tests). Not for the sequencer Worker.

import ts from "typescript";
import { analyze, type Write } from "./index.js";

export type Risk = "low" | "medium" | "high";
export type ChangedFile = { status: string; path: string };

export type SelectConfig = {
  /** Globs of test files (default: *.test.*, *.spec.*, __tests__/**; TS/JS only). */
  tests?: string[];
  /** Extra globs whose change forces the full suite (on top of the built-in config/deps/infra list). */
  infra?: string[];
  /** Globs of files that never affect tests (default: docs, markdown, images, licenses). */
  ignore?: string[];
  /** Selection is skipped (full suite) at or above this risk tier. Default "high". */
  full_at_risk?: Risk;
  /** Use a subset only when it is at most this fraction of the tests (default 1 = always). */
  max_fraction?: number;
};

/** Per-file parse facts; cacheable by blob sha (a trunk sha's graph is reused by every candidate on it). */
export type FileFacts = {
  v: 1;
  parse_error: string | null;
  /** local binding -> [specifier, imported name | "*" | "default"] */
  imports: Record<string, [string, string]>;
  /** side-effect imports (`import "./x"`) */
  side: string[];
  /** export name -> local name (same-file) */
  exports: Record<string, string>;
  /** `export * from` specifiers */
  star: string[];
  /** top-level declared local -> referenced identifiers */
  decls: Record<string, string[]>;
  /** identifiers referenced by module-level statements (calls, `test(...)`, side effects) */
  module: string[];
  /** non-literal dynamic import()/require() somewhere in the file */
  opaque: boolean;
};

export type SelectInput = {
  /** Every tracked file path in the candidate (rebased) tree. */
  files: string[];
  /** Candidate tree contents. */
  read(path: string): string | undefined;
  /** Trunk (onto) contents, for the changed files. */
  readBefore(path: string): string | undefined;
  /** onto..candidate name-status (no renames: a rename is D + A). */
  changed: ChangedFile[];
  risk?: Risk | null;
  config?: SelectConfig;
  /** Blob sha per path (cache key); without it facts are recomputed. */
  blobs?: Record<string, string>;
  cache?: Map<string, FileFacts>;
};

export type Selection = {
  mode: "subset" | "full";
  /** Why the full suite runs (null for a subset). */
  reason: string | null;
  /** Test files to run (all tests for mode=full). */
  selected: string[];
  /** All test files found. */
  tests: string[];
  total: number;
  /** Why each selected test was picked (first reason), for evidence. */
  why: Record<string, string>;
  /** Analyzer write set of the candidate (capped at 200). */
  writes: Write[];
  graph: { files: number; parsed: number; cached: number; ms: number };
};

// ------------------------------------------------------------------------------ globs

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}
const matcher = (globs: string[]) => {
  const res = globs.map(globToRegExp);
  return (p: string) => res.some((r) => r.test(p));
};

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const OTHER_SOURCE = /\.(?:py|rb|php|go|rs|java|kt|kts|swift|cs|c|cc|cpp|cxx|h|hpp|m|mm|scala|ex|exs|sh|vue|svelte|astro)$/;
export const DEFAULT_TESTS = ["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "**/__tests__/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];
export const DEFAULT_IGNORE = ["**/*.{md,mdx,markdown,txt,rst,adoc}", "docs/**", "**/{LICENSE,LICENCE,NOTICE,AUTHORS,CHANGELOG,CODEOWNERS}{,.*}", "**/*.{png,jpg,jpeg,gif,svg,ico,webp}", ".gitignore", "**/.gitignore", ".editorconfig", ".prettierrc{,.*}"];
/** Config / dependency / test-infra files: a change can alter every test's outcome. */
export const INFRA = [
  "**/package.json",
  "**/{pnpm-lock.yaml,pnpm-workspace.yaml,package-lock.json,npm-shrinkwrap.json,yarn.lock,bun.lockb,bun.lock}",
  "**/{.npmrc,.nvmrc,.node-version,.tool-versions}",
  "**/tsconfig*.json",
  "**/jsconfig*.json",
  "**/{vitest,vite,jest,playwright,mocha,ava,babel,esbuild,rollup,webpack,tsup,swc}.config.*",
  "**/{vitest.workspace,vitest.setup,jest.setup,setupTests}.*",
  "**/.{babelrc,swcrc,mocharc}{,.*}",
  "**/{wrangler.toml,wrangler.json,wrangler.jsonc,Dockerfile}",
  ".weft/**",
  ".github/**",
];
/** Same high-risk paths as the workflows' heuristic risk floor (apps/workflows/src/core/evidence.ts). */
const HIGH_RISK = [/(^|\/)migrations?\//i, /(^|\/)(auth|security|crypto|session|permissions?)[^/]*(\/|\.|$)/i];

// ------------------------------------------------------------------------------ facts

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const hasMod = (n: ts.Node, k: ts.SyntaxKind) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === k));

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

export function fileFacts(path: string, text: string): FileFacts {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, scriptKind(path));
  const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const f: FileFacts = { v: 1, parse_error: diags.length ? ts.flattenDiagnosticMessageText(diags[0]!.messageText, " ").slice(0, 200) : null, imports: {}, side: [], exports: {}, star: [], decls: {}, module: [], opaque: false };
  let dyn = 0;
  /** Identifiers referenced under `node` (over-approximation: property names count too). */
  const refs = (node: ts.Node | undefined, skip?: ts.Node): string[] => {
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
      if (n === skip) return;
      if (ts.isIdentifier(n)) out.add(n.text);
      else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        const a = n.arguments[0];
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
          const local = `\0dyn${dyn++}`;
          f.imports[local] = [a.text, "*"];
          out.add(local);
        } else f.opaque = true;
      }
      ts.forEachChild(n, visit);
    };
    if (node) visit(node);
    return [...out];
  };
  const decl = (name: string, node: ts.Node | undefined, skip?: ts.Node) => {
    f.decls[name] = [...new Set([...(f.decls[name] ?? []), ...refs(node, skip)])];
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (!c) {
        f.side.push(spec);
        continue;
      }
      if (c.name) f.imports[c.name.text] = [spec, "default"];
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) f.imports[nb.name.text] = [spec, "*"];
      else if (nb) for (const el of nb.elements) f.imports[el.name.text] = [spec, (el.propertyName ?? el.name).text];
    } else if (ts.isImportEqualsDeclaration(st)) {
      const r = st.moduleReference;
      if (ts.isExternalModuleReference(r) && ts.isStringLiteral(r.expression)) f.imports[st.name.text] = [r.expression.text, "*"];
      else decl(st.name.text, r);
      if (hasMod(st, ts.SyntaxKind.ExportKeyword)) f.exports[st.name.text] = st.name.text;
    } else if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const ec = st.exportClause;
      if (spec && !ec) f.star.push(spec);
      else if (spec && ec && ts.isNamespaceExport(ec)) {
        const local = `\0re:${ec.name.text}`;
        f.imports[local] = [spec, "*"];
        f.exports[ec.name.text] = local;
      } else if (ec && ts.isNamedExports(ec))
        for (const el of ec.elements) {
          const from = (el.propertyName ?? el.name).text;
          if (spec) {
            const local = `\0re:${el.name.text}`;
            f.imports[local] = [spec, from];
            f.exports[el.name.text] = local;
          } else f.exports[el.name.text] = from;
        }
    } else if (ts.isExportAssignment(st)) {
      decl("default", st.expression);
      f.exports["default"] = "default";
    } else if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
      const name = st.name && ts.isIdentifier(st.name) ? st.name.text : hasMod(st, ts.SyntaxKind.DefaultKeyword) ? "default" : null;
      if (!name) {
        f.module.push(...refs(st));
        continue;
      }
      decl(name, st, st.name);
      if (hasMod(st, ts.SyntaxKind.ExportKeyword)) f.exports[hasMod(st, ts.SyntaxKind.DefaultKeyword) ? "default" : name] = name;
    } else if (ts.isVariableStatement(st)) {
      const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
      for (const d of st.declarationList.declarations) {
        const names = bindingNames(d.name);
        // Destructuring: every bound name depends on the whole initializer.
        for (const n of names) {
          decl(n, d.initializer);
          if (d.type) decl(n, d.type);
          if (exported) f.exports[n] = n;
        }
      }
    } else f.module.push(...refs(st));
  }
  f.module = [...new Set(f.module)];
  return f;
}

// ------------------------------------------------------------------------------ resolution

type Pkg = { name: string; dir: string; json: Record<string, unknown> };
const EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const JS_TO_TS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

function norm(p: string): string {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function resolveFile(base: string, files: Set<string>): string | null {
  if (files.has(base) && !base.endsWith("/")) return base;
  for (const [js, tss] of Object.entries(JS_TO_TS)) if (base.endsWith(js)) for (const t of tss) if (files.has(base.slice(0, -js.length) + t)) return base.slice(0, -js.length) + t;
  for (const e of EXT) if (files.has(base + e)) return base + e;
  for (const e of EXT) if (files.has(`${base}/index${e}`)) return `${base}/index${e}`;
  return null;
}

function exportTarget(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = exportTarget(x);
      if (t) return t;
    }
    return null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["source", "import", "node", "default", "require", "types"]) if (k in o) {
      const t = exportTarget(o[k]);
      if (t) return t;
    }
  }
  return null;
}

function resolvePackage(pkg: Pkg, sub: string, files: Set<string>): string | null {
  const ex = pkg.json.exports;
  const key = sub ? `./${sub}` : ".";
  let target: string | null = null;
  if (ex !== undefined) {
    if (typeof ex === "string" || Array.isArray(ex) || (ex && typeof ex === "object" && !Object.keys(ex).some((k) => k.startsWith(".")))) target = key === "." ? exportTarget(ex) : null;
    else if (ex && typeof ex === "object") {
      const map = ex as Record<string, unknown>;
      if (key in map) target = exportTarget(map[key]);
      else
        for (const [k, v] of Object.entries(map)) {
          if (!k.includes("*")) continue;
          const [pre, post] = k.split("*") as [string, string];
          if (key.startsWith(pre) && key.endsWith(post)) {
            const t = exportTarget(v);
            if (t) target = t.replace("*", key.slice(pre.length, key.length - post.length));
            break;
          }
        }
    }
  }
  if (!target && !sub) target = (typeof pkg.json.module === "string" ? pkg.json.module : null) ?? (typeof pkg.json.main === "string" ? pkg.json.main : null);
  const cands = target ? [norm(`${pkg.dir}/${target}`)] : [norm(`${pkg.dir}/${sub}`)];
  if (!sub) cands.push(norm(`${pkg.dir}/src/index`), norm(`${pkg.dir}/index`));
  for (const c of cands) {
    const r = resolveFile(c, files);
    if (r) return r;
    // dist/x.js -> src/x.ts (workspace packages that export their build output)
    const src = c.replace(/(^|\/)(dist|build|lib|out)\//, "$1src/");
    if (src !== c) {
      const r2 = resolveFile(src, files);
      if (r2) return r2;
    }
  }
  return null;
}

export type Resolver = (from: string, spec: string) => string | null | "opaque";

export function makeResolver(files: string[], read: (p: string) => string | undefined): Resolver {
  const set = new Set(files);
  const pkgs: Pkg[] = [];
  for (const p of files) {
    if (!(p === "package.json" || p.endsWith("/package.json")) || p.includes("node_modules/")) continue;
    try {
      const json = JSON.parse(read(p) ?? "{}") as Record<string, unknown>;
      if (typeof json.name === "string") pkgs.push({ name: json.name, dir: dirOf(p), json });
    } catch {
      /* unparsable package.json: imports of it stay external */
    }
  }
  pkgs.sort((a, b) => b.name.length - a.name.length);
  const memo = new Map<string, string | null | "opaque">();
  return (from, spec) => {
    const k = `${from}\0${spec}`;
    if (memo.has(k)) return memo.get(k)!;
    let r: string | null | "opaque" = null;
    if (spec.startsWith(".") || spec.startsWith("/")) r = resolveFile(norm(spec.startsWith("/") ? spec : `${dirOf(from)}/${spec}`), set);
    else if (/^(node:|bun:)/.test(spec)) r = null;
    else if (/^(@\/|~\/|#)/.test(spec)) r = "opaque"; // path alias / subpath import we do not resolve
    else {
      const pkg = pkgs.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
      if (pkg) r = resolvePackage(pkg, spec === pkg.name ? "" : spec.slice(pkg.name.length + 1), set);
    }
    memo.set(k, r);
    return r;
  };
}

// ------------------------------------------------------------------------------ selection

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function discoverTests(files: string[], config: SelectConfig = {}): string[] {
  const isTest = matcher(config.tests ?? DEFAULT_TESTS);
  return files.filter((p) => !p.includes("node_modules/") && CODE.test(p) && !p.endsWith(".d.ts") && isTest(p)).sort();
}

export function selectTests(input: SelectInput): Selection {
  const t0 = Date.now();
  const cfg = input.config ?? {};
  const files = input.files.filter((p) => !p.includes("node_modules/"));
  const tests = discoverTests(files, cfg);
  const graph = { files: 0, parsed: 0, cached: 0, ms: 0 };
  let writes: Write[] = [];
  const full = (reason: string): Selection => ({ mode: "full", reason, selected: tests, tests, total: tests.length, why: {}, writes: writes.slice(0, 200), graph: { ...graph, ms: Date.now() - t0 } });

  if (!tests.length) return full("no test files matched the test globs");
  const risk = input.risk ?? "low";
  const at = cfg.full_at_risk ?? "high";
  if (RANK[risk] >= RANK[at]) return full(`risk tier ${risk}`);

  const isInfra = matcher([...INFRA, ...(cfg.infra ?? [])]);
  const isIgnored = matcher(cfg.ignore ?? DEFAULT_IGNORE);
  const isTest = new Set(tests);
  for (const c of input.changed) {
    if (isInfra(c.path)) return full(`config/deps/test infra changed: ${c.path}`);
    if (HIGH_RISK.some((re) => re.test(c.path))) return full(`high-risk path changed: ${c.path}`);
  }

  // 1. Facts for every code file (cached by blob sha).
  const facts = new Map<string, FileFacts>();
  for (const p of files) {
    if (!CODE.test(p)) continue;
    graph.files++;
    const blob = input.blobs?.[p];
    const hit = blob ? input.cache?.get(blob) : undefined;
    if (hit) {
      graph.cached++;
      facts.set(p, hit);
      continue;
    }
    const text = input.read(p);
    if (text === undefined) continue;
    const f = fileFacts(p, text);
    graph.parsed++;
    facts.set(p, f);
    if (blob && input.cache) input.cache.set(blob, f);
  }
  // Deleted files stay resolvable: their importers are what the deletion breaks.
  const deleted = input.changed.filter((c) => c.status === "D").map((c) => c.path);
  const resolve = makeResolver([...files, ...deleted], input.read);

  // 2. Seeds: the analyzer write set of each changed code file + module-level changes.
  const tainted = new Map<string, Set<string>>(); // file -> tainted locals
  const whole = new Set<string>(); // files whose module-level code changed (every binding tainted)
  const why: Record<string, string> = {};
  const changedTests: string[] = [];
  const nonCode: string[] = [];
  for (const c of input.changed) {
    const p = c.path;
    if (isTest.has(p)) {
      if (c.status !== "D") changedTests.push(p);
      continue;
    }
    if (!CODE.test(p)) {
      if (!isIgnored(p)) nonCode.push(p);
      continue;
    }
    if (p.endsWith(".d.ts")) {
      whole.add(p);
      continue;
    }
    const after = c.status === "D" ? "" : input.read(p);
    const before = c.status === "A" ? "" : input.readBefore(p);
    if (after === undefined || before === undefined) return full(`could not read ${p}`);
    const fa = facts.get(p);
    if (fa?.parse_error) return full(`analyzer cannot parse ${p}: ${fa.parse_error}`);
    let a: { writes: Write[] };
    try {
      a = analyze(before, after, p);
    } catch (e) {
      return full(`analyzer failed on ${p}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
    writes.push(...a.writes);
    const set = tainted.get(p) ?? new Set<string>();
    for (const w of a.writes) set.add(w.key.slice(w.key.indexOf("#") + 1).split(".")[0]!);
    tainted.set(p, set);
    // Changes outside declarations (imports, exports, top-level statements) are not in the
    // write set: compare them structurally and taint the whole module when they differ.
    if (c.status === "A" || c.status === "D") whole.add(p);
    else {
      const fb = fileFacts(p, before);
      if (fb.parse_error) return full(`analyzer cannot parse ${p} on trunk: ${fb.parse_error}`);
      if (fa && moduleShape(fb) !== moduleShape(fa)) whole.add(p);
    }
  }
  // Non-code files: imported ones (json, css, wasm) taint their importers; others may be read at runtime.
  const importedFiles = new Set<string>();
  for (const [p, f] of facts) for (const spec of [...Object.values(f.imports).map((x) => x[0]), ...f.side, ...f.star]) {
    const r = resolve(p, spec);
    if (r && r !== "opaque") importedFiles.add(r);
  }
  for (const p of nonCode) {
    if (importedFiles.has(p)) {
      whole.add(p);
      continue;
    }
    if (OTHER_SOURCE.test(p)) return full(`no TS/JS graph for ${p} (selection covers TypeScript/JavaScript)`);
    return full(`non-code file changed that no module imports (tests may read it at runtime): ${p}`);
  }
  writes = writes.sort((a, b) => a.key.localeCompare(b.key));

  // 3. Fixed point over the graph.
  const taint = (p: string, local: string): boolean => {
    let s = tainted.get(p);
    if (!s) tainted.set(p, (s = new Set()));
    if (s.has(local)) return false;
    s.add(local);
    return true;
  };
  const exportTainted = (p: string, name: string, seen = new Set<string>()): boolean => {
    if (whole.has(p)) return true;
    if (seen.has(p)) return false;
    seen.add(p);
    const f = facts.get(p);
    if (!f) return false;
    const local = f.exports[name];
    if (local !== undefined) return tainted.get(p)?.has(local) ?? false;
    if (name === "default") return false;
    for (const spec of f.star) {
      const r = resolve(p, spec);
      if (r && r !== "opaque" && exportTainted(r, name, seen)) return true;
    }
    return false;
  };
  const anyTainted = (p: string, seen = new Set<string>()): boolean => {
    if (whole.has(p)) return true;
    if (seen.has(p)) return false;
    seen.add(p);
    const f = facts.get(p);
    if (!f) return false;
    if (Object.values(f.exports).some((l) => tainted.get(p)?.has(l))) return true;
    return f.star.some((spec) => {
      const r = resolve(p, spec);
      return !!r && r !== "opaque" && anyTainted(r, seen);
    });
  };
  for (let changed = true, rounds = 0; changed && rounds < 10_000; rounds++) {
    changed = false;
    for (const [p, f] of facts) {
      if (whole.has(p)) continue;
      // cross-file: import bindings of tainted exports
      for (const [local, [spec, name]] of Object.entries(f.imports)) {
        if (tainted.get(p)?.has(local)) continue;
        const r = resolve(p, spec);
        if (!r || r === "opaque") continue;
        if (name === "*" ? anyTainted(r) : exportTainted(r, name)) changed = taint(p, local) || changed;
      }
      // side-effect imports of a tainted module re-run its side effects here
      if (f.side.some((spec) => {
        const r = resolve(p, spec);
        return !!r && r !== "opaque" && (whole.has(r) || (facts.get(r)?.module.some((id) => tainted.get(r)?.has(id)) ?? false));
      })) {
        whole.add(p);
        changed = true;
        continue;
      }
      // intra-file: declarations referencing a tainted local (callers, transitively)
      const s = tainted.get(p);
      if (!s?.size) continue;
      for (let again = true; again; ) {
        again = false;
        for (const [name, ids] of Object.entries(f.decls)) if (!s.has(name) && ids.some((id) => s.has(id) && id !== name)) again = taint(p, name) || again;
        changed = again || changed;
      }
    }
  }

  // 4. Tests.
  const reachesOpaque = (start: string): boolean => {
    const stack = [start];
    const seen = new Set<string>();
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      const f = facts.get(p);
      if (!f) continue;
      if (f.opaque) return true;
      for (const spec of [...Object.values(f.imports).map((x) => x[0]), ...f.side, ...f.star]) {
        const r = resolve(p, spec);
        if (r === "opaque") return true;
        if (r) stack.push(r);
      }
    }
    return false;
  };
  const anyOpaque = [...facts.values()].some((f) => f.opaque) || [...facts.entries()].some(([p, f]) => Object.values(f.imports).some(([spec]) => resolve(p, spec) === "opaque"));
  const selected: string[] = [];
  for (const t of tests) {
    const f = facts.get(t);
    let reason: string | null = null;
    if (changedTests.includes(t)) reason = "test file changed";
    else if (!f) reason = "test file unreadable";
    else if (f.parse_error) reason = "test file does not parse";
    else if (whole.has(t)) reason = "imports a changed module";
    else {
      const hit = [...(tainted.get(t) ?? [])].find((l) => l in f.imports);
      if (hit) {
        const [spec, name] = f.imports[hit]!;
        reason = `reaches ${name === "*" ? spec : `${spec}#${name}`}`;
      } else if (anyOpaque && reachesOpaque(t)) reason = "reaches a dynamic or unresolved import";
    }
    if (reason) {
      selected.push(t);
      why[t] = reason;
    }
  }
  const frac = cfg.max_fraction ?? 1;
  if (selected.length > tests.length * frac) return { ...full(`selection (${selected.length}/${tests.length}) above max_fraction ${frac}`), why };
  return { mode: "subset", reason: null, selected, tests, total: tests.length, why, writes: writes.slice(0, 200), graph: { ...graph, ms: Date.now() - t0 } };
}

/** Everything except declaration bodies: imports, exports, module-level references. */
function moduleShape(f: FileFacts): string {
  const imp = Object.entries(f.imports).filter(([k]) => !k.startsWith("\0dyn")).sort();
  return JSON.stringify([imp, [...f.side].sort(), Object.entries(f.exports).sort(), [...f.star].sort(), [...f.module].sort(), f.opaque]);
}

/** Test command for the selected files: `{files}` placeholder in an argv/string, else appended. */
export function selectedCommand(command: string[] | string, files: string[]): string[] {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (Array.isArray(command)) {
    const i = command.indexOf("{files}");
    return i >= 0 ? [...command.slice(0, i), ...files, ...command.slice(i + 1)] : [...command, ...files];
  }
  const joined = files.map(q).join(" ");
  return ["sh", "-c", command.includes("{files}") ? command.replace("{files}", joined) : `${command} ${joined}`];
}
