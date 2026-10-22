# reroute rerun with the use-first contract gate (t_513b15c6)

Same run as [`../reroute-field-rename/`](../reroute-field-rename/) (agy 1.4.5 as agy-b, Claude Code
2.1.309 as claude-a, local gateway), on wt/t_513b15c6 (main 0824646 + the WCP §6.3 step 6 change).
Command: `WEFT_URL=http://localhost:8812 node demo/antigravity-live.mjs reroute` (output moved
here from `../reroute/`, which is unchanged).

| | before (../reroute-field-rename) | after (this dir) |
|---|---|---|
| agy-b's accepted use of calcTotal | #8 | #8 |
| claude-a renames `PriceOptions.taxRate` → `rate` | #10 writes `calcTotal: signature` | #10 writes `calcTotal: signature` |
| what #10 does to agy-b's change | pushes a `contract_changed` **warning**; no gate closes | opens a `stale_assumption` **error** on agy-b's change (origin `contract`) and pushes it: `[weft error] stale_assumption src/pricing.ts:4:17: claude-a changed the signature of src/pricing.ts#calcTotal (#10) after your change started using it; your call sites may no longer match.` Suggestion: "… the commit gate stays closed until an edit of yours that uses src/pricing.ts#calcTotal is accepted." (hooks-b.jsonl line 14, b3-status.json via PreInvocation injectSteps) |
| agy-b's code | adapted at #15: `calcTotal(this.items, { rate: 0 })` | adapted at #15: `calcTotal(this.items, { rate: 0 })`; #15 is an accepted edit that reads calcTotal, which clears the error (§6.5 rule 1) |
| commits / main | both commit, `tsc: exit 0` | both commit (the pre-commit gate passes after #15), `tsc: exit 0 (clean)` (landing.txt) |

agy-b adapted in both runs, so the end state is the same. The difference is what happens if it had
not: before, both commits would have passed their gates and main would fail tsc; now agy-b's commit
gate refuses until it redoes the call site, the same as in the change-first order (R2
`stale_assumption`, which this run also shows at #7). The gate's refusal between #10 and #15 was
not probed in this live run, because agy-b fixed the call before committing. Unit and conformance
tests cover it: `contract-change-after-use`, sequencer `conflicts.test.ts`, claude-code
`adapter.test.ts`, gateway `observer.test.ts`/`sequencer.test.ts`.
