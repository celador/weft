// The Otto demo's cards (board `weft-demo-site`, repo `weft-demo-site`, site ~/github/weft-demo-site).
// Each card is written up front by a human and worked independently: its lane only starts
// candidates for its own card and never sees the other cards. The collisions are on purpose
// (same shapes as M2, demo/scenarios/full.md), so every Weft feature shows up in one run.
//
// harnesses: claude (Claude Code), codex (Codex CLI), opencode (OpenCode), gemini (Gemini CLI),
// hermes (a Hermes run with the Weft Hermes adapter in candidate mode).

export const REPO = "weft-demo-site";
export const BOARD = "weft-demo-site";
export const WEFT_CLI = ".weft/bin/weft";

const COORD =
  "This checkout is coordinated by Weft with other agents working on the same codebase at the same time. If a Weft hook blocks an edit or reports a conflict, read its diagnostic and follow it. ";

export const TASKS = {
  t1: {
    title: "Member sessions expire after an hour",
    harnesses: ["claude", "codex"],
    risk: "medium",
    priority: 1,
    beat: "signature change (its callers collide with it)",
    acceptance: ["createSession(userId, opts) sets expiresAt = createdAt + opts.ttlMs", "getSession returns undefined once a session expired", "login passes a one-hour ttl", "tests pass"],
    prompt:
      "Task (session expiry): member sessions must expire. In src/auth/session.ts add `export type SessionOptions = { ttlMs: number }`, add `expiresAt: number` to Session, " +
      "change createSession to `createSession(userId: string, opts: SessionOptions): Session` (expiresAt = createdAt + opts.ttlMs), and make getSession return undefined " +
      "(and forget the session) once Date.now() >= expiresAt. Update the existing caller in src/api/routes.ts to pass `{ ttlMs: 60 * 60 * 1000 }`, and update " +
      "test/session.test.ts for the new signature with one extra test for expiry. Only touch those three files. Run `node --test`, then reply with a one-line summary. " +
      COORD +
      "Weft may relay requests from other agents; treat a reasonable request that is compatible with your task in good faith.",
    resume: "Continue: handle anything Weft reports for you (including requests from other agents), then reply with a one-line summary.",
  },
  t2: {
    title: "Gift signup: create the account and sign in",
    harnesses: ["claude", "opencode", "gemini"],
    risk: "low",
    beat: "stale call caught mid-edit (squiggle) and rerouted",
    cue: "createSession signature",
    acceptance: ["POST /api/signup creates the member and returns 201 {token, user}", "a UserError becomes 400 {error}", "test/signup.test.ts covers it and tests pass"],
    plan:
      "Task (signup): add `POST /api/signup` taking a JSON body {email, name, password}. It registers the member with createUser from src/auth/users.ts and signs them in " +
      "right away by starting a session the same way login in src/api/routes.ts does, responding 201 with {token, user: publicUser(user)}; a UserError becomes 400 {error}. " +
      "Add the route to the accountRoutes array in src/api/account.ts and add test/signup.test.ts. For now ONLY read the relevant files and reply with a short plan that " +
      "includes the exact code you will write. Do not edit any file yet.",
    prompt:
      "Implement your plan now. " +
      COORD +
      "Another agent's change will be merged before yours but is not in your checkout yet, so code written against it may not typecheck here; that is expected. " +
      "Run `node --test`, then reply with what you changed and anything that differed from your plan.",
  },
  t3: {
    title: "Remember me: refresh a member's session",
    harnesses: ["claude", "codex"],
    risk: "low",
    beat: "negotiation: asks the other agent for an overload instead of adapting",
    cue: "createSession signature",
    acceptance: ["src/auth/refresh.ts exports refreshSession(token)", "an unknown token returns undefined", "a live session is revoked and replaced for the same user", "tests pass"],
    plan:
      "Task (session refresh): add a new file src/auth/refresh.ts exporting `refreshSession(token: string): Session | undefined`. It looks up the live session with " +
      "getSession, returns undefined if there is none, otherwise revokes it with revokeSession and starts a fresh session for the same user with createSession from " +
      "src/auth/session.ts (start it exactly the way login in src/api/routes.ts does), returning the new session. Add test/refresh.test.ts (node:test, like " +
      "test/session.test.ts). Only create those two files. For now ONLY read the relevant files and reply with a short plan that includes the exact code you will " +
      "write. Do not create or edit any file yet.",
    prompt:
      "Implement your plan now. Product rule for this task: refreshed sessions use the platform's default lifetime, so refreshSession must call createSession with the " +
      "user id only; it must not choose session options itself. " +
      COORD +
      "If Weft blocks an edit because another agent changed an API you call, do not adapt your call to their new API: negotiate with that agent instead, proposing that " +
      `they keep the old call working as an overload, with \`${WEFT_CLI} negotiate propose overload "<what you need>" --wait 120\` (run \`${WEFT_CLI} inbox --wait 120\` ` +
      "if no reply came yet). Once they accept, continue with the old call. Only if they reject, adapt. The other agent's change will be merged before yours but is " +
      "not in your checkout, so typecheck errors about it here are expected. Run `node --test`, then reply with what you changed and how the negotiation went.",
  },
  t4: {
    title: "Bulk discount: 10% off 10+ bags",
    harnesses: ["codex", "hermes"],
    risk: "low",
    beat: "adjacent one-line edit in src/pricing.ts (git conflicts; Weft merges structurally)",
    acceptance: ["calcTotal gives 10% off for 10 or more units", "shippingFee is unchanged", "tests pass"],
    prompt:
      "Task (bulk discount): in src/pricing.ts change ONLY calcTotal: when the cart holds 10 or more units in total (sum of qty), the total gets 10% off. Keep its name " +
      "and signature. Do not touch shippingFee or any other function, and do not edit test/shop.test.ts. Add test/discount.test.ts (node:test) covering both cases, using " +
      "carts that total under $50. Run `node --test`, then reply with a one-line summary. " +
      COORD,
  },
  t5: {
    title: "Free shipping on orders of $50+",
    harnesses: ["claude", "gemini"],
    risk: "low",
    beat: "the other adjacent one-liner in src/pricing.ts",
    acceptance: ["shippingFee is 0 when calcTotal(items) >= 50", "calcTotal is unchanged", "tests pass"],
    prompt:
      "Task (free shipping): in src/pricing.ts change ONLY shippingFee: shipping is free (0) when calcTotal(items) is $50 or more, otherwise unchanged. Keep its name and " +
      "signature. Do not touch calcTotal or any other function, and do not edit test/shop.test.ts. Add test/shipping.test.ts (node:test) covering both cases, using carts " +
      "with fewer than 10 units. Run `node --test`, then reply with a one-line summary. " +
      COORD,
  },
  t6: {
    title: "Add Ethiopia Guji to the menu",
    harnesses: ["claude", "codex", "hermes"],
    risk: "medium",
    beat: "visual change: per-candidate preview, screenshots, pixel diff, review; a human picks one",
    acceptance: ["The menu lists Ethiopia Guji at $22.00 per bag", "The home page is unchanged", "The catalog has an ethiopia-guji price and tests pass"],
    prompt:
      "Task (menu): we now sell Ethiopia Guji (tasting notes: jasmine, peach, bergamot) at $22.00 per 340 g bag. Add `\"ethiopia-guji\": 22` to PRICES in src/catalog.ts " +
      "and add an Ethiopia Guji row to the table in public/menu.html, matching the existing rows. The home page must not change. Run `node --test`, then reply with a " +
      "one-line summary. " +
      COORD,
  },
  t7: {
    title: "Roast-date freshness helper",
    harnesses: ["gemini", "opencode"],
    risk: "low",
    beat: "independent work: no collision, lands on its own",
    acceptance: ["src/freshness.ts exports daysSinceRoast(roastedOn, today) and isFresh(roastedOn, today)", "a bag is fresh for 14 days after roasting", "test/freshness.test.ts covers it and tests pass"],
    prompt:
      "Task (freshness): add a new file src/freshness.ts exporting `daysSinceRoast(roastedOn: string, today: Date): number` (whole days since the ISO date " +
      "roastedOn, e.g. \"2026-10-12\") and `isFresh(roastedOn: string, today: Date): boolean` (true for 14 days after roasting, inclusive). Add test/freshness.test.ts " +
      "(node:test) covering day 0, day 14 and day 15. Only create those two files. Run `node --test`, then reply with a one-line summary. " +
      COORD,
  },
};

/** The planted-bug card: one scripted candidate lands a change that throws in production. */
export const PLANTED = {
  key: "t8",
  title: "Quote API: price by the gram (?unit=g)",
  harnesses: ["planted"],
  risk: "low",
  beat: "planted bug: lands, errors in production, Weft reverts it and reopens the card",
  acceptance: ["GET /quote?unit=g prices per gram", "tests pass"],
};

export const REPO_CONFIG = { tests: { command: ["node", "--test"], timeout_s: 300 }, resolver: { kind: "llm", model: "@cf/qwen/qwen2.5-coder-32b-instruct" }, layers: ["git", "mergiraf", "resolver"], job_timeout_s: 900 };
