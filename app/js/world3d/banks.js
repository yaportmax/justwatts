// World 3D road sides: what lies beside a road's paved edge. The ground's grid is 7.5 m, coarser than a road is wide,
// so on a hillside a road's edge would float over the slope below it, and a cut bank would lean back over a whole ring
// of the grid. Here, per side of a road: where the ground lies below the edge, an embankment from the edge down to it
// at 1 in 1.5 at most (a shoulder first where a rail stands); where the lidar's ground rises steeply from the edge, a
// face up to the bank's top (red chert where it is bare) and back onto the hillside; where neither, nothing. Pure (no
// three.js): tests/test_world3d.py.

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

export const LEVEL = 0, CUT = 1, FILL = 2;
// What the ground does beyond each point of an edge E (ribbonEdge): { kind, h, o } per point. ground(x, z): the ground as
// drawn (carved), raw(x, z): the lidar's own, either null where unknown. A cut: the lidar's ground 2 m or more over the
// edge 4.5 m out and rising at 3 in 5 or steeper (h its height there; a lower bank, 0.8 m or more, rocky: a ditch's
// rocks and gravel, Street View); a fill: the drawn ground under the edge within
// 1.5 m of it. rail(i): a rail stands there (a fill with its shoulder, whatever the ground does); skip(p): nothing there
// (by a tunnel's portal: its headwall and wing walls). Kinds held for fewer than three points in a row take their
// neighbours'.
export function sideKinds(E, ground, raw, rail = () => false, skip = () => false) {
  const at = (f, p, o) => f(p[0] + p[3] * o, p[2] + p[4] * o);
  const out = E.map((p, i) => {
    if (skip(p)) return { kind: LEVEL, h: 0 };
    const r45 = at(raw, p, 4.5), r3 = at(raw, p, 3), g05 = at(ground, p, 0.5), g15 = at(ground, p, 1.5);
    if (rail(i)) return { kind: FILL, h: 0, rail: true };
    if (r45 != null && r3 != null && r45 - p[1] >= 2 && r45 - p[1] >= 0.6 * 4.5 && r3 > p[1] + 0.6) return { kind: CUT, h: Math.min(18, r45 - p[1]) };
    if (r45 != null && r3 != null && r45 - p[1] >= 0.8 && r3 > p[1] + 0.4) return { kind: CUT, h: r45 - p[1], rocky: true };  // a low bank: rocks and gravel
    if ((g05 != null && g05 < p[1] - 0.08) || (g15 != null && g15 < p[1] - 0.25)) return { kind: FILL, h: 0 };
    return { kind: LEVEL, h: 0 };
  });
  // short runs of a kind (fewer than three points) take the kind before them
  for (let i = 0; i < out.length;) {
    let j = i; while (j + 1 < out.length && out[j + 1].kind === out[i].kind) j++;
    if (j - i < 2 && i > 0 && !out[i].rail) for (let k = i; k <= j; k++) out[k] = { ...out[i - 1], rail: false, h: out[i - 1].h };
    i = j + 1;
  }
  return out;
}

// The bands across each point of an edge: [[o0, h0, o1, h1, cut], ...] (offsets outward and heights of each band's
// inner and outer side; cut: bare cut bank) for kind K at edge point p. ground(x, z): the ground as drawn. sh: the
// shoulder before an embankment (where a rail stands), verge: the flat strip before a cut face. cut: 1 a cut face (bare
// chert where the imagery says so), 2 a low rocky bank.
export function bands(p, K, ground, { sh = 0.15, verge = 0.6 } = {}) {
  const y = p[1], g = o => { const h = ground(p[0] + p[3] * o, p[2] + p[4] * o); return h == null ? y : h; };
  if (K.kind === FILL) {
    // the embankment's toe: where the 1 in 1.5 slope from the shoulder meets the ground; 8 m out at most (past that the
    // ground's own grid carries on down the hillside: a steeper fall from there to the ground under it)
    let toe = sh;
    for (let o = sh; o <= 8; o += 0.5) { toe = o; if (y - 0.06 - (o - sh) / 1.5 <= g(o) + 0.05) break; }
    const yt = y - 0.06 - (toe - sh) / 1.5, o2 = toe + Math.max(0.5, Math.min(4, (yt - g(toe)) * 0.5));
    return [[0, y - 0.03, sh, y - 0.06, 0], [sh, y - 0.06, toe, Math.max(yt, g(toe)) - 0.05, 0], [toe, Math.max(yt, g(toe)) - 0.05, o2, g(o2) - 0.3, 0]];
  }
  if (K.kind === CUT) {
    // a face from the verge's outer side up to the bank's height at 68 degrees, then back onto the hillside
    if (K.rocky) {  // a low bank: rocks and gravel at 1 in 1 for its first 1.2 m, the hillside beyond as it grows
      const H = Math.min(K.h, 1.2), ot = verge + H, oc = Math.max(ot + 2, 6);
      return [[0, y - 0.03, verge, y - 0.05, 0], [verge, y - 0.3, ot, y + H, 2], [ot, y + H, oc, Math.max(g(oc), y + H) - 0.15, 0]];
    }
    const H = K.h, of = verge, ot = of + 0.4 * H, oc = Math.max(ot + 2.5, 7.5), hc = Math.min(g(oc), y + H + 0.4 * (oc - ot));
    return [[0, y - 0.03, of, y - 0.05, 0], [of, y - 0.3, ot, y + H, 1], [ot, y + H, oc, Math.max(hc, y + H - 1) - 0.15, 1]];
  }
  return null;
}

// Runs of one kind along an edge, each point's bands; the first and last point of a run drawn into the edge (no blunt
// end). -> [[{ p, b }, ...], ...]
export function sideRuns(E, kinds, ground, opt = {}) {
  const runs = [];
  for (let i = 0; i < E.length;) {
    let j = i; while (j + 1 < E.length && kinds[j + 1].kind === kinds[i].kind) j++;
    if (kinds[i].kind !== LEVEL && j > i) {
      const run = [];
      for (let k = i; k <= j; k++) {
        let b = bands(E[k], kinds[k], ground, { ...opt, sh: kinds[k].rail ? 0.85 : opt.sh ?? 0.15 }); if (!b) continue;
        if ((k === i && i > 0) || (k === j && j < E.length - 1)) b = b.map(([o0, h0, o1, h1, c]) => [o0 * 0.15, E[k][1] + (h0 - E[k][1]) * 0.15, o1 * 0.15, E[k][1] + (h1 - E[k][1]) * 0.15, c]);
        run.push({ p: E[k], b });
      }
      if (run.length > 1) runs.push(run);
    }
    i = j + 1;
  }
  return runs;
}

// The runs' geometry: per band a strip of quads between neighbouring points, each band its own vertices (a cut face's
// colour does not bleed onto its verge). -> { pos: [x, y, z, ...], cut: [0, 1 or 2 per vertex], idx }
export function bankGeometry(runs, out = { pos: [], cut: [], idx: [] }) {
  for (const run of runs) {
    const nb = run[0].b.length;
    for (let k = 0; k < nb; k++) {
      const base = out.pos.length / 3;
      for (const { p, b } of run) {
        const [o0, h0, o1, h1, c] = b[k];
        out.pos.push(p[0] + p[3] * o0, h0, p[2] + p[4] * o0, p[0] + p[3] * o1, h1, p[2] + p[4] * o1); out.cut.push(c, c);
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
export function railLine(E, i0, i1, off = 0.45) {
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
  for (let k = 1, next = 0.95; k < Q.length; k++) {
    const a = Q[k - 1], b = Q[k], l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    for (; next <= d + l; next += 1.9) { const f = (next - d) / (l || 1); posts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, Math.atan2(b[3] * 0 + a[4], -a[3])]); }
    d += l;
  }
  return { pts: Q, posts, len: L };
}
