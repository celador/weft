"""The stale_assumption / stale_overwrite diagnostic carries the other agent's new declaration.

Reproduces the hackathon-demo finding (card t_d2411129): two sessions in separate worktrees; A changes
``calc_total(items)`` to ``calc_total(items, opts)``; B's stale call is rejected; B re-reads
pricing.py *in its own worktree* (still the old signature) and retries the identical edit. Before
the fix the diagnostic never showed the new signature and the retry was accepted.

Run: python3 -m unittest discover -s tests -v   (from packages/adapters/hermes)
"""

from __future__ import annotations

import unittest

from test_adapter import AdapterTestCase, assert_schema_valid  # noqa: E402

from weft.adapter import (  # noqa: E402
    MAX_QUOTE_LINES, diff_hunks, new_declaration, quote_hunks, sensitive_parts, split_key, unified_diff,
)

OLD_PRICING = "def calc_total(items):\n    return sum(i['price'] for i in items)\n\n\ndef tax(x):\n    return x * 0.2\n"
NEW_PRICING = ("def calc_total(items, opts):\n    total = sum(i['price'] for i in items)\n"
               "    return total * (1 - opts.get('discount', 0))\n\n\ndef tax(x):\n    return x * 0.2\n")
CART = "from pricing import calc_total\n"
STALE_CART = CART + "\n\ndef cart_total(items):\n    return round(calc_total(items), 2)\n"
FIXED_CART = CART + "\n\ndef cart_total(items, opts=None):\n    return round(calc_total(items, opts or {}), 2)\n"


def a_record(seq=3, path="pricing.py", before=OLD_PRICING, after=NEW_PRICING, agent="shop"):
    """The EventRecord the gateway serves for A's accepted edit (GET /repos/{repo}/events/{seq})."""
    return {
        "seq": seq, "repo": "weft", "status": "accepted", "kind": "edit", "ts": "2026-11-10T15:00:00Z",
        "actor": {"type": "agent", "id": agent}, "agent": agent, "task": "t_demo", "change": f"{agent}/t_demo",
        "base_seq": 2, "mode": "commit", "files": [path], "reads": [],
        "writes": [{"key": f"{path}#calc_total", "kind": "signature"}],
        "diff": unified_diff(path, before, after), "summary": "calc_total takes opts", "diagnostics": [],
    }


def a_reject(seq=4, cause=3, key="pricing.py#calc_total", agent="shop", code="stale_assumption"):
    """The check verdict the coordinator returns for B's stale call (reference.ts R2 wording)."""
    diag = {
        "severity": "error", "code": code, "file": "cart.py", "symbol": key,
        "message": f"You use {key}, whose signature changed in #{cause} by {agent} after your base #2.",
        "caused_by_seq": cause, "caused_by_agent": agent, "caused_by_task": "t_demo",
        "suggestion": f"Read the new {key} (event #{cause}) and update this call site, or negotiate with {agent}.",
    }
    return {
        "type": "verdict", "verdict": "reject", "mode": "check", "seq": seq, "head_seq": seq,
        "diagnostics": [diag], "inbox": [], "delivered_through": seq,
        "context": (f"[weft error] {code} {key}: {diag['message']} (caused by {agent} · task t_demo · "
                    f"event #{cause}). Suggestion: {diag['suggestion']}"),
    }


class StaleQuoteTests(AdapterTestCase):
    def setUp(self):
        super().setUp()
        (self.repo / "pricing.py").write_text(OLD_PRICING)   # B's worktree: A's change is not here
        (self.repo / "cart.py").write_text(CART)
        self.client.head = 2

    def edit_cart(self, content, call_id):
        path = self.repo / "cart.py"
        return self.run_edit("write_file", {"path": str(path), "content": content}, call_id=call_id,
                             apply=lambda: path.write_text(content))

    def test_retry_after_reading_a_stale_worktree_shows_the_new_signature(self):
        record, verdict = a_record(), a_reject()
        assert_schema_valid(self, "EventRecord", record)
        assert_schema_valid(self, "Verdict", verdict)
        self.client.events[3] = record
        self.client.script["check"] = [verdict]

        # step 2: B's stale call is rejected before the write, and the message quotes A's change
        block, _ = self.edit_cart(STALE_CART, "b1")
        self.assertIsNotNone(block)
        message = block["message"]
        self.assertIn("stale_assumption pricing.py#calc_total", message)
        self.assertIn("calc_total(items, opts)", message)
        self.assertIn("New declaration (event #3):\n      def calc_total(items, opts):", message)
        self.assertIn("+    return total * (1 - opts.get('discount', 0))", message, "bounded diff excerpt")
        self.assertIn("NOT in your checkout yet", message)
        self.assertNotIn("Re-read the cited symbols", message)
        self.assertEqual((self.repo / "cart.py").read_text(), CART, "the blocked edit never reached disk")
        self.assertEqual(self.client.calls.count(("event", 3)), 1)

        # step 3: B re-reads pricing.py in its own worktree: still the old signature ...
        self.assertIn("def calc_total(items):", (self.repo / "pricing.py").read_text())
        # ... and retries the identical edit: blocked again, with the new signature again
        again, _ = self.edit_cart(STALE_CART, "b2")
        self.assertIsNotNone(again)
        self.assertIn("Edit blocked again", again["message"])
        self.assertIn("calc_total(items, opts)", again["message"])
        self.assertEqual(len(self.client.submits("check")), 1, "the guard answers locally")
        self.assertEqual(self.client.submits("commit"), [])
        self.assertEqual((self.repo / "cart.py").read_text(), CART)

        # the informed edit goes through, validated against the advanced base
        ok, _ = self.edit_cart(FIXED_CART, "b3")
        self.assertIsNone(ok)
        check = self.client.submits("check")[1][3]
        self.assertEqual(check["base_seq"], 4)
        self.assertIn("calc_total(items, opts or {})", self.client.submits("commit")[0][3]["diff"])
        self.assertEqual(self.client.calls.count(("event", 3)), 1, "the causing event is fetched once")

    def test_an_identical_retry_after_the_guard_is_deliberate(self):
        self.client.events[3] = a_record()
        self.client.script["check"] = [a_reject()]
        self.assertIsNotNone(self.edit_cart(STALE_CART, "b1")[0])
        self.assertIsNotNone(self.edit_cart(STALE_CART, "b2")[0])
        block, _ = self.edit_cart(STALE_CART, "b3")
        self.assertIsNone(block, "a second unchanged retry is the agent's call (spec §5.2)")
        self.assertEqual(len(self.client.submits("check")), 2)

    def test_checkout_that_already_has_the_change_is_not_told_otherwise(self):
        (self.repo / "pricing.py").write_text(NEW_PRICING)
        self.client.events[3] = a_record()
        self.client.script["check"] = [a_reject()]
        block, _ = self.edit_cart(STALE_CART, "b1")
        self.assertIn("Your checkout already has this change in pricing.py", block["message"])
        self.assertNotIn("NOT in your checkout", block["message"])

    def test_unavailable_event_still_says_the_checkout_may_be_stale(self):
        self.client.script["check"] = [a_reject()]   # no events: GET answers 404 (or 403 without observe)
        block, _ = self.edit_cart(STALE_CART, "b1")
        message = block["message"]
        self.assertIn("could not fetch event #3", message)
        self.assertIn("may not be in your checkout yet", message)
        self.assertNotIn("Re-read the cited symbols", message)

    def test_sensitive_files_are_never_quoted_or_fetched(self):
        self.client.events[3] = a_record(path="config/.env.local")
        self.client.script["check"] = [a_reject(key="config/.env.local#*")]
        block, _ = self.edit_cart(STALE_CART, "b1")
        self.assertIn("excluded as sensitive", block["message"])
        self.assertNotIn(("event", 3), self.client.calls)
        self.assertNotIn("+def calc_total", block["message"])

    def test_inbox_contract_changes_are_quoted_in_the_tool_result(self):
        self.client.events[3] = a_record()
        diag = a_reject(code="contract_changed")["diagnostics"][0]
        diag["severity"] = "warning"
        self.adapter.ensure_session()
        self.adapter.worktrees[str(self.repo)] = None
        self.adapter._queue({"type": "inbox", "items": [{"id": 1, "seq": 3, "kind": "diagnostic", "diagnostic": diag}],
                             "delivered_through": 3, "context": "[weft warning] contract_changed pricing.py#calc_total"})
        out = self.adapter.transform_tool_result(tool_name="read_file", result='{"ok": true}')
        self.assertIn("calc_total(items, opts)", out)


class QuoteHelperTests(unittest.TestCase):
    def test_split_key(self):
        self.assertEqual(split_key("shop/pricing.py#Cart.total"), ("shop/pricing.py", "total"))
        self.assertEqual(split_key("docs/a.md#*"), ("docs/a.md", "*"))

    def test_git_and_plain_headers_and_dash_lines(self):
        git_diff = ("diff --git a/x.py b/x.py\nindex 1..2 100644\n--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n"
                    "--- not a header\n+def f(a, b):\n     pass\n"
                    "diff --git a/y.py b/y.py\n--- a/y.py\n+++ b/y.py\n@@ -1 +1 @@\n-def f():\n+def f(c):\n")
        hunks = diff_hunks(git_diff, "x.py")
        self.assertEqual(len(hunks), 1)
        self.assertIn("--- not a header", hunks[0])
        self.assertEqual(new_declaration(hunks, "f"), "def f(a, b):")
        self.assertEqual(new_declaration(diff_hunks(git_diff, "y.py"), "f"), "def f(c):")
        deleted = unified_diff("z.py", "def g():\n    pass\n", None)
        self.assertEqual(len(diff_hunks(deleted, "z.py")), 1)
        self.assertIsNone(new_declaration(diff_hunks(deleted, "z.py"), "g"), "a removed declaration has no new one")

    def test_multiline_and_typescript_declarations(self):
        before = "export function createSession(\n  user: User,\n): Session {\n  return s\n}\n"
        after = "export function createSession(\n  user: User,\n  opts: Opts,\n): Session {\n  return s\n}\n"
        decl = new_declaration(diff_hunks(unified_diff("src/s.ts", before, after), "src/s.ts"), "createSession")
        # the declaration line itself is context here; the diff only added a parameter line
        self.assertIsNone(decl)
        after2 = "export async function createSession(\n  user: User,\n  opts: Opts,\n): Promise<Session> {\n  return s\n}\n"
        decl2 = new_declaration(diff_hunks(unified_diff("src/s.ts", before, after2), "src/s.ts"), "createSession")
        self.assertEqual(decl2, "export async function createSession(\n  user: User,\n  opts: Opts,\n): Promise<Session> {")

    def test_quote_is_bounded(self):
        before = "".join(f"x{i} = {i}\n" for i in range(200))
        after = "".join(f"x{i} = {i + 1}\n" for i in range(200)) + "y = '" + "z" * 1000 + "'\n"
        quote = quote_hunks(diff_hunks(unified_diff("big.py", before, after), "big.py"), "*")
        lines = quote.split("\n")
        self.assertEqual(len(lines), MAX_QUOTE_LINES + 1)
        self.assertTrue(lines[-1].endswith("more lines)"))
        self.assertTrue(all(len(l) < 220 for l in lines))

    def test_sensitive_parts(self):
        for p in (".env", "a/.env.local", "certs/server.PEM", "node_modules/x/i.js", ".git/config", ".ssh/id"):
            self.assertTrue(sensitive_parts(p.split("/")), p)
        self.assertFalse(sensitive_parts("shop/pricing.py".split("/")))


if __name__ == "__main__":
    unittest.main()
