"""The Weft CLI bridge: the one place the plugin runs a subprocess (``npx @celador/weft``).

Used only on a user's explicit request (``/weft setup`` and ``/weft feed`` in a chat, the pane's
"Open feed" button). It starts nothing on its own and nothing at plugin load. The version is
pinned here (and disclosed in the README): the plugin never asks npm for "latest", and bumping
the pin is a reviewed change to this file like any other.

Standard library only: the Desktop pane's backend (``dashboard/plugin_api.py``) loads this file
directly by path.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import List, Optional, Tuple

CLI_PACKAGE = "@celador/weft"
CLI_VERSION = "0.3.0"          # pinned; npm verifies the tarball integrity against its registry record
SETUP_TIMEOUT_S = 240          # first run installs wrangler (~10 s) and starts the local gateway
QUICK_TIMEOUT_S = 60
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_NODE_MIN = 22


def clean(text: str) -> str:
    return _ANSI.sub("", text or "").replace("\r", "")


def node_problem() -> Optional[str]:
    """None when Node >= 22 and npx are available, else a one-line reason."""
    node, npx = shutil.which("node"), shutil.which("npx")
    if not node or not npx:
        return "Weft's local gateway needs Node.js 22+ (node and npx on PATH): https://nodejs.org"
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        major = int(out.lstrip("v").split(".")[0])
    except Exception:
        return None  # cannot tell: let npx try and report its own error
    return None if major >= _NODE_MIN else f"Weft needs Node.js {_NODE_MIN}+; this machine has {out}"


def command(*args: str) -> List[str]:
    return ["npx", "-y", f"{CLI_PACKAGE}@{CLI_VERSION}", *args]


def run(args: List[str], cwd: str, timeout: int = QUICK_TIMEOUT_S, env: Optional[dict] = None) -> Tuple[int, str]:
    """Run ``npx @celador/weft@<pinned> <args>`` in ``cwd``; (exit code, cleaned output).
    Never prompts (stdin closed) and is bounded by ``timeout``."""
    problem = node_problem()
    if problem:
        return 127, problem
    try:
        proc = subprocess.run(command(*args), cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL, env={**os.environ, **(env or {})})
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    except OSError as err:
        return 127, f"could not run npx: {err}"
    return proc.returncode, clean((proc.stdout or "") + (proc.stderr or "")).strip()


FEED_URL = re.compile(r"https?://\S+/feed\?space=\S+")
PAIR_CODE = re.compile(r"pairing code\s+([A-Z0-9]{5}-[A-Z0-9]{5})")


def parse_feed(text: str) -> dict:
    """{'url', 'code'} from ``weft pair`` / setup output (either may be missing)."""
    url = FEED_URL.search(text or "")
    code = PAIR_CODE.search(text or "")
    return {"url": url.group(0) if url else "", "code": code.group(1) if code else ""}
