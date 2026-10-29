"""Other riders on the ride maps glide from one poll to the next instead of jumping (ridemap.js createGlide)."""
import json
import subprocess

from conftest import REPO


def test_riders_glide_between_polls(node):
    p = subprocess.run([node, str(REPO / "tests/js/glide_harness.mjs")], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    o = json.loads(p.stdout)
    assert o["first"] == [[37, -122]]
    assert o["half"] == [[37.0005, -122]] and o["end"] == [[37.001, -122]] and o["done"] == [False, True]
    assert o["mid"] == [[37.0015, -122]]           # halfway to 37.002 when the 37.004 poll came: glides on from there
    assert o["jump"] == [[37.5, -122]]             # a jump of km snaps
    assert o["newcomer"] == [[37.5, -122], [1, 1]] and o["empty"] == 0
