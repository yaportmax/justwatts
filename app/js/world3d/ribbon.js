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
const LANE_W = 3.4, BIKE_W = 1.6, PARK_W = 2.4;
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
  if (lm && (pR || pL || bR || bL)) { a = pR + bR + (pR || bR ? 0 : sh); b = pL + bL + (pL || bL ? 0 : sh); w = lanes * LANE_W + a + b; }
  if (wd >= 3 && wd < 30 && lm) { const k = wd / w; w = wd; a *= k; b *= k; }  // the tagged width wins, the parts in proportion
  return { w, lm, surf, lanes, a, b, pL, pR };
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
// [marking, surface, lanes, width] and its parts across [a, b, pL, pR] (roadStyle) the shader draws (marking -1: a
// bridge's side)
export function builder() {
  const pos = [], uv = [], code = [], code2 = [], idx = [];
  return {
    pos, uv, code, idx,
    get n() { return pos.length / 3; },
    v(x, y, z, u, w, c) { pos.push(x, y, z); uv.push(u, w); code.push(c[0], c[1], c[2], c[3]); code2.push(c[4] || 0, c[5] || 0, c[6] || 0, c[7] || 0); return pos.length / 3 - 1; },
    tri(a, b, c) { idx.push(a, b, c); },
    done() { return { pos: new Float32Array(pos), uv: new Float32Array(uv), code: new Float32Array(code), code2: new Float32Array(code2), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) }; },
  };
}

// The width at (x, z) of a road `w` wide that eases to the joint's width within TAPER metres of each joint [[x, z,
// width], ...] (tapers): no step where two ways of different layouts meet
export const TAPER = 25;
export function taperedWidth(w, joints, x, z) {
  for (const [jx, jz, wj] of joints || []) { const d = Math.hypot(x - jx, z - jz); if (d < TAPER) { const f = d / TAPER; w = wj + (w - wj) * f * f * (3 - 2 * f); } }
  return w;
}
// Where two ways meet end to end and only they (OpenStreetMap splits a road where its tags change) with widths
// width(road) more than 0.3 m apart: per road index its joints [[x, z, width], ...], the width there halfway between
// the two (the other's own where that one is rigid(road): a bridge or a tunnel drawn at its own width). pts in
// [lat, lon], xz(lat, lon) to local metres; ok(road): a road that takes part.
export function tapers(roads, { width, rigid = () => false, ok = () => true, xz }) {
  const k = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`, ends = new Map(), out = new Map();
  roads.forEach((r, i) => { if (r.pts.length < 2 || !ok(r)) return; for (const e of [0, 1]) { const q = k(e ? r.pts.at(-1) : r.pts[0]); (ends.get(q) ?? ends.set(q, []).get(q)).push([i, e]); } });
  for (const at of ends.values()) {
    if (at.length !== 2 || at[0][0] === at[1][0]) continue;
    const [[i, e], [j]] = at, wa = width(roads[i]), wb = width(roads[j]), ra = rigid(roads[i]), rb = rigid(roads[j]);
    if (Math.abs(wa - wb) < 0.3 || (ra && rb)) continue;
    const wj = ra ? wa : rb ? wb : (wa + wb) / 2, [x, z] = xz(...(e ? roads[i].pts.at(-1) : roads[i].pts[0]));
    for (const [n, rg] of [[i, ra], [j, rb]]) if (!rg) (out.get(n) ?? out.set(n, []).get(n)).push([x, z, wj]);
  }
  return out;
}

// Add one ribbon to builder B. pts: [[x, z], ...]; hAt(x, z): ground height (null: unknown, the last known is kept);
// deck: [h0, h1] the heights at the two ends (a bridge), else the ground under each edge; joints: where it eases to
// another way's width (tapers); drape: the edges on the ground however steep it is across (a trail on a hillside).
// Returns the centre line [[x, y, z, half width], ...] (for pillars, arrows, the rails).
export function ribbon(B, pts, { w, lm = 0, surf = 0, lanes = 0, a = 0, b = 0, pL = 0, pR = 0, hAt, lift = 0.25, deck = null, step = 5, v0 = 0, joints = null, drape = false }) {
  const P = resample(pts, step), n = P.length; if (n < 2) return [];
  let code = [lm, surf, lanes, w, a, b, pL, pR];
  const L = [0]; for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const tot = L[n - 1] || 1, centre = [];
  let last = 0, base = B.n, half = w / 2;
  const ins = [a, b, pL, pR];
  for (let i = 0; i < n; i++) {
    if (joints?.length) { const wi = taperedWidth(w, joints, P[i][0], P[i][1]), s = wi / w; half = wi / 2; code = [lm, surf, lanes, wi, ...ins.map(v => v * s)]; }
    // the join: the average of the two segments' normals, stretched to keep the width (capped at sharp turns)
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], c = P[i];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    let k = 1;
    if (i > 0 && i < n - 1) {
      const s1x = c[0] - a[0], s1z = c[1] - a[1], l1 = Math.hypot(s1x, s1z) || 1;
      k = 1 / Math.max(0.6, Math.abs((s1x * tx + s1z * tz) / l1));
    }
    const nx = -tz * half * k, nz = tx * half * k;  // to the right of travel (u = 0)
    let hl, hr, hc;
    if (deck) { hc = deck[0] + (deck[1] - deck[0]) * L[i] / tot; hl = hr = hc; }
    else {
      hc = hAt(c[0], c[1]); hl = hAt(c[0] + nx, c[1] + nz); hr = hAt(c[0] - nx, c[1] - nz);
      if (hc == null) hc = last; if (hl == null) hl = hc; if (hr == null) hr = hc;
      // a road's crossfall: the edges within a few per cent of the centre (a steep bank beside it never tips the edge up)
      const cf = drape ? Infinity : Math.max(0.25, half * 0.07); hl = Math.max(hc - cf, Math.min(hc + cf, hl)); hr = Math.max(hc - cf, Math.min(hc + cf, hr));
    }
    last = hc;
    B.v(c[0] + nx, hl + lift, c[1] + nz, 0, v0 + L[i], code);
    B.v(c[0] - nx, hr + lift, c[1] - nz, 1, v0 + L[i], code);
    centre.push([c[0], hc + lift, c[1], half]);
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
    let pts = r.pts.slice();
    for (let o; (o = next(i, pts.at(-1), 0));) { used.add(o[0]); const q = roads[o[0]].pts; pts = pts.concat((o[1] ? q.slice().reverse() : q).slice(1)); }
    for (let o; (o = next(i, pts[0], 1));) { used.add(o[0]); const q = roads[o[0]].pts; pts = (o[1] ? q : q.slice().reverse()).slice(0, -1).concat(pts); }
    out.push({ ...r, pts });
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
