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
import { HZ_LAYER } from './horizon.js';
import { shoulderAt, cutAt } from './roadlines.js';
import { compileSpec } from './conzelman.js';
import { makeProj } from './geo.js';

// (A37) the shoulder on the verges: each verge vertex's distance from the paved edge (the chunk's road triangles' edges: the
// nearest point of the paving from outside it is on its boundary, so every triangle edge serves) and its road's shoulder
// (roadlines.js SHOULDERS by the nearest station and the verge's side) as attribute jwSh: x 1 at the edge to 0 at 8 m, y the
// kind (0 grass, 0.5 tan gravel, 1 red dirt), z the width / 8. The hand terrain has none: no shoulder there.
let SPEC_ = null; const PROJ_ = makeProj(37.93, -122.63), spec_ = () => SPEC_ ??= compileSpec(PROJ_);
const SHK = { g: 0, t: 0.5, d: 1, b: -1 }, CTK = { r: [1, 0], g: [1, 0.5], p: [1, 1], x: [-1, 0] };  // (jwCt: x 1 a cut face, -1 none; y its tone)  // (b: brush to the edge past a thin rocky lip, the cover forced on)
function addShoulders(root, lambert) {
  root.updateMatrixWorld(true); const v = new THREE.Vector3(), cells = new Map(), C = 4, S = [];
  root.traverse(o => { if (!o.isMesh || !/^road\d/.test(o.name)) return; const P = o.geometry.attributes.position, I = o.geometry.index; if (!I) return;
    const W = new Float32Array(P.count * 2); for (let k = 0; k < P.count; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); W[2 * k] = v.x; W[2 * k + 1] = v.z; }
    for (let t = 0; t + 2 < I.count; t += 3) for (let e = 0; e < 3; e++) { const a = I.getX(t + e), b = I.getX(t + (e + 1) % 3), n = S.length; S.push(W[2 * a], W[2 * a + 1], W[2 * b], W[2 * b + 1]);
      const x0 = Math.floor(Math.min(W[2 * a], W[2 * b]) / C), x1 = Math.floor(Math.max(W[2 * a], W[2 * b]) / C), z0 = Math.floor(Math.min(W[2 * a + 1], W[2 * b + 1]) / C), z1 = Math.floor(Math.max(W[2 * a + 1], W[2 * b + 1]) / C);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const k = i * 100003 + j; (cells.get(k) ?? cells.set(k, []).get(k)).push(n); } } });
  if (!S.length) return;
  const dist = (x, z) => { let best = 64; const ci = Math.floor(x / C), cj = Math.floor(z / C);  /* (squared, numeric cell keys: A37 load profile) */
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { const L = cells.get((ci + a) * 100003 + cj + b); if (!L) continue; for (let m = 0; m < L.length; m++) { const n = L[m];
      const ax = S[n], az = S[n + 1], ex = S[n + 2] - ax, ez = S[n + 3] - az, L2 = ex * ex + ez * ez, f = L2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)) : 0, dx = x - ax - ex * f, dz = z - az - ez * f, d = dx * dx + dz * dz; if (d < best) best = d; } }
    return Math.sqrt(best); };
  const Z = spec_();
  // (the hand terrain too, its side of the line from the line's own direction there: where no verge is built, and Hawk Hill's
  // brush ('b') up the slope past the verge, sh_hawk: the cover map has it as grass)
  const sideOf = (x, z, s) => { const [a0, o0] = Z.latlon(s - 1), [a1, o1] = Z.latlon(s + 1), [x0, z0] = PROJ_.xz(a0, o0), [x1, z1] = PROJ_.xz(a1, o1); return (x - x0) * -(z1 - z0) + (z - z0) * (x1 - x0) > 0 ? 'R' : 'L'; };
  root.traverse(o => { const ve = /^verge\d+[LR]$/.test(o.name); if (!o.isMesh || !(ve || /^terrain\d/.test(o.name))) return; const P = o.geometry.attributes.position, A = new Float32Array(P.count * 3), B = new Float32Array(P.count * 2);
    for (let k = 0; k < P.count; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); const q = Z.near(v.x, v.z, 40); if (!q || q.s < 0) continue; const sd = ve ? o.name.slice(-1) : sideOf(v.x, v.z, q.s), ct = CTK[cutAt(q.s, sd, q.d)]; if (ct) { B[2 * k] = ct[0]; B[2 * k + 1] = ct[1]; } const sh = shoulderAt(q.s, sd); if (!sh || (!ve && q.d > 25 && sh[0] !== 'b')) continue;
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
  110000: [0.75, 0.79, 0.91], 130000: [1.0, 0.99, 1.03], 280000: [1.13, 1.17, 1.20] };
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
          diffuseColor.rgb *= (1.0 - 0.12 * patchT) * (1.0 + 0.05 * worn) * (1.0 - 0.3 * seam) * (1.0 - 0.15 * crack); }`);
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

export function loadHand({ scene, base = '/world/hand/', lambert = m => m, onLoad = () => {}, prepare = null }) {
  const group = new THREE.Group(); group.name = 'hand'; scene.add(group);
  // (A23: streamed by stretch: a group of chunks loads when the rider comes within 1800 m of one of them; a ride elsewhere loads none. state.on(s): that station's
  // chunk is in the scene; state.want(x, z): called by view.js as the rider moves; onLoad after each group.)
  const state = { group, covers: null, ready: false, settled: false, push: [], ranges: [], on: s => state.ranges.some(r => s >= r[0] && s <= r[1]), want(x, z) { state.at = [x, z]; state.pump?.(); }, notHere: () => !state.settled };
  fetch(base + 'conz.json').then(r => r.ok ? r.json() : null).then(async j => {
    if (!j) { state.settled = true; return; } state.covers = j.stations; state.runs = j.runs; state.allRanges = j.chunks.map(c => [c.s0, c.s1]);
    // (the hand terrain past the corridor, build_conz.py ext_terrain: per row of its grid the runs [i0, n, ...] of points
    // where the generated ground gives way)
    // (__w3.handNoExt: without it, the generated ground there again: perf attribution)
    const noExt = !!globalThis.__w3?.handNoExt;
    if (j.ext && !noExt) { const E = j.ext, M = new Uint8Array(E.nx * E.nz);
      E.runs.forEach((r, jj) => { for (let k = 0; k + 1 < r.length; k += 2) M.fill(1, jj * E.nx + r[k], jj * E.nx + r[k] + r[k + 1]); });
      state.extAt = (x, z) => { const i = Math.round((x - E.x0) / E.step), jj = Math.round((z - E.z0) / E.step); return i >= 0 && i < E.nx && jj >= 0 && jj < E.nz && M[jj * E.nx + i] === 1; }; }
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), mats = new Map();
    const grp = c => c.s0 >= 20000 ? 100 + Math.floor(c.s0 / 1000) : c.s0 < 5000 ? 0 : c.s0 < 11322 ? 1 : c.s0 < 12822 ? 2 : 3,  /* (A33: the other roads a group per kilometre: all of them one group loaded 85 MB at once and the ride stalled) */ groups = new Map(); for (const c of j.chunks) { const k = grp(c); (groups.get(k) ?? groups.set(k, []).get(k)).push(c); }
    // (a group stays hidden until all its chunks are in, and counts as present only then: a late load shows the generated ground it replaces, never a part of the
    // corridor standing in it)
    async function addChunk(c, into, box) {
      const g = await loader.loadAsync(base + `conz_${c.i}.glb`).catch(() => null); if (!g) return;
      g.scene.position.set(c.cx, 0, c.cz);
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
      // (the verges' and lots' triangles in world space: the generated ground is pushed under them as under the paving,
      // view.js buildRoads; else its coarse grid stands up through a level verge or a lot)
      into.updateMatrixWorld(true); g.scene.updateMatrixWorld(true);
      g.scene.traverse(o => { if (!o.isMesh || !/^(verge|lot)/.test(o.name)) return; const out = state.push, P = o.geometry.attributes.position, I = o.geometry.index, v = new THREE.Vector3();
        for (let k = 0, n = I ? I.count : P.count; k < n; k++) { v.fromBufferAttribute(P, I ? I.getX(k) : k).applyMatrix4(o.matrixWorld); out.push(v.x, v.y, v.z); } });
    }
    let busy = false; const D2 = 1800 * 1800;
    // (A23: a group wanted but not in yet: the world is not ready until it is, view.js)
    // (notHere: a chunk within 400 m of the rider not shown yet: what the loading screen waits for; a group further off comes in during the ride)
    const shown = new Set(), all = j.chunks;
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
          const box = new THREE.Box3(); for (const c of cs) await addChunk(c, into, box);
          await prepare?.(into); state.lastBox = box;
          into.updateMatrixWorld(true); into.updateMatrixWorld = () => {};  // (A32: never moves. three.js walks every child each frame whatever matrixWorldAutoUpdate says: 1.5 ms a frame over 8000 objects)
          into.visible = true; for (const c of cs) { shown.add(c.i); state.ranges.push([c.s0, c.s1]); }
          state.ready = true; onLoad(state); }
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
// A35: the coastal scrub as one canopy surface (private tools/blender/scrub_shell.py: the lidar's canopy over its ground where NAIP sees
// plants, coloured from NAIP): scrub.json the head, scrub/s<k>.bin per road group (positions, rgb, triangles), streamed as loadHand's groups.
// Lit as a solid mass with the asphalt's world-space grain for its leaves; no model, no texture.
export function loadScrub({ scene, base = '/world/hand/', lambert = m => m }) {
  const group = new THREE.Group(); group.name = 'handScrub'; scene.add(group);
  const mat = groundMaterial({ base, lambert });  // (A35: the ground's own material: its scrub cover paints the shell, one surface with relief)
  let groups = null, at = null, busy = false, D2 = 1800 * 1800;
  fetch(base + 'scrub.json').then(r => r.ok ? r.json() : null).then(j => { if (j) { groups = j.groups; pump(); } }).catch(() => {});
  async function pump() {
    if (busy || !groups || !at) return; busy = true;
    try {
      for (let k = 0; k < groups.length; k++) { const G = groups[k]; if (!G || !G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < D2)) continue; groups[k] = null;
        const buf = await fetch(base + G.file).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null); if (!buf) continue;
        const pos = new Float32Array(buf, 0, G.n * 3), cOff = G.n * 12, col = new Uint8Array(buf, cOff, G.n * 3), iOff = cOff + G.n * 3 + ((-G.n * 3) % 4 + 4) % 4, idx = new Uint32Array(buf, iOff, G.t * 3);
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); { const c = new Float32Array(G.n * 3); for (let i = 0; i < c.length; i++) { const v = col[i] / 255; c[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; } geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); }  /* (NAIP's sRGB to linear) */ geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeVertexNormals(); geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.castShadow = true; m.matrixAutoUpdate = false; m.updateMatrix(); group.add(m);
        await new Promise(r => setTimeout(r, 16)); k = -1; }
    } finally { busy = false; }
  }
  return { group, want(x, z, r = 1800) { at = [x, z]; D2 = r * r; pump(); } };  // (A36: r: only the groups by the rider while the world loads, 124 MB in all)
}

export function loadVeg({ scene, renderer = null, base = '/world/hand/', lambert = m => m }) {
  const group = new THREE.Group(); group.name = 'handVeg'; scene.add(group); group.updateMatrixWorld = () => {};  // (A32: every plant mesh an identity matrix at the origin: not walked each frame)
  const DROP = new Set(['brush', 'brushg', 'mat_o', 'mat_g', 'mat_l', 'mat_d', 'mat_r']);  // (and the scrub carpets: they read as rows of corn up the slopes, user 2026-11-05)
  const sets = [], CELL = 32, cam = { value: new THREE.Vector3(1e9, 0, 1e9) }; let own = null;
  // owns(x, z): inside the corridor this list owns (veg.json own: a 2 m bit grid), where the generated scrub and trees
  // give way; onOwn() once that is known
  const ownCbs = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const matAt = (a, i, st = 7) => { m4.compose(v.set(a[st * i], a[st * i + 1], a[st * i + 2]), q.setFromAxisAngle(up, a[st * i + 3]), s.set(a[st * i + 4], a[st * i + 5], a[st * i + 6]));
    if (st === 9) { const e = m4.elements, kx = a[9 * i + 7], kz = a[9 * i + 8]; e[1] += kx * e[0] + kz * e[2]; e[5] += kx * e[4] + kz * e[6]; e[9] += kx * e[8] + kz * e[10]; }  // (A30: a low plant sheared to the slope under it, stride 9)
    return m4; };
  // (a material per part: its range [from, to) metres, the instance outside it moved off screen in the vertex shader;
  // fade: 1 fades out over the range's far end, -1 fades in over its near end, FADE metres either side, by a screen-door
  // dither: lod0 and the impostors cross-faded with no pop)
  const FADE = 5;
  function material(src, geo, lo, hi, { round = false, fade = 0, meshNormals = false } = {}) {
    const m0 = new THREE.MeshLambertMaterial({ color: src.color, map: src.map, alphaTest: src.map ? 0.5 : 0, side: THREE.DoubleSide, vertexColors: !!geo.attributes.color });
    const range = { value: new THREE.Vector2(lo, hi) };
    m0.onBeforeCompile = sh => {
      sh.uniforms.jwVegCam = cam; sh.uniforms.jwVegRange = range;
      // (round: an impostor card lit as the mound it shows, its normal from the plant's middle: a sunlit side and a shaded
      // side whatever way the card faces)
      if (round) {
        geo.computeBoundingBox(); const b = geo.boundingBox, cy = (b.min.y + b.max.y) * 0.5, ry = Math.max(0.01, (b.max.y - b.min.y) * 0.5);
        sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', `vec3 objectNormal = normalize(vec3(position.x, (position.y - ${cy.toFixed(3)}) * 1.2 + ${(0.45 * ry).toFixed(3)}, position.z) / ${ry.toFixed(3)});`);
      }
      const f = fade.toFixed(1);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 jwVegCam; uniform vec2 jwVegRange; varying float vJwFade;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vJwFade = 1.0;
          #ifdef USE_INSTANCING
          { vec4 o = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0); float d = distance(o.xz, jwVegCam.xz);
            if (d < jwVegRange.x || d >= jwVegRange.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            if (${f} > 0.5) vJwFade = 1.0 - smoothstep(jwVegRange.y - ${(2 * FADE).toFixed(1)}, jwVegRange.y, d);
            if (${f} < -0.5) vJwFade = smoothstep(jwVegRange.x, jwVegRange.x + ${(2 * FADE).toFixed(1)}, d); }
          #endif`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vJwFade;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          if (vJwFade < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vJwFade) discard;`);
      // (cards and bent leaves: both faces keep the normal, no flip on the back; the scan's own mesh flips as usual)
      if (!meshNormals) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, '').replace(/normal = normal \* faceDirection;/g, ''));
    };
    m0.customProgramCacheKey = () => 'jw-veg19d' + fade + (meshNormals ? 'm' : '') + (round ? geo.uuid : ''); return lambert(m0);
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
    for (const p of parts[1]) p.mat = material(p.src, p.geo, near > 0 ? near - FADE : 0, far, { round: /brush|sage/.test(sp), fade: near > 0 ? -1 : 0 });
    const out_ = { near, parts, mats: parts[0].map(p => material(p.src, p.geo, 0, near + FADE, { fade: 1, meshNormals: !!J.mesh_normals?.[sp] })) };
    // (A35: the bush-tree's leaves a muted olive: as the tall shrubs along Field, Bunker and McCullough they read cartoon lime against Street View's)
    if (/^lime/.test(sp)) for (const m of [...out_.mats, ...parts[1].map(p => p.mat)]) m.color.multiply(new THREE.Color(0.58, 0.6, 0.44));
    // (A37: the Monterey cypress near black green in Street View, w_mitchell0, w_simmonds1: the plates read light lime when lit as built)
    if (/^mcyp/.test(sp)) for (const m of [...out_.mats, ...parts[1].map(p => p.mat)]) m.color.multiply(new THREE.Color(0.62, 0.66, 0.6));
    // (A36: the sage read near white beside Conzelman, Street View cz 2025-03 a darker grey green)
    if (sp === 'sage') for (const m of [...out_.mats, ...parts[1].map(p => p.mat)]) m.color.multiply(new THREE.Color(0.5, 0.58, 0.45));
    return out_;
  })).get(sp);
  async function addGroup(G, x, z) {
    const buf = await fetch(base + G.file).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null); if (!buf) return;
    let off = 0; t0 = performance.now();
    for (const [sp, n] of Object.entries(G.species)) {
      const st = J.stride?.[sp] || 7, a = new Float32Array(buf, off, n * st); off += n * st * 4;
      if (DROP.has(sp)) continue;  // (A33: the round brush domes by the road dropped, user 2026-11-05: 'these bushes so bad just remove them')
      const M = await model(sp); if (!M) continue; t0 = performance.now();
      // lod1: every plant of the group, written once
      for (const p of M.parts[1]) {
        const im = new THREE.InstancedMesh(p.geo, p.mat, n);
        for (let i = 0; i < n; i++) { im.setMatrixAt(i, matAt(a, i, st)); if (!(i & 255)) await breath(); }
        im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true; group.add(im); await breath();
      }
      // lod0: the plants by cell, every cell built now, nearest first
      if (!M.parts[0].length) continue;
      const cells = new Map();
      for (let i = 0; i < n; i++) { const cx = Math.floor(a[st * i] / CELL), cz = Math.floor(a[st * i + 2] / CELL), k = cx + ',' + cz; (cells.get(k) ?? cells.set(k, { ids: [], meshes: null, cx: (cx + 0.5) * CELL, cz: (cz + 0.5) * CELL }).get(k)).ids.push(i); }
      await breath();
      const S = { sp, a, st, near: M.near, parts: M.parts[0], mats: M.mats, cells: [...cells.values()] }; sets.push(S);
      const [px, pz] = at ?? [x, z], d2 = c => (c.cx - px) ** 2 + (c.cz - pz) ** 2;
      for (const c of [...S.cells].sort((p, q) => d2(p) - d2(q))) { build(S, c); await breath(); }
    }
    dirty = true;
  }
  const D2 = 1800 * 1800;
  async function pump() {
    if (pumping || !J || !at) return; pumping = true;
    try {
      // (A28: every species' model and its textures on the GPU when the first group is wanted, under the loading screen for a ride that starts here: a texture is about 15 MB, sent
      // with its mips at the species' first draw it held a frame up by 170 to 220 ms; one species per pause when the rider comes from further off)
      if (!texDone) { texDone = true; const sps = new Set(); for (const G of groups) if (G) for (const sp of Object.keys(G.species)) sps.add(sp);
        for (const sp of sps) { const M = await model(sp); if (!M || !renderer) continue; for (const p of [...M.parts[0], ...M.parts[1]]) if (p.src.map) renderer.initTexture(p.src.map); await new Promise(r => setTimeout(r, 30)); } }
      for (let k = 0; k < groups.length; k++) { const G = groups[k]; if (!G || !G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < D2)) continue;
        groups[k] = null; await addGroup(G, at[0], at[1]); k = -1; }
    } finally { pumping = false; state.busy = false; state.first = true; }  // (first: the plants at the rider's place are in; busy can read false before a position has come)
  }
  const wanted = () => groups.some(G => G && G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < D2));
  fetch(base + 'veg.json').then(r => r.ok ? r.json() : null).then(j => {
    if (!j) return; J = j; groups.push(...(j.groups || []));
    if (j.own) { const b = atob(j.own.bits), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); own = { ...j.own, u }; for (const f of ownCbs) f(); }
    if (at) pump();
  }).catch(() => {}).finally(() => { if (!at || !J || !wanted()) state.busy = false; if (!J) state.first = true; });
  function build(S, c) {
    const R = S.near + FADE + CELL * 0.75 + 3, on = (c.cx - lx) ** 2 + (c.cz - lz) ** 2 < R * R;
    c.meshes = S.parts.map((p, k) => {
      const im = new THREE.InstancedMesh(p.geo, S.mats[k], c.ids.length);
      c.ids.forEach((i, j) => im.setMatrixAt(j, matAt(S.a, i, S.st)));
      im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true; im.visible = on; group.add(im); return im;  // (no cast shadows: on the steep faces they fell as black blots, cz_1105_l)
    });
  }
  // every frame: the camera uniform; near cells shown (only after 3 m of travel: the extra 3 m in R covers it)
  function update(x, z) {
    cam.value.set(x, 0, z);
    if (!dirty && Math.abs(x - lx) + Math.abs(z - lz) < 3) return;
    lx = x; lz = z; dirty = false;
    for (const S of sets) { const R = S.near + FADE + CELL * 0.75 + 3, R2 = R * R; for (const c of S.cells) { if (!c.meshes) continue; const on = (c.cx - x) ** 2 + (c.cz - z) ** 2 < R2; for (const m of c.meshes) m.visible = on; } }
  }
  // (view.js as the rider moves; busy: stats().jobs counts it, so a render waits for the plants)
  function want(x, z) { at = [x, z]; if (!J) return; if (wanted()) { state.busy = true; pump(); } }
  const owns = (x, z) => { if (!own) return false; const i = Math.floor((x - own.x0) / own.g), k = Math.floor((z - own.z0) / own.g);
    if (i < 0 || k < 0 || i >= own.w || k >= own.h) return false; const b = k * own.w + i; return !!(own.u[b >> 3] & (1 << (b & 7))); };
  return { group, update, want, owns, get busy() { return state.busy; }, get first() { return !!state.first; }, onOwn: f => { if (own) f(); else ownCbs.push(f); } };
}

// A19 ground for the hand-built stretch: Poly Haven CC0 scans (private tools/blender/ground19.py; /world/hand/ground.json:
// box [x0, z0, x1, z1] in the game frame, a splat (r dirt, g chert cut, b scrub litter; the rest grass) and one tile per
// layer, each tiled in world metres, no UVs). The cut shows only where the ground is steep (its side projection then);
// a shallow cut zone stays grass. One shared material: groundMaterial({ lambert }) for the verges and the hand terrain.
// (A37: shoulder: the verges' variant, their jwSh attribute's shoulder band; one set of uniforms and textures for both)
let groundShared = null, groundSh = null, groundMk = null;
export function groundMaterial({ base = '/world/hand/', lambert = m => m, shoulder = false } = {}) {
  groundMk ??= groundMaker(base);
  if (shoulder) return groundSh ??= lambert(groundMk(true));
  return groundShared ??= lambert(groundMk(false));
}
function groundMaker(base) {
  const U = {
    gBox: { value: new THREE.Vector4(0, 0, 1, 1) }, gBoxW: { value: new THREE.Vector4(1e9, 1e9, 1, 1) }, gSplatW: { value: null }, gRep: { value: new THREE.Vector4(3, 7, 4, 6) },
    gSplat: { value: null }, gDirt: { value: null }, gCut: { value: null }, gGrass: { value: null }, gLitter: { value: null }, gScrub: { value: null }, gScrubBox: { value: new THREE.Vector4(0, 0, 1, 1) } };
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
  const grey = new THREE.DataTexture(new Uint8Array([104, 120, 66, 255]), 1, 1); grey.colorSpace = THREE.SRGBColorSpace; grey.needsUpdate = true;
  U.gSplat.value = blank; U.gSplatW.value = blank; U.gScrub.value = blank;
  // (A35: the scrub's cover, scrub_shell.py: the lidar's low canopy where NAIP sees plants, 2.8 m cells over every hand road's corridor)
  fetch(base + 'scrub.json').then(r => r.ok ? r.json() : null).then(j => { if (!j?.cover) return; const t = new THREE.TextureLoader().load(base + j.cover.file); t.flipY = false; t.colorSpace = THREE.NoColorSpace;
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
  return SH => { const m = new THREE.MeshLambertMaterial({ color: 0xffffff }); if (SH) m.defines = { JW_SH: '' };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U); sh.uniforms.gNoise = { value: textures().noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGdW; varying vec3 vGdN;\n#ifdef JW_SH\nattribute vec3 jwSh; varying vec3 vSh; attribute vec2 jwCt; varying vec2 vCt;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGdW = (modelMatrix * vec4(transformed, 1.0)).xyz; vGdN = normalize(mat3(modelMatrix) * objectNormal);\n#ifdef JW_SH\nvSh = jwSh; vCt = jwCt;\n#endif');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vGdW; varying vec3 vGdN; uniform vec4 gBox; uniform vec4 gRep; uniform vec4 gBoxW; uniform sampler2D gSplatW;
      uniform sampler2D gSplat, gDirt, gCut, gGrass, gLitter, gNoise, gScrub; uniform vec4 gScrubBox;
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
            if (hh > best) { best = hh; id = h.x; g = -1.2 * H * tp / max(t, 0.04) * d / (r * r); } } }
        return vec4(best, g, id); }`)
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
        vec2 dPx = dFdx(p), dPy = dFdy(p), dSx = dFdx(side), dSy = dFdy(side); mat2 mSR = mat2(0.62, -0.78, 0.78, 0.62); vec2 dRx = mSR * dSx, dRy = mSR * dSy;
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
          float cv = smoothstep(0.12, 0.8, cov + (s2 - 0.5) * 0.7 + (s1 - 0.5) * 0.35); cv = max(cv, 0.45 * smoothstep(0.62, 0.8, s1) * sIn);  // (A35: ragged edges and scattered bushes in the grass, cz300: hard-edged grass patches)
          float sw = cv * (1.0 - clamp(wd, 0.0, 1.0)) * (1.0 - rb31) * (1.0 - smoothstep(0.85, 1.0, steep) * 0.7);  // (A37: brush on the steep slopes too, only the cut faces bare: Street View hawk)
          if (sw > 0.002) { float bf = (1.0 - smoothstep(0.2, 0.8, pxm)) * smoothstep(0.2, 0.6, max(texture2D(gScrub, sb).g * sIn, jwBrush));  // (the mounds fade to their mean once one is a few pixels across; A37: only where the lidar sees real shrubs, scrubcover G, review1 w_center0 lawns took them as scales)
            vec2 pw = p + (vec2(textureGrad(gNoise, p / 0.8 + 0.41, dPx / 0.8, dPy / 0.8).r, textureGrad(gNoise, p / 0.8 + 0.83, dPx / 0.8, dPy / 0.8).g) - 0.5) * 0.45 * aaS;  // (ragged leafy outlines)
            vec4 bu = jwBush(pw, mix(0.9, 1.0, smoothstep(0.3, 0.9, cov)));
            float top = smoothstep(0.1, 1.0, bu.x), gap = 1.0 - smoothstep(0.0, 0.1, bu.x), foot = smoothstep(0.0, 0.35, bu.x);
            // (A36, hawkR: Street View's coyote brush a fresh mid green, one bush in four or five grey sage; red-brown dirt and dry grass between)
            vec3 cB = mix(vec3(0.062, 0.09, 0.04), vec3(0.085, 0.098, 0.07), step(0.9, bu.w)) * mix(0.8, 1.2, fract(bu.w * 13.7));
            { float l1 = textureGrad(gNoise, p / 0.27 + 0.29, dPx / 0.27, dPy / 0.27).r, l2 = textureGrad(gNoise, p / 0.7 + 0.53, dPx / 0.7, dPy / 0.7).g;
              cB *= mix(1.0, mix(0.35, 1.45, smoothstep(0.2, 0.8, l1 * 0.6 + l2 * 0.4)), aaS); }  // (the leaves: lit sprays and dark holes in each bush)
            cB *= mix(0.55, 1.0, foot) * mix(0.65, 1.2, top);
            vec3 cG = mix(vec3(0.16, 0.10, 0.06), vec3(0.17, 0.15, 0.09), smoothstep(0.35, 0.65, s1)) * mix(0.75, 1.1, s3);  // (dirt and dry grass in the gaps)
            cB = mix(cB, cG, gap);
            vec3 cFar = mix(vec3(0.055, 0.085, 0.032), vec3(0.08, 0.095, 0.058), smoothstep(0.45, 0.75, s2)) * mix(0.62, 1.12, clumpS);  // (the bushes' and gaps' mean, so near and far brush are one colour)
            cS = mix(cFar, cB, bf); sw = max(sw, bf * smoothstep(0.4, 0.55, cov) * (1.0 - steep * 0.7) * (1.0 - rb31));
            jwSW = sw * bf * (1.0 - gap) * 0.45 * (1.0 - smoothstep(0.3, 0.9, pxm)); jwSG = clamp(bu.yz, vec2(-2.5), vec2(2.5)); }  // (A37: the bent light weak, and gone at a grazing angle: on the flat ground it drew the painted mounds as dark shingles, w_field1)
          c = mix(c, cS, sw * (1.0 - jwBand)); jwSW *= 1.0 - jwBand; }
        #ifdef JW_SH
        // (A37: the shoulder's own surface: short saturated grass, or tan gravel, or red-brown dirt with a few tufts, the dirt
        // greening into the scrub at its outer edge; Street View cz_33430_a, w_mitchell1, w_mccullough0, w_conzelman3)
        if (jwBand > 0.002) {
          float m1 = textureGrad(gNoise, p / 3.1 + 0.37, dPx / 3.1, dPy / 3.1).r, m2 = textureGrad(gNoise, p / 0.35 + 0.53, dPx / 0.35, dPy / 0.35).g, k = vSh.y < -0.5 ? 0.45 : vSh.y;
          vec3 gS = textureGrad(gGrass, p / gRep.z, dPx / gRep.z, dPy / gRep.z).rgb; float gl = clamp(dot(gS, vec3(0.3, 0.55, 0.15)) / 0.35, 0.4, 1.6);
          vec3 cSg = vec3(0.19, 0.27, 0.09) * mix(1.0, gl, aaS * 0.7) * mix(0.85, 1.15, m1);
          vec3 cTan = mix(vec3(0.34, 0.31, 0.27), vec3(0.43, 0.39, 0.34), mix(0.5, m2, aaS)) * mix(0.85, 1.12, m1);
          vec3 cRed = mix(vec3(0.33, 0.22, 0.16), vec3(0.41, 0.29, 0.21), mix(0.5, m2, aaS)) * mix(0.85, 1.12, m1);
          vec3 cD = mix(cTan, cRed, smoothstep(0.6, 0.9, k));
          cD = mix(cD, cSg, smoothstep(0.62, 0.8, m2) * 0.35 * aaS + smoothstep(0.55, 1.0, (1.0 - vSh.x) / max(vSh.z, 0.01)) * 0.45);
          c = mix(c, mix(cSg, cD, smoothstep(0.2, 0.3, k)), jwBand); }
        #endif
        if (wc > 0.002) {
        // mixed; grey-green tufts in clumps over it)
        // (three lookups at different angles and scales: the scan's level strata averaged out into fractured rock)
        vec2 sr = mat2(0.62, -0.78, 0.78, 0.62) * side;
        vec3 cFace = (textureGrad(gCut, side / (gRep.y * 0.45), dSx / (gRep.y * 0.45), dSy / (gRep.y * 0.45)).rgb + textureGrad(gCut, side.yx / (gRep.y * 1.15) + 0.37, dSx.yx / (gRep.y * 1.15), dSy.yx / (gRep.y * 1.15)).rgb + textureGrad(gCut, sr / (gRep.y * 0.7) + 0.71, dRx / (gRep.y * 0.7), dRy / (gRep.y * 0.7)).rgb) / 3.0;
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
          cCut = mix(cCut, tuft, clump * blade * 0.8 * steep * (1.0 - rb31) * mix(0.35, 1.0, clamp((w.a - 0.4) / 0.6, 0.0, 1.0))); }  // (A32, n11_11605_r: fewer pale tufts on the dark rock)
        // (the splat's alpha below 1: the chert dark grey-brown there, cz_1205_l, cz_1380_l)
        cCut = mix(cCut, vec3(dot(cCut, vec3(0.3, 0.55, 0.15))) * vec3(0.92, 0.86, 0.80) * 0.62, 0.8 * clamp((1.0 - w.a) / 0.6, 0.0, 1.0));  // (A32: darker, n11_11605_r)
        // (A37, review1 w_conzelman0/1: the faces were one red-brown smear; Street View's are red chert, grey chert and weathered pale
        // grey-pink rock in patches metres across, fractured, with green clumps on the ledges)
        { float tA = textureGrad(gNoise, p / 13.0 + 0.27, dPx / 13.0, dPy / 13.0).r, tB = textureGrad(gNoise, side / 4.5 + 0.61, dSx / 4.5, dSy / 4.5).g;
          float L = dot(cCut, vec3(0.3, 0.55, 0.15)); vec3 cGrey = vec3(L) * vec3(0.95, 0.96, 1.0) * 1.2, cPale = mix(vec3(L) * 1.2, vec3(0.62, 0.50, 0.46), 0.6) * mix(0.8, 1.1, tA);
          float gW = smoothstep(0.55, 0.75, tA * 0.7 + tB * 0.3) * 0.45, pW = smoothstep(0.66, 0.84, tB) * 0.3;
          #ifdef JW_SH
          if (vCt.x > 0.5) { gW = max(gW, step(0.25, vCt.y) * step(vCt.y, 0.75) * 0.8); pW = max(pW, step(0.75, vCt.y) * mix(0.35, 0.7, tB)); }
          #endif
          cCut = mix(cCut, cGrey, gW * (1.0 - rb31)); cCut = mix(cCut, cPale, pW * (1.0 - rb31));
          float gc = smoothstep(0.56, 0.7, textureGrad(gNoise, side / 2.2 + 0.43, dSx / 2.2, dSy / 2.2).r) * smoothstep(0.35, 0.6, textureGrad(gNoise, p / 8.0 + 0.19, dPx / 8.0, dPy / 8.0).g);
          cCut = mix(cCut, vec3(0.15, 0.21, 0.075) * mix(0.7, 1.25, tB), gc * 0.75 * (1.0 - rb31)); }
          c = mix(c, cCut, clamp(wc * (1.0 - jwBand * (1.0 - steep)), 0.0, 1.0)); }
        if (p.x > 8935.0 && p.x < 8995.0 && p.y > 11625.0 && p.y < 11695.0) {  // (A31: shade pools under the picnic's cypress crowns, cz_14255_l, 14275_l: bright grass and shade, the plants cast no shadows)
          float s31 = 0.0; vec3 Q[7]; Q[0] = vec3(8949.0, 11651.0, 7.5); Q[1] = vec3(8953.0, 11660.0, 6.5); Q[2] = vec3(8957.0, 11647.0, 6.5); Q[3] = vec3(8962.0, 11636.0, 6.0); Q[4] = vec3(8964.0, 11652.0, 8.5); Q[5] = vec3(8969.0, 11667.0, 8.0); Q[6] = vec3(8972.0, 11682.0, 8.0);
          float n31 = texture2D(gNoise, p / 5.5).r * 0.55 + texture2D(gNoise, p / 1.7).g * 0.45;
          for (int k = 0; k < 7; k++) s31 = max(s31, 0.75 * (1.0 - smoothstep(Q[k].z * 0.12, Q[k].z * 0.5, length(p - Q[k].xy) + (n31 - 0.5) * 3.0)));
          vec2 T32[4]; T32[0] = vec2(8950.5, 11647.6); T32[1] = vec2(8951.5, 11650.1); T32[2] = vec2(8952.3, 11652.8); T32[3] = vec2(8951.2, 11655.7);  // (A32, cz_14255_l: the trunks' long shadows toward the road, the lawn bright between them)
          for (int k = 0; k < 4; k++) { vec2 d32 = p - T32[k]; float u32 = clamp(dot(d32, vec2(-0.93, 0.36)), 0.0, 13.0); s31 = max(s31, (1.0 - smoothstep(0.5, 1.2, length(d32 - vec2(-0.93, 0.36) * u32) + (n31 - 0.5) * 0.7)) * (1.0 - u32 / 22.0)); }
          c *= mix(vec3(1.28, 1.42, 1.0), vec3(0.62, 0.7, 0.58), s31); }
        diffuseColor.rgb *= c;
      }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      if (jwSW > 0.001) normal = normalize(normal + (viewMatrix * vec4(-jwSG.x, 0.0, -jwSG.y, 0.0)).xyz * jwSW);`);
  };
  m.customProgramCacheKey = () => 'jw-hand-ground22' + (SH ? 'sh' : '');
  return m; };
}
