// World 3D road sides: what lies beside a road's paved edge. The ground's grid is 7.5 m, coarser than a road is wide,
// so beside a road it is carved level to it and pushed under its top: on a hillside that leaves a terrace, a pit, or a
// road edge over the slope. Here, per side of a road, one continuous strip from the paved edge out to where it meets the
// ground as drawn, only where one is needed: where the lidar's ground rises steeply from the edge (a cut), the lidar's
// own bank up to it at 68 degrees at most; where the ground lies below the edge, down to it at 1 in 1.5 at most (a
// shoulder first where a rail stands). Never over another road's paving, never higher than the lidar's ground or the
// ground as drawn, never leaning toward the road; its outer side on the drawn ground, its ends sunk to it. Where neither
// (the ground at the edge), no strip: the ground. Pure (no three.js): tests/test_world3d.py.

// A ribbon's drawn edge on one side (side 1: its right as it runs, -1: its left) from ribbon()'s centre entries [x, y,
// z, half, right x, y, z, left x, y, z]: [[x, y, z, nx, nz], ...], (nx, nz) the outward normal from the edge's own
// tangent eased over two points either way (it keeps one direction all along: it cannot flip)
export function ribbonEdge(C, side) {
  const k = side > 0 ? 4 : 7, E = C.map(c => [c[k], c[k + 1], c[k + 2]]), n = E.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = E[Math.max(0, i - 2)], b = E[Math.min(n - 1, i + 2)];
    let tx = b[0] - a[0], tz = b[2] - a[2]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    out.push([E[i][0], E[i][1], E[i][2], side > 0 ? -tz : tz, side > 0 ? tx : -tx]);
  }
  return out;
}

export const LEVEL = 0, CUT = 1, FILL = 2, NONE = 3;  // (NONE: nothing drawn: by a tunnel's portal)
// What the ground does beyond each point of an edge E (ribbonEdge): { kind, h } per point. raw(x, z): the lidar's own
// ground, ground(x, z): as drawn (carved), either null where unknown. A cut: the lidar's ground 1.2 m or more over the
// edge 3 m out and rising at 9 in 20 or steeper to 4.5 m out (h its height there); a fill: the drawn ground under the
// edge within 1.5 m of it. rail(i): a rail stands there (a fill with its shoulder, whatever the ground does); skip(p):
// nothing there (by a tunnel's portal: its headwall and wing walls). Kinds held for fewer than three points in a row
// take their neighbours'.
export function sideKinds(E, ground, raw, rail = () => false, skip = () => false) {
  const at = (f, p, o) => f(p[0] + p[3] * o, p[2] + p[4] * o);
  const out = E.map((p, i) => {
    if (skip(p)) return { kind: NONE, h: 0 };
    const r45 = at(raw, p, 4.5), r3 = at(raw, p, 3), g05 = at(ground, p, 0.5), g15 = at(ground, p, 1.5);
    if (rail(i)) return { kind: FILL, h: 0, rail: true };
    if (r45 != null && r3 != null && r3 - p[1] >= 1.2 && r45 - p[1] >= 0.45 * 4.5) return { kind: CUT, h: Math.min(18, r45 - p[1]) };
    if ((g05 != null && g05 < p[1] - 0.08) || (g15 != null && g15 < p[1] - 0.25)) return { kind: FILL, h: 0 };
    return { kind: LEVEL, h: 0 };
  });
  for (let i = 0; i < out.length;) {
    let j = i; while (j + 1 < out.length && out[j + 1].kind === out[i].kind) j++;
    if (j - i < 2 && i > 0 && !out[i].rail && out[i].kind !== NONE && out[i - 1].kind !== NONE) for (let k = i; k <= j; k++) out[k] = { ...out[i - 1], rail: false };
    i = j + 1;
  }
  return out;
}

const STEP0 = 0.75, FOOT = 1.5;
export const ACROSS = 7;  // a strip's points across (six bands: the verge or shoulder by the edge where there is one, five out to its end)
// The profile out from edge point p for kind K: { prof: [[o, h], ...] from the edge (0, just under it) to where it meets
// the ground as drawn, O: that offset, need: anywhere 5 cm or more over the ground } (null: NONE). ground(x, z): as drawn;
// opt.raw: the lidar's; opt.block(x, z, y): another road's paving there within reach of height y (the profile ends on the
// ground short of it). sh: the shoulder before a fill (where a rail stands), verge: the flat strip before a cut face.
export function profile(p, K, ground, { sh = 0.15, verge = 0.6, raw = null, block = null } = {}) {
  if (K.kind === NONE) return null;
  const y = p[1], at = o => [p[0] + p[3] * o, p[2] + p[4] * o], g = o => ground(...at(o)) ?? y - 0.03, rw = o => (raw && raw(...at(o))) ?? g(o);
  // (the lidar's own ground wherever it is over the ground as drawn: a cut's bank, or what the carve and the push under
  // the road dug out beside it; at 68 degrees at most from the verge)
  // (behind a retaining wall (K.wall, its back 0.5 m out) the bank rises from the wall's back)
  if (K.wall) verge = 0.5;
  // (behind a curb (K.curb) its shoulder 0.1 m under the curb's top for 0.6 m, then down (A12: at its top the curb read flush,
  // Street View Center Road 0a_0030: a raised curb, the lawn behind a little under its top; its foot buried, no underside))
  const top = K.curb ? 0.05 : -0.03; if (K.curb) sh = 0.6;
  // (up a cut: a grassy foot first, 1 in 4 for its first 1.5 m out from the verge, then at 68 degrees at most (Street View,
  // Alexander Avenue 0a_0530, McCullough Road 0a_0530: a near level grass margin about 2 m wide at the bank's foot before it
  // steepens; the lidar's 7.5 m grid cannot place the foot itself. A11's 1 in 2 never showed: the strip's points across
  // skipped it, a straight ramp from the verge)
  const toe = d => d <= 0 ? 0 : d <= FOOT ? d * 0.25 : FOOT * 0.25 + (d - FOOT) * 2.5;
  const up = o => Math.min(rw(o), y + toe(o - verge));
  const down = o => y + top - Math.max(0, o - sh) / 1.5;
  const STEP = 0.75, MAX = 10.5, T = [];
  let lim = MAX;
  // (the flat strip's outer side, where it turns up a cut or down a fill: a point of its own, so the strip keeps it)
  const rises = rw(STEP) > y + 0.05, kink = rises ? verge : sh, foot = rises ? verge + FOOT : null, OS = [];
  for (let o = STEP; o <= MAX + 1e-9; o += STEP) { for (const q of [kink, foot]) if (q != null && q > o - STEP + 0.05 && q < o - 0.05) OS.push(q); OS.push(o); }
  // out to MAX or short of another road; the strip ends a step past the last point it stands 5 cm or more over the
  // ground (the lidar may rise past a level verge the carve made: the strip goes on over it); lim: how far it may reach
  for (const o of OS) {
    if (block && block(...at(o), y)) { lim = Math.max(0, (T.at(-1)?.[0] ?? 0)); break; }
    const gg = g(o); T.push([o, Math.min(Math.max(up(o), down(o)), gg + (MAX - o) * 1.0), gg]);
  }
  // (needed where it stands 5 cm over the ground, or where the ground just past the edge is 15 cm under it: a step down
  // off the edge shows under the road's paving)
  let L = -1; T.forEach(([, t, gg], k) => { if (t > gg + 0.05 || (k === 0 && gg < y - 0.15)) L = k; });
  if (L < 0 || !T.length) return { prof: [[0, y - 0.03], [STEP, g(STEP)]], O: STEP, need: false, lim, kink, foot };
  const end = Math.min(L + 1, T.length - 1), prof = [[0, y - 0.03], ...T.slice(0, end).map(([o, t, gg]) => [o, Math.max(t, gg)]), [T[end][0], T[end][2]]];
  const need = true;
  return { prof, O: prof.at(-1)[0], need, lim, kink, foot };
}
// The strip across p out to offset R (R >= the profile's O: past it on the ground): [[o0, h0, o1, h1, cut], ...] (each
// band's inner and outer offset and height; cut 1: a steep face, else the ground's own cover). Every point on or over
// the ground, the first just under the edge, the last on the ground. flat: all of it on the ground (a run's ends).
export function strip(p, P, R, ground, flat = false) {
  const y = p[1], at = o => [p[0] + p[3] * o, p[2] + p[4] * o], g = o => ground(...at(o)) ?? y - 0.03, prof = P.prof;
  const hAt = o => { if (o >= P.O) return g(o); let k = 1; while (k < prof.length - 1 && prof[k][0] < o) k++; const [o0, h0] = prof[k - 1], [o1, h1] = prof[k]; return h0 + (h1 - h0) * Math.max(0, Math.min(1, (o - o0) / ((o1 - o0) || 1))); };
  const pts = [];
  // (each inner point over the ground at it and over the mean of the ground halfway to its neighbours: where the ground
  // bulges between two points)
  // (the first band the flat strip by the edge where it turns up or down within the strip's first half (the verge before
  // a cut, the shoulder before a fill: the setback from the paved edge Street View shows), the rest even out to R)
  // (and up a cut the foot's outer side a point of its own too: the foot's gentle rise drawn, not a ramp from the verge)
  const kk = P.kink != null && P.kink > 0.05 && P.kink < R / 2 ? P.kink : null, ft = kk != null && P.foot != null && P.foot < R * 0.7 ? P.foot : null;
  const oAt = k => kk == null ? R * k / (ACROSS - 1) : k === 0 ? 0 : ft == null ? kk + (R - kk) * (k - 1) / (ACROSS - 2) : k === 1 ? kk : ft + (R - ft) * (k - 2) / (ACROSS - 3);
  const d = R / (ACROSS - 1) / 2, over = o => Math.max(g(o), (g(Math.max(0, o - d)) + g(o + d)) / 2) + 0.03;
  for (let k = 0; k < ACROSS; k++) { const o = oAt(k); pts.push([o, k === 0 ? y - 0.03 : k === ACROSS - 1 || flat ? g(o) : Math.max(hAt(o), over(o))]); }
  const out = [];
  // (v: 1 within 2 m of the edge where not steep (the verge, a rail's or a curb's shoulder, a cut's foot): grass whatever the
  // ground's cover beyond (Street View: Alexander Avenue 0a_1230's rail feet and fence base, Bunker Road 0a_0430's rail
  // posts, McCullough Road 0a_0530's margin))
  for (let k = 1; k < ACROSS; k++) { const [o0, h0] = pts[k - 1], [o1, h1] = pts[k], c = (h1 - h0) > 1.0 * (o1 - o0) && h1 > y + 0.3 ? 1 : 0; out.push([o0, h0, o1, h1, c, !c && o0 < 2.0 ? 1 : 0]); }
  return out;
}
// (one point's strip on its own: tests)
export function bands(p, K, ground, opt = {}) { const P = profile(p, K, ground, opt); return P && P.need ? strip(p, P, P.O, ground) : null; }

// Runs of strips along an edge: the points that need one; each strip out to the furthest of its own and its neighbours'
// ends (no long diagonal between a wide strip and a narrow one); each run with the point before and after it laid flat
// on the ground out as far (its ends sunk: no hole under them). opt: profile's. -> [[{ p, b }, ...], ...]
export function sideRuns(E, kinds, ground, opt = {}) { const it = sideRunsSteps(E, kinds, ground, opt); let r; do r = it.next(); while (!r.done); return r.value; }
// (the same a slice at a time: a generator that yields every `every` points, its value the runs; a tile's build runs it
// over several frames)
export function* sideRunsSteps(E, kinds, ground, opt = {}, every = 24) {
  // (points at most 3 m apart along the edge: the ground between two may bulge over a strip)
  { const E2 = [], K2 = [];
    for (let i = 0; i < E.length; i++) {
      if (i) { const a = E[i - 1], b = E[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 3);
        for (let k = 1; k < n; k++) { const f = k / n, q = a.map((v, j) => v + (b[j] - v) * f), l = Math.hypot(q[3], q[4]) || 1; q[3] /= l; q[4] /= l; E2.push(q); K2.push(f < 0.5 ? kinds[i - 1] : kinds[i]); } }
      E2.push(E[i]); K2.push(kinds[i]);
    }
    E = E2; kinds = K2; }
  const P = [];
  for (let i = 0; i < E.length; i++) { if (i % every === every - 1) yield; P.push(profile(E[i], kinds[i], ground, { ...opt, sh: kinds[i].rail ? 0.75 : opt.sh ?? 0.15 })); }
  // (each strip out to the furthest end within 6 m along, short of another road)
  const need = i => !!P[i]?.need, reach = i => { let r = P[i]?.O ?? 0; for (let k = Math.max(0, i - 3); k <= Math.min(E.length - 1, i + 3); k++) if (need(k)) r = Math.max(r, P[k].O); return Math.max(STEP0, Math.min(r, P[i]?.lim ?? r)); };
  const runs = [];
  for (let i = 0; i < E.length; i++) {
    if (i % every === every - 1) yield;
    if (!need(i)) continue;
    let j = i; while (j + 1 < E.length && need(j + 1)) j++;
    const run = [];
    for (let k = Math.max(0, i - 1); k <= Math.min(E.length - 1, j + 1); k++) {
      if (!P[k]) continue;
      run.push({ p: E[k], b: strip(E[k], P[k], reach(k), ground, k < i || k > j) });
    }
    if (run.length > 1) runs.push(run);
    i = j;
  }
  return runs;
}

// The runs' geometry: per band a strip of quads between neighbouring points, each band its own vertices (a cut face's
// colour does not bleed onto its neighbour). -> { pos: [x, y, z, ...], cut: [0 or 1 per vertex], idx }
export function bankGeometry(runs, out = { pos: [], cut: [], vg: [], idx: [] }) {
  for (const run of runs) {
    const nb = run[0].b.length;
    for (let k = 0; k < nb; k++) {
      const base = out.pos.length / 3;
      for (const { p, b } of run) {
        const [o0, h0, o1, h1, c, v = 0] = b[k];
        out.pos.push(p[0] + p[3] * o0, h0, p[2] + p[4] * o0, p[0] + p[3] * o1, h1, p[2] + p[4] * o1); out.cut.push(c, c); out.vg?.push(v, v);
      }
      // facing up and out, whichever side of the road (the edge's outward normal says which way round)
      for (let i = 1; i < run.length; i++) {
        const a = base + 2 * (i - 1), b = a + 2, p = run[i - 1].p, q = run[i].p, tx = q[0] - p[0], tz = q[2] - p[2], right = p[3] * tz - p[4] * tx > 0;
        if (right) out.idx.push(a, b, a + 1, a + 1, b, b + 1); else out.idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  return out;
}

// A rail along an edge's points i0..i1: its posts 0.45 m out from the paved edge (the beam's face 0.25 m), every 2 m by arc length, eased along (its line
// and its heights), each point [x, y, z, nx, nz] with the outward normal of the eased line; posts every 1.9 m by arc
// length [x, y, z, yaw] (yaw: the post's +x toward the road).
export function railLine(E, i0, i1, off = 0.45, gap = 1.9) {
  const P = []; for (let i = i0; i <= i1; i++) P.push([E[i][0] + E[i][3] * off, E[i][1], E[i][2] + E[i][4] * off, E[i][3], E[i][4]]);
  if (P.length < 2) return null;
  const D = [0]; for (let i = 1; i < P.length; i++) D.push(D[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]));
  const L = D.at(-1); if (L < 2) return null;
  const n = Math.max(2, Math.round(L / 2) + 1), Q = [];
  for (let k = 0, j = 0; k < n; k++) {
    const s = L * k / (n - 1); while (j + 2 < P.length && D[j + 1] < s) j++;
    const f = Math.max(0, Math.min(1, (s - D[j]) / ((D[j + 1] - D[j]) || 1))), a = P[j], b = P[j + 1];
    Q.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f]);
  }
  const ease = (idx, times) => { for (let t = 0; t < times; t++) for (let k = 1; k + 1 < Q.length; k++) Q[k][idx] = (Q[k - 1][idx] + 2 * Q[k][idx] + Q[k + 1][idx]) / 4; };
  ease(0, 2); ease(2, 2); ease(1, 4);
  for (let k = 0; k < Q.length; k++) {
    const a = Q[Math.max(0, k - 1)], b = Q[Math.min(Q.length - 1, k + 1)]; let tx = b[0] - a[0], tz = b[2] - a[2]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const s = Math.sign(-tz * Q[k][3] + tx * Q[k][4]) || 1; Q[k][3] = -tz * s; Q[k][4] = tx * s;
  }
  const posts = []; let d = 0;
  for (let k = 1, next = gap / 2; k < Q.length; k++) {
    const a = Q[k - 1], b = Q[k], l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    for (; next <= d + l; next += gap) { const f = (next - d) / (l || 1); posts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, Math.atan2(b[3] * 0 + a[4], -a[3])]); }
    d += l;
  }
  return { pts: Q, posts, len: L };
}
