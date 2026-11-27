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
import collections
import difflib
import hashlib
import json
import os
import queue
import re
import shlex
import select
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import weakref
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

try:  # package import inside Hermes; flat import in tests
    from .wcp import WcpClient, WcpError
    from .land import commit_time, detect_trunk, is_ancestor, pending_path, state_path, trunk_tips
    from . import pyanalyze, standalone, status
except ImportError:  # pragma: no cover
    from wcp import WcpClient, WcpError  # type: ignore
    from land import commit_time, detect_trunk, is_ancestor, pending_path, state_path, trunk_tips  # type: ignore
    import pyanalyze, standalone, status  # type: ignore

ADAPTER_VERSION = "0.4.0"
EDIT_TOOLS = {"write_file", "patch"}
TERMINAL_TOOLS = {"terminal"}
# Tools that can run git: HEAD moves of the session's worktrees and trunk moves are watched
# around them (checkpoints + auto-land), whatever directory the command cd's into.
WATCH_TOOLS = TERMINAL_TOOLS | {"execute_code"}
COMPLETION_TOOLS = {"kanban_complete", "kanban_request_review"}
GIT_PULL = re.compile(r"\bgit\b[^|;&]*\bpull\b")
TRUNK_TTL_S = 600.0     # re-detect a repo's trunk branch at most this often
LAND_RETRY_S = 60.0     # a pending (failed) auto-land is retried at most this often
# Never reported: VCS internals, dependencies, caches and build outputs.
SKIP_PARTS = {
    ".git", ".weft", ".hermes", ".ssh", "node_modules", ".wrangler", ".turbo", "__pycache__", ".pnpm-store",
    "dist", "build", ".build", ".next", ".nuxt", ".svelte-kit", ".output", ".vercel", ".expo",
    "DerivedData", "Pods", "target", "coverage", ".venv", "venv", ".cache", ".parcel-cache",
    ".pytest_cache", ".mypy_cache", ".gradle",
}
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
# Diagnostics whose cause is another agent's change to a declaration: the adapter quotes that
# change (new declaration + a bounded excerpt of the causing event's diff), because in a
# separate worktree the other agent's edit is not in this checkout, so re-reading the file here
# shows the old code (the same rule as the claude-code/codex adapters' renderers).
QUOTE_CODES = {"stale_assumption", "stale_overwrite", "contract_changed"}
# A byte-identical retry of an edit blocked for these is blocked once more (see _pre_edit).
RETRY_GUARD_CODES = {"stale_assumption", "stale_overwrite"}
# What the plugin says around the coordinator's diagnostics (issue #15). Byte-identical copies of
# OPEN_ERROR_ADVICE / BLOCKED_EDIT_ADVICE in packages/protocol/src/ownership.ts (pinned by
# src/advice-text.test.ts). The suggestions carry the repo's `conflicts` mode (spec §8.4): `hold`
# says to update the code against the other agent's change, `continue` says that agent owns the
# conflict and this agent stops and reports it. The plugin does not know the mode, so it defers to
# the suggestion and never tells the agent, by itself, to adapt to another agent's change.
OPEN_ERROR_ADVICE = (
    "Do what each error's suggestion says. If it says another agent owns the conflict, stop working on that code and report it "
    "(negotiate with that agent, or say so in your task report): do not adapt your code to their change, rebase onto it or work around it to clear the error. "
    "Otherwise re-edit the cited code as the suggestion says (an accepted edit that touches the symbol clears the error), or retreat from that code.")
BLOCKED_EDIT_ADVICE = (
    "Do not retry the same edit. Do what each error's suggestion says. If it says another agent owns the conflict, leave this edit and report it "
    "(negotiate with that agent, or say so in your task report): do not adapt your code to their change or work around it. "
    "Otherwise change your code as the suggestion says, then edit again: your next attempt is checked against the current log.")
MAX_QUOTE_LINES = 30
MAX_QUOTE_LINE_CHARS = 200
MAX_QUOTED_CAUSES = 3
MAX_DECL_LINES = 8
MAX_BLOCKED_EDITS = 16
MAX_EVENT_CACHE = 64
MAX_FILE_BYTES = 512 * 1024
DRAIN_EVERY_S = 20.0
RELOAD_EVERY_S = 60.0  # long-lived processes re-read the config for unknown projects at most this often
SESSION_IDLE_S = 2 * 3600.0  # a chat's adapters (one WCP session per repo) close after this long idle
MAX_SESSION_KEYS = 4096      # remembered session id -> conversation id pairs
RELEASE_AFTER_REFUSALS = 2
SYMBOL_KEY = re.compile(r"^[^#\s]+#[^#\s]+$")  # WCP SymbolKey (schema $defs.SymbolKey)
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
# fullmatch only: with ``match``, ``$`` also matches before a trailing newline ("app\n").
REPO_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def valid_repo(name: Any) -> bool:
    return isinstance(name, str) and REPO_NAME.fullmatch(name) is not None


def sanitize_repo(name: str) -> str:
    """Weft repo name for a project dir basename (gateway rule ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$)."""
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).lstrip("._-")[:64].rstrip("-")
    return s or "project"


def _real(p: str) -> str:
    return os.path.realpath(os.path.expanduser(p))


def space_repo(checkout: str) -> Optional[str]:
    """The Weft repo ``npx @celador/weft`` registered this checkout as (``.weft/space.json``
    ``repo``, e.g. ``<space>-<folder>``), when it names a valid one. Such a checkout already has a
    feed: reporting it under a bare ``<folder>`` repo would split one project's events in two.

    The file sits in the checkout the agent edits, so it is a HINT only: it can name a repo, never
    a gateway URL, a token or a mode (a repo's mode comes from the adapter config's ``modes``).
    Callers accept the name only where they trust it: ``discover_projects`` (install time) when git
    does not track the file, ``Scope`` (run time) only among repos the config already has."""
    try:
        with open(os.path.join(checkout, ".weft", "space.json")) as f:
            repo = json.loads(f.read(65536)).get("repo")
    except (OSError, ValueError, AttributeError):
        return None
    return repo if valid_repo(repo) else None


def _git_tracks(checkout: str, rel: str) -> bool:
    """True when git tracks ``rel`` in ``checkout`` (or cannot tell: fail closed)."""
    try:
        out = subprocess.run(["git", "-C", checkout, "ls-files", "--", rel], capture_output=True, text=True,
                             timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return True
    return out.returncode != 0 or bool(out.stdout.strip())


def local_space_repo(checkout: str) -> Optional[str]:
    """``space_repo`` for a ``.weft/space.json`` the user's own ``npx @celador/weft`` wrote: git
    does not track it. One that came with the repository's content (a clone) names nothing."""
    repo = space_repo(checkout)
    if repo is None or _git_tracks(checkout, ".weft/space.json"):
        return None
    return repo


def discover_projects(dirs: List[str], explicit: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """{project dir (realpath): weft repo} for every top-level git repo in ``dirs``.

    A project is a direct child of a projects dir that is a git checkout (``.git`` dir or file).
    A checkout with an untracked ``.weft/space.json`` keeps the repo named there
    (``local_space_repo``); other names come from the basename, and a later dir's duplicate gets ``<dirbasename>-<name>``. ``explicit``
    (path -> repo) wins over discovery.
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
            repo = local_space_repo(full)
            if repo is None:
                repo = sanitize_repo(name)
                if repo in taken and taken[repo] != full:
                    repo = sanitize_repo(f"{os.path.basename(base)}-{name}")
            taken.setdefault(repo, full)
            out[full] = repo
    for path, repo in (explicit or {}).items():
        out[_real(path)] = repo
    return out


# ------------------------------------------------------------------------------------------
# terminal targets (the same accepted forms as the Claude Code adapter's Bash handling)
# ------------------------------------------------------------------------------------------
# Bare paths exclude glob/brace/expansion characters (the shell would rewrite them before cd
# runs); double-quoted paths exclude `$`, backquote and `\`; single quotes keep everything
# literal, and `'\''` (close, escaped quote, reopen) is how a shell spells an apostrophe in one.
# Only a LEADING `cd <dir> &&` or `git [global options] -C <dir> [global options] <subcommand>`
# names THE directory; leading blank lines are skipped.
_BASH_DIR = r"""(?:"([^"$`\\\n\r]+)"|'((?:[^'\n\r]|'\\'')+)'|([^\s"'$`;&|<>()*?\[\]{}\\]+))"""
# git global options that may stand before or after `-C <dir>` (`-c k=v` takes a value).
_GIT_OPT = r"""(?:[ \t]+(?:-c[ \t]+[^\s;&|<>()`$]+|--[a-z][a-z-]*(?:=[^\s;&|<>()`$]+)?|-[pP]))"""
_CD_TARGET = re.compile(r"\A\s*cd[ \t]+" + _BASH_DIR + r"[ \t]*&&")
_GIT_C_TARGET = re.compile(r"\A\s*git" + _GIT_OPT + r"*[ \t]+-C[ \t]+" + _BASH_DIR + _GIT_OPT + r"*[ \t]+[a-z]")
# Anything else that moves where a command works: another cd/pushd, a second -C, --git-dir /
# --work-tree, `sh -c` (the leading form is counted once; see scan_command).
_DIR_CHANGE = re.compile(
    r"""(?:^|[\s;&|()`'"{])(?:cd|pushd|popd|chdir|env[ \t]+-C)(?=$|[\s;&|()`'"}])"""
    r"""|(?:^|\s)(?:-C|--git-dir|--work-tree|--chdir|--directory)(?=[=\s]|$)"""
    r"""|(?:^|[\s;&|(])(?:ba|z|da|k)?sh[ \t]+-\w*c""", re.M)
# Absolute or ~ paths anywhere in a text (quoted or not): used when the text is not shell.
_ABS_PATH = re.compile(r"""(?:(?<=^)|(?<=[\s=:'"(<>|;&,\[]))(~?/[^\s'";&|<>()`$*?\[\]{},]*)""", re.M)
_HOME_VAR = re.compile(r"\A(?:\$HOME|\$\{HOME\})(?=/|\Z)")
_GLOB = re.compile(r"[*?\[{]")
# A program that runs code given on its command line (or on stdin): the code can reach any path.
_INLINE_RUNNER = re.compile(r"\A(?:python[\d.]*|node|nodejs|perl|ruby|php|bun|deno|lua|osascript|Rscript)\Z")
_INLINE_FLAGS = {"-c", "-e", "-E", "--eval", "-p", "--print", "-r", "-"}
_CODE_RUNNERS = {"eval", "source", ".", "xargs", "parallel", "exec"}
_COMMAND_START = {"&&", "||", ";", "|", "&", "(", "|&", ";;", "!", "then", "do", "else", "time", "sudo",
                  "nohup", "command", "builtin"}
MAX_COMMAND_PATHS = 256  # distinct existing directories (each costs a realpath + scope lookup)
MAX_COMMAND_WORDS = 4096
OPAQUE_TOOLS = {"execute_code"}  # code, not a command line: its reach is never parsed


def _target_of(m: "re.Match[str]") -> Optional[str]:
    raw = m.group(1) or m.group(2) or m.group(3)
    if m.group(2) is not None:
        raw = m.group(2).replace("'\\''", "'")
    if not raw or ".." in re.split(r"[\\/]", raw):
        return None
    quoted = m.group(1) is not None or m.group(2) is not None
    if raw.startswith("~"):
        if quoted:
            return None  # a quoted ~ is a literal relative directory, not the home dir
        if raw == "~":
            return os.path.expanduser("~")
        if raw.startswith("~/"):
            return os.path.join(os.path.expanduser("~"), raw[2:])
        return None
    return os.path.normpath(raw) if raw.startswith("/") else None


def bash_target_dir(command: Any) -> Optional[str]:
    """The directory a shell command works in when it names one with a leading ``cd <dir> &&``
    or ``git [opts] -C <dir> [opts] <subcommand>`` (absolute or ``~`` path; no ``..``, no
    variables). None otherwise. Accepts the forms of ``bashTargetDir`` in
    packages/adapters/claude-code/src/config.ts and a few more spellings (``'\\''``, git global
    options, leading blank lines); anything else is handled fail-closed by ``terminal_dirs``."""
    if not isinstance(command, str):
        return None
    m = _CD_TARGET.match(command) or _GIT_C_TARGET.match(command)
    return _target_of(m) if m else None


@dataclass
class CommandScan:
    """What a terminal command (or ``execute_code`` code) names. ``dirs``: existing directories
    named by a literal path (absolute, ``~``, ``$HOME``, or relative to the command's cwd).
    ``opaque``: why the command can reach paths it does not name literally ("" = it cannot: every
    word is literal, it changes directory at most in the leading ``cd``/``git -C``, and no bound
    was hit). ``names``: every path component of every word (an opaque command's capture also
    covers each project whose folder name it mentions)."""
    dirs: List[str] = field(default_factory=list)
    opaque: str = ""
    names: set = field(default_factory=set)


def _shell_words(command: str) -> Tuple[Optional[List[str]], bool]:
    """(every shell word, True when the command parsed as is). An unbalanced quote is closed at
    the end of the command (words, False); (None, False) when even that does not parse."""
    for n, text in enumerate((command, command + '"', command + "'")):
        try:
            lex = shlex.shlex(text, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""
            return list(lex), n == 0
        except ValueError:
            continue
    return None, False


def _existing_dir(raw: str) -> Optional[str]:
    """The directory a path names: itself, or its deepest existing ancestor. None for ``/``."""
    d = os.path.normpath(raw)
    while d and d != os.path.dirname(d) and not os.path.isdir(d):
        d = os.path.dirname(d)
    return d if d and d != os.path.dirname(d) else None


def _scan_words(words: List[str], cwd: str, scan: CommandScan, depth: int = 0) -> None:
    home = os.path.expanduser("~")
    for i, w in enumerate(words):
        if (i == 0 or words[i - 1] in _COMMAND_START) and os.path.basename(w) in _CODE_RUNNERS:
            scan.opaque = scan.opaque or f"runs code from its arguments or input ({w})"
        if _INLINE_RUNNER.match(os.path.basename(w)) and any(x in _INLINE_FLAGS for x in words[i + 1:i + 3]):
            scan.opaque = scan.opaque or f"runs inline code ({os.path.basename(w)})"
        cands = [w]
        if "=" in w and not w.startswith(("/", "~")):
            cands.append(w.split("=", 1)[1])
        for c in cands:
            c = _HOME_VAR.sub(lambda _: home, c)
            for part in c.split("/"):
                if part:
                    scan.names.add(part)
            if "$" in c or "`" in c:
                scan.opaque = scan.opaque or "expands a variable or command"
                continue
            if c.startswith("~") and not (c == "~" or c.startswith("~/")):
                scan.opaque = scan.opaque or "names another user's home (~user)"
                continue
            absolute = c.startswith("/") or c == "~" or c.startswith("~/")
            if not absolute and "/" not in c:
                continue  # a plain word: at most a name in the cwd, which is captured anyway
            if ".." in c.split("/"):
                scan.opaque = scan.opaque or "walks up with .."
            if absolute and _GLOB.search(c):
                scan.opaque = scan.opaque or "globs an absolute path"
            path = os.path.expanduser(c) if c.startswith("~") else c
            d = _existing_dir(path if absolute else os.path.join(cwd, path))
            if d and d not in scan.dirs:
                if len(scan.dirs) >= MAX_COMMAND_PATHS:
                    scan.opaque = scan.opaque or f"names more than {MAX_COMMAND_PATHS} directories"
                else:
                    scan.dirs.append(d)
        if depth < 2 and not w.startswith(("/", "~")) and any(ch in w for ch in " \t\n;&|"):
            inner, _ = _shell_words(w)  # a quoted command (`sh -c '...'`, `ssh h '...'`)
            if inner:
                _scan_words(inner, cwd, scan, depth + 1)


def scan_command(command: Any, cwd: str = "", target: Optional[str] = None) -> CommandScan:
    """Scan a shell command for what it can reach (``CommandScan``), split the way a shell would:
    quotes and ``'\\''`` escapes keep a path with spaces or apostrophes whole, ``;&|()<>``
    separate words, ``--opt=/path`` yields ``/path``, a quoted word that is itself a command is
    scanned again. Nothing is truncated: past a bound the command is opaque instead.

    The parse only ADDS worktrees to a call's capture; it never has to be complete. A command it
    cannot fully resolve is opaque, and the caller then captures every worktree of every repo the
    conversation works in (``WeftRouter._terminal_repos``), whatever the spelling."""
    scan = CommandScan()
    if not isinstance(command, str) or not command.strip():
        return scan
    cwd = target or cwd or os.getcwd()
    words, clean = _shell_words(command)
    if words is None:
        scan.opaque = "does not parse as a shell command"
        words = [m.group(1) for m in _ABS_PATH.finditer(command)] + re.split(r"[\s'\"]+", command)
    elif not clean:
        scan.opaque = "has an unbalanced quote"
    if len(words) > MAX_COMMAND_WORDS:
        scan.opaque = scan.opaque or f"has more than {MAX_COMMAND_WORDS} words"
    if len(_DIR_CHANGE.findall(command)) > (1 if target else 0):
        scan.opaque = scan.opaque or "changes directory"
    _scan_words(words, cwd, scan)
    return scan


def scan_code(code: Any) -> CommandScan:
    """``execute_code``: Python code, always opaque; its literal absolute / ``~`` paths and its
    identifiers still name worktrees and project folders."""
    scan = CommandScan(opaque="runs code")
    if not isinstance(code, str):
        return scan
    for m in _ABS_PATH.finditer(code):
        raw = m.group(1)
        scan.names.update(p for p in raw.split("/") if p)
        d = _existing_dir(os.path.expanduser(raw) if raw.startswith("~") else raw)
        if d and d not in scan.dirs and len(scan.dirs) < MAX_COMMAND_PATHS:
            scan.dirs.append(d)
    scan.names.update(re.findall(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", code))
    return scan


def command_paths(command: Any) -> List[str]:
    """Existing directories named by literal paths in ``command`` (a file names its directory; a
    path that does not exist yet names its deepest existing ancestor)."""
    return scan_command(command).dirs


def terminal_scan(name: str, args: dict, base: str) -> Tuple[List[str], CommandScan]:
    """Candidate directories of a terminal (or ``execute_code``) call, best first: the command's
    own leading ``cd``/``git -C`` target, its ``workdir`` (else the session's directory), then
    every directory a literal path in it names; and the scan (``opaque`` says whether the call can
    reach more than that)."""
    if name in OPAQUE_TOOLS:
        lead: List[Optional[str]] = [args.get("workdir") or base]
        scan = scan_code(args.get("code"))
    else:
        command = args.get("command")
        target = bash_target_dir(command)
        lead = [target, args.get("workdir") or base]
        cwd = target or args.get("workdir") or base
        scan = scan_command(command, cwd if isinstance(cwd, str) else "", target)
    out: List[str] = []
    for d in [*lead, *scan.dirs]:
        if isinstance(d, str) and d and d not in out:
            out.append(d)
    return out, scan


def terminal_dirs(args: dict, base: str) -> List[str]:
    """``terminal_scan``'s directories for a ``terminal`` call."""
    return terminal_scan("terminal", args, base)[0]


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
    node: str = ""  # "" = the first working candidate (resolve_node); a configured node is probed too
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
    trunks: Dict[str, str] = field(default_factory=dict)   # repo -> trunk branch override
    # Auto-land (0.3): when trunk moves, spawn land.py to land changes whose work reached it.
    # Off for directly constructed configs (tests); Config.load turns it on (`auto_land`).
    auto_land: bool = False
    # Standalone mode (catalog installs): each checkout names its own gateway/repo/token
    # (``.weft/``, see standalone.py). ``links`` resolves a checkout root to that link; the
    # router's key for a checkout is its root path (``route``), not a Weft repo name.
    links: Optional["standalone.Links"] = None
    route: str = ""
    settings: Optional["standalone.Settings"] = None

    @property
    def route_key(self) -> str:
        """What ``Scope`` calls this adapter's repo: the Weft repo name (multi-project mode) or
        the checkout root (standalone)."""
        return self.route or self.repo

    def mode_for(self, repo: str) -> str:
        forced = os.environ.get("WEFT_HERMES_MODE")
        if forced:
            return forced
        return self.modes.get(repo) or self.default_mode

    def for_repo(self, repo: str) -> Optional["Config"]:
        if self.links is not None:
            link = self.links.link(repo)
            if not link:
                return None
            return replace(self, url=link["url"], repo=link["repo"], token=link["token"], agent=link["agent"],
                           route=repo, mode=self.mode_for(repo))
        token = self.tokens.get(repo) or (self.token if repo == self.repo else "")
        if not token:
            return None
        return replace(self, repo=repo, token=token, mode=self.mode_for(repo))

    def scope(self) -> "Scope":
        if self.links is not None:
            return StandaloneScope(self.links, self.excludes)
        return Scope(self.roots, projects=self.projects, project_dirs=self.project_dirs,
                     excludes=self.excludes, default_repo=self.repo, known_repos=self.known_repos())

    def known_repos(self) -> List[str]:
        """Every Weft repo this config already names (project map, tokens, the legacy repo): the
        only names a checkout's own ``.weft/space.json`` may pick (``Scope._project_root``)."""
        out = set(self.projects.values()) | set(self.tokens)
        if self.repo:
            out.add(self.repo)
        return sorted(r for r in out if r)

    @staticmethod
    def standalone(get_config: Callable[[str, Any], Any], get_secret: Callable[[str], Optional[str]],
                   profile: Optional[str] = None) -> Optional["Config"]:
        """Config for a catalog install: nothing preconfigured, checkouts link themselves.
        None only when the user switched the plugin off (``enabled: false``)."""
        profile = profile or current_profile()
        st = standalone.Settings.read(get_config)
        if not st.enabled:
            return None
        cache = Path(os.environ.get("WEFT_HERMES_CACHE", "~/.cache/weft-hermes")).expanduser()
        log_path = cache / f"{profile}.log"

        def log(message: str) -> None:
            try:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("a") as f:
                    f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{profile}] {message}\n")
            except Exception:
                pass

        links = standalone.Links(st, get_secret, profile, log=log)
        analyzer = st.analyzer or None
        if analyzer:
            analyzer = os.path.expanduser(analyzer)
            if not os.path.isfile(analyzer):
                log(f"analyzer setting {analyzer!r} is not a file; using the built-in analyzers")
                analyzer = None
        return Config(
            url="", repo="", token="", agent=f"hermes-{profile}", profile=profile, roots=[], mode=st.mode,
            node="", analyzer=analyzer, log_path=log_path, default_mode=st.mode,
            excludes=[_real(x) for x in DEFAULT_EXCLUDES], auto_land=False, links=links, settings=st,
            async_advise=True)

    @staticmethod
    def load(path: Optional[Path] = None, profile: Optional[str] = None) -> Optional["Config"]:
        """Read the adapter config; None (adapter disabled) when absent or this profile has no agent."""
        try:
            from .legacy_config import load
        except ImportError:
            try:
                from legacy_config import load  # only the development installer supplies this module
            except ImportError:
                return None
        return load(path, profile)


# ------------------------------------------------------------------------------------------
# node selection
# ------------------------------------------------------------------------------------------
# A node binary can exist and still be dead: a `brew upgrade` of one of its dylibs (simdjson
# 4 -> 5 on 2026-11-17) leaves /opt/homebrew/opt/node@24/bin/node aborting in dyld before it
# runs a line. So a candidate counts only when it actually runs (and is new enough for the
# analyzer bundle), probed once per process.

NODE_CANDIDATES = ("/opt/homebrew/opt/node@24/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node")
NODE_MIN_MAJOR = 22
NODE_PROBE_TIMEOUT = 5.0
_node_probes: Dict[str, Optional[str]] = {}
_node_probe_lock = threading.Lock()


def _first_line(text: Optional[str]) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return ""


def _probe_node(node: str, timeout: float) -> Optional[str]:
    try:
        out = subprocess.run([node, "-p", "process.versions.node"], stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return "not found"
    except subprocess.TimeoutExpired:
        return f"no answer in {timeout:g}s"
    except OSError as err:
        return str(err)
    if out.returncode != 0:
        status = f"exit status {out.returncode}" if out.returncode > 0 else f"signal {-out.returncode}"
        return _first_line(out.stderr) or status
    version = out.stdout.strip()
    try:
        major = int(version.split(".")[0])
    except ValueError:
        return f"unexpected version output {version[:60]!r}"
    if major < NODE_MIN_MAJOR:
        return f"version {version} is older than {NODE_MIN_MAJOR}"
    return None


def probe_node(node: str, refresh: bool = False, timeout: float = NODE_PROBE_TIMEOUT) -> Optional[str]:
    """Why ``node`` cannot run the analyzer (its first stderr line, or a short reason); None when
    it runs. Cached per process; ``refresh`` re-probes."""
    with _node_probe_lock:
        if not refresh and node in _node_probes:
            return _node_probes[node]
    reason = _probe_node(node, timeout)
    with _node_probe_lock:
        _node_probes[node] = reason
    return reason


def node_candidates(preferred: Optional[str] = None) -> List[str]:
    """``preferred`` (the configured node), then the usual install locations, then ``node`` on PATH."""
    out: List[str] = []
    for c in ([preferred] if preferred else []) + list(NODE_CANDIDATES) + [shutil.which("node") or ""]:
        if c and c not in out:
            out.append(c)
    return out


def resolve_node(preferred: Optional[str] = None, log: Optional[Callable[[str], None]] = None,
                 refresh: bool = False) -> str:
    """The first candidate that runs. When the node that would have been used (``preferred``, or
    the first installed candidate) is broken, logs ONE line naming it, why, and the fallback.
    No working node at all: ``preferred`` (or ``node``) unchanged, so callers fail as before."""
    broken: Optional[Tuple[str, str]] = None
    for c in node_candidates(preferred):
        if os.sep in c and not os.path.exists(c):
            if c == preferred:
                broken = (c, "not found")
            continue
        reason = probe_node(c, refresh=refresh)
        if reason is None:
            if broken and log:
                log(f"node {broken[0]} is broken: {broken[1]}; using {c}")
            return c
        broken = broken or (c, reason)
    fallback = preferred or "node"
    if broken and log:
        log(f"node {broken[0]} is broken: {broken[1]}; no working node >= {NODE_MIN_MAJOR} found, "
            f"keeping {fallback}")
    return fallback


def _find_node(log: Optional[Callable[[str], None]] = None) -> str:
    """The node to run the analyzer with when none is configured (probed, see ``resolve_node``)."""
    return resolve_node(None, log)


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
                 default_repo: str = "", known_repos: Optional[List[str]] = None):
        self.roots = self.sort_roots(roots)
        self.projects = dict(projects or {})
        # repos the adapter config names: the only ones a checkout's space.json may pick
        self.known_repos = set(known_repos or ()) | set(self.projects.values())
        self.project_dirs = list(project_dirs or [])
        self.excludes = list(excludes or [])
        self.default_repo = default_repo
        self._ext: Dict[str, Optional[Root]] = {}  # external worktree dir -> root (cache)

    @staticmethod
    def sort_roots(roots: List[Root]) -> List[Root]:
        """Explicit roots, longest path first (the deepest root containing a path wins)."""
        return sorted(roots, key=lambda r: len(r.path), reverse=True)

    def repo_of(self, root: Root) -> str:
        return root.repo or self.default_repo

    def _mapped_root(self, path: str) -> Optional[Root]:
        """A project the config maps (``projects.repos``) anywhere on disk, not only as a direct
        child of ``project_dirs``: a project registered outside the project dirs resolves even
        without an explicit root. Deepest mapped project first."""
        best = ""
        for proj in self.projects:
            if len(proj) > len(best) and _under(path, proj):
                best = proj
        return Root(best, "", self.projects[best]) if best else None

    def _configured_root(self, path: str) -> Optional[Root]:
        return self._explicit_root(path) or self._project_root(path) or self._mapped_root(path)

    def _project_root(self, path: str) -> Optional[Root]:
        for d in self.project_dirs:
            if path.startswith(d + os.sep):
                name = path[len(d) + 1:].split(os.sep, 1)[0]
                proj = os.path.join(d, name)
                if proj in self.projects:
                    return Root(proj, "", self.projects[proj])
                if os.path.exists(os.path.join(proj, ".git")):
                    return Root(proj, "", self._unsynced_repo(proj, name))
                return None
        return None

    def _unsynced_repo(self, proj: str, name: str) -> str:
        """The repo of a checkout ``install.py --sync`` has not mapped yet: its folder name, or
        the repo its ``.weft/space.json`` names when that is a repo the config already knows and
        the folder name is not. The agent can write that file, so it never picks a repo (and with
        it a mode or token) outside the config, and never displaces a configured folder repo."""
        repo = sanitize_repo(name)
        if repo in self.known_repos:
            return repo
        hint = space_repo(proj)
        return hint if hint is not None and hint in self.known_repos else repo

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
        owner = self._configured_root(main)
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
        root = self._configured_root(path)
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
        if sensitive_parts(parts):
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

    def locate_terminal(self, args: dict, base: str) -> Optional[Tuple[str, str]]:
        """(worktree root, repo) a terminal call works in: its leading ``cd <abs> &&`` /
        ``git -C <abs>`` target when that is in scope (``cd ~/github/x/.worktrees/t && rm f`` run
        from another worktree's session edits ``t``), else its workdir / the session's cwd."""
        hits = self.locate_terminal_all(args, base)
        return hits[0] if hits else None

    def locate_terminal_all(self, args: dict, base: str) -> List[Tuple[str, str]]:
        """Every in-scope (worktree root, repo) of ``terminal_dirs``, best first, deduplicated."""
        out: List[Tuple[str, str]] = []
        for d in terminal_dirs(args, base):
            hit = self.locate_dir(d)
            if hit and hit not in out:
                out.append(hit)
        return out

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


class StandaloneScope(Scope):
    """Scope for catalog installs: a path belongs to the git checkout that contains it, and that
    checkout is in scope only when it names a gateway (``.weft/`` from ``npx @celador/weft``, or
    the ``project_dirs`` setting). The route key of a checkout is its root path, so every
    checkout (every git worktree) is its own adapter, agent identity and WCP session: two Hermes
    sessions in two worktrees of one repo are two agents, even inside one gateway process."""

    def __init__(self, links: "standalone.Links", excludes: Optional[List[str]] = None):
        super().__init__([], excludes=excludes)
        self.links = links

    @staticmethod
    def checkout_of(path: str) -> Optional[str]:
        d = path if os.path.isdir(path) else os.path.dirname(path)
        for _ in range(64):
            if os.path.exists(os.path.join(d, ".git")):
                return d
            parent = os.path.dirname(d)
            if parent == d:
                return None
            d = parent
        return None

    def root_for(self, path: str) -> Optional[Root]:
        if any(_under(path, x) for x in self.excludes):
            return None
        wt = self.checkout_of(path)
        if not wt or not self.links.link(wt):
            return None
        return Root(wt, "", wt)


# ------------------------------------------------------------------------------------------
# analysis
# ------------------------------------------------------------------------------------------

class Analyzer:
    """Persistent ``node analyze.mjs --serve`` child. Without a bundle: ``pyanalyze`` for Python
    files, whole-file keys for everything else.

    The node binary is probed before first use (``resolve_node``): a configured node that no
    longer runs is replaced by the next working candidate, with one log line. When the child
    still dies before answering anything ``EARLY_EXITS`` times in a row, the node is re-probed
    and switched; if no other node works (or the node is fine and the bundle itself dies), the
    analyzer pauses for ``DEAD_COOLDOWN`` seconds instead of respawning a dead binary on every
    call. The child's stderr is kept (first line) and logged when it dies."""

    EARLY_EXITS = 2
    DEAD_COOLDOWN = 300.0

    def __init__(self, node: str, script: Optional[str], timeout: float = 6.0,
                 log: Callable[[str], None] = lambda _m: None):
        self.node, self.script, self.timeout, self.log = node, script, timeout, log
        self.proc: Optional[subprocess.Popen] = None
        self.lock = threading.Lock()
        self.broken = False
        self.seq = 0
        self._extensions: Optional[Tuple[str, ...]] = None
        self._extensions_node: Optional[str] = None  # the node --languages was last asked with
        self._node_lock = threading.Lock()
        self._node_resolved = False
        self._node_refresh = False  # re-probe (ignore the per-process cache) on the next resolve
        self._early_exits = 0
        self._paused_until = 0.0

    def resolved_node(self) -> str:
        """The configured node if it runs, else the first working candidate (probed once)."""
        with self._node_lock:
            if not self._node_resolved:
                self.node = resolve_node(self.node or None, self.log, refresh=self._node_refresh)
                self._node_resolved, self._node_refresh = True, False
            return self.node

    def _paused(self) -> bool:
        return time.monotonic() < self._paused_until

    def extensions(self) -> Optional[Tuple[str, ...]]:
        """File extensions the bundle analyzes at declaration level (``analyze.mjs --languages``),
        asked once per node. None when the bundle cannot say (older bundle): every file is then
        sent and the bundle's ``analyzed`` list decides."""
        if self._extensions is None and self.script and not self.broken and not self._paused():
            node = self.resolved_node()
            if node == self._extensions_node:
                return None
            self._extensions_node = node
            try:
                out = subprocess.run([node, self.script, "--languages"], capture_output=True, text=True,
                                     timeout=max(self.timeout, 10.0))
                info = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {}
                exts = info.get("extensions") if info.get("ok") else None
                if isinstance(exts, list):
                    self._extensions = tuple(str(e).lower() for e in exts)
                    self.log(f"analyzer languages: {', '.join(l.get('id', '?') for l in info.get('languages', []))}")
                elif out.returncode != 0:
                    self.log(f"analyzer --languages failed: exit {out.returncode}: "
                             f"{_first_line(out.stderr) or 'no stderr'}")
            except Exception as err:
                self.log(f"analyzer --languages failed: {err}")
        return self._extensions

    def analyzable(self, path: str) -> bool:
        exts = self.extensions()
        return True if exts is None else path.lower().endswith(exts)

    @staticmethod
    def _drain_stderr(proc: subprocess.Popen) -> None:
        """Keep the child's first stderr line (dyld errors land there); never let the pipe fill."""
        try:
            for line in proc.stderr:  # type: ignore[union-attr]
                if not getattr(proc, "weft_stderr", "") and line.strip():
                    proc.weft_stderr = line.strip()[:300]  # type: ignore[attr-defined]
        except Exception:
            pass

    @staticmethod
    def _release(proc: subprocess.Popen) -> None:
        """Close a finished child's pipes (after its stderr drain thread had its chance)."""
        drain = getattr(proc, "weft_drain", None)
        if drain is not None:
            drain.join(timeout=1.0)
        for f in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if f:
                    f.close()
            except Exception:
                pass

    def _start(self) -> Optional[subprocess.Popen]:
        if self.broken or not self.script:
            return None
        if self.proc and self.proc.poll() is None:
            return self.proc
        if self.proc is not None:  # died between requests
            dead, self.proc = self.proc, None
            self._died(dead, "analyzer exited")
        if self._paused():
            return None
        node = self.resolved_node()
        try:
            proc = subprocess.Popen(
                [node, self.script, "--serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1)
        except Exception as err:
            self.log(f"analyzer start failed with node {node}: {err}")
            self._early_exit(node, str(err))
            return None
        proc.weft_answered = False  # type: ignore[attr-defined]
        proc.weft_stderr = ""  # type: ignore[attr-defined]
        drain = threading.Thread(target=self._drain_stderr, args=(proc,), daemon=True)
        drain.start()
        proc.weft_drain = drain  # type: ignore[attr-defined]
        self.proc = proc
        return proc

    def _died(self, proc: subprocess.Popen, what: str) -> None:
        """Log a child that ended on its own (exit status + first stderr line); count it when it
        never answered (it died at start, e.g. dyld could not load the node binary)."""
        self._release(proc)
        err = getattr(proc, "weft_stderr", "")
        code = proc.poll()
        status = "" if code is None else (f" (exit {code})" if code >= 0 else f" (signal {-code})")
        self.log(f"analyzer failed: {what}{status}" + (f": {err}" if err else ""))
        if getattr(proc, "weft_answered", True):
            self._early_exits = 0
        else:
            self._early_exit(str(proc.args[0]) if isinstance(proc.args, (list, tuple)) else self.node, err)

    def _early_exit(self, node: str, err: str) -> None:
        self._early_exits += 1
        if self._early_exits < self.EARLY_EXITS:
            return
        self._early_exits = 0
        with self._node_lock:
            fresh = resolve_node(node, self.log, refresh=True)  # logs "node X is broken: ...; using Y"
            if fresh != node:
                self.node, self._node_resolved = fresh, True
                self._extensions, self._extensions_node = None, None
                return
        reason = probe_node(node) if os.sep not in node or os.path.exists(node) else "not found"
        if reason:
            why = f"node {node} is broken and no other node >= {NODE_MIN_MAJOR} runs"
        else:
            why = f"node {node} runs, but the bundle exits at start" + (f" ({err})" if err else "")
        self._paused_until = time.monotonic() + self.DEAD_COOLDOWN
        with self._node_lock:
            # re-probe after the pause, so fixing node (brew upgrade) needs no gateway restart
            self._node_resolved, self._node_refresh = False, True
        self.log(f"analyzer paused for {self.DEAD_COOLDOWN:g}s: {why}; whole-file keys meanwhile")

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
                        proc.weft_answered = True  # type: ignore[attr-defined]
                        self._early_exits = 0
                        return msg if msg.get("ok") else None
            except Exception as err:
                self.proc = None
                if isinstance(err, (EOFError, BrokenPipeError)):
                    try:
                        proc.wait(timeout=1.0)
                    except Exception:
                        pass
                if proc.poll() is not None:  # it died on its own
                    self._died(proc, str(err) or type(err).__name__)
                    return None
                self.log(f"analyzer failed: {err}")
                try:
                    proc.kill()
                    proc.wait(timeout=1.0)
                except Exception:
                    pass
                self._release(proc)
                return None

    def analyze(self, changes: List[Tuple[str, Optional[str], Optional[str]]], root: Optional[str] = None,
                prefix: str = "") -> Tuple[List[str], List[dict]]:
        """changes: [(rel_path, before|None, after|None)] -> (reads, writes). ``root``/``prefix``
        let the analyzer resolve relative imports against the checkout (cross-file reads)."""
        reads: List[str] = []
        writes: Dict[str, dict] = {}
        code_files = [c for c in changes if c[1] != c[2] and self.analyzable(c[0])] if self.script else []
        result = self._ask([{"path": p, "before": b or "", "after": a or ""} for p, b, a in code_files], root, prefix) \
            if code_files else None
        analyzed = set(result.get("analyzed", [])) if result else set()
        if result:
            reads = list(result.get("reads", []))
            for w in result.get("writes", []):
                writes[w["key"]] = {"key": w["key"], "kind": w["kind"]}
        # No bundle (a catalog install), or it failed: Python files still get declaration-level keys.
        for path, before, after in changes:
            if path in analyzed or before == after or not path.lower().endswith((".py", ".pyi")):
                continue
            res = pyanalyze.analyze_file(path, before, after, root, prefix)
            if res is None:
                continue
            analyzed.add(path)
            reads += res[0]
            for w in res[1]:
                writes[w["key"]] = w
        for path, before, after in changes:
            if path in analyzed or before == after:
                continue
            kind = "new" if before is None else "deleted" if after is None else "body"
            writes[file_key(path)] = {"key": file_key(path), "kind": kind}
        # An analyzed file whose text changed without symbol-level writes (comments, imports) yields no
        # write: nothing another agent could conflict with, so no edit event is sent for it.
        return sorted(set(reads) - set(writes)), list(writes.values())

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()  # type: ignore[union-attr]
                proc.wait(timeout=1)
            except Exception:
                proc.kill()
        if proc:
            self._release(proc)


def file_key(rel: str) -> str:
    """Whole-file symbol key for files no analyzer backend understands."""
    return f"{rel.replace(' ', '_')}#*"


def unified_diff(rel: str, before: Optional[str], after: Optional[str]) -> str:
    a = (before or "").splitlines(keepends=True)
    b = (after or "").splitlines(keepends=True)
    return "".join(difflib.unified_diff(
        a, b, fromfile="/dev/null" if before is None else f"a/{rel}",
        tofile="/dev/null" if after is None else f"b/{rel}"))


def sensitive_parts(parts: List[str]) -> bool:
    """True for paths the plugin never reports or quotes: VCS internals, dependencies, caches,
    build outputs, ``.env*`` and common key containers."""
    return any(part in SKIP_PARTS or part == ".env" or part.startswith(".env.") for part in parts) \
        or bool(parts and parts[-1].lower().endswith(SECRET_SUFFIXES))


def split_key(key: str) -> Tuple[str, str]:
    """``path#Qualified.name`` -> (path, last name segment); ``path#*`` -> (path, "*")."""
    path, _, qualified = key.partition("#")
    return path, qualified.split(".")[-1] if qualified else ""


_HUNK = re.compile(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@")


def diff_hunks(diff: str, path: str) -> List[List[str]]:
    """The hunks (``@@`` header + lines) of ``diff`` that touch ``path``. Understands git
    (``diff --git``) and plain unified (``--- a/x`` / ``+++ b/x``, what this plugin sends) headers,
    and counts hunk lines, so a removed line starting with ``-- `` is not taken for a header."""
    out: List[List[str]] = []
    current: Optional[str] = None
    minus: Optional[str] = None
    hunk: Optional[List[str]] = None
    old_left = new_left = 0

    def strip(p: str) -> str:
        p = p.split("\t")[0].strip()
        return p[2:] if p.startswith(("a/", "b/")) else p

    for line in diff.split("\n"):
        if (old_left > 0 or new_left > 0) and hunk is not None:
            if line.startswith("\\"):
                continue  # "\ No newline at end of file"
            tag = line[:1]
            if tag == "-":
                old_left -= 1
            elif tag == "+":
                new_left -= 1
            else:
                old_left, new_left = old_left - 1, new_left - 1
            hunk.append(line)
            continue
        m = _HUNK.match(line)
        if m:
            old_left = int(m.group(1)) if m.group(1) is not None else 1
            new_left = int(m.group(2)) if m.group(2) is not None else 1
            hunk = [line]
            if current == path:
                out.append(hunk)
            continue
        if line.startswith("diff --git "):
            current, minus = (line.rsplit(" b/", 1)[1] if " b/" in line else None), None
        elif line.startswith("--- "):
            minus = strip(line[4:])
        elif line.startswith("+++ "):
            plus = line[4:].split("\t")[0].strip()
            current = minus if plus == "/dev/null" else strip(plus)
    return out


def quote_hunks(hunks: List[List[str]], name: str) -> Optional[str]:
    """A bounded excerpt of ``hunks``: the ones that mention ``name`` (else all of them), at most
    ``MAX_QUOTE_LINES`` lines of at most ``MAX_QUOTE_LINE_CHARS`` chars, indented for the model."""
    if name and name != "*":
        rx = re.compile(rf"\b{re.escape(name)}\b")
        hunks = [h for h in hunks if any(rx.search(l) for l in h[1:])] or hunks
    lines = [l for h in hunks for l in h]
    if not any(l[:1] in ("+", "-") for l in lines):
        return None
    clip = [l if len(l) <= MAX_QUOTE_LINE_CHARS else l[:MAX_QUOTE_LINE_CHARS] + " …" for l in lines]
    if len(clip) > MAX_QUOTE_LINES:
        clip = clip[:MAX_QUOTE_LINES] + [f"… ({len(clip) - MAX_QUOTE_LINES} more lines)"]
    return "\n".join(f"      {l}" for l in clip)


def new_declaration(hunks: List[List[str]], name: str) -> Optional[str]:
    """The declaration of ``name`` as an added (``+``) line of ``hunks`` (the new signature), with
    continuation lines until its parentheses close. None when the diff did not add one."""
    if not name or name == "*":
        return None
    n = re.escape(name)
    decl = re.compile(
        rf"^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?"
        rf"(?:def|class|function\*?|fn|func|interface|type|enum|struct|trait|const|let|var|val)\s+"
        rf"(?:\([^)]*\)\s*)?{n}\b")
    member = re.compile(
        rf"^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|final)\s+)*{n}\s*[(<]")
    for hunk in hunks:
        new_side = [l[1:] for l in hunk[1:] if l[:1] != "-"]
        added = [l[:1] == "+" for l in hunk[1:] if l[:1] != "-"]
        for i, text in enumerate(new_side):
            if not added[i] or not (decl.search(text) or member.search(text)):
                continue
            out, depth = [], 0
            for cont in new_side[i:i + MAX_DECL_LINES]:
                out.append(cont.rstrip() if len(cont) <= MAX_QUOTE_LINE_CHARS else cont[:MAX_QUOTE_LINE_CHARS] + " …")
                depth += cont.count("(") - cont.count(")")
                if depth <= 0:
                    break
            return "\n".join(out)
    return None


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


# ------------------------------------------------------------------------------------------
# worktree snapshots (terminal capture)
# ------------------------------------------------------------------------------------------

MAX_SNAPSHOT_TEXTS = 300       # dirty files whose text is kept before a call (the rest: stat only)
SNAPSHOT_WORKERS = 8           # worktrees snapshotted in parallel around one call
WORKTREE_LIST_TTL_S = 2.0
BUSY_STALE_S = 6 * 3600.0      # a capture window that never closed stops counting after this
MAX_WINDOWS = 16               # capture windows kept per worktree (terminal) and for edits
_SNAP_POOL: Optional[ThreadPoolExecutor] = None
_SNAP_POOL_LOCK = threading.Lock()
_WORKTREE_LISTS: Dict[str, Tuple[float, List[str]]] = {}
_LIVE_ADAPTERS: "weakref.WeakSet[WeftAdapter]" = weakref.WeakSet()


def _pool_map(fn: Callable[[Any], Any], items: List[Any]) -> List[Any]:
    """``map`` over a small shared thread pool (git status of several worktrees at once)."""
    global _SNAP_POOL
    if len(items) <= 1:
        return [fn(x) for x in items]
    with _SNAP_POOL_LOCK:
        if _SNAP_POOL is None:
            _SNAP_POOL = ThreadPoolExecutor(max_workers=SNAPSHOT_WORKERS, thread_name_prefix="weft-snap")
    return list(_SNAP_POOL.map(fn, items))


def worktree_list(checkout: str) -> List[str]:
    """Every existing worktree of the repository ``checkout`` belongs to (``git worktree list``),
    main checkout first. Cached for a couple of seconds (one call asks for it per adapter)."""
    now = time.monotonic()
    hit = _WORKTREE_LISTS.get(checkout)
    if hit and now - hit[0] < WORKTREE_LIST_TTL_S:
        return list(hit[1])
    out = git(checkout, "worktree", "list", "--porcelain") or ""
    paths = [line[len("worktree "):] for line in out.splitlines() if line.startswith("worktree ")]
    paths = [p for p in paths if os.path.isdir(p)]
    if len(_WORKTREE_LISTS) > 256:
        _WORKTREE_LISTS.clear()
    _WORKTREE_LISTS[checkout] = (now, paths)
    return list(paths)


def _stat_sig(path: str) -> Optional[Tuple[int, int, int, int]]:
    """Change signature of a path: ctime (no userland call can set it), mtime, size, inode."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    return (st.st_ctime_ns, st.st_mtime_ns, st.st_size, st.st_ino)


@dataclass
class Snap:
    """A worktree's dirty files: ``sigs`` = rel -> (git status code, stat signature) for EVERY
    dirty or untracked file (unbounded: that is what detects a change); ``texts`` = rel -> text
    for the first ``MAX_SNAPSHOT_TEXTS`` of them (a diff's before side). ``ok`` False: git failed."""
    sigs: Dict[str, Tuple[str, Optional[Tuple[int, int, int, int]]]] = field(default_factory=dict)
    texts: Dict[str, Optional[str]] = field(default_factory=dict)
    ok: bool = True


def dirty_snapshot(worktree: str, texts: bool = True) -> Snap:
    out = git(worktree, "status", "--porcelain", "-z", "--untracked-files=all", timeout=10.0)
    snap = Snap()
    if out is None:
        snap.ok = False
        return snap
    entries = out.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        code, rel = entry[:2], entry[3:]
        if "R" in code or "C" in code:
            i += 1  # skip the rename source
        if any(part in SKIP_PARTS for part in rel.split("/")):
            continue
        full = os.path.join(worktree, rel)
        snap.sigs[rel] = (code, _stat_sig(full))
        if texts and len(snap.texts) < MAX_SNAPSHOT_TEXTS:
            snap.texts[rel] = read_text(full) if os.path.isfile(full) else None
    return snap


def hermes_session_cwd(task_id: Any) -> Optional[str]:
    """The cwd Hermes's file/terminal tools use for this call's session, when it is known.

    Every ``hermes chat`` turn (``-q`` included) runs in the long-lived gateway process, whose
    ``os.getcwd()`` is not the directory the chat was started in. Hermes's file tools anchor a
    relative path at ``tools.file_tools_paths._authoritative_workspace_root(task_id)`` (session cwd
    record, else the session's registered cwd override); ask the same function, falling back to
    ``tools.terminal_tool``'s override / recorded cwd. Only modules Hermes already loaded are
    used (never import Hermes internals from here); any failure -> None.
    """
    if not isinstance(task_id, str) or not task_id:
        return None
    cwd: Any = None
    paths = sys.modules.get("tools.file_tools_paths")
    if paths is not None:
        try:
            cwd = paths._authoritative_workspace_root(task_id)
        except Exception:
            cwd = None
    term = sys.modules.get("tools.terminal_tool")
    if not cwd and term is not None:
        try:
            cwd = (term.resolve_task_overrides(task_id) or {}).get("cwd") or term.get_session_cwd(task_id)
        except Exception:
            cwd = None
    return cwd if isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isdir(cwd) else None


def process_pinned() -> bool:
    """True when this whole process works on one task: a kanban worker (``HERMES_KANBAN_TASK``)
    or a launcher-pinned candidate run (``WEFT_HERMES_TASK`` / ``WEFT_HERMES_CHANGE``)."""
    return any(os.environ.get(k, "").strip() for k in ("HERMES_KANBAN_TASK", "WEFT_HERMES_TASK", "WEFT_HERMES_CHANGE"))


def base_dir(task_id: Any = "") -> str:
    """Directory relative tool paths resolve against: kanban workspace, else the Hermes session's
    cwd, else this process's cwd."""
    return os.environ.get("HERMES_KANBAN_WORKSPACE") or hermes_session_cwd(task_id) or os.getcwd()


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
    snapshot: Snap = field(default_factory=Snap)  # terminal: the worktree's dirty files before
    integration: bool = False  # git merge/rebase/...: record HEAD moves only, not file changes
    more: List["Pending"] = field(default_factory=list)  # terminal: the call's other worktrees
    # terminal: why the worktree is captured: "named" (the call names it), "own" (this session
    # worked there before) or "wide" (an opaque call: every worktree of the repo)
    reach: str = "named"


class WeftAdapter:
    def __init__(self, config: Config, client: Optional[WcpClient] = None,
                 analyzer: Optional[Analyzer] = None, heartbeat: bool = True,
                 scope: Optional[Scope] = None, session_key: str = ""):
        self.cfg = config
        # The Hermes conversation this adapter reports for ("" = the whole process: a kanban
        # worker, a pinned candidate, or a caller that passes no hook ids). One gateway process
        # serves many chats, so the change must come from the hook call, never process state.
        self.session_key = session_key
        self.last_used = time.monotonic()
        # Set by the router for conversation adapters: the heartbeat loop hands an idle one back
        # (``on_idle(self)``) instead of heartbeating it until the gateway process exits.
        self.on_idle: Optional[Callable[["WeftAdapter"], bool]] = None  # True: retired
        self.idle_clock: Callable[[], float] = time.monotonic
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
        # Causing events fetched for quotes (seq -> record), and byte-identical edits blocked for a
        # stale declaration (fingerprint -> the quote shown), for the one-time retry guard.
        self.event_cache: "collections.OrderedDict[int, dict]" = collections.OrderedDict()
        self.blocked_edits: "collections.OrderedDict[str, Tuple[List[str], str]]" = collections.OrderedDict()
        self.task = self._task_info()
        change = f"{config.agent}/{self.task['id']}"
        if config.links is not None and session_key:
            # Standalone: the task is the checkout (sessions sharing one working tree are
            # alternatives, never checked against each other), the change is the conversation.
            change += f"/{session_key}"
        self.change = os.environ.get("WEFT_HERMES_CHANGE", "").strip() or change
        self.rec = status.Recorder(
            status.status_dir(config.log_path.parent) if config.log_path else None,
            {"route": config.route_key, "repo": config.repo, "agent": config.agent, "change": self.change,
             "task": dict(self.task), "mode": config.mode, "profile": config.profile, "url": config.url,
             "kind": status.gateway_kind(config.url), "worktree": config.route or "",
             "adapter": ADAPTER_VERSION, "source": "standalone" if config.links is not None else "installer"})
        self._hb_thread: Optional[threading.Thread] = None
        self._hb_enabled = heartbeat
        self._closed = False
        # auto-land (0.3): worktrees this session works in, HEAD/trunk snapshots around tool
        # calls that can run git, and the session's own work commits (hints for land.py).
        self.worktrees: Dict[str, None] = {}
        self._watch: Dict[str, dict] = {}
        self.work_shas: List[str] = []
        self.last_tips: Optional[Dict[str, str]] = None
        self._trunk: Optional[Tuple[Optional[str], float]] = None
        self._land_spawned_at = -1e9
        self._procs: List[Any] = []
        self.spawner: Callable[[List[str]], Any] = self._popen
        # Capture windows: worktree -> {"runs": [[start, end|None, call]], "edits": [[path,
        # start, end|None, call]]}. A run window lies inside this session's snapshot pair of the
        # worktree (opened after the pre-call snapshot, closed before the post-call one), an edit
        # window inside its before/after reads of the file, so a change made inside one is
        # certainly reported by this session. Published in the status file: another session
        # that sees the same change leaves it to this one (``_claimed_elsewhere``).
        self.activity: Dict[str, Dict[str, List[list]]] = {}
        _LIVE_ADAPTERS.add(self)

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
        if not task_id and self.cfg.links is not None:
            # Standalone: the checkout is the unit of work. Weft treats changes that share a task as
            # alternatives (best-of-N candidates), not as conflicts, so two checkouts must never share
            # one: a gateway process serves many sessions under one HERMES_SESSION_ID.
            return {"id": f"hermes-{hashlib.sha256(self.cfg.route_key.encode()).hexdigest()[:12]}"}
        if not task_id:
            # The hook call's conversation (session_key) names the work; the env/pid fallbacks
            # serve callers that pass no hook ids (a CLI process is one session).
            sid = self.session_key or os.environ.get("HERMES_SESSION_ID", "").strip() or f"pid{os.getpid()}"
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

    def _base_dir(self, task_id: Any = "") -> str:
        return base_dir(task_id)

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
            self.rec.set_session(self.session)
            self._start_heartbeat()
            return self.session

    def _call(self, fn: Callable[[str], Any]) -> Any:
        """Run ``fn(session)``; re-hello once if the session expired (§8.2)."""
        try:
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
        except WcpError as err:
            if err.code in ("transport", "circuit_open") or err.status >= 500:
                self.rec.set_reachable(False)
            raise
        self.rec.set_reachable(True)
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
                if self.session_key and self.on_idle and self.idle_clock() - self.last_used > SESSION_IDLE_S:
                    if self.on_idle(self):  # the chat went quiet: no heartbeats for it until it is back
                        return
                self.rec.touch()
                if time.monotonic() - self.last_contact < interval * 0.8:
                    continue
                try:
                    self._call(lambda s: self.client.heartbeat(s))
                except Exception as err:
                    self.log(f"heartbeat failed: {err}")

        self._hb_thread = threading.Thread(target=loop, name="weft-heartbeat", daemon=True)
        self._hb_thread.start()

    def close(self, close_analyzer: bool = True) -> None:
        if self._closed:
            return
        self.flush(5.0)
        self._closed = True
        if self.session:
            try:
                self.client.bye(self.session, "hermes process exit")
            except Exception:
                pass
        self.rec.end()
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

    def _queue(self, response: dict, extra: str = "", notes: Optional[str] = None) -> None:
        """Queue a verdict/inbox response's context for injection into the model, followed by
        quotes of the changes that caused its diagnostics (``_cause_notes``)."""
        context = response.get("context") or ""
        if notes is None:
            notes = self._cause_notes(response)
        top = self._note_items(response.get("inbox") or response.get("items") or [])
        text = "\n".join(t for t in (extra, context, notes) if t)
        self.outbox.append((text, int(response.get("delivered_through", 0)), top))

    # -- quotes of the causing change ------------------------------------------------------

    @staticmethod
    def _diagnostics_of(response: dict) -> List[dict]:
        out = [d for d in response.get("diagnostics") or [] if isinstance(d, dict)]
        for item in response.get("inbox") or response.get("items") or []:
            if isinstance(item, dict) and isinstance(item.get("diagnostic"), dict):
                out.append(item["diagnostic"])
        return out

    def _event_record(self, seq: int) -> Optional[dict]:
        """The causing event (``GET /repos/{repo}/events/{seq}``: this session's repo only, with
        the gateway's secret redaction applied). Successes are cached; failures are logged and
        quoted as unavailable (tokens without the ``observe`` scope cannot read events)."""
        with self.lock:
            if seq in self.event_cache:
                return self.event_cache[seq]
        try:
            record = self.client.event(seq)
        except Exception as err:
            self.log(f"event #{seq} unavailable for a quote: {err!r}")
            return None
        if not isinstance(record, dict) or record.get("seq") not in (None, seq):
            return None
        with self.lock:
            self.event_cache[seq] = record
            while len(self.event_cache) > MAX_EVENT_CACHE:
                self.event_cache.popitem(last=False)
        return record

    def _in_checkout(self, path: str, decl: str) -> Optional[bool]:
        """Whether this session's worktrees already contain ``decl`` in ``path`` (None: unknown)."""
        first = decl.split("\n", 1)[0].strip()
        seen = False
        for worktree in list(self.worktrees):
            prefix = self.scope.prefix_for(worktree)
            rel = path[len(prefix):] if prefix and path.startswith(prefix) else path
            full = os.path.join(worktree, rel)
            if not os.path.isfile(full):
                continue
            text = read_text(full)
            if text is None:
                continue
            seen = True
            if any(line.strip() == first for line in text.splitlines()):
                return True
        return False if seen else None

    def _cause_note(self, d: dict, key: str, seq: int) -> str:
        path, name = split_key(key)
        who = str(d.get("caused_by_agent") or "another agent")
        if sensitive_parts(path.split("/")):
            return (f"  ↳ event #{seq} by {who} changed {key}; Weft does not quote {path} "
                    "(excluded as sensitive). Ask " + who + " for the new shape.")
        record = self._event_record(seq)
        diff = record.get("diff") if record else None
        hunks = diff_hunks(diff, path) if isinstance(diff, str) else []
        decl = new_declaration(hunks, name)
        quote = quote_hunks(hunks, name)
        here = self._in_checkout(path, decl) if decl else None
        if here:
            where = f"Your checkout already has this change in {path}."
        elif decl:
            where = (f"That change is NOT in your checkout yet: re-reading {path} here still shows the "
                     "OLD code. Use the new declaration below, not your copy.")
        elif quote:
            where = (f"That change may not be in your checkout yet: if {path} here still shows the old "
                     "code, trust the diff below, not your copy.")
        else:
            where = f"That change may not be in your checkout yet: re-reading {path} here can show the old code."
        lines = [f"  ↳ event #{seq} by {who} changed {key}. {where}"]
        if decl:
            lines.append(f"    New declaration (event #{seq}):\n" + "\n".join(f"      {l}" for l in decl.split("\n")))
        if quote:
            lines.append(f"    Their diff to {path} (event #{seq}, excerpt):\n{quote}")
        elif record is None:
            lines.append(f"    (Weft could not fetch event #{seq} to show the new code: ask {who} for the new "
                         f"shape of {key}, or wait until their change reaches your checkout.)")
        return "\n".join(lines)

    def _cause_notes(self, response: dict) -> str:
        """For diagnostics caused by another agent's change to a declaration (``QUOTE_CODES``),
        the new declaration and a bounded excerpt of the causing event's diff. Never raises."""
        try:
            lines: List[str] = []
            done = set()
            for d in self._diagnostics_of(response):
                key, seq = d.get("symbol"), d.get("caused_by_seq")
                if d.get("code") not in QUOTE_CODES or not isinstance(key, str) or not SYMBOL_KEY.match(key) \
                        or not isinstance(seq, int) or isinstance(seq, bool) or seq <= 0:
                    continue
                if (seq, key) in done or len(done) >= MAX_QUOTED_CAUSES:
                    continue
                done.add((seq, key))
                lines.append(self._cause_note(d, key, seq))
            return "\n".join(lines)
        except Exception as err:  # a quote is a courtesy: never lose the diagnostic over it
            self.log(f"cause quote failed: {err!r}")
            return ""

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
        # The session opens lazily on the first edit. Hello before reading the base: otherwise the
        # first edit carries the pre-hello base 0 and every symbol landed earlier in the repo's
        # log looks like a stale_overwrite to a checkout that already contains it.
        self.ensure_session()
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
                      task_id: Any = "", **_: Any) -> Optional[dict]:
        name = normalize_tool(tool_name)
        args = args if isinstance(args, dict) else {}
        try:
            if name in EDIT_TOOLS:
                return self._pre_edit(name, args, tool_call_id, task_id)
            if name in WATCH_TOOLS:
                block = self._pre_terminal(name, args, tool_call_id, task_id)
                if not block:
                    self.watch_begin(tool_call_id, str(args.get("command") or args.get("code") or ""))
                return block
            if name in COMPLETION_TOOLS:
                if self.worktrees or self.work_shas:
                    self.request_land(f"{name}")  # the kanban completion path: never blocks
                return self._gate_tool(name)
        except Exception as err:  # fail open
            self.log(f"pre_tool_call {name} failed open: {err!r}")
        return None

    def _edit_targets(self, name: str, args: dict, task_id: Any = "") -> List[Target]:
        base = self._base_dir(task_id)
        paths = edit_paths(name, args)
        out = []
        for p in paths:
            t = self.scope.resolve(p, base)
            if t and t.repo == self.cfg.route_key and t not in out:
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

    def _pre_edit(self, name: str, args: dict, call_id: str, task_id: Any = "") -> Optional[dict]:
        targets = self._edit_targets(name, args, task_id)
        if not targets:
            return None  # SCOPE GUARD: not a weft path
        pend = Pending("edit", name, call_id or f"anon-{time.monotonic_ns()}", targets=targets)
        for t in targets:
            pend.before[t.abs] = read_text(t.abs) if os.path.exists(t.abs) else None
            self.worktrees.setdefault(t.worktree, None)
        self._open_window(pend.call_id, edits=[(t.worktree, t.abs) for t in targets])
        with self.lock:
            self.pending[pend.call_id] = pend
        if len(targets) != 1 or self.deferred:
            return None  # advise repos: no pre-check round trip (the commit verdict still advises)
        t = targets[0]
        after = self._proposed(name, args, pend.before[t.abs])
        if after is None or after == pend.before[t.abs]:
            return None
        fingerprint = hashlib.sha1(f"{t.rel}\0{after}".encode("utf-8", "surrogatepass")).hexdigest()
        if self.cfg.mode == "enforce":
            with self.lock:
                held = self.blocked_edits.pop(fingerprint, None)
            if held is not None:
                # The agent retried the exact edit that was just blocked for a stale declaration.
                # The coordinator would accept it now (the diagnostic advanced the base: §5.2), but
                # in a separate worktree a "re-read" shows the old code, so an unchanged retry most
                # likely means the agent did not take the new declaration in. Block it once more
                # with the quote; a second unchanged retry goes to the coordinator (deliberate).
                codes, shown = held
                with self.lock:
                    self.pending.pop(pend.call_id, None)
                self._close_window(pend.call_id, drop=True)
                self.log(f"identical retry of blocked edit to {t.rel} blocked once more ({', '.join(codes)})")
                return {"action": "block", "message": (
                    f"[weft] Edit blocked again: this is the exact edit to {t.rel} that Weft just blocked "
                    f"({', '.join(codes)}), unchanged. While the other agent's change is not in your checkout, "
                    "re-reading the file here shows the OLD code. The diagnostics again:\n"
                    f"{shown}\n"
                    "Do what each error's suggestion says. If it says the other agent owns the conflict, leave "
                    "this edit and report it (negotiate with that agent, or say so in your task report): do not "
                    "adapt your edit to their change. If it says to update your code, change your edit to match "
                    "the new declaration (or negotiate with that agent). If you have checked it and this exact "
                    "edit is still right without adapting to their change (for example, the new parameter is "
                    "optional), retry it unchanged once more and Weft will validate it against the current log.")}
        reads, writes = self.analyzer.analyze([(t.rel, pend.before[t.abs], after)], t.worktree,
                                              self.scope.prefix_for(t.worktree))
        if not writes:
            return None
        event = self._event([t.rel], reads, writes, unified_diff(t.rel, pend.before[t.abs], after),
                            name, pend.call_id, "pre_tool_call")
        verdict = self._submit("check", event, pend.call_id)
        if verdict.get("verdict") != "reject":
            return None  # warnings reach the model with the commit verdict (§8.3 step 2)
        self.rec.verdict("check", [t.rel], writes, verdict, name)
        if self.cfg.mode != "enforce":
            self._queue(verdict, "[weft] (advisory) this edit would be rejected:")
            return None
        notes = self._cause_notes(verdict)  # network (event fetch): outside the lock
        with self.lock:
            self.pending.pop(pend.call_id, None)
            self._queue(verdict, notes=notes)
            context = self._take_outbox()
        self._close_window(pend.call_id, drop=True)  # blocked: the edit never happens
        codes = sorted({str(d.get("code")) for d in verdict.get("diagnostics") or []
                        if isinstance(d, dict) and d.get("severity") == "error" and d.get("code") in RETRY_GUARD_CODES})
        if codes:
            with self.lock:
                self.blocked_edits[fingerprint] = (codes, context)
                while len(self.blocked_edits) > MAX_BLOCKED_EDITS:
                    self.blocked_edits.popitem(last=False)
        self.log(f"check rejected {t.rel} seq {verdict.get('seq')}")
        if notes:
            where = ("The new declaration and diff quoted above come from the Weft log, not from your "
                     "checkout: while the other agent's change is not in your checkout, re-reading the file "
                     "here shows the OLD code.")
        else:
            where = ("If another agent changed code you use, their change may not be in your checkout yet: "
                     "re-reading the file here can show the old code.")
        return {"action": "block", "message": (
            "[weft] Edit blocked by Weft edit-time coordination (another agent's change conflicts "
            f"with this edit to {t.rel}). Diagnostics:\n{context}\n"
            f"{BLOCKED_EDIT_ADVICE} {where}")}

    def _pre_terminal(self, name: str, args: dict, call_id: str, task_id: Any = "") -> Optional[dict]:
        """Snapshot every worktree of this repo the call may change, before it runs:

        - ``named``: the call's leading ``cd``/``git -C`` target, its workdir (else the session's
          directory) and every directory a literal path in it names (``terminal_scan``);
        - ``own``: every worktree this session worked in before, whatever the command says (a
          script or a build can write there without naming it);
        - ``wide``: when the call is opaque (a variable, ``$(...)``, an unparsed directory change,
          inline code, a bound hit, ``execute_code``...), every worktree of the repo.

        The parse only adds worktrees; an opaque call does not depend on it. ``post_tool_call``
        diffs each snapshot, and a ``git commit`` (any spelling, for an opaque call) first asks
        the commit gate."""
        base = self._base_dir(task_id)
        dirs, scan = terminal_scan(name, args, base)
        plan: Dict[str, str] = {}
        for d in dirs:
            hit = self.scope.locate_dir(d)
            if hit and hit[1] == self.cfg.route_key:
                plan.setdefault(hit[0], "named")
        for wt in list(self.worktrees):
            if os.path.isdir(wt):
                plan.setdefault(wt, "own")
        if scan.opaque:
            for wt in self.repo_worktrees():
                plan.setdefault(wt, "wide")
        if not plan:
            return None  # SCOPE GUARD
        command = str(args.get("command") or args.get("code") or "")
        named = any(r == "named" for r in plan.values())
        if self.session and ((named and re.search(r"\bgit\b[^|;&]*\bcommit\b", command))
                             or (scan.opaque and re.search(r"\bcommit\b", command))):
            block = self._gate("commit", "git commit")
            if block:
                return block
        call_id = call_id or f"anon-{time.monotonic_ns()}"
        integration = bool(GIT_INTEGRATION.search(command))
        if scan.opaque:
            wide = sum(1 for r in plan.values() if r == "wide")
            self.log(f"[{self.cfg.repo}] {name} call {call_id[:40]} {scan.opaque}: capturing "
                     f"{len(plan)} worktree(s) ({wide} by the opaque-call rule)")
        worktrees = list(plan)

        def take(wt: str) -> Pending:
            part = Pending("terminal", name, call_id, worktree=wt, integration=integration, reach=plan[wt])
            part.head = (git(wt, "rev-parse", "HEAD") or "").strip() or None
            if not integration:
                part.snapshot = dirty_snapshot(wt)
            return part

        parts = _pool_map(take, worktrees)
        for wt, reach in plan.items():
            if reach == "named":
                self.worktrees.setdefault(wt, None)
        self._open_window(call_id, runs=[wt for wt, r in plan.items() if r != "wide"])
        pend = parts[0]
        pend.more = parts[1:]
        with self.lock:
            self.pending[pend.call_id] = pend
        return None

    def abandon(self, call_id: str) -> None:
        """The call another adapter blocked never runs: forget its snapshot and activity."""
        with self.lock:
            pend = self.pending.pop(call_id, None) if call_id else None
        self._watch.pop(call_id or "anon", None)
        if pend:
            self._close_window(pend.call_id, drop=True)

    def repo_worktrees(self) -> List[str]:
        """Every in-scope worktree of this repo (``git worktree list`` of its checkout)."""
        git_dir = self._git_dir()
        out: List[str] = []
        for wt in worktree_list(git_dir) if git_dir else []:
            hit = self.scope.locate_dir(wt)
            if hit and hit[1] == self.cfg.route_key and hit[0] not in out:
                out.append(hit[0])
        return out

    # -- capture windows (who captures which worktree when) ---------------------------------

    def _open_window(self, call_id: str, runs: Optional[List[str]] = None,
                     edits: Optional[List[Tuple[str, str]]] = None) -> None:
        now = time.time()
        with self.lock:
            for wt in runs or []:
                ws = self.activity.setdefault(wt, {"runs": [], "edits": []})["runs"]
                ws.append([now, None, call_id])
                del ws[:-MAX_WINDOWS]
            for wt, path in edits or []:
                ws = self.activity.setdefault(wt, {"runs": [], "edits": []})["edits"]
                ws.append([path, now, None, call_id])
                del ws[:-MAX_WINDOWS]
            while len(self.activity) > 64:
                self.activity.pop(next(iter(self.activity)))
        self._publish_windows()

    def _close_window(self, call_id: str, drop: bool = False) -> None:
        """End (``drop``: forget, the call never ran) the windows of ``call_id``."""
        now = time.time()
        with self.lock:
            for a in self.activity.values():
                for key in ("runs", "edits"):
                    if drop:
                        a[key] = [w for w in a[key] if w[-1] != call_id]
                    else:
                        for w in a[key]:
                            if w[-1] == call_id and w[-2] is None:
                                w[-2] = now
        self._publish_windows()

    def _publish_windows(self) -> None:
        with self.lock:
            view = {wt: {"runs": [w[:2] for w in a["runs"]], "edits": [w[:3] for w in a["edits"]]}
                    for wt, a in self.activity.items() if a["runs"] or a["edits"]}
        self.rec.set_worktrees(view)

    @staticmethod
    def _covers(windows: Any, path: str, when: float, now: float) -> bool:
        """``windows`` (a published ``{"runs", "edits"}``) has a window containing ``when``:
        any run window, or an edit window of ``path``. An open window counts until now (unless
        it is stale: its call never ended)."""
        if not isinstance(windows, dict):
            return False

        def inside(start: Any, end: Any) -> bool:
            try:
                s = float(start)
                e = now if end is None else float(end)
            except (TypeError, ValueError):
                return False
            if end is None and now - s > BUSY_STALE_S:
                return False
            return s <= when <= e

        for w in windows.get("runs") or []:
            if isinstance(w, list) and len(w) >= 2 and inside(w[0], w[1]):
                return True
        for w in windows.get("edits") or []:
            if isinstance(w, list) and len(w) >= 3 and w[0] == path and inside(w[1], w[2]):
                return True
        return False

    @staticmethod
    def _changed_at(path: str) -> float:
        """When ``path`` last changed (ctime; a deleted file: its nearest existing directory's)."""
        p = path
        while True:
            try:
                return os.lstat(p).st_ctime
            except OSError:
                parent = os.path.dirname(p)
                if parent == p:
                    return time.time()
                p = parent

    def _claimed_elsewhere(self, worktree: str, path: str) -> Optional[str]:
        """Another live session (another change, in this process or another Hermes process)
        whose capture window of ``worktree`` (or edit window of ``path``) contains the moment
        ``path`` changed: that session reports the change itself."""
        when = self._changed_at(path)
        now = time.time()
        for other in list(_LIVE_ADAPTERS):
            if other is self or other._closed or other.change == self.change:
                continue
            with other.lock:
                a = other.activity.get(worktree)
                windows = {"runs": [w[:2] for w in a["runs"]], "edits": [w[:3] for w in a["edits"]]} if a else None
            if self._covers(windows, path, when, now):
                return other.change
        directory = self.rec.directory
        if directory is None:
            return None
        try:
            files = list(directory.glob("*.json"))
        except OSError:
            return None
        for f in files:
            if f == self.rec.path:
                continue
            try:
                snap = json.loads(f.read_text())
                if not isinstance(snap, dict) or snap.get("pid") == os.getpid() or snap.get("ended"):
                    continue
                if snap.get("change") == self.change or not status.pid_alive(snap.get("pid")):
                    continue
                if self._covers((snap.get("worktrees") or {}).get(worktree), path, when, now):
                    return str(snap.get("change") or "another session")
            except Exception:
                continue
        return None

    # -- gates -----------------------------------------------------------------------------

    def _gate_tool(self, name: str) -> Optional[dict]:
        if not self.session:
            return None  # no in-scope activity in this process: not a weft card
        return self._gate("stop", name)

    def _gate(self, gate: str, what: str) -> Optional[dict]:
        if self.cfg.mode != "enforce":
            return None
        result = self._call(lambda s: self.client.gate(s, gate))
        self.rec.gate(gate, bool(result.get("allow", True)), result.get("open_errors") or [], str(result.get("reason") or ""))
        if result.get("allow", True) or self._retreat(gate, what, result):
            return None
        open_errors = result.get("open_errors") or []
        self.log(f"gate {gate} refused ({len(open_errors)} open errors) for {what}")
        return {"action": "block", "message": (
            f"[weft] {what} refused by the Weft {gate} gate: {result.get('reason') or 'open errors'}\n"
            f"{OPEN_ERROR_ADVICE} If you deliberately retreated from "
            f"these symbols, retry {what} {RELEASE_AFTER_REFUSALS} more time(s) and Weft will let it "
            "through as a retreat: it releases them in the Weft feed, but the errors stay open on "
            "your change for humans and the coordinator's gates.")}

    def _retreat(self, gate: str, what: str, result: dict) -> bool:
        """Count a refusal; once the agent has insisted past ``RELEASE_AFTER_REFUSALS`` refusals
        over the same open errors, treat it as a deliberate retreat: release those keys and let
        the action through locally. The release gives up the claims only — it never clears an
        open error (spec §6.5, #17) — so the errors stay on the change, the release record shows
        humans what was walked away from, and the coordinator's own gates keep refusing. Returns
        True when the caller should let the action through."""
        open_errors = result.get("open_errors") or []
        keys = sorted({d.get("symbol") for d in open_errors
                       if isinstance(d.get("symbol"), str) and SYMBOL_KEY.match(d["symbol"])})
        fingerprint = f"{gate}:{','.join(keys)}"
        n = self.refusals.get(fingerprint, 0) + 1
        self.refusals[fingerprint] = n
        if n <= RELEASE_AFTER_REFUSALS or not keys:
            return False
        self.refusals.pop(fingerprint, None)
        self._release(keys, f"retreat: {what} after {n - 1} gate refusals")
        return True

    def _release(self, keys: List[str], note: str) -> bool:
        """Submit a ``release`` for ``keys``. ReleasePayload.reason is a closed enum (§6.3), so a
        retreat is ``abandoned``; the human-readable why rides in ``intent``. Returns True when
        the gateway accepted the release."""
        event = {"kind": "release", "base_seq": self._effective_base(),
                 "payload": {"keys": keys, "reason": "abandoned"}, "intent": note[:200]}
        try:
            verdict = self._submit("commit", event,
                                   f"release-{hashlib.sha1(note.encode()).hexdigest()[:10]}-{time.time_ns()}")
        except WcpError as err:
            issues = (err.details or {}).get("issues")
            self.log(f"release REJECTED by gateway for {keys}: {err.code}: {err.message}"
                     + (f" issues={json.dumps(issues)[:500]}" if issues else ""))
            return False
        except Exception as err:
            self.log(f"release failed for {keys}: {err!r}")
            return False
        if verdict.get("verdict") == "reject":
            self.log(f"release REJECTED (verdict) for {keys}: seq {verdict.get('seq')} "
                     f"{json.dumps(verdict.get('diagnostics') or [])[:500]}")
            self._queue(verdict)
            return False
        self._queue(verdict)
        self.rec.release(keys, note)
        self.log(f"released {keys} (abandoned, seq {verdict.get('seq')}): {note}")
        return True

    def pre_verify(self, **_: Any) -> Optional[dict]:
        if not self.session or self.cfg.mode != "enforce":
            return None
        try:
            result = self._call(lambda s: self.client.gate(s, "stop"))
        except Exception as err:
            self.log(f"pre_verify gate failed open: {err}")
            return None
        if result.get("allow", True):
            self.refusals.clear()
            return None
        if self._retreat("stop", "finishing", result):
            return None
        self.log(f"pre_verify refused ({len(result.get('open_errors') or [])} open errors)")
        return {"action": "continue", "message": (
            f"[weft] Not done yet: {result.get('reason') or 'open Weft errors'}\n"
            f"{OPEN_ERROR_ADVICE} "
            "If you deliberately retreated from these symbols, try to finish "
            f"{RELEASE_AFTER_REFUSALS} more time(s) and Weft will let you finish as a retreat (recorded "
            "in the Weft feed; the errors stay open on your change).")}

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
                self._close_window(pend.call_id)
                changes = [(t, pend.before.get(t.abs), self._current(t.abs)) for t in pend.targets]
                self._defer(lambda: self._commit_changes(changes, name, pend.call_id))
            elif pend and pend.kind == "terminal":
                self._post_terminal_all([pend, *pend.more])
            elif self.session and time.monotonic() - self.last_drain > DRAIN_EVERY_S:
                self.last_drain = time.monotonic()
                self._defer(self._drain)
        except Exception as err:
            self.log(f"post_tool_call {name} failed: {err!r}")
        if name in WATCH_TOOLS:
            self.watch_end(tool_call_id, name)

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
        self.rec.verdict("commit", [r for r, _, _ in rels], writes, verdict, tool)
        self._queue(verdict)
        self.last_drain = time.monotonic()

    def _post_terminal_all(self, parts: List[Pending]) -> None:
        self._close_window(parts[0].call_id)  # before the post-call snapshots: see self.activity
        afters = _pool_map(lambda p: None if p.integration else dirty_snapshot(p.worktree or "", texts=False),
                           parts)
        for part, after in zip(parts, afters):
            try:
                self._post_terminal(part, after)
            except Exception as err:
                self.log(f"[{self.cfg.repo}] terminal capture of {part.worktree} failed: {err!r}")

    def _post_terminal(self, pend: Pending, after: Optional[Snap] = None) -> None:
        worktree = pend.worktree or ""
        prefix = self.scope.prefix_for(worktree)
        head = (git(worktree, "rev-parse", "HEAD") or "").strip() or None
        integrating = pend.integration or bool(git(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"))
        if after is None and not integrating:
            after = dirty_snapshot(worktree, texts=False)
        before = pend.snapshot
        changes: List[Tuple[Target, Optional[str], Optional[str]]] = []
        if not integrating and after is not None and before.ok and after.ok:
            for rel in sorted(set(before.sigs) | set(after.sigs)):
                was, now = before.sigs.get(rel), after.sigs.get(rel)
                if was == now:
                    continue  # same git status and same stat signature (ctime included): unchanged
                full = os.path.join(worktree, rel)
                if was is not None and now is not None:  # dirty before and after
                    if rel in before.texts:
                        before_text = before.texts[rel]
                    else:
                        # past MAX_SNAPSHOT_TEXTS dirty files: still reported, against the
                        # pre-call HEAD version (a superset of this call's diff)
                        before_text = git(worktree, "show", f"{pend.head}:{rel}") if pend.head else None
                        self.log(f"[{self.cfg.repo}] {rel}: changed during {pend.tool}; before text not kept "
                                 f"(more than {MAX_SNAPSHOT_TEXTS} dirty files), diffing against HEAD")
                elif head != pend.head:
                    continue  # HEAD moved: a commit / checkout, not an edit (checkpoints cover it)
                elif now is not None:  # newly dirty: before = the HEAD version
                    before_text = git(worktree, "show", f"HEAD:{rel}")
                elif rel in before.texts:  # was dirty, now clean: reverted
                    before_text = before.texts[rel]
                else:
                    self.log(f"[{self.cfg.repo}] {rel}: reverted during {pend.tool}; before text not kept")
                    continue
                after_text = self._current(full)
                if before_text == after_text:
                    continue
                changes.append((Target(full, worktree, prefix + rel), before_text, after_text))
        elif not integrating and not (before.ok and (after is None or after.ok)):
            self.log(f"[{self.cfg.repo}] git status failed in {worktree}: {pend.tool} changes there not captured")
        moved = bool(head and pend.head and head != pend.head)
        if changes:
            kept = []
            for change in changes:
                other = self._claimed_elsewhere(worktree, change[0].abs)
                if other:
                    # made inside another live session's capture window: that session reports
                    # it (never claimed twice)
                    self.log(f"[{self.cfg.repo}] {change[0].rel} changed during {pend.tool}; left to "
                             f"{other}, whose capture covers that moment")
                else:
                    kept.append(change)
            changes = kept
            if changes:
                self.worktrees.setdefault(worktree, None)
        if not changes:
            if not moved and self.session and time.monotonic() - self.last_drain > DRAIN_EVERY_S:
                self.last_drain = time.monotonic()
                self._defer(self._drain)
            return
        # HEAD moves (checkpoints) are posted by watch_end, for every worktree of the session.
        self._defer(lambda: self._commit_changes(changes, pend.tool, pend.call_id))

    # -- HEAD / trunk watch and auto-land (0.3) ----------------------------------------------

    def _git_dir(self) -> Optional[str]:
        """A checkout of this repo (refs are shared by all its worktrees): the project dir,
        else an explicit root, else any worktree the session works in."""
        if self.cfg.route and os.path.isdir(self.cfg.route):  # standalone: this checkout
            return self.cfg.route
        for path, repo in self.cfg.projects.items():
            if repo == self.cfg.repo and os.path.isdir(path):
                return path
        for root in self.scope.roots:
            if self.scope.repo_of(root) == self.cfg.repo and os.path.isdir(root.path):
                return root.path
        for wt in self.worktrees:
            if os.path.isdir(wt):
                return wt
        return None

    def _tips(self, git_dir: str) -> Dict[str, str]:
        now = time.monotonic()
        if self._trunk is None or now - self._trunk[1] > TRUNK_TTL_S:
            self._trunk = (detect_trunk(git_dir, self.cfg.trunks.get(self.cfg.repo)), now)
        return trunk_tips(git_dir, self._trunk[0])

    def watch_begin(self, call_id: str = "", command: str = "") -> None:
        """Before a tool that can run git: snapshot the session's worktree HEADs and the trunk
        tips. A trunk that moved since the previous call (another process merged) triggers a
        land check right away."""
        key = call_id or "anon"
        if key in self._watch:
            return
        try:
            git_dir = self._git_dir()
            if not git_dir:
                return
            tips = self._tips(git_dir)
            heads = {wt: (git(wt, "rev-parse", "HEAD") or "").strip() or None for wt in list(self.worktrees)}
            if len(self._watch) > 64:
                self._watch.pop(next(iter(self._watch)))
            self._watch[key] = {"t": time.time(), "tips": tips, "heads": heads, "pull": bool(GIT_PULL.search(command))}
            prev = self.last_tips if self.last_tips is not None else self._swept_tips()
            if prev is not None and tips != prev:
                self.request_land("trunk moved since the last check")
            self.last_tips = tips
        except Exception as err:  # fail open
            self.log(f"[{self.cfg.repo}] watch_begin failed open: {err!r}")

    def watch_end(self, call_id: str = "", tool: str = "terminal") -> None:
        """After the tool: a worktree whose HEAD moved gets a ``checkpoint`` (``x_work`` = the
        command made this commit: not on trunk before, committed during the call, not a pull);
        a trunk that moved triggers the land check (after the checkpoints, in queue order)."""
        snap = self._watch.pop(call_id or "anon", None)
        if not snap:
            return
        try:
            git_dir = self._git_dir()
            tips = self._tips(git_dir) if git_dir else {}
            for wt, before in snap["heads"].items():
                after = (git(wt, "rev-parse", "HEAD") or "").strip() or None
                if not (before and after and after != before):
                    continue
                work = (not snap["pull"] and (commit_time(wt, after) or 0) >= snap["t"] - 5
                        and not any(is_ancestor(wt, after, t) for t in snap["tips"].values()))
                if work and after not in self.work_shas:
                    self.work_shas = (self.work_shas + [after])[-20:]
                self._defer(lambda sha=after, w=work: self._checkpoint(sha, w, tool, call_id))
            self.last_tips = tips
            if tips != snap["tips"]:
                self._defer(lambda: self.request_land("trunk moved"))
            elif time.monotonic() - self._land_spawned_at > LAND_RETRY_S and self._pending_exists():
                self.request_land("retrying a pending land")
        except Exception as err:  # fail open
            self.log(f"[{self.cfg.repo}] watch_end failed open: {err!r}")

    def _checkpoint(self, sha: str, work: bool, tool: str, call_id: str) -> None:
        event = {"kind": "checkpoint", "base_seq": self._effective_base(), "payload": {"sha": sha, "x_work": work},
                 "tool": {"name": tool, "harness_event": "post_tool_call"}}
        if self.task.get("title"):
            event["summary_hint"] = self.task["title"][:100]
        try:
            verdict = self._submit("commit", event, f"{call_id}:checkpoint:{sha[:12]}")
        except Exception as err:  # fail open; land.py still gets the sha as a --hint
            self.log(f"[{self.cfg.repo}] checkpoint {sha[:12]} failed open: {err!r}")
            return
        self._queue(verdict)
        self.rec.checkpoint(sha, work)
        # A new commit on the worktree: assume it is rebased. Cleared after _queue, because
        # this verdict repeats any still-unacked trunk item and would re-set the floor.
        self.rebase_floor = None

    def _swept_tips(self) -> Optional[Dict[str, str]]:
        """Trunk tips the last land.py run for this repo saw (any process), None if unknown: a
        session's first look at a repo notices merges made while no session was watching."""
        if not self.cfg.auto_land or not self.cfg.log_path:
            return None
        try:
            tips = json.loads(state_path(self.cfg.repo, self.cfg.log_path.parent).read_text()).get("swept_tips")
        except Exception:
            return None
        return tips if isinstance(tips, dict) else None

    def _pending_exists(self) -> bool:
        if not self.cfg.auto_land or not self.cfg.log_path:
            return False
        return pending_path(self.cfg.repo, self.cfg.log_path.parent).exists()

    @staticmethod
    def _popen(args: List[str]) -> Any:
        return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)

    def request_land(self, reason: str) -> None:
        """Spawn ``land.py --auto`` for this repo, detached: it lands every change whose newest
        work commit is on trunk. Never waits, never raises. The land script (not this process)
        reads the repo's system land token; this process holds only its agent token."""
        if not self.cfg.auto_land:
            return
        try:
            git_dir = self._git_dir()
            script = Path(__file__).resolve().with_name("land.py")
            if not git_dir or not script.exists():
                return
            self._procs = [p for p in self._procs if getattr(p, "poll", lambda: 0)() is None]  # reap
            args = [sys.executable or "python3", str(script), "--auto", "--repo", self.cfg.repo,
                    "--git-dir", git_dir, "--profile", self.cfg.profile]
            if self.cfg.log_path:
                args += ["--log", str(self.cfg.log_path)]
            if self.cfg.trunks.get(self.cfg.repo):
                args += ["--trunk", self.cfg.trunks[self.cfg.repo]]
            for sha in self.work_shas[-5:]:
                args += ["--hint", f"{self.change}={sha}"]
            self._land_spawned_at = time.monotonic()
            proc = self.spawner(args)
            if proc is not None:
                self._procs.append(proc)
            self.log(f"[{self.cfg.repo}] auto-land check started ({reason})")
        except Exception as err:  # fail open
            self.log(f"[{self.cfg.repo}] auto-land spawn failed open: {err!r}")

    def _drain(self) -> None:
        batch = self._call(lambda s: self.client.drain(s, ack=self.acked or None))
        self.last_drain = time.monotonic()
        if batch.get("items"):
            self.rec.inbox(batch["items"])
            self._queue(batch)

    # -- agent-facing reads (the weft_status / weft_inbox tools, /weft status) ----------------

    def inbox_now(self) -> str:
        """Fetch what other agents sent since the last look and hand it to the model (it advances
        the base and acks, exactly as an injected diagnostic would)."""
        self._drain()
        return self._take_outbox()

    def refresh_open(self) -> List[dict]:
        """Ask the gateway for this change's open errors (the ``stop`` gate is a read: it only
        reports them; advise repos never act on it)."""
        result = self._call(lambda s: self.client.gate(s, "stop"))
        self.rec.gate("stop", True, result.get("open_errors") or [])
        return list(self.rec.snapshot()["open"])

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

    LONG-LIVED PROCESSES. Every ``hermes`` / ``hermes chat -q`` turn runs inside the gateway
    process, which lives for days. An unknown project is therefore re-checked: at most once per
    ``RELOAD_EVERY_S`` the config file is re-read, so a project added by ``install.py --sync``
    starts reporting without a gateway restart. Live sessions keep their tokens.
    """

    def __init__(self, config: Config, client_factory: Optional[Callable[[Config], Any]] = None,
                 analyzer: Optional[Analyzer] = None, heartbeat: bool = True,
                 loader: Optional[Callable[[], Optional[Config]]] = None,
                 clock: Callable[[], float] = time.monotonic):
        self.cfg = config
        self.scope = config.scope()
        # (route key, session key) -> adapter: one WCP session per repo AND Hermes conversation.
        self.adapters: Dict[Tuple[str, str], WeftAdapter] = {}
        self.unknown: Dict[str, float] = {}  # repo -> when it was last found to have no token
        # physical Hermes session id -> conversation key (compression rotates the session id,
        # the conversation id stays); filled from tool calls, read by hooks that carry only
        # ``session_id`` (pre_verify, session start/end).
        self._conversations: "collections.OrderedDict[str, str]" = collections.OrderedDict()
        # (repo, conversation) -> base_seq of a session-start adapter opened under the physical
        # session id before a tool call showed the conversation (see ``_adopt``).
        self._start_bases: Dict[Tuple[str, str], int] = {}
        self.client_factory = client_factory
        self.heartbeat = heartbeat
        self.lock = threading.RLock()
        self._analyzer = analyzer
        self._loader = loader
        self._clock = clock
        self._loaded_at = clock()

    def _reload(self) -> bool:
        """Re-read the config (rate-limited to once per ``RELOAD_EVERY_S``); True when it was
        re-read. Only token/mode/project maps and explicit roots change: the reload can add repos
        this profile already holds tokens for in the config file, nothing else."""
        now = self._clock()
        if self._loader is None or now - self._loaded_at < RELOAD_EVERY_S:
            return False
        self._loaded_at = now
        try:
            fresh = self._loader()
        except Exception as err:
            self.log(f"config reload failed: {err!r}")
            return False
        if not fresh or fresh.profile != self.cfg.profile:
            return False
        self.cfg = fresh
        if fresh.links is not None:  # standalone: new settings (mode, trusted gateways, ...) apply live
            if isinstance(self.scope, StandaloneScope):
                self.scope.links = fresh.links
            for adapter in self._live():
                adapter.cfg = replace(adapter.cfg, mode=fresh.mode_for(adapter.cfg.route_key), links=fresh.links)
                adapter.rec.set_mode(adapter.cfg.mode)
            return True
        # Shared with live adapters: update in place (single attribute stores, GIL-atomic).
        # Explicit roots too: a project registered outside the project dirs (``roots`` entry)
        # after this process started must resolve without a restart.
        self.scope.roots = Scope.sort_roots(fresh.roots)
        self.scope.projects = dict(fresh.projects)
        self.scope.known_repos = set(fresh.known_repos())
        self.scope.project_dirs = list(fresh.project_dirs)
        self.scope.excludes = list(fresh.excludes)
        self.scope._ext = {}
        return True

    def log(self, message: str) -> None:
        WeftAdapter.log(self, message)  # type: ignore[arg-type]

    @property
    def analyzer(self) -> Analyzer:
        if self._analyzer is None:
            self._analyzer = Analyzer(self.cfg.node, self.cfg.analyzer, log=self.log)
        return self._analyzer

    # -- sessions ----------------------------------------------------------------------------

    def session_key(self, kw: Dict[str, Any]) -> str:
        """The Hermes conversation a hook call belongs to, from the call's own ids (never from
        process state: one gateway process runs many chats at once). ``conversation_id`` first
        (stable across context compression, which rotates ``session_id``), then ``session_id``
        (mapped back to its conversation when a tool call showed the pair), then ``task_id``.
        "" for a process pinned to one task (kanban worker, candidate run): every call is it."""
        if process_pinned():
            return ""
        conv = str(kw.get("conversation_id") or "").strip()[:200]
        sid = str(kw.get("session_id") or "").strip()[:200]
        with self.lock:
            if conv:
                if sid and sid != conv:
                    known = self._conversations.get(sid)
                    self._conversations[sid] = conv
                    self._conversations.move_to_end(sid)
                    while len(self._conversations) > MAX_SESSION_KEYS:
                        self._conversations.popitem(last=False)
                    if known != conv:
                        self._adopt(sid, conv)
                return conv
            if sid:
                return self._conversations.get(sid, sid)
        tid = kw.get("task_id")
        return tid.strip()[:200] if isinstance(tid, str) else ""

    def _adopt(self, sid: str, conv: str) -> None:
        """A tool call just showed that physical session ``sid`` belongs to conversation ``conv``.
        ``on_session_start`` carries only ``sid``, so a resumed (compressed) conversation's
        start-time adapter was keyed by it, with a task named after it. Hand its base (the log
        head when the session started) to the conversation's adapter, which every later edit
        uses, and close it: the late-base problem session start prevents stays prevented, and no
        second WCP session lingers until finalize. Caller holds ``self.lock``."""
        for key in [k for k in self.adapters if k[1] == sid]:
            early = self.adapters.pop(key)
            target = (key[0], conv)
            if early.session and early.base_seq:
                live = self.adapters.get(target)
                if live is None:
                    prev = self._start_bases.get(target)
                    self._start_bases[target] = min(prev, early.base_seq) if prev else early.base_seq
                elif not live.session:
                    live.base_seq = min(live.base_seq, early.base_seq) if live.base_seq else early.base_seq
            self._retire(early, f"session start adopted by conversation {conv}")
        while len(self._start_bases) > MAX_SESSION_KEYS:
            self._start_bases.pop(next(iter(self._start_bases)))

    def adapter_for(self, repo: str, session: str = "") -> Optional[WeftAdapter]:
        if not repo:
            return None
        with self.lock:
            if self.cfg.links is not None:
                self._reload()  # rate-limited; picks up settings changed since the last look
            hit = self.adapters.get((repo, session))
            if hit:
                hit.last_used = self._clock()
                return hit
            cfg = self.cfg.for_repo(repo)
            if not cfg:
                seen = self.unknown.get(repo)
                if seen is not None and self._clock() - seen < RELOAD_EVERY_S:
                    return None
                if self._reload():
                    cfg = self.cfg.for_repo(repo)
                if not cfg:
                    if seen is None:
                        self.log(f"project '{repo}' has no Weft repo/token for profile {self.cfg.profile}; "
                                 f"skipping (run `install.py --sync` to add it; re-checked every "
                                 f"{int(RELOAD_EVERY_S)} s)")
                    self.unknown[repo] = self._clock()
                    return None
                self.unknown.pop(repo, None)
                self.log(f"config reloaded: project '{repo}' now has a Weft repo/token")
            self._evict_idle()
            client = self.client_factory(cfg) if self.client_factory else None
            adapter = WeftAdapter(cfg, client=client, analyzer=self.analyzer, heartbeat=self.heartbeat,
                                  scope=self.scope, session_key=session)
            adapter.last_used = self._clock()
            start_base = self._start_bases.pop((repo, session), 0)
            if start_base:
                adapter.base_seq = start_base  # its hello keeps min(base, delivered_through)
            if session:
                adapter.on_idle, adapter.idle_clock = self._idle_retire, self._clock
            self.adapters[(repo, session)] = adapter
            if adapter._pending_exists():  # a land a previous process could not post
                adapter.request_land("retrying a pending land")
            return adapter

    def _evict_idle(self) -> None:
        """Close conversation adapters idle for ``SESSION_IDLE_S`` (the gateway lives for days and
        serves many chats). A chat that comes back gets a fresh WCP session on the same change."""
        now = self._clock()
        idle = [k for k, a in self.adapters.items()
                if k[1] and now - a.last_used > SESSION_IDLE_S and not a.pending]
        for k in idle:
            self._retire(self.adapters.pop(k), "idle")

    def _idle_retire(self, adapter: WeftAdapter) -> bool:
        """An idle conversation adapter's heartbeat loop gave it back: drop it and say bye.
        Rechecked under the lock: a call that reused it since the heartbeat looked, or a tool
        call still in flight (a build running for hours), keeps it."""
        with self.lock:
            if self._clock() - adapter.last_used <= SESSION_IDLE_S or adapter.pending:
                return False
            for k, a in list(self.adapters.items()):
                if a is adapter:
                    self.adapters.pop(k)
        self._retire(adapter, "idle")
        return True

    def _retire(self, adapter: WeftAdapter, why: str) -> None:
        adapter.log(f"[{adapter.cfg.repo}] closing session {adapter.change} ({why})")
        threading.Thread(target=adapter.close, kwargs={"close_analyzer": False}, name="weft-close",
                         daemon=True).start()

    def _repos(self, name: str, args: dict, task_id: Any = "", session: str = "") -> List[str]:
        if self.cfg.links is not None:
            self._reload()
        base = base_dir(task_id)
        repos: List[str] = []
        if name in EDIT_TOOLS:
            paths = edit_paths(name, args)
            missed = []
            for p in paths:
                t = self.scope.resolve(p, base)
                if not t:
                    missed.append(p)
                elif t.repo not in repos:
                    repos.append(t.repo)
            # A path in no project may be in one registered since the last config read (an
            # explicit root outside the project dirs): re-read (rate-limited) and retry.
            if missed and self._reload_on_miss():
                for p in missed:
                    t = self.scope.resolve(p, base)
                    if t and t.repo not in repos:
                        self.log(f"config reloaded: {t.worktree} now resolves to project '{t.repo}'")
                        repos.append(t.repo)
        elif name in WATCH_TOOLS:
            repos = self._terminal_repos(name, args, base, session)
        return repos

    def _reload_on_miss(self) -> bool:
        """Multi-project mode: a path resolved to no project. Re-read the config (at most once
        per ``RELOAD_EVERY_S``, shared with the unknown-repo re-check); True when re-read.
        Standalone mode already re-reads on every call."""
        if self.cfg.links is not None:
            return False
        with self.lock:
            return self._reload()

    def _terminal_repos(self, name: str, args: dict, base: str, session: str) -> List[str]:
        """Repos a terminal / ``execute_code`` call is captured in. The ones its directories and
        literal paths name; when the call is opaque (``CommandScan.opaque``: a variable, an
        unparsed directory change, inline code, a bound hit, ``execute_code``), also every repo
        this conversation works in and every project whose folder name the call mentions, with
        every worktree of each (a standalone checkout's worktrees are repos of their own). Each
        repo's adapter then snapshots all of that repo's worktrees (``_pre_terminal``)."""
        dirs, scan = terminal_scan(name, args, base)
        repos: List[str] = []
        seeds: List[str] = []  # a checkout of each repo, for its worktree list
        hits = [self.scope.locate_dir(d) for d in dirs]
        if not all(hits) and self._reload_on_miss():  # see ``_repos``
            before = hits
            hits = [self.scope.locate_dir(d) for d in dirs]
            for old, hit in zip(before, hits):
                if hit and not old:
                    self.log(f"config reloaded: {hit[0]} now resolves to project '{hit[1]}'")
        for hit in hits:
            if hit and hit[1] not in repos:
                repos.append(hit[1])
                seeds.append(hit[0])
        if not scan.opaque:
            return repos
        for adapter in self._live(session):
            route = adapter.cfg.route_key
            if route not in repos:
                git_dir = adapter._git_dir()
                repos.append(route)
                seeds.append(git_dir or "")
        roots = list(self.scope.projects.items()) + [(r.path, self.scope.repo_of(r)) for r in self.scope.roots]
        for path, _ in roots:
            if os.path.basename(path) in scan.names:
                hit = self.scope.locate_dir(path)
                if hit and hit[1] not in repos:
                    repos.append(hit[1])
                    seeds.append(hit[0])
        for seed in list(seeds):
            for wt in worktree_list(seed) if seed else []:
                hit = self.scope.locate_dir(wt)
                if hit and hit[1] not in repos:
                    repos.append(hit[1])
        return repos

    def _live(self, session: Optional[str] = None) -> List[WeftAdapter]:
        """Live adapters: all of them, or only one conversation's (``session``)."""
        with self.lock:
            return [a for (_, s), a in self.adapters.items() if session is None or s == session]

    def set_mode(self, mode: str) -> None:
        """Switch every live checkout (and later ones) to ``advise`` / ``enforce`` right now."""
        self.cfg = replace(self.cfg, default_mode=mode, mode=mode)
        for adapter in self._live():
            adapter.cfg = replace(adapter.cfg, mode=mode)
            adapter.rec.set_mode(mode)

    def adapter_at(self, directory: Any, kw: Optional[Dict[str, Any]] = None) -> Optional[WeftAdapter]:
        """The adapter for the checkout that contains ``directory`` (created if it is linked), for
        the conversation of the hook/tool call ``kw`` (none: the process-wide one)."""
        if self.cfg.links is not None:
            self._reload()
        hit = self.scope.locate_dir(directory) if isinstance(directory, str) else None
        if not hit and isinstance(directory, str) and directory and self._reload_on_miss():
            hit = self.scope.locate_dir(directory)  # see ``_repos``
        return self.adapter_for(hit[1], self.session_key(kw or {})) if hit else None

    def pre_tool_call(self, tool_name: str = "", args: Optional[dict] = None, **kw: Any) -> Optional[dict]:
        name = normalize_tool(tool_name)
        args = args if isinstance(args, dict) else {}
        try:
            session = self.session_key(kw)
            if name in COMPLETION_TOOLS:
                targets = self._live(session)
            else:
                targets = [a for a in (self.adapter_for(r, session)
                                       for r in self._repos(name, args, kw.get("task_id"), session)) if a]
                if name in WATCH_TOOLS:
                    # every repo this conversation works in snapshots its own worktrees around
                    # every terminal call, whatever the command names (WeftAdapter._pre_terminal)
                    targets += [a for a in self._live(session) if a not in targets]
        except Exception as err:  # fail open
            self.log(f"route {name} failed open: {err!r}")
            return None
        for i, adapter in enumerate(targets):
            block = adapter.pre_tool_call(tool_name=tool_name, args=args, **kw)
            if block:
                for earlier in targets[:i]:  # the call will not run: drop their snapshots
                    earlier.abandon(str(kw.get("tool_call_id") or ""))
                return block
        if name in WATCH_TOOLS:
            # Every repo this conversation works in watches its worktrees and trunk around the
            # call, wherever the command runs (`cd ~/github/x && git merge ...` from a scratch dir).
            command = str(args.get("command") or args.get("code") or "")
            for adapter in self._live(session):
                if adapter not in targets:
                    adapter.watch_begin(str(kw.get("tool_call_id") or ""), command)
        return None

    def post_tool_call(self, **kw: Any) -> None:
        now = self._clock()
        for adapter in self._live(self.session_key(kw)):
            adapter.last_used = now  # a long tool call counts as use: idle starts when it ends
            adapter.post_tool_call(**kw)

    def session_started(self, session_id: Any = "", **kw: Any) -> None:
        """A Hermes session began: open this session's Weft session for its checkout *now* (off the
        turn's path), so its base is the log head at the start of the work. Opened lazily at the
        first edit instead, an agent that started before another agent's edit would count that
        edit as already seen and never be told it conflicts."""
        try:
            adapter = self.adapter_at(base_dir(session_id), {**kw, "session_id": session_id})
        except Exception as err:  # fail open
            self.log(f"session start route failed open: {err!r}")
            return
        if adapter is None or adapter.session:
            return

        def open_session() -> None:
            try:
                adapter.ensure_session()
            except Exception as err:  # fail open: the first edit retries
                adapter.log(f"[{adapter.cfg.repo}] session start hello failed open: {err!r}")

        threading.Thread(target=open_session, name="weft-hello", daemon=True).start()

    def session_finalized(self, **kw: Any) -> None:
        """The Hermes session closed for good: flush and say bye for its conversation's adapters
        (off the caller's thread). The process-wide ones ("" key) live until exit."""
        session = self.session_key(kw)
        if not session:
            return
        with self.lock:
            sid = str(kw.get("session_id") or "").strip()[:200]
            done = [k for k in self.adapters if k[1] in (session, sid)]
            adapters = [self.adapters.pop(k) for k in done]
            for k in [k for k in self._start_bases if k[1] == session]:
                self._start_bases.pop(k)
            if sid:
                self._conversations.pop(sid, None)
        for adapter in adapters:
            self._retire(adapter, "session finalized")

    def transform_tool_result(self, result: Any = None, **kw: Any) -> Optional[str]:
        out, changed = result, False
        for adapter in self._live(self.session_key(kw)):
            r = adapter.transform_tool_result(result=out, **kw)
            if r is not None:
                out, changed = r, True
        return out if changed else None

    def pre_verify(self, **kw: Any) -> Optional[dict]:
        for adapter in self._live(self.session_key(kw)):
            r = adapter.pre_verify(**kw)
            if r:
                return r
        return None

    def flush(self, timeout: float = 5.0, kw: Optional[Dict[str, Any]] = None) -> bool:
        """Wait (bounded) for deferred submissions: every adapter's, or one conversation's."""
        deadline = time.monotonic() + timeout
        live = self._live(None if kw is None else self.session_key(kw))
        return all(a.flush(max(0.0, deadline - time.monotonic())) for a in live)

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
_LOAD_TRIED_AT = 0.0


_GET_CONFIG: Optional[Callable[[str, Any], Any]] = None
_GET_SECRET: Callable[[str], Optional[str]] = standalone.default_secret


def configure(get_config: Optional[Callable[[str, Any], Any]] = None,
              get_secret: Optional[Callable[[str], Optional[str]]] = None) -> None:
    """Called by ``register(ctx)``: the plugin's settings reader (``ctx.get_config``) and secret reader."""
    global _GET_CONFIG, _GET_SECRET
    if get_config is not None:
        _GET_CONFIG = get_config
    if get_secret is not None:
        _GET_SECRET = get_secret


def _setting(key: str, default: Any = None) -> Any:
    if _GET_CONFIG is None:
        return default
    try:
        return _GET_CONFIG(key, default)
    except Exception:
        return default


def installer_managed() -> bool:
    """True for a copy made by this repo's own installer (``scripts/install.py`` writes
    ``INSTALLED.json`` next to the code) or when ``WEFT_HERMES_CONFIG`` names a config file: those
    use the multi-project config file the installer manages. A catalog install has neither and
    runs standalone (per-checkout ``.weft/``, see standalone.py)."""
    return bool(os.environ.get("WEFT_HERMES_CONFIG")) or (Path(__file__).resolve().parent / "INSTALLED.json").exists()


def _load_config() -> Optional[Config]:
    if installer_managed():
        cfg = Config.load()
        if cfg:
            return cfg
    return Config.standalone(_setting, lambda name: _GET_SECRET(name))


def get_adapter() -> Optional[WeftRouter]:
    """The process-wide router. A process that found no usable config (or no agent for this
    profile) retries at most once per ``RELOAD_EVERY_S``: the Hermes gateway outlives installs."""
    global _ADAPTER, _LOADED, _LOAD_TRIED_AT
    if _setting("enabled", True) is False:
        if _ADAPTER is not None:
            shutdown()
        return None
    if _LOADED and (_ADAPTER is not None or time.monotonic() - _LOAD_TRIED_AT < RELOAD_EVERY_S):
        return _ADAPTER
    with _ADAPTER_LOCK:
        if not _LOADED or (_ADAPTER is None and time.monotonic() - _LOAD_TRIED_AT >= RELOAD_EVERY_S):
            _LOAD_TRIED_AT = time.monotonic()
            cfg = _load_config()
            _ADAPTER = WeftRouter(cfg, loader=_load_config) if cfg else None
            if _ADAPTER:
                atexit.register(_ADAPTER.close)
            _LOADED = True
    return _ADAPTER


def shutdown(wait: bool = False) -> None:
    """Plugin unload (a gateway ``reload-plugins`` / ``hermes plugins enable|disable``): close the
    router's sessions (bounded flush + bye) off the caller's thread. The reloaded module builds a
    fresh router, so the old one must not keep heartbeating."""
    global _ADAPTER, _LOADED
    with _ADAPTER_LOCK:
        router, _ADAPTER, _LOADED = _ADAPTER, None, False
    if router is None:
        return
    t = threading.Thread(target=router.close, name="weft-unload", daemon=True)
    t.start()
    if wait:
        t.join(10.0)
