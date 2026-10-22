// Helpers shared by the Swift and C# specs (lexically scoped, index-based languages).
import type { Reference, SyntaxNode } from "../language.js";

export function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

export function same(a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean {
  return !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

/** Is `node` one of `parent`'s children for any of `fields`? */
export function isFieldOf(parent: SyntaxNode, node: SyntaxNode, fields: string[]): boolean {
  return fields.some((f) => parent.childrenForFieldName(f).some((c) => same(c, node)));
}

export function nodeId(node: SyntaxNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

/** `node.text` with the given child spans cut out (spans are absolute, non-overlapping). */
export function cut(node: SyntaxNode, spans: Array<SyntaxNode | null | undefined>, end = node.endIndex): string {
  let out = "";
  let at = node.startIndex;
  const text = node.text;
  for (const s of spans.filter((x): x is SyntaxNode => !!x && x.startIndex >= node.startIndex && x.endIndex <= end).sort((a, b) => a.startIndex - b.startIndex)) {
    if (s.startIndex < at) continue;
    out += text.slice(at - node.startIndex, s.startIndex - node.startIndex);
    at = s.endIndex;
  }
  return out + text.slice(at - node.startIndex, end - node.startIndex);
}

/**
 * A reference written unqualified inside nested types: try each enclosing type, innermost
 * first (implicit `self` / `this`, nested types), then the `extra` candidates, then the
 * reference as written. `scope` is the innermost type path, e.g. ["Outer", "Cart"].
 */
export function scoped(ref: string[], scope: string[], extra: string[][] = []): Reference {
  const chain: Reference[] = [];
  for (let n = scope.length; n >= 1; n--) {
    const r: Reference = [...scope.slice(0, n), ...ref];
    r.min = n + 1;
    r.anchored = true;
    chain.push(r);
  }
  for (const e of extra) {
    const r: Reference = [...e, ...ref];
    r.min = e.length + 1;
    chain.push(r);
  }
  chain.push([...ref]);
  for (let i = 0; i < chain.length - 1; i++) chain[i].or = chain[i + 1];
  return chain[0];
}
