// World 3D terrain: a height grid per Web Mercator tile from Terrarium tiles, carved to the ridden road, ground
// classes rasterised from landuse polygons, and the mesh (an index over a regular grid, skirts on the edges so tiles
// of other detail never show a crack). Pure: no three.js, no DOM. tests/test_world3d.py.
import { terrarium } from '../roads.js';
import { tileX, tileY, lonOf, latOf } from './geo.js';
import { KINDS } from './landuse.js';

const T = 256;
// a decoded tile { w, h, data: RGBA } -> heights in metres
export function heightsOf(t) {
  const n = t.w * t.h, hm = new Float32Array(n), d = t.data;
  for (let i = 0; i < n; i++) hm[i] = terrarium(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
  return { w: t.w, h: t.h, hm };
}
// height at global pixel coordinates (tile x * 256 + pixel) of one zoom, bilinear between pixel centres and across
// tile edges. get(tx, ty) -> { hm } | null; a missing neighbour is left out of the blend.
export function makeSampler(get) {
  const pix = (i, j) => { const t = get(Math.floor(i / T), Math.floor(j / T)); return t ? t.hm[(((j % T) + T) % T) * T + (((i % T) + T) % T)] : null; };
  return (gx, gy) => {
    const px = gx - 0.5, py = gy - 0.5, i = Math.floor(px), j = Math.floor(py), fx = px - i, fy = py - j;
    const v = [pix(i, j), pix(i + 1, j), pix(i, j + 1), pix(i + 1, j + 1)], w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    let s = 0, ws = 0; for (let k = 0; k < 4; k++) if (v[k] != null) { s += v[k] * w[k]; ws += w[k]; }
    return ws ? s / ws : 0;
  };
}

// The grid of a tile: (segs + 1)^2 heights, xs[i] / zs[j] in local metres (x depends on the column only, z on the row).
export function makeGrid({ z, x, y, segs, sample, proj }) {
  const n = segs + 1, hs = new Float32Array(n * n), xs = new Float64Array(n), zs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = proj.x(lonOf(x + i / segs, z));
  for (let j = 0; j < n; j++) zs[j] = proj.z(latOf(y + j / segs, z));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hs[j * n + i] = sample((x + i / segs) * T, (y + j / segs) * T);
  return { z, x, y, segs, hs, xs, zs, raw: hs.slice(), proj };
}
// the same from baked heights (n x n, n = src segs + 1), taking every step-th sample for a coarser grid
export function gridFromHeights({ z, x, y, hs: src, n: sn, step = 1, proj }) {
  const segs = (sn - 1) / step, n = segs + 1, hs = new Float32Array(n * n), xs = new Float64Array(n), zs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = proj.x(lonOf(x + i / segs, z));
  for (let j = 0; j < n; j++) zs[j] = proj.z(latOf(y + j / segs, z));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hs[j * n + i] = src[j * step * sn + i * step];
  return { z, x, y, segs, hs, xs, zs, raw: hs.slice(), proj };
}
// Bicubic (Catmull-Rom) upsampling of an n x n height grid by an integer factor f: ((n - 1) f + 1)^2 heights that pass
// through every source sample, smooth in between (no 15 m facets near the rider). ext(i, j): a sample outside the grid
// (a neighbour tile's), null to clamp to the edge. Edge rows only use samples along the edge, so two tiles that share
// an edge get the same heights on it.
export function upsample(hs, n, f, ext = null) {
  const m = (n - 1) * f + 1, out = new Float32Array(m * m), W = [];
  for (let k = 0; k < f; k++) { const t = k / f, t2 = t * t, t3 = t2 * t; W.push([(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]); }
  const at = (i, j) => {
    if (i >= 0 && j >= 0 && i < n && j < n) return hs[j * n + i];
    const e = ext ? ext(i, j) : null; if (e != null) return e;
    return hs[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  };
  // rows first (every source row at the new columns), then columns
  const rows = new Float32Array((n + 2) * m);
  for (let j = -1; j <= n; j++) for (let I = 0; I < m; I++) {
    const i = Math.floor(I / f), k = I - i * f, o = (j + 1) * m + I;
    if (k === 0) { rows[o] = at(i, j); continue; }
    const w = W[k]; rows[o] = w[0] * at(i - 1, j) + w[1] * at(i, j) + w[2] * at(i + 1, j) + w[3] * at(i + 2, j);
  }
  for (let J = 0; J < m; J++) {
    const j = Math.floor(J / f), k = J - j * f, w = W[k];
    for (let I = 0; I < m; I++) {
      if (k === 0) { out[J * m + I] = rows[(j + 1) * m + I]; continue; }
      const r = jj => rows[(Math.max(-1, Math.min(n, jj)) + 1) * m + I];
      out[J * m + I] = w[0] * r(j - 1) + w[1] * r(j) + w[2] * r(j + 1) + w[3] * r(j + 2);
    }
  }
  return out;
}
// smooth vertex normals of a grid's surface (central differences, one-sided on the edges): Float32Array n * n * 3
export function gridNormals(g, hs = g.hs) {
  const s = g.segs, n = s + 1, out = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(s, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(s, j + 1);
    const dx = (hs[j * n + i1] - hs[j * n + i0]) / (g.xs[i1] - g.xs[i0]), dz = (hs[j1 * n + i] - hs[j0 * n + i]) / (g.zs[j1] - g.zs[j0]);
    const l = Math.hypot(dx, 1, dz), o = 3 * (j * n + i);
    out[o] = -dx / l; out[o + 1] = 1 / l; out[o + 2] = -dz / l;
  }
  return out;
}
// hollows (+) and ridges (-) per vertex, -1..1: how far the ground `r` metres round sits above (below) the vertex,
// over `scale` metres. Gullies stay green and a little darker; ridges dry.
export function gridCurvature(g, r = 25, scale = 6, hs = g.raw) {
  const s = g.segs, n = s + 1, out = new Float32Array(n * n), sp = Math.abs(g.xs[s] - g.xs[0]) / s, k = Math.max(1, Math.round(r / sp));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - k), i1 = Math.min(s, i + k), j0 = Math.max(0, j - k), j1 = Math.min(s, j + k);
    const avg = (hs[j * n + i0] + hs[j * n + i1] + hs[j0 * n + i] + hs[j1 * n + i] + hs[j0 * n + i0] + hs[j0 * n + i1] + hs[j1 * n + i0] + hs[j1 * n + i1]) / 8;
    out[j * n + i] = Math.max(-1, Math.min(1, (avg - hs[j * n + i]) / scale));
  }
  return out;
}
// Ground class weights per vertex for the terrain shader, so class edges blend instead of stepping per triangle:
// 8 bytes per vertex [wood, green, sand, town, cut bank, rock, lake, farm] (0..255). lu: rasterClasses, cut: carve's.
export function classMasks(lu, cut = null) {
  const n = lu.length, out = new Uint8Array(n * 8);
  //               park grass farm town scrub wood rock sand water
  const W = [null, [0, 0], [1, 0.4], [7, 1], [3, 1], [0, 0.55], [0, 1], [5, 1], [2, 1], [6, 1]];
  for (let v = 0; v < n; v++) {
    const k = lu[v], o = v * 8;
    if (k === 1) { out[o + 1] = 255; out[o] = 70; }          // a park: green, a few trees
    else if (k === 5) { out[o] = 140; out[o + 1] = 90; }     // scrub: dark and green
    else if (W[k]) out[o + W[k][0]] = Math.round(255 * W[k][1]);
    if (cut && cut[v]) out[o + 4] = 255;
  }
  return out;
}
// grid coordinates (fractional column, row) of a local point
export function gridIJ(g, px, pz) {
  const fi = (px - g.xs[0]) / (g.xs[g.segs] - g.xs[0]) * g.segs;
  const lat = g.proj.lat(pz), fj = (tileY(lat, g.z) - g.y) * g.segs;
  return [fi, fj];
}
// the mesh's own surface at a local point (the triangle it falls in, the same diagonal as the index), null outside
export function gridHeight(g, px, pz, hs = g.hs) {
  const [fi, fj] = gridIJ(g, px, pz), s = g.segs, n = s + 1;
  if (!(fi >= 0 && fj >= 0 && fi <= s && fj <= s)) return null;
  const i = Math.min(s - 1, Math.floor(fi)), j = Math.min(s - 1, Math.floor(fj)), u = fi - i, v = fj - j;
  const a = hs[j * n + i], b = hs[j * n + i + 1], c = hs[(j + 1) * n + i], d = hs[(j + 1) * n + i + 1];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

// Carve the ridden road in: vertices within r0 metres of the road take its height (projected onto the nearest
// segment), fading back to the ground by r1. Points far off the ground (a bridge, a tunnel) leave it alone.
// pts: [[x, z, h], ...] in order along the road. under: other roads [{ pts, r0, r1, rc }] flattened first (each road
// level across, so no hump of ground shows through it); the ridden road wins where they meet. g.cut: the vertices the
// carve lowered by more than 0.8 m (a fill is no cut), and those within rc (if given) of a road standing 1.5 m or more
// over it and rising from its edge (half: half its width) at 4 in 5 or steeper (a cut bank the heights already have;
// a natural slope is gentler).
export function carve(g, pts, r0, r1, under = null) { return drain(carveSteps(g, pts, r0, r1, under)); }
// the same a slice at a time (a generator yielding every few dozen roads; returns what carve returns)
export function* carveSteps(g, pts, r0, r1, under = null) {
  const u = under?.length ? yield* blend(g, g.raw, under, false) : null, base = u ? u.hs : g.raw;
  const r = yield* blend(g, base, [{ pts, r0, r1 }], true);
  if (u) for (let v = 0; v < r.cut.length; v++) if (g.raw[v] - r.hs[v] > 0.8 || u.cut[v]) r.cut[v] = 1;
  g.hs = r.hs; g.cut = r.cut;
  return r.touched;
}
// run a generator to its end, its return value
export function drain(it) { let r; do r = it.next(); while (!r.done); return r.value; }
function* blend(g, from, lines, check) {
  const s = g.segs, n = s + 1, best = new Float32Array(n * n).fill(Infinity), bh = new Float32Array(n * n), raw = g.raw, fade = new Float32Array(n * n), bank = new Uint8Array(n * n);
  const x0 = g.xs[0], dx = (g.xs[s] - g.xs[0]) / s, z0 = g.zs[0], dz = (g.zs[s] - g.zs[0]) / s;
  let touched = false;
  let nl = 0;
  for (const { pts, r0, r1: rf, rc = 0, half = 0 } of lines) {
    if (++nl % 24 === 0) yield;
    const r1 = Math.max(rf, rc);
    const lo = Math.min(g.xs[0], g.xs[s]) - r1, hi = Math.max(g.xs[0], g.xs[s]) + r1, zlo = Math.min(g.zs[0], g.zs[s]) - r1, zhi = Math.max(g.zs[0], g.zs[s]) + r1;
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      if (Math.max(p[0], q[0]) < lo || Math.min(p[0], q[0]) > hi || Math.max(p[1], q[1]) < zlo || Math.min(p[1], q[1]) > zhi) continue;
      if (check) {
        const gp = gridHeight(g, p[0], p[1], raw), gq = gridHeight(g, q[0], q[1], raw);
        if (Math.max(gp == null ? 0 : Math.abs(p[2] - gp), gq == null ? 0 : Math.abs(q[2] - gq)) > 12) continue;  // a bridge or a tunnel
      }
      const ia = Math.max(0, Math.floor((Math.min(p[0], q[0]) - r1 - x0) / dx)), ib = Math.min(s, Math.ceil((Math.max(p[0], q[0]) + r1 - x0) / dx));
      const ja = Math.max(0, Math.floor((Math.min(p[1], q[1]) - r1 - z0) / dz) - 1), jb = Math.min(s, Math.ceil((Math.max(p[1], q[1]) + r1 - z0) / dz) + 1);
      const ex = q[0] - p[0], ez = q[1] - p[1], L = ex * ex + ez * ez;
      for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
        const vx = g.xs[i] - p[0], vz = g.zs[j] - p[1], t = L ? Math.max(0, Math.min(1, (vx * ex + vz * ez) / L)) : 0;
        const d = Math.hypot(vx - ex * t, vz - ez * t), v = j * n + i;
        if (d >= r1) continue;
        if (d < rc) { const up = raw[v] - (p[2] + (q[2] - p[2]) * t); if (up > 1.5 && up > 0.8 * Math.max(0.5, d - half)) bank[v] = 1; }
        if (d >= rf) continue;
        const f = d <= r0 ? 1 : 1 - (d - r0) / (rf - r0);
        if (f > fade[v] || (f === fade[v] && d < best[v])) { fade[v] = f; best[v] = d; bh[v] = p[2] + (q[2] - p[2]) * t; touched = true; }
      }
    }
  }
  const hs = from.slice(), cut = bank;
  if (touched) for (let v = 0; v < n * n; v++) {
    const t = fade[v]; if (!t) continue;
    const w = t * t * (3 - 2 * t);
    hs[v] = from[v] + (bh[v] - from[v]) * w;
    if (raw[v] - hs[v] > 0.8) cut[v] = 1;
  }
  return { hs, cut, touched };
}

// Ground classes per vertex (0: none, else KINDS index + 1; the higher class wins) from features { k, rings: [[lat, lon]] }
export function rasterClasses(g, features) { return rasterBy(g, features, f => f.k === 'building' ? 0 : KINDS.indexOf(f.k) + 1); }
// Any value per vertex of a tile grid ({ z, x, y, segs }: no heights needed) from polygons: value(f) 1..255, the
// higher wins, 0 leaves the feature out. A scanline fill, fast at any resolution.
export function rasterBy(g, features, value) {
  const s = g.segs, n = s + 1, lu = new Uint8Array(n * n);
  for (const f of features) {
    const c = value(f); if (!(c > 0)) continue;
    const rings = f.rings.map(r => r.map(([la, lo]) => [(tileX(lo, g.z) - g.x) * s, (tileY(la, g.z) - g.y) * s]));
    let jmin = Infinity, jmax = -Infinity;
    for (const r of rings) for (const p of r) { jmin = Math.min(jmin, p[1]); jmax = Math.max(jmax, p[1]); }
    for (let j = Math.max(0, Math.ceil(jmin)); j <= Math.min(s, Math.floor(jmax)); j++) {
      const xs = [];
      for (const r of rings) for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const p = r[a], q = r[b];
        if ((p[1] > j) !== (q[1] > j)) xs.push(p[0] + (j - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let i = Math.max(0, Math.ceil(xs[k])); i <= Math.min(s, Math.floor(xs[k + 1])); i++) {
        const v = j * n + i; if (c > lu[v]) lu[v] = c;
      }
    }
  }
  return lu;
}

// The mesh: positions, ground class per vertex, triangles; skip(i, j): leave quad i, j out (a finer tile covers it).
// Skirts hang `skirt` metres down from every edge that borders nothing.
// Skirts face out (front faces seen from outside the tile). Returns src: for every vertex the grid vertex it copies.
export function gridMesh(g, { lu = null, skip = null, skirt = 0 } = {}) {
  const s = g.segs, n = s + 1, nv = n * n;
  const keep = (i, j) => i >= 0 && j >= 0 && i < s && j < s && !(skip && skip(i, j));
  // count first (quads kept, skirt walls), then fill typed arrays: no growing arrays for the 66 000 vertices of a fine tile
  let quads = 0, walls = 0;
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
    if (!keep(i, j)) continue;
    quads++; if (skirt > 0) walls += !keep(i, j - 1) + !keep(i, j + 1) + !keep(i - 1, j) + !keep(i + 1, j);
  }
  const NV = nv + 2 * walls, pos = new Float32Array(NV * 3), cls = new Uint8Array(NV), src = new Uint32Array(NV), idx = NV > 65535 ? new Uint32Array(6 * (quads + walls)) : new Uint16Array(6 * (quads + walls));
  for (let j = 0, v = 0; j < n; j++) for (let i = 0; i < n; i++, v++) { pos[3 * v] = g.xs[i]; pos[3 * v + 1] = g.hs[v]; pos[3 * v + 2] = g.zs[j]; cls[v] = lu ? lu[v] : 0; src[v] = v; }
  let nx = nv, k = 0;
  const wall = (va, vb) => {
    for (const v of [va, vb]) { pos[3 * nx] = pos[3 * v]; pos[3 * nx + 1] = pos[3 * v + 1] - skirt; pos[3 * nx + 2] = pos[3 * v + 2]; cls[nx] = cls[v]; src[nx] = v; nx++; }
    idx[k++] = va; idx[k++] = vb; idx[k++] = nx - 2; idx[k++] = vb; idx[k++] = nx - 1; idx[k++] = nx - 2;
  };
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
    if (!keep(i, j)) continue;
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    if (skirt > 0) {
      if (!keep(i, j - 1)) wall(a, b);
      if (!keep(i, j + 1)) wall(d, c);
      if (!keep(i - 1, j)) wall(c, a);
      if (!keep(i + 1, j)) wall(b, d);
    }
  }
  return { pos, cls, src, idx };
}

// do two triangles [[x, z] x 3] overlap (separating axes)
function trisOverlap(A, B) {
  for (const T of [A, B]) for (let k = 0; k < 3; k++) {
    const p = T[k], q = T[(k + 1) % 3], nx = q[1] - p[1], nz = p[0] - q[0];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of A) { const t = v[0] * nx + v[1] * nz; a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
    for (const v of B) { const t = v[0] * nx + v[1] * nz; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
    if (a1 < b0 + 1e-6 || b1 < a0 + 1e-6) return false;
  }
  return true;
}
// Keep the ground under the roads: tris = [ax, ay, az, bx, by, bz, cx, cy, cz, ...] (a road's top surface); a grid point
// under a triangle goes no higher than it less `below`, one within `margin` metres of it no higher than the triangle's
// nearest point less `below`, plus `slope` for every metre past its edge (the ground's triangles are coarser than a path
// is wide: without this they poke up through it). Every corner of a ground triangle that overlaps a road triangle goes
// no higher than that road triangle's lowest corner less `below` (else a corner further up a cut slope lifts the
// triangle over the road's edge between them; cover: false leaves that out, for a trail draped on the ground). Lowers
// only. Returns how many points came down.
export function pushUnder(g, tris, opt) { return drain(pushUnderSteps(g, tris, opt)); }
// the same a slice at a time (a generator yielding every 500 triangles)
export function* pushUnderSteps(g, tris, { margin = 5.5, slope = 0.2, below = 0.08, cover = true } = {}) {
  if (g.hs === g.raw) g.hs = g.raw.slice();
  const s = g.segs, n = s + 1, hs = g.hs, lim = new Float32Array(n * n).fill(Infinity);
  const seg = (px, pz, ax, ay, az, bx, by, bz) => {
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / L2)) : 0;
    return [Math.hypot(px - ax - ex * t, pz - az - ez * t), ay + (by - ay) * t];
  };
  for (let k = 0; k + 8 < tris.length; k += 9) {
    if (k % 4500 === 4491) yield;
    const ax = tris[k], ay = tris[k + 1], az = tris[k + 2], bx = tris[k + 3], by = tris[k + 4], bz = tris[k + 5], cx = tris[k + 6], cy = tris[k + 7], cz = tris[k + 8];
    const [i0, j0] = gridIJ(g, Math.min(ax, bx, cx) - margin, Math.min(az, bz, cz) - margin), [i1, j1] = gridIJ(g, Math.max(ax, bx, cx) + margin, Math.max(az, bz, cz) + margin);
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    for (let j = Math.max(0, Math.ceil(Math.min(j0, j1))); j <= Math.min(s, Math.floor(Math.max(j0, j1))); j++) for (let i = Math.max(0, Math.ceil(Math.min(i0, i1))); i <= Math.min(s, Math.floor(Math.max(i0, i1))); i++) {
      const px = g.xs[i], pz = g.zs[j];
      let d = 0, h;
      const l1 = det ? ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det : -1, l2 = det ? ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det : -1, l3 = 1 - l1 - l2;
      if (l1 >= 0 && l2 >= 0 && l3 >= 0) h = l1 * ay + l2 * by + l3 * cy;
      else {
        let best = seg(px, pz, ax, ay, az, bx, by, bz);
        for (const e of [seg(px, pz, bx, by, bz, cx, cy, cz), seg(px, pz, cx, cy, cz, ax, ay, az)]) if (e[0] < best[0]) best = e;
        [d, h] = best; if (d > margin) continue;
      }
      const v = j * n + i, L = h - below + slope * Math.max(0, d - 0.3);
      if (L < lim[v]) lim[v] = L;
    }
    // the ground triangles over it (the mesh's: a c b and b c d of each quad)
    if (!cover) continue;
    const low = Math.min(ay, by, cy) - below, R = [[ax, az], [bx, bz], [cx, cz]];
    const [qi0, qj0] = gridIJ(g, Math.min(ax, bx, cx), Math.min(az, bz, cz)), [qi1, qj1] = gridIJ(g, Math.max(ax, bx, cx), Math.max(az, bz, cz));
    for (let j = Math.max(0, Math.floor(Math.min(qj0, qj1))); j <= Math.min(s - 1, Math.floor(Math.max(qj0, qj1))); j++) for (let i = Math.max(0, Math.floor(Math.min(qi0, qi1))); i <= Math.min(s - 1, Math.floor(Math.max(qi0, qi1))); i++) {
      const a = j * n + i, b = a + 1, c = a + n, d2 = c + 1, P = v => [g.xs[v % n], g.zs[Math.floor(v / n)]];
      for (const tri of [[a, c, b], [b, c, d2]]) if (trisOverlap(tri.map(P), R)) for (const v of tri) if (low < lim[v]) lim[v] = low;
    }
  }
  let moved = 0;
  for (let v = 0; v < n * n; v++) if (hs[v] > lim[v]) { hs[v] = lim[v]; moved++; }
  return moved;
}
