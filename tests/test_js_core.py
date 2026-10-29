"""app/js/core.js run under node: workout DSL, toText round trip, FIT/TCX/ZWO encoders."""
import base64
import io
import math
import xml.etree.ElementTree as ET

import pytest

from conftest import REPO, run_node

HARNESS = REPO / "tests" / "js" / "harness.mjs"

CASES = [
    "10m 45-75%, 5x(3m 115%, 3m 50%), 1m 300w, 10m free",
    "10m 50%",
    "5m 50-90%",
    "1h 65%",
    "1m30s 120%",
    "90s 150w; 30sec 400w",
    "10min @ 80%",
    "2x(3x(30s 130%, 30s 50%), 5m 55%)",
    "3X(1M 100%,1M 50%)",
    "20m 97.5%",
    "5m 100-200w",
    "4m free, 1m 300 w",
]
ERRORS = {
    "": "Empty workout",
    "3x(1m 50%": "Missing )",
    "1m 50%)": "Unexpected )",
    "banana": "Can't read",
    "0m 50%": "Zero duration",
}


@pytest.fixture(scope="module")
def js(node):
    def call(reqs):
        return run_node(node, HARNESS, reqs)
    return call


def _same_steps(a, b):
    assert len(a) == len(b)
    for x, y in zip(a, b):
        assert x["d"] == y["d"]
        assert bool(x.get("free")) == bool(y.get("free"))
        if not x.get("free"):
            assert x["u"] == y["u"]
            assert math.isclose(x["a"], y["a"], abs_tol=1e-9) and math.isclose(x["b"], y["b"], abs_tol=1e-9)


def test_parse_examples(js):
    r = js([{"op": "parse", "text": CASES[0]}])[0]
    assert r["ok"]
    s = r["steps"]
    assert len(s) == 1 + 10 + 1 + 1
    assert s[0] == {"d": 600, "a": 0.45, "b": 0.75, "u": "%"}
    assert s[1] == {"d": 180, "a": 1.15, "b": 1.15, "u": "%"} and s[2]["a"] == 0.5
    assert s[11] == {"d": 60, "a": 300, "b": 300, "u": "w"}
    assert s[12] == {"d": 600, "free": True}
    assert r["text"] == "10m 45-75%, 5x(3m 115%, 3m 50%), 1m 300w, 10m free"


def test_durations_and_units(js):
    out = js([{"op": "parse", "text": t} for t in ("1h 65%", "1m30s 120%", "90s 150w; 30sec 400w", "10min @ 80%")])
    assert out[0]["steps"][0]["d"] == 3600
    assert out[1]["steps"][0]["d"] == 90
    assert [s["d"] for s in out[2]["steps"]] == [90, 30] and out[2]["steps"][1]["a"] == 400
    assert out[3]["steps"][0] == {"d": 600, "a": 0.8, "b": 0.8, "u": "%"}


@pytest.mark.parametrize("text", CASES)
def test_round_trip(js, text):
    first = js([{"op": "parse", "text": text}])[0]
    assert first["ok"], first
    again = js([{"op": "parse", "text": first["text"]}])[0]
    assert again["ok"], again
    _same_steps(first["steps"], again["steps"])
    assert again["text"] == first["text"]  # toText is a fixed point after one pass


def test_presets_round_trip(js):
    presets = js([{"op": "presets"}])[0]
    assert len(presets) >= 9
    outs = js([{"op": "parse", "text": p["text"]} for p in presets])
    for p, o in zip(presets, outs):
        assert o["ok"], p
        _same_steps(o["steps"], js([{"op": "parse", "text": o["text"]}])[0]["steps"])
    sweet = next(o for p, o in zip(presets, outs) if p["id"] == "p-sweetspot")
    assert sweet["text"] == "10m 40-75%, 3x(10m 90%, 5m 55%), 5m 50-40%"
    ramp = next(o for p, o in zip(presets, outs) if p["id"] == "t-ramp")
    assert ramp["total"] == 300 + 26 * 60


@pytest.mark.parametrize("text,err", ERRORS.items())
def test_parse_errors(js, text, err):
    r = js([{"op": "parse", "text": text}])[0]
    assert not r["ok"] and err in r["error"]


def test_step_watts_ramp_and_intensity(js):
    w = js([{"op": "watts", "text": "10m 50-100%, 1m 300w", "ftp": 200, "at": [0, 300, 599.9, 600, 660], "k": 1}])[0]
    assert w[0] == 100 and w[1] == 150 and w[2] == 200 and w[3] == 300 and w[4] is None
    k = js([{"op": "watts", "text": "1m 100%", "ftp": 250, "at": [0], "k": 1.05}])[0]
    assert k == [263]


def _ride(n=600, gap_at=300, gap_s=10, ftp=200):
    t0 = 1767250800000  # 2026-01-01T07:00:00Z
    samples, el, t = [], 0, t0
    for i in range(n):
        if i == gap_at:
            t += gap_s * 1000  # a pause
        el += 1
        p = 150 + (i % 60)
        hr = 0 if i < 5 else 100 + i // 10
        samples.append([t, el, p, 90, hr, 30.0, 160])
        t += 1000
    return {"id": "r-test", "name": "Test ride", "text": "10m 80%", "ftp": ftp, "start": t0, "samples": samples}


def test_fit_encoder_decodes_with_valid_crc(js):
    fitdecode = pytest.importorskip("fitdecode")
    ride = _ride()
    out = js([{"op": "fit", "ride": ride}])[0]
    data = base64.b64decode(out["b64"])
    assert data[8:12] == b".FIT" and data[0] == 14
    msgs = {}
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.RAISE) as fr:
        for frame in fr:
            if isinstance(frame, fitdecode.FitDataMessage):
                msgs.setdefault(frame.name, []).append(frame)
    recs = msgs["record"]
    assert len(recs) == 600
    assert recs[0].get_value("power") == 150
    assert recs[0].get_value("heart_rate") is None  # 0 bpm is written as invalid
    assert recs[10].get_value("heart_rate") == 101
    assert recs[0].get_value("cadence") == 90
    events = [(e.get_value("event"), e.get_value("event_type")) for e in msgs["event"]]
    assert events[0] == ("timer", "start") and events[-1] == ("timer", "stop_all")
    assert ("timer", "stop_all") in events[1:-1]  # pause gap recorded
    fid = msgs["file_id"][0]
    assert fid.get_value("type") == "activity" and fid.get_value("manufacturer") == "development"
    ses = msgs["session"][0]
    s = out["summary"]
    assert ses.get_value("sport") == "cycling" and ses.get_value("sub_sport") == "indoor_cycling"
    assert ses.get_value("avg_power") == round(s["avgP"])
    assert ses.get_value("max_power") == 209
    assert ses.get_value("normalized_power") == round(s["np"])
    assert ses.get_value("threshold_power") == 200
    assert math.isclose(ses.get_value("total_timer_time"), 600, abs_tol=0.01)
    assert math.isclose(ses.get_value("total_elapsed_time"), 610, abs_tol=0.01)
    assert msgs["activity"][0].get_value("num_sessions") == 1
    assert len(msgs["lap"]) == 1


def test_fit_crc_detects_corruption(js):
    fitdecode = pytest.importorskip("fitdecode")
    data = bytearray(base64.b64decode(js([{"op": "fit", "ride": _ride(n=60, gap_at=-1)}])[0]["b64"]))
    data[40] ^= 0xFF
    with pytest.raises(fitdecode.FitCRCError):
        with fitdecode.FitReader(io.BytesIO(bytes(data)), check_crc=fitdecode.CrcCheck.RAISE) as fr:
            for _ in fr:
                pass


def test_fit_crc_known_vector(js):
    # FIT SDK CRC-16 of the ASCII string "123456789" is 0xBB3D (CRC-16/ARC)
    assert js([{"op": "crc", "bytes": list(b"123456789")}])[0] == 0xBB3D


def test_tcx_is_valid_xml(js):
    tcx = js([{"op": "tcx", "ride": _ride(n=30, gap_at=-1)}])[0]
    root = ET.fromstring(tcx.encode())
    ns = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"}
    assert len(root.findall(".//t:Trackpoint", ns)) == 30
    assert root.find(".//t:Activity", ns).get("Sport") == "Biking"


def test_zwo_export(js):
    zwo = js([{"op": "zwo", "workout": {"name": "A & B", "text": "10m 50-75%, 2x(1m 300w, 1m 50%), 5m free"}, "ftp": 200}])[0]
    root = ET.fromstring(zwo.encode())
    assert root.find("name").text == "A & B"
    w = list(root.find("workout"))
    assert [e.tag for e in w] == ["Ramp", "SteadyState", "SteadyState", "SteadyState", "SteadyState", "FreeRide"]
    assert w[1].get("Power") == "1.500"  # 300 W at FTP 200
    assert w[0].get("PowerLow") == "0.500" and w[0].get("PowerHigh") == "0.750"


def test_fmt_t(js):
    assert js([{"op": "fmtT", "values": [0, 59.4, 59.5, 61, 3599, 3600, 3661]}])[0] == \
        ["0:00", "0:59", "1:00", "1:01", "59:59", "1:00:00", "1:01:01"]
