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
// pts: [[x, z, h], ...] in order along the road. under: other roads [{ pts, r0, r1 }] flattened first (each road
// level across, so no hump of ground shows through it); the ridden road wins where they meet.
export function carve(g, pts, r0, r1, under = null) {
  const base = under?.length ? blend(g, g.raw, under, false).hs : g.raw;
  const r = blend(g, base, [{ pts, r0, r1 }], true);
  if (under?.length) for (let v = 0; v < r.cut.length; v++) if (Math.abs(r.hs[v] - g.raw[v]) > 0.8) r.cut[v] = 1;
  g.hs = r.hs; g.cut = r.cut;
  return r.touched;
}
function blend(g, from, lines, check) {
  const s = g.segs, n = s + 1, best = new Float32Array(n * n).fill(Infinity), bh = new Float32Array(n * n), raw = g.raw, fade = new Float32Array(n * n);
  const x0 = g.xs[0], dx = (g.xs[s] - g.xs[0]) / s, z0 = g.zs[0], dz = (g.zs[s] - g.zs[0]) / s;
  let touched = false;
  for (const { pts, r0, r1 } of lines) {
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
        const f = d <= r0 ? 1 : 1 - (d - r0) / (r1 - r0);
        if (f > fade[v] || (f === fade[v] && d < best[v])) { fade[v] = f; best[v] = d; bh[v] = p[2] + (q[2] - p[2]) * t; touched = true; }
      }
    }
  }
  const hs = from.slice(), cut = new Uint8Array(n * n);
  if (touched) for (let v = 0; v < n * n; v++) {
    const t = fade[v]; if (!t) continue;
    const w = t * t * (3 - 2 * t);
    hs[v] = from[v] + (bh[v] - from[v]) * w;
    if (Math.abs(hs[v] - raw[v]) > 0.8) cut[v] = 1;
  }
  return { hs, cut, touched };
}

// Ground classes per vertex (0: none, else KINDS index + 1; the higher class wins) from features { k, rings: [[lat, lon]] }
export function rasterClasses(g, features) {
  const s = g.segs, n = s + 1, lu = new Uint8Array(n * n);
  for (const f of features) {
    const c = KINDS.indexOf(f.k) + 1; if (c <= 0 || f.k === 'building') continue;
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
export function gridMesh(g, { lu = null, skip = null, skirt = 0 } = {}) {
  const s = g.segs, n = s + 1, nv = n * n;
  const pos = [], cls = [], idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { pos.push(g.xs[i], g.hs[j * n + i], g.zs[j]); cls.push(lu ? lu[j * n + i] : 0); }
  const keep = (i, j) => i >= 0 && j >= 0 && i < s && j < s && !(skip && skip(i, j));
  let nx = nv;
  const wall = (va, vb) => {
    for (const v of [va, vb]) { pos.push(pos[3 * v], pos[3 * v + 1] - skirt, pos[3 * v + 2]); cls.push(cls[v]); }
    idx.push(va, vb, nx, vb, nx + 1, nx); nx += 2;
  };
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
    if (!keep(i, j)) continue;
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
    if (skirt > 0) {
      if (!keep(i, j - 1)) wall(a, b);
      if (!keep(i, j + 1)) wall(c, d);
      if (!keep(i - 1, j)) wall(a, c);
      if (!keep(i + 1, j)) wall(b, d);
    }
  }
  return { pos: new Float32Array(pos), cls: new Uint8Array(cls), idx: nx > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
}
