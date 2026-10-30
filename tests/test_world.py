"""Open world on the page (tests/js/world_harness.mjs): world.js loads recorded roads, plans and sends the road to the
web build's engine as the rider rides; the junction prompt shows about 200 m before a junction, the default way is
already sent, a tap or the arrow keys change it, doing nothing keeps it, and a reload picks the ride up."""
import pytest

from conftest import REPO, run_node

HARNESS = REPO / "tests" / "js" / "world_harness.mjs"


@pytest.fixture(scope="module")
def out(node):
    return run_node(node, HARNESS, timeout=120)


def test_start_loads_an_open_course(out):
    assert out["start"] is True and out["loaded"]["open"] and out["loaded"]["name"] == "Hawk Hill"
    assert out["loaded"]["dist"] >= 600 and out["loaded"]["n"] == out["loaded"]["dist"] / 10 + 1  # the first 600 m, the rest while riding
    assert out["noPromptKey"] is False  # no junction ahead: the arrows keep their ride controls


def test_prompt_shows_before_the_junction_with_the_default_on(out):
    p = out["prompt"]
    assert p and p["on"] and 150 <= p["m"] <= 200                      # about 200 m before it
    assert [o["name"] for o in p["opts"]] == ["Road", "McCullough Road"]  # left to right
    assert [b["on"] for b in p["buttons"]] == [o["on"] for o in p["opts"]] == [False, True]
    assert 'rotate(-33deg)' in p["html"] and "McCullough Road" in p["html"]
    assert out["defaultNext"]["sel"] == out["defaultNext"]["inEngine"]   # doing nothing: the engine already has the default way


def test_arrow_keys_and_taps_change_the_way(out):
    assert out["key"] is True and out["afterKey"]["sel"] == out["afterKey"]["want"] == out["afterKey"]["inEngine"]  # left: one way over
    assert [b["on"] for b in out["afterKey"]["buttons"]] == [True, False]
    assert out["up"] is True and out["afterUp"]["sel"] == out["afterUp"]["want"] == out["afterUp"]["inEngine"]      # up: the straightest
    t = out["afterTap"]
    assert t["sel"] == t["want"] == t["inEngine"] and [b["on"] for b in t["buttons"]] == [True, False]


def test_the_rider_rides_the_chosen_way(out):
    assert out["through"]["passed"] and out["through"]["onWay"]


def test_reload_keeps_the_road_coming(out):
    r = out["reload"]
    assert r["n1"] > r["n0"] and r["d1"] > r["d0"] + 1000 and not r["stuck"] and r["ahead"] > 1000
    assert out["view"]["road"] and not out["view"]["wait"]
    assert "%</b>" in out["crsK"] and out["view"]["road"] in out["crsK"]
    assert out["ll0"][0] == [37.829504, -122.484401] and out["ndOk"] and out["spacing"] < 10.2
    assert out["asked"][0] == "3782_-12249"  # the start's cell first


def test_a_start_on_a_long_bridge_rides_at_once_and_spans_it_later(out):
    b = out["bridge"]
    assert b["started"] and b["first"][1] == b["first"][2]        # its far end unknown: sent flat at first
    assert b["n"] > 250 and b["d"] > 300                           # then the road beyond loads and comes
    assert 55 < b["mid"] < 75 and b["end"] == pytest.approx(90.2, abs=1)  # a straight line over the valley to the far end
    assert b["jump"] < 1                                           # no step where the line meets what was sent flat


def test_u_turn_rides_back_the_way_the_rider_came(out):
    u = out["uturn"]
    assert u["ok"] and 0 < u["pivot"] < 60 and u["samePrefix"]       # a few metres on; the road behind never changes
    assert u["turned"] > 160 and u["back"] < 15                      # facing back, on the same road as before
    assert u["d1"] > u["d0"] + 300 and u["ahead"] > 1000              # the same ride goes on, the road keeps coming
    assert u["jp"] == [] and u["spacing"] < 10.2                      # no jump: the road just turns back
    r = out["uturnReload"]
    assert r["ndOk"] and r["ahead"] > 1000 and r["spacing"] < 10.2   # a reload rebuilds the turned plan


def test_teleport_jumps_and_the_ride_goes_on(out):
    t = out["tele"]
    assert t["ok"] and len(t["jp"]) == 1 and t["landed"] < 5 and t["gap"] > 300 and 0 < t["lead"] < 60
    assert t["gradeJump"] == 0                                       # flat across the jump: the trainer never sees it
    assert t["viewBefore"]["o"] == 0 and t["viewBefore"]["lastIsOld"]  # not there yet: the old road, up to the jump
    a = t["after"]
    assert a["same"] and a["samples"] == 30 and a["d"] > 100          # same ride, distance and time keep counting
    assert a["climbed"] < 20 and a["road"] == "Bunker Road"
    assert a["o"] == t["jp"][0] * 10 and a["first"] and 0 < a["vd"] < a["d"]  # the screen shows the road from the new spot
    assert a["near"] < 200 and a["ahead"] > 1000
    r = out["teleReload"]
    assert r["jp"] == t["jp"] and r["o"] == a["o"] and r["ndOk"] and r["ahead"] > 1000 and r["spacing"] < 10.2


def test_the_golden_gate_bridge_course_rides_on_its_deck(out):
    g = out["ggb"]
    assert g["d"] > 2800 and g["deck"] > 260                      # Vista Point to the south end: 2.7 km on the deck, unbroken
    assert g["sMin"] < -1250 and g["sMax"] > 1350                  # from the south abutment to Vista Point
    assert g["worst"] < 0.6                                        # every point at the deck's own height (ggb.js)
    assert 66 < g["mid"] < 70                                      # mid span about 68 m up, not the sea floor
