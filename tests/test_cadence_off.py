"""Cadence off: one setting (Settings and the ride's Adjust sheet) that also silences the server's cadence cues.
The page side (no readout, no range, both controls in sync, kept over a reload) is in test_page_controls.py."""
from justwatts.agent_gate import AgentGate, LocalCoach


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def low_cadence(cad=70):
    return {"devices": {"trainer": "ble"}, "athlete": {"ftp": 200, "cadence_range": [85, 95]},
            "live": {"power": 200, "power_3s": 200, "cadence": cad},
            "ride": {"started": True, "paused": False, "mode": "workout", "ftp": 200, "target_w": 200, "elapsed_s": 600, "steps": [],
                     "step": {"index": 1, "count": 3, "duration_s": 600, "into_s": 60, "left_s": 300, "free": False}}}


def cues(settings):
    """30 s under the cadence range: what the built-in coach says and what the agent gate raises."""
    said, clk = [], Clock()
    lc = LocalCoach(settings, lambda t, imp: said.append(t), clock=clk)
    g = AgentGate(settings, clock=clk)
    for _ in range(30):
        clk.t += 1
        lc.observe(low_cadence())
        g.observe(low_cadence())
    g.flush(clk.t)
    return said, [e["data"].get("alert") for b in g.batches for e in b["events"] if e["kind"] == "alert"]


def test_cadence_setting_round_trip(srv):
    assert srv.req("GET", "/api/settings")[1]["settings"]["cadOn"] is True     # on by default
    srv.req("POST", "/api/settings", {"cadOn": "no"}, headers=srv.page)           # only a bool is taken
    assert srv.req("GET", "/api/settings")[1]["settings"]["cadOn"] is True
    srv.req("POST", "/api/settings", {"cadOn": False}, headers=srv.page)
    assert srv.req("GET", "/api/settings")[1]["settings"]["cadOn"] is False
    assert srv.server._load_settings()["cadOn"] is False                         # persisted


def test_cadence_off_silences_server_cues(srv):
    s = srv.server
    s.update_settings({"localCoach": {"enabled": True}})
    said, alerts = cues(s.coach_settings)
    assert "Cadence 70. Spin up." in said and "cadence_low" in alerts          # on: the nag and the agent alert
    s.update_settings({"cadOn": False})
    said, alerts = cues(s.coach_settings)
    assert not any("Cadence" in t for t in said) and "cadence_low" not in alerts
    assert s.local.cfg()["cadence"] is False and s.gate.cfg()["cadence_low_s"] == float("inf")  # the live coaches read it too
    assert s.settings["localCoach"].get("cadence", True) is True                # the coach's own option is untouched
