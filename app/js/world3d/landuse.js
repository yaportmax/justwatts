// World 3D ground data: landuse, nature, water and buildings from OpenStreetMap (Overpass), parsed to small
// features { id, k: class, rings: [[[lat, lon], ...], ...] (outer and inner rings, even-odd), h: building height }.
// The same compact form is baked into the app (tools/bake_world.mjs) and cached per cell. Pure: no DOM, no network.
// tests/test_world3d.py.

// ground classes; a later class wins where polygons overlap (a wood inside a park is a wood)
export const KINDS = ['park', 'grass', 'farm', 'urban', 'scrub', 'wood', 'rock', 'sand', 'water', 'building'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
export const PRIORITY = Object.fromEntries(KINDS.map((k, i) => [k, i]));

const LANDUSE = { forest: 'wood', grass: 'grass', meadow: 'grass', recreation_ground: 'grass', village_green: 'grass', cemetery: 'grass',
  residential: 'urban', commercial: 'urban', retail: 'urban', industrial: 'urban', reservoir: 'water', basin: 'water',
  farmland: 'farm', orchard: 'farm', vineyard: 'farm' };
const NATURAL = { wood: 'wood', scrub: 'scrub', heath: 'scrub', grassland: 'grass', beach: 'sand', sand: 'sand', water: 'water',
  bare_rock: 'rock', scree: 'rock' };
const LEISURE = { park: 'park', golf_course: 'grass', garden: 'park' };

export function kindOf(t = {}) {
  if (t.building && t.building !== 'no') return 'building';
  return NATURAL[t.natural] || LANDUSE[t.landuse] || LEISURE[t.leisure] || null;
}
// metres tall: height, else levels, else a guess by type
export function buildingHeight(t = {}) {
  const h = parseFloat(String(t.height || '').replace(/[^\d.]/g, ''));
  if (h > 1 && h < 400) return Math.round(h);
  const l = parseFloat(t['building:levels']);
  if (l >= 1 && l < 120) return Math.round(l * 3.2 + 1.5);
  return { house: 6, detached: 6, residential: 7, garage: 3, shed: 3, garages: 3, roof: 4, apartments: 12, commercial: 9, retail: 6,
    industrial: 8, church: 12, hangar: 9 }[t.building] || 6;
}

const LU = Object.keys(LANDUSE).join('|'), NA = Object.keys(NATURAL).join('|'), LE = Object.keys(LEISURE).join('|');
// one Overpass query for a box [s, w, n, e]: buildings, landuse, nature, water
export function landuseQuery(box, timeout = 25) {
  const bb = box.join(',');
  const sel = `["landuse"~"^(${LU})$"](${bb});X["natural"~"^(${NA})$"](${bb});X["leisure"~"^(${LE})$"](${bb});`;
  return `[out:json][timeout:${timeout}];(way["building"](${bb});way${sel.replace(/X/g, 'way')}relation["type"="multipolygon"]${sel.replace(/X/g, 'relation["type"="multipolygon"]')});out geom qt;`;
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
// join open member ways into closed rings by their end points
export function joinRings(lines) {
  const left = lines.filter(l => l.length > 1).map(l => l.slice()), out = [];
  while (left.length) {
    let r = left.pop();
    for (let guard = 0; !same(r[0], r.at(-1)) && guard < 10000; guard++) {
      const i = left.findIndex(l => same(l[0], r.at(-1)) || same(l.at(-1), r.at(-1)));
      if (i < 0) break;
      const l = left.splice(i, 1)[0];
      r = r.concat((same(l[0], r.at(-1)) ? l : l.reverse()).slice(1));
    }
    if (r.length >= 4 && same(r[0], r.at(-1))) out.push(r);
  }
  return out;
}

const ll = g => [+g.lat.toFixed(6), +g.lon.toFixed(6)];
const okGeom = g => Array.isArray(g) && g.length > 1 && g.every(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
// Overpass JSON -> features
export function parseLanduse(j) {
  const out = [];
  for (const e of j?.elements || []) {
    const t = e.tags || {}, k = kindOf(t); if (!k) continue;
    let rings = [];
    if (e.type === 'way') {
      if (!okGeom(e.geometry)) continue;
      const r = e.geometry.map(ll); if (!same(r[0], r.at(-1)) || r.length < 4) continue;
      rings = [r];
    } else if (e.type === 'relation') {
      const lines = (e.members || []).filter(m => m.type === 'way' && okGeom(m.geometry) && (m.role === 'outer' || m.role === 'inner' || m.role === ''))
        .map(m => m.geometry.map(ll));
      rings = joinRings(lines);
    }
    if (!rings.length) continue;
    const f = { id: (e.src || (e.type === 'relation' ? 'r' : 'w')) + e.id, k, rings };
    if (k === 'building') f.h = buildingHeight(t);
    if (k === 'wood' && /^(needleleaved|broadleaved|mixed)$/.test(t.leaf_type || '')) f.lt = t.leaf_type[0];  // n, b, m
    out.push(f);
  }
  return out;
}

/* ---------- geometry helpers (lat/lon or local metres, any [x, y] pairs) ---------- */
export function ringArea(r) { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
// even-odd over all rings: holes cut out
export function inRings(rings, x, y) {
  let c = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
export function ringsBox(rings) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const r of rings) for (const p of r) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
  return [s, w, n, e];
}
// Douglas-Peucker on [lat, lon] with tol in metres (rings keep their closing point)
export function simplify(pts, tol) {
  if (pts.length < 5 || tol <= 0) return pts;
  const k = Math.cos(pts[0][0] * Math.PI / 180), M = 111195, keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const X = p => [p[1] * k * M, p[0] * M], P = pts.map(X), st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let best = -1, bd = 0;
    const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = L ? Math.abs((P[i][0] - ax) * dy - (P[i][1] - ay) * dx) / L : Math.hypot(P[i][0] - ax, P[i][1] - ay);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0 && bd > tol) { keep[best] = 1; st.push([a, best], [best, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : pts;
}

/* ---------- compact form (bake files and the cell cache): integers at 1e-5 degrees, delta coded ---------- */
const Q = 1e5;
export function encode(features) {
  return features.map(f => {
    const rs = f.rings.map(r => { let a = 0, b = 0; const o = []; for (const [la, lo] of r) { const x = Math.round(la * Q), y = Math.round(lo * Q); o.push(x - a, y - b); a = x; b = y; } return o; });
    return f.lt ? [K[f.k], rs, f.h || 0, f.lt] : f.h ? [K[f.k], rs, f.h] : [K[f.k], rs];
  });
}
export function decode(rows, prefix = 'b') {
  return rows.map(([k, rs, h, lt], i) => {
    const rings = rs.map(o => { const r = []; let a = 0, b = 0; for (let j = 0; j + 1 < o.length; j += 2) { a += o[j]; b += o[j + 1]; r.push([a / Q, b / Q]); } return r; });
    const f = { id: prefix + i, k: KINDS[k], rings }; if (h) f.h = h; if (lt) f.lt = lt; return f;
  });
}

/* ---------- a spatial index by cell (roads.js cells, 0.01 degrees) ---------- */
export const CELL = 0.01;
export function cellIndex(features) {
  const idx = new Map();
  features.forEach((f, i) => {
    const [s, w, n, e] = ringsBox(f.rings);
    for (let a = Math.floor(s / CELL); a <= Math.floor(n / CELL); a++) for (let b = Math.floor(w / CELL); b <= Math.floor(e / CELL); b++) {
      const key = `${a}_${b}`; let l = idx.get(key); if (!l) idx.set(key, l = []); l.push(i);
    }
  });
  return idx;
}

/* ---------- scatter: deterministic points inside polygons (trees, bushes) ---------- */
export function hash2(x, y) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
// points on a jittered grid of `step` metres inside rings given in local metres [x, z]; density 0..1 keeps that share
export function scatter(rings, step, density = 1, box = null) {
  const out = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rings) for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  if (box) { x0 = Math.max(x0, box[0]); z0 = Math.max(z0, box[1]); x1 = Math.min(x1, box[2]); z1 = Math.min(z1, box[3]); }
  if (!(x1 > x0 && z1 > z0) || (x1 - x0) * (z1 - z0) / (step * step) > 400000) return out;
  for (let i = Math.floor(x0 / step); i * step <= x1; i++) for (let j = Math.floor(z0 / step); j * step <= z1; j++) {
    if (hash2(i, j * 7 + 3) > density) continue;
    const x = (i + hash2(i, j)) * step, z = (j + hash2(j + 11, i)) * step;
    if (box && (x < box[0] || z < box[1] || x >= box[2] || z >= box[3])) continue;
    if (inRings(rings, x, z)) out.push([x, z, hash2(i * 3 + 1, j * 5 + 2)]);
  }
  return out;
}

// a ring [[lat, lon], ...] clipped to a box [s, w, n, e] (Sutherland-Hodgman; closed again), null when nothing is left
export function clipRing(ring, [s, w, n, e]) {
  let pts = ring.slice(0, -1);
  const edges = [[p => p[0] >= s, (a, b) => cut(a, b, 0, s)], [p => p[0] <= n, (a, b) => cut(a, b, 0, n)],
    [p => p[1] >= w, (a, b) => cut(a, b, 1, w)], [p => p[1] <= e, (a, b) => cut(a, b, 1, e)]];
  function cut(a, b, k, v) { const t = (v - a[k]) / (b[k] - a[k]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  for (const [ins, at] of edges) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (ins(a)) { out.push(a); if (!ins(b)) out.push(at(a, b)); } else if (ins(b)) out.push(at(a, b));
    }
    pts = out; if (pts.length < 3) return null;
  }
  return [...pts, pts[0]].map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]);
}

/* ---------- roads for the 3D view (every way with a highway tag, also those no route takes) ---------- */
export const HW = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link',
  'tertiary_link', 'unclassified', 'residential', 'road', 'living_street', 'service', 'cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track'];
// flags: 1 bridge, 2 tunnel, 4 unpaved, 8 oneway, 16 the Golden Gate Bridge (drawn by its own model), 32/64 a bike lane
// on the left/right (as the way runs), 128/256 a parking lane left/right, 512 no lane markings, 1024/2048 a sidewalk
// left/right, 4096 the left bike lane runs against the oneway. ln: lanes (0..15) and the tagged width in decimetres
// (wd, x 16)
export function encodeRoads(roads) {
  return roads.map(r => {
    const o = [HW.indexOf(r.hw), r.fl | 0, (r.ln | 0) + 16 * Math.round((r.wd || 0) * 10), r.dk ? Math.round(r.dk[0] * 10) : 0, r.dk ? Math.round(r.dk[1] * 10) : 0];
    let a = 0, b = 0; for (const [la, lo] of r.pts) { const x = Math.round(la * Q), y = Math.round(lo * Q); o.push(x - a, y - b); a = x; b = y; }
    return o;
  });
}
export function decodeRoads(rows) {
  return rows.map(o => {
    const pts = []; let a = 0, b = 0; for (let j = 5; j + 1 < o.length; j += 2) { a += o[j]; b += o[j + 1]; pts.push([a / Q, b / Q]); }
    const r = { hw: HW[o[0]] || 'road', fl: o[1], ln: o[2] & 15, wd: (o[2] >> 4) / 10, pts };
    if (o[1] & 1) r.dk = [o[3] / 10, o[4] / 10];
    return r;
  });
}
