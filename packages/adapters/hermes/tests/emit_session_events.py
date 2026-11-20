"""Print the Hello and Submit bodies two interleaved Hermes chats send through one router (one
gateway process), plus a standalone checkout's per-conversation change, as JSON (one list).

Driven by src/session-schema.test.ts, which validates each body with @weft/protocol's own
validator: per-conversation task/change ids must stay valid WCP.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "plugin"))
sys.path.insert(0, str(HERE))

from test_adapter import FakeClient  # noqa: E402
from weft.adapter import Config, WeftAdapter, WeftRouter, discover_projects  # noqa: E402
from weft.wcp import PROTOCOL  # noqa: E402


def main() -> None:
    os.environ.pop("HERMES_KANBAN_TASK", None)
    os.environ["HERMES_SESSION_ID"] = "process-global"
    tmp = Path(tempfile.mkdtemp(prefix="weft-emit-sessions-")).resolve()
    proj = tmp / "Projects" / "app"
    (proj / "src").mkdir(parents=True)
    (proj / "src" / "a.md").write_text("one\n")
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    os.environ["HERMES_KANBAN_WORKSPACE"] = str(proj)
    projects = discover_projects([str(tmp / "Projects")])
    cfg = Config(url="http://fake", repo="", token="", agent="hermes-default", profile="default", roots=[],
                 tokens={"app": "t"}, project_dirs=[str(tmp / "Projects")], projects=projects, analyzer=None,
                 log_path=None)
    clients = []

    def factory(c):
        clients.append(FakeClient())
        return clients[-1]
    r = WeftRouter(cfg, client_factory=factory, heartbeat=False)
    target = proj / "src" / "a.md"
    for i, sid in enumerate(("api_1700000001_aaaa1111", "api_1700000002_bbbb2222")):
        kw = {"session_id": sid, "conversation_id": sid, "task_id": sid, "tool_call_id": f"c{i}"}
        r.pre_tool_call(tool_name="write_file", args={"path": str(target), "content": f"v{i}\n"}, **kw)
        target.write_text(f"v{i}\n")
        r.post_tool_call(tool_name="write_file", args={}, **kw)
    r.flush(5)
    # standalone (catalog) checkout: task = the checkout, change = the conversation
    st = Config(url="http://fake", repo="app", token="t", agent="hermes-default", profile="default", roots=[],
                analyzer=None, log_path=None, links=object(), route=str(proj))  # type: ignore[arg-type]
    clients.append(FakeClient())
    a = WeftAdapter(st, client=clients[-1], analyzer=object(), heartbeat=False, session_key="20261120_101500_abcd")  # type: ignore[arg-type]
    a.ensure_session()
    bodies = []
    for c in clients:
        for call in c.calls:
            if call[0] == "hello":
                _, agent, caps, task, change = call
                bodies.append({"type": "hello", "protocol": PROTOCOL, "agent": agent, "capabilities": caps,
                               "task": task, "change": change})
            elif call[0] == "submit":
                _, _, mode, event, _, _ = call
                bodies.append({"type": "submit", "mode": mode, "event": event})
    r.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps(bodies))


if __name__ == "__main__":
    main()
