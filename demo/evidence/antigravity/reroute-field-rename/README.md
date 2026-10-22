# reroute rerun after the field-rename fix (t_8a058cc8)

Same run as [`../reroute/`](../reroute/) (agy 1.4.5 as agy-b, Claude Code 2.1.309 as claude-a,
local gateway), on wt/t_7a3391a8 (58f9273) merged with main plus commit 36601ab of wt/t_8a058cc8.
Command: `WEFT_URL=http://localhost:8811 node demo/antigravity-live.mjs reroute`.

| | before (../reroute) | after (this dir) |
|---|---|---|
| claude-a renames `PriceOptions.taxRate` → `rate` | #10 writes `PriceOptions: signature`, `calcTotal: body` | #10 writes `PriceOptions: signature`, **`calcTotal: signature`** |
| queued for agy-b (already uses calcTotal, #8) | nothing | `[weft warning] contract_changed src/pricing.ts:4:17: claude-a changed the signature of src/pricing.ts#calcTotal (#10), which your change uses.` delivered by PreInvocation injectSteps (b3-status.json, hooks-b.jsonl) |
| agy-b's code | `calcTotal(this.items, { taxRate: 0 })` | adapted, #15: `calcTotal(this.items, { rate: 0 })` |
| main after merging both | `tsc: exit 2`, TS2353 'taxRate' | `tsc: exit 0 (clean)` (landing.txt) |

The analyzer now treats a declaration's contract as including the types its signature names:
a signature change or deletion of `PriceOptions` makes `calcTotal(opts: PriceOptions)` a
signature write too (transitive within the file; locals inside bodies excluded). Adapters also
read the contract types of what they call (`contractReads`), so a type in a third file still
reaches the caller (claude-a's #4/#12 reads now list `src/pricing.ts#PriceOptions`). agy-b's
reads do not, because its checkout's pricing.ts still had the old calcTotal; the writer-side
rule covered it.

What it does not do: agy-b's call was already accepted (#8) when the rename landed (#10), so per
WCP §6.3 it got a `contract_changed` **warning**, which closes no gate (wcp-v0.md, "Under
`continue` … the `contract_changed` warning, which closes no gate"). agy-b adapted because the
warning reached it. A gate-closing error for this ordering would be a protocol change; it is
filed as a separate card.
