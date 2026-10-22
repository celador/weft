# Python, two real Claude Code agents (2026-10-22)

Card t_3605c66e. Two Claude Code sessions (`claude -p`, Claude Code 2.1.308, default model) edit
a small Python repo in two git worktrees, coordinated by a local gateway (`pnpm dev:local`) and
the Claude Code adapter built from branch `wt/languages`. Raw evidence:
[demo/evidence/python/](../../demo/evidence/python/).

## Repo

```
shop/__init__.py
shop/pricing.py   Item (dataclass), calc_total(items: list[Item]) -> float
shop/cart.py      from shop.pricing import Item; cart_summary(items) -> "3 items"
```

Setup: `node scripts/local-quickstart.mjs --url http://localhost:8811 --repo shop-py-2
--agents agent-a,agent-b <shop> <shop-b>`.

## Run 2 (the recorded squiggle)

1. agent-b (worktree `shop-b`), prompt: show the cart total with `calc_total(items)` in
   `shop/cart.py`, then run a slow check (`sleep 60 && python3 -c 'import shop.cart'`).
   It writes the call. The edit event carries the Python keys from the new backend:

   ```
   #2 accepted edit agent-b reads=['shop/pricing.py#Item', 'shop/pricing.py#calc_total']
                            writes=[('shop/cart.py#cart_summary', 'body')]
   ```

2. While agent-b's check runs, agent-a (worktree `shop`), prompt: make `calc_total` take a
   required `tax_rate: float`. Its edit is classified as a signature change:

   ```
   #4 accepted edit agent-a reads=['shop/pricing.py#Item']
                            writes=[('shop/pricing.py#calc_total', 'signature')]
   ```

3. On agent-b's next turn the adapter injects the squiggle (verbatim, from the session
   transcript):

   ```
   [weft warning] contract_changed shop/pricing.py#calc_total: agent-a changed the signature of
   shop/pricing.py#calc_total (#4), which your change uses. (caused by agent-a · task T-1 · event #4).
   Suggestion: Re-read shop/pricing.py#calc_total and adapt your call sites before your next edit,
   or negotiate (e.g. keep the old signature as an overload).
     ↳ event #4 by agent-a changed shop/pricing.py (their change is not in your checkout yet):
       -def calc_total(items: list[Item]) -> float:
       +def calc_total(items: list[Item], tax_rate: float) -> float:
   ```

4. agent-b's final answer: "the change will break once another agent's change to `calc_total`
   lands … `cart_summary` will fail with a `TypeError` the first time it's called … ask agent-a
   to give `tax_rate` a default of `0.0`". It tried `weft negotiate`, which needs a permission
   this headless session could not grant, so it reported instead of negotiating.

Timing for agent-b's hooks (`run2-agent-b-hooks.jsonl`): `PreToolUse` on the Python `Write`
took 160 ms end to end, including Node start-up and the coordinator round trip.

## Run 1 (no squiggle, and why)

agent-a ran to completion first (signature change, event #4), then agent-b started. agent-b
joined at base #7, after #4, so its `calc_total(items)` call was accepted clean, although its
checkout does not contain agent-a's change. The Python analysis was right (agent-b's edit read
`shop/pricing.py#calc_total`); the gap is that a session's base is the log head at join, not
what its checkout contains. This is language-independent and is filed as card t_7268cb08.

### Run 1 re-run after the fix (t_7268cb08)

Same repo and prompts, sequential sessions, local gateway built from `wt/t_7268cb08`
(WCP §6.1 `told`/`U`). agent-a's session ran to completion first; agent-b's session
started afterwards in a worktree without agent-a's change and joined at base #5, past
agent-a's edit (#2). Its first edit was still denied
([join-rerun-events.txt](../../demo/evidence/python/join-rerun-events.txt)):

```
#2 accepted commit edit agent-a writes=[('shop/pricing.py#calc_total', 'signature')]
#5 accepted join agent-b
#6 rejected check edit agent-b reads=[..., 'shop/pricing.py#calc_total']
    error stale_assumption shop/pricing.py#calc_total: You use shop/pricing.py#calc_total, whose
    signature changed in #2 by agent-a and is not in your checkout: that change has not landed
    and was never delivered to you. (caused_by #2)
```

The stop gate then refused once on the open error; agent-b rewrote the call against agent-a's
new signature (`calc_total(items, tax_rate)`), which was accepted (#7). Its final answer names
the conflict and that the call fails in its own checkout until agent-a's change lands
([join-rerun-agent-b-final-answer.md](../../demo/evidence/python/join-rerun-agent-b-final-answer.md)).

## Deny path

The edit-time deny (`stale_assumption`, the edit never reaches disk) is covered by the Python
conformance fixtures, which drive the same adapter hook with Claude Code's JSON:
`PY.deny-stale-signature`, `PY.deny-renamed` (relative import, renamed function) and
`PY.deny-module-attribute` (`from app import pricing; pricing.calc_total(...)`) deny;
`PY.allow-after-adapting` and `PY.allow-unrelated` allow. With the grammars removed (the old
whole-file fallback), the four deny/adapt fixtures fail; with them, all five pass.
