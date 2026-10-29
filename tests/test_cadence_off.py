"""Cadence off: one setting, shared by Settings and the ride's Adjust sheet.
The page side (no readout, no range, both controls in sync, kept over a reload) is in test_page_controls.py."""


def test_cadence_setting_round_trip(srv):
    assert srv.req("GET", "/api/settings")[1]["settings"]["cadOn"] is True     # on by default
    srv.req("POST", "/api/settings", {"cadOn": "no"}, headers=srv.page)           # only a bool is taken
    assert srv.req("GET", "/api/settings")[1]["settings"]["cadOn"] is True
    srv.req("POST", "/api/settings", {"cadOn": False}, headers=srv.page)
    assert srv.req("GET", "/api/settings")[1]["settings"]["cadOn"] is False
    assert srv.server._load_settings()["cadOn"] is False                         # persisted
