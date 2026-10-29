"""Tiny HTTP client for the local server, used by the CLI, the MCP server and the simulator."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlencode

from .config import Config


class ClientError(Exception):
    pass


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never route localhost via a proxy


class CoachClient:
    def __init__(self, cfg: Config | None = None, base_url: str | None = None, token: str | None = None, timeout: float = 5,
                 agent: bool = False):
        self.cfg = cfg or Config()
        self.base_url = (base_url or self.cfg.base_url).rstrip("/")
        self._token = token
        self.timeout = timeout
        self.agent = agent  # identifies the caller as a coaching agent (MCP), not a CLI user

    @property
    def token(self) -> str:
        tok = self._token or self.cfg.read_token()
        if not tok:
            raise ClientError(f"no API token at {self.cfg.token_file}; start the server once (justwatts serve) or set JUSTWATTS_TOKEN")
        return tok

    def request(self, method: str, path: str, body: Any = None, auth: bool = True) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if auth:
            req.add_header("Authorization", f"Bearer {self.token}")
            if self.agent:
                req.add_header("X-JustWatts-Client", "agent")
        try:
            with _OPENER.open(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("error")
            except Exception:  # noqa: BLE001
                detail = None
            raise ClientError(f"{method} {path}: HTTP {e.code} {detail or e.reason}") from None
        except (urllib.error.URLError, OSError) as e:
            raise ClientError(f"cannot reach {self.base_url} ({getattr(e, 'reason', e)}); is `justwatts serve` running?") from None

    # ---------- API ----------
    def health(self) -> dict:
        return self.request("GET", "/api/health", auth=False)

    def state(self) -> dict:
        return self.request("GET", "/api/state")

    def history(self, seconds: float = 300) -> list[dict]:
        return self.request("GET", "/api/state/history?" + urlencode({"seconds": seconds}))["samples"]

    def events(self, n: int = 50) -> list[dict]:
        return self.request("GET", "/api/events?" + urlencode({"n": n}))["events"]

    def commands(self, since: int = 0) -> list[dict]:
        return self.request("GET", f"/api/coach?since={int(since)}", auth=False)["cmds"]

    def coach(self, msg: str | None = None, step: int | str | None = None, watts: int | None = None,
              edit: dict | None = None, important: bool = False) -> dict:
        body: dict[str, Any] = {}
        if important:
            body["important"] = True
        if edit:
            body["edit"] = edit
        if msg:
            body["msg"] = msg
        if watts is not None:
            body["set"] = {"step": step if step is not None else "cur", "w": int(watts)}
        return self.request("POST", "/api/coach", body)

    def voice(self, event: str | None = None) -> dict:
        if event:
            return self.request("POST", "/api/voice", {"event": event})
        return self.request("GET", "/api/voice", auth=False)

    def agent_events(self, since: int = 0, wait: float = 0) -> dict:
        old = self.timeout
        self.timeout = max(old, wait + 10)
        try:
            return self.request("GET", f"/api/agent-events?since={int(since)}&wait={wait:g}")
        finally:
            self.timeout = old

    def report_usage(self, **usage) -> dict:
        return self.request("POST", "/api/agent-usage", usage)

    def event(self, line: str) -> None:
        self.request("POST", "/api/event", {"line": line})

    def post_state(self, state: dict) -> None:
        self.request("POST", "/api/state", state)

    def post_current(self, ride: dict) -> None:
        self.request("POST", "/api/current", ride)
