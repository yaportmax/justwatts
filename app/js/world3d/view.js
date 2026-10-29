// World 3D view: the Marin world in three.js around an open-world rider. Terrain, roads, trees and buildings stream
// in by Web Mercator tile from the baked world (baked.js), finest around the rider; a chase camera follows the road.
// Rendering runs on its own requestAnimationFrame loop and never touches the ride: any error, a lost context or a
// frame rate that stays bad calls onFail and the ride map falls back to the other views.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { makeProj, tileX, tileY, key, unkey, headingOf, angDiff } from './geo.js';
import { gridFromHeights, gridHeight, gridIJ, carve, rasterClasses, gridMesh, upsample, gridNormals, gridCurvature, classMasks } from './terrain.js';
import { builder, ribbon, deckSides, roadStyle, roadLift, resample, clipLine } from './ribbon.js';
import { wanted, plan, jobQueue, childrenOf, NEAR_Z, FAR_Z } from './stream.js';
import { scatter, hash2, KINDS } from './landuse.js';
import { terrainMaterial, roadMaterial, propMaterial, buildingMaterial, grassMaterial, WIND } from './materials.js';
import { treeGeometries, species, buildingGeometry } from './props.js';
import { createSky } from './sky.js';
import { createPost } from './post.js';
import { createGrass } from './grass.js';
import { makeRider } from './rider.js';
import { createLandmarks } from './marin.js';

const ORIGIN = [37.93, -122.63];  // the middle of the Marin world: every coordinate stays within about 25 km
// quality tiers: shadow map size (0: none) and span, pixel ratio cap, tree share, near rings, far ring, terrain grid
// (segs) and upsampling near the rider (up), draw distance, post-processing (bloom, MSAA samples), grass radius and
// clumps per square metre, ground detail (bump, close-up noise)
export const QUALITY = [
  { name: 'high', shadow: 2048, span: 70, pr: 1.5, trees: 1, rings: [1, 2], far: 2, segs: 128, up: 2, view: 42000, post: true, bloom: true, msaa: 4, grass: [64, 4], detail: true, treeNear: 300 },
  { name: 'medium', shadow: 1024, span: 55, pr: 1, trees: 0.6, rings: [1, 2], far: 2, segs: 128, up: 2, view: 32000, post: true, bloom: true, msaa: 2, grass: [44, 2.6], detail: true, treeNear: 200 },
  { name: 'low', shadow: 0, span: 0, pr: 0.8, trees: 0.3, rings: [1, 1], far: 1, segs: 64, up: 1, view: 22000, post: false, bloom: false, msaa: 0, grass: [24, 1.4], detail: false, treeNear: 120 },
];
const CAP = { 0: 6000, 1: 1600 };
const OCC = 512;  // the road mask per tile: cells of about 3.8 m (no grass, trees or shrubs on a road)  // trees per tile at full share, by detail

export function createWorldView({ container, baked, getOthers = () => [], onFail = () => {}, quality = 0, time = 'golden' }) {
  let q = Math.max(0, Math.min(2, quality)), dead = false, raf = 0;
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'; container.appendChild(canvas);
  const tags = document.createElement('div'); tags.className = 'w3tags'; container.appendChild(tags);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true, failIfMajorPerformanceCaveat: false });
  } catch (e) { canvas.remove(); tags.remove(); throw e; }
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); canvas.remove(); tags.remove(); throw new Error('no WebGL2'); }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = true;
  renderer.info.autoReset = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(new Error('WebGL context lost')); });

  const scene = new THREE.Scene(), proj = makeProj(...ORIGIN);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 60000);
  const sky = createSky(scene, { far: 60000 }); sky.set(time);
  const mats = { terrain: terrainMaterial(), terrainFar: terrainMaterial({ detail: false }), road: roadMaterial(), prop: propMaterial(), propLo: propMaterial({ wind: false }),
    bldg: buildingMaterial(), grass: grassMaterial(), pillar: new THREE.MeshLambertMaterial({ color: 0x9a968c }),
    tunnel: new THREE.MeshLambertMaterial({ color: 0x77736b, emissive: 0x1a1712 }), portal: new THREE.MeshLambertMaterial({ color: 0xa8a297 }) };
  const trees = treeGeometries(), treesLo = treeGeometries(true), pillarGeo = new THREE.BoxGeometry(1.6, 1, 1.6).translate(0, 0.5, 0);
  const marks = createLandmarks({ THREE, scene, proj, sky, mats, baked });
  const post = createPost(renderer, scene, camera);

  /* ---------- streaming ---------- */
  const near = new Map(), far = new Map(), jobs = jobQueue();
  const tileOf = (x, z) => { const lat = proj.lat(z), lon = proj.lon(x); return [Math.floor(tileX(lon, NEAR_Z)), Math.floor(tileY(lat, NEAR_Z))]; };
  function disposeObj(o) {
    o.traverse(m => { if (m.isInstancedMesh) m.dispose(); else if (m.geometry && !m.userData.shared) m.geometry.dispose(); });
    o.parent?.remove(o);
  }
  function newChunk(k, lod) {
    const [z, x, y] = unkey(k), c = { k, z, x, y, lod, tile: undefined, grid: null, group: new THREE.Group(), parts: {}, sig: {}, decks: [], built: false, occ: null };
    scene.add(c.group);
    baked.get(z, x, y).then(t => { c.tile = t; poke(); });
    return c;
  }
  function dropChunk(map, k) { const c = map.get(k); if (!c) return; disposeObj(c.group); map.delete(k); jobs.drop(id => id.startsWith(k + '|')); farDirty = true; }
  function setPart(c, name, obj) { if (c.parts[name]) disposeObj(c.parts[name]); c.parts[name] = obj; if (obj) c.group.add(obj); }

  // a neighbour tile's height sample (grid indices past this tile's edge; tiles share their edge rows), null if not loaded
  const extOf = c => (i, j) => {
    const n = c.tile.n, dx = i < 0 ? -1 : i >= n ? 1 : 0, dy = j < 0 ? -1 : j >= n ? 1 : 0, t = baked.peek(c.z, c.x + dx, c.y + dy);
    if (!t) return null;
    const ii = i < 0 ? n - 1 + i : i >= n ? i - (n - 1) : i, jj = j < 0 ? n - 1 + j : j >= n ? j - (n - 1) : j;
    return ii >= 0 && jj >= 0 && ii < n && jj < n ? t.hs[jj * n + ii] : null;
  };
  function buildTerrain(c) {
    const t = c.tile, Q = QUALITY[q];
    if (!t) { c.grid = null; setPart(c, 'terrain', null); c.built = true; c.ver = (c.ver || 0) + 1; farDirty = true; return; }
    const fine = c.z === NEAR_Z && c.lod === 0, up = fine ? Q.up : 1;
    const step = c.z === FAR_Z ? 1 : c.lod === 0 ? (Q.segs === 128 ? 1 : 2) : 4, gk = up > 1 ? 'u' + up : 's' + step;
    if (!c.grid || c.grid.key !== gk) {
      if (up > 1) c.grid = gridFromHeights({ z: c.z, x: c.x, y: c.y, hs: upsample(t.hs, t.n, up, extOf(c)), n: (t.n - 1) * up + 1, step: 1, proj });
      else c.grid = gridFromHeights({ z: c.z, x: c.x, y: c.y, hs: t.hs, n: t.n, step, proj });
      c.grid.key = gk; c.grid.m = up > 1 ? 1 / up : step;  // source steps (about 15 m) per grid step
    }
    c.grid.cut = null; c.grid.hs = c.grid.raw;
    const ms = c.grid.m;
    if (fine) {
      // every road level across its width (heights along it from the ground, eased), cut and fill banks either side
      const under = [];
      for (const r of t.roads) {
        if (r.fl & 3 || /path|footway|track|bridleway|steps/.test(r.hw)) continue;
        const pts = resample(r.pts.map(([la, lo]) => proj.xz(la, lo)), 8), P = [];
        for (let i = 0; i < pts.length; i++) { const h = gridHeight(c.grid, pts[i][0], pts[i][1], c.grid.raw); if (h != null) P.push([pts[i][0], pts[i][1], h]); }
        for (let k = 0; k < 4; k++) for (let i = 1; i + 1 < P.length; i++) P[i][2] = (P[i - 1][2] + 2 * P[i][2] + P[i + 1][2]) / 4;
        const w = roadStyle(r.hw, r.ln, r.fl).w;
        if (P.length > 1) under.push({ pts: P, r0: w / 2 + Math.max(2.5, 8 * ms), r1: w / 2 + Math.max(9, 22 * ms) });
      }
      // the ridden road is one of them: the rider sits on the same ground (the engine's grade comes from these heights too)
      carve(c.grid, [], 0, 1, under);
    }
    const lu = rasterClasses(c.grid, t.features), m = gridMesh(c.grid, { lu, skirt: c.z === FAR_Z ? 40 : 12, skip: c.z === FAR_Z ? farSkip(c) : null });
    const nor = gridNormals(c.grid), mask = classMasks(lu, c.grid.cut), cv = gridCurvature(c.grid, c.z === FAR_Z ? 400 : 25, c.z === FAR_Z ? 40 : 6);
    const nv = m.src.length, N = new Float32Array(nv * 3), A = new Uint8Array(nv * 4), B = new Uint8Array(nv * 4), CV = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const v = m.src[i]; N[3 * i] = nor[3 * v]; N[3 * i + 1] = nor[3 * v + 1]; N[3 * i + 2] = nor[3 * v + 2]; CV[i] = cv[v];
      for (let k = 0; k < 4; k++) { A[4 * i + k] = mask[8 * v + k]; B[4 * i + k] = mask[8 * v + 4 + k]; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('mk', new THREE.BufferAttribute(A, 4, true)); g.setAttribute('mk2', new THREE.BufferAttribute(B, 4, true)); g.setAttribute('cv', new THREE.BufferAttribute(CV, 1));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1)); g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, c.z === NEAR_Z && Q.detail ? mats.terrain : mats.terrainFar); mesh.receiveShadow = fine; mesh.matrixAutoUpdate = false;
    if (fine) { c.nor = nor; c.mask = mask; c.cv = cv; grass.invalidate(); } else { c.nor = c.mask = c.cv = null; }
    setPart(c, 'terrain', mesh); c.built = true; c.ver = (c.ver || 0) + 1; if (c.z === NEAR_Z) farDirty = true;
  }
  // far tiles leave out the quads a built near tile covers
  function farSkip(c) {
    const s = 2 ** (NEAR_Z - FAR_Z), per = c.grid.segs / s;
    return (i, j) => { const n = near.get(key(NEAR_Z, c.x * s + Math.floor(i / per), c.y * s + Math.floor(j / per))); return !!n?.built; };
  }
  const hOf = c => (x, z) => c.grid ? gridHeight(c.grid, x, z) : null;
  function buildRoads(c) {
    const t = c.tile; c.decks = []; c.occ = null;
    if (!t || !c.grid) return setPart(c, 'roads', null);
    const B = builder(), pillars = [], hAt = hOf(c), g = c.grid, occ = new Uint8Array(OCC * OCC), ox = Math.min(g.xs[0], g.xs[g.segs]), oz = Math.min(g.zs[0], g.zs[g.segs]);
    const ow = Math.abs(g.xs[g.segs] - g.xs[0]) / OCC, oh = Math.abs(g.zs[g.segs] - g.zs[0]) / OCC;
    const mark = (x, z, r) => { for (let a = Math.floor((x - r - ox) / ow); a <= Math.floor((x + r - ox) / ow); a++) for (let b = Math.floor((z - r - oz) / oh); b <= Math.floor((z + r - oz) / oh); b++) if (a >= 0 && b >= 0 && a < OCC && b < OCC) occ[b * OCC + a] = 1; };
    const minor = c.lod > 0, lanes = [], tbox = [Math.min(g.xs[0], g.xs[g.segs]), Math.min(g.zs[0], g.zs[g.segs]), Math.max(g.xs[0], g.xs[g.segs]), Math.max(g.zs[0], g.zs[g.segs])];
    for (const r of t.roads) {
      if (r.fl & 2) continue;                          // tunnels: under the hill
      if (minor && /path|footway|track|bridleway|service/.test(r.hw)) continue;
      const st = roadStyle(r.hw, r.ln, r.fl);
      const all = r.pts.map(([la, lo]) => proj.xz(la, lo)), runs = [[]];
      for (const p of all) { if (r.fl & 16 && marks.deckAt(p[0], p[1]) != null) { if (runs.at(-1).length) runs.push([]); } else runs.at(-1).push(p); }  // the bridge's own deck
      for (const pts of runs.flatMap(run => run.length > 1 ? clipLine(run, tbox) : [])) {  // exactly this tile: the next one draws on from its edge
      if (pts.length < 2) continue;
      const dk = r.fl & 16 && r.dk ? [marks.deckLine(...pts[0]), marks.deckLine(...pts.at(-1))] : r.dk;  // the approaches meet the deck
      const centre = ribbon(B, pts, { ...st, hAt, lift: roadLift(r.hw), deck: dk || null, step: minor ? 12 : 5 });
      if (dk) {
        pillars.push(...deckSides(B, centre, st.w, 1.4, hAt));
        for (let i = 1; i < centre.length; i++) c.decks.push([centre[i - 1], centre[i], st.w / 2 + 0.6]);
      }
      if (!minor) centre.forEach((q, i) => { mark(q[0], q[2], st.w / 2 + 1.2); lanes.push(q[0], q[2], st.w / 2); if (i) { const p = centre[i - 1]; mark((p[0] + q[0]) / 2, (p[2] + q[2]) / 2, st.w / 2 + 1.2); } });
      }
    }
    c.occ = { occ, ox, oz, ow, oh }; c.lanes = new Float32Array(lanes);
    if (!B.n) return setPart(c, 'roads', null);
    const d = B.done(), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); geo.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2));
    geo.setAttribute('rd', new THREE.BufferAttribute(d.code, 4)); geo.setIndex(new THREE.BufferAttribute(d.idx, 1)); geo.computeVertexNormals(); geo.computeBoundingSphere();
    const grp = new THREE.Group(), mesh = new THREE.Mesh(geo, mats.road); mesh.receiveShadow = c.lod === 0; grp.add(mesh);
    if (pillars.length) {
      const im = new THREE.InstancedMesh(pillarGeo, mats.pillar, pillars.length), m4 = new THREE.Matrix4();
      pillars.forEach(([x, z, top, bot], i) => im.setMatrixAt(i, m4.makeScale(1, top - bot, 1).setPosition(x, bot, z)));
      im.userData.shared = true; im.castShadow = true; grp.add(im);
    }
    setPart(c, 'roads', grp);
  }
  const occAt = (o, x, z) => { if (!o) return false; const a = Math.floor((x - o.ox) / o.ow), b = Math.floor((z - o.oz) / o.oh); return a >= 0 && b >= 0 && a < OCC && b < OCC && o.occ[b * OCC + a] === 1; };
  function buildTrees(c) {
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'trees', null);
    const share = QUALITY[q].trees, cap = CAP[c.lod] * share, g = c.grid, hAt = hOf(c);
    const box = [Math.min(g.xs[0], g.xs[g.segs]), Math.min(g.zs[0], g.zs[g.segs]), Math.max(g.xs[0], g.xs[g.segs]), Math.max(g.zs[0], g.zs[g.segs])];
    const out = {}; let n = 0;
    const add = (sp, x, z, s, r) => { const y = hAt(x, z); if (y == null || y < 1.2 || occAt(c.occ, x, z)) return; (out[sp] ??= []).push([x, y - 0.3, z, s, r]); n++; };
    const STEP = { wood: 11, scrub: 8, park: 24, urban: 30, grass: 70, farm: 90 };
    for (const f of t.features) {
      const st = STEP[f.k]; if (!st) continue;
      const rings = f.rings.map(r => r.map(([la, lo]) => proj.xz(la, lo)));
      const step = st * (c.lod ? 2.2 : 1) / Math.sqrt(Math.max(0.15, share));
      for (const [x, z, r] of scatter(rings, step, f.k === 'urban' ? 0.55 : f.k === 'grass' || f.k === 'farm' ? 0.6 : 1, box)) {
        if (n > cap) break;
        const lat = proj.lat(z), lon = proj.lon(x), h = hAt(x, z) ?? 0, sp = species(f.k, f.lt, h, lat, lon, r);
        add(sp, x, z, 0.75 + 0.5 * hash2(Math.round(x), Math.round(z)), r);
      }
    }
    // lone oaks on the open hills, in loose clumps
    if (c.lod === 0) {
      const step = 26 / Math.sqrt(Math.max(0.15, share));
      for (let x = Math.ceil(box[0] / step) * step; x < box[2]; x += step) for (let z = Math.ceil(box[1] / step) * step; z < box[3]; z += step) {
        if (n > cap) break;
        const ix = Math.round(x / step), iz = Math.round(z / step), clump = hash2(Math.floor(x / 260), Math.floor(z / 260));
        if (hash2(ix, iz) > clump * clump * 0.5) continue;
        const px = x + (hash2(iz, ix) - 0.5) * step, pz = z + (hash2(ix + 5, iz) - 0.5) * step, h = hAt(px, pz);
        if (h == null || h < 6) continue;
        add('oak', px, pz, 0.6 + 0.6 * hash2(ix, iz + 3), hash2(ix + 1, iz));
      }
      // coyote brush and toyon in patches on the open hills: thickest on the shaded north slopes and in the gullies
      const ss = 7 / Math.sqrt(Math.max(0.2, share)), nn = g.segs + 1;
      let shrubs = 0;
      for (let x = Math.ceil(box[0] / ss) * ss; x < box[2]; x += ss) for (let z = Math.ceil(box[1] / ss) * ss; z < box[3]; z += ss) {
        if (shrubs > 5000 * share) break;
        const ix = Math.round(x / ss), iz = Math.round(z / ss), px = x + (hash2(ix + 7, iz) - 0.5) * ss, pz = z + (hash2(ix, iz + 7) - 0.5) * ss;
        const [fi, fj] = gridIJ(g, px, pz), v = Math.round(fj) * nn + Math.round(fi);
        if (!(v >= 0 && v < nn * nn) || !c.mask) continue;
        const mk = c.mask, open = mk[8 * v] < 80 && mk[8 * v + 2] < 60 && mk[8 * v + 3] < 60 && mk[8 * v + 4] < 128 && mk[8 * v + 5] < 128 && mk[8 * v + 6] < 128;
        if (!open || c.nor[3 * v + 1] < 0.8) continue;
        const north = Math.max(0, -c.nor[3 * v + 2] * 2.5), patch = hash2(Math.floor(px / 90), Math.floor(pz / 90)) * 0.7 + hash2(Math.floor(px / 31) + 5, Math.floor(pz / 31)) * 0.3;
        const p = (patch - 0.55) * 1.6 + north * 0.5 + Math.max(0, c.cv[v]) * 0.9 + (mk[8 * v + 1] > 0 ? -0.2 : 0);
        if (hash2(ix * 3, iz * 5) > p) continue;
        const r = hash2(ix, iz * 3);
        add(r < 0.78 ? 'bush' : 'shrub', px, pz, 0.7 + 0.8 * hash2(iz, ix + 1), r); shrubs++;
      }
      // stones in the grass, more on the steep
      for (let k = 0; k < 1400 * share; k++) {
        const px = box[0] + hash2(k, c.x) * (box[2] - box[0]), pz = box[1] + hash2(c.y, k) * (box[3] - box[1]);
        const [fi, fj] = gridIJ(g, px, pz), v = Math.round(fj) * nn + Math.round(fi);
        if (!(v >= 0 && v < nn * nn) || !c.mask || c.mask[8 * v + 3] > 60 || c.mask[8 * v + 2] > 60) continue;
        if (hash2(k, 7) > 0.25 + (1 - c.nor[3 * v + 1]) * 4) continue;
        add('stone', px, pz, 0.6 + 1.4 * hash2(k, 3) ** 2, hash2(k, 5));
      }
    }
    // per species two instanced sets: full trees near the rider, simple ones further out (partTrees splits them)
    const grp = new THREE.Group(); c.treeSets = [];
    for (const [sp, list] of Object.entries(out)) {
      const sm = sp === 'stone', mk = (geo, mat, shadow) => {
        const im = new THREE.InstancedMesh(geo, mat, list.length); im.count = 0; im.userData.shared = true; im.castShadow = shadow; im.receiveShadow = c.lod === 0; grp.add(im); return im;
      };
      const hi = c.lod ? null : mk(trees[sp] ?? trees.bush, sm ? mats.propLo : mats.prop, !sm && QUALITY[q].shadow > 0);
      const lo = sm ? null : mk(treesLo[sp] ?? treesLo.bush, mats.propLo, false);
      c.treeSets.push({ sp, list, hi, lo });
    }
    c.partAt = null; partTrees(c, me.group.position.x, me.group.position.z);
    setPart(c, 'trees', grp);
  }
  // split a tile's trees: within `near` metres of (x, z) the full models, the rest the simple ones (stones only near)
  function partTrees(c, x, z) {
    const R2 = QUALITY[q].treeNear ** 2, m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(), tint = new THREE.Color();
    c.partAt = [x, z];
    for (const { sp, list, hi, lo } of c.treeSets || []) {
      let a = 0, b = 0; const sm = sp === 'stone';
      for (const [px, y, pz, sc, r] of list) {
        const isHi = hi && (px - x) ** 2 + (pz - z) ** 2 < R2 * (sm ? 0.25 : 1);
        if (!isHi && !lo) continue;
        const im = isHi ? hi : lo, i = isHi ? a++ : b++;
        e.set((r - 0.5) * 0.08, r * 6.283, 0); im.setMatrixAt(i, m4.compose(v.set(px, sm ? y + 0.25 : y, pz), qt.setFromEuler(e), s.set(sc, sc * (0.85 + 0.3 * r), sc)));
        const k = 0.86 + 0.28 * hash2(Math.round(px), Math.round(pz)), w = (hash2(Math.round(pz), Math.round(px)) - 0.5) * 0.12;
        im.setColorAt(i, tint.setRGB(k * (1 + w), k, k * (1 - w)));
      }
      for (const [im, n] of [[hi, a], [lo, b]]) if (im) {
        im.count = n; im.visible = n > 0; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (n) im.computeBoundingSphere();
      }
    }
  }
  function buildBuildings(c) {
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'bldg', null);
    const list = [], hAt = hOf(c);
    for (const f of t.features) {
      if (f.k !== 'building') continue;
      let ring = f.rings[0].map(([la, lo]) => proj.xz(la, lo));
      { let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
        const k = 0.04 + 0.12 * hash2(Math.round(cx), Math.round(cz)); ring = ring.map(([x, z]) => { const d = Math.hypot(x - cx, z - cz) || 1; return [x - (x - cx) / d * k, z - (z - cz) / d * k]; }); }
      if (c.lod > 0 && ring.length > 12) continue;
      let base = Infinity; for (const p of ring) { const h = hAt(p[0], p[1]); if (h != null) base = Math.min(base, h); }
      if (!isFinite(base)) continue;
      list.push({ ring, base, h: (f.h || 6) + 0.1 * hash2(Math.round(ring[0][0]), 3), seed: Math.round(ring[0][0] * 13 + ring[0][1] * 7) });
    }
    if (!list.length) return setPart(c, 'bldg', null);
    const mesh = new THREE.Mesh(buildingGeometry(list), mats.bldg); mesh.castShadow = c.lod === 0 && QUALITY[q].shadow > 0; mesh.receiveShadow = c.lod === 0;
    setPart(c, 'bldg', mesh);
  }
  let farDirty = false, lastStream = 0, ready = false;
  const poke = () => { lastStream = 0; };
  function stream(lat, lon, now) {
    if (now - lastStream < 300) return; lastStream = now;
    const Q = QUALITY[q];
    const wn = wanted(lat, lon, NEAR_Z, Q.rings), pn = plan(new Map([...near].map(([k, c]) => [k, c.lod])), wn, lat, lon, 1);
    for (const k of pn.drop) dropChunk(near, k);
    for (const [k, lod] of pn.add) near.set(k, newChunk(k, lod));
    for (const [k, lod] of pn.change) { const c = near.get(k); c.lod = lod; }
    const wf = wanted(lat, lon, FAR_Z, [Q.far]), pf = plan(new Map([...far].map(([k, c]) => [k, c.lod])), wf, lat, lon, 1);
    for (const k of pf.drop) dropChunk(far, k);
    for (const [k, lod] of pf.add) far.set(k, newChunk(k, lod));
    // what each chunk needs (re)built
    const rx = tileX(lon, NEAR_Z), ry = tileY(lat, NEAR_Z);
    for (const c of near.values()) {
      if (c.tile === undefined) continue;
      const pri = Math.hypot(c.x + 0.5 - rx, c.y + 0.5 - ry) + c.lod * 3;
      const ts = `${c.lod}|${q}`;
      if (c.sig.terrain !== ts) { c.sig.terrain = ts; jobs.add(c.k + '|t', pri, () => buildTerrain(c)); }
      const ds = `${ts}|${c.ver}`;
      if (c.ver != null && c.sig.roads !== ds) { c.sig.roads = ds; jobs.add(c.k + '|r', pri + 0.1, () => buildRoads(c)); }
      if (c.ver != null && c.sig.trees !== ds) { c.sig.trees = ds; jobs.add(c.k + '|v', pri + 0.3 + c.lod, () => buildTrees(c)); }
      if (c.ver != null && c.sig.bldg !== ds) { c.sig.bldg = ds; jobs.add(c.k + '|b', pri + 0.2 + c.lod, () => buildBuildings(c)); }
      if (c.ver != null && c.lod === 0 && c.sig.tun !== ds) { c.sig.tun = ds; jobs.add(c.k + '|u', pri + 0.15, () => buildTunnels(c)); }
    }
    for (const c of far.values()) {
      if (c.tile === undefined) continue;
      const mask = childrenOf(c.k).map(k => near.get(k)?.built ? 1 : 0).join('');
      const fs = `${mask}|${q}`;
      if (c.sig.terrain !== fs) { c.sig.terrain = fs; jobs.add(c.k + '|t', 20 + (farDirty ? 0 : 5), () => buildTerrain(c)); }
    }
    farDirty = false;
    ready = [...near.values()].filter(c => c.lod === 0).every(c => c.built);
  }

  // the ground (or a deck) under a local point: the finest built tile there
  function groundAt(x, z) {
    const [tx, ty] = tileOf(x, z), c = near.get(key(NEAR_Z, tx, ty));
    let h = c?.grid ? gridHeight(c.grid, x, z) : null;
    if (h == null) { const lat = proj.lat(z), lon = proj.lon(x), f = far.get(key(FAR_Z, Math.floor(tileX(lon, FAR_Z)), Math.floor(tileY(lat, FAR_Z)))); h = f?.grid ? gridHeight(f.grid, x, z) : null; }
    return h;
  }
  function deckAt(x, z) {
    const [tx, ty] = tileOf(x, z), c = near.get(key(NEAR_Z, tx, ty)); let best = null;
    for (const [a, b, r] of c?.decks || []) {
      const ex = b[0] - a[0], ez = b[2] - a[2], L = ex * ex + ez * ez, t = L ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[2]) * ez) / L)) : 0;
      if (Math.hypot(x - a[0] - ex * t, z - a[2] - ez * t) < r) { const h = a[1] + (b[1] - a[1]) * t; if (best == null || h > best) best = h; }
    }
    return best ?? marks.deckAt(x, z);
  }

  // how far right of the road's centre line a rider rides: about a metre in from the edge
  function keepRight(x, z) {
    const [tx, ty] = tileOf(x, z), L = near.get(key(NEAR_Z, tx, ty))?.lanes; if (!L) return side;
    let best = 1e9, half = null;
    for (let i = 0; i < L.length; i += 3) { const d = (L[i] - x) ** 2 + (L[i + 1] - z) ** 2; if (d < best) { best = d; half = L[i + 2]; } }
    return best < 64 && half != null ? Math.max(0, Math.min(6.5, half - 1.1)) : side;
  }
  // grass: clumps in cells round the camera (grass.js); the ground under a point: height, normal, class weights
  function groundSample(x, z) {
    const [tx, ty] = tileOf(x, z), c = near.get(key(NEAR_Z, tx, ty)); if (!c?.grid || !c.mask) return null;
    if (occAt(c.occ, x, z) || tunnelNear(c, x, z)) return { skip: true };
    const g = c.grid, n = g.segs + 1, [fi, fj] = gridIJ(g, x, z), i = Math.round(fi), j = Math.round(fj);
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    const v = j * n + i, h = gridHeight(g, x, z), mk = c.mask, N = c.nor; if (h == null || h < 1.2) return null;
    if ((mk[8 * v + 4] > 100 && N[3 * v + 1] < 0.8) || mk[8 * v + 5] > 128 || mk[8 * v + 6] > 100) return { skip: true };
    return { h, nx: N[3 * v], ny: N[3 * v + 1], nz: N[3 * v + 2], cv: c.cv[v], m: [mk[8 * v] / 255, mk[8 * v + 1] / 255, mk[8 * v + 2] / 255, mk[8 * v + 3] / 255] };
  }
  const grass = createGrass({ THREE, scene, mat: mats.grass, sample: groundSample });

  /* ---------- tunnels: a lined bore through the hill, portals at both ends, the rider on the line between them ---------- */
  function buildTunnels(c) {
    c.tunnels = [];
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'tunnels', null);
    const B = builder(), grp = new THREE.Group(), pos = [], idx = [], port = [];
    for (const r of t.roads) {
      if (!(r.fl & 2) || /path|footway|steps/.test(r.hw)) continue;
      const P = resample(r.pts.map(([la, lo]) => proj.xz(la, lo)), 6); if (P.length < 2) continue;
      const D = [0]; for (let i = 1; i < P.length; i++) D.push(D[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      const out = (p, q) => { const dx = p[0] - q[0], dz = p[1] - q[1], l = Math.hypot(dx, dz) || 1, a = groundAt(...p), b = groundAt(p[0] + dx / l * 12, p[1] + dz / l * 12); return a == null ? b : b == null ? a : Math.min(a, b); };
      const h0 = out(P[0], P[1]) ?? 0, h1 = out(P.at(-1), P.at(-2)) ?? h0, st = roadStyle(r.hw, r.ln, r.fl), w = st.w / 2 + 1.2, L = D.at(-1) || 1;
      // under little cover (cut and cover under flat ground): ride it on the surface, no bore
      let cover = 0; for (let i = 0; i < P.length; i++) cover += (groundAt(...P[i]) ?? 0) - (h0 + (h1 - h0) * D[i] / L);
      if (cover / P.length < 8) { ribbon(B, P, { ...st, hAt: (x, z) => groundAt(x, z), lift: roadLift(r.hw), step: 6 }); continue; }
      const T = { P, D, h0, h1, w, L }; c.tunnels.push(T);
      ribbon(B, P, { ...st, hAt: () => 0, deck: [h0, h1], lift: 0.05, step: 6 });
      // the bore: a half barrel over the road, faces inward
      const SEG = 10, R = w, H = 2.2;
      for (let i = 0; i < P.length; i++) {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l, y = h0 + (h1 - h0) * D[i] / L;
        for (let k = 0; k <= SEG; k++) { const th = Math.PI * k / SEG, cx = Math.cos(th) * R, cy = Math.sin(th) * (R * 0.75) + H; pos.push(P[i][0] + nx * cx, y + (k === 0 || k === SEG ? -0.3 : cy), P[i][1] + nz * cx); }
        if (i) for (let k = 0; k < SEG; k++) { const p0 = (i - 1) * (SEG + 1) + k, p1 = i * (SEG + 1) + k; idx.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }
        if (i === 0 || i === P.length - 1) port.push([P[i][0], y, P[i][1], Math.atan2(dx, dz), R, H, i === 0 ? -1 : 1]);
      }
    }
    if (!B.n) return setPart(c, 'tunnels', null);
    const d = B.done(), rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); rg.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2)); rg.setAttribute('rd', new THREE.BufferAttribute(d.code, 4));
    rg.setIndex(new THREE.BufferAttribute(d.idx, 1)); rg.computeVertexNormals(); grp.add(new THREE.Mesh(rg, mats.road));
    if (pos.length) {
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setIndex(idx); bg.computeVertexNormals();
      const bore = new THREE.Mesh(bg, mats.tunnel); bore.material.side = THREE.DoubleSide; grp.add(bore);
    }
    // portals: a concrete face with an arched opening, set into the hillside
    for (const [x, y, z, yaw, R, H, dir] of port) {
      const sh = new THREE.Shape(); sh.moveTo(-R - 3.5, -1); sh.lineTo(R + 3.5, -1); sh.lineTo(R + 3.5, H + R + 3); sh.lineTo(-R - 3.5, H + R + 3); sh.lineTo(-R - 3.5, -1);
      const hole = new THREE.Path(); hole.moveTo(-R, -0.5); hole.lineTo(R, -0.5); hole.lineTo(R, H);
      for (let k = 1; k <= 12; k++) { const th = Math.PI * k / 12; hole.lineTo(Math.cos(th) * R, H + Math.sin(th) * R * 0.75); }
      hole.lineTo(-R, -0.5); sh.holes.push(hole);
      const pg = new THREE.ExtrudeGeometry(sh, { depth: 1.2, bevelEnabled: false }), pm = new THREE.Mesh(pg, mats.portal);
      pm.position.set(x, y, z); pm.rotation.y = yaw + (dir > 0 ? Math.PI : 0); pm.castShadow = true; pm.receiveShadow = true; grp.add(pm);
    }
    setPart(c, 'tunnels', grp);
  }
  // the tunnel a point is in: { y, k } (k: how far in, 0 at a portal .. 1 from 25 m in), null outside
  function tunnelNear(c, x, z) {
    for (const T of c?.tunnels || []) {
      const { P, D } = T;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)) : 0;
        if (Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t) < T.w + 0.5) { const d = D[i - 1] + (D[i] - D[i - 1]) * t; return { y: T.h0 + (T.h1 - T.h0) * d / T.L, k: Math.min(1, Math.min(d, T.L - d) / 25) }; }
      }
    }
    return null;
  }
  const tunnelAt = (x, z) => { const [tx, ty] = tileOf(x, z); return tunnelNear(near.get(key(NEAR_Z, tx, ty)), x, z); };

  /* ---------- riders ---------- */
  const me = makeRider(THREE, { kit: 0xf2c230, kit2: 0x1b1f25, accent: 0xe8b21e }); scene.add(me.group);
  const others = new Map();  // id -> { r, tag, x, z, yaw, seen }
  let grade = 0, dark = 0;
  let chase = [6.5, 2.6], side = 0, rx = 0, rz = 0, camInit = false, st = null, dShown = 0, dAt = 0, tAt = 0, yaw = 0, camYaw = null, mode = 'chase';
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmp = new THREE.Vector3();
  function course(s) {
    if (!s?.ll || s.ll.length < 2) return;
    const reset = !st || st.ll[0] !== s.ll[0] || (st.ll !== s.ll && Math.abs((s.d ?? 0) - dShown) > 200);
    if (!st || st.ll !== s.ll) {
      const pts = s.ll.map(([la, lo]) => proj.xz(la, lo)), D = [0];
      for (let i = 1; i < pts.length; i++) D.push(D[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const k = s.dist && D.at(-1) ? s.dist / D.at(-1) : 1;
      s.P = pts; s.D = D.map(d => d * k);
      poke();
    } else { s.P = st.P; s.D = st.D; }
    if (reset) { dShown = s.d; camYaw = null; camInit = false; }
    st = s; dAt = s.d; tAt = performance.now();
  }
  function at(d) {
    const { P, D } = st; if (d <= 0) return P[0]; if (d >= D.at(-1)) return P.at(-1);
    let a = 0, b = D.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (D[m] < d) a = m; else b = m; }
    const f = D[b] > D[a] ? (d - D[a]) / (D[b] - D[a]) : 0; return [P[a][0] + (P[b][0] - P[a][0]) * f, P[a][1] + (P[b][1] - P[a][1]) * f];
  }
  const eleAt = d => { if (!st.ele?.length) return null; const i = d / 10, a = Math.max(0, Math.min(st.ele.length - 1, Math.floor(i))), b = Math.min(st.ele.length - 1, a + 1); return st.ele[a] + (st.ele[b] - st.ele[a]) * (i - a); };
  // the surface the rider is on: a bridge deck, else the ground (carved to the road), else the course's own height
  function yAt(x, z, d) {
    const k = deckAt(x, z); if (k != null && (d == null || Math.abs(k - (eleAt(d) ?? k)) < 15)) return k;
    const tn = tunnelAt(x, z); if (tn) return tn.y + 0.05;
    return groundAt(x, z) ?? (d != null ? eleAt(d) : null) ?? 0;
  }

  function syncOthers(dt, now) {
    const list = getOthers(), keep = new Set();
    for (const o of list) {
      keep.add(o.id);
      let e = others.get(o.id);
      if (!e) {
        e = { r: makeRider(THREE, o.hi ? { kit: 0x2fbf71, kit2: 0x173d2a, accent: 0x2fbf71 } : { kit: [0xd94b3d, 0x3d7bd9, 0xeeeeee, 0x7a4fd1, 0xf08a24][Math.abs(hash2(String(o.id).length, String(o.id).charCodeAt(0) || 1) * 5 | 0) % 5] }), tag: document.createElement('div'), x: null, z: null, yaw: 0 };
        e.tag.className = 'w3tag' + (o.hi ? ' hi' : ''); tags.appendChild(e.tag); scene.add(e.r.group); others.set(o.id, e);
      }
      const [x, z] = proj.xz(o.lat, o.lon), mv = e.x == null ? 0 : Math.hypot(x - e.x, z - e.z);
      if (mv > 0.05) e.yaw += angDiff(e.yaw * 180 / Math.PI, headingOf(x - e.x, z - e.z)) * Math.PI / 180 * Math.min(1, dt * 4);
      e.v = mv / Math.max(dt, 1e-3); e.x = x; e.z = z;
      const off = e.off = (e.off ?? keepRight(x, z)) + (keepRight(x, z) - (e.off ?? 0)) * Math.min(1, dt), ox = x + Math.cos(e.yaw) * off, oz = z + Math.sin(e.yaw) * off;
      const y = yAt(ox, oz, null);
      e.r.group.position.set(ox, y, oz); e.r.group.rotation.y = -e.yaw; e.r.update(dt, e.v > 0.5 ? 85 : 0, e.v);
      if (e.tag.textContent !== o.label) e.tag.textContent = o.label;
      tmp.set(x, y + 2.1, z).project(camera);
      const dist = camera.position.distanceTo(e.r.group.position), vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 && dist < 400;
      e.tag.style.display = vis ? '' : 'none';
      if (vis) e.tag.style.transform = `translate(${((tmp.x + 1) / 2 * canvas.clientWidth).toFixed(1)}px, ${((1 - tmp.y) / 2 * canvas.clientHeight).toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [id, e] of others) if (!keep.has(id)) { e.r.dispose(); scene.remove(e.r.group); e.tag.remove(); others.delete(id); }
  }

  /* ---------- junction arrows: amber chevrons down the other ways, white ones on the way taken ---------- */
  const chevGeo = new THREE.BufferGeometry().setFromPoints([[-0.9, 0.7], [0, -0.5], [0.9, 0.7], [0.9, 0.1], [0, -1.1], [-0.9, 0.1]].map(([x, z]) => new THREE.Vector3(x, 0, z)));
  chevGeo.setIndex([0, 1, 5, 1, 4, 5, 1, 2, 3, 1, 3, 4]); chevGeo.computeVertexNormals();
  const chev = { alt: new THREE.InstancedMesh(chevGeo, new THREE.MeshBasicMaterial({ color: 0xf0a020, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }), 80),
    sel: new THREE.InstancedMesh(chevGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }), 40) };
  for (const m of Object.values(chev)) { m.count = 0; m.frustumCulled = false; scene.add(m); }
  let chevKey = '';
  function arrows() {
    const alts = st?.alts || [], turn = st?.turn, k = JSON.stringify([alts.map(a => a.length && a[0]), turn && turn.m > 0 && Math.round((st.d + turn.m) / 5), st?.ll?.length]);
    if (k === chevKey) return; chevKey = k;
    const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(0.75, 1, 0.75);
    const lay = (mesh, pts) => {
      let n = 0;
      for (const line of pts) {
        const P = line.map(([la, lo]) => proj.xz(la, lo)); let run = 4;
        for (let i = 1; i < P.length && n < mesh.count + 999; i++) {
          const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          for (; run < L && n < (mesh === chev.alt ? 80 : 40); run += 7) {
            const x = a[0] + (b[0] - a[0]) * run / L, z = a[1] + (b[1] - a[1]) * run / L, h = yAt(x, z, null);
            qq.setFromAxisAngle(v.set(0, 1, 0), -Math.atan2(b[0] - a[0], -(b[1] - a[1])));
            mesh.setMatrixAt(n++, m4.compose(v.set(x, h + 0.32, z), qq, sc));
          }
          run -= L;
        }
      }
      mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
    };
    lay(chev.alt, alts.map(a => { const out = [a[0]]; let m = 0; for (let i = 1; i < a.length && m < 45; i++) { m += Math.hypot((a[i][0] - a[i - 1][0]) * 111195, (a[i][1] - a[i - 1][1]) * 87800); out.push(a[i]); } return out; }));
    if (turn && !turn.dead && st?.P) { const d0 = st.d + turn.m, line = []; for (let d = d0; d < d0 + 45; d += 5) { const p = at(d); line.push([proj.lat(p[1]), proj.lon(p[0])]); } lay(chev.sel, [line]); }
    else chev.sel.count = 0;
  }

  /* ---------- the frame ---------- */
  let last = performance.now(), size = '', ft = [], slow = 0, fast = 0, lastGov = 0, frames = 0, fpsT = performance.now(), fps = 0;
  function resize() {
    const w = container.clientWidth, h = container.clientHeight, k = `${w}x${h}x${q}`;
    if (!w || !h || k === size) return !!(w && h); size = k;
    const pr = Math.min(globalThis.devicePixelRatio || 1, QUALITY[q].pr);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false); post.setSize(w, h, pr);
    camera.aspect = w / h; camera.fov = mode === 'first' ? 58 : w / h < 1.2 ? 62 : 50; camera.updateProjectionMatrix(); return true;
  }
  function applyQuality() {
    const Q = QUALITY[q];
    renderer.shadowMap.enabled = Q.shadow > 0; sky.sun.castShadow = Q.shadow > 0;
    if (Q.shadow) { sky.sun.shadow.mapSize.set(Q.shadow, Q.shadow); sky.sun.shadow.map?.dispose(); sky.sun.shadow.map = null; }
    camera.far = Q.view; camera.updateProjectionMatrix();
    sky.set(sky.time); post.build(Q); grass.set(...Q.grass);
    size = ''; poke();
    scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  }
  applyQuality();
  function governor(dt, now) {
    if (document.hidden || dt > 0.25) return;
    ft.push(dt); if (now - lastGov < 2500) return; lastGov = now;
    ft.sort((a, b) => a - b); const med = ft[ft.length >> 1] || 0; ft = [];
    if (med > 1 / 42) { slow++; fast = 0; } else { slow = 0; if (med < 1 / 75) fast++; }
    if (slow >= 2 && q < 2) { q++; slow = 0; applyQuality(); }
    else if (slow >= 4 && q === 2) fail(new Error('too slow'));
  }
  function frame(now) {
    raf = 0; if (dead) return;
    try {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (!resize() || !st?.P) { raf = requestAnimationFrame(frame); return; }
      // the rider: where the engine said plus speed since, eased so updates never jump
      const v = st.v || 0, target = Math.min(dAt + v * Math.min(2, (now - tAt) / 1000), st.D.at(-1));
      dShown += (target - dShown) * Math.min(1, dt * 2.5) + (Math.abs(target - dShown) < 30 ? v * dt * 0.0 : 0);
      if (Math.abs(target - dShown) > 60) dShown = target;
      const d = Math.max(0, dShown), p0 = at(d), pa = at(d - 2), pb = at(d + 3);
      { const hx = pb[0] - pa[0], hz = pb[1] - pa[1], L = Math.hypot(hx, hz) || 1; side += (keepRight(p0[0], p0[1]) - side) * Math.min(1, dt * 1.5); rx = -hz / L; rz = hx / L; }
      const p = [p0[0] + rx * side, p0[1] + rz * side];
      const y = yAt(p[0], p[1], d), want = Math.atan2(pb[0] - pa[0], -(pb[1] - pa[1]));
      yaw += ((want - yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 8);
      const yb = yAt(pb[0], pb[1], d + 3), ya = yAt(pa[0], pa[1], d - 2);
      me.group.position.set(p[0], y, p[1]); me.group.rotation.set(Math.atan2(yb - ya, 5) * 0.9, -yaw, 0, 'YXZ');
      grade += ((yb - ya) / 5 - grade) * Math.min(1, dt * 1.5);
      me.update(dt, st.cad || 0, v, grade);
      const lat = proj.lat(p[1]), lon = proj.lon(p[0]);
      stream(lat, lon, now);
      jobs.run(q === 2 ? 3 : 5);
      marks.update(camera, dt);
      for (const c of near.values()) if (c.treeSets && c.lod === 0 && (!c.partAt || Math.hypot(c.partAt[0] - p[0], c.partAt[1] - p[1]) > 60)) { c.partAt = [p[0], p[1]]; jobs.add(c.k + '|p', 0.5, () => partTrees(c, p[0], p[1])); }
      if (ready) grass.update(camPos.x || p[0], camPos.z || p[1], q === 2 ? 1.5 : 3);
      WIND.time.value += dt; WIND.gust.value = 0.55 + 0.35 * Math.sin(now / 7300) * Math.sin(now / 3100);
      syncOthers(dt, now); arrows();
      // camera: behind and above, looking down the road; first person: at the eyes
      const ahead = at(d + 14), hd = yAt(ahead[0], ahead[1], d + 14);
      const look = Math.atan2(ahead[0] - pa[0], -(ahead[1] - pa[1]));
      camYaw = camYaw == null ? look : camYaw + ((look - camYaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 2.2);
      const fx = Math.sin(camYaw), fz = -Math.cos(camYaw);
      if (mode === 'chase') {
        tmp.set(p[0] - fx * chase[0], y + chase[1], p[1] - fz * chase[0]);
        const tn = tunnelAt(tmp.x, tmp.z), g = tn ? null : groundAt(tmp.x, tmp.z); if (g != null && tmp.y < g + 1.4) tmp.y = g + 1.4;
        if (tn) tmp.y = Math.min(tmp.y, tn.y + 3.4);
        camPos.lerp(tmp, camInit ? Math.min(1, dt * 6) : 1); camInit = true;
        camLook.set(p[0] + fx * 10, (y + hd) / 2 + 1.1, p[1] + fz * 10);
        me.group.visible = true;
      } else {
        camPos.set(p[0] + fx * 0.15, y + 1.62, p[1] + fz * 0.15);
        camLook.set(p[0] + fx * 30, hd + 1.3, p[1] + fz * 30);
        me.group.visible = false;
      }
      camera.position.copy(camPos); camera.lookAt(camLook);
      sky.update(camera, me.group.position, dt, QUALITY[q].span);
      // inside a tunnel: the daylight fades out
      const tk = tunnelAt(camPos.x, camPos.z)?.k ?? 0; dark += (tk - dark) * Math.min(1, dt * 3);
      sky.sun.intensity = sky.sunI * (1 - 0.92 * dark); sky.hemi.intensity = sky.hemiI * (1 - 0.8 * dark);
      renderer.info.reset();
      post.render(sky.exposure * (1 + dark * 0.6));
      frames++; if (now - fpsT > 1000) { fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
      governor(dt, now);
    } catch (e) { fail(e); return; }
    raf = requestAnimationFrame(frame);
  }
  function fail(e) {
    if (dead) return; console.warn('world view:', e);
    dispose(); onFail(e?.message || String(e));
  }
  function dispose() {
    if (dead) return; dead = true; cancelAnimationFrame(raf);
    for (const m of [near, far]) for (const k of [...m.keys()]) dropChunk(m, k);
    me.dispose(); for (const e of others.values()) e.r.dispose();
    grass.dispose(); post.dispose();
    renderer.dispose(); renderer.forceContextLoss?.(); canvas.remove(); tags.remove();
  }
  raf = requestAnimationFrame(frame);
  return {
    // s: { ll, ele, dist, d, v (m/s), cad (rpm), alts, turn }
    update(s) { if (!dead) course(s); if (!raf && !dead) raf = requestAnimationFrame(frame); },
    camera: () => mode,
    // the chase camera's distance behind and height (a wider view for screenshots)
    setChase(back, up) { chase = [back, up]; },
    toggleCamera() { mode = mode === 'chase' ? 'first' : 'chase'; size = ''; return mode; },
    setTime(t) { sky.set(t); return sky.time; },
    // Karl the fog's banks on or off
    setFog(on) { return sky.setBanks(on); }, fog: () => sky.banksOn,
    setKit(kit, accent) { me.setKit?.(kit, accent); },
    stats: () => ({ fps, quality: QUALITY[q].name, near: near.size, far: far.size, jobs: jobs.size, ready, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, grass: grass.count }),
    setQuality(n) { q = Math.max(0, Math.min(2, n)); applyQuality(); },
    dispose, alive: () => !dead,
    debug: () => ({ scene, camera, THREE }),
  };
}
