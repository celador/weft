// Reading checkout files safely. The adapter reads a file's text to analyze an edit and
// may put it into a diff on the shared log, so a read must never escape the checkout:
//   - no symlink anywhere on the path (the final file is opened with O_NOFOLLOW, and the
//     real path of the file must be exactly <real checkout root>/<rel>, which fails if any
//     directory on the way is a symlink);
//   - only regular files, at most `maxBytes`.
// Anything else reads as "no text" (null): the edit is then not coordinated, which is the
// adapter's normal fail-open behaviour for files it cannot see.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, resolve, sep } from "node:path";

const realRoots = new Map<string, string>();

function realRoot(root: string): string | undefined {
  const hit = realRoots.get(root);
  if (hit) return hit;
  try {
    const r = realpathSync(root);
    realRoots.set(root, r);
    return r;
  } catch {
    return undefined;
  }
}

/** Text of `abs` if it is a regular, non-symlinked file inside `root`; otherwise null. */
export function readInsideCheckout(root: string, abs: string, maxBytes: number): string | null {
  const full = resolve(abs);
  const rel = relative(resolve(root), full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const rr = realRoot(resolve(root));
  if (!rr) return null;
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return null; // missing, or a dangling link
  }
  if (real !== join(rr, rel.split("/").join(sep))) return null; // some component is a symlink
  let fd: number | undefined;
  try {
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
