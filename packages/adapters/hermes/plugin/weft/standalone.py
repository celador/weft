"""Standalone mode: how a catalog install finds its gateway, repo and token, with nothing preconfigured.

A user who installed the plugin from the Hermes catalog has no ``~/.config/weft/hermes-adapter.json``
(that file belongs to Weft's own multi-profile dev installer). Instead each *checkout* says where it
reports, the way every other Weft adapter works:

1. ``<checkout>/.weft/space.json`` + Hermes-managed ``WEFT_AGENT_TOKEN``: written by ``npx @celador/weft``
   (the local gateway on 127.0.0.1 by default; ``--hosted`` / ``deploy`` for the others). One agent
   token saved by the user in Hermes, never read from CLI credential files. A checkout without
   ``.weft/`` is never reported (unless explicit project_dirs are configured).
2. Explicit settings (``plugins.entries.weft.settings``): ``gateway_url`` + ``repo`` + the secret
   ``WEFT_AGENT_TOKEN`` (read through Hermes' secret scope) for the checkouts under ``project_dirs``.
   Empty by default.

Safety: a ``.weft/space.json`` can come from a repository you cloned, so its gateway URL is honoured
only when it is this machine (127.0.0.1 / localhost), Weft's hosted gateway, or listed in the
``trusted_gateways`` setting (``/weft trust <url>``). Anything else is skipped with one log line:
a cloned repo can never point your diffs at a server you did not choose.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

HOSTED_URL = "https://weft-hosted.elier.ai"
LOCAL_URL = "http://127.0.0.1:7878"
LINK_TTL_S = 5.0
_LOOPBACK = re.compile(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?(/|$)")
_AGENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


def norm_url(url: Any) -> str:
    return str(url or "").strip().rstrip("/")


def is_trusted(url: str, extra: List[str]) -> bool:
    u = norm_url(url)
    if not u:
        return False
    if _LOOPBACK.match(u) or u == HOSTED_URL:
        return True
    return u in {norm_url(x) for x in extra}


@dataclass
class Settings:
    enabled: bool = True
    mode: str = "advise"
    project_dirs: List[str] = field(default_factory=list)
    gateway_url: str = ""
    repo: str = ""
    agent: str = ""
    trusted_gateways: List[str] = field(default_factory=list)
    analyzer: str = ""

    @staticmethod
    def read(get: Callable[[str, Any], Any]) -> "Settings":
        def text(key: str) -> str:
            v = get(key, "")
            return v.strip() if isinstance(v, str) else ""

        def items(key: str) -> List[str]:
            v = get(key, [])
            if isinstance(v, str):
                v = [x for x in re.split(r"[,\n]", v)]
            return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, (list, tuple)) else []

        mode = text("mode").lower()
        enabled = get("enabled", True)
        return Settings(
            enabled=enabled is not False, mode=mode if mode in ("advise", "enforce") else "advise",
            project_dirs=items("project_dirs"), gateway_url=norm_url(text("gateway_url")),
            repo=text("repo"), agent=text("agent"), trusted_gateways=items("trusted_gateways"),
            analyzer=text("analyzer"))


def _read_text(path: str, limit: int = 8192) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read(limit)
    except OSError:
        return None


class Links:
    """checkout root -> {url, repo, agent, token, source}, or None. Cached for a few seconds so
    the per-tool-call scope check is a dictionary hit, while a ``npx @celador/weft`` run in a
    checkout starts reporting within seconds."""

    def __init__(self, settings: Settings, secret: Callable[[str], Optional[str]], profile: str,
                 log: Callable[[str], None] = lambda _m: None, clock: Callable[[], float] = time.monotonic):
        self.settings = settings
        self.secret = secret
        self.profile = profile
        self.log = log
        self.clock = clock
        self._cache: Dict[str, Tuple[float, Optional[dict]]] = {}
        self._warned: set = set()

    def link(self, root: str) -> Optional[dict]:
        hit = self._cache.get(root)
        now = self.clock()
        if hit and now - hit[0] < LINK_TTL_S:
            return hit[1]
        if len(self._cache) > 512:
            self._cache.clear()
        out = self._from_checkout(root) or self._from_settings(root)
        self._cache[root] = (now, out)
        return out

    def _from_checkout(self, root: str) -> Optional[dict]:
        raw = _read_text(os.path.join(root, ".weft", "space.json"))
        if raw is None:
            return None
        try:
            meta = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(meta, dict):
            return None
        url, repo = norm_url(meta.get("url")), str(meta.get("repo") or "")
        token = (self.secret("WEFT_AGENT_TOKEN") or "").strip()
        agent = self.settings.agent or str(meta.get("agent") or "")
        if not (url and repo and token and _AGENT.match(agent)):
            return None
        if not is_trusted(url, self.settings.trusted_gateways):
            if root not in self._warned:
                self._warned.add(root)
                self.log(f"{root}: .weft/space.json names gateway {url}, which is not this machine, Weft's "
                         f"hosted gateway or a trusted gateway; not reporting (/weft trust {url} to allow)")
            return None
        return {"url": url, "repo": repo, "agent": agent, "token": token, "source": ".weft"}

    def _from_settings(self, root: str) -> Optional[dict]:
        s = self.settings
        if not (s.gateway_url and s.repo and s.project_dirs):
            return None
        if not any(root == d or root.startswith(d.rstrip(os.sep) + os.sep) for d in self._dirs()):
            return None
        token = (self.secret("WEFT_AGENT_TOKEN") or "").strip()
        if not token:
            return None
        return {"url": s.gateway_url, "repo": s.repo, "agent": s.agent or f"hermes-{self.profile}",
                "token": token, "source": "settings"}

    def _dirs(self) -> List[str]:
        return [os.path.realpath(os.path.expanduser(d)) for d in self.settings.project_dirs]


def default_secret(name: str) -> Optional[str]:
    """Hermes' profile-aware secret lookup (catalog rule 11); never reads files or os.environ itself."""
    try:
        from agent.secret_scope import get_secret  # documented plugin API
        return get_secret(name)
    except Exception:
        return None
