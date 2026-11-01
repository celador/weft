// `weft usage`, `weft upgrade`, `weft billing`: the hosted space's usage against its free monthly
// allowance, and the two Stripe pages (Checkout, Customer Portal). Pricing is usage-based, never per
// seat or per developer (docs/pricing.md). Nothing here prints a key.
import { Api, type SpaceUsage } from "./api";
import { c, openUrl, WeftError } from "./util";

const n = (x: number) => x.toLocaleString("en-US");

/** The lines `weft usage` prints. */
export function usageLines(space: string, url: string, u: SpaceUsage | undefined, billingEnabled: boolean | undefined): string[] {
  const head = `${c.bold("space")}   ${space} ${c.dim(`(${url})`)}`;
  if (!u) return [head, c.dim("this gateway does not report usage")];
  const lines = [head, `${c.bold("plan")}    ${u.plan}${u.plan === "paid" ? c.dim(" (usage-based: you pay only for events above the monthly allowance)") : ""}`];
  const pct = u.allowance > 0 ? Math.min(100, Math.round((100 * u.events) / u.allowance)) : 100;
  if (u.plan === "paid") {
    const over = Math.max(0, u.events - u.allowance);
    lines.push(`${c.bold(u.month)}  ${n(u.events)} events (${n(Math.min(u.events, u.allowance))} of ${n(u.allowance)} included${over ? `, ${c.yellow(n(over))} billed this month` : ""})`);
  } else {
    lines.push(`${c.bold(u.month)}  ${n(u.events)} of ${n(u.allowance)} free events (${pct}%)`);
    if (billingEnabled === false) lines.push(c.dim("nothing is limited or charged on this gateway"));
    else if (u.events >= u.allowance) lines.push(`${c.red("free allowance used up")}: your agents keep working, uncoordinated. Run ${c.bold("npx @celador/weft upgrade")} to keep coordinating.`);
    else if (billingEnabled) lines.push(c.dim("past the allowance: npx @celador/weft upgrade (usage-based, no seats)"));
  }
  return lines;
}

const notSold = (url: string) =>
  new WeftError(`${url} does not sell a plan (billing is off there)`, "Local and self-hosted Weft are free with no limits from us. Only the hosted gateway has usage-based billing.");

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

export async function upgrade(url: string, owner: string, open: boolean): Promise<void> {
  const api = new Api(url);
  const r = await viaBilling(url, () => api.checkout(owner));
  console.log(`Open this page to choose the usage-based plan (Stripe Checkout; no seats, you pay only above the free allowance):\n\n  ${c.cyan(r.url)}\n`);
  console.log(c.dim("When you are done, the plan switches within a few seconds: npx @celador/weft usage"));
  if (open) openUrl(r.url);
}

export async function billing(url: string, owner: string, open: boolean): Promise<void> {
  const api = new Api(url);
  const r = await viaBilling(url, () => api.portal(owner));
  console.log(`Manage your plan, payment method and invoices (Stripe):\n\n  ${c.cyan(r.url)}\n`);
  if (open) openUrl(r.url);
}
