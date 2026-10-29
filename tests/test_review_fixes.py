"""Fixes from the first real-browser review."""
from justwatts import history as H

from conftest import REPO


def ctl(srv, action, **kw):
    return srv.req("POST", "/api/ride/control", {"action": action, **kw}, headers=srv.page)


def short_ride(srv, name="A", n=30):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.page)
    ctl(srv, "load", workout={"name": name, "text": "10m 50%"})
    ctl(srv, "start")
    for _ in range(n):
        srv.server.engine.tick(1.0)


def test_best_efforts_never_zero_on_short_rides():
    t0 = 1767250800000
    r = {"id": "r", "name": "x", "ftp": 200, "samples": [[t0 + i * 1000, i + 1, 150, 90, 0, 30, 0] for i in range(90)]}
    assert H.best_efforts([150] * 90) == {"1m": 150, "5m": None, "20m": None}
    assert H.detail(r)["best"] == {"1m": 150, "5m": None, "20m": None}
    assert H.ride_meta_row(r)["best"]["20m"] is None
    assert H.best_efforts([100] * 30) == {"1m": None, "5m": None, "20m": None}


def test_coach_bar_starts_clean_each_ride(srv):
    short_ride(srv)
    srv.req("POST", "/api/coach", {"msg": "from ride one"}, headers=srv.bearer)
    assert srv.server.engine_state()["messages"][-1]["msg"] == "from ride one"
    ctl(srv, "end")
    ctl(srv, "load", workout={"name": "B", "text": "5m 50%"})
    ctl(srv, "start")
    assert srv.server.engine_state()["messages"] == []


def test_meter_needs_a_real_agent_this_ride(srv):
    short_ride(srv)
    srv.req("GET", "/api/state", headers=srv.bearer)  # the CLI or curl with the token: not an agent
    st = srv.server.engine_state()
    assert st["ride"]["agent"]["seen"] is False and st["agent"]["connected"] is False
    srv.req("GET", "/api/state", headers={**srv.bearer, "X-JustWatts-Client": "agent"})  # the MCP server
    st = srv.server.engine_state()
    assert st["ride"]["agent"]["seen"] is True and st["agent"]["connected"] is True
    ctl(srv, "end")
    short_ride(srv, "next ride")
    assert srv.server.engine_state()["ride"]["agent"]["seen"] is False  # per ride
    srv.req("GET", "/api/agent-events", headers=srv.bearer)  # long-polling the agent stream counts
    assert srv.server.engine_state()["ride"]["agent"]["seen"] is True


def test_mcp_client_identifies_as_agent():
    import pytest
    pytest.importorskip("mcp")
    from justwatts import mcp_server as M
    from justwatts.client import CoachClient
    c = CoachClient(token="t")
    M.set_client(c)
    try:
        assert M.client().agent is True
    finally:
        M.set_client(None)
    assert CoachClient(token="t").agent is False


def test_virtual_distance_setting(srv):
    assert srv.server.update_settings({"hideVirtualDistance": True})["settings"]["hideVirtualDistance"] is True


def test_static_markup():
    html = (REPO / "app" / "index.html").read_text(encoding="utf-8")
    assert 'id="srvState" style="display:none" aria-hidden="true"' in html
    for field in ('id="sFtp"', 'id="sWeight"', 'id="sHrZones"', 'id="hrMax"', 'id="virtDist"'):
        assert field in html
    js = (REPO / "app" / "js" / "app.js").read_text(encoding="utf-8")
    assert "'Distance'" in js  # indoor distance from trainer speed, labeled plainly (owner's call)
