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
    env = {**os.environ, "HW_SMOKE_PORT": str(srv.port)}
    p = subprocess.run([node, str(SCRIPT), mode], capture_output=True, text=True, timeout=timeout, env=env, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_page_rides_a_workout_on_the_server_engine(node, srv):
    with FastTicker(srv.server.engine):
        out = run_page(node, srv)
    d = out["during"]
    assert d["meter"].startswith("Agent ") and "local cues" in d["meter"]  # live usage meter in the header
    assert d["target"] == "230" and d["interval"] == "2 / 2"
    assert d["cad"] == "target 85-95 rpm" and d["cadColor"] in ("var(--good)", "var(--warn)")
    # TTS reads new messages: local-coach cues plus the agent message; nothing after mute
    assert "Hold 230" in out["spoken"] and "1 minute at 100 watts" in out["spoken"]
    assert "Quiet message" not in out["spoken"]
    assert out["cancels"] >= 1  # barge-in cancelled speech
    assert out["muteBtn"] == "Unmute"
    assert out["overBadge"].startswith("Workout done") and out["stillRiding"]  # first End tap only arms
    assert out["laps"] == 3 and out["events"]  # 2 steps + the free-ride lap; transcript has the FEEL press
    assert out["sName"] == "Smoke"
    ride = out["histRides"][0]
    assert ride["n"] >= 120 and ride["ov"] == {"1": 230}
    assert "/api/ride/control:load" in out["posts"] and "/api/ride/control:start" in out["posts"]
    assert "/api/ride/control:feel" in out["posts"] and "/api/devices:sim" in out["posts"]
    assert "/api/ride/control:save" in out["posts"] and "/api/settings" in out["posts"]
    assert "/api/garmin/upload" not in out["posts"]  # Garmin off on test servers, so no auto upload
    assert out["settings"]["autoGarmin"] is False
    evs = srv.client.events(100)
    types = [e["type"] for e in evs]
    assert types.count("step_start") == 2 and "feel" in types and "workout_done" in types and types[-1] == "ride_end"
    assert (srv.cfg.rides / f"{ride['id']}.json").exists()


def test_reload_mid_ride_keeps_riding(node, srv):
    """The page is only a view: a fresh page load shows the ride the server kept running."""
    eng = srv.server.engine
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "Long", "text": "20m 60%"}}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "start"}, headers=srv.bearer)
    for _ in range(90):
        eng.tick(1.0)
    srv.client.coach(msg="Old message")
    srv.server.log_event('SAID (whisper): "a bit hard"')
    out = run_page(node, srv, "boot")
    assert out["ride"] == "Long" and out["started"] and out["rideOn"] == ""
    assert out["el"].startswith("1:3")
    assert out["tTxt"] == "Simulated"
    assert out["coachMsg"] == "Old message" and out["spoken"] == []  # shown, but not re-read aloud
    assert "a bit hard" in out["said"]
    assert not [p for p in out["posts"] if "control" in p]  # booting never touches the ride
    assert eng.ride and eng.ride.started and len(eng.ride.samples) == 90
