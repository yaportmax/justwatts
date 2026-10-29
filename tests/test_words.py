"""Workouts from plain words (app/js/words.js): rules only, read in the page."""
from conftest import REPO, run_node

CASES = {
    "20 min easy, 3 sets of 6 x 45s hard / 30s easy, 5 min easy between sets, easy to 60 min":
        "20m 55%, 3x(6x(45s 120%, 30s 55%), 5m 55%), 2m30s 55%",
    "warm up 15 min, 4x8 min at threshold with 4 min recovery, cool down 10 min": "15m 45-70%, 4x(8m 100%, 4m 50%), 10m 65-45%",
    "2x20 at sweet spot, 5 min rest": "2x(20m 90%, 5m 50%)",
    "10 min warmup then 5x3min VO2 3min rest then 10 min cooldown": "10m 45-70%, 5x(3m 118%, 3m 50%), 10m 65-45%",
    "10x30 all out / 30 off": "10x(30s 150%, 30s 50%)",
    "1 hour endurance": "60m 65%",
    "15m wu, 3x10m @ 260w w/ 5m easy, 10m cd": "15m 45-70%, 3x(10m 260w, 5m 55%), 10m 65-45%",
    "5 min at 90-105%": "5m 90-105%",
    "3 x 12 min over-unders, 6 minutes easy": "3x(12m 105%, 6m 55%)",
    "45 min free ride": "45m free",
}


def test_words_read_as_workouts(node):
    out = run_node(node, REPO / "tests/js/words_harness.mjs", list(CASES))
    assert [o.get("text") or o for o in out] == list(CASES.values())


def test_words_that_are_not_a_workout_say_so(node):
    out = run_node(node, REPO / "tests/js/words_harness.mjs", ["hello world", "", "warm up then intervals"])
    assert all("error" in o for o in out), out
