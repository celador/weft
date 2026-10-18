"""Unit tests for scripts/weft_land.py (no network): branch/task mapping, land decision, CAS retry."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import weft_land as wl  # noqa: E402


def ev(seq, kind, status="accepted", change="hermes-default/t_aaaaaaaa"):
    return {"seq": seq, "kind": kind, "status": status, "change": change}


class Mapping(unittest.TestCase):
    def test_branch_from_merge_subject(self):
        self.assertEqual(wl.branch_from_subject("Merge branch 'wt/b2'"), "wt/b2")
        self.assertEqual(wl.branch_from_subject("Merge branch 'wt/b2' into wt/b16"), "wt/b2")
        self.assertEqual(wl.branch_from_subject("Merge remote-tracking branch 'origin/wt/x'"), "wt/x")
        self.assertIsNone(wl.branch_from_subject("pm: log 2026-10-04"))

    def test_tasks_from_messages_tags_and_trailers(self):
        text = ("sequencer: DO [t_1c24a8fd]\n\nbody\n\nadapters: x [t_573911b1]\n\n"
                "fix\n\nKanban-Task: t_4ea09be8\n\nagain [t_1c24a8fd]\nmention t_deadbeef in prose\n")
        self.assertEqual(wl.tasks_from_messages(text), ["t_1c24a8fd", "t_573911b1", "t_4ea09be8"])

    def test_tasks_from_branch(self):
        self.assertEqual(wl.tasks_from_branch("wt/t_f81b1eaa"), ["t_f81b1eaa"])
        self.assertEqual(wl.tasks_from_branch("wt/b16"), [])

    def test_tasks_from_kanban(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "kanban.db"
            con = sqlite3.connect(db)
            con.execute("CREATE TABLE tasks (id TEXT, created_at INTEGER, workspace_path TEXT, branch_name TEXT)")
            con.executemany("INSERT INTO tasks VALUES (?,?,?,?)", [
                ("t_00000001", 1, "/r/.worktrees/b16-land", "wt/t_00000001"),  # renamed branch: path match
                ("t_00000002", 2, "/r/.worktrees/b16", "wt/b16"),
                ("t_00000003", 3, "/r/.worktrees/b4", "wt/b4"),
            ])
            con.commit()
            con.close()
            self.assertEqual(wl.tasks_from_kanban(db, "wt/b16-land"), ["t_00000001"])
            self.assertEqual(wl.tasks_from_kanban(db, "wt/b16"), ["t_00000002"])
            self.assertEqual(wl.tasks_from_kanban(db, "wt/nope"), [])
            self.assertEqual(wl.tasks_from_kanban(Path(d) / "missing.db", "wt/b4"), [])

    def test_op_id_is_stable(self):
        self.assertEqual(wl.op_id("weft", "c", "abc"), wl.op_id("weft", "c", "abc"))
        self.assertNotEqual(wl.op_id("weft", "c", "abc"), wl.op_id("weft", "c", "abd"))


class Decision(unittest.TestCase):
    def test_no_edits(self):
        self.assertEqual(wl.land_decision([ev(1, "join"), ev(2, "checkpoint")])[0], "skip")

    def test_edits_land(self):
        self.assertEqual(wl.land_decision([ev(1, "join"), ev(3, "edit"), ev(4, "leave")])[0], "land")

    def test_rejected_edits_do_not_count(self):
        self.assertEqual(wl.land_decision([ev(3, "edit", status="rejected")])[0], "skip")

    def test_already_landed(self):
        d, why = wl.land_decision([ev(3, "edit"), ev(9, "land")])
        self.assertEqual(d, "skip")
        self.assertIn("#9", why)

    def test_rejected_land_does_not_count(self):
        self.assertEqual(wl.land_decision([ev(3, "edit"), ev(9, "land", status="rejected")])[0], "land")

    def test_reopened_after_land(self):
        self.assertEqual(wl.land_decision([ev(3, "edit"), ev(9, "land"), ev(12, "claim")])[0], "land")


class FakeGateway(wl.Gateway):
    def __init__(self, replies):
        super().__init__("http://x", "tok", "weft")
        self.replies = list(replies)
        self.heads = iter(range(10, 100, 5))
        self.drafts = []

    def head(self):
        return next(self.heads)

    def land(self, draft):
        self.drafts.append(draft)
        return self.replies.pop(0)


class Retry(unittest.TestCase):
    def test_accept_first_try(self):
        gw = FakeGateway([(200, {"status": "accepted", "seq": 11})])
        out, rec = wl.post_land(gw, "hermes-default/t_a", "sha1", sleep=lambda s: None)
        self.assertEqual(out, "landed")
        d = gw.drafts[0]
        self.assertEqual((d["kind"], d["base_seq"], d["change"]), ("land", 10, "hermes-default/t_a"))
        self.assertEqual(d["payload"]["sha"], "sha1")
        self.assertEqual(d["payload"]["op_id"], wl.op_id("weft", "hermes-default/t_a", "sha1"))

    def test_r1_rejection_logged_and_retried_on_fresh_head(self):
        logs = []
        gw = FakeGateway([
            (200, {"status": "rejected", "seq": 11, "diagnostics": [{"code": "stale_overwrite", "symbol": "a.ts#f", "caused_by_seq": 10}]}),
            (200, {"status": "accepted", "seq": 17}),
        ])
        out, rec = wl.post_land(gw, "c", "sha", sleep=lambda s: None, log=logs.append)
        self.assertEqual(out, "landed")
        self.assertEqual([d["base_seq"] for d in gw.drafts], [10, 15])
        self.assertEqual(logs[0]["event"], "land_rejected")
        self.assertIn("stale_overwrite a.ts#f (#10)", logs[0]["diagnostics"])

    def test_gives_up_after_retries(self):
        rej = (200, {"status": "rejected", "seq": 1, "diagnostics": []})
        gw = FakeGateway([rej] * 4)
        out, _ = wl.post_land(gw, "c", "sha", retries=3, sleep=lambda s: None)
        self.assertEqual(out, "rejected")
        self.assertEqual(len(gw.drafts), 4)

    def test_unknown_change(self):
        gw = FakeGateway([(400, {"error": {"code": "invalid_reference", "message": "unknown change c"}})])
        self.assertEqual(wl.post_land(gw, "c", "sha", sleep=lambda s: None)[0], "unknown_change")

    def test_forbidden_is_not_retried(self):
        gw = FakeGateway([(403, {"error": {"code": "forbidden", "message": "token lacks scope system"}})])
        self.assertEqual(wl.post_land(gw, "c", "sha", sleep=lambda s: None)[0], "http_403")
        self.assertEqual(len(gw.drafts), 1)


class TrunkAndTokens(unittest.TestCase):
    def test_trunk_ref_recorded_in_land_payload(self):
        gw = FakeGateway([(200, {"status": "accepted", "seq": 11})])
        wl.post_land(gw, "c", "sha1", sleep=lambda s: None, trunk_ref=wl.trunk_ref_of("rebrand/otto"))
        self.assertEqual(gw.drafts[0]["payload"]["trunk_ref"], "refs/heads/rebrand/otto")
        self.assertIsNone(wl.trunk_ref_of(None))
        self.assertEqual(wl.trunk_ref_of("refs/heads/main"), "refs/heads/main")

    def test_no_trunk_ref_by_default(self):
        gw = FakeGateway([(200, {"status": "accepted", "seq": 11})])
        wl.post_land(gw, "c", "sha1", sleep=lambda s: None)
        self.assertNotIn("trunk_ref", gw.drafts[0]["payload"])

    def test_tokens_are_kept_per_repo(self):
        u = "https://gw"
        cfg = {"land": {"url": u, "repo": "weft", "token": "W"},
               "land_tokens": {"hermes-ios": {"url": u, "repo": "hermes-ios", "token": "H"}}}
        self.assertEqual(wl.cached_token(cfg, u, "weft"), "W")         # legacy entry still read
        self.assertEqual(wl.cached_token(cfg, u, "hermes-ios"), "H")
        self.assertIsNone(wl.cached_token(cfg, u, "other"))
        self.assertIsNone(wl.cached_token(cfg, "https://elsewhere", "hermes-ios"))

    def test_note_install_is_a_changeless_system_checkpoint(self):
        class GW:
            repo = "hermes-ios"
            def __init__(self):
                self.posts = []
            def head(self):
                return 41
            def call(self, method, path, body=None):
                self.posts.append((method, path, body))
                return 200, {"status": "accepted", "seq": 42}
        gw = GW()
        status, rec = wl.note_install(gw, "abc1234", "refs/heads/rebrand/otto", {"build": "87", "target": "mac"})
        self.assertEqual((status, rec["seq"]), (200, 42))
        method, path, body = gw.posts[0]
        self.assertEqual((method, path), ("POST", "/v1/repos/hermes-ios/system/events"))
        self.assertEqual(body["kind"], "checkpoint")
        self.assertNotIn("change", body)
        self.assertEqual(body["base_seq"], 41)
        self.assertEqual(body["payload"], {"sha": "abc1234", "ref": "refs/heads/rebrand/otto",
                                           "x_install": {"build": "87", "target": "mac"}})


class Git(unittest.TestCase):
    def test_merge_info_collects_merged_commit_messages(self):
        with tempfile.TemporaryDirectory() as d:
            r = Path(d)

            def g(*a):
                subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=r, check=True,
                               capture_output=True)
            g("init", "-q", "-b", "main")
            (r / "a").write_text("1")
            g("add", "-A"); g("commit", "-qm", "init")
            g("checkout", "-qb", "wt/b9")
            (r / "a").write_text("2")
            g("commit", "-qam", "x: one [t_11111111]")
            (r / "b").write_text("3")
            g("add", "-A"); g("commit", "-qm", "x: two\n\nKanban-Task: t_22222222")
            g("checkout", "-q", "main")
            (r / "c").write_text("4")
            g("add", "-A"); g("commit", "-qm", "pm: log [t_99999999]")  # on main, not merged in
            g("merge", "--no-ff", "--no-edit", "wt/b9")
            info = wl.merge_info(r, "main")
            self.assertTrue(info["merge"])
            self.assertEqual(info["branch"], "wt/b9")
            self.assertEqual(wl.tasks_from_messages(info["messages"]), ["t_11111111", "t_22222222"])
            self.assertEqual(len(wl.recent_merges(r, "main", 5)), 1)


if __name__ == "__main__":
    unittest.main()
