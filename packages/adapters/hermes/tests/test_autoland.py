"""Auto-land (plugin/weft/land.py + the adapter's HEAD/trunk watch): trunk detection, merge and
fast-forward landings, idempotency, no land for unmerged work, fail-open on gateway errors."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "plugin" / "weft"))
sys.path.insert(0, str(HERE))

import land as L  # noqa: E402
from adapter import Config, Root, WeftAdapter, WeftRouter  # noqa: E402
from test_adapter import FakeClient  # noqa: E402

REPO = "proj"
CHANGE = "hermes-default/t_aaaaaaaa"


def g(cwd, *args) -> str:
    return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


def commit(cwd, name, text="x\n", msg=None) -> str:
    Path(cwd, name).write_text(text)
    g(cwd, "add", "-A")
    g(cwd, "commit", "-qm", msg or f"add {name}")
    return g(cwd, "rev-parse", "HEAD")


def new_repo(root: Path, branch: str = "master") -> Path:
    r = root / REPO
    r.mkdir(parents=True)
    g(r, "init", "-q", "-b", branch)
    commit(r, "README.md", "hi\n", "init")
    return r


class FakeGW(L.Gateway):
    """In-memory gateway log: GET events (kind/change filters) + POST system land."""

    def __init__(self, records=None, repo=REPO):
        super().__init__("http://fake", "sys", repo)
        self.log = []
        self.posts = []
        self.fail = None
        for r in records or []:
            self.add(**r)

    def add(self, kind, change=CHANGE, payload=None, status="accepted", ts=None):
        seq = len(self.log) + 1
        self.log.append({"seq": seq, "kind": kind, "change": change, "status": status, "payload": payload or {},
                         "ts": ts or time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())})
        return seq

    def events(self, start=0, **filters):
        if self.fail:
            raise L.GatewayError(self.fail)
        kinds = set((filters.get("kind") or "").split(",")) - {""}
        return [e for e in self.log if e["seq"] > start and (not kinds or e["kind"] in kinds)], len(self.log)

    def head(self):
        if self.fail:
            raise L.GatewayError(self.fail)
        return len(self.log)

    def land(self, draft):
        self.posts.append(draft)
        if self.fail:
            return 0, {"error": {"code": "transport", "message": self.fail}}
        seq = self.add("land", draft["change"], draft["payload"])
        return 200, {"status": "accepted", "seq": seq, "writes": []}


def work_history(gw: FakeGW, shas, x_work=True, change=CHANGE):
    gw.add("edit", change)
    for s in shas:
        gw.add("checkpoint", change, {"sha": s, "x_work": x_work})


class TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="weft-autoland-")).resolve()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TrunkDetection(TmpCase):
    def test_main(self):
        r = new_repo(self.tmp, "main")
        self.assertEqual(L.detect_trunk(r), "main")
        self.assertEqual(list(L.trunk_tips(r, "main")), ["refs/heads/main"])

    def test_master(self):
        r = new_repo(self.tmp, "master")
        g(r, "branch", "feature")
        self.assertEqual(L.detect_trunk(r), "master")

    def test_custom_default_branch_from_origin_head(self):
        upstream = new_repo(self.tmp / "up", "develop")
        clone = self.tmp / "clone"
        subprocess.run(["git", "clone", "-q", str(upstream), str(clone)], check=True, capture_output=True)
        self.assertEqual(g(clone, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/develop")
        g(clone, "branch", "main")  # a stray main must not win over origin/HEAD
        self.assertEqual(L.detect_trunk(clone), "develop")
        tips = L.trunk_tips(clone, "develop")
        self.assertEqual(set(tips), {"refs/heads/develop", "refs/remotes/origin/develop"})

    def test_override_and_none(self):
        r = new_repo(self.tmp, "trunk")
        self.assertIsNone(L.detect_trunk(r))
        self.assertEqual(L.detect_trunk(r, "refs/heads/trunk"), "trunk")
        self.assertEqual(L.trunk_tips(r, None), {})


class Landing(TmpCase):
    def setUp(self):
        super().setUp()
        self.r = new_repo(self.tmp)

    def test_merge_commit(self):
        g(self.r, "checkout", "-qb", "milestone-2")
        s1 = commit(self.r, "a.txt")
        s2 = commit(self.r, "b.txt")
        g(self.r, "checkout", "-q", "master")
        commit(self.r, "other.txt")
        g(self.r, "merge", "-q", "--no-ff", "milestone-2", "-m", "Merge milestone 2")
        m = g(self.r, "rev-parse", "HEAD")
        commit(self.r, "later.txt")
        tip = g(self.r, "rev-parse", "master")
        self.assertEqual(L.landing_commit(self.r, s1, tip), m)
        self.assertEqual(L.landing_commit(self.r, s2, tip), m)

    def test_fast_forward(self):
        g(self.r, "checkout", "-qb", "graphql")
        s1 = commit(self.r, "a.txt")
        s2 = commit(self.r, "b.txt")
        g(self.r, "checkout", "-q", "master")
        g(self.r, "merge", "-q", "--ff-only", "graphql")
        tip = g(self.r, "rev-parse", "master")
        self.assertEqual(L.landing_commit(self.r, s2, tip), s2)
        self.assertEqual(L.landing_commit(self.r, s1, tip), s1)

    def test_unmerged(self):
        g(self.r, "checkout", "-qb", "wip")
        s = commit(self.r, "a.txt")
        self.assertIsNone(L.landing_commit(self.r, s, g(self.r, "rev-parse", "master")))
        self.assertIsNone(L.find_landing(self.r, s, L.trunk_tips(self.r, "master")))

    def test_rebase_then_merge_is_found_by_patch_equivalence(self):
        g(self.r, "checkout", "-qb", "card")
        s = commit(self.r, "a.txt")
        g(self.r, "checkout", "-q", "master")
        commit(self.r, "other.txt")
        g(self.r, "checkout", "-q", "card")
        g(self.r, "rebase", "-q", "master")
        g(self.r, "checkout", "-q", "master")
        g(self.r, "merge", "-q", "--no-ff", "card", "-m", "Merge card")
        m = g(self.r, "rev-parse", "HEAD")
        self.assertIsNone(L.landing_commit(self.r, s, m))  # the original commit is not on trunk
        self.assertEqual(L.find_landing(self.r, s, L.trunk_tips(self.r, "master")), (m, "refs/heads/master"))


class Sweep(TmpCase):
    def setUp(self):
        super().setUp()
        self.r = new_repo(self.tmp)

    def merged_branch(self, ff=False):
        g(self.r, "checkout", "-qb", "milestone-2")
        s = commit(self.r, "a.txt")
        g(self.r, "checkout", "-q", "master")
        if ff:
            g(self.r, "merge", "-q", "--ff-only", "milestone-2")
        else:
            g(self.r, "merge", "-q", "--no-ff", "milestone-2", "-m", "Merge")
        return s, g(self.r, "rev-parse", "master")

    def test_merge_commit_lands_once_with_stable_op_id(self):
        s, m = self.merged_branch()
        gw = FakeGW()
        work_history(gw, [s])
        out = L.sweep(gw, REPO, self.r, state={})
        self.assertEqual([(x["change"], x["result"], x["sha"]) for x in out], [(CHANGE, "landed", m)])
        p = gw.posts[0]
        self.assertEqual(p["payload"], {"sha": m, "op_id": L.op_id(REPO, CHANGE, m), "trunk_ref": "refs/heads/master"})
        self.assertEqual(p["kind"], "land")

    def test_fast_forward_lands_at_the_commit(self):
        s, tip = self.merged_branch(ff=True)
        self.assertEqual(s, tip)
        gw = FakeGW()
        work_history(gw, [s])
        out = L.sweep(gw, REPO, self.r, state={})
        self.assertEqual(out[0]["result"], "landed")
        self.assertEqual(gw.posts[0]["payload"]["sha"], s)

    def test_rerun_and_double_detection_post_nothing_new(self):
        s, m = self.merged_branch()
        gw = FakeGW()
        work_history(gw, [s])
        state = {}
        L.sweep(gw, REPO, self.r, state=state)
        L.sweep(gw, REPO, self.r, state=state)              # cached state (plugin rerun)
        L.sweep(gw, REPO, self.r, state={})                 # fresh state (another detector)
        L.sweep(gw, REPO, self.r, hints={CHANGE: [s]})      # the session's own hint
        self.assertEqual(len(gw.posts), 1)
        # a land posted by someone else at the same landing commit (same op_id) is recognised
        gw2 = FakeGW()
        work_history(gw2, [s])
        gw2.add("edit", CHANGE)
        gw2.add("land", CHANGE, {"sha": m, "op_id": L.op_id(REPO, CHANGE, m)})
        gw2.add("edit", CHANGE)  # work after it, still nothing new on trunk for this commit
        out = L.sweep(gw2, REPO, self.r, state={})
        self.assertEqual(gw2.posts, [])
        self.assertIn("no commit", out[0]["reason"])

    def test_unmerged_change_is_not_landed(self):
        g(self.r, "checkout", "-qb", "wip")
        s = commit(self.r, "a.txt")
        g(self.r, "checkout", "-q", "master")
        gw = FakeGW()
        work_history(gw, [s])
        out = L.sweep(gw, REPO, self.r, state={})
        self.assertEqual(gw.posts, [])
        self.assertEqual(out[0]["result"], "skip")
        self.assertIn("not on trunk", out[0]["reason"])

    def test_session_without_commits_is_not_landed(self):
        # the smoke change: edits, then the session ended (released), never merged
        gw = FakeGW()
        gw.add("join", "hermes-default/adhoc-api_1")
        gw.add("edit", "hermes-default/adhoc-api_1")
        gw.add("release", "hermes-default/adhoc-api_1", {"reason": "session_ended"})
        out = L.sweep(gw, REPO, self.r, state={})
        self.assertEqual(gw.posts, [])
        self.assertEqual(out[0]["reason"], "no commit recorded after its last edit")

    def test_edits_after_the_last_commit_keep_the_change_open(self):
        s, _ = self.merged_branch()
        gw = FakeGW()
        work_history(gw, [s])
        gw.add("edit")  # edited again after its commit: not known to be on trunk
        out = L.sweep(gw, REPO, self.r, state={})
        self.assertEqual(gw.posts, [])
        self.assertEqual(out[0]["reason"], "no commit recorded after its last edit")

    def test_checkout_of_trunk_is_not_work(self):
        # HEAD moved onto trunk by a checkout: x_work false -> never a reason to land
        gw = FakeGW()
        work_history(gw, [g(self.r, "rev-parse", "master")], x_work=False)
        L.sweep(gw, REPO, self.r, state={})
        self.assertEqual(gw.posts, [])

    def test_changes_without_edits_are_not_landed(self):
        s, _ = self.merged_branch()
        gw = FakeGW()
        gw.add("checkpoint", "hermes-default/pm", {"sha": s, "x_work": True})  # the PM's merge session
        self.assertEqual(L.sweep(gw, REPO, self.r, state={}), [])
        self.assertEqual(gw.posts, [])

    def test_legacy_checkpoints_count_only_when_fresh(self):
        s, m = self.merged_branch()
        gw = FakeGW()
        gw.add("edit")
        gw.add("checkpoint", CHANGE, {"sha": s})  # adapter < 0.3: no x_work; commit is fresh
        self.assertEqual(L.sweep(gw, REPO, self.r, state={})[0]["result"], "landed")
        gw2 = FakeGW()
        gw2.add("edit")
        gw2.add("checkpoint", CHANGE, {"sha": s}, ts="2030-01-01T00:00:00Z")  # commit far older
        self.assertEqual(L.sweep(gw2, REPO, self.r, state={})[0]["result"], "skip")

    def test_since_filters_backfill(self):
        s, _ = self.merged_branch()
        gw = FakeGW()
        work_history(gw, [s])
        self.assertEqual(L.sweep(gw, REPO, self.r, since_ts=time.time() + 3600, dry_run=True), [])
        out = L.sweep(gw, REPO, self.r, since_ts=time.time() - 3600, dry_run=True)
        self.assertEqual(out[0]["result"], "would_land")
        self.assertEqual(gw.posts, [])


class RunAutoFailOpen(TmpCase):
    def setUp(self):
        super().setUp()
        self.r = new_repo(self.tmp)
        g(self.r, "checkout", "-qb", "b")
        self.s = commit(self.r, "a.txt")
        g(self.r, "checkout", "-q", "master")
        g(self.r, "merge", "-q", "--no-ff", "b", "-m", "Merge b")
        self.cfg = {"url": "http://fake", "land_tokens": {REPO: {"url": "http://fake", "token": "sys"}}}
        self.cache = self.tmp / "cache"
        self.logs = []

    def run_auto(self, gw, hints=None):
        orig = L.Gateway
        L.Gateway = lambda *a, **k: gw  # type: ignore[assignment]
        try:
            return L.run_auto(REPO, str(self.r), dict(hints or {}), cfg=self.cfg, base=self.cache,
                              log=self.logs.append, sleep=lambda s: None)
        finally:
            L.Gateway = orig  # type: ignore[assignment]

    def test_gateway_outage_fails_open_and_retries_from_pending(self):
        gw = FakeGW()
        gw.add("edit")  # the checkpoint never reached the gateway: only the session's hint has it
        gw.fail = "connection refused"
        code, _ = self.run_auto(gw, {CHANGE: [self.s]})
        self.assertEqual(code, 1)
        pend = json.loads(L.pending_path(REPO, self.cache).read_text())
        self.assertEqual(pend["hints"], {CHANGE: [self.s]})
        self.assertEqual(self.logs[-1]["result"], "deferred")
        gw.fail = None
        code, results = self.run_auto(gw)  # next opportunity: no hints passed, pending supplies them
        self.assertEqual(code, 0)
        self.assertEqual([r["result"] for r in results], ["landed"])
        self.assertFalse(L.pending_path(REPO, self.cache).exists())
        self.assertEqual(len(gw.posts), 1)  # the outage run never got to post
        self.assertEqual(sum(1 for e in gw.log if e["kind"] == "land"), 1)

    def test_auto_mode_leaves_the_old_backlog_to_the_reviewed_backfill(self):
        gw = FakeGW()
        gw.add("edit", ts="2026-01-01T00:00:00.000Z")  # unlanded since long before auto-land existed
        gw.add("checkpoint", CHANGE, {"sha": self.s, "x_work": True}, ts="2026-01-01T00:00:01.000Z")
        code, results = self.run_auto(gw)
        self.assertEqual((code, results, gw.posts), (0, [], []))
        state = json.loads(L.state_path(REPO, self.cache).read_text())
        self.assertGreater(state["floor_ts"], time.time() - L.AUTO_LOOKBACK_S - 60)
        self.assertEqual(L.sweep(gw, REPO, self.r, dry_run=True)[0]["result"], "would_land")  # --all-repos
        code, results = self.run_auto(gw, {CHANGE: [self.s]})  # ...a live session's own commit still lands
        self.assertEqual([r["result"] for r in results], ["landed"])

    def test_no_land_token_is_a_logged_skip(self):
        self.cfg = {"url": "http://fake"}
        code, results = self.run_auto(FakeGW())
        self.assertEqual((code, results), (0, []))
        self.assertIn("no land token", self.logs[-1]["reason"])

    def test_concurrent_runs_are_serialised(self):
        with L.RepoLock(REPO, self.cache):
            with self.assertRaises(TimeoutError):
                with L.RepoLock(REPO, self.cache, wait_s=0.3):
                    pass


class AdapterWatch(TmpCase):
    """The plugin side: checkpoints for HEAD moves wherever the command ran, land on trunk move."""

    def setUp(self):
        super().setUp()
        self.r = new_repo(self.tmp)
        self.scratch = self.tmp / "scratch"
        self.scratch.mkdir()
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(self.scratch)  # like a scratch kanban card
        os.environ["HERMES_KANBAN_TASK"] = "t_aaaaaaaa"
        self.cfg = Config(url="http://fake", repo=REPO, token="t", agent="hermes-default", profile="default",
                          roots=[Root(str(self.r), "", REPO)], analyzer=None, log_path=self.tmp / "default.log",
                          auto_land=True)
        self.client = FakeClient()
        self.spawned = []
        self.router = WeftRouter(self.cfg, client_factory=lambda c: self.client, heartbeat=False)

    def tearDown(self):
        os.environ.pop("HERMES_KANBAN_TASK", None)
        os.environ.pop("HERMES_KANBAN_WORKSPACE", None)
        self.router.close()
        super().tearDown()

    def adapter(self) -> WeftAdapter:
        a = self.router.adapter_for(REPO)
        a.spawner = self.spawned.append
        return a

    def edit(self, name, text, cid):
        path = self.r / name
        args = {"path": str(path), "content": text}
        self.router.pre_tool_call(tool_name="write_file", args=args, tool_call_id=cid)
        path.write_text(text)
        self.router.post_tool_call(tool_name="write_file", args=args, tool_call_id=cid)

    def shell(self, command, cid, run):
        args = {"command": command, "workdir": str(self.scratch)}  # out of scope: cd's into the repo
        self.assertIsNone(self.router.pre_tool_call(tool_name="terminal", args=args, tool_call_id=cid))
        run()
        self.router.post_tool_call(tool_name="terminal", args=args, tool_call_id=cid)
        self.assertTrue(self.router.flush(5.0))  # advise repo: checkpoints + land check run deferred

    def checkpoints(self):
        return [c[3] for c in self.client.submits("commit") if c[3]["kind"] == "checkpoint"]

    def test_cd_commit_and_merge_from_a_scratch_dir(self):
        self.adapter()
        g(self.r, "checkout", "-qb", "milestone-2")
        self.edit("a.txt", "work\n", "e1")
        self.shell(f"cd {self.r} && git add -A && git commit -m work", "t1",
                   lambda: (g(self.r, "add", "-A"), g(self.r, "commit", "-qm", "work")))
        s = g(self.r, "rev-parse", "HEAD")
        cps = self.checkpoints()
        self.assertEqual([c["payload"] for c in cps], [{"sha": s, "x_work": True}])
        self.assertEqual(self.spawned, [], "trunk did not move: no land check yet")
        self.shell(f"cd {self.r} && git checkout master", "t2", lambda: g(self.r, "checkout", "-q", "master"))
        self.assertFalse(self.checkpoints()[-1]["payload"]["x_work"], "a checkout of trunk is not work")
        self.shell(f"cd {self.r} && git merge --no-ff milestone-2", "t3",
                   lambda: g(self.r, "merge", "-q", "--no-ff", "milestone-2", "-m", "Merge"))
        self.assertEqual(len(self.spawned), 1)
        args = self.spawned[0]
        self.assertIn("--auto", args)
        self.assertEqual(args[args.index("--repo") + 1], REPO)
        self.assertIn(f"hermes-default/t_aaaaaaaa={s}", args)
        self.assertTrue(args[args.index("--git-dir") + 1].endswith(REPO))
        self.assertNotIn("sys", args, "the plugin never handles the land token")

    def test_trunk_moved_by_another_process_triggers_a_check(self):
        self.adapter()
        self.edit("a.txt", "work\n", "e1")
        self.shell("ls", "t1", lambda: None)
        commit(self.r, "pm.txt")  # someone else commits on master between two tool calls
        self.shell("ls", "t2", lambda: None)
        self.assertEqual(len(self.spawned), 1)

    def test_merge_made_while_no_session_watched_is_noticed_on_first_look(self):
        old_tip = g(self.r, "rev-parse", "master")
        state = L.state_path(REPO, self.tmp)  # cache dir = log_path.parent
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps({"swept_tips": {"refs/heads/master": old_tip}}))
        commit(self.r, "by-hand.txt")  # a human merged/committed with no Hermes session around
        self.adapter()
        self.edit("a.txt", "work\n", "e1")
        self.shell("ls", "t1", lambda: None)
        self.assertEqual(len(self.spawned), 1)

    def test_kanban_completion_triggers_a_check(self):
        self.adapter()
        self.edit("a.txt", "work\n", "e1")
        self.router.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k1")
        self.assertEqual(len(self.spawned), 1)

    def test_spawn_failure_fails_open(self):
        a = self.adapter()

        def boom(_args):
            raise OSError("fork failed")
        a.spawner = boom
        self.edit("a.txt", "work\n", "e1")
        self.shell("git commit", "t1", lambda: (g(self.r, "add", "-A"), g(self.r, "commit", "-qm", "c")))
        self.assertIsNone(self.router.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k1"))
        self.assertIn("auto-land spawn failed open", (self.tmp / "default.log").read_text())

    def test_gateway_down_still_hints_the_commit(self):
        a = self.adapter()
        self.edit("a.txt", "work\n", "e1")

        def down(*_a, **_k):
            from wcp import WcpError
            raise WcpError("transport", "connection refused")
        self.client.submit = down  # type: ignore[assignment]
        g(self.r, "checkout", "-qb", "b")
        self.shell("git commit", "t1", lambda: (g(self.r, "add", "-A"), g(self.r, "commit", "-qm", "c")))
        s = g(self.r, "rev-parse", "HEAD")
        self.shell("git checkout master && git merge b", "t2",
                   lambda: (g(self.r, "checkout", "-q", "master"), g(self.r, "merge", "-q", "--no-ff", "b", "-m", "M")))
        self.assertEqual(a.work_shas[0], s)
        self.assertIn(f"hermes-default/t_aaaaaaaa={s}", self.spawned[-1])

    def test_auto_land_off_spawns_nothing(self):
        self.cfg.auto_land = False
        self.router = WeftRouter(self.cfg, client_factory=lambda c: self.client, heartbeat=False)
        self.adapter()
        self.edit("a.txt", "work\n", "e1")
        commit(self.r, "pm.txt")
        self.shell("ls", "t1", lambda: None)
        self.router.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="k1")
        self.assertEqual(self.spawned, [])


if __name__ == "__main__":
    unittest.main()
