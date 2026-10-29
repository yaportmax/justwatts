"""Every mid-ride control, driven through the real page (buttons, Adjust sheet, keys), in the local
server mode and the web build, then a reload in the middle that must keep every manual change."""
import json
import subprocess
import sys

import pytest

from conftest import REPO
from test_app_smoke import FastTicker

sys.path.insert(0, str(REPO / "web"))
import build as web_build  # noqa: E402

SCRIPT = REPO / "tests" / "js" / "page_controls.mjs"


@pytest.fixture(scope="module")
def dist(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist") / "dist-web"
    web_build.build(out)
    return out


def run(node, *args):
    p = subprocess.run([node, str(SCRIPT), *map(str, args)], capture_output=True, text=True, timeout=120, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def check(out):
    assert out["undoShown"] == "" and out["sheetOpen"] and out["keysOpen"] and out["closed"]
    assert out["tab0"] == {"w": "", "c": "none"}                             # Workouts tab first
    assert out["tab1"] == {"w": "none", "c": "", "on": [False, True]}
    assert out["tab2"] == out["tab1"]                                        # remembered after the reload
    toasts = dict(out["log"])
    assert toasts["plus button"] == "Intensity 101%" and toasts["shift up"] == "Intensity 106%"
    assert toasts["undo button"] == "Undone" and toasts["skip key"] == "Skipped segment 1"
    assert toasts["step watts +5"] == "Segment 2: 205 W" and toasts["ERG off: grade"] == "Trainer: grade"
    assert toasts["next steps"].startswith("Plan set")
    assert out["tgtShown"] == "205"
    assert out["adjGrade"] == "Grade 3.0%" and out["tgtSub"].startswith("ERG off")
    assert out["nextErr"]  # a typo is caught before anything is sent
    b = out["before"]
    assert b["intensity"] == 1.0 and b["control"] == "k" and b["jr"]["wm"] == "e" and b["jr"]["g"] == 3
    assert "1" in b["ov"] and b["steps"][1][2] == 205  # step 2 set by hand
    assert b["steps"][-1][0] == 60 and 100 <= b["steps"][-2][0] <= 120  # typed in the sheet: this segment becomes 2m in total, then 1m
    assert b["after_workout"] == "grade0"
    s = out["settings"]
    assert s["cadRange"] == [90, 95] and s["beeps"] is False
    assert s["cadOn"] is False                                     # one setting: the sheet and Settings both change it
    assert out["cadOff"] == {"tile": "none", "range": "none", "settings": "0", "loDisabled": True, "back": ""}
    assert out["focusNoMap"] is False                              # F without a course map does nothing
    f = out["focus"]                                               # with one, F and the map button swap map and chart
    assert f["on"] and f["stored"] == "true" and f["title"] == "Chart focus (F)" and f["off"] and f["stored2"] == "false"
    assert f["dist"].endswith(" up")                              # climbed, next to the distance
    m = out["manual"]
    for line in ("MANUAL intensity 101%", "MANUAL skip step 1", "MANUAL target step 2 205W", "MANUAL mode grade",
                 "MANUAL grade 2.5%", "MANUAL mode level", "MANUAL mode erg", "MANUAL back step 2"):
        assert line in m, line
    assert any(x.startswith("EDIT rest after step") for x in m)
    # the reload keeps every change and the new page shows it
    assert out["after"] == out["before"]
    assert out["shown"]["adj"] == "100%" and out["shown"]["target"] != "–"


def test_page_controls_on_the_local_server(node, srv):
    with FastTicker(srv.server.engine, period=0.05):
        out = run(node, "server", srv.port)
    assert out["mode"] == "server"
    check(out)
    # the server logged the rider's changes as MANUAL lines
    evs = srv.client.events(400)
    assert any(e["type"] == "manual" for e in evs)


def test_page_controls_in_the_web_build(node, dist):
    out = run(node, "web", dist)
    assert out["mode"] == "web"
    check(out)
