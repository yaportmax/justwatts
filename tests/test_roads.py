"""Open world roads (app/js/roads.js): Overpass parsing, the road graph, the default way at junctions (same road,
straight on, main road), dead-end U-turns, oneways, roundabouts, cell (chunk) boundaries, 10 m points and grade
from a Terrarium tile with bridges. Overpass answers are recorded fixtures; nothing touches the network."""
import json
import math
import subprocess

import pytest

from conftest import REPO, run_node

HARNESS = REPO / "tests" / "js" / "roads_harness.mjs"
HAWK = {"lat": 37.8295, "lon": -122.4844, "heading": 270}  # Conzelman Road, the climb to Hawk Hill (world.js preset)


@pytest.fixture(scope="module")
def js(node):
    return lambda reqs: run_node(node, HARNESS, reqs)


# a synthetic map in one cell: x east, y north in metres around a point
O_LAT, O_LON, KEY = 37.005, -121.995, "3700_-12200"


def at(x, y):
    return {"lat": round(O_LAT + y / 111195, 7), "lon": round(O_LON + x / (111195 * math.cos(math.radians(O_LAT))), 7)}


def way(wid, hw, pts, name="", **tags):
    """pts: [(node id, x, y)]"""
    return {"type": "way", "id": wid, "nodes": [p[0] for p in pts], "geometry": [at(p[1], p[2]) for p in pts],
            "tags": {"highway": hw, **({"name": name} if name else {}), **tags}}


def osm(*ways):
    return [[KEY, {"elements": list(ways)}]]


def plan(js, cells, x=0, y=-280, heading=0, to=600, **kw):
    p = at(x, y)
    return js([{"op": "plan", "cells": cells, "lat": p["lat"], "lon": p["lon"], "heading": heading, "to": to, **kw}])[0]


ELM = way(1, "residential", [(1, 0, -300), (2, 0, 0)], "Elm Street")


def test_parse_keeps_bikeable_ways_only(js):
    out = js([{"op": "parse", "key": "3783_-12249"}, {"op": "parse", "json": {"elements": [
        way(1, "motorway", [(1, 0, 0), (2, 0, 100)]), way(2, "footway", [(1, 0, 0), (2, 0, 100)]), way(3, "cycleway", [(1, 0, 0), (2, 0, 100)], bridge="yes"),
        way(4, "residential", [(1, 0, 0), (2, 0, 100)], oneway="-1"), way(5, "tertiary", [(1, 0, 0), (2, 5, 5), (3, 0, 10)], junction="roundabout"),
        way(6, "primary", [(1, 0, 0), (2, 0, 100)], oneway="yes", **{"oneway:bicycle": "no"}), {"type": "node", "id": 9}]}}])
    real, synth = out
    assert len(real) > 40 and {w["hw"] for w in real} <= {"secondary", "tertiary", "unclassified", "residential", "service", "cycleway", "path", "footway", "track", "primary", "trunk", "trunk_link", "secondary_link", "tertiary_link", "living_street", "pedestrian", "bridleway", "road", "primary_link"}
    assert any(w["name"] == "Conzelman Road" for w in real)
    assert [(w["id"], w["ow"], w["br"], w["rb"]) for w in synth] == [(2, 0, 0, 0), (3, 0, 1, 0), (4, -1, 0, 0), (5, 1, 0, 1), (6, 0, 0, 0)]


def test_cells_and_query(js):
    c = js([{"op": "cells", "lat": 37.8295, "lon": -122.4844}])[0]
    assert c["key"] == "3782_-12249" and c["box"] == [37.82, -122.49, 37.83, -122.48] and len(c["around"]) == 9 and c["around"][0] == c["key"]
    assert "(37.82,-122.49,37.83,-122.48)" in c["q"] and "out body geom" in c["q"] and "motorway" not in c["q"]


def test_t_junction_takes_the_main_road(js):
    r = plan(js, osm(ELM, way(2, "primary", [(2, 0, 0), (3, 300, 0)], "Main Street"), way(3, "residential", [(2, 0, 0), (4, -300, 0)], "Oak Street")))
    assert r["snap"]["name"] == "Elm Street" and r["snap"]["v"] == 2
    assert r["names"][:2] == ["Elm Street", "Main Street"]
    j = r["junctions"][0]
    assert j["k"] == 1 and [o["name"] for o in j["opts"]] == ["Oak Street", "Main Street"] and [o["a"] for o in j["opts"]] == [-90, 90]  # left to right
    assert j["sel"] == 3


def test_straight_on_beats_a_bigger_crossing_road(js):
    r = plan(js, osm(ELM, way(2, "residential", [(2, 0, 0), (5, 0, 300)], "Pine Street"),
                     way(3, "primary", [(4, -300, 0), (2, 0, 0), (3, 300, 0)], "Main Street")))
    assert r["names"][:2] == ["Elm Street", "Pine Street"]


def test_the_same_road_wins_even_when_it_bends(js):
    r = plan(js, osm(way(1, "residential", [(1, 0, -300), (2, 0, 0)], "Beach Road"), way(2, "primary", [(2, 0, 0), (3, 250, 140)], "Beach Road"),
                     way(3, "primary", [(2, 0, 0), (4, 0, 300)], "Cliff Drive")))
    assert r["names"][:2] == ["Beach Road"]


def test_the_main_road_wins_over_a_smaller_straight_one(js):
    r = plan(js, osm(way(1, "primary", [(1, 0, -300), (2, 0, 0)], "Ocean Avenue"), way(2, "primary", [(2, 0, 0), (3, 250, 140)], "Cliff Drive"),
                     way(3, "residential", [(2, 0, 0), (4, 0, 300)], "Sand Street")))
    assert r["names"][:2] == ["Ocean Avenue", "Cliff Drive"]


def test_dead_end_turns_around(js):
    r = plan(js, osm(way(1, "residential", [(1, 0, -300), (2, 0, 0), (3, 0, 100)], "Elm Street"), way(2, "residential", [(2, 0, 0), (4, -300, 0)], "Oak Street")), to=800)
    ids = [s[0] for s in r["seq"]]
    assert ids[:5] == [1, 2, 3, 2, 1]  # up Elm to its end and back down Elm (the same road), past Oak
    dead = [j for j in r["junctions"] if not j["opts"]]
    assert dead and dead[0]["sel"] == 2 and dead[0]["d"] == pytest.approx(380, abs=2)


def test_oneway_the_wrong_way_is_not_the_default(js):
    r = plan(js, osm(ELM, way(2, "primary", [(3, 300, 0), (2, 0, 0)], "Main Street", oneway="yes"), way(3, "residential", [(2, 0, 0), (4, -300, 0)], "Oak Street")))
    assert r["names"][:2] == ["Elm Street", "Oak Street"] and all(j["k"] != 1 for j in r["junctions"])  # one way on: no question


def test_roundabout_exits_straight_on(js):
    rb = way(9, "tertiary", [(2, 0, 0), (6, 30, 30), (7, 0, 60), (8, -30, 30), (2, 0, 0)], junction="roundabout")
    r = plan(js, osm(ELM, rb, way(3, "residential", [(6, 30, 30), (10, 300, 30)], "East Street"),
                     way(4, "residential", [(7, 0, 60), (11, 0, 300)], "North Street"), way(5, "residential", [(8, -30, 30), (12, -300, 30)], "West Street")))
    assert r["names"][:3] == ["Elm Street", "Road", "North Street"]  # round to the exit straight ahead, the right way round


def test_the_rider_picks_another_way(js):
    cells = osm(ELM, way(2, "primary", [(2, 0, 0), (3, 300, 0)], "Main Street"), way(3, "residential", [(2, 0, 0), (4, -300, 0)], "Oak Street"))
    r = plan(js, cells, picks=[[2, 4]], peek=[1, 3, 100])
    assert r["names"][:2] == ["Elm Street", "Oak Street"] and r["junctions"][0]["sel"] == 4
    assert len(r["peek"]) >= 2 and r["peek"][-1][1] > r["peek"][0][1]  # a look down Main Street, east


def test_points_every_10_m_with_bridges_flagged(js):
    r = plan(js, osm(way(1, "residential", [(1, 0, -300), (2, 0, -100)], "Elm Street"), way(2, "residential", [(2, 0, -100), (3, 0, 100)], "Elm Street", bridge="yes"),
                     way(3, "residential", [(3, 0, 100), (4, 0, 300)], "Elm Street")), y=-300, to=500, pts=50)
    pts = r["pts"]
    assert len(pts) == 50
    step = [math.dist((a["ll"][0] * 111195, 0), (b["ll"][0] * 111195, 0)) for a, b in zip(pts, pts[1:])]
    assert all(abs(s - 10) < 0.15 for s in step)
    nd = r["nd"]
    assert [n[1] for n in nd] == [1, 2, 3, 4] and [round(n[0]) for n in nd] == [0, 196, 396, 596]  # the start snaps 4 m up the road
    assert [p["br"] for p in pts] == [1 if nd[1][0] < 10 * i <= nd[2][0] else 0 for i in range(50)] and sum(p["br"] for p in pts) == 20


# ---------- recorded Overpass cells ----------
def test_plan_on_real_roads_climbs_conzelman(js):
    r = js([{"op": "plan", "cells": ["3782_-12249", "3783_-12249", "3783_-12250"], **HAWK, "to": 1500}])[0]
    assert r["snap"]["name"] == "Conzelman Road" and r["snap"]["m"] < 2
    assert r["names"][0] == "Conzelman Road" and "McCullough Road" in r["names"]
    assert r["end"] >= 1500 and r["blocked"] is None


def test_chunk_boundary_waits_for_the_next_cell_and_never_turns_around(js):
    whole = js([{"op": "plan", "cells": ["3782_-12249", "3783_-12249", "3783_-12250"], **HAWK, "to": 2000}])[0]
    part = js([{"op": "plan", "cells": ["3782_-12249"], **HAWK, "to": 2000}])[0]
    assert part["blocked"] == "3783_-12249" and part["end"] < 400               # stops at the first node outside the cell
    ids = [s[0] for s in part["seq"]]
    assert all(ids[i] != ids[i + 2] for i in range(len(ids) - 2))               # no U-turn at the cell edge
    later = js([{"op": "plan", "cells": ["3782_-12249"], "later": ["3783_-12249", "3783_-12250"], **HAWK, "to": 2000}])[0]
    assert later["asked"][0] == "3783_-12249" and later["seq"] == whole["seq"]  # the same road as with every cell loaded


def test_plan_rebuilds_from_the_engine_course(js):
    r = js([{"op": "roundtrip", "cells": ["3782_-12249", "3783_-12249", "3783_-12250"], **HAWK, "cut": 600, "to": 1800}])[0]
    assert r["a"] == r["b"] and r["da"] == pytest.approx(r["db"], abs=0.1) and r["more"] == 20


# ---------- grade from a terrain tile ----------
def test_terrarium_decode(js):
    assert js([{"op": "terrarium", "rgb": [[128, 0, 0], [0, 0, 0], [128, 100, 128]]}])[0] == [0, -32768, 100.5]


def tile_row(n0, n, step=10.0):
    """Points every `step` m east along a row of the fixture tile (z14 x 2639 y 6376), from about pixel n0."""
    lat = 37.0062  # inside the tile, away from its edges
    k = 111195 * math.cos(math.radians(lat))
    lon0 = -122.0141 + n0 * (360 / 2 ** 14 / 256)
    return [[lat, lon0 + i * step / k] for i in range(n)]


def test_grade_from_a_terrain_tile(js):
    # the fixture is a plane rising 0.5 m per pixel to the east (a valley at pixels 120..140)
    px_m = 40075016.686 * math.cos(math.radians(37.0062)) / 2 ** 14 / 256
    r = js([{"op": "tile", "file": "terrarium_slope.png", "pts": tile_row(10, 60), "from": 30}])[0]
    assert r["at"]["x"] == 2639 and r["at"]["y"] == 6376
    e = r["ele"]
    g = [(e[i + 10] - e[i]) / 100 * 100 for i in range(8, len(e) - 18)]  # away from the smoothing edges
    assert all(x == pytest.approx(0.5 / px_m * 100, abs=0.15) for x in g)  # 6.6 %
    assert r["tail"] == r["ele"][30:]                                             # extending gives the same numbers


def test_bridges_span_the_valley(js):
    pts = tile_row(95, 50)  # over the valley
    plain = js([{"op": "tile", "file": "terrarium_slope.png", "pts": pts}])[0]
    br = [1 if e < plain["raw"][0] + 0.5 * 10 * i / 7.63 - 20 else 0 for i, e in enumerate(plain["raw"])]
    br = [max(br[max(0, i - 1):i + 2]) for i in range(len(br))]  # the bridge starts and ends a point past the drop
    fixed = js([{"op": "tile", "file": "terrarium_slope.png", "pts": pts, "br": br}])[0]
    assert min(plain["raw"]) < plain["raw"][0] - 30                               # the terrain dips 60 m under it
    line = [fixed["fixed"][0] + (fixed["fixed"][-1] - fixed["fixed"][0]) * i / (len(pts) - 1) for i in range(len(pts))]
    assert max(abs(a - b) for a, b in zip(fixed["fixed"], line)) < 3
    assert js([{"op": "bridges", "raw": [10, 0, 0, 40, 50], "br": [0, 1, 1, 0, 0]}])[0] == [10, 20, 30, 40, 50]
    assert js([{"op": "bridges", "raw": [5, 0, 30], "br": [1, 1, 0]}])[0] == pytest.approx([5 + 25 / 3, 5 + 50 / 3, 30])


def test_preset_roads_are_baked_in(node):
    p = subprocess.run([node, str(REPO / "tests/js/seed_harness.mjs")], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    asked = out.pop("asked")
    assert asked and all(a.startswith("/roads/marin/") for a in asked) and len(asked) == len(set(asked))  # baked blocks, each once, never Overpass
    for pid, r in out.items():
        assert r["here"] > 0 and r["around"], pid
