"""Garmin Connect on the integration framework: wraps GarminLink (python-garminconnect, local tokens).

Connect from the page: email + password go straight to Garmin through python-garminconnect, then the MFA
code if Garmin asks for one. Only the OAuth tokens it dumps are kept (the token dir, as with
`justwatts login-garmin`); the password is never written anywhere. The pending MFA login lives in memory
for 5 minutes.
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

from ..garmin import DISABLED_MSG
from .base import AUTH, BLOCKED, DUPLICATE, TEMPORARY, Connector, IntegrationError, RideMeta

MFA_TTL_S = 300


def classify(msg: str) -> str:
    low = msg.lower()
    if "409" in msg or "duplicate" in low:
        return DUPLICATE
    if "429" in msg or "too many" in low or "rate limit" in low:
        return TEMPORARY
    if re.search(r"\b401\b", msg) or "unauthor" in low or "authenticat" in low or "login" in low or "expired" in low:
        return AUTH
    if re.search(r"\b403\b", msg) or "forbidden" in low or "captcha" in low or "cloudflare" in low:
        return BLOCKED
    if re.search(r"\b4\d\d\b", msg) and not re.search(r"\b(408|425)\b", msg):
        return BLOCKED
    return TEMPORARY


class GarminConnector(Connector):
    id, name = "garmin", "Garmin Connect"
    official = False
    connect_kind = "fields"
    fields = [{"name": "email", "label": "Garmin email", "secret": False},
              {"name": "password", "label": "Garmin password", "secret": True, "help": "Sent to Garmin once, never stored"},
              {"name": "mfa_code", "label": "Code from Garmin", "secret": False, "step": "mfa"}]

    def __init__(self, link, rides: Path, enabled: bool = True, garmin_factory: Callable[..., Any] | None = None,
                 clock: Callable[[], float] = time.time):
        self.link = link  # GarminLink or a test fake with linked() / upload(path)
        self.rides = Path(rides)
        self.enabled = enabled
        self.factory = garmin_factory
        self.clock = clock
        self._pending: tuple[Any, Any, float] | None = None
        self._lock = threading.Lock()

    def status(self) -> dict:
        linked = bool(self.enabled and self.link.linked())
        return {"connected": linked, "enabled": self.enabled, "account": None,
                "mfa_pending": bool(self._pending and self.clock() - self._pending[2] < MFA_TTL_S)}

    def _garmin(self):
        if self.factory:
            return self.factory
        try:
            from garminconnect import Garmin
        except ImportError:
            raise IntegrationError(BLOCKED, "garminconnect not installed: pip install 'justwatts[garmin]'") from None
        return Garmin

    def connect(self, fields: dict) -> dict:
        if not self.enabled:
            raise IntegrationError(BLOCKED, DISABLED_MSG)
        code = str(fields.get("mfa_code") or "").strip()
        with self._lock:
            if code:
                p = self._pending
                if not p or self.clock() - p[2] >= MFA_TTL_S:
                    self._pending = None
                    raise IntegrationError(AUTH, "the sign-in timed out; enter your email and password again")
                g, state, _ = p
                try:
                    g.resume_login(state, code)
                except Exception as e:  # noqa: BLE001
                    raise IntegrationError(classify(str(e)) if "429" in str(e) else AUTH, f"Garmin refused the code: {e}"[:200]) from None
                self._pending = None
                return self._save(g)
            email, pw = str(fields.get("email") or "").strip(), str(fields.get("password") or "")
            if not email or not pw:
                raise IntegrationError(AUTH, "enter your Garmin email and password")
            Garmin = self._garmin()
            try:
                g = Garmin(email=email, password=pw, return_on_mfa=True)
                res = g.login()
            except IntegrationError:
                raise
            except Exception as e:  # noqa: BLE001
                k = classify(str(e))
                raise IntegrationError(AUTH if k in (DUPLICATE, BLOCKED) and "403" not in str(e) else k,
                                       f"Garmin sign-in failed: {e}"[:200]) from None
            if isinstance(res, tuple) and res and res[0] == "needs_mfa":
                self._pending = (g, res[1], self.clock())
                return {"mfa_required": True}
            return self._save(g)

    def _save(self, g) -> dict:
        tokens = Path(self.link.tokens)
        tokens.mkdir(parents=True, exist_ok=True)
        dumper = getattr(g, "client", None) or getattr(g, "garth", None)  # as `justwatts login-garmin` does
        dumper.dump(str(tokens))
        if hasattr(self.link, "reset"):
            self.link.reset()
        return {"connected": True}

    def disconnect(self) -> None:
        tokens = Path(getattr(self.link, "tokens", "") or "")
        if tokens.name and tokens.is_dir():
            for f in tokens.glob("*.json"):  # whatever token files python-garminconnect wrote
                f.unlink(missing_ok=True)
        if hasattr(self.link, "reset"):
            self.link.reset()

    def upload(self, fit: bytes, meta: RideMeta) -> dict:
        if not self.enabled:
            raise IntegrationError(BLOCKED, DISABLED_MSG)
        if not self.link.linked():
            raise IntegrationError(AUTH, "not signed in to Garmin")
        from ..server import atomic_write  # FIT always kept locally (as before)
        path = self.rides / meta.filename
        atomic_write(path, fit)
        res = self.link.upload(path) or {}
        if res.get("disabled"):
            raise IntegrationError(BLOCKED, str(res.get("error") or DISABLED_MSG))
        if not res.get("ok"):
            err = str(res.get("error") or "upload failed")
            raise IntegrationError(classify(err), err)
        aid = res.get("activityId")
        return {"activity_id": aid, "duplicate": bool(res.get("duplicate")),
                "url": f"https://connect.garmin.com/modern/activity/{aid}" if aid else None}
