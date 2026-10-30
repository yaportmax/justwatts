// World 3D hand-made Marin: the Golden Gate Bridge (towers, main cables, suspenders, the deck the rider rides on,
// International Orange), the San Francisco skyline across the strait, the Point Bonita and Alcatraz lighthouses and
// Karl the fog lying off the coast.
import { hash2 } from './landuse.js';
import * as roadLib from './ribbon.js';

import { GGB, deckH, centreT, fromST, toST, onDeck } from '../ggb.js';
export { GGB };

export function createLandmarks({ THREE, scene, proj, sky, mats, baked }) {
  const root = new THREE.Group(); scene.add(root);
  const mat = (c, o = {}) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...o });
  const orange = mat(0xc0452f), orangeDark = mat(0x8e3224), concrete = mat(0xb8b2a6), white = mat(0xf2f0ea), red = mat(0xb03026), median = mat(0xa9a69e);

  /* ---------- the Golden Gate Bridge ---------- */
  const A = proj.xz(...GGB.south), B = proj.xz(...GGB.north);
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;   // along, south to north
  const vx = -uz, vz = ux;                                                                         // across (east +)
  const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], half = L / 2;
  const W = (s, t, y) => new THREE.Vector3(mid[0] + ux * s + vx * t, y, mid[1] + uz * s + vz * t);
  const bridge = new THREE.Group(); root.add(bridge);
  const yaw = Math.atan2(ux, uz);
  const box = (sx, sy, sz, m, s, t, y, rot = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.copy(W(s, t, y)); o.rotation.y = yaw + rot; o.castShadow = true; o.receiveShadow = true; bridge.add(o); return o; };
  // the deck follows its own centre line (ggb.js: straight over the water, curving at both ends): a point s along it,
  // d across from the centre line (east +), at height y; the way it runs there
  const cl = s => proj.xz(...fromST(s, centreT(s)));
  function D(s, d, y) {
    const p = cl(s), a = cl(s - 1), b = cl(s + 1), tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
    return { x: p[0] - tz / l * d, y, z: p[1] + tx / l * d, yaw: Math.atan2(tx, tz) };
  }
  // the deck's stations: 40 m apart over the straight, 10 m on the curves
  const S0 = GGB.span[0], S1 = GGB.span[1], st = [];
  for (let s = S0; s < S1; s += s < -1150 || s > 1210 ? 10 : 40) st.push(s);
  st.push(S1);
  const segBox = (sx, sy, m, s0, s1, d, y0, y1) => {
    const a = D(s0, d, y0), b = D(s1, d, y1), len = Math.hypot(b.x - a.x, b.z - a.z), o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, len + 0.4), m);
    o.position.set((a.x + b.x) / 2, (y0 + y1) / 2, (a.z + b.z) / 2); o.quaternion.setFromEuler(new THREE.Euler(-Math.atan2(y1 - y0, len), Math.atan2(b.x - a.x, b.z - a.z), 0, 'YXZ'));
    o.castShadow = true; o.receiveShadow = true; bridge.add(o); return o;
  };
  // deck: a truss box in segments that follow the deck's rise and its curves; on top six lanes with their lines and a
  // sidewalk each side (the road shader), thin railings at the edges; at the towers the sidewalks step out round the legs
  const rail = [], legT = 14.6;
  for (let i = 1; i < st.length; i++) {
    const s0 = st[i - 1], s1 = st[i], h0 = deckH(s0), h1 = deckH(s1);
    const dp = s0 >= -1000 && s1 <= 1100 ? 7.6 : 2.4;  // the stiffening truss over the suspended spans, girders on the approaches
    segBox(GGB.deckW, dp, orange, s0, s1, 0, h0 - 0.15 - dp / 2, h1 - 0.15 - dp / 2);
    for (const t of [-1, 1]) for (const [y, th] of [[1.15, 0.09], [0.55, 0.05]]) segBox(0.07, th, orange, s0, s1, t * (GGB.deckW / 2 - 0.15), h0 + y, h1 + y);
    // a low curb between the roadway and each sidewalk (a railing on it, below), the movable median barrier down the middle
    for (const t of [-1, 1]) segBox(0.35, 0.3, concrete, s0, s1, t * 10.15, h0 + 0.15, h1 + 0.15);
    segBox(0.6, 0.82, median, s0, s1, 0, h0 + 0.41, h1 + 0.41);
    for (let k = s0; k < s1; k += 4) if (Math.abs(Math.abs(k) - GGB.towers) > 12) for (const t of [-1, 1]) { const p = D(k, t * (GGB.deckW / 2 - 0.15), deckH(k) + 0.6); rail.push(new THREE.Vector3(p.x, p.y, p.z)); }
  }
  for (const s of [-GGB.towers, GGB.towers]) for (const t of [-1, 1]) {  // the walkways round the tower legs
    box(4.2, 1.2, 30, concrete, s, t * (legT + 6.9), deckH(s) - 0.62);
    box(0.08, 1.15, 30, orange, s, t * (legT + 8.95), deckH(s) + 0.6);
  }
  if (mats?.road) {
    const { builder, ribbon } = roadLib, Bd = builder(), axis = [], H = (x, z) => deckH(toST(proj.lat(z), proj.lon(x))[0]);
    for (let s = S0; s <= S1; s += 5) axis.push(s);
    const line = d => axis.map(s => { const p = D(s, d, 0); return [p.x, p.z]; });
    ribbon(Bd, line(0), { w: 20, lm: 2, lanes: 6, hAt: H, lift: 0.02, step: 10 });
    for (const t of [-1, 1]) ribbon(Bd, line(t * 11.8), { w: 3.2, surf: 1, hAt: H, lift: 0.06, step: 10 });
    const d = Bd.done(), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); g.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2)); g.setAttribute('rd', new THREE.BufferAttribute(d.code, 4)); g.setAttribute('rd2', new THREE.BufferAttribute(d.code2, 4));
    g.setIndex(new THREE.BufferAttribute(d.idx, 1)); g.computeVertexNormals(); g.computeBoundingSphere();
    const top = new THREE.Mesh(g, mats.road); top.receiveShadow = true; bridge.add(top);
  }
  { const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), orange, rail.length), m4 = new THREE.Matrix4();
    rail.forEach((p, i) => post.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z))); post.computeBoundingSphere(); bridge.add(post); }
  // the railings' bars: a strip along each edge, its balusters (19 cm apart) cut in the shader
  { const pos = [], uv = [], idx = [];
    for (const [t, top] of [[-GGB.deckW / 2 + 0.15, 1.2], [GGB.deckW / 2 - 0.15, 1.2], [-10.15, 1.1], [10.15, 1.1]]) { const b = pos.length / 3; let n = 0;  // outer railings, the ones between road and sidewalk
      for (let s = S0; s <= S1; s += 2, n++) { const p = D(s, t, 0), h = deckH(s); pos.push(p.x, h + 0.05, p.z, p.x, h + top, p.z); uv.push(s - S0, 0, s - S0, 1); }
      for (let k = 1; k < n; k++) { const a = b + 2 * (k - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ color: 0xc0452f, side: THREE.DoubleSide });
    m.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vBar;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvBar = uv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vBar;').replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vBar.y > 0.06 && vBar.y < 0.93 && fract(vBar.x / 0.19) > 0.3) discard;');
    };
    m.customProgramCacheKey = () => 'jw-ggb-rail-1';
    const bars = new THREE.Mesh(g, m); bars.castShadow = true; bars.receiveShadow = true; bridge.add(bars); }
  // towers: two legs each (their inner faces at the roadway's edge, the sidewalks going round them), portal struts above
  // the deck, a pier at the water
  for (const s of [-half, half]) {
    for (const t of [-legT, legT]) {
      for (const [y0, y1, w] of [[0, 70, 9.6], [70, 150, 8.6], [150, GGB.towerTop, 7.4]]) box(w, y1 - y0, w * 1.6, orange, s, t, (y0 + y1) / 2);
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
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, 0.46, 8), orange); tube.castShadow = true; bridge.add(tube);  // 0.92 m across
    for (const p of pts) { const s = (p.x - mid[0]) * ux + (p.z - mid[1]) * uz, d = deckH(s); if (p.y - d > 3) susp.push(p.x, p.y, p.z, p.x, d + 0.5, p.z); }
    // between the samples, every 15 m
    for (let s = -half + 15; s < half; s += 15) { const f = s / half, top = GGB.towerTop - 2, low = deckH(0) + 4, y = low + (top - low) * f * f, p = W(s, t, y); susp.push(p.x, y, p.z, p.x, deckH(s) + 0.5, p.z); }
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(susp, 3));
  bridge.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xa83a2e })));
  // anchorages: massive blocks from the ground (or the sea floor) up under the deck; the north one carries the roadway
  // from the side span to the north approach (OpenStreetMap's road on it runs s 984 to 1092)
  box(42, deckH(-GGB.anchor) - 8.2 + 8, 56, concrete, -GGB.anchor, 0, (deckH(-GGB.anchor) - 8.2 - 8) / 2);
  { const s = 1038, top = deckH(s) - 8.2; box(44, top + 8, 120, concrete, s, 0, (top - 8) / 2); }
  // the San Francisco end: concrete pylons rising over the roadway either side at both ends of the steel arch over Fort
  // Point (S1 at the anchorage, S2 at the arch's south end: OpenStreetMap's Pylon S1 / S2), the arch itself
  for (const s of [-GGB.anchor, -1100]) for (const t of [-1, 1]) box(5, deckH(s) + 9, 8, concrete, s, t * (GGB.deckW / 2 + 2.8), (deckH(s) + 9) / 2);
  for (const t of [-9, 9]) {
    const pts = []; for (let s = -1094; s <= -987; s += 6) { const f = (s + 1040.5) / 53.5; pts.push(W(s, t, 14 + (deckH(s) - 8.5 - 14) * (1 - f * f))); }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 1.1, 6), orange); tube.castShadow = true; bridge.add(tube);
  }
  // lamp standards along both rails every 50 m (the Art Deco lamps), the lantern leaning over the roadway
  { const lp = [], lg = new THREE.BoxGeometry(0.22, 7.4, 0.22).translate(0, 3.7, 0), am = new THREE.BoxGeometry(0.14, 0.14, 1.4).translate(0, 7.3, 0.6), ln = new THREE.BoxGeometry(0.42, 0.5, 0.42).translate(0, 7.1, 1.25);
    for (let s = S0 + 25; s < S1 - 10; s += 50) if (Math.abs(Math.abs(s) - GGB.towers) > 30) for (const t of [-1, 1]) { const p = D(s, t * (GGB.deckW / 2 - 0.4), deckH(s)); lp.push([p.x, p.y, p.z, p.yaw + (t > 0 ? Math.PI / 2 : -Math.PI / 2)]); }
    const geo = mergeBoxes([lg, am, ln]), im = new THREE.InstancedMesh(geo, orange, lp.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
    lp.forEach(([x, y, z, ry], i) => im.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(0, ry, 0)), one))); im.castShadow = true; im.computeBoundingSphere(); bridge.add(im); }
  // the approaches' piers (concrete, to well below the ground) every 45 m where the deck curves off the axis
  for (let s = S0 + 12; s < S1; s += 45) if (s < -1140 || s > 1100) {
    const p = D(s, 0, 0), h = deckH(s) - 2.6, o = new THREE.Mesh(new THREE.BoxGeometry(18, h + 40, 3.2), concrete);
    o.position.set(p.x, (h - 40) / 2, p.z); o.rotation.y = p.yaw; o.castShadow = true; o.receiveShadow = true; bridge.add(o);
  }
  // one draw per material for the boxes (towers, struts, deck truss, rails, piers): hundreds of meshes otherwise
  {
    bridge.updateMatrixWorld(true);
    const groups = new Map();
    for (const o of [...bridge.children]) if (o.isMesh && !o.isInstancedMesh && o.geometry.type === 'BoxGeometry') { (groups.get(o.material) ?? groups.set(o.material, []).get(o.material)).push(o); bridge.remove(o); }
    for (const [m, list] of groups) {
      const pos = [], nor = [];
      for (const o of list) {
        const g = o.geometry.toNonIndexed(); g.applyMatrix4(o.matrix);
        pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); g.dispose(); o.geometry.dispose();
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true; bridge.add(mesh);
    }
  }

  function mergeBoxes(list) {
    const pos = [], nor = []; for (const g of list) { const n = g.toNonIndexed(); pos.push(...n.attributes.position.array); nor.push(...n.attributes.normal.array); n.dispose(); g.dispose(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); return g;
  }
  // the rider's deck (ggb.js, the same deck the course's heights come from): the roadway's height, null off the deck
  function deckAt(x, z) { const k = onDeck(proj.lat(z), proj.lon(x)); return k ? k.h + 0.05 : null; }

  /* ---------- San Francisco: the skyline across the strait (outside the baked world) ---------- */
  const city = new THREE.Group(); root.add(city);
  baked?.index?.().then(ix => buildCity(ix)).catch(() => {});
  function buildCity() {
    // San Francisco's hills (Telegraph, Russian, Nob, Rincon) under the blocks: [lat, lon, height, radius m]
    const HILLS = [[37.8024, -122.4058, 80, 260], [37.8011, -122.4194, 88, 420], [37.7930, -122.4161, 96, 480], [37.7862, -122.3925, 30, 250], [37.7975, -122.4260, 40, 500]];
    const groundSF = (x, z) => { let h = 4; for (const [la, lo, hh, r] of HILLS) { const [hx, hz] = proj.xz(la, lo), d2 = (x - hx) ** 2 + (z - hz) ** 2; h = Math.max(h, 4 + hh * Math.exp(-d2 / (r * r))); } return h; };
    const blocks = [];
    const fidi = proj.xz(37.7915, -122.3990);
    for (let la = 37.765; la < 37.809; la += 0.001) for (let lo = -122.4295; lo < -122.384; lo += 0.0013) {
      const i = Math.round(la * 1e4), j = Math.round(lo * 1e4); if (hash2(i, j) < 0.22) continue;
      const lat = la + (hash2(j, i) - 0.5) * 0.0005, lon = lo + (hash2(i + 3, j) - 0.5) * 0.0006;
      // the bay: roughly north of the Embarcadero / Marina shore
      const shore = lon > -122.395 ? 37.7985 + (lon + 122.395) * 1.3 : lon > -122.41 ? 37.8075 : lon > -122.425 ? 37.8050 : 37.8035;
      if (lat > shore || (lon > -122.388 && lat > 37.79)) continue;
      const [x, z] = proj.xz(lat, lon), d = Math.hypot(x - fidi[0], z - fidi[1]);
      const tall = Math.exp(-(d * d) / (650 * 650)), h = 9 + hash2(i, j + 9) * 12 + tall * (25 + hash2(j, i + 4) * 120);
      const w = 20 + hash2(i + 7, j) * 22 + tall * 8;
      blocks.push([x, z, w, h, w * (0.7 + hash2(j + 2, i) * 0.6), groundSF(x, z)]);
    }
    // the low city seen across the strait from the Headlands (Street View): the Marina, Cow Hollow, Pacific Heights, the
    // Richmond and Sea Cliff, rows of two to four storey houses; not the Presidio's woods, Lincoln Park or the water
    for (let la = 37.772; la < 37.806; la += 0.0007) for (let lo = -122.512; lo < -122.43; lo += 0.0009) {
      const i = Math.round(la * 1e4), j = Math.round(lo * 1e4); if (hash2(i + 11, j) < 0.3) continue;
      const lat = la + (hash2(j, i + 5) - 0.5) * 0.0004, lon = lo + (hash2(i + 7, j) - 0.5) * 0.0005;
      if (lat > (lon < -122.49 ? 37.787 : lon < -122.447 ? 37.7885 : 37.8045)) continue;   // Sea Cliff's bluffs, the Presidio, the Marina's shore
      if (lat > 37.778 && lon < -122.494) continue;                                        // Lincoln Park
      if (lat < 37.7745 && lon < -122.454) continue;                                       // Golden Gate Park
      const [x, z] = proj.xz(lat, lon), w = 14 + hash2(i, j + 2) * 12;
      blocks.push([x, z, w, 7 + hash2(j + 1, i) * 8, w * (0.8 + hash2(i + 2, j) * 0.5), 4 + 40 * hash2(Math.round(la * 300), Math.round(lo * 300)) ** 2]);
    }
    // a city block: a box with floors of windows in its own shader (bands that fade out far away)
    const cityMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    cityMat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCw;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCw = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCw;').replace('#include <color_fragment>', `#include <color_fragment>
        if (distance(vCw.xz, cameraPosition.xz) < 3400.0) discard;  // near: the baked world's own buildings
        float fl = vCw.y / 3.6, fw = fwidth(fl), band = smoothstep(0.35, 0.5, fract(fl)) * (1.0 - smoothstep(0.85, 1.0, fract(fl)));
        diffuseColor.rgb *= mix(1.0, mix(0.62, 0.86, step(0.5, fract(vCw.x * 0.05 + vCw.z * 0.03))), band * (1.0 - smoothstep(0.15, 0.5, fw)) * step(0.3, abs(normalize(vNormal).x) + abs(normalize(vNormal).z)));`);
    };
    cityMat.customProgramCacheKey = () => 'jw-city-2';
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), im = new THREE.InstancedMesh(geo, cityMat, blocks.length);
    const m4 = new THREE.Matrix4(), c = new THREE.Color(), tones = [0xe9e6df, 0xd9d4ca, 0xc8c6c2, 0xb9b8b6, 0xe2d6c0, 0xa9b2ba, 0xf0ece4, 0xcfc2ae];
    blocks.forEach(([x, z, w, h, dep, g], i) => {
      im.setMatrixAt(i, m4.makeScale(w, h + g, dep).setPosition(x, 0, z));
      im.setColorAt(i, c.set(tones[Math.floor(hash2(i, 3) * tones.length)]));
    });
    im.computeBoundingSphere(); city.add(im);
    const at = (la, lo) => { const [x, z] = proj.xz(la, lo); return [x, groundSF(x, z), z]; };
    const put = (geo, color, la, lo, ry = 0) => { const [x, y, z] = at(la, lo), m = new THREE.Mesh(geo, mat(color, { flatShading: false })); m.position.set(x, y - 2, z); m.rotation.y = ry; city.add(m); return m; };
    // Salesforce Tower (326 m): a rounded square tapering a little, a pale lattice crown
    put(new THREE.CylinderGeometry(20, 26, 300, 24, 1).translate(0, 150, 0), 0xc9d0d6, 37.7898, -122.3968);
    put(new THREE.CylinderGeometry(19.5, 20, 26, 24, 1, true).translate(0, 313, 0), 0xe9ecee, 37.7898, -122.3968).material.side = THREE.DoubleSide;
    // Transamerica Pyramid (260 m): a slender four-sided pyramid with its wings, a spire
    put(new THREE.CylinderGeometry(2.5, 27, 212, 4, 1).translate(0, 106, 0), 0xeeeae2, 37.7952, -122.4028, Math.PI / 4);
    put(new THREE.CylinderGeometry(0.3, 2.5, 48, 4, 1).translate(0, 236, 0), 0xeeeae2, 37.7952, -122.4028, Math.PI / 4);
    for (const s of [-1, 1]) put(new THREE.BoxGeometry(9, 150, 6).translate(s * 20, 135, 0).applyMatrix4(new THREE.Matrix4().makeRotationZ(-s * 0.1)), 0xe6e2da, 37.7952, -122.4028, 0.15);
    // Coit Tower on Telegraph Hill: a fluted column
    put(new THREE.CylinderGeometry(5.5, 6, 64, 16).translate(0, 32, 0), 0xece6d8, 37.8024, -122.4058);
    // more of the skyline: 181 Fremont, Millennium, 555 California (dark), 345 California, the Embarcadero Center, One Rincon,
    // the Ferry Building's clock tower
    for (const [la, lo, h, w, col] of [[37.7897, -122.3954, 245, 30, 0xb7c0c8], [37.7906, -122.3963, 197, 30, 0xc9ced4], [37.7920, -122.4038, 237, 46, 0x4b3f3a],
      [37.7926, -122.4006, 212, 36, 0xd8d2c6], [37.7948, -122.3990, 172, 40, 0xe4e0d8], [37.7951, -122.3975, 150, 40, 0xe4e0d8], [37.7955, -122.3962, 125, 40, 0xe4e0d8],
      [37.7864, -122.3918, 188, 28, 0xbfc6cc], [37.7937, -122.3984, 160, 38, 0xd2ccc0], [37.7889, -122.4014, 180, 34, 0xa8b0b8]]) put(new THREE.BoxGeometry(w, h, w * 0.8).translate(0, h / 2, 0), col, la, lo, 0.3);
    put(new THREE.BoxGeometry(14, 75, 14).translate(0, 37.5, 0), 0xf0ead8, 37.7955, -122.3937, 0.3);
    put(new THREE.BoxGeometry(200, 14, 30).translate(0, 7, 0), 0xe8e0cc, 37.7953, -122.3930, 0.3);
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

  /* ---------- Karl the fog: banks lying on the sea along the coast, rolling in through the Golden Gate ---------- */
  // [lat, lon] of each end of a bank's spine, its width (m) and height (m)
  const banks = [];
  for (const [a, b, w, h] of [[[37.8105, -122.4805], [37.8085, -122.4995], 520, 95], [[37.8085, -122.492], [37.8035, -122.545], 900, 150], [[37.818, -122.548], [37.842, -122.585], 1100, 190],
    [[37.85, -122.6], [37.885, -122.655], 1300, 210], [[37.89, -122.67], [37.93, -122.735], 1400, 230], [[37.79, -122.56], [37.79, -122.64], 1800, 260],
    [[37.95, -122.76], [37.99, -122.83], 1600, 240]]) {
    const [ax, az] = proj.xz(...a), [bx, bz] = proj.xz(...b), L = Math.hypot(bx - ax, bz - az), n = Math.max(10, Math.round(L / 160));
    for (let k = 0; k < n; k++) {
      const t = (k + hash2(k, L | 0)) / n, side = (hash2(L | 0, k) - 0.5) * w, mid = 1 - Math.abs(t - 0.5) * 1.4;
      const x = ax + (bx - ax) * t - (bz - az) / L * side, z = az + (bz - az) * t + (bx - ax) / L * side;
      const s = (300 + 500 * hash2(k, 3)) * (0.6 + 0.6 * mid), y = s * 0.16 + h * mid * hash2(k, 9);
      banks.push([x, z, s, y]);
    }
  }
  sky.placeBanks(banks);

  // the deck's height line, also past its ends (any OpenStreetMap piece of the bridge the deck does not cover)
  const deckLine = (x, z) => deckH(toST(proj.lat(z), proj.lon(x))[0]);
  // a point on the bridge's road deck: s metres along from mid span (south to north), t across (east +), its heading
  const lane = (s, t) => { const p = D(s, t, deckH(s) + 0.05); return { x: p.x, y: p.y, z: p.z, yaw: p.yaw }; };
  return { ggb: true, deckAt, deckLine, lane, span: GGB.span, update() {}, dispose() { root.traverse(o => o.geometry?.dispose()); scene.remove(root); } };
}
