"""Server-backed history (Python FIT/TCX parity with JS, laps, trends), crash journal, overtime,
workout length, resistance mode, voice mute/barge-in, and the full-control MCP tools."""
import base64
import io
import json

import pytest

from conftest import REPO, run_node
from test_js_core import _ride
from justwatts import ftms
from justwatts import history as H
from justwatts.config import Config
from justwatts.server import make_server

HARNESS = REPO / "tests" / "js" / "harness.mjs"


# ---------- Python ports match the JS ----------
def test_fit_tcx_summary_match_js(node):
    fitdecode = pytest.importorskip("fitdecode")
    r = _ride()
    js_fit, js_tcx = run_node(node, HARNESS, [{"op": "fit", "ride": r}, {"op": "tcx", "ride": r}])
    py = H.fit_encode(r)
    assert py == base64.b64decode(js_fit["b64"])  # byte for byte
    assert H.tcx(r) == js_tcx
    s = H.summarize(r)
    for k in ("dur", "avgP", "np", "IF", "tss", "maxP", "kJ", "avgHR", "maxHR", "avgC", "best60", "zt", "elapsed"):
        assert s[k] == pytest.approx(js_fit["summary"][k]), k
    with fitdecode.FitReader(io.BytesIO(py), check_crc=fitdecode.CrcCheck.RAISE) as fr:
        assert sum(1 for f in fr if isinstance(f, fitdecode.FitDataMessage) and f.name == "record") == 600


def test_laps_detail_and_trends():
    t0 = 1767250800000
    steps = [{"d": 60, "a": 0.5, "b": 0.5, "u": "%"}, {"d": 120, "a": 250, "b": 250, "u": "w"}]
    samples = [[t0 + i * 1000, i + 1, 100 if i < 60 else 250, 90, 120 + i // 10, 30, 100 if i < 60 else 250] for i in range(200)]
    r = {"id": "r-1", "name": "L", "ftp": 200, "start": t0, "steps": steps, "samples": samples,
         "events": [[t0, "RIDE START L | FTP 200 | 2 steps, 3:00"]]}
    laps = H.laps(r)
    assert [(l["index"], l["time_s"], l["avg_w"], l["overtime"]) for l in laps] == [(1, 60, 100, False), (2, 120, 250, False), (3, 20, 250, True)]
    d = H.detail(r, [100, 120, 140, 160, 180])
    assert d["best"]["1m"] == 250 and d["summary"]["time_s"] == 200 and d["hr_zones_s"]["Z2"] > 0
    assert d["events"][0][1].startswith("RIDE START")
    row = H.ride_meta_row(r)
    t = H.trends([row, {**row, "id": "r-2", "start": t0 + 86400000 * 8, "tss": 50, "ftp": 210, "best": {"5m": 260}}],
                 weeks=4, today=__import__("datetime").date(2026, 1, 15))
    assert [w["rides"] for w in t["weeks"]] == [0, 1, 1, 0]  # Thu Jan 1 and Fri Jan 9, weeks start Monday
    assert [f["ftp"] for f in t["ftp_history"]] == [200, 210] and t["best"]["5m"]["w"] == 260


# ---------- server history API ----------
def ctl(srv, action, **kw):
    return srv.req("POST", "/api/ride/control", {"action": action, **kw}, headers=srv.bearer)


def ride(srv, text, n):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer", "on": True}, headers=srv.bearer)
    ctl(srv, "load", workout={"name": "H", "text": text})
    ctl(srv, "start")
    eng = srv.server.engine
    for _ in range(n):
        eng.tick(1.0)
    return eng


def test_history_endpoints(srv):
    ride(srv, "1m 50%, 1m 90%", 60)
    srv.client.coach(msg="Halfway")
    srv.server.log_event('SAID (whisper): "feeling good today"')
    for _ in range(70):
        srv.server.engine.tick(1.0)
    rid = ctl(srv, "end")[1]["id"]
    rows = srv.req("GET", "/api/rides")[1]["rides"]
    assert rows[0]["id"] == rid and rows[0]["time_s"] == 130 and rows[0]["tss"] >= 1 and rows[0]["garmin"] is None
    d = srv.req("GET", f"/api/rides/{rid}/detail")[1]
    assert len(d["laps"]) == 3 and d["laps"][2]["overtime"]
    lines = [l for _, l in d["events"]]
    assert lines[0].startswith("RIDE START") and lines[-1].startswith("RIDE END")
    assert any("Halfway" in l for l in lines) and any("feeling good today" in l for l in lines)
    code, fit, ctype = srv.req("GET", f"/api/rides/{rid}/fit", raw=True)
    assert code == 200 and fit[8:12] == b".FIT"
    assert srv.req("GET", f"/api/rides/{rid}/tcx", raw=True)[1].startswith(b"<?xml")
    code, res = srv.req("POST", f"/api/rides/{rid}/garmin", {}, headers=srv.page)
    assert code == 200 and res["activityId"] == 42 and srv.garmin.uploads[-1][:1] == b"\x0e"
    assert srv.req("GET", "/api/rides")[1]["rides"][0]["garmin"] == 42
    assert srv.req("GET", f"/api/rides/{rid}/detail")[1]["garmin"] == 42
    tr = srv.req("GET", "/api/trends?weeks=4")[1]
    assert tr["weeks"][-1]["rides"] == 1 and tr["ftp_history"][0]["ftp"] == 200
    assert srv.req("POST", f"/api/rides/{rid}/delete", {}, headers=srv.page)[0] == 200
    assert srv.req("GET", "/api/rides")[1]["rides"] == [] and (srv.cfg.rides / "trash" / f"{rid}.json").exists()
    assert srv.req("POST", f"/api/rides/{rid}/delete", {})[0] == 403  # auth still applies


def test_auto_garmin_upload_on_finish(srv):
    srv.server.update_settings({"autoGarmin": True})
    ride(srv, "20s 50%", 25)
    rid = ctl(srv, "end")[1]["id"]
    import time
    for _ in range(100):
        if srv.server.ride_meta(rid).get("garmin"):
            break
        time.sleep(0.05)
    assert srv.server.ride_meta(rid)["garmin"] == 42 and len(srv.garmin.uploads) == 1


def test_save_copy_keeps_riding(srv):
    eng = ride(srv, "5m 50%", 20)
    j = ctl(srv, "save")[1]
    assert j["saved"] and j["samples"] == 20 and eng.ride is not None
    assert srv.req("GET", "/api/rides")[1]["rides"][0]["time_s"] == 20


# ---------- crash safety: every sample is journaled ----------
def test_journal_recovers_samples_after_crash(srv):
    eng = ride(srv, "10m 50%", 47)  # snapshot at 30, 17 more only in the journal
    snap = json.loads(eng.current_file.read_text())
    assert len(snap["samples"]) == 30
    assert len(eng.journal_file.read_text().splitlines()) == 17
    with eng.journal_file.open("a") as f:
        f.write('[1, 2, 3')  # a torn line from a crash mid-write
    s2 = make_server(Config(port=srv.port + 60, data=srv.cfg.data), quiet=True, ticker=False, devices=False)
    try:
        r = s2.engine.ride
        assert len(r.samples) == 47 and r.el == pytest.approx(47, abs=0.2)
    finally:
        s2.server_close()


# ---------- overtime, length, resistance ----------
def edit(srv, **e):
    return srv.req("POST", "/api/coach", {"edit": e}, headers=srv.bearer)


def test_overtime_then_insert_more(srv):
    eng = ride(srv, "1m 50%", 75)
    st = srv.client.state()["state"]["ride"]
    assert st["overtime"] and st["target_w"] == 100
    srv.server.update_settings({"afterWorkout": "grade0"})
    eng.tick(1.0)
    assert srv.client.state()["state"]["ride"]["target_w"] is None and eng.hub.wanted_cmd == {"k": "sim", "g": 0}
    assert edit(srv, op="insert", steps="2m 120%")[0] == 200
    st = srv.client.state()["state"]["ride"]
    assert not st["overtime"] and [s["free"] for s in st["steps"]] == [False, True, False]
    assert st["step"]["index"] == 3 and st["target_w"] == 240 and st["step"]["into_s"] == 0


def test_total_length_last_and_scale(srv):
    eng = ride(srv, "1m 50%, 5m 80%, 4m 60%, 2m 40%", 90)
    assert edit(srv, op="total", seconds=12 * 60 + 300)[0] == 200
    st = srv.client.state()["state"]["ride"]
    assert st["total_s"] == 17 * 60 and st["steps"][-1]["duration_s"] == 420
    assert edit(srv, op="total", seconds=8 * 60)[0] == 200  # drops the last block, trims the next
    st = srv.client.state()["state"]["ride"]
    assert st["total_s"] == 480 and len(st["steps"]) == 3 and st["steps"][-1]["duration_s"] == 120
    assert edit(srv, op="total", seconds=16 * 60, how="scale")[0] == 200
    st = srv.client.state()["state"]["ride"]
    assert st["total_s"] == pytest.approx(960, abs=2) and st["steps"][0]["duration_s"] == 60
    assert ctl(srv, "edit", edit={"op": "total", "seconds": 600})[0] == 200  # the athlete's +/- buttons
    assert srv.client.state()["state"]["ride"]["total_s"] == 600


def test_resistance_mode(srv):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    ctl(srv, "load", workout=None)
    eng = srv.server.engine
    assert ctl(srv, "free", m="r", value=8)[0] == 200
    assert eng.hub.wanted_cmd == {"k": "res", "r": 8.0} and ftms.cp_command(eng.hub.wanted_cmd) == bytes([0x04, 80])
    ctl(srv, "adjust", dir=1)
    st = srv.client.state()["state"]["ride"]
    assert st["mode"] == "resistance" and st["level"] == 8.5
    assert ctl(srv, "free", m="w", value=5000)[0] == 400
    ctl(srv, "free", m="g", value=3.5)
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 3.5}
    assert ctl(srv, "intensity", percent=110)[0] == 200  # allowed on free rides too (no effect)


# ---------- voice: mute by voice, barge-in, important messages ----------
def test_voice_mute_barge_and_important(srv):
    v = srv.req("GET", "/api/voice")[1]
    assert v["mode"] == "all" and v["barge"] == 0
    srv.req("POST", "/api/event", {"line": 'SAID (whisper): "please stop talking"'}, headers=srv.bearer)
    v = srv.req("GET", "/api/voice")[1]
    assert v["mode"] == "silent" and v["barge"] == 1
    srv.req("POST", "/api/event", {"line": 'SAID (whisper): "ok you can talk again"'}, headers=srv.bearer)
    assert srv.req("GET", "/api/voice")[1]["mode"] == "all"
    assert srv.req("POST", "/api/voice", {"event": "speech_start"}, headers=srv.bearer)[1]["barge"] == 2
    assert srv.req("POST", "/api/voice", {"event": "tts_start"}, headers=srv.page)[1]["tts"] is True
    assert srv.req("POST", "/api/voice", {"event": "nope"}, headers=srv.page)[0] == 400
    assert srv.req("POST", "/api/voice", {"event": "tts_end"})[0] == 403
    types = [e.get("state") for e in srv.client.events(10) if e["type"] == "voice"]
    assert types == ["muted", "unmuted"]
    assert srv.client.coach(msg="fyi")["important"] is False
    assert srv.client.coach(msg="drop", step="cur", watts=100)["important"] is True
    assert srv.client.coach(msg="safety", important=True)["important"] is True
    st = srv.client.state()["state"]
    assert st["voice"]["mode"] == "all" and [m["important"] for m in st["messages"]] == [False, True, True]


# ---------- MCP: the agent can do what the athlete can ----------
@pytest.fixture
def mcp(srv):
    pytest.importorskip("mcp")
    from justwatts import mcp_server as M
    M.set_client(srv.client)
    yield M
    M.set_client(None)


def test_mcp_full_control(mcp, srv):
    M = mcp
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    assert M.devices()["trainer"] == "sim"
    M.load_workout("1m 50%, 3m 90%", name="Agent")
    M.ride_control("start")
    eng = srv.server.engine
    for _ in range(70):
        eng.tick(1.0)
    with pytest.raises(M.ToolError, match="end_current"):
        M.load_workout("5m 50%")
    with pytest.raises(M.ToolError, match="confirm"):
        M.ride_control("end")
    M.ride_control("pause")
    assert eng.ride.paused
    M.ride_control("resume")
    assert not eng.ride.paused
    assert M.set_intensity(95)["ok"]
    with pytest.raises(M.ToolError, match="needs a recent FEEL"):
        M.set_intensity(105)
    with pytest.raises(M.ToolError, match="exceeds"):
        M.set_intensity(60)
    assert M.set_workout_length(300)["result"]["total_s"] == 300
    assert M.set_voice_mode("important")["voiceMode"] == "important"
    assert M.update_settings(ftp=230, hr_zone_floors=[100, 120, 140, 160, 180], after_workout="grade0")["ftp"] == 230
    with pytest.raises(M.ToolError):
        M.update_settings(hr_zone_floors=[1, 2])
    assert M.ride_control("save")["saved"]
    M.ride_control("end", confirm=True)
    rows = M.list_rides()
    assert rows[0]["name"] == "Agent"
    assert M.get_ride_detail(rows[0]["id"])["laps"]
    assert "weeks" in M.get_trends(4)
    assert M.upload_ride_to_garmin(rows[0]["id"])["ok"]
    M.load_workout(None)
    with pytest.raises(M.ToolError, match="ceiling"):
        M.free_ride("erg", 600)
    with pytest.raises(M.ToolError, match="FEEL"):
        M.free_ride("grade", 12)
    assert M.free_ride("resistance", 6)["ok"] and eng.hub.wanted_cmd == {"k": "res", "r": 6.0}
