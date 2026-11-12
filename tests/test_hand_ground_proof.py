"""Actual drawn-ground placement contract and its focused geometry/bake checks."""
import subprocess

import pytest

from conftest import REPO


@pytest.mark.parametrize("script", [
    "test-support.mjs", "test-mounted.mjs", "test-surface-effect.mjs",
    "test-seat.mjs", "test-keep.mjs", "test-baseline-write-guard.mjs", "test-guard.mjs", "test-comparison.mjs", "test-certification.mjs", "test-bridge.mjs",
])
def test_drawn_ground_rules(node, tmp_path, script):
    result = subprocess.run(
        [node, str(REPO / "tests" / "js" / "hand-ground" / script), str(tmp_path)],
        cwd=tmp_path, capture_output=True, text=True, timeout=180 if script == "test-bridge.mjs" else 60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_current_world_matches_complete_drawn_ground_proof(node):
    result = subprocess.run(
        [node, str(REPO / "tools" / "hand-ground" / "hand_ground_guard.mjs"), str(REPO / "app")],
        cwd=REPO, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
