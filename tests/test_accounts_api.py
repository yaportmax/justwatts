"""Accounts, sync and community API (web/api/_lib) under node: in-memory store, fake clock, stubbed
Resend / Google / Strava. The same suite runs against the Postgres store on PGlite when it is installed:
    npm install --prefix tests/js --no-save @electric-sql/pglite@0.5.9
"""
import json
import subprocess

import pytest

from conftest import REPO

SECTIONS = ["providers", "auth", "origin", "ratelimits", "email", "google", "strava", "claim", "sync", "community", "limits", "moderation", "integrations", "social"]
PGLITE = REPO / "tests/js/node_modules/@electric-sql/pglite"


def run(node, section, store="memory", timeout=120):
    p = subprocess.run([node, str(REPO / "tests/js/accounts_api.mjs"), str(REPO), section, store],
                       capture_output=True, text=True, timeout=timeout, encoding="utf-8")
    assert p.returncode == 0, p.stderr[-4000:]
    return json.loads(p.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("section", SECTIONS)
def test_api_memory_store(node, section):
    assert run(node, section) == {section: "ok"}


@pytest.mark.skipif(not PGLITE.exists(), reason="PGlite not installed (opt-in Postgres test)")
@pytest.mark.parametrize("section", SECTIONS)
def test_api_postgres_store(node, section):
    # the SQL store (store-pg.js, migrations included) on a real Postgres engine
    assert run(node, section, f"pglite:{PGLITE}", timeout=600) == {section: "ok"}


def test_parser_copies_match_the_app(node):
    p = subprocess.run([node, str(REPO / "tests/js/accounts_parity.mjs"), str(REPO)], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert all(out["same"].values()) and len(out["same"]) == 5, out
    assert all(out["consts"].values()) and out["parse"], out


def test_no_em_dashes_or_debug_logs_in_api_sources():
    for f in list((REPO / "web/api").rglob("*.js")) + [REPO / "app/privacy.html"]:
        text = f.read_text(encoding="utf-8")
        assert "\u2014" not in text, f
        assert "console.log" not in text, f  # errors only, and never with env values
