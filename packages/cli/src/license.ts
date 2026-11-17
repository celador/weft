// `weft license`: the Weft Commercial License on this machine (docs/commercial-license.md). Weft is free for personal
// use; work use needs a commercial license or Weft Pro, which includes one. Nothing here blocks anything.
//
//   weft license          signed in (`weft login`): the account's license, read from the hosted gateway. Otherwise the
//                         key recorded on this machine, if any. Local mode sends nothing.
//   weft license <KEY>    record a license key (made on weft.mx/account/) for a machine that never signs in, and check
//                         it with the hosted gateway once: the only call Weft makes for a license, and only when you run this.
//
// What is kept: ~/.config/weft/license.json (0600): the key and what the check answered. Nothing here prints the key.
import { join } from "node:path";
import { Api, statusOf } from "./api";
import { HOSTED_URL } from "./gateways";
import { currentOwner } from "./login";
import { c, configDir, info, ok, readJson, warn, WeftError, writeJson } from "./util";

/** What the gateway says a license covers (GET /v1/space `license`, POST /v1/license/verify). */
export type LicenseState = {
  active: boolean;
  included_in_pro: boolean;
  seats: number;
  lifetime_seats: number;
  year_seats: number;
  term: "lifetime" | "year" | "mixed" | null;
  valid_until: string | null;
  renews: boolean;
  key?: { hint: string; created_at: string } | null;
};

/** ~/.config/weft/license.json */
export type LocalLicense = { key?: string; hint?: string; source: "key" | "account"; checked_at: string; gateway: string; license: LicenseState | null };

export const LICENSE_HINT = "Free for personal use. Using Weft at work? weft.mx/pricing";
export const KEY_RE = /^weft_lic_[A-Za-z0-9_-]{32}$/;

const file = (env = process.env) => join(configDir(env), "license.json");
export const readLocalLicense = (env = process.env): LocalLicense | undefined => readJson<LocalLicense | undefined>(file(env), undefined);
const save = (l: LocalLicense, env = process.env) => writeJson(file(env), l, true);

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
const users = (n: number) => `${n} ${n === 1 ? "user" : "users"}`;

/** Whether a recorded license still covers this machine (a yearly one until its paid-through date). */
export function licensed(l: LocalLicense | undefined, now = Date.now()): boolean {
  const s = l?.license;
  if (!s?.active) return false;
  if (s.included_in_pro || s.lifetime_seats > 0) return true;
  return s.valid_until !== null && Date.parse(s.valid_until) > now;
}

/** The lines `weft license` prints for a license state. */
export function licenseLines(s: LicenseState | null): string[] {
  if (!s || (!s.active && !s.seats)) return [`${c.bold("license")}  none ${c.dim("(free for personal use; at work: a commercial license or Weft Pro, https://weft.mx/pricing/)")}`];
  if (!s.active) return [`${c.bold("license")}  ${c.yellow("ended")} ${c.dim("(renew on https://weft.mx/account/)")}`];
  const lines: string[] = [];
  if (s.included_in_pro) lines.push(`${c.bold("license")}  included in Weft Pro ${c.dim("(every Pro user is covered)")}`);
  if (s.lifetime_seats > 0) lines.push(`${c.bold("license")}  Commercial License, ${users(s.lifetime_seats)}, lifetime ${c.dim("(never renews, never ends)")}`);
  if (s.year_seats > 0)
    lines.push(`${c.bold("license")}  Commercial License, ${users(s.year_seats)}, yearly, ${s.valid_until ? `${s.renews ? "renews" : "ends"} ${day(s.valid_until)}` : "active"}`);
  return lines;
}

/** `weft license [KEY]`. `url` is the hosted gateway (or --url / WEFT_URL). */
export async function license(url: string, key: string | undefined, o: { root?: string; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const api = new Api(url, o.fetchImpl);
  if (key !== undefined) {
    key = key.trim();
    if (!KEY_RE.test(key)) throw new WeftError("that is not a Weft license key (it starts with weft_lic_)", "Make or copy one on https://weft.mx/account/ (License key).");
    let r: { license: LicenseState };
    try {
      r = await api.call<{ license: LicenseState }>("POST", "/v1/license/verify", undefined, { key });
    } catch (e) {
      if (statusOf(e) === 404) throw new WeftError("that license key is not valid (a newer key may have replaced it)", "Copy the current key from https://weft.mx/account/.");
      if ((e as { network?: boolean }).network) {
        save({ key, hint: key.slice(-4), source: "key", checked_at: new Date().toISOString(), gateway: url, license: null });
        warn(`could not reach ${new URL(url).host} to check the key; it is recorded on this machine unchecked. Run this again to check it.`);
        return;
      }
      throw e;
    }
    save({ key, hint: key.slice(-4), source: "key", checked_at: new Date().toISOString(), gateway: url, license: r.license });
    if (!r.license.active) {
      warn("the key is valid, but its license has ended");
      for (const l of licenseLines(r.license)) console.log(l);
      return;
    }
    ok(`license key recorded on this machine ${c.dim(`(…${key.slice(-4)})`)}`);
    for (const l of licenseLines(r.license)) console.log(l);
    return;
  }
  // No key given: the signed-in account's license, else what this machine has recorded.
  const owner = currentOwner(url, o.root);
  if (owner) {
    let r;
    try {
      r = await api.space(owner);
    } catch (e) {
      if (statusOf(e) !== 401) throw e;
      throw new WeftError(`this machine's key for ${new URL(url).host} no longer works`, "Run: npx @celador/weft login");
    }
    if (r.account && r.license !== undefined) {
      console.log(`${c.bold("account")}  ${r.account} ${c.dim("(https://weft.mx/account/)")}`);
      for (const l of licenseLines(r.license)) console.log(l);
      // Remember it, so setup does not mention licenses on a licensed machine (nothing else reads this).
      const prev = readLocalLicense();
      if (!prev || prev.source === "account") save({ source: "account", checked_at: new Date().toISOString(), gateway: url, license: r.license });
      return;
    }
  }
  const local = readLocalLicense();
  if (local?.license || local?.key) {
    console.log(`${c.bold("key")}      …${local.hint ?? "????"} ${c.dim(`(recorded ${day(local.checked_at)}${local.license ? "" : ", not checked yet"})`)}`);
    for (const l of licenseLines(local.license)) console.log(l);
    return;
  }
  for (const l of licenseLines(null)) console.log(l);
  info(`Signed in? npx @celador/weft login. A key from weft.mx/account/: npx @celador/weft license <key>`);
}

/**
 * The one line setup prints when this machine has no license and no Pro (and nothing else, ever: no blocking, no
 * repeats outside setup). Reads only the local file; `pro` is what the gateway this run already talks to said.
 */
export function licenseHint(pro: boolean, env = process.env): string | undefined {
  if (pro || licensed(readLocalLicense(env))) return undefined;
  return LICENSE_HINT;
}

export { HOSTED_URL };
