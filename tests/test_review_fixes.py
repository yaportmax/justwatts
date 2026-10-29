"""Fixes from the first real-browser review."""
from justwatts import history as H

from conftest import REPO


def test_best_efforts_never_zero_on_short_rides():
    t0 = 1767250800000
    r = {"id": "r", "name": "x", "ftp": 200, "samples": [[t0 + i * 1000, i + 1, 150, 90, 0, 30, 0] for i in range(90)]}
    assert H.best_efforts([150] * 90) == {"1m": 150, "5m": None, "20m": None}
    assert H.detail(r)["best"] == {"1m": 150, "5m": None, "20m": None}
    assert H.ride_meta_row(r)["best"]["20m"] is None
    assert H.best_efforts([100] * 30) == {"1m": None, "5m": None, "20m": None}


def test_virtual_distance_setting(srv):
    assert srv.server.update_settings({"hideVirtualDistance": True})["settings"]["hideVirtualDistance"] is True


def test_static_markup():
    html = (REPO / "app" / "index.html").read_text(encoding="utf-8")
    assert 'id="srvState" style="display:none" aria-hidden="true"' in html
    for field in ('id="sFtp"', 'id="sWeight"', 'id="sHrZones"', 'id="hrMax"', 'id="virtDist"'):
        assert field in html
    js = (REPO / "app" / "js" / "app.js").read_text(encoding="utf-8")
    assert "'Distance'" in js  # indoor distance from trainer speed, labeled plainly (owner's call)
