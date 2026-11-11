// The keep-out rule, one for every placer (A38: the owner's ride of the link to Mount Tam, "poles in the middle of the road",
// a lamp post in Bridgeway's bike lane (ride frame linkN_02006), a building standing in the bay (linkN_01016)): nothing solid
// within a drawn ribbon plus KEEP of any road, path or ride line, and no building or tree with its foot in water. A pole or a
// lamp is pushed out to the ribbon's edge plus KEEP on its own side; a tree or a prop is dropped; a building is moved clear
// or dropped. Pure (no three.js, no DOM): view.js's placers use it on the drawn roads at run time, the data pass
// (justwatts-private/work/tam-net/keepout_bake.mjs) on the baked tiles, and keepout_check.mjs counts what is left (the ship gate).
export const KEEP = 1.5;

// The ribbons of a set of lines, in cells: add(x0, z0, x1, z1, half, deck, tag) a segment at its half width (deck: a bridge's
// height, else null), gap(x, z, ground) how far a point is outside the nearest ribbon's edge (negative: on it; Infinity with
// none within REACH; a bridge more than 5 m over the ground there does not count), mids(x0, z0, x1, z1, fn) the middles of the
// segments on the ground in a box (a way under a roof).
export function ribbons(cell = 25, REACH = 8) {
  const cells = new Map(), S = [], tags = [];
  const each = (x0, z0, x1, z1, fn) => { for (let a = Math.floor(x0 / cell); a <= Math.floor(x1 / cell); a++) for (let b = Math.floor(z0 / cell); b <= Math.floor(z1 / cell); b++) fn(a * 100003 + b); };
  return {
    get n() { return tags.length; },
    add(x0, z0, x1, z1, half, deck = null, tag = null) {
      const id = tags.push(tag) - 1, m = half + REACH; S.push(x0, z0, x1, z1, half, deck ?? NaN);
      each(Math.min(x0, x1) - m, Math.min(z0, z1) - m, Math.max(x0, x1) + m, Math.max(z0, z1) + m, k => { const l = cells.get(k); if (l) l.push(id); else cells.set(k, [id]); });
    },
    gap(x, z, ground = null) {
      let best = Infinity;
      for (const id of cells.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || []) {
        const k = id * 6; if (ground != null && S[k + 5] - ground > 5) continue;
        const ex = S[k + 2] - S[k], ez = S[k + 3] - S[k + 1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 1]) * ez) / L2)) : 0;
        const d = Math.hypot(x - S[k] - ex * t, z - S[k + 1] - ez * t) - S[k + 4]; if (d < best) best = d;
      }
      return best;
    },
    mids(x0, z0, x1, z1, fn) {
      const seen = new Set();
      each(x0, z0, x1, z1, key => { for (const id of cells.get(key) || []) { if (seen.has(id)) continue; seen.add(id); const k = id * 6; if (S[k + 5] === S[k + 5]) continue; fn((S[k] + S[k + 2]) / 2, (S[k + 1] + S[k + 3]) / 2, S[k + 4], tags[id]); } });
    },
  };
}

// Is a point clear of every ribbon by the rule (gap: a function (x, z) giving the distance outside the nearest ribbon's edge, or
// null or Infinity with none near)?
export const clear = (gap, x, z, keep = KEEP) => { const g = gap(x, z); return g == null || g >= keep; };

// A pole's or a lamp's spot by the rule: where it is when clear, else out from the nearest ribbon (up the gap's slope, so on
// its own side) to that ribbon's edge plus the keep, when that spot is clear of every other ribbon (and ok(x, z), the
// caller's own test: not in a building, not in water) too; else the nearest clear spot on a ring of 16 round it out to
// `reach`; null when there is none (the caller drops it).
export function pushOut(gap, x, z, { keep = KEEP, reach = 8, ok = null } = {}) {
  const g = gap(x, z); if (g == null || g >= keep) return [x, z];
  const fine = (a, b) => { const q = gap(a, b); return (q == null || q >= keep) && (!ok || ok(a, b)); };
  const e = 0.5, gx = (gap(x + e, z) ?? g) - (gap(x - e, z) ?? g), gz = (gap(x, z + e) ?? g) - (gap(x, z - e) ?? g), L = Math.hypot(gx, gz);
  if (L > 0.05) { let a = x, b = z; for (let i = 0; i < 4; i++) { const q = gap(a, b); if (q == null || q >= keep) break; const d = keep - q + 0.05; a += gx / L * d; b += gz / L * d; } if (fine(a, b)) return [a, b]; }
  for (let r = 1; r <= reach; r += 0.5) for (let i = 0; i < 16; i++) { const a = x + Math.cos(i * Math.PI / 8) * r, b = z + Math.sin(i * Math.PI / 8) * r; if (fine(a, b)) return [a, b]; }
  return null;
}

// The least gap along a closed outline of [x, z] corners, sampled every `step` metres (a building's walls against the ribbons)
export function outlineGap(gap, ring, step = 1) {
  let worst = Infinity;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) { const g = gap(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n); if (g != null && g < worst) worst = g; } }
  return worst;
}

// The rule bound to its sources: the one every placer asks, the data pass on the baked tiles as view.js at run time.
//   gap(x, z): how far the point is outside the nearest ribbon's edge (every drawn road and path and every ride line; null
//     or Infinity with none near); wet(x, z): is the point in water; ground(x, z): the height of the surface drawn there
//     (the ground as cut to the roads and their banks, the hand-built ground inside its corridor), null where none is.
// It gives clear(x, z, margin): may something stand there (clear of every ribbon by the margin, KEEP unless given, and
// not in water); wet(x, z): is it in water; groundY(x, z): the height its foot takes, null where nothing may stand; spot(x, z, margin, ok): a pole's
// or a lamp's place (pushOut: out to the ribbon's edge plus the margin on its own side, null to drop it; ok(x, z): the
// caller's own test besides, not in a building); outline(ring, step): a building's walls' least gap (outlineGap).
// (A38: before it every placer had its own test and its own height: grid trees a coarse raster of road cells, lidar trees
// 1 m from the drawn roads only, lamps 0.9 m from their own road and no other, power poles none at all, the hand list's
// furniture the lidar's ground while the rest stood on the carved grid; the list is in work/handoff_tam_net.md.)
export function rule({ gap, wet = null, ground }) {
  const dry = (x, z) => !(wet && wet(x, z));
  return {
    KEEP, gap, wet: (x, z) => !dry(x, z),
    clear: (x, z, margin = KEEP) => { const g = gap(x, z); return (g == null || g >= margin) && dry(x, z); },
    groundY: (x, z) => ground(x, z),
    spot: (x, z, margin = KEEP, ok = null) => { const fine = (a, b) => dry(a, b) && (!ok || ok(a, b)), p = pushOut(gap, x, z, { keep: margin, ok: fine }); return p && fine(p[0], p[1]) ? p : null; },
    outline: (ring, step = 1) => outlineGap(gap, ring, step),
  };
}
