"""Works with no agent and no extras; built-in coach adjustments; Garmin profile import; HR strap
retry; Strava upload (mocked, never the real API); share cards."""
import json
import subprocess
import sys
import textwrap
import time
import urllib.parse

import pytest

from conftest import REPO, FakeGarmin

# ---------- no optional extras installed ----------
NO_EXTRAS = textwrap.dedent(r"""
    import importlib.abc, json, sys, tempfile
    BLOCK = ("mcp", "faster_whisper", "sounddevice", "garminconnect", "numpy")
    class Block(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in BLOCK:
                raise ModuleNotFoundError(f"No module named {name!r}")
            return None
    sys.meta_path.insert(0, Block())
    sys.path.insert(0, sys.argv[1])
    from justwatts.cli import main
    from justwatts.config import Config
    from justwatts.server import make_server
    out = {"mcp_cmd": main(["mcp", "--port", "8797", "--data", tempfile.mkdtemp()]),
           "voice_cmd": main(["voice", "--port", "8797", "--data", tempfile.mkdtemp()])}
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    srv = make_server(Config(port=port, data=tempfile.mkdtemp()), quiet=True, ticker=False)
    eng = srv.engine
    srv.hub.set_sim(True)
    eng.control("load", {"workout": {"name": "Plain", "text": "30s 50%, 30s 100%"}})
    eng.control("start", {})
    for _ in range(70):
        eng.tick(1.0); srv.after_tick()
    res = eng.control("end", {})
    from justwatts import history as H
    r = srv.load_ride(res["id"])
    out.update(saved=res["saved"], samples=len(r["samples"]), fit=H.fit_encode(r)[8:12].decode(),
               cues=r["agent"]["local_cues"], wakes=r["agent"]["wakes"],
               loaded=sorted(m for m in sys.modules if m.split(".")[0] in BLOCK))
    srv.server_close()
    print(json.dumps(out))
""")


def test_runs_and_rides_without_optional_extras(tmp_path):
    script = tmp_path / "noextras.py"
    script.write_text(NO_EXTRAS)
    p = subprocess.run([sys.executable, "-I", str(script), str(REPO / "server")], capture_output=True, text=True,
                       timeout=120, env={**{k: v for k, v in __import__("os").environ.items() if not k.startswith(("JUSTWATTS_", "HW_"))},
                                         "JUSTWATTS_BLE": "off", "JUSTWATTS_GARMIN": "off", "USERPROFILE": str(tmp_path), "HOME": str(tmp_path)})
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout.strip().splitlines()[-1])
    assert out["mcp_cmd"] == 1 and out["voice_cmd"] == 1        # clear message, no crash
    assert out["saved"] and out["samples"] == 70 and out["fit"] == ".FIT"
    assert out["cues"] >= 2 and out["wakes"] == 0                # built-in coach spoke, no agent woke
    assert out["loaded"] == []
    assert "pip install" in p.stderr                             # the hint for the missing extras


# ---------- built-in coach auto-adjust ----------
def ride(srv, text="1m 50%, 5m 100%", n=90):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.page)
    srv.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "S", "text": text}}, headers=srv.page)
    srv.req("POST", "/api/ride/control", {"action": "start"}, headers=srv.page)
    for _ in range(n):
        srv.server.engine.tick(1.0)
        srv.server.after_tick()
    return srv.server.engine


def feel(srv, f):
    srv.req("POST", "/api/ride/control", {"action": "feel", "feel": f}, headers=srv.page)
    srv.server.engine.tick(1.0)
    srv.server.after_tick()


def target(srv):
    return srv.server.engine_state()["ride"]["target_w"]


def test_local_coach_adjusts_without_agent(srv):
    ride(srv)
    assert target(srv) == 200
    feel(srv, "easier")
    assert target(srv) == 190 and srv.server.engine.messages[-1]["msg"] == "Easier: 190 watts."
    feel(srv, "harder")
    assert target(srv) == 195
    feel(srv, "good")
    assert target(srv) == 195
    assert any(l.startswith("CUE set step 2 190W") for _, l in srv.server.engine.ride.events)


def test_local_coach_leaves_targets_to_a_connected_agent(srv):
    ride(srv)
    srv.req("GET", "/api/agent-events", headers=srv.bearer)  # an agent shows up
    assert srv.server.engine_state()["agent"]["connected"]
    feel(srv, "easier")
    assert target(srv) == 200
    srv.server.update_settings({"localCoach": {"auto_adjust": "always"}})
    feel(srv, "easier")
    assert target(srv) == 190


def test_local_coach_hr_cap_eases_once_per_step(srv):
    srv.server.update_settings({"hrMax": 150})  # cap 142; the sim HR reaches ~165 at 100 %
    ride(srv, "30s 50%, 10m 100%", n=400)
    st = srv.server.engine_state()["ride"]
    assert st["target_w"] == 190 and st["steps"][1]["override_w"] == 190
    assert sum(1 for _, l in srv.server.engine.ride.events if "Easing to" in l) == 1


# ---------- Garmin profile import ----------
class ProfileGarmin(FakeGarmin):
    def profile(self):
        return {"floors": [101, 121, 141, 161, 176], "max": 188, "ftp": 247, "weight_kg": 71.5}


def test_garmin_profile_import(tmp_path):
    from conftest import free_port
    from justwatts.config import Config
    from justwatts.server import make_server
    s = make_server(Config(port=free_port(), data=tmp_path), garmin=ProfileGarmin(), quiet=True, ticker=False, devices=True)
    try:
        for _ in range(100):
            if s.settings.get("profileImported"):
                break
            time.sleep(0.02)
        st = s.settings
        assert (st["ftp"], st["ftpSrc"], st["weight"]) == (247, "garmin", 71.5)
        assert st["hrZones"] is None and s.athlete()["hr_zones_source"] == "default"  # Garmin zones only on request
        s.update_settings({"hrZonesSrc": "garmin"})
        s.import_garmin_profile()
        assert (s.settings["hrZones"][0], s.settings["hrMax"]) == (101, 188)
        s.update_settings({"ftp": 230, "ftpSrc": "manual"})
        res = s.import_garmin_profile()
        assert "ftp" not in res["imported"] and s.settings["ftp"] == 230  # what the athlete typed wins
        assert s.import_garmin_profile(force=True)["imported"]["ftp"] == 247
    finally:
        s.server_close()


def test_garmin_link_profile_parsing(tmp_path):
    from justwatts.garmin import GarminLink

    class C:
        def get_heart_rate_zones(self):
            return [{"sport": "CYCLING", **{f"zone{i}Floor": 100 + i for i in range(1, 6)}, "maxHeartRateUsed": 190}]

        def get_userprofile_settings(self):
            return {"userData": {"weight": 72300.0, "functionalThresholdPower": 251}}

    g = GarminLink(tmp_path)
    g._client = C()
    assert g.profile() == {"floors": [101, 102, 103, 104, 105], "max": 190, "lthr": None, "weight_kg": 72.3, "ftp": 251}
    assert GarminLink(tmp_path, enabled=False).upload(tmp_path / "x.fit")["disabled"]


# ---------- HR strap that hides its HR service until it feels a heartbeat ----------
def test_hr_strap_waits_for_heartbeat(tmp_path):
    from test_ftms_devices import FakeBle, until
    from justwatts import ftms
    from justwatts.devices import DeviceHub
    ble = FakeBle()
    misses = {"n": 3}
    orig = ble.BleakClient.start_notify

    async def flaky(self, uuid, cb):
        if uuid == ftms.HR_MEASUREMENT and misses["n"] > 0:
            misses["n"] -= 1
            raise KeyError("Characteristic 00002a37 was not found")
        return await orig(self, uuid, cb)
    ble.BleakClient.start_notify = flaky
    h = DeviceHub(tmp_path / "d.json", ble_enabled=True, ble=ble)
    h.start()
    try:
        h.connect("hr", "TR", "TRACKR")
        until(lambda: h.hr_state == "waiting_heartbeat", "waiting state")
        assert h.status()["hr_state"] == "waiting_heartbeat" and h.error is None
        until(lambda: h.hr_connected, "connected after retries", t=20)
        assert h.status()["hr_state"] == "connected" and misses["n"] == 0
    finally:
        h.stop()


# ---------- Strava (mocked HTTP) ----------
class FakeStrava:
    def __init__(self):
        self.calls = []
        self.upload_error = None

    def __call__(self, method, url, data=None, headers=None):
        self.calls.append((method, url, data, headers or {}))
        if url.endswith("/oauth/token"):
            f = urllib.parse.parse_qs(data.decode())
            assert f["client_secret"] == ["s3cret-value"]
            if f["grant_type"] == ["authorization_code"]:
                return 200, {"access_token": "AT1", "refresh_token": "RT1", "expires_at": time.time() + 3600,
                             "athlete": {"id": 9, "firstname": "Test", "lastname": "Rider"}}
            return 200, {"access_token": "AT2", "refresh_token": "RT2", "expires_at": time.time() + 3600}
        if url.endswith("/uploads"):
            return 201, {"id": 555, "status": "Your activity is still being processed."}
        if "/uploads/555" in url:
            if self.upload_error:
                return 200, {"id": 555, "error": self.upload_error}
            return 200, {"id": 555, "activity_id": 777}
        return 404, {}


@pytest.fixture
def ssrv(tmp_path):
    import threading
    from conftest import SimpleNamespace, free_port, request
    from justwatts.client import CoachClient
    from justwatts.config import Config
    from justwatts.server import make_server
    fake = FakeStrava()
    cfg = Config(port=free_port(), data=tmp_path / "d", app=REPO / "app")
    s = make_server(cfg, garmin=FakeGarmin(), quiet=True, ticker=False, devices=False, strava_http=fake)
    s.strava.sleep = lambda _s: None
    threading.Thread(target=s.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{cfg.port}"
    yield SimpleNamespace(server=s, cfg=cfg, port=cfg.port, fake=fake, client=CoachClient(cfg),
                          page={"Origin": url, "X-HW": "1"}, bearer={"Authorization": f"Bearer {s.token}"},
                          req=lambda *a, **kw: request(cfg.port, *a, **kw))
    s.shutdown()
    s.server_close()


def test_strava_config_is_user_only_and_secret_never_leaks(ssrv):
    t = ssrv
    code, body = t.req("POST", "/api/strava/config", {"client_id": "168528", "client_secret": "s3cret-value"}, headers=t.bearer)
    assert code == 403 and "yourself" in body["error"]  # an agent's token cannot set the secret
    assert t.req("POST", "/api/strava/config", {"client_id": "abc"}, headers=t.page)[0] == 400
    code, st = t.req("POST", "/api/strava/config", {"client_id": "168528", "client_secret": "s3cret-value"}, headers=t.page)
    assert code == 200 and st == {**st, "client_id": "168528", "has_secret": True, "configured": True, "connected": False}
    assert "s3cret" not in json.dumps(t.req("GET", "/api/strava/status")[1])
    t.req("POST", "/api/strava/config", {"client_id": "168528", "client_secret": ""}, headers=t.page)  # keep secret
    assert t.server.strava.status()["has_secret"]
    assert "s3cret" not in t.cfg.events_log.read_text(encoding="utf-8") if t.cfg.events_log.exists() else True


def test_strava_oauth_upload_and_auto(ssrv):
    t = ssrv
    t.req("POST", "/api/strava/config", {"client_id": "168528", "client_secret": "s3cret-value"}, headers=t.page)
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", t.port)
    conn.request("GET", "/api/strava/connect", headers={"Host": f"localhost:{t.port}"})
    r = conn.getresponse()
    loc = r.getheader("Location")
    conn.close()
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(loc).query)
    assert loc.startswith("https://www.strava.com/oauth/authorize")
    assert q["redirect_uri"] == [f"http://localhost:{t.port}/api/strava/callback"] and q["client_id"] == ["168528"]
    assert q["scope"] == ["activity:write,activity:read"]
    code, _, _ = t.req("GET", f"/api/strava/callback?state=bogus&code=x&scope=activity:write", raw=True, host=f"localhost:{t.port}")
    assert code == 302 and t.server.strava.status()["connected"] is False
    conn = http.client.HTTPConnection("127.0.0.1", t.port)
    conn.request("GET", f"/api/strava/callback?state={q['state'][0]}&code=abc&scope=read,activity:write,activity:read",
                 headers={"Host": f"localhost:{t.port}"})
    r = conn.getresponse()
    assert r.status == 302 and "strava=connected" in r.getheader("Location") and r.getheader("Location").startswith("http://127.0.0.1")
    conn.close()
    st = t.req("GET", "/api/strava/status")[1]
    assert st["connected"] and st["athlete"]["name"] == "Test Rider"
    assert json.loads((t.cfg.data / "strava_token.json").read_text())["refresh_token"] == "RT1"
    # a finished ride uploads automatically, with Garmin upload off
    t.server.update_settings({"autoStrava": True, "autoGarmin": False})
    t.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=t.page)
    t.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "Strava ride", "text": "30s 50%, 30s 100%"}}, headers=t.page)
    t.req("POST", "/api/ride/control", {"action": "start"}, headers=t.page)
    for _ in range(65):
        t.server.engine.tick(1.0)
    rid = t.req("POST", "/api/ride/control", {"action": "end"}, headers=t.page)[1]["id"]
    for _ in range(200):
        if t.server.ride_meta(rid).get("strava"):
            break
        time.sleep(0.02)
    assert t.server.ride_meta(rid)["strava"] == 777
    up = next(c for c in t.fake.calls if c[1].endswith("/uploads"))
    body = up[2].decode("latin-1")
    assert up[3]["Authorization"] == "Bearer AT1"
    for field in ('name="data_type"\r\n\r\nfit', f'name="external_id"\r\n\r\n{rid}', 'name="name"\r\n\r\nStrava ride',
                  "Recorded with Just Watts", "NP ", "TSS "):
        assert field in body
    assert body.count(".FIT") == 1
    row = t.req("GET", "/api/rides")[1]["rides"][0]
    assert row["strava"] == 777 and row["garmin"] is None
    # duplicate upload is reported as already there
    t.fake.upload_error = "rid.fit duplicate of <a href='/activities/777'>777</a>"
    code, res = t.req("POST", f"/api/rides/{rid}/strava", {}, headers=t.page)
    assert code == 200 and res["duplicate"] and res["activity_id"] == 777


def test_strava_token_refresh_and_description(ssrv):
    t = ssrv
    t.req("POST", "/api/strava/config", {"client_id": "168528", "client_secret": "s3cret-value"}, headers=t.page)
    from justwatts.strava import _write_private, summary_text
    _write_private(t.cfg.data / "strava_token.json", {"access_token": "OLD", "refresh_token": "RT1", "expires_at": 0, "scope": "activity:write"})
    assert t.server.strava.access_token() == "AT2"
    assert json.loads((t.cfg.data / "strava_token.json").read_text())["refresh_token"] == "RT2"
    d = {"ftp": 200, "summary": {"np": 230, "avg_w": 210, "if": 1.15, "tss": 80, "kJ": 600, "avg_hr": 150, "max_hr": 175},
         "laps": [{"target_w": 250, "avg_w": 248, "free": False}, {"target_w": 100, "avg_w": 101, "free": False},
                  {"target_w": 250, "avg_w": 251, "free": False}]}
    text = summary_text(d, "https://x.example/share/r-1.png", "Strong finish.")
    assert text.splitlines() == ["Strong finish.", "", "NP 230 W | avg 210 W | IF 1.15 | TSS 80 | 600 kJ | HR 150 avg, 175 max",
                                 "Intervals (2): 248, 251 W", "https://x.example/share/r-1.png", "Recorded with Just Watts"]
    assert summary_text(d).endswith("Recorded with Just Watts") and "http" not in summary_text(d)


def test_strava_upload_refused_without_connection(ssrv):
    t = ssrv
    t.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=t.page)
    t.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "X", "text": "30s 50%"}}, headers=t.page)
    t.req("POST", "/api/ride/control", {"action": "start"}, headers=t.page)
    for _ in range(20):
        t.server.engine.tick(1.0)
    rid = t.req("POST", "/api/ride/control", {"action": "end"}, headers=t.page)[1]["id"]
    code, res = t.req("POST", f"/api/rides/{rid}/strava", {}, headers=t.page)
    assert code == 502 and "not connected" in res["error"] and not t.fake.calls


# ---------- share cards ----------
def test_share_card_hosting(ssrv):
    t = ssrv
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 50
    assert t.req("POST", "/api/rides/r-1/card", b"nope", headers=t.page)[0] == 400
    code, res = t.req("POST", "/api/rides/r-1/card", png, headers=t.page)
    assert code == 200 and res["url"] is None
    assert t.req("GET", "/share/r-1.png", host="cards.example.com")[0] == 404  # not public without a base URL
    t.server.update_settings({"shareBaseUrl": "https://cards.example.com/os"})
    code, body, ctype = t.req("GET", "/share/r-1.png", host="cards.example.com", raw=True)
    assert code == 200 and body == png and ctype == "image/png"
    assert t.req("POST", "/api/rides/r-1/card", png, headers=t.page)[1]["url"] == "https://cards.example.com/os/share/r-1.png"
    assert t.req("GET", "/api/rides", host="cards.example.com")[0] == 421  # nothing else is exposed


def test_strava_shared_app_by_default_never_sends_a_secret(tmp_path):
    from justwatts.strava import StravaLink
    calls = []

    def relay(method, url, data=None, headers=None):
        calls.append((url, json.loads(data)))
        if json.loads(data)["grant_type"] == "authorization_code":
            return 200, {"access_token": "AT1", "refresh_token": "RT1", "expires_at": time.time() - 1,
                         "athlete": {"id": 9, "firstname": "Test", "lastname": "Rider"}}
        return 200, {"access_token": "AT2", "refresh_token": "RT2", "expires_at": time.time() + 3600}

    s = StravaLink(tmp_path, http=relay, relay="https://relay.example/api/strava/token")
    st = s.status()
    assert st["configured"] and st["mode"] == "shared" and not st["connected"]
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(s.authorize_url("http://localhost:1/cb")).query)
    assert q["client_id"] == ["168528"]
    s.callback("abc12345", q["state"][0], "read,activity:write")
    assert s.status()["athlete"]["name"] == "Test Rider"
    assert s.access_token() == "AT2"  # expired, refreshed through the relay
    assert [c[0] for c in calls] == ["https://relay.example/api/strava/token"] * 2
    assert all("client_secret" not in c[1] and "client_id" not in c[1] for c in calls)
    # the user's own app takes over and never touches the relay; going back forgets it
    s.configure("12345", "own-secret")
    assert s.status()["mode"] == "own" and not s.status()["connected"]
    s.use_shared()
    assert s.status()["mode"] == "shared" and not (tmp_path / "strava_app.json").exists()
    off = StravaLink(tmp_path / "x", http=relay, relay="off")
    assert not off.status()["configured"]
    with pytest.raises(Exception):
        off.authorize_url("http://localhost:1/cb")
