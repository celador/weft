// `weft claim` (adapter CLI): an agent asks for an explicit claim on symbols before it
// starts (spec §7.5). Shared by every adapter CLI so the grammar and the checks are the same
// everywhere. The coordinator treats keys as opaque strings, so the strictness lives here:
// a key the analyzer could never produce (absolute path, `..`, whitespace, a non-identifier
// name) is refused before it reaches the log.

import type { ClaimsPolicy, SymbolKey } from "./types";

export type ClaimCommand = { keys: SymbolKey[]; firm: boolean; ttl_ms?: number };

export const CLAIM_USAGE = [
  "weft claim --keys path#symbol[,path#symbol…] [--firm] [--ttl MS]",
  "  path    repo-relative POSIX path as it appears in Weft diagnostics (no leading /, no . or .. segments)",
  "  symbol  dotted declaration name (SessionStore.get) or * for the whole file",
  "  --firm  a firm claim: others' overlapping edits are refused until it expires or you release it",
  "  --ttl   firm claims only: how long, in ms; at most the repo's firm limit (default 10 min)",
].join("\n");

const MAX_KEY = 1024;
const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Why `key` is not an acceptable claim key, or undefined when it is. */
export function claimKeyError(key: string): string | undefined {
  if (key.length > MAX_KEY) return `key longer than ${MAX_KEY} characters`;
  // Control characters (incl. NUL) are never part of a path or name.
  if ([...key].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "control character in key";
  const hash = key.indexOf("#");
  if (hash <= 0 || hash !== key.lastIndexOf("#") || hash === key.length - 1) return "a key is path#symbol (exactly one #, both sides non-empty)";
  const path = key.slice(0, hash);
  const name = key.slice(hash + 1);
  if (/\s/.test(key)) return "whitespace in key";
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) return "path must be repo-relative, not absolute";
  if (path.includes("\\")) return "path must use / separators";
  const segs = path.split("/");
  if (segs.some((s) => s === "")) return "empty path segment (//, or a trailing /)";
  if (segs.some((s) => s === "..")) return "'..' is not allowed in a path";
  if (segs.some((s) => s === ".")) return "'.' segments are not allowed in a path";
  if (name !== "*" && !name.split(".").every((p) => IDENT.test(p))) return "symbol must be a dotted declaration name (e.g. SessionStore.get) or *";
  return undefined;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Parse `weft claim …` arguments. Throws Error with a user-facing message. */
export function parseClaim(args: string[]): ClaimCommand {
  const known = new Set(["--keys", "--firm", "--ttl"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!known.has(a)) throw new Error(`unexpected argument ${JSON.stringify(a)}\n${CLAIM_USAGE}`);
    if (a !== "--firm") i++;
  }
  const raw = flag(args, "keys");
  if (raw === undefined || raw.startsWith("--")) throw new Error(`--keys is required\n${CLAIM_USAGE}`);
  const keys = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  if (!keys.length) throw new Error(`--keys is empty\n${CLAIM_USAGE}`);
  for (const k of keys) {
    const err = claimKeyError(k);
    if (err) throw new Error(`invalid key ${JSON.stringify(k)}: ${err}`);
  }
  const firm = args.includes("--firm");
  const ttlRaw = flag(args, "ttl");
  if (ttlRaw === undefined) return { keys, firm };
  if (!firm) throw new Error("--ttl applies to firm claims only (a soft claim is a lease renewed while you work)");
  if (!/^\d+$/.test(ttlRaw)) throw new Error(`--ttl must be a whole number of milliseconds, got ${JSON.stringify(ttlRaw)}`);
  const ttl = Number(ttlRaw);
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new Error(`--ttl must be at least 1 ms`);
  return { keys, firm, ttl_ms: ttl };
}

/**
 * Upper bound for `--ttl` from what the coordinator announced (welcome): the firm limit
 * under the claims policy, else (repos created before it) the claim TTL.
 */
export function maxClaimTtl(w: { claim_ttl_ms: number; policy: { claims?: ClaimsPolicy } }): number {
  return w.policy.claims?.firm_max_ms ?? w.claim_ttl_ms;
}
