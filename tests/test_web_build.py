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
    assert not {"browser.html", "connect.html", "js/package.json", "sw.js"} & files  # server-only pages, no PWA cache
    assert not any(f.startswith("api/") for f in files)                              # no serverless functions
    assert "MODE = 'web'" in (dist / "js/mode.js").read_text()
    assert "MODE = 'server'" in (REPO / "app/js/mode.js").read_text()                # the local app is untouched


def test_vercel_headers(dist):
    v = json.loads((dist / "vercel.json").read_text())
    h = {x["key"]: x["value"] for x in v["headers"][0]["headers"]}
    csp = h["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "script-src 'self'" in csp and "connect-src 'self';" in csp
    assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
    assert h["X-Content-Type-Options"] == "nosniff" and "bluetooth=(self)" in h["Permissions-Policy"]
    assert v["rewrites"] == [{"source": "/([^.]*)", "destination": "/index.html"}]


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
    assert f["rides"] == 1 and f["samples"] == 247 and f["fit"] == ".FIT" and f["backupRides"] == 1 and f["steps"] == 3
    assert f["garminStatus"] == 503 and f["agent"] == {"connected": False} and f["meter"] == "none"
    assert [e.split(" ")[0] + " " + e.split(" ")[1] for e in f["events"]] == ["RIDE START", "RIDE RESUMED", "EDIT insert", "WORKOUT DONE", "RIDE END"]
    assert "Rep done" in " ".join(out["spoken"])                            # built-in coach in the page
