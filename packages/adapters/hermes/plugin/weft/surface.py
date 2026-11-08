"""What the agent and the user can ask Weft: tools ``weft_status`` / ``weft_inbox``, and ``/weft``.

The hooks (``adapter.py``) do the coordinating: every edit is reported and Weft's diagnostics ride
in the tool results. This module is the part you can *talk to*:

- ``weft_status`` (tool): where this checkout stands: open conflicts, recent edits and verdicts,
  other agents live in the same repo.
- ``weft_inbox`` (tool): fetch what other agents sent since the last look and acknowledge it.
- ``/weft`` (slash command, for the person): ``status`` | ``setup [local|hosted]`` | ``feed`` |
  ``mode [advise|enforce]`` | ``trust <gateway url>`` | ``help``.

Everything here is a read of the adapter's state except ``setup``/``feed`` (which run the pinned
Weft CLI, see cli.py) and ``mode``/``trust`` (which write this plugin's own settings).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Dict, List, Optional

try:  # package import inside Hermes; flat import in tests
    from . import adapter as _adapter, cli, status, standalone
except ImportError:  # pragma: no cover
    import adapter as _adapter, cli, status, standalone  # type: ignore

MAX_TOOL_CHARS = 6000

STATUS_SCHEMA = {
    "name": "weft_status",
    "description": (
        "Weft edit-time coordination: show where this checkout stands against other coding agents "
        "working in the same repository: open conflicts (symbols another agent changed that your "
        "edits depend on or overwrite), your recent edits and Weft's verdicts, and which other agents "
        "are live. Call it when an edit result mentions [weft], before finishing a task that touched "
        "shared code, or to check whether anyone else is editing the file you are about to change."),
    "parameters": {"type": "object", "properties": {}, "required": []},
}
INBOX_SCHEMA = {
    "name": "weft_inbox",
    "description": (
        "Weft: fetch what other agents sent you since the last look: changes to code your work "
        "depends on, negotiation messages, trunk updates. Returns the text Weft would inject into "
        "your next tool result, and marks it read. Use it to resync before a risky edit."),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

HELP = (
    "/weft: edit-time coordination for coding agents\n"
    "  /weft              where this checkout stands (conflicts, recent edits, other agents)\n"
    "  /weft setup        link this repo to a local Weft gateway (runs `npx @celador/weft@%s`)\n"
    "  /weft setup hosted use Weft's hosted gateway instead (your edits are sent to weft-hosted.elier.ai)\n"
    "  /weft feed         live feed address + one-time pairing code\n"
    "  /weft mode [advise|enforce]   advise never blocks; enforce blocks conflicting edits\n"
    "  /weft trust <url>  allow a gateway you run yourself (checkouts may only name trusted gateways)\n" % cli.CLI_VERSION)


# ----------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------

def _ago(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s}s ago" if s < 90 else f"{s // 60}m ago" if s < 5400 else f"{s // 3600}h ago"


def _diag_line(d: Dict[str, Any]) -> str:
    by = f" (changed by {d['by']})" if d.get("by") else ""
    sym = d.get("symbol") or d.get("file") or "?"
    msg = (d.get("message") or "").strip().replace("\n", " ")
    return f"{d.get('severity', 'info')} {d.get('code', '')} {sym}{by}: {msg[:240]}"


def _event_line(e: Dict[str, Any], now: float) -> str:
    when = _ago(now - float(e.get("t") or now))
    kind = e.get("kind")
    if kind in ("edit", "check"):
        where = ", ".join(e.get("keys") or e.get("files") or [])[:160]
        word = {"accept": "accepted", "warn": "accepted with warnings", "reject": "REJECTED"}.get(e.get("verdict"), "")
        return f"{when}: edit {where} -> {word}" + (" (blocked before it was written)" if kind == "check" else "")
    if kind == "inbox":
        return f"{when}: {e.get('count', 0)} update(s) from other agents ({', '.join(e.get('items') or [])})"
    if kind == "gate":
        return f"{when}: {e.get('gate')} refused: {e.get('reason', '')[:160]}"
    if kind == "commit":
        return f"{when}: commit {e.get('sha', '')}"
    if kind == "release":
        return f"{when}: released {', '.join(e.get('keys') or [])}"
    return f"{when}: {kind}"


def _clip(text: str) -> str:
    return text if len(text) <= MAX_TOOL_CHARS else text[: MAX_TOOL_CHARS - 20] + "\n…(truncated)"


def current_dir(task_id: Any = "") -> str:
    try:
        from agent.runtime_cwd import resolve_agent_cwd  # documented for slash-command handlers
        return str(resolve_agent_cwd())
    except Exception:
        return _adapter.base_dir(task_id)


def others_for(me: Dict[str, Any], snaps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Live snapshots of other agents reporting to the same repo on the same gateway."""
    out = []
    for s in snaps:
        if not s.get("live") or s.get("change") == me.get("change"):
            continue
        if s.get("repo") == me.get("repo") and standalone.norm_url(s.get("url")) == standalone.norm_url(me.get("url")):
            out.append(s)
    return out


# ----------------------------------------------------------------------------------------------
# status
# ----------------------------------------------------------------------------------------------

def status_data(router: Any, directory: str, refresh: bool = True) -> Dict[str, Any]:
    """The structured answer behind ``weft_status`` and ``/weft``."""
    now = time.time()
    adapter = router.adapter_at(directory) if router else None
    if adapter is None:
        snaps = status.read_all()
        return {"linked": False, "checkout": directory,
                "live_agents": [{"agent": s.get("agent"), "repo": s.get("repo"), "checkout": s.get("worktree")}
                                for s in snaps if s.get("live")][:8]}
    if refresh:
        try:
            adapter.ensure_session()   # proves the gateway is reachable (a status query is not an edit)
            adapter.refresh_open()
        except Exception:
            adapter.rec.set_reachable(False)
    snap = adapter.rec.snapshot()
    snap["live"] = True
    others = others_for(snap, status.read_all())
    return {
        "linked": True, "checkout": snap.get("worktree") or directory, "repo": snap.get("repo"),
        "agent": snap.get("agent"), "change": snap.get("change"), "mode": snap.get("mode"),
        "gateway": {"url": snap.get("url"), "kind": snap.get("kind"), "reachable": snap.get("reachable"),
                    "session": snap.get("session")},
        "counters": snap.get("counters"), "open_conflicts": snap.get("open"),
        "recent": snap.get("events", [])[-8:][::-1],
        "other_agents": [{"agent": o.get("agent"), "change": o.get("change"), "checkout": o.get("worktree"),
                          "active": _ago(o.get("age_s") or 0), "open_conflicts": len(o.get("open") or [])}
                         for o in others],
        "analysis": "declaration-level" if adapter.analyzer.script else "python declarations, whole-file keys elsewhere",
        "now": now,
    }


def status_text(data: Dict[str, Any]) -> str:
    if not data.get("linked"):
        lines = [f"Weft is not set up for {data.get('checkout')}.",
                 "  /weft setup    link this repo to a local Weft gateway (nothing leaves this machine)"]
        live = data.get("live_agents") or []
        if live:
            lines.append("Weft is live for: " + ", ".join(f"{a['agent']} ({a['repo']})" for a in live))
        return "\n".join(lines)
    g = data["gateway"]
    where = {"local": "local gateway", "hosted": "hosted gateway", "own": "your gateway"}.get(g.get("kind"), "gateway")
    reach = {True: "connected", False: "UNREACHABLE (edits proceed unchecked)", None: "not contacted yet"}[g.get("reachable")]
    c = data.get("counters") or {}
    lines = [f"Weft · {data['mode']} mode · {where} · {reach}",
             f"checkout {data['checkout']}  (repo {data['repo']}, agent {data['agent']})",
             f"this session: {c.get('edits', 0)} edit(s): {c.get('accepted', 0)} clean, {c.get('warned', 0)} with warnings, "
             f"{c.get('rejected', 0)} rejected"]
    open_ = data.get("open_conflicts") or []
    if open_:
        lines.append(f"open conflicts ({len(open_)}):")
        lines += [f"  ✕ {_diag_line(d)}" for d in open_[:6]]
    else:
        lines.append("open conflicts: none")
    others = data.get("other_agents") or []
    lines.append("other agents here: " + (", ".join(f"{o['agent']} ({o['active']})" for o in others) if others else "none live"))
    recent = data.get("recent") or []
    if recent:
        lines.append("recent:")
        now = data.get("now") or time.time()
        lines += [f"  {_event_line(e, now)}" for e in recent[:5]]
    lines.append(f"analysis: {data.get('analysis')}")
    return "\n".join(lines)


# ----------------------------------------------------------------------------------------------
# tools
# ----------------------------------------------------------------------------------------------

def make_tools(get_router: Callable[[], Any]) -> List[Dict[str, Any]]:
    def relevant() -> bool:
        router = get_router()
        if router is None:
            return False
        try:
            return bool(router._live()) or router.adapter_at(_adapter.base_dir("")) is not None
        except Exception:
            return False

    def weft_status(args: Optional[dict] = None, **kw: Any) -> str:
        try:
            data = status_data(get_router(), _adapter.base_dir(kw.get("task_id") or ""))
            data["summary"] = status_text(data)
            return json.dumps(data, ensure_ascii=False, default=str)
        except Exception as err:
            return json.dumps({"error": f"weft_status failed: {err}"})

    def weft_inbox(args: Optional[dict] = None, **kw: Any) -> str:
        try:
            router = get_router()
            adapter = router.adapter_at(_adapter.base_dir(kw.get("task_id") or "")) if router else None
            if adapter is None:
                return json.dumps({"linked": False, "message": "Weft is not set up for this checkout (the user can run /weft setup)."})
            text = adapter.inbox_now()
            return json.dumps({"linked": True, "messages": text or "", "empty": not text})
        except Exception as err:
            return json.dumps({"error": f"weft_inbox failed: {err}"})

    return [
        {"name": "weft_status", "toolset": "weft", "schema": STATUS_SCHEMA, "handler": weft_status,
         "check_fn": relevant, "description": "Weft: this checkout's conflicts, recent edits, other live agents", "emoji": "🧵"},
        {"name": "weft_inbox", "toolset": "weft", "schema": INBOX_SCHEMA, "handler": weft_inbox,
         "check_fn": relevant, "description": "Weft: fetch updates from other agents", "emoji": "📬"},
    ]


# ----------------------------------------------------------------------------------------------
# /weft
# ----------------------------------------------------------------------------------------------

def make_command(get_router: Callable[[], Any], set_config: Callable[[str, Any], None],
                 get_config: Callable[[str, Any], Any]) -> Callable[..., str]:
    def handler(raw_args: str = "", **kw: Any) -> str:
        parts = (raw_args or "").strip().split()
        sub = parts[0].lower() if parts else "status"
        directory = current_dir(kw.get("session_id") or "")
        router = get_router()
        if sub in ("status", "st", ""):
            return status_text(status_data(router, directory))
        if sub == "help":
            return HELP
        if sub == "setup":
            return _setup(directory, hosted=(len(parts) > 1 and parts[1].lower() == "hosted"))
        if sub in ("feed", "open", "pair"):
            return _feed(directory)
        if sub == "mode":
            if len(parts) < 2 or parts[1].lower() not in ("advise", "enforce"):
                cur = (router.cfg.default_mode if router else None) or get_config("mode", "advise")
                return f"mode: {cur}  (advise never blocks; enforce blocks conflicting edits)\nusage: /weft mode advise|enforce"
            mode = parts[1].lower()
            set_config("mode", mode)
            if router:
                router.set_mode(mode)
            return f"Weft mode: {mode}" + ("  (conflicting edits are blocked before they are written)" if mode == "enforce"
                                           else "  (never blocks; diagnostics arrive with tool results)")
        if sub == "trust":
            if len(parts) < 2 or not parts[1].startswith(("https://", "http://")):
                return "usage: /weft trust <https://your-gateway>   (a gateway you run: `npx @celador/weft deploy`)"
            url = standalone.norm_url(parts[1])
            have = list(get_config("trusted_gateways", []) or [])
            if url not in have:
                set_config("trusted_gateways", have + [url])
            if router:
                router._loaded_at = float("-inf")
                router._reload()
            return f"Trusted {url}: checkouts that name it may report there."
        return HELP

    return handler


def _setup(directory: str, hosted: bool) -> str:
    rc, out = cli.run(["--yes", "--no-open", "--harness", "watcher", *(["--hosted"] if hosted else ["--local"])], directory,
                      timeout=cli.SETUP_TIMEOUT_S)
    lines = [ln for ln in out.splitlines() if ln.strip()]
    keep = [ln for ln in lines if ln.lstrip().startswith(("✓", "·", "Live feed", "http", "pairing code", "more devices"))
            or "error" in ln.lower() or "not a git" in ln.lower()]
    if rc != 0:
        return "Weft setup failed (exit %s):\n%s" % (rc, "\n".join((keep or lines)[-12:]))
    return ("Weft gateway is set up. Configure the agent token in Hermes before reporting begins.\n"
            + "\n".join(keep[-14:])
            + "\nIn Hermes Settings → Plugins → Weft, set Agent token from this checkout’s .weft/token. "
            "The plugin never reads that credential file. For paired checkouts using the same token, set Agent id "
            "to the agent in the first checkout’s .weft/space.json. /weft mode enforce blocks conflicting edits.")


def _feed(directory: str) -> str:
    rc, out = cli.run(["pair"], directory)
    feed = cli.parse_feed(out)
    if rc != 0 or not feed["url"]:
        return "Could not get the feed address (run /weft setup first):\n" + "\n".join(out.splitlines()[-6:])
    return f"Live feed: {feed['url']}\npairing code: {feed['code']} (one use, 10 minutes)"
