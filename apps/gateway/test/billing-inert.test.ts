// Hosted billing is OFF until the Stripe secrets are set (this suite runs without them): the billing
// routes answer 503, nobody is ever refused for being over an allowance, and usage is still counted so
// `GET /v1/space` has real numbers. docs/pricing.md and the wrangler default agree on the allowance.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Welcome } from "@weft/protocol";
import { DEFAULT_FREE_EVENTS } from "../src/usage";
import pricingDoc from "../../../docs/pricing.md?raw";
import wrangler from "../wrangler.toml?raw";
import { ADMIN, BASE, call, hello, wcp } from "./helpers";

let n = 0;
async function agentSpace() {
  const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": `198.51.100.${(n++ % 200) + 1}-${crypto.randomUUID().slice(0, 6)}` });
  expect(r.status).toBe(201);
  const s = (await r.json()) as { space: { id: string }; token: string };
  await call("POST", "/v1/space/repos", s.token, { name: "app" });
  const repo = `${s.space.id}-app`;
  const t = (await (await call("POST", "/v1/space/tokens", s.token, { kind: "agent", repo, agent: "a1" })).json()) as { token: string };
  const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t.token, hello("a1", `I-${s.space.id}`));
  return { id: s.space.id, owner: s.token, repo, agent: t.token, session: sess.session, head: sess.head_seq, k: 0 };
}

describe("billing is inert without Stripe secrets", () => {
  it("billing routes answer 503 and say why", async () => {
    const a = await agentSpace();
    for (const [m, p, tok] of [
      ["POST", "/v1/space/billing/checkout", a.owner],
      ["POST", "/v1/space/billing/portal", a.owner],
      ["POST", "/v1/billing/stripe/webhook", undefined],
      ["POST", "/v1/admin/billing/report", ADMIN],
    ] as const) {
      const r = await call(m, p, tok, {});
      expect(r.status, p).toBe(503);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("unavailable");
    }
    // even a correctly shaped webhook is not read
    const w = await SELF.fetch(`${BASE}/v1/billing/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) }, body: "{}" });
    expect(w.status).toBe(503);
  });

  it("nobody hits an allowance: over the allowance still works, and usage is still counted", async () => {
    const a = await agentSpace();
    expect((await call("POST", `/v1/admin/spaces/${a.id}/allowance`, ADMIN, { events: 1 })).status).toBe(200);
    const info0 = (await (await call("GET", "/v1/space", a.owner)).json()) as { usage: { allowance: number; plan: string; events: number }; billing: { enabled: boolean } };
    expect(info0.billing.enabled).toBe(false);
    expect(info0.usage).toMatchObject({ allowance: 1, plan: "free", events: 0 });
    for (let i = 0; i < 4; i++) {
      const r = await call("POST", `/v1/repos/${a.repo}/sessions/${a.session}/events`, a.agent, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.head, writes: [{ key: `src/f${a.k++}.ts#x`, kind: "body" }] } });
      expect(r.status).toBe(200);
      a.head = ((await r.json()) as { head_seq: number }).head_seq;
    }
    let events = 0;
    for (let i = 0; i < 100 && events < 4; i++) {
      events = ((await (await call("GET", "/v1/space", a.owner)).json()) as { usage: { events: number } }).usage.events;
      if (events < 4) await new Promise((r) => setTimeout(r, 25));
    }
    expect(events).toBe(4); // counted, never refused
  });

  it("the default allowance is the one in docs/pricing.md and in the hosted wrangler vars", () => {
    const cfg = JSON.parse(/```json pricing-config\n([\s\S]*?)\n```/.exec(pricingDoc)![1]!) as { free_events_per_month: number; usd_per_1000_events: number; meter_event_name: string };
    expect(cfg.free_events_per_month).toBe(DEFAULT_FREE_EVENTS);
    expect(cfg.meter_event_name).toBe("weft_agent_events");
    expect(cfg.usd_per_1000_events).toBeGreaterThan(0);
    const hosted = wrangler.slice(wrangler.indexOf("[env.hosted.vars]"));
    expect(Number(/WEFT_FREE_EVENTS = "(\d+)"/.exec(hosted)![1])).toBe(DEFAULT_FREE_EVENTS);
  });
});
