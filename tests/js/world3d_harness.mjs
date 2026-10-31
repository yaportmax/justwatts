// The 3D world's pure parts (app/js/world3d): terrain grids from a synthetic Terrarium tile, the carve, ground classes,
// road ribbons, landuse parsing and the compact forms, streaming bookkeeping, the baked tile format, the leg solver,
// the view choice and the WebGL fallback, the open world's edge. stdout: JSON report for tests/test_world3d.py.
import { heightsOf, makeSampler, makeGrid, gridHeight, carve, pushUnder, rasterClasses, gridMesh, gridFromHeights, upsample, gridNormals, gridCurvature, classMasks, overTunnels } from '../../app/js/world3d/terrain.js';
import { ribbonEdge, sideKinds, sideRuns, bankGeometry, railLine, bands, CUT, FILL, LEVEL } from '../../app/js/world3d/banks.js';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { cellPoints, cellsAround, clumpGeometry } from '../../app/js/world3d/grass.js';
import { skyRadiance, sunTint } from '../../app/js/world3d/skymath.js';
import { noisePixels, wavePixels, coverageMips } from '../../app/js/world3d/texgen.js';
import { windGain, tireGain, tireHz, tickRate, oceanGain } from '../../app/js/world3d/audio.js';
import { passPlan, carStep } from '../../app/js/world3d/life.js';
import { builder, ribbon, resample, roadStyle, clipLine, deckSides, chainWays, roundCorners, tapers, taperedWidth, TAPER } from '../../app/js/world3d/ribbon.js';
import { parseVeg, makeVeg, SCRUB, GRASS, PAVED } from '../../app/js/world3d/veg.js';
import { cellBushes, SIZE as SCRUB_CELL } from '../../app/js/world3d/scrub.js';
import { parseLanduse, encode, decode, clipRing, encodeRoads, decodeRoads, scatter, buildingHeight, inRings } from '../../app/js/world3d/landuse.js';
import { wanted, plan, jobQueue, childrenOf, parentOf } from '../../app/js/world3d/stream.js';
import { packTile, unpackTile, gridAt } from '../../app/js/world3d/baked.js';
import { makeProj, tileX, tileY, latOf, lonOf } from '../../app/js/world3d/geo.js';
import { knee, BIKE, stance, newStance, ik } from '../../app/js/world3d/rider.js';
import { probeWebGL2, resetProbe, pickView } from '../../app/js/world3d/probe.js';
import { RoadGraph, Plan, bridges, smoothFrom } from '../../app/js/roads.js';
import { dense, track, railIndex, profileOf, profileAt, laneOf, unpackH, packH, smoothRail, isTrail, handBarriers } from '../../app/js/world3d/rail.js';
import { BARRIERS, SURVEY, MARKINGS } from '../../app/js/world3d/handlist.js';
import { onDeck, toST, GGB } from '../../app/js/ggb.js';
import { readdirSync } from 'node:fs';
import { inWorld, BOUNDS } from '../../app/js/world.js';
import { draftShare } from '../../app/js/world3d/draft.js';
import { speedStep } from '../../app/js/course.js';
import { Engine } from '../../app/js/web/engine.js';

const out = {};
const r3 = x => Math.round(x * 1000) / 1000;

/* ---------- terrain ---------- */
// a Terrarium tile whose height rises 1 m per pixel to the east (from 100 m) -> RGBA
function tileOf(f) {
  const data = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = f(x, y) + 32768, r = Math.floor(v / 256), g = Math.floor(v - r * 256), b = Math.round((v - r * 256 - g) * 256), o = (y * 256 + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }
  return { w: 256, h: 256, data };
}
const Z = 14, X = 2619, Y = 6330, lat0 = latOf(Y + 0.5, Z), lon0 = lonOf(X + 0.5, Z), proj = makeProj(lat0, lon0);
const t0 = heightsOf(tileOf((x) => 100 + x)), t1 = heightsOf(tileOf((x) => 356 + x));  // the east neighbour goes on rising
const tiles = { [`${X}/${Y}`]: t0, [`${X + 1}/${Y}`]: t1 };
const S = makeSampler((x, y) => tiles[`${x}/${y}`] || null);
out.sample = { mid: r3(S(X * 256 + 128.5, Y * 256 + 10)), edge: r3(S((X + 1) * 256, Y * 256 + 10)), missing: r3(S((X - 5) * 256 + 3.5, Y * 256)) };
const g = makeGrid({ z: Z, x: X, y: Y, segs: 16, sample: S, proj });
out.grid = { n: g.hs.length, west: r3(g.hs[0]), east: r3(g.hs[16]), x0: r3(g.xs[0]), x1: r3(g.xs[16]), z0: r3(g.zs[0]), z1: r3(g.zs[16]),
  mid: r3(gridHeight(g, (g.xs[0] + g.xs[16]) / 2, (g.zs[0] + g.zs[16]) / 2)), outside: gridHeight(g, g.xs[16] + 50, g.zs[0]) };
const m = gridMesh(g, { skirt: 10 }), mSkip = gridMesh(g, { skirt: 10, skip: (i, j) => i < 8 });
let up = 0, down = 0; for (let t = 0; t < m.idx.length; t += 3) {  // the surface's triangles face up (skirts stand on edge)
  const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]].map(i => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny > 1e-6) up++; else if (ny < -1e-6) down++;
}
out.mesh = { tris: m.idx.length / 3, verts: m.pos.length / 3, up, down, skipTris: mSkip.idx.length / 3 };
// carve: a road across the tile 5 m above the ground (a fill): vertices on it take its height, far ones keep theirs
const zMid = (g.zs[0] + g.zs[16]) / 2, road = [[g.xs[0], zMid, 105], [g.xs[16], zMid, 360.5]];
const raw = g.hs.slice(); carve(g, road, 12, 40);
const jm = Math.round(8), on = g.hs[jm * 17 + 4], off = g.hs[0 * 17 + 4];
out.carve = { on: r3(on), rawOn: r3(raw[jm * 17 + 4]), off: r3(off), rawOff: r3(raw[4]), bridgeTouched: carve(makeGrid({ z: Z, x: X, y: Y, segs: 16, sample: S, proj }), [[g.xs[0], zMid, 600], [g.xs[16], zMid, 600]], 12, 40), fillCut: g.cut[jm * 17 + 4] };
// a road 5 m under a level ground (a cut), and one on it with a wall of ground beside it: the carve's cut, and the bank
// the heights already have (steep beside it: a cut; gentle: not)
{ const flat = (h, f) => { const g3 = makeGrid({ z: Z, x: X, y: Y, segs: 16, sample: S, proj }); for (let v = 0; v < g3.hs.length; v++) g3.hs[v] = g3.raw[v] = f(v); return g3; };
  const step = Math.abs(g.zs[9] - g.zs[8]), line = h => [{ pts: [[g.xs[0], g.zs[8], h], [g.xs[16], g.zs[8], h]], r0: 6, r1: 20, rc: step * 1.5, half: 3 }];
  const cutG = flat(0, () => 50); carve(cutG, [], 0, 1, line(45));
  const steep = flat(0, v => (Math.floor(v / 17) === 7 ? 50 + step : 50)), gentle = flat(0, v => (Math.floor(v / 17) === 7 ? 50 + step * 0.4 : 50));
  carve(steep, [], 0, 1, [{ ...line(50)[0], r0: 1, r1: 2 }]); carve(gentle, [], 0, 1, [{ ...line(50)[0], r0: 1, r1: 2 }]);
  out.cuts = { cut: cutG.cut[8 * 17 + 4], steep: steep.cut[7 * 17 + 4], gentle: gentle.cut[7 * 17 + 4], far: steep.cut[2 * 17 + 4] }; }
// the ground under a road's top: a 4 m wide road 3 m under the ground across the middle row of the tile; the row under
// it comes down to just under it, the next rows only as far as the rise allowed from its edge, far rows not at all
{ const g2 = makeGrid({ z: Z, x: X, y: Y, segs: 16, sample: S, proj }), zc = g2.zs[8], x0 = g2.xs[0], x1 = g2.xs[16], y = 50;
  for (let v = 0; v < g2.hs.length; v++) g2.hs[v] = y + 3;
  const T = [x0, y, zc - 2, x1, y, zc - 2, x1, y, zc + 2, x0, y, zc - 2, x1, y, zc + 2, x0, y, zc + 2], step = Math.abs(g2.zs[9] - g2.zs[8]);
  const moved = pushUnder(g2, T, { margin: step * 1.2, slope: 0.02 });  // this tile's rows are 120 m apart
  out.pushUnder = { moved, on: r3(g2.hs[8 * 17 + 5]), next: r3(g2.hs[9 * 17 + 5]), far: r3(g2.hs[2 * 17 + 5]), step: r3(step) };
  // a trail (cover: false): only the ground at its own points comes down, not the whole triangles across it
  for (let v = 0; v < g2.hs.length; v++) g2.hs[v] = y + 3;
  out.trailPush = { moved: pushUnder(g2, T, { margin: 0.6, slope: 1, cover: false }), next: r3(g2.hs[9 * 17 + 5]) }; }
// classes: a wood square in the middle of the tile, a beach inside it wins (later class)
const box = (s, w, n, e) => [[s, w], [s, e], [n, e], [n, w], [s, w]];
const la = i => latOf(Y + i / 16, Z), lo = i => lonOf(X + i / 16, Z);
const lu = rasterClasses(g, [{ k: 'wood', rings: [box(la(12.5), lo(3.5), la(3.5), lo(12.5))] }, { k: 'sand', rings: [box(la(8.5), lo(7.5), la(7.5), lo(8.5))] }, { k: 'building', rings: [box(la(16), lo(0), la(0), lo(16))] }]);
out.classes = { corner: lu[0], wood: lu[5 * 17 + 5], sand: lu[8 * 17 + 8], count: [...lu].filter(v => v).length };
const gf = gridFromHeights({ z: Z, x: X, y: Y, hs: g.hs, n: 17, step: 4, proj });
out.coarse = { segs: gf.segs, n: gf.hs.length, corner: r3(gf.hs[4]), same: r3(g.hs[16]) };

/* ---------- roads ---------- */
const B = builder();
const centre = ribbon(B, [[0, 0], [0, -20]], { w: 6, lm: 2, lanes: 2, hAt: (x, z) => 10 + x * 0.1, lift: 0.25, step: 5 });
// a trail across a 1 in 1 hillside: draped, its edges on the ground; a road there stays level across within its crossfall
{ const T1 = builder(), T2 = builder(), hill = (x, z) => 10 + x;
  ribbon(T1, [[0, 0], [0, -20]], { w: 2, surf: 2, hAt: hill, lift: 0.15, drape: true }); ribbon(T2, [[0, 0], [0, -20]], { w: 2, hAt: hill, lift: 0.15 });
  const a1 = T1.done().pos, a2 = T2.done().pos; out.drape = { trail: r3(Math.abs(a1[1] - a1[4])), road: r3(Math.abs(a2[1] - a2[4])) }; }
const d = B.done(), ys = [], xs = [];
for (let i = 0; i < d.pos.length; i += 3) { xs.push(r3(d.pos[i])); ys.push(r3(d.pos[i + 1])); }
let faceUp = 0; for (let t = 0; t < d.idx.length; t += 3) {
  const [a, b, c] = [d.idx[t], d.idx[t + 1], d.idx[t + 2]].map(i => [d.pos[3 * i], d.pos[3 * i + 1], d.pos[3 * i + 2]]);
  if ((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) > 0) faceUp++;
}
const B2 = builder(), deck = ribbon(B2, [[0, 0], [100, 0]], { w: 8, hAt: () => 0, deck: [40, 60], lift: 0 }), pil = deckSides(B2, deck, 8, 1.4, () => 0, 30);
out.ribbon = { verts: d.pos.length / 3, tris: d.idx.length / 3, faceUp, xs: [...new Set(xs)].sort((a, b) => a - b), edgeY: [ys[0], ys[1]], centre: centre.map(p => r3(p[1])),
  code: [...d.code.slice(0, 4)], v: [...d.uv].filter((_, i) => i % 2).slice(-2), deck: [r3(deck[0][1]), r3(deck.at(-1)[1]), r3(deck[Math.floor(deck.length / 2)][1])], pillars: pil.length,
  resample: resample([[0, 0], [0, 23]], 5).length };
out.styles = Object.fromEntries([['tertiary', 0, 0], ['primary', 4, 0], ['trunk', 2, 8], ['motorway', 4, 8], ['residential', 0, 0], ['path', 0, 0], ['tertiary', 0, 4],
  ['unclassified', 1, 8 | 32 | 256 | 4096], ['unclassified', 2, 32 | 64], ['tertiary', 0, 0, 9]]
  .map(([hw, ln, fl, wd = 0]) => [`${hw}/${ln}/${fl}${wd ? '/' + wd : ''}`, roadStyle(hw, ln, fl, wd)]));
out.clip = clipLine([[-10, 5], [5, 5], [5, 20], [20, 20], [20, 5], [30, 5]], [0, 0, 10, 10]).map(r => r.map(p => p.map(r3)));

/* ---------- landuse ---------- */
const ring = pts => pts.map(([lat, lon]) => ({ lat, lon }));
const j = { elements: [
  { type: 'way', id: 1, tags: { natural: 'wood', leaf_type: 'needleleaved' }, geometry: ring([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]) },
  { type: 'way', id: 2, tags: { building: 'yes', 'building:levels': '3' }, geometry: ring([[0, 0], [0, 0.001], [0.001, 0.001], [0, 0]]) },
  { type: 'way', id: 3, tags: { highway: 'residential' }, geometry: ring([[0, 0], [1, 1]]) },
  { type: 'way', id: 4, tags: { natural: 'scrub' }, geometry: ring([[0, 0], [0, 1], [1, 1]]) },  // not closed
  { type: 'relation', id: 5, tags: { type: 'multipolygon', natural: 'water' }, members: [
    { type: 'way', role: 'outer', geometry: ring([[0, 0], [0, 2], [2, 2]]) }, { type: 'way', role: 'outer', geometry: ring([[0, 0], [2, 0], [2, 2]]) },
    { type: 'way', role: 'inner', geometry: ring([[0.5, 0.5], [0.5, 1], [1, 1], [0.5, 0.5]]) }] },
] };
const f = parseLanduse(j);
const rt = decode(encode(f));
out.landuse = { kinds: f.map(x => x.k), ids: f.map(x => x.id), lt: f[0].lt, h: f[1].h, rings: f.map(x => x.rings.length), outer: f[2].rings[0].length,
  roundTrip: rt.map(x => [x.k, x.rings[0].length, x.h ?? null, x.lt ?? null]), holeIn: inRings(f[2].rings, 0.6, 0.8), solidIn: inRings(f[2].rings, 1.5, 0.3),
  heights: [buildingHeight({ height: '25 m' }), buildingHeight({ 'building:levels': '2' }), buildingHeight({ building: 'garage' })] };
out.clipRing = clipRing([[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]], [1, 1, 3, 5]);
out.roadsRT = decodeRoads(encodeRoads([{ hw: 'tertiary', fl: 9, ln: 2, dk: [61.25, 70.5], pts: [[37.9, -122.6], [37.90012, -122.60034]] },
  { hw: 'unclassified', fl: 8 | 32 | 256 | 4096, ln: 1, wd: 8.4, pts: [[37.9, -122.6], [37.9001, -122.6]] }]));
const sc = scatter([[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]], 10, 1), sc2 = scatter([[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]], 10, 1);
out.scatter = { n: sc.length, same: JSON.stringify(sc) === JSON.stringify(sc2), inside: sc.every(([x, z]) => x >= 0 && x <= 100 && z >= 0 && z <= 100),
  half: scatter([[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]], 10, 0.5).length };

/* ---------- streaming ---------- */
const w1 = wanted(37.9, -122.6, 14, [1, 2]), lods = [...w1.values()];
out.stream = { n: w1.size, fine: lods.filter(x => x === 0).length, mid: lods.filter(x => x === 1).length };
const have = new Map(w1); const w2 = wanted(37.9, -122.6 + 0.022 * 1.2, 14, [1, 2]), p2 = plan(have, w2, 37.9, -122.6 + 0.022 * 1.2, 1);
const w3 = wanted(37.9, -122.6 + 0.022 * 4, 14, [1, 2]), p3 = plan(have, w3, 37.9, -122.6 + 0.022 * 4, 1);
out.plan = { add: p2.add.length, change: p2.change.length, drop: p2.drop.length, dropFar: p3.drop.length, nearestFirst: p2.add.length > 1 };
out.children = { n: childrenOf('11/327/791').length, first: childrenOf('11/327/791')[0], parent: parentOf('14/2623/6335') };
let clock = 0; const q = jobQueue(() => clock), ran = [];
q.add('a', 2, () => { ran.push('a'); clock += 3; }); q.add('b', 1, () => { ran.push('b'); clock += 3; }); q.add('c', 3, () => { ran.push('c'); clock += 3; }); q.add('a', 0, () => { ran.push('a2'); clock += 3; });
const first = q.run(5), left = q.size; q.run(100);
out.jobs = { first, left, ran };

/* ---------- baked tiles ---------- */
const hs = new Float32Array(17 * 17).map((_, i) => 100 + (i % 17) * 1.25 - Math.floor(i / 17) * 0.75 + (i === 40 ? -150.3 : 0));
const packed = packTile({ f: [[1, [[1, 2, 3, 4]]]] }, hs, 17), un = unpackTile(packed, 17);
out.baked = { json: un.json, maxErr: Math.max(...hs.map((h, i) => Math.abs(h - un.hs[i]))), bytes: packed.length, at: r3(gridAt(un.hs, 17, 2.5, 0)), corner: r3(gridAt(un.hs, 17, 0, 0)) };
// a tile's grid side from its own size (the lidar's tiles are finer than Terrarium's)
{ const fine = new Float32Array(33 * 33).map((_, i) => 20 + (i % 33) * 0.5), u2 = unpackTile(packTile({ r: [] }, fine, 33)), u3 = unpackTile(packed);
  out.bakedSide = { fine: u2.n, coarse: u3.n, last: r3(u2.hs.at(-1)) }; }

/* ---------- rider ---------- */
const hip = [BIKE.saddle[1], BIKE.saddle[2]], feet = [[0.12, 0.2], [0.46, 0.02], [0.3, -0.15]];
out.knee = feet.map(ft => { const k = knee(hip, ft); return [r3(Math.hypot(k[0] - hip[0], k[1] - hip[1])), r3(Math.hypot(k[0] - ft[0], k[1] - ft[1])), k[1] < Math.max(hip[1], ft[1])]; });

/* ---------- the view: WebGL2 or the fallback ---------- */
resetProbe(); const noDoc = probeWebGL2(null);
resetProbe(); const noGl = probeWebGL2({ createElement: () => ({ getContext: () => null }) });
resetProbe(); let lost = 0; const yesGl = probeWebGL2({ createElement: () => ({ getContext: k => k === 'webgl2' ? { getExtension: () => ({ loseContext: () => lost++ }) } : null }) });
resetProbe(); const throws = probeWebGL2({ createElement: () => { throw new Error('x'); } });
out.probe = { noDoc, noGl, yesGl, lost, throws };
out.pick = {
  owDefault: pickView({ open: true, gl: true }), owNoGl: pickView({ open: true, gl: false }), owNoGl3d: pickView({ open: true, gl: false, d3: true }),
  owFailed: pickView({ open: true, gl: true, failed: true }), owPref3d: pickView({ open: true, gl: true, pref: '3d' }), owPref2d: pickView({ open: true, gl: true, pref: '2d' }),
  owPrefWorldFailed: pickView({ open: true, gl: true, pref: 'world', failed: true }), course: pickView({ open: false, gl: true, d3: true }), course2d: pickView({ open: false, gl: true }),
};

/* ---------- the open world's edge ---------- */
// a road along the north edge of the world: a junction with one way leading out of it and one along the edge
const N = BOUNDS[0][2], edge = N - 0.0005, mk = (id, nodes, pts, hw = 'tertiary') => ({ id, hw, name: '', ref: '', ow: 0, br: 0, rb: 0, nodes, pts });
const ways = [mk(1, [1, 2], [[edge, -122.50], [edge, -122.499]]), mk(2, [2, 3], [[edge, -122.499], [N + 0.002, -122.499]], 'primary'), mk(3, [2, 4], [[edge, -122.499], [edge - 0.0004, -122.498]], 'residential')];
const g0 = new RoadGraph(), gIn = new RoadGraph({ inside: inWorld });
for (const gg of [g0, gIn]) gg.addCell('x', ways), gg.complete = () => true;
const pl = gr => { const p = Plan.at(gr, gr.snap(edge, -122.4995, 90)); p.extend(300, 6); return p.seq.map(s => s.id); };
out.edge = { opts: g0.options(1, 2).map(e => e.to), optsIn: gIn.options(1, 2).map(e => e.to), plan: pl(g0), planIn: pl(gIn), inside: inWorld(37.83, -122.5), outside: inWorld(37.9, -122.6), bridge: inWorld(37.815, -122.478) };

/* ---------- drafting ---------- */
const me = { lat: 37.9, lon: -122.6, h: 0 }, ahead = m => ({ lat: 37.9 + m / 111195, lon: -122.6 });
out.draft = { close: draftShare(me, [ahead(3)]), far: draftShare(me, [ahead(9)]), gone: draftShare(me, [ahead(20)]), behind: draftShare(me, [ahead(-3)]),
  side: draftShare(me, [{ lat: 37.9 + 3 / 111195, lon: -122.6 + 3 / (111195 * Math.cos(37.9 * Math.PI / 180)) }]), best: draftShare(me, [ahead(20), ahead(2)]), none: draftShare(me, []) };
let v0 = 0, v1 = 0; for (let i = 0; i < 120; i++) { v0 = speedStep(v0, 250, 0, 84, 1); v1 = speedStep(v1, 250, 0, 84, 1, 0.3); }
out.draftSpeed = { solo: r3(v0 * 3.6), drafting: r3(v1 * 3.6), capped: r3(speedStep(10, 250, 0, 84, 1, 5) * 3.6), capped35: r3(speedStep(10, 250, 0, 84, 1, 0.35) * 3.6) };
{
  let t = 0; const hub = { mode: 'ble', r: { power: 250, cadence: 90, hr: 0, speed: 0, last: 0, hrLast: 0 }, want() {}, status() { return {}; } };
  const eng = new Engine({ hub, logEvent: () => {}, settings: () => ({ ftp: 250, weight: 75 }), save: () => {}, archive: () => {}, clock: () => t, wall: () => 1.7e12 + t * 1000 });
  const ll = Array.from({ length: 400 }, (_, i) => [37.9 + i * 10 / 111195, -122.6]);
  eng.control('load', { course: { name: 'Open world', open: true, ele: ll.map(() => 10), ll, nd: [[0, 1], [3990, 2]] } }); eng.control('start', {});
  const run = n => { for (let i = 0; i < n; i++) { t += 1; hub.r.last = t; eng.tick(1); } return eng.ride.cs.v * 3.6; };
  const solo = run(200), res = eng.control("draft", { k: 0.3 }), drafted = run(4), lapsed = run(90);
  out.engineDraft = { solo: r3(solo), res, drafted: drafted > solo + 0.3, lapsed: Math.abs(lapsed - solo) < 0.3, clamp: eng.control('draft', { k: 9 }).draft };
}

/* ---------- round 2: smooth terrain, grass scatter, sky colours, procedural textures ---------- */
{
  // a 5 x 5 grid, a plane rising 2 m per sample east and 1 m per sample south, a bump in the middle
  const n = 5, hs = new Float32Array(n * n); for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hs[j * n + i] = 10 + 2 * i + j;
  const up = upsample(hs, n, 2), m = 9;
  let through = true, linear = true;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (Math.abs(up[(2 * j) * m + 2 * i] - hs[j * n + i]) > 1e-4) through = false;
  for (let J = 2; J < m - 2; J++) for (let I = 2; I < m - 2; I++) if (Math.abs(up[J * m + I] - (10 + I + J / 2)) > 1e-4) linear = false;  // a plane stays a plane inside
  const bump = hs.slice(); bump[12] += 8; const ub = upsample(bump, n, 2), ext = upsample(bump, n, 2, () => 99);
  // the east edge of one tile and the west edge of the next, each upsampled alone: the same heights on the shared edge
  const A = new Float32Array(n * n), B = new Float32Array(n * n), f = (x, y) => 50 + 10 * Math.sin(x * 0.9) + 5 * Math.cos(y * 1.3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { A[j * n + i] = f(i, j); B[j * n + i] = f(i + n - 1, j); }
  const ua = upsample(A, n, 2), ubb = upsample(B, n, 2); let seam = 0; for (let J = 0; J < m; J++) seam = Math.max(seam, Math.abs(ua[J * m + m - 1] - ubb[J * m]));
  const g = { segs: 4, xs: Float64Array.from([0, 10, 20, 30, 40]), zs: Float64Array.from([0, 10, 20, 30, 40]), hs: bump, raw: bump };
  const nor = gridNormals(g), cv = gridCurvature(g, 10, 4), ix = 3 * 7;
  const lu = Uint8Array.from([0, 6, 9, 2]), mk = classMasks(lu, Uint8Array.from([0, 0, 0, 1]));
  out.smooth = { n: up.length, through, linear, peak: r3(ub[4 * m + 4]), overshoot: ub[4 * m + 4] > 18 && ub[4 * m + 3] > ub[4 * m + 2], extSame: ext[4 * m + 4] === ub[4 * m + 4], seam: r3(seam),
    normal: [r3(nor[ix]), r3(nor[ix + 1]), r3(nor[ix + 2])], unit: r3(Math.hypot(nor[ix], nor[ix + 1], nor[ix + 2])),
    ridge: r3(cv[12]), hollow: cv[0] > 0 ? 'up' : 'flat', masks: [mk[8 + 0], mk[16 + 6], mk[24 + 1], mk[24 + 4]] };
}
{
  const a = cellPoints(3, -7, 20, 50), b = cellPoints(3, -7, 20, 50), c = cellPoints(4, -7, 20, 50);
  const inside = a.every(([x, z, r]) => x >= 60 && x < 80 && z >= -140 && z < -120 && r >= 0 && r < 1);
  const near = cellsAround(5, 5, 30, 20), cg = clumpGeometry();
  out.scatter2 = { same: JSON.stringify(a) === JSON.stringify(b), differs: JSON.stringify(a) !== JSON.stringify(c), inside, n: a.length,
    cells: near.length, first: near[0].slice(0, 2), sorted: near.every((q, i) => !i || near[i - 1][2] <= q[2]), within: near.every(q => q[2] < 30),
    blades: cg.idx.length / 3, verts: cg.pos.length / 3 };
}
{
  const sun = [0.7, Math.sin(13 * Math.PI / 180), -0.7], zen = skyRadiance([0, 1, 0], sun, { turbidity: 2.6, rayleigh: 1.6 }), hor = skyRadiance([-0.7, 0.03, 0.7], sun, { turbidity: 2.6, rayleigh: 1.6 });
  const low = sunTint(3), high = sunTint(60);
  out.sky = { zenBlue: zen[2] > zen[0], horPaler: hor[2] / hor[0] < zen[2] / zen[0], lowRed: low[0] === 1 && low[2] < 0.2, highWhite: high[2] > 0.6, finite: [...zen, ...hor].every(Number.isFinite) };
}
{
  const S = 64, np = noisePixels(S), wp = wavePixels(S);
  let wrap = 0, step = 0, mean = 0;
  for (let y = 0; y < S; y++) { wrap = Math.max(wrap, Math.abs(np[(y * S + S - 1) * 4] - np[(y * S) * 4])); for (let x = 1; x < S; x++) step = Math.max(step, Math.abs(np[(y * S + x) * 4 + 3] - np[(y * S + x - 1) * 4 + 3])); }
  for (let i = 0; i < S * S; i++) mean += wp[i * 4] / (S * S);
  out.tex = { n: np.length, wrap, smooth: step, waveFlat: Math.round(mean), same: noisePixels(S).every((v, i) => v === np[i]) };
}
{
  // a leaf atlas of two 32 px cells: a disc in the left one, nothing in the right; the mipmaps keep the disc's share
  // of texels over the alpha test, clear texels take the cell's colour
  const W = 64, H = 32, px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < 32; x++) if (Math.hypot(x - 15.5, y - 15.5) < 10) px.set([200, 120, 40, 255], (y * W + x) * 4);
  const m = coverageMips(px, W, H, 2, 1), cover = l => { const c = l.width / 2; let n = 0; for (let y = 0; y < l.height; y++) for (let x = 0; x < c; x++) if (l.data[(y * l.width + x) * 4 + 3] >= 128) n++; return n / (c * l.height); };
  out.mips = { levels: m.length, last: [m.at(-1).width, m.at(-1).height], cover: m.slice(0, 4).map(l => r3(cover(l))), fill: [...px.slice(0, 3)], empty: m[1].data[(0 * 32 + 20) * 4 + 3] };
}

{
  const vs = [0, 0.5, 2, 5, 10, 15, 20, 30], mono = f => vs.every((v, i) => !i || f(v) >= f(vs[i - 1]));
  out.audio = { windStill: windGain(0), wind10: r3(windGain(10)), windCap: windGain(60), windUp: mono(windGain), tireStill: tireGain(0.3), tire10: r3(tireGain(10)), tireGravel: r3(tireGain(10, 1)), tireUp: mono(v => tireGain(v)),
    hz: [tireHz(0), tireHz(10)], tickPedal: tickRate(10, 85), tickStill: tickRate(0.5, 0), tick5: r3(tickRate(5, 0)), tickCap: tickRate(40, 0), seaNone: oceanGain(0), seaHalf: r3(oceanGain(0.5)), seaSome: oceanGain(0.2) > 0 && oceanGain(0.2) < oceanGain(0.5) };
  // a two-lane road 7.6 m wide: the car's lane 1.9 m right of the centre line, a rider 2.7 m right (keeping right)
  const pp = (gap, rl, off, left) => { const p = passPlan(gap, rl, off, 1.9, left, 20, 8); return { v: r3(p.v), target: r3(p.target) }; };
  out.pass = { clear: pp(80, 2.7, 1.9, -2.65), moving: pp(15, 2.7, 1.9, -2.65), beside: pp(0, 2.7, 0.3, -2.65), blocked: pp(15, 2.7, 1.9, 1.1), behind: pp(-10, 2.7, 0.3, -2.65), across: pp(10, -2.7, 1.9, -2.65) };
  // a car at 20 to 25 m/s comes up behind riders at 60 Hz: the least room across while it is beside one (car side to
  // the rider's middle), the least room along while it is in the rider's line, where it ends
  const drive = ({ riders, left, v0 = 20, secs = 40 }) => {
    const c = { v: v0, v0, off: 1.9 }; let s = -120, room = Infinity, back = Infinity;
    for (let i = 0; i < secs * 60; i++) {
      const rs = riders.map(r => ({ gap: r.s + r.v * i / 60 - s, rl: r.rl, v: r.v }));
      for (const r of rs) { if (Math.abs(r.gap) < 2.35 + 0.3) room = Math.min(room, Math.abs(r.rl - c.off) - 0.91); if (Math.abs(r.rl - c.off) < 0.91 + 0.3) back = Math.min(back, Math.abs(r.gap) - 2.35); }
      const st = carStep(c, rs, { laneOff: 1.9, leftmost: left, L: 4.7, W: 1.82 }, 1 / 60); c.v = st.v; c.off = st.off; s += st.move;
    }
    return { room: r3(room), back: r3(back), past: s > riders[0].s + riders[0].v * secs + 10, v: r3(c.v), off: r3(c.off) };
  };
  out.cars = { pass: drive({ riders: [{ s: 0, rl: 2.7, v: 8 }], left: -2.65 }), blocked: drive({ riders: [{ s: 0, rl: 2.7, v: 8 }], left: 1.1 }),
    slow: drive({ riders: [{ s: 0, rl: 2.7, v: 2 }], left: -2.65, v0: 25 }), group: drive({ riders: [{ s: 0, rl: 2.7, v: 8 }, { s: 3, rl: 1.6, v: 8 }, { s: -2, rl: 0.7, v: 8 }], left: -2.65 }),
    groupBlocked: drive({ riders: [{ s: 0, rl: 2.7, v: 8 }, { s: 3, rl: 1.6, v: 8 }], left: 1.1 }) };
}

{
  const run = (s, secs, cad, v, g) => { for (let i = 0; i < secs * 60; i++) stance(s, 1 / 60, cad, v, g); return s; };
  const s = newStance(0); run(s, 3, 85, 4, 0.09); const up = { up: s.up, sb: r3(s.sb) };
  run(s, 1, 85, 4, 0.07); const held = s.up; run(s, 2, 85, 6, 0.04); const down = { up: s.up, sb: r3(s.sb) };
  const c = newStance(1.0); run(c, 3, 0, 8, 0); const level = r3(Math.abs((c.ca % Math.PI) - Math.PI / 2)), still = r3(Math.abs(c.cw));
  const t = newStance(0); run(t, 2, 0, 15, -0.06); const tuck = { tuck: t.tuck, tb: r3(t.tb) };
  const root = [0, 1, 0], mid = ik(root, [0, 0.2, -0.3], 0.46, 0.47, [0, 0, -1]), L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  out.stance = { up, held, down, level, still, tuck, thigh: r3(L(root, mid)), shin: r3(L(mid, [0, 0.2, -0.3])), forward: mid[2] < -0.15 };
}

{
  // three ways of one road (the middle one drawn backwards) and a side road at the second joint: two chains
  const a = [37.9, -122.6], b = [37.9, -122.599], cc = [37.9, -122.598], d = [37.9, -122.597], side = [37.901, -122.598];
  const ws = [{ hw: 'tertiary', fl: 0, pts: [a, b] }, { hw: 'tertiary', fl: 0, pts: [cc, b] }, { hw: 'tertiary', fl: 0, pts: [cc, d] }, { hw: 'residential', fl: 0, pts: [cc, side] }, { hw: 'tertiary', fl: 1, pts: [d, [37.9, -122.596]] }];
  const ch = chainWays(ws, r => r.fl & 3 ? null : r.hw);
  // a right angle corner of two 20 m legs: rounded, never more than dmax from the corner's lines, ends kept
  const rc = roundCorners([[0, 0], [20, 0], [20, 20]], 0.35), dev = Math.max(...rc.map(([x, z]) => Math.min(Math.abs(z), Math.abs(x - 20))));
  out.chain = { n: ch.length, first: ch[0].pts.length, joined: JSON.stringify(ch[0].pts) === JSON.stringify([a, b, cc]), rest: ch.map(r => r.pts.length), round: { n: rc.length, dev: r3(dev), ends: JSON.stringify([rc[0], rc.at(-1)]) === '[[0,0],[20,20]]' } };
}
{
  // two ways of one road meet end to end, 10 m and 7.6 m wide: each eases to 8.8 m at the joint over TAPER metres; a
  // bridge on the other side keeps its own width and the road meets it at that
  const a = [37.9, -122.6], b = [37.9, -122.599], c2 = [37.9, -122.598], proj = makeProj(37.9, -122.6), W = { wide: 10, narrow: 7.6, deck: 12 };
  const roads = [{ hw: 'wide', pts: [a, b] }, { hw: 'narrow', pts: [b, c2] }, { hw: 'deck', fl: 1, pts: [c2, [37.9, -122.597]] }];
  const j = tapers(roads, { width: r => W[r.hw], rigid: r => r.fl & 1, xz: proj.xz }), [bx, bz] = proj.xz(...b);
  const B = builder(), cen = ribbon(B, [proj.xz(...a), proj.xz(...b)], { w: 10, hAt: () => 0, joints: j.get(0), step: 5 }), d = B.done();
  out.taper = { ends: [...j.keys()].sort(), atJoint: r3(taperedWidth(10, j.get(0), bx, bz)), narrowAtJoint: r3(taperedWidth(7.6, j.get(1), bx, bz)),
    away: r3(taperedWidth(10, j.get(0), bx - TAPER - 1, bz)), toDeck: r3(taperedWidth(7.6, j.get(1), ...proj.xz(...c2))), deckHas: j.has(2),
    first: r3(Math.hypot(d.pos[0] - d.pos[3], d.pos[2] - d.pos[5])), last: r3(Math.hypot(d.pos.at(-6) - d.pos.at(-3), d.pos.at(-4) - d.pos.at(-1))), half: r3(cen.at(-1)[3]), code: r3(d.code.at(-1 - 4)) };
}
{
  // the ground cover grid: header, classes, lookups; the scrub's bushes only on scrub cells, the same every time
  const n = 64, cls = new Uint8Array(n * n).fill(GRASS); for (let j = 0; j < n; j++) for (let i = 0; i < n / 2; i++) cls[j * n + i] = SCRUB;
  const head = new TextEncoder().encode(JSON.stringify({ box: [37.8, -122.6, 37.81, -122.59], n })), pad = (4 + head.length) % 2, buf = new Uint8Array(4 + head.length + pad + n * n);
  new DataView(buf.buffer).setUint32(0, head.length, true); buf.set(head, 4); buf.set(cls, 4 + head.length + pad);
  const v = parseVeg(buf), rgba = v.rgba(), proj = makeProj(37.805, -122.595), at = (x, z) => v.at(proj.lat(z), proj.lon(x));
  const b1 = cellBushes(-3, -2, at), b2 = cellBushes(-3, -2, at), west = cellBushes(-10, 0, at), east = cellBushes(8, 0, at);
  const paved = makeVeg([37.8, -122.6, 37.81, -122.59], 1, Uint8Array.of(PAVED)).rgba();
  out.veg = { west: v.at(37.805, -122.598), east: v.at(37.805, -122.591), outside: v.at(37.9, -122.598), rgba: [...rgba.slice(0, 4)], rgbaEast: [...rgba.slice(4 * (n - 1), 4 * n)], paved: [...paved],
    same: JSON.stringify(b1) === JSON.stringify(b2), westN: west.length, eastN: east.length, onScrub: west.every(([x, z]) => at(x, z) === SCRUB),
    perCell: SCRUB_CELL * SCRUB_CELL, scales: [r3(Math.min(...west.map(q => q[2]))), r3(Math.max(...west.map(q => q[2])))] };
}

/* ---------- road sides (banks.js) ---------- */
// a straight road east along z = 0 at height 10, 6 m wide (its right edge z = +3): the ground falling away on the right
// (2 m under the edge, then 1 in 3); on the left the lidar's bank rising at 3 in 2, the drawn ground carved level to the
// road for 2.5 m and back onto the lidar by 7 m out
{
  const C = []; for (let x = 0; x <= 40; x += 5) C.push([x, 10, 0, 3, x, 10, 3, x, 10, -3]);
  const rawL = o => 10 + o * 1.5, carved = o => o < 2.5 ? 10 : o < 7 ? 10 + (rawL(o) - 10) * (o - 2.5) / 4.5 : rawL(o);
  const ground = (x, z) => z > 3 ? 8 - (z - 3) / 3 : z < -3 ? carved(-3 - z) : 10, raw = (x, z) => z < -3 ? rawL(-3 - z) : ground(x, z);
  const R = ribbonEdge(C, 1), Lf = ribbonEdge(C, -1), kr = sideKinds(R, ground, raw), kl = sideKinds(Lf, ground, raw), br = bands(R[4], kr[4], ground, { raw }), bl = bands(Lf[4], kl[4], ground, { raw });
  const runs = sideRuns(R, kr, ground, { raw }).concat(sideRuns(Lf, kl, ground, { raw })), geo = bankGeometry(runs);
  let up = 0; for (let k = 0; k < geo.idx.length; k += 3) { const [a, b, c] = [geo.idx[k], geo.idx[k + 1], geo.idx[k + 2]].map(v => geo.pos.slice(3 * v, 3 * v + 3)), ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2]; if (uz * vx - ux * vz > 0) up++; }
  // every strip point on or over the ground, and over the edge's height never over the lidar's (or the drawn) ground by more than 3 cm
  let under = 0, over = 0; for (let i = 0; i < geo.pos.length; i += 3) { const x = geo.pos[i], y = geo.pos[i + 1], z = geo.pos[i + 2]; if (Math.abs(z) <= 3.001) continue; const g = ground(x, z); if (y < g - 0.001) under++; if (y > 10 && y > Math.max(g, raw(x, z)) + 0.031) over++; }
  // a side with the ground at the edge: no strip; one with another road 3 m out: it ends short of it
  const level = bands(R[4], { kind: 0 }, () => 9.97, { raw: () => 9.97 }), blocked = bands(Lf[4], kl[4], ground, { raw, block: (x, z) => z < -6 });
  const rl = railLine(R, 0, R.length - 1), railed = sideKinds(R, (x, z) => 10, raw, () => true);
  out.banks = { normals: [R[0][3], R[0][4], Lf[0][3], Lf[0][4]], right: kr.map(k => k.kind), left: kl.map(k => k.kind), cutH: r3(kl[4].h),
    fill: br.map(b => b.map(r3)), cut: bl.map(b => b.map(r3)), tris: geo.idx.length / 3, up, under, over, runs: runs.length, level, blockedTo: r3(blocked.at(-1)[2]),
    rail: { pts: rl.pts.length, z: r3(rl.pts[3][2]), posts: rl.posts.length, gap: r3(Math.hypot(rl.posts[1][0] - rl.posts[0][0], rl.posts[1][2] - rl.posts[0][2])), yaw: r3(rl.posts[0][3]) }, railed: railed[2] };
}
/* ---------- roads over tunnels ---------- */
{
  const road = [[-50, 0], [50, 0]];
  out.over = { square: overTunnels(road, [{ pts: [[0, -20], [0, 20]], th: 3 }]).map(g => g.map(r3)), angled: overTunnels(road, [{ pts: [[-20, -20], [20, 20]], th: 3 }]).map(g => g.map(r3)),
    end: overTunnels(road, [{ pts: [[50, 0], [90, 0]], th: 3 }]), climb: overTunnels(road, [{ pts: [[0, -20], [0, 20]], th: 3 }], 12, (x, z) => Math.abs(x) < 30 ? 2 : 10).map(g => g.map(r3)) };
}
// the Headlands' under-crossings in the baked tiles (USGS lidar, whose bare earth leaves out the overpasses): each road
// over a tunnel finds the stretch over the lidar's gap, its deck there well over the road under it; the Baker-Barry
// tunnel under its hill; the ground at each portal carved down to the road going in
{
  const APP = new URL('../../app/', import.meta.url), tiles = new Map(), proj = makeProj(37.84, -122.48);
  const tile = (x, y) => { const k = `${x}_${y}`; if (!tiles.has(k)) { const f = new URL(`world/14/${k}.bin`, APP); tiles.set(k, existsSync(f) ? unpackTile(new Uint8Array(gunzipSync(readFileSync(f)))) : null); } return tiles.get(k); };
  const raw = (x, z) => { const la = proj.lat(z), lo = proj.lon(x), X = tileX(lo, 14), Y = tileY(la, 14), t = tile(Math.floor(X), Math.floor(Y)); return t ? gridAt(t.hs, t.n, (X % 1) * (t.n - 1), (Y % 1) * (t.n - 1)) : null; };
  const roadsNear = (la, lo) => { const X = Math.floor(tileX(lo, 14)), Y = Math.floor(tileY(la, 14)), all = []; for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) { const t = tile(X + dx, Y + dy); if (t) all.push(...decodeRoads(t.json.r || [])); } return all; };
  const xz = ([la, lo]) => proj.xz(la, lo);
  out.under = {};
  for (const [name, a, b] of [['alexander101', [37.8357578, -122.4845255], [37.8355005, -122.484859]], ['bunker101', [37.838099, -122.48318], [37.8379019, -122.4828768]],
    ['eastAlexander', [37.8434853, -122.4783654], [37.8433264, -122.4782486]], ['bakerBarry', [37.8418603, -122.4932478], [37.8390149, -122.4858974]]]) {
    const all = roadsNear(...a), T = all.filter(r => r.fl & 2 && r.pts.some(p => Math.abs(p[0] - a[0]) < 2e-5 && Math.abs(p[1] - a[1]) < 2e-5)), tl = T.length ? T.sort((u, w) => w.pts.length - u.pts.length)[0].pts.map(xz) : [xz(a), xz(b)];
    const th = 3.4, f0 = raw(...xz(a)), f1 = raw(...xz(b)), L = Math.hypot(xz(b)[0] - xz(a)[0], xz(b)[1] - xz(a)[1]);
    const floorAt = p => { const t = Math.max(0, Math.min(1, ((p[0] - xz(a)[0]) * (xz(b)[0] - xz(a)[0]) + (p[1] - xz(a)[1]) * (xz(b)[1] - xz(a)[1])) / (L * L))); return f0 + (f1 - f0) * t; };
    const decks = [];
    for (const r of all) {
      if (r.fl & 3 || /path|footway|track|steps|cycleway/.test(r.hw)) continue;
      const P = r.pts.map(xz); for (const [s0, s1] of overTunnels(P, [{ pts: tl, th }], 12, raw)) {
        const at = s => { let d = 0; for (let k = 1; k < P.length; k++) { const l = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); if (s <= d + l || k === P.length - 1) { const f = Math.max(0, Math.min(1, (s - d) / (l || 1))); return [P[k - 1][0] + (P[k][0] - P[k - 1][0]) * f, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * f]; } d += l; } };
        const h0 = raw(...at(s0)), h1 = raw(...at(s1)); let low = 1e9, X = null; for (let s = s0; s <= s1; s += 2) { const p = at(s), h = raw(...p); if (h < low) { low = h; X = p; } }
        decks.push({ hw: r.hw, deckOverFloor: r3(h0 + (h1 - h0) * 0.5 - floorAt(X)), gap: r3(Math.min(h0, h1) - low), span: r3(s1 - s0) });
      }
    }
    // the portal: the way in carved level at the floor (as buildTerrain does: the ground under it no higher than it)
    const c = tile(Math.floor(tileX(a[1], 14)), Math.floor(tileY(a[0], 14))), g = gridFromHeights({ z: 14, x: Math.floor(tileX(a[1], 14)), y: Math.floor(tileY(a[0], 14)), hs: c.hs, n: c.n, proj });
    const pa = xz(a), dir = [pa[0] - xz(b)[0], pa[1] - xz(b)[1]].map(v => v / L), way = [0, 8, 16].map(o => [pa[0] + dir[0] * o, pa[1] + dir[1] * o, Math.min(f0, raw(pa[0] + dir[0] * 16, pa[1] + dir[1] * 16))]);
    carve(g, [], 0, 1, [{ pts: way, r0: 6, r1: 12 }]);
    let mid = 0; for (let k = 1; k < 10; k++) { const p = [pa[0] + (xz(b)[0] - pa[0]) * k / 10, pa[1] + (xz(b)[1] - pa[1]) * k / 10]; mid = Math.max(mid, raw(...p) - floorAt(p)); }
    out.under[name] = { decks, cover: r3(mid), portal: r3(gridHeight(g, ...pa) - way[0][2]) };
  }
}

/* ---------- streaming along the route: a queued job moves when the route turns round, a half done one kept ---------- */
{
  const J = jobQueue(() => 0), ran = [];
  function* slow() { ran.push('a1'); yield; ran.push('a2'); }
  J.add('a', 1, slow); J.add('b', 2, () => ran.push('b')); J.add('c', 3, () => ran.push('c'));
  J.run(0); J.reprio('a', 9); J.reprio('c', 0.5); J.run(0); J.run(0); J.run(0);
  out.reprio = ran;
}
/* ---------- rails (rail.js): the baked rails walked at light speed, every road and every open world start ---------- */
{
  // the format and the pure pieces
  const pts = [[37.83, -122.5], [37.83, -122.4996], [37.8301, -122.4996]], idx = [], D = dense(pts, 5, idx);
  const h = Float64Array.from(D, (_, i) => i % 2 ? 10.3 : 10), sm = smoothRail(h, 2, new Set([idx[1]]));
  const T = track([[0, 0], [10, 0], [10, 10]], [0, 1, 3]), q = T.at(5, 2), qr = T.at(5, -2);
  const r2 = { hw: 'unclassified', ln: 2, fl: 96, wd: 0 }, r0 = { hw: 'tertiary', ln: 0, fl: 0, wd: 0 }, rp = { hw: 'cycleway', ln: 0, fl: 0, wd: 0 }, rk = { hw: 'unclassified', ln: 1, fl: 4392 | 256, wd: 0 };
  out.railBasics = { n: D.length, idx, step: r3(Math.max(...D.slice(1).map((p, i) => Math.hypot((p[0] - D[i][0]) * 111195, (p[1] - D[i][1]) * 111195 * Math.cos(37.83 * Math.PI / 180))))),
    pinned: sm[idx[1]], ends: [sm[0], sm.at(-1)], pack: Array.from(unpackH(packH([10.004, 10.5, 9.99]))).map(r3), at: [r3(q.h), r3(q.d), r3(q.s), r3(qr.d)],
    lanes: { bunker: [r3(laneOf(r2, true)), r3(laneOf(r2, false))], plain: r3(laneOf(r0, true)), path: laneOf(rp, true), conzUp: r3(laneOf(rk, false)), conzDown: r3(laneOf(rk, true)) } };

  const APP = new URL('../../app/', import.meta.url), proj = makeProj(37.83, -122.5), xz = (la, lo) => proj.xz(la, lo);
  const RJ = JSON.parse(gunzipSync(readFileSync(new URL('world/rails.bin', APP))).toString()), RI = railIndex(RJ, xz);
  const tiles = new Map(), tile = (x, y) => { const k = `${x}_${y}`; if (!tiles.has(k)) { const f = new URL(`world/14/${k}.bin`, APP); tiles.set(k, existsSync(f) ? unpackTile(new Uint8Array(gunzipSync(readFileSync(f)))) : null); } return tiles.get(k); };
  const ground = (x, z) => { const la = proj.lat(z), lo = proj.lon(x), X = tileX(lo, 14), Y = tileY(la, 14), t = tile(Math.floor(X), Math.floor(Y)); return t ? gridAt(t.hs, t.n, (X % 1) * (t.n - 1), (Y % 1) * (t.n - 1)) : null; };
  // (a): every rail: its grade over 10 m, the bend from one 5 m step to the next (a jump), how far under the lidar's
  // ground it runs (a cut; tunnels and bridges left out); each tile's piece of a rail the same as the area's
  const portals = RI.rails.filter(q => q.r.fl & 2).flatMap(q => [q.T.P[0], q.T.P.at(-1)]);  // (a cut down to a portal is a cut)
  let worstGrade = 0, worstBend = 0, worstCut = 0, cutAt = null, n = 0, km = 0, tileGap = 0, tilePts = 0;
  for (const q of RI.rails) {
    const { P, h, D } = q.T; n++; km += q.T.L / 1000;
    for (let i = 2; i < P.length; i++) { if (D[i] - D[i - 2] > 4) worstGrade = Math.max(worstGrade, Math.abs(h[i] - h[i - 2]) / (D[i] - D[i - 2])); worstBend = Math.max(worstBend, Math.abs(h[i] - 2 * h[i - 1] + h[i - 2])); }
    if (q.r.fl & 3) continue;
    for (let i = 0; i < P.length; i++) { if (portals.some(([x, z]) => Math.hypot(P[i][0] - x, P[i][1] - z) < 30)) continue; const gr = ground(...P[i]); if (gr != null && gr - h[i] > worstCut) { worstCut = gr - h[i]; cutAt = [+proj.lat(P[i][1]).toFixed(5), +proj.lon(P[i][0]).toFixed(5), q.r.hw]; } }
  }
  for (const [x, y] of [[2618, 6329], [2619, 6329], [2620, 6330], [2617, 6330], [2618, 6330], [2619, 6330]]) {
    const t = tile(x, y); if (!t?.json.rh) continue;
    decodeRoads(t.json.r).forEach((r, i) => {
      if (!t.json.rh[i] || r.fl & 16) return; const H = unpackH(t.json.rh[i]), P = dense(r.pts).map(p => xz(...p)), lift = RI.rails.find(q => q.r.hw === r.hw && q.r.fl === r.fl)?.lift ?? 0;
      for (let k = 0; k < P.length; k += 2) { const top = RI.top(P[k][0], P[k][1], H[k] + lift); if (top != null) { tilePts++; tileGap = Math.max(tileGap, Math.abs(top - lift - H[k])); } }
    });
  }
  // the roads' plan (A2): S-jogs, a turn over 3 degrees with one the other way within 10 m (OpenStreetMap's nodes, smoothed
  // in the bake), on the roads (not paths, driveways or the bridge's ways); the worst the smaller turn of a pair
  let jogs = 0, jogWorst = 0;
  for (const q of RI.rails) { if (q.r.fl & 16 || isTrail(q.r) || /service|cycleway|pedestrian/.test(q.r.hw)) continue; const { P, D } = q.T, turn = [];
    for (let i = 1; i + 1 < P.length; i++) { let t = Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) - Math.atan2(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); while (t > Math.PI) t -= 2 * Math.PI; while (t < -Math.PI) t += 2 * Math.PI; turn.push([i, t * 180 / Math.PI]); }
    for (let k = 0; k < turn.length; k++) { const [i, t] = turn[k]; if (Math.abs(t) < 3) continue; for (let m = k + 1; m < turn.length && D[turn[m][0]] - D[i] < 10; m++) if (Math.abs(turn[m][1]) >= 3 && Math.sign(turn[m][1]) !== Math.sign(t)) { jogs++; jogWorst = Math.max(jogWorst, Math.min(Math.abs(t), Math.abs(turn[m][1]))); break; } } }
  out.rails = { jogs, jogWorst: r3(jogWorst), n, km: r3(km), grade: r3(worstGrade), bend: r3(worstBend), cut: r3(worstCut), cutAt, tileGap: r3(tileGap), tilePts, file: readFileSync(new URL('world/rails.bin', APP)).length };

  // every bridge in the Headlands' tiles: its deck (straight between its ends) never through the ground, and over the
  // lidar's gap (a creek, a road, water), not a slab in the air over a culvert or a ridge
  { let n = 0, through = 0, worst = 0;
    for (let x = 2612; x <= 2622; x++) for (let y = 6325; y <= 6333; y++) { const t = tile(x, y); if (!t) continue;
      for (const r of decodeRoads(t.json.r || [])) { if (!(r.fl & 1) || r.fl & 16 || !r.dk) continue; n++;
        const P = r.pts.map(p => xz(...p)), S = [0]; for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
        let over = 0; for (let i = 0; i < P.length; i++) { const l = r.dk[0] + (r.dk[1] - r.dk[0]) * S[i] / (S.at(-1) || 1), gr = ground(...P[i]); if (gr == null) continue; over = Math.max(over, gr - l); }
        worst = Math.max(worst, over); if (over > 1.2) through++; } }
    out.bridges = { n, through, worst: r3(worst) }; }
  // the under-crossings on the rails: the lower road's rail well under the upper one (or the ground over a tunnel)
  const railNear = (la, lo, f) => { const [x, z] = xz(la, lo); let best = null; for (const id of RI.near(x, z)) { const q = RI.rails[id]; if (!f(q.r)) continue; const p = q.T.at(x, z); if (p && Math.abs(p.d) < q.half + 3 && (!best || Math.abs(p.d) < Math.abs(best.p.d))) best = { p, q }; } return best; };
  const tun = r => r.fl & 2, notTun = r => !(r.fl & 3);
  const lidarOver = (la, lo) => { const [x, z] = xz(la, lo); let top = -1e9; for (let a = 0; a < 6.3; a += 0.52) for (const rr of [14, 22, 30]) { const g2 = ground(x + Math.cos(a) * rr, z + Math.sin(a) * rr); if (g2 != null) top = Math.max(top, g2); } return top; };
  const ux = {};
  { const t = railNear(37.8434, -122.47833, tun), o = railNear(37.8434, -122.47833, notTun); ux.eastUnderAlexander = t && o ? r3(o.p.h - t.p.h) : null; }
  { const t = railNear(37.8356, -122.48468, tun); ux.alexanderUnder101 = t ? r3(lidarOver(37.8356, -122.48468) - t.p.h) : null; }
  { const t = railNear(37.83800, -122.48305, tun); ux.bunkerUnder101 = t ? r3(lidarOver(37.838, -122.48305) - t.p.h) : null; }
  { const t = railNear(37.8405, -122.4897, tun), [x, z] = xz(37.8405, -122.4897); ux.bakerBarry = t ? r3(ground(x, z) - t.p.h) : null; }
  out.railUnder = ux;
  // the hand list's barriers (A4): every entry on a rail, its pieces as long as listed (on past a way's end), each survey
  // pano on a rail; a W-beam listed on Conzelman Road's outer edge at Hawk Hill's bend is found there on its side
  { const HB = handBarriers(RI, BARRIERS, SURVEY, xz), want = BARRIERS.reduce((a, e) => a + e[5] - e[4], 0), got = HB.pieces.reduce((a, p) => a + p.s1 - p.s0, 0);
    const [hx, hz] = xz(37.830207, -122.498459), q = RI.rails[RI.match(hx, hz, Math.sin(16 * Math.PI / 180), -Math.cos(16 * Math.PI / 180))], t = q.T.at(hx, hz), r = (16 + 90) * Math.PI / 180;
    const ex = hx + Math.sin(r) * (q.half + 0.3), ez = hz - Math.cos(r) * (q.half + 0.3), lx = hx - Math.sin(r) * (q.half + 0.3), lz = hz + Math.cos(r) * (q.half + 0.3);
    out.hand = { n: BARRIERS.length, pieces: HB.pieces.length, want: r3(want), got: r3(got), surveyed: HB.surveyed.size, right: HB.at(ex, ez, q.half, hx, hz), left: HB.at(lx, lz, q.half, hx, hz), t: r3(t.d) }; }
  // every portal: the road going on from it meets the bore at its floor's height and heads into its opening (within
  // 35 degrees of the bore's line at the portal: not past its side)
  { const res = [];
    for (const t of RI.rails) { if (!(t.r.fl & 2)) continue;
      for (const end of [0, 1]) {
        const P = t.T.P, n = P.length, e = end ? P[n - 1] : P[0], f = end ? P[n - 2] : P[1], ux = e[0] - f[0], uz = e[1] - f[1], ul = Math.hypot(ux, uz) || 1, he = end ? t.T.h[n - 1] : t.T.h[0];
        for (const q of RI.rails) { if (q === t || q.r.fl & 2) continue; const Q = q.T.P, k = Math.hypot(Q[0][0] - e[0], Q[0][1] - e[1]) < 0.5 ? 0 : Math.hypot(Q.at(-1)[0] - e[0], Q.at(-1)[1] - e[1]) < 0.5 ? Q.length - 1 : -1; if (k < 0) continue;
          const g = Q[k ? k - 2 : 2] ?? Q[k ? k - 1 : 1], vx = g[0] - e[0], vz = g[1] - e[1], vl = Math.hypot(vx, vz) || 1, ang = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (ul * vl)))) * 180 / Math.PI;
          res.push({ at: [+proj.lat(e[1]).toFixed(5), +proj.lon(e[0]).toFixed(5)], ang: Math.round(ang), dh: r3(Math.abs(q.T.h[k] - he)) }); } } }
    out.portals = res; }

  // (b): the open world's starts (world.js PRESETS and perfride's rides), each way, 3 km on: the course as world.js makes
  // it (10 m points, heights from the baked tiles, straight over bridges and through tunnels, smoothed), its profile
  // matched to the rails, ridden at a third of a metre a step (20 m/s at 60 frames a second)
  const g = new RoadGraph({ inside: inWorld });
  for (const f of readdirSync(new URL('roads/marin/', APP))) { const j = JSON.parse(readFileSync(new URL(`roads/marin/${f}`, APP), 'utf8')), byId = new Map(j.ways.map(w => [w.id, w])); for (const [k, ids] of Object.entries(j.cells)) g.addCell(k, ids.map(i => byId.get(i)).filter(Boolean)); }
  const starts = [['ggb', 37.83234, -122.48061, 160], ['conzelman', 37.83300, -122.48341, 190], ['hawk', 37.82625, -122.49900, 250], ['rodeo', 37.83406, -122.53338, 122], ['fortbaker', 37.83658, -122.47779, 330],
    ['hawkDown', 37.826611, -122.499231, 197], ['mccullough', 37.834121, -122.494207, 346], ['bunker', 37.835115, -122.480078, 247]];
  const ggbOn = q => /^Golden Gate Bridge/.test(q.nm) ? onDeck(...q.ll) : null;
  const courseOf = (la, lo, hd) => {
    const s = g.snap(la, lo, hd); if (!s) return null; const p = Plan.at(g, s); p.extend(3000); const pts = p.points(0, 301), ll = pts.map(q => q.ll);
    const R = pts.map(q => { const dk = ggbOn(q); if (dk) return dk.h; const [x, z] = xz(...q.ll); return ground(x, z) ?? 0; });
    return { ll, nm: pts.map(q => q.nm), ele: smoothFrom(bridges(R, pts.map(q => ggbOn(q) ? 0 : q.br)), 0) };
  };
  const ride = c => {
    const P = c.ll.map(p => xz(...p)), pr = profileOf(RI, P, c.ele), rows = [];
    for (let d = 0; d <= (P.length - 1) * 10; d += 1 / 3) {
      const i = Math.min(P.length - 2, Math.floor(d / 10)), f = d / 10 - i, x = P[i][0] + (P[i + 1][0] - P[i][0]) * f, z = P[i][1] + (P[i + 1][1] - P[i][1]) * f;
      const dk0 = onDeck(proj.lat(z), proj.lon(x)), dk = dk0 && Math.abs(c.ele[i] - dk0.h) < 8 ? dk0 : null, hh = profileAt(RI, pr, i, f), hx = P[i + 1][0] - P[i][0], hz = P[i + 1][1] - P[i][1], L = Math.hypot(hx, hz) || 1, lane = pr.lane[i] + (pr.lane[i + 1] - pr.lane[i]) * f;
      // (as view.js: across the rail's tangent, on the topmost road there)
      const sg = hh && hh.tx * hx + hh.tz * hz < 0 ? -1 : 1, nx = hh ? -hh.tz * sg : -hz / L, nz = hh ? hh.tx * sg : hx / L, yr = hh ? Math.max(hh.y, RI.topMax((hh.x) + nx * lane, hh.z + nz * lane, hh.y) ?? hh.y) : null;
      rows.push({ d, x: hh ? hh.x : x, z: hh ? hh.z : z, y: dk ? dk.h + 0.05 : yr, yp: hh ? hh.y : null, rail: hh?.rail ?? null, lane, rx: nx, rz: nz, fw: pr.fw[i] > 0 });
    }
    return { P, pr, rows };
  };
  // the rider's height along it: no step from one frame to the next (jump), and its curvature (second difference
  // over 5 m) no more than the road's own: a smooth line, no bounce
  const bounce = rows => { let b = 0; for (let k = 15; k + 15 < rows.length; k += 3) { const a = rows[k - 15].y, m = rows[k].y, c = rows[k + 15].y; const A = rows[k - 15], C = rows[k + 15], M = rows[k], turn = (M.x - A.x) * (C.x - M.x) + (M.z - A.z) * (C.z - M.z) < 0.5 * Math.hypot(M.x - A.x, M.z - A.z) * Math.hypot(C.x - M.x, C.z - M.z) || Math.hypot(C.x - A.x, C.z - A.z) < 8;  // (not where the course turns round: a dead end)
      if (!turn && a != null && m != null && c != null) b = Math.max(b, Math.abs(a - 2 * m + c)); } return b; };
  out.courses = {};
  for (const [name, la, lo, hd] of starts) for (const back of [0, 1]) {
    const c = courseOf(la, lo, (hd + 180 * back) % 360), key = name + (back ? 'Back' : ''); if (!c) { out.courses[key] = null; continue; }
    const { rows, pr } = ride(c); let jump = 0, none = 0, laneBad = 0, onRail = 0;
    for (let k = 1; k < rows.length; k++) if (rows[k].y != null && rows[k - 1].y != null) jump = Math.max(jump, Math.abs(rows[k].y - rows[k - 1].y));
    for (const r of rows) { if (r.y == null) none++; else onRail++; }
    // a cyclist's line at each course point: the middle of a bike lane on their right where there is one, else 0.5 to
    // 1.5 m in from the right edge of their travel lane (a path, a bike path: its middle)
    const CP = c.ll.map(p => xz(...p));
    for (let i = 0; i < pr.ri.length; i++) {
      if (RI.narrows.some(([x, z]) => Math.hypot(CP[i][0] - x, CP[i][1] - z) < 25)) continue;  // (into a one-lane bore: onto its lane)
      const q = RI.rails[pr.ri[i]]; if (!q) continue; const st = roadStyle(q.r.hw, q.r.ln, q.r.fl, q.r.wd), half = st.w / 2, fw = pr.fw[i] > 0, park = fw ? st.pR : st.pL, bike = q.r.fl & (fw ? 64 : 32), edge = half - park - pr.lane[i];
      if (!isTrail(q.r) && !/cycleway|pedestrian/.test(q.r.hw) && half >= 2 && !(q.r.fl & 2 && q.r.ln === 1) && (bike ? Math.abs(edge - 0.9) > 0.05 : edge > 1.5 || edge < 0.5)) laneBad++;
    }
    const bn = bounce(rows); out.courses[key] = { pts: c.ll.length, jump: r3(jump), bounce: r3(bn), none, onRail, laneBad };
  }
  // the rider's line against where_riders_ride.md (C:/Dev/justwatts-private/streetview), road by road, every start each
  // way: bike the middle of the bike lane on their side, edge 0.5 to 1.5 m in from their travel lane's right edge, right
  // right of a sidewalk's middle (keep right)
  // (a bike lane, or a shoulder OpenStreetMap or the bake's patch tags as one, where the way has one on the rider's side:
  // Conzelman Road's contraflow lane uphill, Bunker Road's shoulders, Alexander Avenue's northbound shoulder, the bike
  // lanes of East Road, Center Road, Mitchell Road, Danes Drive and Bridgeway; else sharrows: near the right edge)
  { const lane = (q, fw) => q.r.fl & (fw ? 64 : 32) ? 'bike' : 'edge';
    const TABLE = [[/^(Conzelman Road|East Road|Center Road|Mitchell Road|Danes Drive|Bridgeway|Bunker Road|Alexander Avenue|McCullough Road|Field Road)$/, lane], [/Sidewalk/, 'right']];
    const by = {}, bad = [];
    for (const [name, la, lo, hd] of starts) for (const back of [0, 1]) {
      const c = courseOf(la, lo, (hd + 180 * back) % 360); if (!c) continue; const P = c.ll.map(p => xz(...p)), pr = profileOf(RI, P, c.ele);
      for (let i = 0; i < pr.ri.length; i++) {
        const q = RI.rails[pr.ri[i]], row = q && TABLE.find(([re]) => re.test(c.nm[i] || '')); if (!row || RI.narrows.some(([x, z]) => Math.hypot(P[i][0] - x, P[i][1] - z) < 25)) continue;
        const fw = pr.fw[i] > 0, want = typeof row[1] === 'function' ? row[1](q, fw) : row[1], st = roadStyle(q.r.hw, q.r.ln, q.r.fl, q.r.wd), half = st.w / 2, park = fw ? st.pR : st.pL, lane = pr.lane[i];
        if (!(q.r.fl & 16) && (isTrail(q.r) || /cycleway|pedestrian/.test(q.r.hw) || half < 2)) continue;  // (a path the course's name runs onto: its middle)
        const got = q.r.fl & 16 ? (lane > 0.3 ? 'right' : 'mid') : q.r.fl & (fw ? 64 : 32) && Math.abs(half - park - lane - 0.9) < 0.05 ? 'bike' : half - park - lane >= 0.5 && half - park - lane <= 1.5 ? 'edge' : 'off';
        const b = by[c.nm[i]] ??= { n: 0, bad: 0, bike: 0, up: 0, upBike: 0 }; b.n++; if (got === 'bike') b.bike++; if (q.r.fl & 4096 && !fw) { b.up++; if (got === 'bike') b.upBike++; } if (got !== want) { b.bad++; if (bad.length < 12) bad.push([c.nm[i], name + (back ? 'Back' : ''), i, want, got, ...c.ll[i].map(v => +v.toFixed(5))]); }
      }
    }
    out.riderTable = { by, bad }; }
  // the hand list's lane markings (A6): every entry on a rail at its length; the kinds found where Street View has them
  { const HM = handBarriers(RI, MARKINGS, [], xz), want = MARKINGS.reduce((a, e) => a + e[5] - e[4], 0), got = HM.pieces.reduce((a, p) => a + p.s1 - p.s0, 0);
    const at = (la, lo, hd) => { const [x, z] = xz(la, lo), r = hd * Math.PI / 180; return HM.across(x, z, Math.sin(r), -Math.cos(r)).map(([k, sd]) => k === 'pass' || k === 'stalls' ? k + (sd > 0 ? 'R' : 'L') : k).sort(); };
    out.marks = { n: MARKINGS.length, pieces: HM.pieces.length, want: r3(want), got: r3(got), bunkerDash: at(37.832461, -122.510236, 65), bunkerPass: at(37.833229, -122.508168, 65), bunkerPassBack: at(37.833229, -122.508168, 245),
      cronkhite: at(37.833930, -122.533105, 122), conzTop: at(37.833236, -122.492124, 144), conzMid: at(37.832673, -122.489632, 66), center: at(37.834933, -122.477937, 206), hawk: at(37.826250, -122.499000, 250) }; }
  // both ways along one road: the rider on the other side of its centre, at the same height
  { const c = courseOf(37.83300, -122.48341, 190), P = c.ll.map(p => xz(...p)), fwd = ride(c), rev = ride({ ll: c.ll.slice().reverse(), ele: c.ele.slice().reverse() }), L = (P.length - 1) * 10;
    let dh = 0, sides = 0, n2 = 0;
    for (let d = 20; d < L - 20; d += 10) {
      const a = fwd.rows[Math.round(d * 3)], b = rev.rows[Math.round((L - d) * 3)]; if (!a?.rail || !b?.rail || a.y == null || b.y == null || a.rail !== b.rail) continue; n2++;
      dh = Math.max(dh, Math.abs(a.yp - b.yp));  // (the rail's height: the same whichever way)
      const pa = a.rail.T.at(a.x + a.rx * a.lane, a.z + a.rz * a.lane), pb = a.rail.T.at(b.x + b.rx * b.lane, b.z + b.rz * b.lane);
      if (a.lane < 0.5 || (Math.sign(pa.d) !== Math.sign(pb.d) && Math.abs(pa.d) > 0.4 && Math.abs(pb.d) > 0.4)) sides++;
    }
    out.bothWays = { n: n2, dh: r3(dh), sides }; }
  // the Golden Gate Bridge's sidewalks: every point of a ride along either outside the roadway's curb wall (10.15 m from
  // the centre line, marin.js), on the sidewalk (to the outer railing; round the tower legs out to 23.6 m)
  { const res = {};
    for (const [nm, la, lo, hd] of [['east', 37.8245, -122.4790, 175], ['west', 37.8245, -122.4797, 355]]) {
      const c = courseOf(la, lo, hd), rows = ride(c).rows; let inRoad = 0, off = 0, n3 = 0;
      for (const r of rows) {
        const px = r.x + r.rx * r.lane, pz = r.z + r.rz * r.lane, la2 = proj.lat(pz), lo2 = proj.lon(px), [s] = toST(la2, lo2), dk = onDeck(la2, lo2); if (!dk || s < -1130 || s > 1220) continue; n3++;
        const t = Math.abs(dk.t), tw = Math.abs(Math.abs(s) - GGB.towers) < 22; if (t < GGB.curb + GGB.wall) inRoad++; else if (t > (tw ? 23.6 : GGB.curb + GGB.wall + GGB.walk)) off++;
      }
      res[nm] = { n: n3, inRoad, off, road: c.nm.find(x => /Sidewalk/.test(x)) || c.nm[0] };
    }
    out.ggbWalks = res; }
}

console.log(JSON.stringify(out));
