"""TrainingPeaks through the web app's own API (unofficial; TrainingPeaks has no open API for riders).

The rider pastes the value of their Production_tpAuth cookie from app.trainingpeaks.com once. It is swapped
for a 1 hour bearer token whenever one is needed; the cookie itself lasts weeks and dies on logout, then
every call fails with `auth` and the page asks for a fresh cookie.

Endpoints and payloads from community clients (pinned commits; no official docs exist):
- token: GET https://tpapi.trainingpeaks.com/users/v3/token with the cookie -> {success, token: {access_token,
  expires_in}}; 401 when the cookie is dead. JamsusMaximus/trainingpeaks-mcp src/tp_mcp/client/http.py L200-265
  (a412a84), holdenstirling/garmin-mcp src/garmin_mcp/trainingpeaks.py L282-297 (5178e8c),
  nagelflorian/trainingpeaks-mcp-server src/auth.ts L54-77 (f1ec1f3).
- athlete: GET /users/v3/user -> user.personId (coach accounts list other athletes first, so personId wins),
  then athletes[] by personId, then userId. trainingpeaks-mcp src/tp_mcp/auth/validator.py L72-92,
  garmin-mcp trainingpeaks.py L365-384.
- upload: POST /fitness/v6/athletes/{aid}/workouts/filedata {workoutDay: null, data: base64(fit), fileName,
  uploadClient}. fr3akX/fit2tp src/main.rs L117-130 (b3b80d0). Duplicates are not reported by this
  endpoint, so we check the day's completed workouts first.
- planned: GET /fitness/v6/athletes/{aid}/workouts/{day}/{day}; structure format from a real response in
  freekode/tp2intervals boot/src/test/resources/tp-calendar-workout-null-title.json (5ffdc66).
Type ids: 2 = bike (tp2intervals TPTrainingTypeMapper.kt).
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import re
import time
from pathlib import Path
from typing import Callable

from . import planned as P
from .base import (AUTH, BLOCKED, DUPLICATE, TEMPORARY, Connector, IntegrationError, Resp, RideMeta, SecretFile, http,
                   kind_for_status, retry_after)

API = "https://tpapi.trainingpeaks.com"
COOKIE = "Production_tpAuth"
BIKE = 2
UPLOAD_CLIENT = "TP Web App"  # what fit2tp sends; the web app's own value
HEADERS = {"Accept": "application/json", "Origin": "https://app.trainingpeaks.com",
           "Referer": "https://app.trainingpeaks.com/",
           "User-Agent": "Mozilla/5.0 (compatible; JustWatts/0.1; +https://justwatts.com)"}
EXPIRED = "TrainingPeaks session expired: copy a fresh Production_tpAuth cookie and reconnect"


def cookie_value(raw: str) -> str:
    """Accept the bare value, `Production_tpAuth=...` or a whole Cookie header."""
    raw = str(raw or "").strip().strip('"')
    m = re.search(COOKIE + r"=([^;\s]+)", raw)
    v = m[1] if m else raw
    return v if re.fullmatch(r"[A-Za-z0-9\-_.~%+/=]{20,4096}", v) else ""


class TrainingPeaksConnector(Connector):
    id, name = "trainingpeaks", "TrainingPeaks"
    official = False
    planned_workouts = True
    fields = [{"name": "cookie", "label": "Production_tpAuth cookie", "secret": True,
               "help": "Signed in at app.trainingpeaks.com: browser dev tools, Application, Cookies, Production_tpAuth"}]

    def __init__(self, idir: Path, http=http, clock: Callable[[], float] = time.time):
        self.file = SecretFile(Path(idir) / "trainingpeaks.json")
        self.http = http
        self.clock = clock

    def status(self) -> dict:
        s = self.file.read()
        return {"connected": bool(s.get("cookie")), "account": s.get("name") or None,
                "athlete_id": s.get("athlete_id")}

    def secrets(self) -> list[str]:
        s = self.file.read()
        return [v for v in (s.get("cookie"), s.get("access_token")) if v]

    # ---------- auth ----------
    def _mint(self, s: dict) -> dict:
        r = self.http("GET", f"{API}/users/v3/token", None, {**HEADERS, "Cookie": f"{COOKIE}={s['cookie']}"})
        body = r.json() if r.status < 500 else None
        tok = (body or {}).get("token") if isinstance(body, dict) else None
        if r.status in (401, 403) or (r.status == 200 and (not isinstance(body, dict) or body.get("success") is False
                                                            or not (tok or {}).get("access_token"))):
            raise IntegrationError(AUTH, EXPIRED)
        if r.status != 200:
            raise IntegrationError(kind_for_status(r.status) if r.status != 409 else TEMPORARY,
                                   f"TrainingPeaks token request failed ({r.status})", retry_after(r.headers))
        s.update(access_token=tok["access_token"], expires_at=self.clock() + float(tok.get("expires_in") or 3600))
        return s

    def _token(self, force: bool = False) -> tuple[dict, str]:
        s = self.file.read()
        if not s.get("cookie"):
            raise IntegrationError(AUTH, "TrainingPeaks not connected")
        if force or not s.get("access_token") or s.get("expires_at", 0) - 60 < self.clock():
            s = self._mint(s)
            self.file.write(s)
        return s, s["access_token"]

    def _api(self, method: str, path: str, body=None) -> Resp:
        """Bearer call; a 401 mints a new token once (the 1 h token ran out early), then gives up as auth."""
        data = json.dumps(body).encode() if body is not None else None
        for attempt in (0, 1):
            _, tok = self._token(force=attempt == 1)
            h = {**HEADERS, "Authorization": f"Bearer {tok}"}
            if data is not None:
                h["Content-Type"] = "application/json"
            r = self.http(method, API + path, data, h)
            if r.status != 401:
                break
        if r.status < 300:
            return r
        kind = kind_for_status(r.status)
        if r.status == 401:
            kind = AUTH
        elif r.status == 403 and "html" not in r.headers.get("content-type", ""):
            kind = AUTH  # an API refusal for this athlete: the session belongs to someone else or lost rights
        if "duplicate" in r.text.lower():
            kind = DUPLICATE
        msg = EXPIRED if kind == AUTH else f"TrainingPeaks said {r.status}"
        raise IntegrationError(kind, msg, retry_after(r.headers))

    @staticmethod
    def _athlete(body: dict) -> tuple[str | None, str]:
        u = (body or {}).get("user") or {}
        name = " ".join(x for x in (u.get("firstName"), u.get("lastName")) if x)
        pid = u.get("personId")
        aths = [a for a in u.get("athletes") or [] if isinstance(a, dict)]
        match = next((a for a in aths if pid and a.get("athleteId") == pid), None) or \
            next((a for a in aths if u.get("email") and a.get("email") == u.get("email")), None)
        aid = pid or (match or {}).get("athleteId") or u.get("userId")
        return (str(aid) if aid else None), name

    def connect(self, fields: dict) -> dict:
        ck = cookie_value(fields.get("cookie"))
        if not ck:
            raise IntegrationError(AUTH, "paste the Production_tpAuth cookie value from app.trainingpeaks.com")
        s = self._mint({"cookie": ck})
        self.file.write(s)
        aid, name = self._athlete(self._api("GET", "/users/v3/user").json() or {})
        if not aid:
            self.file.clear()
            raise IntegrationError(BLOCKED, "TrainingPeaks did not return an athlete for this login")
        self.file.write({**self.file.read(), "athlete_id": aid, "name": name[:80]})
        return {"connected": True, **self.status()}

    def disconnect(self) -> None:
        self.file.clear()

    # ---------- workouts ----------
    def _day(self, day: str) -> list[dict]:
        s, _ = self._token()
        w = self._api("GET", f"/fitness/v6/athletes/{s['athlete_id']}/workouts/{day}/{day}").json()
        return [x for x in w if isinstance(x, dict)] if isinstance(w, list) else []

    @staticmethod
    def _done(w: dict) -> bool:
        return bool(w.get("completed")) or w.get("totalTime") is not None

    def upload(self, fit: bytes, meta: RideMeta) -> dict:
        s, _ = self._token()
        start = (meta.start_ms or 0) / 1000
        dur = float(meta.extra.get("duration_s") or 0)
        if start:
            local = dt.datetime.fromtimestamp(start)
            for w in self._day(local.strftime("%Y-%m-%d")):
                if not self._done(w):
                    continue
                st = str(w.get("startTime") or "")
                same_start = False
                if st:
                    try:
                        same_start = abs((dt.datetime.fromisoformat(st[:19]) - local.replace(microsecond=0)).total_seconds()) <= 120
                    except ValueError:
                        pass
                same_len = dur and w.get("totalTime") is not None and abs(float(w["totalTime"]) * 3600 - dur) <= 60
                if same_start or (not st and same_len):
                    return {"duplicate": True, "activity_id": w.get("workoutId"), "url": self._url(w.get("workoutId"))}
        body = {"workoutDay": None, "data": base64.b64encode(fit).decode(), "fileName": meta.filename or "ride.fit",
                "uploadClient": UPLOAD_CLIENT}
        res = self._api("POST", f"/fitness/v6/athletes/{s['athlete_id']}/workouts/filedata", body).json()
        first = res[0] if isinstance(res, list) and res else res if isinstance(res, dict) else {}
        wid = (first or {}).get("workoutId")
        return {"activity_id": wid, "url": self._url(wid)}

    @staticmethod
    def _url(wid) -> str | None:
        return f"https://app.trainingpeaks.com/#calendar/workout/{wid}" if wid else None

    def planned(self, day: str) -> list[dict]:
        out = []
        for w in self._day(day):
            if w.get("workoutTypeValueId") != BIKE or self._done(w):
                continue
            hours = w.get("totalTimePlanned")
            text = P.from_trainingpeaks(w.get("structure")) or P.free_for(hours * 3600 if hours else None)
            if not text:
                continue
            out.append({"id": str(w.get("workoutId")), "name": str(w.get("title") or "Planned ride")[:120],
                        "date": str(w.get("workoutDay") or day)[:10], "text": text,
                        "duration_s": round(hours * 3600) if hours else None,
                        "description": str(w.get("description") or "")[:2000],
                        "structured": bool(w.get("structure")), "tss": w.get("tssPlanned")})
        return out
