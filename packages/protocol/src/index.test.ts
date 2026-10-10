import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  closeCode,
  decodeCursor,
  encodeCursor,
  ERROR_STATUS,
  ERROR_CODES,
  mergeFeed,
  mergeWriteKind,
  parseKey,
  partialMatch,
  ReferenceCoordinator,
  renderContext,
  runScenario,
  scenarioClock,
  scenarioInit,
  schema,
  summarize,
  validate,
  validateMessage,
  type EventRecord,
  type Scenario,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const dir = (p: string) =>
  readdirSync(join(pkg, p))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), data: readJson(join(pkg, p, f)) }));

type MessageFixture = { schema: string; value: unknown; expect_issue_path?: string };
const valid = dir("fixtures/messages/valid") as Array<{ name: string; data: MessageFixture }>;
const invalid = dir("fixtures/messages/invalid") as Array<{ name: string; data: MessageFixture }>;
const scenarios = dir("fixtures/scenarios") as Array<{ name: string; data: Scenario }>;

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
ajv.addSchema(schema as object, "wcp");
const ajvValidate = (name: string, v: unknown) => ajv.validate(`wcp#/$defs/${name}`, v);

describe("JSON Schema artifact", () => {
  it("schema/wcp-v0.schema.json is up to date with src/schema.ts (run `pnpm gen`)", () => {
    expect(readJson(join(pkg, "schema/wcp-v0.schema.json"))).toEqual(JSON.parse(JSON.stringify(schema)));
  });

  it("compiles under Ajv strict mode (draft 2020-12)", () => {
    expect(ajv.getSchema("wcp")).toBeTruthy();
  });

  it("has fixtures", () => {
    expect(valid.length).toBeGreaterThanOrEqual(35);
    expect(invalid.length).toBeGreaterThanOrEqual(25);
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
  });
});

describe("message fixtures", () => {
  it.each(valid)("valid/$name", ({ data }) => {
    const r = validate(data.schema, data.value);
    expect(r.ok ? [] : r.issues).toEqual([]);
    expect(ajvValidate(data.schema, data.value), JSON.stringify(ajv.errors)).toBe(true);
  });

  it.each(invalid)("invalid/$name", ({ data }) => {
    const r = validate(data.schema, data.value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(data.expect_issue_path);
    expect(ajvValidate(data.schema, data.value)).toBe(false);
  });

  it("dispatches by type discriminator", () => {
    const hello = valid.find((v) => v.name === "hello-claude-code-l3")!.data.value;
    expect(validateMessage(hello)).toMatchObject({ ok: true, schema: "Hello" });
    expect(validateMessage({ type: "nope" }).ok).toBe(false);
    expect(validateMessage({ type: "ping", head_seq: 3 })).toMatchObject({ ok: true, schema: "StreamFrame" });
  });
});

describe("helpers", () => {
  it("parses symbol keys", () => {
    expect(parseKey("src/auth/session.ts#SessionStore.get")).toEqual({
      path: "src/auth/session.ts",
      name: "SessionStore.get",
      short: "get",
    });
    expect(() => parseKey("src/a.ts")).toThrow();
  });

  it("summarizes within 140 chars, prefixing rejections", () => {
    const base = { actor: { type: "agent" as const, id: "a" }, agent: "a", status: "accepted" as const };
    expect(
      summarize({
        ...base,
        kind: "edit",
        writes: [
          { key: "src/x.ts#f", kind: "signature" },
          { key: "src/x.ts#g", kind: "new" },
        ],
        intent: "split f\nmore detail",
      }),
    ).toBe("a changed signature of f, added g in src/x.ts — split f");
    const long = summarize({ ...base, status: "rejected", kind: "edit", writes: [{ key: "src/x.ts#f", kind: "body" }], intent: "x".repeat(300) });
    expect([...long].length).toBe(140);
    expect(long.startsWith("Blocked: a edited f in src/x.ts — ")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(
      summarize({ ...base, kind: "edit", writes: ["a", "b", "c", "d"].map((n) => ({ key: `s.ts#${n}`, kind: "body" as const })) }),
    ).toBe("a edited a, b +2 more in s.ts");
  });

  it("merges write kinds per §6.1", () => {
    expect(mergeWriteKind(undefined, "body")).toBe("body");
    expect(mergeWriteKind("new", "signature")).toBe("new");
    expect(mergeWriteKind("body", "signature")).toBe("signature");
    expect(mergeWriteKind("signature", "body")).toBe("signature");
    expect(mergeWriteKind("body", "deleted")).toBe("deleted");
    expect(mergeWriteKind("deleted", "new")).toBe("signature");
  });

  it("maps every error code to an HTTP status and WS close code", () => {
    for (const c of ERROR_CODES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(closeCode("unauthorized")).toBe(4401);
    expect(closeCode("session_expired")).toBe(4410);
  });

  it("renders deterministic model-visible context", () => {
    const text = renderContext([
      {
        severity: "error",
        code: "stale_assumption",
        file: "src/api/client.ts",
        range: { start: { line: 41, character: 10 }, end: { line: 41, character: 22 } },
        symbol: "src/auth/session.ts#refreshToken",
        message: "signature changed",
        caused_by_seq: 12,
        caused_by_agent: "claude-a",
        caused_by_task: "T-1",
        suggestion: "update the call",
      },
    ]);
    expect(text).toBe(
      "[weft error] stale_assumption src/api/client.ts:42:11: signature changed (caused by claude-a · task T-1 · event #12). Suggestion: update the call",
    );
  });
});

describe("combined feed (§9.5)", () => {
  const rec = (repo: string, seq: number, ts: string): EventRecord => ({
    seq,
    repo,
    status: "accepted",
    kind: "intent",
    ts,
    actor: { type: "agent", id: "a" },
    files: [],
    reads: [],
    writes: [],
    summary: "a plans",
    diagnostics: [],
  });

  it("round-trips cursors", () => {
    const c = { weft: 12, "demo-app": 3 };
    const s = encodeCursor(c);
    expect(s.startsWith("v0.")).toBe(true);
    expect(decodeCursor(s)).toEqual(c);
    expect(decodeCursor(undefined)).toEqual({});
    expect(() => decodeCursor("v9.xxx")).toThrow();
  });

  it("merges repos by (ts, repo, seq) and resumes exactly", () => {
    const a = [rec("a", 1, "2026-10-05T10:00:00.000Z"), rec("a", 2, "2026-10-05T10:00:02.000Z")];
    const b = [rec("b", 1, "2026-10-05T10:00:01.000Z"), rec("b", 2, "2026-10-05T10:00:02.000Z")];
    const p1 = mergeFeed({ a: { events: a, has_more: false }, b: { events: b, has_more: false } }, {}, 3);
    expect(p1.events.map((e) => `${e.repo}${e.seq}`)).toEqual(["a1", "b1", "a2"]);
    expect(p1.has_more).toBe(true);
    expect(validate("FeedPage", p1).ok).toBe(true);
    const p2 = mergeFeed({ a: { events: a, has_more: false }, b: { events: b, has_more: false } }, decodeCursor(p1.cursor), 3);
    expect(p2.events.map((e) => `${e.repo}${e.seq}`)).toEqual(["b2"]);
    expect(decodeCursor(p2.cursor)).toEqual({ a: 2, b: 2 });
    expect(p2.has_more).toBe(false);
  });

  it("tail mode returns the newest records and a cursor at every head", () => {
    const a = [rec("a", 7, "2026-10-05T10:00:00.000Z"), rec("a", 8, "2026-10-05T10:00:03.000Z")];
    const b = [rec("b", 4, "2026-10-05T10:00:01.000Z")];
    const p = mergeFeed({ a: { events: a, has_more: true, head_seq: 8 }, b: { events: b, has_more: false, head_seq: 4 } }, {}, 2, { tail: true });
    expect(p.events.map((e) => `${e.repo}${e.seq}`)).toEqual(["b4", "a8"]);
    expect(decodeCursor(p.cursor)).toEqual({ a: 8, b: 4 });
    expect(p.has_more).toBe(false);
  });
});

function schemaFor(op: string, actual: unknown): string | undefined {
  if (actual === null || actual === undefined) return undefined;
  if (op === "system" || op === "event") return (actual as { type?: string }).type === "error" ? "WcpError" : "EventRecord";
  return undefined;
}

async function run(sc: Scenario) {
  const clock = scenarioClock(sc.start);
  const coord = new ReferenceCoordinator({ ...scenarioInit(sc), now: clock.now });
  const results = await runScenario(sc, coord, clock);
  return { coord, results };
}

describe("conformance scenarios (reference coordinator)", () => {
  it.each(scenarios)("$name", async ({ data }) => {
    const { coord, results } = await run(data);
    const failures = results.filter((r) => !r.ok).map((r) => ({ step: r.index, op: r.op, errors: r.errors }));
    expect(failures).toEqual([]);

    // Every response the reference emits must itself satisfy the schema.
    for (const r of results) {
      const named = schemaFor(r.op, r.actual);
      if (named) expect(validate(named, r.actual)).toMatchObject({ ok: true });
      else if (Array.isArray(r.actual)) for (const e of r.actual) expect(validate("EventRecord", e)).toMatchObject({ ok: true });
      else if (r.actual && typeof r.actual === "object") {
        const v = validateMessage(r.actual);
        expect(v.ok ? [] : v.issues, `step ${r.index} ${r.op}`).toEqual([]);
      }
    }
    // Log invariants (§5.1): gapless, starts at 1, ts non-decreasing, every record valid.
    coord.log.forEach((rec, i) => {
      expect(rec.seq).toBe(i + 1);
      if (i) expect(rec.ts >= coord.log[i - 1]!.ts).toBe(true);
      expect(validate("EventRecord", rec)).toMatchObject({ ok: true });
    });
  });

  it.each(scenarios)("$name replays deterministically", async ({ data }) => {
    const one = await run(data);
    const two = await run(data);
    expect(JSON.stringify(two.coord.log)).toBe(JSON.stringify(one.coord.log));
    expect(two.results.map((r) => r.actual)).toEqual(one.results.map((r) => r.actual));
  });

  it("covers every diagnostic code that the reference can emit", () => {
    const seen = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.code === "string" && typeof o.severity === "string") seen.add(o.code);
        Object.values(o).forEach(walk);
      }
    };
    walk(scenarios.map((s) => s.data.steps.map((st) => ("expect" in st ? st.expect : undefined))));
    for (const code of [
      "stale_overwrite",
      "stale_assumption",
      "stale_read",
      "claim_wait",
      "claim_die",
      "claim_wounded",
      "claim_contended",
      "contract_changed",
      "agent_paused",
      "trunk_advanced",
      "claim_predicted_overlap",
    ])
      expect(seen, code).toContain(code);
  });

  it("partialMatch semantics", () => {
    expect(partialMatch({ a: 1, b: [1, 2] }, { a: 1, b: { $len: 2 } })).toEqual([]);
    expect(partialMatch({ a: 1 }, { b: "$absent" })).toEqual([]);
    expect(partialMatch({ a: [{ x: 1 }, { x: 2 }] }, { a: { $contains: [{ x: 2 }] } })).toEqual([]);
    expect(partialMatch([1], [1, 2])).toHaveLength(1);
  });
});
