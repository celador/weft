#!/usr/bin/env python3
"""Append Weft `land` records for kanban branches the PM merged into main with `git merge`.

Weft's own build lands outside Weft: the PM merges `wt/<key>` into main with git. Without a
`land` record (spec §4.2, §6.3) the merged cards' soft claims live until their TTL and later cards
get `claim_wait` against code that is already on main. Run this right after each merge:

    python3 packages/adapters/hermes/scripts/weft_land.py                 # the merge at HEAD of main
    python3 packages/adapters/hermes/scripts/weft_land.py --merge <sha>   # a given merge commit
    python3 packages/adapters/hermes/scripts/weft_land.py --recent 20     # catch up: last 20 merges
    python3 packages/adapters/hermes/scripts/weft_land.py --branch wt/x --sha <sha>  # fast-forward
    ... --dry-run                                                          # resolve + decide, no POST

For each merge it:
  1. maps the merged branch to kanban task ids: the weft board's kanban DB (`branch_name`, or
     `workspace_path` = `.worktrees/<key>` for `wt/<key>`), a `t_<hex8>` in the branch name, and the
     `[t_…]` tags / `Kanban-Task:` trailers of the commits the merge brought in (merge^1..merge^2);
  2. finds the Weft changes of those tasks (`GET /events?task=<id>`; the Hermes adapter names them
     `hermes-<profile>/<task id>`);
  3. lands each change that has accepted `edit`/`claim` records after its last accepted `land`:
     `POST /v1/repos/<repo>/system/events {kind:"land", base_seq:<head>, change,
     payload:{sha:<merge sha>, op_id}}` (op_id = uuid5 of repo/change/sha, so reruns are
     recognisable). Changes with no edits, already landed, or unknown to Weft are skipped;
  4. a rejected land (R1 trunk CAS: `stale_overwrite`) is logged and retried against a fresh head.
     git already holds the merge, so "rebase" here means re-reading Weft's trunk view.

Other repos: `--repo hermes-ios --git-dir ~/code/hermes-ios --ref rebrand/otto --trunk-ref
rebrand/otto --kanban-db ~/.hermes/kanban/boards/otto/kanban.db`. `--trunk-ref` is recorded in each
land payload (`trunk_ref: refs/heads/<branch>`), which is how Weft knows a repo's trunk branch.

`--note-install` appends a system `checkpoint` (no change) recording an install/release of trunk
(`payload {sha, ref, x_install: {build, target, devices}}`), so every agent and the Otto Weft
strip sees which build went where.

Token: a system token (scopes system+observe, repos [<repo>]) kept per repo under
`land_tokens.<repo>` in ~/.config/weft/hermes-adapter.json (mode 600; the legacy single `land`
entry is still read when its repo matches). It is minted on first use from the admin token
(~/.config/weft/preview-admin-token) and revoked by `install.py --uninstall`. Secrets are never
printed. Every decision is appended as one JSON line to ~/.cache/weft-hermes/land.log.

Exit status: 0 when every change was landed or legitimately skipped, 1 if any land failed.
This is a stopgap until B8's landing queue owns landing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from install import CONFIG, DEFAULT_ADMIN, DEFAULT_URL, admin_call, load_config, save_config  # noqa: E402

DEFAULT_GIT = "~/github/weft"
DEFAULT_KANBAN_DB = "~/.hermes/kanban/boards/weft/kanban.db"
LOG = Path(os.environ.get("WEFT_LAND_LOG", "~/.cache/weft-hermes/land.log")).expanduser()
TASK_RE = re.compile(r"\bt_[0-9a-f]{8}\b")
TAG_RE = re.compile(r"\[(t_[0-9a-f]{8})\]")
TRAILER_RE = re.compile(r"^(?:Kanban-Task|Task|Weft-Task):\s*(t_[0-9a-f]{8})\s*$", re.M | re.I)
MERGE_SUBJECT_RE = re.compile(r"^Merge (?:remote-tracking )?branch '([^']+)'")
NS = uuid.UUID("6f1b2c1e-9d7a-4c55-8a3e-5e2f0d7a1b10")  # uuid5 namespace for land op ids


# ---------------------------------------------------------------------------- pure helpers

def branch_from_subject(subject: str) -> Optional[str]:
    m = MERGE_SUBJECT_RE.match(subject.strip())
    if not m:
        return None
    b = m.group(1)
    return b[len("origin/"):] if b.startswith("origin/") else b


def tasks_from_messages(text: str) -> List[str]:
    """Task ids from `[t_xxxxxxxx]` tags and `Kanban-Task:`/`Task:` trailers, first-seen order."""
    seen: List[str] = []
    for m in list(TAG_RE.finditer(text)) + list(TRAILER_RE.finditer(text)):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def tasks_from_branch(branch: str) -> List[str]:
    return TASK_RE.findall(branch or "")


def tasks_from_kanban(db: Path, branch: str) -> List[str]:
    """Cards whose branch_name is `branch`, or whose worktree is `.worktrees/<key>` for `wt/<key>`."""
    if not branch or not db.exists():
        return []
    key = branch[3:] if branch.startswith("wt/") else branch
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        rows = con.execute(
            "SELECT id FROM tasks WHERE branch_name = ? OR workspace_path LIKE ? ORDER BY created_at",
            (branch, f"%/.worktrees/{key}"),
        ).fetchall()
        con.close()
    except sqlite3.Error:
        return []
    return [r[0] for r in rows]


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


# ---------------------------------------------------------------------------- gateway client

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
        req.add_header("User-Agent", "weft-land/0.1")  # Cloudflare 403s Python-urllib
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

    def events(self, **filters: str) -> Tuple[List[dict], int]:
        out: List[dict] = []
        after, head = 0, 0
        while True:
            q = "&".join(f"{k}={urllib.parse.quote(v, safe='')}" for k, v in filters.items())
            status, page = self.call("GET", f"/v1/repos/{self.repo}/events?after={after}&limit=500&{q}")
            if status != 200:
                raise RuntimeError(f"GET events -> HTTP {status}: {err_text(page)}")
            out += page["events"]
            head = page["head_seq"]
            if not page["has_more"] or page["next_after"] <= after:
                return out, head
            after = page["next_after"]

    def head(self) -> int:
        status, page = self.call("GET", f"/v1/repos/{self.repo}/events?tail=1&limit=1")
        if status != 200:
            raise RuntimeError(f"GET head -> HTTP {status}: {err_text(page)}")
        return int(page["head_seq"])

    def land(self, draft: dict) -> Tuple[int, Any]:
        return self.call("POST", f"/v1/repos/{self.repo}/system/events", draft)


def err_text(body: Any) -> str:
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return f"{body['error'].get('code')}: {body['error'].get('message')}"
    return str(body)[:200]


def trunk_ref_of(branch: Optional[str]) -> Optional[str]:
    if not branch:
        return None
    return branch if branch.startswith("refs/") else f"refs/heads/{branch}"


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

def git(repo_dir: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo_dir), *args], check=True, capture_output=True, text=True).stdout


def merge_info(repo_dir: Path, rev: str, branch: Optional[str] = None) -> dict:
    """{sha, branch, messages} for a merge commit (or a fast-forwarded tip with --branch)."""
    sha = git(repo_dir, "rev-parse", f"{rev}^{{commit}}").strip()
    parents = git(repo_dir, "rev-list", "--parents", "-n", "1", sha).split()[1:]
    subject = git(repo_dir, "log", "-1", "--format=%s", sha)
    if len(parents) >= 2:
        messages = git(repo_dir, "log", "--format=%B%n", f"{parents[0]}..{parents[1]}")
    else:
        messages = git(repo_dir, "log", "-1", "--format=%B", sha)
    return {"sha": sha, "branch": branch or branch_from_subject(subject), "subject": subject.strip(),
            "merge": len(parents) >= 2, "messages": messages}


def recent_merges(repo_dir: Path, ref: str, n: int) -> List[str]:
    out = git(repo_dir, "log", "--first-parent", "--merges", f"-n{n}", "--format=%H", ref).split()
    return list(reversed(out))  # oldest first, the order they landed


# ---------------------------------------------------------------------------- token

def note_install(gw: Gateway, sha: str, ref: str, install: Dict[str, Any]) -> Tuple[int, Any]:
    """System checkpoint (no change) recording that trunk ``sha`` was installed/released."""
    draft = {"kind": "checkpoint", "base_seq": gw.head(),
             "payload": {"sha": sha, "ref": ref, "x_install": install}}
    return gw.call("POST", f"/v1/repos/{gw.repo}/system/events", draft)


def cached_token(cfg: dict, url: str, repo: str) -> Optional[str]:
    """The repo's saved system token: `land_tokens.<repo>`, else the legacy single `land` entry."""
    entry = (cfg.get("land_tokens") or {}).get(repo) or {}
    if entry.get("token") and entry.get("url") == url:
        return entry["token"]
    entry = cfg.get("land") or {}
    if entry.get("token") and entry.get("url") == url and entry.get("repo") == repo:
        return entry["token"]
    return None


def system_token(cfg: dict, url: str, repo: str, admin_file: str) -> str:
    cached = cached_token(cfg, url, repo)
    if cached:
        return cached
    admin_path = Path(admin_file).expanduser()
    if not admin_path.exists():
        sys.exit(f"no system token in {CONFIG} and no admin token at {admin_path}")
    status, body = admin_call(url, admin_path.read_text().strip(), "POST", "/v1/admin/tokens",
                              {"principal": "weft-pm-land", "scopes": ["system", "observe"], "repos": [repo],
                               "label": "PM git-merge landings (weft_land.py)"})
    if status != 201 or not isinstance(body, dict):
        sys.exit(f"could not issue a system token: HTTP {status} {err_text(body)}")
    cfg = load_config()  # re-read: never clobber a concurrent installer write
    cfg.setdefault("land_tokens", {})[repo] = {"url": url, "repo": repo, "principal": "weft-pm-land",
                                               "token": body["token"], "token_id": body["info"]["id"]}
    save_config(cfg)
    print(f"issued system token {body['info']['id']} (principal weft-pm-land, repos [{repo}]); saved to {CONFIG}")
    return body["token"]


# ---------------------------------------------------------------------------- main

def write_log(rec: dict) -> None:
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **rec}) + "\n")
    except OSError:
        pass


def process(gw: Gateway, info: dict, kanban_db: Path, dry_run: bool,
            trunk_ref: Optional[str] = None) -> List[dict]:
    branch = info["branch"] or ""
    tasks: List[str] = []
    for t in tasks_from_kanban(kanban_db, branch) + tasks_from_branch(branch) + tasks_from_messages(info["messages"]):
        if t not in tasks:
            tasks.append(t)
    results: List[dict] = []
    base = {"sha": info["sha"][:12], "branch": branch or None}
    if not tasks:
        r = {**base, "result": "skip", "reason": "no kanban task id found for this merge"}
        write_log(r)
        return [r]
    for task in tasks:
        events, _ = gw.events(task=task)
        by_change: Dict[str, List[dict]] = {}
        for e in events:
            if e.get("change"):
                by_change.setdefault(e["change"], []).append(e)
        if not by_change:
            r = {**base, "task": task, "result": "skip", "reason": "no Weft change for this task"}
            write_log(r)
            results.append(r)
            continue
        for change, evs in sorted(by_change.items()):
            decision, reason = land_decision(evs)
            r = {**base, "task": task, "change": change}
            if decision == "skip":
                r.update(result="skip", reason=reason)
            elif dry_run:
                r.update(result="would_land", reason=reason)
            else:
                outcome, rec = post_land(gw, change, info["sha"], log=write_log, trunk_ref=trunk_ref)
                r.update(result=outcome, reason=reason)
                if rec:
                    r.update(seq=rec.get("seq"), keys=len(rec.get("writes") or []))
            write_log(r)
            results.append(r)
    return results


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--git-dir", default=DEFAULT_GIT, help="repo whose main received the merge")
    p.add_argument("--ref", default="main", help="trunk ref (for --recent and the default --merge)")
    p.add_argument("--merge", action="append", help="merge commit(s) to land (default: <ref>)")
    p.add_argument("--recent", type=int, help="examine the last N first-parent merges on <ref> (idempotent)")
    p.add_argument("--branch", help="branch name, for a fast-forward merge with no merge subject")
    p.add_argument("--sha", help="with --branch: the commit that is now on trunk")
    p.add_argument("--repo", help="Weft repo (default: config repo, else weft)")
    p.add_argument("--url", help="gateway URL (default: config url)")
    p.add_argument("--kanban-db", default=DEFAULT_KANBAN_DB)
    p.add_argument("--admin-token-file", default=DEFAULT_ADMIN)
    p.add_argument("--token-file", help="use this system token instead of the config's")
    p.add_argument("--trunk-ref", help="trunk branch recorded in each land (e.g. rebrand/otto)")
    p.add_argument("--note-install", metavar="JSON",
                   help='record an install of <ref>: {"build": "87", "target": "mac", "devices": [...]}')
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)

    cfg = load_config()
    url = a.url or cfg.get("url") or DEFAULT_URL
    repo = a.repo or cfg.get("repo") or "weft"
    token = (Path(a.token_file).expanduser().read_text().strip() if a.token_file
             else system_token(cfg, url, repo, a.admin_token_file))
    gw = Gateway(url, token, repo)
    git_dir = Path(a.git_dir).expanduser()
    trunk_ref = trunk_ref_of(a.trunk_ref)

    if a.note_install:
        install = json.loads(a.note_install)
        sha = git(git_dir, "rev-parse", f"{a.sha or a.ref}^{{commit}}").strip()
        status, rec = note_install(gw, sha, trunk_ref or trunk_ref_of(a.ref) or a.ref, install)
        ok = status == 200 and isinstance(rec, dict) and rec.get("status") == "accepted"
        write_log({"event": "install", "repo": repo, "sha": sha[:12], "install": install,
                   "result": "noted" if ok else f"http_{status}", **({"seq": rec.get("seq")} if ok else {})})
        print(f"{sha[:12]} install {install}: " + (f"noted seq #{rec.get('seq')}" if ok else f"HTTP {status} {err_text(rec)}"))
        return 0 if ok else 1

    infos: List[dict] = []
    if a.branch:
        infos.append(merge_info(git_dir, a.sha or a.ref, branch=a.branch))
    elif a.recent:
        infos += [merge_info(git_dir, s) for s in recent_merges(git_dir, a.ref, a.recent)]
    else:
        infos += [merge_info(git_dir, m) for m in (a.merge or [a.ref])]

    failed = False
    for info in infos:
        if not info["merge"] and not a.branch:
            print(f"{info['sha'][:12]} is not a merge commit ({info['subject'][:60]}); pass --branch for a fast-forward")
            continue
        for r in process(gw, info, Path(a.kanban_db).expanduser(), a.dry_run, trunk_ref):
            extra = f" seq #{r['seq']}" if r.get("seq") else ""
            print(f"{r['sha']} {r.get('branch') or '-'} {r.get('change') or r.get('task') or ''}: {r['result']}{extra} ({r.get('reason', '')})")
            if r["result"] not in ("landed", "skip", "would_land", "unknown_change"):
                failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
