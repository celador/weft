"""Weft for Hermes: edit-time coordination between coding agents.

Hooks report every edit to a Weft gateway and put Weft's diagnostics back into the agent's run
(``adapter.py``); the tools ``weft_status`` / ``weft_inbox`` and the ``/weft`` command (``surface.py``)
let the agent and the person ask where things stand; the Desktop pane (``desktop/plugin.js``, fed
by ``dashboard/plugin_api.py``) shows the live feed.

Nothing is reported until a checkout is linked and its agent token is saved in Hermes: ``/weft setup`` (or
``npx @celador/weft``) writes ``.weft/`` into it; see README.md for exactly what is read, sent and run.
Dev installs made by ``scripts/install.py`` use the multi-project config that script manages.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Optional

from . import surface, worktrees
from .adapter import _setting, configure, current_profile, get_adapter, shutdown


def _pre_tool_call(**kwargs: Any) -> Optional[dict]:
    adapter = get_adapter()
    return adapter.pre_tool_call(**kwargs) if adapter else None


def _post_tool_call(**kwargs: Any) -> None:
    adapter = get_adapter()
    if adapter:
        adapter.post_tool_call(**kwargs)


def _transform_tool_result(**kwargs: Any) -> Optional[str]:
    adapter = get_adapter()
    return adapter.transform_tool_result(**kwargs) if adapter else None


def _pre_verify(**kwargs: Any) -> Optional[dict]:
    adapter = get_adapter()
    return adapter.pre_verify(**kwargs) if adapter else None


def _session_start(**kwargs: Any) -> None:
    adapter = get_adapter()
    if adapter:
        adapter.session_started(**kwargs)


def _flush(**kwargs: Any) -> None:
    """End of a turn / session: give this session's deferred (advise) submissions a bounded
    chance to land. Kanban workers may leave via ``os._exit``, which skips atexit. (``hermes chat``
    turns, ``-q``/``-Q`` included, run inside the long-lived gateway process, not the CLI process.)"""
    adapter = get_adapter()
    if adapter:
        adapter.flush(3.0, kw=kwargs)


def _finalize(**kwargs: Any) -> None:
    """The session closed for good: flush, then close its WCP sessions (bye)."""
    adapter = get_adapter()
    if adapter:
        adapter.flush(3.0, kw=kwargs)
        adapter.session_finalized(**kwargs)


def _log(message: str) -> None:
    path = Path(os.environ.get("WEFT_HERMES_CACHE", "~/.cache/weft-hermes")).expanduser() / f"{current_profile()}.log"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{current_profile()}] {message}\n")
    except Exception:
        pass


def _worker_spawned(**kwargs: Any) -> None:
    """A kanban worker started in its workspace: join that worktree to the Claude Code adapter of
    its main checkout (worktrees.py), so Claude Code sessions there report as the kanban task."""
    if _setting("enabled", True) is False or _setting("join_worktrees", True) is False:
        return
    worktrees.on_worker_spawned(_log, **kwargs)


def register(ctx: Any) -> None:
    configure(get_config=ctx.get_config)  # settings (mode, trusted gateways, ...); secrets via agent.secret_scope
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("transform_tool_result", _transform_tool_result)
    ctx.register_hook("pre_verify", _pre_verify)
    ctx.register_hook("on_session_start", _session_start)
    ctx.register_hook("on_session_end", _flush)
    ctx.register_hook("on_session_finalize", _finalize)
    ctx.register_hook("on_kanban_worker_spawned", _worker_spawned)
    for tool in surface.make_tools(get_adapter):
        ctx.register_tool(**tool)
    ctx.register_command(
        "weft", surface.make_command(get_adapter, ctx.set_config, ctx.get_config),
        description="Weft edit-time coordination: status, setup, feed, mode", args_hint="[status|setup|feed|mode|trust|help]")
    on_unload = getattr(ctx, "on_unload", None)  # Hermes reload-plugins: close the old router
    if callable(on_unload):
        on_unload(shutdown)
