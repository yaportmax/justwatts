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
    th = "vendor/three-0.180.0/"                                                     # the 3D world, pinned, no CDN (CSP)
    assert {th + f for f in ("three.module.min.js", "three.core.min.js", "LICENSE.txt")} <= files
    assert {"world/index.json", "js/world3d/view.js"} <= files and any(f.startswith("world/14/") for f in files)  # the baked Marin world
    assert any(f.startswith("roads/marin/") for f in files)
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
                             {"source": "/api/(auth|sync|community|social|admin)(/.*)?", "destination": "/api/accounts?__path=/api/$1$2"},
                             {"source": "/((?!api/)[^.]*)", "destination": "/index.html"}]  # /api/* reaches the functions
    assert v["regions"] == ["pdx1"]                                                   # next to the Neon database
    assert v["crons"] == [{"path": "/api/integrations?op=cron", "schedule": "*/15 * * * *"}]  # retries uploads with the page closed


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
    sr = out["source"]                                                        # no community library: no Community source, All instead
    assert sr["value"] == "all" and sr["crs"] == "all" and sr["options"] == ['value="all"', 'value="jw"', 'value="mine"']
    assert sr["authors"] == ["Just Watts", "You", "Just Watts", "You"]          # the Author column, workouts and courses
    assert sr["mine"] == ["Backup test"] and sr["jw"] is False
    so = out["sort"]                                                          # sortable headers, in step with the Sort select
    assert so["asc"] and so["desc"] and so["st1"] == {"sort": "short", "aria": "ascending", "up": True} and so["st2"] == {"sort": "long", "aria": "descending"}
    assert so["author"] == {"sort": "h:author:asc", "extra": True, "first": "Just Watts", "aria": "ascending", "timeAria": "none"} and so["stored"] == "h:author:asc"
    assert so["preset"] == {"level": "descending", "extra": False} and so["featured"] is False
    assert so["courses"] == {"asc": True, "desc": True, "select": "long", "stored": "long"}
    k = out["picks"]                                                          # per-ride course picks
    assert out["oldCourse"] is False                                         # the old global course is dropped
    assert k["flatWorkout"] == {"name": "Sweet spot 2x12", "course": None, "plan": True}
    assert k["wPicker"] == {"open": True, "html": True}                          # the workout dialog: Flat, Open world, the courses
    assert k["workoutCourse"] == {"name": "Sweet spot 2x12", "course": "Rolling hills", "plan": True}
    assert k["remembered"] == {"name": "Recovery spin 20", "course": "Rolling hills", "plan": True}  # one-click Ride: the last pick
    assert k["cPicker"] == {"open": True, "map": True, "html": True}              # the course dialog: map first, a workout list
    assert k["search"] == {"hit": True, "other": False}
    assert k["courseWorkout"] == {"name": "Sweet spot 2x12", "course": "Hawk Hill, Marin", "plan": True}
    assert k["courseFree"] == {"name": "The climb", "course": "The climb", "plan": False}
    assert k["thumbs"] == {"map": True, "nomap": True, "ow": True, "jr": True}
    assert k["test"]["course"] is None                                       # FTP tests never take a course
    assert k["justFlat"]["course"] is None and not k["justFlat"]["plan"]      # Just ride: one click, flat
    c = out["course"]                                                         # Just ride on the course picked next to it
    assert c["name"] == c["course"] == "The climb" and c["done"] > 100 and c["profile"] == 300
    assert c["want"]["k"] == "sim" and c["strip"] == "" and "%" in c["text"]
    w = out["web"]                                                            # integrations through the real web handler
    assert w["signedOut"] == {"connects": 0, "manual": True, "steps": True}   # signed out: sign in + manual upload only
    assert w["panelOut"] == {"signin": True, "fit": True, "steps": True} and w["signIns"] == 1
    assert w["connectStep"] == {"title": "Connect your services", "first": "garmin", "skip": True}
    assert w["after"] == {"button": "Uploaded", "line": True}                # connect with the ride: it went up
    assert w["posts"] == [{"op": "connect", "services": None, "fit": False, "key": True},
                          {"op": "upload", "services": "intervals", "fit": True, "key": False}]
    assert w["auto"] == []                                                   # manual by default: later rides wait for Upload
    assert w["today"] and not w["leak"]


def test_web_account_sync_and_community(dist, node):
    # the page against the real accounts API (in-memory store, stubbed Resend / Strava), see tests/js/account_web.mjs
    p = subprocess.run([node, str(REPO / "tests/js/account_web.mjs"), str(REPO), str(dist)], capture_output=True, text=True, timeout=180, encoding="utf-8")
    assert p.returncode == 0, p.stderr[-4000:]
    out = json.loads(p.stdout)
    off = out["off"]
    assert off["slot"] == "" and off["account"] is None and off["setAccount"] == "none"              # no accounts on the server: nothing shows
    assert off["src"] == ['value="all"', 'value="jw"', 'value="mine"'] and off["srcValue"] == "all" and off["crsSrc"]  # no Community source
    assert out["migrated"] == {"stored": "lib", "value": "all"}                                      # the old source bar's Library is All
    so = out["signedOut"]
    assert so["slot"] and so["settings"] and so["comm"]                                             # Sign in, and Community to browse
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
    # one list per tab with a Source filter (All, Just Watts, Mine, Community) and an Author column
    a = out["all"]
    assert a["src"] == "all" and a["stored"] == '"all"' and a["comm"] == 1 and a["after"]             # community items after the local ones
    assert a["authors"] == ["You", "Just Watts", "Ann"] and a["you"] == "You" and a["communityAuthor"] == "Ann"
    assert a["likes"] == "0" and not a["edit"]                                                       # the publisher's likes; no Edit on a community row
    assert out["jw"]["authors"] == ["Just Watts"] and out["jw"]["n"] > 30
    assert out["mine"] == {"names": ["Local over-unders"], "authors": ["You"]}
    li = out["list"]                                                                                 # Community: only community items
    assert li["tab"] == "" and li["value"] == "comm" and li["names"] == ["Sweet spot ladder"] and li["more"] == "none"
    assert "<span>Ann</span>" in li["row"] and '<div class="c">Sweet spot</div>' in li["row"] and 'title="Likes"' in li["row"]  # the tag names the category
    assert '<span class="pau">Ann</span>' in li["row"] and "· </i>sweet spot" not in li["row"] and li["row"].count('class="m num r"') == 2  # time, TSS
    assert out["likedSort"] == {"first": "Sweet spot ladder", "second": "You"}                       # Most liked: community first, then Featured
    assert out["search"] == {"names": ["Sweet spot ladder"]} and out["searchYou"] == {"authors": ["You"]}  # search matches the author
    assert out["catTag"] == {"comm": True, "mine": False, "cats": ["Sweet spot"]} and out["catOther"] == {"comm": False}  # chips match community tags
    assert out["failNow"]["local"] > 0 and out["failAfter"] == {"local": out["failNow"]["local"], "comm": 0, "empty": "none"}  # a failed fetch: local rows stay
    assert out["failComm"] == {"rows": 0, "empty": "", "text": "No connection."}
    assert out["rowOpen"] == {"pane": "", "lib": "none", "crumb": True}                             # a community row opens its page
    assert out["dedupe"] == {"mine": ["You"]} and out["dedupeComm"] == {"comm": True}                # saved to mine: listed once in All
    c = out["courses"]                                                                               # Courses: the same Source filter and Author column
    assert c["tab"] == "" and c["src"] == "all" and c["last"] and c["local"] == "Just Watts" and c["author"] == "Dan" and c["ride"] and not c["del"]
    assert out["coursesComm"] == {"names": ["Hawk Hill loop"], "lib": "comm"}                       # one Source for both tabs
    assert out["coursesJw"] == {"authors": ["Just Watts"], "hawk": False}
    it = out["item"]
    for want in ("Sweet spot ladder", "Comments", "Great one", 'data-a="like"', "Save to mine", 'data-a="ride"', "Add a comment"):
        assert want in it["html"], want
    assert out["liked"] == {"likes": 1, "liked": True, "comments": ["Great one", "Did it twice"]}
    assert out["rode"] == 1                                                                           # riding a community item counts
    assert out["published"] == {"item": ["Local over-unders", ["vo2", "threshold"]], "modal": False}
    assert out["courseItem"]["map"] and out["courseItem"]["profile"]                                 # a community course shows its route
    sa = out["signedOutAgain"]
    assert sa["slot"] and sa["custom"] == 2 and sa["sync"] == "null"                                 # local data stays on the device (with the saved copy)
    assert out["sameAgain"] == {"step": None, "owner": True}                                        # the same account again: no question
    ak = out["asked"]                                                                                # another account: ask, nothing goes up yet
    assert ak["title"] == "Data on this device" and "Add this device's data to Bob" in ak["html"] and "Start clean" in ak["html"] and ak["server"] == 0
    assert out["afterMerge"] == {"step": "connect"}                                                  # then the sign-up's connect step
    mg = out["merged"]                                                                               # local data, the saved community copy too
    assert mg["rides"] and mg["records"][:2] == ["settings:main", "workout:c-local1"] and len(mg["records"]) == 3 and mg["records"][2].startswith("workout:c-")
    assert out["dismissed"] == {"status": "error", "error": "choose", "step": None, "server": 0}      # dismissed: no merge, sync waits
    assert out["clean"] == {"custom": 0, "courses": 0, "rides": 0, "server": [], "serverRides": 0, "step": None}
    st = out["strava"]                                                                               # Strava sign-up: ask for the email once
    assert st["back"] == "/?provider=strava&auth=ok&new=1" and st["step"] == "email" and "Skip for now" in st["html"] and st["stripped"] == "/"
    assert out["claim"]["step"] == "sent" and out["claim"]["mail"] == ["eddy@example.com"] and 'data-a="connect"' in out["claim"]["html"]
    assert out["claimed"] == {"email": "eddy@example.com", "verified": True, "toast": "Email confirmed"}
    oe = out["oauthError"]
    assert oe["step"] == "signin" and "Strava sign-in is coming back soon. Use Google or email." in oe["html"] and oe["html"].count("user limit") == 1 and oe["stripped"] == "/"


def test_web_social(dist, node):
    # presence, friends, group rides, chat and ride-ons on the page against the real API, see tests/js/social_web.mjs
    p = subprocess.run([node, str(REPO / "tests/js/social_web.mjs"), str(REPO), str(dist)], capture_output=True, text=True, timeout=240, encoding="utf-8")
    assert p.returncode == 0, p.stderr[-4000:]
    out = json.loads(p.stdout)
    assert out["off"] == {"social": None, "calls": 0}                                              # no accounts: no social at all
    assert out["signedOut"]["calls"] == 0 and out["signedOut"].get("strip") in (None, "none")      # signed out: sends nothing, sees nobody
    assert 'data-a="friends">Friends' in out["menu"]                                               # the Friends panel opens from the account menu
    pn = out["panel"]
    assert pn["on"] and pn["title"] == "Friends" and "Requests" in pn["html"] and "Accept" in pn["html"] and "Copy link" in pn["html"]
    assert out["accepted"] == ["Bob"] and 'data-s="add"' in out["found"] and out["catIncoming"] == ["Ann"]
    rd = out["riding"]                                                                             # a course ride: the friend on the strip
    assert rd["riders"] == [["Bob", True, 240, "Hawk Hill, Marin|2907"]] and rd["here"] == "1 riding here" and rd["strip"] == ""
    assert 2 <= out["rate"] <= 4                                                                   # about every 2 s, never piling up
    assert out["bobSees"] == [["Ann", True, "Hawk Hill, Marin|2907", "number", "number"]]
    assert "Riding now" in out["ridingNow"] and "Ride here" in out["ridingNow"] and "240 W" in out["ridingNow"]
    assert out["hidden"] == {"bob": [], "sees": ["Bob"]}                                           # switched off: others no longer see you
    assert out["netDown"]["ride"] and out["netDown"]["samples"] >= 5                               # the network fails: the ride goes on
    assert out["ended"] == {"strip": "none", "riders": 0}
    assert out["activity"] == ["Ann", "Hawk Hill, Marin", True, False]                             # the finished ride reaches friends
    assert "Activity" in out["activityHtml"] and "1 ride-on" in out["activityHtml"]
    nf = out["newForm"]
    assert 'value="o:ggb"' in nf and 'value="c:r-hawk"' in nf and 'type="datetime-local"' in nf and 'name="invite"' in nf
    assert out["created"] == ["Tuesday spin", "course", "r-hawk"]
    assert out["lobby"]["title"] == "Tuesday spin" and "Ready" in out["lobby"]["html"] and "invited" in out["lobby"]["html"]
    assert out["bobInvited"] == [["Tuesday spin", "invited"]]
    assert "In 0:0" in out["lobby2"] and out["armed"] and out["loadedEarly"]                        # loads ahead, starts at the time
    gr = out["groupRide"]
    assert "<b>Right now</b>" in gr["grp"] and 'class="on">Bob' in gr["grp"] and "Go go go" in gr["msgs"] and gr["chat"] == ""
    assert gr["mates"] == [["Bob", True]]
    assert out["said"] is True and out["bobReads"] == [["Bob", "Go go go"], ["Ann", "On your wheel"]]
    assert out["reloadReady"] == {"stored": [True, True, "string"], "armed": True, "started": True, "after": None}  # Ready survives a reload
    assert out["expiredReady"] == {"armed": None, "kept": None}                                    # past the start: forgotten
    lk = out["links"]                                                                              # share links, then a clean URL
    assert lk["stripped"] == "/" and lk["view"] == "group" and lk["toast"] == "Request sent to Cat"
    assert out["afterSignOut"]["calls"] == 0 and out["afterSignOut"].get("strip") in (None, "none")
    for k in ("panel", "ridingNow", "activityHtml", "newForm", "lobby", "lobby2"):
        assert "\u2014" not in json.dumps(out[k]), k                                               # no em dashes on screen
