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

export const EDIT_BUDGET_MS = 300;
