// World 3D view: the Marin world in three.js around an open-world rider. Terrain, roads, trees and buildings stream
// in by Web Mercator tile from the baked world (baked.js), finest around the rider; a chase camera follows the road.
// Rendering runs on its own requestAnimationFrame loop and never touches the ride: any error, a lost context or a
// frame rate that stays bad calls onFail and the ride map falls back to the other views.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { makeProj, tileX, tileY, lonOf, latOf, key, unkey, headingOf, angDiff } from './geo.js';
import { gridFromHeights, gridHeight, gridIJ, carveSteps, pushUnder, pushUnderSteps, rasterClasses, rasterBy, gridMesh, upsample, gridNormals, gridCurvature, classMasks } from './terrain.js';
import { builder, ribbon, deckSides, roadStyle, roadLift, resample, clipLine, chainWays, roundCorners, tapers } from './ribbon.js';
import { wanted, plan, jobQueue, childrenOf, NEAR_Z, FAR_Z } from './stream.js';
import { hash2 } from './landuse.js';
import { terrainMaterial, roadMaterial, propMaterial, buildingMaterial, grassMaterial, furnitureMaterial, tunnelMaterial, portalMaterial, withSun, WIND, BORES, REDWOOD, HL, SFB, LAMPS, VEG } from './materials.js';
import { createHorizon, HZ_LAYER } from './horizon.js';
import { treeGeometries, scrubGeometries, species, buildingGeometry, furnitureGeometries, SPECIES, NEAR, REDWOODS, HEADLANDS, SF_CITY, inHeadlands } from './props.js';
import { loadVeg, SCRUB, CYPRESS, EUC } from './veg.js';
import { createScrub } from './scrub.js';
import { bakeImpostors, impostorMesh } from './impostor.js';
import { textures } from './tex.js';
import { createSky, FOG_SUN } from './sky.js';
import { createPost } from './post.js';
import { createGrass } from './grass.js';
import { createLife } from './life.js';
import { createAudio } from './audio.js';
import { makeRider } from './rider.js';
import { createLandmarks } from './marin.js';
import { GGB, onDeck } from '../ggb.js';

const ORIGIN = [37.93, -122.63];  // the middle of the Marin world: every coordinate stays within about 25 km
// quality tiers: shadow map size (0: none) and span, pixel ratio cap, tree share, near rings, far ring, terrain grid
// (segs) and upsampling near the rider (up), draw distance, post-processing (bloom, MSAA samples, fog volume steps),
// grass radius and clumps per square metre, ground detail (bump, close-up noise), the full trees' radius, the scrub's
// radius and its full models' radius
export const QUALITY = [
  { name: 'high', shadow: 1536, span: 70, pr: 1.5, trees: 1, rings: [1, 2], far: 2, segs: 128, up: 2, view: 42000, post: true, bloom: true, msaa: 0, fxaa: true, vol: 22, grass: [56, 4], detail: true, treeNear: 300, scrub: [130, 38] },
  { name: 'medium', shadow: 1024, span: 55, pr: 1, trees: 0.6, rings: [1, 2], far: 2, segs: 128, up: 2, view: 32000, post: true, bloom: true, msaa: 0, fxaa: true, vol: 18, grass: [44, 2.6], detail: true, treeNear: 200, scrub: [95, 30] },
  { name: 'low', shadow: 0, span: 0, pr: 0.8, trees: 0.3, rings: [1, 1], far: 1, segs: 64, up: 1, view: 22000, post: false, bloom: false, msaa: 0, grass: [24, 1.4], detail: false, treeNear: 120, scrub: [55, 18] },
];
const CAP = { 0: 22000, 1: 18000 };  // trees per tile at full share, by detail (a denser tile is thinned evenly)
// trees by the tile's ground classes (a raster at about 15 m): codes, higher wins: open grass, farm, town, park, scrub,
// wood (mixed, broadleaf, needleleaf), and ground no tree grows on (rock, sand, water). [class, metres between trees,
// share of the spots kept, leaf type]
const treeCode = f => ({ grass: 1, farm: 2, urban: 3, park: 4, scrub: 5, rock: 9, sand: 9, water: 9 })[f.k] ?? (f.k === 'wood' ? (f.lt === 'b' ? 7 : f.lt === 'n' ? 8 : 6) : 0);
const TREE = [null, ['grass', 70, 0.6], ['farm', 90, 0.6], ['urban', 14, 0.65], ['park', 24, 1], ['scrub', 8, 1], ['wood', 11, 1, 'm'], ['wood', 11, 1, 'b'], ['wood', 11, 1, 'n'], null];
const OCC = 512;  // the road mask per tile: cells of about 3.8 m (no grass, trees or shrubs on a road)
const PORT = 12;  // metres of open cut before a tunnel's portal
// underpasses that are a barrel arch, not a concrete box (Street View): Bunker Road under US-101
const ARCHED = [[37.8380, -122.4830]];

export function createWorldView({ container, baked, getOthers = () => [], onFail = () => {}, quality = 0, time = 'golden', sound = true, fog = true, kit = null }) {
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
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(new Error('WebGL context lost')); });

  const scene = new THREE.Scene(), proj = makeProj(...ORIGIN);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 60000);
  const sky = createSky(scene, { far: 60000 }); sky.set(time);
  const mats = { terrain: terrainMaterial(), terrainBore: terrainMaterial({ bores: true }), terrainFar: terrainMaterial({ detail: false }), road: roadMaterial(), prop: propMaterial(),
    bldg: buildingMaterial(), grass: grassMaterial(), pillar: new THREE.MeshLambertMaterial({ color: 0x9a968c }),
    tunnel: tunnelMaterial(), portal: portalMaterial(),
    furn: furnitureMaterial(), rail: new THREE.MeshLambertMaterial({ color: 0xb9bdc1, side: THREE.DoubleSide }) };
  const scrubFade = { centre: { value: new THREE.Vector2() }, radius: { value: 150 } }; mats.scrub = propMaterial({ fade: scrubFade });
  mats.walk = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });  // a tunnel's walk and pipes
  for (const m of Object.values(mats)) withSun(m);  // the hills' shadows at any distance (horizon.js)
  REDWOODS.forEach(([s, w, n, e], i) => REDWOOD.value[i].set(proj.x(w), proj.z(n), proj.x(e), proj.z(s)));
  { const [s, w, n, e] = HEADLANDS; HL.value.set(proj.x(w), proj.z(n), proj.x(e), proj.z(s)); }
  { const [s, w, n, e] = SF_CITY; SFB.value.set(proj.x(w), proj.z(n), proj.x(e), proj.z(s)); }
  const hz = createHorizon(renderer, scene, sky.sunDir);
  // the pool of light a street lamp puts on the road (added light, faded out by day)
  const lampPool = new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), lampPoolMat = new THREE.ShaderMaterial({ name: 'jwLampPool', uniforms: { lamps: LAMPS }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vP; varying float vD; void main() { vP = position.xz; vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vD = distance(w.xyz, cameraPosition); gl_Position = projectionMatrix * viewMatrix * w;
#include <logdepthbuf_vertex>
}`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
uniform float lamps; varying vec2 vP; varying float vD; void main() {
#include <logdepthbuf_fragment>
float a = max(0.0, 1.0 - length(vP) / 7.0); gl_FragColor = vec4(vec3(1.0, 0.78, 0.5) * a * a * lamps * 0.5 * (1.0 - smoothstep(200.0, 500.0, vD)), 1.0); }` });
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2c2d2e });
  const FURN = furnitureGeometries(), trees = treeGeometries(), IMP = bakeImpostors(renderer, trees, SPECIES, textures().leaves, NEAR), pillarGeo = new THREE.BoxGeometry(1.6, 1, 1.6).translate(0, 0.5, 0);
  const marks = createLandmarks({ THREE, scene, proj, sky, mats, baked });
  const post = createPost(renderer, scene, camera, sky.fog);
  const life = createLife({ THREE, scene, proj, marks, quality: q }), audio = createAudio({ on: sound });
  sky.setBanks(fog);
  // the Headlands' ground cover (veg.js): the ground shader's texture, the scrub, the groves; tiles built before it
  // came are built again
  let veg = null;
  const vcls = (x, z) => veg ? veg.at(proj.lat(z), proj.lon(x)) : 0;
  loadVeg().then(v => {
    if (dead || !v) return;
    const tex = new THREE.DataTexture(v.rgba(), v.n, v.n, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 4; tex.needsUpdate = true;
    renderer.initTexture(tex);
    const [s, w, n, e] = v.box; VEG.box.value.set(proj.x(w), proj.z(n), proj.x(e), proj.z(s)); VEG.tex.value = tex; veg = v;
    for (const c of [...near.values(), ...far.values()]) c.sig.trees = null;
    grass.invalidate(); scrub.invalidate(); poke();
  });

  /* ---------- streaming ---------- */
  const near = new Map(), far = new Map(), jobs = jobQueue();
  if (globalThis.__w3?.prof) globalThis.__w3.slowJobs = jobs.slow;  // profiling: the jobs that took over 6 ms
  const tileOf = (x, z) => { const lat = proj.lat(z), lon = proj.lon(x); return [Math.floor(tileX(lon, NEAR_Z)), Math.floor(tileY(lat, NEAR_Z))]; };
  function disposeObj(o) {
    o.traverse(m => { if (m.isInstancedMesh || m.isBatchedMesh) m.dispose(); else if (m.geometry && !m.userData.shared) m.geometry.dispose(); if (m.userData.ownMat) m.material.dispose(); });
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
  function* buildTerrain(c) {
    const t = c.tile, Q = QUALITY[q];
    if (!t) { c.grid = null; setPart(c, 'terrain', null); c.built = true; c.ver = (c.ver || 0) + 1; farDirty = true; return; }
    const fine = c.z === NEAR_Z && c.lod === 0, up = fine ? Q.up : 1;
    const step = c.z === FAR_Z ? 1 : c.lod === 0 ? (Q.segs === 128 ? 1 : 2) : 4, gk = up > 1 ? 'u' + up : 's' + step;
    // built aside (G) and swapped in at the end: the ground in use stays as it is while this runs over several frames
    let G = c.grid;
    if (!G || G.key !== gk) {
      if (up > 1) G = gridFromHeights({ z: c.z, x: c.x, y: c.y, hs: upsample(t.hs, t.n, up, extOf(c)), n: (t.n - 1) * up + 1, step: 1, proj });
      else G = gridFromHeights({ z: c.z, x: c.x, y: c.y, hs: t.hs, n: t.n, step, proj });
      G.key = gk; G.m = up > 1 ? 1 / up : step;  // source steps (about 15 m) per grid step
      yield;
    } else G = { ...G };
    G.cut = null; G.hs = G.raw;
    const ms = G.m;
    if (fine) {
      // every road level across its width (heights along it from the ground, eased), cut and fill banks either side
      const under = [];
      for (const r of t.roads) {
        if (r.fl & 3 || /path|footway|track|bridleway|steps/.test(r.hw)) continue;
        const pts = resample(r.pts.map(([la, lo]) => proj.xz(la, lo)), 8), P = [];
        for (let i = 0; i < pts.length; i++) { const h = gridHeight(G, pts[i][0], pts[i][1], G.raw); if (h != null) P.push([pts[i][0], pts[i][1], h]); }
        for (let k = 0; k < 4; k++) for (let i = 1; i + 1 < P.length; i++) P[i][2] = (P[i - 1][2] + 2 * P[i][2] + P[i + 1][2]) / 4;
        const w = roadStyle(r.hw, r.ln, r.fl, r.wd).w;
        if (P.length > 1) under.push({ pts: P, r0: w / 2 + Math.max(2.5, 8 * ms), r1: w / 2 + Math.max(9, 22 * ms) });
        if (under.length % 12 === 0) yield;
      }
      // the Golden Gate Bridge's ends: the ground meets the deck (just under it) where the land comes up to it
      if (marks.ggb) for (const [a, b] of [[GGB.span[0], GGB.span[0] + 24], [GGB.span[1] - 24, GGB.span[1]]]) {
        const P = []; for (let s = a; s <= b; s += 4) { const p = marks.lane(s, 0), h = gridHeight(G, p.x, p.z, G.raw); if (h != null && Math.abs(h - p.y) < 4) P.push([p.x, p.z, p.y - 0.4]); }
        if (P.length > 1) under.push({ pts: P, r0: 15, r1: 24 });
      }
      // the ridden road is one of them: the rider sits on the same ground (the engine's grade comes from these heights too)
      for (const r of t.roads) {
        if (!(r.fl & 2) || /path|footway|steps/.test(r.hw)) continue;
        const P = resample(r.pts.map(([la, lo]) => proj.xz(la, lo)), 4); if (P.length < 3) continue;
        const w = roadStyle(r.hw, r.ln, r.fl, r.wd).w, D = [0]; for (let i = 1; i < P.length; i++) D.push(D[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
        const L = D.at(-1); if (L < 3 * PORT) continue;
        const box = [Math.min(G.xs[0], G.xs[G.segs]), Math.min(G.zs[0], G.zs[G.segs]), Math.max(G.xs[0], G.xs[G.segs]), Math.max(G.zs[0], G.zs[G.segs])];
        for (const [a, dir] of [[0, 1], [P.length - 1, -1]]) {
          if (!(P[a][0] > box[0] + 1 && P[a][0] < box[2] - 1 && P[a][1] > box[1] + 1 && P[a][1] < box[3] - 1)) continue;  // past the tile's edge: the neighbour's piece, not a portal
          const out = [P[a][0] * 2 - P[a + dir][0], P[a][1] * 2 - P[a + dir][1]], h = Math.min(gridHeight(G, ...P[a], G.raw) ?? 1e9, gridHeight(G, ...out, G.raw) ?? 1e9);
          if (h > 1e8) continue;
          const pts = []; for (let i = a; i >= 0 && i < P.length && Math.abs(D[i] - D[a]) <= PORT + 1; i += dir) pts.push([P[i][0], P[i][1], h]);
          if (pts.length > 1) under.push({ pts, r0: w / 2 + 2.5, r1: w / 2 + 9 });
        }
      }
      yield; yield* carveSteps(G, [], 0, 1, under); yield;
    }
    const lu = rasterClasses(G, withGardens(t)); yield;
    const m = gridMesh(G, { lu, skirt: c.z === FAR_Z ? 40 : 12, skip: c.z === FAR_Z ? farSkip(c, G) : null }); yield;
    const nor = gridNormals(G), mask = classMasks(lu, G.cut); yield;
    const cv = gridCurvature(G, c.z === FAR_Z ? 400 : 25, c.z === FAR_Z ? 40 : 6); yield;
    const nv = m.src.length, N = new Float32Array(nv * 3), A = new Uint8Array(nv * 4), B = new Uint8Array(nv * 4), CV = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const v = m.src[i]; N[3 * i] = nor[3 * v]; N[3 * i + 1] = nor[3 * v + 1]; N[3 * i + 2] = nor[3 * v + 2]; CV[i] = cv[v];
      for (let k = 0; k < 4; k++) { A[4 * i + k] = mask[8 * v + k]; B[4 * i + k] = mask[8 * v + 4 + k]; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('mk', new THREE.BufferAttribute(A, 4, true)); g.setAttribute('mk2', new THREE.BufferAttribute(B, 4, true)); g.setAttribute('cv', new THREE.BufferAttribute(CV, 1));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1)); g.computeBoundingSphere();
    const bored = c.z === NEAR_Z && t.roads.some(r => r.fl & 2), mesh = new THREE.Mesh(g, c.z === NEAR_Z && Q.detail ? (bored ? mats.terrainBore : mats.terrain) : mats.terrainFar); mesh.receiveShadow = fine; mesh.matrixAutoUpdate = false; mesh.layers.enable(HZ_LAYER); hz.touch();
    c.grid = G; c.tmesh = { src: m.src, nv: (G.segs + 1) ** 2, skirt: c.z === FAR_Z ? 40 : 12 };
    if (fine) { c.nor = nor; c.mask = mask; c.cv = cv; grass.invalidate(tileBox(c)); scrub.invalidate(tileBox(c)); } else { c.nor = c.mask = c.cv = null; }
    setPart(c, 'terrain', mesh); c.built = true; c.ver = (c.ver || 0) + 1; if (c.z === NEAR_Z) farDirty = true;
  }
  // far tiles leave out the quads a built near tile covers
  function farSkip(c, g = c.grid) {
    const s = 2 ** (NEAR_Z - FAR_Z), per = g.segs / s;
    return (i, j) => { const n = near.get(key(NEAR_Z, c.x * s + Math.floor(i / per), c.y * s + Math.floor(j / per))); return !!n?.built; };
  }
  const hOf = c => (x, z) => c.grid ? gridHeight(c.grid, x, z) : null;
  // a tile's features with a garden round every building (its footprint grown by about 6 m, as town ground), once
  // (not round the Headlands' forts west of Fort Baker: scrub runs up to their walls, Street View)
  const withGardens = t => t.gardens ??= t.features.concat(t.features.filter(f => f.k === 'building' && !(inHeadlands(...f.rings[0][0]) && f.rings[0][0][1] < -122.49)).map(f => {
    const r = f.rings[0], n = r.length - 1; let la = 0, lo = 0; for (let i = 0; i < n; i++) { la += r[i][0]; lo += r[i][1]; } la /= n; lo /= n;
    return { k: 'urban', rings: [r.map(([a, b]) => { const dy = (a - la) * 111195, dx = (b - lo) * 87800, d = Math.hypot(dx, dy) || 1, k = (d + 6) / d; return [la + (a - la) * k, lo + (b - lo) * k]; })] };
  }));
  function* buildRoads(c) {
    const t = c.tile, decks = [];
    if (!t || !c.grid) return setPart(c, 'roads', null);
    const B = builder(), pillars = [], hAt = hOf(c), g = c.grid, occ = new Uint8Array(OCC * OCC), ox = Math.min(g.xs[0], g.xs[g.segs]), oz = Math.min(g.zs[0], g.zs[g.segs]);
    const ow = Math.abs(g.xs[g.segs] - g.xs[0]) / OCC, oh = Math.abs(g.zs[g.segs] - g.zs[0]) / OCC;
    const mark = (x, z, r) => { for (let a = Math.floor((x - r - ox) / ow); a <= Math.floor((x + r - ox) / ow); a++) for (let b = Math.floor((z - r - oz) / oh); b <= Math.floor((z + r - oz) / oh); b++) if (a >= 0 && b >= 0 && a < OCC && b < OCC) occ[b * OCC + a] = 1; };
    const minor = c.lod > 0, lanes = [], drive = [], lines = [], tops = [], surf = [], tbox = [Math.min(g.xs[0], g.xs[g.segs]), Math.min(g.zs[0], g.zs[g.segs]), Math.max(g.xs[0], g.xs[g.segs]), Math.max(g.zs[0], g.zs[g.segs])];
    // ways that go on as one road drawn as one ribbon (no seam where OpenStreetMap splits a road), corners rounded
    t.chained ??= chainWays(t.roads, r => r.fl & 3 ? null : `${r.hw}|${r.ln}|${r.fl}|${r.wd}`);
    // where one road's ways of different layouts meet, the width eases from one to the other (no step)
    t.joints ??= tapers(t.chained, { width: r => roadStyle(r.hw, r.ln, r.fl, r.wd).w, rigid: r => r.fl & 19, ok: r => !/path|footway|track|bridleway|steps|cycleway|pedestrian/.test(r.hw), xz: proj.xz });
    let nr = 0;
    for (const [ri, r] of t.chained.entries()) {
      if (++nr % 6 === 0) yield;
      if (r.fl & 2) continue;                          // tunnels: under the hill
      if (minor && /path|footway|track|bridleway|service/.test(r.hw)) continue;
      const st = roadStyle(r.hw, r.ln, r.fl, r.wd);
      const all = (r.fl & 1 ? (p => p) : roundCorners)(r.pts.map(([la, lo]) => proj.xz(la, lo))), runs = [[]];
      for (const p of all) { if (r.fl & 16 && marks.deckAt(p[0], p[1]) != null) { if (runs.at(-1).length) runs.push([]); } else runs.at(-1).push(p); }  // the bridge's own deck
      for (const pts of runs.flatMap(run => run.length > 1 ? clipLine(run, tbox) : [])) {  // exactly this tile: the next one draws on from its edge
      if (pts.length < 2) continue;
      const dk = r.fl & 16 && r.dk ? [marks.deckLine(...pts[0]), marks.deckLine(...pts.at(-1))] : r.dk;  // the approaches meet the deck
      const i0 = B.idx.length, centre = ribbon(B, pts, { ...st, hAt, lift: roadLift(r.hw), deck: dk || null, step: minor ? 12 : 5, joints: t.joints.get(ri) });
      tops.push([i0, B.idx.length]);
      for (let i = 1; i < centre.length; i++) { const a = centre[i - 1], b = centre[i]; surf.push(a[0], a[1], a[2], b[0], b[1], b[2], Math.max(a[3], b[3])); }
      if (!minor && !st.surf && !/path|footway|track|bridleway|cycleway|pedestrian/.test(r.hw) && centre.length > 1) lines.push({ P: centre, w: st.w, hw: r.hw, br: !!dk });
      if (!minor && st.lm && st.lanes >= 2 && !st.surf && centre.length > 3) drive.push({ P: centre, w: st.w, lanes: st.lanes, one: !!(r.fl & 8), big: /motorway|trunk|primary/.test(r.hw) });
      if (dk) {
        pillars.push(...deckSides(B, centre, st.w, 1.4, hAt));
        for (let i = 1; i < centre.length; i++) decks.push([centre[i - 1], centre[i], st.w / 2 + 0.6]);
      }
      if (!minor) centre.forEach((q, i) => { mark(q[0], q[2], q[3] + 1.2); lanes.push(q[0], q[2], q[3]); if (i) { const p = centre[i - 1]; mark((p[0] + q[0]) / 2, (p[2] + q[2]) / 2, q[3] + 1.2); } });
      }
    }
    for (const f of t.features) if (f.k === 'building') {
      const r = f.rings[0].map(([la, lo]) => proj.xz(la, lo)); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      if ((x1 - x0) * (z1 - z0) > 4000) continue;
      for (let x = x0; x <= x1; x += ow) for (let z = z0; z <= z1; z += oh) mark(x, z, 1.5);
    }
    yield;
    // the ground never over a road (lowered, the terrain mesh moved to match): its grid is coarser than a path is wide
    { const T = []; for (const [a, b] of tops) for (let k = a; k < b; k++) { const v = B.idx[k]; T.push(B.pos[3 * v], B.pos[3 * v + 1], B.pos[3 * v + 2]); }
      if (T.length && g) { const moved = yield* pushUnderSteps(g, T, { margin: Math.max(4, 0.75 * Math.abs(g.xs[1] - g.xs[0])) }); if (moved) groundMoved(c); } }
    yield;
    c.surf = roadIndex(surf); c.decks = decks; c.occ = { occ, ox, oz, ow, oh }; c.lanes = new Float32Array(lanes); c.drive = drive; c.lines = lines; if (c.lod === 0) { grass.invalidate(tileBox(c)); scrub.invalidate(tileBox(c)); }  // no grass or scrub on the roads
    if (!B.n) return setPart(c, 'roads', null);
    const d = B.done(), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); geo.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2));
    geo.setAttribute('rd', new THREE.BufferAttribute(d.code, 4)); geo.setAttribute('rd2', new THREE.BufferAttribute(d.code2, 4)); geo.setIndex(new THREE.BufferAttribute(d.idx, 1)); geo.computeVertexNormals(); geo.computeBoundingSphere();
    const grp = new THREE.Group(), mesh = new THREE.Mesh(geo, mats.road); mesh.receiveShadow = c.lod === 0; grp.add(mesh);
    if (pillars.length) {
      const im = new THREE.InstancedMesh(pillarGeo, mats.pillar, pillars.length), m4 = new THREE.Matrix4();
      pillars.forEach(([x, z, top, bot], i) => im.setMatrixAt(i, m4.makeScale(1, top - bot, 1).setPosition(x, bot, z)));
      im.userData.shared = true; im.castShadow = true; grp.add(im);
    }
    setPart(c, 'roads', grp);
  }
  const occAt = (o, x, z) => { if (!o) return false; const a = Math.floor((x - o.ox) / o.ow), b = Math.floor((z - o.oz) / o.oh); return a >= 0 && b >= 0 && a < OCC && b < OCC && o.occ[b * OCC + a] === 1; };
  function* buildTrees(c) {
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'trees', null);
    const share = QUALITY[q].trees, cap = CAP[c.lod] * share, g = c.grid, hAt = hOf(c), fine = c.lod === 0, box = tileBox(c);
    const out = {}; let n = 0, ferns = 0;
    // [x, y, z, scale, random, near only: a full model, no impostor]
    const add = (sp, x, z, s, r, nearOnly = 0) => { if (x < box[0] || z < box[1] || x >= box[2] || z >= box[3]) return; const y = hAt(x, z); if (y == null || y < 1.2 || occAt(c.occ, x, z)) return; (out[sp] ??= []).push([x, y - 0.3, z, s, r, nearOnly]); if (!nearOnly && sp !== 'fern') n++; };  // ferns and ring trees: not in the cap
    // woods, scrub, parks and towns by a raster of the tile's polygons: spots on a jittered grid in each cell, the
    // class of the nearest raster vertex deciding (no point in polygon tests)
    const R = 128, ras = rasterBy({ z: c.z, x: c.x, y: c.y, segs: R }, withGardens(t), treeCode), xs = [], zs = [];
    for (let i = 0; i <= R; i++) { xs.push(proj.x(lonOf(c.x + i / R, c.z))); zs.push(proj.z(latOf(c.y + i / R, c.z))); }
    let thin = 1;
    const dens = k => { const T = TREE[k]; if (!T) return 0; const st = T[1] * (c.lod ? 1.2 : 1) / Math.sqrt(Math.max(0.15, share)); return thin * T[2] / (st * st); };
    // a tile with more trees than its cap keeps the same share of them everywhere (not the first rows only)
    { let all = 0; for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) all += dens(ras[j * (R + 1) + i]) * Math.abs((xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j])); thin = Math.min(1, cap / Math.max(1, all * 1.1)); }
    yield;
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (i === 0 && j % 8 === 7) yield;
      const v = j * (R + 1) + i, most = Math.max(dens(ras[v]), dens(ras[v + 1]), dens(ras[v + R + 1]), dens(ras[v + R + 2])); if (!most) continue;
      const area = Math.abs((xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j])), N = most * area, cnt = Math.floor(N) + (hash2(i * 7 + c.x, j * 13 + c.y) < N % 1 ? 1 : 0);
      for (let m = 0; m < cnt; m++) {
        const fi = i + hash2(i * 31 + m, j * 17 + c.x), fj = j + hash2(j * 29 + m, i * 11 + c.y), k = ras[Math.round(fj) * (R + 1) + Math.round(fi)], d = dens(k);
        if (!d || hash2(m * 5 + i, j * 3 + m) * most > d) continue;
        const x = xs[i] + (xs[i + 1] - xs[i]) * (fi - i), z = zs[j] + (zs[j + 1] - zs[j]) * (fj - j), r = hash2(Math.round(x * 3), Math.round(z * 3));
        if (vcls(x, z)) continue;  // the Headlands: their cover from the aerial imagery (below), not OpenStreetMap's
        const lat = proj.lat(z), lon = proj.lon(x), h = hAt(x, z) ?? 0, sp = species(TREE[k][0], TREE[k][3], h, lat, lon, r);
        add(sp, x, z, 0.75 + 0.5 * hash2(Math.round(x), Math.round(z)), r);
        if (sp !== 'redwood') continue;
        // redwoods stand in rings round where an old one was (the ring only near the rider: further away its impostor
        // would be one more card over the same spot); sword ferns under them (full models near the rider only)
        if (r < 0.2) for (let e = 0; e < 1; e++) { const a = r * 40 + e * 2.6, rr = 3 + 1.5 * hash2(e, Math.round(x)); add('redwood', x + Math.cos(a) * rr, z + Math.sin(a) * rr, 0.55 + 0.4 * hash2(e, Math.round(z)), hash2(Math.round(z), e), 1); }
        if (fine && ferns < 8000) for (let e = 0; e < 4; e++) { const a = hash2(e, Math.round(x * 7)) * 6.283, rr = 2 + 5 * hash2(Math.round(z * 7), e); add('fern', x + Math.cos(a) * rr, z + Math.sin(a) * rr, 0.9 + 0.7 * hash2(e, Math.round(z)), hash2(e, Math.round(x))); ferns++; }
      }
    }
    yield;
    // the Headlands' groves where the aerial imagery has them (veg.js): Monterey cypress and pine, blue gum eucalyptus,
    // a tree every 7 m or so, tall (the planted groves are 15 to 40 m)
    if (veg) { const st = 6.8, [s0, w0, n0, e0] = veg.box, bx0 = Math.max(box[0], proj.x(w0)), bx1 = Math.min(box[2], proj.x(e0)), bz0 = Math.max(box[1], proj.z(n0)), bz1 = Math.min(box[3], proj.z(s0));
      for (let x = Math.ceil(bx0 / st) * st; x < bx1; x += st) {
        if (Math.round(x / st) % 4 === 0) yield;
        for (let z = Math.ceil(bz0 / st) * st; z < bz1; z += st) {
          const ix = Math.round(x / st), iz = Math.round(z / st), px = x + (hash2(ix, iz + 3) - 0.5) * st * 0.8, pz = z + (hash2(iz + 5, ix) - 0.5) * st * 0.8, k = vcls(px, pz);
          if ((k !== CYPRESS && k !== EUC) || hash2(ix * 3, iz * 7) > 0.85) continue;
          const r = hash2(ix + 9, iz * 3), sc = 0.8 + 0.5 * hash2(iz, ix + 1);
          if (k === EUC) add('euc', px, pz, 1.45 * sc, r); else add(r < 0.72 ? 'cypress' : 'pine', px, pz, (r < 0.72 ? 2.1 : 1.6) * sc, r);
        }
      } }
    yield;
    // lone oaks on the open hills, in loose clumps
    { const step = 26 * (c.lod ? 1.4 : 1) / Math.sqrt(Math.max(0.15, share));
      for (let x = Math.ceil(box[0] / step) * step; x < box[2]; x += step) for (let z = Math.ceil(box[1] / step) * step; z < box[3]; z += step) {
        if (n > cap) break;
        const ix = Math.round(x / step), iz = Math.round(z / step), clump = hash2(Math.floor(x / 260), Math.floor(z / 260));
        if (hash2(ix, iz) > clump * clump * 0.5) continue;
        const px = x + (hash2(iz, ix) - 0.5) * step, pz = z + (hash2(ix + 5, iz) - 0.5) * step, h = hAt(px, pz);
        if (h == null || h < 6 || inHeadlands(proj.lat(pz), proj.lon(px))) continue;
        add('oak', px, pz, 0.6 + 0.6 * hash2(ix, iz + 3), hash2(ix + 1, iz));
      } }
    yield;
    if (fine) {
      // coyote brush and toyon in patches on the open hills: thickest on the shaded north slopes and in the gullies
      const hlT = inHeadlands(proj.lat((box[1] + box[3]) / 2), proj.lon((box[0] + box[2]) / 2)), ss = (hlT ? 5 : 7) / Math.sqrt(Math.max(0.2, share)), nn = g.segs + 1;
      let shrubs = 0;
      const cap = (hlT ? 14000 : 5000) * share;
      for (let x = Math.ceil(box[0] / ss) * ss; x < box[2]; x += ss) for (let z = Math.ceil(box[1] / ss) * ss; z < box[3]; z += ss) {
        if (shrubs > cap) break;
        const ix = Math.round(x / ss), iz = Math.round(z / ss), px = x + (hash2(ix + 7, iz) - 0.5) * ss, pz = z + (hash2(ix, iz + 7) - 0.5) * ss;
        const [fi, fj] = gridIJ(g, px, pz), v = Math.round(fj) * nn + Math.round(fi);
        if (!(v >= 0 && v < nn * nn) || !c.mask) continue;
        const mk = c.mask, open = mk[8 * v] < 80 && mk[8 * v + 2] < 60 && mk[8 * v + 3] < 60 && mk[8 * v + 4] < 128 && mk[8 * v + 5] < 128 && mk[8 * v + 6] < 128;
        if (!open || c.nor[3 * v + 1] < 0.8 || vcls(px, pz)) continue;  // (the Headlands' scrub: scrub.js)
        const north = Math.max(0, -c.nor[3 * v + 2] * 2.5), patch = hash2(Math.floor(px / 90), Math.floor(pz / 90)) * 0.7 + hash2(Math.floor(px / 31) + 5, Math.floor(pz / 31)) * 0.3;
        const p = (patch - 0.55) * 1.6 + north * 0.5 + Math.max(0, c.cv[v]) * 0.9 + (mk[8 * v + 1] > 0 ? -0.2 : 0) + (hlT ? 0.45 : 0);
        if (hash2(ix * 3, iz * 5) > p) continue;
        const r = hash2(ix, iz * 3);
        add(r < (hlT ? 0.92 : 0.78) ? 'bush' : 'shrub', px, pz, (0.7 + 0.8 * hash2(iz, ix + 1)) * (hlT ? 1.6 : 1), r); shrubs++;
        if (shrubs % 600 === 0) yield;
      }
      yield;
      // stones in the grass, more on the steep
      for (let k = 0; k < 1400 * share; k++) {
        const px = box[0] + hash2(k, c.x) * (box[2] - box[0]), pz = box[1] + hash2(c.y, k) * (box[3] - box[1]);
        const [fi, fj] = gridIJ(g, px, pz), v = Math.round(fj) * nn + Math.round(fi);
        if (!(v >= 0 && v < nn * nn) || !c.mask || c.mask[8 * v + 3] > 60 || c.mask[8 * v + 2] > 60) continue;
        { const vk = vcls(px, pz); if (vk === SCRUB || vk === CYPRESS || vk === EUC) continue; }
        if (hash2(k, 7) > 0.25 + (1 - c.nor[3 * v + 1]) * 4) continue;
        add('stone', px, pz, 0.6 + 1.4 * hash2(k, 3) ** 2, hash2(k, 5));
      }
    }
    // per species the full models near the rider (fine tiles; partTrees fills them), and every tree of the tile as an
    // impostor in one draw (the full models' circle left out)
    yield;
    const grp = new THREE.Group(), imp = [], sets = [];
    let y0 = Infinity, y1 = -Infinity;
    for (const [sp, list] of Object.entries(out)) {
      const ci = SPECIES.indexOf(sp);
      // the ring of tiles further out (2 km and more) keeps four trees in ten, bigger, once and for all (thinning in the
      // shader would still cost the GPU every one of them); in the dense groves of redwood and fir fewer cards, no bigger:
      // there a card mostly covers others, and every layer costs the GPU (the full trees fill the near view)
      const keep = c.lod > 0 ? 0.42 : sp === 'redwood' ? 0.5 : sp === 'fir' ? 0.7 : 1, grow = c.lod > 0 ? 1 / Math.sqrt(keep) : 1;
      if (ci >= 0) for (const [x, y, z, s, r, nearOnly] of list) {
        const thin = c.lod > 0; if (nearOnly || (x * 0.1731 + z * 0.2917) - Math.floor(x * 0.1731 + z * 0.2917) > keep) continue;
        imp.push([x, y, z, s * grow, ci, (thin ? -1 : 1) * (0.85 + 0.3 * r), 0.86 + 0.28 * hash2(Math.round(x), Math.round(z)), (hash2(Math.round(z), Math.round(x)) - 0.5) * 0.12]);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y + 50 * s);
      }
      list.sort((u, w) => u[0] - w[0]);  // by x: a split looks at the strip round the rider only
      sets.push({ sp, list, fine, grp, low: sp === 'stone' || sp === 'fern', near: NEAR[sp] ?? 1, hi: null });
      yield;
    }
    let newImp = null;
    if (imp.length) {
      const cx = (box[0] + box[2]) / 2, cz = (box[1] + box[3]) / 2, sphere = new THREE.Sphere(new THREE.Vector3(cx, (y0 + y1) / 2, cz), Math.hypot(box[2] - box[0], box[3] - box[1], y1 - y0) / 2 + 30);
      // nearest the rider first (the GPU then skips much of what is hidden)
      const rx = me.group.position.x, rz = me.group.position.z; imp.sort((u, w) => (u[0] - rx) ** 2 + (u[2] - rz) ** 2 - (w[0] - rx) ** 2 - (w[2] - rz) ** 2);
      newImp = impostorMesh(IMP, imp, sphere); newImp.userData.ownMat = true; grp.add(newImp);
      yield;
    }
    // swap in at once (the old sets stay drawn until now)
    c.treeSets = sets; c.imp = newImp; c.partAt = null; partTrees(c, me.group.position.x, me.group.position.z);
    setPart(c, 'trees', grp);
  }
  // split a tile's trees: within `treeNear` metres of (x, z) (a share of it per species, NEAR) the full models, the
  // rest impostors (stones and ferns: nothing past it). A set grows when it needs more room. Nearest first, so the
  // shadow map (onBeforeShadow) draws just the first ones: those near enough for it.
  function partTrees(c, x, z) {
    const R = QUALITY[q].treeNear, m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(), tint = new THREE.Color();
    const Rs2 = (QUALITY[q].span + 25) ** 2;
    c.partAt = [x, z]; c.hiCount = 0;
    // each split new draws with their own buffers (the old ones dropped): writing into a buffer the GPU may still be
    // drawing from makes the browser wait for the GPU, hundreds of milliseconds on a busy frame
    const fill = (set, key, items, cast) => {
      let m = set[key];
      if (m) { set.grp.remove(m); m.dispose(); m = set[key] = null; }
      if (items.length) {
        m = set[key] = new THREE.InstancedMesh(trees[set.sp], mats.prop, items.length);
        m.userData.shared = true; m.castShadow = cast; m.receiveShadow = true; m.customDepthMaterial = mats.prop.userData.depth; set.grp.add(m);
        m.onBeforeShadow = () => { m.userData.all = m.count; m.count = m.userData.cast; }; m.onAfterShadow = () => { m.count = m.userData.all; };
      }
      if (!m) return;
      let a = 0; const sm = set.sp === 'stone';
      for (const [, [px, y, pz, sc, r]] of items) {
        e.set((r - 0.5) * 0.08, r * 6.283, 0); m.setMatrixAt(a, m4.compose(v.set(px, sm ? y + 0.25 : y, pz), qt.setFromEuler(e), s.set(sc, sc * (0.85 + 0.3 * r), sc)));
        const kk = 0.86 + 0.28 * hash2(Math.round(px), Math.round(pz)), w = (hash2(Math.round(pz), Math.round(px)) - 0.5) * 0.12;
        m.setColorAt(a++, tint.setRGB(kk * (1 + w), kk, kk * (1 - w)));
      }
      let k = 0; while (k < items.length && items[k][0] < Rs2) k++;
      c.hiCount += a; m.count = a; m.userData.cast = k;
      m.computeBoundingSphere();
    };
    for (const set of c.treeSets || []) {
      if (!set.fine) continue;
      // nearest first: the GPU skips what is hidden behind them (the cards are alpha tested, so this matters)
      const Rs = R * set.near, R2 = Rs * Rs, L = set.list, pick = [];
      let lo = 0, hi = L.length; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m][0] < x - Rs) lo = m + 1; else hi = m; }
      for (let i = lo; i < L.length && L[i][0] <= x + Rs; i++) { const t = L[i], d = (t[0] - x) ** 2 + (t[2] - z) ** 2; if (d < R2) pick.push([d, t]); }
      pick.sort((u, w) => u[0] - w[0]);
      fill(set, 'hi', pick, !set.low && QUALITY[q].shadow > 0);
    }
    if (c.imp) { const u = c.imp.material.userData.u; u.nearC.value.set(x, z); u.nearR.value = c.lod === 0 ? R : 0; }
  }
/* ---------- street furniture: guardrails where the ground falls away beside a road, lamps along town streets, stop
     signs where a small road meets another, a speed limit now and then, ranch fences along farm roads, picket fences
     in front of houses. Fine tiles only; one draw per kind. ---------- */
  function* buildFurniture(c) {
    const t = c.tile; if (!t || !c.grid || c.lod > 0 || !c.lines?.length) return setPart(c, 'furn', null);
    const g = c.grid, hAt = hOf(c), raw = (x, z) => gridHeight(g, x, z, g.raw), R = 64, ras = rasterBy({ z: c.z, x: c.x, y: c.y, segs: R }, t.features, treeCode);
    const cls = (x, z) => { const [fi, fj] = gridIJ(g, x, z), k = R / g.segs, i = Math.round(fi * k), j = Math.round(fj * k); return i >= 0 && j >= 0 && i <= R && j <= R ? ras[j * (R + 1) + i] : 0; };
    const items = { post: [], lamp: [], stop: [], limit: [], fence: [], picket: [], pole: [] }, rail = [], wires = [];
    const hlTile = inHeadlands(proj.lat((tileBox(c)[1] + tileBox(c)[3]) / 2), proj.lon((tileBox(c)[0] + tileBox(c)[2]) / 2));
    const put = (k, x, y, z, yaw) => items[k].push([x, y, z, yaw]);
    // a spatial hash of the lines' points (10 m), to find where a road ends on another
    const cell = new Map(), ck = (x, z) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
    c.lines.forEach((L, li) => L.P.forEach(p => { const k = ck(p[0], p[2]); (cell.get(k) ?? cell.set(k, []).get(k)).push(li); }));
    const meets = (x, z, self) => {
      const seen = new Set(); let ends = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const li of cell.get(`${Math.floor(x / 10) + a},${Math.floor(z / 10) + b}`) || []) {
        if (li === self || seen.has(li)) continue; seen.add(li);
        const Q = c.lines[li].P; let best = 1e9, bi = -1; Q.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[2] - z); if (d < best) { best = d; bi = i; } });
        if (best > c.lines[li].w / 2 + 3) continue;
        if (bi > 1 && bi < Q.length - 2) return true;  // another road passes: a T
        ends++;
      }
      return ends >= 2;  // three ways meet (one road going on is only a joint)
    };
    for (const [li, L] of c.lines.entries()) {
      if (li % 4 === 3) yield;
      const P = L.P, n = P.length, hw = i => P[i][3] ?? L.w / 2, big = /motorway|trunk|primary|secondary|tertiary/.test(L.hw), small = /residential|unclassified|living|road|service/.test(L.hw);
      const dir = i => { const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
      let run = 0;
      for (let i = 0; i < n; i++) {
        const [dx, dz] = dir(i), nx = -dz, nz = dx, [x, y, z] = P[i], k = cls(x, z), road = y - 0.25, r = hash2(Math.round(x), Math.round(z)), half = hw(i);
        run += i ? Math.hypot(x - P[i - 1][0], z - P[i - 1][2]) : 0;
        // lamps along town streets every 32 m, sides in turn; a speed limit along the bigger roads now and then
        if (k === 3 && !L.br && run >= 32) { run = 0; const s = (i >> 2) % 2 ? 1 : -1; put('lamp', x + nx * s * (half + 0.9), road, z + nz * s * (half + 0.9), Math.atan2(nz * s, -nx * s)); }
        if (big && !L.br && i % 90 === 45 && r < 0.6) put('limit', x + nx * (half + 1.3), road, z + nz * (half + 1.3), Math.atan2(-dx, -dz));

        // fences: post and rail along farm roads, picket in front of the houses on town streets, in stretches
        if (i % 3 === 0 && !L.br && i + 1 < n && !hlTile) for (const s of [1, -1]) {  // (none in the Headlands, Street View)
          const blk = hash2(Math.floor(x / 40) + s * 7, Math.floor(z / 40));
          if (k === 2 && blk < 0.75) put('fence', x + nx * s * (half + 3), hAt(x + nx * s * (half + 3), z + nz * s * (half + 3)) ?? road, z + nz * s * (half + 3), Math.atan2(-dz, dx));
          else if (k === 3 && small && blk < 0.3) put('picket', x + nx * s * (half + 2.4), hAt(x + nx * s * (half + 2.4), z + nz * s * (half + 2.4)) ?? road, z + nz * s * (half + 2.4), Math.atan2(-dz, dx));
        }
      }
      // stop signs where a small road ends on another
      if (small && n > 3) for (const [i, sgn] of [[0, -1], [n - 1, 1]]) {
        const [x, y, z] = P[i], half = hw(i); if (!meets(x, z, li)) continue;
        const [dx, dz] = dir(i), fx = dx * sgn, fz = dz * sgn, nx = -fz, nz = fx;  // toward the junction, and right of it
        put('stop', x - fx * (half + 4) + nx * (half + 0.8), y - 0.25, z - fz * (half + 4) + nz * (half + 0.8), Math.atan2(-fx, -fz));
      }
      // guardrails where the ground falls away beside the road (not bridges, not in town), in runs of 12 m or more
      if (L.br || L.hw === 'service') continue;
      for (const s of [1, -1]) {
        const steep = P.map(([x, y, z], i) => {
          // the ground as it was before the road was cut in: a drop of 4 m within 9 m of the edge
          const [dx, dz] = dir(i), nx = -dz * s, nz = dx * s, half = hw(i), e = raw(x + nx * (half + 1.5), z + nz * (half + 1.5)), f = raw(x + nx * (half + 9), z + nz * (half + 9));
          return e != null && f != null && y - 0.25 - f > 4 && e - (y - 0.25) < 1.5 && cls(x, z) !== 3;
        });
        for (let i = 0; i < n;) {
          if (!steep[i]) { i++; continue; }
          let j = i; while (j + 1 < n && steep[j + 1]) j++;
          const pts = []; for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, j + 1); k++) { const [dx, dz] = dir(k), o = hw(k) + 0.75; pts.push([P[k][0] - dz * s * o, P[k][1] - 0.25, P[k][2] + dx * s * o]); }
          let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][2] - pts[k - 1][2]);
          if (len >= 12) {
            pts.side = -s; rail.push(pts);  // its ridges toward the road
            let d = 0, next = 0;
            for (let k = 1; k < pts.length; k++) {
              const a = pts[k - 1], b = pts[k], L2 = Math.hypot(b[0] - a[0], b[2] - a[2]);
              for (; next <= d + L2; next += 1.9) { const f = (next - d) / (L2 || 1); put('post', a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, Math.atan2(-(b[2] - a[2]), b[0] - a[0])); }
              d += L2;
            }
          }
          i = j + 1;
        }
      }
    }
    // OpenStreetMap's power lines: a wooden pole with a crossarm at each node in the tile (across the line), two wires
    // from it to the next node
    { const bx = tileBox(c);
      for (const line of t.power || []) {
        const Q = line.map(([la, lo]) => proj.xz(la, lo)), at = Q.map(([x, z]) => [x, (hAt(x, z) ?? 0) - 0.1, z]);
        const yawAt = i => { const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)]; return Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2; };
        for (let i = 0; i < Q.length; i++) {
          const [x, z] = Q[i]; if (!(x >= bx[0] && x < bx[2] && z >= bx[1] && z < bx[3])) continue;
          const yaw = yawAt(i); put('pole', x, at[i][1], z, yaw);
          if (i + 1 < Q.length) { const yb = yawAt(i + 1); for (const o of [-0.8, 0.8]) wires.push([x + Math.sin(yaw) * o, at[i][1] + 9.1, z + Math.cos(yaw) * o, Q[i + 1][0] + Math.sin(yb) * o, at[i + 1][1] + 9.1, Q[i + 1][1] + Math.cos(yb) * o]); }
        }
      } }
    yield;
    const grp = new THREE.Group(), m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    // every kind in one batched draw
    const kinds = Object.keys(items).filter(k => items[k].length), count = kinds.reduce((n, k) => n + items[k].length, 0);
    if (count) {
      const bm = new THREE.BatchedMesh(count, kinds.reduce((n, k) => n + FURN[k].attributes.position.count, 0), 0, mats.furn);
      for (const k of kinds) { const gi = bm.addGeometry(FURN[k]); for (const [x, y, z, yaw] of items[k]) bm.setMatrixAt(bm.addInstance(gi), m4.compose(v.set(x, y, z), qq.setFromAxisAngle(up, yaw), one)); }
      bm.castShadow = QUALITY[q].shadow > 0; bm.receiveShadow = true; bm.computeBoundingSphere(); grp.add(bm);
    }
    // the wires: hanging a little between the poles (three straight pieces each)
    if (wires.length) {
      const pos = [];
      for (const [x0, y0, z0, x1, y1, z1] of wires) { let p = [x0, y0, z0]; for (const f of [1 / 3, 2 / 3, 1]) { const q = [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f - Math.sin(Math.PI * f) * 0.7, z0 + (z1 - z0) * f]; pos.push(...p, ...q); p = q; } }
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); wg.computeBoundingSphere();
      grp.add(new THREE.LineSegments(wg, wireMat));
    }
    // light from the street lamps on the road under them at dusk
    if (items.lamp.length) {
      const pm = new THREE.InstancedMesh(lampPool, lampPoolMat, items.lamp.length); pm.userData.shared = true; pm.renderOrder = 2;
      items.lamp.forEach(([x, y, z, yaw], i) => pm.setMatrixAt(i, m4.compose(v.set(x + Math.cos(yaw) * 1.85, (hAt(x + Math.cos(yaw) * 1.85, z - Math.sin(yaw) * 1.85) ?? y) + 0.48, z - Math.sin(yaw) * 1.85), qq.identity(), one)));
      pm.computeBoundingSphere(); grp.add(pm);
    }
    // the rails: a galvanised W-beam on the posts, 0.31 m tall, its two ridges standing out toward the road
    if (rail.length) {
      const pos = [], idx = [], W = [[0.5, 0], [0.56, 0.05], [0.65, 0], [0.74, 0.05], [0.81, 0]], N = W.length;
      for (const pts of rail) {
        const b0 = pos.length / 3;
        for (let k = 0; k < pts.length; k++) {
          const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1, [x, y, z] = pts[k];
          for (const [h, o] of W) pos.push(x - dz / l * o * pts.side, y + h, z + dx / l * o * pts.side);
        }
        for (let k = 1; k < pts.length; k++) for (let m = 0; m + 1 < N; m++) { const a = b0 + N * (k - 1) + m, b = a + N; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      }
      const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setIndex(idx); rg.computeVertexNormals(); rg.computeBoundingSphere();
      const rm = new THREE.Mesh(rg, mats.rail); rm.castShadow = QUALITY[q].shadow > 0; rm.receiveShadow = true; grp.add(rm);
    }
    setPart(c, 'furn', grp.children.length ? grp : null);
  }
  function* buildBuildings(c) {
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'bldg', null);
    const list = [], hAt = hOf(c);
    let nb = 0;
    for (const f of t.features) {
      if (f.k !== 'building') continue;
      if (++nb % 40 === 0) yield;
      let ring = f.rings[0].map(([la, lo]) => proj.xz(la, lo));
      { let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
        const k = 0.04 + 0.12 * hash2(Math.round(cx), Math.round(cz)); ring = ring.map(([x, z]) => { const d = Math.hypot(x - cx, z - cz) || 1; return [x - (x - cx) / d * k, z - (z - cz) / d * k]; }); }
      if (c.lod > 0 && ring.length > 12) continue;
      let base = Infinity; for (const p of ring) { const h = hAt(p[0], p[1]); if (h != null) base = Math.min(base, h); }
      if (!isFinite(base)) continue;
      { const dk = marks.deckAt(...ring[0]); if (dk != null && base + (f.h || 6) > dk - 12) continue; }  // the bridge's own anchorages and pylons (its model draws them); Fort Point under it stays
      list.push({ ring, base, h: (f.h || 6) + 0.1 * hash2(Math.round(ring[0][0]), 3), seed: Math.round(ring[0][0] * 13 + ring[0][1] * 7) });
    }
    if (!list.length) return setPart(c, 'bldg', null);
    const grp = new THREE.Group();
    for (let i = 0; i < list.length; i += 60) {
      yield;
      const mesh = new THREE.Mesh(buildingGeometry(list.slice(i, i + 60)), mats.bldg); mesh.castShadow = c.lod === 0 && QUALITY[q].shadow > 0; mesh.receiveShadow = c.lod === 0; grp.add(mesh);
    }
    setPart(c, 'bldg', grp);
  }
  // a far tile's woods (beyond the near tiles, out to where trees vanish): impostors on a coarse raster of its polygons
  const farReach = (c, lat, lon) => { const b = tileBox(c), x = proj.x(lon), z = proj.z(lat); return !!b && Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3])) < 14000; };
  function* buildFarTrees(c) {
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'trees', null);
    const R = 256, ras = rasterBy({ z: c.z, x: c.x, y: c.y, segs: R }, t.features, treeCode), xs = [], zs = [], list = [], step = 42 / Math.sqrt(Math.max(0.3, QUALITY[q].trees));
    for (let i = 0; i <= R; i++) { xs.push(proj.x(lonOf(c.x + i / R, c.z))); zs.push(proj.z(latOf(c.y + i / R, c.z))); }
    let y0 = Infinity, y1 = -Infinity;
    yield;
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (i === 0 && j % 16 === 15) yield;
      const k = ras[j * (R + 1) + i]; if (k < 5 || k > 8) continue;  // scrub and woods
      const area = Math.abs((xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j])), N = area / (step * step) * (k === 5 ? 0.4 : 1);
      for (let m = 0, cnt = Math.floor(N) + (hash2(i, j + c.y) < N % 1 ? 1 : 0); m < cnt; m++) {
        const x = xs[i] + (xs[i + 1] - xs[i]) * hash2(i * 13 + m, j), z = zs[j] + (zs[j + 1] - zs[j]) * hash2(j * 17 + m, i), h = gridHeight(c.grid, x, z);
        if (h == null || h < 2 || vcls(x, z)) continue;
        const r = hash2(Math.round(x), Math.round(z)), sp = k === 5 ? (r < 0.7 ? 'bush' : 'shrub') : species('wood', TREE[k][3], h, proj.lat(z), proj.lon(x), r);
        const s = (0.8 + 0.45 * hash2(Math.round(z), Math.round(x))) * (k === 5 ? 1.6 : 1) * 1.2;
        list.push([x, h - 0.5, z, s, SPECIES.indexOf(sp), -(0.85 + 0.3 * r), 0.86 + 0.28 * hash2(m, i + j), (hash2(j, i) - 0.5) * 0.12]); y0 = Math.min(y0, h); y1 = Math.max(y1, h + 50 * s);
      }
    }
    // the Headlands' groves (veg.js), a tree every 16 m
    if (veg) { const st = 16, [s0, w0, n0, e0] = veg.box, b = tileBox(c), bx0 = Math.max(b[0], proj.x(w0)), bx1 = Math.min(b[2], proj.x(e0)), bz0 = Math.max(b[1], proj.z(n0)), bz1 = Math.min(b[3], proj.z(s0));
      for (let x = Math.ceil(bx0 / st) * st; x < bx1; x += st) {
        if (Math.round(x / st) % 5 === 0) yield;
        for (let z = Math.ceil(bz0 / st) * st; z < bz1; z += st) {
          const k = vcls(x, z); if (k !== CYPRESS && k !== EUC) continue;
          const h = gridHeight(c.grid, x, z); if (h == null || h < 2) continue;
          const r = hash2(Math.round(x), Math.round(z)), sp = k === EUC ? 'euc' : r < 0.72 ? 'cypress' : 'pine', s = (k === EUC ? 1.45 : sp === 'cypress' ? 2.1 : 1.6) * (0.85 + 0.4 * hash2(Math.round(z), Math.round(x))) * 1.15;
          list.push([x, h - 0.5, z, s, SPECIES.indexOf(sp), -(0.85 + 0.3 * r), 0.86 + 0.28 * hash2(Math.round(x * 3), 7), (hash2(7, Math.round(z * 3)) - 0.5) * 0.12]); y0 = Math.min(y0, h); y1 = Math.max(y1, h + 50 * s);
        }
      } }
    c.farImp = null;
    if (!list.length) return setPart(c, 'trees', null);
    const b = tileBox(c), sphere = new THREE.Sphere(new THREE.Vector3((b[0] + b[2]) / 2, (y0 + y1) / 2, (b[1] + b[3]) / 2), Math.hypot(b[2] - b[0], b[3] - b[1], y1 - y0) / 2);
    c.farImp = impostorMesh(IMP, list, sphere); c.farImp.userData.ownMat = true; setPart(c, 'trees', c.farImp);
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
      if (c.ver != null && c.sig.furn !== ds) { c.sig.furn = ds; jobs.add(c.k + '|f', pri + 0.4 + c.lod, () => buildFurniture(c)); }
      if (c.ver != null && c.sig.tun !== ds) { c.sig.tun = ds; jobs.add(c.k + '|u', pri + 0.15, () => buildTunnels(c)); }
    }
    for (const c of far.values()) {
      if (c.tile === undefined) continue;
      const mask = childrenOf(c.k).map(k => near.get(k)?.built ? 1 : 0).join('');
      const fs = `${mask}|${q}`;
      if (c.sig.terrain !== fs) { c.sig.terrain = fs; jobs.add(c.k + '|t', 20 + (farDirty ? 0 : 5), () => buildTerrain(c)); }
      // its woods as impostors, once, within reach of the eye (the near tiles' square is left out in the shader)
      if (c.grid && c.sig.trees !== q && farReach(c, lat, lon)) { c.sig.trees = q; jobs.add(c.k + '|v', 26, () => buildFarTrees(c)); }
      if (c.farImp) { const u = c.farImp.material.userData.u.nearBox.value, R = Q.rings.at(-1), X = Math.floor(tileX(lon, NEAR_Z)), Y = Math.floor(tileY(lat, NEAR_Z));
        u.set(proj.x(lonOf(X - R, NEAR_Z)), proj.z(latOf(Y - R, NEAR_Z)), proj.x(lonOf(X + R + 1, NEAR_Z)), proj.z(latOf(Y + R + 1, NEAR_Z))); }
    }
    farDirty = false;
    // impostors after everything else that is opaque, nearest tile first: what is drawn before hides what is behind it
    // (alpha tested cards cost the GPU for every layer it cannot skip)
    { const imps = [...near.values()].filter(c => c.imp).map(c => [c.imp, Math.hypot(c.x + 0.5 - rx, c.y + 0.5 - ry)]);
      for (const c of far.values()) if (c.farImp) imps.push([c.farImp, 100 + Math.hypot(c.x + 0.5 - tileX(lon, FAR_Z), c.y + 0.5 - tileY(lat, FAR_Z))]);
      imps.sort((u, w) => u[1] - w[1]).forEach(([m], i) => { m.renderOrder = 1 + i; }); }
    if (tun.dirty) { tun.dirty = false; jobs.add('tunnels', 30, rebuildTunnels); }
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

  // lower a tile's ground under road tops T ([ax, ay, az, bx, ...], terrain.js pushUnder) and move its mesh to match
  function groundUnder(c, T) {
    const g = c.grid; if (!T.length || !g) return;
    if (pushUnder(g, T, { margin: Math.max(4, 0.75 * Math.abs(g.xs[1] - g.xs[0])) })) groundMoved(c);
  }
  // the terrain mesh moved to its grid's heights (after the ground was lowered under roads): a new geometry with new
  // buffers, the old one dropped (writing into a buffer the GPU may still be drawing from makes the browser wait)
  function groundMoved(c) {
    const g = c.grid; if (!g || !c.tmesh || !c.parts.terrain) return;
    const mesh = c.parts.terrain, old = mesh.geometry, geo = old.clone(), P = geo.attributes.position, { src, nv, skirt } = c.tmesh;
    for (let i = 0; i < src.length; i++) P.array[3 * i + 1] = g.hs[src[i]] - (i >= nv ? skirt : 0);
    geo.computeBoundingSphere(); mesh.geometry = geo; old.dispose(); hz.touch();
  }
  // a tile's road tops for the rider: segments [x0, y0, z0, x1, y1, z1, half width] in 10 m cells
  function roadIndex(a) {
    const S = new Float32Array(a), cells = new Map(), at = (x, z) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
    for (let k = 0; k < S.length; k += 7) { const key = at((S[k] + S[k + 3]) / 2, (S[k + 2] + S[k + 5]) / 2); (cells.get(key) ?? cells.set(key, []).get(key)).push(k); }
    return { S, cells };
  }
  // the drawn road's top at a point (its centre line's height across it), null off the roads
  function roadAt(x, z) {
    const [tx, ty] = tileOf(x, z), R = near.get(key(NEAR_Z, tx, ty))?.surf; if (!R) return null;
    const cx = Math.floor(x / 10), cz = Math.floor(z / 10), S = R.S; let best = null, bd = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of R.cells.get(`${cx + a},${cz + b}`) || []) {
      const ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2)) : 0;
      const d = Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t); if (d < S[k + 6] + 0.3 && d < bd) { bd = d; best = S[k + 1] + (S[k + 4] - S[k + 1]) * t; }
    }
    return best;
  }
  // how far a point is outside the nearest drawn road's edge (negative: on it), null with no road within 10 m
  function roadGap(x, z) {
    const [tx, ty] = tileOf(x, z), R = near.get(key(NEAR_Z, tx, ty))?.surf; if (!R) return null;
    const cx = Math.floor(x / 10), cz = Math.floor(z / 10), S = R.S; let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of R.cells.get(`${cx + a},${cz + b}`) || []) {
      const ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2)) : 0;
      const g = Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t) - S[k + 6]; if (best == null || g < best) best = g;
    }
    return best;
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
    if (occAt(c.occ, x, z) || tunnelAt(x, z)) return { skip: true };
    const g = c.grid, n = g.segs + 1, [fi, fj] = gridIJ(g, x, z), i = Math.round(fi), j = Math.round(fj);
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    const v = j * n + i, h = gridHeight(g, x, z), mk = c.mask, N = c.nor; if (h == null || h < 1.2) return null;
    if ((mk[8 * v + 4] > 100 && N[3 * v + 1] < 0.8) || mk[8 * v + 5] > 128 || mk[8 * v + 6] > 100) return { skip: true };
    if (mk[8 * v] > 120 && REDWOOD.value.some(b => x > b.x && x < b.z && z > b.y && z < b.w)) return { skip: true };  // no grass under the redwoods
    const vk = vcls(x, z); if (vk === CYPRESS || vk === EUC || (vk === SCRUB && hash2(Math.round(x * 7), Math.round(z * 7)) < 0.5)) return { skip: true };  // under the groves none; between the scrub's bushes some
    return { h, nx: N[3 * v], ny: N[3 * v + 1], nz: N[3 * v + 2], cv: c.cv[v], m: [mk[8 * v] / 255, mk[8 * v + 1] / 255, mk[8 * v + 2] / 255, mk[8 * v + 3] / 255] };
  }
  const grass = createGrass({ THREE, scene, mat: mats.grass, sample: groundSample });
  // the scrub's bushes stand on the ground: from a metre and a half past a road's edge (the road mask's cells are
  // coarser), not in a building, a bore or on a steep bank cut for a road
  function scrubGround(x, z) {
    const [tx, ty] = tileOf(x, z), c = near.get(key(NEAR_Z, tx, ty)); if (!c?.grid || !c.mask || !c.occ) return null;
    if ((occAt(c.occ, x, z) && (roadGap(x, z) ?? -1) < 1.5) || tunnelAt(x, z)) return { skip: true };
    const g = c.grid, n = g.segs + 1, [fi, fj] = gridIJ(g, x, z), v = Math.round(fj) * n + Math.round(fi), h = gridHeight(g, x, z);
    if (h == null || !(v >= 0 && v < n * n)) return null;
    if (h < 1.2 || (c.mask[8 * v + 4] > 100 && c.nor[3 * v + 1] < 0.75)) return { skip: true };
    return { h };
  }
  const scrub = createScrub({ THREE, scene, geos: scrubGeometries(), mat: mats.scrub, fade: scrubFade, cls: vcls, ground: scrubGround });

  /* ---------- tunnels: a lined bore through the hill, portals at both ends, the rider on the line between them ----------
     The baked tiles cut a tunnel at their edges, so the pieces are joined across tiles first; a tunnel is drawn once
     both its real ends (not on a tile edge) are loaded. */
  const tun = { list: [], dirty: false, group: null };
  const tileBox = c => c.grid && [Math.min(c.grid.xs[0], c.grid.xs[c.grid.segs]), Math.min(c.grid.zs[0], c.grid.zs[c.grid.segs]), Math.max(c.grid.xs[0], c.grid.xs[c.grid.segs]), Math.max(c.grid.zs[0], c.grid.zs[c.grid.segs])];
  const onEdge = (b, [x, z]) => !!b && (Math.abs(x - b[0]) < 0.8 || Math.abs(x - b[2]) < 0.8 || Math.abs(z - b[1]) < 0.8 || Math.abs(z - b[3]) < 0.8);
  function buildTunnels(c) {
    const box = tileBox(c);
    c.tunPieces = (c.tile?.roads || []).filter(r => r.fl & 2 && !/path|footway|steps/.test(r.hw)).map(r => ({ r, P: r.pts.map(([la, lo]) => proj.xz(la, lo)), box }));
    tun.dirty = true;
  }
  // (a slice at a time: a generator; the tunnels in use stay until the new ones are done)
  function* rebuildTunnels() {
    // the tiles store each road with a margin past their edge: pieces of one tunnel overlap, so grow a piece's ends
    // along any other piece they lie on; a tunnel is whole when both ends sit in loaded tiles with nothing to extend them
    const pieces = [...near.values()].flatMap(c => c.tunPieces || []).sort((a, b) => b.P.length - a.P.length), used = new Set(), chains = [];
    const onLine = (p, Q) => { let best = { d: 1e9 }; for (let k = 0; k + 1 < Q.length; k++) { const a = Q[k], b = Q[k + 1], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / L2)) : 0, d = Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t); if (d < best.d) best = { d, k, ex, ez }; } return best; };
    const grow = (P, atEnd) => {
      for (let guard = 0; guard < 30; guard++) {
        const e = atEnd ? P.at(-1) : P[0], f = atEnd ? P.at(-2) : P[1], ox = e[0] - f[0], oz = e[1] - f[1];
        let hit = null; for (let j = 0; j < pieces.length && !hit; j++) if (!used.has(j)) { const h = onLine(e, pieces[j].P); if (h.d < 2.5) hit = [j, h]; }
        if (!hit) return;
        const [j, h] = hit, Q = pieces[j].P; used.add(j);
        const out = h.ex * ox + h.ez * oz > 0 ? Q.slice(h.k + 1) : Q.slice(0, h.k + 1).reverse();  // Q beyond e, going outward
        if (atEnd) P.push(...out); else P.unshift(...out.reverse());
      }
    };
    const loaded = p => { const [tx, ty] = tileOf(p[0], p[1]); return near.get(key(NEAR_Z, tx, ty))?.tile !== undefined; };
    for (let i = 0; i < pieces.length; i++) {
      if (used.has(i)) continue; used.add(i);
      const q = pieces[i];
      if (chains.some(ch => onLine(q.P[0], ch.P).d < 2.5 && onLine(q.P.at(-1), ch.P).d < 2.5)) continue;  // a part of one already joined
      const P = q.P.slice(); grow(P, true); grow(P, false);
      if (loaded(P[0]) && loaded(P.at(-1))) chains.push({ P, r: q.r });
    }
    const list = [], B = builder(), grp = new THREE.Group(), pos = [], idx = [], tl = [], posB = [], idxB = [], tlB = [], ports = [], lamps = [], cuts = [], walk = { pos: [], idx: [], col: [] }, heads = [];
    for (const { P: P0, r } of chains) {
      yield;
      const P = resample(P0, 6); if (P.length < 2) continue;
      const D = [0]; for (let i = 1; i < P.length; i++) D.push(D[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      const out = (p, q) => { const dx = p[0] - q[0], dz = p[1] - q[1], l = Math.hypot(dx, dz) || 1, a = groundAt(...p), b = groundAt(p[0] + dx / l * 12, p[1] + dz / l * 12); return a == null ? b : b == null ? a : Math.min(a, b); };
      const h0 = out(P[0], P[1]) ?? 0, h1 = out(P.at(-1), P.at(-2)) ?? h0, L = D.at(-1) || 1;
      // one lane, both ways in turn (lanes=1, not a oneway: the Baker-Barry tunnel, Street View): the lane with an edge
      // line each side, a raised walk along its north wall, a narrow round-arched bore, its portals at the way's ends
      const one = r.ln === 1 && !(r.fl & 8), st = one ? { w: 4.4, lm: 1, surf: 0, lanes: 1, a: 0.3, b: 0.3, pL: 0, pR: 0 } : roadStyle(r.hw, r.ln, r.fl, r.wd);
      // at grade (hardly any ground over it) or very short: ride it on the surface, no bore. Under a road or a little
      // ground (US-101 over Alexander Avenue and Bunker Road): an underpass, its headwalls right at its ends: a concrete
      // box with a flat roof, or a barrel arch (ARCHED). Deeper and longer: a bored tunnel, arched, lit, its portals at
      // the end of a cut.
      // (the cover: the most ground over its middle half; a short one under a motorway's fill has its ends carved down)
      let cover = 0; for (let i = 0; i < P.length; i++) if (D[i] > L * 0.25 && D[i] < L * 0.75) cover = Math.max(cover, (groundAt(...P[i]) ?? 0) - (h0 + (h1 - h0) * D[i] / L));
      if (cover < 3 || L < 18) { ribbon(B, P, { ...st, hAt: (x, z) => groundAt(x, z), lift: roadLift(r.hw), step: 6 }); continue; }
      const box = cover < 8 || L < 3 * PORT, port = box ? 1.5 : one ? 2 : PORT, mid = P[P.length >> 1], arch = box && ARCHED.some(([la, lo]) => Math.hypot(proj.x(lo) - mid[0], proj.z(la) - mid[1]) < 60);
      // half width, the walls' height, the arch's rise over them (0: a flat roof)
      const w = st.w / 2 + (one || arch ? 1 : 2), H = box ? (arch ? 1.4 : 5.2) : one ? 2 : 2.2, rise = box && !arch ? 0 : one || arch ? w : w * 0.75;
      // the bore as straight pieces of up to 40 m (for the ground to leave out): [x0, z0, x1, z1, floor0, floor1, half width, height]
      const segs = []; let i0 = P.findIndex((_, i) => D[i] >= port - 1);
      for (let i = i0 + 1; i0 >= 0 && i < P.length && D[i0] < L - port + 1; i++) if (D[i] - D[i0] >= 40 || i === P.length - 1 || D[i] >= L - port + 1) {
        segs.push([P[i0][0], P[i0][1], P[i][0], P[i][1], h0 + (h1 - h0) * D[i0] / L, h0 + (h1 - h0) * D[i] / L, w + 0.3, H + rise + 0.6]); i0 = i;
      }
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity; for (const [x, z] of P) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
      list.push({ P, D, h0, h1, w, L, segs, port, box, bb: [bx0 - w - 5, bz0 - w - 5, bx1 + w + 5, bz1 + w + 5] });
      const k0 = B.idx.length; ribbon(B, P, { ...st, hAt: () => 0, deck: [h0, h1], lift: 0.05, step: 6 }); cuts.push([k0, B.idx.length, port, L]);
      // a ring: walls up to the arch (or the flat roof), and the floor under the road (closed, so nothing outside shows through)
      const SEG = 12, R = w, ring = [];
      if (!rise) ring.push([R, H], [-R, H]);
      else for (let k = 0; k <= SEG; k++) { const th = Math.PI * k / SEG; ring.push([Math.cos(th) * R, Math.sin(th) * rise + H]); }
      ring.unshift([R, -0.15]); ring.push([-R, -0.15], [R, -0.15]);
      const [PO, TL, IX] = box ? [posB, tlB, idxB] : [pos, tl, idx], keep = [], N = ring.length, base = PO.length / 3;  // an underpass: bare concrete
      for (let i = 0; i < P.length; i++) if (D[i] >= port - 0.5 && D[i] <= L - port + 0.5) keep.push(i);
      // the one-lane tunnel's walk on its north wall (the side its normal points north at the middle): a raised walk,
      // two pipes along the wall over it
      const im = keep[keep.length >> 1] ?? 0, ns = P[Math.min(P.length - 1, im + 1)][0] - P[Math.max(0, im - 1)][0] < 0 ? 1 : -1, wb = walk.pos.length / 3;
      const WALK = [[R - 1.0, -0.1], [R - 1.0, 0.22], [R, 0.22], ...[[0.95, 0.24], [1.5, 0.16]].flatMap(([py, pr]) => Array.from({ length: 7 }, (_, k) => [R - 0.05 - pr + Math.cos(k * Math.PI / 6 - Math.PI / 2) * pr, py + Math.sin(k * Math.PI / 6 - Math.PI / 2) * pr]))];
      keep.forEach((i, n) => {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l, y = h0 + (h1 - h0) * D[i] / L;
        for (const [cx, cy] of ring) { PO.push(P[i][0] + nx * cx, y + cy, P[i][1] + nz * cx); TL.push(D[i], Math.max(0, cy) / (H + rise), cx / R); }
        // lamps every 9 m: high on both walls, or along the crown of a one-lane bore; and the light they put on the road
        if (!box && n && Math.floor(D[i] / 9) !== Math.floor(D[keep[n - 1]] / 9)) for (const s of one ? [0] : [-1, 1]) { const th = s ? (s > 0 ? 0.62 : Math.PI - 0.62) : Math.PI / 2; lamps.push([P[i][0] + nx * Math.cos(th) * R * 0.97, y + H + Math.sin(th) * rise * 0.97, P[i][1] + nz * Math.cos(th) * R * 0.97, Math.atan2(dx, dz), s]); }
        if (n) for (let k = 0; k < N - 1; k++) { const p0 = base + (n - 1) * N + k, p1 = base + n * N + k; IX.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }
        if (one) {
          for (const [cx, cy] of WALK) { walk.pos.push(P[i][0] + nx * cx * ns, y + cy, P[i][1] + nz * cx * ns); walk.col.push(...(cy < 0.3 ? [0.62, 0.6, 0.56] : [0.24, 0.24, 0.25])); }
          if (n) for (const [k0, k1] of [[0, 2], [3, 9], [10, 16]]) for (let k = k0; k < k1; k++) { const p0 = wb + (n - 1) * WALK.length + k, p1 = p0 + WALK.length; walk.idx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1); }
        }
        if (n === 0 || n === keep.length - 1) ports.push([P[i][0], y, P[i][1], Math.atan2(dx, dz), R, H, n === 0 ? -1 : 1, box, rise, arch, one]);
      });
    }
    if (!B.n) { if (tun.group) disposeObj(tun.group); tun.group = null; tun.list = list; return; }
    yield;
    // the open cuts before the portals: the ground there kept under the road (each near tile its own part)
    { const T = [];
      for (const [a, b, port, L] of cuts) for (let k = a; k + 2 < b; k += 3) {
        const vs = [B.idx[k], B.idx[k + 1], B.idx[k + 2]]; if (!vs.every(v => B.uv[2 * v + 1] <= port + 1) && !vs.every(v => B.uv[2 * v + 1] >= L - port - 1)) continue;
        for (const v of vs) T.push(B.pos[3 * v], B.pos[3 * v + 1], B.pos[3 * v + 2]);
      }
      if (T.length) for (const c of near.values()) if (c.lod === 0 && c.grid) { const bx = tileBox(c), Tc = [];
        for (let k = 0; k < T.length; k += 9) if (T[k] > bx[0] - 12 && T[k] < bx[2] + 12 && T[k + 2] > bx[1] - 12 && T[k + 2] < bx[3] + 12) Tc.push(...T.slice(k, k + 9));
        groundUnder(c, Tc); yield; } }
    const d = B.done(), rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); rg.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2)); rg.setAttribute('rd', new THREE.BufferAttribute(d.code, 4)); rg.setAttribute('rd2', new THREE.BufferAttribute(d.code2, 4));
    rg.setIndex(new THREE.BufferAttribute(d.idx, 1)); rg.computeVertexNormals(); grp.add(new THREE.Mesh(rg, mats.road));
    if (pos.length) {
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setAttribute('tl', new THREE.Float32BufferAttribute(tl, 3)); bg.setIndex(idx); bg.computeVertexNormals();
      grp.add(new THREE.Mesh(bg, mats.tunnel));
    }
    if (posB.length) {
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(posB, 3)); bg.setIndex(idxB); bg.computeVertexNormals();
      const m = new THREE.Mesh(bg, mats.underpass); m.receiveShadow = true; grp.add(m);
    }
    if (walk.pos.length) {
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(walk.pos, 3)); wg.setAttribute('color', new THREE.Float32BufferAttribute(walk.col, 3));
      wg.setIndex(walk.idx); wg.computeVertexNormals();
      const wm = new THREE.Mesh(wg, mats.walk); wm.receiveShadow = true; grp.add(wm);
    }
    if (lamps.length) {
      const lm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.14, 1.3), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.3, 3.2) }), lamps.length), m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion();
      lamps.forEach(([x, y, z, yaw, s], i) => lm.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y, z), q4.setFromEuler(new THREE.Euler(0, yaw, s * 0.6, 'YXZ')), new THREE.Vector3(1, 1, 1))));
      lm.computeBoundingSphere(); grp.add(lm);
    }
    // portals: a headwall with an arched opening at the end of the cut, wider and taller than the bore; all their parts
    // in one draw (attribute pl: a part's own position, for the courses in the portal shader)
    const pp = [], pn = [], pl = [], m4 = new THREE.Matrix4(), nm = new THREE.Matrix3();
    const add = (g, x, y, z, ry) => {
      const ng = g.index ? g.toNonIndexed() : g; ng.computeVertexNormals(); m4.makeRotationY(ry).setPosition(x, y, z); nm.getNormalMatrix(m4);
      const p = ng.attributes.position, n = ng.attributes.normal, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) { pl.push(p.getX(i), p.getY(i), p.getZ(i)); v.fromBufferAttribute(p, i).applyMatrix4(m4); pp.push(v.x, v.y, v.z); v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); pn.push(v.x, v.y, v.z); }
      if (ng !== g) ng.dispose(); g.dispose();
    };
    for (const [x, y, z, yaw, R, H, dir, box, rise, arch, one] of ports) {
      if (arch || one) {
        // a flat headwall with a round-arched opening, a coping, wing walls splayed out from it and sloping down (Street
        // View: the Baker-Barry tunnel's portals, Bunker Road under US-101); at a one-lane tunnel a signal each side of
        // the opening, on the wall
        const top = H + rise + 2.2, half = R + 2.6, ry = yaw + (dir > 0 ? Math.PI : 0), sh = new THREE.Shape(); sh.moveTo(-half, -1); sh.lineTo(half, -1); sh.lineTo(half, top); sh.lineTo(-half, top); sh.lineTo(-half, -1);
        const hole = new THREE.Path(); hole.moveTo(-R, -0.5); hole.lineTo(R, -0.5); hole.lineTo(R, H);
        for (let k = 1; k <= 16; k++) { const th = Math.PI * k / 16; hole.lineTo(Math.cos(th) * R, H + Math.sin(th) * rise); }
        hole.lineTo(-R, -0.5); sh.holes.push(hole);
        const parts = [new THREE.ExtrudeGeometry(sh, { depth: 0.8, bevelEnabled: false }).translate(0, 0, -0.8), new THREE.BoxGeometry(2 * half + 0.5, 0.35, 1.1).translate(0, top + 0.15, -0.4)];
        for (const s of [-1, 1]) {
          const ws = new THREE.Shape(); ws.moveTo(0, -1); ws.lineTo(7, -1); ws.lineTo(7, 1); ws.lineTo(0, top - 0.4); ws.lineTo(0, -1);
          parts.push(new THREE.ExtrudeGeometry(ws, { depth: 0.6, bevelEnabled: false }).translate(0, 0, -0.3).rotateY(Math.atan2(Math.cos(0.6), s * Math.sin(0.6))).translate(s * (half - 0.3), 0, -0.8));
        }
        for (const g of parts) add(g, x, y, z, ry);
        if (one) for (const s of [-1, 1]) { const v = new THREE.Vector3(s * (R + 1.1), H + rise * 0.55, -0.85).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry); heads.push([x + v.x, y + v.y, z + v.z, ry + Math.PI]); }
        continue;
      }
      if (box) {  // an underpass: a square headwall the depth of the road over it, a coping, wing walls
        const top = H + 1.6, wing = R + 3.5, sh = new THREE.Shape(); sh.moveTo(-wing, -1); sh.lineTo(wing, -1); sh.lineTo(wing, top); sh.lineTo(-wing, top); sh.lineTo(-wing, -1);
        const hole = new THREE.Path(); hole.moveTo(-R, -0.5); hole.lineTo(R, -0.5); hole.lineTo(R, H); hole.lineTo(-R, H); hole.lineTo(-R, -0.5); sh.holes.push(hole);
        for (const g of [new THREE.ExtrudeGeometry(sh, { depth: 0.8, bevelEnabled: false }).translate(0, 0, -0.8), new THREE.BoxGeometry(2 * wing + 0.6, 0.35, 1.1).translate(0, top + 0.15, -0.4)]) add(g, x, y, z, yaw + (dir > 0 ? Math.PI : 0));
        continue;
      }
      const top = H + rise + 5, wing = R + 5, sh = new THREE.Shape(); sh.moveTo(-wing, -1); sh.lineTo(wing, -1); sh.lineTo(wing, top - 3); sh.lineTo(R + 2, top); sh.lineTo(-R - 2, top); sh.lineTo(-wing, top - 3); sh.lineTo(-wing, -1);
      const hole = new THREE.Path(); hole.moveTo(-R, -0.5); hole.lineTo(R, -0.5); hole.lineTo(R, H);
      for (let k = 1; k <= 12; k++) { const th = Math.PI * k / 12; hole.lineTo(Math.cos(th) * R, H + Math.sin(th) * rise); }
      hole.lineTo(-R, -0.5); sh.holes.push(hole);
      const pg = new THREE.ExtrudeGeometry(sh, { depth: 0.9, bevelEnabled: false }).translate(0, 0, -0.9), pm = new THREE.Mesh(pg, mats.portal);
      // an arch ring standing a little proud round the opening, a coping along the top, pilasters either side
      const ar = new THREE.Shape(); ar.moveTo(R + 0.75, -0.5); ar.lineTo(R + 0.75, H);
      for (let k = 1; k <= 16; k++) { const th = Math.PI * k / 16; ar.lineTo(Math.cos(th) * (R + 0.75), H + Math.sin(th) * (rise + 0.75)); }
      ar.lineTo(-R - 0.75, -0.5); ar.lineTo(-R, -0.5); ar.lineTo(-R, H);
      for (let k = 15; k >= 1; k--) { const th = Math.PI * k / 16; ar.lineTo(Math.cos(th) * R, H + Math.sin(th) * rise); }
      ar.lineTo(R, H); ar.lineTo(R, -0.5);
      const parts = [pg, new THREE.ExtrudeGeometry(ar, { depth: 0.25, bevelEnabled: false }), new THREE.BoxGeometry(2 * R + 4.6, 0.45, 1.3).translate(0, top + 0.2, -0.45),
        ...[-1, 1].map(s => new THREE.BoxGeometry(1.1, top - 2.5, 1.2).translate(s * (wing - 0.55), (top - 2.5) / 2 - 1, -0.3))];
      for (const g of parts) add(g, x, y, z, yaw + (dir > 0 ? Math.PI : 0));
    }
    if (pp.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(pn, 3)); g.setAttribute('pl', new THREE.Float32BufferAttribute(pl, 3)); g.computeBoundingSphere();
      const pm = new THREE.Mesh(g, mats.portal); pm.castShadow = true; pm.receiveShadow = true; grp.add(pm);
    }
    if (heads.length) {
      const hm = new THREE.InstancedMesh(FURN.signalHead, mats.furn, heads.length), q4 = new THREE.Quaternion(), unit = new THREE.Vector3(1, 1, 1);
      heads.forEach(([x, y, z, yaw], i) => hm.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y, z), q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), unit)));
      hm.userData.shared = true; hm.computeBoundingSphere(); grp.add(hm);
    }
    if (tun.group) disposeObj(tun.group);
    tun.group = grp; tun.list = list; scene.add(grp);
  }
  // the tunnel a point is in: { y, k } (k: how far in, 0 at a portal .. 1 from 25 m in), null outside
  function tunnelAt(x, z) {
    for (const T of tun.list) {
      const { P, D, bb } = T; if (x < bb[0] || z < bb[1] || x > bb[2] || z > bb[3]) continue;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)) : 0;
        if (Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t) < T.w + 5) { const d = D[i - 1] + (D[i] - D[i - 1]) * t; if (d < T.port - 1 || d > T.L - T.port + 1) return null; return { y: T.h0 + (T.h1 - T.h0) * d / T.L, k: Math.max(0, Math.min(T.box ? 0.35 : 1, Math.min(d - T.port, T.L - T.port - d) / 25)), x: a[0] + ex * t, z: a[1] + ez * t }; }
      }
    }
    return null;
  }

  /* ---------- riders ---------- */
  const me = makeRider(THREE, { kit: kit ?? 0xf2c230, kit2: 0x1b1f25 }); scene.add(me.group);
  const others = new Map();  // id -> { r, tag, x, z, yaw, seen }
  const TUN_LIGHT = new THREE.Color(0.6, 0.5, 0.36), hemiBase = [new THREE.Color(), new THREE.Color()]; let hemiKey = null;
  let grade = 0, dark = 0, camOver = null, sea = 0, seaAt = 0, lifeDt = 0, audioDt = 0;
  const cpu = { js: 0, draw: 0, max: 0 };  // milliseconds a frame on the CPU: the world's own work, issuing the draws
  // milliseconds a frame on the GPU (timer queries, when the dev switch __w3.gpu is on): the last 600 frames
  const gpuTime = (() => {
    const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'), wait = [], ms = [];
    return { ms,
      begin() { if (!ext) return null; for (let i = wait.length - 1; i >= 0; i--) if (gl.getQueryParameter(wait[i], gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) { const v = gl.getQueryParameter(wait[i], gl.QUERY_RESULT) / 1e6; ms.push(v); const PF = globalThis.__w3?.prof; if (PF && v > 12) PF.push(['gpu', wait[i].t, +v.toFixed(1)]); } gl.deleteQuery(wait[i]); wait.splice(i, 1); } if (ms.length > 600) ms.splice(0, ms.length - 600); const q = gl.createQuery(); q.t = Math.round(performance.now()); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); return q; },
      end(q) { gl.endQuery(ext.TIME_ELAPSED_EXT); wait.push(q); },
      get stat() { if (!ms.length) return null; const a = ms.slice().sort((x, y) => x - y); return { med: +a[a.length >> 1].toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(2), n: a.length }; } };
  })();
  // how much of the ground round a point is sea (for the sound of the waves): 16 points at 250 and 700 m
  function seaShare(x, z) {
    let n = 0; for (let k = 0; k < 16; k++) { const a = k * 0.785 + (k > 7 ? 0.39 : 0), r = k > 7 ? 700 : 250, h = groundAt(x + Math.cos(a) * r, z + Math.sin(a) * r); if (h == null || h < 0.4) n++; }
    return n / 16;
  }
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
  // the surface the rider is on: of what is drawn there (a deck, a bore, the ground) the one nearest the course's own
  // height, so a road under a bridge stays under it and the bridge's course stays on the deck; never under the ground
  // (but in a bore), and floating on the course's height rather than sunk when nothing drawn is near it (a deck not
  // built yet). Others (no course height): a deck, else a bore, else the ground.
  function yAt(x, z, d) {
    const k = deckAt(x, z), tn = tunnelAt(x, z), e = d == null ? null : eleAt(d), b = tn ? tn.y + 0.05 : null;
    let g = groundAt(x, z); const rd = g == null ? null : roadAt(x, z); if (rd != null && Math.abs(rd - g) < 1.5) g = rd;  // on a road: its top
    if (e == null) return k ?? b ?? g ?? 0;
    let best = null; for (const h of [k, b, g]) if (h != null && (best == null || Math.abs(h - e) < Math.abs(best - e))) best = h;
    if (best == null) return e;
    if (best < e - 6 && best === g) return e;
    if (best === k && g != null && g > k && g - k < 2) return g;  // where a deck meets the land a little under it
    return best;
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
    sky.set(sky.time); post.build({ ...Q, ...(globalThis.__w3?.post || {}) }); sky.setVolume(post.fog); grass.set(...Q.grass); scrub.set(...Q.scrub); VEG.near.value = Q.scrub[0];
    size = ''; poke();
    scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  }
  applyQuality();
  // the materials a tile or a tunnel brings in later, compiled up front in the background (a first use would otherwise
  // hold up a frame for 100 ms or more)
  mats.underpass = withSun(new THREE.MeshLambertMaterial({ color: 0xbdb6a8, emissive: 0x3a3832, side: THREE.DoubleSide }));  // the light bounced in from the openings
  { const g = new THREE.Group(), geo = new THREE.BoxGeometry(1, 1, 1); for (const m of [mats.underpass, mats.tunnel, mats.portal, mats.pillar, mats.walk]) g.add(new THREE.Mesh(geo, m));
    renderer.compileAsync?.(g, camera, scene).catch(() => {}).finally(() => geo.dispose()); }
  // and the instanced ones a tile or the scrub brings in later (the street lamps' pools of light, the scrub and the full
  // trees with their colours, in the light and in the shadow map, signals): drawn far under the ground in the first
  // frames, so every variant the passes need is built while the world loads
  const warm = new THREE.Group(); warm.userData.frames = 0; scene.add(warm);
  { const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    for (const [m, depth] of [[lampPoolMat], [mats.scrub, mats.scrub.userData.depth], [mats.prop, mats.prop.userData.depth], [mats.furn]]) {
      const im = new THREE.InstancedMesh(geo, m, 1); im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, -900, 0)); if (m !== lampPoolMat) im.setColorAt(0, new THREE.Color(1, 1, 1));
      im.frustumCulled = false; im.castShadow = !!depth; im.receiveShadow = true; if (depth) im.customDepthMaterial = depth; warm.add(im);
    }
    warm.userData.geo = geo; }
  function governor(dt, now) {
    if (document.hidden || dt > 0.25) return;
    if (jobs.size > 3) { ft = []; lastGov = now; return; }  // still building tiles: judge the steady ride, not the loading
    ft.push(dt); if (now - lastGov < 2500) return; lastGov = now;
    ft.sort((a, b) => a - b); const med = ft[ft.length >> 1] || 0; ft = [];
    if (med > 1 / 42) { slow++; fast = 0; } else { slow = 0; if (med < 1 / 75) fast++; }
    if (slow >= 2 && q < 2) { q++; slow = 0; applyQuality(); }
    else if (slow >= 4 && q === 2) fail(new Error('too slow'));
  }
  function frame(now) {
    raf = 0; if (dead) return;
    try {
      const dt = Math.min(0.1, (now - last) / 1000); last = now; const c0 = performance.now();
      if (!resize() || !st?.P) { raf = requestAnimationFrame(frame); return; }
      // the rider: where the engine said plus speed since, eased so updates never jump
      const v = st.v || 0, target = Math.min(dAt + v * Math.min(2, (now - tAt) / 1000), st.D.at(-1));
      dShown += (target - dShown) * Math.min(1, dt * 2.5) + (Math.abs(target - dShown) < 30 ? v * dt * 0.0 : 0);
      if (Math.abs(target - dShown) > 60) dShown = target;
      const d = Math.max(0, dShown), p0 = at(d), pa = at(d - 2), pb = at(d + 3);
      { const hx = pb[0] - pa[0], hz = pb[1] - pa[1], L = Math.hypot(hx, hz) || 1; side += (keepRight(p0[0], p0[1]) - side) * Math.min(1, dt * 1.5); rx = -hz / L; rz = hx / L; }
      let p = [p0[0] + rx * side, p0[1] + rz * side];
      // on the Golden Gate Bridge's sidewalks: round the outside of the tower legs (OpenStreetMap's way cuts their corners)
      if (marks.ggb) { const k = onDeck(proj.lat(p[1]), proj.lon(p[0])), ds = k ? Math.abs(Math.abs(k.s) - GGB.towers) : 99;
        if (ds < 16 && Math.abs(k.t) > 7 && Math.abs(k.t) < 21.2) { const f = Math.min(1, (16 - ds) / 6), q = marks.lane(k.s, k.t + (Math.sign(k.t) * 21.2 - k.t) * f); p = [q.x, q.z]; } }
      // in a tunnel: on the bore's own line (the course can run a few metres off it), eased in from the portal
      { const tn = tunnelAt(p[0], p[1]); if (tn) { const k = tn.k * tn.k * (3 - 2 * tn.k), sx = tn.x + rx * 1.4, sz = tn.z + rz * 1.4; p = [p[0] + (sx - p[0]) * k, p[1] + (sz - p[1]) * k]; } }
      const y = yAt(p[0], p[1], d), want = Math.atan2(pb[0] - pa[0], -(pb[1] - pa[1]));
      yaw += ((want - yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 8);
      const yb = yAt(pb[0], pb[1], d + 3), ya = yAt(pa[0], pa[1], d - 2);
      me.group.position.set(p[0], y, p[1]); me.group.rotation.set(Math.atan2(yb - ya, 5) * 0.9, -yaw, 0, 'YXZ');
      grade += ((yb - ya) / 5 - grade) * Math.min(1, dt * 1.5);
      me.update(dt, st.cad || 0, v, grade);
      const lat = proj.lat(p[1]), lon = proj.lon(p[0]);
      stream(lat, lon, now);
      const PF = globalThis.__w3?.prof, pm = PF ? [c0] : null, mark = PF ? () => pm.push(performance.now()) : () => {}, gq0 = PF && globalThis.__w3.gpu ? gpuTime.begin() : null;
      jobs.run(globalThis.__w3?.budget ?? (q === 2 ? 2.5 : 4)); mark();  // (__w3.budget: tools that only want it built)
      marks.update(camera, dt);
      // the full trees follow the rider: split a tile again after 60 m, unless it is all far away and already all simple
      for (const c of near.values()) if (c.treeSets && c.lod === 0 && (!c.partAt || Math.hypot(c.partAt[0] - p[0], c.partAt[1] - p[1]) > 60)) {
        const b = tileBox(c), far2 = b ? Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3])) > QUALITY[q].treeNear + 80 : false;
        c.partAt = [p[0], p[1]]; if (far2 && !c.hiCount) continue;
        jobs.add(c.k + '|p', 0.5, () => partTrees(c, p[0], p[1]));
      }
      const dbg = globalThis.__w3 || {};  // dev switches for profiling: { noGrass, noScrub, noLife, noImp, noHi, noSm, noTerrain, gpu }
      if (dbg.noLife) life.show(false);
      if (dbg.noImp || dbg.noHi || dbg.noSm || dbg.noTerrain || dbg.noFurn) { renderer.shadowMap.enabled = !dbg.noSm; for (const c of near.values()) { if (c.imp) c.imp.visible = !dbg.noImp; if (c.parts.furn) c.parts.furn.visible = !dbg.noFurn; if (c.parts.terrain && dbg.noTerrain) c.parts.terrain.visible = false; for (const t of c.treeSets || []) if (t.hi && dbg.noHi) t.hi.visible = false; } }
      mark(); if (ready && !dbg.noGrass) grass.update(camPos.x || p[0], camPos.z || p[1], q === 2 ? 1 : 2); if (ready && !dbg.noScrub) scrub.update(camPos.x || p[0], camPos.z || p[1], q === 2 ? 1 : 1.5, Math.min(40, QUALITY[q].span)); mark();
      WIND.time.value += dt; WIND.gust.value = 0.55 + 0.35 * Math.sin(now / 7300) * Math.sin(now / 3100);
      syncOthers(dt, now); arrows();
      lifeDt += dt;
      if (!dbg.noLife && (q < 2 || frames % 2 === 0)) life.update(lifeDt, { rider: { x: p[0], y, z: p[1], v, yaw }, ground: groundAt,
        riders: [{ x: p[0], z: p[1], v }, ...[...others.values()].map(e => ({ x: e.r.group.position.x, z: e.r.group.position.z, v: e.v || 0 }))], roads: () => {
        const out = []; for (const c of near.values()) if (c.lod === 0 && c.drive) for (const r of c.drive) if (Math.hypot(r.P[0][0] - p[0], r.P[0][2] - p[1]) < 900 || Math.hypot(r.P.at(-1)[0] - p[0], r.P.at(-1)[2] - p[1]) < 900) out.push(r);
        return out; } }), lifeDt = 0;
      mark();
      // camera: behind and above, looking down the road; first person: at the eyes
      const ahead = at(d + 14), hd = yAt(ahead[0], ahead[1], d + 14);
      const look = Math.atan2(ahead[0] - pa[0], -(ahead[1] - pa[1]));
      camYaw = camYaw == null ? look : camYaw + ((look - camYaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 2.2);
      const fx = Math.sin(camYaw), fz = -Math.cos(camYaw);
      if (mode === 'chase') {
        tmp.set(p[0] - fx * chase[0], y + chase[1], p[1] - fz * chase[0]);
        const tn = tunnelAt(tmp.x, tmp.z) ?? tunnelAt(p[0], p[1]), g = tn ? null : groundAt(tmp.x, tmp.z); if (g != null && tmp.y < g + 1.4) tmp.y = g + 1.4;
        if (tn) tmp.y = Math.min(tmp.y, y + 3.2);
        camPos.lerp(tmp, camInit ? Math.min(1, dt * 6) : 1); camInit = true;
        camLook.set(p[0] + fx * 10, (y + hd) / 2 + 1.1, p[1] + fz * 10);
        me.group.visible = true;
      } else {
        camPos.set(p[0] + fx * 0.15, y + 1.62, p[1] + fz * 0.15);
        camLook.set(p[0] + fx * 30, hd + 1.3, p[1] + fz * 30);
        me.group.visible = false;
      }
      camera.position.copy(camPos); camera.lookAt(camLook);
      if (camOver) { const [la, lo, h, hd, pitch] = camOver, [x, z] = proj.xz(la, lo), r = hd * Math.PI / 180; camera.position.set(x, h, z); camera.lookAt(x + Math.sin(r) * 100, h + Math.tan(pitch * Math.PI / 180) * 100, z - Math.cos(r) * 100); }
      sky.update(camera, me.group.position, dt, QUALITY[q].span);
      mark(); if (ready) hz.update(p[0], p[1], now); mark();
      // the bores nearest the camera, for the ground to leave out
      { const segs = [];
        for (const T of tun.list) for (const g of T.segs) segs.push([Math.hypot((g[0] + g[2]) / 2 - camPos.x, (g[1] + g[3]) / 2 - camPos.z), g]);
        segs.sort((a, b) => a[0] - b[0]); const n = Math.min(12, segs.length);
        for (let i = 0; i < n; i++) { const g = segs[i][1]; BORES.a.value[i].set(g[0], g[1], g[2], g[3]); BORES.b.value[i].set(g[4], g[5], g[6], g[7]); }
        BORES.n.value = n; }
      // inside a tunnel: the daylight fades out
      const tk = tunnelAt(camPos.x, camPos.z)?.k ?? 0; dark += (tk - dark) * Math.min(1, dt * 3);
      // the cars' lamps: on with the sun low (under about 8 degrees) and in tunnels
      { const sy = sky.sunDir.y, k = Math.min(1, Math.max(0, (0.14 - sy) / 0.12)); life.setLamps(Math.max(k * k * (3 - 2 * k), dark), scene.fog.color); LAMPS.value = Math.min(1, Math.max(0, (0.07 - sy) / 0.08)); }
      sky.sun.intensity = sky.sunI * (1 - 0.96 * dark); sky.hemi.intensity = sky.hemiI * (1 - 0.6 * dark);
      FOG_SUN.d.value.copy(sky.sunDir); FOG_SUN.c.value.copy(sky.sun.color).multiplyScalar(sky.sun.intensity);
      // the tunnel's own lamps: warm light all round inside it
      if (hemiKey !== sky.time) { hemiKey = sky.time; hemiBase[0].copy(sky.hemi.color); hemiBase[1].copy(sky.hemi.groundColor); }
      sky.hemi.color.copy(hemiBase[0]).lerp(TUN_LIGHT, dark * 0.9); sky.hemi.groundColor.copy(hemiBase[1]).lerp(TUN_LIGHT, dark * 0.7);
      if (now - seaAt > 1000) { seaAt = now; sea = seaShare(p[0], p[1]); }
      audioDt += dt; if (audioDt > 0.1) { audio.update({ dt: audioDt, v, cad: st.cad || 0, sea, inside: dark }); audioDt = 0; }
      // the shadow map every other frame (the box only moves when it is drawn, so the old one stays true until then)
      if (frames % (globalThis.__w3?.smEvery ?? 2) === 0) { sky.update(camera, me.group.position, 0, QUALITY[q].span, true); renderer.shadowMap.needsUpdate = true; }
      // once the world round the start is built: every program it needs built now, not when a part of it first comes
      // into view or into the shadow box on the ride (each one held a frame up by a quarter of a second): the scene's
      // materials compiled, and one shadow map drawn over 20 km
      if (ready && warm.userData.frames > 3 && !warm.userData.all) {
        warm.userData.all = true; renderer.compile(scene, camera);
        { const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }), prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.compile(scene, camera); renderer.setRenderTarget(prev); rt.dispose(); }  // as drawn into post's targets
        for (const p of renderer.info.programs) p.getUniforms();  // linked and checked now (a program's first use waits for that)
        const c = sky.sun.shadow.camera, far = c.far; c.far = 40000; sky.update(camera, me.group.position, 0, 20000, true); c.updateProjectionMatrix(); renderer.shadowMap.needsUpdate = true;
        warm.userData.restore = () => { c.far = far; c.updateProjectionMatrix(); };
      } else if (warm.userData.restore) { warm.userData.restore(); warm.userData.restore = null; }
      renderer.info.reset(); mark();
      const c1 = performance.now();
      const gq = dbg.gpu && !gq0 ? gpuTime.begin() : null;
      if (dbg.noPost) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = sky.exposure; renderer.render(scene, camera); } else post.render(sky.exposure * (1 + dark * 0.6));
      if (gq || gq0) gpuTime.end(gq || gq0);
      const c2 = performance.now(); if (PF && c2 - c0 > 12) { pm.push(c2); PF.push([Math.round(now), ...pm.slice(1).map((t, i) => +(t - pm[i]).toFixed(1))]); if (PF.length > 400) PF.shift(); }
      cpu.js += (c1 - c0 - cpu.js) * 0.05; cpu.draw += (c2 - c1 - cpu.draw) * 0.05; cpu.max = Math.max(cpu.max * 0.995, c1 - c0);
      if (warm.parent && ++warm.userData.frames > 12 && warm.userData.all) { scene.remove(warm); warm.traverse(o => o.isInstancedMesh && o.dispose()); warm.userData.geo.dispose(); }
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
    grass.dispose(); scrub.dispose(); post.dispose(); life.dispose(); audio.dispose(); hz.dispose(); if (tun.group) disposeObj(tun.group);
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
    // a time of day (TIMES): the sun moves there over a few seconds
    setTime(t) { sky.go(t); return sky.time; },
    // Karl the fog's banks on or off
    setFog(on) { return sky.setBanks(on); }, fog: () => sky.banksOn,
    setKit(kit, accent) { me.setKit?.(kit, accent); },
    // world sound on or off
    setSound(on) { return audio.set(on); }, sound: () => audio.on,
    stats: () => ({ fps, quality: QUALITY[q].name, near: near.size, far: far.size, jobs: jobs.size, ready: ready && !warm.parent, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, grass: grass.count, scrub: scrub.count, life: life.counts, cpu: { js: +cpu.js.toFixed(2), draw: +cpu.draw.toFixed(2), max: +cpu.max.toFixed(1) }, gpu: gpuTime.stat, slow: jobs.slow }),
    setQuality(n) { q = Math.max(0, Math.min(2, n)); applyQuality(); },
    dispose, alive: () => !dead,
    // for checks and screenshots: the scene, the rider, what is under a point
    debug: () => ({ scene, camera, THREE, renderer, horizon: hz, gpuMs: gpuTime.ms, me: me.group.position.toArray(), probe: (x, z) => ({ tunnel: tunnelAt(x, z), ground: groundAt(x, z), deck: deckAt(x, z) }), lat: z => proj.lat(z), lon: x => proj.lon(x), tunnels: tun.list.map(T => ({ h0: T.h0, h1: T.h1, L: T.L })) }),
    // a fixed camera for screenshots and checks: [lat, lon, height m, heading deg, pitch deg], null to follow the rider
    viewFrom(v) { camOver = v; },
  };
}
