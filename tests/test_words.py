"""Workouts from plain words (app/js/words.js): rules only, read in the page."""
import json

from conftest import REPO, run_node

HARNESS = REPO / "tests/js/words_harness.mjs"

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

# tests/words_cases.json: [{"in", "out"} | {"in", "error": true}, optional "note" on the reading chosen]
CORPUS = json.loads((REPO / "tests/words_cases.json").read_text(encoding="utf-8"))


def test_words_read_as_workouts(node):
    out = run_node(node, HARNESS, list(CASES))
    assert [o.get("text") or o for o in out] == list(CASES.values())


def test_words_that_are_not_a_workout_say_so(node):
    out = run_node(node, HARNESS, ["hello world", "", "warm up then intervals"])
    assert all("error" in o for o in out), out


def test_words_corpus(node):
    assert len(CORPUS) >= 150 and len({c["in"] for c in CORPUS}) == len(CORPUS)
    out = run_node(node, HARNESS, [c["in"] for c in CORPUS])
    bad = []
    for c, o in zip(CORPUS, out):
        if c.get("error"):
            if not o.get("error") or not o.get("isError"):
                bad.append(f"{c['in']!r}: want an error, got {o}")
        elif o.get("text") != c["out"]:
            bad.append(f"{c['in']!r}: want {c['out']!r}, got {o.get('text') or o}")
    assert not bad, f"{len(bad)}/{len(CORPUS)} wrong:\n" + "\n".join(bad)


def test_words_output_reads_back_as_the_same_text(node):
    # every workout it writes is valid workout text that reads back unchanged
    texts = [c["out"] for c in CORPUS if "out" in c]
    out = run_node(node, HARNESS, texts)
    assert [o.get("text") for o in out] == texts


def test_words_long_or_garbage_input_is_quick_and_never_hangs(node):
    junk = ["((((" * 500, "x" * 2000, "4x" * 1000, "1 min easy, " * 166, "3 sets of " * 200,
            "".join("4x8 min at threshold with 4 min recovery (stay seated) " for _ in range(34))[:2000],
            "\n- " * 666, "between sets " * 150, "😂" * 1000, "30/30 " * 333, "1:" * 1000, "z" * 2000]
    out = run_node(node, HARNESS, {"texts": junk, "timed": True})
    assert all(("text" in o) or (o.get("error") and o.get("isError")) for o in out["results"]), out
    assert out["ms"] < 1000, out["ms"]
