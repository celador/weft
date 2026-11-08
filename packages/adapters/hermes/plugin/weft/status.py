"""Status snapshots: what each Weft-reporting Hermes process is seeing, readable by anyone.

Every ``WeftAdapter`` (one per checkout and process) keeps a small recorder: its identity, its
gateway, the last few edits with Weft's verdicts, the diagnostics other agents' changes raised
against it, and its open conflicts. The recorder writes that to one JSON file under
``<cache>/status/`` (``~/.cache/weft-hermes/status/`` unless ``WEFT_HERMES_CACHE`` says otherwise,
the directory the adapter's log already lives in).

Why files and not memory: Hermes runs plugin code in several processes (the gateway, kanban
workers, a ``hermes chat`` CLI, an optional plugin host), and the Desktop pane's backend, the
``weft_status`` tool and ``/weft`` must see all of them, so two colliding sessions show up side by
side. Files hold only symbol keys, file names, verdict words and Weft's own diagnostic text, never
tokens and never file contents; they are mode 600 and a reader ignores any that stopped updating
a day ago.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

STALE_AFTER_S = 24 * 3600     # a snapshot nobody refreshed for a day is dropped by readers
LIVE_WITHIN_S = 120           # "live" = refreshed in the last two minutes (heartbeat keeps it so)
MAX_EVENTS = 40
MAX_OPEN = 20
WRITE_EVERY_S = 0.4


def status_dir(cache_dir: Optional[Path] = None) -> Path:
    base = cache_dir or Path(os.environ.get("WEFT_HERMES_CACHE", "~/.cache/weft-hermes")).expanduser()
    return base / "status"


def _trim(text: Any, n: int = 600) -> str:
    s = str(text or "")
    return s if len(s) <= n else s[: n - 1] + "…"


def gateway_kind(url: str) -> str:
    if re.match(r"^https?://(127\.0\.0\.1|localhost)(:|/|$)", url or ""):
        return "local"
    if (url or "").rstrip("/") == "https://weft-hosted.elier.ai":
        return "hosted"
    return "own"


def brief_diagnostic(d: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "severity": d.get("severity", "info"), "code": d.get("code", ""),
        "file": _trim(d.get("file"), 200), "symbol": _trim(d.get("symbol"), 240),
        "message": _trim(d.get("message")), "by": _trim(d.get("caused_by_agent"), 80),
        "by_task": _trim(d.get("caused_by_task"), 80), "seq": d.get("caused_by_seq"),
        "suggestion": _trim(d.get("suggestion"), 400),
    }


class Recorder:
    """One per adapter. Thread-safe; every method is best-effort and never raises."""

    def __init__(self, directory: Optional[Path], identity: Dict[str, Any]):
        self.directory = directory  # None: recording only, nothing written (unit tests)
        self.identity = dict(identity)
        key = f"{identity.get('route', '')}|{identity.get('change', '')}"
        self.path = (directory / (re.sub(r"[^A-Za-z0-9]+", "", key)[-24:] + f"-{os.getpid()}.json")
                     if directory else None)
        self.started = time.time()
        self.lock = threading.Lock()
        self.events: Deque[Dict[str, Any]] = deque(maxlen=MAX_EVENTS)
        self.open: Dict[str, Dict[str, Any]] = {}
        self.counters = {"edits": 0, "accepted": 0, "warned": 0, "rejected": 0, "inbox": 0}
        self.session: Optional[str] = None
        self.reachable: Optional[bool] = None
        self.ended = False
        self._last_write = 0.0
        self._dirty = True

    # -- recording --------------------------------------------------------------------------

    def set_session(self, session: Optional[str]) -> None:
        self.session = session
        self.reachable = True if session else self.reachable
        self.flush(force=True)

    def set_reachable(self, ok: bool) -> None:
        if self.reachable != ok:
            self.reachable = ok
            self.flush(force=True)

    def set_mode(self, mode: str) -> None:
        self.identity["mode"] = mode
        self.flush(force=True)

    def add(self, kind: str, **fields: Any) -> None:
        try:
            with self.lock:
                self.events.append({"t": round(time.time(), 3), "kind": kind, **fields})
            self.flush()
        except Exception:
            pass

    def verdict(self, mode: str, files: List[str], writes: List[dict], verdict: Dict[str, Any],
                tool: str = "") -> None:
        """An edit's verdict (``check`` before it hits the disk, ``commit`` after)."""
        try:
            diags = [brief_diagnostic(d) for d in (verdict.get("diagnostics") or []) if isinstance(d, dict)]
            rejected = verdict.get("verdict") == "reject"
            errors = [d for d in diags if d["severity"] == "error"]
            keys = [w.get("key") for w in writes if isinstance(w, dict) and w.get("key")]
            with self.lock:
                if mode == "commit":
                    self.counters["edits"] += 1
                    self.counters["rejected" if rejected else "warned" if diags else "accepted"] += 1
                elif rejected:
                    self.counters["rejected"] += 1
                # an accepted edit that touches a symbol clears the conflict on it
                if not rejected:
                    for k in keys:
                        for ok in [ok for ok, d in self.open.items() if d.get("symbol") == k]:
                            self.open.pop(ok, None)
                for d in errors:
                    self.open[f"{d['code']}|{d['symbol']}|{d['by']}"] = d
                while len(self.open) > MAX_OPEN:
                    self.open.pop(next(iter(self.open)))
            self.add("edit" if mode == "commit" else "check", files=files[:8], keys=keys[:12],
                     verdict="reject" if rejected else ("warn" if diags else "accept"), seq=verdict.get("seq"),
                     tool=tool, diagnostics=diags[:6])
        except Exception:
            pass

    def inbox(self, items: List[Dict[str, Any]]) -> None:
        try:
            diags = []
            for item in items or []:
                d = item.get("diagnostic")
                if isinstance(d, dict):
                    diags.append(brief_diagnostic(d))
            if not (items or diags):
                return
            with self.lock:
                self.counters["inbox"] += len(items)
                for d in diags:
                    if d["severity"] == "error":
                        self.open[f"{d['code']}|{d['symbol']}|{d['by']}"] = d
            kinds = sorted({str(i.get("kind")) for i in items})
            self.add("inbox", count=len(items), items=kinds, diagnostics=diags[:6])
        except Exception:
            pass

    def gate(self, gate: str, allow: bool, open_errors: List[Dict[str, Any]], reason: str = "") -> None:
        try:
            diags = [brief_diagnostic(d) for d in open_errors if isinstance(d, dict)]
            with self.lock:
                # the gateway's own list of open errors is the truth: replace ours
                self.open = {f"{d['code']}|{d['symbol']}|{d['by']}": d for d in diags[:MAX_OPEN]}
            if not allow:
                self.add("gate", gate=gate, allow=False, reason=_trim(reason, 300), diagnostics=diags[:6])
            else:
                self.flush(force=True)
        except Exception:
            pass

    def checkpoint(self, sha: str, work: bool) -> None:
        self.add("commit", sha=sha[:10], work=bool(work))

    def release(self, keys: List[str], note: str) -> None:
        with self.lock:
            for ok in [ok for ok, d in self.open.items() if d.get("symbol") in keys]:
                self.open.pop(ok, None)
        self.add("release", keys=keys[:12], note=_trim(note, 200))

    def end(self) -> None:
        self.ended = True
        self.flush(force=True)

    # -- persistence ------------------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "v": 1, "pid": os.getpid(), **self.identity, "session": self.session,
                "reachable": self.reachable, "ended": self.ended, "started_at": round(self.started, 3),
                "updated_at": round(time.time(), 3), "counters": dict(self.counters),
                "open": list(self.open.values()), "events": list(self.events),
            }

    def flush(self, force: bool = False) -> None:
        if self.directory is None or self.path is None:
            return
        now = time.monotonic()
        if not force and now - self._last_write < WRITE_EVERY_S:
            self._dirty = True
            return
        self._last_write = now
        self._dirty = False
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            tmp = self.path.with_suffix(".tmp")
            data = json.dumps(self.snapshot(), ensure_ascii=False)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(data)
            os.replace(tmp, self.path)
        except Exception:
            pass

    def touch(self) -> None:
        """Heartbeat: keeps ``updated_at`` fresh so readers can tell a live session from a dead one."""
        self.flush(force=True)


# ----------------------------------------------------------------------------------------------
# readers (the tool, the slash command, the Desktop pane's backend)
# ----------------------------------------------------------------------------------------------

def pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except (ProcessLookupError, ValueError, TypeError):
        return False
    except PermissionError:
        return True
    return True


def read_all(cache_dir: Optional[Path] = None, now: Optional[float] = None) -> List[Dict[str, Any]]:
    """Every snapshot still worth showing, newest activity first. Adds ``live`` (its process is
    running and refreshed it recently). Deletes the files of dead processes older than a day."""
    now = now or time.time()
    out: List[Dict[str, Any]] = []
    directory = status_dir(cache_dir)
    try:
        files = list(directory.glob("*.json"))
    except OSError:
        return out
    for f in files:
        try:
            snap = json.loads(f.read_text())
        except Exception:
            continue
        if not isinstance(snap, dict):
            continue
        age = now - float(snap.get("updated_at") or 0)
        alive = pid_alive(snap.get("pid")) and not snap.get("ended")
        if age > STALE_AFTER_S and not alive:
            try:
                f.unlink()
            except OSError:
                pass
            continue
        snap["live"] = bool(alive and age < LIVE_WITHIN_S)
        snap["age_s"] = int(age)
        out.append(snap)
    out.sort(key=lambda s: (not s["live"], -float(s.get("updated_at") or 0)))
    return out
