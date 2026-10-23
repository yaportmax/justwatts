"""The Python DSL port (used by the simulator) must agree with app/js/core.js."""
import math
import re

import pytest

from conftest import REPO, run_node
from test_js_core import CASES, ERRORS
from openspin.workout import WorkoutError, compile_workout, parse_workout, step_at, step_watts, to_text

HARNESS = REPO / "tests" / "js" / "harness.mjs"


@pytest.fixture(scope="module")
def js_results(node):
    presets = run_node(node, HARNESS, [{"op": "presets"}])[0]
    texts = CASES + [p["text"] for p in presets] + ["1m30s 87.25%, 45s 100-112.5%"]
    return texts, run_node(node, HARNESS, [{"op": "parse", "text": t} for t in texts])


def test_parse_and_to_text_match_js(js_results):
    texts, outs = js_results
    for t, o in zip(texts, outs):
        py = parse_workout(t)
        assert len(py) == len(o["steps"]), t
        for a, b in zip(py, o["steps"]):
            assert a["d"] == b["d"]
            if not a.get("free"):
                assert a["u"] == b["u"] and math.isclose(a["a"], b["a"]) and math.isclose(a["b"], b["b"])
        assert to_text(py) == o["text"], t


@pytest.mark.parametrize("text,err", ERRORS.items())
def test_errors_match_js(text, err):
    with pytest.raises(WorkoutError, match=re.escape(err)):
        parse_workout(text)


def test_compile_and_watts():
    steps, total = compile_workout("10m 50-100%, 1m 300w, 5m free")
    assert total == 960
    i, s, into = step_at(steps, 300)
    assert i == 0 and step_watts(s, into, 200) == 150
    assert step_watts(steps[1], 0, 200) == 300
    assert step_watts(steps[2], 0, 200) is None
    assert step_at(steps, 960) is None
