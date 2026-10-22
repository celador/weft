"""Unit tests for the Hermes adapter's hook mapping and scope guard (no network).

Run: python3 -m unittest discover -s tests -t . -v   (from packages/adapters/hermes)
The analyzer bundle (dist/analyze.mjs) is used when present (``pnpm build``).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG / "plugin"))

from weft.adapter import (  # noqa: E402
    Analyzer, Config, Root, Scope, WeftAdapter, file_key, normalize_tool,
)
from weft.wcp import WcpError  # noqa: E402

BUNDLE = PKG / "dist" / "analyze.mjs"


def node_bin() -> str:
    for c in ("/opt/homebrew/opt/node@24/bin/node", shutil.which("node") or ""):
        if c and os.path.exists(c):
            return c
    return "node"


class FakeClient:
    """Scripted WCP client: records every call; verdicts come from ``self.script``."""

    def __init__(self):
        self.calls = []
        self.script = {}  # mode -> list of verdict dicts (popped in order); default accept
        self.gate_results = []
        self.head = 10
        self.expire_next = False

    def hello(self, agent, capabilities, task=None, change=None, resume_session=None):
        self.calls.append(("hello", agent, capabilities, task, change))
        return {"type": "welcome", "session": f"s{len(self.calls)}", "head_seq": self.head,
                "delivered_through": self.head, "heartbeat_interval_ms": 30000,
                "limits": {"max_diff_bytes": 1 << 20}}

    def submit(self, session, mode, event, inbox_ack=None, idempotency_key=None):
        if self.expire_next:
            self.expire_next = False
            raise WcpError("session_expired", "gone", 410)
        self.calls.append(("submit", session, mode, event, inbox_ack, idempotency_key))
        queue = self.script.get(mode) or []
        verdict = queue.pop(0) if queue else {"verdict": "accept", "diagnostics": [], "inbox": []}
        verdict.setdefault("type", "verdict")
        verdict.setdefault("mode", mode)
        verdict.setdefault("delivered_through", self.head)
        return verdict

    def drain(self, session, ack=None):
        self.calls.append(("drain", session, ack))
        return {"type": "inbox", "items": [], "delivered_through": self.head}

    def heartbeat(self, session):
        self.calls.append(("heartbeat", session))
        return {}

    def gate(self, session, gate):
        self.calls.append(("gate", session, gate))
        return self.gate_results.pop(0) if self.gate_results else {"allow": True, "open_errors": []}

    def bye(self, session, reason=""):
        self.calls.append(("bye", session))

    def submits(self, mode=None):
        return [c for c in self.calls if c[0] == "submit" and (mode is None or c[2] == mode)]


SCHEMA = json.loads((PKG.parent.parent / "protocol" / "schema" / "wcp-v0.schema.json").read_text())


def _schema_errors(node, value, path="$"):
    """Minimal JSON Schema check covering the keywords wcp-v0.schema.json uses (no jsonschema
    dependency). The vitest suite re-validates the same events with @weft/protocol's validator."""
    import re as _re
    if "$ref" in node:
        return _schema_errors(SCHEMA["$defs"][node["$ref"].split("/")[-1]], value, path)
    errs = []
    t = node.get("type")
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool}
    if t in types and (not isinstance(value, types[t]) or (t == "integer" and isinstance(value, bool))):
        return [f"{path}: expected {t}"]
    if "const" in node and value != node["const"]:
        errs.append(f"{path}: expected const {node['const']!r}")
    if "enum" in node and value not in node["enum"]:
        errs.append(f"{path}: {value!r} not in {node['enum']}")
    if isinstance(value, str):
        if "pattern" in node and not _re.search(node["pattern"], value):
            errs.append(f"{path}: {value!r} !~ {node['pattern']}")
        if len(value) > node.get("maxLength", 1 << 30) or len(value) < node.get("minLength", 0):
            errs.append(f"{path}: bad length")
    if isinstance(value, int) and "minimum" in node and value < node["minimum"]:
        errs.append(f"{path}: < {node['minimum']}")
    if isinstance(value, list) and "items" in node:
        for i, v in enumerate(value):
            errs += _schema_errors(node["items"], v, f"{path}[{i}]")
    if isinstance(value, dict):
        errs += [f"{path}: missing {k}" for k in node.get("required", []) if k not in value]
        for k, sub in (node.get("properties") or {}).items():
            if k in value:
                errs += _schema_errors(sub, value[k], f"{path}.{k}")
    for sub in node.get("allOf", []):
        if "if" in sub and not _schema_errors(sub["if"], value, path):
            errs += _schema_errors(sub["then"], value, path)
        elif "if" not in sub:
            errs += _schema_errors(sub, value, path)
    return errs


def assert_schema_valid(case, definition, value):
    errs = _schema_errors(SCHEMA["$defs"][definition], value)
    case.assertEqual(errs, [], f"{definition} invalid against wcp-v0.schema.json")


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


class AdapterTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="weft-hermes-test-")).resolve()
        self.repo = self.tmp / "weft"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "src" / "a.ts").write_text(
            "export function refreshToken(a: number) { return a }\nexport function other() { return 1 }\n")
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "notes.md").write_text("hello\n")
        git(self.repo, "init", "-q")
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
        self.outside = self.tmp / "elsewhere"
        self.outside.mkdir()
        (self.outside / "x.ts").write_text("export const x = 1;\n")
        self.cfg = Config(url="http://fake", repo="weft", token="t", agent="hermes-test", profile="test",
                          roots=[Root(str(self.repo), "")], node=node_bin(),
                          analyzer=str(BUNDLE) if BUNDLE.exists() else None, log_path=None)
        self.client = FakeClient()
        os.environ.pop("HERMES_KANBAN_TASK", None)
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.repo)
        self.adapter = WeftAdapter(self.cfg, client=self.client, heartbeat=False)

    def tearDown(self):
        self.adapter.analyzer.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers ------------------------------------------------------------------------------

    def run_edit(self, tool, args, call_id="c1", apply=None):
        block = self.adapter.pre_tool_call(tool_name=tool, args=args, tool_call_id=call_id)
        if block:
            return block, None
        if apply:
            apply()
        self.adapter.post_tool_call(tool_name=tool, args=args, tool_call_id=call_id, result='{"ok": true}')
        out = self.adapter.transform_tool_result(tool_name=tool, args=args, result='{"ok": true}',
                                                 tool_call_id=call_id)
        return None, out


class ScopeTests(AdapterTestCase):
    def test_scope_guard_resolution(self):
        scope = Scope([Root(str(self.repo), ""), Root(str(self.tmp / "ios"), "ios/")])
        t = scope.resolve(str(self.repo / "src" / "a.ts"))
        self.assertEqual(t.rel, "src/a.ts")
        self.assertEqual(t.worktree, str(self.repo))
        self.assertEqual(scope.resolve("src/new.ts", str(self.repo)).rel, "src/new.ts")  # relative + new
        self.assertIsNone(scope.resolve(str(self.outside / "x.ts")))
        self.assertIsNone(scope.resolve(str(self.repo) + "-other/x.ts"))  # prefix-sibling dir
        self.assertIsNone(scope.resolve(str(self.repo / "node_modules" / "p" / "i.ts")))
        self.assertIsNone(scope.resolve(str(self.repo / ".git" / "config")))

    def test_worktrees_map_to_repo_relative_paths(self):
        wt = self.repo / ".worktrees" / "b9"
        git(self.repo, "worktree", "add", "-q", str(wt))
        scope = Scope([Root(str(self.repo), "")])
        t = scope.resolve(str(wt / "src" / "a.ts"))
        self.assertEqual((t.rel, t.worktree), ("src/a.ts", str(wt)))
        self.assertEqual(scope.resolve_dir(str(wt / "src")), str(wt))
        ios = Scope([Root(str(self.repo), "ios/")])
        self.assertEqual(ios.resolve(str(wt / "src" / "a.ts")).rel, "ios/src/a.ts")

    def test_out_of_scope_tools_are_noops(self):
        self.adapter.pre_tool_call(tool_name="write_file", args={"path": str(self.outside / "x.ts"),
                                                                "content": "export const x = 2;\n"},
                                   tool_call_id="o1")
        self.adapter.post_tool_call(tool_name="write_file", args={}, tool_call_id="o1")
        self.adapter.pre_tool_call(tool_name="terminal", args={"command": "ls", "workdir": str(self.outside)},
                                   tool_call_id="o2")
        self.adapter.post_tool_call(tool_name="terminal", args={}, tool_call_id="o2")
        self.assertIsNone(self.adapter.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="o3"))
        self.assertIsNone(self.adapter.pre_verify())
        self.assertEqual(self.client.calls, [], "nothing may be sent for out-of-scope work")

    def test_tool_name_normalization(self):
        self.assertEqual(normalize_tool("mcp__write_file"), "write_file")
        self.assertEqual(normalize_tool("patch"), "patch")


class EditTests(AdapterTestCase):
    @unittest.skipUnless(BUNDLE.exists(), "analyzer bundle not built")
    def test_patch_checks_then_commits_symbol_writes(self):
        path = self.repo / "src" / "a.ts"
        args = {"path": str(path), "old_string": "refreshToken(a: number)", "new_string": "refreshToken(a: number, retries = 1)"}
        block, out = self.run_edit("patch", args, apply=lambda: path.write_text(
            path.read_text().replace(args["old_string"], args["new_string"])))
        self.assertIsNone(block)
        hello = [c for c in self.client.calls if c[0] == "hello"][0]
        self.assertEqual(hello[1]["harness"], "hermes")
        self.assertEqual(hello[2]["level"], 3)
        self.assertTrue(hello[4].startswith("hermes-test/adhoc-"))
        check, commit = self.client.submits("check")[0], self.client.submits("commit")[0]
        self.assertEqual(check[3]["writes"], [{"key": "src/a.ts#refreshToken", "kind": "signature"}])
        self.assertEqual(commit[3]["writes"], [{"key": "src/a.ts#refreshToken", "kind": "signature"}])
        self.assertIn("+export function refreshToken(a: number, retries = 1)", commit[3]["diff"])
        self.assertEqual(commit[3]["base_seq"], 10)
        # the first edit's pre-check opens the session; it must carry the welcome's base, not 0
        self.assertEqual(check[3]["base_seq"], 10)
        self.assertEqual(commit[3]["tool"]["call_id"], "c1")
        self.assertIsNone(out, "no diagnostics -> tool result untouched")

    @unittest.skipUnless(BUNDLE.exists(), "analyzer bundle not built")
    def test_python_edit_gets_declaration_keys(self):
        """Python goes through the bundle's tree-sitter backend: declaration keys, not path#*."""
        shop = self.repo / "shop"
        shop.mkdir()
        (shop / "__init__.py").write_text("")
        (shop / "pricing.py").write_text("def calc_total(items):\n    return sum(items)\n\n\ndef tax(x):\n    return x * 0.2\n")
        path = shop / "cart.py"
        content = "from shop.pricing import calc_total\n\n\nclass Cart:\n    def total(self, items):\n        return calc_total(items)\n"
        self.run_edit("write_file", {"path": str(path), "content": content}, apply=lambda: path.write_text(content))
        commit = self.client.submits("commit")[0][3]
        self.assertEqual(sorted((w["key"], w["kind"]) for w in commit["writes"]),
                         [("shop/cart.py#Cart", "new"), ("shop/cart.py#Cart.total", "new")])
        self.assertIn("shop/pricing.py#calc_total", commit["reads"])
        self.assertTrue(self.adapter.analyzer.analyzable("shop/cart.py"))
        self.assertFalse(self.adapter.analyzer.analyzable("docs/notes.md"))
        # a signature change on an existing function
        pricing = shop / "pricing.py"
        args = {"path": str(pricing), "old_string": "def calc_total(items):", "new_string": "def calc_total(items, discount=0):"}
        self.run_edit("patch", args, call_id="c2", apply=lambda: pricing.write_text(
            pricing.read_text().replace(args["old_string"], args["new_string"])))
        self.assertEqual(self.client.submits("commit")[1][3]["writes"],
                         [{"key": "shop/pricing.py#calc_total", "kind": "signature"}])

    def test_non_ts_files_use_whole_file_keys(self):
        path = self.repo / "docs" / "notes.md"
        args = {"path": str(path), "content": "hello world\n"}
        self.run_edit("write_file", args, apply=lambda: path.write_text(args["content"]))
        self.assertEqual(self.client.submits("commit")[0][3]["writes"],
                         [{"key": file_key("docs/notes.md"), "kind": "body"}])
        new = self.repo / "docs" / "new.md"
        self.run_edit("write_file", {"path": str(new), "content": "x"}, call_id="c2",
                      apply=lambda: new.write_text("x"))
        self.assertEqual(self.client.submits("commit")[1][3]["writes"],
                         [{"key": "docs/new.md#*", "kind": "new"}])

    def test_reject_on_check_blocks_with_context_and_advances_base(self):
        self.client.head = 12
        self.client.script["check"] = [{
            "verdict": "reject", "seq": 12, "delivered_through": 12,
            "diagnostics": [{"severity": "error", "code": "stale_assumption"}],
            "inbox": [{"id": 3, "seq": 11, "kind": "diagnostic"}],
            "context": "[weft error] stale_assumption docs/notes.md: changed (caused by hermes-b · event #11)",
        }]
        path = self.repo / "docs" / "notes.md"
        block, _ = self.run_edit("write_file", {"path": str(path), "content": "changed\n"})
        self.assertEqual(block["action"], "block")
        self.assertIn("stale_assumption", block["message"])
        self.assertEqual(path.read_text(), "hello\n")
        self.assertEqual(self.client.submits("commit"), [], "blocked edits are never committed")
        self.assertEqual((self.adapter.base_seq, self.adapter.acked), (12, 3))
        self.run_edit("write_file", {"path": str(path), "content": "changed\n"}, call_id="c2",
                      apply=lambda: path.write_text("changed\n"))
        retry = self.client.submits("check")[1]
        self.assertEqual((retry[3]["base_seq"], retry[4]), (12, 3), "retry carries new base + ack")

    def test_advise_mode_never_blocks(self):
        self.cfg.mode = "advise"
        self.client.script["commit"] = [{"verdict": "reject", "diagnostics": [], "inbox": [], "context": "[weft error] x"}]
        path = self.repo / "docs" / "notes.md"
        block, first = self.run_edit("write_file", {"path": str(path), "content": "z\n"},
                                     apply=lambda: path.write_text("z\n"))
        self.assertIsNone(block)
        self.assertEqual(self.client.submits("check"), [], "advise repos skip the pre-check round trip")
        self.assertTrue(self.adapter.flush(5))
        self.assertEqual(len(self.client.submits("commit")), 1, "the commit still reaches the log")
        later = self.adapter.transform_tool_result(tool_name="read_file", result='{"ok": true}')
        out = first or later  # this result, or the next one if the worker finished afterwards
        self.assertIn("[weft error] x", json.loads(out)["weft_diagnostics"])

    def test_hello_declares_l1_when_advisory(self):
        # Agent Hooks Core §3.3: an advisory adapter MUST NOT declare L2/L3.
        def hello_caps():
            self.adapter.session = None
            self.client.calls.clear()
            self.adapter.ensure_session()
            return [c for c in self.client.calls if c[0] == "hello"][-1][2]
        self.cfg.mode = "enforce"
        self.assertEqual(hello_caps()["level"], 3)
        self.cfg.mode, self.cfg.async_advise = "advise", False
        caps = hello_caps()
        self.assertEqual(caps, {"level": 1, "observe": "sync", "inject": "immediate",
                                "deny_edit": False, "refuse_stop": False, "commit_gate": False})
        self.cfg.async_advise = True
        caps = hello_caps()
        self.assertEqual((caps["level"], caps["observe"], caps["inject"], caps["deny_edit"]),
                         (1, "async", "delayed", False))

    def test_advise_sync_mode_still_prechecks(self):
        self.cfg.mode, self.cfg.async_advise = "advise", False
        self.client.script["check"] = [{"verdict": "reject", "diagnostics": [], "inbox": [], "context": "[weft error] x"}]
        path = self.repo / "docs" / "notes.md"
        block, out = self.run_edit("write_file", {"path": str(path), "content": "z\n"},
                                   apply=lambda: path.write_text("z\n"))
        self.assertIsNone(block)
        self.assertIn("(advisory)", json.loads(out)["weft_diagnostics"])

    def test_commit_diagnostics_are_injected_into_tool_result(self):
        self.client.script["commit"] = [{
            "verdict": "accept", "seq": 11, "delivered_through": 11, "diagnostics": [],
            "inbox": [{"id": 1, "seq": 9, "kind": "diagnostic"}],
            "context": "[weft warning] claim_wait docs/notes.md#*: hermes-b holds this area",
        }]
        path = self.repo / "docs" / "notes.md"
        _, out = self.run_edit("write_file", {"path": str(path), "content": "y\n"},
                               apply=lambda: path.write_text("y\n"))
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertIn("claim_wait", payload["weft_diagnostics"])
        self.assertEqual((self.adapter.base_seq, self.adapter.acked), (11, 1))
        plain = self.adapter.transform_tool_result(tool_name="read_file", result="text")
        self.assertIsNone(plain, "injected once")

    def test_unchanged_file_after_failed_tool_sends_nothing(self):
        path = self.repo / "docs" / "notes.md"
        self.run_edit("write_file", {"path": str(path), "content": "never applied\n"})
        self.assertEqual(self.client.submits("commit"), [])

    def test_session_expiry_rehellos(self):
        path = self.repo / "docs" / "notes.md"
        self.run_edit("write_file", {"path": str(path), "content": "1\n"}, apply=lambda: path.write_text("1\n"))
        self.client.expire_next = True
        self.run_edit("write_file", {"path": str(path), "content": "2\n"}, call_id="c2",
                      apply=lambda: path.write_text("2\n"))
        self.assertEqual(len([c for c in self.client.calls if c[0] == "hello"]), 2)
        self.assertEqual(len(self.client.submits("commit")), 2)

    def test_transport_errors_fail_open(self):
        def boom(*a, **k):
            raise WcpError("transport", "down")
        self.client.submit = boom
        path = self.repo / "docs" / "notes.md"
        block, out = self.run_edit("write_file", {"path": str(path), "content": "q\n"},
                                   apply=lambda: path.write_text("q\n"))
        self.assertIsNone(block)
        self.assertIsNone(out)


class EnforceFailsOpenTests(AdapterTestCase):
    """John's rule for enforce repos: an unreachable gateway never stalls a card. Every hook
    lets the tool run, one log line per failure, and the breaker makes later calls instant."""

    def test_enforce_with_dead_gateway_allows_everything_and_logs(self):
        import socket
        import time as _time
        from weft.wcp import CircuitBreaker, WcpClient
        with socket.socket() as s:  # a port nothing listens on
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        log = self.tmp / "weft.log"
        self.cfg.log_path = log
        self.assertEqual(self.cfg.mode, "enforce")
        client = WcpClient(f"http://127.0.0.1:{port}", "t", "weft", timeout=1.0, breaker=CircuitBreaker(300))
        adapter = WeftAdapter(self.cfg, client=client, heartbeat=False)
        try:
            path = self.repo / "src" / "a.ts"
            path.parent.mkdir(exist_ok=True)
            path.write_text("export function f() { return 1; }\n")
            args = {"path": str(path), "content": "export function f() { return 2; }\n"}
            self.assertIsNone(adapter.pre_tool_call(tool_name="write_file", args=args, tool_call_id="e1"))
            path.write_text(args["content"])
            adapter.post_tool_call(tool_name="write_file", args=args, tool_call_id="e1", result="{}")
            self.assertIsNone(adapter.transform_tool_result(tool_name="write_file", args=args, result="{}",
                                                            tool_call_id="e1"))
            # the breaker is open now: the next edit costs no network round trip
            t0 = _time.monotonic()
            args2 = {"path": str(path), "content": "export function f() { return 3; }\n"}
            self.assertIsNone(adapter.pre_tool_call(tool_name="write_file", args=args2, tool_call_id="e2"))
            self.assertLess(_time.monotonic() - t0, 0.5)
            commit = {"command": "git commit -qam x", "workdir": str(self.repo)}
            self.assertIsNone(adapter.pre_tool_call(tool_name="terminal", args=commit, tool_call_id="g1"))
            self.assertIsNone(adapter.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k1"))
            self.assertIsNone(adapter.pre_verify())
            text = log.read_text()
            self.assertIn("failed open", text)
            self.assertIn("circuit_open", text)
        finally:
            adapter.analyzer.close()


class TerminalAndGateTests(AdapterTestCase):
    def test_terminal_edits_and_commits_become_events(self):
        args = {"command": "echo more >> docs/notes.md", "workdir": str(self.repo)}
        self.adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id="t1")
        with open(self.repo / "docs" / "notes.md", "a") as f:
            f.write("more\n")
        self.adapter.post_tool_call(tool_name="terminal", args=args, tool_call_id="t1")
        commit = self.client.submits("commit")[0][3]
        self.assertEqual(commit["files"], ["docs/notes.md"])
        self.assertEqual(commit["writes"], [{"key": "docs/notes.md#*", "kind": "body"}])
        # a git commit through the terminal: gate commit first, then a checkpoint event
        args = {"command": "git commit -qam wip", "workdir": str(self.repo)}
        self.assertIsNone(self.adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id="t2"))
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "wip")
        self.adapter.post_tool_call(tool_name="terminal", args=args, tool_call_id="t2")
        self.assertIn(("gate", "s1", "commit"), self.client.calls)
        kinds = [c[3]["kind"] for c in self.client.submits("commit")]
        self.assertEqual(kinds, ["edit", "checkpoint"])
        self.assertRegex(self.client.submits("commit")[1][3]["payload"]["sha"], r"^[0-9a-f]{40}$")

    def test_rebase_checkpoint_clears_floor_even_if_its_verdict_repeats_the_trunk_item(self):
        # A land (#12) put a requires_rebase trunk item in the inbox; the agent rebases before
        # that item was acked, so the checkpoint's verdict still lists it. The new commit must
        # still lift the rebase floor, or every later edit stays based below the landing.
        trunk = {"id": 1, "kind": "trunk", "seq": 12, "requires_rebase": True,
                 "diagnostic": {"severity": "info", "code": "trunk_advanced"}}
        self.client.head = 13
        self.client.script["commit"] = [{"verdict": "accept", "diagnostics": [], "inbox": [trunk],
                                          "context": "[weft info] trunk_advanced", "delivered_through": 13}]
        self.adapter.ensure_session()
        self.adapter.rebase_floor = 12
        args = {"command": "git commit --allow-empty -qm rebased", "workdir": str(self.repo)}
        self.adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id="r1")
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "rebased")
        self.adapter.post_tool_call(tool_name="terminal", args=args, tool_call_id="r1")
        self.assertEqual([c[3]["kind"] for c in self.client.submits("commit")], ["checkpoint"])
        self.assertIsNone(self.adapter.rebase_floor)

    def test_git_integration_commands_do_not_claim_merged_files(self):
        git(self.repo, "checkout", "-qb", "other")
        (self.repo / "src" / "a.ts").write_text("export function refreshToken(a: string) { return a }\n")
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "theirs")
        git(self.repo, "checkout", "-q", "-")
        args = {"command": "git merge --no-commit --no-ff other", "workdir": str(self.repo)}
        self.adapter.ensure_session()
        self.adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id="m1")
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-commit", "--no-ff", "other")
        self.adapter.post_tool_call(tool_name="terminal", args=args, tool_call_id="m1")
        self.assertEqual(self.client.submits(), [], "merged-in changes are not this agent's edits")

    def test_completion_gate_blocks_then_releases_on_insistence(self):
        path = self.repo / "docs" / "notes.md"
        self.run_edit("write_file", {"path": str(path), "content": "1\n"}, apply=lambda: path.write_text("1\n"))
        refused = {"allow": False, "reason": "1 open Weft error(s)",
                   "open_errors": [{"symbol": "src/a.ts#refreshToken", "severity": "error"}]}
        self.client.gate_results = [dict(refused), dict(refused), dict(refused)]
        for _ in range(2):
            block = self.adapter.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k")
            self.assertEqual(block["action"], "block")
            self.assertIn("open Weft error", block["message"])
        self.assertIsNone(self.adapter.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k"))
        release = self.client.submits("commit")[-1][3]
        self.assertEqual(release["kind"], "release")
        self.assertEqual(release["payload"]["keys"], ["src/a.ts#refreshToken"])
        self.assertEqual(release["payload"]["reason"], "abandoned")
        self.assertIn("retreat: kanban_complete after 2 gate refusals", release["intent"])
        assert_schema_valid(self, "Submit", {"type": "submit", "mode": "commit", "event": release})

    def test_commit_gate_retreat_release_is_schema_valid(self):
        self.adapter.ensure_session()
        refused = {"allow": False, "reason": "1 open Weft error(s)",
                   "open_errors": [{"symbol": "pnpm-lock.yaml#*", "severity": "error"},
                                   {"symbol": "not a key", "severity": "error"}]}
        self.client.gate_results = [dict(refused), dict(refused), dict(refused)]
        args = {"command": "git commit -m x", "workdir": str(self.repo)}
        for _ in range(2):
            self.assertEqual(self.adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id="g")["action"],
                             "block")
        self.assertIsNone(self.adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id="g"))
        release = self.client.submits("commit")[-1][3]
        self.assertEqual(release["payload"], {"keys": ["pnpm-lock.yaml#*"], "reason": "abandoned"})
        assert_schema_valid(self, "Submit", {"type": "submit", "mode": "commit", "event": release})

    def test_schema_check_rejects_free_text_release_reason(self):
        bad = {"kind": "release", "base_seq": 1, "payload": {"keys": ["a.ts#x"], "reason": "retreat: git commit"}}
        self.assertTrue(_schema_errors(SCHEMA["$defs"]["Submit"], {"type": "submit", "mode": "commit", "event": bad}))

    def test_pre_verify_releases_on_insistence(self):
        path = self.repo / "docs" / "notes.md"
        self.run_edit("write_file", {"path": str(path), "content": "1\n"}, apply=lambda: path.write_text("1\n"))
        refused = {"allow": False, "reason": "1 open Weft error(s)",
                   "open_errors": [{"symbol": "pnpm-lock.yaml#*", "severity": "error"}]}
        self.client.gate_results = [dict(refused), dict(refused), dict(refused)]
        for _ in range(2):
            out = self.adapter.pre_verify()
            self.assertEqual(out["action"], "continue")
            self.assertIn("Not done yet", out["message"])
        self.assertIsNone(self.adapter.pre_verify())
        release = self.client.submits("commit")[-1][3]
        self.assertEqual(release["kind"], "release")
        self.assertEqual(release["payload"], {"keys": ["pnpm-lock.yaml#*"], "reason": "abandoned"})
        self.assertIn("retreat: finishing", release["intent"])
        assert_schema_valid(self, "Submit", {"type": "submit", "mode": "commit", "event": release})

    def test_rejected_release_is_logged(self):
        logs = []
        self.adapter.log = logs.append  # type: ignore[method-assign]
        self.adapter.ensure_session()
        real_submit = self.client.submit

        def reject(session, mode, event, **kw):
            if event.get("kind") == "release":
                raise WcpError("invalid_message", "invalid submit", 400,
                               {"issues": [{"path": "/event/payload/reason", "message": "enum"}]})
            return real_submit(session, mode, event, **kw)

        self.client.submit = reject  # type: ignore[method-assign]
        self.assertFalse(self.adapter._release(["a.ts#x"], "retreat: test"))
        self.assertTrue(any("release REJECTED" in m and "invalid_message" in m and "/event/payload/reason" in m
                            for m in logs), logs)
        self.client.submit = real_submit  # type: ignore[method-assign]
        self.client.script["commit"] = [{"verdict": "reject", "diagnostics": [{"code": "x"}]}]
        self.assertFalse(self.adapter._release(["a.ts#x"], "retreat: test"))
        self.assertTrue(any("release REJECTED (verdict)" in m for m in logs), logs)

    def test_pre_verify_continues_while_errors_open(self):
        path = self.repo / "docs" / "notes.md"
        self.run_edit("write_file", {"path": str(path), "content": "1\n"}, apply=lambda: path.write_text("1\n"))
        self.client.gate_results = [{"allow": False, "reason": "2 open Weft error(s)", "open_errors": []}]
        self.assertEqual(self.adapter.pre_verify()["action"], "continue")
        self.assertIsNone(self.adapter.pre_verify())


class ConfigTests(unittest.TestCase):
    def test_load_per_profile(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.json"
            p.write_text(json.dumps({"url": "https://g", "repo": "weft",
                                     "agents": {"backend": {"agent": "hermes-backend", "token": "tok"}}}))
            cfg = Config.load(p, profile="backend")
            self.assertEqual((cfg.agent, cfg.token, cfg.repo), ("hermes-backend", "tok", "weft"))
            self.assertEqual(cfg.roots, [], "projects are discovered; no explicit roots by default")
            self.assertEqual(cfg.tokens, {"weft": "tok"})
            self.assertEqual(cfg.mode, "advise", "no mode configured -> advise")
            self.assertIsNone(Config.load(p, profile="money"), "profiles without an agent are disabled")
            self.assertIsNone(Config.load(Path(d) / "missing.json", profile="backend"))


if __name__ == "__main__":
    unittest.main()
