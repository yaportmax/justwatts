"""Optional direct upload to Strava through the official API.

Default: Just Watts's shared Strava app. Its client secret never ships with the app; a small token
service (web/api/strava/token.js, at JUSTWATTS_STRAVA_RELAY) holds it and only swaps OAuth codes and
refresh tokens for access tokens. Uploads go straight from this computer to Strava.

Advanced: the user's own API app. Client ID and secret are entered in Settings (the page only; the
API refuses to take the secret from a token caller) and live in
<data>/strava_app.json; then the token service is not used at all. Tokens are in
<data>/strava_token.json (mode 0600). OAuth returns to http://localhost:<port>/api/strava/callback
(Strava always allows localhost callbacks).
"""
from __future__ import annotations

import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

AUTH_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
API = "https://www.strava.com/api/v3"
SCOPE = "activity:write,activity:read"
SHARED_CLIENT_ID = os.environ.get("JUSTWATTS_STRAVA_CLIENT_ID", "168528")
RELAY_URL = os.environ.get("JUSTWATTS_STRAVA_RELAY", "https://justwatts.com/api/strava/token")
STATE_TTL_S = 900  # an OAuth state is good for 15 minutes
MAX_STATES = 8


class StravaError(Exception):
    pass


def _write_private(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _http(method: str, url: str, data: bytes | None = None, headers: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


class StravaLink:
    def __init__(self, data: Path, http: Callable[..., tuple[int, dict]] = _http, sleep=time.sleep,
                 relay: str | None = RELAY_URL):
        self.data = Path(data)
        self.relay = None if (relay or "").lower() in ("", "off", "0") else relay
        self.http = http
        self.sleep = sleep
        self._states: dict[str, float] = {}

    # ---------- storage ----------
    @property
    def app_file(self) -> Path:
        return self.data / "strava_app.json"

    @property
    def token_file(self) -> Path:
        return self.data / "strava_token.json"

    def _read(self, f: Path) -> dict:
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def configure(self, client_id: str, client_secret: str | None) -> None:
        cid = str(client_id or "").strip()
        if not cid.isdigit():
            raise StravaError("Client ID must be the number shown on strava.com/settings/api")
        app = self._read(self.app_file)
        if cid != app.get("client_id"):
            self.token_file.unlink(missing_ok=True)  # tokens belong to the old app
        app["client_id"] = cid
        if client_secret:  # empty keeps the stored secret
            app["client_secret"] = client_secret.strip()
        _write_private(self.app_file, app)

    def _own(self) -> dict | None:
        app = self._read(self.app_file)
        return app if app.get("client_id") and app.get("client_secret") else None

    def _client_id(self) -> str | None:
        own = self._own()
        return own["client_id"] if own else (SHARED_CLIENT_ID if self.relay else None)

    def _token(self, grant: dict) -> tuple[int, dict]:
        """Strava token call: directly with the user's own app, else through the shared app's token service."""
        own = self._own()
        if own:
            return self.http("POST", TOKEN_URL, urllib.parse.urlencode({
                "client_id": own["client_id"], "client_secret": own["client_secret"], **grant}).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"})
        if not self.relay:
            raise StravaError("set up your own Strava API app in Settings (the shared app is off)")
        return self.http("POST", self.relay, json.dumps(grant).encode(), {"Content-Type": "application/json"})

    def status(self) -> dict:
        app, tok = self._read(self.app_file), self._read(self.token_file)
        own = self._own()
        return {"client_id": app.get("client_id"), "has_secret": bool(app.get("client_secret")),
                "mode": "own" if own else ("shared" if self.relay else None),
                "configured": bool(own or self.relay),
                "connected": bool(tok.get("refresh_token")), "athlete": tok.get("athlete"),
                "scope": tok.get("scope")}

    def disconnect(self) -> None:
        self.token_file.unlink(missing_ok=True)

    def use_shared(self) -> None:
        """Forget the user's own API app (and its tokens) and go back to Just Watts's shared app."""
        self.app_file.unlink(missing_ok=True)
        self.token_file.unlink(missing_ok=True)

    # ---------- OAuth ----------
    def authorize_url(self, redirect_uri: str) -> str:
        cid = self._client_id()
        if not cid:
            raise StravaError("set up your own Strava API app in Settings first")
        state = secrets.token_urlsafe(16)
        # any web page can make the browser open /connect: keep only the newest few, unexpired states
        live = sorted(((k, v) for k, v in self._states.items() if time.time() - v < STATE_TTL_S), key=lambda kv: kv[1])
        self._states = dict(live[-(MAX_STATES - 1):])
        self._states[state] = time.time()
        q = {"client_id": cid, "redirect_uri": redirect_uri, "response_type": "code",
             "approval_prompt": "auto", "scope": SCOPE, "state": state}
        return AUTH_URL + "?" + urllib.parse.urlencode(q)

    def callback(self, code: str, state: str, scope: str = "") -> dict:
        made = self._states.pop(state, None) if state else None
        if made is None or time.time() - made >= STATE_TTL_S:
            raise StravaError("unknown or expired OAuth state; press Connect Strava again")
        if "activity:write" not in (scope or ""):
            raise StravaError("Strava did not grant activity:write; allow uploads on the Strava page")
        code_, body = self._token({"code": code, "grant_type": "authorization_code"})
        if code_ != 200 or "refresh_token" not in body:
            raise StravaError(f"token exchange failed ({code_}): {body.get('message', '')}")
        ath = body.get("athlete") or {}
        _write_private(self.token_file, {"access_token": body["access_token"], "refresh_token": body["refresh_token"],
                                         "expires_at": body.get("expires_at", 0), "scope": scope,
                                         "athlete": {"id": ath.get("id"), "name": " ".join(x for x in (ath.get("firstname"), ath.get("lastname")) if x)}})
        return self.status()

    def access_token(self) -> str:
        tok = self._read(self.token_file)
        if not tok.get("refresh_token"):
            raise StravaError("Strava not connected")
        if tok.get("expires_at", 0) - 120 > time.time():
            return tok["access_token"]
        code, body = self._token({"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})
        if code != 200 or "access_token" not in body:
            raise StravaError(f"token refresh failed ({code}): {body.get('message', '')}")
        tok.update(access_token=body["access_token"], refresh_token=body.get("refresh_token", tok["refresh_token"]),
                   expires_at=body.get("expires_at", 0))
        _write_private(self.token_file, tok)
        return tok["access_token"]

    # ---------- upload ----------
    def upload(self, fit: bytes, name: str, description: str, external_id: str,
               poll_s: float = 2, max_polls: int = 30) -> dict[str, Any]:
        """POST /uploads (data_type fit), then poll until Strava reports an activity id."""
        tok = self.access_token()
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in (("data_type", "fit"), ("name", name), ("description", description), ("external_id", external_id),
                     ("trainer", "1"), ("sport_type", "VirtualRide")):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{external_id}.fit"\r\n'
                     "Content-Type: application/octet-stream\r\n\r\n".encode() + fit + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        code, body = self.http("POST", f"{API}/uploads", b"".join(parts),
                               {"Authorization": f"Bearer {tok}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
        if code not in (200, 201) or "id" not in body:
            raise StravaError(f"upload refused ({code}): {body.get('message') or body.get('error') or body}")
        up = body
        for _ in range(max_polls):
            if up.get("activity_id"):
                return {"ok": True, "activity_id": up["activity_id"], "upload_id": up["id"]}
            if up.get("error"):
                err = str(up["error"])
                dup = "duplicate" in err.lower()
                # "duplicate of activity 123" carries the existing id
                aid = next((int(w) for w in err.replace("<", " ").replace(">", " ").split() if w.isdigit()), None)
                return {"ok": dup, "duplicate": dup, "activity_id": aid, "upload_id": up.get("id"), "error": err}
            self.sleep(poll_s)
            code, up = self.http("GET", f"{API}/uploads/{body['id']}", None, {"Authorization": f"Bearer {tok}"})
            if code != 200:
                raise StravaError(f"upload status failed ({code})")
        return {"ok": False, "upload_id": body["id"], "error": "Strava is still processing; check later"}


def summary_text(detail: dict, link: str | None = None, note: str | None = None) -> str:
    """Strava description: the rider's optional note, numbers, the intervals, the card link, the app line."""
    s = detail["summary"]
    lines = []
    if note:
        lines += [note.strip(), ""]
    hr = f" | HR {s['avg_hr']} avg, {s['max_hr']} max" if s.get("avg_hr") else ""
    lines.append(f"NP {s['np']} W | avg {s['avg_w']} W | IF {s['if']:.2f} | TSS {s['tss']} | {s['kJ']} kJ{hr}")
    work = [lp for lp in detail.get("laps", []) if lp.get("target_w") and not lp.get("free")
            and detail.get("ftp") and lp["target_w"] >= 0.88 * detail["ftp"]]
    if work:
        reps = ", ".join(f"{lp['avg_w']}" for lp in work[:12])
        lines.append(f"Intervals ({len(work)}): {reps} W")
    if link:
        lines.append(link)
    lines.append("Recorded with Just Watts")
    return "\n".join(lines)
