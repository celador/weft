#!/usr/bin/env python3
"""Live end-to-end: two Hermes sessions edit the same code; the second gets Weft's diagnostic at edit time.

Runs the REAL plugin inside a REAL Hermes runtime (``model_tools.handle_function_call``, the function
every model tool call goes through, so every hook fires exactly as in a chat) against a REAL local
Weft gateway, with no LLM and no cost. Uses a throwaway HERMES_HOME and a throwaway WEFT_HOME, so it
never touches your ~/.hermes or your Weft setup.

    python3 packages/adapters/hermes/tests/e2e_catalog.py            # uses the Hermes venv if found
    WEFT_E2E_KEEP=1 python3 ...                                      # leave the gateway + dirs running

Needs: Hermes installed (``hermes`` on PATH), Node >= 22 + network once (``npx @celador/weft`` starts
the local gateway, ~15 s the first time), git. Exit 0 = every check passed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent / "plugin" / "weft"
CLI = os.environ.get("WEFT_E2E_CLI", "@celador/weft@0.3.0")


def hermes_python() -> str:
    for cand in (os.environ.get("HERMES_PYTHON", ""), str(Path.home() / ".hermes/hermes-agent/venv/bin/python")):
        if cand and os.path.exists(cand):
            return cand
    out = subprocess.run(["sh", "-c", "head -1 $(command -v hermes)"], capture_output=True, text=True).stdout
    if out.startswith("#!"):
        return out[2:].strip().split()[0]
    sys.exit("cannot find Hermes' Python (set HERMES_PYTHON)")


# ---- the driver runs inside Hermes' interpreter ------------------------------------------------
DRIVER = r'''
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, os.environ["HERMES_SRC"])
from hermes_cli.plugins import get_plugin_manager
from agent.secret_scope import set_secret_scope, build_profile_secret_scope
set_secret_scope(build_profile_secret_scope(Path(os.environ["HERMES_HOME"])))
import model_tools

from tools.terminal_tool import register_task_env_overrides
pm = get_plugin_manager()
pm.discover_and_load(force=True)
loaded = {k: v.enabled for k, v in pm._plugins.items()}
call = lambda name, args, sid, n: json.loads(model_tools.handle_function_call(name, args, task_id=sid, session_id=sid, tool_call_id=f"{sid}-{n}"))
steps = json.loads(os.environ["E2E_STEPS"])
out = {"plugins": loaded, "steps": []}
for sid, cwd in json.loads(os.environ["E2E_CWDS"]).items():
    register_task_env_overrides(sid, {"cwd": cwd})   # what a Hermes session's working directory is
from hermes_cli.plugins import invoke_hook
for sid in json.loads(os.environ["E2E_CWDS"]):      # both sessions are open before anyone edits
    invoke_hook("on_session_start", session_id=sid, model="e2e", platform="cli")
time.sleep(2)
for i, st in enumerate(steps):
    time.sleep(st.get("wait", 0))
    r = model_tools.handle_function_call(st["tool"], st["args"], task_id=st["session"], session_id=st["session"], tool_call_id=f"{st['session']}-{i}")
    out["steps"].append({"label": st["label"], "result": r[:4000]})
    if st["tool"] == "weft_status":
        out["snapshots"] = [json.loads(p.read_text()) for p in (Path(os.environ["WEFT_HERMES_CACHE"]) / "status").glob("*.json")]
print("E2E_JSON " + json.dumps(out))
'''


def run_steps(py: str, env: dict, steps: list, cwds: dict, cwd: str | None = None) -> dict:
    env = {**env, "E2E_STEPS": json.dumps(steps), "E2E_CWDS": json.dumps(cwds)}
    proc = subprocess.run([py, "-c", DRIVER], env=env, capture_output=True, text=True, timeout=180, cwd=cwd)
    for line in proc.stdout.splitlines():
        if line.startswith("E2E_JSON "):
            return json.loads(line[9:])
    sys.exit(f"driver failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-3000:]}")


def sh(cmd, cwd=None, env=None, timeout=300):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        sys.exit(f"{' '.join(cmd)} failed:\n{r.stdout[-1500:]}{r.stderr[-1500:]}")
    return r.stdout


def main() -> int:
    py = hermes_python()
    tmp = Path(tempfile.mkdtemp(prefix="weft-e2e-", dir=os.environ.get("TMPDIR")))
    weft_home, hermes_home, proj = tmp / "weft-home", tmp / "hermes-home", tmp / "shop"
    env = {**os.environ, "WEFT_HOME": str(weft_home), "HERMES_HOME": str(hermes_home),
           "WEFT_HERMES_CACHE": str(tmp / "cache"), "HERMES_SRC": str(Path(py).parents[2])}
    for k in ("WEFT_HERMES_CONFIG", "WEFT_HERMES_MODE", "HERMES_KANBAN_TASK", "HERMES_KANBAN_WORKSPACE", "WEFT_HERMES_TASK", "WEFT_HERMES_CHANGE"):
        env.pop(k, None)
    failures = []

    def check(ok: bool, label: str, detail: str = "") -> None:
        print(("PASS " if ok else "FAIL ") + label + (f"  [{detail}]" if detail and not ok else ""))
        if not ok:
            failures.append(label)

    try:
        # 1. a small Python repo, linked to a local gateway by the real CLI
        proj.mkdir(parents=True)
        sh(["git", "init", "-q", "-b", "main"], proj)
        sh(["git", "config", "user.email", "e2e@example.com"], proj)
        sh(["git", "config", "user.name", "e2e"], proj)
        (proj / "pricing.py").write_text("def calc_total(items):\n    return sum(i['price'] * i['qty'] for i in items)\n")
        (proj / "cart.py").write_text("from pricing import calc_total\n\n\ndef render(items):\n    return 'total: %.2f' % calc_total(items)\n")
        sh(["git", "add", "-A"], proj)
        sh(["git", "commit", "-qm", "init"], proj)
        print("== npx @celador/weft (local gateway, 2 worktrees) ...")
        sys.path.insert(0, str(PLUGIN.parent))
        from weft import cli
        rc, setup = cli.run(["--yes", "--no-open", "--harness", "watcher", "--local"], str(proj),
                            env={"WEFT_HOME": str(weft_home)}, timeout=400)
        if rc:
            sys.exit(f"plugin CLI bridge setup failed: {setup[-1200:]}")
        a, b = proj, tmp / "shop-2"
        check((a / ".weft/token").exists() and (b / ".weft/token").exists(), "CLI linked both worktrees (.weft/token)")

        # 2. the plugin, installed the way a catalog install lays it out, enforcing
        (hermes_home / "plugins").mkdir(parents=True)
        shutil.copytree(PLUGIN, hermes_home / "plugins" / "weft", ignore=shutil.ignore_patterns("__pycache__"))
        (hermes_home / ".env").write_text("WEFT_AGENT_TOKEN=" + (a / ".weft/token").read_text().strip() + "\n")
        os.chmod(hermes_home / ".env", 0o600)
        (hermes_home / "config.yaml").write_text(textwrap.dedent("""\
            plugins:
              enabled: [weft]
              entries:
                weft:
                  settings:
                    mode: enforce
                    agent: shop
            """))

        # 3. session A (worktree 1) changes calc_total's signature; session B (worktree 2) uses it the old way
        new_pricing = "def calc_total(items, opts):\n    return sum(i['price'] * i['qty'] for i in items) * (1 + opts['tax'])\n"
        cart = (b / "cart.py").read_text() + "\n\ndef cart_total(items):\n    return round(calc_total(items), 2)\n"
        steps = [
            {"label": "A reads pricing.py", "session": "sess-A", "tool": "read_file", "args": {"path": str(a / "pricing.py")}},
            {"label": "A edits pricing.py", "session": "sess-A", "tool": "write_file",
             "args": {"path": str(a / "pricing.py"), "content": new_pricing}},
            {"label": "B reads cart.py", "session": "sess-B", "tool": "read_file", "args": {"path": str(b / "cart.py")}, "wait": 1},
            {"label": "B edits cart.py (calls calc_total the old way)", "session": "sess-B", "tool": "write_file",
             "args": {"path": str(b / "cart.py"), "content": cart}},
            {"label": "B checks weft_status", "session": "sess-B", "tool": "weft_status", "args": {}, "wait": 1},
            {"label": "A checks weft_status", "session": "sess-A", "tool": "weft_status", "args": {}},
            {"label": "B reads pricing.py", "session": "sess-B", "tool": "read_file", "args": {"path": str(b / "pricing.py")}},
            {"label": "B edits the SAME pricing.py", "session": "sess-B", "tool": "write_file",
             "args": {"path": str(b / "pricing.py"), "content": "def calc_total(items):\n    return 99\n"}},
        ]
        # both sessions in ONE process (the Hermes gateway / Desktop case): one adapter per checkout
        res = run_steps(py, env, steps, {"sess-A": str(a), "sess-B": str(b)}, cwd=str(tmp))
        check(res["plugins"].get("weft") is True, "plugin loaded and enabled in Hermes", str(res["plugins"]))
        got = {s["label"]: s["result"] for s in res["steps"]}
        a_res = got["A edits pricing.py"]
        b_res = got["B edits cart.py (calls calc_total the old way)"]
        check("[weft]" not in a_res and "error" not in a_res.lower(), "A's edit goes through unflagged", a_res[:300])
        check("cart_total" not in (b / "cart.py").read_text(), "B's edit was blocked before it reached the disk")
        check("[weft]" in b_res and "stale_assumption" in b_res and "calc_total" in b_res,
              "B got the conflict diagnostic naming calc_total", b_res[:600])
        check("shop" in b_res, "the diagnostic names the other agent", b_res[:300])
        status = got["B checks weft_status"]
        check('"linked": true' in status and '"open_conflicts": [{' in status and '"rejected":' in status,
              "weft_status (B) shows the open conflict and the rejection", status[:700])
        same = got["B edits the SAME pricing.py"]
        check("[weft warning] claim_wait pricing.py#calc_total" in same,
              "same-file in-flight collision gets an edit-time diagnostic (soft claim = warning)", same[:600])
        a_status = got["A checks weft_status"]
        check('"linked": true' in a_status and str(b) in a_status, "weft_status (A) sees B live in the same repo", a_status[:700])
        print("\n--- B's blocked edit, as the agent saw it ---\n" + b_res[:1400])
        if os.environ.get("WEFT_E2E_JSON"):
            Path(os.environ["WEFT_E2E_JSON"]).write_text(json.dumps(res, indent=2))
    finally:
        if not os.environ.get("WEFT_E2E_KEEP"):
            subprocess.run(["npx", "-y", CLI, "local", "stop"], cwd=proj, env=env, capture_output=True, timeout=60)
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print(f"kept: {tmp}")
    print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
