#!/usr/bin/env python3
"""Auto-land: append the Weft ``land`` for every Hermes change whose work reached its repo's trunk.

Shared by the Hermes plugin (which spawns this file as a detached subprocess, ``--auto``) and
``scripts/weft_land.py`` (PM / backfill CLI). Stdlib only; no relative imports, so it runs both
as ``weft.land`` and as a plain script from ``<profile home>/plugins/weft/land.py``.

MAPPING (change -> commits). Workers' branch names and commit messages vary, so the mapping does
not read them. It uses the change's own ``checkpoint`` records: the Hermes adapter posts one for
every HEAD move of a worktree the session works in (``payload.sha``), and marks the ones that are
the session's own new commits with ``x_work: true`` (made by the command, not reachable from
trunk before it, not a ``git pull``). A change is landed when

  * it has accepted ``edit``/``claim`` records after its last accepted ``land``,
  * it recorded a work commit AFTER its last edit/claim (so the commit can hold all of its work;
    a change with edits after its last commit, or with no commit at all, is never landed), and
  * that newest work commit is on trunk: an ancestor of the trunk tip (merge commit or
    fast-forward), or patch-equivalent to trunk commits (rebase-and-merge).

The land's ``sha`` is the landing commit: the first commit on trunk's first-parent chain that
contains the work (the merge commit, or the commit itself for a fast-forward). That is
deterministic, so ``op_id = uuid5(repo, change, sha)`` is the same whoever detects it, and a
change whose ``op_id`` is already in the log is never landed twice.

TRUNK. Per repo: ``trunks.<repo>`` in the adapter config, else ``origin/HEAD``, else ``main``,
else ``master``. Tips: ``refs/heads/<trunk>`` and ``refs/remotes/origin/<trunk>``.

TOKEN. The system token (scopes system+observe, one repo) under ``land_tokens.<repo>`` in
``~/.config/weft/hermes-adapter.json``, issued by ``install.py --sync`` / ``weft_land.py``. This
file never reads the admin token: in ``--auto`` mode a repo without a land token is skipped.

BACKLOG. ``--auto`` only considers changes with work after a per-repo floor (its first run in
the repo minus ``AUTO_LOOKBACK_S``, or ``auto_land_since`` in the config) plus the calling
session's own commits; older unlanded changes are for the reviewed ``weft_land.py --all-repos``.

FAIL OPEN. Called detached; any error is logged (``--log``, the profile log) and leaves a pending
marker ``<cache>/land-pending/<repo>.json`` (with the hints) that the plugin retries on its next
opportunity. Payload sent: ``{kind:"land", base_seq, change, payload:{sha, op_id, trunk_ref}}``.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

NS = uuid.UUID("6f1b2c1e-9d7a-4c55-8a3e-5e2f0d7a1b10")  # uuid5 namespace for land op ids
SUMMARY_KINDS = "edit,claim,land,checkpoint"
LEGACY_WINDOW_S = 600  # a checkpoint without x_work counts if its commit is this recent
# Auto mode only considers changes with work after (first auto run in the repo - this): in-flight
# cards are covered, the older backlog is left to the reviewed `weft_land.py --all-repos` backfill.
AUTO_LOOKBACK_S = 6 * 3600
MAX_CANDIDATES = 30
SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")


def config_path() -> Path:
    return Path(os.environ.get("WEFT_HERMES_CONFIG", "~/.config/weft/hermes-adapter.json")).expanduser()


def cache_dir() -> Path:
    return Path(os.environ.get("WEFT_HERMES_CACHE", "~/.cache/weft-hermes")).expanduser()


def load_config(path: Optional[Path] = None) -> dict:
    try:
        return json.loads((path or config_path()).read_text())
    except Exception:
        return {}


# ---------------------------------------------------------------------------- pure helpers

def op_id(repo: str, change: str, sha: str) -> str:
    return str(uuid.uuid5(NS, f"{repo}\n{change}\n{sha}"))


def land_decision(events: Iterable[dict]) -> Tuple[str, str]:
    """('land'|'skip', reason) for one change, from its accepted records (any order).

    Land iff the change has an accepted edit/claim after its last accepted land: that is what holds
    claims and what later cards would wait on. A card that was reopened after an earlier land
    edits again and is landed again on the next merge.
    """
    last_work = last_land = 0
    for e in events:
        if e.get("status") != "accepted":
            continue
        if e.get("kind") in ("edit", "claim"):
            last_work = max(last_work, int(e["seq"]))
        elif e.get("kind") == "land":
            last_land = max(last_land, int(e["seq"]))
    if not last_work:
        return "skip", "no edits or claims"
    if last_land > last_work:
        return "skip", f"already landed (#{last_land})"
    return "land", f"work through #{last_work}" + (f", last land #{last_land}" if last_land else "")


def trunk_ref_of(branch: Optional[str]) -> Optional[str]:
    if not branch:
        return None
    return branch if branch.startswith("refs/") else f"refs/heads/{branch}"


def parse_ts(ts: Any) -> float:
    if isinstance(ts, (int, float)):
        return float(ts)
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def err_text(body: Any) -> str:
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return f"{body['error'].get('code')}: {body['error'].get('message')}"
    return str(body)[:200]


# ---------------------------------------------------------------------------- gateway client

class GatewayError(RuntimeError):
    pass


class Gateway:
    def __init__(self, url: str, token: str, repo: str, timeout: float = 15.0):
        self.base = url.rstrip("/")
        self.token = token
        self.repo = repo
        self.timeout = timeout

    def call(self, method: str, path: str, body: Any = None) -> Tuple[int, Any]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("WCP-Version", "0.1")
        req.add_header("User-Agent", "weft-land/0.2")  # Cloudflare 403s Python-urllib
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as err:
            try:
                return err.code, json.loads(err.read() or b"{}")
            except Exception:
                return err.code, None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
            return 0, {"error": {"code": "transport", "message": str(err)}}

    def events(self, start: int = 0, **filters: str) -> Tuple[List[dict], int]:
        out: List[dict] = []
        after, head = start, start
        while True:
            q = "&".join(f"{k}={urllib.parse.quote(v, safe=',')}" for k, v in filters.items())
            status, page = self.call("GET", f"/v1/repos/{self.repo}/events?after={after}&limit=500&{q}")
            if status != 200:
                raise GatewayError(f"GET events -> HTTP {status}: {err_text(page)}")
            out += page["events"]
            head = page["head_seq"]
            if not page["has_more"] or page["next_after"] <= after:
                return out, head
            after = page["next_after"]

    def head(self) -> int:
        status, page = self.call("GET", f"/v1/repos/{self.repo}/events?tail=1&limit=1")
        if status != 200:
            raise GatewayError(f"GET head -> HTTP {status}: {err_text(page)}")
        return int(page["head_seq"])

    def land(self, draft: dict) -> Tuple[int, Any]:
        return self.call("POST", f"/v1/repos/{self.repo}/system/events", draft)


def post_land(gw: Gateway, change: str, sha: str, retries: int = 3,
              sleep: Callable[[float], None] = time.sleep,
              log: Callable[[dict], None] = lambda r: None,
              trunk_ref: Optional[str] = None) -> Tuple[str, Optional[dict]]:
    """POST the land; on an R1 rejection log it, re-read head ("rebase") and retry."""
    oid = op_id(gw.repo, change, sha)
    for attempt in range(1, retries + 2):
        base = gw.head()
        payload: Dict[str, Any] = {"sha": sha, "op_id": oid}
        if trunk_ref:
            payload["trunk_ref"] = trunk_ref
        draft = {"kind": "land", "base_seq": base, "change": change, "payload": payload}
        status, rec = gw.land(draft)
        if status == 200 and isinstance(rec, dict) and rec.get("status") == "accepted":
            return "landed", rec
        if status == 200 and isinstance(rec, dict) and rec.get("status") == "rejected":
            diags = [f"{d.get('code')} {d.get('symbol')} (#{d.get('caused_by_seq')})" for d in rec.get("diagnostics", [])]
            log({"event": "land_rejected", "change": change, "sha": sha, "base_seq": base, "seq": rec.get("seq"),
                 "attempt": attempt, "diagnostics": diags})
            if attempt <= retries:
                sleep(min(2 ** attempt, 10))
                continue
            return "rejected", rec
        if isinstance(rec, dict) and (rec.get("error") or {}).get("code") == "invalid_reference":
            return "unknown_change", None
        log({"event": "land_error", "change": change, "sha": sha, "http": status, "error": err_text(rec), "attempt": attempt})
        if attempt <= retries and (status >= 500 or status == 0):
            sleep(min(2 ** attempt, 10))
            continue
        return f"http_{status}", None
    return "rejected", None


# ---------------------------------------------------------------------------- git

def git(repo_dir: Any, *args: str, timeout: float = 10.0) -> Optional[str]:
    """stdout of a git command, None on any failure (never raises)."""
    try:
        out = subprocess.run(["git", "-C", str(repo_dir), *args], capture_output=True, text=True, timeout=timeout)
        return out.stdout if out.returncode == 0 else None
    except Exception:
        return None


def _ref_exists(git_dir: Any, ref: str) -> bool:
    return git(git_dir, "rev-parse", "-q", "--verify", f"{ref}^{{commit}}") is not None


def detect_trunk(git_dir: Any, override: Optional[str] = None) -> Optional[str]:
    """The repo's trunk branch name: ``override``, else origin/HEAD, else main, else master."""
    if override:
        return override[len("refs/heads/"):] if override.startswith("refs/heads/") else override
    head = (git(git_dir, "symbolic-ref", "-q", "refs/remotes/origin/HEAD") or "").strip()
    if head.startswith("refs/remotes/origin/"):
        name = head[len("refs/remotes/origin/"):]
        if name and name != "HEAD" and (_ref_exists(git_dir, f"refs/heads/{name}")
                                        or _ref_exists(git_dir, f"refs/remotes/origin/{name}")):
            return name
    for name in ("main", "master"):
        if _ref_exists(git_dir, f"refs/heads/{name}") or _ref_exists(git_dir, f"refs/remotes/origin/{name}"):
            return name
    return None


def trunk_tips(git_dir: Any, branch: Optional[str]) -> Dict[str, str]:
    """{ref: sha} for the local trunk branch and its origin remote-tracking ref (those that exist)."""
    if not branch:
        return {}
    out = git(git_dir, "for-each-ref", "--format=%(refname) %(objectname)",
              f"refs/heads/{branch}", f"refs/remotes/origin/{branch}", timeout=5.0) or ""
    tips: Dict[str, str] = {}
    for line in out.splitlines():
        ref, _, sha = line.partition(" ")
        if ref in (f"refs/heads/{branch}", f"refs/remotes/origin/{branch}") and sha:
            tips[ref] = sha
    return tips


def is_ancestor(git_dir: Any, sha: str, tip: str) -> bool:
    try:
        return subprocess.run(["git", "-C", str(git_dir), "merge-base", "--is-ancestor", sha, tip],
                              capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


def commit_time(git_dir: Any, sha: str) -> Optional[float]:
    out = git(git_dir, "log", "-1", "--format=%ct", sha)
    try:
        return float(out.strip()) if out else None
    except ValueError:
        return None


def landing_commit(git_dir: Any, sha: str, tip: str) -> Optional[str]:
    """The first commit on ``tip``'s first-parent chain that contains ``sha``: the merge commit
    that brought it in, or ``sha`` itself when it is on the chain (fast-forward / direct commit).
    None when ``sha`` is not an ancestor of ``tip``."""
    full = (git(git_dir, "rev-parse", "-q", "--verify", f"{sha}^{{commit}}") or "").strip()
    tip_full = (git(git_dir, "rev-parse", "-q", "--verify", f"{tip}^{{commit}}") or "").strip()
    if not full or not tip_full or not is_ancestor(git_dir, full, tip_full):
        return None
    if full == tip_full:
        return full
    chain = set((git(git_dir, "rev-list", "--first-parent", f"{full}..{tip_full}") or "").split())
    for c in (git(git_dir, "rev-list", "--ancestry-path", "--reverse", "--topo-order", f"{full}..{tip_full}") or "").split():
        if c in chain:
            first_parent = (git(git_dir, "rev-parse", f"{c}^1") or "").strip()
            return full if first_parent == full else c
    return None


def equivalent_on_trunk(git_dir: Any, sha: str, tip: str, max_commits: int = 300) -> Optional[str]:
    """Rebase-and-merge: when every commit of ``sha`` since its merge base with ``tip`` has a
    patch-equivalent commit on ``tip``, the newest such trunk commit; else None."""
    out = git(git_dir, "rev-list", "--left-right", "--cherry-mark", "--topo-order", f"{tip}...{sha}", timeout=20.0)
    if out is None:
        return None
    lines = out.split()
    if not lines or len(lines) > max_commits * 2:
        return None
    # --left-right --cherry-mark prints '=' for patch-equivalent commits on EITHER side and
    # '<'/'>' for the rest, so the sides of the '=' lines come from a right-only listing.
    right = set((git(git_dir, "rev-list", "--right-only", f"{tip}...{sha}") or "").split())
    if not right:
        return None
    marks = {l[1:]: l[0] for l in lines}
    if any(marks.get(c) != "=" for c in right):
        return None  # some of the work has no equivalent on trunk
    left_eq = [l[1:] for l in lines if l[0] == "=" and l[1:] not in right]
    return left_eq[0] if left_eq else None  # topo order: newest first


def find_landing(git_dir: Any, sha: str, tips: Dict[str, str]) -> Optional[Tuple[str, str]]:
    """(landing commit, trunk ref) for ``sha`` on any trunk tip (local first), else None."""
    for ref in sorted(tips, key=lambda r: (not r.startswith("refs/heads/"), r)):
        hit = landing_commit(git_dir, sha, tips[ref])
        if hit:
            return hit, ref
    for ref in sorted(tips, key=lambda r: (not r.startswith("refs/heads/"), r)):
        eq = equivalent_on_trunk(git_dir, sha, tips[ref])
        if eq:
            hit = landing_commit(git_dir, eq, tips[ref])
            if hit:
                return hit, ref
    return None


# ---------------------------------------------------------------------------- change summaries

def new_summary() -> dict:
    return {"first_ts": 0.0, "last_work_ts": 0.0, "last_work": 0, "last_land": 0, "land_ops": [], "cands": []}


def summarize(events: Iterable[dict], changes: Optional[Dict[str, dict]] = None) -> Dict[str, dict]:
    """Fold accepted edit/claim/land/checkpoint records into per-change summaries (no content)."""
    changes = changes if changes is not None else {}
    for e in events:
        ch = e.get("change")
        if not ch or e.get("status") != "accepted":
            continue
        s = changes.setdefault(ch, new_summary())
        seq, ts, kind = int(e.get("seq", 0)), parse_ts(e.get("ts")), e.get("kind")
        p = e.get("payload") or {}
        if kind in ("edit", "claim"):
            s["last_work"] = max(s["last_work"], seq)
            s["last_work_ts"] = max(s["last_work_ts"], ts)
            s["first_ts"] = ts if not s["first_ts"] else min(s["first_ts"], ts)
        elif kind == "land":
            s["last_land"] = max(s["last_land"], seq)
            if p.get("op_id") and p["op_id"] not in s["land_ops"]:
                s["land_ops"].append(p["op_id"])
        elif kind == "checkpoint" and isinstance(p.get("sha"), str) and SHA_RE.match(p["sha"]):
            work = p.get("x_work")
            s["cands"].append([seq, p["sha"], ts, work if isinstance(work, bool) else None])
            s["cands"] = s["cands"][-MAX_CANDIDATES:]
    return changes


def newest_work_commit(git_dir: Any, s: dict, hints: List[str]) -> Optional[str]:
    """The change's newest own commit made after its last edit/claim, i.e. one that can contain
    all of its work (hints = the session's local commits, newest last). Edits made after the
    change's last commit are not known to be committed, so such a change is not landed."""
    for sha in reversed(hints):
        if git(git_dir, "rev-parse", "-q", "--verify", f"{sha}^{{commit}}") is None:
            continue
        ct = commit_time(git_dir, sha)
        if ct is not None and ct >= s["last_work_ts"] - 5:
            return sha
    for seq, sha, ts, work in reversed(s["cands"]):
        if seq <= s["last_work"] or work is False:
            continue
        if work is None:  # checkpoint from an adapter before 0.3: count only fresh commits
            ct = commit_time(git_dir, sha)
            if ct is None or not (ts - LEGACY_WINDOW_S <= ct <= ts + 120):
                continue
        elif git(git_dir, "rev-parse", "-q", "--verify", f"{sha}^{{commit}}") is None:
            continue
        return sha
    return None


def decide(repo: str, change: str, s: dict, git_dir: Any, tips: Dict[str, str],
           hints: Optional[List[str]] = None) -> Tuple[str, str, Optional[str], Optional[str]]:
    """(land|skip, reason, landing sha, trunk ref) for one change."""
    if not s["last_work"]:
        return "skip", "no edits or claims", None, None
    if s["last_land"] > s["last_work"]:
        return "skip", f"already landed (#{s['last_land']})", None, None
    if not tips:
        return "skip", "no trunk branch found", None, None
    sha = newest_work_commit(git_dir, s, hints or [])
    if not sha:
        return "skip", "no commit recorded after its last edit", None, None
    hit = find_landing(git_dir, sha, tips)
    if not hit:
        return "skip", f"latest commit {sha[:10]} is not on trunk", None, None
    landing, ref = hit
    if op_id(repo, change, landing) in s["land_ops"]:
        return "skip", f"already landed at {landing[:10]}", None, None
    branch_ref = "refs/heads/" + ref.split("/", 3)[3] if ref.startswith("refs/remotes/") else ref
    return "land", f"commit {sha[:10]} on trunk via {landing[:10]}", landing, branch_ref


# ---------------------------------------------------------------------------- state, lock, log

def _safe(repo: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", repo)


def state_path(repo: str, base: Optional[Path] = None) -> Path:
    return (base or cache_dir()) / "land-state" / f"{_safe(repo)}.json"


def pending_path(repo: str, base: Optional[Path] = None) -> Path:
    return (base or cache_dir()) / "land-pending" / f"{_safe(repo)}.json"


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


class RepoLock:
    """Exclusive per-repo lock: one sweep / land run per repo at a time (plugin + PM CLI)."""

    def __init__(self, repo: str, base: Optional[Path] = None, wait_s: float = 90.0):
        self.path = (base or cache_dir()) / "land-state" / f"{_safe(repo)}.lock"
        self.wait_s = wait_s
        self.fd: Optional[int] = None

    def __enter__(self) -> "RepoLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        deadline = time.monotonic() + self.wait_s
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() > deadline:
                    os.close(self.fd)
                    self.fd = None
                    raise TimeoutError(f"land lock busy: {self.path}")
                time.sleep(0.2)

    def __exit__(self, *_: Any) -> None:
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)


class Logger:
    def __init__(self, text_log: Optional[Path] = None, json_log: Optional[Path] = None, profile: str = "land"):
        self.text_log, self.json_log, self.profile = text_log, json_log, profile

    def __call__(self, rec: dict) -> None:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
        for path, line in ((self.json_log, json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **rec})),
                           (self.text_log, f"{stamp} [{self.profile}] auto-land " + " ".join(
                               f"{k}={v}" for k, v in rec.items() if v not in (None, "")))):
            if not path:
                continue
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a") as f:
                    f.write(line + "\n")
            except OSError:
                pass


# ---------------------------------------------------------------------------- sweep

def sweep(gw: Gateway, repo: str, git_dir: Any, *, trunk: Optional[str] = None,
          hints: Optional[Dict[str, List[str]]] = None, since_ts: float = 0.0, dry_run: bool = False,
          state: Optional[dict] = None, log: Callable[[dict], None] = lambda r: None,
          sleep: Callable[[float], None] = time.sleep) -> List[dict]:
    """Land every open change of ``repo`` whose newest work commit is on trunk.

    ``state`` (mutated in place when given) caches the folded summaries and the event cursor, so
    an auto run reads only the records appended since the previous one. Raises GatewayError when
    the gateway cannot be read; individual land failures are reported in the results.
    """
    hints = hints or {}
    branch = detect_trunk(git_dir, trunk)
    tips = trunk_tips(git_dir, branch)
    st = state if state is not None else {}
    if st.get("url") != gw.base:
        st.clear()
        st["url"] = gw.base
    changes = st.setdefault("changes", {})
    events, head = gw.events(start=int(st.get("cursor", 0)), kind=SUMMARY_KINDS)
    summarize(events, changes)
    st["cursor"] = head
    results: List[dict] = []
    for change in sorted(set(changes) | set(hints)):
        s = changes.get(change)
        if s is None:
            results.append({"repo": repo, "change": change, "result": "skip", "reason": "change unknown to Weft"})
            continue
        if since_ts and max(s["last_work_ts"], s["first_ts"]) < since_ts and change not in hints:
            continue
        if not s["last_work"] or (s["last_land"] > s["last_work"] and change not in hints):
            continue  # nothing open: not worth a line in every report
        decision, reason, sha, ref = decide(repo, change, s, git_dir, tips, hints.get(change))
        r: Dict[str, Any] = {"repo": repo, "change": change, "result": decision, "reason": reason}
        if sha:
            r["sha"] = sha
        if decision == "land" and dry_run:
            r["result"] = "would_land"
        elif decision == "land":
            outcome, rec = post_land(gw, change, sha, log=log, trunk_ref=ref, sleep=sleep)  # type: ignore[arg-type]
            r["result"] = outcome
            if rec and outcome == "landed":
                r["seq"] = rec.get("seq")
                s["last_land"] = max(s["last_land"], int(rec.get("seq") or 0))
                s["land_ops"].append(op_id(repo, change, sha))  # type: ignore[arg-type]
        results.append(r)
    st["swept_tips"] = tips
    st["trunk"] = branch
    return results


def run_auto(repo: str, git_dir: str, hints: Dict[str, List[str]], *, trunk: Optional[str] = None,
             dry_run: bool = False, log: Callable[[dict], None] = lambda r: None,
             cfg: Optional[dict] = None, base: Optional[Path] = None,
             sleep: Callable[[float], None] = time.sleep) -> Tuple[int, List[dict]]:
    """One plugin-triggered run for ``repo`` (locked, state-cached, pending marker on failure).
    Exit code 0 = done (landed or nothing to land), 1 = failed and left pending."""
    cfg = cfg if cfg is not None else load_config()
    url = os.environ.get("WEFT_HERMES_URL") or cfg.get("url") or ""
    entry = (cfg.get("land_tokens") or {}).get(repo) or {}
    token = entry.get("token") if entry.get("url") == url else None
    if not token and (cfg.get("land") or {}).get("repo") == repo and (cfg.get("land") or {}).get("url") == url:
        token = cfg["land"].get("token")
    trunk = trunk or (cfg.get("trunks") or {}).get(repo)
    pend = pending_path(repo, base)
    if not url or not token:
        log({"repo": repo, "result": "skip", "reason": "no land token for this repo (run install.py --sync)"})
        return 0, []
    try:
        with RepoLock(repo, base):
            old = _read_json(pend)
            for ch, shas in (old.get("hints") or {}).items():  # retry what a failed run left behind
                hints.setdefault(ch, [])
                hints[ch] = [s for s in shas if s not in hints[ch]] + hints[ch]
            spath = state_path(repo, base)
            state = _read_json(spath)
            floor = float(state.get("floor_ts") or 0) or time.time() - AUTO_LOOKBACK_S
            if cfg.get("auto_land_since"):
                floor = parse_ts(cfg["auto_land_since"]) or floor
            results = sweep(Gateway(url, token, repo, timeout=10.0), repo, git_dir, trunk=trunk, hints=hints,
                            since_ts=floor, dry_run=dry_run, state=state, log=log, sleep=sleep)
            state["floor_ts"] = floor
            if not dry_run:
                _write_json(spath, state)
            failed = [r for r in results if r["result"] not in ("landed", "skip", "would_land", "unknown_change")]
            for r in results:
                log(r)
            if failed and not dry_run:
                keep = {r["change"]: hints.get(r["change"], []) for r in failed}
                _write_json(pend, {"repo": repo, "git_dir": git_dir, "hints": keep, "ts": time.time(),
                                   "error": f"{len(failed)} land(s) failed"})
                return 1, results
            if pend.exists() and not dry_run:
                pend.unlink()
            return 0, results
    except Exception as err:  # gateway down, lock busy, bug: fail open, retry later
        log({"repo": repo, "result": "deferred", "reason": f"{type(err).__name__}: {err}"[:300]})
        if not dry_run:
            try:
                old = _read_json(pend)
                merged = dict(old.get("hints") or {})
                for ch, shas in hints.items():
                    merged[ch] = list(dict.fromkeys((merged.get(ch) or []) + shas))
                _write_json(pend, {"repo": repo, "git_dir": git_dir, "hints": merged, "ts": time.time(),
                                   "error": f"{type(err).__name__}: {err}"[:300]})
            except Exception:
                pass
        return 1, []


def parse_hints(values: Optional[List[str]]) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    for v in values or []:
        change, _, sha = v.rpartition("=")
        if change and SHA_RE.match(sha):
            out.setdefault(change, [])
            if sha not in out[change]:
                out[change].append(sha)
    return out


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--auto", action="store_true", help="plugin-triggered run (required)")
    p.add_argument("--repo", required=True)
    p.add_argument("--git-dir", required=True)
    p.add_argument("--hint", action="append", help="CHANGE=SHA: a work commit the session saw (may not be on the gateway yet)")
    p.add_argument("--trunk", help="trunk branch override")
    p.add_argument("--log", help="text log (the Hermes profile log)")
    p.add_argument("--profile", default="land")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    if not a.auto:
        p.error("--auto is required (use scripts/weft_land.py for manual landings)")
    log = Logger(Path(a.log).expanduser() if a.log else None, cache_dir() / "land.log", a.profile)
    code, _ = run_auto(a.repo, a.git_dir, parse_hints(a.hint), trunk=a.trunk, dry_run=a.dry_run, log=log)
    return code


if __name__ == "__main__":
    sys.exit(main())
