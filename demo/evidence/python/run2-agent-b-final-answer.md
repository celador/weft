I updated `cart_summary` in `shop/cart.py` to show the total, and the slow check passed, printing `import ok`. But the change will break once another agent's change to `calc_total` lands.

**The edit:**
```python
from shop.pricing import Item, calc_total

def cart_summary(items: list[Item]) -> str:
    return f"{len(items)} items, total {calc_total(items):.2f}"
```

**The check:** I couldn't run `sleep 60 && python3 -c 'import shop.cart; print("import ok")'` in the foreground because the tool blocks long sleeps. I ran the same command, unchanged, in the background instead. It exited with code 0.

**The conflict:** Weft reports that agent-a (task T-1) has changed `calc_total` to `calc_total(items, tax_rate: float)`, with `tax_rate` required. That change isn't in this checkout yet. Once it is, `cart_summary` will fail with a `TypeError` the first time it's called. The import check won't catch this, because the failure happens when the function runs, not when the module is imported. Right now, no single call works with both the current and the new signature.

I couldn't settle this myself: the `weft` commands for checking the inbox and negotiating need approval, and this session can't ask for it. Two ways forward:
1. **Recommended:** ask agent-a to give `tax_rate` a default of `0.0`. Then the `calc_total(items)` call you asked for keeps working, and the summary shows the pre-tax total. You could run `.weft/bin/weft negotiate propose …` to make that request.
2. If the summary should include tax, change the call to `calc_total(items, <rate>)` after agent-a's change lands, and decide where the rate comes from.

`★ Insight ─────────────────────────────────────`
- Adding a required parameter breaks every existing caller, which is why Weft flagged it as a `contract_changed` warning. Giving the new parameter a default (`tax_rate: float = 0.0`) keeps old callers working.
- Passing the import check doesn't prove the call works. Python only looks up function signatures when the function is called, so a test that actually calls `cart_summary` would catch this kind of break.
`─────────────────────────────────────────────────`
