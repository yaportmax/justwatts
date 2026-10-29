"""intervals.icu through its official API: the rider pastes their athlete id and API key (Settings, Developer).

Docs: https://forum.intervals.icu/t/api-access-to-intervals-icu/609 and the OpenAPI spec at
https://intervals.icu/api/v1/docs. Basic auth, user "API_KEY", the key as password.
Upload: POST /api/v1/athlete/{id}/activities (multipart "file"); 201 = created, 200 = all duplicates.
Planned: GET /api/v1/athlete/{id}/events?category=WORKOUT&resolve=true; workout_doc -> workout text
(https://forum.intervals.icu/t/downloading-planned-workouts-from-the-api/93737).
"""
from __future__ import annotations

import base64
import re
import urllib.parse
from pathlib import Path

from . import importing as I
from . import planned as P
from .base import (AUTH, BLOCKED, TEMPORARY, Connector, IntegrationError, Resp, RideMeta, SecretFile, http,
                   kind_for_status, multipart, retry_after)

BASE = "https://intervals.icu/api/v1"
# intervals.icu sits behind Cloudflare, which may challenge bare script user agents (forum advice)
UA = "Mozilla/5.0 (compatible; JustWatts/0.1; +https://justwatts.com)"
ATHLETE_RE = re.compile(r"^(i?\d{1,12}|0)$")
RIDE_TYPES = ("Ride", "VirtualRide", "MountainBikeRide", "GravelRide", None, "")


class IntervalsConnector(Connector):
    id, name = "intervals", "intervals.icu"
    planned_workouts = True
    imports = True
    fields = [{"name": "athlete_id", "label": "Athlete ID", "secret": False, "help": "Settings, Developer Settings, e.g. i12345"},
              {"name": "api_key", "label": "API key", "secret": True, "help": "Settings, Developer Settings"}]

    def __init__(self, idir: Path, http=http):
        self.file = SecretFile(Path(idir) / "intervals.json")
        self.http = http

    def status(self) -> dict:
        s = self.file.read()
        return {"connected": bool(s.get("api_key")), "account": s.get("name") or None,
                "athlete_id": s.get("athlete_id") or None}

    def secrets(self) -> list[str]:
        k = self.file.read().get("api_key")
        return [k, base64.b64encode(f"API_KEY:{k}".encode()).decode()] if k else []

    def _call(self, method: str, path: str, key: str, data: bytes | None = None, headers: dict | None = None) -> Resp:
        auth = base64.b64encode(f"API_KEY:{key}".encode()).decode()
        r = self.http(method, BASE + path, data, {"Authorization": f"Basic {auth}", "Accept": "application/json",
                                                   "User-Agent": UA, **(headers or {})})
        if r.status < 300:
            return r
        kind = kind_for_status(r.status)
        if r.status == 403:  # a Cloudflare challenge is HTML; intervals.icu's own refusal is JSON (wrong id/key)
            html = "html" in r.headers.get("content-type", "") or r.body.lstrip()[:1] == b"<"
            kind = BLOCKED if html else AUTH
        msg = {AUTH: "intervals.icu refused the athlete id or API key", BLOCKED: f"intervals.icu refused the request ({r.status})",
               TEMPORARY: f"intervals.icu is busy or down ({r.status})"}.get(kind, f"intervals.icu said {r.status}")
        raise IntegrationError(kind, msg, retry_after(r.headers))

    def _creds(self) -> tuple[str, str]:
        s = self.file.read()
        if not s.get("api_key"):
            raise IntegrationError(AUTH, "intervals.icu not connected")
        return s["athlete_id"], s["api_key"]

    def connect(self, fields: dict) -> dict:
        aid = str(fields.get("athlete_id") or "").strip()
        key = str(fields.get("api_key") or "").strip()
        if not ATHLETE_RE.match(aid) or not re.fullmatch(r"[\w\-]{8,128}", key):
            raise IntegrationError(AUTH, "paste the athlete id (like i12345) and API key from intervals.icu Settings")
        body = self._call("GET", f"/athlete/{urllib.parse.quote(aid)}", key).json() or {}
        aid = str(body.get("id") or aid)
        self.file.write({"athlete_id": aid, "api_key": key, "name": str(body.get("name") or "")[:80]})
        return {"connected": True, **self.status()}

    def disconnect(self) -> None:
        self.file.clear()

    def upload(self, fit: bytes, meta: RideMeta) -> dict:
        aid, key = self._creds()
        q = urllib.parse.urlencode({"name": meta.name, "description": meta.description, "external_id": meta.ride_id})
        data, ctype = multipart({}, "file", meta.filename or "ride.fit", fit)
        r = self._call("POST", f"/athlete/{urllib.parse.quote(aid)}/activities?{q}", key, data, {"Content-Type": ctype})
        body = r.json()
        acts = body.get("activities") if isinstance(body, dict) else body if isinstance(body, list) else None
        first = acts[0] if acts else (body if isinstance(body, dict) else {})
        act = (first or {}).get("id")
        return {"activity_id": act, "url": f"https://intervals.icu/activities/{act}" if act else None,
                "duplicate": r.status == 200}

    def import_profile(self) -> dict:
        aid, key = self._creds()
        try:
            piece = {"ok": True, "json": self._call("GET", f"/athlete/{urllib.parse.quote(aid)}", key).json()}
        except IntegrationError as e:
            if e.kind == AUTH:
                raise
            piece = {"ok": False, "error": str(e)}
        return I.intervals_profile({"athlete": piece})

    def import_list(self, since: str, until: str, start: int = 0) -> dict:
        aid, key = self._creds()
        q = urllib.parse.urlencode({"oldest": since, "newest": until})
        raw = self._call("GET", f"/athlete/{urllib.parse.quote(aid)}/activities?{q}", key).json()
        raw = raw if isinstance(raw, list) else []
        items = [x for x in (I.intervals_activity(a) for a in raw) if x]
        return {"items": items, "skipped": len(raw) - len(items), "more": False, "next": len(raw)}

    def import_fit(self, activity_id: str) -> bytes:
        if not re.fullmatch(r"i?\d{1,20}", str(activity_id)):
            raise IntegrationError(BLOCKED, "bad activity id")
        _, key = self._creds()
        r = self._call("GET", f"/activity/{urllib.parse.quote(str(activity_id))}/fit-file", key, None, {"Accept": "*/*"})
        try:
            return I.fit_from_zip(r.body)
        except ValueError as e:
            raise IntegrationError(BLOCKED, f"intervals.icu file: {e}") from None

    def planned(self, day: str) -> list[dict]:
        aid, key = self._creds()
        q = urllib.parse.urlencode({"oldest": day, "newest": day, "category": "WORKOUT", "resolve": "true"})
        events = self._call("GET", f"/athlete/{urllib.parse.quote(aid)}/events?{q}", key).json() or []
        out = []
        for ev in events if isinstance(events, list) else []:
            if not isinstance(ev, dict) or ev.get("category") not in (None, "WORKOUT") or ev.get("type") not in RIDE_TYPES:
                continue
            text = P.from_intervals(ev.get("workout_doc")) or P.free_for(ev.get("moving_time"))
            if not text:
                continue
            out.append({"id": str(ev.get("id")), "name": str(ev.get("name") or "Planned ride")[:120],
                        "date": str(ev.get("start_date_local") or day)[:10], "text": text,
                        "duration_s": (ev.get("workout_doc") or {}).get("duration") or ev.get("moving_time"),
                        "description": str(ev.get("description") or "")[:2000],
                        "structured": bool((ev.get("workout_doc") or {}).get("steps"))})
        return out
