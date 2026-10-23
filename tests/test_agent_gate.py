"""Agent event gate (what wakes the LLM), batching, local rule coach, usage meter."""
import json
import threading
import time

import pytest

from openspin import events as E
from openspin.agent_gate import AgentGate, LocalCoach


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def gate(settings=None):
    clk = Clock()
    s = {"agentGate": {}, **(settings or {})}
    return AgentGate(lambda: s, clock=clk), clk, s


def st(power=200, target=200, cad=90, hr=140, into=60, left=120, paused=False, trainer="ble", hr_on=True,
       zones=(100, 120, 140, 160, 180), hr_max=190, index=2):
    return {"devices": {"trainer": trainer, "hr_connected": hr_on, "hr_name": "Strap", "hr": "Strap" if hr_on else None},
            "athlete": {"ftp": 200, "hr_zones": list(zones) if zones else None, "hr_max": hr_max, "cadence_range": [85, 95]},
            "live": {"power": power, "power_3s": power, "cadence": cad, "hr": hr},
            "ride": {"started": True, "paused": paused, "mode": "workout", "target_w": target, "elapsed_s": 600,
                     "step": {"index": index, "count": 5, "duration_s": 180, "into_s": into, "left_s": left, "free": False},
                     "last30": {"power": power, "cadence": cad, "hr": hr, "hr_delta": 2}}}


def run(g, clk, secs, state_fn):
    for _ in range(secs):
        clk.t += 1
        g.observe(state_fn())


def kinds(g):
    return [e["kind"] for b in g.batches for e in b["events"]]


def texts(g):
    return [e["text"] for b in g.batches for e in b["events"]]


def test_firehose_ride_wakes_far_less():
    """An 85 min ride like the one that woke the agent ~340 times."""
    g, clk, _ = gate()
    l30 = [[0, i, 200, 90, 140, 30, 200] for i in range(30)]
    g.on_event(E.line_ride_start("Ride", 200, 13, 85 * 60))
    feel_at = set(range(200, 5100, 380))
    said_at = set(range(40, 5100, 38))
    steps_at = set(range(0, 5100, 400))
    lines = 1
    for t in range(85 * 60):
        clk.t += 1
        if t % 30 == 0:
            g.on_event(E.line_tick(t, 2, 13, 30, 400, 200, l30, [200])); lines += 1
        if t in said_at:
            g.on_event('SAID (whisper): "this one is fine for now"'); lines += 1
        if t in feel_at:
            g.on_event(E.line_feel("good", 2, l30, 140)); lines += 1
        if t in steps_at:
            g.on_event(E.line_step_end(1, [200], [140], [90], [200])); g.on_event(E.line_step_start(1, 13, 400, 200)); lines += 2
        g.observe(st())
    g.flush(clk.t)
    assert "tick" not in kinds(g)                    # 30 s telemetry never wakes the agent
    assert kinds(g).count("said") == len(said_at)    # transcripts all pass...
    assert len(g.batches) < 0.6 * lines              # ...but coalescing and gating cut wakes a lot
    assert kinds(g).count("status") == 0             # never quiet for 3 min here


def test_coalescing_window():
    g, clk, _ = gate()
    g.on_event("FEEL HARDER | step 2 | 30s 200W | HR 150", clk.t)
    clk.t += 3
    g.on_event('SAID (whisper): "a bit more please coach"', clk.t)
    g.tick(clk.t + 1)
    assert not g.batches                             # still inside the 5 s window
    g.tick(clk.t + 2.5)
    assert len(g.batches) == 1 and [e["kind"] for e in g.batches[0]["events"]] == ["feel", "said"]
    clk.t += 10
    g.on_event("PAUSED (stopped pedaling)", clk.t)
    g.tick(clk.t + 6)
    assert len(g.batches) == 2 and g.ride_wakes == 0  # nothing delivered yet: no agent, no wakes
    g.since(0)
    assert g.ride_wakes == 2
    g.since(0)
    assert g.ride_wakes == 2  # re-reading the same batches is not a new wake


def test_dropped_lines():
    g, clk, _ = gate()
    for line in ["COACH 1 | msg hold", "CUE Rep done. 250 average.", "VOICE ON (whisper)", "GARMIN uploaded",
                 "T+1:00 step 1/2 0:30 in, 0:30 left | tgt 100 | 30s 99W | step avg 98W | HR 120 (+2/30s) | cad 90"]:
        g.on_event(line, clk.t)
    g.flush(clk.t)
    assert not g.batches and g.seen == 5


def test_alerts():
    g, clk, _ = gate()
    run(g, clk, 5, lambda: st())
    run(g, clk, 3, lambda: st(hr=182))               # over the cap (95 % of 190 = 180)
    run(g, clk, 21, lambda: st(cad=78))              # cadence under 85 for 20 s
    run(g, clk, 16, lambda: st(power=180))           # -10 % for 15 s
    run(g, clk, 6, lambda: st(trainer="wait"))       # trainer dropped
    run(g, clk, 6, lambda: st(trainer="ble", hr_on=False))
    g.flush(clk.t)
    al = [e["data"]["alert"] for b in g.batches for e in b["events"] if e["kind"] == "alert"]
    assert al.count("hr_cap") == 1 and al.count("cadence_low") == 1 and al.count("power_dev") == 1
    assert "trainer_lost" in al and "trainer_back" in al and "hr_lost" in al


def test_power_dev_ignores_step_ramp_in_and_rearms():
    g, clk, _ = gate()
    run(g, clk, 30, lambda: st(power=150, into=5))   # first 10 s of a step: ERG still settling
    g.flush(clk.t)
    assert "alert" not in kinds(g)
    run(g, clk, 16, lambda: st(power=150))
    run(g, clk, 3, lambda: st(power=200))            # back on target re-arms
    run(g, clk, 16, lambda: st(power=150))
    g.flush(clk.t)
    assert sum(1 for b in g.batches for e in b["events"] if e["data"].get("alert") == "power_dev") == 2


def test_zone_jump():
    g, clk, _ = gate({"agentGate": {"hr_cap": 250}})
    run(g, clk, 10, lambda: st(hr=125))              # Z2
    run(g, clk, 10, lambda: st(hr=165))              # Z4 within a minute
    g.flush(clk.t)
    assert any(e["data"].get("alert") == "zone_jump" for b in g.batches for e in b["events"])


def test_status_at_most_every_3_min_when_quiet():
    g, clk, _ = gate()
    run(g, clk, 600, lambda: st())
    g.flush(clk.t)
    stamps = [b["ts"] for b in g.batches if b["events"][0]["kind"] == "status"]
    assert len(stamps) == 3 and all(b - a >= 180 for a, b in zip(stamps, stamps[1:]))
    assert texts(g)[0].startswith("T+10:00 step 2/5")


def test_no_alerts_while_paused():
    g, clk, _ = gate()
    run(g, clk, 300, lambda: st(paused=True, cad=0, power=0, hr=185))
    g.flush(clk.t)
    assert not g.batches


def test_long_poll_wakes_on_batch():
    g, clk, _ = gate()
    out = {}

    def waiter():
        out["r"] = g.since(0, wait=10)
    th = threading.Thread(target=waiter)
    th.start()
    time.sleep(0.2)
    g.on_event("FEEL EASIER | step 3 | 30s 250W | HR 170", clk.t)
    g.tick(clk.t + 5)
    th.join(5)
    assert out["r"]["batches"][0]["events"][0]["data"]["feel"] == "easier" and out["r"]["next"] == 1
    assert g.since(1, wait=0)["batches"] == []


# ---------- local coach ----------
def test_local_coach_cues():
    said = []
    clk = Clock()
    s = {"localCoach": {}}
    lc = LocalCoach(lambda: s, lambda t, imp: said.append(t), clock=clk)
    lc.on_event(E.line_ride_start("R", 200, 4, 900))
    lc.on_event(E.line_step_start(1, 4, 180, 250))
    assert said[-1] == "3 minutes at 250 watts"
    steps = [{"free": False, "start_w": 100}, {"free": False, "start_w": 250}, {"free": False, "start_w": 100}, {"free": True, "start_w": None}]
    ride = lambda left, cad=90: {"devices": {}, "athlete": {"cadence_range": [85, 95]}, "live": {"cadence": cad},  # noqa: E731
                                 "ride": {"started": True, "paused": False, "ftp": 200, "steps": steps,
                                          "step": {"index": 2, "count": 4, "duration_s": 180, "left_s": left}}}
    lc.observe(ride(11))
    lc.observe(ride(10))
    lc.observe(ride(10))
    assert said[-1] == "10 seconds. Then 100 watts." and said.count("10 seconds. Then 100 watts.") == 1
    lc.on_event(E.line_step_end(1, [252], [160, 171], [90], [250]))
    assert said[-1] == "Rep done. 252 average, heart rate 171 max."
    lc.on_event(E.line_step_end(2, [100], [140, 128], [88], [100]))
    assert said[-1] == "Recovery heart rate 128, down 43."
    for _ in range(25):
        clk.t += 1
        lc.observe(ride(100, cad=72))
    assert said[-1] == "Cadence 72. Spin up."
    n = len(said)
    for _ in range(60):
        clk.t += 1
        lc.observe(ride(100, cad=72))
    assert len(said) == n  # nagged at most every 2 min
    s["localCoach"] = {"enabled": False}
    lc.on_event(E.line_step_start(3, 4, 60, 300))
    assert len(said) == n and lc.cues == n


# ---------- server wiring ----------
def ride_on(srv, text="1m 50%, 2m 100%, 1m 50%"):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": "G", "text": text}}, headers=srv.bearer)
    srv.req("POST", "/api/ride/control", {"action": "start"}, headers=srv.bearer)
    return srv.server.engine


def tick(srv, n):
    for _ in range(n):
        srv.server.engine.tick(1.0)
        srv.server.after_tick()


def test_server_agent_stream_and_usage(srv):
    assert srv.req("GET", "/api/agent-events")[0] == 403
    ride_on(srv)
    tick(srv, 70)
    srv.server.gate.flush()
    res = srv.req("GET", "/api/agent-events?since=0", headers=srv.bearer)[1]
    ks = [e["kind"] for b in res["batches"] for e in b["events"]]
    assert "ride_start" in ks and "step_end" in ks and "tick" not in ks
    # the agent's own edit does not wake it; the athlete's edit from the UI does
    n = res["next"]
    srv.req("POST", "/api/coach", {"edit": {"op": "extend", "seconds": 30}, "msg": "longer"}, headers=srv.bearer)
    srv.server.gate.flush()
    assert srv.req("GET", f"/api/agent-events?since={n}", headers=srv.bearer)[1]["batches"] == []
    srv.req("POST", "/api/ride/control", {"action": "edit", "edit": {"op": "extend", "seconds": 30}}, headers=srv.page)
    srv.server.gate.flush()
    b = srv.req("GET", f"/api/agent-events?since={n}", headers=srv.bearer)[1]["batches"]
    assert b and b[0]["events"][0]["kind"] == "edit"
    # local cues reach the athlete without counting as wakes
    assert any(m["msg"] == "2 minutes at 200 watts" for m in srv.server.engine.messages)
    # usage meter
    assert srv.req("POST", "/api/agent-usage", {"input_tokens": 1200, "output_tokens": 80, "cache_read_tokens": 9000,
                                                "cost_usd": 0.012, "turns": 1, "model": "small"}, headers=srv.bearer)[0] == 200
    srv.req("POST", "/api/agent-usage", {"input_tokens": 800, "output_tokens": 20, "turns": 1}, headers=srv.bearer)
    ag = srv.client.state()["state"]["ride"]["agent"]
    assert ag["wakes"] >= 2 and ag["local_cues"] >= 2
    assert ag["usage"]["input_tokens"] == 2000 and ag["usage"]["turns"] == 2 and ag["usage"]["model"] == "small"
    assert srv.req("POST", "/api/agent-usage", {"input_tokens": 1}, headers=srv.page)[0] == 200
    rid = srv.req("POST", "/api/ride/control", {"action": "end"}, headers=srv.bearer)[1]["id"]
    row = srv.req("GET", "/api/rides")[1]["rides"][0]
    assert row["id"] == rid and row["agent_wakes"] >= ag["wakes"]
    assert row["agent_tokens"] == 2001 + 100 + 9000 and row["agent_cost_usd"] == pytest.approx(0.012)
    d = srv.req("GET", f"/api/rides/{rid}/detail")[1]
    assert d["agent"]["usage"]["turns"] == 2 and d["agent"]["local_cues"] >= 2


def test_cli_tail_agent(srv, capsys):
    from openspin.cli import main
    srv.server.log_event("FEEL GOOD | step - | 30s 0W | HR -")
    srv.server.gate.flush()
    assert main(["tail", "--agent", "--port", str(srv.port), "--data", str(srv.cfg.data)]) == 0
    out = capsys.readouterr().out
    assert "#1 feel: FEEL GOOD" in out


def test_mcp_wait_for_events_and_report_usage(srv):
    pytest.importorskip("mcp")
    from openspin import mcp_server as M
    M.set_client(srv.client)
    try:
        ride_on(srv)
        srv.server.gate.flush()
        start = M.wait_for_events(None, 0)["next"]

        def later():
            time.sleep(0.3)
            srv.server.log_event("FEEL HARDER | step 1 | 30s 100W | HR 120")
            srv.server.gate.flush()
        threading.Thread(target=later).start()
        res = M.wait_for_events(start, 10)
        assert res["batches"][0]["events"][0]["data"]["feel"] == "harder"
        assert M.report_usage(input_tokens=500, output_tokens=40, model="haiku")["usage"]["input_tokens"] == 500
    finally:
        M.set_client(None)
