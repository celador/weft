"""Minimal WCP v0.1 HTTP client (stdlib only; runs inside the Hermes Python process).

Spec: docs/protocol/wcp-v0.md (§2 transport, §8.2 session lifecycle, §11 errors).
Every call has a short timeout because Hermes bounds ``pre_tool_call`` hooks and fails
*closed* on timeout; the adapter itself fails *open* on any WcpError it gets from here.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

PROTOCOL = "wcp/0.1"
WCP_VERSION = "0.1"


class WcpError(Exception):
    """A protocol error (§11) or a transport failure (code ``transport``)."""

    def __init__(self, code: str, message: str, status: int = 0, details: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


class CircuitBreaker:
    """Fail fast while the gateway is unreachable: a dead or slow gateway costs at most one
    timeout per ``cooldown`` seconds (shared by every repo session of the process).

    Closed -> a transport failure / 5xx opens it for ``cooldown`` s; every call in that window
    raises ``WcpError("circuit_open")`` without touching the network. After the window ONE
    trial call goes through (the window is re-armed first, so concurrent callers keep failing
    fast); success closes the breaker, failure keeps it open for another window.
    """

    def __init__(self, cooldown: float = 300.0, clock: Callable[[], float] = time.monotonic):
        self.cooldown = cooldown
        self.clock = clock
        self.open_until = 0.0
        self.failures = 0
        self.lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        return self.open_until > self.clock()

    def before(self) -> None:
        with self.lock:
            if not self.failures:
                return
            now = self.clock()
            if now < self.open_until:
                raise WcpError("circuit_open", f"gateway unreachable; retrying in {int(self.open_until - now)}s")
            self.open_until = now + self.cooldown  # half-open: this caller is the trial

    def success(self) -> None:
        with self.lock:
            self.failures, self.open_until = 0, 0.0

    def failure(self) -> None:
        with self.lock:
            self.failures += 1
            self.open_until = self.clock() + self.cooldown


_BREAKERS: Dict[str, CircuitBreaker] = {}
_BREAKERS_LOCK = threading.Lock()


def breaker_for(base_url: str, cooldown: float = 300.0) -> CircuitBreaker:
    with _BREAKERS_LOCK:
        b = _BREAKERS.get(base_url)
        if b is None:
            b = _BREAKERS[base_url] = CircuitBreaker(cooldown)
        return b


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward a repo-scoped credential or edit diff through a gateway redirect."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class WcpClient:
    def __init__(self, base_url: str, token: str, repo: str, timeout: float = 4.0,
                 breaker: Optional[CircuitBreaker] = None, breaker_cooldown: float = 300.0):
        self.base = base_url.rstrip("/")
        if not self.base.endswith("/v1"):
            self.base += "/v1"
        self.token = token
        self.repo = repo
        self.timeout = timeout
        self.breaker = breaker or breaker_for(self.base, breaker_cooldown)

    # -- transport -------------------------------------------------------------------------

    def _request(self, method: str, path: str, body: Any = None,
                 headers: Optional[Dict[str, str]] = None) -> Any:
        self.breaker.before()
        try:
            out = self._send(method, path, body, headers)
        except WcpError as err:
            if err.code == "transport" or err.status >= 500:
                self.breaker.failure()
            else:
                self.breaker.success()  # the gateway answered: it is up
            raise
        self.breaker.success()
        return out

    def _send(self, method: str, path: str, body: Any = None,
              headers: Optional[Dict[str, str]] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("WCP-Version", WCP_VERSION)
        req.add_header("User-Agent", "weft-hermes-adapter/0.1")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.build_opener(NoRedirect()).open(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read() or b"{}")
            except Exception:
                payload = {}
            finally:
                err.close()
            e = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(e, dict):
                raise WcpError(str(e.get("code", "http")), str(e.get("message", "")), err.code,
                               e.get("details") if isinstance(e.get("details"), dict) else None)
            raise WcpError("http", f"HTTP {err.code}", err.code)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
            raise WcpError("transport", str(err))

    def _session_path(self, session: str, suffix: str = "") -> str:
        return f"/repos/{self.repo}/sessions/{session}{suffix}"

    # -- session lifecycle (§8.2) ---------------------------------------------------------

    def hello(self, agent: dict, capabilities: dict, task: Optional[dict] = None,
              change: Optional[str] = None, resume_session: Optional[str] = None) -> dict:
        body: Dict[str, Any] = {"type": "hello", "protocol": PROTOCOL, "agent": agent,
                                "capabilities": capabilities}
        if task:
            body["task"] = task
        if change:
            body["change"] = change
        if resume_session:
            body["resume_session"] = resume_session
        return self._request("POST", f"/repos/{self.repo}/sessions", body)

    def submit(self, session: str, mode: str, event: dict, inbox_ack: Optional[int] = None,
               idempotency_key: Optional[str] = None) -> dict:
        body: Dict[str, Any] = {"type": "submit", "mode": mode, "event": event}
        if inbox_ack:
            body["inbox_ack"] = inbox_ack
        headers = {"Idempotency-Key": idempotency_key[:128]} if idempotency_key else None
        return self._request("POST", self._session_path(session, "/events"), body, headers)

    def drain(self, session: str, ack: Optional[int] = None) -> dict:
        body: Dict[str, Any] = {"type": "inbox.drain"}
        if ack:
            body["ack"] = ack
        return self._request("POST", self._session_path(session, "/inbox"), body)

    def event(self, seq: int) -> dict:
        """One event of this client's repo (§9.3 observer read; needs the ``observe`` scope, which
        space agent tokens carry). Used to quote the change behind a diagnostic."""
        return self._request("GET", f"/repos/{self.repo}/events/{int(seq)}")

    def heartbeat(self, session: str) -> dict:
        return self._request("POST", self._session_path(session, "/heartbeat"), {"type": "heartbeat"})

    def gate(self, session: str, gate: str) -> dict:
        return self._request("POST", self._session_path(session, "/gate"), {"type": "gate", "gate": gate})

    def bye(self, session: str, reason: str = "") -> None:
        body = {"type": "bye", "reason": reason} if reason else {"type": "bye"}
        self._request("DELETE", self._session_path(session), body)
