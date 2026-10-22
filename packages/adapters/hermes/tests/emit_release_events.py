"""Print the Submit bodies the adapter sends for a retreat release, as JSON (one list).

Driven by src/release-schema.test.ts, which validates each body with @weft/protocol's own
validator, so a payload the gateway would reject as ``invalid_message`` fails the suite.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "plugin"))
sys.path.insert(0, str(HERE))

from test_adapter import FakeClient  # noqa: E402
from weft.adapter import Config, Root, WeftAdapter  # noqa: E402


def adapter() -> tuple:
    root = str(Path(tempfile.mkdtemp(prefix="weft-emit-")).resolve())
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    os.environ.pop("HERMES_KANBAN_TASK", None)
    os.environ["HERMES_KANBAN_WORKSPACE"] = root
    cfg = Config(url="http://fake", repo="weft", token="t", agent="hermes-test", profile="test",
                 roots=[Root(root, "")], node="node", analyzer=None, log_path=None)
    client = FakeClient()
    a = WeftAdapter(cfg, client=client, heartbeat=False)
    a.ensure_session()
    return a, client, root


def main() -> None:
    refused = {"allow": False, "reason": "1 open Weft error(s)",
               "open_errors": [{"symbol": "pnpm-lock.yaml#*", "severity": "error"},
                               {"symbol": "src/a.ts#refreshToken", "severity": "error"}]}
    bodies = []

    a, client, root = adapter()  # commit gate retreat
    client.gate_results = [dict(refused) for _ in range(3)]
    args = {"command": "git commit -m x", "workdir": root}
    for _ in range(3):
        a.pre_tool_call(tool_name="terminal", args=args, tool_call_id="g")
    bodies += [{"type": "submit", "mode": m, "event": e} for _, _, m, e, _, _ in client.submits()]

    a, client, _ = adapter()  # stop gate (pre_verify) retreat
    client.gate_results = [dict(refused) for _ in range(3)]
    for _ in range(3):
        a.pre_verify()
    bodies += [{"type": "submit", "mode": m, "event": e} for _, _, m, e, _, _ in client.submits()]

    print(json.dumps(bodies))


if __name__ == "__main__":
    main()
