// The 3D world's pure parts (app/js/world3d): terrain grids from a synthetic Terrarium tile, the carve, ground classes,
// road ribbons, landuse parsing and the compact forms, streaming bookkeeping, the baked tile format, the leg solver,
// the view choice and the WebGL fallback, the open world's edge. stdout: JSON report for tests/test_world3d.py.
import { heightsOf, makeSampler, makeGrid, gridHeight, carve, rasterClasses, gridMesh, gridFromHeights, upsample, gridNormals, gridCurvature, classMasks } from '../../app/js/world3d/terrain.js';
import { cellPoints, cellsAround, clumpGeometry } from '../../app/js/world3d/grass.js';
import { skyRadiance, sunTint } from '../../app/js/world3d/skymath.js';
import { noisePixels, wavePixels, coverageMips } from '../../app/js/world3d/texgen.js';
import { windGain, tireGain, tireHz, tickRate, oceanGain } from '../../app/js/world3d/audio.js';
import { passPlan, carStep } from '../../app/js/world3d/life.js';
import { builder, ribbon, resample, roadStyle, clipLine, deckSides, chainWays, roundCorners } from '../../app/js/world3d/ribbon.js';
import { parseLanduse, encode, decode, clipRing, encodeRoads, decodeRoads, scatter, buildingHeight, inRings } from '../../app/js/world3d/landuse.js';
import { wanted, plan, jobQueue, childrenOf, parentOf } from '../../app/js/world3d/stream.js';
import { packTile, unpackTile, gridAt } from '../../app/js/world3d/baked.js';
import { makeProj, tileX, tileY, latOf, lonOf } from '../../app/js/world3d/geo.js';
import { knee, BIKE, stance, newStance, ik } from '../../app/js/world3d/rider.js';
import { probeWebGL2, resetProbe, pickView } from '../../app/js/world3d/probe.js';
import { RoadGraph, Plan } from '../../app/js/roads.js';
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
out.carve = { on: r3(on), rawOn: r3(raw[jm * 17 + 4]), off: r3(off), rawOff: r3(raw[4]), bridgeTouched: carve(makeGrid({ z: Z, x: X, y: Y, segs: 16, sample: S, proj }), [[g.xs[0], zMid, 600], [g.xs[16], zMid, 600]], 12, 40) };
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
out.styles = Object.fromEntries([['tertiary', 0, 0], ['primary', 4, 0], ['trunk', 2, 8], ['motorway', 4, 8], ['residential', 0, 0], ['path', 0, 0], ['tertiary', 0, 4]]
  .map(([hw, ln, fl]) => [`${hw}/${ln}/${fl}`, roadStyle(hw, ln, fl)]));
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
out.roadsRT = decodeRoads(encodeRoads([{ hw: 'tertiary', fl: 9, ln: 2, dk: [61.25, 70.5], pts: [[37.9, -122.6], [37.90012, -122.60034]] }]));
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
const ways = [mk(1, [1, 2], [[edge, -122.70], [edge, -122.699]]), mk(2, [2, 3], [[edge, -122.699], [N + 0.002, -122.699]], 'primary'), mk(3, [2, 4], [[edge, -122.699], [edge - 0.0004, -122.698]], 'residential')];
const g0 = new RoadGraph(), gIn = new RoadGraph({ inside: inWorld });
for (const gg of [g0, gIn]) gg.addCell('x', ways), gg.complete = () => true;
const pl = gr => { const p = Plan.at(gr, gr.snap(edge, -122.6995, 90)); p.extend(300, 6); return p.seq.map(s => s.id); };
out.edge = { opts: g0.options(1, 2).map(e => e.to), optsIn: gIn.options(1, 2).map(e => e.to), plan: pl(g0), planIn: pl(gIn), inside: inWorld(37.9, -122.6), outside: inWorld(38.2, -122.6), bridge: inWorld(37.79, -122.476) };

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
console.log(JSON.stringify(out));
