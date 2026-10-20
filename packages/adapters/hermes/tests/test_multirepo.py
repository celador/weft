"""Multi-repo adapter: project discovery/resolution, per-repo modes, fail-open + circuit breaker.

Run: python3 -m unittest discover -s tests -v   (from packages/adapters/hermes)
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "plugin"))

from test_adapter import FakeClient, git  # noqa: E402
from weft.adapter import (  # noqa: E402
    Config, Root, Scope, WeftAdapter, WeftRouter, discover_projects, sanitize_repo,
)
from weft.wcp import CircuitBreaker, WcpClient, WcpError  # noqa: E402


def commit_all(cwd):
    git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")


class Workspace(unittest.TestCase):
    """tmp/github/{alpha,beta}, tmp/code/gamma (git repos), tmp/github/notgit, tmp/hermes."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="weft-multi-")).resolve()
        self.gh, self.code = self.tmp / "github", self.tmp / "code"
        for proj in (self.gh / "alpha", self.gh / "beta", self.code / "gamma", self.code / "My Proj!"):
            (proj / "src").mkdir(parents=True)
            (proj / "src" / "a.md").write_text("one\n")
            git(proj, "init", "-q")
            commit_all(proj)
        (self.gh / "notgit").mkdir()
        (self.gh / "notgit" / "x.md").write_text("x\n")
        self.hermes = self.tmp / "hermes"
        (self.hermes / "skills").mkdir(parents=True)
        self.projects = discover_projects([str(self.gh), str(self.code)])
        self.log = self.tmp / "weft.log"
        os.environ.pop("HERMES_KANBAN_TASK", None)
        os.environ.pop("WEFT_HERMES_MODE", None)
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.gh / "alpha")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def scope(self, roots=()):
        return Scope(list(roots), projects=self.projects, project_dirs=[str(self.gh), str(self.code)],
                     excludes=[str(self.hermes)])

    def config(self, tokens, modes=None, **kw):
        return Config(url="http://fake", repo="", token="", agent="hermes-test", profile="test", roots=[],
                      log_path=self.log, tokens=tokens, modes=modes or {}, default_mode="advise",
                      project_dirs=[str(self.gh), str(self.code)], projects=self.projects,
                      excludes=[str(self.hermes)], analyzer=None, **kw)


class ResolutionTests(Workspace):
    def test_discovery_names_projects_and_skips_non_git(self):
        names = {os.path.basename(p): r for p, r in self.projects.items()}
        self.assertEqual(names, {"alpha": "alpha", "beta": "beta", "gamma": "gamma", "My Proj!": "My-Proj"})
        self.assertEqual(sanitize_repo(".hidden name"), "hidden-name")
        self.assertEqual(sanitize_repo("a" * 80), "a" * 64)

    def test_repo_worktree_and_external_worktree_resolve_to_the_project(self):
        s = self.scope()
        t = s.resolve(str(self.gh / "alpha" / "src" / "a.md"))
        self.assertEqual((t.repo, t.rel, t.worktree), ("alpha", "src/a.md", str(self.gh / "alpha")))
        wt = self.gh / "alpha" / ".worktrees" / "k1"
        git(self.gh / "alpha", "worktree", "add", "-q", str(wt))
        t = s.resolve(str(wt / "src" / "new.md"))
        self.assertEqual((t.repo, t.rel, t.worktree), ("alpha", "src/new.md", str(wt)))
        ext = self.tmp / "elsewhere" / "gamma-wt"
        git(self.code / "gamma", "worktree", "add", "-q", str(ext))
        t = s.resolve(str(ext / "src" / "a.md"))
        self.assertEqual((t.repo, t.rel, t.worktree), ("gamma", "src/a.md", str(ext)))
        self.assertEqual(s.locate_dir(str(ext / "src")), (str(ext), "gamma"))
        self.assertEqual(s.locate_dir(str(self.code / "gamma")), (str(self.code / "gamma"), "gamma"))

    def test_excluded_and_out_of_scope_paths(self):
        s = self.scope()
        self.assertIsNone(s.resolve(str(self.hermes / "skills" / "x.md")), "~/.hermes is never reported")
        self.assertIsNone(s.resolve(str(self.gh / "notgit" / "x.md")))
        self.assertIsNone(s.resolve(str(self.tmp / "loose.md")))
        for junk in ("node_modules/p/i.js", "dist/out.js", ".git/config", "build/x.o", ".next/a.js"):
            self.assertIsNone(s.resolve(str(self.gh / "alpha" / junk)), junk)
        # a git worktree of an excluded or unknown repo is not a project
        other = self.tmp / "other"
        (other / "f").mkdir(parents=True)
        (other / "f" / "x.md").write_text("x")
        git(other, "init", "-q")
        commit_all(other)
        git(other, "worktree", "add", "-q", str(self.tmp / "other-wt"))
        self.assertIsNone(s.resolve(str(self.tmp / "other-wt" / "f" / "x.md")))

    def test_explicit_root_overrides_discovery(self):
        s = self.scope([Root(str(self.gh / "beta"), "web/", "weft")])
        t = s.resolve(str(self.gh / "beta" / "src" / "a.md"))
        self.assertEqual((t.repo, t.rel), ("weft", "web/src/a.md"))


class RouterTests(Workspace):
    def router(self, tokens, modes=None):
        self.clients = {}

        def factory(cfg):
            c = self.clients[cfg.repo] = FakeClient()
            c.repo = cfg.repo
            return c
        return WeftRouter(self.config(tokens, modes), client_factory=factory, heartbeat=False)

    def edit(self, router, path, content, call_id):
        block = router.pre_tool_call(tool_name="write_file", args={"path": str(path), "content": content},
                                     tool_call_id=call_id)
        if block:
            return block
        path.write_text(content)
        router.post_tool_call(tool_name="write_file", args={}, tool_call_id=call_id)
        return None

    def test_one_session_per_repo_opened_lazily(self):
        r = self.router({"alpha": "ta", "gamma": "tg"})
        self.assertEqual(self.clients, {}, "nothing opened before the first in-scope edit")
        self.edit(r, self.gh / "alpha" / "src" / "a.md", "two\n", "c1")
        self.edit(r, self.code / "gamma" / "src" / "a.md", "two\n", "c2")
        self.edit(r, self.gh / "alpha" / "src" / "a.md", "three\n", "c3")
        self.assertTrue(r.flush(5))
        self.assertEqual(sorted(self.clients), ["alpha", "gamma"])
        self.assertEqual(len([c for c in self.clients["alpha"].calls if c[0] == "hello"]), 1)
        self.assertEqual([c[3]["files"] for c in self.clients["alpha"].submits("commit")], [["src/a.md"]] * 2)
        self.assertEqual(len(self.clients["gamma"].submits("commit")), 1)
        r.close()

    def test_unknown_project_is_a_noop_with_one_log_line(self):
        r = self.router({"alpha": "ta"})
        self.edit(r, self.gh / "beta" / "src" / "a.md", "two\n", "c1")
        self.edit(r, self.gh / "beta" / "src" / "a.md", "three\n", "c2")
        r.pre_tool_call(tool_name="terminal", args={"command": "ls", "workdir": str(self.gh / "beta")}, tool_call_id="t")
        r.post_tool_call(tool_name="terminal", args={}, tool_call_id="t")
        self.assertEqual(self.clients, {})
        lines = [l for l in self.log.read_text().splitlines() if "'beta'" in l]
        self.assertEqual(len(lines), 1, lines)

    def test_excluded_paths_send_nothing(self):
        r = self.router({"alpha": "ta"})
        self.edit(r, self.hermes / "skills" / "x.md", "x\n", "c1")
        self.assertEqual(self.clients, {})

    def test_per_repo_modes(self):
        r = self.router({"alpha": "ta", "gamma": "tg"}, modes={"alpha": "enforce"})
        reject = {"verdict": "reject", "diagnostics": [], "inbox": [], "context": "[weft error] conflict"}
        r.adapter_for("alpha").client.script["check"] = [dict(reject)]
        block = self.edit(r, self.gh / "alpha" / "src" / "a.md", "two\n", "c1")
        self.assertEqual(block["action"], "block", "enforce repo blocks on reject")
        r.adapter_for("gamma").client.script["check"] = [dict(reject)]
        r.adapter_for("gamma").client.script["commit"] = [dict(reject)]
        self.assertIsNone(self.edit(r, self.code / "gamma" / "src" / "a.md", "two\n", "c2"))
        self.assertEqual(r.adapter_for("gamma").cfg.mode, "advise")
        self.assertIsNone(r.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k"))
        self.assertTrue(r.flush(5))
        self.assertEqual(self.clients["gamma"].submits("check"), [])
        self.assertEqual(len(self.clients["gamma"].submits("commit")), 1)

    def test_advise_never_waits_on_a_slow_gateway(self):
        r = self.router({"alpha": "ta"})
        client = r.adapter_for("alpha").client
        real_hello = client.hello

        def slow_hello(*a, **k):
            time.sleep(1.5)
            return real_hello(*a, **k)
        client.hello = slow_hello
        t0 = time.monotonic()
        self.edit(r, self.gh / "alpha" / "src" / "a.md", "two\n", "c1")
        r.pre_tool_call(tool_name="terminal", args={"command": "echo", "workdir": str(self.gh / "alpha")}, tool_call_id="t")
        (self.gh / "alpha" / "src" / "b.md").write_text("b\n")
        r.post_tool_call(tool_name="terminal", args={}, tool_call_id="t")
        self.assertLess(time.monotonic() - t0, 1.0, "tool-call path must not wait for the gateway")
        self.assertTrue(r.flush(6))
        self.assertEqual(len(client.submits("commit")), 2)

    def test_config_load_multi_repo(self):
        p = self.tmp / "c.json"
        p.write_text(json.dumps({
            "url": "https://g", "repo": "weft", "mode": "enforce", "modes": {"alpha": "enforce"},
            "projects": {"dirs": [str(self.gh)], "repos": {str(self.gh / "alpha"): "alpha"}},
            "agents": {"money": {"agent": "hermes-money", "tokens": {"alpha": {"token": "ta", "token_id": "i"}}}}}))
        cfg = Config.load(p, profile="money")
        self.assertEqual((cfg.tokens, cfg.agent), ({"alpha": "ta"}, "hermes-money"))
        self.assertEqual((cfg.mode_for("alpha"), cfg.mode_for("weft"), cfg.mode_for("zzz")),
                         ("enforce", "enforce", "advise"))
        self.assertIsNone(cfg.for_repo("weft"), "no token for weft in this profile")
        self.assertEqual(cfg.for_repo("alpha").token, "ta")
        self.assertIsNone(Config.load(p, profile="nobody"))

    def test_candidate_mode_env_pins_repo_agent_change_task(self):
        p = self.tmp / "c.json"
        p.write_text(json.dumps({
            "url": "https://g", "repo": "weft", "modes": {"alpha": "enforce"},
            "projects": {"dirs": [str(self.gh)], "repos": {str(self.gh / "alpha"): "alpha"}},
            "agents": {"default": {"agent": "hermes-default", "tokens": {"weft": "tw", "alpha": "ta"}}}}))
        env = {"WEFT_HERMES_REPO": "alpha", "WEFT_HERMES_TOKEN": "cand", "WEFT_HERMES_AGENT": "hermes-t4-r1",
               "WEFT_HERMES_CHANGE": "chg_123", "WEFT_HERMES_TASK": "t_card", "WEFT_HERMES_TASK_TITLE": "Bulk discount"}
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            cfg = Config.load(p, profile="default")
            self.assertEqual((cfg.agent, cfg.tokens["alpha"], cfg.tokens["weft"]), ("hermes-t4-r1", "cand", "tw"))
            a = WeftAdapter(cfg.for_repo("alpha"), client=object(), analyzer=object(), heartbeat=False)
            self.assertEqual((a.change, a.task), ("chg_123", {"id": "t_card", "title": "Bulk discount"}))
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        cfg = Config.load(p, profile="default")
        self.assertEqual((cfg.agent, cfg.tokens["alpha"]), ("hermes-default", "ta"), "no env: profile config")


class Silent:
    """A TCP server that accepts and never answers (a hung gateway)."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.conns = []
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                c, _ = self.sock.accept()
                self.conns.append(c)
            except OSError:
                return

    def close(self):
        for c in self.conns:
            c.close()
        self.sock.close()


class BreakerTests(unittest.TestCase):
    def test_breaker_state_machine(self):
        now = [0.0]
        b = CircuitBreaker(cooldown=60, clock=lambda: now[0])
        b.before()
        b.failure()
        with self.assertRaises(WcpError) as e:
            b.before()
        self.assertEqual(e.exception.code, "circuit_open")
        now[0] = 61
        b.before()  # the single trial
        with self.assertRaises(WcpError):
            b.before()  # concurrent callers still fail fast during the trial
        b.success()
        b.before()
        self.assertFalse(b.is_open)

    def test_hung_gateway_costs_one_timeout_per_window(self):
        srv = Silent()
        try:
            client = WcpClient(f"http://127.0.0.1:{srv.port}", "t", "r", timeout=0.5,
                               breaker=CircuitBreaker(cooldown=60))
            t0 = time.monotonic()
            with self.assertRaises(WcpError) as first:
                client.heartbeat("s")
            self.assertEqual(first.exception.code, "transport")
            t1 = time.monotonic()
            for _ in range(20):
                with self.assertRaises(WcpError) as e:
                    client.submit("s", "commit", {"kind": "edit"})
                self.assertEqual(e.exception.code, "circuit_open")
            t2 = time.monotonic()
            self.assertGreaterEqual(t1 - t0, 0.4)
            self.assertLess(t2 - t1, 0.1, "open breaker answers without the network")
        finally:
            srv.close()

    def test_unreachable_gateway_fails_open_through_the_router(self):
        tmp = Path(tempfile.mkdtemp(prefix="weft-dead-")).resolve()
        try:
            proj = tmp / "github" / "alpha"
            (proj / "src").mkdir(parents=True)
            (proj / "src" / "a.md").write_text("1\n")
            git(proj, "init", "-q")
            commit_all(proj)
            srv = Silent()
            cfg = Config(url=f"http://127.0.0.1:{srv.port}", repo="", token="", agent="hermes-t", profile="t",
                         roots=[], log_path=tmp / "log", tokens={"alpha": "ta"}, timeout=0.5,
                         project_dirs=[str(tmp / "github")], projects={str(proj): "alpha"}, analyzer=None)
            r = WeftRouter(cfg, heartbeat=False)
            r.adapter_for("alpha").client.breaker = CircuitBreaker(60)
            durations = []
            for i in range(5):
                t0 = time.monotonic()
                args = {"path": str(proj / "src" / "a.md"), "content": f"{i}\n"}
                self.assertIsNone(r.pre_tool_call(tool_name="write_file", args=args, tool_call_id=f"c{i}"))
                (proj / "src" / "a.md").write_text(f"{i}\n")
                r.post_tool_call(tool_name="write_file", args=args, tool_call_id=f"c{i}")
                r.transform_tool_result(tool_name="write_file", result="ok")
                durations.append(time.monotonic() - t0)
            self.assertLess(max(durations), 0.2, durations)
            t0 = time.monotonic()
            r.close()
            self.assertLess(time.monotonic() - t0, 2.0, "exit flush is bounded and the breaker short-circuits")
            self.assertIn("failed open", (tmp / "log").read_text())
            srv.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
