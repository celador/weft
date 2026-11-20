"""Terminal capture by structure, not by spelling.

A terminal call is captured in every worktree it NAMES (parsed leading ``cd``/``git -C``, workdir,
literal paths), every worktree its conversation worked in before (whatever the command says), and,
when the call is OPAQUE (a variable, ``$(...)``, an unparsed directory change, inline code, a
bound hit, ``execute_code``), every worktree of every repo the conversation works in plus every
project whose folder name the call mentions. A change in a worktree that another live session
worked in during the call is left to that session's own capture (never reported twice).

Run: python3 -m unittest discover -s tests -v   (from packages/adapters/hermes)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "installer"))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "plugin"))

from test_adapter import FakeClient, git  # noqa: E402
from test_multirepo import Workspace, commit_all  # noqa: E402
from test_second_account import env  # noqa: E402
from weft import adapter as weft_adapter  # noqa: E402
from weft.adapter import (  # noqa: E402
    MAX_COMMAND_PATHS, MAX_COMMAND_WORDS, MAX_SNAPSHOT_TEXTS, WeftRouter, scan_code, scan_command,
)


class ScanTests(unittest.TestCase):
    def test_literal_commands_are_not_opaque_and_name_their_paths(self):
        for cmd in ("ls", "rm -f /etc/hosts.x", "git status && pnpm -r test", "echo 'a b' > /tmp/x",
                    "cd /tmp && rm x", "python3 script.py", "sed -i s/a/b/ src/a.md", "git log main..HEAD",
                    "git add src/*.py", "cp x{,.bak}", "grep -e foo -r ."):
            self.assertEqual(scan_command(cmd, "/tmp", "/tmp" if cmd.startswith("cd ") else None).opaque, "", cmd)
        self.assertIn("/etc", scan_command("rm -f /etc/hosts.x").dirs)
        self.assertIn("/tmp", scan_command("echo x > /tmp/nope/deeper").dirs, "deepest existing ancestor")

    def test_anything_unresolved_is_opaque(self):
        cases = {
            "rm ${HOME:-/x}/a": "expands",
            "rm ${HOME:=/x}/a": "expands",
            "WT=/a; rm $WT/x": "expands",
            "rm \"$(git rev-parse --show-toplevel)/x\"": "expands",
            "rm `pwd`/x": "expands",
            "rm '$literal'": "expands",          # over-approximation: costs a wider snapshot only
            "rm ~other/x": "another user",
            "rm ../t_2/x": "walks up",
            "rm /a/.worktrees/*/x": "globs",
            "cd x; rm y": "changes directory",
            "cd /a && cd /b && rm y": "changes directory",
            "pushd /a && rm x": "changes directory",
            "make -C /a": "changes directory",
            "python3 -c 'open(1)'": "inline code",
            "node -e 'x'": "inline code",
            "python3 - <<EOF\nx\nEOF": "inline code",
            "eval \"rm x\"": "runs code",
            "ls | xargs rm": "runs code",
            "cd /a && . ./env.sh": "runs code",
            "echo \"unbalanced": "unbalanced",
            "echo " + "x " * (MAX_COMMAND_WORDS + 1): f"more than {MAX_COMMAND_WORDS} words",
        }
        for cmd, why in cases.items():
            target = "/a" if cmd.startswith("cd /a &&") else None
            self.assertIn(why, scan_command(cmd, "/tmp", target).opaque, cmd)
        self.assertEqual(scan_code("print(1)").opaque, "runs code")

    def test_nothing_is_truncated(self):
        words = " ".join(["x"] * (MAX_COMMAND_WORDS + 10))
        scan = scan_command(f"echo {words}; rm /etc/hosts.x")
        self.assertIn("/etc", scan.dirs, "a path past the word bound is still scanned")
        root = Path(tempfile.mkdtemp(prefix="weft-scan-"))
        self.addCleanup(shutil.rmtree, root, True)
        for i in range(MAX_COMMAND_PATHS + 5):
            (root / f"n{i}").mkdir()
        many = " ".join(f"{root}/n{i}/f" for i in range(MAX_COMMAND_PATHS + 5))
        scan = scan_command(f"ls /usr/bin {many}")
        self.assertIn(f"more than {MAX_COMMAND_PATHS} directories", scan.opaque)
        self.assertIn("alpha", scan_command(f"ls {many} /x/github/alpha/src").names,
                      "folder names past the path bound still reach the opaque capture")


class StructuralCaptureTests(Workspace):
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
        self.r = WeftRouter(self.config({"alpha": "ta", "beta": "tb"}), client_factory=factory, heartbeat=False)
        self.scratch = self.tmp / "scratch"
        self.scratch.mkdir()
        self.n = 0

    def tearDown(self):
        self.r.close()
        super().tearDown()

    def call(self, command, apply=lambda: None, tool="terminal", session=None, workdir=None):
        self.n += 1
        kw = {"tool_call_id": f"c{self.n}"}
        if session:
            kw.update(session_id=session, conversation_id=session, task_id=session)
        key = "code" if tool == "execute_code" else "command"
        args = {key: command, **({"workdir": workdir} if workdir else {})}
        self.assertIsNone(self.r.pre_tool_call(tool_name=tool, args=args, **kw))
        apply()
        self.r.post_tool_call(tool_name=tool, args=args, **kw)
        self.assertTrue(self.r.flush(5))

    def edits(self):
        return [(s[3]["files"], s[3]["diff"]) for c in self.clients for s in c.submits("commit")
                if s[3].get("kind") == "edit"]

    def rm(self, wt=None):
        target = (wt or self.wt) / "src" / "a.md"
        return target.unlink

    def restore(self, wt=None):
        git(wt or self.wt, "checkout", "-q", "--", "src/a.md")

    # -- MergeSafe P1: variable spellings ----------------------------------------------------

    def test_variable_spellings_are_captured_in_the_sessions_repo(self):
        # session dir = alpha's main checkout (HERMES_KANBAN_WORKSPACE): every alpha worktree is
        # snapshotted around an opaque call, whatever the variable expands to
        cases = ("cd /tmp; rm ${HOME:-/x}/github/alpha/.worktrees/t_2/src/a.md",
                 "cd /tmp; rm ${HOME:=/x}/github/alpha/.worktrees/t_2/src/a.md",
                 "WT=$PWD/.worktrees/t_2; rm $WT/src/a.md",
                 'rm "$(git rev-parse --show-toplevel)/.worktrees/t_2/src/a.md"',
                 "for d in .worktrees/*; do rm $d/src/a.md; done",
                 "rm ../alpha/.worktrees/t_2/src/a.md",
                 "python3 -c 'import os; os.remove(\".worktrees/t_2/src/a.md\")'")
        with env(HOME=str(self.tmp)):
            for cmd in cases:
                before = len(self.edits())
                self.call(cmd, self.rm())
                self.assertEqual([f for f, _ in self.edits()[before:]], [["src/a.md"]], cmd)
                self.restore()

    def test_variable_spellings_reach_a_repo_the_session_never_touched_by_its_folder_name(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)  # out of scope, nothing touched
        with env(HOME=str(self.tmp)):
            for cmd in ("cd /tmp; rm ${HOME:-/x}/github/alpha/.worktrees/t_2/src/a.md",
                        "P=github; rm ~/$P/alpha/.worktrees/t_2/src/a.md"):
                before = len(self.edits())
                self.call(cmd, self.rm())
                self.assertEqual([f for f, _ in self.edits()[before:]], [["src/a.md"]], cmd)
                self.restore()

    def test_execute_code_is_captured(self):
        def apply():
            (self.wt / "src" / "a.md").write_text("by code\n")
        self.call("import pathlib; pathlib.Path('.worktrees/t_2/src/a.md').write_text('by code')",
                  apply, tool="execute_code")
        self.assertEqual([f for f, _ in self.edits()], [["src/a.md"]])
        self.assertIn("+by code", self.edits()[0][1])

    # -- the session's own worktrees, whatever the command ------------------------------------

    def test_own_worktrees_are_compared_around_every_call(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)
        self.call(f"cd {self.wt} && git status")  # the session now works in t_2
        before = len(self.edits())

        def apply():  # a script run from elsewhere edits t_2 without naming it
            (self.wt / "src" / "a.md").write_text("from a script\n")
        self.call("sh build.sh", apply, workdir=str(self.scratch))
        self.assertEqual([f for f, _ in self.edits()[before:]], [["src/a.md"]])

    # -- MergeSafe P3: bounds ------------------------------------------------------------------

    def test_bounds_make_a_call_opaque_instead_of_dropping_paths(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)
        for i in range(MAX_COMMAND_PATHS + 5):
            (self.scratch / f"n{i}").mkdir()
        noise = " ".join(str(self.scratch / f"n{i}") for i in range(MAX_COMMAND_PATHS + 5))
        words = " ".join(["x"] * (MAX_COMMAND_WORDS + 10))
        for cmd in (f"cd /tmp; echo {words}; rm {self.wt}/src/a.md",
                    f"ls {noise}; rm {self.wt}/src/a.md"):
            before = len(self.edits())
            self.call(cmd, self.rm())
            self.assertEqual([f for f, _ in self.edits()[before:]], [["src/a.md"]], cmd[:40])
            self.restore()

    def test_snapshot_detects_changes_past_the_text_bound(self):
        junk = self.wt / "junk"
        junk.mkdir()
        for i in range(MAX_SNAPSHOT_TEXTS + 20):
            (junk / f"f{i:04}.md").write_text(f"{i}\n")
        last = junk / f"f{MAX_SNAPSHOT_TEXTS + 19:04}.md"  # dirty, but no text kept for it

        def apply():
            (self.wt / "zz.md").write_text("new past the bound\n")
            last.write_text("changed\n")
        self.call(f"cd {self.wt} && make", apply)
        files = [f for fs, _ in self.edits() for f in fs]
        self.assertIn("zz.md", files)
        self.assertIn(f"junk/{last.name}", files, "a change to a dirty file whose text was not kept")
        self.assertIn("+changed", "".join(d for _, d in self.edits()))
        self.assertEqual(len(files), 2, files)

    # -- the commit gate -----------------------------------------------------------------------

    def test_opaque_commit_runs_the_gate_for_every_repo_of_the_conversation(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)
        self.r.cfg.modes["alpha"] = "enforce"
        self.call(f"cd {self.wt} && git status")
        a = self.r.adapter_for("alpha", "")
        a.ensure_session()
        a.client.gate_results = [{"allow": False, "reason": "1 open", "open_errors": [{"key": "src/a.md#x"}]}] * 3
        for cmd in ("G=git; $G commit -am x", "cd /tmp; ${GIT:-git} -C ${WT} commit -am x"):
            block = self.r.pre_tool_call(tool_name="terminal", args={"command": cmd}, tool_call_id=f"g{cmd[:6]}")
            self.assertEqual((block or {}).get("action"), "block", cmd)
        self.assertEqual(a.pending, {}, "a blocked call leaves no snapshot behind")

    # -- never twice: another live session's worktree ---------------------------------------------

    def test_a_change_in_a_worktree_another_session_works_in_is_left_to_that_session(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)
        r = self.r
        b_args = {"command": f"cd {self.wt} && pnpm test"}
        # chat B starts a long call in t_2 ...
        self.assertIsNone(r.pre_tool_call(tool_name="terminal", args=b_args, tool_call_id="b1",
                                          session_id="B", conversation_id="B", task_id="B"))
        # ... chat A runs an opaque command meanwhile, and t_2 changes during it
        def apply():
            (self.wt / "src" / "a.md").write_text("written during both calls\n")
        with env(HOME=str(self.tmp)):
            self.call("rm -f ${HOME:-/x}/github/alpha/.worktrees/t_2/nothing", apply, session="A")
        self.assertEqual(self.edits(), [], "A does not claim it")
        r.post_tool_call(tool_name="terminal", args=b_args, tool_call_id="b1",
                         session_id="B", conversation_id="B", task_id="B")
        self.assertTrue(r.flush(5))
        b = r.adapters[("alpha", "B")]
        self.assertEqual([s[3]["files"] for s in b.client.submits("commit")], [["src/a.md"]], "B reports it once")
        self.assertEqual(len(self.edits()), 1)
        # B idle again: a change during A's next opaque call is A's
        time.sleep(0.01)
        before = len(self.edits())
        with env(HOME=str(self.tmp)):
            self.call("rm ${HOME:-/x}/github/alpha/.worktrees/t_2/src/a.md", self.rm(), session="A")
        mine = r.adapters[("alpha", "A")]
        self.assertEqual([s[3]["files"] for s in mine.client.submits("commit")], [["src/a.md"]])
        self.assertEqual(len(self.edits()), before + 1)

    def test_another_sessions_edit_window_covers_only_its_file(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)
        r = self.r
        f, g = self.wt / "src" / "a.md", self.wt / "src" / "g.md"
        b_kw = {"session_id": "B", "conversation_id": "B", "task_id": "B", "tool_call_id": "bw"}
        b_args = {"path": str(f), "content": "B's edit\n"}
        self.assertIsNone(r.pre_tool_call(tool_name="write_file", args=b_args, **b_kw))

        def apply():  # B's write_file lands during A's call, and A's command writes g
            f.write_text("B's edit\n")
            g.write_text("A's file\n")
        with env(HOME=str(self.tmp)):
            self.call("echo x > ${HOME:-/x}/github/alpha/.worktrees/t_2/src/g.md", apply, session="A")
        r.post_tool_call(tool_name="write_file", args=b_args, **b_kw)
        self.assertTrue(r.flush(5))
        by = {k[1]: [s[3]["files"] for s in a.client.submits("commit")] for k, a in r.adapters.items()}
        self.assertEqual(by["A"], [["src/g.md"]], "A reports its own file only")
        self.assertEqual(by["B"], [["src/a.md"]], "B reports its edit; nobody reports it twice")

    def test_another_processs_session_is_read_from_its_status_file(self):
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)
        status_dir = self.tmp / "status"
        status_dir.mkdir(exist_ok=True)
        other = {"v": 1, "pid": os.getppid(), "change": "hermes-other/t_x", "updated_at": time.time(),
                 "ended": False, "worktrees": {str(self.wt): {"runs": [[time.time() - 5, None]], "edits": []}}}
        (status_dir / "other-1.json").write_text(json.dumps(other))
        with env(HOME=str(self.tmp)):
            self.call("rm ${HOME:-/x}/github/alpha/.worktrees/t_2/src/a.md", self.rm())
        self.assertEqual(self.edits(), [], "left to the other process's session, whose capture covers it")
        self.restore()
        other["worktrees"][str(self.wt)]["runs"] = [[time.time() - 5, time.time() - 4]]  # ended before
        (status_dir / "other-1.json").write_text(json.dumps(other))
        with env(HOME=str(self.tmp)):
            self.call("rm ${HOME:-/x}/github/alpha/.worktrees/t_2/src/a.md", self.rm())
        self.assertEqual([f for f, _ in self.edits()], [["src/a.md"]], "idle elsewhere: this call's change")

    # -- cost -----------------------------------------------------------------------------------

    def test_opaque_capture_snapshots_worktrees_in_parallel(self):
        for i in range(6):
            git(self.alpha, "worktree", "add", "-q", "-b", f"wt/p{i}", str(self.alpha / ".worktrees" / f"p{i}"))
        a = self.r.adapter_for("alpha", "")
        self.assertEqual(len(a.repo_worktrees()), 8)
        seen = []
        real = weft_adapter.dirty_snapshot

        def slow(wt, texts=True):
            seen.append(wt)
            time.sleep(0.2)
            return real(wt, texts)
        weft_adapter.dirty_snapshot = slow
        try:
            t0 = time.monotonic()
            self.assertIsNone(self.r.pre_tool_call(tool_name="terminal", args={"command": "echo $X"},
                                                   tool_call_id="par"))
            took = time.monotonic() - t0
        finally:
            weft_adapter.dirty_snapshot = real
        self.r.post_tool_call(tool_name="terminal", args={}, tool_call_id="par")
        self.assertEqual(len(seen), 8)
        self.assertLess(took, 8 * 0.2 * 0.6, f"8 snapshots of 0.2 s took {took:.2f} s")


if __name__ == "__main__":
    unittest.main()
