// The hosted gateway's admin key, for the funnel and the operator scripts. Never printed.
// It lives in the macOS keychain (service `weft-hosted-admin`, account `john`), not in a file that
// any process running as this user could read (security finding #8). On a machine without a
// keychain, $WEFT_HOSTED_ADMIN_TOKEN serves. Nothing here ever writes the key anywhere.
import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "weft-hosted-admin";
export const TOKEN_ENV = "WEFT_HOSTED_ADMIN_TOKEN";
export const TOKEN_HELP = `no hosted admin key in the macOS keychain (service ${KEYCHAIN_SERVICE}, account john) or in $${TOKEN_ENV}`;

const keychain = (platform) => {
  if (platform !== "darwin") return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).toString().trim() || null;
  } catch { return null; }
};

/** { token, source } from the keychain, else $WEFT_HOSTED_ADMIN_TOKEN; null when neither has it. Readers are injectable for tests. */
export function readHostedAdminToken({ platform = process.platform, fromKeychain = keychain, env = process.env } = {}) {
  const k = fromKeychain(platform);
  if (k) return { token: k, source: `keychain ${KEYCHAIN_SERVICE}` };
  const e = env[TOKEN_ENV]?.trim();
  if (e) return { token: e, source: `$${TOKEN_ENV}` };
  return null;
}
