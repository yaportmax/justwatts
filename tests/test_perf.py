"""Performance budgets: server CPU while idle and 3 hours into a ride, chart cost on a 3 h ride."""
import json
import subprocess
import sys

import pytest

from conftest import REPO, free_port, run_node


def probe(mode, secs=8):
    p = subprocess.run([sys.executable, str(REPO / "tests/helpers/cpu_probe.py"), str(free_port()), str(secs), mode, "-",
                        str(REPO / "server")], capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("mode", ["idle", "ride"])
def test_server_cpu_under_2_percent(mode):
    r = probe(mode)
    assert r["cpu_pct"] < 2.0, r
    if mode == "ride":
        assert r["new_samples"] >= 7  # the ride really ran (1 Hz) while measured


def test_chart_is_decimated_and_cheap_on_a_3_hour_ride(node):
    r = run_node(node, REPO / "tests/js/chart_bench.mjs")
    assert r["points"] <= 2 * 1200          # at most 2 points per pixel instead of 10800
    assert r["small_points"] == 100         # short rides keep every sample
    assert r["ms_per_draw"] < 20, r         # measured ~0.6 ms in node
