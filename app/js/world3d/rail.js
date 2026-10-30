// World 3D rails: one height line per road along its centre, baked from the lidar (bake_world.mjs), the single source
// of a road's height. The rider reads only the rail (deck ?? profile(d)), the drawn road is laid on it, the ground is
// fitted to it; none of it depends on which tiles have loaded or the quality. A rail: the way's points split every
// RAIL_STEP metres or less (dense: the same split in the bake and here), a height at each. A lane is a signed offset
// from the rail, at the rail's height (the road flat across). Pure.
import { roadStyle, roadLift } from './ribbon.js';
import { decodeRoads } from './landuse.js';

export const RAIL_STEP = 5;
const M = 111195, R = Math.PI / 180;
// metres between two [lat, lon]
export const llDist = (a, b) => Math.hypot((b[0] - a[0]) * M, (b[1] - a[1]) * M * Math.cos((a[0] + b[0]) / 2 * R));
// a way's points with each segment split into equal parts of RAIL_STEP or less (its own points kept); with idx, the
// dense index of each original point
export function dense(pts, step = RAIL_STEP, idx = null) {
  const out = [pts[0]]; idx?.push(0);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], k = Math.max(1, Math.ceil(llDist(a, b) / step - 1e-9));
    for (let j = 1; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    out.push(b); idx?.push(out.length - 1);
  }
  return out;
}
// heights in centimetres, each the change from the one before (compact in JSON, small under gzip)
export const packH = h => { let a = 0; return Array.from(h, v => { const c = Math.round(v * 100), d = c - a; a = c; return d; }); };
export const unpackH = o => { const h = new Float32Array(o.length); let a = 0; for (let i = 0; i < o.length; i++) { a += o[i]; h[i] = a / 100; } return h; };
// eased along the rail ([1 2 1] / 4, `passes` times), the ends and pinned points (junctions: every road there meets at
// one height) kept
export function smoothRail(h, passes = 2, pin = null) {
  const out = Float64Array.from(h);
  for (let p = 0; p < passes; p++) { const prev = out.slice(); for (let i = 1; i + 1 < out.length; i++) if (!pin?.has(i)) out[i] = (prev[i - 1] + 2 * prev[i] + prev[i + 1]) / 4; }
  return out;
}

// A rail in local metres: P [[x, z], ...] with heights h. at(x, z, hint): the nearest point on it { h, d (signed: + to
// the right as it runs), s (metres along), k (segment) }; a hint (the last k) searches round it first.
export function track(P, h) {
  const D = [0]; for (let i = 1; i < P.length; i++) D.push(D[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const seg = (k, x, z) => {
    const a = P[k], b = P[k + 1], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)) : 0;
    const px = x - a[0] - ex * t, pz = z - a[1] - ez * t, d = Math.hypot(px, pz);
    return { d: ex * pz - ez * px < 0 ? -d : d, h: h[k] + (h[k + 1] - h[k]) * t, s: D[k] + (D[k + 1] - D[k]) * t, k, t };
  };
  // (the right of travel: x east, z south, so heading (ex, ez) has its right at (-ez, ex))
  function at(x, z, hint = -1) {
    if (P.length < 2) return P.length ? { d: Math.hypot(x - P[0][0], z - P[0][1]), h: h[0], s: 0, k: 0, t: 0 } : null;
    let best = null;
    const scan = (k0, k1) => { for (let k = Math.max(0, k0); k <= Math.min(P.length - 2, k1); k++) { const r = seg(k, x, z); if (!best || Math.abs(r.d) < Math.abs(best.d)) best = r; } };
    if (hint >= 0) { scan(hint - 6, hint + 6); if (best && best.k > Math.max(0, hint - 6) && best.k < Math.min(P.length - 2, hint + 6)) return best; best = null; }
    scan(0, P.length - 2);
    return best;
  }
  return { P, h, D, L: D.at(-1), at };
}

// a rail road's lift: the drawn road's top over its rail (roadLift, in a bore too; a trail 0.15; a paved path, the bridge's ways 0.05)
export const isTrail = r => !(r.fl & 1) && (roadStyle(r.hw, r.ln, r.fl, r.wd).surf === 2 || /path|footway|track|bridleway|steps/.test(r.hw));
export const railLift = r => r.fl & 16 || /cycleway|pedestrian|footway|path/.test(r.hw) ? 0.05 : isTrail(r) ? 0.15 : roadLift(r.hw);  // (a path under every road where they cross; on the bridge's sidewalks as on its deck, marin.js)  // (the Golden Gate Bridge's: as on its deck, marin.js)
// where a cyclist rides, in metres right of the rail as they go (fwd: along the way as it runs): in the middle of the
// bike lane on their right if there is one, else about a metre in from the right edge of their travel lane (from the
// paved edge, or the parking lane's inner side); on a path its middle
export const BIKE_LANE = 1.8;
export function laneOf(r, fwd = true) {
  const st = roadStyle(r.hw, r.ln, r.fl, r.wd), half = st.w / 2, park = fwd ? st.pR : st.pL, bike = r.fl & (fwd ? 64 : 32);
  if (isTrail(r) || /cycleway|pedestrian/.test(r.hw) || half < 2) return 0;
  return Math.max(0, Math.min(6.5, bike ? half - park - BIKE_LANE / 2 : half - park - 1));
}

// The whole area's rails (app/world/rails.bin: { r: roads as landuse.js encodeRoads, h: packH per road }) in local
// metres, xz(lat, lon) -> [x, z]; a spatial index of their segments (CELL m). top(x, z, e): the drawn road's top at a point
// (the rail's height there plus its lift), null off every road; where roads cross one over the other, the one nearest
// the height e if given, else the one whose centre is nearest. match(x, z, hx, hz, e, prev): the rail a course point
// rides (its heading (hx, hz), its height e): the near ones, by how far off, the height, the heading; prev kept a little.
const CELL = 20;
export function railIndex(json, xz) {
  const roads = decodeRoads(json.r || []), out = [], cells = new Map(), ck = (i, j) => i * 100003 + j;
  roads.forEach((r, id) => {
    const H = unpackH(json.h[id] || []), P = dense(r.pts).map(([la, lo]) => xz(la, lo));
    if (P.length !== H.length || P.length < 2) return;
    const st = roadStyle(r.hw, r.ln, r.fl, r.wd), T = track(P, H), rail = { id: out.length, r, half: st.w / 2, lift: railLift(r), T };
    out.push(rail);
    for (let k = 0; k + 1 < P.length; k++) {
      const a = P[k], b = P[k + 1], m = rail.half + 4;
      for (let i = Math.floor((Math.min(a[0], b[0]) - m) / CELL); i <= Math.floor((Math.max(a[0], b[0]) + m) / CELL); i++)
        for (let j = Math.floor((Math.min(a[1], b[1]) - m) / CELL); j <= Math.floor((Math.max(a[1], b[1]) + m) / CELL); j++) {
          const c = ck(i, j); let L = cells.get(c); if (!L) cells.set(c, L = []); if (L.at(-1) !== rail.id) L.push(rail.id);
        }
    }
  });
  const near = (x, z) => cells.get(ck(Math.floor(x / CELL), Math.floor(z / CELL))) || [];
  // the rail id's height at a point (its lift included), and the hit
  const on = (id, x, z, hint) => { const q = out[id], p = q.T.at(x, z, hint); return p && { ...p, y: p.h + q.lift, rail: q }; };
  function top(x, z, e = null) {
    let best = null, bm = Infinity;
    for (const id of near(x, z)) {
      const q = out[id], p = q.T.at(x, z); if (!p || Math.abs(p.d) >= q.half + 0.3) continue;
      const y = p.h + q.lift, m = e == null ? Math.abs(p.d) : Math.abs(y - e) + Math.abs(p.d) * 0.01; if (m < bm) { bm = m; best = y; }
    }
    return best;
  }
  function match(x, z, hx, hz, e = null, prev = -1, dir = null) {
    let best = -1, bc = Infinity; const hl = Math.hypot(hx, hz) || 1;
    for (const id of near(x, z)) {
      const q = out[id], p = q.T.at(x, z); if (!p || Math.abs(p.d) > q.half + 4 || (e != null && !(q.r.fl & 2) && Math.abs(p.h + q.lift - e) > 10)) continue;  // (a road over or under the course's; a tunnel's
      // height the course only guesses at: straight between the ground at its ends)
      const a = q.T.P[p.k], b = q.T.P[p.k + 1], sl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, cs = (hx * (b[0] - a[0]) + hz * (b[1] - a[1])) / (hl * sl), cos = Math.abs(cs);
      // (past a rail's end: another road goes on from there)
      const past = (p.k === 0 && p.t === 0) || (p.k === q.T.P.length - 2 && p.t === 1) ? 3 : 0;
      const c = Math.abs(p.d) + (e == null ? 0 : 2 * Math.abs(p.h + q.lift - e)) + 8 * (1 - cos) + (id === prev ? 0 : 0.5) + past;
      if (c < bc) { bc = c; best = id; if (dir) dir[0] = cs >= 0 ? 1 : -1; }
    }
    return best;
  }
  return { rails: out, top, match, on, near };
}

// A course's profile: the rail each of its points rides (P: [[x, z], ...] its points, ele: its heights or null),
// matched once when the course arrives, so a road under another resolves the same way every frame. -> { ri: Int32Array
// (-1: no rail there), fw: Int8Array (1: along the way as it runs, -1 against it), lane: Float32Array (laneOf), s:
// Float32Array (per stretch i to i + 1, how far along its two rails (ri[i], ri[i + 1]) each end lies: 4 a stretch) }.
// Heights come from the rails at distances along them, eased between the course's points: a course a metre or two off
// the rail (OpenStreetMap moves) never jumps where the nearest point on the rail skips across a bend.
// (old, k: a profile of the same course's first k points, kept: a course that grew)
export function profileOf(idx, P, ele = null, old = null, k = 0) {
  const n = P.length, ri = new Int32Array(n).fill(-1), fw = new Int8Array(n).fill(1), lane = new Float32Array(n), s = new Float32Array(4 * n), dir = [1]; let prev = -1;
  if (old && k > 0) { k = Math.min(k, n, old.ri.length); ri.set(old.ri.subarray(0, k)); fw.set(old.fw.subarray(0, k)); lane.set(old.lane.subarray(0, k)); s.set(old.s.subarray(0, 4 * Math.max(0, k - 1))); prev = k ? ri[k - 1] : -1; } else k = 0;
  for (let i = k; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    ri[i] = prev = idx.match(P[i][0], P[i][1], b[0] - a[0], b[1] - a[1], ele ? ele[i] : null, prev, dir);
    if (prev >= 0) { fw[i] = dir[0]; lane[i] = laneOf(idx.rails[prev].r, dir[0] > 0); }
  }
  for (let i = Math.max(0, k - 1); i + 1 < n; i++) {
    const sOn = (r, p) => r >= 0 ? idx.rails[r].T.at(p[0], p[1]).s : 0;
    s[4 * i] = sOn(ri[i], P[i]); s[4 * i + 1] = sOn(ri[i], P[i + 1]); s[4 * i + 2] = sOn(ri[i + 1], P[i]); s[4 * i + 3] = sOn(ri[i + 1], P[i + 1]);
  }
  return { ri, fw, lane, s };
}
// a rail's height (its lift included) s metres along it
export function railY(q, s) {
  const { D, h } = q.T; if (s <= 0) return h[0] + q.lift; if (s >= D.at(-1)) return h.at(-1) + q.lift;
  let a = 0, b = D.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (D[m] < s) a = m; else b = m; }
  return h[a] + (h[b] - h[a]) * (s - D[a]) / ((D[b] - D[a]) || 1) + q.lift;
}
// a rail's point s metres along it and the way it runs there: [x, z, dx, dz]
export function railXZ(q, s) {
  const { D, P } = q.T, n = D.length; s = Math.max(0, Math.min(D[n - 1], s));
  let a = 0, b = n - 1; while (b - a > 1) { const m = (a + b) >> 1; if (D[m] < s) a = m; else b = m; }
  const f = (s - D[a]) / ((D[b] - D[a]) || 1), dx = P[b][0] - P[a][0], dz = P[b][1] - P[a][1], l = Math.hypot(dx, dz) || 1;
  return [P[a][0] + dx * f, P[a][1] + dz * f, dx / l, dz / l];
}
// the profile between course points i and i + 1 (f of the way): { y, x, z (the rail's line there: the rider's lane is
// an offset from it, not from the course's line), rail (the one nearer) }, null without a rail; where the course goes
// from one road onto the next, the two blended
export function profileAt(idx, pr, i, f) {
  const n = pr.ri.length; if (i >= n - 1) { i = n - 2; f = 1; } if (i < 0) return null;
  const a = pr.ri[i], b = pr.ri[i + 1], S = pr.s, o = 4 * i;
  if (a < 0 && b < 0) return null;
  const at = (r, s) => { const q = idx.rails[r], p = railXZ(q, s); return { y: railY(q, s), x: p[0], z: p[1], rail: q }; };
  const A = a >= 0 ? at(a, S[o] + (S[o + 1] - S[o]) * f) : null, B = b >= 0 && b !== a ? at(b, S[o + 2] + (S[o + 3] - S[o + 2]) * f) : A;
  if (!A) return B; if (!B || A === B) return A;
  return { y: A.y + (B.y - A.y) * f, x: A.x + (B.x - A.x) * f, z: A.z + (B.z - A.z) * f, rail: f < 0.5 ? A.rail : B.rail };
}
