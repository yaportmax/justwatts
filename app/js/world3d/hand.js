// World 3D: hand-built scenery (A17 pilot: Conzelman Road 930 to 1690 m, modelled in Blender against the Street View
// survey; private tools/blender/build_conz.py). app/world/hand/conz.json lists its chunks ({ i, cx, cz }: glTF in the game
// frame less (cx, 0, cz)) and the stations it covers; the generated road, banks and rails give way there (view.js), the
// rider's rails and grade stay as they are. Materials become the game's own Lambert (the sun's terrain shadows, withSun).
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { GLTFLoader } from '../../vendor/three-0.180.0/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../../vendor/three-0.180.0/addons/libs/meshopt_decoder.module.js';
// (A34: the meshes' decoding in two workers, off the main thread: each chunk and plant group arriving after the loading screen had held
// frames at 50 ms for about ten seconds on the live site, lw1/lw2 20 to 30 s; CSP worker-src blob: in web/vercel.json)
try { if (typeof Worker !== 'undefined' && !globalThis.__w3?.noMeshoptWorkers) MeshoptDecoder.useWorkers(Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1))); } catch {}
import { textures } from './tex.js';
import { TAM, tamCover } from './materials.js';
import { HZ_LAYER } from './horizon.js';
import { createCoverage } from './hand-cover.js';
import { shoulderAt, cutAt, SHOULDERS } from './roadlines.js';
import { compileSpec } from './conzelman.js';
import { makeProj } from './geo.js';

// (A37) the shoulder on the verges: each verge vertex's distance from the paved edge (the chunk's road triangles' edges: the
// nearest point of the paving from outside it is on its boundary, so every triangle edge serves) and its road's shoulder
// (roadlines.js SHOULDERS by the nearest station and the verge's side) as attribute jwSh: x 1 at the edge to 0 at 8 m, y the
// kind (0 grass, 0.5 tan gravel, 1 red dirt), z the width / 8. The hand terrain has none: no shoulder there.
let SPEC_ = null; const PROJ_ = makeProj(37.93, -122.63), spec_ = () => SPEC_ ??= compileSpec(PROJ_);
const SHK = { g: 0, t: 0.5, d: 1, o: 1.5, b: -1 }, CTK = { r: [1, 0], g: [1, 0.5], p: [1, 1], o: [0, -1], t: [1, -2], x: [-1, 0] };  // (jwCt: x 1 a cut face, -1 none; y its tone)  // (b: brush to the edge past a thin rocky lip, the cover forced on)
// (A37) the scrub shell over a brush shoulder ('b', Hawk Hill): its vertices tagged as the ground's are (jwSh: no band, the brush
// forced on), so the bushes paint there too; the cover map's shrub mask (G) misses that slope (hawkR). Only vertices near a 'b' row.
let BR_ = null;
const brushAt = (x, z) => {  // (a 'b' row's width at (x, z), by that row's own line: at the hairpins another stretch's station is nearer and left patches, hawkR)
  if (!BR_) { const Z = spec_(); BR_ = SHOULDERS.filter(r => r[3] === 'b').map(([a, b, sd, , w]) => { const P = []; for (let s = a; s <= b; s += 2) P.push(PROJ_.xz(...Z.latlon(s))); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return { P, sd, w, bb: [x0 - 45, z0 - 45, x1 + 45, z1 + 45] }; }); }
  for (const { P, sd, w, bb } of BR_) { if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue; let bd = 45 * 45, bi = -1; for (let i = 0; i + 1 < P.length; i++) { const d = (P[i][0] - x) ** 2 + (P[i][1] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    if (bi < 0) continue; const [x0, z0] = P[bi], [x1, z1] = P[bi + 1]; if (((x - x0) * -(z1 - z0) + (z - z0) * (x1 - x0) > 0 ? 'R' : 'L') === sd) return w; }
  return 0; };
function addShoulders(root, lambert) {
  root.updateMatrixWorld(true); const v = new THREE.Vector3(), cells = new Map(), C = 8, S = [];  // (A37: 8 m cells and a 3 x 3 window still reach the 8 m clamp; each edge tested once per lookup (stamp))
  root.traverse(o => { if (!o.isMesh || !/^road\d/.test(o.name)) return; const P = o.geometry.attributes.position, I = o.geometry.index; if (!I) return;
    const W = new Float32Array(P.count * 2); for (let k = 0; k < P.count; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); W[2 * k] = v.x; W[2 * k + 1] = v.z; }
    // (A37 load profile: only the paving's outline: an inner edge (two triangles share it) is never the nearest point from outside)
    const ec = new Map(), ek = (a, b) => a < b ? a * 1048576 + b : b * 1048576 + a; for (let t = 0; t + 2 < I.count; t += 3) for (let e = 0; e < 3; e++) { const k = ek(I.getX(t + e), I.getX(t + (e + 1) % 3)); ec.set(k, (ec.get(k) || 0) + 1); }
    for (let t = 0; t + 2 < I.count; t += 3) for (let e = 0; e < 3; e++) { const a = I.getX(t + e), b = I.getX(t + (e + 1) % 3); if (ec.get(ek(a, b)) !== 1) continue; const n = S.length; S.push(W[2 * a], W[2 * a + 1], W[2 * b], W[2 * b + 1]);
      const x0 = Math.floor(Math.min(W[2 * a], W[2 * b]) / C), x1 = Math.floor(Math.max(W[2 * a], W[2 * b]) / C), z0 = Math.floor(Math.min(W[2 * a + 1], W[2 * b + 1]) / C), z1 = Math.floor(Math.max(W[2 * a + 1], W[2 * b + 1]) / C);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const k = i * 100003 + j; (cells.get(k) ?? cells.set(k, []).get(k)).push(n); } } });
  if (!S.length) return;
  const seen = new Uint32Array(S.length / 4 + 1); let stamp = 0;
  const dist = (x, z) => { let best = 64; const ci = Math.floor(x / C), cj = Math.floor(z / C); stamp++;  /* (squared, numeric cell keys: A37 load profile) */
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const L = cells.get((ci + a) * 100003 + cj + b); if (!L) continue; for (let m = 0; m < L.length; m++) { const n = L[m]; if (seen[n >> 2] === stamp) continue; seen[n >> 2] = stamp;
      const ax = S[n], az = S[n + 1], ex = S[n + 2] - ax, ez = S[n + 3] - az, L2 = ex * ex + ez * ez, f = L2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)) : 0, dx = x - ax - ex * f, dz = z - az - ez * f, d = dx * dx + dz * dz; if (d < best) best = d; } }
    return Math.sqrt(best); };
  const Z = spec_();
  // (the hand terrain too, its side of the line from the line's own direction there: where no verge is built, and Hawk Hill's
  // brush ('b') up the slope past the verge, sh_hawk: the cover map has it as grass)
  // (A37 load profile: the terrain's nearest station once per 2 m cell (its vertices are a metre or two apart; the verges stay exact))
  const NC = new Map(), nearC = (x, z) => { const k = Math.floor(x / 2) * 100003 + Math.floor(z / 2); let q = NC.get(k); if (q === undefined) { q = Z.near(Math.floor(x / 2) * 2 + 1, Math.floor(z / 2) * 2 + 1, 40); NC.set(k, q); } return q; };
  const sideOf = (x, z, s) => { const [a0, o0] = Z.latlon(s - 1), [a1, o1] = Z.latlon(s + 1), [x0, z0] = PROJ_.xz(a0, o0), [x1, z1] = PROJ_.xz(a1, o1); return (x - x0) * -(z1 - z0) + (z - z0) * (x1 - x0) > 0 ? 'R' : 'L'; };
  root.traverse(o => { const ve = /^verge\d+[LR]$/.test(o.name), ext = /^terrain_ext/.test(o.name); if (!o.isMesh || !(ve || ext || /^terrain\d/.test(o.name))) return;  // (A37: the far terrain too, for the brush rows only: hawkR's slope is on it)
    const P = o.geometry.attributes.position, A = new Float32Array(P.count * 3), B = new Float32Array(P.count * 2);
    for (let k = 0; k < P.count; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); const q = ext ? null : ve ? Z.near(v.x, v.z, 40) : nearC(v.x, v.z); if (!q || q.s < 0) { const bw = brushAt(v.x, v.z); if (bw) { A[3 * k + 1] = -1; A[3 * k + 2] = bw / 8; } continue; } const sd = ve ? o.name.slice(-1) : sideOf(v.x, v.z, q.s), ct = CTK[cutAt(q.s, sd, q.d)]; if (ct) { B[2 * k] = ct[0]; B[2 * k + 1] = ct[1]; } let sh = shoulderAt(q.s, sd); if (sh?.[0] === 'b') sh = null; { const bw = brushAt(v.x, v.z); if (bw) sh = ['b', bw]; } if (!sh || (!ve && q.d > 25 && sh[0] !== 'b')) continue;
      A[3 * k] = q.d > 18 ? 0 : 1 - dist(v.x, v.z) / 8;  /* (A37: past 18 m of the line the edge is over 8 m away: no search) */ A[3 * k + 1] = SHK[sh[0]] ?? 0; A[3 * k + 2] = sh[1] / 8; }
    o.geometry.setAttribute('jwSh', new THREE.BufferAttribute(A, 3)); o.geometry.setAttribute('jwCt', new THREE.BufferAttribute(B, 2)); o.material = groundMaterial({ lambert, shoulder: true }); });
}

// (a surface's grain in world space from the game's noise texture, no UVs needed: asphalt aggregate and its tone patches,
// the verges' mottle; amp: how far the colour swings either way)
function grain(m, amp, scales) {
  const T = textures();
  m.onBeforeCompile = (sh, r) => {
    sh.uniforms.tGrain = { value: T.noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGw;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGw; uniform sampler2D tGrain;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        { vec2 p = vGw.xz; float g = texture2D(tGrain, p / ${scales[0].toFixed(1)}).r * 0.5 + texture2D(tGrain, p / ${scales[1].toFixed(1)}).g * 0.3 + texture2D(tGrain, p / ${scales[2].toFixed(1)}).b * 0.2;
          diffuseColor.rgb *= 1.0 + ${amp.toFixed(3)} * (g - 0.5) * 2.0; }`);
  };
  m.customProgramCacheKey = () => 'jw-hand-grain-' + amp + scales.join(',');
  return m;
}

// (A37 theme 8: each road's asphalt tone against Conzelman's, from Street View: the asphalt's pixel median in each pair
// (low saturation, no paint, the bottom middle of the view) over the game's at the same pose, as a ratio to Conzelman's own
// (its surface the reference), linear RGB, damped to 0.6 of the measured step (two to seven pairs a road, auto exposure):
// review1 w_bunker0-2, w_mccullough0-1, w_field0-2, w_mitchell0-1, w_east0-2, w_center0, w_simmonds0-1, w_kirkpatrick0,
// w_alexander0-1 and the A37 pairs; by the chunk's station base (allroads.py lines.json))
const ASPH_TONE = { 20000: [1.27, 1.34, 1.36], 30000: [0.93, 0.96, 1.02], 90000: [0.93, 0.96, 1.02], 120000: [0.93, 0.96, 1.02], 40000: [0.91, 0.92, 0.93],
  50000: [0.74, 0.77, 0.90], 70000: [1.14, 1.19, 1.24], 80000: [1.02, 1.05, 1.10], 360000: [1.02, 1.05, 1.10], 100000: [0.77, 0.77, 0.79],
  110000: [0.75, 0.79, 0.91], 130000: [1.0, 0.99, 1.03], 280000: [1.13, 1.17, 1.20],
  // (A38 Mount Tam, the same measure on the first hand pairs: Shoreline and Panoramic fresh dark blacktop (tam_517000), East Ridgecrest pale aged grey (tam_532000); Pantoll Road as Conzelman's)
  500000: [0.78, 0.81, 0.88], 510000: [0.78, 0.81, 0.88], 530000: [1.25, 1.22, 1.19] };
const asphTone = s0 => ASPH_TONE[Math.floor(s0 / 10000) * 10000] || null;
// (A37 theme 8: the blacktop's wear in world space, Street View's on every road: darker tar patches metres across with crisp
// edges, sealed cracks (black tar lines a hand wide, wandering), fine open cracks in some stretches, a lighter worn patch
// now and then; sparse, as most of Street View's surface is plain (a first, denser pass read as a cracked cartoon, w_field1_ts1); each faded where a pixel spans more than its width (no shimmer far off). No wheel paths: the road mesh has
// no across-the-road coordinate.)
function asphaltWear(m) {
  const T = textures(), f0 = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    f0.call(m, sh, r);
    sh.uniforms.tWear = { value: T.noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vAw;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvAw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vAw; uniform sampler2D tWear;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        { vec2 p = vAw.xz; float px = length(fwidth(p));
          vec4 a = texture2D(tWear, p / 23.0 + 0.13), b = texture2D(tWear, p / 7.3 + 0.71), c = texture2D(tWear, p / 3.1 + 0.29);
          float patchT = smoothstep(0.69, 0.715, a.g * 0.6 + b.r * 0.4);           // a tar patch
          float worn = smoothstep(0.72, 0.76, a.b * 0.55 + b.g * 0.45) * (1.0 - patchT);  // a pale worn patch
          float seam = (1.0 - smoothstep(0.004, 0.012 + px * 0.02, abs(b.b - 0.5))) * smoothstep(0.62, 0.74, a.r) * (1.0 - smoothstep(0.08, 0.3, px));
          float crack = (1.0 - smoothstep(0.003, 0.008 + px * 0.02, abs(c.a - 0.5))) * smoothstep(0.7, 0.82, a.a) * (1.0 - smoothstep(0.04, 0.15, px));
          diffuseColor.rgb *= (1.0 - 0.1 * patchT) * (1.0 + 0.05 * worn) * (1.0 - 0.14 * seam) * (1.0 - 0.08 * crack); }`);  /* (review2: the sealed cracks at 30 % read as drawn lines, a cartoon, w_mccullough0, w_bunker3) */
  };
  const k0 = m.customProgramCacheKey; m.customProgramCacheKey = () => k0.call(m) + '|wear';
  return m;
}

// (white water: its vertex alpha broken into lace by the game's noise in world space, solid only where the alpha is high)
function foam(m) {
  const T = textures();
  m.onBeforeCompile = sh => {
    sh.uniforms.tGrain = { value: T.noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGw;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGw; uniform sampler2D tGrain;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        { vec2 p = vGw.xz; float n = texture2D(tGrain, p / 173.0).r * 0.6 + texture2D(tGrain, p / 61.0).g * 0.4, a = diffuseColor.a;
          diffuseColor.a = a * smoothstep(0.25, 0.7, n); }`);
  };
  m.customProgramCacheKey = () => 'jw-hand-foam';
  return m;
}

// (A39) The ground meshes of a chunk (names matching re) as a height raster in world space: a point every C metres (1 m, more
// for a large mesh: at most 400 000 points), the highest surface at each, in centimetres over the lowest (Int16, -32768: none).
function groundRaster(root, re) {
  const meshes = [], box = new THREE.Box3(), b = new THREE.Box3();
  root.traverse(o => { if (!o.isMesh || !re.test(o.name) || !o.geometry?.attributes?.position) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); box.union(b); meshes.push(o); });
  if (!meshes.length || box.isEmpty()) return null;
  const C = Math.max(1, Math.sqrt((box.max.x - box.min.x + 2) * (box.max.z - box.min.z + 2) / 4e5)), x0 = Math.floor(box.min.x / C) * C, z0 = Math.floor(box.min.z / C) * C;
  const nx = Math.ceil((box.max.x - x0) / C) + 1, nz = Math.ceil((box.max.z - z0) / C) + 1, y0 = box.min.y - 1, h = new Int16Array(nx * nz).fill(-32768), v = new THREE.Vector3();
  for (const o of meshes) {
    const P = o.geometry.attributes.position, I = o.geometry.index, n = P.count, W = new Float32Array(3 * n);
    for (let k = 0; k < n; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); W[3 * k] = (v.x - x0) / C; W[3 * k + 1] = (v.y - y0) * 100; W[3 * k + 2] = (v.z - z0) / C; }
    for (let t = 0, T = I ? I.count : n; t + 2 < T; t += 3) {
      const a = 3 * (I ? I.getX(t) : t), bb = 3 * (I ? I.getX(t + 1) : t + 1), c = 3 * (I ? I.getX(t + 2) : t + 2);
      const ax = W[a], ay = W[a + 1], az = W[a + 2], bx = W[bb], by = W[bb + 1], bz = W[bb + 2], cx = W[c], cy = W[c + 1], cz = W[c + 2];
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 1e-3)), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) + 1e-3)); if (i0 > i1) continue;
      const j0 = Math.max(0, Math.ceil(Math.min(az, bz, cz) - 1e-3)), j1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz) + 1e-3)); if (j0 > j1) continue;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-9) continue;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const u = ((bz - cz) * (i - cx) + (cx - bx) * (j - cz)) / d, w = ((cz - az) * (i - cx) + (ax - cx) * (j - cz)) / d, q = 1 - u - w; if (u < -2e-3 || w < -2e-3 || q < -2e-3) continue;
        const y = Math.max(-32767, Math.min(32767, Math.round(u * ay + w * by + q * cy))), k = j * nx + i; if (y > h[k]) h[k] = y;
      }
    }
  }
  return { x0, z0, x1: x0 + (nx - 1) * C, z1: z0 + (nz - 1) * C, C, nx, nz, y0, h };
}
// (A42) A bored tunnel's zone: the points within w of its line (stations a to b, a point every 4 m) whose nearest point of the line is not one of its
// ends: past the portals' planes, inside the hill. The ground there is the hill's (the tile's), the bore the generated tunnel's.
function boreZone(ranges, w = 120) {
  const Z = spec_(), L = ranges.map(([a, b]) => { const P = []; for (let s = a; s < b; s += 4) P.push(PROJ_.xz(...Z.latlon(s))); P.push(PROJ_.xz(...Z.latlon(b)));
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return { P, bb: [x0 - w, z0 - w, x1 + w, z1 + w] }; });
  return (x, z) => { for (const { P, bb } of L) { if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue; let bd = w * w, bi = -1, bt = 0;
      for (let i = 0; i + 1 < P.length; i++) { const [ax, az] = P[i], [bx, bz] = P[i + 1], ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1))),
        dd = (x - ax - ex * t) ** 2 + (z - az - ez * t) ** 2; if (dd < bd) { bd = dd; bi = i; bt = t; } }
      if (bi >= 0 && !(bi === 0 && bt <= 0) && !(bi === P.length - 2 && bt >= 1)) return true; } return false; };
}
// its mouths: at each end of the line the bore's own width (w either side), from inn inside the portal's plane to out before it; near(x, z, r): within r of one
function boreMouths(ranges, w = 4, out = 1.5, inn = 12) {
  const Z = spec_(), E = [];
  for (const [a, b] of ranges) for (const [s0, s1] of [[a, a + 4], [b, b - 4]]) { const e = PROJ_.xz(...Z.latlon(s0)), f = PROJ_.xz(...Z.latlon(s1)), l = Math.hypot(e[0] - f[0], e[1] - f[1]) || 1; E.push([e[0], e[1], (e[0] - f[0]) / l, (e[1] - f[1]) / l]); }
  const m = (x, z) => { for (const [ex, ez, ux, uz] of E) { const s = (x - ex) * ux + (z - ez) * uz; if (s <= out && s >= -inn && Math.abs((x - ex) * uz - (z - ez) * ux) < w) return true; } return false; };
  m.near = (x, z, r) => E.some(([ex, ez]) => (x - ex) ** 2 + (z - ez) ** 2 < (r + inn + w) ** 2);
  // (its apron: before the portal, the road's width out to 9 m and between the wing walls out to 5 m)
  m.apron = (x, z) => { for (const [ex, ez, ux, uz] of E) { const s = (x - ex) * ux + (z - ez) * uz, d = Math.abs((x - ex) * uz - (z - ez) * ux); if (s > -inn && (s <= 5 ? d < 6 : s <= 9 && d < 4.5)) return true; } return false; };
  return m;
}
// A neighbour's ground in a mouth's apron down under its own road's level (the nearest point of the chunk's road, less 0.12 m): the chunk's ground
// ends there in points at the hill's height (the cut was the tunnel chunk's), wedges 2 to 5 m high standing across the road before the east portal.
function sinkApron(scene, mouth) {
  const R = [], T = []; scene.traverse(o => { if (!o.isMesh || !o.geometry?.attributes?.position) return; if (/^road/.test(o.name)) R.push(o); else if (/^terrain(?!_ext)/.test(o.name)) T.push(o); });
  if (!R.length || !T.length) return 0;
  const rv = []; for (const o of R) { const P = o.geometry.attributes.position, M = o.matrixWorld.elements; for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i), X = M[0] * x + M[4] * y + M[8] * z + M[12], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; if (mouth.near(X, Z, 20)) rv.push(X, M[1] * x + M[5] * y + M[9] * z + M[13], Z); } }
  if (!rv.length) return 0; let moved = 0;
  for (const o of T) { const P = o.geometry.attributes.position, N = o.geometry.attributes.normal, M = o.matrixWorld.elements; if (Math.abs(M[1]) > 1e-6 || Math.abs(M[9]) > 1e-6 || !(M[5] > 0)) continue; let any = false;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i), X = M[0] * x + M[4] * y + M[8] * z + M[12], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; if (!mouth.apron(X, Z)) continue;
      let bd = Infinity, by = 0; for (let k = 0; k < rv.length; k += 3) { const dd = (rv[k] - X) ** 2 + (rv[k + 2] - Z) ** 2; if (dd < bd) { bd = dd; by = rv[k + 1]; } }
      const Y = M[5] * y + M[13]; if (Y > by - 0.12) { P.setY(i, (by - 0.12 - M[13]) / M[5]); N?.setXYZ(i, 0, 1, 0); any = true; moved++; } }
    if (any) { P.needsUpdate = true; if (N) N.needsUpdate = true; o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); } }
  return moved;
}
// the bored tunnels: the road lines' station ranges whose hand chunks are not loaded (__w3.handBore: loaded, as before A42)
const BORED_ = () => globalThis.__w3?.handBore ? [] : [[120000, 120714]];
// a ground mesh without its triangles in the zone (by their centres); a terrain mesh also without those that reach into a mouth anywhere (points of the
// triangle every 1.2 m: the neighbour's banks crossed the opening in large triangles with every corner outside it, wedges 3 m high before the east
// portal, a mound 0.5 m over the road in the west one); how many went
function cutBored(o, zone, mouth) {
  const geo = o.geometry, P = geo.attributes.position, I = geo.index, n = I ? I.count : P.count, M = o.matrixWorld.elements, out = new Uint8Array(Math.floor(n / 3)), ter = /^terrain/.test(o.name); let cut = 0;
  const wx = v => M[0] * P.getX(v) + M[4] * P.getY(v) + M[8] * P.getZ(v) + M[12], wz = v => M[2] * P.getX(v) + M[6] * P.getY(v) + M[10] * P.getZ(v) + M[14];
  for (let t = 0, q = 0; t + 2 < n; t += 3, q++) { const a = I ? I.getX(t) : t, b = I ? I.getX(t + 1) : t + 1, c = I ? I.getX(t + 2) : t + 2;
    const ax = wx(a), az = wz(a), bx = wx(b), bz = wz(b), cx = wx(c), cz = wz(c);
    let hit = zone((ax + bx + cx) / 3, (az + bz + cz) / 3);
    if (!hit && ter) { const e = Math.sqrt(Math.max((ax - bx) ** 2 + (az - bz) ** 2, (bx - cx) ** 2 + (bz - cz) ** 2, (cx - ax) ** 2 + (cz - az) ** 2));
      if (mouth.near(ax, az, e)) { const k = Math.min(24, Math.max(1, Math.ceil(e / 1.2)));
        for (let i = 0; i <= k && !hit; i++) for (let j = 0; j <= k - i; j++) { const u = i / k, v = j / k, w = 1 - u - v; if (mouth(ax * u + bx * v + cx * w, az * u + bz * v + cz * w)) { hit = true; break; } } } }
    if (hit) { out[q] = 1; cut++; } }
  if (!cut) return 0;
  if (o.userData.ownT) o.userData.ownT = o.userData.ownT.filter((_, q) => !out[q]);  // (A46: the owner list follows the triangles kept)
  const keep = []; for (let t = 0, q = 0; t + 2 < n; t += 3, q++) if (!out[q]) keep.push(I ? I.getX(t) : t, I ? I.getX(t + 1) : t + 1, I ? I.getX(t + 2) : t + 2);
  geo.setIndex(keep); return cut;
}
// (A45) A chunk's terrain under its own verges, lots and road. The bake laid the terrain 12 to 25 cm under them, but not everywhere: where the lidar's
// ground stood a hand or two over a verge the two were drawn through each other, the terrain's triangles standing out of the verge in shards (their
// shoulder and cover differ: grey facets in the grass, Bunker Road 90300's right bank; the scan's hOver, 1,227 cells of 36,864 there). At load the
// terrain's points under a verge, a lot or the road go `drop` under it, and its triangles there are checked at their edges' midpoints and their
// centres and lowered where they still stand over: a point outside the verge by `ring` at most, a point on the terrain's own edge not at all (the
// next chunk's terrain meets it there). Ground `cap` or more over the verge is a bank standing in it: left, the two meet in one line.
// (A47) cap 0.3 and ring 0.15, not 1.5 and 0.8: with those the tuck dug the banks out of the verges, 88,000 points by 0.4 to 1.65 m: a wall at the
// verge's edge where the bank had run down into it (the scan's seam 228 > 2,215 on 30 stops) and 2,049 hand plants left standing in the air over the
// lowered ground, 1.6 m at most. Only ground within a foot of the verge's surface fights it; no point moves more than cap + drop, none beside a verge
// more than ring. The hand plants are seated on the ground as it is drawn after this (private work/lead/own/handseat.mjs, which runs this function
// as it stands here: run it again when these numbers change).
// __w3.noTuck: as before; __w3.tuckWide: cap 1.5, ring 0.8
function tuckTerrain(scene, { drop = 0.15, cap = 0.3, ring = 0.15, clear = 0.05 } = {}) {
  const st = { cov: 0, ring: 0, max: 0, left: 0, ms: 0 }, t0 = performance.now();
  scene.updateMatrixWorld(true);
  const R = groundRaster(scene, /^(verge|lot|road)/); if (!R) return st;
  const v = new THREE.Vector3(), inv = new THREE.Matrix4(), B = [[0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3]];
  scene.traverse(o => {
    if (!o.isMesh || !/^terrain(?!_ext)/.test(o.name)) return;
    const P = o.geometry.attributes.position, I = o.geometry.index; if (!P) return;
    const n = P.count, T = I ? I.count : n, W = new Float64Array(3 * n); let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    for (let k = 0; k < n; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); W[3 * k] = v.x; W[3 * k + 1] = v.y; W[3 * k + 2] = v.z; if (v.x < x0) x0 = v.x; if (v.y < y0) y0 = v.y; if (v.z < z0) z0 = v.z; }
    // (the points at one place move as one: the loader splits a point where its normals differ)
    const id = new Int32Array(n), keys = new Map(), gx = [], gy = [], gz = [];
    for (let k = 0; k < n; k++) { const q = (Math.round((W[3 * k] - x0) * 50) * 131072 + Math.round((W[3 * k + 2] - z0) * 50)) * 32768 + Math.round((W[3 * k + 1] - y0) * 20); let g = keys.get(q); if (g === undefined) { keys.set(q, g = gx.length); gx.push(W[3 * k]); gy.push(W[3 * k + 1]); gz.push(W[3 * k + 2]); } id[k] = g; }
    const m = gx.length, cov = new Float64Array(m).fill(NaN), low = new Float64Array(m), tri = k => id[I ? I.getX(k) : k];
    for (let g = 0; g < m; g++) { if (gx[g] < R.x0 - 1 || gx[g] > R.x1 + 1 || gz[g] < R.z0 - 1 || gz[g] > R.z1 + 1) continue; const c = rasterY(R, gx[g], gz[g]); if (c != null) cov[g] = c; }
    // (the triangles with a point under a verge: their corners, and the verge's height at the four checked points)
    const list = [];
    for (let t = 0; t + 2 < T; t += 3) { const a = tri(t), b = tri(t + 1), c = tri(t + 2); if (a === b || b === c || a === c) continue;
      if (Math.min(gx[a], gx[b], gx[c]) > R.x1 || Math.max(gx[a], gx[b], gx[c]) < R.x0 || Math.min(gz[a], gz[b], gz[c]) > R.z1 || Math.max(gz[a], gz[b], gz[c]) < R.z0) continue;
      let any = cov[a] === cov[a] || cov[b] === cov[b] || cov[c] === cov[c]; const sv = [NaN, NaN, NaN, NaN];
      for (let k = 0; k < 4; k++) { const y = rasterY(R, B[k][0] * gx[a] + B[k][1] * gx[b] + B[k][2] * gx[c], B[k][0] * gz[a] + B[k][1] * gz[b] + B[k][2] * gz[c]); if (y != null) { sv[k] = y; any = true; } }
      if (any) list.push(a, b, c, sv[0], sv[1], sv[2], sv[3]); }
    if (!list.length) return;
    // (the terrain's own edge: an edge of one triangle only)
    const edge = new Uint8Array(m), ec = new Map();
    for (let t = 0; t + 2 < T; t += 3) { const a = tri(t), b = tri(t + 1), c = tri(t + 2); if (a === b || b === c || a === c) continue;
      for (let j = 0; j < 3; j++) { const p = j === 0 ? a : j === 1 ? b : c, q = j === 0 ? b : j === 1 ? c : a, e = p < q ? p * m + q : q * m + p; ec.set(e, (ec.get(e) || 0) + 1); } }
    for (const [e, cnt] of ec) if (cnt === 1) { edge[Math.floor(e / m)] = 1; edge[e % m] = 1; }
    for (let g = 0; g < m; g++) { const c = cov[g]; if (c !== c) continue; const d = gy[g] - c; if (d > -drop && d < cap) { low[g] = d + drop; gy[g] = c - drop; } }
    for (let it = 0; it < 4; it++) { let moved = 0;
      for (let q = 0; q < list.length; q += 7) { const a = list[q], b = list[q + 1], c = list[q + 2]; let ex = 0;
        for (let k = 0; k < 4; k++) { const vy = list[q + 3 + k]; if (vy !== vy) continue; const e = B[k][0] * gy[a] + B[k][1] * gy[b] + B[k][2] * gy[c] - (vy - clear); if (e > ex && e < cap) ex = e; }
        if (!(ex > 0)) continue;
        for (let j = 0; j < 3; j++) { const g = j === 0 ? a : j === 1 ? b : c, dy = Math.min(ex, (cov[g] === cov[g] ? cap + drop : edge[g] ? 0 : ring) - low[g]); if (dy > 1e-3) { gy[g] -= dy; low[g] += dy; moved++; } } }
      if (!moved) break; }
    let ch = 0; for (let g = 0; g < m; g++) if (low[g] > 1e-3) { ch++; if (cov[g] === cov[g]) st.cov++; else st.ring++; if (low[g] > st.max) st.max = low[g]; }
    for (let q = 0; q < list.length; q += 7) for (let k = 0; k < 4; k++) { const vy = list[q + 3 + k]; if (vy === vy && B[k][0] * gy[list[q]] + B[k][1] * gy[list[q + 1]] + B[k][2] * gy[list[q + 2]] > vy) st.left++; }
    if (!ch) return;
    inv.copy(o.matrixWorld).invert();
    for (let k = 0; k < n; k++) { const g = id[k]; if (!(low[g] > 1e-3)) continue; v.set(W[3 * k], gy[g], W[3 * k + 2]).applyMatrix4(inv); P.setXYZ(k, v.x, v.y, v.z); }
    P.needsUpdate = true; o.geometry.boundingBox = null; o.geometry.boundingSphere = null;
  });
  st.ms = performance.now() - t0; return st;
}
// its height at a point: between its four points round it, those that have one (null: none of them has)
function rasterY(R, x, z) {
  const fx = (x - R.x0) / R.C, fz = (z - R.z0) / R.C; if (fx < -0.5 || fz < -0.5 || fx > R.nx - 0.5 || fz > R.nz - 0.5) return null;
  const i = Math.max(0, Math.min(R.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(R.nz - 2, Math.floor(fz))), u = Math.max(0, Math.min(1, fx - i)), w = Math.max(0, Math.min(1, fz - j)), k = j * R.nx + i;
  let s = 0, sw = 0; const add = (hv, wt) => { if (hv !== -32768 && wt > 0) { s += hv * wt; sw += wt; } };
  add(R.h[k], (1 - u) * (1 - w)); add(R.h[k + 1], u * (1 - w)); add(R.h[k + R.nx], (1 - u) * w); add(R.h[k + R.nx + 1], u * w);
  return sw > 0.249 ? R.y0 + s / sw / 100 : null;
}

export function loadHand({ scene, base = '/world/hand/', lambert = m => m, onLoad = () => {}, prepare = null, ahead = () => 1 }) {
  const group = new THREE.Group(); group.name = 'hand'; scene.add(group);
  // (A23: streamed by stretch: a group of chunks loads when the rider comes within 1800 m of one of them; a ride elsewhere loads none. state.on(s): that station's
  // chunk is in the scene; state.want(x, z): called by view.js as the rider moves; onLoad after each group.)
  const state = { group, covers: null, ready: false, settled: false, push: [], ranges: [], on: s => state.ranges.some(r => s >= r[0] && s <= r[1]), want(x, z) { state.at = [x, z]; state.pump?.(); }, notHere: () => !state.settled };
  fetch(base + 'conz.json').then(r => r.ok ? r.json() : null).then(async j => {
    if (!j) { state.settled = true; return; } state.covers = j.stations; state.runs = j.runs; state.allRanges = j.chunks.map(c => [c.s0, c.s1]);
    // (A42: a road line that is a bored tunnel from end to end, the Baker-Barry tunnel (120000), is the generated tunnel's (view.js rebuildTunnels: the bore under
    // the hill, its lining, lamps and portals). Built as an open road its chunks cut the hill down to the road, a slot 80 m deep. They are not loaded; allRanges
    // keeps them, so the corridor's raster still gives the tunnel's rows their cells, where the tile's ground stays. __w3.handBore: loaded as before, to compare)
    const BORED = BORED_(), live = j.chunks.filter(c => !BORED.some(([a, b]) => c.s0 >= a && c.s1 <= b));
    const zone = BORED.length ? boreZone(BORED) : null, mouth = zone && boreMouths(BORED); state.boreCut = 0;
    // (the hand terrain past the corridor, build_conz.py ext_terrain: per row of its grid the runs [i0, n, ...] of points
    // where the generated ground gives way)
    // (__w3.handNoExt: without it, the generated ground there again: perf attribution)
    const noExt = !!globalThis.__w3?.handNoExt;
    if (j.ext && !noExt) { const E = j.ext, M = new Uint8Array(E.nx * E.nz);
      E.runs.forEach((r, jj) => { for (let k = 0; k + 1 < r.length; k += 2) M.fill(1, jj * E.nx + r[k], jj * E.nx + r[k] + r[k + 1]); });
      state.extAt = (x, z) => { const i = Math.round((x - E.x0) / E.step), jj = Math.round((z - E.z0) / E.step); return i >= 0 && i < E.nx && jj >= 0 && jj < E.nz && M[jj * E.nx + i] === 1; }; }
    // (A46) One owner for every piece of hand-built ground. Each road of the hand build was baked on its own, with a corridor of terrain and verges round
    // it: where two roads run close (all of Fort Baker, Sausalito's streets, a junction) both corridors were drawn over the same ground, 227 ha of it twice,
    // nearly all within 0.25 m in height: two differently cut copies with their own shoulder shading standing through each other in facets, and one road's
    // bank over the other's paving. own.json (private work/lead/own/handown.mjs) gives the ground to the chunk whose paving is nearest: per chunk and mesh
    // [triangles, [owner chunks], [first triangle, count, ...], ...]. A block's triangles are left out while all its owner chunks are shown: the groups
    // load one after the other, and a piece whose owner is not in yet stays. Heights (yAt, the rasters the tiles are pressed under, the push) stay those
    // of all the ground. A chunk with triangles cut at the tunnel (cutBored) owns nothing: its ground has an opening the list does not know.
    // __w3.noOwn: all drawn, as before
    const OWN = globalThis.__w3?.noOwn ? null : await fetch(base + 'own.json').then(r => r.ok ? r.json() : null).catch(() => null), ownBy = new Map(), ownCut = new Set();
    // (A53 ground: a height raster misses thin gaps. Suppress a tile quad only when retained hand triangles cover it whole
    // and their chunks are visible. cx-ground/pits_before_q0: McCullough 14 pit cells, source triangle edge gaps.)
    const cover = await fetch(base + 'cover.json').then(r => r.ok ? r.json() : null).then(j => j ? createCoverage(j) : null).catch(() => null);
    state.coverFor = g => cover?.forGrid(g) ?? null;
    state.own = { meshes: 0, skipped: 0, tris: 0, hidden: 0, ms: 0, max: 0 }; if (globalThis.__w3) globalThis.__w3.own = state.own;
    const ownReg = into => { const list = []; into.traverse(o => { const T = o.userData.ownT, sets = o.userData.ownSets; if (!T) return; delete o.userData.ownT; delete o.userData.ownSets;
        const I = o.geometry?.index; if (!I || I.count !== 3 * T.length) { state.own.skipped++; return; }
        const e = { o, I, T, sets, full: I.array.slice(), hide: new Uint8Array(sets.length), kept: T.length }; list.push(e); state.own.meshes++;
        for (const st of sets) for (const i of st) (ownBy.get(i) ?? ownBy.set(i, new Set()).get(i)).add(e); }); return list; };
    const ownApply = (list, on) => { const t0 = performance.now();
      for (const e of list) { let ch = false; for (let b = 0; b < e.sets.length; b++) { const h = e.sets[b].every(on) ? 1 : 0; if (h !== e.hide[b]) { e.hide[b] = h; ch = true; } } if (!ch) continue;
        const A = e.I.array, F = e.full, T = e.T; let w = 0; for (let q = 0; q < T.length; q++) { const b = T[q]; if (b >= 0 && e.hide[b]) continue; A[w++] = F[3 * q]; A[w++] = F[3 * q + 1]; A[w++] = F[3 * q + 2]; }
        state.own.hidden += e.kept - w / 3; e.kept = w / 3; e.o.geometry.setDrawRange(0, w); e.I.needsUpdate = true; }
      const dt = performance.now() - t0; state.own.ms += dt; if (dt > state.own.max) state.own.max = dt; };
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), mats = new Map();
    const grp = c => c.s0 >= 20000 ? 100 + Math.floor(c.s0 / 1000) : c.s0 < 5000 ? 0 : c.s0 < 11322 ? 1 : c.s0 < 12822 ? 2 : 3,  /* (A33: the other roads a group per kilometre: all of them one group loaded 85 MB at once and the ride stalled) */ groups = new Map(); for (const c of live) { const k = grp(c); (groups.get(k) ?? groups.set(k, []).get(k)).push(c); }
    // (a group stays hidden until all its chunks are in, and counts as present only then: a late load shows the generated ground it replaces, never a part of the
    // corridor standing in it)
    // (A51: ahead(): how many of a group's chunk files are on their way at once, the one being worked on counted. 1 in a ride, as before. Under the
    // start screen view.js asks for 6: on the live site each file waited for the one before it to be fetched and worked through, 102 files at the
    // Conzelman start arriving from 7 s to 24 s, v610_conzelman_net.txt. They are still worked through one at a time in the same order.)
    const coming = new Map(), fetchChunk = c => coming.get(c.i) ?? coming.set(c.i, loader.loadAsync(base + `conz_${c.i}.glb`).catch(() => null)).get(c.i);
    async function addChunk(c, into, box) {
      const g = await fetchChunk(c); coming.delete(c.i); if (!g) return false;
      g.scene.position.set(c.cx, 0, c.cz);
      { const od = OWN?.drop?.[c.i]; if (od) g.scene.traverse(o => { const B = o.isMesh && od[o.name], I = o.geometry?.index; if (!B || !I) return; const nt = I.count / 3; if (nt !== B[0]) { state.own.skipped++; return; }  // (A46; a list made from another build of the chunk: not used)
          const T = new Int16Array(nt).fill(-1), sets = []; for (let q = 1; q + 1 < B.length; q += 2) { const id = sets.push(B[q]) - 1, R = B[q + 1]; for (let k = 0; k + 1 < R.length; k += 2) { T.fill(id, R[k], R[k] + R[k + 1]); state.own.tris += R[k + 1]; } }
          o.userData.ownT = T; o.userData.ownSets = sets; }); }
      // (A42: the chunks at the tunnel's ends carry their ground on into the hill along the tunnel, at its floor: mounds in the bore's mouth, and a ground the tile's
      // was pressed under (A41), a trench over the tunnel. Left out there, before anything is made from it; group and into are never moved)
      if (zone) { g.scene.updateMatrixWorld(true); g.scene.traverse(o => { if (o.isMesh && /^(terrain(?!_ext)|verge|road|lot)/.test(o.name) && o.geometry?.attributes?.position) { const n = cutBored(o, zone, mouth); state.boreCut += n; if (n) ownCut.add(c.i); } }); if (mouth.near(c.cx, c.cz, 400)) state.boreSunk = (state.boreSunk || 0) + sinkApron(g.scene, mouth); }
      if (!globalThis.__w3?.noTuck) { const t = tuckTerrain(g.scene, globalThis.__w3?.tuckWide ? { cap: 1.5, ring: 0.8 } : undefined), S = (state.tuck ??= { cov: 0, ring: 0, max: 0, left: 0, ms: 0, n: 0 }); S.cov += t.cov; S.ring += t.ring; S.left += t.left; S.ms += t.ms; S.max = Math.max(S.max, t.max); S.n++; if (globalThis.__w3) globalThis.__w3.tuck = S; }  // (A45)
      let hasVerge = false;
      g.scene.traverse(o => {
        if (!o.isMesh) return; o.receiveShadow = !/^(posts_(hp|fork[wy]|line|yline)|tunwa_bk_day)/.test(o.name); o.castShadow = /beam|post|kerb/.test(o.name) && !/^posts_(hp|fork[wy]|line|yline|wa_bo_board)/.test(o.name);  // (A29: paint neither casts nor takes shadows: dark smudges on the crossing bars, b1103_1538)
        // (the ground is in the terrain shadows' height map: without it the corridor was a pit there, and the generated hill
        // past its edge threw a straight-edged shadow into it, Street View Conzelman 1400 ahead)
        if (/^(terrain|rock_ext|verge|road|lot)/.test(o.name)) o.layers.enable(HZ_LAYER);
        // (a lot's and the road's paving one surface: its triangles over a bumpy lidar lit alike; at the junctions the road's fans read as dark wedges and radial bands, s6_1755_l, 1790_r; A27: the road's steps are gone, 1785-1800 inner edge 0.10 m over 0.45 m remains, and face lighting still draws bands there, 1790_a, 1790_r)
        if (/^(lot|road)/.test(o.name) && o.geometry.attributes.normal) { const N = o.geometry.attributes.normal; for (let k = 0; k < N.count; k++) N.setXYZ(k, 0, 1, 0); N.needsUpdate = true; }
        // (A32: steep ground away from the sun went near black and showed the terrain's and the verge's triangles against each other, w34_14095_l, w36_13800_l: its normals eased up)
        if (/^(terrain|verge)/.test(o.name) && o.geometry.attributes.normal) { const N = o.geometry.attributes.normal; for (let k = 0; k < N.count; k++) { const x = N.getX(k) * 0.55, y = N.getY(k) * 0.55 + 0.45, z = N.getZ(k) * 0.55, l = Math.hypot(x, y, z) || 1; N.setXYZ(k, x / l, y / l, z / l); } N.needsUpdate = true; }
        // (A32, w48_13050_a: the battery's road faces in the game's shade read blue, its doors dark: nearly up-facing normals, the colour warmed; the photo's pale stained concrete)
        if (/^posts_bat/.test(o.name) && o.geometry.attributes.normal) { const N = o.geometry.attributes.normal; for (let k = 0; k < N.count; k++) { const x = N.getX(k) * 0.3, y = N.getY(k) * 0.3 + 0.7, z = N.getZ(k) * 0.3, l = Math.hypot(x, y, z) || 1; N.setXYZ(k, x / l, y / l, z / l); } N.needsUpdate = true; if (o.material?.color && !o.material.userData.w32) { o.material.userData.w32 = 1; o.material.color.multiply(new THREE.Color(1.0, 0.95, 0.82)); } }
        // (A29: the concrete's sunlit look in the morning photos, t4_13050_a, cz_11050_a: the game's sun leaves their road faces in shade; normals eased up, no extra cost)
        if (/^posts_(bunker|wc|hut|wblock|wa_|wall1045)/.test(o.name) && o.geometry.attributes.normal) { const N = o.geometry.attributes.normal; for (let k = 0; k < N.count; k++) { const x = N.getX(k) * 0.45, y = N.getY(k) * 0.45 + 0.55, z = N.getZ(k) * 0.45, l = Math.hypot(x, y, z) || 1; N.setXYZ(k, x / l, y / l, z / l); } N.needsUpdate = true; }
        // (the ground round the road and the verges: jw-a19's photo-zoned ground textures, world space)
        if (/^(verge|terrain)/.test(o.name)) { o.material = groundMaterial({ lambert }); o.geometry.deleteAttribute('color'); if (/^verge/.test(o.name)) hasVerge = true; return; }
        if (noExt && /^(terrain_ext|rock_ext|surf)/.test(o.name)) { o.visible = false; return; }
        // (the surf at the ridge's foot: white water, see-through by its vertex alpha, build_conz.py surf)
        if (/^surf/.test(o.name)) { o.material = lambert(foam(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }))); o.receiveShadow = false; return; }
        // (the W-beam's folds lit face by face: smooth normals averaged its profile flat, a pale plank)
        if (/^beam/.test(o.name)) { o.geometry = o.geometry.toNonIndexed(); o.geometry.computeVertexNormals(); }
        const s = o.material, tone = /^road/.test(o.name) && s.name === 'asphalt' ? asphTone(c.s0) : null, mk = tone ? s.name + '|' + tone : s; let m = mats.get(mk);  // (A37: a road's own asphalt tone)
        if (!m) { m = new THREE.MeshLambertMaterial({ color: s.color, vertexColors: !!o.geometry.attributes.color, side: THREE.DoubleSide, polygonOffset: /paint/.test(o.name), polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
          if (tone) m.color.multiply(new THREE.Color(...tone));
          // (the asphalt's grain: Street View 950 m, the paving mid grey with darker and lighter patches metres across and a fine
          // aggregate; the verges mottled)
          if (/lot_dirt|lot_gravel/.test(s.name)) grain(m, 0.32, [1.3, 5.3, 19.7]);
          else if (/asphalt|lot/.test(s.name)) grain(m, 0.11, [1.37, 9.7, 37.3]);
          else if (/wall_stone/.test(s.name)) grain(m, 0.3, [0.35, 0.9, 3.1]);  // (A37: Kirkpatrick Street's rubble stone wall, its stones a hand to a foot across, w_kirkpatrick0)
          if (/^asphalt$|^lot$/.test(s.name)) asphaltWear(m);
          // (galvanised steel: the sky's sheen on its shaded face, Street View: a light W-beam even with the sun behind it)
          if (/wbeam/.test(s.name)) m.emissive = new THREE.Color(0.10, 0.105, 0.11); 
          if (/a31_bk_day/.test(s.name)) m.emissive = new THREE.Color(0.55, 0.56, 0.57);  // (A31: daylight through the tunnel, no sun on it)
          // (A34: the dark information boards near black, 0.5 %, read as holes cut in the view, lv2 0:29 and 1:40: a painted dark brown-green, still dark)
          if (/^(sign_board|a31_bo_board)/.test(s.name)) m.color.setRGB(0.045, 0.055, 0.045);
          m = lambert(m); mats.set(mk, m); }
        o.material = m;
      });
      if (hasVerge) addShoulders(g.scene, lambert);
      into.add(g.scene); into.updateMatrixWorld(true); box.expandByObject(g.scene);
      // (A39: this chunk's ground as heights, yAt: what is drawn there is this mesh, not the tile's 7.5 m grid; kept with the group, counted from when it shows)
      { const t0 = performance.now(); g.scene.updateMatrixWorld(true); for (const re of [/^(terrain(?!_ext)|verge|road|lot)/, /^(terrain_ext|rock_ext)/]) { const R = groundRaster(g.scene, re); if (R) (into.userData.rasters ??= []).push(R); } { const R = groundRaster(g.scene, /^lot/); if (R) (into.userData.lotRasters ??= []).push(R); }  /* (the chunk's own car parks apart: view.js draws no generated car park over one) */ const dt = performance.now() - t0, D = globalThis.__w3; if (D) { const S = (D.handRaster ??= { ms: 0, max: 0, n: 0, cells: 0 }); S.ms += dt; S.max = Math.max(S.max, dt); S.n++; S.cells += (into.userData.rasters ?? []).slice(-2).reduce((q, R) => q + R.nx * R.nz, 0); } }  // (the harness's counters)
      // (the verges' and lots' triangles in world space: the generated ground is pushed under them as under the paving,
      // view.js buildRoads; else its coarse grid stands up through a level verge or a lot)
      into.updateMatrixWorld(true); g.scene.updateMatrixWorld(true);
      g.scene.traverse(o => { if (!o.isMesh || !/^(verge|lot)/.test(o.name)) return; const out = state.push, P = o.geometry.attributes.position, I = o.geometry.index, v = new THREE.Vector3();
        for (let k = 0, n = I ? I.count : P.count; k < n; k++) { v.fromBufferAttribute(P, I ? I.getX(k) : k).applyMatrix4(o.matrixWorld); out.push(v.x, v.y, v.z); } });
      return true;
    }
    // (A39: the hand-built ground's height at a point, the highest of its surfaces there (terrain, verge, road, lot), null where there is none: the chunks' rasters in 64 m cells)
    const rasters = new Map(), RC = 64, rasterList = [];
    const lotRasters = [];
    state.lotAt = (x, z) => { for (const R of lotRasters) if (x >= R.x0 && x <= R.x1 && z >= R.z0 && z <= R.z1 && rasterY(R, x, z) != null) return true; return false; };
    // (A41: the rasters over a box, whole: view.js presses a tile's ground under them, terrain.js pressUnderSteps)
    state.rastersIn = (x0, z0, x1, z1) => rasterList.filter(R => R.x1 >= x0 && R.x0 <= x1 && R.z1 >= z0 && R.z0 <= z1);
    state.yAt = (x, z) => { const L = rasters.get(Math.floor(x / RC) + ',' + Math.floor(z / RC)); if (!L) return null; let best = null; for (const R of L) { const y = rasterY(R, x, z); if (y != null && (best == null || y > best)) best = y; } return best; };
    let busy = false; const D2 = 1800 * 1800;
    // (A23: a group wanted but not in yet: the world is not ready until it is, view.js)
    // (notHere: a chunk within 400 m of the rider not shown yet: what the loading screen waits for; a group further off comes in during the ride)
    const shown = new Set(), all = live;
    state.notHere = () => !state.at || all.some(c => !shown.has(c.i) && (c.cx - state.at[0]) ** 2 + (c.cz - state.at[1]) ** 2 < 160000);
    state.pending = () => !!state.at && [...groups.values()].some(cs => cs.some(c => (c.cx - state.at[0]) ** 2 + (c.cz - state.at[1]) ** 2 < D2));
    state.pump = async () => {
      if (busy || !state.at) return; const [x, z] = state.at; busy = true; state.busy = true;
      try {
        // (A34: the nearest wanted group first, chosen again after each from where the rider is now: in file order the groups round the start
        // could come last, the loading screen held 20 s on the live site, lv2)
        for (;;) { const [x, z] = state.at; let k = null, best = D2;
          for (const [kk, cs_] of groups) for (const c of cs_) { const d = (c.cx - x) ** 2 + (c.cz - z) ** 2; if (d < best) { best = d; k = kk; } }
          if (k == null) break; const cs = groups.get(k); groups.delete(k);
          cs.sort((a, b) => ((a.cx - x) ** 2 + (a.cz - z) ** 2) - ((b.cx - x) ** 2 + (b.cz - z) ** 2));
          const into = new THREE.Group(); into.visible = false; group.add(into);
          // (lastBox: what this group covers, view.js builds again only the tiles it touches; prepare: slow work done in slices before the group shows)
          const box = new THREE.Box3(), covered = []; for (let i = 0; i < cs.length; i++) { for (let j = i + 1, n = Math.min(cs.length, i + ahead()); j < n; j++) fetchChunk(cs[j]); if (await addChunk(cs[i], into, box)) covered.push(cs[i].i); }
          { const will = new Set(cs.map(c => c.i)); ownApply(ownReg(into), i => (shown.has(i) || will.has(i)) && !ownCut.has(i)); }  // (A46: before the buffers go to the GPU)
          await prepare?.(into); state.lastBox = box;
          into.updateMatrixWorld(true); into.updateMatrixWorld = () => {};  // (A32: never moves. three.js walks every child each frame whatever matrixWorldAutoUpdate says: 1.5 ms a frame over 8000 objects)
          for (const R of into.userData.rasters ?? []) { for (let cj = Math.floor(R.z0 / RC); cj <= Math.floor(R.z1 / RC); cj++) for (let ci = Math.floor(R.x0 / RC); ci <= Math.floor(R.x1 / RC); ci++) { const k = ci + ',' + cj; (rasters.get(k) ?? rasters.set(k, []).get(k)).push(R); } rasterList.push(R); }
          for (const R of into.userData.lotRasters ?? []) lotRasters.push(R);
          into.visible = true; for (const c of cs) { shown.add(c.i); state.ranges.push([c.s0, c.s1]); }
          { const L = new Set(); for (const c of cs) for (const e of ownBy.get(c.i) ?? []) L.add(e); if (L.size) ownApply(L, i => shown.has(i) && !ownCut.has(i)); }  // (A46: the shown chunks' ground this group owns)
          cover?.mark(covered); state.ready = true; onLoad(state); }
      } finally { busy = false; state.busy = false; state.settled = true; }
    };
    state.pump();
  }).catch(() => { state.settled = true; });
  return state;
}

// A19 vegetation for the hand-built stretch (app/world/hand/veg.json in the game frame; models veg/<sp>.glb from Poly Haven
// CC0 scans, private tools/blender/assets19.py): <sp>_lod0 the scan's own leaf cards (alpha-cut, normals bent outward) and
// <sp>_lod1 crossed impostor cards (a model with only lod1: the cards at every distance). A22: brush and sage lod0 are
// leaf-cluster cards round a mound (private tools/blender/assets22.py), a few hundred triangles each. Static buffers, written once at
// load: lod1 one InstancedMesh per species and primitive holding every plant; lod0 per 32 m cell, shown while the cell is
// near. Which lod a plant draws in is decided on the GPU by its
// distance to the camera (veg.json lod: { sp: [lod0 metres, last metres] }); update(x, z) only moves that uniform and
// toggles near cells: no matrices are rewritten after load.
// (A39, the owner twice: the plants must not change as the rider nears them. The near model was swapped for crossed cards at 25 to 80 m, a tree 130 to 600 px tall
// turning into another tree. Now the near model itself thins with distance and no swap happens while the plant is large: thin() cuts a part into clusters (a leaf
// card, or a single triangle of a trunk) and ranks them so that any head of the list is spread over the whole plant; at a distance d a plant keeps the share
// (D1 / d)^2 of its clusters, each grown about its own middle so the kept area stays the full model's (the last quarter of the kept ones shrinking to nothing, so
// none pops out). A cluster so keeps the size on screen it has at D1. A cell draws only the head of the index buffer its nearest plant needs (the clusters lie in
// rank order). The cards come in at about 7 times the old distance, the plant a seventh of the height it had at the old swap.)
const PRUNE_HEAD = 'uniform vec2 jwVegPrune; attribute vec4 jwPr;';
const PRUNE_BODY = `#ifdef USE_INSTANCING
  { vec4 jo = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0); float jf = jwVegPrune.x / max(distance(jo.xz, jwVegCam.xz), 1.0); jf = max(jf * jf, jwVegPrune.y);
    if (jf < 1.3333) { float ja = clamp((jf - jwPr.w) / (0.25 * jf), 0.0, 1.0), jk = jf < 1.0 ? 0.875 * jf : 0.75 * jf + (jf - 0.5 - 0.46875 * jf * jf) / (0.25 * jf);
      transformed = jwPr.xyz + (transformed - jwPr.xyz) * sqrt(ja / jk); } }
  #endif`;
function thin(g0) {
  let g = g0, idx = g.index ? g.index.array : null, cl = null, nc = 0, tri = false; const nv0 = g.attributes.position.count, nt = (idx ? idx.length : nv0) / 3;
  if (idx) {  // the mesh's pieces by shared corners: a leaf card is a piece of a few triangles
    const par = new Uint32Array(nv0); for (let i = 0; i < nv0; i++) par[i] = i;
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let t = 0; t < nt; t++) { const a = find(idx[3 * t]), b = find(idx[3 * t + 1]); if (b !== a) par[b] = a; const c = find(idx[3 * t + 2]); if (c !== a) par[c] = a; }
    const id = new Int32Array(nv0).fill(-1), size = []; cl = new Uint32Array(nt); let max = 0;
    for (let t = 0; t < nt; t++) { const r = find(idx[3 * t]); if (id[r] < 0) { id[r] = nc++; size.push(0); } cl[t] = id[r]; if (++size[id[r]] > max) max = size[id[r]]; }
    if (max > 8) cl = null;
  }
  if (!cl) { if (idx) g = g.toNonIndexed(); idx = null; tri = true; nc = nt; cl = new Uint32Array(nt); for (let t = 0; t < nt; t++) cl[t] = t; }  // (a trunk: every triangle on its own)
  const P = g.attributes.position, nv = P.count, vi = idx ? k => idx[k] : k => k;
  const cen = new Float64Array(nc * 3), cn = new Uint32Array(nc), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let t = 0; t < nt; t++) { const c = cl[t]; for (let k = 0; k < 3; k++) { const v = vi(3 * t + k); cen[3 * c] += P.getX(v); cen[3 * c + 1] += P.getY(v); cen[3 * c + 2] += P.getZ(v); } cn[c] += 3; }
  for (let c = 0; c < nc; c++) for (let k = 0; k < 3; k++) { const v = cen[3 * c + k] /= cn[c]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  // (the clusters along a Morton curve through the plant, then ranked by bit reversal of their place on it: the first n are n places evenly along the curve)
  const bits = x => { x &= 0x3ff; x = (x ^ (x << 16)) & 0xff0000ff; x = (x ^ (x << 8)) & 0x0300f00f; x = (x ^ (x << 4)) & 0x030c30c3; return (x ^ (x << 2)) & 0x09249249; };
  const keys = new Float64Array(nc), qz = (c, k) => Math.min(1023, Math.floor(1024 * (cen[3 * c + k] - lo[k]) / Math.max(1e-6, hi[k] - lo[k])));
  for (let c = 0; c < nc; c++) keys[c] = ((bits(qz(c, 0)) | bits(qz(c, 1)) << 1 | bits(qz(c, 2)) << 2) >>> 0) * nc + c;
  keys.sort();
  let B = 0; while ((1 << B) < nc) B++;
  const rank = new Uint32Array(nc); let n = 0;
  for (let r = 0; r < (1 << B); r++) { let j = 0; for (let b = 0; b < B; b++) j |= ((r >> b) & 1) << (B - 1 - b); if (j < nc) rank[keys[j] % nc] = n++; }
  const ends = new Uint32Array(nc + 1); for (let t = 0; t < nt; t++) ends[rank[cl[t]] + 1] += 3;
  for (let i = 0; i < nc; i++) ends[i + 1] += ends[i];
  const out = new (nv > 65535 ? Uint32Array : Uint16Array)(nt * 3), cur = ends.slice(0, nc), pr = new Float32Array(nv * 4);
  for (let t = 0; t < nt; t++) { const c = cl[t], r = rank[c], o = cur[r]; cur[r] += 3;
    for (let k = 0; k < 3; k++) { const v = vi(3 * t + k); out[o + k] = v; pr[4 * v] = cen[3 * c]; pr[4 * v + 1] = cen[3 * c + 1]; pr[4 * v + 2] = cen[3 * c + 2]; pr[4 * v + 3] = r / nc; } }
  g.setIndex(new THREE.BufferAttribute(out, 1)); g.setAttribute('jwPr', new THREE.BufferAttribute(pr, 4)); g.computeBoundingBox(); g.computeBoundingSphere();
  return { geo: g, ends: ends.subarray(1), nc, tri };
}
// (a cell's own geometry over the species' buffers: its own draw range)
const shallow = g => { const s = new THREE.BufferGeometry(); for (const k in g.attributes) s.setAttribute(k, g.attributes[k]); s.setIndex(g.index); s.boundingBox = g.boundingBox; s.boundingSphere = g.boundingSphere; return s; };

export function loadVeg({ scene, renderer = null, base = '/world/hand/', lambert = m => m }) {
  const group = new THREE.Group(); group.name = 'handVeg'; scene.add(group); group.updateMatrixWorld = () => {};  // (A32: every plant mesh an identity matrix at the origin: not walked each frame)
  const DROP = new Set(['brush', 'brushg', 'mat_o', 'mat_g', 'mat_l', 'mat_d', 'mat_r']);  // (and the scrub carpets: they read as rows of corn up the slopes, user 2026-11-05)
  const sets = [], CELL = 32, cam = { value: new THREE.Vector3(1e9, 0, 1e9) }; let own = null, ownMore = [];
  // owns(x, z): inside the corridor this list owns (veg.json own: a 2 m bit grid), where the generated scrub and trees
  // give way; onOwn() once that is known
  const ownCbs = [];
  // (A42: in a bored tunnel's zone the ground is the hill's, the tile's: this list's plants there stood at the old open cutting's level, under the hill, and the
  // generated scrub and trees gave way to them: a bare swath up the hill over the tunnel. Neither there now: its plants left out as a group loads, owns() false)
  let bz_ = null; const boreIn = (x, z) => (bz_ ??= (B => B.length ? boreZone(B) : () => false)(BORED_()))(x, z);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const matAt = (a, i, st = 7) => { m4.compose(v.set(a[st * i], a[st * i + 1], a[st * i + 2]), q.setFromAxisAngle(up, a[st * i + 3]), s.set(a[st * i + 4], a[st * i + 5], a[st * i + 6]));
    if (st === 9) { const e = m4.elements, kx = a[9 * i + 7], kz = a[9 * i + 8]; e[1] += kx * e[0] + kz * e[2]; e[5] += kx * e[4] + kz * e[6]; e[9] += kx * e[8] + kz * e[10]; }  // (A30: a low plant sheared to the slope under it, stride 9)
    return m4; };
  // (a material per part: its range [from, to) metres, the instance outside it moved off screen in the vertex shader;
  // fade: 1 fades out over the range's far end, -1 fades in over its near end, FADE metres either side, by a screen-door
  // dither: lod0 and the impostors cross-faded with no pop)
  // (A38, w_bunker1's right bank: both halves kept the same pixels of the dither, so a plant in the band was half holes, the bright grass behind showing through
  // as a stipple of dots; the impostor now keeps the pixels the near model drops: the plant stays solid through the band)
  const FADE = 5, ranges = [], SPLIT = 96, CELL2 = 128, prunes = []; let forced, dk = 1;
  // (A37, review2: the hand roads' trees cast their shadows on the road and the ground, Street View's shade under the canopy, w_east0, w_east2, w_bunker3;
  // trees only, their near model with its leaves' alpha: the shrubs and domes keep none, on the steep faces those fell as black blots, cz_1105_l)
  /* (A38: and the Tam forest's firs, redwoods and bays, their shade over Panoramic: tam_pan5600; oakt is an oak already) */
  const CAST = /^(oak|cyp|cypress|wood|btree|avc|mcyp|loak|willow|dfir|rwd|bay)/, depths = new Map();
  // (A39: the shadow of a thinned plant is the thinned plant's)
  const pruneDepth = (m, prune) => { if (prune) { m.onBeforeCompile = sh => { sh.uniforms.jwVegCam = cam; sh.uniforms.jwVegPrune = prune.u; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 jwVegCam; ' + PRUNE_HEAD).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + PRUNE_BODY); }; m.customProgramCacheKey = () => 'jw-vegd-prune'; } return m; };
  const depthFor = (src, prune = null) => depths.get(src) ?? depths.set(src, pruneDepth(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: src.map || null, alphaTest: src.map ? 0.5 : 0, side: THREE.DoubleSide }), prune)).get(src);
  function material(src, geo, lo, hi, { round = false, fade = 0, meshNormals = false, prune = null, band = FADE, kind = fade > 0 ? 'm' : fade < 0 ? 'c' : 'k' } = {}) {
    const m0 = new THREE.MeshLambertMaterial({ color: src.color, map: src.map, alphaTest: src.map ? 0.5 : 0, side: THREE.DoubleSide, vertexColors: !!geo.attributes.color });
    const range = { value: new THREE.Vector3(lo, hi, band) }; ranges.push({ range, lo, hi, fade, kind });
    m0.onBeforeCompile = sh => {
      sh.uniforms.jwVegCam = cam; sh.uniforms.jwVegRange = range;
      if (prune) { sh.uniforms.jwVegPrune = prune.u; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + PRUNE_HEAD).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + PRUNE_BODY); }
      // (round: an impostor card lit as the mound it shows, its normal from the plant's middle: a sunlit side and a shaded
      // side whatever way the card faces)
      if (round) {
        geo.computeBoundingBox(); const b = geo.boundingBox, cy = (b.min.y + b.max.y) * 0.5, ry = Math.max(0.01, (b.max.y - b.min.y) * 0.5);
        sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', `vec3 objectNormal = normalize(vec3(position.x, (position.y - ${cy.toFixed(3)}) * 1.2 + ${(0.45 * ry).toFixed(3)}, position.z) / ${ry.toFixed(3)});`);
      }
      const f = fade.toFixed(1);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 jwVegCam; uniform vec3 jwVegRange; varying float vJwFade;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vJwFade = 1.0;
          #ifdef USE_INSTANCING
          { vec4 o = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0); float d = distance(o.xz, jwVegCam.xz);
            if (d < jwVegRange.x || d >= jwVegRange.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            if (${f} > 0.5) vJwFade = 1.0 - smoothstep(jwVegRange.y - 2.0 * jwVegRange.z, jwVegRange.y, d);
            if (${f} < -0.5) vJwFade = smoothstep(jwVegRange.x, jwVegRange.x + 2.0 * jwVegRange.z, d); }
          #endif`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vJwFade;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          { float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            if (vJwFade < 0.999 && (${f} < -0.5 ? 1.0 - dn : dn) > vJwFade) discard; }`);
      // (cards and bent leaves: both faces keep the normal, no flip on the back; the scan's own mesh flips as usual)
      if (!meshNormals) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, '').replace(/normal = normal \* faceDirection;/g, ''));
    };
    m0.customProgramCacheKey = () => 'jw-veg19f' + fade + (prune ? 'p' : '') + (meshNormals ? 'm' : '') + (round ? geo.uuid : ''); return lambert(m0);
  }
  // (streamed by stretch as loadHand: veg.json is the head (lod, own, groups: { file, at: chunk centres, species: { sp: count } }); a group's plants,
  // veg/g<k>.bin little-endian floats [x, y, z, rotY, sx, sy, sz] species after species, load when the rider comes within 1800 m of one of its chunks.
  // The work runs in slices of about 3 ms with a pause between: no long task at a group's arrival. Nearest cells first: a cell not built yet is a hole
  // in lod1 near the rider, seen only at a ride's start.)
  let J = null, pumping = false, texDone = false, at = null, lx = 1e9, lz = 1e9, dirty = false; const state = { busy: true };
  const groups = [], models = new Map(), loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  let t0 = 0; const breath = async () => { if (performance.now() - t0 < 3) return; await new Promise(r => setTimeout(r, 6)); t0 = performance.now(); };
  // (a species' model and materials once, shared by its groups: no second shader compile when a group arrives)
  const model = sp => models.get(sp) ?? models.set(sp, loader.loadAsync(base + `veg/${sp}.glb`).catch(() => null).then(g => { if (!g) return null;
    const [near0, far] = J.lod?.[sp] || [30, 450], parts = [[], []];
    g.scene.updateMatrixWorld(true);
    g.scene.traverse(o => { if (!o.isMesh) return; parts[/lod1/.test(o.name) || /lod1/.test(o.parent?.name || '') ? 1 : 0].push({ geo: o.geometry.clone().applyMatrix4(o.matrixWorld), src: o.material }); });
    const near = parts[0].length ? near0 : 0;
    // (A39: the thinned near model out to R1, in two rings of cells (32 m ones to `split`, 128 m ones beyond: the same plant either way); the cards from R1 on)
    const W3 = globalThis.__w3 || {}, R1 = Math.min(far, near * (W3.vegX ?? 7)), band = Math.max(FADE, 0.07 * R1), split = Math.min(SPLIT, R1 * 0.5), mn = !!J.mesh_normals?.[sp];
    for (const p of parts[1]) p.mat = material(p.src, p.geo, near > 0 ? R1 - band : 0, far, { round: /brush|sage/.test(sp), fade: near > 0 ? -1 : 0, band });
    for (const p of parts[0]) { const T = thin(p.geo), d1 = near * (W3.vegD1 ?? 0.5) * (T.tri ? 1.5 : 1); p.geo = T.geo; p.ends = T.ends; p.nc = T.nc; p.prune = { u: { value: new THREE.Vector2(d1 * dk, Math.min(1, 40 / T.nc)) }, d0: d1, d1: d1 * dk }; prunes.push(p.prune); }
    const out_ = { near, R1, band, split, parts, mats: parts[0].map(p => material(p.src, p.geo, 0, split, { meshNormals: mn, prune: p.prune, kind: 'n' })),
      mats2: parts[0].map(p => material(p.src, p.geo, split, R1 + band, { fade: 1, meshNormals: mn, prune: p.prune, band })) };
    // (A35: the bush-tree's leaves a muted olive: as the tall shrubs along Field, Bunker and McCullough they read cartoon lime against Street View's)
    if (/^lime/.test(sp)) for (const m of [...out_.mats, ...out_.mats2, ...parts[1].map(p => p.mat)]) m.color.multiply(new THREE.Color(0.58, 0.6, 0.44));
    // (A37 round 4, review2 w_simmonds1, w_mitchell0, w_east2: the hand roads' cypress and oak read near black cut-outs where Street View's are bright with
    // light through them: lifted, and a share of their own colour as emissive so the shaded side is never black; the willow thicket bright yellow green, w_bunker1/2)
    // (the emissive share only on a textured material: on the oak's vertex coloured fronds an untinted emissive washed them grey white, b2 w_east2)
    const glow = (m, k) => { if (m.map && !m.vertexColors) { m.emissive.copy(m.color).multiplyScalar(k); m.emissiveMap = m.map; } else m.color.multiplyScalar(1 + k * 1.5); };
    if (/^loak/.test(sp)) for (const m of [...out_.mats, ...out_.mats2, ...parts[1].map(p => p.mat)]) { m.color.multiplyScalar(1.3); glow(m, 0.22); }
    // (round 5: the cypress texture carries Street View's own colours and its deep inner shade: lit as built, no glow flattening it, w_mitchell0)
    if (/^mcyp/.test(sp)) for (const m of [...out_.mats, ...out_.mats2, ...parts[1].map(p => p.mat)]) m.color.multiplyScalar(1.15);
    if (/^willow/.test(sp)) for (const m of [...out_.mats, ...out_.mats2, ...parts[1].map(p => p.mat)]) { m.color.multiply(new THREE.Color(0.95, 1.05, 0.62)); glow(m, 0.15); }
    // (A36: the sage read near white beside Conzelman, Street View cz 2025-03 a darker grey green)
    if (sp === 'sage') for (const m of [...out_.mats, ...out_.mats2, ...parts[1].map(p => p.mat)]) m.color.multiply(new THREE.Color(0.5, 0.58, 0.45));
    return out_;
  })).get(sp);
  async function addGroup(G, x, z) {
    /* (A38 Tam cover: the mountain's ground cover with its first plant group, materials.js TAM; never on a Headlands ride) */
    if (/veg\/g5\d\d\.bin$/.test(G.file)) tamCover(base);
    const buf = await fetch(base + G.file).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null); if (!buf) return;
    let off = 0; t0 = performance.now();
    for (const [sp, n0] of Object.entries(G.species)) {
      const st = J.stride?.[sp] || 7, a0 = new Float32Array(buf, off, n0 * st); off += n0 * st * 4;
      let a = a0, n = n0; { let k = 0; for (let i = 0; i < n0; i++) if (!boreIn(a0[st * i], a0[st * i + 2])) k++;
        if (k < n0) { a = new Float32Array(k * st); n = 0; for (let i = 0; i < n0; i++) if (!boreIn(a0[st * i], a0[st * i + 2])) a.set(a0.subarray(st * i, st * i + st), st * n++); state.boreVeg = (state.boreVeg || 0) + n0 - k; } }
      if (!n) continue;
      if (DROP.has(sp)) continue;  // (A33: the round brush domes by the road dropped, user 2026-11-05: 'these bushes so bad just remove them')
      const M = await model(sp); if (!M) continue;
      if (renderer && !M.tex) { M.tex = true; for (const p of [...M.parts[0], ...M.parts[1]]) if (p.src.map) renderer.initTexture(p.src.map); await new Promise(r => setTimeout(r, 30)); }
      t0 = performance.now();
      // lod1: every plant of the group, written once
      for (const p of M.parts[1]) {
        const im = new THREE.InstancedMesh(p.geo, p.mat, n);
        for (let i = 0; i < n; i++) { im.setMatrixAt(i, matAt(a, i, st)); if (!(i & 255)) await breath(); }
        im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true; im.name = 'veg1_' + sp; group.add(im); await breath();
      }
      // lod0: the plants by cell, every cell built now, nearest first
      if (!M.parts[0].length) continue;
      const cellsOf = size => { const cells = new Map(); for (let i = 0; i < n; i++) { const cx = Math.floor(a[st * i] / size), cz = Math.floor(a[st * i + 2] / size), k = cx + ',' + cz; (cells.get(k) ?? cells.set(k, { ids: [], meshes: null, cx: (cx + 0.5) * size, cz: (cz + 0.5) * size }).get(k)).ids.push(i); } return [...cells.values()]; };
      // (A53: lidar canopy on Miller added 231 draw calls for 120k triangles. Larger batches use exact plant distances below; model, scale and thinning stay unchanged.)
      const batch = Array.isArray(G.batch), c0 = batch ? G.batch[0] : CELL, c1 = batch ? G.batch[1] : CELL2;
      const S = { sp, a, st, batch, parts: M.parts[0], tiers: [{ size: c0, mats: M.mats, lo: 0, hi: M.split, cast: true, cells: cellsOf(c0) }, { size: c1, mats: M.mats2, lo: M.split, hi: M.R1 + M.band, cast: false, cells: cellsOf(c1) }] }; sets.push(S);
      await breath();
      const [px, pz] = at ?? [x, z], d2 = c => (c.cx - px) ** 2 + (c.cz - pz) ** 2;
      for (const T of S.tiers) for (const c of [...T.cells].sort((p, q) => d2(p) - d2(q))) { build(S, T, c); await breath(); }
    }
    dirty = true;
  }
  const D2 = 1800 * 1800;
  async function pump() {
    if (pumping || !J || !at) return; pumping = true;
    try {
      // (A28: every species' model and its textures on the GPU when the first group is wanted, under the loading screen for a ride that starts here: a texture is about 15 MB, sent
      // with its mips at the species' first draw it held a frame up by 170 to 220 ms; one species per pause when the rider comes from further off)
      // (A38: only the species of the groups within 5.4 km: a Headlands ride does not load the mountain's trees nor a Tam ride the Headlands' 15 MB scans; a species met later
      // is sent when its first group arrives, in addGroup)
      if (!texDone) { texDone = true; const sps = new Set(); for (const G of groups) if (G && G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < 9 * D2)) for (const sp of Object.keys(G.species)) sps.add(sp);
        for (const sp of sps) { if (DROP.has(sp)) continue; const M = await model(sp); if (!M || !renderer || M.tex) continue; M.tex = true; for (const p of [...M.parts[0], ...M.parts[1]]) if (p.src.map) renderer.initTexture(p.src.map); await new Promise(r => setTimeout(r, 30)); } }
      for (let k = 0; k < groups.length; k++) { const G = groups[k]; if (!G || !G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < D2)) continue;
        groups[k] = null; await addGroup(G, at[0], at[1]); k = -1; }
    } finally { pumping = false; state.busy = false; state.first = true; }  // (first: the plants at the rider's place are in; busy can read false before a position has come)
  }
  const wanted = () => groups.some(G => G && G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < D2));
  fetch(base + 'veg.json').then(r => r.ok ? r.json() : null).then(j => {
    if (!j) return; J = j; groups.push(...(j.groups || []));
    // (A38: own_more: further corridors with bit grids of their own, the Tam climb's at 8 m: one 2 m grid over both the Headlands and the mountain would be megabytes)
    const bitsOf = o => { const b = atob(o.bits), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return { ...o, u }; };
    if (j.own) { own = bitsOf(j.own); ownMore = (j.own_more || []).map(bitsOf); for (const f of ownCbs) f(); }
    if (at) pump();
  }).catch(() => {}).finally(() => { if (!at || !J || !wanted()) state.busy = false; if (!J) state.first = true; });
  function build(S, T, c) {
    c.meshes = S.parts.map((p, k) => {
      const im = new THREE.InstancedMesh(shallow(p.geo), T.mats[k], c.ids.length);
      c.ids.forEach((i, j) => im.setMatrixAt(j, matAt(S.a, i, S.st)));
      im.computeBoundingSphere(); im.boundingSphere.radius += 3;  /* (a thinned plant's clusters are larger) */
      im.castShadow = T.cast && CAST.test(S.sp); if (im.castShadow) im.customDepthMaterial = depthFor(p.src, p.prune); im.receiveShadow = true; im.visible = false; im.name = 'veg0_' + S.sp; group.add(im); return im;
    });
    show(S, T, c, lx, lz);
  }
  // (a cell: shown while one of its plants can be inside its ring, and of each part only the clusters its nearest plant keeps)
  function show(S, T, c, x, z) {
    const full = forced === 0, h = T.size * 0.7072 + 3, dc = Math.hypot(c.cx - x, c.cz - z);
    let near = dc - h, far = dc + h;
    if (S.batch && near < T.hi && far >= T.lo) {
      let n2 = Infinity, f2 = 0;
      for (const i of c.ids) { const dx = S.a[S.st * i] - x, dz = S.a[S.st * i + 2] - z, d2 = dx * dx + dz * dz; n2 = Math.min(n2, d2); f2 = Math.max(f2, d2); }
      near = Math.sqrt(n2) - 3; far = Math.sqrt(f2) + 3;
    }
    const on = full && T.lo > 0 ? true : near < T.hi && far >= T.lo;
    for (let k = 0; k < c.meshes.length; k++) { const m = c.meshes[k]; m.visible = on; if (!on) continue;
      const p = S.parts[k], d = Math.max(1, near, T.lo - 3), fr = full ? 1 : Math.max((p.prune.d1 / d) ** 2, p.prune.u.value.y), nk = Math.min(p.nc, Math.ceil(Math.min(1, fr) * p.nc) + 1);
      m.geometry.setDrawRange(0, p.ends[nk - 1]); }
  }
  // every frame: the camera uniform; near cells shown (only after 3 m of travel: the extra 3 m in R covers it)
  function update(x, z) {
    cam.value.set(x, 0, z);
    // (A38, the owner on the live site: the plants change as the rider nears them. A switch to measure it, globalThis.__w3.vegLod: 0 every plant's near model at every
    // distance, 1 its far cards at every distance, so the two are compared from one camera in one frame; the meshes named veg0_<sp> and veg1_<sp>)
    { const F = globalThis.__w3?.vegLod; if (F !== forced) { forced = F; dirty = true;
        for (const r of ranges) { const k = r.kind; if (k === 'k') continue; if (F === 0) { if (k === 'm') r.range.value.set(r.lo, 1e6); else if (k === 'c') r.range.value.set(1e6, 2e6); else r.range.value.set(r.lo, r.hi); } else if (F === 1) { if (k === 'c') r.range.value.set(-1e6, r.hi); else r.range.value.set(0, 0); } else r.range.value.set(r.lo, r.hi); }
        for (const p of prunes) p.u.value.x = F === 0 ? 1e9 : p.d1; } }  /* (A39: 0 is the full near model, not thinned: the control) */
    if (!dirty && Math.abs(x - lx) + Math.abs(z - lz) < 3) return;
    lx = x; lz = z; dirty = false;
    for (const S of sets) for (const T of S.tiers) for (const c of T.cells) if (c.meshes) show(S, T, c, x, z);
  }
  // (A39: the quality tier's share of the full-detail distance: a weaker computer thins the plants sooner, by the same rule)
  function detail(k) { if (!(k > 0) || k === dk) return; dk = k; for (const p of prunes) { p.d1 = p.d0 * k; if (forced !== 0) p.u.value.x = p.d1; } dirty = true; }
  // (view.js as the rider moves; busy: stats().jobs counts it, so a render waits for the plants)
  function want(x, z) { at = [x, z]; if (!J) return; if (wanted()) { state.busy = true; pump(); } }
  const inOwn = (o, x, z) => { const i = Math.floor((x - o.x0) / o.g), k = Math.floor((z - o.z0) / o.g);
    if (i < 0 || k < 0 || i >= o.w || k >= o.h) return false; const b = k * o.w + i; return !!(o.u[b >> 3] & (1 << (b & 7))); };
  const owns = (x, z) => { if (!own || boreIn(x, z)) return false; if (inOwn(own, x, z)) return true; for (const o of ownMore) if (inOwn(o, x, z)) return true; return false; };
  return { group, update, want, owns, detail, get busy() { return state.busy; }, get first() { return !!state.first; }, onOwn: f => { if (own) f(); else ownCbs.push(f); } };
}

// A19 ground for the hand-built stretch: Poly Haven CC0 scans (private tools/blender/ground19.py; /world/hand/ground.json:
// box [x0, z0, x1, z1] in the game frame, a splat (r dirt, g chert cut, b scrub litter; the rest grass) and one tile per
// layer, each tiled in world metres, no UVs). The cut shows only where the ground is steep (its side projection then);
// a shallow cut zone stays grass. One shared material: groundMaterial({ lambert }) for the verges and the hand terrain.
// (A37: shoulder: the verges' variant, their jwSh attribute's shoulder band; one set of uniforms and textures for both)
// (A38: shell: the scrub shell's own variant (JW_SHELL): it is brush by construction, so no cut face, no dirt, and its mounds' steep sides keep their paint)
// (A38, w_center0: the mown lawn mask on the CPU, scrubcover.png's B over half: view.js keeps its grass clumps off the lawns, their blades stood grey-green on the bright lawn)
let lawnMask = null;
export function lawnAt(x, z) { const m = lawnMask; if (!m) return false; const u = (x - m.b[0]) / (m.b[2] - m.b[0]), v = (z - m.b[1]) / (m.b[3] - m.b[1]); return u >= 0 && u < 1 && v >= 0 && v < 1 && m.d[(v * m.h | 0) * m.w + (u * m.w | 0)] > 127; }
const groundMats = []; let groundMk = null;
export function groundMaterial({ base = '/world/hand/', lambert = m => m, shoulder = false, shell = false } = {}) {
  groundMk ??= groundMaker(base);
  return groundMats[(shoulder ? 1 : 0) + (shell ? 2 : 0)] ??= lambert(groundMk(shoulder, shell));
}
function groundMaker(base) {
  const U = {
    gBox: { value: new THREE.Vector4(0, 0, 1, 1) }, gBoxW: { value: new THREE.Vector4(1e9, 1e9, 1, 1) }, gSplatW: { value: null }, gRep: { value: new THREE.Vector4(3, 7, 4, 6) },
    gSplat: { value: null }, gDirt: { value: null }, gCut: { value: null }, gGrass: { value: null }, gLitter: { value: null }, gScrub: { value: null }, gScrubBox: { value: new THREE.Vector4(0, 0, 1, 1) }, gHill: { value: new THREE.Vector4(1.25, 1.0, 0.1, 0.1) },
    /* (A38 Tam cover: materials.js TAM, shared with the generated terrain) */
    gTam: TAM.tex, gTamBox: TAM.box, gTamOn: TAM.on };
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
  const grey = new THREE.DataTexture(new Uint8Array([104, 120, 66, 255]), 1, 1); grey.colorSpace = THREE.SRGBColorSpace; grey.needsUpdate = true;
  U.gSplat.value = blank; U.gSplatW.value = blank; U.gScrub.value = blank;
  // (A35: the scrub's cover, scrub_shell.py: the lidar's low canopy where NAIP sees plants, 2.8 m cells over every hand road's corridor)
  fetch(base + 'scrub.json').then(r => r.ok ? r.json() : null).then(j => { if (!j?.cover) return; const t = new THREE.TextureLoader().load(base + j.cover.file, t => { try { const im = t.image, cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      const px = g.getImageData(0, 0, im.width, im.height).data, d = new Uint8Array(im.width * im.height); for (let i = 0; i < d.length; i++) d[i] = px[i * 4 + 2]; lawnMask = { d, w: im.width, h: im.height, b: j.cover.box }; } catch (e) {} }); t.flipY = false; t.colorSpace = THREE.NoColorSpace;
    const b = j.cover.box; U.gScrubBox.value.set(b[0], b[1], 1 / (b[2] - b[0]), 1 / (b[3] - b[1])); U.gScrub.value = t; }).catch(() => {}); for (const k of ['gDirt', 'gCut', 'gGrass', 'gLitter']) U[k].value = grey;
  fetch(base + 'ground.json').then(r => r.ok ? r.json() : null).then(j => {
    if (!j) return; const L = new THREE.TextureLoader(), b = j.box; U.gBox.value.set(b[0], b[1], 1 / (b[2] - b[0]), 1 / (b[3] - b[1]));
    const sp = L.load(base + j.splat); sp.flipY = false; sp.colorSpace = THREE.NoColorSpace; U.gSplat.value = sp;
    if (j.west) { const b2 = j.west.box, s2 = L.load(base + j.west.splat); s2.flipY = false; s2.colorSpace = THREE.NoColorSpace; U.gBoxW.value.set(b2[0], b2[1], 1 / (b2[2] - b2[0]), 1 / (b2[3] - b2[1])); U.gSplatW.value = s2; }  // (A22: the west stretch's own map)
    const name = { dirt: 'gDirt', cut: 'gCut', grass: 'gGrass', litter: 'gLitter' }, rep = { dirt: 0, cut: 1, grass: 2, litter: 3 };
    for (const t of j.tiles) {
      const x = L.load(base + t.file); x.wrapS = x.wrapT = THREE.RepeatWrapping; x.colorSpace = THREE.SRGBColorSpace; x.anisotropy = 8; U[name[t.layer]].value = x;
      U.gRep.value.setComponent(rep[t.layer], t.rep);
    }
  }).catch(() => {});
  return (SH, SHELL) => { const m = new THREE.MeshLambertMaterial({ color: 0xffffff }); if (SH || SHELL) m.defines = { ...(SH ? { JW_SH: '' } : {}), ...(SHELL ? { JW_SHELL: '' } : {}) };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U); sh.uniforms.gNoise = { value: textures().noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGdW; varying vec3 vGdN;\n#ifdef JW_SH\nattribute vec3 jwSh; varying vec3 vSh; attribute vec2 jwCt; varying vec2 vCt;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGdW = (modelMatrix * vec4(transformed, 1.0)).xyz; vGdN = normalize(mat3(modelMatrix) * objectNormal);\n#ifdef JW_SH\nvSh = jwSh; vCt = jwCt;\n#endif');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vGdW; varying vec3 vGdN; uniform vec4 gBox; uniform vec4 gRep; uniform vec4 gBoxW; uniform sampler2D gSplatW;
      uniform sampler2D gSplat, gDirt, gCut, gGrass, gLitter, gNoise, gScrub; uniform vec4 gScrubBox; uniform vec4 gHill;
      uniform sampler2D gTam; uniform vec4 gTamBox; uniform float gTamOn;
      // (A37, review2 w_conzelman0/1/4/5: the cut face from one side projection switched by the normal's larger axis stretched along faces
      // near 45 degrees to it; both side projections now, blended by the normal, each with its own derivatives)
      vec3 jwFace(vec2 sd, vec2 dx, vec2 dy, float rp) {
        vec2 sr = mat2(0.62, -0.78, 0.78, 0.62) * sd, rx = mat2(0.62, -0.78, 0.78, 0.62) * dx, ry = mat2(0.62, -0.78, 0.78, 0.62) * dy;
        return (textureGrad(gCut, sd / (rp * 0.45), dx / (rp * 0.45), dy / (rp * 0.45)).rgb + textureGrad(gCut, sd.yx / (rp * 1.15) + 0.37, dx.yx / (rp * 1.15), dy.yx / (rp * 1.15)).rgb + textureGrad(gCut, sr / (rp * 0.7) + 0.71, rx / (rp * 0.7), ry / (rp * 0.7)).rgb) / 3.0; }
      // (A36: the scrub's bushes as round mounds a metre or two across, packed as Street View's coyote brush: a cell each, its centre and size
      // from a hash; the tallest mound under the pixel gives the height and its slope, the slope bends the light, hawk_r9: painted cover read as lawn)
      float jwSW = 0.0; vec2 jwSG = vec2(0.0); float jwBand = 0.0, jwBrush = 0.0;
      #ifdef JW_SH
      varying vec3 vSh; varying vec2 vCt;
      #endif
      vec2 jwH2(vec2 q) { q = mod(q, 289.0); vec3 p3 = fract(vec3(q.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
      vec4 jwBush(vec2 p, float dens) {
        vec2 q = p / 1.4, ic = floor(q); float best = 0.0, id = 0.0; vec2 g = vec2(0.0);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 c = ic + vec2(float(i), float(j)), h = jwH2(c), h2 = jwH2(c + 17.0); if (h2.y > dens) continue;
          vec2 d = p - (c + h) * 1.4; float r = 0.7 + 0.75 * h2.x, t = 1.0 - dot(d, d) / (r * r);
          if (t > 0.0) { float H = r * (0.38 + 0.3 * fract(h.x * 7.13)), tp = pow(max(t, 0.04), 0.6), hh = H * tp;  // (puffy: steep sides, a round top)
            if (hh > best) { best = hh; id = r < 1.1 ? h.x : h.x * 0.8;  /* (A38: an id over 0.82 only on a bush under 2.2 m across: the sage) */ g = -1.2 * H * tp / max(t, 0.04) * d / (r * r); } } }
        return vec4(best, g, id); }
      // (A37, review2 w_conzelman1: the chert's fractures: warped cells about a metre across on the face; x a crack line, y the ledge's
      // shadow just under a crack, z the plate's own id)
      vec3 jwVor(vec2 q) { vec2 ic = floor(q); float f1 = 9.0, f2 = 9.0, id = 0.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 c = ic + vec2(float(i), float(j)), d = q - c - jwH2(c); float e = dot(d, d); if (e < f1) { f2 = f1; f1 = e; id = jwH2(c + 7.0).x; } else if (e < f2) f2 = e; }
        return vec3(sqrt(f1), sqrt(f2) - sqrt(f1), id); }
      vec3 jwCrack(vec2 sd, float aa) { vec2 q = vec2(sd.x / 1.1, sd.y / 0.75);  // (plates wider than tall: the strata)
        vec3 a = jwVor(q), b = jwVor(q + vec2(0.0, 0.2));
        float cr = (1.0 - smoothstep(0.05, 0.13, a.y)) * aa, sh = (1.0 - smoothstep(0.06, 0.22, b.y)) * (1.0 - cr) * aa;
        return vec3(cr, sh, a.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        // (the face's own slope from the surface itself, not the mesh's normals: a smoothed or exported-up normal had hidden
        // the cut faces)
        vec3 n = normalize(cross(dFdx(vGdW), dFdy(vGdW))); if (n.y < 0.0) n = -n; vec2 p = vGdW.xz;
        vec4 w = texture2D(gSplat, (p - gBox.xy) * gBox.zw);
        vec2 buW = (p - gBoxW.xy) * gBoxW.zw; float inW = step(0.0, buW.x) * step(buW.x, 1.0) * step(0.0, buW.y) * step(buW.y, 1.0) * (1.0 - step(gBox.x + 140.0, p.x));
        if (inW > 0.5) w = texture2D(gSplatW, buW);
        // (A34: past both splats, the roads built after Conzelman (McCullough, East Road): the clamped edge texel smeared across them as lime
        // stripes and blotches, mccullough70400; grass with dark scrub litter in patches from the noise instead, no cut, no dirt)
        { vec2 buE = (p - gBox.xy) * gBox.zw; float outAll = (1.0 - inW) * step(0.0001, max(max(-buE.x, buE.x - 1.0), max(-buE.y, buE.y - 1.0)));
          float sN = texture2D(gNoise, p / 23.0 + 0.37).r * 0.6 + texture2D(gNoise, p / 7.0 + 0.61).g * 0.4;
          w = mix(w, vec4(0.0, 0.0, smoothstep(0.44, 0.64, sN) * 0.8, 1.0), outAll); }
        // (breaks the soft zone edges up a little with the grass tile's own tone)
        float rb31 = inW * smoothstep(11434.0, 11437.0, p.x) * (1.0 - smoothstep(11510.0, 11514.0, p.x)) * (1.0 - smoothstep(11441.0, 11444.0, p.y)) * smoothstep(11365.0, 11369.0, p.y);  // (A31: the red bank north of the tunnel is bare: facets read as face, no tufts: green leaf shapes on red, w5_11070_r)
        float steep = smoothstep(0.05, 0.34, 1.0 - n.y);  // (the lidar's 2 m mesh and the verges soften the cuts: 25 degrees and up reads as the face)
        vec2 side = abs(n.x) > abs(n.z) ? vGdW.zy : vGdW.xy;
        // (A33: the lookups inside the per-layer branches take their mip level from these, taken outside them: derivatives inside a branch some pixels skip are undefined, and on a Mac the ground lost its mipmaps, grit far off, user 2026-11-05)
        vec2 dPx = dFdx(p), dPy = dFdy(p), dSx = dFdx(side), dSy = dFdy(side); vec2 sZY = vGdW.zy, sXY = vGdW.xy, dZYx = dFdx(sZY), dZYy = dFdy(sZY), dXYx = dFdx(sXY), dXYy = dFdy(sXY);  /* (A37: the triplanar face's, outside the branch) */ mat2 mSR = mat2(0.62, -0.78, 0.78, 0.62); vec2 dRx = mSR * dSx, dRy = mSR * dSy;
        // (every layer from above on the flat and from the side on a steep face: no streaks down a bank)
        // (A33, perf: each layer only where it shows: the cut, dirt and litter lookups skipped where their weight is nil; same picture, a third of the texture reads on most of the ground)
        // (inside a drawn cut zone the face from about 15 degrees of true surface slope: the zone bounds it along the road,
        // the slope where it ends up the hill)
        // (the zone alone: it gives the face top, a clean line along the road; the terrain mesh's slope inside it is not
        // trusted, its flat facets showed as grass teeth in the face)
        // (the face's top edge ragged as the photo's, scrub and grass reaching down into it: the zone's soft edge broken by noise)
        float wc = smoothstep(0.4, 0.6, w.g + (texture2D(gNoise, p / mix(4.3, 1.3, inW)).r - 0.5) * mix(0.9, 0.6, inW) * (1.0 - step(0.999, w.g)))  /* (A32, west: metre-wide noise stretched up the banks into lime leaf shapes at the cuts' foot, n19_11605_r) */, wd = w.r * (1.0 - wc), wl = w.b * (1.0 - wc);
        // (A37: roadlines.js CUTS: a face the splat lacks where the ground is steep (w_conzelman5, w_mccullough0), or none where it is grass (w_conzelman2))
        #ifdef JW_SH
        { float stC = smoothstep(0.12, 0.3, 1.0 - n.y); wc = mix(wc, max(wc, stC), clamp(vCt.x, 0.0, 1.0)) * (1.0 - clamp(-vCt.x, 0.0, 1.0)); wd = w.r * (1.0 - wc); wl = w.b * (1.0 - wc); }
        #endif
        // (A38, hawkR 37.82645,-122.49934 heading 297: the pale faceted lumps on the upper slope were the scrub shell's own mounds: their steep sides
        // took the splat's cut face and dirt and lost their brush paint. The shell is brush by construction: no cut face, no dirt, its paint whatever its slope)
        #ifdef JW_SHELL
        float shl = 1.0;
        #else
        float shl = 0.0;
        #endif
        wc *= 1.0 - shl; wd *= 1.0 - shl; float stS = steep * (1.0 - shl), lwn = 0.0; vec3 cLw = vec3(0.0);
        vec3 cGrass = texture2D(gGrass, p / gRep.z).rgb; if (steep > 0.002) cGrass = mix(cGrass, texture2D(gGrass, side / gRep.z).rgb, steep);
        float far = smoothstep(40.0, 160.0, length(vGdW - cameraPosition));
        // (A33: metres of ground under one pixel; each fine pattern fades to its mean once it is a few pixels across: far off it read as grit, user 2026-11-05)
        float pxm = length(fwidth(vGdW.xz)); float aaS = 1.0 - smoothstep(0.35, 1.0, pxm), aaM = 1.0 - smoothstep(1.0, 3.0, pxm);
        cGrass = mix(cGrass, texture2D(gGrass, p / (gRep.z * 7.3)).rgb, far * 0.6);
        { float sk = smoothstep(0.5, 0.68, texture2D(gNoise, p / 2.3 + 0.17).g) * smoothstep(0.36, 0.6, texture2D(gNoise, p / 13.0 + 0.41).r);
          cGrass = mix(cGrass, vec3(dot(cGrass, vec3(0.3, 0.55, 0.15))) * vec3(0.8, 0.92, 0.66), sk * 0.75 * aaS); }
        cGrass = mix(cGrass, cGrass * vec3(0.94, 1.14, 0.66) * 1.06, inW * clamp((1.0 - w.a) / 0.5, 0.0, 1.0) * (1.0 - w.r) * (1.0 - w.g));
        { vec2 bu = (p - gBox.xy) * gBox.zw; float outBox = smoothstep(0.0, 0.04, max(max(-bu.x, bu.x - 1.0), max(-bu.y, bu.y - 1.0))) * (1.0 - inW);
          float streak = smoothstep(0.45, 0.7, texture2D(gNoise, vec2(p.x / 38.0, p.y / 9.0) + 0.29).g);
          cGrass = mix(cGrass, cGrass * vec3(0.9, 0.95, 0.66) * (1.0 - 0.2 * streak), outBox); }  // (A34: drier olive, the lime read too bright against Street View, mccullough70400, east80700)
        // (A37, review2 w_bunker1, w_field1/2, w_mccullough2: the hand ground's grass read lime and dark beside Street View's dry hill grass,
        // #8c8561 by pixel medians beside the roads, #9f9f6c on the hills (the generated terrain's measure): half the saturation, drier, lighter)
        { float L37 = dot(cGrass, vec3(0.3, 0.55, 0.15)); cGrass = mix(vec3(L37), cGrass, 0.5) * vec3(1.42, 1.32, 1.22); }
        vec3 c = cGrass;
        // (A37: the shoulder band, its outer edge ragged by the noise a few tenths of a metre: review1 w_bunker1, w_field2, w_mccullough0)
        #ifdef JW_SH
        { float shW = vSh.z * 8.0, shD = (1.0 - vSh.x) * 8.0;
          if (shW > 0.05) { float nE = (textureGrad(gNoise, p / 2.1 + 0.19, dPx / 2.1, dPy / 2.1).r - 0.5) * 0.8 + (textureGrad(gNoise, p / 0.5 + 0.71, dPx / 0.5, dPy / 0.5).g - 0.5) * 0.4 * aaS;
            if (vSh.y < -0.5) { jwBrush = 1.0 - smoothstep(shW - 0.5, shW + 0.5, shD + nE); jwBand = 1.0 - smoothstep(0.25, 0.55, shD + nE * 0.3); }  // (A37, Hawk Hill: the brush down to a rocky lip at the edge, cz_11110_a to cz_11245_a; the verge stands over the lidar there and buried the brush shell)
            else jwBand = 1.0 - smoothstep(shW - 0.15, shW + 0.15, shD + nE * clamp(shW, 0.5, 1.2)); } }
        #endif
        if (wl > 0.002) {
        vec3 cLit = textureGrad(gLitter, p / gRep.w, dPx / gRep.w, dPy / gRep.w).rgb; if (steep > 0.002) cLit = mix(cLit, textureGrad(gLitter, side / gRep.w, dSx / gRep.w, dSy / gRep.w).rgb, steep);
        cLit = mix(cLit, textureGrad(gLitter, p / (gRep.w * 6.1), dPx / (gRep.w * 6.1), dPy / (gRep.w * 6.1)).rgb, far * 0.6);
        { float m1 = textureGrad(gNoise, p / 9.0 + 0.3, dPx / 9.0, dPy / 9.0).g, m3 = textureGrad(gNoise, p / 3.7 + 0.11, dPx / 3.7, dPy / 3.7).b;
          cLit = mix(cLit, vec3(0.2, 0.25, 0.12), smoothstep(0.35, 0.75, m1) * 0.55);
          cLit = mix(cLit, vec3(0.27, 0.30, 0.19), smoothstep(0.4, 0.8, m3) * 0.45 * aaS);
          cLit *= mix(1.0, 0.72, smoothstep(0.6, 0.95, w.b)); cLit *= mix(1.0, 0.62, inW * smoothstep(0.75, 1.0, w.b)); if (inW > 0.5) { cLit = mix(cLit, vec3(0.36, 0.38, 0.28), smoothstep(0.2, 0.85, textureGrad(gNoise, p / 6.0 + 0.23, dPx / 6.0, dPy / 6.0).r) * 0.2); cLit = mix(cLit, vec3(0.13, 0.16, 0.09), smoothstep(0.2, 0.9, textureGrad(gNoise, p / 2.6 + 0.67, dPx / 2.6, dPy / 2.6).g) * 0.2); } }
          c = mix(c, cLit, clamp(wl, 0.0, 1.0)); }
        if (wd > 0.002) {
        vec3 cDirt = textureGrad(gDirt, p / gRep.x, dPx / gRep.x, dPy / gRep.x).rgb; if (steep > 0.002) cDirt = mix(cDirt, textureGrad(gDirt, side / gRep.x, dSx / gRep.x, dSy / gRep.x).rgb, steep);
        cDirt = mix(cDirt, cDirt * vec3(0.92, 0.6, 0.6), clamp((1.0 - w.a) / 0.5, 0.0, 1.0));
          c = mix(c, cDirt, clamp(wd, 0.0, 1.0)); }
        // (A35: the coastal scrub over the grass where the lidar and NAIP see it: Street View's hillsides are solid grey-green brush, ours read as lawn;
        // clumps a metre or two across lit on their tops and dark between, grey sage patches, the cover's edge broken by the noise; not on a cut face)
        { vec2 sb = (p - gScrubBox.xy) * gScrubBox.zw; float sIn = step(0.0, sb.x) * step(sb.x, 1.0) * step(0.0, sb.y) * step(sb.y, 1.0);
          float cov = max(texture2D(gScrub, sb).r * sIn, 0.9 * jwBrush);
          float s1 = textureGrad(gNoise, p / 1.9 + 0.21, dPx / 1.9, dPy / 1.9).r, s2 = textureGrad(gNoise, p / 6.1 + 0.47, dPx / 6.1, dPy / 6.1).g, s3 = textureGrad(gNoise, p / 0.55 + 0.13, dPx / 0.55, dPy / 0.55).b;
          float clumpS = smoothstep(0.3, 0.72, s1 * 0.65 + s2 * 0.35);
          vec3 cS = mix(vec3(0.085, 0.105, 0.055), vec3(0.125, 0.135, 0.095), smoothstep(0.45, 0.75, s2));
          cS *= mix(0.5, 1.12, clumpS) * mix(1.0, mix(0.82, 1.12, s3), aaS);
          float cv = smoothstep(0.12, 0.8, cov + (s2 - 0.5) * 0.7 + (s1 - 0.5) * 0.35); cv = max(cv, 0.45 * smoothstep(0.62, 0.8, s1) * sIn); cv = mix(cv, 1.0, shl * 0.9);  // (A35: ragged edges and scattered bushes in the grass, cz300: hard-edged grass patches)
          float sw = cv * (1.0 - clamp(wd, 0.0, 1.0)) * (1.0 - rb31) * (1.0 - smoothstep(0.85, 1.0, stS) * 0.7);  // (A37: brush on the steep slopes too, only the cut faces bare: Street View hawk)
          if (sw > 0.002) { float bf = (1.0 - smoothstep(0.2, 0.8, pxm)) * smoothstep(0.2, 0.6, max(texture2D(gScrub, sb).g * sIn, jwBrush));  // (the mounds fade to their mean once one is a few pixels across; A37: only where the lidar sees real shrubs, scrubcover G, review1 w_center0 lawns took them as scales)
            vec2 pw = p + (vec2(textureGrad(gNoise, p / 0.8 + 0.41, dPx / 0.8, dPy / 0.8).r, textureGrad(gNoise, p / 0.8 + 0.83, dPx / 0.8, dPy / 0.8).g) - 0.5) * 0.45 * aaS;  // (ragged leafy outlines)
            vec4 bu = jwBush(pw, mix(0.9, 1.0, smoothstep(0.3, 0.9, cov)));
            float top = smoothstep(0.1, 1.0, bu.x), gap = 1.0 - smoothstep(0.0, 0.1, bu.x), foot = smoothstep(0.0, 0.35, bu.x);
            // (A36, hawkR: Street View's coyote brush a fresh mid green, one bush in four or five grey sage; red-brown dirt and dry grass between)
            // (A38, hawkR, w_bunker1: the grey sage bushes were flat pale discs up to 3 m across, grey slabs on the verge at a grazing angle; Street View's sage is the
            // small bushes, grey on their tops and dark green at the foot: only the bushes under 2.2 m, the grey from the foot up)
            float sg = step(0.82, bu.w) * smoothstep(0.04, 0.3, bu.x);
            vec3 cB = mix(vec3(0.062, 0.09, 0.04), vec3(0.085, 0.098, 0.07), sg) * mix(0.8, 1.2, fract(bu.w * 13.7));
            { float l1 = textureGrad(gNoise, p / 0.27 + 0.29, dPx / 0.27, dPy / 0.27).r, l2 = textureGrad(gNoise, p / 0.7 + 0.53, dPx / 0.7, dPy / 0.7).g;
              cB *= mix(1.0, mix(0.35, 1.45, smoothstep(0.2, 0.8, l1 * 0.6 + l2 * 0.4)), aaS); }  // (the leaves: lit sprays and dark holes in each bush)
            cB *= mix(0.55, 1.0, foot) * mix(0.65, 1.2, top);
            // (A38: the brush read near black-green beside Street View's: sunlit slope at w_conzelman3 #8e875c against our #485938, overcast hawkR
            // #575a35 against #4d5b3a; lifted, the red most (Street View's brush has red about equal to green), the grey sage less so it stays grey)
            cB *= mix(vec3(2.2, 1.6, 1.5), vec3(1.55, 1.5, 1.22), sg);
            vec3 cG = mix(vec3(0.16, 0.10, 0.06), vec3(0.17, 0.15, 0.09), smoothstep(0.35, 0.65, s1)) * mix(0.75, 1.1, s3);  // (dirt and dry grass in the gaps)
            // (A38, w_bunker1: the red-brown gaps drew brown blobs all over the left verge where Street View has grass between the bushes; red dirt
            // only under the brush rows at a rocky lip (hawkR), dry grass in the gaps everywhere else)
            cG = mix(mix(vec3(0.105, 0.10, 0.058), vec3(0.15, 0.14, 0.085), smoothstep(0.35, 0.65, s1)) * mix(0.75, 1.1, s3), cG, jwBrush); cB = mix(cB, cG, gap);
            vec3 cFar = mix(vec3(0.055, 0.085, 0.032), vec3(0.08, 0.095, 0.058), smoothstep(0.45, 0.75, s2)) * mix(0.62, 1.12, clumpS);  // (the bushes' and gaps' mean, so near and far brush are one colour)
            cFar *= vec3(2.14, 1.59, 1.52); cS = mix(cFar, cB, bf); sw = max(sw, bf * max(shl, smoothstep(0.4, 0.55, cov)) * (1.0 - stS * 0.7) * (1.0 - rb31));
            // (A38, w_conzelman3 and the lead's review: the hillsides read one even saturated green. Street View's sunlit slopes are lighter and mottled: stands of
            // dark olive coyote brush in paler grey sage and dry grass, 10 to 40 m across, #8a865b (#7d7a4f to #9c9268) against our #656a3e. Two fields of the
            // noise at unlike scales, one turned, so its tile never shows. gHill: lift, mottle, grey, the patches' edge width)
            { vec2 pr = vec2(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6), prx = vec2(dPx.x * 0.8 + dPx.y * 0.6, dPx.y * 0.8 - dPx.x * 0.6), pry = vec2(dPy.x * 0.8 + dPy.y * 0.6, dPy.y * 0.8 - dPy.x * 0.6);
              float hk = smoothstep(0.5 - gHill.w, 0.5 + gHill.w, textureGrad(gNoise, p / 97.0 + 0.19, dPx / 97.0, dPy / 97.0).a * 0.55 + textureGrad(gNoise, pr / 41.0 + 0.71, prx / 41.0, pry / 41.0).a * 0.45);
              cS *= gHill.x * mix(vec3(1.0), mix(vec3(0.84, 0.92, 0.74), vec3(1.16, 1.1, 1.3), hk), gHill.y); cS = mix(cS, vec3(dot(cS, vec3(0.3, 0.55, 0.15))), gHill.z); }
            jwSW = sw * bf * (1.0 - gap) * mix(0.45, 1.1, jwBrush) * (1.0 - smoothstep(0.3, 0.9, pxm));  /* (A37, hawkR: the brush rows' bushes lit as mounds) */ jwSG = clamp(bu.yz, vec2(-2.5), vec2(2.5)); }  // (A37: the bent light weak, and gone at a grazing angle: on the flat ground it drew the painted mounds as dark shingles, w_field1)
          // (A38, w_center0: the mown lawns (scrubcover.png's B, from scrub_shell.py's LAWN_SEEDS) a bright even green with no brush and no dry
          // patches: Street View's Fort Baker parade ground in the sun is #aab754, ours read dull olive #8b9066 with scrub mounds)
          lwn = texture2D(gScrub, sb).b * sIn;
          if (lwn > 0.002) { cLw = vec3(0.36, 0.42, 0.095) * mix(0.9, 1.08, s2) * mix(1.0, mix(0.9, 1.1, s3), aaS); c = mix(c, cLw, lwn); sw *= 1.0 - lwn; jwSW *= 1.0 - lwn; }
          c = mix(c, cS, sw * (1.0 - jwBand)); jwSW *= 1.0 - jwBand; }
        // >>> A38 Tam cover (tam-veg) begin. gTamOn is 0 until a Tam plant group (veg g500 and up) loads: nothing in this block runs on a Headlands ride.
        // (materials.js TAM: the lidar's canopy and NAIP as cover, r trees, g brush, b bare; the same colours as jwGround's Tam block so the hand ground
        // and the generated ground meet. Street View tam_pan5600: dark brown duff and ferns under the firs; tam_ridge3500: olive chaparral to the road's
        // edge; tam_shore3000: spring grass on the open banks, lit median #90995e. The shoulder band and the cut faces are drawn over it below.)
        if (gTamOn > 0.5) { vec2 tb = (p - gTamBox.xy) * gTamBox.zw; float tIn = step(0.0, tb.x) * step(tb.x, 1.0) * step(0.0, tb.y) * step(tb.y, 1.0);
          #define JW_TS(r, g, b) pow(vec3(r, g, b), vec3(2.2))
          float t8 = textureGrad(gNoise, p / 66.0 + 0.63, dPx / 66.0, dPy / 66.0).g, t17 = textureGrad(gNoise, p / 70.0 + 0.23, dPx / 70.0, dPy / 70.0).b, t2 = textureGrad(gNoise, p / 9.0 + 0.19, dPx / 9.0, dPy / 9.0).b, t03 = textureGrad(gNoise, p / 2.3 + 0.27, dPx / 2.3, dPy / 2.3).g;
          vec3 tv = texture2D(gTam, clamp(tb + (vec2(t8, t2) - 0.5) * 5.0 * gTamBox.zw, 0.0, 1.0)).rgb; vec3 lw38 = vec3(0.3, 0.55, 0.15);
          float kT = smoothstep(0.25, 0.6, tv.r + (t17 - 0.5) * 0.25), kB = smoothstep(0.25, 0.6, tv.g + (t17 - 0.5) * 0.3) * (1.0 - kT), kE = smoothstep(0.3, 0.65, tv.b + (t8 - 0.5) * 0.2) * (1.0 - kT) * (1.0 - kB);
          /* (the grass tile's own blades and the litter's and dirt's grain as light and dark in each colour) */
          float gG = mix(1.0, clamp(dot(cGrass, lw38) / 0.21, 0.65, 1.4), 0.8), gL = mix(1.0, clamp(dot(textureGrad(gLitter, p / gRep.w, dPx / gRep.w, dPy / gRep.w).rgb, lw38) / 0.14, 0.55, 1.5), aaS), gD = mix(1.0, clamp(dot(textureGrad(gDirt, p / gRep.x, dPx / gRep.x, dPy / gRep.x).rgb, lw38) / 0.21, 0.6, 1.4), aaS);
          vec3 tGrass = mix(JW_TS(0.47, 0.52, 0.32), JW_TS(0.55, 0.55, 0.38), smoothstep(0.3, 0.7, t17)) * gG;
          vec3 tBrush = mix(JW_TS(0.27, 0.31, 0.19), JW_TS(0.39, 0.42, 0.27), smoothstep(0.3, 0.7, t8)) * mix(0.62, 1.15, smoothstep(0.3, 0.72, t2)) * mix(1.0, mix(0.75, 1.2, t03), aaS);
          vec3 tBare = mix(JW_TS(0.55, 0.48, 0.36), JW_TS(0.47, 0.37, 0.28), smoothstep(0.35, 0.7, t17)) * gD;
          vec3 tDuff = mix(JW_TS(0.37, 0.30, 0.22), JW_TS(0.30, 0.24, 0.18), smoothstep(0.3, 0.7, t2)) * gL;
          tDuff = mix(tDuff, JW_TS(0.27, 0.35, 0.17) * mix(1.0, mix(0.7, 1.3, t03), aaS), smoothstep(0.58, 0.78, t8) * 0.65);
          vec3 tCan = mix(JW_TS(0.15, 0.21, 0.12), JW_TS(0.25, 0.32, 0.17), smoothstep(0.3, 0.7, t8)) * (1.0 - 0.35 * smoothstep(0.55, 0.8, t17));
          float tNear = 1.0 - smoothstep(90.0, 142.0, length(vGdW - cameraPosition));
          vec3 tc = mix(mix(mix(tGrass, tBrush, kB), tBare, kE), mix(tCan, tDuff, tNear), kT);
          c = mix(c, tc, tIn * (1.0 - jwBand)); jwSW *= 1.0 - tIn; }
        // <<< A38 Tam cover (tam-veg) end
        #ifdef JW_SH
        // (A37: the shoulder's own surface: short saturated grass, or tan gravel, or red-brown dirt with a few tufts, the dirt
        // greening into the scrub at its outer edge; Street View cz_33430_a, w_mitchell1, w_mccullough0, w_conzelman3)
        if (jwBand > 0.002) {
          float m1 = textureGrad(gNoise, p / 3.1 + 0.37, dPx / 3.1, dPy / 3.1).r, m2 = textureGrad(gNoise, p / 0.35 + 0.53, dPx / 0.35, dPy / 0.35).g, k = vSh.y < -0.5 ? 0.45 : vSh.y;
          vec3 gS = textureGrad(gGrass, p / gRep.z, dPx / gRep.z, dPy / gRep.z).rgb; float gl = clamp(dot(gS, vec3(0.3, 0.55, 0.15)) / 0.35, 0.4, 1.6);
          // (A38, w_bunker1, h_bunker1: Street View's strip beside the valley roads is lush bright grass, #8d9144 to #a2a759 in the sun; ours read a dull #525831)
          vec3 cSg = vec3(0.27, 0.32, 0.09) * mix(1.0, gl, aaS * 0.7) * mix(0.85, 1.15, m1);
          cSg = mix(cSg, cLw, lwn);
          vec3 cTan = mix(vec3(0.29, 0.25, 0.21), vec3(0.36, 0.31, 0.26), mix(0.5, m2, aaS)) * mix(0.85, 1.12, m1);
          vec3 cRed = mix(vec3(0.23, 0.18, 0.145), vec3(0.29, 0.225, 0.18), mix(0.5, m2, aaS)) * mix(0.85, 1.12, m1);
          // (A37, review2 w_mccullough2, w_mitchell1: Street View's dirt shoulder grey-brown, #555149 to #877e70 by pixel medians, not salmon; darker at the asphalt)
          // (A38, w_conzelman3: kind 'o', the dirt under an orange soil cut is the cut's own washed-down soil, orange-tan #a88b6c in the sun; the grey-brown
          // dirt read #79756f, a grey band under the orange face)
          vec3 cOr = mix(vec3(0.33, 0.215, 0.13), vec3(0.42, 0.28, 0.165), mix(0.5, m2, aaS)) * mix(0.85, 1.12, m1);
          vec3 cD = mix(mix(cTan, cRed, smoothstep(0.6, 0.9, k)), cOr, smoothstep(1.1, 1.4, k)) * mix(0.78, 1.0, smoothstep(0.0, 1.2, (1.0 - vSh.x) * 8.0));
          cD = mix(cD, cSg, smoothstep(0.62, 0.8, m2) * 0.35 * aaS + smoothstep(0.55, 1.0, (1.0 - vSh.x) / max(vSh.z, 0.01)) * 0.45);
          c = mix(c, mix(cSg, cD, smoothstep(0.2, 0.3, k)), jwBand); }
        #endif
        if (wc > 0.002) {
        // mixed; grey-green tufts in clumps over it)
        // (three lookups at different angles and scales: the scan's level strata averaged out into fractured rock)
        vec2 sr = mat2(0.62, -0.78, 0.78, 0.62) * side;
        float wX = pow(abs(n.x), 4.0), wZ = pow(abs(n.z), 4.0), wb = wX / max(wX + wZ, 1e-4);
        vec3 cFace = mix(jwFace(sXY, dXYx, dXYy, gRep.y), jwFace(sZY, dZYx, dZYy, gRep.y), wb);
        // (A37, review2 w_conzelman1: orange-red chert broken in plates, crisp dark fractures, a shadow under each ledge, some plates grey or pale)
        { vec2 wq = (vec2(textureGrad(gNoise, side / 3.1 + 0.13, dSx / 3.1, dSy / 3.1).r, textureGrad(gNoise, side / 3.1 + 0.57, dSx / 3.1, dSy / 3.1).g) - 0.5) * 0.7;
          float aaC = 1.0 - smoothstep(0.08, 0.25, length(abs(dSx) + abs(dSy)));  /* (the face's own metres per pixel: the ground plane's read grazing on a steep face) */
          vec3 kA = jwCrack(sXY + wq, aaC), kB = jwCrack(sZY + wq, aaC), k37 = mix(kA, kB, wb);
          float pid = wb > 0.5 ? kB.z : kA.z, L37 = dot(cFace, vec3(0.3, 0.55, 0.15));
          vec3 plate = pid < 0.84 ? vec3(2.35, 1.4, 0.8) : pid < 0.93 ? vec3(1.2, 1.15, 1.08) : vec3(1.5, 1.32, 1.12);  /* (A37: lit chert #a47856 by Street View pixel medians, w_conzelman1; ours read #766450. A38, w_conzelman1, a0_ctl: the faces still read grey-purple and green beside Street View's orange-red: more of the plates red and stronger, fewer grey plates, patches, tufts and clumps) */
          cFace = mix(cFace, vec3(L37) * plate * 1.15, 0.82 * (1.0 - rb31));
          cFace *= mix(1.0, 0.22, k37.x) * mix(1.0, 0.55, k37.y);
          // (grey-green tufts on the ledges: on the plate just over a fracture, in clumps)
          float tf = k37.y * smoothstep(0.55, 0.72, textureGrad(gNoise, side / 1.7 + 0.31, dSx / 1.7, dSy / 1.7).g) * aaC;
          cFace = mix(cFace, vec3(0.30, 0.34, 0.22) * mix(0.8, 1.2, textureGrad(gNoise, side / 0.4 + 0.77, dSx / 0.4, dSy / 0.4).r), tf * 0.4 * (1.0 - rb31)); }
        // (cz_1105_a: pale weathered rock showing through the red in patches a metre or two across)
        cFace = mix(cFace, vec3(0.50, 0.44, 0.38) * (0.8 + 0.4 * textureGrad(gNoise, side / 0.6, dSx / 0.6, dSy / 0.6).b), 0.14 * smoothstep(0.66, 0.74, textureGrad(gNoise, side / 1.7 + 0.51, dSx / 1.7, dSy / 1.7).b));
        // (A32, n9_505_a, w61_11010_r: the photos' cuts ribbed and broken: ribs down the fall line a few metres apart, crossed fractures, small dark gaps between stones; no extra geometry)
        if (steep > 0.01) { float r32a = smoothstep(0.34, 0.68, textureGrad(gNoise, vec2(side.x / 5.5, side.y / 34.0) + 0.21, vec2(dSx.x / 5.5, dSx.y / 34.0), vec2(dSy.x / 5.5, dSy.y / 34.0)).r), r32b = smoothstep(0.38, 0.72, textureGrad(gNoise, vec2(sr.x / 1.7, sr.y / 9.0) + 0.33, vec2(dRx.x / 1.7, dRx.y / 9.0), vec2(dRy.x / 1.7, dRy.y / 9.0)).g), r32c = smoothstep(0.3, 0.6, textureGrad(gNoise, side / 0.42 + 0.17, dSx / 0.42, dSy / 0.42).b);
          cFace *= mix(0.62, 1.22, r32a * 0.55 + r32b * 0.45) * mix(0.78, 1.06, r32c); }
        vec3 cTop31 = (textureGrad(gCut, p / (gRep.y * 0.45), dPx / (gRep.y * 0.45), dPy / (gRep.y * 0.45)).rgb + textureGrad(gCut, p.yx / (gRep.y * 1.15) + 0.37, dPx.yx / (gRep.y * 1.15), dPy.yx / (gRep.y * 1.15)).rgb + textureGrad(gCut, p / (gRep.y * 0.7) + 0.71, dPx / (gRep.y * 0.7), dPy / (gRep.y * 0.7)).rgb) / 3.0;  // (A31: the face's own mix, on the ground plane: no stretch on the bank's flat facets, w8_11050_r; no plain dirt, w9_11050_r)
        // (A32, w61_11010_r, cz_11050_r: the banks' stone in thin slanted layers, broken along them, loose stones between; on the bank's flat facets too)
        if (rb31 > 0.0) { vec2 q32 = mat2(0.87, -0.5, 0.5, 0.87) * p + (vec2(textureGrad(gNoise, p / 19.0 + 0.3, dPx / 19.0, dPy / 19.0).r, textureGrad(gNoise, p / 7.0 + 0.6, dPx / 7.0, dPy / 7.0).g) - 0.5) * 9.0;  // (warped: straight rows read as a weave, n11_11050_r)
          float s32 = smoothstep(0.3, 0.62, textureGrad(gNoise, vec2(q32.x / 13.0, q32.y / 1.5) + 0.41, vec2(dPx.x / 13.0, dPx.y / 1.5), vec2(dPy.x / 13.0, dPy.y / 1.5)).r), t32 = smoothstep(0.32, 0.6, textureGrad(gNoise, vec2(q32.x / 3.4, q32.y / 0.5) + 0.77, vec2(dPx.x / 3.4, dPx.y / 0.5), vec2(dPy.x / 3.4, dPy.y / 0.5)).g), u32 = smoothstep(0.34, 0.62, textureGrad(gNoise, p / 0.38 + 0.11, dPx / 0.38, dPy / 0.38).b);
          cTop31 *= mix(0.66, 1.24, s32 * 0.5 + t32 * 0.5) * mix(0.76, 1.08, u32); }
        vec3 cCut = mix(mix(textureGrad(gCut, p / gRep.y, dPx / gRep.y, dPy / gRep.y).rgb, cTop31, rb31), cFace, steep);
        // (the tufts' clumps and blades from the game's noise texture: its values spread evenly, unlike a grass tile's)
        // (cz_1105_l: green scrub patches over about a quarter of the face)
        { float clump = smoothstep(0.52, 0.64, textureGrad(gNoise, side / 7.0 + 0.13, dSx / 7.0, dSy / 7.0).r), blade = smoothstep(0.45, 0.65, textureGrad(gNoise, side / 0.9, dSx / 0.9, dSy / 0.9).g);
          // (A22, a19g_1105_l: the tufts grey-green sage and dry grass, not lime: the grass tile half greyed, its green held back)
          vec3 tg = textureGrad(gGrass, side / 0.9, dSx / 0.9, dSy / 0.9).rgb; vec3 tuft = mix(vec3(dot(tg, vec3(0.3, 0.55, 0.15))), tg, 0.45) * vec3(1.02, 1.08, 0.9);
          cCut = mix(cCut, tuft, clump * blade * 0.35 * steep * (1.0 - rb31) * mix(0.35, 1.0, clamp((w.a - 0.4) / 0.6, 0.0, 1.0))); }  // (A32, n11_11605_r: fewer pale tufts on the dark rock)
        // (the splat's alpha below 1: the chert dark grey-brown there, cz_1205_l, cz_1380_l)
        cCut = mix(cCut, vec3(dot(cCut, vec3(0.3, 0.55, 0.15))) * vec3(0.92, 0.86, 0.80) * 0.62, 0.8 * clamp((1.0 - w.a) / 0.6, 0.0, 1.0));  // (A32: darker, n11_11605_r)
        // (A37, review1 w_conzelman0/1: the faces were one red-brown smear; Street View's are red chert, grey chert and weathered pale
        // grey-pink rock in patches metres across, fractured, with green clumps on the ledges)
        { float tA = textureGrad(gNoise, p / 13.0 + 0.27, dPx / 13.0, dPy / 13.0).r, tB = textureGrad(gNoise, side / 4.5 + 0.61, dSx / 4.5, dSy / 4.5).g;
          float L = dot(cCut, vec3(0.3, 0.55, 0.15)); vec3 cGrey = vec3(L) * vec3(0.95, 0.96, 1.0) * 1.2, cPale = mix(vec3(L) * 1.2, vec3(0.62, 0.50, 0.46), 0.6) * mix(0.8, 1.1, tA);
          float gW = smoothstep(0.55, 0.75, tA * 0.7 + tB * 0.3) * 0.2, pW = smoothstep(0.66, 0.84, tB) * 0.18;
          #ifdef JW_SH
          if (vCt.x > 0.5) { gW = max(gW, step(0.25, vCt.y) * step(vCt.y, 0.75) * 0.8); pW = max(pW, step(0.75, vCt.y) * mix(0.35, 0.7, tB)); }
          #endif
          cCut = mix(cCut, cGrey, gW * (1.0 - rb31)); cCut = mix(cCut, cPale, pW * (1.0 - rb31));
          float gc = smoothstep(0.56, 0.7, textureGrad(gNoise, side / 2.2 + 0.43, dSx / 2.2, dSy / 2.2).r) * smoothstep(0.35, 0.6, textureGrad(gNoise, p / 8.0 + 0.19, dPx / 8.0, dPy / 8.0).g);
          cCut = mix(cCut, vec3(0.15, 0.21, 0.075) * mix(0.7, 1.25, tB), gc * 0.4 * (1.0 - rb31)); }
        // (A38, w_conzelman3: roadlines.js CUTS tone 'o': a crumbling orange chert and soil face, Street View's #c0986f in the sun (#b78e65 to #c9a179), rust patches
        // metres across, small dark stones, a few grey-green tufts; the plated rock read grey #857d64 there)
        // (A38, tam_517000: tone 't', Mount Tam's cut banks: tan-brown broken soil and sandstone, #7d7058 under Street View's overcast (#695c45 to #8d8068), grass and
        // fern tufts #515637 over a third of it; no red chert on the mountain: the red plates read dark grey-blue with green blobs there)
        #ifdef JW_SH
        float soil = clamp(-vCt.y, 0.0, 1.0), tamK = clamp(-vCt.y - 1.0, 0.0, 1.0);
        #else
        float soil = 0.0, tamK = 0.0;
        #endif
        if (soil > 0.002) {
          float g1 = textureGrad(gNoise, side / 0.23 + 0.31, dSx / 0.23, dSy / 0.23).r, g2 = textureGrad(gNoise, side / 1.9 + 0.67, dSx / 1.9, dSy / 1.9).g, g3 = textureGrad(gNoise, side / 5.3 + 0.12, dSx / 5.3, dSy / 5.3).b;
          vec3 cSoil = mix(mix(vec3(0.49, 0.285, 0.158), vec3(0.29, 0.225, 0.135), tamK), mix(vec3(0.39, 0.18, 0.088), vec3(0.20, 0.145, 0.085), tamK), smoothstep(0.38, 0.7, g3 * 0.65 + g2 * 0.35)) * mix(0.9, 1.08, g2);
          cSoil *= mix(1.0, mix(0.78, 1.12, g1), aaS) * mix(1.0, 0.62, smoothstep(0.76, 0.86, textureGrad(gNoise, side / 0.37 + 0.55, dSx / 0.37, dSy / 0.37).g) * aaS);
          float tS = smoothstep(mix(0.64, 0.5, tamK), mix(0.78, 0.64, tamK), textureGrad(gNoise, side / 2.6 + 0.83, dSx / 2.6, dSy / 2.6).r) * smoothstep(mix(0.4, 0.25, tamK), mix(0.6, 0.45, tamK), textureGrad(gNoise, side / 0.5 + 0.29, dSx / 0.5, dSy / 0.5).g);
          cSoil = mix(cSoil, mix(vec3(0.20, 0.24, 0.13), vec3(0.12, 0.155, 0.055), tamK), tS * 0.85);
          cCut = mix(cCut, cSoil, soil * 0.88); }
          c = mix(c, cCut, clamp(wc * (1.0 - jwBand * (1.0 - steep)), 0.0, 1.0)); }
        // (A37: the picnic cypress's painted shade pools and trunk shadows gone: the hand trees cast real shadows now, 05587f3)
        if (p.x > 8935.0 && p.x < 8995.0 && p.y > 11625.0 && p.y < 11695.0) c *= vec3(1.28, 1.42, 1.0);  // (the picnic's watered lawn bright lime in the sun, cz_14255_l; its old pools' lit tone kept)
        diffuseColor.rgb *= c;
      }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      if (jwSW > 0.001) normal = normalize(normal + (viewMatrix * vec4(-jwSG.x, 0.0, -jwSG.y, 0.0)).xyz * jwSW);`);
  };
  m.customProgramCacheKey = () => 'jw-hand-ground24' + (SH ? 'sh' : '') + (SHELL ? 'sl' : '');
  return m; };
}
