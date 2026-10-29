// World 3D hand-made Marin: the Golden Gate Bridge (towers, main cables, suspenders, the deck the rider rides on,
// International Orange), the San Francisco skyline across the strait, the Point Bonita and Alcatraz lighthouses and
// Karl the fog lying off the coast.
import { hash2 } from './landuse.js';
import * as roadLib from './ribbon.js';

// the bridge's axis: the two tower centres (where the OpenStreetMap sidewalks step round the towers); along the axis
// from mid span: the straight deck (the approaches curve, the road renderer draws those), the anchorages, the deck's
// height (the same straight line the ride's road takes between the abutments)
export const GGB = { south: [37.814, -122.47788], north: [37.82547, -122.47923], ends: [-1127, 985], anchor: 981, deckW: 27.4, walk: 29.5,
  towerTop: 227, deck: [[-1127, 54.5], [985, 60.8]] };

export function createLandmarks({ THREE, scene, proj, sky, mats, baked }) {
  const root = new THREE.Group(); scene.add(root);
  const mat = (c, o = {}) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...o });
  const orange = mat(0xc0452f), orangeDark = mat(0x8e3224), concrete = mat(0xb8b2a6), white = mat(0xf2f0ea), red = mat(0xb03026);

  /* ---------- the Golden Gate Bridge ---------- */
  const A = proj.xz(...GGB.south), B = proj.xz(...GGB.north);
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;   // along, south to north
  const vx = -uz, vz = ux;                                                                         // across
  const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], half = L / 2;
  const W = (s, t, y) => new THREE.Vector3(mid[0] + ux * s + vx * t, y, mid[1] + uz * s + vz * t);
  const deckH = s => { const d = GGB.deck; if (s <= d[0][0]) return d[0][1]; for (let i = 1; i < d.length; i++) if (s <= d[i][0]) return d[i - 1][1] + (d[i][1] - d[i - 1][1]) * (s - d[i - 1][0]) / (d[i][0] - d[i - 1][0]); return d.at(-1)[1]; };
  const bridge = new THREE.Group(); root.add(bridge);
  const yaw = Math.atan2(ux, uz);
  const box = (sx, sy, sz, m, s, t, y, rot = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.copy(W(s, t, y)); o.rotation.y = yaw + rot; o.castShadow = true; o.receiveShadow = true; bridge.add(o); return o; };
  // deck: a truss box in segments that follow the deck's rise; on top six lanes with their lines and a sidewalk each
  // side (the road shader), thin railings at the edges
  const seg = 40, rail = [];
  for (let s = GGB.ends[0]; s < GGB.ends[1]; s += seg) {
    const s1 = Math.min(GGB.ends[1], s + seg), h0 = deckH(s), h1 = deckH(s1), len = s1 - s, q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.atan2(h1 - h0, len), yaw, 0, 'YXZ'));
    box(GGB.deckW, 7.6, len + 0.4, orange, (s + s1) / 2, 0, (h0 + h1) / 2 - 3.95).quaternion.copy(q);
    for (const t of [-1, 1]) for (const [y, th] of [[1.15, 0.09], [0.55, 0.05]]) box(0.07, th, len + 0.1, orange, (s + s1) / 2, t * (GGB.deckW / 2 - 0.15), (h0 + h1) / 2 + y).quaternion.copy(q);
    for (let k = s; k < s1; k += 4) for (const t of [-1, 1]) rail.push(W(k, t * (GGB.deckW / 2 - 0.15), deckH(k) + 0.6));
  }
  if (mats?.road) {
    const { builder, ribbon } = roadLib, B = builder(), axis = [[0, GGB.ends[0]], [0, GGB.ends[1]]].map(([t, s]) => { const p = W(s, t, 0); return [p.x, p.z]; });
    const off = (pts, t) => pts.map(([x, z]) => [x + vx * t, z + vz * t]), dk = [deckH(GGB.ends[0]), deckH(GGB.ends[1])];
    ribbon(B, axis, { w: 20, lm: 2, lanes: 6, hAt: () => 0, deck: dk, lift: 0.02, step: 40 });
    for (const t of [-1, 1]) {
      ribbon(B, off(axis, t * 11.8), { w: 3.2, surf: 1, hAt: () => 0, deck: dk, lift: 0.06, step: 40 });
    }
    const d = B.done(), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); g.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2)); g.setAttribute('rd', new THREE.BufferAttribute(d.code, 4));
    g.setIndex(new THREE.BufferAttribute(d.idx, 1)); g.computeVertexNormals(); g.computeBoundingSphere();
    const top = new THREE.Mesh(g, mats.road); top.receiveShadow = true; bridge.add(top);
  }
  { const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), orange, rail.length), m4 = new THREE.Matrix4();
    rail.forEach((p, i) => post.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z))); post.computeBoundingSphere(); bridge.add(post); }
  // towers: two legs each, portal struts above the deck, a pier at the water
  const legT = 15.2;
  for (const s of [-half, half]) {
    for (const t of [-legT, legT]) {
      for (const [y0, y1, w] of [[0, 70, 10.5], [70, 150, 9], [150, GGB.towerTop, 7.6]]) box(w, y1 - y0, w * 1.6, orange, s, t, (y0 + y1) / 2);
      box(3.2, 4, 3.2, orangeDark, s, t, GGB.towerTop + 2);
    }
    for (const y of [deckH(s) - 12, deckH(s) + 40, deckH(s) + 85, deckH(s) + 125, GGB.towerTop - 6]) box(2 * legT, y === GGB.towerTop - 6 ? 9 : 6, 6, orange, s, 0, y);
    box(48, 14, 70, concrete, s, 0, 2);
  }
  // main cables: tower top to tower top sagging to just above the deck, and down the side spans to the anchorages
  const cablePts = t => {
    const pts = [], top = GGB.towerTop - 2, low = deckH(0) + 4;
    for (let s = -GGB.anchor; s <= -half; s += 25) { const f = (s + GGB.anchor) / (GGB.anchor - half); pts.push(W(s, t, deckH(s) + 2 + (top - deckH(s) - 2) * (f * f * 0.75 + f * 0.25))); }
    for (let s = -half; s <= half; s += 20) { const f = s / half; pts.push(W(s, t, low + (top - low) * f * f)); }
    for (let s = half + 25; s <= GGB.anchor; s += 25) { const f = (GGB.anchor - s) / (GGB.anchor - half); pts.push(W(s, t, deckH(s) + 2 + (top - deckH(s) - 2) * (f * f * 0.75 + f * 0.25))); }
    return pts;
  };
  const susp = [];
  for (const t of [-legT, legT]) {
    const pts = cablePts(t), curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, 0.65, 6), orange); tube.castShadow = true; bridge.add(tube);
    for (const p of pts) { const s = (p.x - mid[0]) * ux + (p.z - mid[1]) * uz, d = deckH(s); if (p.y - d > 3) susp.push(p.x, p.y, p.z, p.x, d + 0.5, p.z); }
    // between the samples, every 15 m
    for (let s = -half + 15; s < half; s += 15) { const f = s / half, top = GGB.towerTop - 2, low = deckH(0) + 4, y = low + (top - low) * f * f, p = W(s, t, y); susp.push(p.x, y, p.z, p.x, deckH(s) + 0.5, p.z); }
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(susp, 3));
  bridge.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xa83a2e })));
  // anchorages
  box(40, 30, 50, concrete, -GGB.anchor, 0, deckH(-GGB.anchor) - 23); box(40, 30, 50, concrete, GGB.anchor, 0, deckH(GGB.anchor) - 23);  // under the deck
  bridge.traverse(o => { o.matrixAutoUpdate = true; });

  // the rider's deck: inside the deck's width and span, the deck top
  function deckAt(x, z) {
    const dx = x - mid[0], dz = z - mid[1], s = dx * ux + dz * uz, t = dx * vx + dz * vz;
    return s >= GGB.ends[0] && s <= GGB.ends[1] && Math.abs(t) <= GGB.walk / 2 ? deckH(s) + 0.05 : null;
  }

  /* ---------- San Francisco: the skyline across the strait (outside the baked world) ---------- */
  const city = new THREE.Group(); root.add(city);
  baked?.index?.().then(ix => buildCity(ix)).catch(() => {});
  function buildCity() {
    const blocks = [], landmarks = [];
    // the downtown towers rise around the Financial District; low blocks on the hills around
    const fidi = proj.xz(37.7915, -122.3990);
    for (let la = 37.765; la < 37.809; la += 0.0011) for (let lo = -122.4195; lo < -122.384; lo += 0.0014) {
      const i = Math.round(la * 1e4), j = Math.round(lo * 1e4); if (hash2(i, j) < 0.25) continue;
      const lat = la + (hash2(j, i) - 0.5) * 0.0006, lon = lo + (hash2(i + 3, j) - 0.5) * 0.0007;
      // the bay: roughly north of the Embarcadero / Marina shore
      const shore = lon > -122.395 ? 37.7985 + (lon + 122.395) * 1.3 : lon > -122.41 ? 37.8075 : 37.8045;
      if (lat > shore || (lon > -122.388 && lat > 37.79)) continue;
      const [x, z] = proj.xz(lat, lon), d = Math.hypot(x - fidi[0], z - fidi[1]);
      const tall = Math.exp(-(d * d) / (700 * 700)), h = 8 + hash2(i, j + 9) * 14 + tall * (40 + hash2(j, i + 4) * 180);
      const w = 22 + hash2(i + 7, j) * 26 + tall * 10;
      blocks.push([x, z, w, h, w * (0.7 + hash2(j + 2, i) * 0.6)]);
    }
    landmarks.push(['salesforce', 37.7898, -122.3968], ['transamerica', 37.7952, -122.4028], ['coit', 37.8024, -122.4058]);
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), im = new THREE.InstancedMesh(geo, mat(0xffffff), blocks.length);
    const m4 = new THREE.Matrix4(), c = new THREE.Color(), tones = [0xe9e6df, 0xd9d4ca, 0xc8c6c2, 0xb9b8b6, 0xe2d6c0, 0xa9b2ba];
    blocks.forEach(([x, z, w, h, dep], i) => {
      im.setMatrixAt(i, m4.makeScale(w, h, dep).setPosition(x, 4, z));
      im.setColorAt(i, c.set(tones[Math.floor(hash2(i, 3) * tones.length)]));
    });
    im.computeBoundingSphere(); city.add(im);
    const [sx, sz] = proj.xz(37.7898, -122.3968);
    const sf = new THREE.Mesh(new THREE.CylinderGeometry(19, 26, 300, 12).translate(0, 150, 0), mat(0xd9dde0)); sf.position.set(sx, 4, sz); city.add(sf);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(19, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xd9dde0)); cap.position.set(sx, 304, sz); cap.scale.y = 1.4; city.add(cap);
    const [tx, tz] = proj.xz(37.7952, -122.4028);
    const tp = new THREE.Mesh(new THREE.ConeGeometry(30, 260, 4).translate(0, 130, 0), mat(0xeeeae2)); tp.position.set(tx, 4, tz); tp.rotation.y = Math.PI / 4; city.add(tp);
    const [cx, cz] = proj.xz(37.8024, -122.4058);
    const coit = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.5, 64, 10).translate(0, 32, 0), mat(0xece6d8)); coit.position.set(cx, 80, cz); city.add(coit);
  }

  /* ---------- lighthouses ---------- */
  const lighthouse = (lat, lon, ground, h) => {
    const [x, z] = proj.xz(lat, lon), g = new THREE.Group(); g.position.set(x, ground, z);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, h, 8).translate(0, h / 2, 0), white);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2, 8).translate(0, h + 1, 0), mat(0xfff1b0, { emissive: 0x806a20 }));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2, 8).translate(0, h + 3, 0), red);
    const house = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 9).translate(4, 2, 0), white);
    g.add(tower, lamp, roof, house); g.traverse(o => { o.castShadow = true; }); root.add(g);
  };
  lighthouse(37.81565, -122.52982, 30, 9);     // Point Bonita
  lighthouse(37.82648, -122.42246, 38, 26);    // Alcatraz
  { const [x, z] = proj.xz(37.8267, -122.4231); const cell = new THREE.Mesh(new THREE.BoxGeometry(40, 14, 150), mat(0xd8cdb4)); cell.position.set(x, 38, z); cell.rotation.y = 0.5; root.add(cell); }

  /* ---------- Karl the fog ---------- */
  const banks = [];
  for (const [lat, lon, s] of [[37.806, -122.505, 1600], [37.812, -122.54, 2000], [37.80, -122.58, 2400], [37.835, -122.585, 2000], [37.855, -122.63, 2600],
    [37.88, -122.665, 2400], [37.895, -122.71, 2800], [37.79, -122.63, 3000], [37.83, -122.66, 3200], [37.80, -122.475, 1100], [37.94, -122.76, 3000]]) {
    for (let k = 0; k < 3; k++) { const [x, z] = proj.xz(lat + (hash2(k, s) - 0.5) * 0.01, lon + (hash2(s, k) - 0.5) * 0.012); banks.push([x, z, s * (0.6 + 0.5 * hash2(k + 1, s)), 30 + 60 * hash2(k, 7)]); }
  }
  sky.placeBanks(banks);

  // the deck's height line, also past its ends (the curved approaches the road renderer draws)
  const deckLine = (x, z) => deckH((x - mid[0]) * ux + (z - mid[1]) * uz);
  return { ggb: true, deckAt, deckLine, update() {}, dispose() { root.traverse(o => o.geometry?.dispose()); scene.remove(root); } };
}
