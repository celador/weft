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

export const EDIT_BUDGET_MS = 300;
