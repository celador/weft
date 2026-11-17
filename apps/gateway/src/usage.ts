// Usage metering vocabulary shared by the Registry (which stores it) and the gateway (which
// enforces and shows it). The meter is "agent events": an agent submit whose verdict carries a
// `seq`, i.e. an event that entered the log (docs/pricing.md).
//
// Plans: `free` (a monthly allowance of events, then 429 over_allowance) and `paid`. A paid space is
// Weft Pro (per user: `seats` and a billing `interval`) or, for subscriptions made before Pro existed,
// the legacy usage-based plan (no seats; overage reported to a Stripe meter).

export type Plan = "free" | "paid";
export type Interval = "month" | "year";

/** Default free allowance per space per UTC month. Must equal `free_events_per_month` in docs/pricing.md (a test checks). */
export const DEFAULT_FREE_EVENTS = 5000;
/**
 * Pro fair use: events per seat per UTC month. Passing it cuts nothing off; the month is flagged for the operator
 * (`GET /v1/admin/spaces`). Must equal `pro.fair_use_events_per_seat_month` in docs/pricing.md (a test checks).
 */
export const DEFAULT_FAIR_USE_PER_SEAT = 50_000;
/** Most seats one Pro subscription can have. Must equal `pro.max_seats` in docs/pricing.md (a test checks). */
export const MAX_SEATS = 500;

export function freeEvents(env: { WEFT_FREE_EVENTS?: string }): number {
  const n = Number(env.WEFT_FREE_EVENTS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FREE_EVENTS;
}

export function fairUsePerSeat(env: { WEFT_PRO_FAIR_USE_EVENTS?: string }): number {
  const n = Number(env.WEFT_PRO_FAIR_USE_EVENTS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FAIR_USE_PER_SEAT;
}

/** A seat count from a request: an integer 1..MAX_SEATS, or undefined. */
export function parseSeats(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_SEATS ? n : undefined;
}

export const isInterval = (v: unknown): v is Interval => v === "month" || v === "year";

/** UTC calendar month, `YYYY-MM`. */
export function monthKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export type UsageState = {
  month: string;
  events: number;
  /** Events included per month before anything is refused (free) or billed (legacy usage plan). */
  allowance: number;
  plan: Plan;
  /** True for a free space that has used its allowance. Only meaningful while billing is enabled. */
  over: boolean;
  /** Whether a Stripe customer is attached (a subscription exists or existed). Never the id itself. */
  has_billing_account: boolean;
  /** Weft Pro: the seats paid for (null on the free plan and on the legacy usage plan). */
  seats: number | null;
  /** Weft Pro: how the seats are billed. */
  interval: Interval | null;
  /** Weft Pro: fair-use events this month (seats x per-seat fair use); null when not Pro. Not a limit. */
  fair_use_events: number | null;
  /** Weft Pro: more events this month than fair use. Nothing is cut off; the operator sees it. */
  over_fair_use: boolean;
};
