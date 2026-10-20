"""Weft adapter for Hermes Agent: maps Hermes plugin hooks onto WCP v0.1.

Hook mapping (docs/protocol/wcp-v0.md §8.3, Hermes ``hermes_cli/plugins.py``):

=====================================  ===========================================================
Hermes hook                            WCP
=====================================  ===========================================================
``pre_tool_call`` write_file / patch    analyze proposed before/after -> ``submit mode:"check"``;
                                       reject -> ``{"action":"block","message": context}`` (L2)
``post_tool_call`` (any edit)           real before/after -> ``submit mode:"commit"`` (L0)
``transform_tool_result``               append verdict/inbox ``context`` to the tool result (L1)
``pre_tool_call`` terminal ``git commit``  ``gate commit`` -> block while errors are open
``pre_tool_call`` kanban_complete /     ``gate stop`` -> block while errors are open (L3)
   kanban_request_review
``pre_verify``                          ``gate stop`` -> ``{"action":"continue"}`` (L3)
=====================================  ===========================================================

PROJECTS (0.2). Every git repo directly under ``~/github`` and ``~/code`` is a project and its own
Weft repo (named after the dir). Its ``.worktrees/*`` and any linked git worktree elsewhere whose
common git dir is the project map to the same repo. Explicit ``roots`` ({path, prefix, repo})
override discovery. ``~/.hermes``, dependencies, caches and build outputs are never reported.
One ``WeftAdapter`` (= one WCP session) per repo, created by ``WeftRouter`` on the first
in-scope tool call. A project with no token for this profile (no Weft repo yet) is a no-op with
one log line; ``scripts/install.py --sync`` creates repos + tokens for new projects.

MODES. Per repo (``modes`` in the config, default ``advise``). ``enforce``: pre-checks can block
edits and gates can refuse ``git commit`` / completion. ``advise``: never blocks and never waits:
no pre-check, and the commit (analysis + submit) runs on a background worker; its verdict reaches
the model with a later tool result.

FAIL OPEN. Hermes fails a ``pre_tool_call`` *closed* when it times out, so every network call is
short, every error lets the tool run (and is logged to ``~/.cache/weft-hermes/<profile>.log``),
and a circuit breaker (wcp.py) makes a dead or hung gateway cost at most one timeout per
``breaker_cooldown_s`` (default 300 s) for the whole process.
"""

from __future__ import annotations

import atexit
import difflib
import hashlib
import json
import os
import queue
import re
import select
import sqlite3
import subprocess
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

try:  # package import inside Hermes; flat import in tests
    from .wcp import WcpClient, WcpError
except ImportError:  # pragma: no cover
    from wcp import WcpClient, WcpError  # type: ignore

ADAPTER_VERSION = "0.2.0"
EDIT_TOOLS = {"write_file", "patch"}
TERMINAL_TOOLS = {"terminal"}
COMPLETION_TOOLS = {"kanban_complete", "kanban_request_review"}
# Never reported: VCS internals, dependencies, caches and build outputs.
SKIP_PARTS = {
    ".git", "node_modules", ".wrangler", ".turbo", "__pycache__", ".pnpm-store",
    "dist", "build", ".build", ".next", ".nuxt", ".svelte-kit", ".output", ".vercel", ".expo",
    "DerivedData", "Pods", "target", "coverage", ".venv", "venv", ".cache", ".parcel-cache",
    ".pytest_cache", ".mypy_cache", ".gradle",
}
ANALYZABLE = re.compile(r"\.(?:[cm]?ts|tsx|[cm]?js|jsx)$")
MAX_FILE_BYTES = 512 * 1024
MAX_SNAPSHOT_FILES = 300
DRAIN_EVERY_S = 20.0
RELEASE_AFTER_REFUSALS = 2
# Terminal commands that move other people's changes into the worktree: their file changes are
# not this agent's edits (a conflicted merge would otherwise claim every merged symbol).
GIT_INTEGRATION = re.compile(
    r"\bgit\b[^|;&]*\b(merge|rebase|pull|cherry-pick|revert|checkout|switch|reset|stash|am|restore|worktree)\b")

CAPABILITIES = {
    "level": 3,
    "observe": "sync",
    "inject": "immediate",
    "deny_edit": True,
    "refuse_stop": True,
    "commit_gate": "tool_interception",
}
# Advise repos never block (denials become advise text, gates stay open): they deliver L1 and
# MUST NOT declare L2/L3 (Agent Hooks Core §3.3). Deferred advise (async_advise) also never
# makes the agent wait and its verdicts reach the model with a later tool result.
ADVISORY_CAPABILITIES = {
    "level": 1,
    "observe": "sync",
    "inject": "immediate",
    "deny_edit": False,
    "refuse_stop": False,
    "commit_gate": False,
}


def capabilities_for(mode: str, async_advise: bool) -> dict:
    if mode == "enforce":
        return dict(CAPABILITIES)
    caps = dict(ADVISORY_CAPABILITIES)
    if async_advise:
        caps.update(observe="async", inject="delayed")
    return caps

DEFAULT_ROOTS: List[dict] = []          # explicit {path, prefix, repo} overrides (legacy: weft only)
DEFAULT_PROJECT_DIRS = ["~/github", "~/code"]
DEFAULT_EXCLUDES = ["~/.hermes"]
REPO_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def sanitize_repo(name: str) -> str:
    """Weft repo name for a project dir basename (gateway rule ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$)."""
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).lstrip("._-")[:64].rstrip("-")
    return s or "project"


def _real(p: str) -> str:
    return os.path.realpath(os.path.expanduser(p))


def discover_projects(dirs: List[str], explicit: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """{project dir (realpath): weft repo} for every top-level git repo in ``dirs``.

    A project is a direct child of a projects dir that is a git checkout (``.git`` dir or file).
    Names come from the basename; a later dir's duplicate gets ``<dirbasename>-<name>``.
    ``explicit`` (path -> repo) wins over discovery.
    """
    out: Dict[str, str] = {}
    taken: Dict[str, str] = {}
    for d in dirs:
        base = _real(d)
        try:
            children = sorted(os.listdir(base))
        except OSError:
            continue
        for name in children:
            full = os.path.join(base, name)
            if name.startswith(".") or not os.path.isdir(full) or not os.path.exists(os.path.join(full, ".git")):
                continue
            repo = sanitize_repo(name)
            if repo in taken and taken[repo] != full:
                repo = sanitize_repo(f"{os.path.basename(base)}-{name}")
            taken[repo] = full
            out[full] = repo
    for path, repo in (explicit or {}).items():
        out[_real(path)] = repo
    return out


# ------------------------------------------------------------------------------------------
# configuration
# ------------------------------------------------------------------------------------------

def current_profile() -> str:
    profile = os.environ.get("HERMES_PROFILE", "").strip()
    if profile:
        return profile
    home = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
    if home.parent.name == "profiles":
        return home.name
    return "default"


def default_config_path() -> Path:
    return Path(os.environ.get("WEFT_HERMES_CONFIG", "~/.config/weft/hermes-adapter.json")).expanduser()


@dataclass
class Root:
    path: str  # absolute, realpath'd
    prefix: str
    repo: str = ""  # "" = the config's default repo (legacy single-repo roots)


@dataclass
class Config:
    url: str
    repo: str
    token: str
    agent: str
    profile: str
    roots: List[Root]
    mode: str = "enforce"  # enforce (L2/L3 blocking) | advise (L1 only: never blocks)
    node: str = "node"
    analyzer: Optional[str] = None
    timeout: float = 4.0
    log_path: Optional[Path] = None
    # multi-repo (0.2): every project under ``project_dirs`` is its own Weft repo
    tokens: Dict[str, str] = field(default_factory=dict)   # repo -> agent token
    modes: Dict[str, str] = field(default_factory=dict)    # repo -> enforce|advise
    default_mode: str = "advise"
    project_dirs: List[str] = field(default_factory=list)  # realpath'd
    projects: Dict[str, str] = field(default_factory=dict)  # project dir -> repo (from install sync)
    excludes: List[str] = field(default_factory=list)      # realpath'd, never reported
    breaker_cooldown: float = 300.0
    async_advise: bool = True  # advise repos: skip the pre-check, commit off the tool-call path

    def mode_for(self, repo: str) -> str:
        forced = os.environ.get("WEFT_HERMES_MODE")
        if forced:
            return forced
        return self.modes.get(repo) or self.default_mode

    def for_repo(self, repo: str) -> Optional["Config"]:
        token = self.tokens.get(repo) or (self.token if repo == self.repo else "")
        if not token:
            return None
        return replace(self, repo=repo, token=token, mode=self.mode_for(repo))

    def scope(self) -> "Scope":
        return Scope(self.roots, projects=self.projects, project_dirs=self.project_dirs,
                     excludes=self.excludes, default_repo=self.repo)

    @staticmethod
    def load(path: Optional[Path] = None, profile: Optional[str] = None) -> Optional["Config"]:
        """Read the adapter config; None (adapter disabled) when absent or this profile has no agent."""
        path = path or default_config_path()
        profile = profile or current_profile()
        try:
            raw = json.loads(path.read_text())
        except Exception:
            return None
        if raw.get("enabled") is False:
            return None
        agents = raw.get("agents") or {}
        entry = agents.get(profile) or {}
        repo = str(raw.get("repo") or "")
        tokens: Dict[str, str] = {}
        for r, t in (entry.get("tokens") or {}).items():
            tok = t.get("token") if isinstance(t, dict) else t
            if tok:
                tokens[str(r)] = str(tok)
        # Candidate mode (a Hermes run as one best-of-N candidate, e.g. demo/otto): the launcher
        # pins this process to one repo with its own agent id, token and Change-Id.
        #   WEFT_HERMES_REPO + WEFT_HERMES_TOKEN  -> that repo's token (instead of the profile's)
        #   WEFT_HERMES_AGENT                     -> agent id (the token's agent)
        #   WEFT_HERMES_CHANGE / _TASK / _TASK_TITLE -> see WeftAdapter
        pinned = os.environ.get("WEFT_HERMES_REPO", "").strip()
        if pinned and os.environ.get("WEFT_HERMES_TOKEN"):
            tokens[pinned] = os.environ["WEFT_HERMES_TOKEN"]
            token = tokens.get(repo) or ""
        else:
            token = os.environ.get("WEFT_HERMES_TOKEN") or entry.get("token") or tokens.get(repo) or ""
        if repo and token:
            tokens.setdefault(repo, str(token))
        agent = os.environ.get("WEFT_HERMES_AGENT") or entry.get("agent") or f"hermes-{profile}"
        url = os.environ.get("WEFT_HERMES_URL") or raw.get("url")
        if not (url and tokens):
            return None
        roots = []
        for r in raw.get("roots") if raw.get("roots") is not None else DEFAULT_ROOTS:
            p = _real(str(r.get("path", "")))
            if p and p != "/":
                roots.append(Root(p, str(r.get("prefix", "")), str(r.get("repo") or "")))
        proj = raw.get("projects") or {}
        project_dirs = [_real(d) for d in (proj.get("dirs") or DEFAULT_PROJECT_DIRS)]
        projects = {_real(p): str(r) for p, r in (proj.get("repos") or {}).items()}
        excludes = [_real(x) for x in (raw.get("exclude") or DEFAULT_EXCLUDES)]
        analyzer = raw.get("analyzer")
        if not analyzer:
            here = Path(__file__).resolve().parent / "analyze.mjs"
            analyzer = str(here) if here.exists() else None
        cache = Path(os.environ.get("WEFT_HERMES_CACHE", "~/.cache/weft-hermes")).expanduser()
        modes = {str(k): str(v) for k, v in (raw.get("modes") or {}).items()}
        if repo and raw.get("mode") and repo not in modes:  # legacy single-repo "mode"
            modes[repo] = str(raw["mode"])
        cfg = Config(
            url=url, repo=repo, token=str(tokens.get(repo, "")), agent=str(agent), profile=profile,
            roots=roots, node=str(raw.get("node") or _find_node()), analyzer=analyzer,
            timeout=float(raw.get("timeout", 4.0)), log_path=cache / f"{profile}.log",
            tokens=tokens, modes=modes, default_mode=str(raw.get("default_mode") or "advise"),
            project_dirs=project_dirs, projects=projects, excludes=excludes,
            breaker_cooldown=float(raw.get("breaker_cooldown_s", 300.0)),
        )
        cfg.mode = cfg.mode_for(repo) if repo else cfg.default_mode
        return cfg


def _find_node() -> str:
    for candidate in ("/opt/homebrew/opt/node@24/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if os.path.exists(candidate):
            return candidate
    return "node"


# ------------------------------------------------------------------------------------------
# scope
# ------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Target:
    abs: str        # absolute path of the file
    worktree: str   # git worktree root containing it
    rel: str        # repo-relative POSIX path used in symbol keys (prefix included)
    repo: str = ""  # Weft repo the file belongs to


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


class Scope:
    """Maps a path to (Weft repo, root). Order: excludes -> explicit roots (longest first) ->
    projects (direct children of ``project_dirs``, incl. their ``.worktrees/*``) -> git worktrees
    living elsewhere whose common git dir belongs to a project."""

    def __init__(self, roots: List[Root], projects: Optional[Dict[str, str]] = None,
                 project_dirs: Optional[List[str]] = None, excludes: Optional[List[str]] = None,
                 default_repo: str = ""):
        self.roots = sorted(roots, key=lambda r: len(r.path), reverse=True)
        self.projects = dict(projects or {})
        self.project_dirs = list(project_dirs or [])
        self.excludes = list(excludes or [])
        self.default_repo = default_repo
        self._ext: Dict[str, Optional[Root]] = {}  # external worktree dir -> root (cache)

    def repo_of(self, root: Root) -> str:
        return root.repo or self.default_repo

    def _project_root(self, path: str) -> Optional[Root]:
        for d in self.project_dirs:
            if path.startswith(d + os.sep):
                name = path[len(d) + 1:].split(os.sep, 1)[0]
                proj = os.path.join(d, name)
                if proj in self.projects:
                    return Root(proj, "", self.projects[proj])
                if os.path.exists(os.path.join(proj, ".git")):
                    return Root(proj, "", sanitize_repo(name))  # unknown until `install.py --sync`
                return None
        return None

    def _external_root(self, path: str) -> Optional[Root]:
        """A linked git worktree outside the project dirs (``git worktree add /tmp/x``)."""
        d = path if os.path.isdir(path) else os.path.dirname(path)
        seen = []
        while True:
            if d in self._ext:
                hit = self._ext[d]
                break
            seen.append(d)
            dotgit = os.path.join(d, ".git")
            if os.path.isfile(dotgit):
                hit = self._linked_root(d, dotgit)
                break
            if os.path.isdir(dotgit):
                hit = None
                break
            parent = os.path.dirname(d)
            if parent == d:
                hit = None
                break
            d = parent
        if len(self._ext) > 4096:
            self._ext.clear()
        for s in seen:
            self._ext[s] = hit if hit and _under(s, hit.path) else None
        return hit

    def _linked_root(self, worktree: str, dotgit: str) -> Optional[Root]:
        try:
            with open(dotgit) as f:
                line = f.read(4096).strip()
            if not line.startswith("gitdir:"):
                return None
            gitdir = os.path.join(worktree, line[len("gitdir:"):].strip())
            common = gitdir
            cd = os.path.join(gitdir, "commondir")
            if os.path.isfile(cd):
                with open(cd) as f:
                    common = os.path.join(gitdir, f.read().strip())
            common = os.path.realpath(common)
        except OSError:
            return None
        if os.path.basename(common) != ".git":
            return None
        main = os.path.dirname(common)
        owner = self._explicit_root(main) or self._project_root(main)
        if not owner or main != owner.path:
            return None
        return Root(worktree, owner.prefix, self.repo_of(owner))

    def _explicit_root(self, path: str) -> Optional[Root]:
        for root in self.roots:
            if _under(path, root.path):
                return root
        return None

    def root_for(self, path: str) -> Optional[Root]:
        if any(_under(path, x) for x in self.excludes):
            return None
        root = self._explicit_root(path) or self._project_root(path)
        if root:
            return root
        if self.project_dirs or self.projects:
            return self._external_root(path)
        return None

    def resolve(self, path: Any, base_dir: Optional[str] = None) -> Optional[Target]:
        if not isinstance(path, str) or not path.strip():
            return None
        p = os.path.expanduser(path.strip())
        if not os.path.isabs(p):
            p = os.path.join(base_dir or os.getcwd(), p)
        # realpath the deepest existing ancestor so new files resolve like existing ones
        p = os.path.normpath(p)
        head, tail = p, []
        while head and not os.path.exists(head) and head != os.path.dirname(head):
            head, t = os.path.split(head)
            tail.insert(0, t)
        p = os.path.join(os.path.realpath(head), *tail) if tail else os.path.realpath(head)
        root = self.root_for(p)
        if not root:
            return None
        worktree = self.worktree_of(os.path.dirname(p), root.path)
        rel = os.path.relpath(p, worktree).replace(os.sep, "/")
        if rel.startswith(".."):
            return None
        parts = rel.split("/")
        if parts[0] == ".worktrees" and len(parts) > 2:  # a worktree dir without its own .git yet
            parts = parts[2:]
        if any(part in SKIP_PARTS for part in parts):
            return None
        return Target(p, worktree, root.prefix + "/".join(parts), self.repo_of(root))

    def locate_dir(self, directory: Any) -> Optional[Tuple[str, str]]:
        """(worktree root, repo) for an in-scope directory (terminal workdir), else None."""
        if not isinstance(directory, str) or not directory:
            return None
        d = os.path.realpath(os.path.expanduser(directory))
        if not os.path.isdir(d):
            return None
        root = self.root_for(d)
        if not root:
            return None
        return self.worktree_of(d, root.path), self.repo_of(root)

    def resolve_dir(self, directory: Any) -> Optional[str]:
        """Worktree root for an in-scope directory (terminal workdir), else None."""
        hit = self.locate_dir(directory)
        return hit[0] if hit else None

    def prefix_for(self, worktree: str) -> str:
        root = self.root_for(worktree)
        return root.prefix if root else ""

    @staticmethod
    def worktree_of(directory: str, root: str) -> str:
        d = directory
        while True:
            if os.path.exists(os.path.join(d, ".git")):
                return d
            if d == root or len(d) <= len(root):
                return root
            parent = os.path.dirname(d)
            if parent == d:
                return root
            d = parent


# ------------------------------------------------------------------------------------------
# analysis
# ------------------------------------------------------------------------------------------

class Analyzer:
    """Persistent ``node analyze.mjs --serve`` child; whole-file keys when unavailable."""

    def __init__(self, node: str, script: Optional[str], timeout: float = 6.0,
                 log: Callable[[str], None] = lambda _m: None):
        self.node, self.script, self.timeout, self.log = node, script, timeout, log
        self.proc: Optional[subprocess.Popen] = None
        self.lock = threading.Lock()
        self.broken = False
        self.seq = 0

    def _start(self) -> Optional[subprocess.Popen]:
        if self.broken or not self.script:
            return None
        if self.proc and self.proc.poll() is None:
            return self.proc
        try:
            self.proc = subprocess.Popen(
                [self.node, self.script, "--serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1)
            return self.proc
        except Exception as err:
            self.log(f"analyzer start failed: {err}")
            self.broken = True
            return None

    def _ask(self, files: List[dict], root: Optional[str] = None, prefix: str = "") -> Optional[dict]:
        with self.lock:
            proc = self._start()
            if not proc or not proc.stdin or not proc.stdout:
                return None
            self.seq += 1
            try:
                request: Dict[str, Any] = {"id": self.seq, "files": files}
                if root:
                    request["root"], request["prefix"] = root, prefix
                proc.stdin.write(json.dumps(request) + "\n")
                proc.stdin.flush()
                deadline = time.monotonic() + self.timeout
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError("analyzer timeout")
                    ready, _, _ = select.select([proc.stdout], [], [], left)
                    if not ready:
                        continue
                    line = proc.stdout.readline()
                    if not line:
                        raise EOFError("analyzer exited")
                    msg = json.loads(line)
                    if msg.get("id") == self.seq:
                        return msg if msg.get("ok") else None
            except Exception as err:
                self.log(f"analyzer failed: {err}")
                try:
                    proc.kill()
                except Exception:
                    pass
                self.proc = None
                return None

    def analyze(self, changes: List[Tuple[str, Optional[str], Optional[str]]], root: Optional[str] = None,
                prefix: str = "") -> Tuple[List[str], List[dict]]:
        """changes: [(rel_path, before|None, after|None)] -> (reads, writes). ``root``/``prefix``
        let the analyzer resolve relative imports against the checkout (cross-file reads)."""
        reads: List[str] = []
        writes: Dict[str, dict] = {}
        ts_files = [c for c in changes if ANALYZABLE.search(c[0])]
        result = self._ask([{"path": p, "before": b or "", "after": a or ""} for p, b, a in ts_files], root, prefix) \
            if ts_files else None
        analyzed = set(result.get("analyzed", [])) if result else set()
        if result:
            reads = list(result.get("reads", []))
            for w in result.get("writes", []):
                writes[w["key"]] = {"key": w["key"], "kind": w["kind"]}
        for path, before, after in changes:
            if path in analyzed or before == after:
                continue
            kind = "new" if before is None else "deleted" if after is None else "body"
            writes[file_key(path)] = {"key": file_key(path), "kind": kind}
        # A TS file whose text changed without symbol-level writes (comments, imports) yields no
        # write: nothing another agent could conflict with, so no edit event is sent for it.
        return sorted(set(reads) - set(writes)), list(writes.values())

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
                self.proc.wait(timeout=1)
            except Exception:
                self.proc.kill()


def file_key(rel: str) -> str:
    """Whole-file symbol key for files the TS analyzer does not understand."""
    return f"{rel.replace(' ', '_')}#*"


def unified_diff(rel: str, before: Optional[str], after: Optional[str]) -> str:
    a = (before or "").splitlines(keepends=True)
    b = (after or "").splitlines(keepends=True)
    return "".join(difflib.unified_diff(
        a, b, fromfile="/dev/null" if before is None else f"a/{rel}",
        tofile="/dev/null" if after is None else f"b/{rel}"))


def read_text(path: str) -> Optional[str]:
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def git(worktree: str, *args: str, timeout: float = 3.0) -> Optional[str]:
    try:
        out = subprocess.run(["git", "-C", worktree, *args], capture_output=True, text=True,
                             timeout=timeout)
        return out.stdout if out.returncode == 0 else None
    except Exception:
        return None


def normalize_tool(name: Any) -> str:
    n = str(name or "")
    for prefix in ("mcp__", "functions."):
        if n.startswith(prefix):
            n = n[len(prefix):]
    return n


# ------------------------------------------------------------------------------------------
# the adapter
# ------------------------------------------------------------------------------------------

@dataclass
class Pending:
    kind: str                                   # "edit" | "terminal"
    tool: str
    call_id: str
    targets: List[Target] = field(default_factory=list)
    before: Dict[str, Optional[str]] = field(default_factory=dict)   # abs -> text
    worktree: Optional[str] = None
    head: Optional[str] = None
    snapshot: Dict[str, Optional[str]] = field(default_factory=dict)  # rel(no prefix) -> text
    integration: bool = False  # git merge/rebase/...: record HEAD moves only, not file changes


class WeftAdapter:
    def __init__(self, config: Config, client: Optional[WcpClient] = None,
                 analyzer: Optional[Analyzer] = None, heartbeat: bool = True,
                 scope: Optional[Scope] = None):
        self.cfg = config
        self.scope = scope or config.scope()
        self.client = client or WcpClient(config.url, config.token, config.repo, config.timeout,
                                          breaker_cooldown=config.breaker_cooldown)
        self.analyzer = analyzer or Analyzer(config.node, config.analyzer, log=self.log)
        self._work: "queue.Queue[Callable[[], None]]" = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self.lock = threading.RLock()
        self.hello_lock = threading.RLock()
        self.session: Optional[str] = None
        self.welcome: Dict[str, Any] = {}
        self.base_seq = 0                # last delivered_through passed to the model
        self.rebase_floor: Optional[int] = None  # keep base < this until a checkpoint (§5.2)
        self.acked = 0                   # highest inbox id passed to the model
        self.pending: Dict[str, Pending] = {}
        self.outbox: List[Tuple[str, int, int]] = []  # (text, delivered_through, max inbox id)
        self.last_contact = 0.0
        self.last_drain = 0.0
        self.refusals: Dict[str, int] = {}  # open-error fingerprint -> consecutive refusals
        self.task = self._task_info()
        self.change = os.environ.get("WEFT_HERMES_CHANGE", "").strip() or f"{config.agent}/{self.task['id']}"
        self._hb_thread: Optional[threading.Thread] = None
        self._hb_enabled = heartbeat
        self._closed = False

    # -- infra -----------------------------------------------------------------------------

    @property
    def deferred(self) -> bool:
        """Advise repos never make the agent wait on the gateway: no pre-check, and the commit
        (analysis + submit) runs on a background worker; its verdict reaches the model with a
        later tool result."""
        return self.cfg.mode != "enforce" and self.cfg.async_advise

    def _defer(self, fn: Callable[[], None]) -> None:
        if not self.deferred:
            fn()
            return
        self._work.put(fn)
        if not (self._worker and self._worker.is_alive()):
            self._worker = threading.Thread(target=self._work_loop, name=f"weft-{self.cfg.repo}", daemon=True)
            self._worker.start()

    def _work_loop(self) -> None:
        while True:
            fn = self._work.get()
            try:
                fn()
            except Exception as err:
                self.log(f"[{self.cfg.repo}] deferred submit failed open: {err!r}")
            finally:
                self._work.task_done()

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait (bounded) for deferred submissions; True when the queue drained."""
        deadline = time.monotonic() + timeout
        while self._work.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)
        return not self._work.unfinished_tasks

    def log(self, message: str) -> None:
        path = self.cfg.log_path
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > 1_000_000:
                path.replace(path.with_suffix(".log.1"))
            with path.open("a") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{self.cfg.profile}] {message}\n")
        except Exception:
            pass

    def _task_info(self) -> Dict[str, Any]:
        pinned = os.environ.get("WEFT_HERMES_TASK", "").strip()
        if pinned:  # candidate mode: the launcher names the task (and its title) explicitly
            info: Dict[str, Any] = {"id": pinned}
            if os.environ.get("WEFT_HERMES_TASK_TITLE"):
                info["title"] = os.environ["WEFT_HERMES_TASK_TITLE"][:200]
            return info
        task_id = os.environ.get("HERMES_KANBAN_TASK", "").strip()
        if not task_id:
            sid = os.environ.get("HERMES_SESSION_ID", "").strip() or f"pid{os.getpid()}"
            return {"id": f"adhoc-{sid}"}
        info: Dict[str, Any] = {"id": task_id}
        db = os.environ.get("HERMES_KANBAN_DB")
        if db and os.path.exists(db):
            try:
                con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
                row = con.execute("select title, priority from tasks where id = ?", (task_id,)).fetchone()
                con.close()
                if row:
                    if row[0]:
                        info["title"] = str(row[0])[:200]
                    if row[1] is not None:
                        info["priority"] = int(row[1])
            except Exception as err:
                self.log(f"kanban lookup failed: {err}")
        return info

    def _base_dir(self) -> str:
        return os.environ.get("HERMES_KANBAN_WORKSPACE") or os.getcwd()

    # -- session ---------------------------------------------------------------------------

    def ensure_session(self) -> Optional[str]:
        # hello_lock, not self.lock: a slow hello on the background worker must never stall the
        # tool-call thread, which only needs self.lock for in-memory bookkeeping.
        with self.hello_lock:
            if self.session:
                return self.session
            agent = {"id": self.cfg.agent, "harness": "hermes",
                     "adapter": f"@weft/adapter-hermes@{ADAPTER_VERSION}"}
            if os.environ.get("HERMES_MODEL"):
                agent["model"] = os.environ["HERMES_MODEL"]
            welcome = self.client.hello(agent, capabilities_for(self.cfg.mode, self.cfg.async_advise),
                                        task=self.task, change=self.change)
            self.session = welcome["session"]
            self.welcome = welcome
            # A fresh session's events cannot claim to account for more than it was delivered.
            self.base_seq = min(self.base_seq, int(welcome.get("delivered_through", 0))) \
                if self.base_seq else int(welcome.get("delivered_through", 0))
            self.acked = 0
            self.last_contact = time.monotonic()
            self.log(f"hello -> session {self.session} change {self.change} head {welcome.get('head_seq')}")
            self._start_heartbeat()
            return self.session

    def _call(self, fn: Callable[[str], Any]) -> Any:
        """Run ``fn(session)``; re-hello once if the session expired (§8.2)."""
        session = self.ensure_session()
        try:
            result = fn(session)  # type: ignore[arg-type]
        except WcpError as err:
            if err.code not in ("session_expired",):
                raise
            with self.hello_lock:
                self.log("session expired; re-hello")
                self.session = None
            result = fn(self.ensure_session())  # type: ignore[arg-type]
        self.last_contact = time.monotonic()
        return result

    def _start_heartbeat(self) -> None:
        if not self._hb_enabled or (self._hb_thread and self._hb_thread.is_alive()):
            return
        interval = max(5.0, float(self.welcome.get("heartbeat_interval_ms", 30000)) / 1000.0)

        def loop() -> None:
            while not self._closed:
                time.sleep(interval)
                if self._closed or not self.session:
                    continue
                if time.monotonic() - self.last_contact < interval * 0.8:
                    continue
                try:
                    self._call(lambda s: self.client.heartbeat(s))
                except Exception as err:
                    self.log(f"heartbeat failed: {err}")

        self._hb_thread = threading.Thread(target=loop, name="weft-heartbeat", daemon=True)
        self._hb_thread.start()

    def close(self, close_analyzer: bool = True) -> None:
        self.flush(5.0)
        self._closed = True
        if self.session:
            try:
                self.client.bye(self.session, "hermes process exit")
            except Exception:
                pass
        if close_analyzer:
            self.analyzer.close()

    # -- base / inbox bookkeeping ----------------------------------------------------------

    def _effective_base(self) -> int:
        base = self.base_seq
        if self.rebase_floor is not None:
            base = min(base, self.rebase_floor - 1)
        return max(0, base)

    def _note_items(self, items: List[dict]) -> int:
        top = 0
        for item in items or []:
            top = max(top, int(item.get("id", 0)))
            if item.get("requires_rebase") and item.get("kind") == "trunk":
                seq = int(item.get("seq", 0))
                self.rebase_floor = seq if self.rebase_floor is None else min(self.rebase_floor, seq)
        return top

    def _queue(self, response: dict, extra: str = "") -> None:
        """Queue a verdict/inbox response's context for injection into the model."""
        context = response.get("context") or ""
        top = self._note_items(response.get("inbox") or response.get("items") or [])
        text = "\n".join(t for t in (extra, context) if t)
        self.outbox.append((text, int(response.get("delivered_through", 0)), top))

    def _take_outbox(self) -> str:
        """Pop queued text; the model is about to see it, so advance base and ack (§5.2, §5.4)."""
        with self.lock:
            texts = []
            for text, delivered, top in self.outbox:
                if text:
                    texts.append(text)
                self.base_seq = max(self.base_seq, delivered)
                self.acked = max(self.acked, top)
            self.outbox.clear()
        return "\n".join(texts)

    # -- events ----------------------------------------------------------------------------

    def _event(self, files: List[str], reads: List[str], writes: List[dict], diff: str,
               tool: str, call_id: str, hook: str) -> dict:
        event: Dict[str, Any] = {
            "kind": "edit", "base_seq": self._effective_base(), "files": files, "reads": reads,
            "writes": writes, "tool": {"name": tool, "harness_event": hook},
        }
        if call_id:
            event["tool"]["call_id"] = call_id[:200]
        title = self.task.get("title")
        if title:
            event["intent"] = f"{self.task['id']}: {title}"
            event["summary_hint"] = title[:100]
        max_diff = int((self.welcome.get("limits") or {}).get("max_diff_bytes", 1 << 20))
        if diff and len(diff.encode("utf-8")) <= max_diff:
            event["diff"] = diff
        return event

    def _submit(self, mode: str, event: dict, call_id: str) -> dict:
        key = f"{self.change}:{call_id or hashlib.sha1(json.dumps(event, sort_keys=True).encode()).hexdigest()}:{mode}"
        return self._call(lambda s: self.client.submit(s, mode, event, inbox_ack=self.acked or None,
                                                       idempotency_key=key))

    # -- hook: pre_tool_call ---------------------------------------------------------------

    def pre_tool_call(self, tool_name: str = "", args: Optional[dict] = None, tool_call_id: str = "",
                      **_: Any) -> Optional[dict]:
        name = normalize_tool(tool_name)
        args = args if isinstance(args, dict) else {}
        try:
            if name in EDIT_TOOLS:
                return self._pre_edit(name, args, tool_call_id)
            if name in TERMINAL_TOOLS:
                return self._pre_terminal(name, args, tool_call_id)
            if name in COMPLETION_TOOLS:
                return self._gate_tool(name)
        except Exception as err:  # fail open
            self.log(f"pre_tool_call {name} failed open: {err!r}")
        return None

    def _edit_targets(self, name: str, args: dict) -> List[Target]:
        base = self._base_dir()
        paths = edit_paths(name, args)
        out = []
        for p in paths:
            t = self.scope.resolve(p, base)
            if t and t.repo == self.cfg.repo and t not in out:
                out.append(t)
        return out

    @staticmethod
    def _proposed(name: str, args: dict, before: Optional[str]) -> Optional[str]:
        if name == "write_file":
            content = args.get("content")
            return content if isinstance(content, str) else None
        if name == "patch" and args.get("mode", "replace") == "replace" and before is not None:
            old, new = args.get("old_string"), args.get("new_string")
            if not isinstance(old, str) or not isinstance(new, str) or not old or old not in before:
                return None  # Hermes may fuzzy-match; skip the pre-check, the commit still runs
            return before.replace(old, new) if args.get("replace_all") else before.replace(old, new, 1)
        return None

    def _pre_edit(self, name: str, args: dict, call_id: str) -> Optional[dict]:
        targets = self._edit_targets(name, args)
        if not targets:
            return None  # SCOPE GUARD: not a weft path
        pend = Pending("edit", name, call_id or f"anon-{time.monotonic_ns()}", targets=targets)
        for t in targets:
            pend.before[t.abs] = read_text(t.abs) if os.path.exists(t.abs) else None
        with self.lock:
            self.pending[pend.call_id] = pend
        if len(targets) != 1 or self.deferred:
            return None  # advise repos: no pre-check round trip (the commit verdict still advises)
        t = targets[0]
        after = self._proposed(name, args, pend.before[t.abs])
        if after is None or after == pend.before[t.abs]:
            return None
        reads, writes = self.analyzer.analyze([(t.rel, pend.before[t.abs], after)], t.worktree,
                                              self.scope.prefix_for(t.worktree))
        if not writes:
            return None
        event = self._event([t.rel], reads, writes, unified_diff(t.rel, pend.before[t.abs], after),
                            name, pend.call_id, "pre_tool_call")
        verdict = self._submit("check", event, pend.call_id)
        if verdict.get("verdict") != "reject":
            return None  # warnings reach the model with the commit verdict (§8.3 step 2)
        if self.cfg.mode != "enforce":
            self._queue(verdict, "[weft] (advisory) this edit would be rejected:")
            return None
        with self.lock:
            self.pending.pop(pend.call_id, None)
            self._queue(verdict)
            context = self._take_outbox()
        self.log(f"check rejected {t.rel} seq {verdict.get('seq')}")
        return {"action": "block", "message": (
            "[weft] Edit blocked by Weft edit-time coordination (another agent's change conflicts "
            f"with this edit to {t.rel}). Diagnostics:\n{context}\n"
            "Re-read the cited symbols, adapt your edit to the current code, then retry. The log "
            "base has advanced, so a corrected edit will be validated against the new state.")}

    def _pre_terminal(self, name: str, args: dict, call_id: str) -> Optional[dict]:
        workdir = args.get("workdir") or self._base_dir()
        hit = self.scope.locate_dir(workdir)
        if not hit or hit[1] != self.cfg.repo:
            return None  # SCOPE GUARD
        worktree = hit[0]
        command = str(args.get("command") or "")
        if self.session and re.search(r"\bgit\b[^|;&]*\bcommit\b", command):
            block = self._gate("commit", "git commit")
            if block:
                return block
        pend = Pending("terminal", name, call_id or f"anon-{time.monotonic_ns()}", worktree=worktree)
        pend.head = (git(worktree, "rev-parse", "HEAD") or "").strip() or None
        pend.integration = bool(GIT_INTEGRATION.search(command))
        if not pend.integration:
            pend.snapshot = self._dirty_snapshot(worktree)
        with self.lock:
            self.pending[pend.call_id] = pend
        return None

    def _dirty_snapshot(self, worktree: str) -> Dict[str, Optional[str]]:
        out = git(worktree, "status", "--porcelain", "-z", "--untracked-files=all")
        snap: Dict[str, Optional[str]] = {}
        if out is None:
            return snap
        entries = out.split("\0")
        i = 0
        while i < len(entries) and len(snap) < MAX_SNAPSHOT_FILES:
            entry = entries[i]
            i += 1
            if len(entry) < 4:
                continue
            status, rel = entry[:2], entry[3:]
            if "R" in status or "C" in status:
                i += 1  # skip the rename source
            if any(part in SKIP_PARTS for part in rel.split("/")):
                continue
            full = os.path.join(worktree, rel)
            snap[rel] = read_text(full) if os.path.isfile(full) else None
        return snap

    # -- gates -----------------------------------------------------------------------------

    def _gate_tool(self, name: str) -> Optional[dict]:
        if not self.session:
            return None  # no in-scope activity in this process: not a weft card
        return self._gate("stop", name)

    def _gate(self, gate: str, what: str) -> Optional[dict]:
        if self.cfg.mode != "enforce":
            return None
        result = self._call(lambda s: self.client.gate(s, gate))
        if result.get("allow", True):
            self.refusals.clear()
            return None
        open_errors = result.get("open_errors") or []
        keys = sorted({d.get("symbol") for d in open_errors if d.get("symbol")})
        fingerprint = f"{gate}:{','.join(keys)}"
        n = self.refusals.get(fingerprint, 0) + 1
        self.refusals[fingerprint] = n
        if n > RELEASE_AFTER_REFUSALS and keys:
            # The agent insisted after being told twice: treat it as a deliberate retreat and
            # release those keys (spec §6.3: release clears matching open errors). The release
            # record is visible in the feed, so humans see what was walked away from.
            self._release(keys, f"retreat: {what} after {n - 1} gate refusals")
            self.refusals.pop(fingerprint, None)
            return None
        self.log(f"gate {gate} refused ({len(open_errors)} open errors) for {what}")
        return {"action": "block", "message": (
            f"[weft] {what} refused by the Weft {gate} gate: {result.get('reason') or 'open errors'}\n"
            "Resolve each error by re-editing the cited symbols against the current code (an "
            "accepted edit that touches the symbol clears it). If you deliberately retreated from "
            f"these symbols, retry {what} {RELEASE_AFTER_REFUSALS} more time(s) and Weft will "
            "release them (recorded in the Weft feed).")}

    def _release(self, keys: List[str], reason: str) -> None:
        event = {"kind": "release", "base_seq": self._effective_base(),
                 "payload": {"keys": keys, "reason": reason[:200]}}
        try:
            verdict = self._submit("commit", event, f"release-{hashlib.sha1(reason.encode()).hexdigest()[:10]}-{time.time_ns()}")
            self._queue(verdict)
            self.log(f"released {keys}: {reason}")
        except Exception as err:
            self.log(f"release failed: {err}")

    def pre_verify(self, **_: Any) -> Optional[dict]:
        if not self.session or self.cfg.mode != "enforce":
            return None
        try:
            result = self._call(lambda s: self.client.gate(s, "stop"))
        except Exception as err:
            self.log(f"pre_verify gate failed open: {err}")
            return None
        if result.get("allow", True):
            return None
        return {"action": "continue", "message": (
            f"[weft] Not done yet: {result.get('reason') or 'open Weft errors'}\n"
            "Fix these conflicts (re-edit the cited symbols against the current code) before finishing.")}

    # -- hook: post_tool_call --------------------------------------------------------------

    def post_tool_call(self, tool_name: str = "", args: Optional[dict] = None, tool_call_id: str = "",
                       **_: Any) -> None:
        name = normalize_tool(tool_name)
        with self.lock:
            pend = self.pending.pop(tool_call_id, None) if tool_call_id else None
            if pend is None and not tool_call_id:
                # no call id: match the oldest pending call of this tool
                for k, p in list(self.pending.items()):
                    if p.tool == name:
                        pend = self.pending.pop(k)
                        break
        try:
            if pend and pend.kind == "edit":
                changes = [(t, pend.before.get(t.abs), self._current(t.abs)) for t in pend.targets]
                self._defer(lambda: self._commit_changes(changes, name, pend.call_id))
            elif pend and pend.kind == "terminal":
                self._post_terminal(pend)
            elif self.session and time.monotonic() - self.last_drain > DRAIN_EVERY_S:
                self.last_drain = time.monotonic()
                self._defer(self._drain)
        except Exception as err:
            self.log(f"post_tool_call {name} failed: {err!r}")

    @staticmethod
    def _current(path: str) -> Optional[str]:
        return read_text(path) if os.path.exists(path) else None

    def _commit_changes(self, changes: List[Tuple[Target, Optional[str], Optional[str]]], tool: str,
                        call_id: str) -> None:
        changes = [c for c in changes if c[1] != c[2]]
        if not changes:
            return
        rels = [(t.rel, b, a) for t, b, a in changes]
        worktree = changes[0][0].worktree
        reads, writes = self.analyzer.analyze(rels, worktree, self.scope.prefix_for(worktree))
        if not writes:
            return
        diff = "".join(unified_diff(r, b, a) for r, b, a in rels)
        event = self._event([r for r, _, _ in rels], reads, writes, diff, tool, call_id, "post_tool_call")
        verdict = self._submit("commit", event, call_id)
        self.log(f"commit {[r for r, _, _ in rels]} -> {verdict.get('verdict')} seq {verdict.get('seq')}")
        self._queue(verdict)
        self.last_drain = time.monotonic()

    def _post_terminal(self, pend: Pending) -> None:
        worktree = pend.worktree or ""
        prefix = self.scope.prefix_for(worktree)
        head = (git(worktree, "rev-parse", "HEAD") or "").strip() or None
        integrating = pend.integration or bool(git(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"))
        after = {} if integrating else self._dirty_snapshot(worktree)
        changes: List[Tuple[Target, Optional[str], Optional[str]]] = []
        for rel in ([] if integrating else sorted(set(pend.snapshot) | set(after))):
            was_dirty, is_dirty = rel in pend.snapshot, rel in after
            if was_dirty and is_dirty:
                before_text, after_text = pend.snapshot[rel], after[rel]
            elif is_dirty:  # newly dirty: before = HEAD version (if HEAD did not move)
                if head != pend.head:
                    continue
                shown = git(worktree, "show", f"HEAD:{rel}")
                before_text, after_text = shown, after[rel]
            else:  # was dirty, now clean: reverted (HEAD same) or committed (HEAD moved)
                if head != pend.head:
                    continue
                before_text, after_text = pend.snapshot[rel], self._current(os.path.join(worktree, rel))
            if before_text == after_text:
                continue
            changes.append((Target(os.path.join(worktree, rel), worktree, prefix + rel), before_text, after_text))
        moved = bool(head and pend.head and head != pend.head)
        if not changes and not moved:
            if self.session and time.monotonic() - self.last_drain > DRAIN_EVERY_S:
                self.last_drain = time.monotonic()
                self._defer(self._drain)
            return

        def send() -> None:
            if changes:
                self._commit_changes(changes, pend.tool, pend.call_id)
            if moved:
                event = {"kind": "checkpoint", "base_seq": self._effective_base(), "payload": {"sha": head},
                         "tool": {"name": pend.tool, "harness_event": "post_tool_call"}}
                if self.task.get("title"):
                    event["summary_hint"] = self.task["title"][:100]
                verdict = self._submit("commit", event, f"{pend.call_id}:checkpoint")
                self._queue(verdict)
                # A new commit on the worktree: assume it is rebased. Cleared after _queue, because
                # this verdict repeats any still-unacked trunk item and would re-set the floor.
                self.rebase_floor = None
        self._defer(send)

    def _drain(self) -> None:
        batch = self._call(lambda s: self.client.drain(s, ack=self.acked or None))
        self.last_drain = time.monotonic()
        if batch.get("items"):
            self._queue(batch)

    # -- hook: transform_tool_result -------------------------------------------------------

    def transform_tool_result(self, tool_name: str = "", result: Any = None, **_: Any) -> Optional[str]:
        if not self.outbox:
            return None
        text = self._take_outbox()
        if not text or not isinstance(result, str):
            return None
        block = f"[weft diagnostics]\n{text}"
        try:
            parsed = json.loads(result)
            if isinstance(parsed, dict):
                parsed["weft_diagnostics"] = block
                return json.dumps(parsed, ensure_ascii=False)
        except Exception:
            pass
        return f"{result}\n\n{block}"


# ------------------------------------------------------------------------------------------
# multi-repo router: one WeftAdapter (= one WCP session) per Weft repo, opened lazily
# ------------------------------------------------------------------------------------------

class WeftRouter:
    """Routes each hook to the per-repo adapter(s) its paths resolve to.

    A project without a token for this profile (no Weft repo yet: ``install.py --sync`` creates
    them) is a no-op with one log line per process. Gates (completion / pre_verify) ask every
    adapter that has a session; only ``enforce`` repos can refuse.
    """

    def __init__(self, config: Config, client_factory: Optional[Callable[[Config], Any]] = None,
                 analyzer: Optional[Analyzer] = None, heartbeat: bool = True):
        self.cfg = config
        self.scope = config.scope()
        self.adapters: Dict[str, WeftAdapter] = {}
        self.unknown: set = set()
        self.client_factory = client_factory
        self.heartbeat = heartbeat
        self.lock = threading.RLock()
        self._analyzer = analyzer

    def log(self, message: str) -> None:
        WeftAdapter.log(self, message)  # type: ignore[arg-type]

    @property
    def analyzer(self) -> Analyzer:
        if self._analyzer is None:
            self._analyzer = Analyzer(self.cfg.node, self.cfg.analyzer, log=self.log)
        return self._analyzer

    def adapter_for(self, repo: str) -> Optional[WeftAdapter]:
        if not repo:
            return None
        with self.lock:
            hit = self.adapters.get(repo)
            if hit:
                return hit
            if repo in self.unknown:
                return None
            cfg = self.cfg.for_repo(repo)
            if not cfg:
                self.unknown.add(repo)
                self.log(f"project '{repo}' has no Weft repo/token for profile {self.cfg.profile}; "
                         "skipping (run `install.py --sync` to add it)")
                return None
            client = self.client_factory(cfg) if self.client_factory else None
            adapter = WeftAdapter(cfg, client=client, analyzer=self.analyzer, heartbeat=self.heartbeat,
                                  scope=self.scope)
            self.adapters[repo] = adapter
            return adapter

    def _repos(self, name: str, args: dict) -> List[str]:
        base = os.environ.get("HERMES_KANBAN_WORKSPACE") or os.getcwd()
        repos: List[str] = []
        if name in EDIT_TOOLS:
            for p in edit_paths(name, args):
                t = self.scope.resolve(p, base)
                if t and t.repo not in repos:
                    repos.append(t.repo)
        elif name in TERMINAL_TOOLS:
            hit = self.scope.locate_dir(args.get("workdir") or base)
            if hit:
                repos.append(hit[1])
        return repos

    def _live(self) -> List[WeftAdapter]:
        with self.lock:
            return list(self.adapters.values())

    def pre_tool_call(self, tool_name: str = "", args: Optional[dict] = None, **kw: Any) -> Optional[dict]:
        name = normalize_tool(tool_name)
        args = args if isinstance(args, dict) else {}
        try:
            if name in COMPLETION_TOOLS:
                targets = self._live()
            else:
                targets = [a for a in (self.adapter_for(r) for r in self._repos(name, args)) if a]
        except Exception as err:  # fail open
            self.log(f"route {name} failed open: {err!r}")
            return None
        for adapter in targets:
            block = adapter.pre_tool_call(tool_name=tool_name, args=args, **kw)
            if block:
                return block
        return None

    def post_tool_call(self, **kw: Any) -> None:
        for adapter in self._live():
            adapter.post_tool_call(**kw)

    def transform_tool_result(self, result: Any = None, **kw: Any) -> Optional[str]:
        out, changed = result, False
        for adapter in self._live():
            r = adapter.transform_tool_result(result=out, **kw)
            if r is not None:
                out, changed = r, True
        return out if changed else None

    def pre_verify(self, **kw: Any) -> Optional[dict]:
        for adapter in self._live():
            r = adapter.pre_verify(**kw)
            if r:
                return r
        return None

    def flush(self, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        return all(a.flush(max(0.0, deadline - time.monotonic())) for a in self._live())

    def close(self) -> None:
        for adapter in self._live():
            adapter.close(close_analyzer=False)
        if self._analyzer:
            self._analyzer.close()


def edit_paths(name: str, args: dict) -> List[str]:
    if name == "write_file" or (name == "patch" and args.get("mode", "replace") == "replace"):
        p = args.get("path")
        return [p] if isinstance(p, str) else []
    if name == "patch":
        patch = str(args.get("patch") or "")
        return re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$", patch, re.M) + \
            re.findall(r"^\*\*\* Move to: (.+?)\s*$", patch, re.M)
    return []


# ------------------------------------------------------------------------------------------
# process-wide singleton used by the Hermes plugin entry point
# ------------------------------------------------------------------------------------------

_ADAPTER: Optional[WeftRouter] = None
_ADAPTER_LOCK = threading.Lock()
_LOADED = False


def get_adapter() -> Optional[WeftRouter]:
    global _ADAPTER, _LOADED
    if _LOADED:
        return _ADAPTER
    with _ADAPTER_LOCK:
        if not _LOADED:
            cfg = Config.load()
            _ADAPTER = WeftRouter(cfg) if cfg else None
            if _ADAPTER:
                atexit.register(_ADAPTER.close)
            _LOADED = True
    return _ADAPTER
