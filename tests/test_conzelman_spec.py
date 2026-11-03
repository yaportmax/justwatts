"""Conzelman Road's hand-authored spec (app/js/world3d/conzelman.js, A17): well formed, every row sourced, the ribbon and
its paint built from it."""
import pytest

from conftest import REPO, run_node

HARNESS = REPO / "tests" / "js" / "conzelman_harness.mjs"


@pytest.fixture(scope="module")
def out(node):
    return run_node(node, HARNESS, timeout=60)


def test_spec_rows_are_well_formed_and_sourced(out):
    assert out["sections"] >= 10 and out["bad"] == []          # in order, sourced, lines and the rider on the paving
    assert 1800 < out["length"] < 1840                          # the chained ways from the McCullough end to Alexander Avenue
    assert out["railsOn"] and out["lots"] >= 1 and out["walks"] >= 1


def test_ribbon_takes_the_spec(out):
    r = out["ribbon"]
    assert r["all"] and 7.5 < r["width"] < 10.5 and r["mirrored"] < 0.05   # the spec's paved width (kerb to 0.15 m past the edge line), either way round
    assert r["tris"] > 100                                                  # its paint drawn
    assert out["outside"] is True                                           # off the spec's stretch: the old rules
    assert out["lanes"]["down"] > 1.0 and out["lanes"]["up"] > 2.5          # down in the right lane, up in the contraflow lane
