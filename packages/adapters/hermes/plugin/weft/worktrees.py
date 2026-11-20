"""Join new kanban worktrees to the Claude Code adapter of their main checkout.

``npx @celador/weft`` installs the Claude Code adapter per checkout: ``.weft/claude.json`` (url,
repo, agent, task, change), ``.claude/settings.local.json`` hooks and git hooks. None of that is
tracked by git, so a ``git worktree add`` (the Hermes kanban dispatcher's, ``hermes -w``, a manual
one) leaves the new tree without Weft: a Claude Code session there reports nothing, and its
commits ran the main checkout's shared ``commit-msg`` hook, which stamped the MAIN checkout's
Task-Id / Change-Id. The dispatcher runs ``git worktree add`` with hooks disabled, so a git
``post-checkout`` hook cannot fix it.

``on_kanban_worker_spawned`` gives the worker's workspace path and task id. When that workspace
is a linked worktree of a checkout that has ``.weft/claude.json``, run the same adapter's
``install`` there: same coordinator, repo, agent and mode as the main checkout, the kanban task
id as the WCP task, a fresh change. The agent token is never read here: ``install --token-from``
makes the adapter copy its own token file (runtimes that predate that flag get ``--token-file``
pointing at the main checkout's token instead).

Nothing here is a credential reader: it reads ``.weft/claude.json`` (no secrets) and the
``.weft/bin/weft`` launcher (to find the adapter the user installed), and runs that adapter.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
from typing import Any, Callable, Dict, List, Optional

CONFIG_REL = os.path.join(".weft", "claude.json")
LAUNCHER_REL = os.path.join(".weft", "bin", "weft")
TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
INSTALL_TIMEOUT_S = 30.0


def linked_main(worktree: str) -> Optional[str]:
    """The main checkout of a linked git worktree (``.git`` is a file whose gitdir lives under
    ``<main>/.git/worktrees/``), else None (a main checkout, a submodule, not git)."""
    dotgit = os.path.join(worktree, ".git")
    if not os.path.isfile(dotgit):
        return None
    try:
        with open(dotgit) as f:
            line = f.read(4096).strip()
        if not line.startswith("gitdir:"):
            return None
        gitdir = os.path.realpath(os.path.join(worktree, line[len("gitdir:"):].strip()))
        common = gitdir
        cd = os.path.join(gitdir, "commondir")
        if os.path.isfile(cd):
            with open(cd) as f:
                common = os.path.realpath(os.path.join(gitdir, f.read().strip()))
    except OSError:
        return None
    if os.path.basename(os.path.dirname(gitdir)) != "worktrees" or os.path.basename(common) != ".git":
        return None
    return os.path.dirname(common)


def read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path) as f:
            data = json.loads(f.read(1 << 20))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def adapter_command(main: str) -> Optional[List[str]]:
    """``[node, weft-claude.mjs]`` as installed in ``main``: its ``.weft/bin/weft`` launcher is
    ``exec <node> <adapter> "$@"`` (written by the adapter's own install)."""
    try:
        with open(os.path.join(main, LAUNCHER_REL)) as f:
            text = f.read(8192)
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("exec "):
            continue
        try:
            words = shlex.split(line)
        except ValueError:
            return None
        if len(words) >= 3 and words[1] and words[2].endswith(".mjs") and os.path.isfile(words[2]):
            return [words[1], words[2]]
    return None


def plan_join(worktree: str, task_id: str) -> Optional[Dict[str, Any]]:
    """What joining ``worktree`` to its main checkout's Claude Code adapter would run, or None
    when there is nothing to do (with the reason under ``skip``)."""
    if not isinstance(worktree, str) or not os.path.isabs(worktree) or not os.path.isdir(worktree):
        return {"skip": "workspace is not a directory"}
    worktree = os.path.realpath(worktree)
    if not isinstance(task_id, str) or not TASK_ID.match(task_id):
        return {"skip": "no usable task id"}
    main = linked_main(worktree)
    if not main:
        return {"skip": "not a linked git worktree"}
    cfg = read_json(os.path.join(main, CONFIG_REL))
    if not cfg or not all(isinstance(cfg.get(k), str) and cfg.get(k) for k in ("url", "repo", "agent")):
        return {"skip": f"main checkout {main} has no Claude Code adapter (.weft/claude.json)"}
    own = read_json(os.path.join(worktree, CONFIG_REL))
    if own and (own.get("task") or {}).get("id") == task_id:
        return {"skip": "already joined"}
    cmd = adapter_command(main)
    if not cmd:
        return {"skip": f"main checkout {main} has no .weft/bin/weft launcher naming the adapter"}
    token_rel = cfg.get("tokenFile")
    if not isinstance(token_rel, str) or not token_rel:
        token_rel = ".weft/token"
    token_src = os.path.normpath(os.path.join(main, token_rel))
    args = [*cmd, "install", "--dir", worktree, "--url", cfg["url"], "--repo", cfg["repo"],
            "--agent", cfg["agent"], "--task", task_id, "--mode", str(cfg.get("mode") or "enforce")]
    if isinstance(cfg.get("prefix"), str) and cfg["prefix"]:
        args += ["--prefix", cfg["prefix"]]
    return {"main": main, "worktree": worktree, "args": args, "token_src": token_src}


def run_join(plan: Dict[str, Any], run: Callable[..., Any] = subprocess.run) -> str:
    """Run a ``plan_join`` plan. Returns a one-line outcome for the log."""
    env = {k: v for k, v in os.environ.items() if k != "WEFT_TOKEN"}  # never pass a token through env
    wt = plan["worktree"]
    out = run(plan["args"] + ["--token-from", plan["token_src"]], env=env, capture_output=True, text=True,
              timeout=INSTALL_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if getattr(out, "returncode", 1) != 0:
        return f"join {wt}: adapter install failed: {(out.stderr or out.stdout or '').strip()[-300:]}"
    if not os.path.exists(os.path.join(wt, ".weft", "token")):
        # A runtime without --token-from: point the worktree at the main checkout's token file.
        out = run(plan["args"] + ["--token-file", plan["token_src"]], env=env, capture_output=True, text=True,
                  timeout=INSTALL_TIMEOUT_S, stdin=subprocess.DEVNULL)
        if getattr(out, "returncode", 1) != 0:
            return f"join {wt}: adapter install failed: {(out.stderr or out.stdout or '').strip()[-300:]}"
    cfg = read_json(os.path.join(wt, CONFIG_REL)) or {}
    return (f"joined {wt} to the Claude Code adapter of {plan['main']} "
            f"(repo {cfg.get('repo')}, agent {cfg.get('agent')}, task {(cfg.get('task') or {}).get('id')})")


def join_worktree(workspace_path: Any, task_id: Any, log: Callable[[str], None],
                  run: Callable[..., Any] = subprocess.run) -> Optional[str]:
    """Join one worktree; never raises. Returns the logged outcome (None: nothing to do)."""
    try:
        plan = plan_join(str(workspace_path or ""), str(task_id or ""))
        if not plan or plan.get("skip"):
            return None
        msg = run_join(plan, run=run)
    except Exception as err:  # fail open: a worker without Weft is better than no worker
        msg = f"join {workspace_path}: failed open: {err!r}"
    log(msg)
    return msg


def on_worker_spawned(log: Callable[[str], None], wait: bool = False, **kw: Any) -> None:
    """``on_kanban_worker_spawned`` (kwargs ``task_id``, ``workspace_path``, ...): join the
    worker's worktree off the dispatcher's thread."""
    t = threading.Thread(target=join_worktree, args=(kw.get("workspace_path"), kw.get("task_id"), log),
                         name="weft-join", daemon=True)
    t.start()
    if wait:
        t.join(INSTALL_TIMEOUT_S * 2 + 5)
