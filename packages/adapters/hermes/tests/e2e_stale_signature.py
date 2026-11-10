#!/usr/bin/env python3
"""E2E driver for src/stale-signature-e2e.test.ts (card t_d2411129, the hackathon-demo finding).

Two real WeftAdapters (real WcpClient, the plugin's bundled Python analysis as in a catalog install,
enforce mode) in two git worktrees of one repo, against a local gateway backed by the reference
coordinator:

  1. A changes ``calc_total(items)`` to ``calc_total(items, opts)`` in pricing.py (accepted).
  2. B, whose session opened before that, adds a stale ``calc_total(items)`` call in cart.py: rejected.
  3. B re-reads pricing.py in ITS worktree (still the old signature) and retries the identical edit.
  4. B makes the corrected edit.

    python3 tests/e2e_stale_signature.py <gateway url> <tmp dir>   -> prints a JSON summary
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

URL, TMP = sys.argv[1], Path(sys.argv[2]).resolve()
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugin"))
os.environ.pop("HERMES_KANBAN_TASK", None)
os.environ.pop("HERMES_KANBAN_DB", None)  # never read a real board from a test

from weft.adapter import Config, Root, WeftAdapter  # noqa: E402

OLD = "def calc_total(items):\n    return sum(i['price'] for i in items)\n"
NEW = "def calc_total(items, opts):\n    total = sum(i['price'] for i in items)\n    return total * (1 - opts.get('discount', 0))\n"
CART = "from pricing import calc_total\n"
STALE = CART + "\n\ndef cart_total(items):\n    return round(calc_total(items), 2)\n"
FIXED = CART + "\n\ndef cart_total(items, opts=None):\n    return round(calc_total(items, opts or {}), 2)\n"


def g(cwd, *args) -> str:
    return subprocess.run(["git", "-c", "user.email=e2e@t", "-c", "user.name=e2e", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


shop, shop2 = TMP / "shop", TMP / "shop-2"
shop.mkdir(parents=True)
g(shop, "init", "-q", "-b", "main")
(shop / "pricing.py").write_text(OLD)
(shop / "cart.py").write_text(CART)
g(shop, "add", "-A")
g(shop, "commit", "-qm", "init")
g(shop, "worktree", "add", "-q", "-b", "agent-b", str(shop2))


def adapter(agent: str, token: str, root: Path, change: str) -> WeftAdapter:
    # Two Hermes processes never share a task; in one process the ad-hoc task id would be shared,
    # and changes of one task are best-of-N alternatives that never validate against each other.
    os.environ["WEFT_HERMES_CHANGE"] = change
    os.environ["HERMES_KANBAN_TASK"] = change.split("/")[-1]
    cfg = Config(url=URL, repo="shop", token=token, agent=agent, profile=agent, roots=[Root(str(root), "")],
                 mode="enforce", analyzer=None, log_path=TMP / f"{agent}.log")
    return WeftAdapter(cfg, heartbeat=False)


n = 0


def call(a: WeftAdapter, tool: str, args: dict, run=None):
    """One model tool call through the hooks, as Hermes runs them. -> (block, injected text)"""
    global n
    n += 1
    cid = f"c{n}"
    block = a.pre_tool_call(tool_name=tool, args=args, tool_call_id=cid)
    if block:
        return block, None
    result = run() if run else None
    a.post_tool_call(tool_name=tool, args=args, tool_call_id=cid, result='{"ok": true}')
    out = a.transform_tool_result(tool_name=tool, args=args, result=json.dumps({"content": result or ""}),
                                  tool_call_id=cid)
    return None, out


a = adapter("shop", "tok-a", shop, "shop/t_a")
b = adapter("shop-2", "tok-b", shop2, "shop-2/t_b")
b.ensure_session()  # B's session opens at its session start (on_session_start), before A's change

# 1. A: the signature change
pa = shop / "pricing.py"
patch = {"path": str(pa), "old_string": OLD.split("\n")[0] + "\n" + OLD.split("\n")[1],
         "new_string": NEW.rstrip("\n")}
a_block, _ = call(a, "patch", patch, lambda: pa.write_text(pa.read_text().replace(patch["old_string"], patch["new_string"])))

# 2. B: the stale call
cb = shop2 / "cart.py"
write = lambda text: (lambda: cb.write_text(text))  # noqa: E731
block1, _ = call(b, "write_file", {"path": str(cb), "content": STALE}, write(STALE))
cart_after_block1 = cb.read_text()

# 3. B re-reads pricing.py in its own worktree, then retries the identical edit
_, read_injected = call(b, "read_file", {"path": str(shop2 / "pricing.py")}, lambda: (shop2 / "pricing.py").read_text())
pricing_seen_by_b = (shop2 / "pricing.py").read_text()
block2, _ = call(b, "write_file", {"path": str(cb), "content": STALE}, write(STALE))
cart_after_block2 = cb.read_text()

# 4. B: the informed edit
block3, injected3 = call(b, "write_file", {"path": str(cb), "content": FIXED}, write(FIXED))

for x in (a, b):
    x.close()
print(json.dumps({
    "a_block": a_block, "block1": block1, "block2": block2, "block3": block3, "injected3": injected3,
    "read_injected": read_injected, "pricing_seen_by_b": pricing_seen_by_b,
    "cart_after_block1": cart_after_block1, "cart_after_block2": cart_after_block2, "cart_final": cb.read_text(),
    "b_log": (TMP / "shop-2.log").read_text().splitlines()[-12:] if (TMP / "shop-2.log").exists() else [],
}))
