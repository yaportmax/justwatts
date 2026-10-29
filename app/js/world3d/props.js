// World 3D props: low-poly trees and bushes (one merged, vertex-coloured geometry per species, drawn instanced),
// what grows where, and building geometry from footprints.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { hash2 } from './landuse.js';

const col = (hex, f = 1) => { const c = new THREE.Color(hex); return [c.r * f, c.g * f, c.b * f]; };
// merge parts [geometry, colour, matrix] into one non-indexed geometry with a colour attribute
export function merge(parts) {
  const pos = [], nor = [], cl = [];
  for (const [g0, c, mtx] of parts) {
    const g = (g0.index ? g0.toNonIndexed() : g0.clone()); if (mtx) g.applyMatrix4(mtx); g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]);
      const k = 0.92 + 0.16 * hash2(Math.round(p[i] * 31), Math.round(p[i + 2] * 17 + p[i + 1] * 7));  // facets
      cl.push(c[0] * k, c[1] * k, c[2] * k);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
  out.computeBoundingSphere();
  return out;
}
const M = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz)), new THREE.Vector3(sx, sy, sz));
const bumpy = (g, amt, seed) => {  // shift the vertices a little so crowns are not perfect
  const p = g.attributes.position; const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, [hash2(i + seed, 3) - 0.5, hash2(i + seed, 7) - 0.5, hash2(i + seed, 11) - 0.5]);
    const d = seen.get(k); p.setXYZ(i, p.getX(i) + d[0] * amt, p.getY(i) + d[1] * amt, p.getZ(i) + d[2] * amt);
  }
  return g;
};

// unit-ish trees: about 1 m tall at scale 1 is not useful, so each is built at a typical size (metres) and scaled
export function treeGeometries(lo = false) {
  const trunk = c => [new THREE.CylinderGeometry(0.22, 0.32, 1, 5), col(c)];
  const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);
  if (lo) return {  // far away: one or two shapes each
    oak: merge([[bumpy(ico(3.4, 0), 0.8, 1), col(0x4c6630), M(0, 4.8, 0, 1.4, 0.8, 1.3)]]),
    bay: merge([[bumpy(ico(2.8, 0), 0.6, 4), col(0x3f5a2e), M(0, 6.5, 0, 1, 1.3, 1)]]),
    fir: merge([[new THREE.ConeGeometry(3.0, 15, 5), col(0x2e4c2b), M(0, 8, 0)]]),
    redwood: merge([[new THREE.ConeGeometry(3.0, 26, 5), col(0x27442c), M(0, 15, 0)]]),
    euc: merge([[bumpy(ico(3.2, 0), 1.0, 6), col(0x6f8a6a), M(0, 15, 0, 1, 1.6, 1)], [new THREE.CylinderGeometry(0.3, 0.45, 12, 4), col(0xc9bfae), M(0, 6, 0)]]),
    cypress: merge([[bumpy(ico(3.6, 0), 0.9, 9), col(0x2e472b), M(0, 4.6, 0, 1.7, 0.55, 1.2)]]),
    bush: merge([[bumpy(ico(1.0, 0), 0.3, 11), col(0x55663a), M(0, 0.55, 0, 1.3, 0.75, 1.2)]]),
  };
  return {
    // golden bunch grass and stones near the rider
    tuft: merge([0, 1, 2, 3, 4, 5].map(k => [new THREE.ConeGeometry(0.07, 0.42 + 0.12 * (k % 3), 3), col(0xd8c79a, 0.9 + 0.05 * (k % 3)),
      M(Math.cos(k * 2.4) * 0.12, 0.2, Math.sin(k * 2.4) * 0.12, 1, 1, 1, k, (k % 2 ? 1 : -1) * (0.25 + 0.06 * k))])),
    stone: merge([[bumpy(ico(0.45, 0), 0.15, 21), col(0x8d867a), M(0, 0.15, 0)]]),
    // coast live oak / bay laurel: a broad lumpy crown on a short trunk
    oak: merge([[trunk(0x5a4632)[0], col(0x5a4632), M(0, 1.6, 0, 1, 3.2, 1)],
      [bumpy(ico(3.2, 1), 0.9, 1), col(0x4c6630), M(0, 5.2, 0, 1.35, 0.8, 1.2)],
      [bumpy(ico(2.2, 0), 0.6, 2), col(0x55703a), M(1.9, 4.6, 0.8, 1, 0.8, 1)],
      [bumpy(ico(2.0, 0), 0.6, 3), col(0x45602c), M(-1.8, 4.4, -0.9, 1, 0.8, 1)]]),
    bay: merge([[trunk(0x4d3d2c)[0], col(0x4d3d2c), M(0, 2, 0, 0.9, 4, 0.9)],
      [bumpy(ico(2.6, 1), 0.7, 4), col(0x3f5a2e), M(0, 6.5, 0, 1, 1.25, 1)],
      [bumpy(ico(2.0, 0), 0.6, 5), col(0x48633a), M(0.8, 8.6, 0.3, 1, 1.1, 1)]]),
    // Douglas fir: stacked cones
    fir: merge([[trunk(0x4a3626)[0], col(0x4a3626), M(0, 2, 0, 1, 4, 1)],
      [new THREE.ConeGeometry(3.2, 7, 7), col(0x2c4a2a), M(0, 6.5, 0)],
      [new THREE.ConeGeometry(2.5, 6, 7), col(0x31522d), M(0, 10.5, 0)],
      [new THREE.ConeGeometry(1.7, 5, 6), col(0x37592f), M(0, 14, 0)]]),
    // redwood: a tall red trunk, a narrow spire
    redwood: merge([[new THREE.CylinderGeometry(0.5, 0.9, 1, 6), col(0x7a4430), M(0, 6, 0, 1, 12, 1)],
      [new THREE.ConeGeometry(3.0, 10, 7), col(0x24402a), M(0, 14, 0)],
      [new THREE.ConeGeometry(2.4, 9, 7), col(0x2a4a2e), M(0, 20, 0)],
      [new THREE.ConeGeometry(1.6, 8, 6), col(0x2f5032), M(0, 26, 0)]]),
    // eucalyptus: a tall pale trunk, loose blue-grey crowns
    euc: merge([[new THREE.CylinderGeometry(0.28, 0.45, 1, 5), col(0xc9bfae), M(0, 9, 0, 1, 18, 1, 0, 0.04)],
      [bumpy(ico(2.6, 0), 1.0, 6), col(0x6f8a6a), M(0.6, 18, 0.3, 1.1, 1.4, 1)],
      [bumpy(ico(2.0, 0), 0.8, 7), col(0x7a9473), M(-1.2, 14.5, -0.4, 1, 1.3, 1)],
      [bumpy(ico(1.8, 0), 0.8, 8), col(0x67825f), M(1.4, 12.5, 0.9, 1, 1.2, 1)]]),
    // Monterey cypress: wind-flattened, wide and dark
    cypress: merge([[trunk(0x4d3a2a)[0], col(0x4d3a2a), M(0, 1.6, 0, 1.4, 3.2, 1.4, 0, 0.12)],
      [bumpy(ico(3.4, 0), 0.9, 9), col(0x2e472b), M(1.0, 5.2, 0, 1.7, 0.55, 1.2)],
      [bumpy(ico(2.6, 0), 0.8, 10), col(0x34502f), M(-1.8, 4.6, 0.6, 1.5, 0.5, 1.1)]]),
    // coyote brush and other coastal scrub
    bush: merge([[bumpy(ico(1.0, 0), 0.35, 11), col(0x55663a), M(0, 0.55, 0, 1.3, 0.75, 1.2)],
      [bumpy(ico(0.7, 0), 0.25, 12), col(0x63733f), M(0.7, 0.45, 0.3, 1, 0.7, 1)]]),
  };
}

// which tree grows here: k ground class, lt leaf type, h height, lat/lon, r a random 0..1
const REDWOODS = [[37.885, -122.59, 37.905, -122.565], [38.0, -122.76, 38.035, -122.69], [37.89, -122.555, 37.915, -122.53], [37.96, -122.67, 37.99, -122.62]];
export function species(k, lt, h, lat, lon, r) {
  if (k === 'scrub') return r < 0.94 ? 'bush' : 'cypress';
  if (k === 'wood') {
    if (REDWOODS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e) && h < 350) return r < 0.7 ? 'redwood' : r < 0.85 ? 'bay' : 'fir';
    if (lt === 'n') return r < 0.75 ? 'fir' : 'redwood';
    const coast = h < 140 && lon < -122.47 && lat < 37.92;
    if (coast && r < 0.35) return 'euc';
    if (coast && r < 0.5) return 'cypress';
    if (h > 320 && lt !== 'b') return r < 0.45 ? 'fir' : r < 0.8 ? 'oak' : 'bay';
    return r < 0.5 ? 'oak' : r < 0.82 ? 'bay' : lt === 'b' ? 'euc' : 'fir';
  }
  if (k === 'park' || k === 'urban') return r < 0.5 ? 'oak' : r < 0.75 ? 'euc' : 'bay';
  return 'oak';  // lone oaks on the open hills
}

// the footprint's oriented box (along its longest edge): centre, direction, length, width, area
function orientedBox(r) {
  let best = null;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (!best || l > best.l) best = { l, u: [(q[0] - p[0]) / l, (q[1] - p[1]) / l] }; }
  const [ux, uz] = best.u; let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const [x, z] of r) { const s = x * ux + z * uz, t = -x * uz + z * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
  const sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
  return { c: [ux * sc - uz * tc, uz * sc + ux * tc], u: [ux, uz], L: s1 - s0, W: t1 - t0, area: (s1 - s0) * (t1 - t0) };
}
// buildings: walls and a flat roof from footprints in local metres; base: lowest ground under the corners
const WALLS = [0xf6f1e6, 0xf0e2c4, 0xe3ddd0, 0xf6e3b0, 0xd2e0d0, 0xd4e2ee, 0xf0d2bc, 0xd9cbb4, 0xfaf7f0, 0xe8cfa0, 0xc8d8c4, 0xf2c9a8];
const ROOFS = [0x5b5a58, 0x6e6a64, 0x9a5a40, 0x4d4f52, 0x7a746a, 0x8c4a38];
export function buildingGeometry(list) {
  // list: [{ ring: [[x, z], ...] closed, base, h, seed }]
  const pos = [], cl = [];
  const tri = (a, b, c, k) => { pos.push(...a, ...b, ...c); cl.push(...k, ...k, ...k); };
  for (const b of list) {
    let r = b.ring.slice(0, -1); if (r.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(r.map(p => new THREE.Vector2(p[0], p[1])))) r = r.reverse();
    const top = b.base + b.h, wc = col(WALLS[Math.floor(hash2(b.seed, 1) * WALLS.length)]), rc = col(ROOFS[Math.floor(hash2(b.seed, 2) * ROOFS.length)]);
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length], f = 0.86 + 0.14 * hash2(b.seed, i), k = [wc[0] * f, wc[1] * f, wc[2] * f];
      const A = [p[0], b.base - 1, p[1]], B = [q[0], b.base - 1, q[1]], C = [q[0], top, q[1]], D = [p[0], top, p[1]];
      tri(A, C, B, k); tri(A, D, C, k);
    }
    const tris = THREE.ShapeUtils.triangulateShape(r.map(p => new THREE.Vector2(p[0], p[1])), []);
    for (const [a, b2, c] of tris) tri([r[a][0], top, r[a][1]], [r[c][0], top, r[c][1]], [r[b2][0], top, r[b2][1]], rc);
    const ob = b.h <= 10 && r.length <= 8 ? orientedBox(r) : null;
    if (ob && ob.area < 400) {  // a house: a gable roof along its long side, a little over the walls
      const { c: [cx, cz], u: [ux, uz], L, W: w } = ob, rh = Math.min(3.2, w * 0.38), o = 0.4, P = (s, t, y) => [cx + ux * s - uz * t, y, cz + uz * s + ux * t];
      const a1 = P(-L / 2 - o, -w / 2 - o, top), a2 = P(L / 2 + o, -w / 2 - o, top), b1 = P(-L / 2 - o, w / 2 + o, top), b2 = P(L / 2 + o, w / 2 + o, top), r1 = P(-L / 2 - o, 0, top + rh), r2 = P(L / 2 + o, 0, top + rh);
      tri(a1, r1, a2, rc); tri(a2, r1, r2, rc); tri(b1, b2, r1, rc); tri(b2, r2, r1, rc);
      const e1 = P(-L / 2, -w / 2, top), e2 = P(-L / 2, w / 2, top), e3 = P(-L / 2, 0, top + rh), f1 = P(L / 2, -w / 2, top), f2 = P(L / 2, w / 2, top), f3 = P(L / 2, 0, top + rh);
      tri(e1, e2, e3, wc); tri(f1, f3, f2, wc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
  g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}
