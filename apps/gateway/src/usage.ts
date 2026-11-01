// Usage metering vocabulary shared by the Registry (which stores it) and the gateway (which
// enforces and shows it). The meter is "agent events": an agent submit whose verdict carries a
// `seq`, i.e. an event that entered the log (docs/pricing.md section 2).

export type Plan = "free" | "paid";

/** Default free allowance per space per UTC month. Must equal `free_events_per_month` in docs/pricing.md (a test checks). */
export const DEFAULT_FREE_EVENTS = 5000;

export function freeEvents(env: { WEFT_FREE_EVENTS?: string }): number {
  const n = Number(env.WEFT_FREE_EVENTS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FREE_EVENTS;
}

/** UTC calendar month, `YYYY-MM`. */
export function monthKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export type UsageState = {
  month: string;
  events: number;
  /** Events included per month before anything is billed (paid) or refused (free). */
  allowance: number;
  plan: Plan;
  /** True for a free space that has used its allowance. Only meaningful while billing is enabled. */
  over: boolean;
  /** Whether a Stripe customer is attached (a subscription exists or existed). Never the id itself. */
  has_billing_account: boolean;
};
