"""Recording guarantees: no lost samples on kill -9, monotonic timestamps through clock jumps,
valid FIT for every scenario, and ride engine edge cases."""
import io
import json
import subprocess
import sys
import textwrap
import time

import pytest

from conftest import REPO
from openspin import history as H
from openspin.config import Config
from openspin.devices import DeviceHub
from openspin.engine import RideEngine
from openspin.server import make_server

CHILD = textwrap.dedent(r"""
    import sys, time
    sys.path.insert(0, sys.argv[1])
    from openspin.config import Config
    from openspin.server import make_server
    srv = make_server(Config(port=0, data=sys.argv[2]), quiet=True, ticker=False, devices=False)
    eng = srv.engine
    srv.hub.set_sim(True)
    eng.control("load", {"workout": {"name": "Kill", "text": "30m 60%"}})
    eng.control("start", {})
    while True:
        eng.tick(1.0)
        print(len(eng.ride.samples), flush=True)   # printed only after the sample is fsync'd
        time.sleep(0.001)
""")


@pytest.mark.parametrize("kill_at", [7, 29, 30, 31, 61, 177])
def test_kill_minus_nine_loses_nothing(tmp_path, kill_at):
    script = tmp_path / "child.py"
    script.write_text(CHILD)
    data = tmp_path / "data"
    p = subprocess.Popen([sys.executable, str(script), str(REPO / "server"), str(data)], stdout=subprocess.PIPE, text=True,
                         env={**__import__("os").environ, "OPENSPIN_BLE": "off", "OPENSPIN_GARMIN": "off"})
    seen = 0
    for line in p.stdout:
        seen = int(line)
        if seen >= kill_at:
            break
    p.kill()  # TerminateProcess on Windows, SIGKILL elsewhere: no cleanup, no atexit
    p.wait(10)
    s2 = make_server(Config(port=0, data=data), quiet=True, ticker=False, devices=False)
    try:
        r = s2.engine.ride
        assert r is not None and r.started and r.paused
        assert seen <= len(r.samples) <= seen + 2, f"saw {seen}, resumed {len(r.samples)}"
        els = [x[1] for x in r.samples]
        assert els == sorted(set(els)) and els[0] == 1.0
        assert r.el == els[-1]
    finally:
        s2.server_close()


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def engine(tmp_path, wall_fn=None, clk=None, mode="sim"):
    clk = clk or Clock()
    hub = DeviceHub(None, ble_enabled=False, clock=clk)
    hub.set_sim(mode == "sim")
    if mode == "ble":
        hub.mode = "ble"
    events = []
    eng = RideEngine(hub, tmp_path, events.append, lambda: {"ftp": 200}, clock=clk,
                     wall=wall_fn or (lambda: 1_767_250_800 + clk.t))
    return eng, clk, events


def ride_ticks(eng, clk, n, feed=None):
    for _ in range(n):
        clk.t += 1
        if feed:
            feed()
        eng.tick(1.0)


def test_timestamps_survive_wall_clock_jumps(tmp_path):
    clk = Clock()
    jump = {"off": 0.0}
    eng, clk, _ = engine(tmp_path, wall_fn=lambda: 1_767_250_800 + clk.t + jump["off"], clk=clk)
    eng.control("load", {"workout": {"name": "J", "text": "10m 50%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 60)
    jump["off"] = -3600          # the clock is set back an hour
    ride_ticks(eng, clk, 60)
    jump["off"] = 7200           # ...then forward two
    ride_ticks(eng, clk, 60)
    ts = [x[0] for x in eng.ride.samples]
    assert all(b - a == 1000 for a, b in zip(ts, ts[1:])), "1 s apart, whatever the wall clock did"


def test_timestamps_strictly_increase_when_ticks_are_faster_than_the_clock(tmp_path):
    eng, clk, _ = engine(tmp_path, wall_fn=lambda: 1_767_250_800.0)  # frozen wall clock
    eng.control("load", {"workout": {"name": "F", "text": "5m 50%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 30)
    ts = [x[0] for x in eng.ride.samples]
    assert all(b > a for a, b in zip(ts, ts[1:]))


def fit_check(ride):
    fitdecode = pytest.importorskip("fitdecode")
    msgs = {}
    with fitdecode.FitReader(io.BytesIO(H.fit_encode(ride)), check_crc=fitdecode.CrcCheck.RAISE) as fr:
        for f in fr:
            if isinstance(f, fitdecode.FitDataMessage):
                msgs.setdefault(f.name, []).append(f)
    secs = len({round(x[0] / 1000) for x in ride["samples"]})
    assert len(msgs["record"]) == secs
    ev = [(e.get_value("event"), e.get_value("event_type")) for e in msgs["event"]]
    assert ev[0] == ("timer", "start") and ev[-1] == ("timer", "stop_all")
    starts = sum(1 for e in ev if e[1] == "start")
    stops = sum(1 for e in ev if e[1] == "stop_all")
    assert starts == stops, "every pause has a matching start"
    ses = msgs["session"][0]
    assert abs(ses.get_value("total_timer_time") - len(ride["samples"])) < 0.01
    return msgs, starts


def finish(eng):
    res = eng.control("end", {})
    return json.loads((eng.rides_dir / f"{res['id']}.json").read_text())


def test_fit_valid_with_pauses(tmp_path):
    eng, clk, _ = engine(tmp_path, mode="ble")
    hub = eng.hub
    eng.control("load", {"workout": {"name": "P", "text": "20m 60%"}})
    eng.control("start", {})

    def pedal():
        hub.r.power, hub.r.cadence, hub.r.last = 120, 88, clk.t

    for chunk in range(4):
        ride_ticks(eng, clk, 120, pedal)
        ride_ticks(eng, clk, 30)          # stops pedaling: auto-pause after 3 s
    ride_ticks(eng, clk, 60, pedal)
    ride = finish(eng)
    msgs, starts = fit_check(ride)
    # after the rider stops: readings go stale after 3 s, then 3 idle ticks pause, so 5 s are recorded
    assert starts == 5 and len(ride["samples"]) == 4 * 125 + 60


@pytest.mark.parametrize("scenario", ["steady", "overtime", "edits", "free_modes", "intensity_max", "ramp_test", "minimal"])
def test_fit_valid_for_every_scenario(tmp_path, scenario):
    eng, clk, _ = engine(tmp_path)
    text = {"ramp_test": "5m 100w, 1m 120w, 1m 140w", "minimal": "10s 50%"}.get(scenario, "2m 50%, 3x(1m 120%, 1m 50%), 2m 40%")
    eng.control("load", {"workout": None if scenario == "free_modes" else {"name": scenario, "text": text, "test": scenario == "ramp_test"}})
    eng.control("start", {})
    if scenario == "edits":
        ride_ticks(eng, clk, 90)
        eng.edit({"op": "insert", "steps": "2x(30s 150%, 30s 50%)"})
        eng.edit({"op": "extend", "seconds": 30})
        eng.edit({"op": "delete", "step": 9})
        eng.edit({"op": "total", "seconds": 600})
    if scenario == "free_modes":
        for m, v in (("g", 3), ("w", 250), ("r", 8)):
            eng.control("free", {"m": m, "value": v})
            ride_ticks(eng, clk, 60)
    if scenario == "intensity_max":
        for _ in range(60):
            eng.control("adjust", {"dir": 1})
        assert eng.ride.k == 1.5
    n = {"overtime": 600, "minimal": 12, "free_modes": 0}.get(scenario, 300)
    ride_ticks(eng, clk, n)
    if scenario == "overtime":
        assert eng.ride.overtime
    ride = finish(eng)
    fit_check(ride)
    if scenario == "intensity_max":
        assert max(x[6] for x in ride["samples"]) == 360  # 120 % x FTP 200 x 1.5


# ---------- ride engine edge cases ----------
def test_skip_on_last_step_goes_to_overtime(tmp_path):
    eng, clk, events = engine(tmp_path)
    eng.control("load", {"workout": {"name": "S", "text": "1m 50%, 1m 60%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 70)
    eng.control("skip", {})
    ride_ticks(eng, clk, 2)
    assert eng.ride.overtime and any(e.startswith("WORKOUT DONE") for e in events)
    eng.control("skip", {})  # skipping in overtime does nothing
    assert eng.ride.overtime


def test_edits_at_a_step_boundary(tmp_path):
    eng, clk, events = engine(tmp_path)
    eng.control("load", {"workout": {"name": "B", "text": "1m 50%, 1m 100%, 1m 50%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 60)  # el = 60.0: exactly the start of step 2
    assert eng.state({}, [])["ride"]["step"]["index"] == 2 and eng.state({}, [])["ride"]["step"]["into_s"] == 0
    eng.edit({"op": "delete", "step": "cur"})  # nothing of it ridden yet: removed, not a 1 s sliver
    st = eng.state({}, [])["ride"]
    assert [s["duration_s"] for s in st["steps"]] == [60, 60] and st["step"]["index"] == 2 and st["target_w"] == 100
    eng.edit({"op": "replace", "step": "cur", "steps": "30s 150%"})
    st = eng.state({}, [])["ride"]
    assert [s["duration_s"] for s in st["steps"]] == [60, 30] and st["target_w"] == 300
    ride_ticks(eng, clk, 1)
    starts = [e for e in events if e.startswith("START step 2/")]
    assert starts[-1].endswith("@300W")  # the replacement got its own START line


def test_zero_and_negative_lengths_are_refused_or_clamped(tmp_path):
    eng, clk, _ = engine(tmp_path)
    eng.control("load", {"workout": {"name": "Z", "text": "1m 50%, 1m 60%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 30)
    with pytest.raises(ValueError):
        eng.edit({"op": "insert", "steps": "0s 50%"})
    eng.edit({"op": "duration", "step": 2, "seconds": 0})
    assert eng.ride.steps[1]["d"] == 1
    eng.edit({"op": "extend", "seconds": -9999})  # cannot end in the past
    assert eng.ride.steps[0]["d"] == 30
    eng.edit({"op": "total", "seconds": 1})       # ends the plan now
    ride_ticks(eng, clk, 2)
    assert eng.ride.overtime


def test_only_step_delete_ends_it_and_last_insert_in_overtime(tmp_path):
    eng, clk, _ = engine(tmp_path)
    eng.control("load", {"workout": {"name": "O", "text": "1m 50%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 1)
    eng.edit({"op": "delete", "step": "cur"})     # the only step: ends now instead of leaving no plan
    ride_ticks(eng, clk, 3)
    assert eng.ride.overtime and len(eng.ride.steps) == 1
    eng.edit({"op": "insert", "steps": "1m 100%"})
    st = eng.state({}, [])["ride"]
    assert not st["overtime"] and st["target_w"] == 200 and st["steps"][1]["free"]


def test_intensity_limits_and_clamped_targets(tmp_path):
    eng, clk, _ = engine(tmp_path)
    eng.control("load", {"workout": {"name": "I", "text": "1m 50%"}})
    for _ in range(200):
        eng.control("adjust", {"dir": -1})
    assert eng.ride.k == 0.5
    with pytest.raises(ValueError):
        eng.control("intensity", {"percent": 151})
    eng.control("intensity", {"percent": 150})
    assert eng.cur_target() == 150
    from openspin import ftms
    assert ftms.cp_command({"k": "erg", "w": 5000}) == bytes([0x05, 0xD0, 0x07])  # never above 2000 W on the wire


def test_ride_resumed_mid_pause_keeps_pause_semantics(tmp_path):
    eng, clk, _ = engine(tmp_path, mode="ble")
    hub = eng.hub
    eng.control("load", {"workout": {"name": "R", "text": "10m 50%"}})
    eng.control("start", {})
    ride_ticks(eng, clk, 45, lambda: setattr(hub.r, "last", clk.t) or setattr(hub.r, "power", 100) or setattr(hub.r, "cadence", 85))
    eng.control("hold", {})
    eng.save()
    eng2, clk2, _ = engine(tmp_path, mode="ble")
    assert eng2.resume()
    r = eng2.ride
    assert r.paused and len(r.samples) == 45 and r.el == 45.0
    ride_ticks(eng2, clk2, 5)
    assert len(r.samples) == 45  # nothing recorded until pedaling
