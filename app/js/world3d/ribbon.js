// World 3D roads: ribbon geometry along a way in local metres, on the ground (each edge on the terrain) or on a
// bridge deck (a straight line between the deck's ends), with the marking style the road shader draws (edge lines,
// centre lines). Pure: no three.js. tests/test_world3d.py.

// width in metres (when the lanes are not tagged), marking: 0 none, 1 edge lines, 2 edge lines + double yellow centre
// line (+ dashed lane lines), 3 a oneway: edge lines + dashed lane lines; surface: 0 asphalt, 1 bike path, 2 dirt
const STYLE = {
  motorway: [11, 3, 0], motorway_link: [5, 1, 0], trunk: [13, 2, 0], primary: [10, 2, 0], secondary: [8.5, 2, 0], tertiary: [7.5, 2, 0],
  trunk_link: [5.5, 1, 0], primary_link: [5.5, 1, 0], secondary_link: [5.5, 1, 0], tertiary_link: [5.5, 1, 0],
  unclassified: [6.5, 2, 0], residential: [6.5, 0, 0], road: [6, 0, 0], living_street: [5, 0, 0], service: [3.8, 0, 0],
  cycleway: [3, 0, 1], path: [1.6, 0, 2], footway: [1.8, 0, 2], pedestrian: [3, 0, 1], bridleway: [1.8, 0, 2], track: [2.8, 0, 2],
};
// US widths (Street View and the aerial imagery: lower Conzelman's three parts about 8.5 m): a travel lane 3.6 m, a bike
// lane 1.8 m, a parking lane 2.8 m; the buffer between a lane and a bike lane against it (upper Conzelman Road: two
// yellow lines and ticks across, USDA NAIP and Street View about 0.9 m) stands in YB of its own
const LANE_W = 3.6, BIKE_W = 1.8, PARK_W = 2.8;
export const YB = 0.9;
// Style of a way { hw, ln: lanes, fl: flags (landuse.js: 4 unpaved, 8 oneway, 32/64 a bike lane left/right, 128/256 a
// parking lane left/right, 512 no lane markings, 4096 the left bike lane against the oneway), wd: its tagged width (m) }:
// { w, lm, surf, lanes, a, b, pL, pR }. Across the road from its right edge (as the way runs): parking, bike lane, the
// travel lanes, bike lane, parking; a and b how far in from the right and the left edge the travel lanes start, pR and
// pL the parking lanes' widths (0: none). lm: 0 none, 1 edge lines, 2 two-way (double yellow centre line), 3 oneway
// (yellow left edge, dashed lane lines), 4 oneway with a bike lane against it on the left (double yellow beside it).
export function roadStyle(hw, ln = 0, fl = 0, wd = 0) {
  const s = STYLE[hw] || STYLE.road, one = !!(fl & 8), surf = fl & 4 && s[2] === 0 ? 2 : s[2];
  let lm = surf || fl & 512 ? (surf ? 0 : 1) : s[1];
  if (one && lm >= 2) lm = 3; else if (lm === 3) lm = 2;
  let lanes = ln || (lm === 2 ? 2 : lm === 3 ? (s[0] > 9 ? 2 : 1) : 0);
  if (lm === 2 && lanes < 2) lanes = 2;
  if (lm === 3 && fl & 4096 && fl & 32) lm = 4;
  const sh = s[0] >= 8.5 ? 0.8 : 0.4, pR = fl & 256 ? PARK_W : 0, pL = fl & 128 ? PARK_W : 0, bR = fl & 64 ? BIKE_W : 0, bL = fl & 32 ? BIKE_W : 0;
  let w = lanes && lm ? lanes * LANE_W + 2 * sh : s[0], a = 0, b = 0;
  if (lm && (pR || pL || bR || bL)) { a = pR + bR + (pR || bR ? 0 : sh); b = pL + bL + (pL || bL ? 0 : sh) + (lm === 4 ? YB : 0); w = lanes * LANE_W + a + b; }
  if (wd >= 3 && wd < 30 && lm) { const k = wd / w; w = wd; a *= k; b *= k; }  // the tagged width wins, the parts in proportion
  return { w, lm, surf, lanes, a, b, pL, pR };
}
// The hand list's lane markings (handlist.js MARKINGS) as the road shader reads them, per vertex [centre, bits]: centre
// 0 as the style has it, 1 none, 2 a single broken yellow, 3 solid and broken with the broken line on the right (as the
// ribbon runs), 4 on the left, 5 double white, 6 yellow raised markers; bits 1 no edge lines, 2 no bike symbols, 4 BIKE
// LANE in words, 8 ticks across the contraflow buffer, 16 that buffer cross hatched, 32 / 64 stall ticks in the
// right / left parking lane (no buffer before it)
export function markCode(kinds) {
  let c = 0, b = 0;
  for (const [k, sd] of kinds) {
    if (k === 'nocentre') c = 1; else if (k === 'dash') c = 2; else if (k === 'pass') c = sd > 0 ? 3 : 4; else if (k === 'white2') c = 5; else if (k === 'dots') c = 6;
    else b |= { noedge: 1, nosym: 2, words: 4, ladder: 8, hatch: 16 }[k] || (k === 'stalls' ? (sd > 0 ? 32 : 64) : 0);
  }
  return [c, b];
}
// the order roads draw in where they overlap (bigger roads on top)
export const roadLift = hw => 0.22 + 0.02 * Math.min(4, ['service', 'residential', 'unclassified', 'tertiary', 'secondary'].indexOf(hw) + 1 || (STYLE[hw]?.[0] > 9 ? 5 : 0));

// points [[x, z], ...] with none further apart than `step` metres
export function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.ceil(L / step);
    if (L < 0.05) continue;
    for (let j = 1; j <= k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  return out;
}

// A growing geometry: positions, uvs (u across 0..1 from the right edge, v metres along), per vertex the road
// [marking, surface, lanes, width], its parts across [a, b, pL, pR] (roadStyle) the shader draws (marking -1: a
// bridge's side) and the hand list's markings there [centre, bits, 0, 0] (MARK). u is kept as metres from the right edge (u times the width): where the width changes along a road (a
// taper) a quad is a trapezoid, and a fraction across it does not interpolate straight over its two triangles (the lines
// zigzagged at each diagonal); metres from either edge do
export function builder() {
  const pos = [], uv = [], code = [], code2 = [], code3 = [], idx = [];
  return {
    pos, uv, code, idx,
    get n() { return pos.length / 3; },
    v(x, y, z, u, w, c) { pos.push(x, y, z); uv.push(u * c[3], w); code.push(c[0], c[1], c[2], c[3]); code2.push(c[4] || 0, c[5] || 0, c[6] || 0, c[7] || 0); code3.push(c[8] || 0, c[9] || 0, 0, 0); return pos.length / 3 - 1; },
    tri(a, b, c) { idx.push(a, b, c); },
    done() { return { pos: new Float32Array(pos), uv: new Float32Array(uv), code: new Float32Array(code), code2: new Float32Array(code2), code3: new Float32Array(code3), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) }; },
  };
}

// The width at (x, z) of a road `w` wide that eases to the joint's width within TAPER metres of each joint [[x, z,
// width], ...] (tapers): no step where two ways of different layouts meet
export const TAPER = 25;
// (several joints within reach blend by weights that sum to one: each joint's 1 - S times the others' S, the road's own
// the product of every S (S the smoothstep of the distance over TAPER): at a joint its value exactly, a second joint
// within TAPER never moves it, continuous between them (A13: one after the other had stepped the width at short ways))
function blend(own, joints, x, z, val) {
  const J = []; for (const j of joints || []) { const v = val(j); if (v == null) continue; const d = Math.hypot(x - j[0], z - j[1]); if (d < TAPER) { const f = d / TAPER; J.push([f * f * (3 - 2 * f), v]); } }
  if (!J.length) return null;
  const all = J.reduce((p, [S]) => p * S, 1); let sw = all, acc = own.map(v => v * all);
  J.forEach(([S, v], i) => { const g = (1 - S) * J.reduce((p, [T], k) => k === i ? p : p * T, 1); sw += g; acc = acc.map((a, k) => a + g * v[k]); });
  return acc.map(a => a / sw);
}
export function taperedWidth(w, joints, x, z) { return blend([w], joints, x, z, j => j[2] == null ? null : [j[2]])?.[0] ?? w; }
// The parts across a road [a, b, pL, pR] (roadStyle) at (x, z), each easing to the joint's (its sixth entry, tapers)
// within TAPER metres of it, as the width does: the lines between them run on across the joint (A13: upper Conzelman's
// ways with and without the parking lane, one lane or two, the contraflow buffer's yellow lines had stepped sideways up
// to 1.2 m at each joint, the flexible posts off it), or null where no joint near has parts
export function taperedParts(ins, joints, x, z) { return blend(ins, joints, x, z, j => j[5] || null); }
// Where two ways meet end to end (OpenStreetMap splits a road where its tags change): per road index its joints [[x, z,
// width, tx, tz], ...]. width: where theirs are more than 0.3 m apart, halfway between the two (the other's own where that
// one is rigid(road): a bridge or a tunnel drawn at its own width), else null (no taper); (tx, tz): the two ways' mean
// direction there (unit, either sense), both ribbons' ends cut square to it (one line: no wedge of ground between two ends
// meeting at an angle, nor an overlap). At a node where a third way meets (a side road, a slip road), the two that run on
// most nearly straight through it (within 40 degrees) are the joint (Street View East Road 0a_0130: East Road wider with
// its bike lanes south of the slip road's node, a step and a green wedge across the lane were drawn there). pts in
// [lat, lon], xz(lat, lon) to local metres; ok(road): a road that takes part. parts(road): its [a, b, pL, pR] (roadStyle,
// as the way runs): where the two differ the joint has their mean as a sixth entry (in that road's own sense; a way
// meeting it head on has its right and left swapped) and a width even where the two are within 0.3 m (taperedParts).
export function tapers(roads, { width, parts = null, rigid = () => false, ok = () => true, xz }) {
  const k = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`, ends = new Map(), out = new Map();
  roads.forEach((r, i) => { if (r.pts.length < 2 || !ok(r)) return; for (const e of [0, 1]) { const q = k(e ? r.pts.at(-1) : r.pts[0]); (ends.get(q) ?? ends.set(q, []).get(q)).push([i, e]); } });
  // (a way's direction out of the node, over its first 6 m)
  const out1 = (i, e) => { const P = roads[i].pts.map(p => xz(...p)), Q = e ? P.slice().reverse() : P, o = Q[0]; let q = Q[1];
    for (let m = 1; m < Q.length; m++) { q = Q[m]; if (Math.hypot(q[0] - o[0], q[1] - o[1]) >= 6) break; }
    const l = Math.hypot(q[0] - o[0], q[1] - o[1]) || 1; return [(q[0] - o[0]) / l, (q[1] - o[1]) / l]; };
  for (const at of ends.values()) {
    if (at.length < 2) continue;
    let pair = null;
    if (at.length === 2) { if (at[0][0] !== at[1][0]) pair = at; }
    else { let best = -0.766; for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) { if (at[a][0] === at[b][0]) continue; const u = out1(...at[a]), v = out1(...at[b]), d = u[0] * v[0] + u[1] * v[1]; if (d < best) { best = d; pair = [at[a], at[b]]; } } }
    if (!pair) continue;
    const [[i, e], [j, f]] = pair, wa = width(roads[i]), wb = width(roads[j]), ra = rigid(roads[i]), rb = rigid(roads[j]);
    if (ra && rb) continue;
    // (parts in road i's sense; road j's swapped side for side when the two run head to head or tail to tail)
    const sw = q => [q[1], q[0], q[3], q[2]], pa = parts?.(roads[i]), pb0 = parts?.(roads[j]), pb = pb0 && (e === f ? sw(pb0) : pb0);
    // (with parts, the width's change goes to the travel lanes: the parts eased to the joint's, never scaled with the width)
    // (a width at every joint, the same each side or not: a joint's own width holds there against another within TAPER)
    const wj = ra ? wa : rb ? wb : (wa + wb) / 2, [x, z] = xz(...(e ? roads[i].pts.at(-1) : roads[i].pts[0]));
    const pj = pa && pb ? (ra ? pa : rb ? pb : pa.map((v, k) => (v + pb[k]) / 2)) : null;
    const u = out1(i, e), v = out1(j, f); let tx = u[0] - v[0], tz = u[1] - v[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    for (const [n, rg] of [[i, ra], [j, rb]]) if (!rg) (out.get(n) ?? out.set(n, []).get(n)).push([x, z, wj, tx, tz, pj && (n === j && e === f ? sw(pj) : pj)]);
  }
  return out;
}

// Add one ribbon to builder B. pts: [[x, z], ...]; hAt(x, z): ground height (null: unknown, the last known is kept);
// deck: [h0, h1] the heights at the two ends (a bridge), else the ground under each edge; joints: where it eases to
// another way's width (tapers); drape: the edges on the ground however steep it is across (a trail on a hillside).
// Returns the centre line [[x, y, z, half width, right edge x, y, z, left edge x, y, z, b (the left part's width as
// drawn there)], ...] (for pillars, arrows, the road sides: banks.js; the flexible posts on a buffer).
// mk(x, z, tx, tz): the hand list's markings at a centre point, the way running (tx, tz): [centre, bits] (MARK).
// rail(x, z): the road's own rail (rail.js) at a point, its centre's height (before a deck's line; null: not on it): the
// centre on it and the road flat across (the rider at any lane offset on the drawn top), a trail's edges still draped.
export function ribbon(B, pts, { w, lm = 0, surf = 0, lanes = 0, a = 0, b = 0, pL = 0, pR = 0, hAt, lift = 0.25, deck = null, step = 5, v0 = 0, joints = null, drape = false, rail = null, mk = null, flares = null }) {
  let P = resample(pts, step);
  // (flares [[x, z, R], ...]: a side road's mouth, its corners rounded R metres: the width there 2 R more, a quarter
  // circle each side out to R along it; a point every 0.75 m within its reach)
  if (flares?.length) { const by = q => flares.some(([x, z, R]) => Math.hypot(q[0] - x, q[1] - z) < R + step); P = P.flatMap((p, i) => !i || !(by(P[i - 1]) || by(p)) ? [p] : resample([P[i - 1], p], 0.75).slice(1)); }
  // (within a taper's reach of a joint a point every 1.5 m: the edges follow the width's curve, not a corner every step)
  if (joints?.some(j => j[2] != null)) { const by = q => joints.some(([x, z, wj]) => wj != null && Math.hypot(q[0] - x, q[1] - z) < TAPER + step); P = P.flatMap((p, i) => !i || !(by(P[i - 1]) || by(p)) ? [p] : resample([P[i - 1], p], 1.5).slice(1)); }
  const n = P.length; if (n < 2) return [];
  let code = [lm, surf, lanes, w, a, b, pL, pR];
  const L = [0]; for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const tot = L[n - 1] || 1, centre = [];
  let last = 0, base = B.n, half = w / 2;
  const ins = [a, b, pL, pR];
  for (let i = 0; i < n; i++) {
    if (joints?.length || flares?.length) { const wt = taperedWidth(w, joints, P[i][0], P[i][1]); let wi = wt; for (const [x, z, R] of flares || []) { const d = Math.hypot(P[i][0] - x, P[i][1] - z); if (d < R) wi += 2 * (R - Math.sqrt(R * R - (R - d) * (R - d))); }
      // (the parts eased to a joint's where it has them, else in proportion to the width; a side road's mouth widens them)
      const tp = taperedParts(ins, joints, P[i][0], P[i][1]), s = wi / (tp ? wt : w); half = wi / 2; code = [lm, surf, lanes, wi, ...(tp || ins).map(v => v * s)]; }
    // the join: the average of the two segments' normals, stretched to keep the width (capped at sharp turns)
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], c = P[i];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    // (an end at a joint: square to the two ways' mean direction there, the other way's end on the same line; stretched
    // to keep the width across the road)
    let k = 1;
    if ((i === 0 || i === n - 1) && joints?.length) for (const [x, z, , jx, jz] of joints) if (jx != null && Math.hypot(c[0] - x, c[1] - z) < 0.5) {
      const s = jx * tx + jz * tz >= 0 ? 1 : -1, d = Math.abs(jx * tx + jz * tz); if (d < 0.6) break;
      tx = jx * s; tz = jz * s; k = 1 / d; break;
    }
    if (i > 0 && i < n - 1) {
      const s1x = c[0] - a[0], s1z = c[1] - a[1], l1 = Math.hypot(s1x, s1z) || 1;
      k = 1 / Math.max(0.6, Math.abs((s1x * tx + s1z * tz) / l1));
    }
    const nx = -tz * half * k, nz = tx * half * k;  // to the right of travel (u = 0)
    let hl, hr, hc;
    if (rail && (hc = rail(c[0], c[1])) != null) {
      if (drape) { hl = hAt(c[0] + nx, c[1] + nz) ?? hc; hr = hAt(c[0] - nx, c[1] - nz) ?? hc; } else hl = hr = hc;
    } else if (deck) { hc = deck[0] + (deck[1] - deck[0]) * L[i] / tot; hl = hr = hc; }
    else {
      hc = hAt(c[0], c[1]); hl = hAt(c[0] + nx, c[1] + nz); hr = hAt(c[0] - nx, c[1] - nz);
      if (hc == null) hc = last; if (hl == null) hl = hc; if (hr == null) hr = hc;
      // a road's crossfall: the edges within a few per cent of the centre (a steep bank beside it never tips the edge up)
      const cf = drape ? Infinity : Math.max(0.25, half * 0.07); hl = Math.max(hc - cf, Math.min(hc + cf, hl)); hr = Math.max(hc - cf, Math.min(hc + cf, hr));
    }
    last = hc;
    if (mk) { const m = mk(c[0], c[1], tx, tz); code = code.slice(0, 8); code.push(m[0], m[1]); }
    B.v(c[0] + nx, hl + lift, c[1] + nz, 0, v0 + L[i], code);
    B.v(c[0] - nx, hr + lift, c[1] - nz, 1, v0 + L[i], code);
    centre.push([c[0], hc + lift, c[1], half, c[0] + nx, hl + lift, c[1] + nz, c[0] - nx, hr + lift, c[1] - nz, code[5]]);
    if (i) { const p = base + 2 * (i - 1), q = base + 2 * i; B.tri(p, q, p + 1); B.tri(p + 1, q, q + 1); }  // facing up
  }
  return centre;
}

// a bridge deck's sides: a band `depth` metres deep under each edge, and pillars every `gap` metres where the ground
// is more than 3 m below. Returns the pillars [[x, z, top, bottom], ...].
export function deckSides(B, centre, w, depth, hAt, gap = 36) {
  const pillars = [];
  for (let i = 1; i < centre.length; i++) {
    const a = centre[i - 1], b = centre[i], dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
    for (const s of [1, -1]) {
      const p = B.n, A = [a[0] + nx * s, a[2] + nz * s], C = [b[0] + nx * s, b[2] + nz * s];
      const k = [-1, 0, 0, w]; B.v(A[0], a[1], A[1], 0.5, 0, k); B.v(C[0], b[1], C[1], 0.5, 0, k); B.v(A[0], a[1] - depth, A[1], 0.5, 0, k); B.v(C[0], b[1] - depth, C[1], 0.5, 0, k);
      B.tri(p, p + 2, p + 1); B.tri(p + 1, p + 2, p + 3);
    }
  }
  let run = 0;
  for (let i = 1; i < centre.length; i++) {
    const a = centre[i - 1], b = centre[i]; run += Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (run < gap || i === centre.length - 1) continue;
    run = 0;
    const g = hAt(b[0], b[2]);
    if (g != null && b[1] - depth - g > 3) pillars.push([b[0], b[2], b[1] - depth, Math.max(g - 2, -30)]);
  }
  return pillars;
}

// Clip a polyline to a box [x0, z0, x1, z1]: the runs inside (a run crossing the box edge is cut at the edge)
export function clipLine(pts, [x0, z0, x1, z1]) {
  const runs = []; let cur = null;
  const inside = p => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    // Liang-Barsky
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dz = b[1] - a[1];
    const ok = [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dz, a[1] - z0], [dz, z1 - a[1]]].every(([p, q]) => {
      if (p === 0) return q >= 0;
      const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    });
    if (!ok) { cur = null; continue; }
    const A = t0 > 0 ? [a[0] + dx * t0, a[1] + dz * t0] : a, Bp = t1 < 1 ? [a[0] + dx * t1, a[1] + dz * t1] : b;
    if (!cur || t0 > 0) { cur = [A]; runs.push(cur); }
    cur.push(Bp);
    if (t1 < 1) cur = null;
  }
  return runs.filter(r => r.length > 1 && (r.length > 2 || Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]) > 0.5 || inside(r[0])));
}

// Join ways that go on as one road: where exactly two ends meet and both ways have the same key (class, lanes,
// flags), one polyline through the joint (no seam, the markings run on). roads: [{ pts: [[lat, lon], ...], ... }];
// keyOf(road): their key, null to leave a way alone. -> new list (joined ways take the first one's fields)
export function chainWays(roads, keyOf) {
  const k = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`, ends = new Map(), used = new Set(), out = [];
  roads.forEach((r, i) => { if (keyOf(r) == null || r.pts.length < 2) return; for (const e of [0, 1]) { const q = k(e ? r.pts.at(-1) : r.pts[0]); (ends.get(q) ?? ends.set(q, []).get(q)).push([i, e]); } });
  // a way that would join back to front (its left and right, its oneway, swapped) does not join one with sides
  const sided = r => (r.fl | 0) & (8 | 32 | 64 | 128 | 256 | 4096);
  const next = (i, p, e) => { const at = ends.get(k(p)); if (!at || at.length !== 2) return null; const o = at.find(([j]) => j !== i); return o && !used.has(o[0]) && keyOf(roads[o[0]]) === keyOf(roads[i]) && (o[1] === e || !sided(roads[i])) ? o : null; };
  roads.forEach((r, i) => {
    if (used.has(i)) return; used.add(i);
    if (keyOf(r) == null) { out.push(r); return; }
    // (their rails, rail.js, joined the same way: a rail's dense points split each segment on its own)
    let pts = r.pts.slice(), h = r.h ? Array.from(r.h) : null;
    const rev = (q, o) => o ? q.slice().reverse() : q, hOf = j => roads[j].h ? Array.from(roads[j].h) : null;
    for (let o; (o = next(i, pts.at(-1), 0));) { used.add(o[0]); const q = roads[o[0]].pts, qh = hOf(o[0]); pts = pts.concat(rev(q, o[1]).slice(1)); h = h && qh ? h.concat(rev(qh, o[1]).slice(1)) : null; }
    for (let o; (o = next(i, pts[0], 1));) { used.add(o[0]); const q = roads[o[0]].pts, qh = hOf(o[0]); pts = rev(q, !o[1]).slice(0, -1).concat(pts); h = h && qh ? rev(qh, !o[1]).slice(0, -1).concat(h) : null; }
    out.push({ ...r, pts, h: h && Float32Array.from(h) });
  });
  return out;
}
// Round a polyline's corners (local metres [[x, z], ...]): each corner becomes a curve that strays at most `dmax`
// from it, cut back no more than half a segment; the ends stay
export function roundCorners(pts, dmax = 0.35, step = 1.5) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1], l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], v = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2], th = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    if (th < 0.02) { out.push(b); continue; }
    // a quadratic curve from b - u * cut to b + v * cut strays cut * sin(th / 2) / 2 from the corner
    const cut = Math.min(l1 / 2, l2 / 2, 2 * dmax / Math.sin(th / 2)), p0 = [b[0] - u[0] * cut, b[1] - u[1] * cut], p2 = [b[0] + v[0] * cut, b[1] + v[1] * cut];
    const n = Math.max(2, Math.ceil(cut * th / step) + 1);
    for (let s = 0; s <= n; s++) { const t = s / n, m = 1 - t; out.push([m * m * p0[0] + 2 * m * t * b[0] + t * t * p2[0], m * m * p0[1] + 2 * m * t * b[1] + t * t * p2[1]]); }
  }
  out.push(pts.at(-1));
  return out;
}
