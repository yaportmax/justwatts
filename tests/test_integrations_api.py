"""Local HTTP endpoints for integrations: auth rules, connect, auto upload after a ride, status, retry, planned.
Services are stubbed; secrets must never show up in responses, the event log or the state files."""
import json
import time

from justwatts.integrations.base import Resp

KEY = "icukey-0123456789abcdef"


def J(status, obj, headers=None):
    return Resp(status, {"content-type": "application/json", **(headers or {})}, json.dumps(obj).encode())


class IcuHttp:
    def __init__(self):
        self.calls = []
        self.upload = [J(201, {"id": "i9", "activities": [{"id": "i9"}]})]

    def __call__(self, method, url, data=None, headers=None, timeout=30):
        self.calls.append((method, url))
        if method == "GET" and "/athlete/i123" in url and "/events" not in url:
            ok = (headers or {}).get("Authorization", "").startswith("Basic ")
            return J(200, {"id": "i123", "name": "Test Rider"}) if ok else J(401, {})
        if "/events" in url:
            return J(200, [{"id": 1, "category": "WORKOUT", "type": "Ride", "name": "Tempo",
                            "workout_doc": {"steps": [{"duration": 600, "power": {"value": 80, "units": "%ftp"}}]}}])
        if method == "POST" and "/activities" in url:
            return self.upload.pop(0) if len(self.upload) > 1 else self.upload[0]
        return J(404, {})


def ride(srv, name="Ride"):
    srv.req("POST", "/api/devices", {"action": "sim", "kind": "trainer"}, headers=srv.page)
    srv.req("POST", "/api/ride/control", {"action": "load", "workout": {"name": name, "text": "30s 50%"}}, headers=srv.page)
    srv.req("POST", "/api/ride/control", {"action": "start"}, headers=srv.page)
    for _ in range(20):
        srv.server.engine.tick(1.0)
    return srv.req("POST", "/api/ride/control", {"action": "end"}, headers=srv.page)[1]["id"]


def wait(fn, n=300):
    for _ in range(n):
        v = fn()
        if v:
            return v
        time.sleep(0.01)
    return fn()


def connect_icu(srv):
    fake = IcuHttp()
    srv.server.integrations.conns["intervals"].http = fake
    code, res = srv.req("POST", "/api/integrations/intervals/connect", {"athlete_id": "i123", "api_key": KEY}, headers=srv.page)
    assert code == 200 and res["connected"] and res["account"] == "Test Rider"
    assert srv.req("POST", "/api/integrations/intervals/auto", {"on": True}, headers=srv.page)[0] == 200  # manual by default
    return fake


def everything(srv):
    """Every response the page can read plus every file the server wrote, as one string."""
    out = [json.dumps(srv.req("GET", p, headers=srv.page)[1]) for p in
           ("/api/integrations", "/api/integrations/planned?date=2026-10-28", "/api/strava/status", "/api/settings")]
    for f in srv.cfg.data.rglob("*"):
        if f.is_file() and f.name != "intervals.json" and f.suffix in (".json", ".log", ""):
            out.append(f.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(out)


def test_reads_and_writes_need_the_page_or_token(srv):
    for path in ("/api/integrations", "/api/integrations/planned", "/api/rides/x/uploads", "/api/rides/x/targets"):
        assert srv.req("GET", path)[0] == 403
        assert srv.req("GET", path, headers={"Origin": "https://evil.example", "X-HW": "1"})[0] == 403
        assert srv.req("GET", path, headers={"X-HW": "1"})[0] == 403
        assert srv.req("GET", path, headers={"X-HW": "1", "Sec-Fetch-Site": "cross-site"})[0] == 403
        assert srv.req("GET", path, headers={"Sec-Fetch-Site": "same-origin"})[0] == 403
    # the page's own GET: a browser sends no Origin on a same-origin GET, but Sec-Fetch-Site (it cannot be forged by a page)
    assert srv.req("GET", "/api/integrations", headers={"X-HW": "1", "Sec-Fetch-Site": "same-origin"})[0] == 200
    assert srv.req("POST", "/api/integrations/intervals/auto", {"on": True}, headers={"X-HW": "1", "Sec-Fetch-Site": "same-origin"})[0] == 403
    assert srv.req("GET", "/api/integrations", headers=srv.bearer)[0] == 200
    assert srv.req("POST", "/api/integrations/intervals/connect", {"athlete_id": "i1", "api_key": KEY})[0] == 403
    # credentials only from the page itself, never a token caller
    code, body = srv.req("POST", "/api/integrations/intervals/connect", {"athlete_id": "i1", "api_key": KEY}, headers=srv.bearer)
    assert code == 403 and "Settings" in body["error"]
    assert srv.req("POST", "/api/integrations/nope/connect", {}, headers=srv.page)[0] == 404
    assert srv.req("POST", "/api/integrations/intervals/connect", b"[1]", headers=srv.page)[0] == 400


def test_list_has_garmin_first_and_strava_status(srv):
    rows = srv.req("GET", "/api/integrations", headers=srv.page)[1]["integrations"]
    ids = [r["id"] for r in rows]
    assert ids[:4] == ["garmin", "strava", "trainingpeaks", "intervals"] and ids[4:] == ["coros", "polar", "suunto", "wahoo"]
    assert rows[0]["recommended"] and rows[0]["unofficial_note"].startswith("Unfortunately Garmin Connect doesn't allow")
    assert rows[1]["connect"]["kind"] == "oauth" and rows[1]["connect"]["url"] == "/api/strava/connect"
    assert rows[1]["manual"]["url"] == "https://www.strava.com/upload/select"


def test_connect_upload_after_ride_and_status(srv):
    fake = connect_icu(srv)
    rid = ride(srv, "Tempo ride")  # intervals.icu connected, auto on by default: the ride uploads by itself
    up = wait(lambda: (srv.req("GET", f"/api/rides/{rid}/uploads", headers=srv.page)[1]["uploads"].get("intervals") or {}).get("state") == "done"
              and srv.req("GET", f"/api/rides/{rid}/uploads", headers=srv.page)[1])
    assert up and up["uploads"]["intervals"]["activity_id"] == "i9" and up["fit_url"] == f"/api/rides/{rid}/fit"
    assert wait(lambda: srv.server.ride_meta(rid).get("intervals")) == "i9"  # history badge
    assert any(m == "POST" and "/activities?" in u for m, u in fake.calls)
    t = srv.req("GET", f"/api/rides/{rid}/targets", headers=srv.page)[1]
    rows = {r["id"]: r for r in t["targets"]}
    assert t["any_connected"] and rows["intervals"]["upload"]["state"] == "done" and rows["garmin"]["recommended"]
    assert rows["coros"]["manual_only"] and rows["coros"]["manual"]["steps"][0] == "1. Download the .fit file."
    assert srv.req("GET", f"/api/rides/{rid}/fit", raw=True)[0] == 200  # the fallback link works
    assert KEY not in everything(srv)


def test_failure_carries_fallback_and_retry_requeues(srv):
    fake = connect_icu(srv)
    fake.upload = [J(422, {"error": "bad file"})]
    rid = ride(srv)
    st = wait(lambda: (srv.req("GET", f"/api/rides/{rid}/uploads", headers=srv.page)[1]["uploads"].get("intervals") or {}).get("state") == "failed"
              and srv.req("GET", f"/api/rides/{rid}/uploads", headers=srv.page)[1]["uploads"]["intervals"])
    assert st["kind"] == "blocked" and st["action"] == "download_fit"
    assert st["fallback"]["fit_url"] == f"/api/rides/{rid}/fit" and st["fallback"]["ride_id"] == rid
    assert st["fallback"]["manual"]["url"] == "https://intervals.icu/activities"
    fake.upload = [J(201, {"id": "i10", "activities": [{"id": "i10"}]})]
    code, res = srv.req("POST", f"/api/rides/{rid}/uploads/intervals", {}, headers=srv.page)
    assert code == 200 and res["upload"]["state"] in ("pending", "running", "done")
    assert wait(lambda: srv.server.integrations.runner.get(rid, "intervals")["state"] == "done")
    assert srv.req("POST", "/api/rides/nope/uploads/intervals", {}, headers=srv.page)[0] == 404


def test_bad_key_is_auth_and_never_echoed(srv):
    srv.server.integrations.conns["intervals"].http = lambda *a, **k: J(401, {"error": f"bad key {KEY}"})
    code, body = srv.req("POST", "/api/integrations/intervals/connect", {"athlete_id": "i123", "api_key": KEY}, headers=srv.page)
    assert code == 401 and body["kind"] == "auth" and KEY not in json.dumps(body)


def test_connect_with_ride_id_uploads_that_ride(srv):
    srv.garmin.is_linked = False
    rid = ride(srv)  # nothing connected yet: nothing queued
    assert srv.req("GET", f"/api/rides/{rid}/targets", headers=srv.page)[1]["any_connected"] is False
    srv.server.integrations.conns["intervals"].http = IcuHttp()
    code, res = srv.req("POST", "/api/integrations/intervals/connect", {"athlete_id": "i123", "api_key": KEY, "ride_id": rid}, headers=srv.page)
    assert code == 200 and res["upload"]["service"] == "intervals"
    assert wait(lambda: srv.server.integrations.runner.get(rid, "intervals")["state"] == "done")
    assert srv.req("POST", "/api/integrations/intervals/connect", {"athlete_id": "i123", "api_key": KEY, "ride_id": "nope"}, headers=srv.page)[0] == 404


def test_disconnect_auto_syncs_and_planned(srv):
    connect_icu(srv)
    p = srv.req("GET", "/api/integrations/planned?date=2026-10-28", headers=srv.page)[1]
    assert p["workouts"] == [{"id": "1", "name": "Tempo", "date": "2026-10-28", "text": "10m 80%", "duration_s": None,
                              "description": "", "structured": True, "source": "intervals"}]
    assert srv.req("GET", "/api/integrations/planned?date=28-10-2026", headers=srv.page)[0] == 400
    rows = srv.req("POST", "/api/integrations/intervals/auto", {"on": False}, headers=srv.page)[1]["integrations"]
    assert next(r for r in rows if r["id"] == "intervals")["auto"] is False
    rows = srv.req("POST", "/api/integrations/garmin/syncs", {"syncs_to": ["strava"]}, headers=srv.page)[1]["integrations"]
    assert rows[0]["syncs_to"] == ["strava"]
    assert srv.req("POST", "/api/integrations/garmin/syncs", {"syncs_to": "strava"}, headers=srv.page)[0] == 400
    assert srv.req("POST", "/api/integrations/intervals/syncs", {"syncs_to": []}, headers=srv.page)[0] == 404
    rows = srv.req("POST", "/api/integrations/intervals/disconnect", {}, headers=srv.page)[1]["integrations"]
    assert not next(r for r in rows if r["id"] == "intervals")["status"]["connected"]
    assert not (srv.cfg.data / "integrations" / "intervals.json").exists()


def test_strava_auto_setting_is_the_integration_toggle(srv):
    srv.req("POST", "/api/integrations/strava/auto", {"on": True}, headers=srv.page)
    assert srv.server.settings["autoStrava"] is True
    srv.req("POST", "/api/integrations/strava/auto", {"on": False}, headers=srv.page)
    assert srv.server.settings["autoStrava"] is False


def test_saving_a_ride_never_waits_on_uploads(srv):
    connect_icu(srv)

    def slow(*a, **k):
        time.sleep(1.5)
        return J(503, {})
    srv.server.integrations.conns["intervals"].http = slow
    t0 = time.monotonic()
    rid = ride(srv)
    assert time.monotonic() - t0 < 1.0 and srv.server.load_ride(rid) is not None
