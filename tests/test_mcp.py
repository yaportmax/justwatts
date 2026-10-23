"""MCP tools against a live test server, with the headless simulator playing the page."""
import json
import os
import sys

import pytest

pytest.importorskip("mcp")
import anyio  # noqa: E402

from conftest import REPO  # noqa: E402
from trainer_coach import mcp_server as M  # noqa: E402
from trainer_coach.simulator import Simulator  # noqa: E402

ToolError = M.ToolError
WORKOUT = "2m 50%, 3m 100%, 2m 120%, 2m 50%"  # FTP 200 -> 100, 200, 240, 100 W


@pytest.fixture
def ride(srv, monkeypatch):
    for k in ("TC_MAX_CHANGE_PCT", "TC_MAX_PCT", "TC_FEEL_GATE_PCT", "TC_FEEL_WINDOW_S", "TC_STALE_S"):
        monkeypatch.delenv(k, raising=False)
    M.set_client(srv.client)
    srv.server.update_settings({"localCoach": {"enabled": False}})  # only agent messages in these tests
    sim = Simulator(srv.client, WORKOUT, ftp=200, speed=0, log=None)
    sim.start()
    for _ in range(150):  # 30 s into step 2
        sim.tick()
    yield sim
    M.set_client(None)


def ticks(sim, n=3):
    for _ in range(n):
        sim.tick()


def test_status(ride):
    st = M.get_ride_status()
    assert st["connected"] is True and st["state_age_s"] < 5
    r = st["ride"]
    assert r["mode"] == "workout" and r["elapsed_s"] == 150 and r["target_w"] == 200
    assert r["current_step"]["index"] == 2 and r["current_step"]["into_s"] == 30 and r["current_step"]["start_w"] == 200
    assert r["next_step"]["index"] == 3 and r["next_step"]["start_w"] == 240
    assert "steps" not in r
    assert st["live"]["hr"] > 60 and st["devices"]["trainer"] == "sim"
    types = [e["type"] for e in st["recent_telemetry"]]
    assert "tick" in types and "step_end" in types
    assert st["last_feel"] is None


def test_workout_profile_history_events(ride):
    w = M.get_workout()
    assert [s["start_w"] for s in w["steps"]] == [100, 200, 240, 100]
    assert w["current_step"] == 2 and w["total_s"] == 540
    prof = M.get_athlete_profile()
    assert prof["ftp"] == 200 and len(prof["hr_zones"]) == 5
    hist = M.get_telemetry_history(600)
    assert len(hist) == 50 and hist[-1]["step"] == 2
    evs = M.get_recent_events(5)
    assert len(evs) == 5 and all("raw" in e for e in evs)
    assert M.get_recent_events(500)[0]["type"] == "ride_start"


def test_send_message(ride):
    res = M.send_message("HR 150, holding 200.")
    assert res["sent"]["msg"] == "HR 150, holding 200."
    ticks(ride, 2)
    assert ride.messages == ["HR 150, holding 200."]
    with pytest.raises(ToolError):
        M.send_message("   ")


def test_set_current_target_applies(ride):
    res = M.set_current_target(210, message="Up to 210")
    assert res["check"]["from_w"] == 200 and res["check"]["step"] == 2
    assert res["sent"]["set"] == {"step": 2, "w": 210}  # resolved step number, not "cur"
    ticks(ride, 3)
    assert ride.applied[-1]["step"] == 2 and ride.applied[-1]["w"] == 210
    st = M.get_ride_status()
    assert st["ride"]["target_w"] == 210 and st["ride"]["current_step"]["override_w"] == 210
    assert any(e["type"] == "coach" and e.get("set") == {"step": 2, "w": 210} for e in M.get_recent_events(20))


def test_guard_max_change(ride):
    with pytest.raises(ToolError, match="exceeds 15% FTP"):
        M.set_current_target(260)
    with pytest.raises(ToolError, match="exceeds"):
        M.set_current_target(150)
    M.set_current_target(170)  # -30 W is exactly 15% of 200


def test_guard_feel_gate(ride):
    with pytest.raises(ToolError, match="FEEL HARDER or GOOD"):
        M.set_step_target(3, 250)
    ride.feel("easier")
    with pytest.raises(ToolError, match="last feel: easier"):
        M.set_step_target(3, 250)
    ride.feel("harder")
    res = M.set_step_target(3, 250)
    assert res["check"]["feel"] == "harder"
    M.set_step_target(3, 220)  # lowering never needs a feel signal


def test_guard_ceiling_past_free_and_range(ride, monkeypatch):
    monkeypatch.setenv("TC_MAX_PCT", "110")
    ride.feel("good")
    with pytest.raises(ToolError, match="ceiling"):
        M.set_step_target(3, 245)  # step already at 240 > 220, so 240 is the ceiling
    M.set_step_target(3, 240)
    with pytest.raises(ToolError, match="already done"):
        M.set_step_target(1, 100)
    with pytest.raises(ToolError, match="out of range"):
        M.set_step_target(9, 100)


def test_guard_paused_and_stale(ride, srv):
    st = srv.client.state()["state"]
    st["ride"]["paused"] = True
    srv.client.post_state(st)
    with pytest.raises(ToolError, match="paused"):
        M.set_current_target(210)
    M.set_current_target(190)  # backing off is fine
    srv.server.coach.state_at -= 60
    with pytest.raises(ToolError, match="old"):
        M.set_current_target(190)
    assert M.get_ride_status()["connected"] is False


def test_guard_free_step(srv):
    M.set_client(srv.client)
    try:
        sim = Simulator(srv.client, "1m free, 1m 50%", ftp=200, speed=0, log=None)
        sim.start()
        ticks(sim, 6)
        with pytest.raises(ToolError, match="free-ride"):
            M.set_current_target(150)
    finally:
        M.set_client(None)


def test_server_down_is_a_tool_error(tmp_path):
    from conftest import free_port
    from trainer_coach.client import CoachClient
    from trainer_coach.config import Config
    M.set_client(CoachClient(Config(port=free_port(), data=tmp_path), token="t"))
    try:
        with pytest.raises(ToolError, match="cannot reach"):
            M.get_ride_status()
    finally:
        M.set_client(None)


def test_playbook_tool():
    text = M.get_coaching_playbook()
    assert "Safety" in text and "FEEL" in text


def _attr(obj, *names):
    for n in names:
        if hasattr(obj, n):
            return getattr(obj, n)
    raise AttributeError(names)


def test_tools_over_mcp_protocol_in_process(ride):
    from mcp import Client

    async def go():
        async with Client(M.mcp) as c:
            names = {t.name for t in (await c.list_tools()).tools}
            res = await c.call_tool("get_athlete_profile", {})
            bad = await c.call_tool("set_current_target", {"watts": 400})
            return names, res, bad

    names, res, bad = anyio.run(go)
    assert {"get_ride_status", "get_recent_events", "get_workout", "set_step_target", "set_current_target",
            "send_message", "get_athlete_profile", "get_telemetry_history", "get_coaching_playbook"} <= names
    assert not _attr(res, "is_error", "isError")
    assert json.loads(res.content[0].text)["ftp"] == 200
    assert _attr(bad, "is_error", "isError") and "refused" in bad.content[0].text


def test_stdio_transport(ride, srv):
    """Spawn `python -m trainer_coach mcp` exactly like an agent client would."""
    from mcp import Client, StdioServerParameters

    env = {**os.environ, "HW_PORT": str(srv.port), "HW_DATA": str(srv.cfg.data),
           "PYTHONPATH": str(REPO / "server")}
    params = StdioServerParameters(command=sys.executable, args=["-m", "trainer_coach", "mcp"], env=env)

    async def go():
        async with Client(params) as c:
            return await c.call_tool("get_workout", {})

    res = anyio.run(go)
    assert not _attr(res, "is_error", "isError")
    assert len(json.loads(res.content[0].text)["steps"]) == 4


# ---------- mid-ride edits through MCP (server-side ride) ----------
@pytest.fixture
def eride(srv, monkeypatch):
    for k in ("TC_MAX_INSERT_S", "TC_MAX_EXTEND_S", "TC_FEEL_GATE_PCT", "TC_MAX_PCT"):
        monkeypatch.delenv(k, raising=False)
    M.set_client(srv.client)
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "E", "text": "2m 50%, 10m 90%, 3m 50%, 10m 90%, 5m 45%"}}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "start"}, headers=srv.bearer)
    eng = srv.server.engine
    for _ in range(150):
        eng.tick(1.0)
    yield eng
    M.set_client(None)


def test_mcp_insert_reps(eride, srv):
    res = M.insert_steps("2x(5m 175w, 3m 50%)", message="Two more reps")
    assert res["check"]["added_s"] == 960 and res["check"]["harder"] is False
    assert res["result"]["steps"] == 9 and res["sent"]["edit"]["after"] == 2  # "cur" resolved to the checked step
    w = M.get_workout()
    assert [s["start_w"] for s in w["steps"]][:7] == [100, 180, 175, 100, 175, 100, 100]
    assert M.get_ride_status()["ride"]["next_step"]["start_w"] == 175


def test_mcp_hard_insert_needs_feel(eride, srv):
    with pytest.raises(ToolError, match="FEEL HARDER or GOOD"):
        M.insert_steps("2x(5m 250w, 3m 50%)")
    srv.req("POST", "/api/ride/control", {"action": "feel", "feel": "harder"}, headers=srv.bearer)
    assert M.insert_steps("2x(5m 250w, 3m 50%)")["check"]["harder"] is True
    with pytest.raises(ToolError, match="ceiling"):
        M.insert_steps("1m 400w")
    with pytest.raises(ToolError, match="per edit"):
        M.insert_steps("40m 50%")
    with pytest.raises(ToolError, match="bad steps"):
        M.insert_steps("banana")


def test_mcp_delete_recovery_needs_feel(eride, srv):
    with pytest.raises(ToolError, match="harder"):
        M.delete_step(3)  # the 3 min recovery
    assert M.delete_step(4)["check"]["harder"] is False  # dropping a work block is easier
    assert len(M.get_workout()["steps"]) == 4
    with pytest.raises(ToolError, match="already done"):
        M.delete_step(1)


def test_mcp_durations(eride, srv):
    assert M.extend_current_step(-120)["result"]["op"] == "extend"
    assert M.get_workout()["steps"][1]["duration_s"] == 480
    with pytest.raises(ToolError, match="max 600s"):
        M.extend_current_step(900)
    with pytest.raises(ToolError, match="harder"):
        M.set_step_duration(3, 60)  # shortening a recovery
    M.set_step_duration(5, 600)
    assert M.get_workout()["steps"][4]["duration_s"] == 600
    r = M.replace_step(4, "4x(2m 95%, 1m 50%)")
    assert r["result"]["steps"] == 12


def test_mcp_edit_needs_server_ride(ride):
    with pytest.raises(ToolError):
        M.insert_steps("5m 50%")  # posted-state simulator ride: the server cannot edit it
