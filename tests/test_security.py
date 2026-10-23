"""Security regressions: headers, proxy exposure, ride id paths, OAuth state, page escaping, the Strava relay."""
import http.client
import json
import re
import subprocess
import time

from conftest import REPO
from openspin.strava import MAX_STATES, StravaError, StravaLink

import pytest


def test_pages_cannot_be_framed_and_run_only_own_scripts(srv):
    for path in ("/", "/api/health", "/js/app.js"):
        conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
        conn.request("GET", path, headers={"Host": f"127.0.0.1:{srv.port}"})
        r = conn.getresponse()
        r.read()
        conn.close()
        csp = r.getheader("Content-Security-Policy", "")
        assert r.getheader("X-Frame-Options") == "DENY" and "frame-ancestors 'none'" in csp
        assert "script-src 'self';" in csp and r.getheader("X-Content-Type-Options") == "nosniff"


def test_proxied_requests_never_reach_the_api(srv):
    # a reverse proxy that rewrites Host to 127.0.0.1 would otherwise expose the whole API (Origin is forgeable)
    for h in ({"X-Forwarded-For": "203.0.113.9"}, {"Forwarded": "for=203.0.113.9"}, {"CF-Connecting-IP": "203.0.113.9"}):
        assert srv.req("GET", "/api/settings", headers=h)[0] == 421
        assert srv.req("POST", "/api/settings", {"ftp": 300}, headers={**srv.page, **h})[0] == 421
    assert srv.req("GET", "/api/settings")[0] == 200


def test_bad_content_length_is_refused(srv):
    for n in ("-1", "abc"):
        conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
        conn.putrequest("POST", "/api/event", skip_host=True)
        for k, v in {"Host": f"127.0.0.1:{srv.port}", "Content-Length": n, **srv.page}.items():
            conn.putheader(k, v)
        conn.endheaders()
        r = conn.getresponse()  # answers right away instead of reading until the socket closes
        assert r.status == 413
        conn.close()


def test_ride_id_cannot_steer_meta_paths(srv):
    data = srv.cfg.data
    ride = {"id": "../../evil", "name": "x", "samples": [[1, 1, 100, 80, 0, 0, 0]] * 5}
    assert srv.req("POST", "/api/ride", ride, headers=srv.page)[0] == 200
    stored = json.loads((srv.cfg.rides / "evil.json").read_text())
    assert stored["id"] == "evil"  # the stored id is the file name
    srv.server.set_ride_meta("../../evil2", {"strava": 1})
    assert not (data / "evil2.json").exists() and (srv.cfg.rides / "meta" / "evil2.json").exists()
    assert srv.server.ride_meta("../../evil2") == {"strava": 1}


def test_share_base_url_must_be_http(srv):
    s = srv.req("POST", "/api/settings", {"shareBaseUrl": "javascript:alert(1)"}, headers=srv.bearer)[1]["settings"]
    assert s["shareBaseUrl"] == ""
    s = srv.req("POST", "/api/settings", {"shareBaseUrl": ["x"]}, headers=srv.bearer)[1]["settings"]
    assert s["shareBaseUrl"] == ""
    s = srv.req("POST", "/api/settings", {"shareBaseUrl": "https://example.com/os"}, headers=srv.bearer)[1]["settings"]
    assert s["shareBaseUrl"] == "https://example.com/os"


def test_oauth_code_not_logged(srv, capsys):
    srv.server.quiet = False
    try:
        srv.req("GET", "/api/strava/callback?code=SECRETCODE123&state=nope&scope=activity:write")
    finally:
        srv.server.quiet = True
    assert "SECRETCODE123" not in capsys.readouterr().err


def test_oauth_states_bounded_and_expire(tmp_path, monkeypatch):
    link = StravaLink(tmp_path, http=lambda *a: (500, {}))
    for _ in range(200):  # any web page can make the browser hit /connect repeatedly
        link.authorize_url("http://localhost:1/api/strava/callback")
    assert len(link._states) == MAX_STATES
    url = link.authorize_url("http://localhost:1/api/strava/callback")
    state = re.search(r"state=([^&]+)", url)[1]
    now = time.time()
    monkeypatch.setattr("openspin.strava.time.time", lambda: now + 901)
    with pytest.raises(StravaError, match="expired"):
        link.callback("c" * 40, state, "activity:write")
    with pytest.raises(StravaError, match="expired"):
        link.callback("c" * 40, "", "activity:write")


SAFE_RAW = {  # interpolations in app.js HTML templates that are constants, numbers or fixed markup
    "${HRZ_COLORS[i]}", "${Math.round(hrNow / settings.hrMax * 100)}", "${ZONES[i][1]}", "${ZONES[i][2]}", "${cls(l)}",
    "${fmtT(t)}", "${hm(x.ts)}", "${hz + 1}", "${i + 1}", "${k}", "${t / hn * 100}", "${t / tot * 100}",
    "${r.garmin ? ' <span class=\"badge\">Garmin</span>' : ''}", "${r.strava ? ' <span class=\"badge\">Strava</span>' : ''}",
    "${r.test ? ' <span class=\"badge\">test</span>' : ''}", "${w.id.startsWith('c-') ? ' · custom' : ''}",
    "${r.agent_tokens ? ' · ' + esc(kfmt(r.agent_tokens)) : ''}",
}


def test_app_html_templates_escape_data():
    # ride rows, laps, stats and settings come from ride JSON or imported backups: never raw into innerHTML
    bad = []
    for line in (REPO / "app/js/app.js").read_text(encoding="utf-8").splitlines():
        if "innerHTML" not in line:
            continue
        for expr in re.findall(r"\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", line):
            if not expr.startswith("${esc(") and expr not in SAFE_RAW and not expr.startswith(("${new Date(", "${w.test ?")):
                bad.append(expr)
    assert not bad, bad


def test_strava_relay_validates_and_filters(node):
    p = subprocess.run([node, str(REPO / "tests/js/relay_test.mjs"), str(REPO / "web/api/strava/token.js")],
                       capture_output=True, text=True, timeout=60, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out["get"] == 405 and out["badGrant"] == 400 and out["badToken"] == 400
    assert out["nullBody"] == 400 and out["badJson"] == 400
    for k in ("object", "string", "buffer", "stream"):  # every body shape Vercel may hand over
        r = out[k]
        assert r["code"] == 200, (k, r)
        assert set(r["body"]) == {"access_token", "refresh_token", "expires_at", "athlete"}
        assert r["body"]["athlete"] == {"id": 7, "firstname": "A", "lastname": "B"}
        assert "relay-secret-value" not in json.dumps(r)
    assert len(out["sent"]) == 4 and all(s["url"] == "https://www.strava.com/oauth/token" for s in out["sent"])
