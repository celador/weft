// The edit-time budget (docs/languages.md): an edit check must cost < 300 ms. Tests measure the
// CPU time this process spends, not wall time: on a quiet machine the two are the same, and on
// a machine saturated by other work (parallel agents running their own test suites) wall time
// measures the scheduler, not the analyzer.

/** CPU milliseconds (user + system) `fn` takes. */
export async function cpuMs(fn: () => Promise<unknown>): Promise<number> {
  const start = process.cpuUsage();
  await fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/**
 * Fastest of `n` CPU measurements of a warm call. One run can include a GC pause or a JIT
 * deopt; slow CI runners turn that noise into a false budget failure (Swift: 318 ms once on
 * GitHub's runner, ~80 ms in component timings). Only for warm, repeatable calls.
 */
export async function fastestCpuMs(fn: () => Promise<unknown>, n = 3): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) best = Math.min(best, await cpuMs(fn));
  return best;
}

/** The documented budget, measured on a developer machine. */
export const EDIT_BUDGET_TARGET_MS = 300;

/**
 * Limit the budget tests assert. GitHub's shared runners have roughly half the single-core speed
 * of a developer laptop, and the fastest of 3 warm runs still landed at 315 ms there (Kotlin) while
 * the same check runs well under 300 ms locally. On CI the tests allow 2x the target so they catch
 * real regressions (an accidental O(n^2) or cold re-parse) without failing on runner speed.
 */
export const EDIT_BUDGET_MS = process.env.CI ? EDIT_BUDGET_TARGET_MS * 2 : EDIT_BUDGET_TARGET_MS;
