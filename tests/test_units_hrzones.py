"""Units (display only, storage in kg) and active HR zones: core.js and history.py agree."""
import pytest

from conftest import REPO, run_node
from justwatts import history as H

HARNESS = REPO / "tests" / "js" / "harness.mjs"

HR_CASES = [
    {},
    {"hrMax": 190},
    {"hrMax": "200"},
    {"hrMax": 300},
    {"hrMax": ""},
    {"hrZones": [100, 120, 140, 160, 180], "hrZonesSrc": "manual", "hrMax": 190},
    {"hrZones": [101, 121, 141, 161, 176], "hrZonesSrc": "garmin"},
    {"hrZones": [100, 120, 140, 160, 180]},  # older settings: floors without a source count as manual
    {"hrZones": [100, 120, 140, 160, 180], "hrZonesSrc": "default", "hrMax": 177},
    {"hrZones": [100, 120, 120, 160, 180], "hrZonesSrc": "manual"},  # not rising: fall back
    {"hrZones": [100, 120, 140, 160], "hrZonesSrc": "manual"},
    {"hrZones": ["100", 120, 140, 160, 180], "hrZonesSrc": "manual"},
    {"hrZones": None, "hrZonesSrc": None, "hrMax": None},
]


@pytest.fixture(scope="module")
def js(node):
    return lambda reqs: run_node(node, HARNESS, reqs)


def test_default_zones():
    assert H.active_hr_zones({}) == {"floors": [93, 111, 130, 148, 167], "max": 185, "src": "default"}
    assert H.active_hr_zones({"hrMax": 200})["floors"] == [100, 120, 140, 160, 180]
    m = H.active_hr_zones({"hrZones": [100, 120, 140, 160, 180], "hrZonesSrc": "manual"})
    assert m == {"floors": [100, 120, 140, 160, 180], "max": None, "src": "manual"}


def test_hr_zone_parity(js):
    out = js([{"op": "hrzones", "cases": HR_CASES}])[0]
    assert out == [H.active_hr_zones(c) for c in HR_CASES]


def test_units(js):
    cases = [[81.65, 180, "imperial"], [72.5, 72.5, "metric"], [0, "", "imperial"], [70, 154.3, None]]
    out = js([{"op": "units", "cases": cases}])[0]
    assert out[0] == {"show": 180, "kg": 81.65, "unit": "lb", "dist": "50.7 mi"}
    assert out[1] == {"show": 72.5, "kg": 72.5, "unit": "kg", "dist": "72.5 km"}
    assert out[2]["show"] == "" and out[2]["kg"] == 0
    assert out[3]["unit"] == "lb" and out[3]["show"] == 154.3  # no setting = imperial
    lbs = [150, 165.5, 182.3, 220.1]
    kgs = [r["kg"] for r in js([{"op": "units", "cases": [[0, lb, "imperial"] for lb in lbs]}])[0]]
    back = [r["show"] for r in js([{"op": "units", "cases": [[kg, 0, "imperial"] for kg in kgs]}])[0]]
    assert back == lbs  # lb survives the kg round trip


def test_settings_units_and_zone_source(srv):
    s = srv.server
    assert s.settings["units"] == "imperial"
    assert s.update_settings({"units": "metric"})["settings"]["units"] == "metric"
    assert s.update_settings({"units": "furlongs"})["settings"]["units"] == "metric"
    assert s.update_settings({"hrZonesSrc": "bogus"})["settings"]["hrZonesSrc"] != "bogus"
    ath = s.athlete()
    assert ath["hr_zones_source"] == "default" and ath["hr_zones"] == [93, 111, 130, 148, 167] and ath["hr_max"] is None
    s.update_settings({"hrMax": 200})
    assert s.athlete()["hr_zones"] == [100, 120, 140, 160, 180]
    s.update_settings({"hrZones": [95, 115, 135, 155, 175], "hrZonesSrc": "manual"})
    assert s.athlete()["hr_zones"] == [95, 115, 135, 155, 175] and s.athlete()["hr_zones_source"] == "manual"
    s.update_settings({"hrZonesSrc": "default", "hrZones": None})
    assert s.athlete()["hr_zones"] == [100, 120, 140, 160, 180]
    assert '"units": "metric"' in s.settings_file.read_text(encoding="utf-8")
