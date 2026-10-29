"""Event line formats: JS builders == Python builders, and the parser reads them back."""
import pytest

from conftest import REPO, run_node
from justwatts import events as E

HARNESS = REPO / "tests" / "js" / "harness.mjs"


def _l30(hr=True):
    return [[0, i, 200 + i, 85 + (i % 3), (150 + i // 3) if hr else 0, 30, 210] for i in range(30)]


CASE = dict(name="VO2 5x3", ftp=250, cw="12m 40-75%, 5x(3m 115%, 3m 50%)", el=1834.4, n=812, i=3, count=11,
            d=180, tgt=288, into=61, stepP=[280, 290, 300],
            acc={"i": 3, "p": [280, 290, 301], "h": [150, 160, 171], "c": [90, 91, 93], "tg": [288, 288, 288]},
            l30=_l30(), feel="harder", stepNo=4, hr=171)


@pytest.fixture(scope="module")
def js_lines(node):
    free = dict(CASE, cw=None, tgt=None, l30=_l30(hr=False), stepNo=None, hr=0,
                acc={"i": 0, "p": [100], "h": [], "c": [80], "tg": [0]})
    return run_node(node, HARNESS, [dict(CASE, op="lines"), dict(free, op="lines")])


def test_python_formatters_match_js(js_lines):
    a, b = js_lines
    c = CASE
    assert E.line_ride_start(c["name"], c["ftp"], 11, 12 * 60 + 30 * 60) == a["rideStart"]
    assert E.line_ride_start(c["name"], c["ftp"], None, None) == b["rideStart"]
    assert E.line_ride_end(c["el"]) == a["rideEnd"]
    assert E.line_step_start(c["i"], c["count"], c["d"], c["tgt"]) == a["stepStart"]
    assert E.line_step_start(c["i"], c["count"], c["d"], None) == b["stepStart"]
    assert E.line_step_end(**c["acc"]) == a["stepEnd"]
    assert E.line_step_end(i=0, p=[100], h=[], c=[80], tg=[0]) == b["stepEnd"]
    assert E.line_tick(c["el"], c["i"], c["count"], c["into"], c["d"], c["tgt"], c["l30"], c["stepP"]) == a["tick"]
    assert E.line_tick(c["el"], c["i"], c["count"], c["into"], c["d"], None, _l30(False), c["stepP"]) == b["tick"]
    assert E.line_feel(c["feel"], c["stepNo"], c["l30"], c["hr"]) == a["feel"]
    assert E.line_feel(c["feel"], None, _l30(False), 0) == b["feel"]


def test_parse_js_lines(js_lines):
    a, b = js_lines
    ev = E.parse_line("[07:31:02] " + a["tick"])
    assert ev["time"] == "07:31:02" and ev["type"] == "tick"
    assert ev["elapsed_s"] == 1834 and ev["step"] == 4 and ev["steps"] == 11
    assert ev["into_s"] == 61 and ev["left_s"] == 119 and ev["target_w"] == 288
    assert ev["power_30s"] == 215 and ev["step_avg_w"] == 290
    assert ev["hr"] == 159 and ev["hr_delta_30s"] == 9 and ev["cadence_30s"] == 86
    nb = E.parse_line(b["tick"])
    assert nb["type"] == "tick" and nb["target_w"] is None and nb["hr"] is None and nb["hr_delta_30s"] is None

    st = E.parse_line(a["stepStart"])
    assert (st["type"], st["step"], st["steps"], st["duration_s"], st["target_w"]) == ("step_start", 4, 11, 180, 288)
    assert E.parse_line(b["stepStart"])["target_w"] is None
    en = E.parse_line(a["stepEnd"])
    assert en["type"] == "step_end" and en["avg_w"] == 290 and en["hr_max"] == 171 and en["hr_end"] == 171
    assert E.parse_line(b["stepEnd"])["hr_avg"] is None
    fe = E.parse_line(a["feel"])
    assert fe["type"] == "feel" and fe["feel"] == "harder" and fe["step"] == 4 and fe["hr"] == 171
    assert E.parse_line(b["feel"])["step"] is None
    rs = E.parse_line(a["rideStart"])
    assert rs["type"] == "ride_start" and rs["name"] == "VO2 5x3" and rs["ftp"] == 250 and rs["steps"] == 11
    assert E.parse_line(b["rideStart"])["steps"] is None
    assert E.parse_line(a["resumed"])["samples"] == 812
    assert E.parse_line(a["rideEnd"])["elapsed_s"] == 1834


def test_parse_misc_lines():
    p = E.parse_line("[10:00:00] PAUSED (stopped pedaling)")
    assert p["type"] == "paused" and p["auto"] is True and p["time"] == "10:00:00"
    assert E.parse_line("PAUSED")["auto"] is False
    assert E.parse_line("RESUMED")["type"] == "resumed"
    c = E.parse_line("[10:00:01] " + E.line_coach({"seq": 17, "set": {"step": 3, "w": 240}, "msg": "HR 170 | easing"}))
    assert c["type"] == "coach" and c["seq"] == 17 and c["set"] == {"step": 3, "w": 240} and c["msg"] == "HR 170 | easing"
    assert E.parse_line(E.line_coach({"seq": 1, "set": {"step": "cur", "w": 200}}))["set"]["step"] == "cur"
    o = E.parse_line("[10:00:02] something new")
    assert o["type"] == "other" and o["text"] == "something new"


def test_tail_lines(tmp_path):
    f = tmp_path / "log"
    f.write_text("".join(f"line {i}\n" for i in range(5000)), encoding="utf-8")
    assert E.tail_lines(f, 3) == ["line 4997", "line 4998", "line 4999"]
    assert E.tail_lines(tmp_path / "missing", 3) == []
