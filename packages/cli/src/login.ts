// `weft login`, `weft logout`, `weft whoami`: a Weft account (sign up free on weft.mx) for the hosted gateway.
//
// Device login: the CLI asks the gateway for a code, prints https://weft.mx/cli/?code=ABCD-EFGH (and opens it), the
// person signs in there and confirms the code, and the CLI's next poll gets an owner key for a space on that account.
// A hosted space this machine or repo already has (an anonymous one from before accounts) is sent along and joins
// the account instead; its key keeps working. Local mode never asks for an account and sends nothing. Nothing here
// prints a key.
import { Api, statusOf } from "./api";
import { HOSTED_URL, loadState, mintViewer, readPointer, saveState, type GatewayState } from "./gateways";
import { c, info, ok, openUrl, readSecret, WeftError } from "./util";
import { hostname } from "node:os";
import { join } from "node:path";

export type LoginResult = { space: string; attached: boolean; created: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The owner key this machine holds for `url`: this repo's (if it points there), else the one in cli.json. */
export function currentOwner(url: string, root?: string): string | undefined {
  if (root) {
    const p = readPointer(root);
    const t = p?.url === url ? readSecret(join(root, ".weft", "space-token")) : undefined;
    if (t) return t;
  }
  return loadState().gateways[url]?.owner;
}

export async function login(url: string, o: { open: boolean; root?: string; fetchImpl?: typeof fetch; pollMs?: number; quiet?: boolean }): Promise<LoginResult> {
  const api = new Api(url, o.fetchImpl);
  let start;
  try {
    start = await api.loginStart();
  } catch (e) {
    if (statusOf(e) === 404) throw new WeftError(`${url} has no accounts`, "Accounts are for the hosted gateway (weft.mx). Local and self-hosted Weft need none.");
    throw e;
  }
  console.log(`\nSign in to Weft (free) and confirm this code: ${c.bold(start.user_code)}\n\n  ${c.cyan(start.verification_url)}\n`);
  if (o.open) openUrl(start.verification_url);
  info(c.dim(`waiting for you to confirm (the code works for ${Math.round(start.expires_in / 60)} minutes)...`));
  const owner = currentOwner(url, o.root);
  const end = Date.now() + start.expires_in * 1000;
  const every = o.pollMs ?? Math.max(1, start.interval) * 1000;
  while (Date.now() < end) {
    await sleep(every);
    let r;
    try {
      r = await api.loginPoll(start.device_code, owner, `weft CLI on ${hostname().split(".")[0]}`);
    } catch (e) {
      const err = e as { status?: number; details?: { reason?: string } };
      if (err.status === 401) throw new WeftError("the login expired or was already used", "Run `npx @celador/weft login` again.");
      throw e;
    }
    if (r.type === "login.pending") continue;
    const state = loadState();
    const gw: GatewayState = state.gateways[url] ?? { kind: url === HOSTED_URL ? "hosted" : "own" };
    if (r.token) {
      gw.owner = r.token;
      delete gw.viewer;
      delete gw.viewerId;
    } else if (!gw.owner && owner) gw.owner = owner;
    gw.space = r.space;
    state.gateways[url] = gw;
    saveState(state);
    if (!gw.viewer) await mintViewer(api, url).catch(() => undefined);
    if (!o.quiet) {
      if (r.attached) ok(`signed in: your hosted space ${c.bold(r.space)} is now on your Weft account`);
      else ok(`signed in: ${r.created ? "created your hosted space" : "this machine now uses your space"} ${c.bold(r.space)}`);
    }
    return { space: r.space, attached: r.attached, created: r.created };
  }
  throw new WeftError("the code was not confirmed in time", "Run `npx @celador/weft login` again.");
}

/** `weft logout`: this machine forgets its owner key for `url` (revoked on the gateway when the space is on an account). */
export async function logout(url: string, root?: string): Promise<void> {
  const owner = currentOwner(url, root);
  const state = loadState();
  const gw = state.gateways[url];
  if (!owner || !gw) {
    info(`not signed in to ${url} on this machine`);
    return;
  }
  try {
    await new Api(url).logout(owner);
  } catch (e) {
    const err = e as { status?: number; details?: { reason?: string } };
    if (err.details?.reason === "anonymous")
      throw new WeftError("this space has no account, so its key is the only way back in: not logged out", "Run `npx @celador/weft login` first (it keeps the space); to delete it instead: npx @celador/weft uninstall --space");
    if (err.status !== 401) throw e;
  }
  delete gw.owner;
  delete gw.viewer;
  delete gw.viewerId;
  delete gw.space;
  saveState(state);
  ok(`logged out of ${new URL(url).host} on this machine ${c.dim("(repos set up here keep a copy of the old key in .weft/space-token; it no longer works. Sign in again: npx @celador/weft login)")}`);
}

/** `weft whoami`: the hosted space this machine uses, the account it belongs to (if any) and its plan. */
export async function whoami(url: string, root?: string): Promise<void> {
  const owner = currentOwner(url, root);
  if (!owner) {
    console.log(`not signed in to ${new URL(url).host} ${c.dim("(local Weft needs no account; hosted: npx @celador/weft login)")}`);
    return;
  }
  let r;
  try {
    r = await new Api(url).space(owner);
  } catch (e) {
    if ((e as { status?: number }).status !== 401) throw e;
    throw new WeftError(`this machine's key for ${new URL(url).host} no longer works (logged out, or the space or account was deleted)`, "Run: npx @celador/weft login");
  }
  const plan = r.usage ? (r.usage.plan === "paid" && typeof r.usage.seats === "number" ? `Weft Pro, ${r.usage.seats} ${r.usage.seats === 1 ? "seat" : "seats"}` : r.usage.plan === "paid" ? "paid" : "Free") : "-";
  console.log(`${c.bold("gateway")}  ${url}`);
  console.log(`${c.bold("space")}    ${r.space.id}`);
  console.log(`${c.bold("account")}  ${r.account ? `${r.account} ${c.dim("(manage it on https://weft.mx/account/)")}` : r.accounts ? c.yellow("none: run npx @celador/weft login to put this space on your account") : c.dim("this gateway has no accounts")}`);
  console.log(`${c.bold("plan")}     ${plan}`);
}

/** Run `fn`; if the gateway says a login is required first, sign in (keeping this repo's space) and run it once more. */
export async function withLogin<T>(url: string, o: { open: boolean; root?: string }, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { details?: { reason?: string } }).details?.reason !== "login_required") throw e;
    info("This needs a Weft account (free). Sign in once, and your space joins it.");
    await login(url, o);
    return fn();
  }
}
