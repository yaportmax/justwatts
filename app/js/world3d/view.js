// World 3D view: the Marin world in three.js around an open-world rider. Terrain, roads, trees and buildings stream
// in by Web Mercator tile from the baked world (baked.js), finest around the rider; a chase camera follows the road.
// Rendering runs on its own requestAnimationFrame loop and never touches the ride: any error, a lost context or a
// frame rate that stays bad calls onFail and the ride map falls back to the other views.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { makeProj, tileX, tileY, lonOf, latOf, key, unkey, headingOf, angDiff } from './geo.js';
import { GRID, gridAt } from './baked.js';
import { gridFromHeights, gridHeight, gridIJ, carveSteps, pushUnder, pushUnderSteps, rasterClasses, rasterBy, gridMesh, upsample, gridNormals, gridCurvature, classMasks, overTunnels } from './terrain.js';
import { ribbonEdge, sideKinds, sideRunsSteps, bankGeometry, railLine, CUT } from './banks.js';
import { builder, ribbon, deckSides, roadStyle, roadLift, resample, clipLine, chainWays, roundCorners, tapers, markCode, YB } from './ribbon.js';
import { wanted, plan, jobQueue, childrenOf, NEAR_Z, FAR_Z } from './stream.js';
import { dense, track, railIndex, profileOf, profileAt, railLift, oneLane, ONE_LANE, handBarriers } from './rail.js';
import { BARRIERS, CURBS, SURVEY, MARKINGS, BUILDINGS, CUTS } from './handlist.js';
import { hash2 } from './landuse.js';
import { terrainMaterial, roadMaterial, propMaterial, buildingMaterial, grassMaterial, furnitureMaterial, tunnelMaterial, portalMaterial, withSun, WIND, BORES, REDWOOD, HL, SFB, LAMPS, VEG } from './materials.js';
import { createHorizon, HZ_LAYER } from './horizon.js';
import { treeGeometries, scrubGeometries, species, buildingGeometry, furnitureGeometries, SPECIES, NEAR, REDWOODS, HEADLANDS, SF_CITY, inHeadlands } from './props.js';
import { loadVeg, SCRUB, CYPRESS, EUC, PAVED, BARE } from './veg.js';
import { createScrub, REACH, TOP } from './scrub.js';
import { bakeImpostors, impostorMesh } from './impostor.js';
import { textures } from './tex.js';
import { createSky, FOG_SUN, SEA } from './sky.js';
import { createPost } from './post.js';
import { createGrass } from './grass.js';
import { createLife } from './life.js';
import { createAudio } from './audio.js';
import { makeRider } from './rider.js';
import { createLandmarks } from './marin.js';
import { GGB, onDeck } from '../ggb.js';
import { inWorld } from '../world.js';

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
// the barriers' kinds (handlist.js): k; off: their posts' line out from the paved edge (m); gap: a post every gap metres;
// sh: a level shoulder under them (an embankment only beyond). W-beam: its face 0.3 m out (the beam 0.2 m deep in front of
// its posts), posts every 6 ft 3 in (Caltrans Standard Plan A77, 1.905 m). The rest as Street View shows them (about).
// a road side strip's surface raster's key: the metre (x, z) as one number (no string per lookup)
const bkey = (x, z) => Math.round(x) * 2097152 + Math.round(z);
const BARRIER = [
  { k: 'wbeam', off: 0.5, gap: 1.905, sh: true }, { k: 'beam', off: 0.45, gap: 2.5, sh: true }, { k: 'krail', off: 0.4, gap: 6, sh: true },
  { k: 'cable', off: 0.8, gap: 2.4 }, { k: 'fence', off: 1, gap: 2.4 }, { k: 'chain', off: 1.6, gap: 3 },
  // (a curb along the paved edge, its face there: 6 in tall, 6 in across, A5)
  // (cb: the ground behind it at its top, a lawn or verge flush with it (Street View, Fort Baker: a low curb round a level
  // grass corner), then down to the ground)
  { k: 'curb', off: 0.075, gap: 1e9, cb: true }, { k: 'red', off: 0.075, gap: 1e9, cb: true },
  // (a concrete retaining wall, its face 0.25 m out from the paved edge, 0.25 m thick; its top the lidar's ground just
  // behind it (what it holds up), none where that is under 0.3 m: East Road, Street View 0a_0130)
  { k: 'wall', off: 0.375, gap: 1e9, wall: true },
];
// the tyres' contact over the rail's line: the drawn road's flat cross-sections turn at its points, so on a bend's outside
// the triangles between them lie up to a few centimetres over the line (Hawk Hill: 3.4 cm at 26 m/s); a road tyre's own
// contact patch is about that deep
const TYRE = 0.04;
// underpasses that are a barrel arch, not a concrete box (Street View): Bunker Road under US-101. Per portal (its way's end,
// [lat, lon]) its wing walls looking out of it, right and left: [length along the way out (m), splay (radians), height
// over the road at its end (m)], the top straight down to that from the headwall's. From USGS 3DEP's 1 m bare earth
// resampled at 0.5 m (the walls' faces: the ground 6 to 9 m up within 1.5 m of the road's edge, out to where it is a bank;
// the ground behind each wall's end) and Street View (2025-03, panos at 37.83821,-122.48334 heading 132 and
// 37.83778,-122.48269 heading 309): the west portal's right wall 10 m, its left a short wing (a rubble wall about 1.6 m
// high goes on along the road, not drawn); the east portal's right wall a panelled one 22 m along the road down to about
// 1 m, its left a short wing splayed out.
const ARCHED = [{ at: [37.8380, -122.4830], walls: [[[37.83810, -122.48318], [10, 0.04, 1.3], [3, 0.1, 2]], [[37.83790, -122.48288], [22, 0.02, 1], [4, 0.6, 1]]] }];

// life: the cars, walkers and birds (life.js), off by default (they cost frames; __w3.life turns them on for checks)
export function createWorldView({ container, baked, getOthers = () => [], onFail = () => {}, quality = 0, time = 'golden', sound = true, fog = true, kit = null, life: lifeOn = !!globalThis.__w3?.life }) {
  let q = Math.max(0, Math.min(2, quality)), dead = false, raf = 0;
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'; container.appendChild(canvas);
  const tags = document.createElement('div'); tags.className = 'w3tags'; container.appendChild(tags);
  // a cover over the world until the tiles round the rider are built (at the start and after a jump to another place):
  // never the rider on the bare ground with the road drawn in over them a moment later
  const veil = document.createElement('div'); veil.className = 'w3veil'; veil.textContent = 'Loading';
  veil.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;background:var(--bg,#0f1115);color:var(--mut,#8a93a0);font-size:13px;letter-spacing:.04em;pointer-events:none;transition:opacity .5s';
  container.appendChild(veil); let veilAt = performance.now(), veilP = null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true, failIfMajorPerformanceCaveat: false });
  } catch (e) { canvas.remove(); tags.remove(); veil.remove(); throw e; }
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); canvas.remove(); tags.remove(); veil.remove(); throw new Error('no WebGL2'); }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(new Error('WebGL context lost')); });

  const scene = new THREE.Scene(), proj = makeProj(...ORIGIN);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 60000);
  const sky = createSky(scene, { far: 60000 }); sky.set(time);
  const mats = { terrain: terrainMaterial(), terrainBore: terrainMaterial({ bores: true }), terrainFar: terrainMaterial({ detail: false }), terrainFarBore: terrainMaterial({ detail: false, bores: true }), road: roadMaterial(), prop: propMaterial(),
    bldg: buildingMaterial(), grass: grassMaterial(), pillar: new THREE.MeshLambertMaterial({ color: 0x9a968c }),
    tunnel: tunnelMaterial(), portal: portalMaterial(),
    // the W-beams galvanised (Street View: a mid grey, lit a little on their shaded side); kerbs concrete
    furn: furnitureMaterial(), rail: new THREE.MeshLambertMaterial({ color: 0xb4b9bc, emissive: 0x1e2022, side: THREE.DoubleSide }), curb: new THREE.MeshLambertMaterial({ color: 0xa9a69e }), redCurb: new THREE.MeshLambertMaterial({ color: 0xa2453a }),
    // the other barriers (handlist.js): white painted concrete (Alexander Avenue's rails and K-rails), timber rails, a wire,
    // chain-link's mesh seen through (rusty brown: Alexander Avenue, Field Road)
    wcon: new THREE.MeshLambertMaterial({ color: 0xd9d6cc, side: THREE.DoubleSide }), wood: new THREE.MeshLambertMaterial({ color: 0x5e4a36, side: THREE.DoubleSide }), wire: new THREE.MeshLambertMaterial({ color: 0x55524c, side: THREE.DoubleSide }),
    mesh: new THREE.MeshLambertMaterial({ color: 0x7a5c48, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }) };
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
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2c2d2e }), tunLampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.3, 3.2) });  // a tunnel's lamps
  const FURN = furnitureGeometries(), trees = treeGeometries(), IMP = bakeImpostors(renderer, trees, SPECIES, textures().leaves, NEAR), pillarGeo = new THREE.BoxGeometry(1.6, 1, 1.6).translate(0, 0.5, 0);
  const marks = createLandmarks({ THREE, scene, proj, sky, mats, baked });
  const post = createPost(renderer, scene, camera, sky.fog);
  const life = lifeOn ? createLife({ THREE, scene, proj, marks, quality: q }) : { update() {}, show() {}, setLamps() {}, dispose() {}, counts: null }, audio = createAudio({ on: sound });
  const onHide = () => { if (document.hidden) audio.hush(); }; document.addEventListener('visibilitychange', onHide);  // no frames come in a hidden tab
  sky.setBanks(fog);
  // the Headlands' ground cover (veg.js): the ground shader's texture, the scrub, the groves; tiles built before it
  // came are built again
  let veg = null;
  const vcls = (x, z) => veg ? veg.at(proj.lat(z), proj.lon(x)) : 0;
  loadVeg().then(v => {
    if (dead || !v) return;
    if (!v.cut) { v.cut = true; for (const { pts, w } of CUTS) v.paint(pts, w, BARE); }  // (the hand list's exposed cuts: bare earth; once, the grid is shared)
    const tex = new THREE.DataTexture(v.rgba(), v.n, v.n, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 4; tex.needsUpdate = true;
    renderer.initTexture(tex);
    const [s, w, n, e] = v.box; VEG.box.value.set(proj.x(w), proj.z(n), proj.x(e), proj.z(s)); VEG.tex.value = tex; veg = v;
    for (const c of [...near.values(), ...far.values()]) c.sig.trees = null;
    grass.invalidate(); scrub.invalidate(); poke();
  });

  // the rails of every road the rides reach (rail.js): the rider's heights, read before any tile; a course's profile is
  // matched to them when both are here
  let RI = null, HB = null, HM = null;  // (HB, HM: the hand list's barriers and lane markings on the rails, rail.js handBarriers)
  baked.rails?.().then(j => { if (dead || !j) return; RI = railIndex(j, proj.xz); HB = handBarriers(RI, BARRIERS.concat(CURBS), SURVEY, proj.xz); HM = handBarriers(RI, MARKINGS, [], proj.xz); if (st) st.ri = null; tun.dirty = true; poke(); });  // (the tunnels' floors from it)
  // a tunnel's rail at a point (its floor, baked), null off every tunnel's
  // the drawn top of the road at a point nearest the height e, of the rails it is on, not past one's end (rail.js top
  // counts a rail's end out to its half width past it: a bore's floor carried on level out of its portal)
  const roadTopOn = (x, z, e) => { if (!RI) return null; let best = null, bm = Infinity; for (const id of RI.near(x, z)) { const q = RI.rails[id], p = q.T.at(x, z); if (!p || Math.abs(p.d) >= q.half + 0.3 || (Math.abs(p.d) > 0.3 && ((p.k === 0 && p.t === 0) || (p.k === q.T.P.length - 2 && p.t === 1)))) continue; const y = p.h + q.lift; if (Math.abs(y - e) < bm) { bm = Math.abs(y - e); best = y; } } return best; };
  const tunRail = (x, z) => { if (!RI) return null; let best = null; for (const id of RI.near(x, z)) { const q = RI.rails[id]; if (!(q.r.fl & 2)) continue; const p = q.T.at(x, z); if (p && Math.abs(p.d) < q.half + 3 && (!best || Math.abs(p.d) < Math.abs(best.d))) best = p; } return best ? best.h : null; };

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
    // the grid's side: the quality's near the rider (upsampled from a coarse tile), 32 in the ring round them, a far
    // tile's own; from it the step through the tile's samples or the upsampling
    const fine = c.z === NEAR_Z && c.lod === 0, src = t.n - 1, want = c.z === FAR_Z ? src : fine ? Q.segs * Q.up : 32;
    const up = want > src ? Math.round(want / src) : 1, step = want < src ? Math.round(src / want) : 1, gk = up > 1 ? 'u' + up : 's' + step;
    const lidar = c.z === NEAR_Z && src > GRID[NEAR_Z];  // a tile from the lidar (about 7.5 m): its roads' benches and cuts are in the heights
    // built aside (G) and swapped in at the end: the ground in use stays as it is while this runs over several frames
    let G = c.grid;
    if (!G || G.key !== gk) {
      if (up > 1) G = gridFromHeights({ z: c.z, x: c.x, y: c.y, hs: upsample(t.hs, t.n, up, extOf(c)), n: (t.n - 1) * up + 1, step: 1, proj });
      else G = gridFromHeights({ z: c.z, x: c.x, y: c.y, hs: t.hs, n: t.n, step, proj });
      G.key = gk; G.m = (up > 1 ? 1 / up : step) * GRID[c.z] / src;  // the grid's step over the coarse grid's (about 15 m)
      yield;
    } else G = { ...G };
    G.cut = null; G.hs = G.raw;
    const ms = G.m;
    if (fine) {
      // a road over a tunnel (US-101 over Alexander Avenue and Bunker Road): the lidar's bare earth has a gap where the
      // overpass stands; the road is a deck across it (buildRoads), the ground under it left as it is (not carved)
      const tunnels = ridden(G) ? tunnelLines(t) : [];
      // every road level across its width (heights along it from the ground, eased), cut and fill banks either side
      const under = [];
      for (const r of t.roads) {
        if (r.fl & 3 || /path|footway|track|bridleway|steps/.test(r.hw)) continue;
        // a road with a rail (rail.js): the ground fitted to it (banks and cuts to the rail's heights, whatever the grid);
        // else heights along it from the ground, eased (the lidar's road is the real one: a crest stays a crest;
        // Terrarium's needs more)
        const rl = !!r.h, pts = rl ? dense(r.pts).map(([la, lo]) => proj.xz(la, lo)) : resample(r.pts.map(([la, lo]) => proj.xz(la, lo)), 8), P = [];
        const gp = tunnels.length ? overTunnels(pts, tunnels, 12, (x, z) => gridHeight(G, x, z, G.raw)) : [];
        for (let i = 0, d = 0; i < pts.length; i++) { if (i) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); const h = rl ? r.h[i] : gridHeight(G, pts[i][0], pts[i][1], G.raw); if (h != null) P.push([pts[i][0], pts[i][1], h, d]); }
        if (!rl) for (let k = 0; k < (lidar ? 1 : 4); k++) for (let i = 1; i + 1 < P.length; i++) P[i][2] = (P[i - 1][2] + 2 * P[i][2] + P[i + 1][2]) / 4;
        const w = roadStyle(r.hw, r.ln, r.fl, r.wd).w;
        // level across a ring of the grid's points either side, back to the ground within a few metres more (the
        // lidar's cut and fill banks kept); the ground well above it within 18 m of its edge is a cut (bare where steep);
        // not over a tunnel (the deck)
        for (const run of gp.length ? P.reduce((rs, p) => { if (gp.some(([a, b]) => p[3] >= a && p[3] <= b)) { if (rs.at(-1).length) rs.push([]); } else rs.at(-1).push(p); return rs; }, [[]]) : [P])
          if (run.length > 1) under.push(lidar || rl ? { pts: run, r0: w / 2 + 2.5, r1: w / 2 + 7, rc: w / 2 + 18, half: w / 2 } : { pts: run, r0: w / 2 + Math.max(2.5, 8 * ms), r1: w / 2 + Math.max(9, 22 * ms) });
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
        const L = D.at(-1), short = L < 3 * PORT;  // (an underpass: its approach cut out in front of each headwall, level)
        const box = [Math.min(G.xs[0], G.xs[G.segs]), Math.min(G.zs[0], G.zs[G.segs]), Math.max(G.xs[0], G.xs[G.segs]), Math.max(G.zs[0], G.zs[G.segs])];
        for (const [a, dir] of [[0, 1], [P.length - 1, -1]]) {
          if (!(P[a][0] > box[0] + 1 && P[a][0] < box[2] - 1 && P[a][1] > box[1] + 1 && P[a][1] < box[3] - 1)) continue;  // past the tile's edge: the neighbour's piece, not a portal
          // (the portal's height: the tunnel's rail, baked; else the lower of the ground there and a step out)
          const out = [P[a][0] * 2 - P[a + dir][0], P[a][1] * 2 - P[a + dir][1]], h = r.h ? (a ? r.h.at(-1) : r.h[0]) : Math.min(gridHeight(G, ...P[a], G.raw) ?? 1e9, gridHeight(G, ...out, G.raw) ?? 1e9);
          if (h > 1e8) continue;
          const pts = [], mid = P[P.length >> 1], arch = ARCHED.some(({ at: [la, lo] }) => Math.hypot(proj.x(lo) - mid[0], proj.z(la) - mid[1]) < 60);
          // (out from the portal at the road's own height there: its rail's top, as far over the portal's as it is)
          const t0 = roadTopOn(...P[a], h + 0.3), hOut = (x, z) => { const t = roadTopOn(x, z, h + 0.3); return t0 != null && t != null ? h + t - t0 : h; };
          if (short) { const ux = (P[a][0] - P[a + dir][0]), uz = (P[a][1] - P[a + dir][1]), ul = Math.hypot(ux, uz) || 1; for (let o = -3; o <= 12; o += 1) { const px = P[a][0] + ux / ul * o, pz = P[a][1] + uz / ul * o; pts.push([px, pz, o > 0 ? hOut(px, pz) : h]); } }
          else for (let i = a; i >= 0 && i < P.length && Math.abs(D[i] - D[a]) <= PORT + 1; i += dir) pts.push([P[i][0], P[i][1], h]);
          // (an underpass's cut level out past its headwall's wing walls, the opening clear down to the road: the fill
          // meets the wings, not the opening; its half width w / 2 + 1 and the wings 2.6 m past it, as rebuildTunnels draws.
          // An arch's measured wings (ARCHED) stand at the opening's sides, w / 2 + 1.6 out: the cut to them, the fill behind
          // them kept (rebuildTunnels leaves out the ground between them and draws their floor))
          if (pts.length > 1) under.push(!short ? { pts, r0: w / 2 + 2.5, r1: w / 2 + 9 } : arch ? { pts, r0: w / 2 + 2, r1: w / 2 + 9 } : { pts, r0: w / 2 + 9, r1: w / 2 + 12 });
        }
      }
      yield; if (!globalThis.__w3?.noCarve) yield* carveSteps(G, [], 0, 1, under); yield;  // (__w3.noCarve, noPush: checks)
      // the ground as carved to the roads, before it is pushed under their tops (the grid is coarser than a road: a
      // triangle under one road and beside another comes down whole): the road sides are drawn on this one (banks.js)
      G.carved = G.hs.slice();
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
    const bored = c.z === NEAR_Z && t.roads.some(r => r.fl & 2), mesh = new THREE.Mesh(g, c.z === NEAR_Z && Q.detail ? (bored ? mats.terrainBore : mats.terrain) : bored ? mats.terrainFarBore : mats.terrainFar);  // (the bores left out at every quality) mesh.receiveShadow = fine; mesh.matrixAutoUpdate = false; mesh.layers.enable(HZ_LAYER); hz.touch();
    c.grid = G; c.tmesh = { src: m.src, nv: (G.segs + 1) ** 2, skirt: c.z === FAR_Z ? 40 : 12 };
    if (fine) { c.nor = nor; c.mask = mask; c.cv = cv; grass.invalidate(tileBox(c)); scrub.invalidate(tileBox(c)); } else { c.nor = c.mask = c.cv = null; }
    setPart(c, 'terrain', mesh); upload(mesh); c.built = true; c.ver = (c.ver || 0) + 1; if (c.z === NEAR_Z) farDirty = true;
  }
  // a tile the rides can reach (the open world's edge, world.js BOUNDS, met by its box): its roads' decks over tunnels,
  // banks and rails are worked out (the scenery beyond, San Francisco's streets, seen from afar, goes without)
  const ridden = g => { if (!g) return false; const s = g.segs, la = [proj.lat(g.zs[0]), proj.lat(g.zs[s])], lo = [proj.lon(g.xs[0]), proj.lon(g.xs[s])], [s0, w0, n0, e0] = [Math.min(...la), Math.min(...lo), Math.max(...la), Math.max(...lo)];
    return la.some(a => lo.some(o => inWorld(a, o))) || inWorld((s0 + n0) / 2, (w0 + e0) / 2) || [[s0, (w0 + e0) / 2], [n0, (w0 + e0) / 2], [(s0 + n0) / 2, w0], [(s0 + n0) / 2, e0]].some(([a, o]) => inWorld(a, o)); };
  // a tile's tunnels (roads under the ground): their lines in local metres and half widths, once
  const tunnelLines = t => t.tunnelLines ??= t.roads.filter(r => r.fl & 2 && !/path|footway|track|bridleway|steps/.test(r.hw)).map(r => ({ pts: r.pts.map(([la, lo]) => proj.xz(la, lo)), th: roadStyle(r.hw, r.ln, r.fl, r.wd).w / 2 }));
  // a terrain mesh drawn in the next frame wherever it is (its buffers sent to the GPU then, a tile at a time), not
  // first in the horizon's height map, all the tiles built behind the camera at once (a 100 to 250 ms hold)
  const keepCulled = function () { this.frustumCulled = true; this.onAfterRender = () => {}; };
  function upload(mesh) { mesh.frustumCulled = false; mesh.onAfterRender = keepCulled; }
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
    // (v: 1 a road's cells (its half width and 1.2 m, the cells coarser than a verge), 2 a car park's or a building's)
    const mark = (x, z, r, v = 1) => { for (let a = Math.floor((x - r - ox) / ow); a <= Math.floor((x + r - ox) / ow); a++) for (let b = Math.floor((z - r - oz) / oh); b <= Math.floor((z + r - oz) / oh); b++) if (a >= 0 && b >= 0 && a < OCC && b < OCC) occ[b * OCC + a] = Math.max(occ[b * OCC + a], v); };
    const minor = c.lod > 0, lanes = [], drive = [], lines = [], tops = [], surf = [], sides = [], gends = [], tbox = [Math.min(g.xs[0], g.xs[g.segs]), Math.min(g.zs[0], g.zs[g.segs]), Math.max(g.xs[0], g.xs[g.segs]), Math.max(g.zs[0], g.zs[g.segs])];
    // ways that go on as one road drawn as one ribbon (no seam where OpenStreetMap splits a road), corners rounded
    t.chained ??= chainWays(t.roads, r => r.fl & 3 ? null : `${r.hw}|${r.ln}|${r.fl}|${r.wd}`);
    // where one road's ways of different layouts meet, the width eases from one to the other (no step)
    // (a one-lane bore's way its lane's width: the road narrows to it before each portal)
    t.joints ??= tapers(t.chained, { width: r => oneLane(r) ? ONE_LANE : roadStyle(r.hw, r.ln, r.fl, r.wd).w, rigid: r => r.fl & 19, ok: r => !/path|footway|track|bridleway|steps|cycleway|pedestrian/.test(r.hw), xz: proj.xz });
    let nr = 0;
    const tunnels = ridden(g) ? tunnelLines(t) : [];
    // the lidar's ground anywhere the baked tiles are loaded (before any carving): a deck's ends in the next tile
    const rawAt = (x, z) => { const lat = proj.lat(z), lon = proj.lon(x), X = tileX(lon, NEAR_Z), Y = tileY(lat, NEAR_Z), b = baked.peek(NEAR_Z, Math.floor(X), Math.floor(Y)); return b ? gridAt(b.hs, b.n, (X % 1) * (b.n - 1), (Y % 1) * (b.n - 1)) : null; };
    // how far along a line ([[x, z], ...]) its nearest point to p lies
    const arcAlong = (P, p) => { let best = 1e9, at = 0; for (let k = 0, d = 0; k + 1 < P.length; k++) { const a = P[k], b = P[k + 1], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez), t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / (L * L))) : 0, e = Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t); if (e < best) { best = e; at = d + L * t; } d += L; } return at; };
    // a line split at stretches [[s0, s1], ...] along it: the pieces, those over a stretch marked over (a tunnel under it)
    const splitOver = (pts, gp) => {
      if (!gp.length) return [pts];
      const out = [], at = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], cuts = gp.flat();
      let cur = [pts[0]], d = 0, ci = 0, inside = false;
      while (ci < cuts.length && cuts[ci] <= 0) { inside = !inside; ci++; }
      for (let k = 1; k < pts.length; k++) {
        const L = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        while (ci < cuts.length && cuts[ci] < d + L) { const p = at(pts[k - 1], pts[k], (cuts[ci] - d) / (L || 1)); cur.push(p); if (inside) cur.over = true; out.push(cur); cur = [p]; inside = !inside; ci++; }
        cur.push(pts[k]); d += L;
      }
      if (inside) cur.over = true; out.push(cur);
      return out.filter(q => q.length > 1);
    };
    // the roads' centre lines in 8 m cells (a trail that runs along a road's shoulder is the shoulder: not drawn there)
    const isTrail = r => /path|footway|track|bridleway|steps/.test(r.hw), side = new Map(), sk = (x, z) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    if (!minor) for (const r of t.chained) if (!(r.fl & 3) && !isTrail(r)) { const h = roadStyle(r.hw, r.ln, r.fl, r.wd).w / 2; for (const [x, z] of resample(r.pts.map(([la, lo]) => proj.xz(la, lo)), 4)) (side.get(sk(x, z)) ?? side.set(sk(x, z), []).get(sk(x, z))).push([x, z, h]); }
    const byRoad = (x, z) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [u, w, h] of side.get(`${Math.floor(x / 8) + a},${Math.floor(z / 8) + b}`) || []) if (Math.hypot(u - x, w - z) < h + 3) return true; return false; };
    // a road with no rail (a motorway and its ramps, a street past the rides' area) where it runs onto a railed one, a
    // node shared or not (OpenStreetMap draws a ramp's or a side road's end on top of the bigger road): one surface, its
    // ground (g at x, z) eased onto that road's rail within its paved width and back over 6 m, or 15 m a metre between them,
    // as the bake levels the railed roads' junctions; drawn under it (its lift); left where they are 1.2 m or more apart
    // (one over the other). hint: per rail the last segment (a Map per road)
    // (wider: only onto roads wider than that half width (a railed service way onto the road it leaves))
    const onto = (x, z, g, lift, hint, wider = -1) => {
      if (!RI || g == null) return g; let best = 0, dh = 0;
      for (const id of RI.near(x, z)) {
        const m = RI.rails[id]; if (m.r.fl & 3 || isTrail(m.r) || m.half < wider + 0.5) continue; const p = m.T.at(x, z, hint.get(id) ?? -1); if (!p) continue; hint.set(id, p.k);
        const d = p.h + Math.min(0, m.lift - lift - 0.02) - g, F = Math.min(25, Math.max(6, 15 * Math.abs(d))), o = Math.abs(p.d) - m.half, w0 = o <= 0 ? 1 : o >= F ? 0 : 1 - o / F;
        const w = w0 * w0 * (3 - 2 * w0) * Math.max(0, Math.min(1, (1.2 - Math.abs(d)) / 0.4)); if (w > best) { best = w; dh = d; }
      }
      return g + dh * best;
    };
    // a narrower way (a driveway, a service way, a lot's way in) stops at a wider railed road's paved edge, 0.2 m inside
    // it: OpenStreetMap runs it on to that road's centre line, where it lay across the paving (a slab over Bunker Road at
    // 1a_1030, Street View: a flush join at the edge); not where one is over the other (3 m apart or more)
    // (as wide: only a way's own end inside the other (a T junction: the side road stops at the edge, its centre line not
    // across the other's mouth, Street View Field Road 0a_0130))
    // (its own rail, the rail index's copy of the same way (another object), is not another road: a rail whose two ends are
    // both nodes of this way (OpenStreetMap's way, or one of those chained into it))
    const selfOf = new Map(), isSelf = (m, r) => { let S = selfOf.get(r); if (!S) { S = new Set(r.pts.map(([la, lo]) => { const [x, z] = proj.xz(la, lo); return `${Math.round(x * 2)},${Math.round(z * 2)}`; })); selfOf.set(r, S); }
      const k = q => `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`, P = m.T.P; return S.has(k(P[0])) && S.has(k(P.at(-1))); };
    const inRail = (x, z, r, half) => { const g0 = hAt(x, z); for (const id of RI.near(x, z)) { const m = RI.rails[id]; if (m.r === r || m.r.fl & 3 || isTrail(m.r) || m.half < half) continue; const p = m.T.at(x, z); if (!p || !(p.s > 0.5 && p.s < m.T.L - 0.5 && Math.abs(p.d) < m.half - 0.2 && (g0 == null || Math.abs(p.h - g0) < 3))) continue;
      if (isSelf(m, r)) continue;
      return true; } return false; };
    const offRails = (P, r, half) => {
      const E = [r.pts[0], r.pts.at(-1)].map(([la, lo]) => proj.xz(la, lo)), own = p => E.some(e => Math.hypot(e[0] - p[0], e[1] - p[1]) < 1);
      const tan = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }, tAt = k => tan(P[Math.max(0, k - 1)], P[Math.min(P.length - 1, k + 1)]);
      const wide = (x, z, t) => inRail(x, z, r, half + 0.5, t), same = (x, z, t) => inRail(x, z, r, half - 0.01, t), ins = P.map((p, k) => wide(p[0], p[1], tAt(k)));
      // (the end runs inside an as wide road where they are the way's own ends)
      for (const [a, d] of [[0, 1], [P.length - 1, -1]]) if (own(P[a])) for (let k = a; k >= 0 && k < P.length && same(P[k][0], P[k][1], tAt(k)); k += d) ins[k] = true;
      if (!ins.some(Boolean)) return [P];
      const inR = (x, z, t) => wide(x, z, t) || same(x, z, t);
      const edge = (a, b) => { const t = tan(a, b); let lo = 0, hi = 1; const ia = inR(...a, t); for (let k = 0; k < 12; k++) { const f = (lo + hi) / 2; if (inR(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t) === ia) lo = f; else hi = f; } const f = ia ? hi : lo; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; };
      // (a mouth's corners rounded only where it meets the other road across, 50 degrees or more: at a narrower angle (a slip
      // road joining) the rounding stood out past the other road's edge as a spike over the grass, East Road 0a_0130; the
      // gore between them is paved instead)
      const across = (a, b) => { const [tx, tz] = tan(a, b); for (const id of RI.near(b[0], b[1])) { const m = RI.rails[id]; if (m.r === r || m.r.fl & 3 || isTrail(m.r)) continue; const p = m.T.at(b[0], b[1]); if (!p || Math.abs(p.d) > m.half + 0.5) continue; const A = m.T.P[p.k], Bp = m.T.P[p.k + 1], l = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]) || 1; return Math.abs(((Bp[0] - A[0]) * tx + (Bp[1] - A[1]) * tz) / l) < 0.643 ? 1 : 0; } return 1; };
      const out = []; let cur = [];
      for (let k = 0; k < P.length; k++) {
        if (k && ins[k] !== ins[k - 1]) { const e = edge(P[k - 1], P[k]); if (ins[k]) { cur.push(e); cur.fe = across(P[k - 1], P[k]); cur.ne = !cur.fe; out.push(cur); cur = []; } else { cur.push(e); cur.fs = across(P[k], P[k - 1]); cur.ns = !cur.fs; } }
        if (!ins[k]) cur.push(P[k]);
      }
      out.push(cur);
      return out.filter(q => q.length > 1 && q.reduce((s, p, i) => i ? s + Math.hypot(p[0] - q[i - 1][0], p[1] - q[i - 1][1]) : 0, 0) > 1);
    };
    for (const [ri, r] of t.chained.entries()) {
      if (++nr % 6 === 0) yield;
      if (r.fl & 2) continue;                          // tunnels: under the hill
      if (minor && /path|footway|track|bridleway|service/.test(r.hw)) continue;
      const st = roadStyle(r.hw, r.ln, r.fl, r.wd), tr = !(r.fl & 1) && isTrail(r);
      // its rail (rail.js): the centre's height wherever the ribbon samples it (a deck over a tunnel is in it too)
      let rail = null; if (r.h) { const T = track(dense(r.pts).map(([la, lo]) => proj.xz(la, lo)), r.h); let hint = -1; rail = (x, z) => { const q = T.at(x, z, hint); hint = q?.k ?? -1; return q && q.h; }; }
      // (a road with a rail: its line the rail's own points, so the drawn top is the rail's line between them, the rider's)
      const all = rail ? dense(r.pts).map(([la, lo]) => proj.xz(la, lo)) : (r.fl & 1 ? (p => p) : roundCorners)(r.pts.map(([la, lo]) => proj.xz(la, lo))), runs = [[]];
      for (const p of tr && side.size ? resample(all, 3) : all) { if ((r.fl & 16 && marks.deckAt(p[0], p[1]) != null) || (tr && byRoad(p[0], p[1]))) { if (runs.at(-1).length) runs.push([]); } else runs.at(-1).push(p); }  // the bridge's own deck; a trail on a road's shoulder
      // (over a tunnel: a deck across the lidar's gap, straight between the ground at its ends)
      // (found on the whole way, not this tile's piece of it: a deck's ends may lie in the next tile; its line from the
      // lidar there, its piece in this tile on that line)
      const pieces = runs.flatMap(run => run.length < 2 ? [] : !tunnels.length || r.fl & 1 || tr ? [run] : splitOver(run, overTunnels(run, tunnels, 12, rawAt))).flatMap(run => {
        const line = run.over && [rawAt(...run[0]), rawAt(...run.at(-1))], L = run.reduce((s, p, i) => i ? s + Math.hypot(p[0] - run[i - 1][0], p[1] - run[i - 1][1]) : 0, 0);
        const deep = line && line[0] != null && line[1] != null && Math.min(...line) - Math.min(...resample(run, 2).map(p => rawAt(...p) ?? 1e9)) > 2.5;
        return clipLine(run, tbox).map(pts => { if (deep) { const f = p => arcAlong(run, p) / (L || 1); pts.line = [line[0] + (line[1] - line[0]) * f(pts[0]), line[0] + (line[1] - line[0]) * f(pts.at(-1))]; } return pts; });
      });
      const cutP = tr || !RI || r.fl & 19 ? pieces : pieces.flatMap(p => p.line ? [p] : offRails(p, r, st.w / 2)); if (cutP !== pieces) yield;
      for (const pts of cutP) {  // exactly this tile: the next one draws on from its edge
      if (pts.length < 2) continue;
      const dk = pts.line ?? (r.fl & 16 && r.dk ? [marks.deckLine(...pts[0]), marks.deckLine(...pts.at(-1))] : r.dk);  // the approaches meet the deck
      // a trail lies on the hillside (each edge on the ground); the ground goes under it only where it would cover it
      const trail = !dk && (st.surf === 2 || /path|footway|track|bridleway|steps/.test(r.hw));
      const lift = rail ? railLift(r) : trail ? 0.15 : roadLift(r.hw), hint = new Map(), hOn = rail || dk || trail ? hAt : (x, z) => onto(x, z, hAt(x, z), lift, hint);
      const mk = HM && !trail && st.lm ? (x, z, tx, tz) => markCode(HM.across(x, z, tx, tz)) : null;  // (the hand list's markings)
      // (a railed service way drawn eased onto the wider road it leaves, as an unrailed one: flush at its edge, Street View
      // Bunker Road 1a_1030; the rider's line is its rail all the same, a few centimetres off it within the paved width)
      const rl = rail && r.hw === 'service' ? (x, z) => onto(x, z, rail(x, z), lift, hint, st.w / 2) : rail;
      // (a side road cut at the other road's edge: its corners rounded there (curb returns), 5 m: NAIP, Field Road 0a_0130's
      // T junction, both corners about 4 to 6 m; Street View: a flared mouth. Not a service way's)
      const fl = r.hw === 'service' ? null : [...(pts.fs ? [[...pts[0], 5]] : []), ...(pts.fe ? [[...pts.at(-1), 5]] : [])];
      const i0 = B.idx.length, centre = ribbon(B, pts, { ...st, hAt: hOn, lift, deck: rail ? null : dk || null, rail: rl, step: minor ? 12 : trail ? 3 : 5, joints: t.joints.get(ri), drape: trail, mk, flares: fl });
      tops.push([i0, B.idx.length, trail]);
      for (let i = 1; i < centre.length; i++) { const a = centre[i - 1], b = centre[i]; surf.push(a[0], a[1], a[2], b[0], b[1], b[2], Math.max(a[3], b[3])); }
      if (!minor && !st.surf && !/path|footway|track|bridleway|cycleway|pedestrian/.test(r.hw) && centre.length > 1) lines.push({ P: centre, w: st.w, hw: r.hw, br: !!dk, lm: st.lm, b: st.b, park: !!(r.fl & 256), st });
      if (!minor && st.lm && st.lanes >= 2 && !st.surf && centre.length > 3) drive.push({ P: centre, w: st.w, lanes: st.lanes, one: !!(r.fl & 8), big: /motorway|trunk|primary/.test(r.hw) });
      if (dk) {
        const pl = deckSides(B, centre, st.w, 1.4, hAt); if (!pts.line) pillars.push(...pl);
        for (let i = 1; i < centre.length; i++) decks.push([centre[i - 1], centre[i], st.w / 2 + 0.6]);
      }
      if (!minor) centre.forEach((q, i) => { mark(q[0], q[2], q[3] + 1.2); lanes.push(q[0], q[2], q[3]); if (i) { const p = centre[i - 1]; mark((p[0] + q[0]) / 2, (p[2] + q[2]) / 2, q[3] + 1.2); } });
      // (the roads the rides can reach: their barriers and banks; any other road's banks too (a lot's way in, a fire road
      // at the top of Hawk Hill: no step down off its edge))
      if (!minor && !trail && !dk && centre.length > 1) sides.push({ C: centre, r, st, own: r.inW ??= r.pts.some(([la, lo]) => inWorld(la, lo)) });
      if (!minor && !trail && !dk && centre.length > 1 && !/service/.test(r.hw)) gends.push({ C: centre, r, lift, narrow: [!!pts.ns, !!pts.ne] });
      }
    }
    // (a point on another drawn road's paving: a side way's end)
    const onOther = (G, x, z) => gends.some(H => { if (H === G) return false; for (let i = 1; i < H.C.length; i++) { const a = H.C[i - 1], b = H.C[i], ex = b[0] - a[0], ez = b[2] - a[2], L2 = ex * ex + ez * ez, f = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[2]) * ez) / L2)) : 0; if (Math.hypot(x - a[0] - ex * f, z - a[2] - ez * f) < Math.max(a[3], b[3]) - 0.05) return true; } return false; });
    // the gore where two roads meet at a narrow angle (a slip road joining, a fork): paved between their facing edges
    // from the node back to where they are 8 m apart, 40 m at most (USDA NAIP, East Road 0a_0130: the slip road from
    // Alexander Avenue and East Road one paved triangle to their node; Street View: continuous asphalt, no grass between)
    // (by OpenStreetMap's node where two ways end: each's drawn piece with an end within 15 m of it (a side way may stop
    // inside the other's paving short of the node), its end the nearer one)
    const gnodes = new Map(); if (!minor) for (const [i, gE] of gends.entries()) for (const [la, lo] of [gE.r.pts[0], gE.r.pts.at(-1)]) { const k = `${la.toFixed(6)},${lo.toFixed(6)}`; (gnodes.get(k) ?? gnodes.set(k, []).get(k)).push(i); }
    for (const [nk0, list] of gnodes) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const A = gends[list[a]], Bw = gends[list[b]]; if (A.r === Bw.r) continue;
      const [nla, nlo] = nk0.split(',').map(Number), [nx0, nz0] = proj.xz(nla, nlo);
      const near0 = C => { const d0 = Math.hypot(C[0][0] - nx0, C[0][2] - nz0), d1 = Math.hypot(C.at(-1)[0] - nx0, C.at(-1)[2] - nz0); return d0 <= d1 ? [d0, 0] : [d1, 1]; };
      const [oa, ea] = near0(A.C), [ob, eb] = near0(Bw.C); if (oa > 15 || ob > 15) continue;
      const CA = ea ? A.C.slice().reverse() : A.C, CB = eb ? Bw.C.slice().reverse() : Bw.C;
      // (each's way out of the node over its first 8 m; the two within 35 degrees of each other)
      const dir = C => { let k = 1; while (k < C.length - 1 && Math.hypot(C[k][0] - C[0][0], C[k][2] - C[0][2]) < 8) k++; const l = Math.hypot(C[k][0] - C[0][0], C[k][2] - C[0][2]) || 1; return [(C[k][0] - C[0][0]) / l, (C[k][2] - C[0][2]) / l]; };
      const da = dir(CA), db = dir(CB); if (da[0] * db[0] + da[1] * db[1] < Math.cos(35 * Math.PI / 180)) continue;
      // (which edge of each faces the other: B lies left or right of A's way out)
      const bLeft = da[0] * db[1] - da[1] * db[0] < 0;  // (x east, z south: negative is to the left)
      // centre entries [x, y, z, half, right x, y, z, left x, y, z] as the ribbon ran; reversed, its right is its left
      const edgeA = q => (bLeft !== !!ea) ? [q[7], q[8], q[9]] : [q[4], q[5], q[6]], edgeB = q => (bLeft === !!eb) ? [q[7], q[8], q[9]] : [q[4], q[5], q[6]];
      const at0 = (C, d, f) => { let s = 0; for (let k = 1; k < C.length; k++) { const l = Math.hypot(C[k][0] - C[k - 1][0], C[k][2] - C[k - 1][2]); if (s + l >= d) { const u = (d - s) / (l || 1), p = f(C[k - 1]), q = f(C[k]); return p.map((v, i) => v + (q[i] - v) * u); } s += l; } return null; };
      const at = (C, d, f) => at0(C, Math.max(0, d - (C === CA ? oa : ob)), f);
      const LA = [], LB = [], d0 = Math.max(oa, ob);
      // (none where they run on side by side, 8 m apart or less, past 40 m: a divided road's median, not a gore; walked
      // from where both are drawn)
      let apart = false;
      for (let d = d0; d <= d0 + 40; d += 1.5) { const pa = at(CA, d, edgeA), pb = at(CB, d, edgeB); if (!pa || !pb) break; const gap = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]); LA.push(pa); LB.push(pb); if (gap > 8) { apart = true; break; } }
      if (LA.length < 3 || !apart) continue;
      const code = [0, 0, 0, 6, 0, 0, 0, 0], i0 = B.idx.length, P = B.pos;
      const up = (a, b, c) => { const ux = P[3 * b] - P[3 * a], uz = P[3 * b + 2] - P[3 * a + 2], wx = P[3 * c] - P[3 * a], wz = P[3 * c + 2] - P[3 * a + 2]; if (uz * wx - ux * wz > 0) B.tri(a, b, c); else B.tri(a, c, b); };
      const seg = (p, q, y, h = 1) => { surf.push(p[0], y, p[2], q[0], y, q[2], h); mark((p[0] + q[0]) / 2, (p[2] + q[2]) / 2, Math.hypot(p[0] - q[0], p[2] - q[2]) / 2 + h + 1.2); };
      for (let k = 0; k < LA.length; k++) {
        const pa = LA[k], pb = LB[k], y = Math.min(pa[1], pb[1]) - 0.02;
        B.v(pa[0], y, pa[2], 0.5, 0, code); B.v(pb[0], y, pb[2], 0.5, 0, code);
        if (k) { const v = B.n - 4; up(v, v + 2, v + 1); up(v + 1, v + 2, v + 3);
          // (its paving in the road index: along the middle as wide as it is, the banks, the grass and the scrub keep off)
          const m0 = LA[k - 1].map((v, i) => (v + LB[k - 1][i]) / 2), m1 = pa.map((v, i) => (v + pb[i]) / 2);
          seg(m0, m1, y, Math.max(Math.hypot(LA[k - 1][0] - LB[k - 1][0], LA[k - 1][2] - LB[k - 1][2]), Math.hypot(pa[0] - pb[0], pa[2] - pb[2])) / 2 + 0.1); }
      }
      tops.push([i0, B.idx.length, false]);
    }
    // a slip road's end cut at the other road's edge at a narrow angle (no rounded mouth there): its outer edge drawn on
    // until it meets the other road's edge, the corner its square end leaves paved (USDA NAIP, East Road 0a_0130: the slip
    // road from Alexander Avenue merges, its outer edge running into East Road's; Street View: no grass between them)
    if (!minor) for (const G of gends) for (const e of [0, 1]) {
      if (!G.narrow[e] || G.C.length < 2) continue;
      const q = e ? G.C.at(-1) : G.C[0], o = e ? G.C.at(-2) : G.C[1], l = Math.hypot(q[0] - o[0], q[2] - o[2]) || 1, fx = (q[0] - o[0]) / l, fz = (q[2] - o[2]) / l;
      // (its outer corner: the one further inside no other road; the ray on from it along the way)
      const cR = [q[4], q[5], q[6]], cL = [q[7], q[8], q[9]], inR = onOther(G, cR[0], cR[2]), inL = onOther(G, cL[0], cL[2]); if (inR === inL) continue;
      const out = inR ? cL : cR, inn = inR ? cR : cL;
      let best = null;
      for (const H of gends) { if (H === G) continue; for (const k of [4, 7]) for (let i = 1; i < H.C.length; i++) {
        const a = H.C[i - 1], b = H.C[i], ax = a[k], az = a[k + 2], ex = b[k] - ax, ez = b[k + 2] - az, den = fx * ez - fz * ex; if (Math.abs(den) < 1e-6) continue;
        const s = ((ax - out[0]) * ez - (az - out[2]) * ex) / den, u = ((ax - out[0]) * fz - (az - out[2]) * fx) / den;
        if (s > 0.2 && s < 15 && u >= 0 && u <= 1 && (!best || s < best[0])) best = [s, [ax + ex * u, a[k + 1] + (b[k + 1] - a[k + 1]) * u, az + ez * u]]; } }
      if (!best) continue;
      const hP = best[1], y = Math.min(out[1], inn[1], hP[1]) - 0.02, code = [0, 0, 0, 6, 0, 0, 0, 0], i0 = B.idx.length, P = B.pos;
      const a = B.v(inn[0], y, inn[2], 0.5, 0, code), b = B.v(out[0], y, out[2], 0.5, 0, code), c = B.v(hP[0], y, hP[2], 0.5, 0, code);
      { const ux = P[3 * b] - P[3 * a], uz = P[3 * b + 2] - P[3 * a + 2], wx = P[3 * c] - P[3 * a], wz = P[3 * c + 2] - P[3 * a + 2]; if (uz * wx - ux * wz > 0) B.tri(a, b, c); else B.tri(a, c, b); }
      for (const [p1, p2] of [[out, hP], [inn, hP], [inn, out]]) { surf.push(p1[0], y, p1[2], p2[0], y, p2[2], 0.8); mark((p1[0] + p2[0]) / 2, (p1[2] + p2[2]) / 2, Math.hypot(p1[0] - p2[0], p1[2] - p2[2]) / 2 + 2); }
      tops.push([i0, B.idx.length, false]);
    }
    // car parks (OpenStreetMap: the pullouts, vista points and lots by the roads): paved, on the ground, unmarked, a
    // little under the roads; on the ground as it is after the roads are pushed in (below: no step at their edges)
    // (and the pads veg.js has: the lots, gravel turnouts and dirt entrances Street View shows that OpenStreetMap lacks,
    // traced on NAIP; each drawn by the tile its middle is in, its surface the road shader's: 0 asphalt, 3 gravel, 4 dirt)
    const pads = (veg?.pads || []).filter(([, P]) => { const [x, z] = proj.xz(P.reduce((s, q) => s + q[0], 0) / P.length, P.reduce((s, q) => s + q[1], 0) / P.length); return x >= tbox[0] && x < tbox[2] && z >= tbox[1] && z < tbox[3]; });
    const lotRings = [];
    if (!minor) for (const [ring, surf, pad] of [...(t.lots || []).map(r => [r, 0, false]), ...pads.map(([sf, P]) => [P, sf, true])]) {
      const r = ring.map(([la, lo]) => proj.xz(la, lo)); if (r.length > 3 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]) r.pop();
      if (r.length < 3) continue;
      lotRings.push(r);
      // (a lot's paving under any road's top it reaches: never a step up onto it from the road)
      const code = [0, surf, 0, 60, 0, 0, 0, 0], i0 = B.idx.length, vx = (x, z) => { const h = (hAt(x, z) ?? hAt(Math.max(tbox[0], Math.min(tbox[2], x)), Math.max(tbox[1], Math.min(tbox[3], z))) ?? 0) + 0.2, t = RI?.top(x, z, h); return B.v(x, t != null ? Math.min(h, t - 0.04) : h, z, 0.5, 0, code); };
      const tri = (a, b, c, d = 0) => {  // split until no side is over 4 m (the paving follows the ground)
        const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]), L = Math.max(ab, bc, ca);
        if (L > 4 && d < 8) {
          const [p, q, o] = L === ab ? [a, b, c] : L === bc ? [b, c, a] : [c, a, b], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          tri(p, m, o, d + 1); tri(m, q, o, d + 1); return;
        }
        const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0, ia = vx(...a), ib = vx(...b), ic = vx(...c);
        if (up) B.tri(ia, ib, ic); else B.tri(ia, ic, ib);
        for (const p of [a, b, c]) mark(p[0], p[1], 2.2, 2);
      };
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(r.map(p => new THREE.Vector2(p[0], p[1])), [])) tri(r[a], r[b], r[c]);
      tops.push([i0, B.idx.length, pad ? 'pad' : 'lot']);
      if (B.idx.length - i0 > 600) yield;
    }
    for (const f of t.features) if (f.k === 'building') {
      const r = f.rings[0].map(([la, lo]) => proj.xz(la, lo)); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      if ((x1 - x0) * (z1 - z0) > 4000) continue;
      for (let x = x0; x <= x1; x += ow) for (let z = z0; z <= z1; z += oh) mark(x, z, 1.5, 2);
    }
    yield;
    // (a car park's or a pad's paving within 3 m of a road's edge eased up to it: flush at the edge, on the ground 3 m out
    // (Hawk Hill's gravel junction lay 0.6 m under the road's edge))
    const lotEase = (x, z, h) => { if (!RI) return 0; let up = 0; for (const id of RI.near(x, z)) { const m = RI.rails[id]; if (m.r.fl & 3 || isTrail(m.r)) continue; const p = m.T.at(x, z); if (!p) continue; const d = Math.max(0, Math.abs(p.d) - m.half); if (d > 3 || Math.abs(p.h + m.lift - h) > 2) continue; up = Math.max(up, (p.h + m.lift - 0.04 - (h + 0.04)) * (1 - d / 3)); } return up; };
    // the ground never over a road (lowered, the terrain mesh moved to match): its grid is coarser than a path is wide
    { const T = []; for (const [a, b, trail] of tops) if (trail !== true && trail !== 'pad') for (let k = a; k < b; k++) { const v = B.idx[k]; T.push(B.pos[3 * v], B.pos[3 * v + 1], B.pos[3 * v + 2]); }
      let moved = 0;
      if (T.length && g && !globalThis.__w3?.noPush) moved += yield* pushUnderSteps(g, T, { margin: Math.max(4, 0.75 * Math.abs(g.xs[1] - g.xs[0])) });
      if (moved) groundMoved(c);
      // the trails draped on the ground as it now is (after the roads' carve and push): every vertex 4 cm over it, the
      // ground never pushed under them (that left their edges over a trench)
      // (the car parks too: on the ground, under any road's top they reach)
      if (g) for (const [a, b, trail] of tops) if (trail) { if (b - a > 600) yield; for (let k = a; k < b; k++) { const v = B.idx[k], x = B.pos[3 * v], z = B.pos[3 * v + 2], h = gridHeight(g, x, z) ?? (trail !== true ? gridHeight(g, Math.max(tbox[0], Math.min(tbox[2], x)), Math.max(tbox[1], Math.min(tbox[3], z))) : null); if (h == null) continue; const lot = trail === 'lot' || trail === 'pad', rt = lot ? RI?.top(x, z, h) : null; B.pos[3 * v + 1] = rt != null ? rt - 0.04 : lot ? h + 0.04 + lotEase(x, z, h) : h + 0.04; } } }
    yield;
    // the road sides (banks.js) on the ground as it now is: embankments down to it, cut faces up the lidar's banks, the
    // barriers at the paved edge: on a surveyed road the hand list's (handlist.js, Street View), each its kind; elsewhere
    // OpenStreetMap's barrier=guard_rail ways (a W-beam: it maps them a few metres off, any within 6 m of an edge). None
    // guessed (a rail where the ground fell away was drawn where Street View has none). Gaps of up to three points
    // closed, runs under 6 m left out
    const rails = [], bk = { pos: [], cut: [], vg: [], idx: [], ends: [] }, bankRuns = [], bankH = new Map();
    if (c.lod === 0 && sides.length && ridden(g) && !globalThis.__w3?.noBanks) {  // (__w3.noBanks: profiling)
      const ground = (x, z) => gridHeight(g, x, z) ?? groundAt(x, z), raw = (x, z) => gridHeight(g, x, z, g.raw), n1 = g.segs + 1;
      const osm = new Map(), ok = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
      for (const line of t.rails || []) for (const [x, z] of resample(line.map(([la, lo]) => proj.xz(la, lo)), 2)) (osm.get(ok(x, z)) ?? osm.set(ok(x, z), []).get(ok(x, z))).push([x, z]);
      // (a mapped rail beside this edge: from a metre and a half inside it to 6 m out, within 4 m along)
      const osmNear = p => { for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const [u, w] of osm.get(`${Math.floor(p[0] / 4) + a},${Math.floor(p[2] / 4) + b}`) || []) { const o = (u - p[0]) * p[3] + (w - p[2]) * p[4], al = Math.abs((u - p[0]) * p[4] - (w - p[2]) * p[3]); if (o > -1.5 && o < 6 && al < 4) return true; } return false; };
      // no banks within 28 m of a tunnel's line (an underpass's portals, the headwalls, the road over it on its own fill
      // across the lidar's notch)
      const tl = tunnels.map(T => T.pts).filter(P => P.length > 1), tb = tl.map(P => P.reduce((b, [x, z]) => [Math.min(b[0], x - 28), Math.min(b[1], z - 28), Math.max(b[2], x + 28), Math.max(b[3], z + 28)], [Infinity, Infinity, -Infinity, -Infinity]));
      const byTunnel = p => tl.some((P, ti) => { const b = tb[ti]; if (p[0] < b[0] || p[0] > b[2] || p[2] < b[1] || p[2] > b[3]) return false; for (let k = 0; k + 1 < P.length; k++) { const a = P[k], b = P[k + 1], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, f = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[2] - a[1]) * ez) / L2)) : 0; if (Math.hypot(p[0] - a[0] - ex * f, p[2] - a[1] - ez * f) < 28) return true; } return false; });
      // (a point on any road's paved width here, within 1.5 m of its height)
      const SI = roadIndex(surf), onRoad = (x, z, y) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of SI.cells.get(`${Math.floor(x / 10) + a},${Math.floor(z / 10) + b}`) || []) {
        const S = SI.S, ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2)) : 0;
        if (Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t) < S[k + 6] && Math.abs(S[k + 1] + (S[k + 4] - S[k + 1]) * t - y) < 1.5) return true; } return false; };
      // (a strip ends short of any other road's paving within 8 m of this edge's height: a junction's other leg; not past a
      // way's end, where no paving is drawn)
      // (nor over a car park or a pad: it lies on the ground eased up to the road's edge within 3 m (A12: a strip up the
      // lidar's ground over the carve hid Mitchell Road's lot and Conzelman 0a_2030's turnout under grass))
      const inLot = (x, z) => lotRings.some(r => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; });
      const block = (x, z, ey) => { if (lotRings.length && inLot(x, z) && Math.abs((ground(x, z) ?? ey) - ey) < 3) return true; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of SI.cells.get(`${Math.floor(x / 10) + a},${Math.floor(z / 10) + b}`) || []) {
        const S = SI.S, ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, tu = L2 ? ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2 : 0, t = Math.max(0, Math.min(1, tu));
        if (tu > -0.05 && tu < 1.05 && Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t) < S[k + 6] && Math.abs(S[k + 1] + (S[k + 4] - S[k + 1]) * t - ey) < 8) return true; } return false; };
      // one edge's strips (banks.js): into the banks' geometry; nothing grows where a strip stands off the ground (grass,
      // scrub, trees would be buried in it or hang off it)
      const strips = function* (E, kinds, st) {
        const sr = yield* sideRunsSteps(E, kinds, ground, { verge: st.lm ? 0.8 : 0.4, raw, block }); bankGeometry(sr, bk); bk.ends.push([bk.pos.length / 3, bk.idx.length]); bankRuns.push(...sr); yield;
        // the strips' surface on a 1 m raster (the grass, the scrub and the trees stand on it, not on the ground under it;
        // none on a steep face: a negative height)
        for (const run of sr) for (let i = 1; i < run.length; i++) { const { p: pa, b: ba } = run[i - 1], { p: pb, b: bb } = run[i], L = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]), nu = Math.max(1, Math.ceil(L / 1.0));
          for (let k = 0; k < ba.length; k++) { const W = Math.max(ba[k][2] - ba[k][0], bb[k][2] - bb[k][0]), nv = Math.max(1, Math.ceil(W / 1.0));
            for (let u = 0; u <= nu; u++) for (let w = 0; w <= nv; w++) { const f = u / nu, e = w / nv, o = (ba[k][0] + (bb[k][0] - ba[k][0]) * f) * (1 - e) + (ba[k][2] + (bb[k][2] - ba[k][2]) * f) * e;
              const h = (ba[k][1] + (bb[k][1] - ba[k][1]) * f) * (1 - e) + (ba[k][3] + (bb[k][3] - ba[k][3]) * f) * e, x = pa[0] + (pb[0] - pa[0]) * f + (pa[3] + (pb[3] - pa[3]) * f) * o, z = pa[2] + (pb[2] - pa[2]) * f + (pa[4] + (pb[4] - pa[4]) * f) * o;
              const kk = bkey(x, z), old = bankH.get(kk); if (ba[k][4] || bb[k][4]) bankH.set(kk, -1e9); else if (old == null || (old > -1e8 && h > old)) bankH.set(kk, h); } }
          if (i % 8 === 0) yield; }
      };
      for (const { C, r, st, own } of sides) for (const sd of [1, -1]) {
        yield;
        // (none across another road's mouth: a side road, a lot's way in)
        const E = ribbonEdge(C, sd), half = st.w / 2, mouth = new Uint8Array(E.length), walled = new Uint8Array(E.length), curbed = new Uint8Array(E.length), kinds = E.map((p, i) => { if (onRoad(p[0] + p[3] * 0.6, p[2] + p[4] * 0.6, p[1])) { mouth[i] = 1; return []; } const h = HB?.at(p[0], p[2], half, C[i][0], C[i][2]) ?? []; return h.length || HB?.onSurveyed(p[0], p[2]) || !osmNear(p) ? h : ['wbeam']; }), railed = new Uint8Array(E.length);
        if (own) for (const kind of BARRIER) {
          // (a barrier stops at a junction's mouth: no gap closed across one, none where its own line is on the other
          // road's paving (Street View, Field Road 0a_0130: the cable fence ends at the side road's corner))
          const off = (p, o) => onRoad(p[0] + p[3] * o, p[2] + p[4] * o, p[1]);
          const want = kinds.map((k, i) => k.includes(kind.k) && !(kind.off > 0.3 && (off(E[i], kind.off) || off(E[i], kind.off + 0.5))));
          for (let i = 0; i < want.length; i++) if (!want[i]) { let j = i; while (j < want.length && !want[j]) j++; if (i > 0 && j < want.length && j - i <= 3 && !mouth.subarray(i, j).some(Boolean)) for (let k = i; k < j; k++) want[k] = true; i = j; }
          const runs = []; for (let i = 0; i < want.length; i++) if (want[i]) { let j = i; while (j + 1 < want.length && want[j + 1]) j++; runs.push([i, j]); i = j; }
          for (const [i0, i1] of runs) {
            const R = railLine(E, i0, i1, kind.off, kind.gap); if (!R || R.len < 6) continue;
            if (kind.wall) {  // (its top: the lidar's ground 1.2 m behind its line, over the edge; 3.5 m at most)
              R.wh = R.pts.map(([x, y, z, nx, nz]) => Math.min(3.5, (raw(x + nx * 1.2, z + nz * 1.2) ?? y) - y));
              if (!R.wh.some(h => h >= 0.3)) continue; for (let i = i0; i <= i1; i++) walled[i] = 1;
            }
            rails.push({ ...R, kind: kind.k }); if (kind.sh) for (let i = i0; i <= i1; i++) railed[i] = 1; if (kind.cb) for (let i = i0; i <= i1; i++) curbed[i] = 1;
          }
        }
        // (behind a retaining wall the bank rises from the wall's back, not from a verge before it)
        const K = sideKinds(E, ground, raw, i => railed[i] === 1 || curbed[i] === 1, byTunnel); K.forEach((k, i) => { if (walled[i] && k.kind === CUT) k.wall = true; if (curbed[i] && !railed[i]) k.curb = true; });
        yield* strips(E, K, st);
      }
      // a dead end's end across (a turnaround, a lot's way in that stops): its strip too (none where it runs on into
      // another road or on into the next tile)
      // (a dead end: the way's own last node (OpenStreetMap), which no other way shares; not where the drawn ribbon
      // stops short of it (a deck, a bore, the tile's edge) nor where the way goes on as another (its next way, a junction))
      let nodes = null; const nk = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
      const deadEnd = (r, x, z) => { const e = [r.pts[0], r.pts.at(-1)].map(([la, lo]) => proj.xz(la, lo)).find(([u, w]) => Math.hypot(u - x, w - z) < 2); if (!e) return false;
        if (!nodes) { nodes = new Map(); for (const r of t.chained) for (const [la, lo] of r.pts) { const [x, z] = proj.xz(la, lo); (nodes.get(nk(x, z)) ?? nodes.set(nk(x, z), []).get(nk(x, z))).push([x, z, r]); } }
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [u, w, r2] of nodes.get(`${Math.floor(e[0] / 4) + a},${Math.floor(e[1] / 4) + b}`) || []) if (r2 !== r && Math.hypot(u - e[0], w - e[1]) < 1.5) return false;
        return true; };
      for (const { C, st, r } of sides) for (const i of [0, C.length - 1]) {
        const q = C[i], o = C[i ? i - 1 : 1], dl = Math.hypot(q[0] - o[0], q[2] - o[2]) || 1, dx = (q[0] - o[0]) / dl, dz = (q[2] - o[2]) / dl;
        if (q[0] < tbox[0] + 1 || q[0] > tbox[2] - 1 || q[2] < tbox[1] + 1 || q[2] > tbox[3] - 1 || onRoad(q[0] + dx * 1.5, q[2] + dz * 1.5, q[1]) || !deadEnd(r, q[0], q[2])) continue;
        const n = Math.max(2, Math.ceil(2 * q[3]) + 1), E = [];
        for (let k = 0; k < n; k++) { const f = k / (n - 1); E.push([q[4] + (q[7] - q[4]) * f, q[5] + (q[8] - q[5]) * f, q[6] + (q[9] - q[6]) * f, dx, dz]); }
        yield* strips(E, sideKinds(E, ground, raw, () => false, byTunnel), st);
      }
    }
    c.rails = rails; c.bankRuns = bankRuns; c.bankH = bankH;  // (the runs: the seams check, debug().seamData)
    { const T = []; for (const [a, b, trail] of tops) if (trail === true) for (let k = a; k < b; k++) { const v = B.idx[k]; T.push(B.pos[3 * v], B.pos[3 * v + 1], B.pos[3 * v + 2]); } c.trailPts = T; }
    c.surf = roadIndex(surf); c.decks = decks; c.occ = { occ, ox, oz, ow, oh }; c.lanes = new Float32Array(lanes); c.drive = drive; c.lines = lines; if (c.lod === 0) { grass.invalidate(tileBox(c)); scrub.invalidate(tileBox(c)); }  // no grass or scrub on the roads
    if (!B.n) return setPart(c, 'roads', null);
    const d = B.done(), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); geo.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2));
    geo.setAttribute('rd', new THREE.BufferAttribute(d.code, 4)); geo.setAttribute('rd2', new THREE.BufferAttribute(d.code2, 4)); geo.setAttribute('rd3', new THREE.BufferAttribute(d.code3, 4)); geo.setIndex(new THREE.BufferAttribute(d.idx, 1)); geo.computeVertexNormals(); geo.computeBoundingSphere();
    const grp = new THREE.Group(), mesh = new THREE.Mesh(geo, mats.road); mesh.receiveShadow = c.lod === 0; grp.add(mesh);
    // the banks: the ground's own material and classes (the nearest grid point's), cut faces bare (cut bank class)
    if (bk.idx.length && c.mask) {
      const nv = bk.pos.length / 3, A = new Uint8Array(nv * 4), Bm = new Uint8Array(nv * 4), n1 = g.segs + 1;
      for (let i = 0; i < nv; i++) {
        const [fi, fj] = gridIJ(g, bk.pos[3 * i], bk.pos[3 * i + 2]), v = Math.max(0, Math.min(n1 - 1, Math.round(fj))) * n1 + Math.max(0, Math.min(n1 - 1, Math.round(fi)));
        for (let k = 0; k < 4; k++) { A[4 * i + k] = c.mask[8 * v + k]; Bm[4 * i + k] = c.mask[8 * v + 4 + k]; }
        Bm[4 * i] = bk.cut[i] === 1 ? 255 : 0; Bm[4 * i + 1] = 0;  // a steep face (cut), not rock
        if (bk.vg[i]) A[4 * i + 1] = 255;  // (the verge: grass (green))
      }
      // (in pieces of at most 65,536 vertices, a side's strips never split: 16-bit indices, and no one buffer of tens of
      // megabytes sent in one frame (a quarter-second hold on Bunker Road when a tile's banks were one mesh))
      const P32 = new Float32Array(bk.pos);
      for (let e = 0, v0 = 0, i0 = 0; e < bk.ends.length; e++) {
        const [v1, i1] = bk.ends[e]; if (e + 1 < bk.ends.length && bk.ends[e + 1][0] - v0 <= 65536) continue;
        if (i1 > i0) {
          const bg = new THREE.BufferGeometry(), ix = new (v1 - v0 > 65536 ? Uint32Array : Uint16Array)(i1 - i0); for (let k = i0; k < i1; k++) ix[k - i0] = bk.idx[k] - v0;
          bg.setAttribute('position', new THREE.BufferAttribute(P32.slice(3 * v0, 3 * v1), 3)); bg.setAttribute('mk', new THREE.BufferAttribute(A.slice(4 * v0, 4 * v1), 4, true)); bg.setAttribute('mk2', new THREE.BufferAttribute(Bm.slice(4 * v0, 4 * v1), 4, true));
          bg.setAttribute('cv', new THREE.BufferAttribute(new Float32Array(v1 - v0), 1)); bg.setIndex(new THREE.BufferAttribute(ix, 1)); bg.computeVertexNormals(); bg.computeBoundingSphere();
          // (drawn before the ground: the ground under a bank then costs the GPU nothing)
          const bm = new THREE.Mesh(bg, mats.terrain); bm.receiveShadow = true; bm.renderOrder = -1; grp.add(bm);
        }
        v0 = v1; i0 = i1;
      }
    }
    if (pillars.length) {
      const im = new THREE.InstancedMesh(pillarGeo, mats.pillar, pillars.length), m4 = new THREE.Matrix4();
      pillars.forEach(([x, z, top, bot], i) => im.setMatrixAt(i, m4.makeScale(1, top - bot, 1).setPosition(x, bot, z)));
      im.userData.shared = true; im.castShadow = true; grp.add(im);
    }
    setPart(c, 'roads', grp);
  }
  // within 12 m of the Golden Gate Bridge's deck (no tree grows through it)
  const nearDeck = (x, z) => { const la = proj.lat(z), lo = proj.lon(x); if (la < 37.80 || la > 37.835 || lo < -122.486 || lo > -122.47) return false; for (const [a, b] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]]) if (marks.deckAt(x + a, z + b) != null) return true; return false; };
  const occAt = (o, x, z) => { if (!o) return 0; const a = Math.floor((x - o.ox) / o.ow), b = Math.floor((z - o.oz) / o.oh); return a >= 0 && b >= 0 && a < OCC && b < OCC ? o.occ[b * OCC + a] : 0; };
  function* buildTrees(c) {
    const t = c.tile; if (!t || !c.grid) return setPart(c, 'trees', null);
    const share = QUALITY[q].trees, cap = CAP[c.lod] * share, g = c.grid, hAt = hOf(c), fine = c.lod === 0, box = tileBox(c);
    const out = {}; let n = 0, ferns = 0;
    // [x, y, z, scale, random, near only: a full model, no impostor] (on a road side's strip where one is, none on a steep face)
    const add = (sp, x, z, s, r, nearOnly = 0) => { if (x < box[0] || z < box[1] || x >= box[2] || z >= box[3]) return; const y0 = hAt(x, z), y = y0 == null ? null : standOn(c, x, z, y0); if (y == null || y < SEA + 0.3 || occAt(c.occ, x, z) || nearDeck(x, z)) return; (out[sp] ??= []).push([x, y - 0.3, z, s, r, nearOnly]); if (!nearOnly && sp !== 'fern') n++; };  // ferns and ring trees: not in the cap
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
    // a tree every 10 m or so, tall (the planted groves are 15 to 40 m)
    if (veg) { const st = 8.5, [s0, w0, n0, e0] = veg.box, bx0 = Math.max(box[0], proj.x(w0)), bx1 = Math.min(box[2], proj.x(e0)), bz0 = Math.max(box[1], proj.z(n0)), bz1 = Math.min(box[3], proj.z(s0));
      for (let x = Math.ceil(bx0 / st) * st; x < bx1; x += st) {
        if (Math.round(x / st) % 4 === 0) yield;
        for (let z = Math.ceil(bz0 / st) * st; z < bz1; z += st) {
          const ix = Math.round(x / st), iz = Math.round(z / st), px = x + (hash2(ix, iz + 3) - 0.5) * st * 0.8, pz = z + (hash2(iz + 5, ix) - 0.5) * st * 0.8, k = vcls(px, pz);
          if ((k !== CYPRESS && k !== EUC) || hash2(ix * 3, iz * 7) > 0.75) continue;
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
    const items = { tpost: [], cpost: [], spost: [], lamp: [], stop: [], limit: [], fence: [], picket: [], pole: [], delin: [], wdelin: [], stopbar: [], xwalk: [], xlines: [] }, wires = [];
    const hlTile = inHeadlands(proj.lat((tileBox(c)[1] + tileBox(c)[3]) / 2), proj.lon((tileBox(c)[0] + tileBox(c)[2]) / 2));
    const put = (k, x, y, z, yaw, sx = 1) => items[k].push([x, y, z, yaw, 1, sx]);
    // a spatial hash of the lines' points (10 m), to find the road a crossing or a stop sign is on
    const cell = new Map(), ck = (x, z) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
    c.lines.forEach((L, li) => L.P.forEach(p => { const k = ck(p[0], p[2]); (cell.get(k) ?? cell.set(k, []).get(k)).push(li); }));
    // the nearest point of a drawn road's centre to (x, z) within r metres: [point [x, y, z, half width, ...], its line,
    // its direction (dx, dz)], or null
    const nearLine = (x, z, r) => { let best = null, bd = r * r;
      for (let u = -1; u <= 1; u++) for (let w = -1; w <= 1; w++) for (const li of cell.get(`${Math.floor(x / 10) + u},${Math.floor(z / 10) + w}`) || []) {
        const Q = c.lines[li].P; for (let k = 0; k < Q.length; k++) { const d = (Q[k][0] - x) ** 2 + (Q[k][2] - z) ** 2; if (d < bd) { bd = d; const a = Q[Math.max(0, k - 1)], b = Q[Math.min(Q.length - 1, k + 1)]; best = [Q[k], c.lines[li], [b[0] - a[0], b[2] - a[2]]]; } }
      }
      return best; };
    // OpenStreetMap's marked crossings (only where it tags them marked, bake_world.mjs): across the road at its nearest
    // centre point (within 4 m), the bars along it (zebra, ladder) or two lines across (crossing:markings=lines), the
    // road's width
    for (const [la, lo, k] of t.xings || []) {
      const [x, z] = proj.xz(la, lo), hit = nearLine(x, z, 4); if (!hit) continue;
      const [q, L, d] = hit, w = 2 * (q[3] ?? L.w / 2);
      put(k ? 'xlines' : 'xwalk', q[0], q[1] + 0.03, q[2], Math.atan2(d[0], d[1]), k ? w : w / 7.2);
    }
    // OpenStreetMap's stop signs (highway=stop, bake_world.mjs: each way in [lat, lon, heading, set back]): the sign on
    // the right, the stop line across the lane in (a two way road's right half) at the node, or set back from a junction
    // the node is; no STOP legend (none tagged)
    for (const [la, lo, hd, back] of t.stops || []) {
      const r = hd * Math.PI / 180, fx = Math.sin(r), fz = -Math.cos(r), [x0, z0] = proj.xz(la, lo), x = x0 - fx * back, z = z0 - fz * back, hit = nearLine(x, z, 4); if (!hit) continue;
      const [q, L] = hit, half = q[3] ?? L.w / 2, nx = -fz, nz = fx, two = L.lm === 2, yaw = Math.atan2(-fx, -fz);
      { const sx = x + nx * (half + 0.8), sz = z + nz * (half + 0.8); put('stop', sx, Math.min(q[1] - 0.25, (hAt(sx, sz) ?? q[1]) - 0.1), sz, yaw); }  // (its foot in the ground: never over a fill's slope)
      put('stopbar', x + nx * (two ? half / 2 : 0), q[1] + 0.03, z + nz * (two ? half / 2 : 0), yaw, (two ? half : 2 * half) / 3.2);
    }
    for (const [li, L] of c.lines.entries()) {
      if (li % 4 === 3) yield;
      const P = L.P, n = P.length, hw = i => P[i][3] ?? L.w / 2, big = /motorway|trunk|primary|secondary|tertiary/.test(L.hw), small = /residential|unclassified|living|road|service/.test(L.hw);
      const dir = i => { const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
      let run = 0;
      for (let i = 0; i < n; i++) {
        const [dx, dz] = dir(i), nx = -dz, nz = dx, [x, y, z] = P[i], k = cls(x, z), road = y - 0.25, r = hash2(Math.round(x), Math.round(z)), half = hw(i);
        run += i ? Math.hypot(x - P[i - 1][0], z - P[i - 1][2]) : 0;
        // lamps along town streets every 32 m, sides in turn; a speed limit along the bigger roads now and then
        if (k === 3 && !L.br && run >= 32) { run = 0; const s = (i >> 2) % 2 ? 1 : -1; const lx = x + nx * s * (half + 0.9), lz = z + nz * s * (half + 0.9); put('lamp', lx, Math.min(road, (hAt(lx, lz) ?? road) - 0.1), lz, Math.atan2(nz * s, -nx * s)); }
        if (t.limits && big && !L.br && i % 90 === 45 && r < 0.6) { const lx = x + nx * (half + 1.3), lz = z + nz * (half + 1.3); put('limit', lx, Math.min(road, (hAt(lx, lz) ?? road) - 0.1), lz, Math.atan2(-dx, -dz)); }

        // fences: post and rail along farm roads, picket in front of the houses on town streets, in stretches
        if (i % 3 === 0 && !L.br && i + 1 < n && !hlTile) for (const s of [1, -1]) {  // (none in the Headlands, Street View)
          const blk = hash2(Math.floor(x / 40) + s * 7, Math.floor(z / 40));
          if (k === 2 && blk < 0.75) put('fence', x + nx * s * (half + 3), hAt(x + nx * s * (half + 3), z + nz * s * (half + 3)) ?? road, z + nz * s * (half + 3), Math.atan2(-dz, dx));
          else if (k === 3 && small && blk < 0.3) put('picket', x + nx * s * (half + 2.4), hAt(x + nx * s * (half + 2.4), z + nz * s * (half + 2.4)) ?? road, z + nz * s * (half + 2.4), Math.atan2(-dz, dx));
        }
      }
      // flexible posts in the middle of the buffer beside a bike lane against a oneway (upper Conzelman Road), every 9 m:
      // white or yellow where the hand list has them (handlist.js MARKINGS, Street View), none elsewhere
      if (L.lm === 4 && !L.br && HM) { let run2 = 4.5;
        for (let i = 1; i < n; i++) {
          run2 += Math.hypot(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]); if (run2 < 9) continue;
          const [dx, dz] = dir(i), k = HM.across(P[i][0], P[i][2], dx, dz).find(([k]) => k === 'wposts' || k === 'yposts'); if (!k) continue; run2 = 0;
          const o = hw(i) - (L.b - YB / 2) * hw(i) * 2 / L.w; put(k[0] === 'wposts' ? 'wdelin' : 'delin', P[i][0] + dz * o, P[i][1] - 0.25, P[i][2] - dx * o, 0);
        } }
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
    // the barriers' posts (buildRoads), each from 0.3 m into the ground under it (however far it falls away) to its top:
    // a W-beam's square dark timber posts, a cable fence's and a rail fence's timber posts, a concrete rail's blocks, a
    // chain-link fence's steel posts
    const POST = { wbeam: ['tpost', 0.8], cable: ['tpost', 1], fence: ['tpost', 1.15], beam: ['cpost', 0.62], chain: ['spost', 2.1] };
    for (const R of c.rails || []) { const P = POST[R.kind]; if (P) for (const [x, y, z, yaw] of R.posts) { const bot = Math.min(y, hAt(x, z) ?? y) - 0.3; items[P[0]].push([x, bot, z, yaw, y + P[1] - bot]); } }
    // (the feet of what stands on the ground: the seams check)
    c.feet = ['pole', 'stop', 'lamp', 'limit', 'tpost', 'cpost', 'spost'].flatMap(k => items[k].map(([x, y, z]) => [x, y, z, k]));
    yield;
    const grp = new THREE.Group(), m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
    // every kind in one batched draw
    const kinds = Object.keys(items).filter(k => items[k].length), count = kinds.reduce((n, k) => n + items[k].length, 0);
    if (count) {
      const bm = new THREE.BatchedMesh(count, kinds.reduce((n, k) => n + FURN[k].attributes.position.count, 0), 0, mats.furn);
      for (const k of kinds) { const gi = bm.addGeometry(FURN[k]); for (const [x, y, z, yaw, sy = 1, sx = 1] of items[k]) bm.setMatrixAt(bm.addInstance(gi), m4.compose(v.set(x, y, z), qq.setFromAxisAngle(up, yaw), sc.set(sx, sy, 1))); }
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
    // the barriers along their lines (buildRoads: banks.js railLine), each a cross-section swept along it ([height over the
    // road's edge, metres toward the road from the posts' line], closed where it is a solid): a galvanised W-beam 0.32 m
    // tall, its top 0.79 m up (Caltrans A77: 31 in), its two ridges toward the road; a white concrete beam on its blocks; a
    // K-rail (the New Jersey shape, 32 in tall, 24 in at its foot); a cable fence's wire, a rail fence's two rails, a
    // chain-link fence's top rail and its mesh (a see-through sheet)
    if (c.rails?.length) {
      const SEC = {
        wbeam: [mats.rail, [[0.47, 0.16], [0.54, 0.22], [0.63, 0.16], [0.72, 0.22], [0.79, 0.16]], false],
        beam: [mats.wcon, [[0.42, 0.18], [0.72, 0.18], [0.72, -0.12], [0.42, -0.12]], true],
        krail: [mats.wcon, [[-0.05, 0.31], [0.08, 0.31], [0.33, 0.19], [0.81, 0.08], [0.81, -0.08], [0.33, -0.19], [0.08, -0.31], [-0.05, -0.31]], true],
        cable: [mats.wire, [[0.86, 0.01], [0.88, 0.01], [0.88, -0.01], [0.86, -0.01]], true],
        fence: [mats.wood, [[0.45, 0.06], [0.6, 0.06], [0.6, -0.02], [0.45, -0.02]], true, [[0.95, 0.06], [1.1, 0.06], [1.1, -0.02], [0.95, -0.02]]],
        chain: [mats.wire, [[2.05, 0.03], [2.1, 0.03], [2.1, -0.03], [2.05, -0.03]], true],
        mesh: [mats.mesh, [[0.05, 0], [2.05, 0]], false],
        wall: [mats.portal, [], true],
        // (a curb's foot 0.45 m under the edge: in the ground however it falls behind it; its ends closed)
        curb: [mats.curb, [[-0.45, 0.075], [0.15, 0.075], [0.15, -0.075], [-0.45, -0.075]], true, null, true], red: [mats.redCurb, [[-0.45, 0.075], [0.15, 0.075], [0.15, -0.075], [-0.45, -0.075]], true, null, true],
      };
      const sweep = new Map(), add = (key, pts, S, closed, caps = false) => {
        const g = sweep.get(key) ?? sweep.set(key, { pos: [], idx: [] }).get(key), b0 = g.pos.length / 3, N = S.length;
        for (const [x, y, z, nx, nz] of pts) for (const [h, o] of S) g.pos.push(x - nx * o, y + h, z - nz * o);
        for (let k = 1; k < pts.length; k++) for (let m = 0; m < (closed ? N : N - 1); m++) { const a = b0 + N * (k - 1) + m, a1 = b0 + N * (k - 1) + (m + 1) % N; g.idx.push(a, a + N, a1, a1, a + N, a1 + N); }
        if (caps && N === 4) for (const k of [0, pts.length - 1]) { const a = b0 + N * k; g.idx.push(...(k ? [a, a + 1, a + 2, a, a + 2, a + 3] : [a, a + 2, a + 1, a, a + 3, a + 2])); }
      };
      // (a retaining wall: its top per point, its foot under the ground; cast concrete as the portals' (pl: along it, up it))
      for (const { pts, kind, wh } of c.rails) if (kind === 'wall') {
        const g = sweep.get('wall') ?? sweep.set('wall', { pos: [], idx: [], pl: [] }).get('wall'), b0 = g.pos.length / 3; let s = 0;
        pts.forEach(([x, y, z, nx, nz], k) => { const h = Math.max(0, wh[k]); if (k) s += Math.hypot(x - pts[k - 1][0], z - pts[k - 1][2]);
          for (const [hh, o] of [[-0.6, 0.125], [h, 0.125], [h, -0.125], [-0.6, -0.125]]) { g.pos.push(x - nx * o, y + hh, z - nz * o); g.pl.push(s + o, hh, 0); } });
        for (let k = 1; k < pts.length; k++) for (let m = 0; m < 4; m++) { const a = b0 + 4 * (k - 1) + m, a1 = b0 + 4 * (k - 1) + (m + 1) % 4; g.idx.push(a, a + 4, a1, a1, a + 4, a1 + 4); }
        for (const k of [0, pts.length - 1]) { const a = b0 + 4 * k; g.idx.push(...(k ? [a, a + 1, a + 2, a, a + 2, a + 3] : [a, a + 2, a + 1, a, a + 3, a + 2])); }  // its ends closed
      }
      for (const { pts, kind } of c.rails) { const S = SEC[kind]; if (!S || kind === 'wall') continue; add(kind, pts, S[1], S[2], S[4]); if (S[3]) add(kind, pts, S[3], true); if (kind === 'chain') add('mesh', pts, SEC.mesh[1], false); }
      for (const [key, { pos, idx, pl }] of sweep) {
        let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); if (pl) g.setAttribute('pl', new THREE.Float32BufferAttribute(pl, 3)); g.setIndex(idx);
        // (a curb's faces each lit flat: its face to the road a lit band below its top, not a dark line (A11's deep foot
        // smoothed the face's normals down toward its foot: Street View Center Road 0a_0030's raised curb read flush))
        if (key === 'curb' || key === 'red') g = g.toNonIndexed();
        g.computeVertexNormals(); g.computeBoundingSphere();
        const m = new THREE.Mesh(g, SEC[key][0]); m.castShadow = key !== 'mesh' && QUALITY[q].shadow > 0; m.receiveShadow = true; grp.add(m);
      }
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
      // (a height Street View shows, handlist.js BUILDINGS, where OpenStreetMap has none)
      const R0 = f.rings[0], hb = BUILDINGS.find(([la, lo]) => { let c = false; for (let i = 0, j = R0.length - 1; i < R0.length; j = i++) if ((R0[i][0] > la) !== (R0[j][0] > la) && lo < (R0[j][1] - R0[i][1]) * (la - R0[i][0]) / (R0[j][0] - R0[i][0]) + R0[i][1]) c = !c; return c; });
      list.push({ ring, base, h: (hb ? hb[2] : f.h || 6) + 0.1 * hash2(Math.round(ring[0][0]), 3), seed: Math.round(ring[0][0] * 13 + ring[0][1] * 7), fort: inHeadlands(...f.rings[0][0]) });
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
    // along the route, not in rings: a tile the course runs through first, sooner the sooner the rider gets there (a
    // tile 1.5 km on counts as one tile away), the rest by distance after them; in each the ground and the road before
    // anything else, the trees, buildings and furniture after every tile's ground and roads
    const rx = tileX(lon, NEAR_Z), ry = tileY(lat, NEAR_Z), route = routeTiles(), d0 = dShown;
    for (const c of near.values()) {
      if (c.tile === undefined) continue;
      const along = route?.get(c.k)?.find(D => D >= d0 - 60), dist = Math.hypot(c.x + 0.5 - rx, c.y + 0.5 - ry);
      const pri = (along != null ? Math.min(dist, Math.max(0, along - d0) / 1500) : dist + 1.5) + c.lod * 3;
      // (a new route, a U-turn: what is queued moves to its new place, nothing built or half built is dropped)
      if (route !== c.route) { c.route = route; for (const [s, o] of [['t', 0], ['r', 0.1], ['u', 0.15], ['b', 6.2 + c.lod], ['v', 6.3 + c.lod], ['f', 6.4 + c.lod]]) jobs.reprio(c.k + '|' + s, pri + o); }
      const ts = `${c.lod}|${q}`;
      if (c.sig.terrain !== ts) { c.sig.terrain = ts; jobs.add(c.k + '|t', pri, () => buildTerrain(c)); }
      const ds = `${ts}|${c.ver}`;
      const rs = ds + (RI ? '|r' : '') + (veg?.pads?.length ? '|p' : '');  // (the roads and their barriers again once the rails are in: junctions, the hand list)
      if (c.ver != null && c.sig.roads !== rs) { c.sig.roads = rs; jobs.add(c.k + '|r', pri + 0.1, () => buildRoads(c)); }
      if (c.ver != null && c.sig.trees !== ds) { c.sig.trees = ds; jobs.add(c.k + '|v', pri + 6.3 + c.lod, () => buildTrees(c)); }
      if (c.ver != null && c.sig.bldg !== ds) { c.sig.bldg = ds; jobs.add(c.k + '|b', pri + 6.2 + c.lod, () => buildBuildings(c)); }
      if (c.ver != null && c.sig.furn !== rs) { c.sig.furn = rs; jobs.add(c.k + '|f', pri + 6.4 + c.lod, () => buildFurniture(c)); }
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

  // the near tiles the course runs through: key -> the distances along it it is there (every 10 m), once per course
  function routeTiles() {
    if (!st?.P) return null; if (st.tiles) return st.tiles;
    const m = new Map(); st.P.forEach((p, i) => { const [tx, ty] = tileOf(p[0], p[1]), k = key(NEAR_Z, tx, ty); (m.get(k) ?? m.set(k, []).get(k)).push(st.D[i]); });
    return st.tiles = m;
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
  // the terrain mesh moved to its grid's heights (after the ground was lowered under roads)
  function groundMoved(c) {
    const g = c.grid; if (!g || !c.tmesh || !c.parts.terrain) return;
    // (its heights in place, only the stretch of vertices that moved sent to the GPU again: a whole new geometry (a near
    // tile's about 20 MB with its 32-bit index) held a frame a quarter of a second on Bunker Road when the tunnels' cuts
    // were pushed in after the ride began)
    const mesh = c.parts.terrain, geo = mesh.geometry, P = geo.attributes.position, A = P.array, { src, nv, skirt } = c.tmesh;
    let lo = -1, hi = -1;
    for (let i = 0; i < src.length; i++) { const y = g.hs[src[i]] - (i >= nv ? skirt : 0); if (A[3 * i + 1] !== y) { A[3 * i + 1] = y; if (lo < 0) lo = i; hi = i; } }
    if (lo < 0) return;
    P.clearUpdateRanges(); P.addUpdateRange(3 * lo, 3 * (hi - lo + 1)); P.needsUpdate = true; geo.computeBoundingSphere(); hz.touch();
  }
  // a tile's road tops for the rider: segments [x0, y0, z0, x1, y1, z1, half width] in 10 m cells
  function roadIndex(a) {
    const S = new Float32Array(a), cells = new Map(), at = (x, z) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
    for (let k = 0; k < S.length; k += 7) { const key = at((S[k] + S[k + 3]) / 2, (S[k + 2] + S[k + 5]) / 2); (cells.get(key) ?? cells.set(key, []).get(key)).push(k); }
    return { S, cells };
  }
  // the drawn road's top at a point (its centre line's height across it), null off the roads; where roads cross (one
  // over the other), the one nearest the height e if given, else the one whose centre is nearest
  function roadAt(x, z, e = null) {
    const [tx, ty] = tileOf(x, z), R = near.get(key(NEAR_Z, tx, ty))?.surf; if (!R) return null;
    const cx = Math.floor(x / 10), cz = Math.floor(z / 10), S = R.S; let best = null, bd = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of R.cells.get(`${cx + a},${cz + b}`) || []) {
      const ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2)) : 0;
      const d = Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t); if (d >= S[k + 6] + 0.3) continue;
      const h = S[k + 1] + (S[k + 4] - S[k + 1]) * t, m = e == null ? d : Math.abs(h - e) + d * 0.01; if (m < bd) { bd = m; best = h; }
    }
    return best;
  }
  // how far a point is outside the nearest drawn road's edge (negative: on it), null with no road within 10 m
  function roadGap(x, z) {
    const [tx, ty] = tileOf(x, z), R0 = near.get(key(NEAR_Z, tx, ty))?.surf; if (!R0) return null;
    // (and the next tile's roads within 6 m: a road drawn by it reaches over the tile's edge)
    const Rs = [R0]; for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) { const [ux, uy] = tileOf(x + dx, z + dz); if (ux !== tx || uy !== ty) { const R = near.get(key(NEAR_Z, ux, uy))?.surf; if (R && !Rs.includes(R)) Rs.push(R); } }
    const cx = Math.floor(x / 10), cz = Math.floor(z / 10); let best = null;
    for (const R of Rs) { const S = R.S;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of R.cells.get(`${cx + a},${cz + b}`) || []) {
      const ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2)) : 0;
      const g = Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t) - S[k + 6]; if (best == null || g < best) best = g;
    } }
    return best;
  }
  // how far right of the road's centre line a rider rides: about a metre in from the edge
  function keepRight(x, z) {
    const [tx, ty] = tileOf(x, z), L = near.get(key(NEAR_Z, tx, ty))?.lanes; if (!L) return side;
    let best = 1e9, half = null;
    for (let i = 0; i < L.length; i += 3) { const d = (L[i] - x) ** 2 + (L[i + 1] - z) ** 2; if (d < best) { best = d; half = L[i + 2]; } }
    return best < 64 && half != null ? Math.max(0, Math.min(6.5, half - 1.1)) : side;
  }
  // what grows stands on: a road side's strip where one is (banks.js; null on a steep face), else the ground
  const standOn = (c, x, z, h) => { const b = c.bankH?.size ? c.bankH.get(bkey(x, z)) : null; return b == null ? h : b < -1e8 ? null : Math.max(h, b); };
  // grass: clumps in cells round the camera (grass.js); the ground under a point: height, normal, class weights
  function groundSample(x, z) {
    const [tx, ty] = tileOf(x, z), c = near.get(key(NEAR_Z, tx, ty)); if (!c?.grid || !c.mask) return null;
    // (none in a road's coarse cells, a few metres past its edge: the frame time; its verge is drawn grass (banks.js), nor on
    // a car park or in a building)
    if (occAt(c.occ, x, z)) return { skip: true };
    const g = c.grid, n = g.segs + 1, [fi, fj] = gridIJ(g, x, z), i = Math.round(fi), j = Math.round(fj);
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    const v = j * n + i, h0 = gridHeight(g, x, z), mk = c.mask, N = c.nor; if (h0 == null || h0 < SEA + 0.3) return null;
    const h = standOn(c, x, z, h0); if (h == null) return { skip: true };
    if (onTunnel(x, z, h)) return { skip: true };
    if ((mk[8 * v + 4] > 100 && N[3 * v + 1] < 0.8) || mk[8 * v + 5] > 128 || mk[8 * v + 6] > 100) return { skip: true };
    if (mk[8 * v] > 120 && REDWOOD.value.some(b => x > b.x && x < b.z && z > b.y && z < b.w)) return { skip: true };  // no grass under the redwoods
    const vk = vcls(x, z); if (vk === CYPRESS || vk === EUC || vk === PAVED || (vk === SCRUB && hash2(Math.round(x * 7), Math.round(z * 7)) < 0.5 && (roadGap(x, z) ?? 9) > 3.5)) return { skip: true };  // under the groves and on the paving none; between the scrub's bushes some; the verges in full
    return { h, nx: N[3 * v], ny: N[3 * v + 1], nz: N[3 * v + 2], cv: c.cv[v], m: [mk[8 * v] / 255, mk[8 * v + 1] / 255, mk[8 * v + 2] / 255, mk[8 * v + 3] / 255] };
  }
  const grass = createGrass({ THREE, scene, mat: mats.grass, sample: groundSample });
  // the scrub's bushes stand on the ground: not on a road, in a building, a bore or on a steep bank cut for a road; clear of
  // a road's paved edge by their whole reach and low beside it (Street View user_conzelman_railbend: coyote brush 0.3 to
  // 1.5 m, low at the edge, nothing over the paving; A11's bushes from 1.6 m at full size hung over the road)
  function scrubGround(x, z, w = 1) {
    const [tx, ty] = tileOf(x, z), c = near.get(key(NEAR_Z, tx, ty)); if (!c?.grid || !c.mask || !c.occ) return null;
    const gap = roadGap(x, z) ?? 9; if (gap < 1) return { skip: true };
    if (occAt(c.occ, x, z) === 2) return { skip: true };  // (a car park, a building: the road itself by its gap above, not its coarse cells (bushes were cleared 5 m out, A11: Conzelman 0a_2030, 3a_0430))
    const g = c.grid, n = g.segs + 1, [fi, fj] = gridIJ(g, x, z), v = Math.round(fj) * n + Math.round(fi), h0 = gridHeight(g, x, z);
    if (h0 == null || !(v >= 0 && v < n * n)) return null;
    const h = standOn(c, x, z, h0); if (h == null) return { skip: true };
    if (onTunnel(x, z, h)) return { skip: true };
    // (the road cuts bare (Street View: red chert) where the lidar does not say what grows there; where it does, it decides
    // (cellBushes): Street View user_conzelman_railbend, the cut above the road under low scrub to the edge)
    if (h < SEA + 0.3 || (c.mask[8 * v + 4] > 100 && c.nor[3 * v + 1] < 0.9 && veg?.scrubH(proj.lat(z), proj.lon(x)) == null)) return { skip: true };
    // (the largest it may be: its leaves 0.25 m short of the paved edge, its top 0.5 m at a metre from it, 0.35 m more a
    // metre further out; the ground's slope a metre either way, for its lean and its foot)
    const reach = (gap - 0.25) / (REACH * w), top = (0.5 + 0.35 * (gap - 1)) / TOP;
    const hh = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => { const q = gridHeight(g, x + dx, z + dz), s = q == null ? null : standOn(c, x + dx, z + dz, q); return s ?? h; });
    const gx = Math.max(-1.5, Math.min(1.5, (hh[0] - hh[1]) / 2)), gz = Math.max(-1.5, Math.min(1.5, (hh[2] - hh[3]) / 2));
    return { h, reach, top, grad: [gx, gz] };
  }
  const scrub = createScrub({ THREE, scene, geos: scrubGeometries(), mat: mats.scrub, fade: scrubFade, cls: vcls, hgt: (x, z) => veg ? veg.scrubH(proj.lat(z), proj.lon(x)) : null, ground: scrubGround });

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
      const h0 = tunRail(...P[0]) ?? out(P[0], P[1]) ?? 0, h1 = tunRail(...P.at(-1)) ?? out(P.at(-1), P.at(-2)) ?? h0, L = D.at(-1) || 1;  // (the portals' heights: the rail's)
      // the floor along it: its rail where it has one (rail.js), else straight between the portals
      const Y = P.map((p, i) => tunRail(...p) ?? h0 + (h1 - h0) * D[i] / L);
      // one lane, both ways in turn (lanes=1, not a oneway: the Baker-Barry tunnel, Street View): the lane with an edge
      // line each side, a raised walk along its north wall, a narrow round-arched bore, its portals at the way's ends
      // (and a bike lane along its south wall, the walk's other side: Street View)
      const ns = P[Math.min(P.length - 1, (P.length >> 1) + 1)][0] - P[Math.max(0, (P.length >> 1) - 1)][0] < 0 ? 1 : -1;
      const one = oneLane(r), st = one ? { w: ONE_LANE, lm: 1, surf: 0, lanes: 1, a: ns > 0 ? 0.3 : 1.5, b: ns > 0 ? 1.5 : 0.3, pL: 0, pR: 0 } : roadStyle(r.hw, r.ln, r.fl, r.wd);
      // at grade (hardly any ground over it) or very short: ride it on the surface, no bore. Under a road or a little
      // ground (US-101 over Alexander Avenue and Bunker Road): an underpass, its headwalls right at its ends: a concrete
      // box with a flat roof, or a barrel arch (ARCHED). Deeper and longer: a bored tunnel, arched, lit, its portals at
      // the end of a cut.
      // (the cover: the most ground over its middle half; a short one under a motorway's fill has its ends carved down)
      // (or a road's deck over it: the lidar has a gap under an overpass)
      // (or a road's rail over it: the same at every quality, where the low one's grid is too coarse to keep a fill's top)
      let cover = 0, decked = false; for (let i = 0; i < P.length; i++) if (D[i] > L * 0.25 && D[i] < L * 0.75) { const f = h0 + (h1 - h0) * D[i] / L, g = groundAt(...P[i]) ?? 0, d = deckAt(...P[i]) ?? 0, o = roadTopOn(...P[i], f + 40) ?? 0; cover = Math.max(cover, g - f, d - f, o - f > 3 ? o - f - 0.3 : 0); decked ||= d - f > 3 && d > g; }
      if (cover < 3 || L < 18) { ribbon(B, P, { ...st, hAt: (x, z) => groundAt(x, z), rail: tunRail, lift: railLift(r), step: 6 }); continue; }
      const box = decked || cover < 8 || L < 3 * PORT, port = box ? 1.5 : one ? 2 : PORT, mid = P[P.length >> 1], arch = box && ARCHED.find(({ at: [la, lo] }) => Math.hypot(proj.x(lo) - mid[0], proj.z(la) - mid[1]) < 60);
      // (a point where the lining starts and ends: the headwalls there and the ground left out from there, not from the
      // next 6 m point on, where the road had gone down under the ground carved level at the portal)
      for (const d of [port - 0.5, L - port + 0.5]) { const i = D.findIndex(v => v >= d); if (i > 0 && D[i] - d > 0.3 && d - D[i - 1] > 0.3) { const f = (d - D[i - 1]) / (D[i] - D[i - 1]); P.splice(i, 0, [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f]); Y.splice(i, 0, Y[i - 1] + (Y[i] - Y[i - 1]) * f); D.splice(i, 0, d); } }
      // half width, the walls' height, the arch's rise over them (0: a flat roof)
      // (a box no taller than the road over it allows)
      const w = st.w / 2 + (one || arch ? 1 : 2), H = box ? (arch ? 1.4 : Math.max(3.2, Math.min(5.2, cover - 0.9))) : one ? 2 : 2.2, rise = box && !arch ? 0 : one || arch ? w : w * 0.75;
      // the bore as straight pieces of up to 40 m (for the ground to leave out): [x0, z0, x1, z1, floor0, floor1, half width, height]
      const segs = []; let i0 = P.findIndex((_, i) => D[i] >= port - 0.5);  // (the same points as the lining's rings, below)
      for (let i = i0 + 1; i0 >= 0 && i < P.length && D[i0] < L - port + 0.5; i++) if (D[i] - D[i0] >= 40 || i === P.length - 1 || D[i + 1] > L - port + 0.6) {
        segs.push([P[i0][0], P[i0][1], P[i][0], P[i][1], Y[i0], Y[i], w + 0.3, H + rise + 0.6]); i0 = i;
      }
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity; for (const [x, z] of P) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
      list.push({ P, D, Y, h0, h1, w, L, segs, cuts: [], port, box, lift: railLift(r), bb: [bx0 - w - 5, bz0 - w - 5, bx1 + w + 5, bz1 + w + 5] });
      const k0 = B.idx.length; ribbon(B, P, { ...st, hAt: () => 0, deck: [h0, h1], rail: (x, z) => tunRail(x, z), lift: railLift(r), step: 6 }); cuts.push([k0, B.idx.length, port, L]);  // (its top as its rail's: rail.js)
      // a ring: walls up to the arch (or the flat roof), and the floor under the road (closed, so nothing outside shows through)
      const SEG = 12, R = w, ring = [];
      if (!rise) ring.push([R, H], [-R, H]);
      else for (let k = 0; k <= SEG; k++) { const th = Math.PI * k / SEG; ring.push([Math.cos(th) * R, Math.sin(th) * rise + H]); }
      ring.unshift([R, -0.15]); ring.push([-R, -0.15], [R, -0.15]);
      const [PO, TL, IX] = box ? [posB, tlB, idxB] : [pos, tl, idx], keep = [], N = ring.length, base = PO.length / 3;  // an underpass: bare concrete
      for (let i = 0; i < P.length; i++) if (D[i] >= port - 0.5 && D[i] <= L - port + 0.5) keep.push(i);
      // the one-lane tunnel's walk on its north wall (the side its normal points north at the middle): a raised walk,
      // two pipes along the wall over it
      const wb = walk.pos.length / 3;
      const WALK = [[R - 1.0, -0.1], [R - 1.0, 0.22], [R, 0.22], ...[[0.95, 0.24], [1.5, 0.16]].flatMap(([py, pr]) => Array.from({ length: 7 }, (_, k) => [R - 0.05 - pr + Math.cos(k * Math.PI / 6 - Math.PI / 2) * pr, py + Math.sin(k * Math.PI / 6 - Math.PI / 2) * pr]))];
      keep.forEach((i, n) => {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l, y = Y[i];
        for (const [cx, cy] of ring) { PO.push(P[i][0] + nx * cx, y + cy, P[i][1] + nz * cx); TL.push(D[i], Math.max(0, cy) / (H + rise), cx / R); }
        // lamps every 9 m: high on both walls, or along the crown of a one-lane bore; and the light they put on the road
        if (!box && n && Math.floor(D[i] / 9) !== Math.floor(D[keep[n - 1]] / 9)) for (const s of one ? [0] : [-1, 1]) { const th = s ? (s > 0 ? 0.62 : Math.PI - 0.62) : Math.PI / 2; lamps.push([P[i][0] + nx * Math.cos(th) * R * 0.97, y + H + Math.sin(th) * rise * 0.97, P[i][1] + nz * Math.cos(th) * R * 0.97, Math.atan2(dx, dz), s]); }
        if (n) for (let k = 0; k < N - 1; k++) { const p0 = base + (n - 1) * N + k, p1 = base + n * N + k; IX.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }
        if (one) {
          for (const [cx, cy] of WALK) { walk.pos.push(P[i][0] + nx * cx * ns, y + cy, P[i][1] + nz * cx * ns); walk.col.push(...(cy < 0.3 ? [0.62, 0.6, 0.56] : [0.24, 0.24, 0.25])); }
          if (n) for (const [k0, k1] of [[0, 2], [3, 9], [10, 16]]) for (let k = k0; k < k1; k++) { const p0 = wb + (n - 1) * WALK.length + k, p1 = p0 + WALK.length; walk.idx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1); }
        }
        if (n === 0 || n === keep.length - 1) ports.push([P[i][0], y, P[i][1], Math.atan2(dx, dz), R, H, n === 0 ? -1 : 1, box, rise, arch, one, list.at(-1), n === 0 ? P[0] : P.at(-1)]);
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
    rg.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); rg.setAttribute('ruv', new THREE.BufferAttribute(d.uv, 2)); rg.setAttribute('rd', new THREE.BufferAttribute(d.code, 4)); rg.setAttribute('rd2', new THREE.BufferAttribute(d.code2, 4)); rg.setAttribute('rd3', new THREE.BufferAttribute(d.code3, 4));
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
      const lm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.14, 1.3), tunLampMat, lamps.length), m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion();
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
    for (const [x, y, z, yaw, R, H, dir, box, rise, arch, one, T, end] of ports) {
      if (arch || one) {
        // a flat headwall with a round-arched opening, a coping, wing walls splayed out from it and sloping down (Street
        // View: the Baker-Barry tunnel's portals, Bunker Road under US-101); at a one-lane tunnel a signal each side of
        // the opening, on the wall
        const top = H + rise + 2.2, half = R + 2.6, ry = yaw + (dir > 0 ? Math.PI : 0), sh = new THREE.Shape(); sh.moveTo(-half, -1); sh.lineTo(half, -1); sh.lineTo(half, top); sh.lineTo(-half, top); sh.lineTo(-half, -1);
        const hole = new THREE.Path(); hole.moveTo(-R, -0.5); hole.lineTo(R, -0.5); hole.lineTo(R, H);
        for (let k = 1; k <= 16; k++) { const th = Math.PI * k / 16; hole.lineTo(Math.cos(th) * R, H + Math.sin(th) * rise); }
        hole.lineTo(-R, -0.5); sh.holes.push(hole);
        const parts = [new THREE.ExtrudeGeometry(sh, { depth: 0.8, bevelEnabled: false }).translate(0, 0, -0.8), new THREE.BoxGeometry(2 * half + 0.5, 0.35, 1.1).translate(0, top + 0.15, -0.4)];
        // (a one-lane tunnel's wings long and close along its way in: the retaining walls of its cut, the road between them)
        if (one) for (const s of [-1, 1]) {
          const wl = 17, wa = 0.22, ws = new THREE.Shape(); ws.moveTo(0, -1); ws.lineTo(wl, -1); ws.lineTo(wl, 0.9); ws.lineTo(0, top - 0.4); ws.lineTo(0, -1);
          parts.push(new THREE.ExtrudeGeometry(ws, { depth: 0.6, bevelEnabled: false }).translate(0, 0, -0.3).rotateY(Math.atan2(Math.cos(wa), s * Math.sin(wa))).translate(s * (half - 0.3), 0, -0.8));
        }
        // (an arch's wing walls as measured (ARCHED), from the opening's sides out along the way; a floor between each and
        // the road's middle, the ground over it left out (BORES))
        const spec = !one && arch?.walls.find(([[la, lo]]) => Math.hypot(proj.x(lo) - end[0], proj.z(la) - end[1]) < 8);
        if (spec) {
          const ry = yaw + (dir > 0 ? Math.PI : 0), cs = Math.cos(ry), sn = Math.sin(ry), W = (lx, lz) => [x + lx * cs + lz * sn, z - lx * sn + lz * cs];
          // (the floor's height out along the way: the road's rail there, as far over the portal's as its top is)
          const t0 = roadTopOn(x, z, y + 0.3), fl = s => { const [px, pz] = W(0, -0.8 - s), t = roadTopOn(px, pz, y + 0.3); return t0 != null && t != null ? y + t - t0 : y; };
          for (const [k, [wl, wa, he]] of [[1, spec[1]], [-1, spec[2]]]) {
            const x0 = k * (R + 0.3), n = Math.max(2, Math.ceil(wl)), ws = new THREE.Shape(), tops = [], te = Math.min(top - 0.4, fl(wl) - y + he);
            for (let j = 0; j <= n; j++) tops.push([wl * j / n, top - 0.4 + (te - top + 0.4) * j / n]);
            ws.moveTo(0, -1); ws.lineTo(wl, fl(wl) - y - 1); for (let j = n; j >= 0; j--) ws.lineTo(...tops[j]); ws.lineTo(0, -1);
            parts.push(new THREE.ExtrudeGeometry(ws, { depth: 0.6, bevelEnabled: false }).translate(0, 0, -0.3).rotateY(Math.atan2(Math.cos(wa), k * Math.sin(wa))).translate(x0, 0, -0.8));
            const fg = new THREE.BufferGeometry(), fp = [];
            for (let j = 0; j < n; j++) {
              const s0 = wl * j / n, s1 = wl * (j + 1) / n, o0 = x0 + k * s0 * Math.sin(wa), o1 = x0 + k * s1 * Math.sin(wa), y0 = fl(s0) - y + 0.15, y1 = fl(s1) - y + 0.15, z0 = -0.8 - s0 * Math.cos(wa), z1 = -0.8 - s1 * Math.cos(wa);
              const q = [[0, y0, z0], [o0, y0, z0], [0, y1, z1], [o1, y1, z1]]; for (const t of k > 0 ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]) fp.push(...q[t]);
            }
            fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3)); parts.push(fg);
            // (the ground left out from the road's middle to the wall, over the floor: [x0, z0, x1, z1, floor + 2 at each end
            // (the test leaves out the ground from 2 m under it), half width, height])
            const om = (x0 + k * wl / 2 * Math.sin(wa)) / 2, [ax, az] = W(om, -0.8), [bx, bz] = W(om, -0.8 - wl * Math.cos(wa));
            T.cuts.push([ax, az, bx, bz, y + 0.12 + 2, fl(wl) + 0.12 + 2, Math.abs(om) + 0.25, 60]);
          }
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
    grass.invalidate(); scrub.invalidate();  // (none in the bores and their cuts: onTunnel)
  }
  // is ground at height h on a tunnel's way at its floor's level (its open cuts, its portals): nothing grows there
  function onTunnel(x, z, h) {
    for (const T of tun.list) {
      // (and 18 m out from each portal along its line, between its wing walls: the road's cut, kept clear)
      const { P, bb } = T, n = P.length;
      for (const [e, f, y] of [[P[0], P[1], T.Y[0]], [P[n - 1], P[n - 2], T.Y[n - 1]]]) {
        const ux = e[0] - f[0], uz = e[1] - f[1], ul = Math.hypot(ux, uz) || 1, s = ((x - e[0]) * ux + (z - e[1]) * uz) / ul;
        if (s >= 0 && s <= 18 && Math.abs((x - e[0]) * uz - (z - e[1]) * ux) / ul < T.w + 3 && Math.abs(h - y) < 4) return true;
      }
      if (x < bb[0] || z < bb[1] || x > bb[2] || z > bb[3]) continue;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)) : 0;
        if (Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t) < T.w + 1.5 && Math.abs(h - (T.Y[i - 1] + (T.Y[i] - T.Y[i - 1]) * t)) < 7) return true;
      }
    }
    return false;
  }
  // the tunnel a point is in: { y, k } (k: how far in, 0 at a portal .. 1 from 25 m in), null outside; h: the point's
  // height if known (well over a bore it is on a road over the tunnel, not in it)
  function tunnelAt(x, z, h = null) {
    for (const T of tun.list) {
      const { P, D, bb } = T; if (x < bb[0] || z < bb[1] || x > bb[2] || z > bb[3]) continue;
      // (the nearest point on its line, not the first within reach: on a long bore that one lies metres back up its grade)
      let best = null;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)) : 0, e = Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
        if (e < T.w + 5 && (!best || e < best.e)) best = { e, i, t, a, ex, ez };
      }
      if (!best) continue;
      const { i, t, a, ex, ez } = best, d = D[i - 1] + (D[i] - D[i - 1]) * t; if (d < T.port - 1 || d > T.L - T.port + 1) return null;
      const y = T.Y[i - 1] + (T.Y[i] - T.Y[i - 1]) * t; if (h != null && h > y + 4.5) continue;  // on the road over it, not in it
      return { y, top: y + T.lift, k: Math.max(0, Math.min(T.box ? 0.35 : 1, Math.min(d - T.port, T.L - T.port - d) / 25)), x: a[0] + ex * t, z: a[1] + ez * t };
    }
    return null;
  }

  // spot checks (svcompare --aerial): the drawn roads within r metres of (x, z): their edges, the lines painted on them
  // and the rails, as [kind, [[lat, lon], ...]]
  function nearLines(x, z, r) {
    const out = [], ll = (px, pz) => [+proj.lat(pz).toFixed(7), +proj.lon(px).toFixed(7)], inR = q => Math.hypot(q[0] - x, q[2] - z) < r;
    for (const c of near.values()) {
      for (const L of c.lines || []) {
        const P = L.P.filter(inR); if (P.length < 2) continue;
        out.push(['edge', P.map(q => ll(q[4], q[6]))], ['edge', P.map(q => ll(q[7], q[9]))]);
        const st = L.st || {}, at = (q, rr) => { const W = Math.hypot(q[7] - q[4], q[9] - q[6]) || 1, f = rr / W; return ll(q[4] + (q[7] - q[4]) * f, q[6] + (q[9] - q[6]) * f); };
        const W0 = st.w || L.w, paint = [];
        if (st.lm >= 1) paint.push(['white', st.a > 0.5 ? st.a : 0.3], [st.lm === 3 ? 'yellow' : 'white', W0 - (st.b > 0.5 ? st.b : 0.3)]);
        if (st.pR > 0.5) paint.push(['white', st.pR]);
        if (st.lm === 2) paint.push(['yellow', (st.a + W0 - st.b) / 2]);
        if (st.lm === 4) paint.push(['yellow', W0 - st.b + 0.25]);
        for (const [k, rr] of paint) out.push([k, P.map(q => at(q, rr * Math.hypot(q[7] - q[4], q[9] - q[6]) / W0))]);
      }
      for (const R of c.rails || []) { const P = R.pts.filter(inR); if (P.length > 1) out.push(['rail', P.map(q => ll(q[0], q[2]))]); }
    }
    return { lines: out };
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
    let n = 0; for (let k = 0; k < 16; k++) { const a = k * 0.785 + (k > 7 ? 0.39 : 0), r = k > 7 ? 700 : 250, h = groundAt(x + Math.cos(a) * r, z + Math.sin(a) * r); if (h == null || h < SEA - 0.5) n++; }
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
      s.P = pts; s.D = D.map(d => d * k); s.ri = null; s.tiles = null;
      // (the points it shares with the course before it keep their rails: re-matched from a few before the change)
      if (st?.ri && st.ll) { let j = 0; const m = Math.min(st.ll.length, s.ll.length); while (j < m && st.ll[j] === s.ll[j]) j++; s.old = j > 3 ? [st.ri, j - 3] : null; }
      poke();
    } else { s.P = st.P; s.D = st.D; s.ri = st.ri; s.tiles = st.tiles; }
    if (reset) { dShown = s.d; camYaw = null; camInit = false; }
    st = s; dAt = s.d; tAt = performance.now();
  }
  function at(d) {
    const { P, D } = st; if (d <= 0) return P[0]; if (d >= D.at(-1)) return P.at(-1);
    let a = 0, b = D.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (D[m] < d) a = m; else b = m; }
    const f = D[b] > D[a] ? (d - D[a]) / (D[b] - D[a]) : 0; return [P[a][0] + (P[b][0] - P[a][0]) * f, P[a][1] + (P[b][1] - P[a][1]) * f];
  }
  // the course's profile (rail.js): each point's rail, matched once (a course or the rails arriving)
  function profile() { if (st && !st.ri && RI && st.P) { st.ri = profileOf(RI, st.P, st.ele?.length === st.P.length ? st.ele : null, ...(st.old || [])); st.old = null; } return st?.ri; }
  // the course point index before d and how far on to the next
  function seg(d) { const D = st.D; if (d <= 0) return [0, 0]; if (d >= D.at(-1)) return [D.length - 1, 0]; let a = 0, b = D.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (D[m] < d) a = m; else b = m; } return [a, D[b] > D[a] ? (d - D[a]) / (D[b] - D[a]) : 0]; }
  // the drawn road's top under the course at d (its rail plus lift), null with no rail there; profHit: with the rail's line
  function profHit(d) { const pr = profile(); if (!pr) return null; const [i, f] = seg(d); return profileAt(RI, pr, i, f); }
  const profY = d => profHit(d)?.y ?? null;
  // where across the road the rider rides at d: right of the course's line, metres (rail.js laneOf), null with no rail
  function laneAt(d) { const pr = profile(); if (!pr) return null; const [i, f] = seg(d), a = pr.ri[i], b = pr.ri[Math.min(pr.ri.length - 1, i + 1)]; if (a < 0 && b < 0) return null; return a < 0 ? pr.lane[i + 1] : b < 0 ? pr.lane[i] : pr.lane[i] + (pr.lane[i + 1] - pr.lane[i]) * f; }
  const eleAt = d => { if (!st.ele?.length) return null; const i = d / 10, a = Math.max(0, Math.min(st.ele.length - 1, Math.floor(i))), b = Math.min(st.ele.length - 1, a + 1); return st.ele[a] + (st.ele[b] - st.ele[a]) * (i - a); };
  // the surface the rider is on: of what is drawn there (a deck, a bore, a road's top, the ground) the one nearest the course's own
  // height, so a road under a bridge stays under it and the bridge's course stays on the deck; never under the ground
  // (but in a bore), and floating on the course's height rather than sunk when nothing drawn is near it (a deck not
  // built yet). Others (no course height): a deck, else a bore, else the ground.
  // On the rails (rail.js): the rider is on the Golden Gate Bridge's deck, else on the course's profile (its rail at d: a
  // tunnel's floor, a deck over an underpass, a road's top), however much of the world has loaded and at any quality.
  // Others (no course distance): the deck, else the rails' top nearest the height e. Off every rail (beyond the rides'
  // area) what is drawn there, yDrawn.
  function yAt(x, z, d, e = null) {
    // (the deck only for a course on it: Fort Baker's roads run under its north end)
    const k = marks.deckAt(x, z), ce = d != null ? eleAt(d) : e; if (k != null && (ce == null || Math.abs(ce - k) < 8)) return k;
    if (d != null) { const y = profY(d); if (y != null) return Math.max(y, RI.topMax(x, z, y) ?? y) + TYRE; }
    else if (RI) { const y = RI.top(x, z, e); if (y != null) return y; }
    return yDrawn(x, z, d);
  }
  function yDrawn(x, z, d) {
    const e = d == null ? null : eleAt(d), k = deckAt(x, z), tn = tunnelAt(x, z, e), b = tn ? tn.y + 0.05 : null;
    // on a drawn road: its top, never the ground under it (the ground is lowered under every road, by up to a couple of
    // metres on a steep one, and a road over an underpass stands well above the ground cut down for the way under it)
    const g0 = groundAt(x, z), rd = g0 == null ? null : roadAt(x, z, e), g = rd ?? g0;
    if (e == null) return k ?? b ?? g ?? 0;
    let best = null; for (const h of [k, b, g]) if (h != null && (best == null || Math.abs(h - e) < Math.abs(best - e))) best = h;
    if (best == null) return e;
    if (best < e - 6 && best === g && rd == null) return e;  // the ground well under the course with nothing drawn near it
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
      const y = e.y = yAt(ox, oz, null, e.y ?? null);
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
  // trees with their colours, in the light and in the shadow map, signals): drawn far under the ground, so every variant
  // the passes need is built while the world loads; kept (a program nothing uses any more is deleted, and built again,
  // a quarter of a second, when a part of the world needs it next)
  const warm = new THREE.Group(); warm.userData.frames = 0; scene.add(warm);
  { const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const under = new THREE.Matrix4().makeTranslation(0, -900, 0);
    for (const [m, depth, colour = true] of [[lampPoolMat, null, false], [mats.scrub, mats.scrub.userData.depth], [mats.prop, mats.prop.userData.depth], [mats.furn], [mats.furn, null, false], [mats.pillar, null, false], [tunLampMat, null, false]]) {
      const im = new THREE.InstancedMesh(geo, m, 1); im.setMatrixAt(0, under); if (colour) im.setColorAt(0, new THREE.Color(1, 1, 1));
      im.frustumCulled = false; im.castShadow = !!depth || m === mats.pillar; im.receiveShadow = true; if (depth) im.customDepthMaterial = depth; warm.add(im);
    }
    // the tunnels' parts (a tile with a tunnel may first load mid-ride), roads, buildings, rails as they are drawn
    for (const [m, cast, receive] of [[mats.underpass, false, true], [mats.tunnel, false, false], [mats.portal, true, true], [mats.walk, false, true], [mats.road, false, false], [mats.road, false, true], [mats.bldg, true, true], [mats.bldg, false, false], [mats.rail, true, true], [mats.curb, false, true]]) {
      const o = new THREE.Mesh(geo, m); o.applyMatrix4(under); o.frustumCulled = false; o.castShadow = cast; o.receiveShadow = receive; warm.add(o);
    }
    // shadow casters of every kind the world adds later (their shadow map programs): batched, instanced with colours
    { const bm = new THREE.BatchedMesh(1, 64, 64, mats.furn); bm.setMatrixAt(bm.addInstance(bm.addGeometry(geo)), under); bm.frustumCulled = false; bm.castShadow = bm.receiveShadow = true; warm.add(bm);
      for (const side of [THREE.FrontSide, THREE.DoubleSide]) { const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ side }), 1); im.setMatrixAt(0, under); im.setColorAt(0, new THREE.Color(1, 1, 1)); im.frustumCulled = false; im.castShadow = im.receiveShadow = true; im.userData.ownMat = true; warm.add(im); } }
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
      if (!resize() || !st?.P || document.hidden) { audio.hush(); raf = requestAnimationFrame(frame); return; }  // not drawn: no sound
      // the rider: where the engine said plus speed since, eased so updates never jump
      const v = st.v || 0, target = Math.min(dAt + v * Math.min(2, (now - tAt) / 1000), st.D.at(-1));
      dShown += (target - dShown) * Math.min(1, dt * 2.5) + (Math.abs(target - dShown) < 30 ? v * dt * 0.0 : 0);
      if (Math.abs(target - dShown) > 60) dShown = target;
      const d = Math.max(0, dShown), p0 = at(d), pa = at(d - 2), pb = at(d + 3);
      { const hx = pb[0] - pa[0], hz = pb[1] - pa[1], L = Math.hypot(hx, hz) || 1; side += ((laneAt(d) ?? keepRight(p0[0], p0[1])) - side) * Math.min(1, dt * 1.5); rx = -hz / L; rz = hx / L; }
      // (on a rail: across from its line, not the course's, which OpenStreetMap may have a metre or two off)
      const ph = profHit(d), base = ph ? [ph.x, ph.z] : p0;
      // (across the rail's own line, its right as the rider goes)
      if (ph) { const sg = ph.tx * (pb[0] - pa[0]) + ph.tz * (pb[1] - pa[1]) < 0 ? -1 : 1; rx = -ph.tz * sg; rz = ph.tx * sg; }
      let p = [base[0] + rx * side, base[1] + rz * side];
      // on the Golden Gate Bridge's sidewalks: round the outside of the tower legs (OpenStreetMap's way cuts their corners)
      if (marks.ggb) { const k = onDeck(proj.lat(p[1]), proj.lon(p[0])), ds = k ? Math.abs(Math.abs(k.s) - GGB.towers) : 99;
        if (ds < 16 && Math.abs(k.t) > 7 && Math.abs(k.t) < 21.2) { const f = Math.min(1, (16 - ds) / 6), q = marks.lane(k.s, k.t + (Math.sign(k.t) * 21.2 - k.t) * f); p = [q.x, q.z]; } }
      // in a tunnel: on the bore's own line (the course can run a few metres off it), eased in from the portal
      { const tn = tunnelAt(p[0], p[1], eleAt(d)); if (tn) { const k = tn.k * tn.k * (3 - 2 * tn.k), sx = tn.x + rx * 1.4, sz = tn.z + rz * 1.4; p = [p[0] + (sx - p[0]) * k, p[1] + (sz - p[1]) * k]; } }
      if (veilP && Math.hypot(p[0] - veilP[0], p[1] - veilP[1]) > 150) { veilAt = now; veil.style.transition = 'none'; veil.style.opacity = '1'; }  // a jump: cover it again
      veilP = p;
      // (lifted when the rider's profile and the spawn tile's data are here: the rider is on the rail from the first frame)
      const onRail = profY(d) != null, spawn = onRail && near.get(key(NEAR_Z, ...tileOf(p[0], p[1])))?.tile !== undefined;
      if (veilAt && (((onRail ? spawn : ready) && now - veilAt > 600) || now - veilAt > 30000)) { veilAt = 0; veil.style.transition = 'opacity .5s'; veil.style.opacity = '0'; }
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
      const dbg = globalThis.__w3 || {};  // dev switches for profiling: { noGrass, noScrub, life, noImp, noHi, noSm, noTerrain, gpu }
      life.show(lifeOn);
      if (dbg.noImp || dbg.noHi || dbg.noSm || dbg.noTerrain || dbg.noFurn) { renderer.shadowMap.enabled = !dbg.noSm; for (const c of near.values()) { if (c.imp) c.imp.visible = !dbg.noImp; if (c.parts.furn) c.parts.furn.visible = !dbg.noFurn; if (c.parts.terrain && dbg.noTerrain) c.parts.terrain.visible = false; for (const t of c.treeSets || []) if (t.hi && dbg.noHi) t.hi.visible = false; } }
      mark(); if (ready && !dbg.noGrass) grass.update(camPos.x || p[0], camPos.z || p[1], q === 2 ? 1 : 2); if (ready && !dbg.noScrub) scrub.update(camPos.x || p[0], camPos.z || p[1], q === 2 ? 1 : 1.5, Math.min(40, QUALITY[q].span)); mark();
      WIND.time.value += dt; WIND.gust.value = 0.55 + 0.35 * Math.sin(now / 7300) * Math.sin(now / 3100);
      syncOthers(dt, now); arrows();
      lifeDt += dt;
      if (lifeOn && !dbg.noLife && (q < 2 || frames % 2 === 0)) life.update(lifeDt, { rider: { x: p[0], y, z: p[1], v, yaw }, ground: groundAt,
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
        const tn = tunnelAt(tmp.x, tmp.z, y) ?? tunnelAt(p[0], p[1], y), g = tn ? null : groundAt(tmp.x, tmp.z); if (g != null && tmp.y < g + 1.4) tmp.y = g + 1.4;
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
      if (camOver) { const [la, lo, h, hd, pitch, fov] = camOver, [x, z] = proj.xz(la, lo), r = hd * Math.PI / 180; camera.position.set(x, h, z); camera.lookAt(x + Math.sin(r) * 100, h + Math.tan(pitch * Math.PI / 180) * 100, z - Math.cos(r) * 100); if (fov && camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); } }
      sky.update(camera, me.group.position, dt, QUALITY[q].span);
      mark(); if (ready) hz.update(p[0], p[1], now); mark();
      // the bores nearest the camera, for the ground to leave out
      { const segs = [];
        for (const T of tun.list) for (const g of [...T.segs, ...T.cuts]) segs.push([Math.hypot((g[0] + g[2]) / 2 - camPos.x, (g[1] + g[3]) / 2 - camPos.z), g]);
        segs.sort((a, b) => a[0] - b[0]); const n = Math.min(12, segs.length);
        for (let i = 0; i < n; i++) { const g = segs[i][1]; BORES.a.value[i].set(g[0], g[1], g[2], g[3]); BORES.b.value[i].set(g[4], g[5], g[6], g[7]); }
        BORES.n.value = n; }
      // inside a tunnel: the daylight fades out
      const tk = tunnelAt(camPos.x, camPos.z, y)?.k ?? 0; dark += (tk - dark) * Math.min(1, dt * 3);
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
        warm.userData.all = warm.userData.frames; renderer.compile(scene, camera);
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
      warm.userData.frames++;
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
    grass.dispose(); scrub.dispose(); post.dispose(); life.dispose(); audio.dispose(); document.removeEventListener('visibilitychange', onHide); hz.dispose(); if (tun.group) disposeObj(tun.group);
    renderer.dispose(); renderer.forceContextLoss?.(); canvas.remove(); tags.remove(); veil.remove();
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
    stats: () => ({ fps, quality: QUALITY[q].name, near: near.size, far: far.size, jobs: jobs.size, ready: ready && warm.userData.all > 0 && warm.userData.frames - warm.userData.all > 10, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, grass: grass.count, scrub: scrub.count, life: life.counts, cpu: { js: +cpu.js.toFixed(2), draw: +cpu.draw.toFixed(2), max: +cpu.max.toFixed(1) }, gpu: gpuTime.stat, slow: jobs.slow }),
    setQuality(n) { q = Math.max(0, Math.min(2, n)); applyQuality(); },
    dispose, alive: () => !dead,
    // for checks and screenshots: the scene, the rider, what is under a point
    debug: () => ({ scene, camera, THREE, renderer, horizon: hz, gpuMs: gpuTime.ms, me: me.group.position.toArray(), probe: (x, z, e = null) => ({ tunnel: tunnelAt(x, z, e), ground: groundAt(x, z), raw: (c => c?.grid ? gridHeight(c.grid, x, z, c.grid.raw) : null)(near.get(key(NEAR_Z, ...tileOf(x, z)))), deck: deckAt(x, z), road: roadAt(x, z, e), rail: RI?.top(x, z, e) ?? null }), prof: () => st?.P ? { d: dShown, y: profY(dShown) == null ? null : profY(dShown) + TYRE, lane: laneAt(dShown) } : null, tunRail: (x, z) => tunRail(x, z),
      // the drawn road's top under a point (a ray down onto the roads' and the bores' road surfaces), the nearest under y + 1
      // what is seen from above at a point: the top of the ground, the banks, the roads and lots, the bores' floors
      // ({ y, kind: 'ground' | 'bank' | 'road' }), null where nothing is drawn
      surface: (x, z) => { const c = near.get(key(NEAR_Z, ...tileOf(x, z))); if (!c) return null; const g = groundAt(x, z), rc = new THREE.Raycaster(new THREE.Vector3(x, 3000, z), new THREE.Vector3(0, -1, 0));
        const h = rc.intersectObjects((c.parts.roads?.children || []).filter(m => m.isMesh && !m.isInstancedMesh), false)[0];
        const rd = h?.object.material === mats.road ? h.point.y : null;  // (a road drawn there, seen or under the ground)
        return h && (g == null || h.point.y >= g) ? { y: h.point.y, kind: rd != null ? 'road' : 'bank', road: rd } : g == null ? null : { y: g, kind: 'ground', road: rd }; },
      // the road sides' bank runs ([{ p: edge point [x, y, z, nx, nz], b: bands [[o0, h0, o1, h1, cut], ...] }, ...] per run),
      // the trails' vertices, round (x, z): the seams check (r5check.mjs)
      seamData: (x, z, R) => { const out = { runs: [], trails: [] };
        for (const c of near.values()) { if (c.lod !== 0 || !c.grid) continue; const b = tileBox(c); if (b[2] < x - R || b[0] > x + R || b[3] < z - R || b[1] > z + R) continue;
          for (const run of c.bankRuns || []) if (run.some(({ p }) => Math.hypot(p[0] - x, p[2] - z) < R)) out.runs.push(run.map(({ p, b }) => [p, b]));
          const T = c.trailPts || []; for (let i = 0; i < T.length; i += 3) if (Math.hypot(T[i] - x, T[i + 2] - z) < R) out.trails.push([T[i], T[i + 1], T[i + 2]]);
          for (const f of c.feet || []) if (Math.hypot(f[0] - x, f[2] - z) < R) (out.feet ??= []).push(f); }
        return out; },
      veg: (x, z) => vcls(x, z), ground: (x, z) => groundAt(x, z),
      // the ways (OpenStreetMap, as chained) with a node within R of (x, z): their tags and nodes (checks)
      ways: (x, z, R) => { const out = new Map(); for (const c of near.values()) for (const r of c.tile?.chained || []) { const P = r.pts.map(([la, lo]) => proj.xz(la, lo)); if (P.some(([u, w]) => Math.hypot(u - x, w - z) < R)) out.set(r, { hw: r.hw, ln: r.ln, fl: r.fl, wd: r.wd, rail: !!r.h, pts: P.map(([u, w]) => [+u.toFixed(1), +w.toFixed(1)]) }); } return [...out.values()]; },
      // the top of any road's paving at (x, z) (its built tile's road index, any height), the nearest to y
      roadNear: (x, z, y = null) => { const c = near.get(key(NEAR_Z, ...tileOf(x, z))), SI = c?.surf; if (!SI) return null; let best = null;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of SI.cells.get(`${Math.floor(x / 10) + a},${Math.floor(z / 10) + b}`) || []) {
          const S = SI.S, ex = S[k + 3] - S[k], ez = S[k + 5] - S[k + 2], L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - S[k]) * ex + (z - S[k + 2]) * ez) / L2)) : 0;
          if (Math.hypot(x - S[k] - ex * t, z - S[k + 2] - ez * t) < S[k + 6]) { const h = S[k + 1] + (S[k + 4] - S[k + 1]) * t; if (best == null || (y != null && Math.abs(h - y) < Math.abs(best - y))) best = h; } }
        return best; },
      drawn: (x, z, y) => { const rc = new THREE.Raycaster(new THREE.Vector3(x, y + 1, z), new THREE.Vector3(0, -1, 0), 0, 4), obj = [...near.values()].map(c => c.parts.roads?.children[0]).filter(Boolean); if (tun.group) obj.push(tun.group); const h = rc.intersectObjects(obj, true).find(h => h.object.material === mats.road); return h ? h.point.y : null; }, lat: z => proj.lat(z), lon: x => proj.lon(x), xz: (la, lo) => proj.xz(la, lo), near: nearLines, decks: () => [...near.values()].filter(c => c.decks?.length).map(c => [c.k, c.decks.length]), tunnels: tun.list.map(T => ({ h0: T.h0, h1: T.h1, L: T.L, box: T.box, port: T.port, a: [proj.lat(T.P[0][1]), proj.lon(T.P[0][0])], b: [proj.lat(T.P.at(-1)[1]), proj.lon(T.P.at(-1)[0])] })) }),
    // a fixed camera for screenshots and checks: [lat, lon, height m, heading deg, pitch deg], null to follow the rider
    // a fixed camera for spot checks: [lat, lon, height, heading, pitch, vertical fov (optional)]
    viewFrom(v) { camOver = v; },

  };
}
