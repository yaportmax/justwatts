// World 3D props: trees and shrubs (one merged, vertex-coloured geometry per species, drawn instanced): bark on trunks
// and limbs, crowns of leaf cards (alpha-tested quads with the leaf atlas, tex.js) lit with soft normals from the
// crown's middle and darker inside, what grows where, and buildings from footprints (windows by the atlas, gable,
// hip, gambrel and shed roofs, porches, chimneys, parapets and roof boxes).
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { hash2 } from './landuse.js';
import { LEAF, leafCell } from './tex.js';

const col = (hex, f = 1) => { const c = new THREE.Color(hex); return [c.r * f, c.g * f, c.b * f]; };
// merge parts [geometry, colour, matrix, opts] into one non-indexed geometry with colour and uv attributes. opts.soft:
// a crown centre [x, y, z]: normals lean out from it (foliage reads as a soft mass, not facets); opts.shade: darker
// toward the bottom of [y0, y1] (the inside of a crown, the foot of a trunk); opts.cell: the geometry's own uv goes
// into that leaf atlas cell (else the plain cell); opts.card: the part's normals and uv are kept as they are (leaf
// cards), its `ao` attribute darkens it, its `sk` one (0 or 1) says which cards cast a shadow (the rest, the solid
// parts always); opts.tag: a number in the `tag` attribute (what a part is, for a material)
export function merge(parts) {
  const pos = [], nor = [], cl = [], uvs = [], sks = [], tags = [], plain = leafCell(LEAF.plain), pu = (plain[0] + plain[2]) / 2, pv = (plain[1] + plain[3]) / 2;
  for (const [g0, c, mtx, o = {}] of parts) {
    const g = (g0.index ? g0.toNonIndexed() : g0.clone()); if (mtx) g.applyMatrix4(mtx); if (!o.card) g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array, uv = g.attributes.uv?.array, ao = g.attributes.ao?.array, sk = g.attributes.sk?.array, cell = o.cell != null ? leafCell(o.cell) : null;
    for (let i = 0, v = 0; i < p.length; i += 3, v++) {
      let nx = n[i], ny = n[i + 1], nz = n[i + 2];
      if (o.soft) {
        let sx = p[i] - o.soft[0], sy = (p[i + 1] - o.soft[1]) * 0.8, sz = p[i + 2] - o.soft[2]; const l = Math.hypot(sx, sy, sz) || 1;
        sx /= l; sy /= l; sz /= l; nx = nx * 0.3 + sx * 0.7; ny = ny * 0.3 + sy * 0.7 + 0.15; nz = nz * 0.3 + sz * 0.7;
        const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m;
      }
      pos.push(p[i], p[i + 1], p[i + 2]); nor.push(nx, ny, nz); sks.push(sk ? sk[v] : 1); tags.push(o.tag || 0);
      if (o.card) uvs.push(uv[2 * v], uv[2 * v + 1]);
      else if (cell && uv) uvs.push(cell[0] + (cell[2] - cell[0]) * uv[2 * v], cell[1] + (cell[3] - cell[1]) * (1 - uv[2 * v + 1]));
      else uvs.push(pu, pv);
      let k = (o.card ? 1 : 0.9 + 0.2 * hash2(Math.round(p[i] * 31), Math.round(p[i + 2] * 17 + p[i + 1] * 7))) * (ao ? ao[v] : 1);
      if (o.shade) k *= 0.7 + 0.42 * Math.max(0, Math.min(1, (p[i + 1] - o.shade[0]) / (o.shade[1] - o.shade[0])));
      cl.push(c[0] * k, c[1] * k, c[2] * k);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setAttribute('sk', new THREE.Float32BufferAttribute(sks, 1));
  out.setAttribute('tag', new THREE.Float32BufferAttribute(tags, 1));
  out.computeBoundingSphere(); out.computeBoundingBox();
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

/* ---------- leaf cards ---------- */
// A geometry of quads: each [centre, along (image right), up (image up), half length, half height, atlas cell, flip,
// soft centre, r, the image's rows used ([top, bottom] shares, default all)];
// normals soft round an axis point (the crown's middle at that height) with a little of the card's own facing, ao
// darker toward the inside of the crown (r: 0 at the middle .. 1 at its edge); about one card in five casts a shadow.
function quads(list, soft) {
  const P = [], N = [], U = [], A = [], K = [];
  for (const [c, t, b, hl, hh, k, flip, sc, r, rows = [0, 1]] of list) {
    const [u0, c0, u1, c1] = leafCell(k), v0 = c0 + (c1 - c0) * rows[0], v1 = c0 + (c1 - c0) * rows[1], fn = new THREE.Vector3().crossVectors(t, b).normalize(), s = soft(c, sc);
    const n = s.multiplyScalar(0.78).addScaledVector(fn, 0.22 * (fn.dot(s) < 0 ? -1 : 1)).add(new THREE.Vector3(0, 0.12, 0)).normalize();
    const ao = 0.62 + 0.38 * Math.min(1, r), a = flip ? [u1, u0] : [u0, u1], sk = hash2(Math.round(c.x * 97), Math.round(c.y * 89 + c.z * 83)) < 0.22 ? 1 : 0;
    const corner = (x, y) => P.push(c.x + t.x * hl * x + b.x * hh * y, c.y + t.y * hl * x + b.y * hh * y, c.z + t.z * hl * x + b.z * hh * y);
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
      corner(x, y); N.push(n.x, n.y, n.z); U.push(x < 0 ? a[0] : a[1], y < 0 ? v1 : v0); A.push(ao); K.push(sk);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setAttribute('ao', new THREE.Float32BufferAttribute(A, 1)); g.setAttribute('sk', new THREE.Float32BufferAttribute(K, 1));
  return g;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z), UP = V(0, 1, 0);
// the card's image-up: world up across the card plane, or any line in it when it lies flat
const upIn = n => { const b = UP.clone().addScaledVector(n, -n.y); return b.lengthSq() > 0.02 ? b.normalize() : V(1, 0, 0).addScaledVector(n, -n.x).normalize(); };
// cards in an ellipsoid crown round (cx, cy, cz), radii rx, ry, rz: `size` metres across, facing mostly outward (out),
// tilted up (lift) or left hanging (hang: their image-up stays near vertical)
function crownCards(cx, cy, cz, rx, ry, rz, n, size, k, seed, { out = 0.55, lift = 0, hang = 0, k2 = null, centre = null } = {}) {
  const list = [], C = centre || [cx, cy, cz];
  for (let i = 0; i < n; i++) {
    const a = hash2(seed, i) * 6.283, e = Math.asin(hash2(i, seed) * 2 - 1) * 0.85 + lift * 0.4, r = 0.4 + 0.6 * Math.sqrt(hash2(i + 7, seed + 3));
    const d = V(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)), c = V(cx + d.x * rx * r, cy + d.y * ry * r, cz + d.z * rz * r);
    const ra = hash2(seed + 11, i) * 6.283, re = (hash2(i, seed + 13) - 0.5) * 2.6;
    const nrm = d.clone().multiplyScalar(out).add(V(Math.cos(ra) * Math.cos(re), Math.sin(re) + lift, Math.sin(ra) * Math.cos(re)).multiplyScalar(1 - out)).normalize();
    let b = upIn(nrm); const roll = (hash2(seed + 17, i) - 0.5) * 2.4 * (1 - hang); b.applyAxisAngle(nrm, roll);
    const t = new THREE.Vector3().crossVectors(b, nrm).normalize(), s = size * (0.75 + 0.5 * hash2(i, seed + 5));
    const rr = Math.hypot((c.x - C[0]) / (rx * 1.6), (c.y - C[1]) / (ry * 1.6), (c.z - C[2]) / (rz * 1.6));
    list.push([c, t, b, s / 2, s / 2 * (hang ? 1.3 : 1), k2 != null && i % 3 === 2 ? k2 : k, hash2(i, seed + 19) < 0.5, C, rr * 1.4]);
  }
  return quads(list, (c, C) => c.clone().sub(V(C[0], C[1], C[2])).multiply(V(1 / Math.max(rx, 0.1), 1.25 / Math.max(ry, 0.1), 1 / Math.max(rz, 0.1))).normalize());
}
// a crown of lumps (a broadleaf): cards round each lump, soft about the whole crown
function lumps(cx, cy, cz, rx, ry, rz, nl, per, size, k, seed, o = {}) {
  const gs = [];
  for (let j = 0; j < nl; j++) {
    const a = hash2(seed, j) * 6.283, e = (hash2(j, seed) - 0.35) * 1.2, r = j ? 0.55 + 0.35 * hash2(j + 9, seed) : 0, s = (j ? o.lump ?? 0.55 : 0.75) * (0.85 + 0.3 * hash2(seed + 3, j));
    gs.push(crownCards(cx + Math.cos(a) * Math.cos(e) * rx * r, cy + Math.sin(e) * ry * r, cz + Math.sin(a) * Math.cos(e) * rz * r, rx * s, ry * s, rz * s, per, size, k, seed * 31 + j, { ...o, centre: [cx, cy, cz] }));
  }
  return gs;
}
// conifer boughs: `tiers` rings from y0 to y1 of `per` boughs round the trunk, from r0 long at the bottom to r1 at the
// top, drooping; each a spray card along the bough (flat) and one across it (a bough has depth)
function boughs(y0, y1, tiers, per, r0, r1, wid, droop, k, seed, k2 = null) {
  const list = [];
  for (let i = 0; i < tiers; i++) {
    const f = i / Math.max(1, tiers - 1), y = y0 + (y1 - y0) * f + (hash2(i, seed) - 0.5) * (y1 - y0) / tiers * 0.6;
    for (let j = 0; j < per; j++) {
      const a = (j + hash2(seed, i * 7 + j) * 0.7) / per * 6.283 + i * 2.4, len = (r0 + (r1 - r0) * f) * (0.75 + 0.45 * hash2(i, j + seed));
      const d = V(Math.cos(a), -droop * (0.7 + 0.6 * hash2(j, i + seed)), Math.sin(a)).normalize(), s = V(Math.cos(a) * 0.25, y, Math.sin(a) * 0.25);
      const c = s.clone().addScaledVector(d, len / 2), h = V(-Math.sin(a), 0, Math.cos(a)), roll = (hash2(seed + 3, i * 13 + j) - 0.5) * 0.8;
      const across = h.clone().applyAxisAngle(d, roll), upc = new THREE.Vector3().crossVectors(d, across).normalize();
      const kk = k2 != null && (i + j) % 2 ? k2 : k, r = 0.55 + 0.45 * (len / (r0 + 0.01));
      list.push([c, d, across, len / 2 + 0.3, len * wid / 2 + 0.25, kk, (i + j) % 2 === 0, [0, y, 0], r]);
      list.push([c.clone().addScaledVector(upc, 0.05), d, upc.clone().negate(), len / 2, len * wid * 0.32 + 0.2, kk, (i + j) % 2 === 1, [0, y, 0], r]);
    }
  }
  return quads(list, (c, C) => V(c.x - C[0], (c.y - C[1]) * 0.6 + 0.35, c.z - C[2]).normalize());
}
// fern fronds rising from the ground and arching out
function fronds(n, len, seed) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const a = (i + hash2(seed, i) * 0.6) / n * 6.283, d = V(Math.cos(a), 0, Math.sin(a)), h = V(-Math.sin(a), 0, Math.cos(a)), L = len * (0.8 + 0.4 * hash2(i, seed));
    // two pieces: up and out, then arching over; one image along both (the frond's base at the bottom)
    const p0 = V(0, 0, 0), p1 = d.clone().multiplyScalar(L * 0.3).add(V(0, L * 0.42, 0)), p2 = d.clone().multiplyScalar(L * 0.85).add(V(0, L * 0.3, 0)), w = L * 0.2;
    for (const [a0, a1, rows] of [[p0, p1, [0.5, 1]], [p1, p2, [0, 0.5]]]) {
      const ax = a1.clone().sub(a0), c = a0.clone().add(a1).multiplyScalar(0.5), up = ax.clone().normalize();
      list.push([c, h, up, w, ax.length() / 2, LEAF.fern, i % 2 === 0, [0, 0.2, 0], 0.9, rows]);
    }
  }
  return quads(list, c => V(c.x, 1.2, c.z).normalize());
}
const trunkG = (r0, r1, h, s = 6) => new THREE.CylinderGeometry(r1, r0, h, s, 3).translate(0, h / 2, 0);
const limb = (x0, y0, z0, x1, y1, z1, r, c) => {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return [new THREE.CylinderGeometry(r * 0.6, r, L, 5, 1).translate(0, L / 2, 0), c, new THREE.Matrix4().compose(new THREE.Vector3(x0, y0, z0), q, new THREE.Vector3(1, 1, 1)), { shade: [0, y1], cell: LEAF.bark }];
};
const bark = (g, c, m = null, shade = null) => [g, c, m, { cell: LEAF.bark, shade }];
const leaves = (g, c, soft = null) => [g, c, null, { card: true, soft }];
// the dense heart of a crown: an opaque lumpy blob under the cards (a cone round a conifer's trunk), darker, so a crown
// never shows the sky through its middle
const core = (cx, cy, cz, rx, ry, rz, c, seed) => [bumpy(new THREE.IcosahedronGeometry(1, 1), 0.3, seed), c.map(v => v * 0.5), M(cx, cy, cz, rx, ry, rz, seed), { soft: [cx, cy, cz], shade: [cy - ry, cy + ry] }];
const cone = (y0, y1, r, c, seed) => [bumpy(new THREE.ConeGeometry(r, y1 - y0, 8, 6), r * 0.3, seed), c.map(v => v * 0.45), M(0, (y0 + y1) / 2, 0), { soft: [0, (y0 + y1) / 2, 0], shade: [y0, y1] }];

// trees at a typical size in metres (scaled per instance). Names: oak, bay, fir, redwood, euc, cypress, pine (trees),
// bush, shrub (low), fern, stone (near the rider only)
export const SPECIES = ['oak', 'bay', 'fir', 'redwood', 'euc', 'cypress', 'pine', 'bush', 'shrub'];
// the share of the full models' radius each is drawn in full (the tall dense ones cost the most; impostors past it)
export const NEAR = { oak: 1, bay: 1, fir: 0.45, redwood: 0.2, euc: 0.8, cypress: 1, pine: 0.8, bush: 0.5, shrub: 0.5, stone: 0.45, fern: 0.25 };
export function treeGeometries() {
  const brown = col(0x6e5a44, 1.5), brownD = col(0x574634, 1.5), red = col(0x7e4a36, 1.45), pale = col(0xd8cdb8, 1.15);
  // foliage colours; the atlas's own light (about 0.6 to 1) darkens them
  const F = { oak: col(0x51693a, 1.2), bay: col(0x3e5838, 1.12), fir: col(0x34552f, 1.35), red: col(0x264a32, 1.2),
    euc: col(0x7c9a7a, 1.3), cyp: col(0x35552f, 1.4), pine: col(0x3a5a30, 1.4), bush: col(0x6a7a42, 1.3), shrub: col(0x4a6234, 1.3), fern: col(0x4f7a2c, 1.4) };
  const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);
  return {
    stone: merge([[bumpy(ico(0.45, 1), 0.12, 21), col(0x8d867a), M(0, 0.12, 0, 1, 0.6, 1)]]),
    // coast live oak: a short leaning trunk forking into limbs, a broad dome of leafy lumps
    oak: merge([bark(trunkG(0.42, 0.3, 2.4, 7), brown, M(0, 0, 0, 1, 1, 1, 0, 0.08)),
      limb(0.15, 2.2, 0, 2.2, 4.4, 0.6, 0.26, brown), limb(0.1, 2.2, 0, -1.8, 4.6, -0.8, 0.24, brown), limb(0.1, 2.3, 0, 0.2, 5.2, 1.6, 0.2, brown),
      core(0.2, 5.5, 0, 2.9, 1.5, 2.6, F.oak, 2), ...lumps(0.2, 5.4, 0, 3.7, 2.1, 3.4, 7, 12, 2.9, LEAF.oak, 1).map(g => leaves(g, F.oak))]),
    // California bay laurel: dense, taller than wide, glossy dark
    bay: merge([bark(trunkG(0.36, 0.26, 3.5, 6), brownD), limb(0, 3, 0, 1.2, 6, 0.4, 0.2, brownD), limb(0, 3, 0, -1, 6.4, -0.3, 0.18, brownD),
      core(0, 7.2, 0, 2.1, 2.8, 2.0, F.bay, 5), ...lumps(0, 7, 0, 2.8, 3.6, 2.7, 7, 11, 2.6, LEAF.bay, 4, { lump: 0.6 }).map(g => leaves(g, F.bay))]),
    // Douglas fir: a straight trunk, drooping boughs in tiers to a spire
    fir: merge([bark(trunkG(0.5, 0.12, 25, 7), brownD), cone(4, 25.5, 1.8, F.fir, 31), leaves(boughs(3.5, 24.2, 11, 7, 4.8, 0.8, 1.6, 0.3, LEAF.fir, 30), F.fir),
      leaves(crownCards(0, 24.6, 0, 0.35, 1.2, 0.35, 3, 1.0, LEAF.fir, 33, { out: 0.2, hang: 1 }), F.fir)]),
    // coast redwood: a tall fluted red trunk flaring at the foot, bare to near half its height, short drooping boughs of
    // flat feathery sprays in a narrow, ragged spire
    redwood: merge([bark(trunkG(1.25, 0.32, 46, 10), red), bark(new THREE.CylinderGeometry(1.2, 1.9, 3, 10, 1).translate(0, 1.5, 0), red),
      ...[[13, 0.5], [15, 2.6], [17.5, 4.4], [19, 1.2]].map(([y, a]) => limb(Math.cos(a) * 0.6, y, Math.sin(a) * 0.6, Math.cos(a) * 2.6, y - 0.8, Math.sin(a) * 2.6, 0.09, brownD)),
      cone(20, 47, 1.6, F.red, 41), leaves(boughs(18.5, 45.5, 11, 5, 5.1, 1.1, 1.85, 0.36, LEAF.redwood, 40, LEAF.redwood2), F.red),
      leaves(crownCards(0, 46, 0, 0.5, 1.6, 0.5, 4, 1.3, LEAF.redwood, 44, { out: 0.2, hang: 1 }), F.red)]),
    // blue gum eucalyptus: a tall pale trunk leaning a little, loose blue-grey clumps of hanging leaves off high limbs
    euc: merge([bark(trunkG(0.5, 0.22, 17, 7), pale, M(0, 0, 0, 1, 1, 1, 0, 0.05)),
      limb(0.5, 11, 0, 2.6, 15.5, 0.8, 0.2, pale), limb(0.4, 12, 0, -2.2, 16.2, -0.6, 0.18, pale), limb(0.7, 14, 0, 0.6, 18.5, 1.6, 0.16, pale),
      ...[[2.8, 15.4, 0.8, 6], [-2.3, 16.2, -0.6, 7], [0.6, 18.6, 1.4, 8], [0.2, 13.5, -1.2, 9]].map(([x, y, z, s]) => leaves(crownCards(x, y, z, 2.4, 2.5, 2.2, 16, 2.8, LEAF.euc, s, { out: 0.35, hang: 1, centre: [0.5, 16, 0] }), F.euc))]),
    // Monterey cypress: wind-flattened tables on a crooked trunk, wide and dark
    cypress: merge([bark(trunkG(0.6, 0.4, 3.2, 7), brownD, M(0, 0, 0, 1, 1, 1, 0, 0.18)), limb(0.4, 2.8, 0, 3.0, 4.6, 0.3, 0.26, brownD), limb(0.3, 2.9, 0, -2.6, 4.0, 0.5, 0.24, brownD),
      ...[[2.6, 5.0, 0.2, 3.4, 1.2, 2.6, 9], [-2.4, 4.4, 0.4, 3.0, 1.1, 2.4, 10], [0.2, 6.0, -0.3, 2.6, 1.0, 2.2, 12]].flatMap(([x, y, z, rx, ry, rz, s]) =>
        [core(x, y, z, rx * 0.75, ry * 0.7, rz * 0.75, F.cyp, s), leaves(crownCards(x, y, z, rx, ry, rz, 17, 2.9, LEAF.cypress, s, { out: 0.35, lift: 0.9, centre: [0, 5, 0] }), F.cyp)])]),
    // Monterey / bishop pine: a rounded, irregular dark crown high on a bare trunk
    pine: merge([bark(trunkG(0.45, 0.28, 9, 7), brownD), limb(0, 7.5, 0, 2, 10, 0.5, 0.18, brownD), limb(0, 8, 0, -1.6, 10.6, -0.4, 0.16, brownD),
      core(0, 11, 0, 2.8, 1.8, 2.6, F.pine, 15), ...lumps(0, 11, 0, 3.8, 2.6, 3.6, 6, 10, 2.9, LEAF.pine, 14).map(g => leaves(g, F.pine))]),
    // coyote brush and other coastal scrub: low, irregular mounds
    bush: merge([core(0, 0.5, 0, 1.3, 0.55, 1.1, F.bush, 12), ...lumps(0, 0.6, 0, 1.7, 0.75, 1.5, 3, 12, 1.3, LEAF.scrub, 11, { lift: 0.5 }).map(g => leaves(g, F.bush))]),
    // toyon / manzanita: a taller shrub with a reddish base
    shrub: merge([limb(0, 0, 0, 0.3, 1.2, 0.1, 0.08, col(0x7a3e2c, 1.4)), limb(0, 0, 0, -0.4, 1.1, 0.2, 0.07, col(0x7a3e2c, 1.4)),
      core(0, 1.7, 0, 1.05, 0.85, 1.0, F.shrub, 16), ...lumps(0, 1.7, 0, 1.5, 1.2, 1.4, 4, 10, 1.15, LEAF.scrub, 15).map(g => leaves(g, F.shrub))]),
    // sword fern under the redwoods
    fern: merge([leaves(fronds(12, 1.7, 5), F.fern)]),
  };
}
// The Headlands' coastal scrub (scrub.js), about 2.6 m across at scale 1: coyote brush, a dense lumpy mound about
// 1.4 m tall, and California sage, lower, softer and grey-green; each in full near the camera and with fewer, bigger
// cards further out. Colours from the aerial imagery's scrub (USDA NAIP, about #50624b), the atlas's light on top.
export function scrubGeometries() {
  // the bushes broad and low, their cores not much darker than their leaves (a cover with no black between the bushes)
  // (Street View: coyote brush a grey olive, the sage paler and greyer still; USDA NAIP's scrub about #6b7354)
  const brush = col(0x667352, 1.3), sage = col(0x8f977c, 1.3);
  return {
    brush: merge([[bumpy(new THREE.IcosahedronGeometry(1, 1), 0.45, 23), brush.map(v => v * 0.55), M(0, 0.5, 0, 1.15, 0.45, 1.05), { soft: [0, 0.5, 0], shade: [0.3, 1.0] }], ...lumps(0, 0.62, 0, 1.6, 0.62, 1.5, 5, 12, 0.85, LEAF.scrub, 21, { lift: 0.45, lump: 0.7, out: 0.8 }).map(g => leaves(g, brush))]),
    brushLo: merge([[bumpy(new THREE.IcosahedronGeometry(1, 0), 0.25, 23), brush.map(v => v * 0.72), M(0, 0.55, 0, 1.5, 0.6, 1.4), { soft: [0, 0.55, 0], shade: [0.3, 1.2] }],
      ...lumps(0, 0.66, 0, 1.6, 0.62, 1.5, 3, 6, 1.35, LEAF.scrub, 21, { lift: 0.45, lump: 0.7 }).map(g => leaves(g, brush))]),
    sage: merge([[bumpy(new THREE.IcosahedronGeometry(1, 1), 0.4, 27), sage.map(v => v * 0.6), M(0, 0.38, 0, 0.95, 0.33, 0.88), { soft: [0, 0.38, 0], shade: [0.3, 0.8] }], ...lumps(0, 0.45, 0, 1.35, 0.48, 1.25, 4, 12, 0.8, LEAF.scrub, 25, { lift: 0.65, lump: 0.7, out: 0.8 }).map(g => leaves(g, sage))]),
    sageLo: merge([[bumpy(new THREE.IcosahedronGeometry(1, 0), 0.2, 27), sage.map(v => v * 0.72), M(0, 0.42, 0, 1.25, 0.47, 1.15), { soft: [0, 0.42, 0], shade: [0.3, 0.95] }],
      ...lumps(0, 0.45, 0, 1.35, 0.48, 1.25, 3, 5, 1.2, LEAF.scrub, 25, { lift: 0.65, lump: 0.7 }).map(g => leaves(g, sage))]),
  };
}

// Street furniture at its typical size (metres), instanced along the roads: a guardrail post, a street lamp (its arm
// along +x over the road, the lamp's underside tag 2: lit at dusk), stop and speed limit signs (facing +z), a ranch
// fence and a picket fence section (3 m along +x), a traffic signal on its pole (facing +z, its green lamp tag 4 lit,
// the red and amber dark). Vertex coloured.
export function furnitureGeometries() {
  const B = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z), C = (r0, r1, h, s = 8) => new THREE.CylinderGeometry(r1, r0, h, s).translate(0, h / 2, 0);
  const grey = col(0x8c8f92), steel = col(0x9da3a6), dark = col(0x3b3d40), wood = col(0x6f5a44), pole = col(0x6a5e50), white = col(0xeeeeea), red = col(0xb3241c), lampC = col(0xfff1d0);
  // an octagon facing +z at the sign's height: its circumradius, thickness, z
  const oct = (r, d, z) => new THREE.CylinderGeometry(r, r, d, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 8).translate(0, 2.2, z);
  // STOP on the sign's face (+z): block strokes, letters 0.254 m high, 0.12 m wide, 0.035 m apart, strokes 0.035 m
  const stopLetters = () => {
    const L = { S: [[0, 1, 1, 1], [0, 0.5, 0, 1], [0, 0.5, 1, 0.5], [1, 0, 1, 0.5], [0, 0, 1, 0]], T: [[0, 1, 1, 1], [0.5, 0, 0.5, 1]],
      O: [[0, 1, 1, 1], [1, 0, 1, 1], [0, 0, 1, 0], [0, 0, 0, 1]], P: [[0, 1, 1, 1], [1, 0.5, 1, 1], [0, 0.5, 1, 0.5], [0, 0, 0, 1]] };
    const w = 0.12, h = 0.254, t = 0.035, out = [];
    [...'STOP'].forEach((ch, k) => { const x0 = (k - 1.5) * (w + 0.035) - w / 2;
      for (const [a, b, c, d] of L[ch]) { const xa = x0 + a * w, xb = x0 + c * w, ya = 2.2 - h / 2 + b * h, yb = 2.2 - h / 2 + d * h;
        out.push(B(Math.abs(xb - xa) + t, Math.abs(yb - ya) + t, 0.004, (xa + xb) / 2, (ya + yb) / 2, 0.047)); } });
    return out;
  };
  return {
    // barrier posts 1 m tall (scaled to their height), from their foot: a W-beam's or a fence's square dark timber post (6 by
    // 8 in, Caltrans A77; Street View: every one in the Headlands dark timber), a concrete rail's block, a chain-link's steel (rusty)
    tpost: merge([[B(0.15, 1, 0.2, 0, 0.5, 0), wood]]),
    cpost: merge([[B(0.3, 1, 0.3, 0, 0.5, 0), col(0xd9d6cc)]]),
    spost: merge([[C(0.04, 0.04, 1, 6), col(0x7a5340)]]),
    pole: merge([[C(0.14, 0.11, 9.6, 7), pole], [B(0.1, 0.1, 1.9, 0, 8.9, 0), pole], ...[-0.8, 0.8].map(z => [B(0.07, 0.16, 0.07, 0, 9.03, z), dark])]),
    lamp: merge([[C(0.1, 0.07, 6.6), dark], [B(1.9, 0.08, 0.1, 0.95, 6.5, 0), dark], [B(0.6, 0.14, 0.26, 1.85, 6.42, 0), dark], [B(0.5, 0.03, 0.2, 1.85, 6.34, 0), lampC, null, { tag: 2 }]]),
    // painted on a stop's way in (flat on the road, the driver's right +x, toward the junction -z): the stop bar across a
    // lane, 3.2 m (scaled across to the lane)
    stopbar: merge([[B(3.2, 0.012, 0.45), white]]),
    // a marked crossing (scaled across to the road): bars 0.5 m wide along the road (+z), 2.8 m long, 1.1 m apart across
    // 7.2 m; or two lines across it 0.3 m wide, 3 m apart, 1 m (MUTCD 3B.18: lines 6 to 24 inches wide, 6 feet apart or more)
    xwalk: merge(Array.from({ length: 7 }, (_, i) => [B(0.5, 0.012, 2.8, (i - 3) * 1.1, 0, 0), white])),
    xlines: merge([-1.5, 1.5].map(z => [B(1, 0.012, 0.3, 0, 0, z), white])),
    // a flexible delineator post on the centre line: yellow, two white reflective bands
    delin: merge([[C(0.045, 0.04, 0.95, 8), col(0xd9b21c)], ...[0.72, 0.84].map(y => [new THREE.CylinderGeometry(0.047, 0.047, 0.06, 8).translate(0, y, 0), white])]),
    // a stop sign (MUTCD R1-1, 30 inches across its flats): a red octagon, a narrow white border, STOP in white letters
    // 10 inches high; its back grey
    stop: merge([[C(0.035, 0.035, 2.3, 6), grey], [oct(0.412, 0.02, 0.01), white], [oct(0.392, 0.02, 0.03), red], [oct(0.412, 0.008, -0.004), grey], ...stopLetters().map(g => [g, white])]),
    limit: merge([[C(0.035, 0.035, 2.4, 6), grey], [B(0.6, 0.76, 0.03, 0, 2.15, 0.03), white], [B(0.5, 0.06, 0.035, 0, 2.38, 0.04), dark], [B(0.3, 0.26, 0.035, 0, 2.05, 0.04), dark]]),
    fence: merge([[B(0.12, 1.25, 0.12, 0, 0.62, 0), wood], [B(0.12, 1.25, 0.12, 3, 0.62, 0), wood], ...[0.45, 0.8, 1.12].map(y => [B(3, 0.1, 0.04, 1.5, y, 0.06), wood])]),
    picket: merge([...Array.from({ length: 12 }, (_, i) => [B(0.09, 0.95, 0.025, 0.12 + i * 0.25, 0.47, 0), white]), [B(3, 0.07, 0.04, 1.5, 0.3, -0.03), white], [B(3, 0.07, 0.04, 1.5, 0.75, -0.03), white]]),
    signal: merge([[C(0.1, 0.08, 4.4), grey], ...signalHead(3.55)]),
    signalHead: merge(signalHead(0)),
  };
  // a signal head centred at height y: backplate, the housing, red, amber and green lamps under their visors
  function signalHead(y0) {
    return [[B(0.62, 1.32, 0.03, 0, y0, -0.02), dark], [B(0.38, 1.1, 0.28, 0, y0, 0.13), col(0x2a2c2e)],
      ...[[0.35, col(0x4a1410), 0], [0, col(0x4a3610), 0], [-0.35, col(0x8affc0), 4]].flatMap(([y, c, tag]) => [[new THREE.CylinderGeometry(0.12, 0.12, 0.04, 12).rotateX(Math.PI / 2).translate(0, y0 + y, 0.29), c, null, { tag }],
        [new THREE.CylinderGeometry(0.15, 0.15, 0.2, 12, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, y0 + y + 0.02, 0.38), col(0x1e2022)]])];
  }
}

// which tree grows here: k ground class, lt leaf type, h height, lat/lon, r a random 0..1
export const REDWOODS = [[37.885, -122.59, 37.905, -122.565], [38.0, -122.76, 38.035, -122.69], [37.89, -122.555, 37.915, -122.53], [37.96, -122.67, 37.99, -122.62]];
// the Marin Headlands [s, w, n, e]: coastal scrub and grass, no lone trees on the open hills (Street View)
export const HEADLANDS = [37.80, -122.56, 37.865, -122.46];
// San Francisco from the Golden Gate Park north to the bay (the Presidio's and the park's woods keep their own colour)
export const SF_CITY = [37.745, -122.515, 37.806, -122.36];
export const inHeadlands = (lat, lon) => lat >= HEADLANDS[0] && lat <= HEADLANDS[2] && lon >= HEADLANDS[1] && lon <= HEADLANDS[3];
export function species(k, lt, h, lat, lon, r) {
  if (k === 'scrub') return r < (inHeadlands(lat, lon) ? 0.9 : 0.75) ? 'bush' : r < 0.94 || inHeadlands(lat, lon) ? 'shrub' : 'cypress';
  if (k === 'wood') {
    if (REDWOODS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e) && h < 350) return r < 0.7 ? 'redwood' : r < 0.85 ? 'bay' : 'fir';
    const coast = h < 140 && lon < -122.47 && lat < 37.92;
    if (lt === 'n') return coast || inHeadlands(lat, lon) ? (r < 0.65 ? 'cypress' : 'pine') : r < 0.6 ? 'fir' : r < 0.8 ? 'pine' : 'redwood';  // the coast's planted groves: Monterey cypress and pine
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
  const quad = (a, b, c, d, k, w) => { tri(a, b, c, k, [w[0], w[1], w[2]]); tri(a, c, d, k, [w[0], w[2], w[3]]); };
  const G = [0, 0, 0, 2], T = [G, G, G, G];
  // a box standing on y0 (no floor), sides along (ux, uz) and across, in one colour as trim
  const box = (cx, y0, cz, sl, sh, sw, ux, uz, k) => {
    const P = (s, t, y) => [cx + ux * s - uz * t, y, cz + uz * s + ux * t], y1 = y0 + sh;
    const c = [[-sl, -sw], [sl, -sw], [sl, sw], [-sl, sw]];
    for (let i = 0; i < 4; i++) { const [s0, t0] = c[i], [s1, t1] = c[(i + 1) % 4]; quad(P(s1, t1, y0), P(s0, t0, y0), P(s0, t0, y1), P(s1, t1, y1), k, T); }
    quad(P(-sl, sw, y1), P(sl, sw, y1), P(sl, -sw, y1), P(-sl, -sw, y1), k, T);
  };
  for (const b of list) {
    let r = b.ring.slice(0, -1); if (r.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(r.map(p => new THREE.Vector2(p[0], p[1])))) r = r.reverse();
    const h = (k) => hash2(b.seed, k), ob = orientedBox(r), area = Math.abs(THREE.ShapeUtils.area(r.map(p => new THREE.Vector2(p[0], p[1])))), fill = area / Math.max(1, ob.area);
    // houses: small and near enough a box for one roof over it (an L or a T takes a flat roof); a few barns with a
    // gambrel roof, in barn red
    // (b.fort: the Headlands' army posts, Fort Baker, Barry and Cronkhite: white clapboard under red tile or grey roofs,
    // gabled or hipped barracks, halls and houses, the big ones too, Street View)
    const house = b.fort ? b.h <= 16 && r.length <= 20 && ob.area < 3200 && fill > 0.7 : b.h <= 10 && r.length <= 12 && ob.area < 450 && fill > 0.74, barn = !b.fort && !house && b.h <= 10 && ob.area > 120 && ob.area < 900 && fill > 0.85 && h(11) < 0.22;
    const top = b.base + b.h, wi = Math.floor(h(1) * WALLS.length), wc = b.fort ? col(0xefebe1, 0.94 + 0.08 * h(1)) : barn ? col(h(12) < 0.6 ? 0x8a3226 : 0xd8d0c0) : col(WALLS[wi]), rc = col(b.fort ? (h(2) < 0.75 ? 0x9a4a33 : 0x66625b) : barn ? 0x5a5650 : ROOFS[Math.floor(h(2) * ROOFS.length)]);
    const style = b.fort ? 5 : barn ? 5 : wi >= 12 ? 5 : (house ? HOUSE : b.h > 16 || ob.area > 1500 ? BIG : FLATS)[Math.floor(h(5) * 8) % (house ? 8 : 4)];
    let run = h(6) * 3;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]), f = 0.9 + 0.1 * h(i + 20), k = [wc[0] * f, wc[1] * f, wc[2] * f];
      const A = [p[0], b.base - 1, p[1]], B = [q[0], b.base - 1, q[1]], C = [q[0], top, q[1]], D = [p[0], top, p[1]];
      const a = [run, -1, style, 0], bb = [run + L, -1, style, 0], c = [run + L, b.h, style, 0], d = [run, b.h, style, 0];
      tri(A, C, B, k, [a, c, bb]); tri(A, D, C, k, [a, d, c]);
      run += L;
    }
    const flat = (y, k, kind) => {
      const tris = THREE.ShapeUtils.triangulateShape(r.map(p => new THREE.Vector2(p[0], p[1])), []);
      for (const [a, b2, c] of tris) tri([r[a][0], y, r[a][1]], [r[c][0], y, r[c][1]], [r[b2][0], y, r[b2][1]], k, [[r[a][0], r[a][1], 0, kind], [r[c][0], r[c][1], 0, kind], [r[b2][0], r[b2][1], 0, kind]]);
    };
    const { c: [cx, cz], u: [ux, uz], L, W: w } = ob, P = (s, t, y) => [cx + ux * s - uz * t, y, cz + uz * s + ux * t], R = (s, y) => [s, y, 0, 1];
    if (house || barn) {
      const o = 0.45, e = top - 0.15;
      if (barn) {
        // a gambrel: steep lower slopes to a knee, shallow ones to the ridge; the ends closed in wall colour
        const rh = Math.min(5, w * 0.42), kt = w / 2 * 0.62, ky = top + rh * 0.62;
        const lo = (t, y) => [P(-L / 2 - o, t, y), P(L / 2 + o, t, y)];
        for (const sd of [-1, 1]) {
          const [a1, a2] = lo(sd * (w / 2 + o), e), [k1, k2] = lo(sd * kt, ky), [r1, r2] = lo(0, top + rh), s1 = Math.hypot(w / 2 + o - kt, ky - e), s2 = s1 + Math.hypot(kt, top + rh - ky);
          if (sd > 0) { quad(a1, a2, k2, k1, rc, [R(0, 0), R(L, 0), R(L, s1), R(0, s1)]); quad(k1, k2, r2, r1, rc, [R(0, s1), R(L, s1), R(L, s2), R(0, s2)]); }
          else { quad(a2, a1, k1, k2, rc, [R(0, 0), R(L, 0), R(L, s1), R(0, s1)]); quad(k2, k1, r1, r2, rc, [R(0, s1), R(L, s1), R(L, s2), R(0, s2)]); }
        }
        for (const sd of [-1, 1]) {
          const s = sd * L / 2, pts = [P(s, -w / 2, top), P(s, -kt, ky), P(s, 0, top + rh), P(s, kt, ky), P(s, w / 2, top)];
          for (let i = 1; i < 4; i++) sd > 0 ? tri(pts[0], pts[i], pts[i + 1], wc, [G, G, G]) : tri(pts[0], pts[i + 1], pts[i], wc, [G, G, G]);
        }
      } else {
        // a gable roof along the long side, a hip roof on a squarish house, now and then a shed roof; pitches vary
        const rh = Math.min(3.8, w * (0.26 + 0.24 * h(7))), shed = h(8) > 0.9, hip = !shed && (L < w * 1.35 || h(8) < 0.3), inset = hip ? Math.min(L / 2, w / 2) : 0;
        if (shed) {
          const a1 = P(-L / 2 - o, -w / 2 - o, e), a2 = P(L / 2 + o, -w / 2 - o, e), b1 = P(-L / 2 - o, w / 2 + o, e + rh * 0.7), b2 = P(L / 2 + o, w / 2 + o, e + rh * 0.7), sl = Math.hypot(w + 2 * o, rh * 0.7);
          quad(a2, a1, b1, b2, rc, [R(0, 0), R(L, 0), R(L, sl), R(0, sl)]);
          for (const sd of [-1, 1]) { const s = sd * L / 2, t1 = P(s, -w / 2, top), t2 = P(s, w / 2, top), t3 = P(s, w / 2, top + rh * 0.7); sd < 0 ? tri(t1, t2, t3, wc, [G, G, G]) : tri(t1, t3, t2, wc, [G, G, G]); }
          const hi = P(0, w / 2, top + rh * 0.7); quad(P(-L / 2, w / 2, top), P(L / 2, w / 2, top), [hi[0] + ux * L / 2, hi[1], hi[2] + uz * L / 2], [hi[0] - ux * L / 2, hi[1], hi[2] - uz * L / 2], wc, T);
        } else {
          const a1 = P(-L / 2 - o, -w / 2 - o, e), a2 = P(L / 2 + o, -w / 2 - o, e), b1 = P(-L / 2 - o, w / 2 + o, e), b2 = P(L / 2 + o, w / 2 + o, e);
          const r1 = P(-L / 2 + inset, 0, top + rh), r2 = P(L / 2 - inset, 0, top + rh), sl = Math.hypot(w / 2 + o, rh);
          tri(a1, r1, a2, rc, [R(0, 0), R(inset, sl), R(L + 2 * o, 0)]); tri(a2, r1, r2, rc, [R(L + 2 * o, 0), R(inset, sl), R(L - inset, sl)]);
          tri(b1, b2, r1, rc, [R(0, 0), R(L + 2 * o, 0), R(inset, sl)]); tri(b2, r2, r1, rc, [R(L + 2 * o, 0), R(L - inset, sl), R(inset, sl)]);
          if (hip) { tri(a1, b1, r1, rc, [R(0, 0), R(w + 2 * o, 0), R(w / 2, sl)]); tri(b2, a2, r2, rc, [R(0, 0), R(w + 2 * o, 0), R(w / 2, sl)]); }
          else {
            const e1 = P(-L / 2, -w / 2, top), e2 = P(-L / 2, w / 2, top), e3 = P(-L / 2, 0, top + rh), f1 = P(L / 2, -w / 2, top), f2 = P(L / 2, w / 2, top), f3 = P(L / 2, 0, top + rh);
            tri(e1, e2, e3, wc, [G, G, G]); tri(f1, f3, f2, wc, [G, G, G]);
          }
          // a brick chimney at one end, through the roof
          if (h(13) < 0.45) { const sd = h(14) < 0.5 ? -1 : 1, p = P(sd * (L / 2 - 0.8), (h(15) - 0.5) * w * 0.3, 0); box(p[0], top - 0.5, p[2], 0.38, rh + 1.4, 0.38, ux, uz, col(h(16) < 0.6 ? 0x8a4a3a : 0x9a9690)); }
        }
        // a porch along one long side: a lean-to roof on two posts, a deck
        if (h(17) < 0.35 && L > 6) {
          const sd = h(18) < 0.5 ? -1 : 1, s0 = -L * 0.34, s1 = L * 0.34, t0 = sd * w / 2, t1 = sd * (w / 2 + 2.2), y0 = b.base + 2.95, y1 = b.base + 2.55, pc = col(0xe8e4dc);
          const q1 = P(s0, t0, y0), q2 = P(s1, t0, y0), q3 = P(s1, t1, y1), q4 = P(s0, t1, y1), sl = Math.hypot(2.2, 0.4);
          sd < 0 ? quad(q1, q2, q3, q4, rc, [R(0, sl), R(s1 - s0, sl), R(s1 - s0, 0), R(0, 0)]) : quad(q2, q1, q4, q3, rc, [R(0, sl), R(s1 - s0, sl), R(s1 - s0, 0), R(0, 0)]);
          for (const s of [s0 + 0.2, s1 - 0.2]) { const p = P(s, sd * (w / 2 + 2.05), 0); box(p[0], b.base, p[2], 0.08, 2.6, 0.08, ux, uz, pc); }
          const d = P(0, sd * (w / 2 + 1.1), 0); box(d[0], b.base - 0.4, d[2], (s1 - s0) / 2, 0.7, 1.1, ux, uz, col(0x8a7a66));
        }
      }
      flat(top, wc, 2);  // the ceiling under the eaves (closes the box)
    } else {
      // a flat roof inside a parapet; boxes on the roof (plant, a stair head) on the bigger ones
      flat(top + 0.05, col(0x8c8a86, 0.9 + 0.2 * h(9)), 2);
      const pc = col(0xd8d4cc), ph = 0.5 + 0.5 * h(10);
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        tri([p[0], top, p[1]], [q[0], top + ph, q[1]], [q[0], top, q[1]], pc, [G, G, G]); tri([p[0], top, p[1]], [p[0], top + ph, p[1]], [q[0], top + ph, q[1]], pc, [G, G, G]);
      }
      if (area > 120 && fill > 0.6) for (let i = 0, n = 1 + Math.floor(h(19) * 3); i < n; i++) {
        const s = (h(30 + i) - 0.5) * L * 0.5, t = (h(40 + i) - 0.5) * w * 0.5, p = P(s, t, 0), sz = 0.8 + 1.4 * h(50 + i);
        box(p[0], top, p[2], sz, 0.9 + 1.2 * h(60 + i), sz * (0.6 + 0.6 * h(70 + i)), ux, uz, col(i ? 0xa6a39e : 0xbdb9b2));
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
