"""Event line formats: JS builders == Python builders, and the parser reads them back."""
import pytest

from conftest import REPO, run_node
from justwatts import events as E

HARNESS = REPO / "tests" / "js" / "harness.mjs"


CASE = dict(name="VO2 5x3", ftp=250, cw="12m 40-75%, 5x(3m 115%, 3m 50%)", el=1834.4, n=812, i=3, count=11,
            d=180, tgt=288, acc={"i": 3, "p": [280, 290, 301], "h": [150, 160, 171], "c": [90, 91, 93], "tg": [288, 288, 288]})


@pytest.fixture(scope="module")
def js_lines(node):
    free = dict(CASE, cw=None, tgt=None, acc={"i": 0, "p": [100], "h": [], "c": [80], "tg": [0]})
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


def test_parse_js_lines(js_lines):
    a, b = js_lines
    st = E.parse_line("[07:31:02] " + a["stepStart"])
    assert st["time"] == "07:31:02"
    assert (st["type"], st["step"], st["steps"], st["duration_s"], st["target_w"]) == ("step_start", 4, 11, 180, 288)
    assert E.parse_line(b["stepStart"])["target_w"] is None
    en = E.parse_line(a["stepEnd"])
    assert en["type"] == "step_end" and en["avg_w"] == 290 and en["hr_max"] == 171 and en["hr_end"] == 171
    assert E.parse_line(b["stepEnd"])["hr_avg"] is None
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
    m = E.parse_line("[10:00:01] MANUAL target step 3 240W")
    assert m["type"] == "manual" and m["action"] == "target" and m["detail"] == "step 3 240W"
    o = E.parse_line("[10:00:02] something new")
    assert o["type"] == "other" and o["text"] == "something new"


def test_tail_lines(tmp_path):
    f = tmp_path / "log"
    f.write_text("".join(f"line {i}\n" for i in range(5000)), encoding="utf-8")
    assert E.tail_lines(f, 3) == ["line 4997", "line 4998", "line 4999"]
    assert E.tail_lines(tmp_path / "missing", 3) == []
