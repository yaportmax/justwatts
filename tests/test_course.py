"""Courses: GPX/TCX parsing, the 10 m profile (smoothing, grade clamp), speed from power, riding a course on
the server engine, the web build's engine giving the same ride, workout + course, and FIT/TCX export."""
import base64
import io
import json
import math
import random
import re
import xml.etree.ElementTree as ET

import pytest

from conftest import REPO, run_node
from justwatts import course as C
from justwatts import history as H
from justwatts.engine import RideEngine

HARNESS = REPO / "tests" / "js" / "course_harness.mjs"
GPX = (REPO / "tests" / "fixtures" / "course.gpx").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def js(node):
    return lambda reqs: run_node(node, HARNESS, reqs)


def close(a, b, tol=0.11, path="") -> None:
    """Deep equality with a tolerance on floats (the two engines round at 0.1; libm may differ by an ulp)."""
    if isinstance(a, dict):
        assert isinstance(b, dict) and set(a) == set(b), f"{path}: keys {sorted(a)} != {sorted(b)}"
        for k in a:
            close(a[k], b[k], tol, f"{path}.{k}")
    elif isinstance(a, list):
        assert isinstance(b, list) and len(a) == len(b), f"{path}: {a} != {b}"
        for i, (x, y) in enumerate(zip(a, b)):
            close(x, y, tol, f"{path}[{i}]")
    elif isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, (int, float)) and not isinstance(b, bool):
        assert abs(a - b) <= tol, f"{path}: {a} != {b}"
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


def line_pts(n, step_deg=0.0005, ele=lambda i: 0.0):
    return [{"lat": 37.8 + i * step_deg, "lon": -122.47, "ele": ele(i)} for i in range(n)]


# ---------- parsing ----------
def test_parse_gpx_fixture_matches_js(js):
    t = C.parse_track(GPX)
    assert t["name"] == "Hill & back" and len(t["pts"]) == 31
    assert t["pts"][7]["ele"] is None and t["pts"][7]["lat"] == 37.8035  # attributes in either order, missing <ele>
    assert t["pts"][0] == {"lat": 37.8, "lon": -122.47, "ele": 10.0}
    assert js([{"op": "parse", "text": GPX}])[0] == t


def test_parse_tcx_and_route_points(js):
    tcx = ("<?xml version='1.0'?><TrainingCenterDatabase><Courses><Course><Name>Loop</Name><Track>"
           + "".join(f"<Trackpoint><Time>x</Time><Position><LatitudeDegrees>{37.8 + i * 0.001}</LatitudeDegrees>"
                     f"<LongitudeDegrees>-122.4</LongitudeDegrees></Position><AltitudeMeters>{i * 2}</AltitudeMeters></Trackpoint>"
                     for i in range(5))
           + "<Trackpoint><Time>no position</Time></Trackpoint></Track></Course></Courses></TrainingCenterDatabase>")
    rte = '<gpx><rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="1.01" lon="2"><ele>5</ele></rtept></rte></gpx>'
    py = [C.parse_track(tcx), C.parse_track(rte), C.parse_track("not xml")]
    assert py[0]["name"] == "Loop" and len(py[0]["pts"]) == 5 and py[0]["pts"][4]["ele"] == 8
    assert py[1]["pts"] == [{"lat": 1, "lon": 2, "ele": None}, {"lat": 1.01, "lon": 2, "ele": 5}]
    assert py[2]["pts"] == []
    assert js([{"op": "parse", "text": x} for x in (tcx, rte, "not xml")]) == py


# ---------- profile ----------
def test_build_fixture_matches_js(js):
    t = C.parse_track(GPX)
    c = C.build_course(t["name"], t["pts"])
    assert 1550 < c["dist"] < 1700 and len(c["ele"]) == c["dist"] // 10 + 1
    assert 30 <= c["gain"] <= 45 and c["ll"][0] == [37.8, -122.47] and len(c["ll"]) == 30
    close(js([{"op": "build", "text": GPX}])[0], c, tol=0.051)


def test_smoothing_removes_spikes_and_grade_is_clamped(js):
    spike = line_pts(40, step_deg=0.0001, ele=lambda i: 100.0 + (60 if i == 20 else 0))  # one bad point, 11 m apart
    c = C.build_course("Spike", spike)
    assert max(c["ele"]) < 101 and c["gain"] <= 1
    wall = line_pts(60, step_deg=0.0001, ele=lambda i: i * 4.0)  # about 36 % for the whole way
    w = C.build_course("Wall", wall)
    assert {C.grade_at(w, d) for d in range(100, 500, 10)} == {20.0}
    down = C.build_course("Down", line_pts(60, step_deg=0.0001, ele=lambda i: 500 - i * 4.0))
    assert C.grade_at(down, 300) == -15.0
    flat = C.build_course("No ele", [{"lat": p["lat"], "lon": p["lon"]} for p in line_pts(10)])
    assert set(flat["ele"]) == {0} and flat["gain"] == 0
    res = js([{"op": "buildPts", "name": "Spike", "pts": spike}, {"op": "buildPts", "name": "Wall", "pts": wall},
              {"op": "buildPts", "name": "short", "pts": line_pts(2, step_deg=0.0001)}])
    close(res[0], c, tol=0.051)
    close(res[1], w, tol=0.051)
    assert res[2] == {"error": "Course too short"}
    with pytest.raises(ValueError, match="too short"):
        C.build_course("short", line_pts(2, step_deg=0.0001))
    with pytest.raises(ValueError, match="too long"):
        C.build_course("long", [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 5}])


def test_lookups_and_profile_match_js(js):
    c = js([{"op": "samples"}])[0][2]  # the bundled climb
    assert c["name"] == "The climb" and c["dist"] == 12000 and 515 <= c["gain"] <= 525
    at = [-5, 0, 5, 1999, 2000, 2005, 6000, 9999, 11995, 12000, 20000]
    py = [[C.grade_at(c, d), C.ele_at(c, d)] for d in at]
    close(js([{"op": "lookup", "course": c, "at": at}])[0], py, tol=1e-9)
    assert py[0] == py[1] and py[-1][1] == c["ele"][-1]
    assert 5 <= C.grade_at(c, 6000) <= 8 and C.grade_at(c, 500) == 0
    prof = C.profile_of(c)
    assert len(prof) == 300 and prof[0] == c["ele"][0] and prof[-1] == c["ele"][-1]
    assert js([{"op": "profile", "course": c, "n": 300}])[0] == prof
    for s in js([{"op": "samples"}])[0]:
        assert C.check_course(s)["gain"] == s["gain"] and s["ll"] == []


def test_check_course_rejects_bad_input(js):
    good = {"name": "x", "dist": 200, "ele": [0, 1, 2]}
    assert C.check_course(good)["gain"] == 2
    bad = [None, {"dist": 200, "ele": [0]}, {"dist": 50, "ele": [0, 1]}, {"dist": 200, "ele": [0, "1"]},
           {"dist": 200, "ele": [0, float("1e9")]}, {"dist": "200", "ele": [0, 1]}]
    for b in bad:
        with pytest.raises(ValueError):
            C.check_course(b)
    assert all("error" in r for r in js([{"op": "check", "course": b} for b in bad]))


# ---------- speed from power ----------
def test_speed_from_power():
    def settle(w, g, s=120, v=0.0):
        for _ in range(s):
            v = C.speed_step(v, w, g, 84, 1)
        return v * 3.6
    flat = settle(200, 0)
    assert 32 < flat < 35  # 200 W, 84 kg, CdA 0.32: about 33.7 km/h
    assert 11 < settle(200, 6.5) < 13
    assert settle(400, 0) > flat
    assert C.speed_step(0, 200, 0, 84, 1) * 3.6 < 15  # momentum: not at full speed after one second
    assert settle(0, -6, v=10 / 3.6) > 40  # coasting downhill speeds up
    assert settle(0, 4, v=10) == 0  # no power uphill: stops, never rolls back


def test_speed_matches_js(js):
    rng = random.Random(3)
    seq = [[rng.choice([0, 120, 250, 600]), rng.uniform(-12, 18), rng.choice([1, 1, 2.5, 0.4])] for _ in range(300)]
    v, py = 0.0, []
    for w, g, dt in seq:
        v = C.speed_step(v, w, g, 82, dt)
        py.append(v)
    close(js([{"op": "speed", "seq": seq, "mass": 82}])[0], py, tol=1e-9)


# ---------- riding a course ----------
class Reading:
    power = cadence = speed = hr = 0
    hr_last = last = 0.0


class Hub:
    mode = "ble"

    def __init__(self):
        self.r, self.wanted_cmd, self.sent = Reading(), None, []

    def want(self, c):
        self.wanted_cmd = c
        if not self.sent or self.sent[-1] != c:
            self.sent.append(c)

    def status(self):
        return {}


def run_python(tmp_path, script, settings=None):
    t, wall, lines = [1000.0], [1.7e9], []
    s = {"ftp": 200, "afterWorkout": "hold", "weight": 75, **(settings or {})}
    hub = Hub()
    eng = RideEngine(hub, tmp_path, lambda l: (lines.append(l), eng.note(l)), lambda: s, clock=lambda: t[0], wall=lambda: wall[0])
    out = []
    for op, a in script:
        res = None
        if op == "power":
            hub.r.power, hub.r.cadence, hub.r.last = a, 90 if a > 0 else 0, t[0]
        elif op == "tick":
            for _ in range(a):
                t[0] += 1
                wall[0] += 1
                hub.r.last = t[0]
                eng.tick(1.0)
        elif op == "set":
            s.update(a)
        else:
            try:
                x = eng.control(op, a or {})
                res = x["n"] if op == "road" else "ok"
            except ValueError as e:
                res = f"error: {e}"
        r = eng.state({})["ride"]
        out.append({"op": op, "res": res, "course": r and r["course"] and {**r["course"], "profile": len(r["course"]["profile"])},
                    "control": r and r["control"], "want": hub.wanted_cmd, "last": (eng.ride.samples[-1] if eng.ride.samples else None) if r else None})
    p = eng.ride.payload() if eng.ride else None
    if p is None and eng.last_finished:  # ended: the archived ride
        p = json.loads((eng.rides_dir / f"{eng.last_finished['id']}.json").read_text(encoding="utf-8"))
    return {"out": out, "sent": hub.sent, "lines": [x for x in lines if x.startswith(("COURSE", "WORKOUT"))],
            "samples": p and [x[1:] for x in p["samples"]], "payload": p}, eng


def samples(js):
    return {c["id"]: c for c in js([{"op": "samples"}])[0]}


def test_course_ride_on_server_engine(js, tmp_path):
    climb = samples(js)["s-climb"]
    script = [["power", 250], ["load", {"workout": None, "course": climb}], ["start", {}], ["tick", 60], ["tick", 600],
              ["adjust", {"dir": 1}], ["tick", 3]]
    res, eng = run_python(tmp_path, script)
    first, flat, climbing, offset = res["out"][3], res["out"][3]["course"], res["out"][4]["course"], res["out"][5]
    assert eng.ride.name == "The climb" and first["control"] == "g"
    assert 400 < flat["done_m"] < 650 and flat["grade"] == 0 and flat["climbed_m"] < 1  # first 2 km are flat
    assert climbing["grade"] > 4 and climbing["climbed_m"] > 50 and 10 < climbing["speed_kmh"] < 20
    assert res["out"][4]["want"] == {"k": "sim", "g": climbing["grade"]}
    assert offset["want"]["g"] == pytest.approx(climbing["grade"] + 0.5, abs=0.25)  # +/- shifts the road grade
    x, end = res["samples"][-1], res["out"][6]["course"]  # x = [el, p, cad, hr, speed, target, alt, dist]
    assert len(x) == 8 and x[6] == end["ele_m"] and x[7] == end["odo_m"]
    assert x[4] == pytest.approx(end["speed_kmh"], abs=0.06)
    # rate limit: a sim command only for a change over 0.1 % or after 2 s; never a flood
    sims = [c["g"] for c in res["sent"] if c["k"] == "sim"]
    assert 5 < len(sims) < 664 / 2 + 5
    assert H.summarize(res["payload"])["dist"] == x[7]


def test_course_end_holds_or_goes_flat(js, tmp_path):
    flat = {"name": "Short hill", "dist": 300, "ele": [i * 0.5 for i in range(31)]}  # 5 % for 300 m
    script = [["power", 300], ["load", {"workout": None, "course": flat}], ["start", {}], ["tick", 60], ["tick", 3],
              ["set", {"afterWorkout": "grade0"}], ["tick", 3]]
    res, eng = run_python(tmp_path, script)
    assert res["lines"] and res["lines"][0].startswith("COURSE DONE at T+")
    done = res["out"][3]["course"]
    assert done["end"] and done["done_m"] == 300 and done["odo_m"] > 300 and done["climbed_m"] == pytest.approx(15, abs=0.2)
    assert eng.notice == "Course done. Keep riding or press End ride." and eng.ride.started  # the ride goes on
    assert res["out"][4]["want"] == {"k": "sim", "g": 5.0}  # hold: the last grade
    assert res["out"][6]["want"] == {"k": "sim", "g": 0.0}  # grade0: flat after the finish
    assert res["samples"][-1][7] > res["samples"][-10][7]  # distance keeps counting


def test_workout_with_course_erg_on_targets_grade_on_free(js, tmp_path):
    rolling = samples(js)["s-rolling"]
    wk = {"name": "Mix", "text": "1m 200w, 1m free, 1m 150w"}
    script = [["power", 200], ["load", {"workout": wk, "course": rolling}], ["start", {}], ["tick", 30], ["tick", 60],
              ["tick", 60], ["mode", {"m": "g"}], ["tick", 2]]
    res, eng = run_python(tmp_path, script)
    erg, free, erg2, off = res["out"][3], res["out"][4], res["out"][5], res["out"][7]
    assert erg["control"] == "k" and erg["want"] == {"k": "erg", "w": 200}
    assert free["control"] == "g" and free["want"] == {"k": "sim", "g": free["course"]["grade"]}
    assert erg2["control"] == "k" and erg2["want"] == {"k": "erg", "w": 150}
    assert off["control"] == "g" and off["want"]["k"] == "sim"  # ERG off: the course grade all the way
    ds = [o["course"]["odo_m"] for o in res["out"] if o["op"] == "tick"]
    assert all(b > a for a, b in zip(ds, ds[1:]))  # position always advances
    assert eng.ride.name == "Mix" and eng.state({})["ride"]["course"]["name"] == "Rolling hills"


SCRIPTS = {
    "climb": (None, "s-climb", {}, [["power", 250], ["start", {}], ["tick", 40], ["adjust", {"dir": 1}], ["tick", 700],
                                    ["power", 0], ["tick", 2], ["power", 320], ["free", {"m": "g", "value": -1}], ["tick", 900],
                                    ["mode", {"m": "w"}], ["tick", 5], ["set", {"afterWorkout": "grade0"}], ["mode", {"m": "g"}],
                                    ["tick", 600]]),
    "workout": ({"name": "Mix", "text": "1m 200w, 2m free, 1m 50%"}, "s-rolling", {"weight": 90},
                [["power", 180], ["start", {}], ["tick", 70], ["tick", 130], ["skip", {}], ["tick", 90], ["tick", 5]]),
    "flat": (None, "s-flat", {"weight": 0}, [["power", 150], ["start", {}], ["tick", 100], ["pause", {}], ["tick", 5],
                                             ["pause", {}], ["tick", 50]]),
    "coast": (None, "s-rolling", {}, [["power", 300], ["start", {}], ["tick", 400], ["power", 0], ["tick", 60]]),
}


def test_coasting_downhill_does_not_auto_pause(tmp_path):
    down = {"name": "Down", "dist": 3000, "ele": [300 - i * 0.6 for i in range(301)]}  # -6%
    res, eng = run_python(tmp_path, [["power", 200], ["load", {"workout": None, "course": down}], ["start", {}], ["tick", 30],
                                     ["power", 0], ["tick", 20]])
    r = eng.state({})["ride"]
    assert not r["paused"] and r["course"]["speed_kmh"] > 20
    flat = {"name": "Flat", "dist": 3000, "ele": [10.0] * 301}
    res, eng = run_python(tmp_path, [["power", 200], ["load", {"workout": None, "course": flat}], ["start", {}], ["tick", 30],
                                     ["power", 0], ["tick", 120]])
    assert eng.state({})["ride"]["paused"]  # on the flat the rider rolls to a stop, then it pauses


def test_summary_has_elevation_gain_on_a_course(js, tmp_path):
    res, eng = run_python(tmp_path, [["power", 260], ["load", {"workout": None, "course": samples(js)["s-climb"]}], ["start", {}], ["tick", 900]])
    p = res["payload"]
    up = H.detail(p)["summary"]["elevation_gain_m"]
    assert up > 20 and up == round(sum(max(0, b[7] - a[7]) for a, b in zip(p["samples"], p["samples"][1:])))


@pytest.mark.parametrize("name", SCRIPTS)
def test_js_engine_rides_a_course_like_python(js, tmp_path, name):
    workout, cid, settings, script = SCRIPTS[name]
    script = [["load", {"workout": workout, "course": samples(js)[cid]}], *script]
    py, _ = run_python(tmp_path, script, settings)
    jr = js([{"op": "ride", "settings": settings, "script": script}])[0]
    for i, (a, b) in enumerate(zip(py["out"], jr["out"])):
        close(a, {**b, "last": b["last"] and [a["last"][0], *b["last"][1:]]}, path=f"step {i} {script[i][0]}")  # wall clocks differ
    assert len(py["out"]) == len(jr["out"])
    close(py["samples"], jr["samples"], path="samples")
    close(py["sent"], jr["sent"], path="sent")
    assert py["lines"] == jr["lines"]


# ---------- export ----------
def test_fit_and_tcx_carry_course_distance_and_altitude(js, tmp_path):
    fitdecode = pytest.importorskip("fitdecode")
    climb = samples(js)["s-climb"]
    res, eng = run_python(tmp_path, [["power", 260], ["load", {"workout": None, "course": climb}], ["start", {}], ["tick", 900]])
    p = res["payload"]
    data = H.fit_encode(p)
    recs = []
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.RAISE) as fr:
        for frame in fr:
            if isinstance(frame, fitdecode.FitDataMessage) and frame.name == "record":
                recs.append(frame)
            if isinstance(frame, fitdecode.FitDataMessage) and frame.name == "session":
                ses = frame
    last = p["samples"][-1]
    assert recs[-1].get_value("distance") == pytest.approx(last[8], abs=0.01)
    assert recs[-1].get_value("altitude") == pytest.approx(last[7], abs=0.2)
    assert recs[0].get_value("altitude") == pytest.approx(50, abs=0.2)
    assert ses.get_value("total_distance") == pytest.approx(last[8], abs=0.01)
    out = js([{"op": "export", "ride": p}])[0]
    assert base64.b64decode(out["fit"]) == data  # JS and Python encoders write the same bytes
    assert out["tcx"] == H.tcx(p) and out["dist"] == last[8]
    root = ET.fromstring(H.tcx(p).encode())
    ns = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"}
    tps = root.findall(".//t:Trackpoint", ns)
    assert float(tps[-1].find("t:AltitudeMeters", ns).text) == pytest.approx(last[7], abs=0.05)
    assert float(tps[-1].find("t:DistanceMeters", ns).text) == pytest.approx(last[8], abs=0.05)


def test_exports_carry_gps_from_the_map_line(js, tmp_path):
    # a course with a map line: FIT records and TCX trackpoints get positions along it, and FIT says virtual
    fitdecode = pytest.importorskip("fitdecode")
    alpe = route_courses(js)["r-alpe"]
    res, eng = run_python(tmp_path, [["power", 300], ["load", {"workout": None, "course": alpe}], ["start", {}], ["tick", 600]])
    p = res["payload"]
    data = H.fit_encode(p)
    recs, ses = [], None
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.RAISE) as fr:
        for frame in fr:
            if isinstance(frame, fitdecode.FitDataMessage) and frame.name == "record":
                recs.append(frame)
            if isinstance(frame, fitdecode.FitDataMessage) and frame.name == "session":
                ses = frame
    deg = lambda v: v * 180 / 2 ** 31  # noqa: E731
    first, last = recs[0], recs[-1]
    assert deg(first.get_value("position_lat")) == pytest.approx(alpe["ll"][0][0], abs=1e-4)
    assert deg(first.get_value("position_long")) == pytest.approx(alpe["ll"][0][1], abs=1e-4)
    assert 45.05 < deg(last.get_value("position_lat")) < 45.1 and 6.03 < deg(last.get_value("position_long")) < 6.08
    assert ses.get_value("sub_sport", raw_value=True) == 58
    out = js([{"op": "export", "ride": p}])[0]
    assert base64.b64decode(out["fit"]) == data and out["tcx"] == H.tcx(p)
    root = ET.fromstring(H.tcx(p).encode())
    ns = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"}
    lat = [float(e.text) for e in root.findall(".//t:Position/t:LatitudeDegrees", ns)]
    assert len(lat) == len(p["samples"]) and lat[0] == pytest.approx(alpe["ll"][0][0], abs=1e-4)


def test_fit_import_reads_positions_and_altitude(js, tmp_path):
    # an exported course ride is a valid FIT track: importing it gives back the road
    alpe = route_courses(js)["r-alpe"]
    res, eng = run_python(tmp_path, [["power", 400], ["load", {"workout": None, "course": alpe}], ["start", {}], ["tick", 900]])
    p = res["payload"]
    t = js([{"op": "parseFit", "b64": base64.b64encode(H.fit_encode(p)).decode()}])[0]
    assert len(t["pts"]) == len(p["samples"])
    assert t["pts"][0]["lat"] == pytest.approx(alpe["ll"][0][0], abs=1e-4)
    assert t["pts"][-1]["ele"] == pytest.approx(p["samples"][-1][7], abs=0.2)
    bad = js([{"op": "parseFit", "b64": base64.b64encode(b"<gpx></gpx>").decode()}, {"op": "parseFit", "b64": base64.b64encode(H.fit_encode(p)[:40]).decode()}])
    assert bad[0] == {"error": "Not a FIT file"} and "error" in bad[1]


def test_course_ride_resumes_after_restart(js, tmp_path):
    hill = {"name": "Hill", "dist": 2000, "ele": [i * 0.4 for i in range(201)]}
    res, eng = run_python(tmp_path, [["power", 220], ["load", {"workout": None, "course": hill}], ["start", {}], ["tick", 47]])
    before = eng.state({})["ride"]["course"]
    eng._close_journal()
    hub = Hub()
    s = {"ftp": 200, "weight": 75}
    eng2 = RideEngine(hub, tmp_path, lambda l: None, lambda: s, wall=lambda: 1.7e9 + 60)
    assert eng2.resume()
    after = eng2.state({})["ride"]["course"]
    assert after["name"] == "Hill" and after["odo_m"] == pytest.approx(before["odo_m"], abs=10)
    assert len(eng2.ride.samples) == 47 and all(len(x) == 9 for x in eng2.ride.samples)  # journal lines with course fields
    assert hub.wanted_cmd["k"] == "sim" and hub.wanted_cmd["g"] == pytest.approx(4.0, abs=0.1)


def test_load_rejects_a_bad_course_without_ending_the_ride(tmp_path):
    res, eng = run_python(tmp_path, [["power", 200], ["load", {"workout": None}], ["start", {}], ["tick", 3],
                                     ["load", {"workout": None, "course": {"dist": 5, "ele": [1]}}]])
    assert res["out"][-1]["res"].startswith("error") and eng.ride.started and eng.ride.course is None


def test_course_done_line_parses():
    from justwatts import events as E
    ev = E.parse_line("[10:00:00] COURSE DONE at T+1:02:03, riding on until End")
    assert ev["type"] == "course_done" and ev["elapsed_s"] == 3723


CATS = {"Climb", "Marin", "70.3/Ironman", "Tour de France", "Classic"}


def route_courses(js):
    return {c["id"]: c for c in js([{"op": "routes"}])[0]}


def test_bundled_route_courses_are_well_formed(js):
    # every real-road course: a profile point per 10 m, a map line, sane numbers, rideable grades
    src = (REPO / "app/js/course-routes.js").read_text(encoding="utf-8")
    assert "OpenStreetMap" in src.splitlines()[0] and "Copernicus" in src.splitlines()[0]
    assert len(src.encode()) < 1_500_000
    cs = js([{"op": "routes"}])[0]
    ids = [c["id"] for c in cs]
    assert len(ids) == len(set(ids)) and {"r-hawk", "r-olh", "r-alpe"} <= set(ids)
    assert len(cs) >= 20 and all(c["cat"] in CATS for c in cs) and sum(c["dist"] > 60_000 for c in cs) >= 3 and max(c["dist"] for c in cs) > 100_000
    assert [c["dist"] for c in cs] == sorted(c["dist"] for c in cs)  # the list reads shortest first
    for c in cs:
        ele, ll = c["ele"], c["ll"]
        assert c["name"] and len(c["name"]) <= 80, c["id"]
        assert abs(len(ele) - (c["dist"] / 10 + 1)) <= 1, c["id"]  # one point per 10 m
        assert all(isinstance(x, (int, float)) and math.isfinite(x) and -100 < x < 5000 for x in ele), c["id"]
        assert 2 <= len(ll) <= 500 and all(len(p) == 2 and all(math.isfinite(v) for v in p) for p in ll), c["id"]
        assert all(abs(p[0]) <= 90 and abs(p[1]) <= 180 for p in ll), c["id"]
        line = sum(C.haversine({"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}) for a, b in zip(ll, ll[1:]))
        assert 0.85 * c["dist"] < line <= 1.01 * c["dist"], c["id"]  # the map line follows the profile's road
        gain = sum(max(0, b - a) for a, b in zip(ele, ele[1:]))
        assert abs(gain - c["gain"]) <= 1, c["id"]
        assert max(abs(ele[i] - ele[i - 10]) / 100 for i in range(10, len(ele))) < 0.25, c["id"]  # over 100 m
        assert checked(c)


def checked(c):
    out = C.check_course(c)
    return out["dist"] == c["dist"] and len(out["ll"]) == len(c["ll"])


def test_samples_json_stays_small(js):
    for c in js([{"op": "samples"}])[0]:
        assert len(json.dumps(c)) < 60_000 and math.isclose(len(c["ele"]), c["dist"] / 10 + 1)


def test_http_load_with_course(srv, js):
    climb = samples(js)["s-climb"]
    code, res = srv.req("POST", "/api/ride/control", {"action": "load", "workout": None, "course": climb}, headers=srv.page)
    assert code == 200 and res["loaded"] == "The climb"
    code, st = srv.req("GET", "/api/state", headers=srv.bearer)
    st = st["state"]
    assert code == 200 and st["ride"]["course"]["dist_m"] == 12000 and len(st["ride"]["course"]["profile"]) == 300
    code, res = srv.req("POST", "/api/ride/control", {"action": "load", "course": {"dist": 1, "ele": []}}, headers=srv.page)
    assert code == 400


# ---------- open world: the page extends the course as the rider rides ----------
def _r1(x):
    return math.floor(x * 10 + 0.5) / 10


def hills(i):
    """A test road: 300 m flat, a 4 % climb to 570 m, then a 2 % descent."""
    return _r1(50 if i <= 30 else 50 + 0.4 * (min(i, 57) - 30) - 0.2 * max(0, i - 57))


def road(i0, n, e=hills, nd_every=5):
    """Points i0..i0+n-1 of a straight road north (10 m apart), with nd entries every few points."""
    return {"ele": [e(i) for i in range(i0, i0 + n)], "ll": [[round(37.8 + i * 10 / 111195, 6), -122.47] for i in range(i0, i0 + n)],
            "nd": [[i * 10.0, 1000 + i] for i in range(i0, i0 + n) if i % nd_every == 0]}


OPEN = {"name": "Open world", "open": True, **road(0, 31)}


def test_open_course_checks_match_js(js):
    bad = [{**OPEN, "ll": OPEN["ll"][:-1]}, {**OPEN, "ele": OPEN["ele"][:5], "ll": OPEN["ll"][:5]},
           {**OPEN, "nd": [[20.0, 1], [10.0, 2]]}, {**OPEN, "ll": [[91, 0]] * 31}, {**OPEN, "nd": [[0, 1.5]]}]
    out = js([{"op": "checkRide", "course": c} for c in [OPEN, *bad]])
    ok = C.check_ride_course(OPEN)
    close(out[0], ok)
    assert ok["dist"] == 300 and ok["open"] and len(ok["ll"]) == 31 and ok["nd"][0] == [0.0, 1000]
    for c, o in zip(bad, out[1:]):
        with pytest.raises(ValueError):
            C.check_ride_course(c)
        assert "error" in o
    # extend: append, replace ahead, never behind the rider; nd from the first new entry on is replaced
    c = C.check_ride_course(OPEN)
    cases = [({"at": 31, **road(31, 20)}, 0), ({"at": 25, **road(25, 10, e=lambda i: 60.0)}, 200), ({"at": 21, **road(21, 3)}, 200),
             ({"at": 31, **road(31, 5)}, 300), ({"at": 32, **road(32, 5)}, 0), ({"at": 10, "ele": [1], "ll": [[1, 2, 3]]}, 0)]
    out = js([{"op": "extend", "course": c, "body": b, "d": d} for b, d in cases])
    for (b, d), o in zip(cases, out):
        try:
            py = C.road_extend(c, b, d)
        except ValueError as e:
            assert o == {"error": str(e)}
            continue
        close(o, py)
    assert out[0]["dist"] == 500 and len(out[0]["ll"]) == 51
    assert out[1]["dist"] == 340 and out[1]["ele"][:25] == c["ele"][:25] and out[1]["ele"][25:] == [60.0] * 10
    assert [x[0] for x in out[1]["nd"]][-3:] == [200.0, 250.0, 300.0]
    assert out[2] == {"error": "road.at is behind the rider"}       # the rider is at 200 m: segment 20-21 stays
    assert out[3]["dist"] == 350                                    # a plain append always fits, even at the end
    assert out[4] == {"error": "road.at out of range"} and "error" in out[5]
    r = js([{"op": "ridden", "course": out[0], "d": 123.4}])[0]
    assert r == C.ridden(out[0], 123.4) and r["dist"] == 130 and len(r["ll"]) == 14 and all(x[0] <= 130 for x in r["nd"])


def test_road_extend_replaces_nd_from_the_new_part():
    c = C.check_ride_course(OPEN)
    b = {"at": 26, **road(26, 10)}
    b["nd"] = [[255.0, 7], [300.0, 8]]
    x = C.road_extend(c, b, 100)
    assert [n for _, n in x["nd"]] == [1000, 1005, 1010, 1015, 1020, 1025, 7, 8]  # 250 kept (before 255), 300 replaced


OPEN_SCRIPT = [["power", 250], ["load", {"workout": None, "course": OPEN}], ["start", {}], ["tick", 20],
               ["road", {"at": 31, **road(31, 30)}], ["tick", 40],
               ["road", {"at": 5, **road(5, 3)}],                       # behind the rider: refused
               ["road", {"at": 58, **road(58, 40)}], ["tick", 120],     # then waits at the end of the known road
               ["road", {"at": 98, **road(98, 100)}], ["tick", 20], ["adjust", {"dir": 1}], ["tick", 5]]


def test_js_engine_rides_an_extending_course_like_python(js, tmp_path):
    py, eng = run_python(tmp_path, OPEN_SCRIPT)
    jr = js([{"op": "ride", "settings": {}, "script": OPEN_SCRIPT}])[0]
    for i, (a, b) in enumerate(zip(py["out"], jr["out"])):
        close(a, {**b, "last": b["last"] and [a["last"][0], *b["last"][1:]]}, path=f"step {i} {OPEN_SCRIPT[i][0]}")
    close(py["samples"], jr["samples"], path="samples")
    close(py["sent"], jr["sent"], path="sent")
    assert py["lines"] == jr["lines"] == []                                  # no COURSE DONE in an open world
    o = py["out"]
    assert o[4]["res"] == 61 and o[6]["res"].startswith("error: road.at is behind") and o[7]["res"] == 98 and o[9]["res"] == 198
    assert 310 < o[5]["course"]["odo_m"] < 570 and o[5]["course"]["grade"] == pytest.approx(4.0, abs=0.2)
    assert o[5]["want"] == {"k": "sim", "g": o[5]["course"]["grade"]}     # the trainer follows the new road
    stuck = o[8]["course"]
    assert stuck["odo_m"] == stuck["dist_m"] == 970 and stuck["open"] and stuck["n"] == 98 and not stuck["end"]
    assert o[10]["course"]["odo_m"] > 970 and o[10]["course"]["dist_m"] == 1970
    assert py["samples"][-1][7] == o[-1]["course"]["odo_m"]


def test_open_world_ride_ends_with_the_road_ridden_and_exports_gps(js, tmp_path):
    script = [["power", 250], ["load", {"workout": None, "course": {**OPEN, **road(0, 201)}}], ["start", {}], ["tick", 60], ["end", {}]]
    py, _ = run_python(tmp_path, script)
    jr = js([{"op": "ride", "settings": {}, "script": script}])[0]
    p, q = py["payload"], jr["payload"]
    d = p["samples"][-1][8]
    assert p["course"]["open"] and p["course"]["dist"] == (math.floor(d / 10) + 1) * 10 and len(p["course"]["ll"]) == len(p["course"]["ele"])
    close(p["course"], q["course"], path="course")
    root = ET.fromstring(H.tcx(p).encode())
    ns = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"}
    lat = [float(e.text) for e in root.findall(".//t:Position/t:LatitudeDegrees", ns)]
    assert len(lat) == 60 and lat[-1] == pytest.approx(37.8 + d / 111195, abs=2e-5)  # GPS where the rider got to


def test_open_world_ride_resumes_after_restart(tmp_path):
    res, eng = run_python(tmp_path, [["power", 250], ["load", {"workout": None, "course": OPEN}], ["start", {}], ["tick", 10],
                                     ["road", {"at": 31, **road(31, 60)}], ["tick", 37]])
    before = eng.state({})["ride"]["course"]
    eng._close_journal()
    hub = Hub()
    eng2 = RideEngine(hub, tmp_path, lambda l: None, lambda: {"ftp": 200, "weight": 75}, wall=lambda: 1.7e9 + 60)
    assert eng2.resume()
    after = eng2.state({})["ride"]["course"]
    assert after["open"] and after["n"] == 91 and after["odo_m"] == pytest.approx(before["odo_m"], abs=10)
    cp = eng2.course_payload()
    assert cp["course"]["nd"] == eng.ride.course["nd"] and cp["course"]["ll"] == eng.ride.course["ll"]
    assert eng2.control("road", {"at": 91, **road(91, 10)})["n"] == 101  # the page carries on extending


def test_http_ride_course_needs_the_page(srv):
    code, _ = srv.req("GET", "/api/ride/course")
    assert code == 403
    code, res = srv.req("GET", "/api/ride/course", headers=srv.page)
    assert code == 200 and res == {"course": None, "d": 0}
    code, res = srv.req("POST", "/api/ride/control", {"action": "load", "workout": None, "course": OPEN}, headers=srv.page)
    assert code == 200
    code, res = srv.req("POST", "/api/ride/control", {"action": "road", "at": 31, **road(31, 5)}, headers=srv.page)
    assert code == 200 and res["n"] == 36
    code, res = srv.req("GET", "/api/ride/course", headers=srv.page)
    assert code == 200 and len(res["course"]["ll"]) == 36 and res["course"]["open"]
