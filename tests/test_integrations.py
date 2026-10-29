"""Integrations framework (local app): job runner, connectors, hub, HTTP endpoints. Stubbed HTTP only."""
import base64
import json
import time
import urllib.parse
from pathlib import Path

import pytest

from conftest import REPO
from justwatts.integrations import Integrations
from justwatts.integrations.base import (AUTH, BLOCKED, DUPLICATE, TEMPORARY, Connector, IntegrationError, Resp,
                                         RideMeta, UNOFFICIAL_NOTE)
from justwatts.integrations.garmin_conn import GarminConnector
from justwatts.integrations.intervals import IntervalsConnector
from justwatts.integrations.jobs import DELAYS, MAX_TRIES, JobRunner, public
from justwatts.integrations.manual import manual_only
from justwatts.integrations.trainingpeaks import TrainingPeaksConnector, cookie_value

FIT = b"\x0e\x20\x00\x00\x00\x00\x00\x00.FIT" + b"\x00" * 40
SECRET_KEY = "icukey-0123456789abcdef"
TP_COOKIE = "tpcookie_" + "A1b2C3d4" * 6


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class Scripted(Connector):
    """Connector whose upload answers come from a list (an exception or a dict per attempt)."""
    id, name = "fake", "Fake"

    def __init__(self, answers, sid="fake"):
        self.id = sid
        self.answers = list(answers)
        self.calls = 0
        self.linked = True

    def status(self):
        return {"connected": self.linked}

    def disconnect(self):
        self.linked = False

    def connect(self, fields):
        self.linked = True
        return {"connected": True}

    def secrets(self):
        return ["sekrit-token"]

    def upload(self, fit, meta):
        self.calls += 1
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def runner(tmp_path, conn, clock, results=None):
    return JobRunner(tmp_path / "jobs.json", {conn.id: conn}, lambda rid: (FIT, RideMeta(rid)),
                     on_result=(lambda s, r, j: results.append(j)) if results is not None else None, clock=clock)


# ---------- job runner ----------
def test_retries_with_backoff_then_success(tmp_path):
    clk = Clock()
    c = Scripted([IntegrationError(TEMPORARY, "busy"), IntegrationError(TEMPORARY, "busy"), {"activity_id": 9}])
    r = runner(tmp_path, c, clk)
    r.enqueue("r1", ["fake"])
    assert r.run_due() == 1 and r.get("r1", "fake")["state"] == "pending"
    assert r.get("r1", "fake")["next_at"] == clk.t + DELAYS[0]
    clk.t += DELAYS[0] - 1
    assert r.run_due() == 0  # not due yet
    clk.t += 1
    assert r.run_due() == 1 and r.get("r1", "fake")["next_at"] == clk.t + DELAYS[1]
    clk.t += DELAYS[1]
    r.run_due()
    j = r.get("r1", "fake")
    assert (j["state"], j["tries"], j["activity_id"], c.calls) == ("done", 3, 9, 3)
    assert sum(DELAYS) == 600  # 3 tries over about 10 minutes


def test_gives_up_after_three_tries_with_fallback(tmp_path):
    clk = Clock()
    r = runner(tmp_path, Scripted([IntegrationError(TEMPORARY, "down")] * 5), clk)
    r.enqueue("r1", ["fake"])
    for d in (0, *DELAYS):
        clk.t += d
        r.run_due()
    j = r.get("r1", "fake")
    assert (j["state"], j["kind"], j["tries"]) == ("failed", TEMPORARY, MAX_TRIES)
    fb = {"ride_id": "r1", "fit_url": "/api/rides/r1/fit"}
    p = public(j, fb)
    assert p["action"] == "retry" and p["fallback"] == fb and p["next_retry_at"] is None
    clk.t += 10_000
    assert r.run_due() == 0


@pytest.mark.parametrize("kind,action", [(AUTH, "reconnect"), (BLOCKED, "download_fit")])
def test_auth_and_blocked_stop_at_once(tmp_path, kind, action):
    r = runner(tmp_path, Scripted([IntegrationError(kind, "no")]), Clock())
    r.enqueue("r1", ["fake"])
    r.run_due()
    j = r.get("r1", "fake")
    assert (j["state"], j["kind"], j["tries"]) == ("failed", kind, 1)
    assert public(j, {"x": 1})["action"] == action and public(j, {"x": 1})["fallback"] == {"x": 1}


def test_duplicate_counts_as_done(tmp_path):
    r = runner(tmp_path, Scripted([IntegrationError(DUPLICATE, "already there"), {"duplicate": True, "activity_id": 5}]), Clock())
    r.enqueue("a", ["fake"])
    r.enqueue("b", ["fake"])
    r.run_due()
    for rid in ("a", "b"):
        j = r.get(rid, "fake")
        assert j["state"] == "done" and j["duplicate"] and j["kind"] == DUPLICATE
        assert "fallback" not in public(j, {})


def test_rate_limit_honours_retry_after(tmp_path):
    clk = Clock()
    r = runner(tmp_path, Scripted([IntegrationError(TEMPORARY, "429", retry_after=900), {}]), clk)
    r.enqueue("r1", ["fake"])
    r.run_due()
    assert r.get("r1", "fake")["next_at"] == clk.t + 900
    r2 = runner(tmp_path, Scripted([IntegrationError(TEMPORARY, "429", retry_after=99999)]), clk)
    r2.enqueue("r2", ["fake"])
    r2.run_due()
    assert r2.get("r2", "fake")["next_at"] == clk.t + 1800  # capped


def test_restart_resumes_pending_and_interrupted_jobs(tmp_path):
    clk = Clock()
    c = Scripted([IntegrationError(TEMPORARY, "busy")])
    r = runner(tmp_path, c, clk)
    r.enqueue("r1", ["fake"])
    r.run_due()
    # a second job was mid-attempt when the process died
    data = json.loads((tmp_path / "jobs.json").read_text())
    data["jobs"]["r2:fake"] = {**data["jobs"]["r1:fake"], "ride_id": "r2", "state": "running", "tries": 1}
    (tmp_path / "jobs.json").write_text(json.dumps(data))
    c2 = Scripted([{"activity_id": 1}, {"activity_id": 2}])
    r2 = runner(tmp_path, c2, clk)  # "restart"
    assert r2.get("r2", "fake")["state"] == "pending"
    assert r2.run_due() == 1 and r2.get("r2", "fake")["state"] == "done"  # interrupted one runs at once
    clk.t += DELAYS[0]
    assert r2.run_due() == 1 and r2.get("r1", "fake")["state"] == "done" and c2.calls == 2


def test_enqueue_never_repeats_finished_jobs_unless_retry(tmp_path):
    c = Scripted([{"activity_id": 1}, {"activity_id": 2}])
    r = runner(tmp_path, c, Clock())
    r.enqueue("r1", ["fake"])
    r.run_due()
    r.enqueue("r1", ["fake"])
    assert r.run_due() == 0 and c.calls == 1
    assert r.run_now("r1", "fake")["activity_id"] == 2 and c.calls == 2


def test_connector_crash_and_missing_ride_never_kill_the_worker(tmp_path):
    clk = Clock()
    c = Scripted([ZeroDivisionError("bug")])
    r = JobRunner(tmp_path / "j.json", {"fake": c}, lambda rid: None if rid == "gone" else (FIT, RideMeta(rid)), clock=clk)
    r.enqueue("gone", ["fake"])
    r.enqueue("r1", ["fake"])
    r.run_due()
    assert r.get("gone", "fake")["kind"] == BLOCKED and r.get("r1", "fake")["kind"] == TEMPORARY


def test_errors_are_scrubbed_of_secrets(tmp_path):
    r = runner(tmp_path, Scripted([IntegrationError(AUTH, "bad token sekrit-token here")]), Clock())
    r.enqueue("r1", ["fake"])
    r.run_due()
    assert "sekrit" not in (tmp_path / "jobs.json").read_text()


def test_worker_thread_runs_jobs(tmp_path):
    c = Scripted([{"activity_id": 3}])
    r = runner(tmp_path, c, time.time)
    r.start()
    try:
        r.enqueue("r1", ["fake"])
        for _ in range(200):
            if (r.get("r1", "fake") or {}).get("state") == "done":
                break
            time.sleep(0.01)
        assert r.get("r1", "fake")["state"] == "done"
    finally:
        r.stop()


# ---------- fake HTTP for the services ----------
class FakeHttp:
    def __init__(self, routes):
        self.routes = routes  # list of (method, url substring, Resp or callable)
        self.calls = []

    def __call__(self, method, url, data=None, headers=None, timeout=30):
        self.calls.append((method, url, data, headers or {}))
        for i, (m, sub, resp) in enumerate(self.routes):
            if m == method and sub in url:
                if isinstance(resp, list):
                    out = resp.pop(0) if len(resp) > 1 else resp[0]
                else:
                    out = resp
                return out(method, url, data, headers) if callable(out) else out
        return Resp(404, {}, b"{}")


def J(status, obj, headers=None):
    return Resp(status, {"content-type": "application/json", **(headers or {})}, json.dumps(obj).encode())


# ---------- intervals.icu ----------
def icu(tmp_path, routes):
    h = FakeHttp(routes)
    return IntervalsConnector(tmp_path, http=h), h


def test_intervals_connect_upload_duplicate(tmp_path):
    c, h = icu(tmp_path, [("GET", "/athlete/i123", J(200, {"id": "i123", "name": "Test Rider"})),
                          ("POST", "/activities", [J(201, {"icu_athlete_id": "i123", "id": "i9", "activities": [{"id": "i9"}]}),
                                                   J(200, {"icu_athlete_id": "i123", "id": "i9", "activities": [{"id": "i9"}]})])])
    assert c.connect({"athlete_id": "i123", "api_key": SECRET_KEY})["account"] == "Test Rider"
    auth = h.calls[0][3]["Authorization"]
    assert auth == "Basic " + base64.b64encode(f"API_KEY:{SECRET_KEY}".encode()).decode()
    res = c.upload(FIT, RideMeta("r-1", "Sweet spot", "NP 200 W", filename="r.fit"))
    assert res == {"activity_id": "i9", "url": "https://intervals.icu/activities/i9", "duplicate": False}
    m, url, data, hd = h.calls[-1]
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    assert q["name"] == ["Sweet spot"] and q["external_id"] == ["r-1"] and b'name="file"; filename="r.fit"' in data and FIT in data
    assert c.upload(FIT, RideMeta("r-1"))["duplicate"] is True
    assert SECRET_KEY not in json.dumps(c.status())


def test_intervals_failures(tmp_path):
    c, _ = icu(tmp_path, [("GET", "/athlete/", J(401, {"error": "nope"}))])
    with pytest.raises(IntegrationError) as e:
        c.connect({"athlete_id": "i1", "api_key": SECRET_KEY})
    assert e.value.kind == AUTH and not c.status()["connected"]
    with pytest.raises(IntegrationError) as e:
        c.connect({"athlete_id": "x; drop", "api_key": SECRET_KEY})
    assert e.value.kind == AUTH
    c.file.write({"athlete_id": "i1", "api_key": SECRET_KEY})
    for resp, kind in ((Resp(403, {"content-type": "text/html"}, b"<html>cf challenge</html>"), BLOCKED),
                       (J(403, {"error": "forbidden"}), AUTH),
                       (J(429, {}, {"retry-after": "60"}), TEMPORARY), (J(503, {}), TEMPORARY), (J(422, {}), BLOCKED)):
        c.http = FakeHttp([("POST", "/activities", resp)])
        with pytest.raises(IntegrationError) as e:
            c.upload(FIT, RideMeta("r"))
        assert e.value.kind == kind
        assert SECRET_KEY not in str(e.value)
    assert e.value.kind == BLOCKED
    c.http = FakeHttp([("POST", "/activities", J(429, {}, {"retry-after": "60"}))])
    with pytest.raises(IntegrationError) as e:
        c.upload(FIT, RideMeta("r"))
    assert e.value.retry_after == 60


def test_intervals_planned_today(tmp_path):
    fx = json.loads((REPO / "tests/fixtures/planned.json").read_text())["intervals"]
    events = [{"id": 1, "category": "WORKOUT", "type": "Ride", "name": "VO2", "start_date_local": "2026-10-28T07:00:00",
               "workout_doc": fx[0]["doc"], "description": "hard"},
              {"id": 2, "category": "WORKOUT", "type": "Run", "name": "Run", "workout_doc": fx[1]["doc"]},
              {"id": 3, "category": "WORKOUT", "type": "VirtualRide", "name": "Easy", "moving_time": 3600, "workout_doc": {}}]
    c, h = icu(tmp_path, [("GET", "/events", J(200, events))])
    c.file.write({"athlete_id": "i1", "api_key": SECRET_KEY})
    got = c.planned("2026-10-28")
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(h.calls[0][1]).query)
    assert q == {"oldest": ["2026-10-28"], "newest": ["2026-10-28"], "category": ["WORKOUT"], "resolve": ["true"]}
    assert [(w["id"], w["text"], w["structured"]) for w in got] == [("1", fx[0]["expect"], True), ("3", "60m free", False)]


# ---------- TrainingPeaks ----------
def tp(tmp_path, routes, clock=None):
    h = FakeHttp(routes)
    return TrainingPeaksConnector(tmp_path, http=h, clock=clock or Clock()), h


TOKEN_OK = J(200, {"success": True, "token": {"access_token": "tp-access-1", "expires_in": 3600, "token_type": "bearer"}})
USER = J(200, {"user": {"userId": 11, "personId": 22, "firstName": "Test", "lastName": "Rider", "email": "a@example.com",
                        "athletes": [{"athleteId": 33, "email": "coached@example.com"}, {"athleteId": 22, "email": "a@example.com"}]}})


def test_tp_cookie_parsing():
    assert cookie_value(TP_COOKIE) == TP_COOKIE
    assert cookie_value(f"foo=1; Production_tpAuth={TP_COOKIE}; bar=2") == TP_COOKIE
    assert cookie_value("short") == "" and cookie_value("") == "" and cookie_value("a b c" * 10) == ""


def test_tp_connect_exchanges_cookie_and_picks_own_athlete(tmp_path):
    c, h = tp(tmp_path, [("GET", "/users/v3/token", TOKEN_OK), ("GET", "/users/v3/user", USER)])
    st = c.connect({"cookie": f"Production_tpAuth={TP_COOKIE}"})
    assert st["connected"] and st["athlete_id"] == "22" and st["account"] == "Test Rider"  # personId, not the coached athlete
    tok = h.calls[0]
    assert tok[3]["Cookie"] == f"Production_tpAuth={TP_COOKIE}" and "Authorization" not in tok[3]
    assert h.calls[1][3]["Authorization"] == "Bearer tp-access-1"
    assert TP_COOKIE not in json.dumps(st) and "tp-access-1" not in json.dumps(st)


def test_tp_expired_cookie_is_auth(tmp_path):
    for resp in (J(401, {}), J(200, {"success": False}), J(403, {})):
        c, _ = tp(tmp_path, [("GET", "/users/v3/token", resp)])
        with pytest.raises(IntegrationError) as e:
            c.connect({"cookie": TP_COOKIE})
        assert e.value.kind == AUTH and "fresh" in str(e.value)


def test_tp_token_refresh_and_401_remint(tmp_path):
    clk = Clock()
    tokens = [J(200, {"success": True, "token": {"access_token": f"tp-access-{i}", "expires_in": 3600}}) for i in range(1, 5)]
    c, h = tp(tmp_path, [("GET", "/users/v3/token", tokens), ("GET", "/users/v3/user", USER),
                         ("GET", "/workouts/", [J(401, {}), J(200, [])])], clk)
    c.connect({"cookie": TP_COOKIE})
    assert c.planned("2026-10-28") == []  # first call 401, re-minted, retried
    mints = [x for x in h.calls if x[1].endswith("/users/v3/token")]
    assert len(mints) == 2
    clk.t += 3600  # token ran out: minted again before the call
    c.planned("2026-10-28")
    assert len([x for x in h.calls if x[1].endswith("/users/v3/token")]) == 3
    # the cookie died: every later call is auth (reconnect)
    c.http = FakeHttp([("GET", "/users/v3/token", J(401, {})), ("GET", "/workouts/", J(401, {}))])
    with pytest.raises(IntegrationError) as e:
        c.planned("2026-10-28")
    assert e.value.kind == AUTH


def test_tp_upload_and_duplicate(tmp_path):
    start = time.mktime((2026, 10, 28, 7, 0, 0, 0, 0, -1))
    meta = RideMeta("r-1", "Ride", "d", int(start * 1000), "r.fit", {"duration_s": 3600})
    day = [{"workoutId": 1, "workoutDay": "2026-10-28T00:00:00", "totalTime": None, "workoutTypeValueId": 2},
           {"workoutId": 2, "workoutDay": "2026-10-28T00:00:00", "totalTime": 0.5, "startTime": "2026-10-28T12:00:00"}]
    c, h = tp(tmp_path, [("GET", "/users/v3/token", TOKEN_OK), ("GET", "/users/v3/user", USER),
                         ("GET", "/workouts/2026-10-28/2026-10-28", lambda *a: J(200, day)),
                         ("POST", "/workouts/filedata", J(200, {"workoutId": 77}))])
    c.connect({"cookie": TP_COOKIE})
    res = c.upload(FIT, meta)
    assert res["activity_id"] == 77 and "77" in res["url"]
    post = next(x for x in h.calls if x[0] == "POST")
    body = json.loads(post[2])
    assert post[1].endswith("/fitness/v6/athletes/22/workouts/filedata")
    assert base64.b64decode(body["data"]) == FIT and body["fileName"] == "r.fit" and body["workoutDay"] is None
    # the same ride already there (same start time): duplicate, no second upload
    day.append({"workoutId": 3, "totalTime": 1.0, "startTime": "2026-10-28T07:00:30"})
    n = len(h.calls)
    assert c.upload(FIT, meta) == {"duplicate": True, "activity_id": 3, "url": c._url(3)}
    assert not any(x[0] == "POST" for x in h.calls[n:])
    c.http = FakeHttp([("GET", "/workouts/", J(200, [])), ("POST", "/filedata", J(429, {}, {"retry-after": "30"}))])
    with pytest.raises(IntegrationError) as e:
        c.upload(FIT, meta)
    assert e.value.kind == TEMPORARY and e.value.retry_after == 30


def test_tp_planned_today(tmp_path):
    fx = json.loads((REPO / "tests/fixtures/planned.json").read_text())["trainingpeaks"]
    day = [{"workoutId": 5, "title": "Threshold", "workoutDay": "2026-10-28T00:00:00", "workoutTypeValueId": 2,
            "totalTimePlanned": 1.5, "structure": fx[0]["structure"], "tssPlanned": 80},
           {"workoutId": 6, "title": "Done ride", "workoutTypeValueId": 2, "totalTime": 1.0, "structure": fx[0]["structure"]},
           {"workoutId": 7, "title": "Run", "workoutTypeValueId": 3, "totalTimePlanned": 1.0},
           {"workoutId": 8, "title": None, "workoutTypeValueId": 2, "totalTimePlanned": 0.75}]
    c, _ = tp(tmp_path, [("GET", "/users/v3/token", TOKEN_OK), ("GET", "/users/v3/user", USER), ("GET", "/workouts/", J(200, day))])
    c.connect({"cookie": TP_COOKIE})
    got = c.planned("2026-10-28")
    assert [(w["id"], w["name"], w["text"]) for w in got] == [("5", "Threshold", fx[0]["expect"]), ("8", "Planned ride", "45m free")]
    assert got[0]["tss"] == 80 and got[0]["duration_s"] == 5400


# ---------- Garmin (local, python-garminconnect) ----------
class FakeLink:
    def __init__(self, tokens):
        self.tokens = Path(tokens)
        self.result = {"ok": True, "activityId": 42}
        self.paths = []

    def linked(self):
        return self.tokens.exists() and any(self.tokens.glob("*.json"))

    def upload(self, path):
        self.paths.append(Path(path))
        return dict(self.result)

    def reset(self):
        pass


class FakeGarminLib:
    """Stands in for garminconnect.Garmin (return_on_mfa / resume_login API)."""
    mfa = True
    instances = []

    def __init__(self, email=None, password=None, return_on_mfa=False):
        self.email, self.password = email, password
        self.client = self
        FakeGarminLib.instances.append(self)

    def login(self):
        if self.password != "right-password":
            raise RuntimeError("401 Client Error: Unauthorized")
        return ("needs_mfa", {"state": 1}) if self.mfa else (None, None)

    def resume_login(self, state, code):
        if code != "123456":
            raise RuntimeError("bad code")

    def dump(self, path):
        Path(path, "garmin_tokens.json").write_text('{"di_token": "x"}')


def test_garmin_connect_with_mfa_and_upload(tmp_path):
    link = FakeLink(tmp_path / "tok")
    clk = Clock()
    g = GarminConnector(link, tmp_path / "rides", garmin_factory=FakeGarminLib, clock=clk)
    with pytest.raises(IntegrationError) as e:
        g.connect({"email": "a@example.com", "password": "wrong-password"})
    assert e.value.kind == AUTH
    assert g.connect({"email": "a@example.com", "password": "right-password"}) == {"mfa_required": True}
    with pytest.raises(IntegrationError):
        g.connect({"mfa_code": "000000"})
    assert g.connect({"mfa_code": "123456"}) == {"connected": True} and g.status()["connected"]
    assert "right-password" not in "".join(p.read_text() for p in (tmp_path / "tok").iterdir())
    res = g.upload(FIT, RideMeta("r1", filename="2026 ride.fit"))
    assert res["activity_id"] == 42 and (tmp_path / "rides" / "2026 ride.fit").read_bytes() == FIT
    link.result = {"ok": True, "duplicate": True}
    assert g.upload(FIT, RideMeta("r1"))["duplicate"]
    for err, kind in (("401 Unauthorized", AUTH), ("429 Too Many Requests", TEMPORARY), ("403 Forbidden", BLOCKED),
                      ("network down", TEMPORARY)):
        link.result = {"ok": False, "error": err}
        with pytest.raises(IntegrationError) as e:
            g.upload(FIT, RideMeta("r1"))
        assert e.value.kind == kind, err
    g.disconnect()
    assert not g.status()["connected"]
    with pytest.raises(IntegrationError) as e:
        g.upload(FIT, RideMeta("r1"))
    assert e.value.kind == AUTH


def test_garmin_mfa_times_out(tmp_path):
    clk = Clock()
    g = GarminConnector(FakeLink(tmp_path / "t"), tmp_path, garmin_factory=FakeGarminLib, clock=clk)
    g.connect({"email": "a@example.com", "password": "right-password"})
    clk.t += 301
    with pytest.raises(IntegrationError) as e:
        g.connect({"mfa_code": "123456"})
    assert "timed out" in str(e.value)


def test_garmin_disabled_is_blocked(tmp_path):
    g = GarminConnector(FakeLink(tmp_path), tmp_path, enabled=False)
    for fn in (lambda: g.connect({"email": "a", "password": "b"}), lambda: g.upload(FIT, RideMeta("r"))):
        with pytest.raises(IntegrationError) as e:
            fn()
        assert e.value.kind == BLOCKED


# ---------- hub: list, Garmin question, defaults ----------
def make_hub(tmp_path, garmin_linked=False):
    g = Scripted([{"activity_id": 1}] * 9, "garmin")
    g.name, g.official = "Garmin Connect", False
    g.linked = garmin_linked
    tpc = Scripted([{"activity_id": 2}] * 9, "trainingpeaks")
    tpc.name, tpc.official = "TrainingPeaks", False
    icuc = Scripted([{"activity_id": 3}] * 9, "intervals")
    icuc.name = "intervals.icu"
    h = Integrations(tmp_path, [icuc, tpc, g, *manual_only()], lambda rid: (FIT, RideMeta(rid)), clock=Clock())
    return h, g, tpc, icuc


def test_list_order_metadata_and_tooltips(tmp_path):
    h, *_ = make_hub(tmp_path)
    rows = h.list()
    assert [r["id"] for r in rows] == ["garmin", "trainingpeaks", "intervals", "coros", "polar", "suunto", "wahoo"]
    g = rows[0]
    assert g["recommended"] and g["recommended_reason"] == "Uploads here can sync on to apps you link in Garmin Connect."
    assert g["unofficial_note"] == UNOFFICIAL_NOTE.format(name="Garmin Connect")
    assert g["unofficial_note"].endswith("upload the .fit file manually:") and "—" not in json.dumps(rows)
    assert g["manual"]["url"] == "https://connect.garmin.com/modern/import-data" and len(g["manual"]["steps"]) == 3
    assert "unofficial_note" not in rows[2] and rows[2]["official"]
    coros = rows[3]
    assert coros["connect"] is None and coros["caps"]["upload"] is False and coros["manual"]["url"].startswith("https://")
    assert rows[4]["manual"]["supported"] is False  # Polar has no file import at all


def test_garmin_question_then_defaults(tmp_path):
    h, g, tpc, icuc = make_hub(tmp_path, garmin_linked=False)
    # Garmin not connected: every service uploads directly by default, no warnings
    assert all(r["auto"] for r in h.list() if r["caps"]["upload"])
    g.linked = True
    res = h.connect("garmin", {})
    assert res["question"]["text"] == "Does your Garmin account already send rides to:" and res["syncs_to"] is None
    rows = {r["id"]: r for r in h.list()}
    assert rows["garmin"]["syncs_question"] and rows["trainingpeaks"]["auto"] and not rows["trainingpeaks"]["duplicate_risk"]
    # the rider says Garmin already sends rides to TrainingPeaks
    h.set_syncs_to(["trainingpeaks", "bogus"])
    rows = {r["id"]: r for r in h.list()}
    assert rows["garmin"]["syncs_to"] == ["trainingpeaks"] and rows["garmin"]["syncs_question"] is None
    assert rows["garmin"]["recommended_reason"] == "Garmin also sends your rides to TrainingPeaks."
    assert rows["trainingpeaks"]["auto"] is False and rows["trainingpeaks"]["synced_by_garmin"]
    assert rows["intervals"]["auto"] is True and not rows["intervals"]["synced_by_garmin"]  # not synced: stays on
    assert h.after_ride("r1") == ["garmin", "intervals"]
    # the rider turns TrainingPeaks on anyway: the duplicate warning shows
    h.set_auto("trainingpeaks", True)
    rows = {r["id"]: r for r in h.list()}
    assert rows["trainingpeaks"]["duplicate_risk"]
    assert rows["trainingpeaks"]["duplicate_warning"] == "Garmin already syncs to TrainingPeaks. Uploading to both makes duplicates."
    h.set_syncs_to([])
    assert h.list()[0]["recommended_reason"].startswith("Uploads here can sync")


def test_connect_then_upload_this_ride_and_targets(tmp_path):
    h, g, tpc, icuc = make_hub(tmp_path)
    t = h.targets("r1")
    assert t["any_connected"] is False or t["any_connected"] is True
    g.linked = tpc.linked = icuc.linked = False
    t = h.targets("r1")
    assert t["any_connected"] is False and t["fit_url"] == "/api/rides/r1/fit"
    assert {r["id"] for r in t["targets"]} == {"garmin", "trainingpeaks", "intervals", "coros", "polar", "suunto", "wahoo"}
    g.linked = True
    res = h.connect("garmin", {}, ride_id="r1")
    assert res["upload"]["state"] == "pending"
    h.runner.run_due()
    t = {r["id"]: r for r in h.targets("r1")["targets"]}
    assert t["garmin"]["upload"]["state"] == "done" and t["garmin"]["recommended"]
    assert t["coros"]["manual_only"] and t["coros"]["upload"] is None


def test_planned_collects_and_reports_per_service(tmp_path):
    h, g, tpc, icuc = make_hub(tmp_path, True)
    tpc.planned_workouts = icuc.planned_workouts = True
    tpc.planned = lambda day: (_ for _ in ()).throw(IntegrationError(AUTH, "expired sekrit-token"))
    icuc.planned = lambda day: [{"id": "1", "name": "VO2", "text": "5m 100%"}]
    out = h.planned("2026-10-28")
    assert out["workouts"] == [{"id": "1", "name": "VO2", "text": "5m 100%", "source": "intervals"}]
    assert out["errors"]["trainingpeaks"]["kind"] == AUTH and "sekrit" not in json.dumps(out)
    assert {r["id"]: r for r in h.list()}["trainingpeaks"]["needs_reconnect"]


def test_after_ride_never_raises(tmp_path):
    h, g, *_ = make_hub(tmp_path, True)
    g.status = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    h.runner.enqueue = lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))
    assert h.after_ride("r1") == []
