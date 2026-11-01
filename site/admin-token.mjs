// The hosted gateway's admin key, for the funnel and the operator scripts. Never printed.
// Order: macOS keychain item `weft-hosted-admin` (where the key moves to), then the old file
// ~/.config/weft/hosted-admin-token, so either order of rollout works.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const KEYCHAIN_SERVICE = "weft-hosted-admin";
export const TOKEN_FILE = `${homedir()}/.config/weft/hosted-admin-token`;
export const TOKEN_HELP = `no hosted admin key in the macOS keychain (service ${KEYCHAIN_SERVICE}) or at ~/.config/weft/hosted-admin-token`;

const keychain = (platform) => {
  if (platform !== "darwin") return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).toString().trim() || null;
  } catch { return null; }
};
const file = (path) => {
  try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
};

/** { token, source } from the keychain, else the file; null when neither has it. Readers are injectable for tests. */
export function readHostedAdminToken({ platform = process.platform, fromKeychain = keychain, fromFile = file, path = TOKEN_FILE } = {}) {
  const k = fromKeychain(platform);
  if (k) return { token: k, source: `keychain ${KEYCHAIN_SERVICE}` };
  const f = fromFile(path);
  if (f) return { token: f, source: "~/.config/weft/hosted-admin-token" };
  return null;
}
