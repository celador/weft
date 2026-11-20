"""A second Mac account: per-conversation attribution in one gateway process, cd-aware terminal
capture, configured project dirs + .weft/space.json reuse, url/public_url, --no-build, and
kanban worktrees joining the Claude Code adapter.

Run: python3 -m unittest discover -s tests -v   (from packages/adapters/hermes)
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG / "installer"))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(PKG / "plugin"))

from test_adapter import FakeClient, assert_schema_valid, git  # noqa: E402
from test_multirepo import Workspace, commit_all  # noqa: E402
from weft import worktrees  # noqa: E402
from weft.adapter import (  # noqa: E402
    ADAPTER_VERSION, Config, Scope, WeftRouter, bash_target_dir, discover_projects, space_repo,
)
from weft.wcp import PROTOCOL  # noqa: E402

CLAUDE_BUNDLE = PKG.parent / "claude-code" / "dist" / "weft-claude.mjs"


@contextlib.contextmanager
def env(**values):
    old = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def node() -> str:
    for c in ("/opt/homebrew/opt/node@24/bin/node", shutil.which("node") or ""):
        if c and os.path.exists(c):
            return c
    return "node"


# ------------------------------------------------------------------------------------------
# 1. per-conversation attribution in one long-lived process
# ------------------------------------------------------------------------------------------

class SessionAttributionTests(Workspace):
    def router(self, tokens=None):
        self.clients = []

        def factory(cfg):
            c = FakeClient()
            self.clients.append(c)
            return c
        return WeftRouter(self.config(tokens or {"alpha": "ta"}), client_factory=factory, heartbeat=False)

    def by_change(self):
        """{change: client} from each client's hello (one client per adapter)."""
        out = {}
        for c in self.clients:
            hellos = [x for x in c.calls if x[0] == "hello"]
            if hellos:
                out[hellos[0][4]] = c
        return out

    @staticmethod
    def ids(session, conversation=None, call=""):
        return {"session_id": session, "conversation_id": conversation or session, "task_id": session,
                "tool_call_id": call, "turn_id": "", "api_request_id": ""}

    def test_two_interleaved_chats_in_one_process_are_attributed_to_their_own_session(self):
        # The gateway process has ONE environment for every chat; the old adapter keyed the change
        # on it (whichever chat came first owned every later write).
        with env(HERMES_SESSION_ID="api_other_chat", HERMES_KANBAN_TASK=None):
            r = self.router()
            a_md, b_md = self.gh / "alpha" / "src" / "a.md", self.gh / "alpha" / "src" / "b.md"
            s1, s2 = self.ids("api_1700000001_aaaa1111", call="c1"), self.ids("api_1700000002_bbbb2222", call="c2")
            # interleaved: s1 pre, s2 pre, s2 post, s1 post
            self.assertIsNone(r.pre_tool_call(tool_name="write_file", args={"path": str(a_md), "content": "one-1\n"}, **s1))
            self.assertIsNone(r.pre_tool_call(tool_name="write_file", args={"path": str(b_md), "content": "two-2\n"}, **s2))
            b_md.write_text("two-2\n")
            r.post_tool_call(tool_name="write_file", args={}, **s2)
            a_md.write_text("one-1\n")
            r.post_tool_call(tool_name="write_file", args={}, **s1)
            self.assertTrue(r.flush(5))
            got = self.by_change()
            self.assertEqual(sorted(got), ["hermes-test/adhoc-api_1700000001_aaaa1111",
                                           "hermes-test/adhoc-api_1700000002_bbbb2222"])
            files = {ch: [s[3]["files"] for s in c.submits("commit")] for ch, c in got.items()}
            self.assertEqual(files["hermes-test/adhoc-api_1700000001_aaaa1111"], [["src/a.md"]])
            self.assertEqual(files["hermes-test/adhoc-api_1700000002_bbbb2222"], [["src/b.md"]])
            for c in got.values():  # the shapes the gateway receives stay valid WCP
                _, agent, caps, task, change = [x for x in c.calls if x[0] == "hello"][0]
                assert_schema_valid(self, "Hello", {"type": "hello", "protocol": PROTOCOL, "agent": agent,
                                                    "capabilities": caps, "task": task, "change": change})
                for _, _, mode, event, _, _ in c.submits():
                    assert_schema_valid(self, "Submit", {"type": "submit", "mode": mode, "event": event})
            r.close()

    def test_diagnostics_reach_only_their_own_chat_and_compression_keeps_the_change(self):
        with env(HERMES_KANBAN_TASK=None):
            r = self.router()
            a_md = self.gh / "alpha" / "src" / "a.md"
            s1, s2 = self.ids("sess-1", call="c1"), self.ids("sess-2", call="c2")
            r.pre_tool_call(tool_name="write_file", args={"path": str(a_md), "content": "x\n"}, **s1)
            r.adapter_for("alpha", "sess-1").client.script["commit"] = [
                {"verdict": "accept", "diagnostics": [], "inbox": [], "context": "[weft warning] for chat one"}]
            a_md.write_text("x\n")
            r.post_tool_call(tool_name="write_file", args={}, **s1)
            self.assertTrue(r.flush(5))
            r.pre_tool_call(tool_name="terminal", args={"command": "ls", "workdir": str(self.gh / "alpha")}, **s2)
            r.post_tool_call(tool_name="terminal", args={}, **s2)
            self.assertIsNone(r.transform_tool_result(tool_name="terminal", result="ok", **s2), "chat two sees nothing")
            # context compression: new physical session id, same conversation
            rotated = self.ids("sess-1-b", conversation="sess-1", call="c3")
            out = r.transform_tool_result(tool_name="write_file", result="ok", **rotated)
            self.assertIn("for chat one", out)
            a1 = r.adapter_for("alpha", "sess-1")
            self.assertEqual(len(r._live("sess-1")), 1)
            # hooks that only carry the physical session id find the conversation
            a1.cfg.mode = "enforce"
            a1.client.gate_results = [{"allow": False, "reason": "1 open", "open_errors": []}]
            block = r.pre_verify(session_id="sess-1-b")
            self.assertEqual(block["action"], "continue")
            gates = [c for c in r.adapter_for("alpha", "sess-2").client.calls if c[0] == "gate"]
            self.assertEqual(gates, [], "chat two's gate is not asked")
            r.session_finalized(session_id="sess-1-b")
            deadline = time.monotonic() + 5
            while ("bye", a1.session) not in a1.client.calls and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertIn(("bye", a1.session), a1.client.calls)
            self.assertEqual(r._live("sess-1"), [])
            self.assertEqual(len(r._live("sess-2")), 1)
            r.close()

    def test_kanban_worker_process_is_one_task_whatever_the_hook_ids(self):
        with env(HERMES_KANBAN_TASK="t_card1"):
            r = self.router()
            a_md = self.gh / "alpha" / "src" / "a.md"
            for i, sid in enumerate(("s-a", "s-b")):
                kw = self.ids(sid, call=f"k{i}")
                r.pre_tool_call(tool_name="write_file", args={"path": str(a_md), "content": f"{i}\n"}, **kw)
                a_md.write_text(f"{i}\n")
                r.post_tool_call(tool_name="write_file", args={}, **kw)
            self.assertTrue(r.flush(5))
            self.assertEqual(list(self.by_change()), ["hermes-test/t_card1"])
            self.assertEqual(len(self.clients[0].submits("commit")), 2)
            r.close()

    def test_idle_conversations_are_closed(self):
        with env(HERMES_KANBAN_TASK=None):
            now = [1000.0]
            r = self.router()
            r._clock = lambda: now[0]
            old = r.adapter_for("alpha", "old-chat")
            old.ensure_session()
            now[0] += 7 * 3600
            r.adapter_for("alpha", "new-chat")
            self.assertEqual([k for k in r.adapters], [("alpha", "new-chat")])
            deadline = time.monotonic() + 5
            while ("bye", old.session) not in old.client.calls and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertIn(("bye", old.session), old.client.calls)
            # the heartbeat loop of an idle conversation hands it back to the router
            quiet = r.adapter_for("alpha", "quiet-chat")
            self.assertIsNotNone(quiet.on_idle)
            self.assertIsNone(r.adapter_for("alpha", "").on_idle, "the process-wide adapter never idles out")
            quiet.ensure_session()
            self.assertFalse(quiet.on_idle(quiet), "just used: the router keeps it (rechecked under its lock)")
            self.assertIn(("alpha", "quiet-chat"), r.adapters)
            now[0] += 3 * 3600
            self.assertTrue(quiet.on_idle(quiet))
            self.assertNotIn(("alpha", "quiet-chat"), r.adapters)
            deadline = time.monotonic() + 5
            while ("bye", quiet.session) not in quiet.client.calls and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertIn(("bye", quiet.session), quiet.client.calls)
            r.close()


    def test_a_tool_call_in_flight_keeps_its_adapter_past_the_idle_time(self):
        with env(HERMES_KANBAN_TASK=None):
            now = [1000.0]
            r = self.router()
            r._clock = lambda: now[0]
            a_md = self.gh / "alpha" / "src" / "a.md"
            kw = self.ids("long-chat", call="build")
            r.pre_tool_call(tool_name="terminal", args={"command": "make", "workdir": str(self.gh / "alpha")}, **kw)
            a = r.adapter_for("alpha", "long-chat")
            a.ensure_session()
            now[0] += 3 * 3600  # a three-hour build
            self.assertFalse(a.on_idle(a), "a call in flight is not idle")
            r.adapter_for("alpha", "other-chat")  # eviction runs here too
            self.assertIn(("alpha", "long-chat"), r.adapters)
            a_md.write_text("built\n")
            r.post_tool_call(tool_name="terminal", args={}, **kw)
            self.assertTrue(r.flush(5))
            self.assertEqual([s[3]["files"] for s in a.client.submits("commit")], [["src/a.md"]])
            self.assertEqual(a.last_used, now[0], "the end of the call counts as use")
            r.close()

    def test_session_start_of_a_resumed_conversation_hands_its_base_to_the_conversation(self):
        # on_session_start carries only the physical session id. For a resumed (compressed)
        # conversation that id is not the conversation id the tool calls carry.
        with env(HERMES_KANBAN_TASK=None, HERMES_KANBAN_WORKSPACE=str(self.gh / "alpha")):
            r = self.router()
            r.session_started(session_id="phys-2", platform="cli")
            deadline = time.monotonic() + 5
            while not (r.adapters.get(("alpha", "phys-2")) and r.adapters[("alpha", "phys-2")].session) \
                    and time.monotonic() < deadline:
                time.sleep(0.02)
            early = r.adapters[("alpha", "phys-2")]
            early.base_seq = 7  # the log head when this session started
            a_md = self.gh / "alpha" / "src" / "a.md"
            kw = self.ids("phys-2", conversation="conv-1", call="c1")
            r.pre_tool_call(tool_name="write_file", args={"path": str(a_md), "content": "x\n"}, **kw)
            self.assertNotIn(("alpha", "phys-2"), r.adapters, "the start-time adapter does not linger")
            live = r.adapters[("alpha", "conv-1")]
            self.assertEqual(live.task["id"], "adhoc-conv-1")
            live.client.head = 12  # another agent's edit landed in between
            live.ensure_session()
            self.assertEqual(live.base_seq, 7, "the conversation keeps the base from session start")
            deadline = time.monotonic() + 5
            while ("bye", early.session) not in early.client.calls and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertIn(("bye", early.session), early.client.calls)
            # a brand-new conversation (session id == conversation id) keeps its start adapter
            r.session_started(session_id="fresh-1")
            fresh = r.adapters[("alpha", "fresh-1")]
            r.pre_tool_call(tool_name="write_file", args={"path": str(a_md), "content": "y\n"},
                            **self.ids("fresh-1", call="c2"))
            self.assertIs(r.adapters[("alpha", "fresh-1")], fresh)
            # finalize by physical id closes both keys
            r.session_started(session_id="phys-3")
            r.session_finalized(session_id="phys-3")
            self.assertNotIn(("alpha", "phys-3"), r.adapters)
            r.close()


# ------------------------------------------------------------------------------------------
# 6. terminal capture follows `cd <abs> &&` and `git -C <abs>`
# ------------------------------------------------------------------------------------------

class TerminalTargetTests(Workspace):
    def test_bash_target_dir_accepts_the_claude_adapter_forms_only(self):
        home = os.path.expanduser("~")
        cases = {
            "cd /a/b && rm x": "/a/b",
            "  cd '/a b/c' && ls": "/a b/c",
            'cd "/a/b" && ls': "/a/b",
            "cd ~/p && ls": os.path.join(home, "p"),
            "cd ~ && ls": home,
            "git -C /a/b status": "/a/b",
            "git -C /a --no-pager commit -m x": "/a",
            "git -C /a -c x=y commit": "/a",
            "git -c core.x=1 -C /a commit": "/a",
            "git -C /a/repo,backup commit": "/a/repo,backup",
            "cd '/x/O'\\''Brien/t' && rm f": "/x/O'Brien/t",
            "\n\ncd /x/t && rm f": "/x/t",
            "cd /a/b; rm x": None,          # not `&&`
            "cd rel && ls": None,           # relative
            "cd /a/../b && ls": None,       # `..`
            "cd $HOME/x && ls": None,       # variable
            "cd '~/x' && ls": None,         # quoted ~ is literal
            "ls && cd /a && rm x": None,    # not leading
            "git -C /a -C /b commit": None,   # a second -C is relative to the first
            None: None,
        }
        for cmd, want in cases.items():
            self.assertEqual(bash_target_dir(cmd), want, cmd)

    def setUp(self):
        super().setUp()
        self.alpha = self.gh / "alpha"
        self.wt = self.alpha / ".worktrees" / "t_2"
        git(self.alpha, "worktree", "add", "-q", "-b", "wt/t_2", str(self.wt))
        self.clients = []

        def factory(cfg):
            c = FakeClient()
            self.clients.append(c)
            return c
        self.r = WeftRouter(self.config({"alpha": "ta"}), client_factory=factory, heartbeat=False)

    def tearDown(self):
        self.r.close()
        super().tearDown()

    def run_terminal(self, command, call, apply, workdir=None):
        args = {"command": command, **({"workdir": workdir} if workdir else {})}
        self.assertIsNone(self.r.pre_tool_call(tool_name="terminal", args=args, tool_call_id=call))
        apply()
        self.r.post_tool_call(tool_name="terminal", args=args, tool_call_id=call)
        self.assertTrue(self.r.flush(5))
        return [s[3] for c in self.clients for s in c.submits("commit") if s[3].get("kind") == "edit"]

    def test_rm_in_another_worktree_via_cd_is_captured(self):
        # the session's cwd (HERMES_KANBAN_WORKSPACE) is the main checkout, the command cd's into t_2
        target = self.wt / "src" / "a.md"
        edits = self.run_terminal(f"cd {self.wt} && rm src/a.md", "t1", target.unlink)
        self.assertEqual([e["files"] for e in edits], [["src/a.md"]])
        self.assertIn("-one", edits[0]["diff"])
        self.assertTrue((self.alpha / "src" / "a.md").exists(), "the main checkout was not touched")

    def test_git_dash_c_target_is_captured(self):
        def apply():
            (self.wt / "src" / "a.md").write_text("changed\n")
        edits = self.run_terminal(f"git -C {self.wt} status && echo changed > {self.wt}/src/a.md", "t2", apply)
        self.assertEqual([e["files"] for e in edits], [["src/a.md"]])

    def test_git_dash_c_with_global_options_still_runs_the_commit_gate(self):
        # the session's cwd is out of scope; `git -C <in-scope worktree> --no-pager commit` must
        # still reach that worktree's adapter (gate + capture), not be skipped as out of scope
        scratch = self.tmp / "scratch"
        scratch.mkdir()
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(scratch)
        self.r.cfg.modes["alpha"] = "enforce"
        a = self.r.adapter_for("alpha", "")
        a.ensure_session()
        a.client.gate_results = [{"allow": False, "reason": "1 open", "open_errors": [{"key": "src/a.md#x"}]}] * 3
        for cmd in (f"git -C {self.wt} --no-pager commit -am x", f"git -C {self.wt} -c user.name=x commit -am x",
                    f"git -c user.name=x -C {self.wt} commit -am x"):
            block = self.r.pre_tool_call(tool_name="terminal", args={"command": cmd}, tool_call_id=f"g{cmd[-12:]}")
            self.assertIsNotNone(block, cmd)
            self.assertEqual(block["action"], "block", cmd)

    def test_unparsed_directory_changes_snapshot_every_named_path(self):
        # fail closed: spellings the parser does not accept still capture the in-scope worktree
        # the command names, besides the session's own directory
        scratch = self.tmp / "scratch"
        scratch.mkdir()
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(scratch)
        n = [0]
        for cmd in (f"cd {self.wt}; rm src/a.md", f"cd /tmp && cd {self.wt} && rm src/a.md",
                    f"pushd {self.wt} && rm src/a.md", f"git -C /tmp -C {self.wt} rm -q src/a.md",
                    f"(cd {self.wt} && rm src/a.md)", f"sh -c 'cd {self.wt} && rm src/a.md'"):
            target = self.wt / "src" / "a.md"
            target.write_text("one\n")
            git(self.wt, "checkout", "-q", "--", "src/a.md")
            before = len(self.run_terminal("true", f"noop{n[0]}", lambda: None))
            n[0] += 1
            edits = self.run_terminal(cmd, f"u{n[0]}", target.unlink)
            self.assertEqual([e["files"] for e in edits[before:]], [["src/a.md"]], cmd)
            git(self.wt, "checkout", "-q", "--", "src/a.md")

    def test_fail_closed_scan_keeps_quoted_paths_with_spaces_and_apostrophes_whole(self):
        odd = self.alpha / ".worktrees" / "O'Brien wt"
        git(self.alpha, "worktree", "add", "-q", "-b", "wt/odd", str(odd))
        scratch = self.tmp / "scratch"
        scratch.mkdir()
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(scratch)
        sq = "'" + str(odd).replace("'", "'\\''") + "'"
        n = 0
        for cmd in (f'pushd "{odd}"; rm src/a.md', f"cd x; cd {sq} && rm src/a.md",
                    "sh -c '" + f'cd "{odd}" && rm src/a.md'.replace("'", "'\\''") + "'", f"cd /tmp; rm {sq}/src/a.md",
                    f'git --work-tree="{odd}" status; rm "{odd}/src/a.md"'):
            target = odd / "src" / "a.md"
            n += 1
            before = len(self.run_terminal("true", f"q-noop{n}", lambda: None))
            edits = self.run_terminal(cmd, f"q{n}", target.unlink)
            self.assertEqual([e["files"] for e in edits[before:]], [["src/a.md"]], cmd)
            git(odd, "checkout", "-q", "--", "src/a.md")
        # and the commit gate runs for that worktree
        a = self.r.adapter_for("alpha", "")
        a.cfg.mode = "enforce"
        a.ensure_session()
        a.client.gate_results = [{"allow": False, "reason": "1 open", "open_errors": [{"key": "src/a.md#x"}]}] * 3
        block = self.r.pre_tool_call(tool_name="terminal", args={"command": f'cd "{odd}"; git commit -am x'},
                                     tool_call_id="q-commit")
        self.assertEqual((block or {}).get("action"), "block")

    def test_one_call_in_two_worktrees_reports_both(self):
        def apply():
            (self.alpha / "src" / "a.md").write_text("main\n")
            (self.wt / "src" / "a.md").write_text("wt\n")
        edits = self.run_terminal(f"cd {self.wt}; echo wt > src/a.md; echo main > {self.alpha}/src/a.md", "both",
                                  apply, workdir=str(self.alpha))
        self.assertEqual(sorted(json.dumps(e["files"]) for e in edits), [json.dumps(["src/a.md"])] * 2)
        self.assertEqual(len(self.clients), 1, "one repo, one adapter")

    def test_relative_cd_keeps_the_workdir(self):
        def apply():
            (self.wt / "src" / "a.md").write_text("rel\n")
        edits = self.run_terminal("cd src && echo rel > a.md", "t3", apply, workdir=str(self.wt))
        self.assertEqual([e["files"] for e in edits], [["src/a.md"]])


# ------------------------------------------------------------------------------------------
# 2. configured project dirs + .weft/space.json reuse (discovery side)
# ------------------------------------------------------------------------------------------

def make_checkout(path: Path, space_repo_name=None):
    (path / "src").mkdir(parents=True)
    (path / "src" / "a.md").write_text("one\n")
    git(path, "init", "-q")
    commit_all(path)
    if space_repo_name:
        (path / ".weft").mkdir()
        (path / ".weft" / "space.json").write_text(json.dumps(
            {"url": "http://127.0.0.1:7878", "space": "sp1234", "repo": space_repo_name, "name": path.name}))


class SpaceRepoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="weft-space-")).resolve()
        self.projects = self.tmp / "Projects"
        make_checkout(self.projects / "app", "sp1234-app")
        make_checkout(self.projects / "brain")
        (self.projects / "odd").mkdir()
        make_checkout(self.projects / "bad", "../escape")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_space_json_names_the_repo_and_never_a_bare_folder_repo(self):
        got = discover_projects([str(self.projects)])
        self.assertEqual({os.path.basename(p): r for p, r in got.items()},
                         {"app": "sp1234-app", "brain": "brain", "bad": "bad"})
        self.assertIsNone(space_repo(str(self.projects / "bad")), "an invalid repo name is ignored")
        # an unsynced project resolves the same way when the config already knows that repo
        scope = Scope([], projects={}, project_dirs=[str(self.projects)], known_repos=["sp1234-app"])
        t = scope.resolve(str(self.projects / "app" / "src" / "a.md"))
        self.assertEqual((t.repo, t.rel), ("sp1234-app", "src/a.md"))

    def test_a_trailing_newline_is_not_a_repo_name(self):
        (self.projects / "app" / ".weft" / "space.json").write_text(json.dumps({"repo": "sp1234-app\n"}))
        self.assertIsNone(space_repo(str(self.projects / "app")))
        self.assertEqual(discover_projects([str(self.projects)])[str(self.projects / "app")], "app")

    def test_the_checkout_cannot_pick_its_own_repo_or_mode(self):
        # `enforced` is an enforce repo the config knows; `docs` an advise one. An unsynced checkout
        # whose folder is a known enforce repo cannot switch itself to `docs` (advise) via its own
        # .weft/space.json, and a name the config does not know is never adopted.
        make_checkout(self.projects / "enforced", "docs")
        make_checkout(self.projects / "fresh", "sp9999-unknown")
        cfg = Config(url="http://fake", repo="", token="", agent="hermes-test", profile="test", roots=[],
                     tokens={"enforced": "te", "docs": "td"}, modes={"enforced": "enforce"},
                     default_mode="advise", project_dirs=[str(self.projects)], projects={})
        scope = cfg.scope()
        t = scope.resolve(str(self.projects / "enforced" / "src" / "a.md"))
        self.assertEqual(t.repo, "enforced")
        self.assertEqual(cfg.for_repo(t.repo).mode, "enforce")
        self.assertEqual(scope.resolve(str(self.projects / "fresh" / "src" / "a.md")).repo, "fresh")
        # a space.json that came with the repository's content (tracked) names nothing at install time
        git(self.projects / "brain", "add", "-f", ".")
        (self.projects / "brain" / ".weft").mkdir()
        (self.projects / "brain" / ".weft" / "space.json").write_text(json.dumps({"repo": "weft"}))
        git(self.projects / "brain", "add", "-f", ".weft/space.json")
        self.assertEqual(discover_projects([str(self.projects)])[str(self.projects / "brain")], "brain")
        # and the file never names a gateway: the plugin config's url is the only one used
        self.assertEqual(cfg.for_repo("docs").url, "http://fake")


# ------------------------------------------------------------------------------------------
# install.py: --project-dirs / projects.dirs, --url / --public-url, plugin presence, --no-build
# ------------------------------------------------------------------------------------------

class FakeGateway:
    """In-memory admin API for install.py (admin_call is patched to this)."""

    def __init__(self, repos=(), admin="admin-secret"):
        self.repos = set(repos)
        self.admin = admin
        self.calls = []
        self.n = 0

    def __call__(self, url, admin, method, path, body=None):
        self.calls.append((url, method, path, body))
        if admin != self.admin:
            return 401, {"error": "unauthorized"}
        if (method, path) == ("GET", "/v1/admin/repos"):
            return 200, {"repos": [{"repo": r} for r in sorted(self.repos)]}
        if (method, path) == ("POST", "/v1/admin/repos"):
            created = body["repo"] not in self.repos
            self.repos.add(body["repo"])
            return (201 if created else 200), {"created": created}
        if (method, path) == ("POST", "/v1/admin/tokens"):
            self.n += 1
            return 201, {"token": f"tok{self.n}", "info": {"id": f"id{self.n}"}}
        if method == "DELETE":
            return 204, None
        return 404, None

    def created(self):
        return [b["repo"] for _, m, p, b in self.calls if (m, p) == ("POST", "/v1/admin/repos")]


class InstallerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="weft-install-")).resolve()
        self.weft_dir = self.tmp / "weftcfg"
        self.weft_dir.mkdir()
        (self.weft_dir / "preview-admin-token").write_text("admin-secret\n")
        self.projects = self.tmp / "Projects"
        make_checkout(self.projects / "app", "sp1234-app")
        make_checkout(self.projects / "brain")
        sys.path.insert(0, str(PKG / "scripts"))
        self.addCleanup(sys.path.remove, str(PKG / "scripts"))
        import install  # noqa: WPS433
        self.install = install
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(env(WEFT_CONFIG_DIR=str(self.weft_dir), HERMES_REAL_HOME=str(self.tmp / "home")))
        stack.enter_context(mock.patch.object(install, "CONFIG", self.weft_dir / "hermes-adapter.json"))
        stack.enter_context(mock.patch.object(install, "DEFAULT_ADMIN", str(self.weft_dir / "preview-admin-token")))
        stack.enter_context(mock.patch.object(install, "node_bin", return_value="/usr/bin/node-test"))
        self.gw = FakeGateway(repos={"sp1234-app"})
        stack.enter_context(mock.patch.object(install, "admin_call", self.gw))
        stack.enter_context(mock.patch.object(install, "healthy", return_value=False))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_main(self, *argv):
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["install.py", "--profiles", "default", *argv]), \
                contextlib.redirect_stdout(out):
            self.install.main()
        return out.getvalue()

    def cfg(self):
        return json.loads(self.install.CONFIG.read_text())


class InstallProjectDirsTests(InstallerCase):
    def test_project_dirs_are_saved_absolute_reused_and_space_repos_reused(self):
        self.run_main("--sync", "--url", "http://127.0.0.1:7878", "--project-dirs", str(self.projects))
        cfg = self.cfg()
        self.assertEqual(cfg["projects"]["dirs"], [str(self.projects)])
        self.assertEqual(cfg["projects"]["repos"], {str(self.projects / "app"): "sp1234-app",
                                                    str(self.projects / "brain"): "brain"})
        self.assertEqual(self.gw.created(), ["brain"], "no bare `app` repo: the space's repo is reused")
        self.assertEqual(sorted(cfg["agents"]["default"]["tokens"]), ["brain", "sp1234-app"])
        # a later sync without --project-dirs keeps ~/Projects (the old default would have pruned it)
        make_checkout(self.projects / "third")
        out = self.run_main("--sync")
        cfg = self.cfg()
        self.assertEqual(cfg["projects"]["dirs"], [str(self.projects)])
        self.assertIn(str(self.projects / "third"), cfg["projects"]["repos"])
        self.assertNotIn("prune:", out)
        self.assertEqual(sorted(cfg["agents"]["default"]["tokens"]), ["brain", "sp1234-app", "third"])

    def test_tilde_dirs_are_expanded(self):
        with env(HOME=str(self.tmp)):
            args = SimpleNamespace(project_dirs="~/Projects, ~/Projects")
            self.assertEqual(self.install.resolve_dirs(args, {}), [str(self.tmp / "Projects")])
            args.project_dirs = None
            self.assertEqual(self.install.resolve_dirs(args, {"projects": {"dirs": ["~/Projects"]}}),
                             [str(self.tmp / "Projects")])


class InstallUrlTests(InstallerCase):
    TAILNET = "https://box.tailnet.example:8710"
    LOOP = "http://127.0.0.1:7878"

    def test_url_and_public_url_split_keeps_tokens_and_rekeys_the_human_token(self):
        # the old workaround's shape: url = the tailnet address, tokens minted for that gateway
        self.run_main("--sync", "--url", self.TAILNET, "--project-dirs", str(self.projects))
        before = self.cfg()["agents"]["default"]["tokens"]
        (self.weft_dir / "otto-human-token.json").write_text(json.dumps({"url": self.LOOP, "token": "human-x"}))
        out = self.run_main("--sync", "--url", self.LOOP, "--public-url", self.TAILNET)
        cfg = self.cfg()
        self.assertEqual((cfg["url"], cfg["public_url"]), (self.LOOP, self.TAILNET))
        self.assertEqual(cfg["agents"]["default"]["tokens"], before, "same gateway: tokens kept")
        self.assertIn("same gateway: tokens kept", out)
        human = json.loads((self.weft_dir / "otto-human-token.json").read_text())
        self.assertEqual(human, {"url": self.TAILNET, "token": "human-x"}, "keyed on public_url or url")
        self.assertEqual(stat.S_IMODE((self.weft_dir / "otto-human-token.json").stat().st_mode), 0o600)
        self.assertNotIn("human-x", out)
        # a run without the flags keeps both
        self.run_main("--sync")
        self.assertEqual((self.cfg()["url"], self.cfg()["public_url"]), (self.LOOP, self.TAILNET))
        # the plugin reports through `url`; WEFT_HERMES_URL still overrides it
        cfg_obj = Config.load(self.install.CONFIG, profile="default")
        self.assertEqual(cfg_obj.url, self.LOOP)
        with env(WEFT_HERMES_URL="http://127.0.0.1:9999"):
            self.assertEqual(Config.load(self.install.CONFIG, profile="default").url, "http://127.0.0.1:9999")
        # '' removes public_url
        self.run_main("--sync", "--public-url", "")
        self.assertNotIn("public_url", self.cfg())

    def test_the_weft_hermes_url_workaround_migrates_to_url_and_public_url(self):
        # before: url = the tailnet address, ~/.hermes/.env WEFT_HERMES_URL = loopback
        self.run_main("--sync", "--url", self.TAILNET, "--project-dirs", str(self.projects))
        before = self.cfg()["agents"]["default"]["tokens"]
        envfile = self.tmp / "home" / ".hermes" / ".env"
        envfile.parent.mkdir(parents=True, exist_ok=True)
        envfile.write_text("OTHER_SECRET=s3cret\nexport WEFT_HERMES_URL='http://127.0.0.1:7878/'\n")
        with env(WEFT_HERMES_URL=None), mock.patch.object(self.install, "healthy", return_value=True):
            out = self.run_main("--sync")
        cfg = self.cfg()
        self.assertEqual((cfg["url"], cfg["public_url"]), (self.LOOP, self.TAILNET))
        self.assertEqual(cfg["agents"]["default"]["tokens"], before)
        self.assertIn("the WEFT_HERMES_URL line can go", out)
        self.assertNotIn("s3cret", out)
        # an unreachable override is not adopted
        self.run_main("--sync", "--url", self.TAILNET, "--public-url", "")
        with env(WEFT_HERMES_URL=None):
            self.run_main("--sync")
        self.assertEqual(self.cfg()["url"], self.TAILNET)

    def test_another_gateway_drops_tokens_and_leaves_the_human_token(self):
        self.run_main("--sync", "--url", self.LOOP, "--project-dirs", str(self.projects))
        (self.weft_dir / "otto-human-token.json").write_text(json.dumps({"url": self.LOOP, "token": "h"}))
        out = self.run_main("--sync", "--url", "https://elsewhere.example")
        self.assertIn("existing tokens are dropped", out)
        self.assertEqual(json.loads((self.weft_dir / "otto-human-token.json").read_text())["url"], self.LOOP)

    def test_loopback_url_uses_the_local_gateway_admin_token(self):
        (self.weft_dir / "local").mkdir()
        (self.weft_dir / "local" / "admin-token").write_text("local-admin\n")
        self.gw.admin = "local-admin"
        self.run_main("--sync", "--url", self.LOOP, "--project-dirs", str(self.projects))
        self.assertEqual(self.cfg()["url"], self.LOOP)

    def test_no_url_prefers_a_running_local_gateway(self):
        (self.weft_dir / "local").mkdir()
        (self.weft_dir / "local" / "admin-token").write_text("local-admin\n")
        (self.weft_dir / "local" / "port").write_text("7999\n")
        self.gw.admin = "local-admin"
        with mock.patch.object(self.install, "healthy", return_value=True), \
                mock.patch.object(self.install, "listener_uids", return_value={os.getuid()}):
            out = self.run_main("--sync", "--project-dirs", str(self.projects))
        self.assertEqual(self.cfg()["url"], "http://127.0.0.1:7999")
        self.assertIn("local Weft gateway", out)

    def test_a_loopback_listener_of_another_user_is_not_the_local_gateway(self):
        # the real gateway is down and another account bound its port, answering /v1/health
        (self.weft_dir / "local").mkdir()
        (self.weft_dir / "local" / "admin-token").write_text("local-admin\n")
        (self.weft_dir / "local" / "port").write_text("7999\n")
        self.install._ADMIN_TARGETS.clear()
        with mock.patch.object(self.install, "healthy", return_value=True), \
                mock.patch.object(self.install, "listener_uids", return_value={os.getuid() + 1}):
            self.assertIsNone(self.install.local_gateway())
            self.assertIn("another user", self.install.admin_target_refusal("http://127.0.0.1:7999"))
        self.install._ADMIN_TARGETS.clear()
        with mock.patch.object(self.install, "listener_uids", return_value=set()):
            self.assertIn("no process of yours", self.install.admin_target_refusal("http://localhost:7999"))
        self.install._ADMIN_TARGETS.clear()
        with mock.patch.object(self.install, "listener_uids", return_value=None):
            self.assertIn("cannot tell", self.install.admin_target_refusal("http://[::1]:7999"))
        self.install._ADMIN_TARGETS.clear()
        self.assertIsNone(self.install.admin_target_refusal("https://gateway.example"), "not loopback: not checked")

    def test_local_admin_token_only_for_the_local_gateway_port(self):
        (self.weft_dir / "local").mkdir()
        (self.weft_dir / "local" / "admin-token").write_text("local-admin\n")
        for url, want in (("http://127.0.0.1:7878", "local"), ("http://127.0.0.1:9999", "preview")):
            args = SimpleNamespace(url=url, public_url=None, admin_token_file=None)
            self.install.resolve_gateway(args, {})
            self.assertIn("local" if want == "local" else "preview-admin-token", args.admin_token_file, url)

    def test_host_case_is_the_same_gateway(self):
        self.run_main("--sync", "--url", "https://Box.Tailnet.Example:8710", "--project-dirs", str(self.projects))
        before = self.cfg()["agents"]["default"]["tokens"]
        self.assertEqual(self.cfg()["url"], self.TAILNET, "saved normalized")
        out = self.run_main("--sync", "--url", "HTTPS://box.tailnet.example:8710/")
        self.assertNotIn("existing tokens are dropped", out)
        self.assertEqual(self.cfg()["agents"]["default"]["tokens"], before)
        self.assertTrue(self.install.has_land_token(self.cfg(), "https://BOX.tailnet.example:8710", "brain"))

    def test_plugin_presence_is_recorded_without_secrets(self):
        self.run_main("--sync", "--url", self.LOOP, "--project-dirs", str(self.projects))
        self.install.record_plugin(["default", "coder"])
        p = self.cfg()["plugin"]
        self.assertEqual((p["installed"], p["version"], p["profiles"]), (True, ADAPTER_VERSION, ["coder", "default"]))
        self.install.record_plugin([], ["coder"])
        self.assertEqual(self.cfg()["plugin"]["profiles"], ["default"])
        self.install.record_plugin([], ["default"])
        self.assertFalse(self.cfg()["plugin"]["installed"])
        self.assertNotIn("tok", json.dumps(self.cfg()["plugin"]))


FAKE_BUNDLE = r"""
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  process.stdout.write(JSON.stringify({ ok: true, files: [{ writes: ["a.ts#a", "b.py#b"] }] }) + "\n");
});
"""
FAKE_BUILD = r"""
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const out = process.argv[2];
mkdirSync(dirname(out) + "/grammars", { recursive: true });
writeFileSync(out, %s);
writeFileSync(dirname(out) + "/grammars/x.wasm", "");
""" % json.dumps(FAKE_BUNDLE)


class AdminCallGuardTests(unittest.TestCase):
    """The real admin_call (InstallerCase patches it out)."""

    def setUp(self):
        sys.path.insert(0, str(PKG / "scripts"))
        self.addCleanup(sys.path.remove, str(PKG / "scripts"))
        import install  # noqa: WPS433
        self.install = install
        install._ADMIN_TARGETS.clear()
        self.addCleanup(install._ADMIN_TARGETS.clear)

    def test_admin_token_is_never_sent_to_a_loopback_port_another_user_holds(self):
        sent = []
        with mock.patch.object(self.install.urllib.request, "urlopen", lambda *a, **k: sent.append(a)), \
                mock.patch.object(self.install, "listener_uids", return_value={0, os.getuid()}), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            status, body = self.install.admin_call("http://127.0.0.1:7878", "ADMIN-SECRET", "GET", "/v1/admin/repos")
        self.assertEqual((status, sent), (0, []))
        self.assertIn("admin token not sent", body["error"])
        self.assertIn("another user", err.getvalue())
        self.assertNotIn("ADMIN-SECRET", err.getvalue() + json.dumps(body))

    def test_a_listener_of_this_user_passes(self):
        import socket
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        self.addCleanup(srv.close)
        url = f"http://127.0.0.1:{srv.getsockname()[1]}"
        self.assertEqual(self.install.listener_uids(srv.getsockname()[1]), {os.getuid()})
        self.assertIsNone(self.install.admin_target_refusal(url))

    def test_url_normalization_and_loopback_spellings(self):
        n, lo = self.install.norm_url, self.install.is_loopback
        self.assertEqual(n(" HTTPS://Box.Example:8710/Path/ "), "https://box.example:8710/Path")
        self.assertEqual(n("http://User@HOST"), "http://User@host")
        self.assertEqual(n(None), "")
        for u in ("http://127.0.0.2:7878", "http://[0:0:0:0:0:0:0:1]:7878", "http://[::1]:1", "http://LOCALHOST"):
            self.assertTrue(lo(u), u)
        for u in ("http://localhost.example", "http://10.0.0.1", "https://box.example", "not a url"):
            self.assertFalse(lo(u), u)


class InstallBuildTests(InstallerCase):
    def setUp(self):
        super().setUp()
        self.pkg = self.tmp / "pkg"  # a package copy owned by "another account": read-only
        (self.pkg / "scripts").mkdir(parents=True)
        (self.pkg / "scripts" / "build.mjs").write_text(FAKE_BUILD)
        (self.pkg / "dist" / "grammars").mkdir(parents=True)
        (self.pkg / "dist" / "analyze.mjs").write_text(FAKE_BUNDLE)
        self.addCleanup(lambda: [os.chmod(p, 0o755) for p in (self.pkg / "dist", self.pkg) if p.exists()])
        mock.patch.object(self.install, "PKG", self.pkg).start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(self.install, "node_bin", return_value=node()).start()

    def test_no_build_probes_and_uses_the_existing_bundle(self):
        runs = []
        real = subprocess.run

        def spy(cmd, *a, **k):
            runs.append(cmd)
            return real(cmd, *a, **k)
        with mock.patch.object(self.install.subprocess, "run", spy), contextlib.redirect_stdout(io.StringIO()):
            bundle = self.install.bundle_for(SimpleNamespace(no_build=True, build_dir=None))
        self.assertEqual(bundle, self.pkg / "dist" / "analyze.mjs")
        self.assertFalse(any("build.mjs" in " ".join(map(str, c)) for c in runs), "nothing was built")
        self.assertTrue(any(str(bundle) in map(str, c) for c in runs), "the bundle was probed")

    def test_no_build_without_a_bundle_says_how_to_build_one(self):
        (self.pkg / "dist" / "analyze.mjs").unlink()
        with self.assertRaises(SystemExit) as ctx:
            self.install.bundle_for(SimpleNamespace(no_build=True, build_dir=None))
        self.assertIn("no analyzer bundle", str(ctx.exception))

    def test_read_only_package_builds_into_a_temp_dir(self):
        os.chmod(self.pkg / "dist", 0o555)
        os.chmod(self.pkg, 0o555)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            bundle = self.install.bundle_for(SimpleNamespace(no_build=False, build_dir=None))
        self.assertNotEqual(bundle.parent, self.pkg / "dist")
        self.assertTrue(bundle.is_file() and (bundle.parent / "grammars").is_dir())
        self.assertIn("not writable", out.getvalue())
        shutil.rmtree(bundle.parent, ignore_errors=True)

    def test_build_dir_is_used(self):
        target = self.tmp / "out"
        with contextlib.redirect_stdout(io.StringIO()):
            bundle = self.install.bundle_for(SimpleNamespace(no_build=False, build_dir=str(target)))
        self.assertEqual(bundle, target / "analyze.mjs")


# ------------------------------------------------------------------------------------------
# 5. kanban worktrees join the Claude Code adapter (on_kanban_worker_spawned)
# ------------------------------------------------------------------------------------------

FAKE_ADAPTER = r"""
// Stand-in for weft-claude.mjs `install`: records its argv and environment, writes the config,
// copies --token-from (unless FAKE_OLD_RUNTIME, which predates the flag).
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, weftToken: process.env.WEFT_TOKEN ?? null }) + "\n");
const dir = arg("dir");
mkdirSync(dir + "/.weft", { recursive: true });
writeFileSync(dir + "/.weft/claude.json", JSON.stringify({ url: arg("url"), repo: arg("repo"), agent: arg("agent"), task: { id: arg("task") }, tokenFile: arg("token-file") ?? ".weft/token" }));
if (arg("token-from") && !process.env.FAKE_OLD_RUNTIME) writeFileSync(dir + "/.weft/token", readFileSync(arg("token-from"), "utf8"), { mode: 0o600 });
"""


class WorktreeJoinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="weft-join-")).resolve()
        self.main = self.tmp / "Projects" / "app"
        make_checkout(self.main, "sp1234-app")
        self.adapter = self.tmp / "runtime" / "weft-claude.mjs"
        self.adapter.parent.mkdir()
        self.adapter.write_text(FAKE_ADAPTER)
        (self.main / ".weft" / "bin").mkdir(parents=True)
        (self.main / ".weft" / "bin" / "weft").write_text(
            f"#!/bin/sh\n# weft-claude: Weft CLI\nexec {node()} '{self.adapter}' \"$@\"\n")
        (self.main / ".weft" / "claude.json").write_text(json.dumps(
            {"url": "http://127.0.0.1:7878", "repo": "sp1234-app", "agent": "app", "task": {"id": "T-main"},
             "change": "Imain", "mode": "advise", "tokenFile": ".weft/token"}))
        (self.main / ".weft" / "token").write_text("main-token\n")
        self.wt = self.main / ".worktrees" / "t_abc123"
        git(self.main, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "wt/t_abc123", str(self.wt))
        self.log_file = self.tmp / "fake.log"
        self.lines = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def calls(self):
        return [json.loads(x) for x in self.log_file.read_text().splitlines()] if self.log_file.exists() else []

    def test_worker_spawn_joins_the_worktree_with_the_kanban_task(self):
        with env(FAKE_LOG=str(self.log_file), WEFT_TOKEN="must-not-leak"):
            worktrees.on_worker_spawned(self.lines.append, wait=True, task_id="t_abc123", workspace_path=str(self.wt),
                                        board="b", assignee="default", run_id=1, worker_pid=1, profile_name="default")
        (call,) = self.calls()
        a = call["args"]
        self.assertEqual(a[:3], ["install", "--dir", str(self.wt)])
        for k, v in (("--url", "http://127.0.0.1:7878"), ("--repo", "sp1234-app"), ("--agent", "app"),
                     ("--task", "t_abc123"), ("--mode", "advise"), ("--token-from", str(self.main / ".weft" / "token"))):
            self.assertEqual(a[a.index(k) + 1], v, k)
        self.assertIsNone(call["weftToken"], "the token never travels through the environment")
        self.assertEqual((self.wt / ".weft" / "token").read_text(), "main-token\n")
        self.assertEqual(len(self.lines), 1)
        self.assertIn("joined", self.lines[0])
        self.assertNotIn("main-token", self.lines[0])
        # a second spawn for the same task is a no-op
        with env(FAKE_LOG=str(self.log_file)):
            self.assertIsNone(worktrees.join_worktree(str(self.wt), "t_abc123", self.lines.append))
        self.assertEqual(len(self.calls()), 1)

    def test_old_runtime_falls_back_to_the_main_token_file(self):
        with env(FAKE_LOG=str(self.log_file), FAKE_OLD_RUNTIME="1"):
            worktrees.join_worktree(str(self.wt), "t_abc123", self.lines.append)
        first, second = self.calls()
        self.assertIn("--token-from", first["args"])
        self.assertEqual(second["args"][second["args"].index("--token-file") + 1], str(self.main / ".weft" / "token"))
        self.assertFalse((self.wt / ".weft" / "token").exists())

    def test_a_runtime_that_rejects_token_from_gets_the_token_file_retry(self):
        calls = []

        def fake_run(args, **kw):
            calls.append(args)
            if "--token-from" in args:
                return SimpleNamespace(returncode=2, stdout="", stderr="unknown option --token-from")
            cfg = {"url": "u", "repo": "sp1234-app", "agent": "app", "task": {"id": "t_abc123"}}
            (self.wt / ".weft").mkdir(exist_ok=True)
            (self.wt / ".weft" / "claude.json").write_text(json.dumps(cfg))
            return SimpleNamespace(returncode=0, stdout="installed", stderr="")
        msg = worktrees.join_worktree(str(self.wt), "t_abc123", self.lines.append, run=fake_run)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][calls[1].index("--token-file") + 1], str(self.main / ".weft" / "token"))
        self.assertIn("joined", msg)
        # both attempts failing reports both reasons
        calls.clear()
        msg = worktrees.join_worktree(str(self.wt), "t_other1", self.lines.append,
                                      run=lambda a, **k: SimpleNamespace(returncode=1, stdout="", stderr="nope"))
        self.assertIn("--token-from: nope; --token-file: nope", msg)

    def test_task_ids_and_configs_are_validated_strictly(self):
        self.assertEqual(worktrees.plan_join(str(self.wt), "t_abc123\n")["skip"], "no usable task id")
        (self.wt / ".weft").mkdir()
        (self.wt / ".weft" / "claude.json").write_text(json.dumps({"task": "t_abc123"}))  # not a dict
        self.assertNotIn("skip", worktrees.plan_join(str(self.wt), "t_abc123"))

    def test_nothing_to_join(self):
        self.assertEqual(worktrees.plan_join(str(self.main), "t_1")["skip"], "not a linked git worktree")
        scratch = self.tmp / "scratch"
        scratch.mkdir()
        self.assertEqual(worktrees.plan_join(str(scratch), "t_1")["skip"], "not a linked git worktree")
        self.assertEqual(worktrees.plan_join(str(self.wt), "bad id!")["skip"], "no usable task id")
        (self.main / ".weft" / "claude.json").unlink()
        self.assertIn("no Claude Code adapter", worktrees.plan_join(str(self.wt), "t_1")["skip"])
        self.assertIsNone(worktrees.join_worktree(str(self.wt), "t_1", self.lines.append))
        self.assertEqual(self.lines, [])

    def test_a_launcher_that_came_with_the_repo_is_never_run(self):
        git(self.main, "add", "-f", ".weft/bin/weft")
        self.assertIn(".weft/ in git", worktrees.plan_join(str(self.wt), "t_abc123")["skip"])
        git(self.main, "rm", "-q", "--cached", ".weft/bin/weft")
        self.assertNotIn("skip", worktrees.plan_join(str(self.wt), "t_abc123"))
        # the launcher must exec node on an .mjs file
        (self.main / ".weft" / "bin" / "weft").write_text(f"#!/bin/sh\nexec /bin/sh '{self.adapter}' \"$@\"\n")
        self.assertIn("no .weft/bin/weft launcher", worktrees.plan_join(str(self.wt), "t_abc123")["skip"])

    def test_plugin_registers_the_spawn_hook(self):
        import weft
        hooks = {}

        class Ctx:
            def get_config(self, key, default=None):
                return default

            def set_config(self, key, value):
                pass

            def register_tool(self, **kwargs):
                pass

            def register_command(self, *args, **kwargs):
                pass

            def register_hook(self, name, fn):
                hooks[name] = fn
        weft.register(Ctx())
        self.assertIn("on_kanban_worker_spawned", hooks)
        self.assertIn("on_session_finalize", hooks)
        plugin_yaml = (PKG / "plugin" / "weft" / "plugin.yaml").read_text()
        self.assertIn("- on_kanban_worker_spawned", plugin_yaml)

    @unittest.skipUnless(CLAUDE_BUNDLE.exists(), "claude-code dist/weft-claude.mjs not built")
    def test_real_claude_adapter_joins_and_commits_carry_the_worktree_task(self):
        home = self.tmp / "weft-home"
        e = dict(os.environ, WEFT_HOME=str(home), WEFT_TOKEN="main-token")
        main = self.tmp / "real"
        make_checkout(main)
        subprocess.run([node(), str(CLAUDE_BUNDLE), "install", "--url", "http://127.0.0.1:9", "--repo", "sp1234-real",
                        "--agent", "real", "--task", "T-main"], cwd=main, env=e, check=True, capture_output=True)
        wt = main / ".worktrees" / "t_def456"
        git(main, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "wt/t_def456", str(wt))
        with env(WEFT_HOME=str(home), WEFT_TOKEN=None):
            msg = worktrees.join_worktree(str(wt), "t_def456", self.lines.append)
        self.assertIn("joined", msg)
        cfg = json.loads((wt / ".weft" / "claude.json").read_text())
        self.assertEqual((cfg["repo"], cfg["agent"], cfg["task"]["id"]), ("sp1234-real", "real", "t_def456"))
        self.assertEqual((wt / ".weft" / "token").read_text().strip(), "main-token")
        (wt / "n.txt").write_text("n\n")
        git(wt, "add", "n.txt")
        git(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "wt work")
        body = subprocess.run(["git", "-C", str(wt), "log", "-1", "--format=%B"], capture_output=True, text=True).stdout
        self.assertIn(f"Change-Id: {cfg['change']}\nTask-Id: t_def456\nAgent-Id: real", body)


if __name__ == "__main__":
    unittest.main()
