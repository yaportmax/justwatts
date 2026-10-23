"""Local HTTP server: serves the web app and the coach API. Stdlib only.

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
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .config import Config
from .events import line_coach, parse_line, tail_lines
from .devices import DeviceHub
from .engine import RideEngine
from . import history as H
from .garmin import DISABLED_MSG, GarminLink

MAX_BODY = 64 * 1024 * 1024
MAX_CMDS = 500
HISTORY_LEN = 1200  # state snapshots kept (~1 h at one per 3 s)
QUIET_PATHS = ("/api/state", "/api/event", "/api/current", "/api/coach?", "/api/health")


def atomic_write(dest: Path, data: bytes) -> None:
    """Write via a unique temp file + rename, so readers never see a half-written file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(data)
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


class CoachState:
    """In-memory command queue, latest page state and a short state history."""

    def __init__(self):
        self.lock = threading.Lock()
        self.cmds: list[dict] = []
        self.state: dict | None = None
        self.state_at: float | None = None
        self.history: deque = deque(maxlen=HISTORY_LEN)

    def add_cmd(self, fields: dict) -> dict:
        with self.lock:
            # ms-based seq keeps increasing across server restarts, so open pages never miss commands
            seq = max(int(time.time() * 1000), (self.cmds[-1]["seq"] + 1) if self.cmds else 0)
            cmd = {"seq": seq, **fields}
            self.cmds.append(cmd)
            del self.cmds[:-MAX_CMDS]
            return cmd

    def cmds_since(self, since: int) -> list[dict]:
        with self.lock:
            return [c for c in self.cmds if c["seq"] > since]

    def put_state(self, st: dict) -> None:
        now = time.time()
        with self.lock:
            self.state, self.state_at = st, now
            ride, live = st.get("ride") or {}, st.get("live") or {}
            if ride.get("started"):
                step = ride.get("step") or {}
                self.history.append({
                    "t": round(now, 1), "elapsed_s": ride.get("elapsed_s"), "step": step.get("index"),
                    "target_w": ride.get("target_w"), "power": live.get("power"), "power_3s": live.get("power_3s"),
                    "cadence": live.get("cadence"), "hr": live.get("hr"), "paused": ride.get("paused"),
                })

    def add_history(self, st: dict) -> None:
        """History row for the server-side ride (posted states add their own rows)."""
        now = time.time()
        ride, live = st.get("ride") or {}, st.get("live") or {}
        with self.lock:
            self.history.append({
                "t": round(now, 1), "elapsed_s": ride.get("elapsed_s"), "step": (ride.get("step") or {}).get("index"),
                "target_w": ride.get("target_w"), "power": live.get("power"), "power_3s": live.get("power_3s"),
                "cadence": live.get("cadence"), "hr": live.get("hr"), "paused": ride.get("paused"),
            })

    def get_state(self) -> dict:
        with self.lock:
            age = None if self.state_at is None else round(time.time() - self.state_at, 1)
            return {"state": self.state, "age_s": age, "received_at": self.state_at}

    def get_history(self, seconds: float) -> list[dict]:
        cut = time.time() - seconds
        with self.lock:
            return [h for h in self.history if h["t"] >= cut]


def validate_cmd(body: Any) -> dict:
    if not isinstance(body, dict):
        raise ValueError("body must be an object")
    out: dict = {}
    if "msg" in body:
        msg = str(body["msg"]).strip()
        if msg:
            out["msg"] = " ".join(msg.split())[:280]
    if "set" in body and body["set"] is not None:
        s = body["set"]
        if not isinstance(s, dict):
            raise ValueError("set must be {step, w}")
        step = s.get("step")
        if step != "cur":
            if isinstance(step, str) and step.isdigit():
                step = int(step)
            if not isinstance(step, int) or isinstance(step, bool) or step < 1:
                raise ValueError("set.step must be 'cur' or a 1-based step number")
        w = s.get("w")
        if isinstance(w, float) and w.is_integer():
            w = int(w)
        if not isinstance(w, int) or isinstance(w, bool) or not 0 <= w <= 2000:
            raise ValueError("set.w must be an integer 0..2000")
        out["set"] = {"step": step, "w": w}
    if "edit" in body and body["edit"] is not None:
        e = body["edit"]
        if not isinstance(e, dict) or e.get("op") not in ("insert", "replace", "delete", "duration", "extend", "total"):
            raise ValueError("edit must be {op: insert|replace|delete|duration|extend|total, ...}")
        ed = {"op": e["op"]}
        for k in ("step", "after"):
            if k in e and e[k] is not None:
                v = e[k]
                if v != "cur" and not (isinstance(v, int) and not isinstance(v, bool) and v >= 1):
                    raise ValueError(f"edit.{k} must be 'cur' or a 1-based step number")
                ed[k] = v
        if e["op"] in ("insert", "replace"):
            if not isinstance(e.get("steps"), str) or not e["steps"].strip():
                raise ValueError("edit.steps must be workout text, e.g. '2x(5m 250w, 3m 50%)'")
            ed["steps"] = " ".join(e["steps"].split())[:400]
        if e["op"] == "delete" and "step" not in ed:
            raise ValueError("edit.step required")
        if e["op"] in ("duration", "extend", "total"):
            sec = e.get("seconds")
            if not isinstance(sec, int) or isinstance(sec, bool) or abs(sec) > 6 * 3600 or (e["op"] != "extend" and sec < 1):
                raise ValueError("edit.seconds must be an integer (duration/total >= 1, |extend| <= 21600)")
            ed["seconds"] = sec
            if e["op"] == "total":
                ed["how"] = "scale" if e.get("how") == "scale" else "last"
        out["edit"] = ed
    if not out:
        raise ValueError("need msg, set and/or edit")
    if "msg" in out:
        out["important"] = bool(body.get("important")) or "set" in out or "edit" in out
    return out


class Handler(SimpleHTTPRequestHandler):
    server: "CoachServer"
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
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
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
        if not self.host_ok():
            return self.send_json(421, {"error": "bad host"})
        url = urlsplit(self.path)
        q = parse_qs(url.query)
        p = url.path
        srv = self.server
        if p == "/api/health":
            return self.send_json(200, {"ok": True, "app": "trainer-coach", "version": __version__,
                                        "garmin": srv.garmin_enabled, "ble": srv.hub.ble_enabled})
        if p == "/api/stream":
            return self.stream()
        if p == "/api/live":
            rid = q.get("ride", [None])[0]
            n = int(q.get("n", ["0"])[0] or 0)
            return self.send_json(200, srv.live_payload(rid, n))
        if p == "/api/settings":
            return self.send_json(200, srv.settings_payload())
        if p == "/api/devices":
            return self.send_json(200, srv.hub.status())
        if p == "/api/said":
            return self.send_json(200, {"said": srv.said()})
        if p == "/api/voice":
            return self.send_json(200, {**srv.voice, "mode": srv.settings.get("voiceMode", "all")})
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
                return self.send_json(200, H.detail(r, srv.settings.get("hrZones"), srv.ride_meta(rid)))
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
        if p == "/api/current":
            return self.send_raw_json(read_retry(self.cfg.current) or b"null")
        if p == "/api/coach":
            try:
                since = int(q.get("since", ["0"])[0])
            except ValueError:
                since = 0
            return self.send_json(200, {"cmds": srv.coach.cmds_since(since)})
        if p in ("/api/state", "/api/state/history", "/api/events"):
            if not self.trusted():
                return self.send_json(403, {"error": "forbidden"})
            if p == "/api/state":
                return self.send_json(200, srv.agent_state())
            if p == "/api/state/history":
                secs = float(q.get("seconds", ["300"])[0])
                return self.send_json(200, {"samples": srv.coach.get_history(secs)})
            n = max(1, min(2000, int(q.get("n", ["50"])[0])))
            return self.send_json(200, {"events": [parse_line(x) for x in tail_lines(self.cfg.events_log, n)]})
        if p.startswith("/api/"):
            return self.send_json(404, {"error": "not found"})
        return super().do_GET()

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
        routes = ("/api/event", "/api/coach", "/api/current", "/api/ride", "/api/state", "/api/garmin/upload",
                  "/api/ride/control", "/api/settings", "/api/devices", "/api/voice")
        ride_action = re.fullmatch(r"/api/rides/([\w\-]+)/(garmin|delete)", p)
        if p not in routes and not ride_action:
            return self.send_json(404, {"error": "not found"})
        if not self.trusted():
            return self.send_json(403, {"error": "forbidden"})
        srv = self.server
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
        if p == "/api/event":
            line = " ".join((str((body or {}).get("line", "")) if isinstance(body, dict) else "").splitlines())
            self.log_event(line)
            ev = parse_line(line)
            if ev["type"] == "said":
                srv.on_said(ev["said"])
            return self.send_json(200, {"ok": True})
        if p == "/api/voice":
            try:
                return self.send_json(200, srv.voice_event(str((body or {}).get("event", ""))))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
        if p == "/api/state":
            if not isinstance(body, dict):
                return self.send_json(400, {"error": "state must be an object"})
            srv.coach.put_state(body)
            return self.send_json(200, {"ok": True})
        if p == "/api/coach":
            try:
                fields = validate_cmd(body)
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            result = None
            if "edit" in fields:
                if not (srv.engine.ride and srv.engine.ride.steps):
                    return self.send_json(409, {"error": "workout edits need a structured workout running on the server"})
                try:
                    result = srv.engine.edit(fields["edit"])
                except (ValueError, KeyError, TypeError) as e:
                    return self.send_json(400, {"error": str(e)})
            cmd = srv.coach.add_cmd(fields)
            self.log_event(line_coach(cmd))
            srv.engine.coach(cmd)  # the server-side ride applies msg/set right away
            return self.send_json(200, {**cmd, "result": result} if result else cmd)
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "body must be an object"})
        if p == "/api/ride/control":
            try:
                res = srv.engine.control(str(body.get("action", "")), body)
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            return self.send_json(200, {"ok": True, **res})
        if p == "/api/settings":
            return self.send_json(200, srv.update_settings(body))
        if p == "/api/devices":
            return self.devices(body)
        if p == "/api/ride":
            dest = self.cfg.rides / ((re.sub(r"[^\w\-]+", "", str(body.get("id", "ride"))) or "ride") + ".json")
        elif not body.get("samples"):
            self.cfg.current.unlink(missing_ok=True)
            return self.send_json(200, {"ok": True})
        else:
            dest = self.cfg.current
        atomic_write(dest, json.dumps(body).encode("utf-8"))
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
            return self.send_json(401, {"ok": False, "error": "not signed in, run: trainer-coach login-garmin", "saved": str(path)})
        res = g.upload(path)
        code = 200 if res.get("ok") else 502
        if res.get("ok") and rid:
            self.server.set_ride_meta(rid, {"garmin": res.get("activityId") or True, "garmin_at": int(time.time() * 1000)})
        return self.send_json(code, {**res, "saved": str(path)})


SETTINGS_DEFAULTS = {"ftp": 200, "weight": 0, "beeps": True, "autoGarmin": False, "hrZones": None, "hrMax": None,
                     "hrZonesSrc": None, "cadRange": [85, 95], "voiceMode": "all", "afterWorkout": "hold"}
VOICE_MODES = ("all", "important", "silent")
# spoken commands that change how much the coach talks (checked on every voice transcript)
_UNMUTE = re.compile(r"\b(unmute|voice on|talk to me|speak again|you can talk)\b", re.I)
_MUTE = re.compile(r"\b(mute|quiet|stop talking|shut up|silence|be silent|no talking)\b", re.I)


class CoachServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, cfg: Config, garmin: GarminLink | None = None, quiet: bool = False,
                 ticker: bool = True, devices: bool = True, hub: DeviceHub | None = None):
        self.cfg = cfg
        self.token = cfg.ensure_token()
        self.garmin_enabled = cfg.garmin_enabled if garmin is None else getattr(garmin, "enabled", True)
        self.garmin = garmin or GarminLink(cfg.garmin_tokens, enabled=cfg.garmin_enabled)
        self.coach = CoachState()
        self.log_lock = threading.Lock()
        self.quiet = quiet
        self.stopping = False
        self._said_cache: tuple[float, list] = (-1.0, [])
        self._rides_cache: dict[str, tuple[float, dict]] = {}
        self.settings_lock = threading.Lock()
        # voice: barge counts athlete speech onsets (the page stops TTS when it rises); tts = page speaking
        self.voice = {"barge": 0, "barge_at": None, "tts": False, "tts_at": None, "listener_at": None}
        self.settings = self._load_settings()
        self.hub = hub or DeviceHub(cfg.data / "devices.json", ble_enabled=cfg.ble_enabled,
                                    log=(lambda m: None) if quiet else (lambda m: print("ble:", m, flush=True)))
        self.engine = RideEngine(self.hub, cfg.data, self.log_event, lambda: self.settings)
        self.engine.on_finish = self._after_finish
        super().__init__(("127.0.0.1", cfg.port), Handler)
        self.engine.resume()
        if devices:
            self.hub.start()
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

    def said(self) -> list[dict]:
        """Last 8 voice transcripts, newest first (cached on log mtime)."""
        f = self.cfg.events_log
        try:
            mt = f.stat().st_mtime_ns
        except OSError:
            return []
        if mt != self._said_cache[0]:
            evs = [parse_line(x) for x in tail_lines(f, 400)]
            said = [{"time": e["time"], "text": e["said"], "source": e.get("source")} for e in evs if e["type"] == "said"]
            self._said_cache = (mt, said[-8:][::-1])
        return self._said_cache[1]

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
                if k == "voiceMode" and v not in VOICE_MODES:
                    continue
                if k == "afterWorkout" and v not in ("hold", "grade0"):
                    continue
                new[k] = v
            self.settings = new
            atomic_write(self.settings_file, json.dumps(new).encode())
            self.settings_stored = True
        return self.settings_payload()

    def athlete(self) -> dict:
        s = self.settings
        return {"ftp": s.get("ftp"), "weight_kg": s.get("weight") or None, "hr_zones": s.get("hrZones"),
                "hr_max": s.get("hrMax"), "hr_zones_source": s.get("hrZonesSrc"), "cadence_range": s.get("cadRange")}

    # ---------- state ----------
    def engine_state(self) -> dict:
        st = self.engine.state(self.athlete(), self.said()[:3])
        st["voice"] = {**self.voice, "mode": self.settings.get("voiceMode", "all")}
        return st

    def voice_event(self, ev: str) -> dict:
        now = time.time()
        v = self.voice
        if ev == "speech_start":  # athlete started talking: interrupt coach speech
            v["barge"] += 1
            v["barge_at"] = now
        elif ev in ("tts_start", "tts_end"):
            v["tts"], v["tts_at"] = ev == "tts_start", now
        elif ev == "listening":
            v["listener_at"] = now
        else:
            raise ValueError("event must be speech_start, tts_start, tts_end or listening")
        with self.engine.lock:
            self.engine._bump()
        return dict(v)

    def on_said(self, text: str) -> None:
        """Voice commands that control the coach voice itself."""
        if _UNMUTE.search(text):
            self.update_settings({"voiceMode": "all"})
            self.log_event("VOICE UNMUTED (said)")
        elif _MUTE.search(text):
            self.update_settings({"voiceMode": "silent"})
            self.voice_event("speech_start")  # also cut any sentence in progress
            self.log_event("VOICE MUTED (said)")
        else:
            return
        with self.engine.lock:
            self.engine._bump()

    def agent_state(self) -> dict:
        """What agents see at GET /api/state: the server ride, or a page/simulator that posts its own state."""
        posted = self.coach.get_state()
        if self.engine.ride is None and posted["state"] is not None:
            # a browser-Bluetooth page or the headless simulator owns the ride: report its state,
            # with its real age so agents can tell when it went away
            if posted["state"].get("ride") or posted["age_s"] < 10:
                return posted
        return {"state": self.engine_state(), "age_s": 0.0, "received_at": time.time()}

    def live_payload(self, rid: str | None, n: int) -> dict:
        new_rid, samples = self.engine.samples_since(rid, n)
        reset = new_rid != rid
        total = (0 if reset else n) + len(samples)
        return {"state": self.engine_state(), "ride_id": new_rid, "reset": reset, "samples": samples, "n": total}

    def _after_finish(self, ride: dict) -> None:
        """Auto-upload on the server, so it happens even with no page open."""
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
            return json.loads((self.cfg.rides / "meta" / f"{rid}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def set_ride_meta(self, rid: str, patch: dict) -> None:
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
                if self.engine.ride and self.engine.ride.started:
                    self.coach.add_history(self.engine_state())
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
                ticker: bool = True, devices: bool = True, hub: DeviceHub | None = None) -> CoachServer:
    return CoachServer(cfg or Config(), garmin, quiet, ticker=ticker, devices=devices, hub=hub)


def serve(cfg: Config | None = None) -> None:
    srv = make_server(cfg)
    c = srv.cfg
    print(f"trainer-coach {__version__} on {c.base_url}")
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
