#!/usr/bin/env python3
"""E2E driver for src/autoland-e2e.test.ts: the real plugin router (real WcpClient, real
land.py subprocess) against a local gateway, in a throwaway git repo whose branch is merged
into master from a scratch workdir (`cd <repo> && git merge`), like a kanban worker does.

    python3 tests/e2e_autoland.py <gateway url> <tmp dir>   -> prints a JSON summary
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

URL, TMP = sys.argv[1], Path(sys.argv[2]).resolve()
PLUGIN = Path(__file__).resolve().parent.parent / "plugin" / "weft"
sys.path.insert(0, str(PLUGIN))


def g(cwd, *args) -> str:
    return subprocess.run(["git", "-c", "user.email=e2e@t", "-c", "user.name=e2e", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


projects = TMP / "github"
repo = projects / "proj"
scratch = TMP / "hermes" / "workspaces" / "t_e2e00001"
for d in (repo, scratch):
    d.mkdir(parents=True, exist_ok=True)
g(repo, "init", "-q", "-b", "master")
(repo / "README.md").write_text("hi\n")
g(repo, "add", "-A")
g(repo, "commit", "-qm", "init")

config = TMP / "hermes-adapter.json"
config.write_text(json.dumps({
    "url": URL, "repo": "proj", "default_mode": os.environ.get("E2E_MODE", "advise"),
    "projects": {"dirs": [str(projects)], "repos": {str(repo): "proj"}},
    "exclude": [str(TMP / "hermes")],
    "agents": {"e2e": {"agent": "hermes-e2e", "tokens": {"proj": {"token": "agent-tok"}}}},
    "land_tokens": {"proj": {"url": URL, "repo": "proj", "principal": "weft-pm-land", "token": "sys-tok"}},
}))
os.environ.update({
    "WEFT_HERMES_CONFIG": str(config), "WEFT_HERMES_CACHE": str(TMP / "cache"), "HERMES_PROFILE": "e2e",
    "HERMES_KANBAN_TASK": "t_e2e00001", "HERMES_KANBAN_WORKSPACE": str(scratch),
})

from adapter import Config, WeftRouter  # noqa: E402
import land  # noqa: E402

cfg = Config.load()
assert cfg and cfg.auto_land, "config did not load"
router = WeftRouter(cfg, heartbeat=False)
n = 0


def call(tool, args, run=None):
    global n
    n += 1
    cid = f"c{n}"
    block = router.pre_tool_call(tool_name=tool, args=args, tool_call_id=cid)
    assert block is None, block
    if run:
        run()
    router.post_tool_call(tool_name=tool, args=args, tool_call_id=cid, result='{"ok": true}')
    router.flush(10.0)


def wait_lands(timeout=30.0):
    deadline = time.monotonic() + timeout
    for a in router._live():
        for p in a._procs:
            p.wait(max(0.1, deadline - time.monotonic()))


# the card works on its own branch in the main checkout and edits a file
g(repo, "checkout", "-qb", "milestone-2")
target = repo / "src" / "app.py"
target.parent.mkdir()
call("write_file", {"path": str(target), "content": "def hello():\n    return 1\n"},
     lambda: target.write_text("def hello():\n    return 1\n"))
# commit and merge from the scratch workdir, cd'ing into the repo (no task id anywhere in git)
shell = {"workdir": str(scratch)}
call("terminal", {**shell, "command": f"cd {repo} && git add -A && git commit -m 'feat: hello'"},
     lambda: (g(repo, "add", "-A"), g(repo, "commit", "-qm", "feat: hello")))
work = g(repo, "rev-parse", "HEAD")
call("terminal", {**shell, "command": f"cd {repo} && git checkout master && git merge --no-ff milestone-2"},
     lambda: (g(repo, "checkout", "-q", "master"), g(repo, "merge", "-q", "--no-ff", "milestone-2", "-m", "Merge milestone 2")))
merge = g(repo, "rev-parse", "HEAD")
wait_lands()
# double detection: the kanban completion path and a manual rerun must post nothing new
call("kanban_complete", {})
wait_lands()
rerun = subprocess.run([sys.executable, str(PLUGIN / "land.py"), "--auto", "--repo", "proj", "--git-dir", str(repo)],
                       capture_output=True, text=True, timeout=60)
router.close()
log = (TMP / "cache" / "e2e.log").read_text() if (TMP / "cache" / "e2e.log").exists() else ""
print(json.dumps({"change": "hermes-e2e/t_e2e00001", "work": work, "merge": merge,
                  "op_id": land.op_id("proj", "hermes-e2e/t_e2e00001", merge), "rerun_exit": rerun.returncode,
                  "log_tail": log.splitlines()[-8:]}))
