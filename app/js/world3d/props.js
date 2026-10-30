// World 3D props: low-poly trees and shrubs (one merged, vertex-coloured geometry per species, drawn instanced) with
// soft crown normals and the shade inside a crown baked into the colours, what grows where, and buildings from
// footprints (windows by the atlas, gable and hip roofs, parapets).
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { hash2 } from './landuse.js';

const col = (hex, f = 1) => { const c = new THREE.Color(hex); return [c.r * f, c.g * f, c.b * f]; };
// merge parts [geometry, colour, matrix, opts] into one non-indexed geometry with a colour attribute. opts.soft:
// a crown centre [x, y, z]: normals lean out from it (foliage reads as a soft mass, not facets); opts.shade: darker
// toward the bottom of [y0, y1] (the inside of a crown, the foot of a trunk)
export function merge(parts) {
  const pos = [], nor = [], cl = [];
  for (const [g0, c, mtx, o = {}] of parts) {
    const g = (g0.index ? g0.toNonIndexed() : g0.clone()); if (mtx) g.applyMatrix4(mtx); g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      let nx = n[i], ny = n[i + 1], nz = n[i + 2];
      if (o.soft) {
        let sx = p[i] - o.soft[0], sy = (p[i + 1] - o.soft[1]) * 0.8, sz = p[i + 2] - o.soft[2]; const l = Math.hypot(sx, sy, sz) || 1;
        sx /= l; sy /= l; sz /= l; nx = nx * 0.3 + sx * 0.7; ny = ny * 0.3 + sy * 0.7 + 0.15; nz = nz * 0.3 + sz * 0.7;
        const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m;
      }
      pos.push(p[i], p[i + 1], p[i + 2]); nor.push(nx, ny, nz);
      let k = 0.9 + 0.2 * hash2(Math.round(p[i] * 31), Math.round(p[i + 2] * 17 + p[i + 1] * 7));
      if (o.shade) k *= 0.7 + 0.42 * Math.max(0, Math.min(1, (p[i + 1] - o.shade[0]) / (o.shade[1] - o.shade[0])));
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
const M = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0, rz = 0, rx = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
const bumpy = (g, amt, seed) => {  // shift the vertices a little so crowns are not perfect
  const p = g.attributes.position; const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, [hash2(i + seed, 3) - 0.5, hash2(i + seed, 7) - 0.5, hash2(i + seed, 11) - 0.5]);
    const d = seen.get(k); p.setXYZ(i, p.getX(i) + d[0] * amt, p.getY(i) + d[1] * amt, p.getZ(i) + d[2] * amt);
  }
  return g;
};
// a branchy crown: lumps round a centre, each a bumpy icosahedron, normals soft about the centre
function crown(cx, cy, cz, rx, ry, rz, n, seed, c, lump = 0.55, detail = 1, c2 = null) {
  const parts = [];
  for (let k = 0; k < n; k++) {
    const a = hash2(seed, k) * 6.283, e = (hash2(k, seed) - 0.35) * 1.2, r = k ? 0.55 + 0.35 * hash2(k + 9, seed) : 0;
    const x = cx + Math.cos(a) * Math.cos(e) * rx * r, y = cy + Math.sin(e) * ry * r, z = cz + Math.sin(a) * Math.cos(e) * rz * r;
    const s = (k ? lump : 0.75) * (0.85 + 0.3 * hash2(seed + 3, k));
    parts.push([bumpy(new THREE.IcosahedronGeometry(1, detail), 0.28, seed * 13 + k), k % 3 === 2 && c2 ? c2 : c, M(x, y, z, rx * s, ry * s, rz * s, a),
      { soft: [cx, cy, cz], shade: [cy - ry, cy + ry * 0.8] }]);
  }
  return parts;
}
const trunkG = (r0, r1, h, s = 6) => new THREE.CylinderGeometry(r1, r0, h, s, 1).translate(0, h / 2, 0);
const limb = (x0, y0, z0, x1, y1, z1, r, c) => {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return [new THREE.CylinderGeometry(r * 0.6, r, L, 5, 1).translate(0, L / 2, 0), c, new THREE.Matrix4().compose(new THREE.Vector3(x0, y0, z0), q, new THREE.Vector3(1, 1, 1)), { shade: [0, y1] }];
};
// conifer tiers: drooping skirts from y0 to y1, radius r0 at the bottom to r1 at the top
function tiers(y0, y1, r0, r1, n, c, seed, segs = 8) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1), y = y0 + (y1 - y0) * f, r = r0 + (r1 - r0) * f, h = (y1 - y0) / n * 1.9;
    const g = bumpy(new THREE.ConeGeometry(r, h, segs, 2, true), r * 0.12, seed + k);
    out.push([g, c, M(0, y + h / 2, 0, 1, 1, 1, hash2(seed, k) * 3), { soft: [0, y + h * 0.2, 0], shade: [y - h * 0.4, y + h] }]);
  }
  return out;
}

// trees at a typical size in metres (scaled per instance)
export function treeGeometries(lo = false) {
  const bark = col(0x5a4632), barkD = col(0x463728), red = col(0x7e4630), pale = col(0xcfc4b0);
  const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);
  if (lo) return {  // further away: a few shapes each, the same silhouettes
    oak: merge([[trunkG(0.4, 0.3, 3, 4), bark, null], [bumpy(ico(1, 1), 0.2, 1), col(0x4a6230), M(0, 5.2, 0, 4.6, 2.9, 4.2), { soft: [0, 5, 0], shade: [2.5, 7] }]]),
    bay: merge([[trunkG(0.35, 0.25, 3, 4), bark, null], [bumpy(ico(1, 1), 0.2, 4), col(0x3d5a2d), M(0, 6.8, 0, 3.4, 4.2, 3.3), { soft: [0, 6.5, 0], shade: [3, 10] }]]),
    fir: merge([[new THREE.ConeGeometry(3.4, 17, 6), col(0x2b4729), M(0, 9.5, 0), { soft: [0, 7, 0], shade: [1, 17] }]]),
    redwood: merge([[trunkG(0.9, 0.5, 14, 5), red, null], [new THREE.ConeGeometry(3.4, 26, 6), col(0x26412b), M(0, 21, 0), { soft: [0, 18, 0], shade: [8, 34] }]]),
    euc: merge([[trunkG(0.45, 0.25, 14, 4), pale, null], [bumpy(ico(1, 1), 0.3, 6), col(0x6c8768), M(0.4, 16, 0, 4, 5.5, 3.6), { soft: [0, 16, 0], shade: [11, 21] }]]),
    cypress: merge([[trunkG(0.6, 0.4, 3.5, 4), barkD, M(0, 0, 0, 1, 1, 1, 0, 0.15)], [bumpy(ico(1, 1), 0.2, 9), col(0x2c452a), M(0.6, 5.4, 0, 6, 2.2, 4.5), { soft: [0, 5, 0], shade: [3.5, 7] }]]),
    pine: merge([[trunkG(0.45, 0.3, 8, 4), barkD, null], [bumpy(ico(1, 1), 0.25, 14), col(0x2f4a2b), M(0, 11, 0, 4.2, 3.6, 4), { soft: [0, 11, 0], shade: [7.5, 14] }]]),
    bush: merge([[bumpy(ico(1, 1), 0.25, 11), col(0x5c6b3c), M(0, 0.5, 0, 1.6, 0.7, 1.4), { soft: [0, 0.3, 0], shade: [0, 1.2] }]]),
  };
  return {
    stone: merge([[bumpy(ico(0.45, 1), 0.12, 21), col(0x8d867a), M(0, 0.12, 0, 1, 0.6, 1)]]),
    // coast live oak: a short leaning trunk forking into limbs, a broad lumpy dome
    oak: merge([[trunkG(0.42, 0.3, 2.4, 6), bark, M(0, 0, 0, 1, 1, 1, 0, 0.08)],
      limb(0.15, 2.2, 0, 2.2, 4.4, 0.6, 0.26, bark), limb(0.1, 2.2, 0, -1.8, 4.6, -0.8, 0.24, bark), limb(0.1, 2.3, 0, 0.2, 5.2, 1.6, 0.2, bark),
      ...crown(0.2, 5.4, 0, 3.5, 1.9, 3.2, 7, 1, col(0x4a6230), 0.55, 1, col(0x55703a))]),
    // California bay laurel: dense, taller than wide, glossy dark
    bay: merge([[trunkG(0.36, 0.26, 3.5, 6), barkD, null], limb(0, 3, 0, 1.2, 6, 0.4, 0.2, barkD), limb(0, 3, 0, -1, 6.4, -0.3, 0.18, barkD),
      ...crown(0, 7, 0, 2.7, 3.4, 2.6, 7, 4, col(0x3d5a2d), 0.6, 1, col(0x48633a))]),
    // Douglas fir: drooping tiers to a spire
    fir: merge([[trunkG(0.42, 0.2, 4, 6), barkD, null], ...tiers(3.2, 16.5, 3.6, 0.7, 6, col(0x2b4729), 30), [new THREE.ConeGeometry(0.6, 2.4, 5), col(0x355a31), M(0, 18.4, 0)]]),
    // coast redwood: a tall fluted red trunk, short branches high up, a narrow spire
    redwood: merge([[trunkG(1.0, 0.45, 22, 7), red, null], ...tiers(10, 31, 3.6, 0.8, 8, col(0x26412b), 40), [new THREE.ConeGeometry(0.7, 3, 5), col(0x2f5032), M(0, 33, 0)]]),
    // blue gum eucalyptus: a tall pale trunk leaning a little, loose blue-grey clumps hanging off high limbs
    euc: merge([[trunkG(0.5, 0.22, 17, 6), pale, M(0, 0, 0, 1, 1, 1, 0, 0.05)],
      limb(0.5, 11, 0, 2.6, 15.5, 0.8, 0.2, pale), limb(0.4, 12, 0, -2.2, 16.2, -0.6, 0.18, pale), limb(0.7, 14, 0, 0.6, 18.5, 1.6, 0.16, pale),
      ...crown(2.8, 15.6, 0.8, 2.2, 2.2, 2.0, 3, 6, col(0x6c8768), 0.6), ...crown(-2.3, 16.4, -0.6, 2.0, 2.4, 1.9, 3, 7, col(0x7a9473), 0.6),
      ...crown(0.6, 18.8, 1.4, 2.0, 2.0, 1.8, 3, 8, col(0x67825f), 0.6)]),
    // Monterey cypress: wind-flattened tables on a crooked trunk, wide and dark
    cypress: merge([[trunkG(0.6, 0.4, 3.2, 6), barkD, M(0, 0, 0, 1, 1, 1, 0, 0.18)], limb(0.4, 2.8, 0, 3.0, 4.6, 0.3, 0.26, barkD), limb(0.3, 2.9, 0, -2.6, 4.0, 0.5, 0.24, barkD),
      ...crown(2.6, 5.0, 0.2, 3.4, 1.1, 2.6, 4, 9, col(0x2c452a), 0.6), ...crown(-2.4, 4.4, 0.4, 3.0, 1.0, 2.4, 4, 10, col(0x34502f), 0.6),
      ...crown(0.2, 6.0, -0.3, 2.6, 0.9, 2.2, 3, 12, col(0x2f4a2d), 0.6)]),
    // Monterey / bishop pine: a rounded, irregular dark crown high on a bare trunk
    pine: merge([[trunkG(0.45, 0.28, 9, 6), barkD, null], limb(0, 7.5, 0, 2, 10, 0.5, 0.18, barkD), limb(0, 8, 0, -1.6, 10.6, -0.4, 0.16, barkD),
      ...crown(0, 11, 0, 3.6, 2.4, 3.4, 6, 14, col(0x2f4a2b), 0.55)]),
    // coyote brush and other coastal scrub: low, irregular mounds, sun-bleached on top
    bush: merge([...crown(0, 0.55, 0, 1.5, 0.6, 1.3, 6, 11, col(0x5c6b3c), 0.55, 1, col(0x6b7845)), ...crown(0.9, 0.4, 0.5, 0.8, 0.45, 0.7, 3, 16, col(0x56653a), 0.6, 0)]),
    // toyon / manzanita: a taller shrub with a reddish base
    shrub: merge([limb(0, 0, 0, 0.3, 1.2, 0.1, 0.08, col(0x7a3e2c)), limb(0, 0, 0, -0.4, 1.1, 0.2, 0.07, col(0x7a3e2c)),
      ...crown(0, 1.7, 0, 1.4, 1.1, 1.3, 5, 15, col(0x3f5530), 0.6, 1, col(0x4a5f35))]),
  };
}

// which tree grows here: k ground class, lt leaf type, h height, lat/lon, r a random 0..1
const REDWOODS = [[37.885, -122.59, 37.905, -122.565], [38.0, -122.76, 38.035, -122.69], [37.89, -122.555, 37.915, -122.53], [37.96, -122.67, 37.99, -122.62]];
export function species(k, lt, h, lat, lon, r) {
  if (k === 'scrub') return r < 0.75 ? 'bush' : r < 0.94 ? 'shrub' : 'cypress';
  if (k === 'wood') {
    if (REDWOODS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e) && h < 350) return r < 0.7 ? 'redwood' : r < 0.85 ? 'bay' : 'fir';
    if (lt === 'n') return r < 0.6 ? 'fir' : r < 0.8 ? 'pine' : 'redwood';
    const coast = h < 140 && lon < -122.47 && lat < 37.92;
    if (coast && r < 0.35) return 'euc';
    if (coast && r < 0.5) return 'cypress';
    if (h > 320 && lt !== 'b') return r < 0.45 ? 'fir' : r < 0.8 ? 'oak' : 'bay';
    return r < 0.5 ? 'oak' : r < 0.82 ? 'bay' : lt === 'b' ? 'euc' : 'fir';
  }
  if (k === 'park' || k === 'urban') return r < 0.4 ? 'oak' : r < 0.6 ? 'euc' : r < 0.8 ? 'bay' : 'pine';
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
// Marin colours: whites and creams, butter yellow, sage, sky blue, blush, brown shingle; roofs: terracotta, slate,
// weathered shake, grey composition
const WALLS = [0xf4efe4, 0xf0e2c4, 0xe6dfd1, 0xf3e0a8, 0xcbd9c4, 0xcfdfec, 0xefd3c0, 0xd9cbb4, 0xfaf7f0, 0xe6cb98, 0xb9ccb6, 0xf0c6a4, 0x9c7a5c, 0x8a6a4e];
const ROOFS = [0x55534f, 0x6b665e, 0xa4583c, 0x46484b, 0x786f62, 0x93503a, 0x5e4a3a];
// style (window atlas column + 4 * row): houses 0 sash, 1 shutters, 3 pairs, 5 siding, 7 arched; flats 0, 3, 4; shops
// and offices 2, 6
const HOUSE = [0, 1, 3, 5, 5, 7, 0, 3], FLATS = [0, 3, 4, 4, 1], BIG = [2, 6, 2, 4];
// list: [{ ring: [[x, z], ...] closed, base, h, seed }] -> geometry with position, colour, bw [along, up, style, kind]
export function buildingGeometry(list) {
  const pos = [], cl = [], bw = [];
  const tri = (a, b, c, k, w) => { pos.push(...a, ...b, ...c); cl.push(...k, ...k, ...k); bw.push(...w[0], ...w[1], ...w[2]); };
  for (const b of list) {
    let r = b.ring.slice(0, -1); if (r.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(r.map(p => new THREE.Vector2(p[0], p[1])))) r = r.reverse();
    const top = b.base + b.h, wi = Math.floor(hash2(b.seed, 1) * WALLS.length), wc = col(WALLS[wi]), rc = col(ROOFS[Math.floor(hash2(b.seed, 2) * ROOFS.length)]);
    const ob = orientedBox(r), house = b.h <= 10 && r.length <= 10 && ob.area < 450;
    const style = wi >= 12 ? 5 : (house ? HOUSE : b.h > 16 || ob.area > 1500 ? BIG : FLATS)[Math.floor(hash2(b.seed, 5) * 8) % (house ? 8 : 4)];
    let run = hash2(b.seed, 6) * 3;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]), f = 0.9 + 0.1 * hash2(b.seed, i), k = [wc[0] * f, wc[1] * f, wc[2] * f];
      const A = [p[0], b.base - 1, p[1]], B = [q[0], b.base - 1, q[1]], C = [q[0], top, q[1]], D = [p[0], top, p[1]];
      const a = [run, -1, style, 0], bb = [run + L, -1, style, 0], c = [run + L, b.h, style, 0], d = [run, b.h, style, 0];
      tri(A, C, B, k, [a, c, bb]); tri(A, D, C, k, [a, d, c]);
      run += L;
    }
    const flat = (y, k, kind) => {
      const tris = THREE.ShapeUtils.triangulateShape(r.map(p => new THREE.Vector2(p[0], p[1])), []);
      for (const [a, b2, c] of tris) tri([r[a][0], y, r[a][1]], [r[c][0], y, r[c][1]], [r[b2][0], y, r[b2][1]], k, [[r[a][0], r[a][1], 0, kind], [r[c][0], r[c][1], 0, kind], [r[b2][0], r[b2][1], 0, kind]]);
    };
    if (house) {
      // a gable roof along the long side, or a hip roof on a squarish house, a little over the walls
      const { c: [cx, cz], u: [ux, uz], L, W: w } = ob, rh = Math.min(3.4, w * 0.4), o = 0.45, P = (s, t, y) => [cx + ux * s - uz * t, y, cz + uz * s + ux * t];
      const hip = L < w * 1.35 || hash2(b.seed, 8) < 0.3, inset = hip ? Math.min(L / 2, w / 2) : 0;
      const a1 = P(-L / 2 - o, -w / 2 - o, top - 0.15), a2 = P(L / 2 + o, -w / 2 - o, top - 0.15), b1 = P(-L / 2 - o, w / 2 + o, top - 0.15), b2 = P(L / 2 + o, w / 2 + o, top - 0.15);
      const r1 = P(-L / 2 + inset, 0, top + rh), r2 = P(L / 2 - inset, 0, top + rh), sl = Math.hypot(w / 2 + o, rh);
      const R = (s, y) => [s, y, 0, 1];
      tri(a1, r1, a2, rc, [R(0, 0), R(inset, sl), R(L + 2 * o, 0)]); tri(a2, r1, r2, rc, [R(L + 2 * o, 0), R(inset, sl), R(L - inset, sl)]);
      tri(b1, b2, r1, rc, [R(0, 0), R(L + 2 * o, 0), R(inset, sl)]); tri(b2, r2, r1, rc, [R(L + 2 * o, 0), R(L - inset, sl), R(inset, sl)]);
      if (hip) { tri(a1, b1, r1, rc, [R(0, 0), R(w + 2 * o, 0), R(w / 2, sl)]); tri(b2, a2, r2, rc, [R(0, 0), R(w + 2 * o, 0), R(w / 2, sl)]); }
      else {
        const e1 = P(-L / 2, -w / 2, top), e2 = P(-L / 2, w / 2, top), e3 = P(-L / 2, 0, top + rh), f1 = P(L / 2, -w / 2, top), f2 = P(L / 2, w / 2, top), f3 = P(L / 2, 0, top + rh);
        const G = [0, 0, 0, 2]; tri(e1, e2, e3, wc, [G, G, G]); tri(f1, f3, f2, wc, [G, G, G]);
      }
      flat(top, wc, 2);  // the ceiling under the eaves (closes the box)
    } else {
      // a flat roof inside a parapet
      flat(top + 0.05, col(0x8c8a86, 0.9 + 0.2 * hash2(b.seed, 9)), 2);
      const pc = col(0xd8d4cc);
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length], G = [0, 0, 0, 2];
        tri([p[0], top, p[1]], [q[0], top + 0.7, q[1]], [q[0], top, q[1]], pc, [G, G, G]); tri([p[0], top, p[1]], [p[0], top + 0.7, p[1]], [q[0], top + 0.7, q[1]], pc, [G, G, G]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
  g.setAttribute('bw', new THREE.Float32BufferAttribute(bw, 4));
  g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}
