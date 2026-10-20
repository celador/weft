import { describe, expect, it } from "vitest";
import { errorsFromTail, handleTail, repoMap, type Env } from "../src/index";

describe("Tail normalization", () => {
  it("forwards exception stack traces but ignores response-only failures", async () => {
    // Shape as delivered by the Tail Consumer of weft-demo (exceptions at the top level).
    const errors = await errorsFromTail([
      { eventTimestamp: 1_234, scriptName: "weft-demo", outcome: "exception", exceptions: [{ name: "TypeError", message: "planted bug", stack: "    at fetch (worker.js:30:72)", timestamp: 1_234 }], event: { request: { url: "https://weft-demo.example.workers.dev/quote?sku=pear&token=x", method: "GET" }, response: { status: 500 } } },
      { eventTimestamp: 1_235, scriptName: "weft-demo", outcome: "ok", exceptions: [], event: { response: { status: 500 } } },
    ], "weft-demo");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ repo: "weft-demo", occurred_at: 1_234, script: "weft-demo", status: 500, stack: "TypeError: planted bug\n    at fetch (worker.js:30:72)\n    (request: GET /quote)" });
    expect(errors[0]!.event_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps a stack that already starts with its message line", async () => {
    const [e] = await errorsFromTail([{ eventTimestamp: 1, exceptions: [{ name: "Error", message: "boom", stack: "Error: boom\n at x" }] }], "r");
    expect(e!.stack).toBe("Error: boom\n at x");
  });

  it("writes one Analytics Engine index per point and queues the error", async () => {
    const points: Array<{ indexes?: unknown[] }> = [];
    const sent: unknown[] = [];
    const env = {
      WEFT_REPO: "weft-demo",
      WEFT_PROD: { writeDataPoint: (p: { indexes?: unknown[] }) => { if ((p.indexes?.length ?? 0) > 1) throw new TypeError("writeDataPoint(): Maximum of 1 indexes supported."); points.push(p); } },
      WEFT_PROD_EVENTS: { send: async (m: unknown) => { sent.push(m); } },
    } as unknown as Env;
    await handleTail([{ eventTimestamp: 5, scriptName: "weft-demo", exceptions: [{ name: "Error", message: "x", stack: "    at y" }] }], env);
    expect(points).toEqual([expect.objectContaining({ indexes: ["weft-demo"] })]);
    expect(sent).toHaveLength(1);
  });

  it("routes each producer script to its repo via WEFT_REPOS, else the default repo", async () => {
    const sent: Array<{ repo: string; script?: string }> = [];
    const env = {
      WEFT_REPO: "weft-demo",
      WEFT_REPOS: JSON.stringify({ "weft-demo-site": "weft-demo-site" }),
      WEFT_PROD: { writeDataPoint: () => undefined },
      WEFT_PROD_EVENTS: { send: async (m: { repo: string; script?: string }) => { sent.push(m); } },
    } as unknown as Env;
    const ex = [{ name: "Error", message: "x", stack: "    at y" }];
    await handleTail([{ eventTimestamp: 7, scriptName: "weft-demo-site", exceptions: ex }, { eventTimestamp: 8, scriptName: "weft-demo", exceptions: ex }, { eventTimestamp: 9, exceptions: ex }], env);
    expect(sent.map((e) => [e.script ?? null, e.repo])).toEqual([["weft-demo-site", "weft-demo-site"], ["weft-demo", "weft-demo"], [null, "weft-demo"]]);
  });

  it("treats a malformed WEFT_REPOS as no map", () => {
    expect(repoMap("{nope")).toEqual({});
    expect(repoMap('["a"]')).toEqual({});
    expect(repoMap('{"a":"b","c":3}')).toEqual({ a: "b" });
    expect(repoMap(undefined)).toEqual({});
  });
});
