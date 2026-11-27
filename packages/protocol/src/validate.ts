// Workers-safe JSON Schema validator for the subset WCP uses (no eval / new Function,
// so it runs inside Durable Objects). Supported keywords: $ref (local #/$defs), type,
// const, enum, properties, required, additionalProperties, items, minItems, maxItems,
// minimum, maximum, minLength, maxLength, pattern, oneOf, anyOf, allOf, if/then/else.
// Ajv cross-checks this interpreter against every fixture in the test suite.

import { schema, type JsonSchema } from "./schema";
import type { MessageType } from "./types";

export type ValidationIssue = { path: string; message: string };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

const KNOWN = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "oneOf",
  "anyOf",
  "allOf",
  "if",
  "then",
  "else",
]);

const regexCache = new Map<string, RegExp>();
const regex = (p: string) => {
  let r = regexCache.get(p);
  if (!r) regexCache.set(p, (r = new RegExp(p, "u")));
  return r;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  return want === t || (want === "number" && t === "integer");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

function resolve(s: JsonSchema, root: JsonSchema): JsonSchema {
  const r = s.$ref;
  if (typeof r !== "string") return s;
  const m = /^#\/\$defs\/(.+)$/.exec(r);
  const defs = root.$defs as Record<string, JsonSchema> | undefined;
  const target = m && defs?.[m[1]!];
  if (!target) throw new Error(`unresolvable $ref ${r}`);
  return target;
}

function check(s: JsonSchema, v: unknown, path: string, root: JsonSchema, out: ValidationIssue[]): void {
  if (s.$ref !== undefined) {
    check(resolve(s, root), v, path, root, out);
    return;
  }
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`unsupported schema keyword ${k} at ${path}`);

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(t, v))) {
      out.push({ path, message: `expected ${types.join("|")}, got ${typeOf(v)}` });
      return;
    }
  }
  if (s.const !== undefined && !deepEqual(s.const, v)) out.push({ path, message: `expected ${JSON.stringify(s.const)}` });
  if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => deepEqual(e, v)))
    out.push({ path, message: `expected one of ${JSON.stringify(s.enum)}` });

  if (typeof v === "string") {
    if (typeof s.minLength === "number" && [...v].length < s.minLength) out.push({ path, message: `shorter than ${s.minLength}` });
    if (typeof s.maxLength === "number" && [...v].length > s.maxLength) out.push({ path, message: `longer than ${s.maxLength}` });
    if (typeof s.pattern === "string" && !regex(s.pattern).test(v)) out.push({ path, message: `does not match ${s.pattern}` });
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) out.push({ path, message: `less than ${s.minimum}` });
    if (typeof s.maximum === "number" && v > s.maximum) out.push({ path, message: `greater than ${s.maximum}` });
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) out.push({ path, message: `fewer than ${s.minItems} items` });
    if (typeof s.maxItems === "number" && v.length > s.maxItems) out.push({ path, message: `more than ${s.maxItems} items` });
    if (s.items && typeof s.items === "object") v.forEach((item, i) => check(s.items as JsonSchema, item, `${path}/${i}`, root, out));
  }
  if (typeOf(v) === "object") {
    const o = v as Record<string, unknown>;
    for (const r of (s.required as string[] | undefined) ?? [])
      if (!(r in o)) out.push({ path: `${path}/${r}`, message: "required" });
    const props = (s.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) if (k in o) check(sub, o[k], `${path}/${k}`, root, out);
    if (s.additionalProperties !== undefined) {
      for (const k of Object.keys(o)) {
        if (k in props) continue;
        if (s.additionalProperties === false) out.push({ path: `${path}/${k}`, message: "unexpected property" });
        else if (typeof s.additionalProperties === "object")
          check(s.additionalProperties as JsonSchema, o[k], `${path}/${k}`, root, out);
      }
    }
  }
  for (const sub of (s.allOf as JsonSchema[] | undefined) ?? []) check(sub, v, path, root, out);
  if (s.anyOf) {
    const branches = (s.anyOf as JsonSchema[]).map((sub) => issues(sub, v, path, root));
    if (!branches.some((b) => b.length === 0)) out.push(...best(branches, path, "anyOf"));
  }
  if (s.oneOf) {
    const branches = (s.oneOf as JsonSchema[]).map((sub) => issues(sub, v, path, root));
    const passing = branches.filter((b) => b.length === 0).length;
    if (passing === 0) out.push(...best(branches, path, "oneOf"));
    else if (passing > 1) out.push({ path, message: "matches more than one oneOf branch" });
  }
  if (s.if !== undefined) {
    const cond = issues(s.if as JsonSchema, v, path, root).length === 0;
    if (cond && s.then) check(s.then as JsonSchema, v, path, root, out);
    if (!cond && s.else) check(s.else as JsonSchema, v, path, root, out);
  }
}

function issues(s: JsonSchema, v: unknown, path: string, root: JsonSchema): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  check(s, v, path, root, out);
  return out;
}

/** Report the closest branch (fewest issues) so messages stay useful. */
function best(branches: ValidationIssue[][], path: string, kw: string): ValidationIssue[] {
  const sorted = [...branches].sort((a, b) => a.length - b.length);
  const top = sorted[0] ?? [];
  return top.length ? top : [{ path, message: `no ${kw} branch matched` }];
}

/** Validate any value against a named $defs entry of the WCP schema. */
export function validate<T = unknown>(name: MessageType | string, value: unknown): ValidationResult<T> {
  const defs = schema.$defs as Record<string, JsonSchema>;
  if (!defs[name]) throw new Error(`unknown schema definition ${name}`);
  const out = issues({ $ref: `#/$defs/${name}` }, value, "", schema);
  return out.length ? { ok: false, issues: out } : { ok: true, value: value as T };
}

/** Throwing variant; message lists issues as `path: message`. */
export function assertValid<T = unknown>(name: MessageType | string, value: unknown): T {
  const r = validate<T>(name, value);
  if (!r.ok) throw new Error(`invalid ${name}: ${r.issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ")}`);
  return r.value;
}

const BY_TYPE: Record<string, MessageType> = {
  hello: "Hello",
  welcome: "Welcome",
  submit: "Submit",
  verdict: "Verdict",
  "inbox.drain": "InboxDrain",
  inbox: "InboxBatch",
  heartbeat: "Heartbeat",
  "heartbeat.ack": "HeartbeatAck",
  gate: "Gate",
  "gate.result": "GateResult",
  bye: "Bye",
  repos: "RepoList",
  events: "EventPage",
  feed: "FeedPage",
  event: "StreamFrame",
  "replay.done": "StreamFrame",
  ping: "StreamFrame",
  action: "HumanAction",
  "action.result": "ActionResult",
  dependencies: "Dependencies",
  error: "WcpError",
};

/** Validate a message by its `type` discriminator (what a WS frame or HTTP body carries). */
export function validateMessage(value: unknown): ValidationResult<unknown> & { schema?: MessageType } {
  const t = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
  const name = typeof t === "string" ? BY_TYPE[t] : undefined;
  if (!name) return { ok: false, issues: [{ path: "/type", message: `unknown message type ${JSON.stringify(t)}` }] };
  return { ...validate(name, value), schema: name };
}
