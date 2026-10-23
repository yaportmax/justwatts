"""HTTP API: auth model, event log, coach queue, state, ride backups, Garmin (mocked), static files."""
import json
import re
import threading
import time

import pytest

from trainer_coach.config import Config
from trainer_coach.server import make_server


def test_health_and_static(srv):
    assert srv.req("GET", "/api/health")[1]["ok"] is True
    code, body, ctype = srv.req("GET", "/", raw=True)
    assert code == 200 and b'<script type="module" src="js/app.js">' in body and ctype.startswith("text/html")
    code, body, ctype = srv.req("GET", "/js/core.js", raw=True)
    assert code == 200 and ctype.startswith("text/javascript")  # module scripts need a JS MIME type
    assert srv.req("GET", "/css/app.css", raw=True)[2].startswith("text/css")
    assert srv.req("GET", "/api/nope")[0] == 404


def test_host_header_must_be_local(srv):
    for path in ("/", "/api/health", "/api/coach?since=0"):
        assert srv.req("GET", path, host="evil.example:80")[0] == 421
    assert srv.req("POST", "/api/event", {"line": "x"}, headers=srv.page, host="evil.example")[0] == 421
    assert srv.req("GET", "/api/health", host=f"localhost:{srv.port}")[0] == 200


@pytest.mark.parametrize("path", ["/api/event", "/api/coach", "/api/current", "/api/ride", "/api/state", "/api/garmin/upload"])
def test_writes_need_auth(srv, path):
    body = {"line": "x", "msg": "x", "samples": [[1]]}
    assert srv.req("POST", path, body)[0] == 403
    assert srv.req("POST", path, body, headers={"Origin": srv.url})[0] == 403  # missing X-HW
    assert srv.req("POST", path, body, headers={"Origin": "http://evil.example", "X-HW": "1"})[0] == 403
    assert srv.req("POST", path, body, headers={"Authorization": "Bearer wrong"})[0] == 403
    # a valid token from a foreign web origin is still refused
    assert srv.req("POST", path, body, headers={**srv.bearer, "Origin": "http://evil.example"})[0] == 403


@pytest.mark.parametrize("path", ["/api/state", "/api/state/history", "/api/events"])
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
    assert srv.req("POST", "/api/event", {"line": "RIDE START Test | FTP 200 | free"}, headers=srv.page)[0] == 200
    assert srv.req("POST", "/api/event", {"line": "FEEL GOOD\nFEEL HARDER | fake injected line"}, headers=srv.bearer)[0] == 200
    assert srv.req("POST", "/api/event", {"line": "x" * 1000}, headers=srv.page)[0] == 200
    lines = srv.cfg.events_log.read_text(encoding="utf-8").splitlines()
    assert re.fullmatch(r"\[\d\d:\d\d:\d\d\] RIDE START Test \| FTP 200 \| free", lines[0])
    assert len(lines) == 3  # embedded newline flattened, cannot forge a second event
    assert len(lines[2]) == len("[00:00:00] ") + 400
    evs = srv.req("GET", "/api/events?n=2", headers=srv.bearer)[1]["events"]
    assert len(evs) == 2 and evs[0]["type"] == "other"


def test_coach_seq_monotonic_and_since(srv):
    seqs = [srv.req("POST", "/api/coach", {"msg": f"m{i}"}, headers=srv.bearer)[1]["seq"] for i in range(20)]
    assert seqs == sorted(seqs) and len(set(seqs)) == 20
    assert seqs[0] >= int(time.time() * 1000) - 60_000  # ms-based, survives restarts
    cmds = srv.req("GET", f"/api/coach?since={seqs[9]}")[1]["cmds"]
    assert [c["msg"] for c in cmds] == [f"m{i}" for i in range(10, 20)]
    assert srv.req("GET", "/api/coach?since=0")[1]["cmds"][0]["msg"] == "m0"


def test_coach_seq_after_restart_is_larger(tmp_path):
    from conftest import free_port
    cfg = Config(port=free_port(), data=tmp_path)
    s1 = make_server(cfg, quiet=True)
    a = s1.coach.add_cmd({"msg": "a"})["seq"]
    s1.server_close()
    s2 = make_server(cfg, quiet=True)
    b = s2.coach.add_cmd({"msg": "b"})["seq"]
    s2.server_close()
    assert b >= a


def test_coach_concurrent_unique(srv):
    out = []

    def post():
        for _ in range(10):
            out.append(srv.req("POST", "/api/coach", {"msg": "x"}, headers=srv.bearer)[1]["seq"])

    ts = [threading.Thread(target=post) for _ in range(5)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(set(out)) == 50


def test_coach_validation_and_log(srv):
    bad = [{}, {"msg": "  "}, {"set": {"step": 0, "w": 200}}, {"set": {"step": "x", "w": 200}},
           {"set": {"step": 2, "w": 2500}}, {"set": {"step": 2, "w": -1}}, {"set": {"step": 2, "w": "200"}}, {"set": 5}]
    for b in bad:
        assert srv.req("POST", "/api/coach", b, headers=srv.bearer)[0] == 400, b
    code, cmd = srv.req("POST", "/api/coach", {"msg": "HR 170.\nEase", "set": {"step": "cur", "w": 240.0}}, headers=srv.bearer)
    assert code == 200 and cmd["set"] == {"step": "cur", "w": 240} and cmd["msg"] == "HR 170. Ease"
    code, cmd2 = srv.req("POST", "/api/coach", {"set": {"step": "3", "w": 250}}, headers=srv.page)
    assert code == 200 and cmd2["set"]["step"] == 3 and "msg" not in cmd2
    assert len(srv.req("POST", "/api/coach", {"msg": "y" * 500}, headers=srv.bearer)[1]["msg"]) == 280
    evs = srv.req("GET", "/api/events?n=10", headers=srv.bearer)[1]["events"]
    coach = [e for e in evs if e["type"] == "coach"]
    assert coach[0]["seq"] == cmd["seq"] and coach[0]["set"] == {"step": "cur", "w": 240} and coach[0]["msg"] == "HR 170. Ease"


def test_state_and_history(srv):
    idle = srv.req("GET", "/api/state", headers=srv.bearer)[1]
    assert idle["state"]["source"] == "server" and idle["state"]["ride"] is None and idle["age_s"] == 0
    st = {"v": 1, "ride": {"started": True, "elapsed_s": 10, "target_w": 200, "step": {"index": 1}, "paused": False},
          "live": {"power": 199, "power_3s": 201, "cadence": 90, "hr": 140}}
    assert srv.req("POST", "/api/state", st, headers=srv.page)[0] == 200
    assert srv.req("POST", "/api/state", [1, 2], headers=srv.page)[0] == 400
    got = srv.req("GET", "/api/state", headers=srv.bearer)[1]
    assert got["state"] == st and 0 <= got["age_s"] < 5
    srv.req("POST", "/api/state", {"ride": None, "live": {}}, headers=srv.page)  # not riding: no history row
    hist = srv.req("GET", "/api/state/history?seconds=60", headers=srv.bearer)[1]["samples"]
    assert len(hist) == 1 and hist[0]["power"] == 199 and hist[0]["step"] == 1 and hist[0]["target_w"] == 200


def test_current_backup_atomic(srv):
    ride = {"id": "r-1", "name": "T", "samples": [[1, 1, 100, 90, 0, 30, 100]] * 2000}
    assert srv.req("POST", "/api/current", ride, headers=srv.page)[0] == 200
    assert srv.req("GET", "/api/current")[1] == ride
    stop = threading.Event()
    seen_bad = []

    def reader():
        while not stop.is_set():
            code, body = srv.req("GET", "/api/current")
            if code != 200 or not isinstance(body, dict):
                seen_bad.append((code, type(body)))

    rt = threading.Thread(target=reader)
    rt.start()
    for i in range(30):
        ride["name"] = f"T{i}"
        assert srv.req("POST", "/api/current", ride, headers=srv.page)[0] == 200
    stop.set()
    rt.join()
    assert not seen_bad
    assert srv.req("GET", "/api/current")[1]["name"] == "T29"
    assert not list(srv.cfg.coach_dir.glob("*.tmp"))  # no temp files left behind
    assert srv.req("POST", "/api/current", {}, headers=srv.page)[0] == 200  # clear
    assert srv.req("GET", "/api/current")[1] is None and not srv.cfg.current.exists()


def test_ride_archive_sanitizes_id(srv):
    assert srv.req("POST", "/api/ride", {"id": "../../etc/r-1", "samples": [[1]]}, headers=srv.page)[0] == 200
    files = list(srv.cfg.rides.iterdir())
    assert [f.name for f in files] == ["etcr-1.json"]
    assert json.loads(files[0].read_text())["id"] == "../../etc/r-1"


def test_bad_json(srv):
    assert srv.req("POST", "/api/event", b"{nope", headers=srv.page)[0] == 400


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
    from trainer_coach.garmin import GarminLink

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
