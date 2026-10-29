"""Import from connected services (web): server ops against stubbed Garmin, intervals.icu and Strava HTTP, FIT
activity parsing, and the page's import flow (options, progress, dedupe, stop and resume). See tests/js/import_test.mjs."""
import json
import subprocess

from conftest import REPO


def test_import_web(node):
    p = subprocess.run([node, str(REPO / "tests/js/import_test.mjs"), str(REPO)], capture_output=True, text=True,
                       timeout=120, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout)["checks"] >= 100
