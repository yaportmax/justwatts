"""Import on the local app: the same /api/integrations/<svc>/import/{profile,list,fit} the page uses, with
python-garminconnect (connectapi, download) and intervals.icu stubbed. Shapes as in tests/js/import_test.mjs."""
import io
import json
import zipfile

from justwatts import history as H
from justwatts.integrations import importing as I
from justwatts.integrations.base import Resp

T0 = 1792504800000  # 2026-10-20 14:00 UTC
RIDE = {"id": "x", "name": "Tempo", "ftp": 250, "start": T0,
        "samples": [[T0 + i * 1000, i + 1, 200, 90, 140, 30.0, 0] for i in range(120)]}
FIT = H.fit_encode(RIDE)
GARMIN = {
    "/userprofile-service/userprofile/user-settings": {"userData": {"weight": 79800.0, "lactateThresholdHeartRate": 168}},
    "/userprofile-service/socialProfile": {"displayName": "abc-123"},
    "/weight-service/weight/dateRange": {"dateWeightList": [{"date": 1790000000000, "weight": 80100.0}, {"date": 1792000000000, "weight": 78400.0}]},
    "/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING": {"functionalThresholdPower": 265, "sport": "CYCLING"},
    "/biometric-service/heartRateZones": [{"sport": "DEFAULT", "zone1Floor": 95, "zone2Floor": 114, "zone3Floor": 133, "zone4Floor": 152, "zone5Floor": 171, "maxHeartRateUsed": 190},
                                          {"sport": "CYCLING", "lactateThresholdHeartRateUsed": 165, "zone1Floor": 100, "zone2Floor": 120, "zone3Floor": 140,
                                           "zone4Floor": 155, "zone5Floor": 166, "maxHeartRateUsed": 188}],
    "/biometric-service/biometric/latestLactateThreshold": [{"heartRate": 167}],
    "/wellness-service/wellness/dailyHeartRate/abc-123": {"restingHeartRate": 49},
    "/activitylist-service/activities/search/activities": [
        {"activityId": 9000, "activityName": "Zwift", "startTimeGMT": "2026-10-20 14:00:00", "activityType": {"typeKey": "virtual_ride"}, "avgPower": 200},
        {"activityId": 9001, "activityName": "Run", "startTimeGMT": "2026-10-19 14:00:00", "activityType": {"typeKey": "running"}}],
}


def zipped(data):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("9000_ACTIVITY.fit", data)
    return b.getvalue()


class FakeClient:
    """python-garminconnect: connectapi(path) answers JSON, download(path) bytes; a path may fail."""
    def __init__(self, fail=()):
        self.fail, self.calls = set(fail), []

    def connectapi(self, path):
        self.calls.append(path)
        key = path.split("?")[0]
        if key in self.fail:
            raise RuntimeError("500 Server Error")
        if key not in GARMIN:
            raise RuntimeError("404 Client Error: Not Found")
        return GARMIN[key]

    def download(self, path):
        if path.endswith("/9000"):
            return zipped(FIT)
        raise RuntimeError("404 Client Error: Not Found")


def test_readers_match_the_web():
    p = I.garmin_profile({k: {"ok": True, "json": GARMIN[v]} for k, v in [
        ("settings", "/userprofile-service/userprofile/user-settings"), ("weight", "/weight-service/weight/dateRange"),
        ("ftp", "/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING"), ("zones", "/biometric-service/heartRateZones"),
        ("lactate", "/biometric-service/biometric/latestLactateThreshold"), ("rhr", "/wellness-service/wellness/dailyHeartRate/abc-123")]})
    assert p["values"] == {"ftp": 265, "weight_kg": 78.4, "hr_max": 188, "hr_rest": 49, "lthr": 167, "hr_zones": [100, 120, 140, 155, 166]}
    assert I.garmin_profile({"settings": {"ok": False, "error": "500"}})["missing"] == list(I.PROFILE_KEYS)
    assert I.garmin_activity(GARMIN["/activitylist-service/activities/search/activities"][0])["start_ms"] == T0
    assert I.fit_from_zip(zipped(FIT)) == FIT


def test_local_garmin_import(srv):
    srv.garmin.client = lambda: FakeClient(fail={"/biometric-service/biometric/latestLactateThreshold"})
    code, prof = srv.req("GET", "/api/integrations/garmin/import/profile", headers=srv.page)
    assert code == 200 and prof["values"]["ftp"] == 265 and prof["values"]["lthr"] == 165  # LT piece failed: the zones' LTHR
    assert "lactate" in prof["errors"]
    log = srv.cfg.events_log.read_text(encoding="utf-8")
    assert "IMPORT garmin profile" in log and "lactate" in log and "265" not in log  # field names, never values
    code, lst = srv.req("GET", "/api/integrations/garmin/import/list?since=2026-01-01&until=2026-10-30", headers=srv.page)
    assert code == 200 and [x["id"] for x in lst["items"]] == ["9000"] and lst["skipped"] == 1
    code, data, ctype = srv.req("GET", "/api/integrations/garmin/import/fit?activity=9000", headers=srv.page, raw=True)
    assert code == 200 and data == FIT and ctype == "application/octet-stream"
    code, err = srv.req("GET", "/api/integrations/garmin/import/fit?activity=9999", headers=srv.page)
    assert code == 502 and err["kind"] == "blocked"
    assert srv.req("GET", "/api/integrations/garmin/import/list?since=bad", headers=srv.page)[0] == 400
    assert srv.req("GET", "/api/integrations/garmin/import/profile")[0] == 403  # the page only
    caps = {r["id"]: r["caps"].get("import") for r in srv.req("GET", "/api/integrations", headers=srv.page)[1]["integrations"]}
    assert caps["garmin"] and caps["intervals"] and not caps["trainingpeaks"]


def test_local_intervals_import(srv):
    calls = []

    def http(method, url, data=None, headers=None, timeout=30):
        calls.append(url)
        if url.endswith("/athlete/i123"):
            return Resp(200, {"content-type": "application/json"}, json.dumps({"id": "i123", "name": "T", "icu_weight": 72.5,
                        "sportSettings": [{"types": ["Ride"], "ftp": 255, "lthr": 166, "max_hr": 189}]}).encode())
        if "/activities?" in url:
            return Resp(200, {"content-type": "application/json"}, json.dumps([{"id": "i1", "start_date": "2026-10-20T14:00:00Z", "type": "VirtualRide"}]).encode())
        if url.endswith("/activity/i1/fit-file"):
            return Resp(200, {"content-type": "application/octet-stream"}, FIT)
        return Resp(404, {}, b"{}")
    c = srv.server.integrations.conns["intervals"]
    c.http = http
    c.file.write({"athlete_id": "i123", "api_key": "icukey-0123456789abcdef"})
    code, prof = srv.req("GET", "/api/integrations/intervals/import/profile", headers=srv.page)
    assert code == 200 and prof["values"] == {"ftp": 255, "weight_kg": 72.5, "hr_max": 189, "lthr": 166}
    code, lst = srv.req("GET", "/api/integrations/intervals/import/list?since=2026-10-01&until=2026-10-30", headers=srv.page)
    assert lst["items"][0]["indoor"] is True
    assert srv.req("GET", "/api/integrations/intervals/import/fit?activity=i1", headers=srv.page, raw=True)[1] == FIT


def test_imported_rides_never_upload(srv):
    """A ride the page imported (POST /api/ride, id imp-...) is archived, never queued for any service."""
    ride = {**RIDE, "id": "imp-garmin-9000", "source": "garmin", "imported": {"service": "garmin"}}
    assert srv.req("POST", "/api/ride", ride, headers=srv.page)[0] == 200
    assert srv.server.integrations.after_ride("imp-garmin-9000") == []
    rows = srv.req("GET", "/api/rides", headers=srv.page)[1]["rides"]
    assert rows[0]["id"] == "imp-garmin-9000" and rows[0]["source"] == "garmin"
    assert not srv.garmin.uploads
