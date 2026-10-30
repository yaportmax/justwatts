"""The 3D world's pure parts (tests/js/world3d_harness.mjs): terrain from a synthetic Terrarium tile, the road carve,
ground classes, road ribbons and markings, landuse parsing and the compact bake forms, streaming bookkeeping, the
baked tile format, the leg solver, the view choice with its WebGL fallback, and the open world's edge."""
import pytest

from conftest import REPO, run_node

HARNESS = REPO / "tests" / "js" / "world3d_harness.mjs"


@pytest.fixture(scope="module")
def out(node):
    return run_node(node, HARNESS, timeout=60)


def test_terrain_grid_from_a_synthetic_tile(out):
    assert out["sample"] == {"mid": 228, "edge": 355.5, "missing": 0}         # bilinear, across the tile edge, a missing tile is flat
    g = out["grid"]
    assert g["n"] == 17 * 17 and g["west"] == 100 and g["east"] == 355.5      # the east edge blends into the neighbour
    assert g["x0"] == pytest.approx(-g["x1"], abs=0.01) and g["z0"] < 0 < g["z1"]  # local metres, north is -z
    assert g["mid"] == pytest.approx(227.5, abs=0.5) and g["outside"] is None
    m = out["mesh"]
    assert m["up"] == 16 * 16 * 2 and m["down"] == 0                          # every surface triangle faces the sky
    assert m["tris"] == 512 + 4 * 16 * 2 and m["verts"] == 289 + 4 * 16 * 2   # skirts on the four edges
    assert m["skipTris"] == 8 * 16 * 2 + (16 + 16 + 8 + 8) * 2                    # a finer tile covers half: skirts round the hole
    assert out["coarse"] == {"segs": 4, "n": 25, "corner": 355.5, "same": 355.5}


def test_carve_puts_the_ground_under_the_ridden_road(out):
    c = out["carve"]
    assert c["on"] == pytest.approx(168.875) and c["rawOn"] == 163.5          # on the road: the road's height
    assert c["off"] == c["rawOff"]                                            # far from it: the ground
    assert c["bridgeTouched"] is False                                        # 400 m above the ground: a bridge, no carve


def test_the_ground_stays_under_the_roads(out):
    p = out["pushUnder"]
    assert p["on"] == pytest.approx(49.92)                                      # under the road: just under its top (was 53)
    assert p["next"] == pytest.approx(49.92 + 0.02 * (p["step"] - 2.3), abs=0.02)  # the next rows: the rise allowed from its edge
    assert p["far"] == 53 and p["moved"] == 3 * 17                              # further rows untouched; lowers only


def test_ground_classes_from_polygons(out):
    assert out["classes"] == {"corner": 0, "wood": 6, "sand": 8, "count": 81}  # wood 9x9 vertices, beach on top, buildings not raster


def test_road_ribbon_geometry(out):
    r = out["ribbon"]
    assert r["verts"] == 10 and r["tris"] == 8 and r["faceUp"] == 8 and r["resample"] == 6
    assert r["xs"] == [-3, 3] and r["edgeY"] == [10.55, 9.95] and r["centre"] == [10.25] * 5  # each edge on the ground, lifted
    assert r["code"] == [2, 0, 2, 6] and r["v"] == [20, 20]                                 # markings, lanes, width; metres along
    assert r["deck"] == [40, 60, 50] and r["pillars"] == 3                                  # a bridge: straight between its ends
    s = out["styles"]
    assert s["tertiary/0/0"] == {"w": 7.6, "lm": 2, "surf": 0, "lanes": 2, "a": 0, "b": 0, "pL": 0, "pR": 0}  # two lanes, double yellow line
    assert s["primary/4/0"]["w"] == pytest.approx(15.2) and s["primary/4/0"]["lanes"] == 4
    assert s["trunk/2/8"]["lm"] == 3 and s["motorway/4/8"]["lanes"] == 4                    # oneways: lane lines, a yellow left edge
    c = s["unclassified/1/4392"]                                                            # lower Conzelman: one lane down, parking on
    assert c["lm"] == 4 and c["w"] == pytest.approx(7.4) and c["a"] == pytest.approx(2.4) and c["b"] == pytest.approx(1.6)  # the right, a bike lane up on the left
    b = s["unclassified/2/96"]                                                              # Bunker Road: a bike lane each side
    assert b["lm"] == 2 and b["w"] == pytest.approx(10.0) and b["a"] == b["b"] == pytest.approx(1.6)
    assert s["tertiary/0/0/9"]["w"] == 9                                                    # a tagged width wins
    assert s["residential/0/0"]["lm"] == 0 and s["path/0/0"]["surf"] == 2 and s["tertiary/0/4"]["surf"] == 2
    assert out["clip"] == [[[0, 5], [5, 5], [5, 10]]]


def test_road_ways_join_and_corners_round(out):
    c = out["chain"]
    assert c["joined"] and c["rest"] == [3, 2, 2, 2]                          # a-b-c one ribbon; the side road and c-d meet a third
    assert c["round"]["ends"] and c["round"]["n"] > 5 and 0 < c["round"]["dev"] <= 0.35  # a curve, never far from the corner


def test_landuse_parse_and_compact_forms(out):
    lu = out["landuse"]
    assert lu["kinds"] == ["wood", "building", "water"] and lu["ids"] == ["w1", "w2", "r5"]  # no roads, no open rings
    assert lu["lt"] == "n" and lu["h"] == 11 and lu["rings"] == [1, 1, 2] and lu["outer"] == 4  # two outer pieces joined
    assert lu["roundTrip"] == [["wood", 5, None, "n"], ["building", 4, 11, None], ["water", 4, None, None]]
    assert lu["holeIn"] is False                                               # the inner ring is a hole
    assert lu["solidIn"] is True and lu["heights"] == [25, 8, 3]
    assert out["clipRing"] == [[1, 4], [3, 4], [3, 1], [1, 1], [1, 4]]
    assert out["roadsRT"] == [{"hw": "tertiary", "fl": 9, "ln": 2, "wd": 0, "pts": [[37.9, -122.6], [37.90012, -122.60034]], "dk": [61.3, 70.5]},
                              {"hw": "unclassified", "fl": 4392, "ln": 1, "wd": 8.4, "pts": [[37.9, -122.6], [37.9001, -122.6]]}]  # sides and width kept
    assert out["scatter"]["same"] and out["scatter"]["inside"] and out["scatter"]["n"] == 100 and 30 < out["scatter"]["half"] < 70


def test_chunk_streaming_bookkeeping(out):
    assert out["stream"] == {"n": 25, "fine": 9, "mid": 16}
    p = out["plan"]
    assert p["add"] == 5 and p["change"] > 0 and p["drop"] == 0 and p["dropFar"] > 0 and p["nearestFirst"]  # a margin before dropping
    assert out["children"] == {"n": 64, "first": "14/2616/6328", "parent": "11/327/791"}
    assert out["jobs"] == {"first": 2, "left": 1, "ran": ["a2", "b", "c"]}    # a budget per frame, replaced jobs run once


def test_baked_tile_format(out):
    b = out["baked"]
    assert b["json"] == {"f": [[1, [[1, 2, 3, 4]]]]} and b["maxErr"] < 0.0501 and b["corner"] == 100
    assert b["at"] == pytest.approx(103.15, abs=0.06)


def test_legs_keep_their_length(out):
    for thigh, shin, forward in out["knee"]:
        assert thigh == 0.46 and shin == 0.47 and forward


def test_webgl_missing_falls_back(out):
    assert out["probe"] == {"noDoc": False, "noGl": False, "yesGl": True, "lost": 1, "throws": False}
    p = out["pick"]
    assert p["owDefault"] == "world"                                           # open world: the 3D world by default
    assert p["owNoGl"] == "2d" and p["owNoGl3d"] == "3d"                        # no WebGL2: the maps as before
    assert p["owFailed"] == "3d" and p["owPrefWorldFailed"] == "3d"             # broke or too slow: MapLibre 3D
    assert p["owPref3d"] == "3d" and p["owPref2d"] == "2d"
    assert p["course"] == "3d" and p["course2d"] == "2d"                       # courses keep their map


def test_routes_never_leave_the_world(out):
    e = out["edge"]
    assert e["opts"] == [3, 4] and e["optsIn"] == [4]                           # the way out is no option
    assert 3 in e["plan"] and 3 not in e["planIn"]                             # the default turns away (and turns round)
    assert e["inside"] and not e["outside"] and e["bridge"]


def test_drafting(out, tmp_path):
    d = out["draft"]
    assert d["close"] == 0.35 and 0 < d["far"] < 0.35 and d["gone"] == d["behind"] == d["side"] == d["none"] == 0 and d["best"] == 0.35
    s = out["draftSpeed"]
    assert s["drafting"] > s["solo"] + 3 and s["capped"] == s["capped35"]       # about 30 percent less drag, capped
    e = out["engineDraft"]
    assert e["res"] == {"draft": 0.3} and e["drafted"] and e["lapsed"] and e["clamp"] == 0.35  # the page sends it; it lapses
    # the server engine: the same physics
    from justwatts.course import speed_step
    v0 = v1 = 0.0
    for _ in range(120):
        v0, v1 = speed_step(v0, 250, 0, 84, 1), speed_step(v1, 250, 0, 84, 1, 0.3)
    assert round(v0 * 3.6, 3) == s["solo"] and round(v1 * 3.6, 3) == pytest.approx(s["drafting"], abs=0.002)


def test_terrain_upsampling_is_smooth_and_seamless(out):
    s = out["smooth"]
    assert s["n"] == 81 and s["through"] and s["linear"]                       # through every sample; a plane stays a plane
    assert s["peak"] == 24 and s["overshoot"] and s["extSame"]                 # a bump stays where it is, rises smoothly
    assert s["seam"] == 0                                                      # two tiles agree on the edge they share
    assert s["normal"] == [-0.176, 0.88, -0.44] and s["unit"] == 1             # smooth normals from central differences
    assert s["ridge"] == -1 and s["masks"] == [255, 255, 102, 255]             # a ridge; wood, lake, meadow tint, road bank


def test_grass_scatter_is_deterministic(out):
    g = out["scatter2"]
    assert g["same"] and g["differs"] and g["inside"] and g["n"] == 50         # the same cell gives the same clumps, inside it
    assert g["cells"] == 15 and g["first"] == [0, 0] and g["sorted"] and g["within"]  # cells round a point, nearest first
    assert g["blades"] == 45 and g["verts"] == 63                              # 9 blades, 5 triangles each


def test_sky_colours_follow_the_sun(out):
    assert out["sky"] == {"zenBlue": True, "horPaler": True, "lowRed": True, "highWhite": True, "finite": True}


def test_procedural_textures(out):
    t = out["tex"]
    assert t["n"] == 64 * 64 * 4 and t["same"] and t["smooth"] < 40 and t["waveFlat"] in range(118, 138)


def test_leaf_atlas_mipmaps_keep_their_coverage(out):
    m = out["mips"]
    assert m["levels"] == 7 and m["last"] == [1, 1]                            # 64 x 32 down to 1 x 1
    base = m["cover"][0]
    assert 0.29 < base < 0.32 and abs(m["cover"][1] - base) < 0.02 and abs(m["cover"][2] - base) < 0.07  # leaves do not thin
    assert m["cover"][3] >= base                                             # out far away (4 x 4 texels: never fewer)
    assert m["fill"] == [200, 120, 40] and m["empty"] == 0                   # clear texels take the leaves' colour


def test_world_sound_gain_curves(out):
    a = out["audio"]
    assert a["windStill"] == 0 and a["wind10"] == 0.067 and a["windCap"] == 0.22 and a["windUp"]      # wind grows with speed, capped
    assert a["tireStill"] == 0 and a["tire10"] == 0.066 and a["tireGravel"] > a["tire10"] and a["tireUp"]
    assert a["hz"] == [70, 160]
    assert a["tickPedal"] == 0 and a["tickStill"] == 0 and a["tick5"] == 57.011 and a["tickCap"] == 140  # ticks only coasting
    assert a["seaNone"] == 0 and a["seaHalf"] == 0.1 and a["seaSome"]


def test_cars_pass_a_rider_only_with_room(out):
    p = out["pass"]
    assert p["clear"] == {"v": 20, "target": 1.9} and p["across"] == {"v": 20, "target": 1.9}  # far ahead, or the other side
    assert p["moving"] == {"v": 11.6, "target": 0.3}                          # moving over: slows while it closes in
    assert p["beside"] == {"v": 14, "target": 0.3}                            # over: passes at rider speed + 6
    assert p["blocked"] == {"v": 9.5, "target": 1.9}                          # oncoming traffic: follows, 12 m back
    assert p["behind"]["target"] == 1.9                                       # past: back to its lane


def test_cars_never_pass_through_riders(out):
    c = out["cars"]
    for k in ("pass", "slow", "group"):
        assert c[k]["past"] and c[k]["room"] >= 1.3, k                          # passes, more than a metre clear
    assert c["group"]["back"] > 0.4
    for k in ("blocked", "groupBlocked"):
        assert not c[k]["past"] and c[k]["back"] > 5 and c[k]["v"] == 8, k      # no room: waits behind at their speed


def test_rider_stands_on_steep_climbs_and_tucks_descending(out):
    s = out["stance"]
    assert s["up"] == {"up": True, "sb": 1} and s["held"]                     # stands above 7.5 percent, stays up at 7
    assert s["down"] == {"up": False, "sb": 0}                                 # sits again below 6
    assert s["level"] == 0 and s["still"] == 0                                 # coasting: cranks level and still
    assert s["tuck"] == {"tuck": True, "tb": 1}                                # fast downhill: tucked
    assert s["thigh"] == 0.46 and s["shin"] == 0.47 and s["forward"]           # the IK keeps bone lengths, knee forward
