"""Local HTTP server: serves the web app and its API. Stdlib only.

Binds 127.0.0.1. Every request must carry a localhost Host header (blocks DNS rebinding).
Write endpoints accept either the page (same Origin + `X-HW: 1`) or a local caller with
`Authorization: Bearer <token>` (token file in the data dir). See docs/PROTOCOL.md.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from . import __version__
from .config import Config
from .events import parse_line, tail_lines
from .devices import DeviceHub
from .engine import RideEngine
from . import history as H
from .strava import StravaError, StravaLink, summary_text
from .garmin import DISABLED_MSG, GarminLink

MAX_BODY = 64 * 1024 * 1024
QUIET_PATHS = ("/api/state", "/api/health",
               "/api/strava/callback")  # the callback query carries the OAuth code: keep it out of logs
# A page served from here may never be framed (clickjacking) and runs only its own scripts.
# Map tiles (keyless): OSM, Esri imagery, OpenTopoMap, CyclOSM. The 3D map fetch()es them and AWS terrain tiles.
MAP_TILES = "https://tile.openstreetmap.org https://server.arcgisonline.com https://tile.opentopomap.org https://a.tile-cyclosm.openstreetmap.fr"
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       f"img-src 'self' data: blob: {MAP_TILES}; connect-src 'self' {MAP_TILES} https://s3.amazonaws.com; "
       "object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
# headers a reverse proxy or tunnel adds: such a request came from the network, not this computer
PROXY_HEADERS = ("X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Forwarded", "CF-Connecting-IP", "True-Client-IP")


def safe_id(rid: Any) -> str:
    """A ride id as used in file names: word characters and dashes only."""
    return re.sub(r"[^\w\-]+", "", str(rid or ""))


def atomic_write(dest: Path, data: bytes) -> None:
    """Write via a unique temp file + rename, so readers never see a half-written file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())  # on disk before it replaces the old file: a power cut leaves old or new, never empty
    for attempt in range(50):
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:  # Windows: a reader has the target open; retry briefly
            if attempt == 49:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.01)


def read_retry(path: Path) -> bytes | None:
    """Read a file another thread may be atomically replacing (Windows briefly denies access)."""
    for attempt in range(50):
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None
        except PermissionError:
            if attempt == 49:
                raise
            time.sleep(0.01)
    return None


class Handler(SimpleHTTPRequestHandler):
    server: "AppServer"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(kw.pop("directory", None) or a[2].cfg.app), **kw)

    # ---------- helpers ----------
    @property
    def cfg(self) -> Config:
        return self.server.cfg

    def log_message(self, fmt, *args):
        if self.server.quiet:
            return
        p = self.path or ""
        if "/api/" in p and not p.startswith(QUIET_PATHS):
            super().log_message(fmt, *args)

    def end_headers(self):
        path = urlsplit(self.path or "").path
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if not path.startswith("/api/"):  # app files always revalidate, so an update never mixes old and new modules
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self) -> bool:
        port = self.server.server_address[1]
        if any(h in self.headers for h in PROXY_HEADERS):  # a proxy that rewrites Host must not expose the API
            return False
        return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def origins(self) -> tuple[str, str]:
        port = self.server.server_address[1]
        return (f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def token_ok(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        return hmac.compare_digest(auth[7:].strip().encode(), self.server.token.encode())

    def trusted(self) -> bool:
        origin = self.headers.get("Origin")
        if self.token_ok():
            # a token caller is a local process, never a web page from another origin
            return origin is None or origin in self.origins()
        # The page itself: same origin plus a custom header (forces a CORS preflight we never answer).
        return origin in self.origins() and self.headers.get("X-HW") == "1"

    def read_body(self) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n > MAX_BODY or n < 0:  # a negative length would read until the client hangs up
            raise OverflowError
        return self.rfile.read(n) if n else b""

    def log_event(self, line: str) -> None:
        self.server.log_event(line)

    def send_raw_json(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- routes ----------
    def do_GET(self):
        url = urlsplit(self.path)
        share = re.fullmatch(r"/share/([\w\-]+)\.png", url.path)
        if share:  # the only path served for any Host: finished-ride cards, for a public base URL
            f = self.cfg.rides / "cards" / f"{share[1]}.png"
            if not f.exists() or not self.server.settings.get("shareBaseUrl"):
                return self.send_json(404, {"error": "not found"})
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if not self.host_ok():
            return self.send_json(421, {"error": "bad host"})
        q = parse_qs(url.query)
        p = url.path
        srv = self.server
        if p == "/api/health":
            return self.send_json(200, {"ok": True, "app": "justwatts", "version": __version__,
                                        "garmin": srv.garmin_enabled, "ble": srv.hub.ble_enabled})
        if p == "/api/stream":
            return self.stream()
        if p == "/api/strava/status":
            return self.send_json(200, {**srv.strava.status(), "auto": bool(srv.settings.get("autoStrava"))})
        if p == "/api/strava/connect":
            try:
                return self.redirect(srv.strava.authorize_url(f"http://localhost:{srv.server_address[1]}/api/strava/callback"))
            except StravaError as e:
                return self.redirect(f"http://127.0.0.1:{srv.server_address[1]}/?strava_error={quote(str(e))}#settings")
        if p == "/api/strava/callback":
            home = f"http://127.0.0.1:{srv.server_address[1]}/"
            if q.get("error"):
                return self.redirect(home + f"?strava_error={quote(q['error'][0])}#settings")
            try:
                srv.strava.callback(q.get("code", [""])[0], q.get("state", [""])[0], q.get("scope", [""])[0])
            except StravaError as e:
                return self.redirect(home + f"?strava_error={quote(str(e))}#settings")
            srv.log_event("STRAVA connected")
            return self.redirect(home + "?strava=connected#settings")
        if p == "/api/live":
            rid = q.get("ride", [None])[0]
            n = int(q.get("n", ["0"])[0] or 0)
            return self.send_json(200, srv.live_payload(rid, n))
        if p == "/api/settings":
            return self.send_json(200, srv.settings_payload())
        if p == "/api/devices":
            return self.send_json(200, srv.hub.status())
        if p == "/api/rides":
            return self.send_json(200, {"rides": srv.list_rides()})
        if p == "/api/trends":
            weeks = max(1, min(104, int(q.get("weeks", ["12"])[0])))
            return self.send_json(200, H.trends(srv.list_rides(limit=None), weeks))
        if p.startswith("/api/rides/"):
            parts = p.split("/")[3:]
            rid = re.sub(r"[^\w\-]+", "", parts[0]) if parts else ""
            r = srv.load_ride(rid)
            if r is None:
                return self.send_json(404, {"error": "no such ride"})
            sub = parts[1] if len(parts) > 1 else ""
            if sub == "":
                return self.send_raw_json(json.dumps(r).encode())
            if sub == "detail":
                return self.send_json(200, H.detail(r, H.active_hr_zones(srv.settings)["floors"], srv.ride_meta(rid)))
            if sub in ("fit", "tcx"):
                data = H.fit_encode(r) if sub == "fit" else H.tcx(r).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream" if sub == "fit" else "application/xml")
                self.send_header("Content-Disposition", f'attachment; filename="{H.file_base(r)}.{sub}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return None
            return self.send_json(404, {"error": "not found"})
        if p == "/api/garmin/status":
            return self.send_json(200, {"linked": srv.garmin.linked(), "enabled": srv.garmin_enabled})
        if p == "/api/garmin/zones":
            try:
                return self.send_json(200, srv.garmin.zones())
            except Exception as e:  # noqa: BLE001 - not signed in, disabled, or Garmin unreachable
                return self.send_json(502, {"error": str(e)[:200]})
        if p in ("/api/state", "/api/events"):
            if not self.trusted():
                return self.send_json(403, {"error": "forbidden"})
            if p == "/api/state":
                return self.send_json(200, {"state": srv.engine_state()})
            n = max(1, min(2000, int(q.get("n", ["50"])[0])))
            return self.send_json(200, {"events": [parse_line(x) for x in tail_lines(self.cfg.events_log, n)]})
        if p.startswith("/api/"):
            return self.send_json(404, {"error": "not found"})
        return super().do_GET()

    def redirect(self, url: str):
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def stream(self):
        """Server-sent events: one `data:` JSON message per engine change (at least once a second)."""
        srv = self.server
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        eng = srv.engine
        rid, n, ver = None, 0, -1
        try:
            while not srv.stopping:
                with eng.changed:
                    eng.changed.wait_for(lambda: eng.version != ver or srv.stopping, timeout=2)
                    ver = eng.version
                msg = srv.live_payload(rid, n)
                rid, n = msg["ride_id"], msg["n"]
                self.wfile.write(b"data: " + json.dumps(msg).encode() + b"\n\n")
                self.wfile.flush()
        except (OSError, ValueError):  # client went away
            return

    def do_HEAD(self):
        if not self.host_ok():
            return self.send_json(421, {"error": "bad host"})
        return super().do_HEAD()

    def do_POST(self):
        # Read the body first: answering before the client finished sending resets the socket.
        try:
            raw = self.read_body()
        except OverflowError:
            self.close_connection = True
            return self.send_json(413, {"error": "too large"})
        if not self.host_ok():
            return self.send_json(421, {"error": "bad host"})
        p = urlsplit(self.path).path
        routes = ("/api/ride", "/api/garmin/upload", "/api/ride/control", "/api/settings", "/api/devices", "/api/garmin/import", "/api/strava/config", "/api/strava/disconnect", "/api/strava/shared")
        ride_action = re.fullmatch(r"/api/rides/([\w\-]+)/(garmin|delete|strava|card|description)", p)
        if p not in routes and not ride_action:
            return self.send_json(404, {"error": "not found"})
        if not self.trusted():
            return self.send_json(403, {"error": "forbidden"})
        srv = self.server
        if p == "/api/strava/config":
            # the client secret is the user's: only the page may set it, never a token caller
            if self.token_ok() or self.headers.get("X-HW") != "1":
                return self.send_json(403, {"error": "enter the Strava client secret yourself in Settings"})
            try:
                b = json.loads(raw or b"{}")
                srv.strava.configure(str(b.get("client_id", "")), b.get("client_secret") or None)
            except (ValueError, StravaError) as e:
                return self.send_json(400, {"error": str(e)})
            return self.send_json(200, srv.strava.status())
        if p == "/api/strava/disconnect":
            srv.strava.disconnect()
            return self.send_json(200, srv.strava.status())
        if p == "/api/strava/shared":
            srv.strava.use_shared()
            return self.send_json(200, srv.strava.status())
        if ride_action and ride_action[2] == "card":
            if not raw.startswith(b"\x89PNG"):
                return self.send_json(400, {"error": "PNG expected"})
            atomic_write(self.cfg.rides / "cards" / f"{ride_action[1]}.png", raw)
            return self.send_json(200, {"ok": True, "url": srv.card_url(ride_action[1])})
        if ride_action and ride_action[2] == "description":
            try:
                text = str(json.loads(raw or b"{}").get("text", ""))[:2000]
            except ValueError:
                return self.send_json(400, {"error": "bad json"})
            srv.set_ride_meta(ride_action[1], {"description": text})
            return self.send_json(200, {"ok": True})
        if ride_action and ride_action[2] == "strava":
            r = srv.load_ride(ride_action[1])
            if r is None:
                return self.send_json(404, {"error": "no such ride"})
            try:
                res = srv.upload_strava(r)
            except StravaError as e:
                return self.send_json(502, {"ok": False, "error": str(e)})
            return self.send_json(200 if res.get("ok") else 502, res)
        if ride_action:
            rid, act = ride_action[1], ride_action[2]
            if act == "delete":
                return self.send_json(200 if srv.delete_ride(rid) else 404, {"ok": True})
            r = srv.load_ride(rid)
            if r is None:
                return self.send_json(404, {"error": "no such ride"})
            path = self.cfg.rides / f"{H.file_base(r)}.fit"
            atomic_write(path, H.fit_encode(r))
            return self.upload_file(path, rid)
        if p == "/api/garmin/upload":
            return self.garmin_upload(raw)
        try:
            body = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            return self.send_json(400, {"error": "bad json"})
        if p == "/api/garmin/import":
            if not srv.garmin_enabled or not srv.garmin.linked():
                return self.send_json(503, {"error": DISABLED_MSG if not srv.garmin_enabled else "not signed in"})
            try:
                return self.send_json(200, srv.import_garmin_profile(force=bool(body.get("force"))))
            except Exception as e:  # noqa: BLE001
                return self.send_json(502, {"error": str(e)[:200]})
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "body must be an object"})
        if p == "/api/ride/control":
            try:
                res = srv.engine.control(str(body.get("action", "")), body)
            except (ValueError, KeyError, TypeError) as e:  # a bad body, e.g. an edit without its fields
                return self.send_json(400, {"error": str(e)})
            return self.send_json(200, {"ok": True, **res})
        if p == "/api/settings":
            return self.send_json(200, srv.update_settings(body))
        if p == "/api/devices":
            return self.devices(body)
        # /api/ride: archive a finished ride (the page moves rides kept in old browser storage here)
        body["id"] = safe_id(body.get("id", "ride")) or "ride"  # the stored id is the file name: meta paths use it
        atomic_write(self.cfg.rides / (body["id"] + ".json"), json.dumps(body).encode("utf-8"))
        return self.send_json(200, {"ok": True})

    def devices(self, body: dict):
        hub = self.server.hub
        action, kind = body.get("action"), body.get("kind", "trainer")
        if kind not in ("trainer", "hr"):
            return self.send_json(400, {"error": "kind must be trainer or hr"})
        try:
            if action == "scan":
                return self.send_json(200, {"devices": hub.scan(kind, float(body.get("timeout", 5)))})
            if action == "connect":
                hub.connect(kind, str(body["address"]), body.get("name"))
            elif action == "disconnect":
                hub.disconnect(kind)
            elif action == "sim":
                hub.set_sim(bool(body.get("on", hub.mode != "sim")))
            else:
                return self.send_json(400, {"error": "action must be scan, connect, disconnect or sim"})
        except (RuntimeError, KeyError, TimeoutError) as e:
            return self.send_json(503, {"error": str(e) or type(e).__name__})
        except Exception as e:  # noqa: BLE001 - BLE stack errors
            return self.send_json(502, {"error": f"{type(e).__name__}: {e}"[:300]})
        with self.server.engine.lock:
            self.server.engine.apply_target()
            self.server.engine._bump()
        return self.send_json(200, hub.status())

    def garmin_upload(self, data: bytes):
        name = re.sub(r"[^\w\- .]+", "", self.headers.get("X-Filename", "ride.fit"))[:120].strip(" .") or "ride.fit"
        if not name.lower().endswith(".fit"):
            name += ".fit"
        path = self.cfg.rides / name
        atomic_write(path, data)
        rid = re.sub(r"[^\w\-]+", "", self.headers.get("X-Ride-Id", ""))
        return self.upload_file(path, rid or None)

    def upload_file(self, path: Path, rid: str | None):
        g = self.server.garmin
        if getattr(g, "enabled", True) is False:
            return self.send_json(503, {"ok": False, "disabled": True, "error": DISABLED_MSG, "saved": str(path)})
        if not g.linked():
            return self.send_json(401, {"ok": False, "error": "not signed in, run: justwatts login-garmin", "saved": str(path)})
        res = g.upload(path)
        code = 200 if res.get("ok") else 502
        if res.get("ok") and rid:
            self.server.set_ride_meta(rid, {"garmin": res.get("activityId") or True, "garmin_at": int(time.time() * 1000)})
        return self.send_json(code, {**res, "saved": str(path)})


SETTINGS_DEFAULTS = {"ftp": 200, "weight": 0, "beeps": True, "autoGarmin": False, "hrZones": None, "hrMax": None,
                     "hrZonesSrc": None, "cadRange": [85, 95], "afterWorkout": "hold", "ftpSrc": None, "profileImported": False,
                     "autoStrava": False, "shareBaseUrl": "", "hideVirtualDistance": False, "units": "imperial", "cadOn": True}


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, cfg: Config, garmin: GarminLink | None = None, quiet: bool = False,
                 ticker: bool = True, devices: bool = True, hub: DeviceHub | None = None, strava_http=None):
        self.cfg = cfg
        if cfg.is_default_data:
            from .config import migrate_legacy_data
            if migrate_legacy_data():
                print("moved ~/.trainer-coach to ~/.justwatts")
        self.token = cfg.ensure_token()
        self.garmin_enabled = cfg.garmin_enabled if garmin is None else getattr(garmin, "enabled", True)
        self.garmin = garmin or GarminLink(cfg.garmin_tokens, enabled=cfg.garmin_enabled)
        self.log_lock = threading.Lock()
        self.quiet = quiet
        self.stopping = False
        self._rides_cache: dict[str, tuple[float, dict]] = {}
        self.settings_lock = threading.Lock()
        self.settings = self._load_settings()
        self.hub = hub or DeviceHub(cfg.data / "devices.json", ble_enabled=cfg.ble_enabled,
                                    log=(lambda m: None) if quiet else (lambda m: print("ble:", m, flush=True)))
        cfg.live_dir  # moves the ride in progress from an older data layout before the engine resumes it
        self.engine = RideEngine(self.hub, cfg.data, self.log_event, lambda: self.settings)
        self.engine.on_finish = self._after_finish
        self.strava = StravaLink(cfg.data, http=strava_http) if strava_http else StravaLink(cfg.data)
        super().__init__(("127.0.0.1", cfg.port), Handler)
        self.engine.resume()
        if devices:
            self.hub.start()
            self._first_run_garmin()
        self._ticker = threading.Thread(target=self._tick_loop, name="ride-tick", daemon=True) if ticker else None
        if self._ticker:
            self._ticker.start()

    # ---------- events ----------
    def log_event(self, line: str) -> None:
        with self.log_lock:
            self.cfg.events_log.parent.mkdir(parents=True, exist_ok=True)
            with self.cfg.events_log.open("a", encoding="utf-8") as f:
                f.write(f"[{time.strftime('%H:%M:%S')}] {line[:400]}\n")
        eng = getattr(self, "engine", None)
        if eng is not None:
            eng.note(line[:400])

    def import_garmin_profile(self, force: bool = False) -> dict:
        """Copy FTP, weight and HR zones from Garmin into settings (only fields the athlete did not set).
        HR zones come over only on request (force) or when the athlete chose Garmin zones."""
        prof = self.garmin.profile()
        s, patch = self.settings, {}
        if prof.get("floors") and (force or s.get("hrZonesSrc") == "garmin"):
            patch.update(hrZones=prof["floors"], hrMax=prof.get("max"), hrZonesSrc="garmin")
        if prof.get("ftp") and (force or s.get("ftpSrc") != "manual"):
            patch.update(ftp=prof["ftp"], ftpSrc="garmin")
        if prof.get("weight_kg") and (force or not s.get("weight")):
            patch["weight"] = prof["weight_kg"]
        patch["profileImported"] = True
        self.update_settings(patch)
        return {"imported": {k: v for k, v in patch.items() if k != "profileImported"}, "profile": prof}

    def _first_run_garmin(self) -> None:
        if self.settings.get("profileImported") or not (self.garmin_enabled and self.garmin.linked()):
            return

        def go():
            try:
                res = self.import_garmin_profile()
                self.log_event("GARMIN profile imported: " + ", ".join(f"{k}={v}" for k, v in res["imported"].items()))
            except Exception as e:  # noqa: BLE001
                self.log_event(f"GARMIN profile import failed: {e}"[:200])
        threading.Thread(target=go, name="garmin-profile", daemon=True).start()

    # ---------- settings ----------
    @property
    def settings_file(self) -> Path:
        return self.cfg.data / "settings.json"

    def _load_settings(self) -> dict:
        base = {**SETTINGS_DEFAULTS, "autoGarmin": self.garmin_enabled and self.cfg.is_default_data}
        try:
            stored = json.loads(self.settings_file.read_text(encoding="utf-8"))
            self.settings_stored = True
            out = {**base, **{k: v for k, v in stored.items() if k in SETTINGS_DEFAULTS}}
        except (OSError, ValueError):
            self.settings_stored = False
            out = base
        if not self.garmin_enabled:
            out["autoGarmin"] = False
        return out

    def settings_payload(self) -> dict:
        return {"settings": self.settings, "stored": self.settings_stored, "garmin": self.garmin_enabled}

    def update_settings(self, body: dict) -> dict:
        with self.settings_lock:
            new = dict(self.settings)
            for k, v in body.items():
                if k not in SETTINGS_DEFAULTS:
                    continue
                if k == "ftp":
                    try:
                        v = int(v)
                    except (TypeError, ValueError):
                        continue
                    if not 50 <= v <= 600:
                        continue
                if k == "autoGarmin" and not self.garmin_enabled:
                    v = False
                if k == "afterWorkout" and v not in ("hold", "grade0"):
                    continue
                if k == "units" and v not in ("imperial", "metric"):
                    continue
                if k == "cadOn" and not isinstance(v, bool):
                    continue
                if k == "hrZonesSrc" and v not in (None, "default", "manual", "garmin"):
                    continue
                if k == "shareBaseUrl" and not (isinstance(v, str) and (v == "" or re.match(r"https?://", v))):
                    continue
                new[k] = v
            self.settings = new
            atomic_write(self.settings_file, json.dumps(new).encode())
            self.settings_stored = True
        return self.settings_payload()

    def athlete(self) -> dict:
        s, z = self.settings, H.active_hr_zones(self.settings)
        return {"ftp": s.get("ftp"), "weight_kg": s.get("weight") or None, "hr_zones": z["floors"],
                "hr_max": s.get("hrMax"), "hr_zones_source": z["src"], "cadence_range": s.get("cadRange")}

    # ---------- state ----------
    def engine_state(self) -> dict:
        return self.engine.state(self.athlete())

    def live_payload(self, rid: str | None, n: int) -> dict:
        new_rid, samples = self.engine.samples_since(rid, n)
        reset = new_rid != rid
        total = (0 if reset else n) + len(samples)
        return {"state": self.engine_state(), "ride_id": new_rid, "reset": reset, "samples": samples, "n": total}

    def card_url(self, rid: str) -> str | None:
        base = (self.settings.get("shareBaseUrl") or "").rstrip("/")
        return f"{base}/share/{rid}.png" if base else None

    def upload_strava(self, ride: dict) -> dict:
        rid = ride["id"]
        meta = self.ride_meta(rid)
        d = H.detail(ride, H.active_hr_zones(self.settings)["floors"], meta)
        desc = summary_text(d, self.card_url(rid), meta.get("description"))
        res = self.strava.upload(H.fit_encode(ride), ride.get("name") or "Just Watts ride", desc, rid)
        if res.get("activity_id"):
            self.set_ride_meta(rid, {"strava": res["activity_id"], "strava_at": int(time.time() * 1000)})
        self.log_event(f"STRAVA {'uploaded' if res.get('ok') else 'failed: ' + str(res.get('error'))[:120]}")
        return res

    def _after_finish(self, ride: dict) -> None:
        """Auto-uploads on the server, so they happen even with no page open."""
        if self.settings.get("autoStrava") and self.strava.status()["connected"]:
            def strava():
                try:
                    self.upload_strava(ride)
                except Exception as e:  # noqa: BLE001
                    self.log_event(f"STRAVA failed: {e}"[:200])
            threading.Thread(target=strava, name="strava-upload", daemon=True).start()
        if not (self.settings.get("autoGarmin") and self.garmin_enabled):
            return

        def go():
            try:
                path = self.cfg.rides / f"{H.file_base(ride)}.fit"
                atomic_write(path, H.fit_encode(ride))
                if not self.garmin.linked():
                    self.log_event("GARMIN skipped: not signed in")
                    return
                res = self.garmin.upload(path)
                if res.get("ok"):
                    self.set_ride_meta(ride["id"], {"garmin": res.get("activityId") or True, "garmin_at": int(time.time() * 1000)})
                self.log_event(f"GARMIN {'uploaded' if res.get('ok') else 'failed: ' + str(res.get('error'))[:120]}")
            except Exception as e:  # noqa: BLE001
                self.log_event(f"GARMIN failed: {e}"[:200])
        threading.Thread(target=go, name="garmin-upload", daemon=True).start()

    def load_ride(self, rid: str) -> dict | None:
        if not rid:
            return None
        f = self.cfg.rides / f"{rid}.json"
        try:
            r = json.loads(read_retry(f) or b"null")
        except ValueError:
            return None
        return r if isinstance(r, dict) and r.get("samples") else None

    def ride_meta(self, rid: str) -> dict:
        try:
            return json.loads((self.cfg.rides / "meta" / f"{safe_id(rid)}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def set_ride_meta(self, rid: str, patch: dict) -> None:
        rid = safe_id(rid)
        atomic_write(self.cfg.rides / "meta" / f"{rid}.json", json.dumps({**self.ride_meta(rid), **patch}).encode())
        self._rides_cache.pop(f"{rid}.json", None)

    def delete_ride(self, rid: str) -> bool:
        f = self.cfg.rides / f"{re.sub(r'[^\w\-]+', '', rid)}.json"
        if not f.exists():
            return False
        trash = self.cfg.rides / "trash"
        trash.mkdir(parents=True, exist_ok=True)
        os.replace(f, trash / f.name)  # recoverable by hand
        self._rides_cache.pop(f.name, None)
        return True

    def list_rides(self, limit: int | None = 500) -> list[dict]:
        """Archived rides with summary metrics, newest first (cached per file mtime)."""
        out = []
        for f in (self.cfg.rides.glob("*.json") if self.cfg.rides.exists() else []):
            mt = f.stat().st_mtime_ns
            hit = self._rides_cache.get(f.name)
            if not hit or hit[0] != mt:
                try:
                    r = json.loads(f.read_text(encoding="utf-8"))
                    if not r.get("samples"):
                        continue
                    row = H.ride_meta_row(r, self.ride_meta(r.get("id") or f.stem))
                except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError):
                    continue
                self._rides_cache[f.name] = hit = (mt, row)
            out.append(hit[1])
        out.sort(key=lambda m: m.get("start") or 0, reverse=True)
        return out if limit is None else out[:limit]

    # ---------- ticker ----------
    def _tick_loop(self) -> None:
        nxt = time.monotonic()
        while not self.stopping:
            nxt += 1.0
            time.sleep(max(0.0, nxt - time.monotonic()))
            try:
                self.engine.tick()
            except Exception as e:  # noqa: BLE001 - never let the ride loop die
                print("tick error:", e, flush=True)
            if time.monotonic() - nxt > 5:
                nxt = time.monotonic()

    def shutdown(self) -> None:
        self.stopping = True
        with self.engine.changed:
            self.engine.changed.notify_all()
        super().shutdown()

    def server_close(self) -> None:
        self.stopping = True
        try:
            with self.engine.lock:
                self.engine.save()
        finally:
            self.hub.stop()
            super().server_close()


def make_server(cfg: Config | None = None, garmin: GarminLink | None = None, quiet: bool = False,
                ticker: bool = True, devices: bool = True, hub: DeviceHub | None = None, strava_http=None) -> AppServer:
    return AppServer(cfg or Config(), garmin, quiet, ticker=ticker, devices=devices, hub=hub, strava_http=strava_http)


def serve(cfg: Config | None = None) -> None:
    srv = make_server(cfg)
    c = srv.cfg
    print(f"justwatts {__version__} on {c.base_url}")
    print(f"  app:    {c.app}")
    print(f"  data:   {c.data}")
    print(f"  token:  {c.token_file}")
    print(f"  garmin: {'on' if srv.garmin_enabled else 'off'}   bluetooth: {'on' if srv.hub.ble_enabled else 'off'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
