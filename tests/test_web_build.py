"""Static web build: output layout, headers, and a full simulated ride in web mode (no server)."""
import json
import re
import subprocess
import sys

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "web"))
import build as web_build  # noqa: E402


@pytest.fixture(scope="module")
def dist(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist") / "dist-web"
    web_build.build(out)
    return out


def test_build_output(dist):
    files = {p.relative_to(dist).as_posix() for p in dist.rglob("*") if p.is_file()}
    assert {"index.html", "js/app.js", "js/core.js", "js/mode.js", "js/web/backend.js", "css/app.css", "vercel.json", "icon.svg"} <= files
    ml = "vendor/maplibre-gl-5.24.0/"                                                # 3D map, pinned, no CDN (CSP)
    assert {ml + f for f in ("maplibre-gl-csp.js", "maplibre-gl-csp-worker.js", "maplibre-gl.css", "LICENSE.txt")} <= files
    assert not {"connect.html", "js/package.json", "sw.js"} & files  # server-only pages, no PWA cache
    lib = {f"api/_lib/integrations/{m}.js" for m in ("base", "crypto", "store", "planned", "intervals", "trainingpeaks",
                                                      "garmin", "hub", "http", "session")}
    assert {f for f in files if f.startswith("api/")} == {"api/strava/token.js", "api/integrations.js", *lib}  # serverless only
    assert "MODE = 'web'" in (dist / "js/mode.js").read_text()
    assert "MODE = 'server'" in (REPO / "app/js/mode.js").read_text()                # the local app is untouched


def test_vercel_headers(dist):
    v = json.loads((dist / "vercel.json").read_text())
    h = {x["key"]: x["value"] for x in v["headers"][0]["headers"]}
    csp = h["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "script-src 'self';" in csp and "worker-src 'self';" in csp
    connect = re.search(r"connect-src ([^;]+);", csp).group(1).split()                 # map tiles + terrain only
    assert connect[0] == "'self'" and all(h.startswith("https://") and "*" not in h for h in connect[1:])
    assert "https://s3.amazonaws.com" in connect and "https://server.arcgisonline.com" in csp
    assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
    assert h["X-Content-Type-Options"] == "nosniff" and "bluetooth=(self)" in h["Permissions-Policy"]
    assert v["rewrites"] == [{"source": "/((?!api/)[^.]*)", "destination": "/index.html"}]  # /api/* reaches the function


def test_web_mode_ride_with_reload(dist, node):
    p = subprocess.run([node, str(REPO / "tests/js/web_smoke.mjs"), str(dist)], capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out["mode"] == "web" and out["webClass"] and out["notice"] == ""   # Web Bluetooth notice shown in node
    assert out["before"]["samples"] == 47
    rs = out["resumed"]                                                      # the "reload": IndexedDB snapshot + journal
    assert rs["name"] == "Web ride" and rs["samples"] == 47 and rs["paused"] and rs["auto"]
    assert out["overtime"] is True
    f = out["final"]
    assert out["restored"] == {"custom": ["c-test1"], "courses": ["k-test1"]}
    assert f["rides"] == 1 and f["samples"] == 247 and f["fit"] == ".FIT" and f["backupRides"] == 1 and f["steps"] == 3
    assert f["garminStatus"] == 503 and out["oldKeys"] == []
    assert [e.split(" ")[0] + " " + e.split(" ")[1] for e in f["events"]] == ["RIDE START", "RIDE RESUMED", "EDIT insert", "WORKOUT DONE", "RIDE END"]
    k = out["picks"]                                                          # per-ride course picks
    assert out["oldCourse"] is False                                         # the old global course is dropped
    assert k["flatWorkout"] == {"name": "Sweet spot 2x12", "course": None, "plan": True}
    assert k["wPicker"] == {"sel": "lrow sel", "html": True}
    assert k["workoutCourse"] == {"name": "Sweet spot 2x12", "course": "Rolling hills", "plan": True}
    assert k["cPicker"] == {"sel": "lrow sel", "html": True}
    assert k["courseWorkout"] == {"name": "Sweet spot 2x12", "course": "Hawk Hill, Marin", "plan": True}
    assert k["test"]["course"] is None                                       # FTP tests never take a course
    assert k["justFlat"]["course"] is None and not k["justFlat"]["plan"]      # Just ride: one click, flat
    c = out["course"]                                                         # Just ride on the course picked next to it
    assert c["name"] == c["course"] == "The climb" and c["done"] > 100 and c["profile"] == 300
    assert c["want"]["k"] == "sim" and c["strip"] == "" and "%" in c["text"]
