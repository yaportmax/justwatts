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
    toasts = dict(out["log"])
    assert toasts["plus button"] == "Intensity 101%" and toasts["shift up"] == "Intensity 106%"
    assert toasts["undo button"] == "Undone" and toasts["skip key"] == "Skipped step 1"
    assert toasts["step watts +5"] == "Step 2: 205 W" and toasts["ERG off: grade"] == "Trainer: grade"
    assert toasts["workout +5m"].startswith("Workout ") and toasts["next steps"].startswith("Next steps set")
    assert out["tgtShown"] == "205"
    assert out["adjGrade"] == "Grade 3.0%" and out["tgtSub"].startswith("ERG off")
    assert out["nextErr"]  # a typo is caught before anything is sent
    b = out["before"]
    assert b["intensity"] == 1.0 and b["control"] == "k" and b["jr"]["wm"] == "e" and b["jr"]["g"] == 3
    assert b["steps"][1][3] and b["steps"][1][2] == 205  # step 2 set by hand
    assert [s[0] for s in b["steps"][-2:]] == [120, 60]  # the next steps typed in the sheet
    assert b["after_workout"] == "grade0"
    s = out["settings"]
    assert s["cadRange"] == [90, 95] and s["localCoach"]["enabled"] is False and s["beeps"] is False and s["voiceMode"] == "silent"
    m = out["manual"]
    for line in ("MANUAL intensity 101%", "MANUAL skip step 1", "MANUAL target step 2 205W", "MANUAL mode grade",
                 "MANUAL grade 2.5%", "MANUAL mode level", "MANUAL mode erg", "MANUAL back step 2"):
        assert line in m, line
    assert any(x.startswith("EDIT rest after step") for x in m) and any(x.startswith("EDIT duration total") for x in m)
    # the reload keeps every change and the new page shows it
    assert out["after"] == out["before"]
    assert out["shown"]["adj"] == "100%" and out["shown"]["target"] != "–"


def test_page_controls_on_the_local_server(node, srv):
    with FastTicker(srv.server.engine, period=0.05):
        out = run(node, "server", srv.port)
    assert out["mode"] == "server"
    check(out)
    # the server logged the rider's changes as MANUAL lines, and the agent stream carries them
    evs = srv.client.events(400)
    assert any(e["type"] == "manual" for e in evs)


def test_page_controls_in_the_web_build(node, dist):
    out = run(node, "web", dist)
    assert out["mode"] == "web"
    check(out)
