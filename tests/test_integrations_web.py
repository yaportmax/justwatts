"""Web connectors (web/api/_lib/integrations) under node with stubbed fetch, plus JS/Python parity:
planned-workout conversion and the manual-upload table must match the local app."""
import json
import subprocess

import pytest

from conftest import REPO
from justwatts.integrations import planned as P
from justwatts.integrations.base import MANUAL, UNOFFICIAL_NOTE
from justwatts.workout import parse_workout

FX = json.loads((REPO / "tests/fixtures/planned.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def web(node):
    p = subprocess.run([node, str(REPO / "tests/js/integrations_test.mjs"), str(REPO)], capture_output=True, text=True,
                       timeout=120, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_web_connectors(web):
    assert web["checks"] > 100


@pytest.mark.parametrize("i", range(len(FX["intervals"])))
def test_intervals_conversion(web, i):
    case = FX["intervals"][i]
    assert P.from_intervals(case["doc"]) == case["expect"], case["name"]
    assert web["planned"]["intervals"][i] == case["expect"], case["name"]
    assert parse_workout(case["expect"])


@pytest.mark.parametrize("i", range(len(FX["trainingpeaks"])))
def test_trainingpeaks_conversion(web, i):
    case = FX["trainingpeaks"][i]
    assert P.from_trainingpeaks(case["structure"]) == case["expect"], case["name"]
    assert web["planned"]["trainingpeaks"][i] == case["expect"], case["name"]
    assert parse_workout(case["expect"])


def test_manual_table_and_note_match(web):
    assert web["manual"] == MANUAL and web["note"] == UNOFFICIAL_NOTE
    for m in MANUAL.values():
        assert all(len(s) <= 70 for s in m["steps"]) and len(m["steps"]) <= 3
    assert chr(0x2014) not in json.dumps(MANUAL, ensure_ascii=False) + UNOFFICIAL_NOTE


def test_unstructured_and_garbage_inputs():
    assert P.from_intervals(None) is None and P.from_intervals({"steps": []}) is None
    assert P.from_trainingpeaks("{not json") is None and P.from_trainingpeaks({"structure": []}) is None
    assert P.free_for(5400) == "90m free" and P.free_for(0) is None
