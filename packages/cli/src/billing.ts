// `weft usage`, `weft upgrade`, `weft billing`, `--claim`: the hosted space's plan and usage, and the Stripe pages
// (Checkout, Customer Portal). Hosted plans (docs/pricing.md): Free (a monthly allowance of agent events per space)
// and Weft Pro (per user, monthly or yearly, no event cut-off). Local and self-hosted Weft are free. Nothing here
// prints a key.
import { Api, type SpaceUsage } from "./api";
import { c, openUrl, WeftError } from "./util";

const n = (x: number) => x.toLocaleString("en-US");
const per = (i: string | null | undefined) => (i === "year" ? "billed yearly" : "billed monthly");
const seatsText = (s: number) => `${s} ${s === 1 ? "seat" : "seats"}`;

/** The lines `weft usage` prints. */
export function usageLines(space: string, url: string, u: SpaceUsage | undefined, billingEnabled: boolean | undefined): string[] {
  const head = `${c.bold("space")}   ${space} ${c.dim(`(${url})`)}`;
  if (!u) return [head, c.dim("this gateway does not report usage")];
  const pro = u.plan === "paid" && typeof u.seats === "number";
  if (pro) {
    const lines = [head, `${c.bold("plan")}    Weft Pro, ${seatsText(u.seats!)} ${c.dim(`(${per(u.interval)}; change seats or cancel: npx @celador/weft billing)`)}`];
    lines.push(`${c.bold(u.month)}  ${n(u.events)} events ${c.dim("(no event cut-off on Pro)")}`);
    if (u.over_fair_use && u.fair_use_events) lines.push(c.yellow(`above fair use this month (${n(u.fair_use_events)} = ${u.seats} x ${n(u.fair_use_events / u.seats!)} events): nothing is cut off; we may get in touch`));
    return lines;
  }
  if (u.plan === "paid") {
    // A subscription from before Weft Pro (the usage-based plan): events above the allowance are billed.
    const over = Math.max(0, u.events - u.allowance);
    return [
      head,
      `${c.bold("plan")}    paid ${c.dim("(the earlier usage-based plan)")}`,
      `${c.bold(u.month)}  ${n(u.events)} events (${n(Math.min(u.events, u.allowance))} of ${n(u.allowance)} included${over ? `, ${c.yellow(n(over))} billed this month` : ""})`,
    ];
  }
  const pct = u.allowance > 0 ? Math.min(100, Math.round((100 * u.events) / u.allowance)) : 100;
  const lines = [head, `${c.bold("plan")}    free`, `${c.bold(u.month)}  ${n(u.events)} of ${n(u.allowance)} free events (${pct}%)`];
  if (billingEnabled === false) lines.push(c.dim("nothing is limited or charged on this gateway"));
  else if (u.events >= u.allowance) lines.push(`${c.red("free allowance used up")}: your agents keep working, uncoordinated. Run ${c.bold("npx @celador/weft upgrade")} for Weft Pro to keep coordinating.`);
  else if (billingEnabled) lines.push(c.dim("no event cap, per user: npx @celador/weft upgrade (Weft Pro)"));
  return lines;
}

const notSold = (url: string) =>
  new WeftError(`${url} does not sell a plan (billing is off there)`, "Local and self-hosted Weft are free with no limits from us. Only the hosted gateway sells Weft Pro.");

async function viaBilling<T>(url: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const err = e as { status?: number; code?: string };
    if (err.status === 503 && err.code === "unavailable" && /billing is not enabled/.test((e as Error).message)) throw notSold(url);
    if (err.status === 404) throw notSold(url); // a gateway from before billing existed
    throw e;
  }
}

export async function usage(url: string, owner: string, space: string): Promise<void> {
  const r = await new Api(url).space(owner);
  for (const l of usageLines(space, url, r.usage, r.billing?.enabled)) console.log(l);
}

export type ProChoice = { seats: number; interval: "month" | "year" };

export async function upgrade(url: string, owner: string, open: boolean, choice: ProChoice): Promise<void> {
  const api = new Api(url);
  const r = await viaBilling(url, () => api.checkout(owner, choice));
  console.log(`Open this page to buy Weft Pro for ${seatsText(choice.seats)}, ${per(choice.interval)} (Stripe Checkout; you can change the number of seats there):\n\n  ${c.cyan(r.url)}\n`);
  console.log(c.dim("When you are done, the plan switches within a few seconds: npx @celador/weft usage"));
  if (open) openUrl(r.url);
}

export async function billing(url: string, owner: string, open: boolean): Promise<void> {
  const api = new Api(url);
  const r = await viaBilling(url, () => api.portal(owner));
  console.log(`Manage your plan, seats, payment method and invoices (Stripe):\n\n  ${c.cyan(r.url)}\n`);
  if (open) openUrl(r.url);
}

/** `--claim <code>`: bind a purchase made on weft.mx (the welcome page shows the code) to this space. */
export async function claim(api: Api, url: string, owner: string, code: string): Promise<{ seats: number; interval: "month" | "year" }> {
  try {
    const r = await viaBilling(url, () => api.claim(owner, code));
    return { seats: r.seats, interval: r.interval };
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 401) throw new WeftError("that claim code is not valid or has expired", "Open the welcome page from your receipt again (or reload it) for a new code; each code works once, for an hour.");
    throw e;
  }
}

/** A claim code as the user may have typed it: case and separators do not matter, but it must look like one. */
export function looksLikeClaimCode(s: string): boolean {
  return /^[2-9A-HJKMNP-Z]{12}$/.test(s.toUpperCase().replace(/[^A-Z0-9]/g, ""));
}
