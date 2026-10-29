"""Strava on the integration framework: wraps StravaLink (OAuth, relay, upload + poll) unchanged."""
from __future__ import annotations

import re
import urllib.error

from ..strava import StravaError, StravaLink
from .base import AUTH, BLOCKED, DUPLICATE, TEMPORARY, Connector, IntegrationError, RideMeta, kind_for_status


def classify(msg: str) -> str:
    if "not connected" in msg or "set up your own" in msg or "OAuth" in msg:
        return AUTH
    m = re.search(r"\((\d{3})\)", msg)
    if m:
        code = int(m[1])
        if "token" in msg and code in (400, 401, 403):
            return AUTH  # refresh refused: the rider revoked access
        return kind_for_status(code)
    return TEMPORARY


class StravaConnector(Connector):
    id, name = "strava", "Strava"
    connect_kind = "oauth"
    connect_url = "/api/strava/connect"

    def __init__(self, link: StravaLink):
        self.link = link

    def status(self) -> dict:
        st = self.link.status()
        ath = st.get("athlete") or {}
        return {"connected": bool(st["connected"]), "configured": bool(st["configured"]), "account": ath.get("name") or None,
                "mode": st.get("mode")}

    def describe(self) -> dict:
        d = super().describe()
        d["connect"]["url"] = self.connect_url
        return d

    def connect(self, fields: dict) -> dict:
        return {"redirect": self.connect_url}

    def disconnect(self) -> None:
        self.link.disconnect()

    def secrets(self) -> list[str]:
        tok, app = self.link._read(self.link.token_file), self.link._read(self.link.app_file)
        return [str(v) for v in (tok.get("access_token"), tok.get("refresh_token"), app.get("client_secret")) if v]

    def upload(self, fit: bytes, meta: RideMeta) -> dict:
        try:
            res = self.link.upload(fit, meta.name, meta.description, meta.ride_id)
        except StravaError as e:
            raise IntegrationError(classify(str(e)), str(e)) from None
        except (urllib.error.URLError, OSError) as e:
            raise IntegrationError(TEMPORARY, f"network: {getattr(e, 'reason', e)}") from None
        aid = res.get("activity_id")
        url = f"https://www.strava.com/activities/{aid}" if aid else None
        if res.get("ok"):
            return {"activity_id": aid, "url": url, "duplicate": bool(res.get("duplicate"))}
        err = str(res.get("error") or "upload failed")
        if "still processing" in err:
            raise IntegrationError(TEMPORARY, err)
        raise IntegrationError(DUPLICATE if "duplicate" in err.lower() else BLOCKED, err)
