"""Tiny HTTP client for the local server, used by the CLI."""
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


class Client:
    def __init__(self, cfg: Config | None = None, base_url: str | None = None, token: str | None = None, timeout: float = 5):
        self.cfg = cfg or Config()
        self.base_url = (base_url or self.cfg.base_url).rstrip("/")
        self._token = token
        self.timeout = timeout

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

    def events(self, n: int = 50) -> list[dict]:
        return self.request("GET", "/api/events?" + urlencode({"n": n}))["events"]

    def control(self, action: str, **body) -> dict:
        return self.request("POST", "/api/ride/control", {"action": action, **body})

    def devices(self, **body) -> dict:
        return self.request("POST", "/api/devices", body)
