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
    api = {f for f in files if f.startswith("api/")}                                  # Strava relay, accounts, integrations
    assert {f for f in api if not f.startswith("api/_lib/")} == {"api/strava/token.js", "api/accounts.js", "api/integrations.js"}  # _lib is not routed
    assert {f"api/_lib/integrations/{m}.js" for m in ("base", "crypto", "store", "planned", "intervals", "trainingpeaks",
                                                       "garmin", "hub", "http", "session")} <= api
    pkg = json.loads((dist / "package.json").read_text())                             # Vercel installs the one dependency
    assert pkg["dependencies"] == {"@neondatabase/serverless": "1.2.0"} and (dist / "package-lock.json").exists()
    assert "privacy.html" in files
    assert "MODE = 'web'" in (dist / "js/mode.js").read_text()
    assert "MODE = 'server'" in (REPO / "app/js/mode.js").read_text()                # the local app is untouched


def test_vercel_headers(dist):
    v = json.loads((dist / "vercel.json").read_text())
    h = {x["key"]: x["value"] for x in v["headers"][0]["headers"]}
    csp = h["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "script-src 'self' https://www.googletagmanager.com;" in csp and "worker-src 'self';" in csp
    connect = re.search(r"connect-src ([^;]+);", csp).group(1).split()                 # map tiles, terrain, GA4 only
    ga = {"https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"}
    assert connect[0] == "'self'" and all(h.startswith("https://") and ("*" not in h or h in ga) for h in connect[1:])
    assert "https://s3.amazonaws.com" in connect and "https://server.arcgisonline.com" in csp
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


def test_web_account_sync_and_community(dist, node):
    # the page against the real accounts API (in-memory store, stubbed Resend / Strava), see tests/js/account_web.mjs
    p = subprocess.run([node, str(REPO / "tests/js/account_web.mjs"), str(REPO), str(dist)], capture_output=True, text=True, timeout=180, encoding="utf-8")
    assert p.returncode == 0, p.stderr[-4000:]
    out = json.loads(p.stdout)
    assert out["off"]["slot"] == "" and out["off"]["account"] is None and out["off"]["setAccount"] == "none"   # no accounts on the server: nothing shows
    so = out["signedOut"]
    assert so["slot"] and so["settings"] and so["comm"] == ""                                       # Sign in, and Community to browse
    d = out["dialog"]
    assert d["on"] and d["title"] == "Sign in" and 'data-a="forgot"' in d["html"] and 'data-a="signup"' in d["html"]
    assert "oauth" not in d["html"]                                                                  # no Google / Strava env: no buttons
    c = out["connect"]                                                                               # right after sign-up: connect services
    assert c["step"] == "connect" and c["html"].index("Garmin") < c["html"].index("Strava") and "Recommended" in c["html"] and "Skip for now" in c["html"]
    assert out["connectTap"] == {"closed": True, "settings": True}                                   # the hook's fallback opens Settings
    p_ = out["pushed"]                                                                               # first sign-in: local data merges into the account
    assert p_["records"] == ["settings:main", "workout:c-local1"] and p_["workout"] == {"name": "Local over-unders", "text": "3x(4m 95%, 2m 105%)"}
    assert p_["rides"] == [["r-1790000000000", 120]]
    assert "Account settings" in out["menu"] and "Sign out" in out["menu"] and "Synced" in out["menu"] and ">A</span>" in out["menu"]
    s = out["settingsHtml"]
    for want in ("Name", "ann@example.com", "Not confirmed", "Sign-in methods", "Change password", "Export my data", "Sign out everywhere", "Delete account"):
        assert want in s, want
    assert 'data-p="email" disabled' in s                                                             # never the last sign-in method
    assert out["pulled"] == {"custom": ["c-remote", "c-local1"], "ftp": 280, "units": "metric", "ride": 90}
    assert out["during"] == {"ftp": 280, "pending": {"ftp": 300}, "custom": ["c-local1"]}             # settings wait for the ride; deletes apply
    assert out["after"] == {"ftp": 300, "pending": None}
    assert out["localEdit"] == 310
    assert out["offline"] == {"status": "offline", "slot": True} and out["backOnline"] == "synced"
    li = out["list"]
    assert li["tab"] == "" and "by Ann" in li["row"] and "sweet spot" in li["row"] and 'title="Comments"' in li["row"] and ">1</span>" in li["row"]
    assert "Time" in li["head"] and "TSS" in li["head"]
    it = out["item"]
    for want in ("Sweet spot ladder", "Comments", "Great one", 'data-a="like"', "Save to mine", 'data-a="ride"', "Add a comment"):
        assert want in it["html"], want
    assert out["liked"] == {"likes": 1, "liked": True, "comments": ["Great one", "Did it twice"]}
    assert out["rode"] == 1                                                                           # riding a community item counts
    assert out["published"] == {"item": ["Local over-unders", ["vo2", "threshold"]], "modal": False}
    sa = out["signedOutAgain"]
    assert sa["slot"] and sa["custom"] == 1 and sa["sync"] == "null"                                 # local data stays on the device
    st = out["strava"]                                                                               # Strava sign-up: ask for the email once
    assert st["back"] == "/?provider=strava&auth=ok&new=1" and st["step"] == "email" and "Skip for now" in st["html"] and st["stripped"] == "/"
    assert out["claim"]["step"] == "sent" and out["claim"]["mail"] == ["eddy@example.com"] and 'data-a="connect"' in out["claim"]["html"]
    assert out["claimed"] == {"email": "eddy@example.com", "verified": True, "toast": "Email confirmed"}
    oe = out["oauthError"]
    assert oe["step"] == "signin" and "Strava sign-in is full for now" in oe["html"] and "limited for now" in oe["html"] and oe["stripped"] == "/"
