"""Weft for Hermes: edit-time coordination between coding agents.

Hooks report every edit to a Weft gateway and put Weft's diagnostics back into the agent's run
(``adapter.py``); the tools ``weft_status`` / ``weft_inbox`` and the ``/weft`` command (``surface.py``)
let the agent and the person ask where things stand; the Desktop pane (``desktop/plugin.js``, fed
by ``dashboard/plugin_api.py``) shows the live feed.

Nothing is reported until a checkout is linked to a gateway: ``/weft setup`` (or
``npx @celador/weft``) writes ``.weft/`` into it; see README.md for exactly what is read, sent and run.
Dev installs made by ``scripts/install.py`` use the multi-project config that script manages.
"""

from __future__ import annotations

from typing import Any, Optional

from . import surface
from .adapter import configure, get_adapter, shutdown


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


def _flush(**_: Any) -> None:
    """End of a turn / session: give deferred (advise) submissions a bounded chance to land.
    Kanban workers may leave via ``os._exit``, which skips atexit. (``hermes chat`` turns,
    ``-q``/``-Q`` included, run inside the long-lived gateway process, not the CLI process.)"""
    adapter = get_adapter()
    if adapter:
        adapter.flush(3.0)


def register(ctx: Any) -> None:
    configure(get_config=ctx.get_config)  # settings (mode, trusted gateways, ...); secrets via agent.secret_scope
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("transform_tool_result", _transform_tool_result)
    ctx.register_hook("pre_verify", _pre_verify)
    ctx.register_hook("on_session_end", _flush)
    ctx.register_hook("on_session_finalize", _flush)
    for tool in surface.make_tools(get_adapter):
        ctx.register_tool(**tool)
    ctx.register_command(
        "weft", surface.make_command(get_adapter, ctx.set_config, ctx.get_config),
        description="Weft edit-time coordination: status, setup, feed, mode", args_hint="[status|setup|feed|mode|trust|help]")
    on_unload = getattr(ctx, "on_unload", None)  # Hermes reload-plugins: close the old router
    if callable(on_unload):
        on_unload(shutdown)
