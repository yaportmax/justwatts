"""HTTP API: auth model, event log, state, ride archive, Garmin (mocked), static files."""
import json
import re
import threading

import pytest

from justwatts.config import Config


def test_health_and_static(srv):
    assert srv.req("GET", "/api/health")[1]["ok"] is True
    code, body, ctype = srv.req("GET", "/", raw=True)
    assert code == 200 and b'<script type="module" src="js/app.js">' in body and ctype.startswith("text/html")
    code, body, ctype = srv.req("GET", "/js/core.js", raw=True)
    assert code == 200 and ctype.startswith("text/javascript")  # module scripts need a JS MIME type
    assert srv.req("GET", "/css/app.css", raw=True)[2].startswith("text/css")
    assert srv.req("GET", "/api/nope")[0] == 404


def test_host_header_must_be_local(srv):
    for path in ("/", "/api/health", "/api/rides"):
        assert srv.req("GET", path, host="evil.example:80")[0] == 421
    assert srv.req("POST", "/api/ride/control", {"action": "end"}, headers=srv.page, host="evil.example")[0] == 421
    assert srv.req("GET", "/api/health", host=f"localhost:{srv.port}")[0] == 200


@pytest.mark.parametrize("path", ["/api/ride", "/api/ride/control", "/api/settings", "/api/devices", "/api/garmin/upload"])
def test_writes_need_auth(srv, path):
    body = {"action": "end", "samples": [[1]]}
    assert srv.req("POST", path, body)[0] == 403
    assert srv.req("POST", path, body, headers={"Origin": srv.url})[0] == 403  # missing X-HW
    assert srv.req("POST", path, body, headers={"Origin": "http://evil.example", "X-HW": "1"})[0] == 403
    assert srv.req("POST", path, body, headers={"Authorization": "Bearer wrong"})[0] == 403
    # a valid token from a foreign web origin is still refused
    assert srv.req("POST", path, body, headers={**srv.bearer, "Origin": "http://evil.example"})[0] == 403


@pytest.mark.parametrize("path", ["/api/state", "/api/events"])
def test_reads_need_auth(srv, path):
    assert srv.req("GET", path)[0] == 403
    assert srv.req("GET", path, headers=srv.bearer)[0] == 200
    assert srv.req("GET", path, headers=srv.page)[0] == 200


def test_token_file_created_private(srv):
    tok = srv.cfg.token_file.read_text().strip()
    assert tok == srv.token and len(tok) >= 32
    # restart keeps the same token
    assert Config(port=srv.port, data=srv.cfg.data).ensure_token() == tok


def test_event_log_lines(srv):
    srv.server.log_event("RIDE START Test | FTP 200 | free")
    srv.server.log_event("x" * 1000)
    lines = srv.cfg.events_log.read_text(encoding="utf-8").splitlines()
    assert re.fullmatch(r"\[\d\d:\d\d:\d\d\] RIDE START Test \| FTP 200 \| free", lines[0])
    assert len(lines) == 2 and len(lines[1]) == len("[00:00:00] ") + 400
    evs = srv.req("GET", "/api/events?n=2", headers=srv.bearer)[1]["events"]
    assert len(evs) == 2 and evs[0]["type"] == "ride_start" and evs[1]["type"] == "other"


def test_state(srv):
    idle = srv.req("GET", "/api/state", headers=srv.bearer)[1]
    assert idle["state"]["source"] == "server" and idle["state"]["ride"] is None


def test_ride_archive_atomic(srv):
    ride = {"id": "r-1", "name": "T", "samples": [[1, 1, 100, 90, 0, 30, 100]] * 2000}
    stop = threading.Event()
    seen_bad = []

    def reader():
        while not stop.is_set():
            code, body = srv.req("GET", "/api/rides/r-1")
            if code not in (200, 404) or (code == 200 and not isinstance(body, dict)):
                seen_bad.append((code, type(body)))

    rt = threading.Thread(target=reader)
    rt.start()
    for i in range(30):
        ride["name"] = f"T{i}"
        assert srv.req("POST", "/api/ride", ride, headers=srv.page)[0] == 200
    stop.set()
    rt.join()
    assert not seen_bad
    assert srv.req("GET", "/api/rides/r-1")[1]["name"] == "T29"
    assert not list(srv.cfg.rides.glob("*.tmp")) and not list(srv.cfg.rides.glob(".*.tmp"))  # no temp files left behind


def test_ride_archive_sanitizes_id(srv):
    assert srv.req("POST", "/api/ride", {"id": "../../etc/r-1", "samples": [[1]]}, headers=srv.page)[0] == 200
    files = list(srv.cfg.rides.iterdir())
    assert [f.name for f in files] == ["etcr-1.json"]
    assert json.loads(files[0].read_text())["id"] == "etcr-1"  # stored id = file name (meta paths use it)


def test_bad_json(srv):
    assert srv.req("POST", "/api/ride/control", b"{nope", headers=srv.page)[0] == 400


@pytest.mark.parametrize("path", ["/api/event", "/api/state", "/api/current", "/api/voice"])
def test_removed_endpoints_are_gone(srv, path):
    assert srv.req("POST", path, {}, headers=srv.page)[0] == 404


def test_garmin_upload_mocked(srv):
    fit = b"\x0e\x20" + b"\x00" * 30
    code, body = srv.req("POST", "/api/garmin/upload", fit, headers={**srv.page, "X-Filename": "2026-01-01 Ride/../x.fit"})
    assert code == 200 and body["ok"] and body["activityId"] == 42
    saved = srv.cfg.rides / "2026-01-01 Ride..x.fit"
    assert saved.read_bytes() == fit and srv.garmin.uploads == [fit]
    srv.garmin.result = {"ok": True, "duplicate": True}
    assert srv.req("POST", "/api/garmin/upload", fit, headers=srv.page)[1]["duplicate"] is True
    srv.garmin.result = {"ok": False, "error": "boom"}
    code, body = srv.req("POST", "/api/garmin/upload", fit, headers=srv.page)
    assert code == 502 and body["error"] == "boom" and body["saved"]
    srv.garmin.is_linked = False
    code, body = srv.req("POST", "/api/garmin/upload", fit, headers={**srv.page, "X-Filename": "norm"})
    assert code == 401 and (srv.cfg.rides / "norm.fit").exists()  # FIT is always kept locally


def test_garmin_status_and_zones(srv):
    assert srv.req("GET", "/api/garmin/status")[1] == {"linked": True, "enabled": True}
    assert srv.req("GET", "/api/garmin/zones")[1]["floors"] == [100, 120, 140, 160, 180]
    srv.garmin.zones_value = RuntimeError("not signed in")
    code, body = srv.req("GET", "/api/garmin/zones")
    assert code == 502 and "not signed in" in body["error"]


def test_real_garmin_link_parsing(tmp_path, monkeypatch):
    """GarminLink against a fake garminconnect client (no network)."""
    from justwatts.garmin import GarminLink

    class FakeClient:
        def __init__(self, resp=None, exc=None):
            self.resp, self.exc = resp, exc

        def upload_activity(self, path):
            if self.exc:
                raise self.exc
            return self.resp

        def get_heart_rate_zones(self):
            return [{"sport": "DEFAULT", **{f"zone{i}Floor": i for i in range(1, 6)}},
                    {"sport": "CYCLING", **{f"zone{i}Floor": 100 + i for i in range(1, 6)}, "maxHeartRateUsed": 190}]

    g = GarminLink(tmp_path)
    f = tmp_path / "a.fit"
    f.write_bytes(b"x")
    g._client = FakeClient({"detailedImportResult": {"successes": [{"internalId": 7}], "failures": []}})
    assert g.upload(f) == {"ok": True, "activityId": 7}
    g._client = FakeClient({"detailedImportResult": {"successes": [], "failures": [{"messages": [{"code": 202}]}]}})
    assert g.upload(f) == {"ok": True, "duplicate": True}
    g._client = FakeClient(exc=RuntimeError("409 Conflict"))
    assert g.upload(f)["duplicate"] and g._client is None  # client reset after an error
    g._client = FakeClient(exc=RuntimeError("network down"))
    assert g.upload(f) == {"ok": False, "error": "network down"}
    g._client = FakeClient()
    assert g.zones() == {"floors": [101, 102, 103, 104, 105], "max": 190, "lthr": None}
