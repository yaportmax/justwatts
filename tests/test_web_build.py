"""Static web build: output layout, headers, and a full simulated ride in web mode (no server)."""
import json
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
    assert not {"connect.html", "js/package.json", "sw.js"} & files  # server-only pages, no PWA cache
    api = {f for f in files if f.startswith("api/")}                                  # the Strava token relay + accounts API
    assert {f for f in api if not f.startswith("api/_lib/")} == {"api/strava/token.js", "api/accounts.js"}  # _lib is not routed
    pkg = json.loads((dist / "package.json").read_text())                             # Vercel installs the one dependency
    assert pkg["dependencies"] == {"@neondatabase/serverless": "1.2.0"} and (dist / "package-lock.json").exists()
    assert "privacy.html" in files
    assert "MODE = 'web'" in (dist / "js/mode.js").read_text()
    assert "MODE = 'server'" in (REPO / "app/js/mode.js").read_text()                # the local app is untouched


def test_vercel_headers(dist):
    v = json.loads((dist / "vercel.json").read_text())
    h = {x["key"]: x["value"] for x in v["headers"][0]["headers"]}
    csp = h["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "script-src 'self'" in csp and "connect-src 'self';" in csp
    assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
    assert h["X-Content-Type-Options"] == "nosniff" and "bluetooth=(self)" in h["Permissions-Policy"]
    assert v["rewrites"] == [{"source": "/privacy", "destination": "/privacy.html"},
                             {"source": "/api/(auth|sync|community|admin)(/.*)?", "destination": "/api/accounts?__path=/api/$1$2"},
                             {"source": "/((?!api/)[^.]*)", "destination": "/index.html"}]  # /api/* reaches the functions
    assert v["regions"] == ["pdx1"]                                                   # next to the Neon database


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
    assert f["garminStatus"] == 503 and f["agent"] == {"connected": False} and f["meter"] == "none"
    assert [e.split(" ")[0] + " " + e.split(" ")[1] for e in f["events"]] == ["RIDE START", "RIDE RESUMED", "EDIT insert", "WORKOUT DONE", "RIDE END"]
    c = out["course"]                                                         # a course in use: Just ride rides it
    assert c["name"] == c["course"] == "The climb" and c["done"] > 100 and c["profile"] == 300 and c["now"] == "Rides use The climb"
    assert c["want"]["k"] == "sim" and c["strip"] == "" and "%" in c["text"]
    assert out["coachDefault"] is False                                       # no built-in coach on the web
    assert "Rep done" not in " ".join(out["spoken"])                        # and nothing coach-spoken
