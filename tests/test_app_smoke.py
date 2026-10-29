"""Boot the real app/js/app.js under node (stubbed DOM) against a real test server and ride."""
import json
import os
import subprocess
import threading
import time

import pytest

from conftest import REPO

SCRIPT = REPO / "tests" / "js" / "app_smoke.mjs"


class FastTicker:
    """Ticks the server ride engine 50x faster than real time while the page runs."""

    def __init__(self, engine, period=0.02):
        self.engine, self.period, self.stop = engine, period, threading.Event()
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            self.engine.tick(1.0)
            time.sleep(self.period)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        self.stop.set()
        self.t.join()


def run_page(node, srv, mode="ride", timeout=60):
    env = {**os.environ, "JUSTWATTS_SMOKE_PORT": str(srv.port)}
    p = subprocess.run([node, str(SCRIPT), mode], capture_output=True, text=True, timeout=timeout, env=env, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_page_rides_a_workout_on_the_server_engine(node, srv):
    with FastTicker(srv.server.engine):
        out = run_page(node, srv)
    d = out["during"]
    assert d["offline"] == "true"  # the offline badge is hidden from screen readers too
    assert d["target"] == "230" and d["interval"] == "Segment 2 of 2"
    assert d["cad"] == "target 85-95 rpm" and d["cadColor"] in ("var(--good)", "var(--warn)")
    assert out["overBadge"].startswith("Workout done") and out["stillRiding"]  # first End tap only arms
    assert out["laps"] == 3  # 2 steps + the free-ride lap
    assert out["sName"] == "Smoke"
    ride = out["histRides"][0]
    assert ride["n"] >= 120 and ride["ov"] == {"1": 230}
    assert "/api/ride/control:load" in out["posts"] and "/api/ride/control:start" in out["posts"]
    assert "/api/ride/control:target" in out["posts"] and "/api/devices:sim" in out["posts"]
    assert "/api/ride/control:save" in out["posts"] and "/api/settings" in out["posts"]
    assert "/api/garmin/upload" not in out["posts"]  # Garmin off on test servers, so no auto upload
    assert out["settings"]["autoGarmin"] is False
    evs = srv.client.events(100)
    types = [e["type"] for e in evs]
    assert types.count("step_start") == 2 and "manual" in types and "workout_done" in types and types[-1] == "ride_end"
    assert (srv.cfg.rides / f"{ride['id']}.json").exists()


def test_page_picks_course_and_workout_per_ride(node, srv):
    """Workouts tab: a course picked on a workout row. Courses tab: a workout picked on a course row."""
    out = run_page(node, srv, "pick")
    assert out["workoutCourse"] == {"name": "Sweet spot 2x12", "course": "The climb"}
    assert out["courseWorkout"] == {"name": "Sweet spot 2x12", "course": "Rolling hills"}
    assert out["posts"] == [{"w": "Sweet spot 2x12", "c": "s-climb"}, {"w": "Sweet spot 2x12", "c": "s-rolling"}]
    r = srv.server.engine.ride
    assert r.course["name"] == "Rolling hills" and not r.started


def test_reload_mid_ride_keeps_riding(node, srv):
    """The page is only a view: a fresh page load shows the ride the server kept running."""
    eng = srv.server.engine
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "Long", "text": "20m 60%"}}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "start"}, headers=srv.bearer)
    for _ in range(90):
        eng.tick(1.0)
    out = run_page(node, srv, "boot")
    assert out["ride"] == "Long" and out["started"] and out["rideOn"] == ""
    assert out["el"].startswith("1:3")
    assert out["tTxt"] == "Simulated"
    assert not [p for p in out["posts"] if "control" in p]  # booting never touches the ride
    assert eng.ride and eng.ride.started and len(eng.ride.samples) == 90


@pytest.mark.parametrize("moment", ["nothing", "loaded", "riding", "paused", "auto_paused", "overtime", "finished"])
def test_page_reload_at_any_moment(node, srv, moment):
    """A fresh page load shows exactly the server's state and never changes the ride."""
    eng = srv.server.engine
    ctl = lambda a, **kw: srv.req("POST", "/api/ride/control", {"action": a, **kw}, headers=srv.bearer)  # noqa: E731
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    if moment != "nothing":
        ctl("load", workout={"name": "Any", "text": "1m 50%, 1m 80%"})
    if moment not in ("nothing", "loaded"):
        ctl("start")
        for _ in range(150 if moment in ("overtime", "finished") else 30):
            eng.tick(1.0)
    if moment == "paused":
        ctl("hold")
    if moment == "auto_paused":
        srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer", "on": False}, headers=srv.bearer)
        eng.hub.mode = "ble"
        for _ in range(6):
            eng.tick(1.0)
    if moment == "finished":
        ctl("end")
    before = json.dumps(eng.state({})["ride"], sort_keys=True, default=str)
    out = run_page(node, srv, "state")
    assert not [p for p in out["posts"] if "control" in p or "devices" in p]
    ride = out["ride"]
    if moment in ("nothing", "finished"):
        assert ride is None and out["rideOn"] == "none" and out["rideEmpty"] == ""
    else:
        assert out["rideOn"] == "" and ride["name"] == "Any"
        badge = {"loaded": "Ready", "riding": "Riding", "paused": "Paused", "auto_paused": "Start pedaling",
                 "overtime": "Workout done · riding free"}[moment]
        assert out["badge"] == badge
        assert out["start"] == ("" if moment == "loaded" else "none")
        assert out["pause"] == ("Resume" if moment == "paused" else "Pause")  # auto-paused: Pause makes it stick
    after = json.dumps(eng.state({})["ride"], sort_keys=True, default=str)
    assert before == after, "booting a page must not change the ride"


def test_page_integrations_and_upload_panel(node, srv):
    """Settings > Integrations, the Upload panel with nothing connected, connect-with-ride, mixed upload states,
    the manual fallback and Today's planned ride, on the real page against the server (intervals.icu stubbed)."""
    from test_integrations_api import KEY, IcuHttp, J, ride

    srv.garmin.is_linked = False  # nothing connected yet
    rid = ride(srv, "Smoke ride")
    fake = IcuHttp()
    html403 = J(403, {}, {"content-type": "text/html"})
    html403.body = b"<html>blocked</html>"
    fake.upload = [J(201, {"id": "i9", "activities": [{"id": "i9"}]}), J(503, {}), html403, J(401, {}), J(401, {})]
    srv.server.integrations.conns["intervals"].http = fake
    env = {**os.environ, "JUSTWATTS_SMOKE_PORT": str(srv.port), "JUSTWATTS_SMOKE_KEY": KEY, "JUSTWATTS_SMOKE_RIDE": rid}
    p = subprocess.run([node, str(SCRIPT), "connect"], capture_output=True, text=True, timeout=90, env=env, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    s = out["settings"]
    assert s["order"] == ["garmin", "strava", "trainingpeaks", "intervals", "coros", "polar", "suunto", "wahoo"]
    assert s["recommended"] == 1 and s["garminRecommended"] and s["note"] and s["manualHead"] and s["polar"]
    assert s["connectButtons"] == 4  # Garmin, Strava (Just Watts's shared app), TrainingPeaks, intervals.icu
    # nothing connected: one Upload action, a Connect Garmin nudge, the panel with Garmin first and the manual route
    assert out["summary0"] == {"button": "Upload", "cls": "pri", "line": "none", "nudge": ""}
    p0 = out["panel0"]
    assert p0["on"] and p0["title"] == "Upload" and p0["order"][:4] == ["garmin", "strava", "trainingpeaks", "intervals"]
    assert p0["fit"] and p0["steps"] and p0["link"] and p0["connects"] == 4
    assert out["manualCoros"] and out["fitHref"] == f"/api/rides/{rid}/fit"
    # connect from the panel: the form, secrets cleared after submit, the ride uploaded at once
    f = out["form"]
    assert f == {"open": True, "title": "Connect intervals.icu", "fields": True, "keyIsPassword": True, "help": True}
    assert out["cleared"] and out["connectPost"] == [{"ride": rid, "hasKey": True}]
    assert out["summary1"]["button"] == "Uploaded" and out["summary1"]["cls"] == "done" and "intervals.icu Uploaded" in out["summary1"]["line"]
    retrying, blocked, signed_out = out["states"]
    assert "Retrying Retry" in retrying["line"] and retrying["button"] == "Uploading…" and "Retry now" in retrying["panel"]
    assert "Failed Upload by hand" in blocked["line"] and blocked["button"] == "Upload failed"
    assert "Reconnect" in signed_out["line"] and "Reconnect" in signed_out["panel"]
    assert out["fallback"] and out["settingsReconnect"]
    # Today: the planned ride from intervals.icu, ridden in one click
    assert out["today"] and out["loaded"]["name"] == "Tempo" and "10m" in out["loaded"]["text"]
    assert not out["leak"]
    assert [c for c in fake.calls if c[0] == "POST"]  # the upload went to the stub, never a real service
