"""Desktop app (apps/desktop) parts that run without Electron: the BLE adapter on a mocked radio, the API proxy and
the system-browser sign-in against the accounts API; and the website's "Desktop app" entry."""
import json
import subprocess
import sys

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "web"))
import build as web_build  # noqa: E402

DESKTOP = REPO / "apps" / "desktop"


def test_desktop_unit_tests(node):
    tests = sorted(str(p) for p in (DESKTOP / "test").glob("*.test.mjs"))
    assert len(tests) >= 2
    p = subprocess.run([node, "--test", *tests], capture_output=True, text=True, timeout=120, encoding="utf-8", cwd=DESKTOP)
    assert p.returncode == 0, (p.stdout + p.stderr)[-4000:]


def test_get_app_entry(node, tmp_path):
    out = tmp_path / "dist-web"
    web_build.build(out)
    p = subprocess.run([node, str(REPO / "tests/js/getapp_test.mjs"), str(out)], capture_output=True, text=True, timeout=60, encoding="utf-8")
    assert p.returncode == 0, p.stderr[-4000:]
    assert json.loads(p.stdout.strip().splitlines()[-1]) == {"getapp": "ok"}
    html = (out / "index.html").read_text(encoding="utf-8")
    assert 'id="getApp"' in html and 'href="/download"' in html and "js/web/getapp.js" in html


def test_release_asset_names_match_the_download_links():
    cfg = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))["build"]
    links = (REPO / "app/js/web/getapp.js").read_text(encoding="utf-8")
    assert cfg["nsis"]["artifactName"] == "JustWatts-Setup.${ext}" and "JustWatts-Setup.exe" in links
    assert cfg["dmg"]["artifactName"] == "JustWatts.${ext}" and "JustWatts.dmg" in links
    wf = (REPO / ".github/workflows/desktop.yml").read_text(encoding="utf-8")
    for name in ("JustWatts-Setup.exe", "JustWatts.dmg", "latest.yml", "latest-mac.yml"):
        assert name in wf


@pytest.mark.parametrize("folder", ["apps/desktop/src", "apps/desktop/native", "apps/desktop/test", "apps/desktop/e2e", "apps/desktop/scripts"])
def test_no_em_dashes_in_desktop_sources(folder):
    for f in (REPO / folder).rglob("*"):
        if f.is_file() and f.suffix in {".js", ".mjs", ".html", ".md", ".json"}:
            assert "\u2014" not in f.read_text(encoding="utf-8"), f
