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
    assert c["fillCut"] == 0                                                  # raised to the road: a fill, not a cut bank
    k = out["cuts"]
    assert k["cut"] == 1 and k["steep"] == 1                                  # lowered 5 m; a wall of ground beside the road
    assert k["gentle"] == 0 and k["far"] == 0                                 # a gentle rise, or far away: no cut


def test_trails_lie_on_the_hillside(out):
    assert out["drape"]["trail"] == 2 and out["drape"]["road"] == 0.5         # edges on a 1 in 1 slope; a road's crossfall capped
    assert out["trailPush"]["moved"] == 17 and out["trailPush"]["next"] == 53  # only the row under a trail comes down, not the
                                                                                # rows whose triangles cross it (a road: 3 rows)


def test_the_ground_stays_under_the_roads(out):
    p = out["pushUnder"]
    assert p["on"] == pytest.approx(49.92)                                      # under the road: just under its top (was 53)
    assert p["next"] == pytest.approx(49.92)                                    # the next rows: their triangles cross the road,
                                                                                # so they come down whole (none over its edge)
    assert p["far"] == 53 and p["moved"] == 3 * 17                              # further rows untouched; lowers only


def test_ground_classes_from_polygons(out):
    assert out["classes"] == {"corner": 0, "wood": 6, "sand": 8, "count": 81}  # wood 9x9 vertices, beach on top, buildings not raster


def test_road_ribbon_geometry(out):
    r = out["ribbon"]
    assert r["verts"] == 10 and r["tris"] == 8 and r["faceUp"] == 8 and r["resample"] == 6
    assert r["xs"] == [-3, 3] and r["edgeY"] == [10.5, 10.0] and r["centre"] == [10.25] * 5  # edges on the ground, a crossfall of 0.25 m at most
    assert r["code"] == [2, 0, 2, 6] and r["v"] == [20, 20]                                 # markings, lanes, width; metres along
    assert r["deck"] == [40, 60, 50] and r["pillars"] == 3                                  # a bridge: straight between its ends
    fl = out["flare"]
    assert fl["mouth"] == pytest.approx(15) and fl["past"] == pytest.approx(5)            # a side road's mouth: corners rounded 5 m, its own width on
    assert 5 < fl["at2"] < 7.5                                                            # a quarter circle each side (2.25 m on: 5 + 2 x 0.53)
    s = out["styles"]
    assert s["tertiary/0/0"] == {"w": 8, "lm": 2, "surf": 0, "lanes": 2, "a": 0, "b": 0, "pL": 0, "pR": 0}  # two 3.6 m lanes, double yellow line
    assert s["primary/4/0"]["w"] == pytest.approx(16) and s["primary/4/0"]["lanes"] == 4
    assert s["trunk/2/8"]["lm"] == 3 and s["motorway/4/8"]["lanes"] == 4                    # oneways: lane lines, a yellow left edge
    c = s["unclassified/1/4392"]                                                            # lower Conzelman: one lane down, parking on
    assert c["lm"] == 4 and c["w"] == pytest.approx(9.1) and c["a"] == pytest.approx(2.8) and c["b"] == pytest.approx(2.7)  # the right, a bike lane up on the left
                                                                                            # (and its buffer's 0.9 m): 9.1 m, NAIP 8.5 (the
                                                                                            # travel lane there nearer 3 m than 3.6)
    b = s["unclassified/2/96"]                                                              # Bunker Road: a bike lane each side
    assert b["lm"] == 2 and b["w"] == pytest.approx(10.8) and b["a"] == b["b"] == pytest.approx(1.8)
    assert s["tertiary/0/0/9"]["w"] == 9                                                    # a tagged width wins
    assert s["residential/0/0"]["lm"] == 0 and s["path/0/0"]["surf"] == 2 and s["tertiary/0/4"]["surf"] == 2
    assert out["clip"] == [[[0, 5], [5, 5], [5, 10]]]


def test_road_widths_ease_across_joints(out):
    t = out["taper"]
    assert t["ends"] == [0, 1] and not t["deckHas"]                             # the bridge keeps its own width
    assert t["atJoint"] == t["narrowAtJoint"] == pytest.approx(8.8)            # both meet halfway, no step
    assert t["away"] == 10 and t["toDeck"] == 12                               # its own width further on; the deck's at the deck
    assert t["first"] == pytest.approx(10) and t["last"] == pytest.approx(8.8) and t["half"] == pytest.approx(4.4)
    assert t["code"] == pytest.approx(8.8)                                     # the shader's width follows


def test_ground_cover_and_scrub(out):
    v = out["veg"]
    assert v["west"] == 2 and v["east"] == 1 and v["outside"] == 0             # scrub west, grass east, nothing outside
    assert v["rgba"] == [255, 0, 0, 255] and v["rgbaEast"] == [0, 0, 0, 255]
    assert v["paved"] == [255, 255, 255, 255]                                 # paving: all three channels (the shader's sign)
    assert v["same"] and v["onScrub"] and v["eastN"] == 0                      # bushes on scrub only, the same every time
    assert 0.6 * 164 < v["westN"] <= 169 and 0.45 <= v["scales"][0] < v["scales"][1] <= 1.75  # about a bush every 2.5 m


def test_lidar_trees(out):
    t = out["trees"]
    assert t["n"] == 3 and t["all"] == [[10, 3, "oak"], [40, 8, "euc"], [6, 2, "willow"]] and t["west"] == 1   # by the box
    assert t["cov"] == [True, False]
    assert t["open"] == [2, 1] and t["thin"] == [1.25, 1.6] and t["wide"] == [1.667, 0.6]   # the lidar's shape within 0.6..1.6
    assert t["byRoad"] == [2.8, 10] and t["tall"] == [6]          # a low crown ends 0.2 m short of the paving; a high one may overhang
    assert t["atEdge"] is None and t["clear"] == 4.5
    f = t.get("file")
    if f:  # the shipped trees: the lidar's 41,000 or so, every species the vegetation map names, heights as the lidar has them
        assert 35000 < f["n"] < 60000 and f["bytes"] < 400000 and f["covered"]
        assert {"oak", "bay", "euc", "cypress", "pine", "willow"} <= set(f["species"])
        assert f["median"]["euc"] > f["median"]["cypress"] and f["median"]["willow"] < 10 and f["median"]["oak"] < 15


def test_painted_lines_never_step_sideways(out):
    # A13 (user report, upper Conzelman: the yellow buffer lines broke with a sideways jump at the way joins): every road's
    # lines, along each ribbon and across each joint of two ways (tests/js/world3d_harness.mjs)
    L = out["lines"]
    assert L["roads"] > 5000 and L["joints"] > 3000
    assert L["hl"]["along"] == 0 and L["hl"]["joint"] == 0, L["hl"]


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
    assert out["bakedSide"] == {"fine": 33, "coarse": 17, "last": 36}           # the side read from the tile's own size


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


def test_road_sides_embankments_cuts_and_rails(out):
    b = out["banks"]
    assert b["normals"] == [0, 1, 0, -1]                                          # each side's normal points away from the road
    assert set(b["right"]) == {2} and set(b["left"]) == {1}                       # the ground under the edge: a fill; the lidar rising 3 in 2: a cut
    f = b["fill"]
    assert f[0][0] == 0 and f[0][1] == pytest.approx(9.97)                        # from just under the paved edge
    assert 5.5 <= f[-1][2] <= 7 and f[-1][3] == pytest.approx(8 - f[-1][2] / 3, abs=0.01)  # down to the ground (1 in 3), its end on it
    assert all(q[1] - q[3] <= (q[2] - q[0]) / 1.2 for q in f)                    # 1 in 1.5 down (its toe onto the ground a little steeper)
    c = b["cut"]
    assert b["cutH"] == pytest.approx(6.75)
    assert 7 <= c[-1][2] <= 7.5 and c[-1][3] == pytest.approx(10 + 1.5 * c[-1][2])  # up the lidar's bank to where the carved ground meets it
    assert all(q[2] > q[0] for q in c) and any(q[4] == 1 for q in c)              # never leaning toward the road; a steep face (cut)
    assert all(q[3] - q[1] <= 2.5 * (q[2] - q[0]) + 0.01 for q in c)              # at 68 degrees at most
    assert c[0][2] == pytest.approx(0.6) and abs(c[0][3] - 10) < 0.1              # the verge before the cut kept: a flat band to it
    assert f[0][2] == pytest.approx(0.15) and abs(f[0][3] - 9.97) < 0.05          # the shoulder before the fill too
    assert b["under"] == 0 and b["over"] == 0                                     # on or over the ground, never over the lidar
    assert b["tris"] == b["up"] > 0 and b["runs"] == 2                            # every face toward the sky; one strip a side
    assert b["level"] is None and b["blockedTo"] <= 3                             # the ground at the edge: no strip; short of another road
    r = b["rail"]
    assert r["z"] == pytest.approx(3.45) and r["gap"] == pytest.approx(1.9)       # a rail's posts 0.45 m past the edge, 1.9 m apart
    assert r["posts"] == 21 and r["yaw"] == pytest.approx(1.571, abs=0.01)        # by arc length; each post's front toward the road
    assert b["railed"]["kind"] == 2 and b["railed"]["rail"]                       # a rail stands on its shoulder even on level ground
    assert c[1][3] - c[1][1] <= 0.7 * (c[1][2] - c[1][0])                         # a cut's foot past the verge: about 1 in 2 (Street View), not 68 degrees
    assert c[0][5] == 1 and f[0][5] == 1 and not any(q[5] for q in c if q[4])     # the verge and the shoulder grass; never a steep face
    k = b["curb"]
    assert k[0][2] == pytest.approx(0.6) and k[0][3] == pytest.approx(10.05)      # behind a curb its shoulder 0.1 m under the curb's top
    assert k[-1][3] < 10                                                          # then down to the ground


def test_roads_over_tunnels_are_decks(out):
    o = out["over"]
    assert o["square"] == [[35, 65]]                                              # 12 m past the tunnel's road either side
    assert o["angled"][0][1] - o["angled"][0][0] == pytest.approx(30 / 0.7071, abs=0.1)  # longer across it at an angle
    assert o["end"] == []                                                         # a road going on into a tunnel is not over it
    assert o["climb"][0][0] <= 22 and o["climb"][0][1] >= 78                      # on out across the lidar's whole gap
    u = out["under"]
    for name in ("alexander101",):                                                # US-101 over Alexander Avenue: the lidar's gap
        d = u[name]["decks"]
        assert len(d) >= 2 and all(x["gap"] > 2.5 and x["deckOverFloor"] > 4.5 for x in d)
    assert u["bunker101"]["cover"] > 4.5                                          # Bunker Road under US-101: under its fill
    assert u["eastAlexander"]["cover"] > 3                                        # East Road under Alexander Avenue
    assert u["bakerBarry"]["cover"] > 50                                          # the Baker-Barry tunnel under its hill
    for name in u:
        assert u[name]["portal"] < 0.4                                            # the ground at each portal carved to the way in


def test_rail_pieces(out):
    b = out["railBasics"]
    assert b["n"] == 12 and b["idx"] == [0, 8, 11] and b["step"] <= 5                  # split every 5 m or less, its own points kept
    assert b["pinned"] == 10 and b["ends"] == [10, 10.3]                                 # a junction and the ends keep their height
    assert b["pack"] == [10, 10.5, 9.99]                                                 # centimetres
    assert b["at"] == [0.5, 2, 5, -2]                                                    # height, signed offset (+ right), metres along
    assert b["lanes"]["bunker"] == [4.5, 4.5]                                            # Bunker Road: in the bike lane either way
    assert b["lanes"]["plain"] == 3 and b["lanes"]["path"] == 0                          # no bike lane: a metre in from the edge; a path: its middle
    assert b["lanes"]["conzUp"] == 3.65 and b["lanes"]["conzDown"] == 0.75              # lower Conzelman: up in the bike lane against the
                                                                                         # oneway, down a metre left of the parking lane


def test_rails_walked_at_light_speed(out):
    r = out["rails"]
    assert r["n"] > 300 and r["km"] > 50 and r["file"] < 60000                         # every road the rides reach, one small file
    assert r["grade"] < 0.45                                                             # no stretch steeper than 45 % over 10 m (South
                                                                                         # Sausalito's streets reach 40 %)
    assert r["bend"] < 0.75                                                              # no step: the grade changes by under 15 % in 5 m
    assert r["cut"] < 3.2, r["cutAt"]                                                    # never far under the lidar's ground (but in a
                                                                                         # tunnel, over a deck, down to a portal)
    assert r["tilePts"] > 500 and r["tileGap"] < 0.02                                    # the tiles' pieces are the area's rails
    assert r["jogs"] < 60 and r["jogWorst"] < 10                                         # the roads smooth curves: OpenStreetMap's nodes
                                                                                         # zigzagged them (400 S-jogs, the worst 38 degrees)
    u = out["railUnder"]
    assert u["eastUnderAlexander"] > 4.5                                                 # East Road's rail well under Alexander's
    assert u["alexanderUnder101"] > 4.5 and u["bunkerUnder101"] > 4.5                    # under US-101's fill
    assert u["bakerBarry"] > 50                                                          # the Baker-Barry bore under its hill


def test_hand_listed_barriers_on_their_roads(out):
    h = out["hand"]
    assert h["pieces"] >= h["n"] and abs(h["got"] - h["want"]) < 0.02 * h["want"], h  # every listed stretch on its road, as long
    assert h["surveyed"] >= 30                                                          # the surveyed roads' rails
    assert h["right"] == ["wbeam"] and h["left"] == [], h                                # Conzelman Road at Hawk Hill: the W-beam on
                                                                                         # its outer (right) edge only (Street View)


def test_every_start_rides_its_rails(out):
    for name, c in out["courses"].items():
        assert c is not None, name
        assert c["none"] == 0, name                                                     # on a rail (or the deck) every step
        assert c["jump"] < 0.2, (name, c)                                                # no step over 0.2 m at 20 m/s and 60 frames
        assert c["bounce"] < 0.8, (name, c)                                              # no bounce: the height's bend over 5 m small
        assert c["laneBad"] == 0, (name, c)                                              # in the bike lane, else near the right edge


def test_both_ways_on_one_road(out):
    b = out["bothWays"]
    assert b["n"] > 100 and b["dh"] <= 0.05 and b["sides"] == b["n"]                    # each way on its own side, the same height


def test_bridge_riders_on_the_sidewalks(out):
    for side, w in out["ggbWalks"].items():
        assert "Sidewalk" in w["road"] and w["n"] > 1000, side
        assert w["inRoad"] == 0 and w["off"] == 0, (side, w)                            # outside the curb wall, inside the railing


def test_bridges_only_over_a_gap(out):
    b = out["bridges"]
    assert b["n"] > 0 and b["through"] == 0, b                                          # no deck through the ground (over a ridge):
                                                                                         # a bridge only over the lidar's gap (bake)


def test_queue_follows_the_route(out):
    assert out["reprio"] == ["a1", "a2", "c", "b"]                                       # the half done job finishes first; then the
                                                                                         # one moved up the route


def test_roads_go_through_the_portals(out):
    p = out["portals"]
    assert len(p) >= 6                                                                    # the underpasses' and the tunnel's portals
    for x in p:
        assert x["dh"] < 0.05 and x["ang"] < 35, x                                         # at the floor's height, into the opening


def test_riders_where_cyclists_ride(out):
    t = out["riderTable"]
    assert not t["bad"], t["bad"]                                                       # every road as where_riders_ride.md has it
    c = t["by"]["Conzelman Road"]
    assert c["up"] > 300 and c["upBike"] == c["up"], c                                    # uphill against the oneway: in the buffered lane
    assert t["by"]["Golden Gate Bridge East Sidewalk"]["n"] > 100                       # the bridge's sidewalk: keep right
    for road in ("East Road", "Bunker Road"):
        b = t["by"][road]
        assert b["bike"] > 0.8 * b["n"], (road, b)                                      # in the bike lane (Bunker Road's shoulders)


def test_lane_markings_from_the_hand_list(out):
    m = out["marks"]
    assert m["pieces"] >= m["n"] and abs(m["got"] - m["want"]) < 0.02 * m["want"], m  # every listed stretch on its road, as long
    assert "dash" in m["bunkerDash"] and "white2" in m["cronkhite"], m                   # Bunker Road: the passing zone, Fort Cronkhite
    assert "passR" in m["bunkerPass"] and "passL" in m["bunkerPassBack"], m             # the broken line on the eastbound side
    assert "hatch" in m["conzTop"] and "stallsR" in m["conzTop"] and "ladder" in m["conzMid"], m  # upper Conzelman Road
    assert "words" in m["center"] and m["hawk"] == [], m                                # Center Road's BIKE LANE; none at Hawk Hill
