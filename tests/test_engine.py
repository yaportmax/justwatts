"""Server-side ride engine: controls, auto-pause, mid-ride edits, persistence, streams."""
import json
import time

import pytest

from justwatts.config import Config
from justwatts.server import make_server


def ctl(srv, action, **kw):
    return srv.req("POST", "/api/ride/control", {"action": action, **kw}, headers=srv.bearer)


def ride(srv, text="1m 50%, 2m 100%, 1m 50%", name="T", sim=True):
    if sim:
        srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer", "on": True}, headers=srv.bearer)
    assert ctl(srv, "load", workout={"name": name, "text": text})[0] == 200
    assert ctl(srv, "start")[0] == 200
    return srv.server.engine


def ticks(eng, n):
    for _ in range(n):
        eng.tick(1.0)


def state(srv):
    return srv.client.state()["state"]


def test_controls_and_targets(srv):
    eng = ride(srv)
    ticks(eng, 10)
    st = state(srv)
    assert st["source"] == "server" and st["ride"]["elapsed_s"] == 10 and st["ride"]["target_w"] == 100
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 100}
    ctl(srv, "adjust", dir=1)
    assert state(srv)["ride"]["target_w"] == 101 and state(srv)["ride"]["intensity"] == 1.01
    ctl(srv, "pause")
    ticks(eng, 5)
    assert state(srv)["ride"]["elapsed_s"] == 10 and state(srv)["ride"]["paused"]
    ctl(srv, "pause")
    ctl(srv, "skip")
    ticks(eng, 1)
    assert state(srv)["ride"]["step"]["index"] == 2
    assert ctl(srv, "warp")[0] == 400
    types = [e["type"] for e in srv.client.events(50)]
    assert types.count("paused") == 1 and "resumed" in types


def test_just_ride_modes(srv):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    ctl(srv, "load", workout=None)
    eng = srv.server.engine
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 0.0}
    ctl(srv, "adjust", dir=1)
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 0.5}
    ctl(srv, "mode", m="w")
    ctl(srv, "adjust", dir=-1)
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 115} and state(srv)["ride"]["mode"] == "erg"


def test_auto_pause_with_real_trainer_mode(srv):
    eng = srv.server.engine
    hub = eng.hub
    hub.mode = "ble"  # pretend a BLE trainer is connected; feed readings by hand
    ctl(srv, "load", workout={"name": "T", "text": "5m 50%"})
    ctl(srv, "start")
    assert state(srv)["ride"]["auto_paused"]  # not pedaling at start
    for _ in range(5):
        hub.r.power, hub.r.cadence, hub.r.last = 120, 85, time.monotonic()
        eng.tick(1.0)
    assert not state(srv)["ride"]["paused"] and state(srv)["ride"]["elapsed_s"] == 5
    hub.r.last = time.monotonic() - 10  # trainer data stops: readings go stale, then auto-pause
    ticks(eng, 4)
    st = state(srv)["ride"]
    assert st["paused"] and st["auto_paused"] and st["elapsed_s"] == 7  # 3 idle ticks before pausing, like the page did
    assert any(e["type"] == "paused" and e["auto"] for e in srv.client.events(20))


def test_finish_archives_and_short_rides_are_dropped(srv):
    srv.server.update_settings({"afterWorkout": "hold"})  # the default is grade0 (ride free)
    eng = ride(srv, "30s 50%")
    ticks(eng, 35)
    st = state(srv)
    assert st["ride"]["overtime"] and st["last_finished"] is None  # plan done: still riding free
    assert st["ride"]["target_w"] == 100  # afterWorkout=hold keeps the last target
    ctl(srv, "end")
    lf = state(srv)["last_finished"]
    assert lf and lf["samples"] == 35
    got = srv.req("GET", f"/api/rides/{lf['id']}")[1]
    assert got["name"] == "T" and len(got["samples"]) == 35 and got["steps"][0]["d"] == 30
    assert any("WORKOUT DONE" in line for _, line in got["events"])
    assert srv.req("GET", "/api/rides")[1]["rides"][0]["id"] == lf["id"]
    assert srv.req("GET", "/api/rides/nope")[0] == 404
    eng = ride(srv, "5m 50%")
    ticks(eng, 3)
    ctl(srv, "end")
    assert state(srv)["notice"] == "Ride too short, not saved"
    assert not eng.current_file.exists()


def test_step_targets_apply_on_server(srv):
    eng = ride(srv)
    ticks(eng, 70)
    srv.client.control("target", step="cur", w=230)
    srv.client.control("target", step=3, w=90)
    st = state(srv)
    assert st["ride"]["target_w"] == 230 and eng.hub.wanted_cmd == {"k": "erg", "w": 230}
    assert [s["override_w"] for s in st["ride"]["steps"]] == [None, 230, 90]


# ---------- mid-ride workout edits ----------
def edit(srv, **e):
    return ctl(srv, "edit", edit=e)


def test_insert_reps_after_current_step(srv):
    eng = ride(srv, "2m 50%, 10m 90%, 5m 50%")
    ticks(eng, 150)  # 30 s into step 2
    srv.client.control("target", step=3, w=95)
    code, res = edit(srv, op="insert", steps="2x(5m 250w, 3m 50%)", after="cur")
    assert code == 200 and res["steps"] == 7 and res["total_s"] == 17 * 60 + 16 * 60
    st = state(srv)["ride"]
    assert [s["duration_s"] for s in st["steps"]] == [120, 600, 300, 180, 300, 180, 300]
    assert [s["start_w"] for s in st["steps"]] == [100, 180, 250, 100, 250, 100, 95]
    assert st["steps"][6]["override_w"] == 95  # override moved with its step
    assert st["step"]["index"] == 2 and st["total_s"] == 33 * 60
    assert "5m 250w, 3m 50%" in st["text"]
    ev = [e for e in srv.client.events(20) if e["type"] == "edit"][-1]
    assert ev["op"] == "insert" and ev["steps"] == 7 and ev["total_s"] == 33 * 60
    ticks(eng, 600)  # rides into the inserted rep
    assert state(srv)["ride"]["step"]["index"] == 3 and state(srv)["ride"]["target_w"] == 250


def test_delete_duration_extend_replace(srv):
    eng = ride(srv, "1m 50%, 4x(3m 110%, 2m 50%), 5m 40%")
    ticks(eng, 90)  # 30 s into step 2 (first rep)
    assert edit(srv, op="delete", step=5)[0] == 200  # drop the 2nd recovery: reps 2 and 3 merge
    st = state(srv)["ride"]
    assert len(st["steps"]) == 9 and [s["duration_s"] for s in st["steps"][2:5]] == [120, 180, 180]
    assert edit(srv, op="extend", seconds=60)[0] == 200
    assert state(srv)["ride"]["steps"][1]["duration_s"] == 240
    assert edit(srv, op="extend", seconds=-600)[0] == 200  # cannot end in the past: ends now
    assert state(srv)["ride"]["steps"][1]["duration_s"] == 30
    ticks(eng, 1)
    assert state(srv)["ride"]["step"]["index"] == 3
    assert edit(srv, op="duration", step=4, seconds=240)[0] == 200
    assert state(srv)["ride"]["steps"][3]["duration_s"] == 240
    assert edit(srv, op="replace", step=4, steps="3x(1m 130%, 1m 50%)")[0] == 200
    st = state(srv)["ride"]
    assert [s["start_w"] for s in st["steps"][3:9]] == [260, 100] * 3
    assert edit(srv, op="replace", step="cur", steps="1m 60%")[0] == 200  # current recovery: keep ridden part
    st = state(srv)["ride"]
    assert st["steps"][2]["duration_s"] == 1 and st["steps"][3]["start_w"] == 120
    assert edit(srv, op="delete", step="cur")[0] == 200
    types = [e["op"] for e in srv.client.events(30) if e["type"] == "edit"]
    assert types == ["delete", "duration", "duration", "duration", "replace", "replace", "delete"]  # at into 0: removed, not ended


def test_edit_validation(srv):
    assert edit(srv, op="insert", steps="2x(5m 250w)")[0] == 400  # no ride on the server
    eng = ride(srv, "2m 50%, 2m 100%, 2m 50%")
    ticks(eng, 150)
    bad = [dict(op="insert", steps="banana"), dict(op="insert", steps="1m 50%", after=1), dict(op="delete", step=1),
           dict(op="delete", step=9), dict(op="duration", step=3), dict(op="warp"),
           dict(op="extend", seconds="x"), dict(op="insert")]
    for b in bad:
        assert edit(srv, **b)[0] == 400, b
    assert len(state(srv)["ride"]["steps"]) == 3


def test_edits_survive_restart(srv, tmp_path):
    eng = ride(srv, "1m 50%, 5m 90%")
    ticks(eng, 80)
    srv.client.control("target", w=170)
    edit(srv, op="insert", steps="3m 200w")
    eng.save()
    cfg = Config(port=srv.port + 50, data=srv.cfg.data)
    s2 = make_server(cfg, quiet=True, ticker=False, devices=False)
    try:
        r = s2.engine.ride
        assert r and r.started and r.paused and r.auto and len(r.samples) == 80
        assert [s["d"] for s in r.steps] == [60, 300, 180] and r.ov == {1: 170}
        st = s2.engine.state({"ftp": 200})["ride"]
        assert st["steps"][1]["start_w"] == 170 and st["steps"][2]["start_w"] == 200
        assert s2.engine.notice == "Ride restored. Pedal to continue."
        last = cfg.events_log.read_text(encoding="utf-8").splitlines()[-1]
        assert "RIDE RESUMED after restart at T+1:20 (80 samples kept)" in last
    finally:
        s2.server_close()


def test_stale_unfinished_ride_is_archived(srv):
    eng = ride(srv, "5m 50%")
    ticks(eng, 20)
    eng.save()
    payload = json.loads(eng.current_file.read_text())
    for x in payload["samples"]:
        x[0] -= 7 * 3600 * 1000
    eng.current_file.write_text(json.dumps(payload))
    s2 = make_server(Config(port=srv.port + 51, data=srv.cfg.data), quiet=True, ticker=False, devices=False)
    try:
        assert s2.engine.ride is None and "old unfinished ride" in s2.engine.notice
        assert any(m["name"].endswith("(recovered)") for m in s2.list_rides())
    finally:
        s2.server_close()


# ---------- streams, settings ----------
def test_live_poll_and_sse(srv):
    eng = ride(srv, "5m 50%")
    ticks(eng, 12)
    code, live = srv.req("GET", "/api/live")
    assert live["reset"] and len(live["samples"]) == 12 and live["n"] == 12
    ticks(eng, 3)
    nxt = srv.req("GET", f"/api/live?ride={live['ride_id']}&n=12")[1]
    assert not nxt["reset"] and len(nxt["samples"]) == 3 and nxt["n"] == 15
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
    conn.request("GET", "/api/stream")
    r = conn.getresponse()
    assert r.getheader("Content-Type") == "text/event-stream"
    line = r.fp.readline()
    assert line.startswith(b"data: ")
    msg = json.loads(line[6:])
    assert msg["state"]["ride"]["name"] == "T" and len(msg["samples"]) == 15
    conn.close()


def test_settings_roundtrip_and_garmin_forced_off(tmp_path):
    from conftest import free_port
    s = make_server(Config(port=free_port(), data=tmp_path / "d"), quiet=True, ticker=False, devices=False)
    try:
        assert s.garmin_enabled is False  # JUSTWATTS_GARMIN=off in tests
        p = s.settings_payload()
        assert p["stored"] is False and p["settings"]["autoGarmin"] is False and p["settings"]["ftp"] == 200
        out = s.update_settings({"ftp": 265, "autoGarmin": True, "weight": 70, "bogus": 1, "hrZones": [100, 120, 140, 160, 180]})
        assert out["settings"]["ftp"] == 265 and out["settings"]["autoGarmin"] is False and "bogus" not in out["settings"]
        assert s.update_settings({"ftp": 9999})["settings"]["ftp"] == 265
        assert s.engine_state()["athlete"]["ftp"] == 265 and s.engine_state()["athlete"]["hr_zones"][0] == 100
    finally:
        s.server_close()



def test_old_files_with_removed_fields_still_load(srv, tmp_path):
    """Rides and settings saved by older versions carry fields that no longer exist: they are ignored."""
    t0 = 1767250800000
    old = {"id": "r-old", "name": "Old", "ftp": 200, "start": t0, "text": "1m 50%", "steps": [{"d": 60, "a": 0.5, "b": 0.5, "u": "%"}],
           "samples": [[t0 + i * 1000, i + 1, 100, 90, 120, 30, 100] for i in range(60)],
           "events": [[t0, "RIDE START Old | FTP 200 | 1 steps, 1:00"], [t0, "FEEL GOOD | step 1 | 30s 100W | HR 120"]],
           "agent": {"wakes": 3, "local_cues": 2, "usage": {"input_tokens": 10}, "seen": True},
           "manual": {"what": "intensity", "step": None, "ts": t0}}
    srv.req("POST", "/api/ride", old, headers=srv.page)
    assert srv.req("GET", "/api/rides")[1]["rides"][0]["id"] == "r-old"
    assert srv.req("GET", "/api/rides/r-old/detail")[1]["summary"]["time_s"] == 60
    assert srv.req("GET", "/api/rides/r-old/fit", raw=True)[0] == 200
    data = tmp_path / "old"
    (data / "coach").mkdir(parents=True)  # the ride in progress, where older versions kept it
    now = int(time.time() * 1000)
    (data / "coach" / "engine.json").write_text(json.dumps({**old, "id": "r-1", "start": now - 60000,
                                                            "samples": [[now - 60000 + i * 1000, i + 1, 100, 90, 0, 30, 100] for i in range(60)]}))
    (data / "settings.json").write_text(json.dumps({"ftp": 230, "voiceMode": "silent", "localCoach": {"enabled": True}, "agentGate": {}}))
    s2 = make_server(Config(port=srv.port + 51, data=data), quiet=True, ticker=False, devices=False)
    try:
        assert s2.engine.ride and len(s2.engine.ride.samples) == 60 and s2.settings["ftp"] == 230
        assert "voiceMode" not in s2.settings and (data / "live" / "engine.json").exists()
    finally:
        s2.server_close()
