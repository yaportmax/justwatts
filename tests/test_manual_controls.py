"""Everything the rider can change by hand mid-ride: each control, the edge cases, and that manual
changes win over the built-in coach and agents (and that both see them)."""
import time

import pytest

from justwatts import events as E
from justwatts.config import Config
from justwatts.server import make_server


def ctl(srv, action, page=True, **kw):
    """A control from the rider's page (page=True) or from a token holder (CLI, agent)."""
    return srv.req("POST", "/api/ride/control", {"action": action, **kw}, headers=srv.page if page else srv.bearer)


def ride(srv, text="1m 50%, 2m 100%, 1m 50%", n=0, test=False):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer", "on": True}, headers=srv.bearer)
    assert ctl(srv, "load", page=False, workout={"name": "M", "text": text, "test": test})[0] == 200
    assert ctl(srv, "start", page=False)[0] == 200
    ticks(srv, n)
    return srv.server.engine


def ticks(srv, n):
    for _ in range(n):
        srv.server.engine.tick(1.0)
        srv.server.after_tick()


def st(srv):
    return srv.client.state()["state"]["ride"]


def manual_lines(srv):
    return [e["text"] for e in srv.client.events(200) if e["type"] == "manual"]


# ---------- each control ----------
def test_intensity_logged_as_manual_only_from_the_page(srv):
    eng = ride(srv, n=5)
    assert ctl(srv, "adjust", dir=1)[0] == 200
    assert ctl(srv, "adjust", dir=1, big=True)[0] == 200
    assert st(srv)["intensity"] == 1.06 and st(srv)["target_w"] == 106
    assert ctl(srv, "intensity", percent=95)[0] == 200
    assert ctl(srv, "intensity", page=False, percent=97)[0] == 200  # an agent or the CLI: no MANUAL line
    assert manual_lines(srv) == ["MANUAL intensity 101%", "MANUAL intensity 106%", "MANUAL intensity 95%"]
    m = st(srv)["manual"]
    assert m["what"] == "intensity" and m["ago_s"] < 5
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 97}


def test_step_target_on_a_ramp_shifts_the_ramp(srv):
    eng = ride(srv, text="10m 40-80%, 5m 50%", n=300)  # halfway up the ramp: 120 W of 80..160
    assert st(srv)["target_w"] == 120
    assert ctl(srv, "target", delta=10)[1]["w"] == 130
    s = st(srv)["steps"][0]
    assert (s["start_w"], s["end_w"]) == (90, 170) and s["override_w"] == [90, 170]  # same slope, 10 W up
    ticks(srv, 60)
    assert st(srv)["target_w"] == 138  # still climbing
    assert eng.ride.steps[1]["a"] == 0.5


def test_edit_from_the_current_segment_keeps_what_was_ridden(srv):
    ride(srv, text="10m 40-80%, 5m 50%", n=300)  # halfway up the ramp
    assert ctl(srv, "edit", edit={"op": "rest", "steps": "12m 40-80%, 5m 50%", "after": 1, "with_current": True})[0] == 200
    r = st(srv)
    assert [s["duration_s"] for s in r["steps"]] == [300, 420, 300]
    assert (r["steps"][0]["start_w"], r["steps"][0]["end_w"]) == (80, 120)  # the ridden half is unchanged
    assert r["steps"][1]["end_w"] == 160 and 110 <= r["target_w"] <= 125
    ticks(srv, 2)
    assert st(srv)["step"]["index"] == 2


def test_step_target_is_the_watts_the_trainer_gets_now(srv):
    eng = ride(srv, n=70)  # step 2: 200 W
    ctl(srv, "intensity", percent=110)
    assert st(srv)["target_w"] == 220
    assert ctl(srv, "target", w=250)[1]["w"] == 250
    r = st(srv)
    assert r["target_w"] == 250 and eng.hub.wanted_cmd == {"k": "erg", "w": 250} and r["steps"][1]["manual"]
    assert ctl(srv, "target", delta=-5)[1]["w"] == 245
    assert ctl(srv, "target", step=3, w=90)[0] == 200 and st(srv)["steps"][2]["start_w"] == 90
    assert ctl(srv, "target", step=1, w=90)[0] == 400  # already ridden
    ctl(srv, "intensity", percent=100)  # later intensity changes still scale a step set by hand
    assert st(srv)["target_w"] == round(round(245 / 1.1) * 1.0)
    # an agent's set uses the same meaning: the watts the trainer gets now
    ctl(srv, "intensity", percent=120)
    srv.client.coach(step="cur", watts=200)
    assert st(srv)["target_w"] == 200
    assert manual_lines(srv)[1:4] == ["MANUAL target step 2 250W", "MANUAL target step 2 245W", "MANUAL target step 3 90W"]


def test_skip_and_back(srv):
    ride(srv, n=65)  # 5 s into step 2
    assert ctl(srv, "back")[0] == 200  # first 10 s of a step: back to the previous one
    r = st(srv)
    assert [s["duration_s"] for s in r["steps"]] == [60, 5, 60, 120, 60]
    assert r["step"]["index"] == 3 and r["target_w"] == 100
    ticks(srv, 20)
    assert ctl(srv, "back")[0] == 200  # later in a step: restart it
    r = st(srv)
    assert [s["duration_s"] for s in r["steps"]] == [60, 5, 20, 60, 120, 60] and r["step"]["index"] == 4 and r["step"]["into_s"] == 0
    assert ctl(srv, "skip")[0] == 200  # skipped in its first second: the step leaves the plan
    ticks(srv, 1)
    r = st(srv)
    assert [s["duration_s"] for s in r["steps"]] == [60, 5, 20, 120, 60] and r["step"]["index"] == 4 and r["target_w"] == 200
    ticks(srv, 30)
    assert ctl(srv, "skip")[0] == 200  # later: the step ends now, ride time and plan time stay one clock
    ticks(srv, 1)
    r = st(srv)
    assert [s["duration_s"] for s in r["steps"]] == [60, 5, 20, 31, 60] and r["step"]["index"] == 5
    assert abs(r["el"] - (r["steps"][4]["start_s"] + 1)) < 1.5
    assert manual_lines(srv) == ["MANUAL back step 1", "MANUAL back step 3", "MANUAL skip step 4", "MANUAL skip step 4"]
    types = [e["type"] for e in srv.client.events(200)]
    assert types.count("step_start") == 5  # repeats are steps of their own


def test_back_at_the_very_start_of_a_step_and_at_the_first_step(srv):
    ride(srv, n=60)  # exactly at the start of step 2
    ctl(srv, "back")
    r = st(srv)
    assert [s["duration_s"] for s in r["steps"]] == [60, 60, 120, 60] and r["step"]["index"] == 2 and r["target_w"] == 100
    srv.server.engine.ride.el = 0.0  # step 1, 0 s in: nothing to go back to
    before = [s["duration_s"] for s in st(srv)["steps"]]
    ctl(srv, "back")
    assert [s["duration_s"] for s in st(srv)["steps"]] == before


def test_step_length_in_the_last_seconds_of_a_step(srv):
    ride(srv, n=58)  # 2 s left in step 1
    assert ctl(srv, "edit", edit={"op": "extend", "seconds": 60})[0] == 200
    assert st(srv)["step"]["duration_s"] == 120
    ctl(srv, "edit", edit={"op": "extend", "seconds": -120})  # never ends a step in the past
    r = st(srv)
    assert r["steps"][0]["duration_s"] == 58 and r["step"]["index"] == 2  # ended now, step 2 starts
    assert st(srv)["manual"]["what"] == "edit"


def test_workout_length_and_next_steps_box(srv):
    ride(srv, n=70)
    assert ctl(srv, "edit", edit={"op": "total", "seconds": 240 + 300})[0] == 200
    assert st(srv)["total_s"] == 540
    assert ctl(srv, "edit", edit={"op": "rest", "after": 2, "steps": "3x(1m 120%, 1m 50%), 5m 40%"})[0] == 200
    r = st(srv)
    assert len(r["steps"]) == 2 + 6 + 1 and r["total_s"] == 180 + 360 + 300
    assert ctl(srv, "edit", edit={"op": "rest", "after": 1, "steps": "5m 50%"})[0] == 400  # based on an old step
    assert ctl(srv, "edit", edit={"op": "rest", "after": 2, "steps": "5m bogus"})[0] == 400
    assert ctl(srv, "edit", edit={"op": "rest", "after": 2, "steps": ""})[0] == 200  # the plan ends after this step
    assert len(st(srv)["steps"]) == 2
    assert any(e["type"] == "edit" and e["op"] == "rest" for e in srv.client.events(50))


def test_erg_off_in_a_workout(srv):
    eng = ride(srv, n=70)
    assert ctl(srv, "mode", m="g")[0] == 200
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 0.0} and st(srv)["control"] == "g"
    ctl(srv, "adjust", dir=1)
    ctl(srv, "free", m="g", value=3)
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 3.0}
    assert st(srv)["target_w"] == 200 and st(srv)["intensity"] == 1.0  # the plan still shows its target
    ctl(srv, "mode", m="r")
    ctl(srv, "adjust", dir=-1)
    assert eng.hub.wanted_cmd == {"k": "res", "r": 4.5}
    assert ctl(srv, "free", m="w", value=200)[0] == 400
    ctl(srv, "mode", m="e")
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 200} and st(srv)["control"] == "k"
    assert manual_lines(srv) == ["MANUAL mode grade", "MANUAL grade 0.5%", "MANUAL grade 3.0%", "MANUAL mode level",
                                 "MANUAL level 4.5", "MANUAL mode erg"]


def test_free_steps_ride_by_grade_and_plus_minus_moves_it(srv):
    eng = ride(srv, "1m 50%, 2m free", n=70)
    assert st(srv)["control"] == "g"
    ctl(srv, "adjust", dir=1)
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 0.5} and st(srv)["intensity"] == 1.0


def test_free_ride_value_and_mode(srv):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer", "on": True}, headers=srv.bearer)
    ctl(srv, "load", workout=None)
    ctl(srv, "start")
    eng = srv.server.engine
    ctl(srv, "mode", m="w")
    ctl(srv, "adjust", dir=1, big=True)
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 145}
    ctl(srv, "target", w=180)
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 180}
    assert ctl(srv, "mode", m="x")[0] == 400


# ---------- edge cases ----------
def test_changes_while_paused_apply_and_time_stands_still(srv):
    eng = ride(srv, n=30)
    ctl(srv, "hold")
    ctl(srv, "skip")
    ctl(srv, "adjust", dir=1)
    ctl(srv, "target", w=150)
    el = st(srv)["el"]
    ticks(srv, 5)
    r = st(srv)
    assert r["paused"] and r["el"] == el and r["step"]["index"] == 2 and r["target_w"] == 150
    assert eng.hub.wanted_cmd == {"k": "erg", "w": 150}
    ctl(srv, "resume")
    ticks(srv, 2)
    assert st(srv)["el"] == pytest.approx(el + 2)


def test_pause_during_auto_pause_sticks(srv):
    eng = srv.server.engine
    hub = eng.hub
    hub.mode = "ble"
    ctl(srv, "load", workout={"name": "A", "text": "5m 50%"})
    ctl(srv, "start")
    assert st(srv)["auto_paused"]
    ctl(srv, "adjust", dir=-1)  # changes work while auto-paused too
    assert st(srv)["target_w"] == 99
    ctl(srv, "hold")  # the rider pauses by hand: pedaling must not resume it
    r = st(srv)
    assert r["paused"] and not r["auto_paused"]
    for _ in range(3):
        hub.r.power, hub.r.cadence, hub.r.last = 120, 85, time.monotonic()
        eng.tick(1.0)
    assert st(srv)["paused"] and st(srv)["elapsed_s"] == 0
    ctl(srv, "resume")
    hub.r.power, hub.r.cadence, hub.r.last = 120, 85, time.monotonic()
    eng.tick(1.0)
    assert not st(srv)["paused"] and st(srv)["elapsed_s"] == 1


def test_overtime_controls(srv):
    eng = ride(srv, "1m 50%", n=70)
    assert st(srv)["overtime"] and st(srv)["target_w"] == 100
    ctl(srv, "adjust", dir=1)  # hold: +/- scales the held target
    assert st(srv)["target_w"] == 101 and eng.hub.wanted_cmd == {"k": "erg", "w": 101}
    ctl(srv, "skip")  # nothing to skip
    assert st(srv)["overtime"]
    srv.server.update_settings({"afterWorkout": "grade0"})
    eng.tick(1.0)
    assert st(srv)["control"] == "g" and eng.hub.wanted_cmd == {"k": "sim", "g": 0.0}
    ctl(srv, "adjust", dir=1)  # flat finish: +/- moves the grade
    assert eng.hub.wanted_cmd == {"k": "sim", "g": 0.5}
    ctl(srv, "mode", m="r")
    assert eng.hub.wanted_cmd == {"k": "res", "r": 5.0}
    assert ctl(srv, "target", w=200)[0] == 400  # workout finished: no step to set
    assert ctl(srv, "back")[0] == 200  # ride the last step again
    r = st(srv)
    assert not r["overtime"] and [s["free"] for s in r["steps"]] == [False, True, False] and r["step"]["index"] == 3


def test_next_steps_after_the_plan_ended(srv):
    ride(srv, "1m 50%", n=75)
    assert ctl(srv, "edit", edit={"op": "rest", "steps": ""})[0] == 400  # nothing to add, nothing changed
    assert len(st(srv)["steps"]) == 1 and st(srv)["overtime"]
    assert ctl(srv, "edit", edit={"op": "rest", "steps": "2m 60%"})[0] == 200
    r = st(srv)
    assert not r["overtime"] and [s["duration_s"] for s in r["steps"]] == [60, 15, 120] and r["step"]["index"] == 3


def test_ramp_test_keeps_its_targets(srv):
    ride(srv, "1m 100w, 1m 120w, 1m 140w", n=10, test=True)
    assert ctl(srv, "adjust", dir=1)[0] == 400
    assert ctl(srv, "intensity", percent=110)[0] == 400
    assert st(srv)["intensity"] == 1.0
    assert ctl(srv, "skip")[0] == 200 and ctl(srv, "hold")[0] == 200 and ctl(srv, "resume")[0] == 200
    ticks(srv, 1)
    assert st(srv)["target_w"] == 120


def test_last_seconds_skip_and_target(srv):
    ride(srv, n=59)  # the last second of step 1
    ctl(srv, "target", w=130)
    assert st(srv)["target_w"] == 130
    ticks(srv, 1)
    assert st(srv)["step"]["index"] == 2 and st(srv)["target_w"] == 200  # the change stayed on its step


def test_every_manual_change_survives_a_restart(srv):
    eng = ride(srv, "1m 50%, 2m 100%, 1m 50%, 1m free", n=70)
    ctl(srv, "intensity", percent=105)
    ctl(srv, "target", w=240)
    ctl(srv, "target", step=3, w=90)
    ctl(srv, "edit", edit={"op": "extend", "seconds": 30})
    ctl(srv, "mode", m="g")
    ctl(srv, "free", m="g", value=2)
    before = st(srv)
    cfg = Config(port=srv.port + 52, data=srv.cfg.data)
    s2 = make_server(cfg, quiet=True, ticker=False, devices=False)
    try:
        after = s2.engine.state({"ftp": 200})["ride"]
        for k in ("intensity", "jr", "control", "ov", "total_s", "steps"):
            assert after[k] == before[k], k
        assert after["manual"]["what"] == "grade" and s2.engine.ride.manual == eng.ride.manual
    finally:
        s2.server_close()


# ---------- manual wins, coaches see it ----------
def test_local_coach_leaves_a_step_set_by_hand_alone(srv):
    srv.server.update_settings({"hrMax": 150, "localCoach": {"enabled": True}})  # sim HR climbs past the cap
    ride(srv, "1m 50%, 10m 100%", n=62)
    ctl(srv, "target", w=210)
    ticks(srv, 200)
    cues = [e["text"] for e in srv.client.events(400) if e["text"].startswith("CUE set")]
    assert cues == [] and st(srv)["target_w"] == 210


def test_local_coach_hr_guard_still_works_without_manual_changes(srv):
    srv.server.update_settings({"hrMax": 150, "localCoach": {"enabled": True}})
    ride(srv, "1m 50%, 10m 100%", n=262)
    assert [e for e in srv.client.events(400) if e["text"].startswith("CUE set step 2")]
    assert st(srv)["target_w"] < 200


def test_agent_stream_sees_manual_changes_coalesced(srv):
    ride(srv, n=5)
    srv.server.gate.flush()
    n = srv.server.gate.seq
    for _ in range(4):
        ctl(srv, "adjust", dir=1)
    ctl(srv, "skip")
    srv.server.gate.flush()
    evs = [e for b in srv.server.gate.since(n)["batches"] for e in b["events"] if e["kind"] == "manual"]
    assert [e["text"] for e in evs] == ["MANUAL intensity 104%", "MANUAL skip step 1"]
    assert evs[0]["data"] == {"type": "manual", "action": "intensity", "detail": "104%"}


def test_mcp_waits_after_a_manual_change(srv):
    pytest.importorskip("mcp")
    from justwatts import mcp_server as M
    M.set_client(srv.client)
    try:
        eng = ride(srv, "2m 50%, 5m 100%, 2m 50%", n=130)
        ctl(srv, "adjust", dir=-1)
        for call in (lambda: M.set_current_target(190), lambda: M.set_intensity(98),
                     lambda: M.extend_current_step(30), lambda: M.set_step_target(3, 95)):
            with pytest.raises(M.ToolError, match="by hand"):
                call()
        eng.ride.manual["ts"] -= 61_000  # a minute later the agent may coach again
        assert M.set_step_target(3, 95)["sent"]
        ctl(srv, "target", step=3, w=90)
        eng.ride.manual["ts"] -= 61_000
        with pytest.raises(M.ToolError, match="set step 3 by hand"):
            M.set_step_target(3, 100)
        assert M.set_current_target(190)["sent"]
    finally:
        M.set_client(None)


def test_manual_line_parses_the_same_in_js(node):
    from conftest import REPO
    import json
    import subprocess
    src = REPO / "app/js/web/lines.js"
    lines = ["MANUAL intensity 105%", "MANUAL skip step 3", "MANUAL target step 2 250W", "MANUAL back step 1",
             "EDIT rest after step 2: 5m 50% | 3 steps, 9:00"]
    code = f"import {{ parseLine }} from {json.dumps(src.as_uri())}; console.log(JSON.stringify({json.dumps(lines)}.map(l => parseLine(l))));"
    out = json.loads(subprocess.run([node, "--input-type=module", "-e", code], capture_output=True, text=True, check=True).stdout)
    for line, js in zip(lines, out):
        py = E.parse_line(line)
        assert js["type"] == py["type"] and {k: js[k] for k in js if k not in ("time", "raw", "text")} == \
            {k: py[k] for k in py if k not in ("time", "raw", "text")}
