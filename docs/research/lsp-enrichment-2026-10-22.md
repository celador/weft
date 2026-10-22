# LSP enrichment, end to end (2026-10-22)

Card t_082661b7. Two Claude Code adapters (hooks driven with Claude Code's JSON, no model) on a
small Python repo in two git worktrees, a local gateway (`pnpm dev:local --port 8833`, built
from branch `wt/t_082661b7`, so the sequencer has WCP §6.2 R2a) and pyright 1.1.388
(`pyright-langserver` on PATH). Script: [`scripts/lsp-e2e.mjs`](../../scripts/lsp-e2e.mjs).
Raw evidence: [demo/evidence/lsp/](../../demo/evidence/lsp/).

## Repo

```
shop/__init__.py   from .pricing import Pricer, calc_total   (a re-export)
shop/pricing.py    class Pricer: quote(self, amount); calc_total(prices)
shop/cart.py       from shop import calc_total; class Cart: self.pricer = Pricer()
```

## What tree-sitter sees, and what it misses

agent-b edits `Cart.total` to `return self.pricer.quote(calc_total(self.prices))`. The
edit-time analysis (tree-sitter) keys the `calc_total` read to the module it was imported from,
`shop/__init__.py`, where it is only re-exported, and cannot follow `self.pricer` to `Pricer`:

```
#3 accepted edit agent-b reads=["shop/__init__.py#calc_total","shop/pricing.py#Pricer"]
                         writes=[["shop/cart.py#Cart","body"],["shop/cart.py#Cart.total","body"]]
```

agent-a then changes `calc_total`'s signature:

```
#4 accepted edit agent-a writes=[["shop/pricing.py#calc_total","signature"]]
```

Negative control (`--no-lsp`, `WEFT_LSP=off` for every hook): agent-b hears nothing about #4
([no-lsp.txt](../../demo/evidence/lsp/no-lsp.txt)): `(nothing)`.

## With pyright

The daemon (`lsp-daemon`, started by agent-b's `PostToolUse`) asked pyright for definitions of
the identifiers in the changed line and submitted a reads amendment:

```
lsp enrich #3 (pyright, 738 ms): 3 reads, 3 new [shop/cart.py#Cart.__init__, shop/pricing.py#Pricer.quote, shop/pricing.py#calc_total]
lsp amendment for #3 -> accept #5 (contract_changed)
#5 accepted intent agent-b reads=["shop/cart.py#Cart.__init__","shop/pricing.py#Pricer.quote","shop/pricing.py#calc_total"]
```

(738 ms includes starting pyright.) The amendment's verdict carries a `contract_changed` warning
for #4 (R2a), and the daemon checked what #4 breaks in agent-b's checkout by applying #4's diff
in pyright's memory. agent-b's next hook injected, verbatim:

```
[weft] pyright found more uses in your edit (#3) than the edit-time check saw:
[weft warning] contract_changed shop/pricing.py#calc_total: agent-a changed the signature of shop/pricing.py#calc_total (#4) after your base #2, and your change uses it. (caused by agent-a · task T-1 · event #4). Suggestion: Re-read shop/pricing.py#calc_total (event #4) and adapt your call sites, or negotiate with agent-a.
  ↳ event #4 by agent-a changed shop/pricing.py (their change is not in your checkout yet):
    -def calc_total(prices: list[float]) -> float:
    +def calc_total(prices: list[float], tax: float) -> float:
[weft warning] type_breakage shop/cart.py:11:34: pyright: Argument missing for parameter "tax" — once agent-a's change #4 to shop/pricing.py#calc_total lands (not in your checkout yet). Adapt this use, or negotiate with agent-a.
```

agent-a then changes `Pricer.quote` (#6). Because the amendment added `Pricer.quote` to agent-b's
reads, the coordinator pushes it like any read; the breakage check finds the type error:

```
[weft warning] contract_changed shop/pricing.py#Pricer.quote: agent-a changed the signature of shop/pricing.py#Pricer.quote (#6), which your change uses. …
lsp breakage #6 (1366 ms): 1 new error(s)
[weft warning] type_breakage shop/cart.py:11:16: pyright: Argument missing for parameter "currency" — once agent-a's change #6 to shop/pricing.py#Pricer.quote lands (not in your checkout yet). …
```

At `SessionEnd` of both agents the daemon shut pyright down and released its lock
(`daemon locks gone: true`).

## Off the edit-time path

| | |
|---|---|
| queueing a job from a hook (`lsp_ms` in hooks.jsonl) | 1–12 ms (PostToolUse Edit, UserPromptSubmit, SessionEnd) |
| first enrichment incl. pyright start | 0.7–2 s across runs (in the daemon) |
| breakage check | 0.7–1.7 s (in the daemon) |

The machine was heavily loaded (load average 150–200 from parallel agent work), so absolute
hook times (PreToolUse 294 ms, PostToolUse 320 ms in the recorded run) are higher than the
idle numbers in [languages.md](../languages.md#edit-time-budget). `PreToolUse` sends no job and
does not touch the daemon.

## Found while building it

pyright can publish a file's diagnostics more than once for the same document version (it
re-checks a file when a module it imports changes). The first build took the first publish and
missed the `tax` breakage in 2 of 3 runs (stale result with the overlay, the fresh one arriving
during the baseline). Fix: the baseline is taken first, and every wait ends only after the file
has been quiet for 400 ms (`settleMs`). After the fix, 4 of 4 runs passed all six checks.
