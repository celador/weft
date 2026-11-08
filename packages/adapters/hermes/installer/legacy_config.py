"""Development-installer-only configuration reader; NOT part of the catalog subdirectory.
Copied beside adapter.py only by scripts/install.py. Catalog credentials use agent.secret_scope.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict

def read_raw(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {}

def load(path=None, profile=None):
    try:
        from .adapter import Config, Root, current_profile, default_config_path, _real, _find_node, DEFAULT_ROOTS, DEFAULT_PROJECT_DIRS, DEFAULT_EXCLUDES
    except ImportError:
        try:
            from weft.adapter import Config, Root, current_profile, default_config_path, _real, _find_node, DEFAULT_ROOTS, DEFAULT_PROJECT_DIRS, DEFAULT_EXCLUDES
        except ImportError:
            from adapter import Config, Root, current_profile, default_config_path, _real, _find_node, DEFAULT_ROOTS, DEFAULT_PROJECT_DIRS, DEFAULT_EXCLUDES
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
        trunks={str(k): str(v) for k, v in (raw.get("trunks") or {}).items()},
        auto_land=raw.get("auto_land", True) is not False,
    )
    cfg.mode = cfg.mode_for(repo) if repo else cfg.default_mode
    return cfg
