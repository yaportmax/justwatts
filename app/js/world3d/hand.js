// World 3D: hand-built scenery (A17 pilot: Conzelman Road 930 to 1690 m, modelled in Blender against the Street View
// survey; private tools/blender/build_conz.py). app/world/hand/conz.json lists its chunks ({ i, cx, cz }: glTF in the game
// frame less (cx, 0, cz)) and the stations it covers; the generated road, banks and rails give way there (view.js), the
// rider's rails and grade stay as they are. Materials become the game's own Lambert (the sun's terrain shadows, withSun).
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { GLTFLoader } from '../../vendor/three-0.180.0/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../../vendor/three-0.180.0/addons/libs/meshopt_decoder.module.js';
import { textures } from './tex.js';
import { HZ_LAYER } from './horizon.js';

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
    const grp = c => c.s0 < 5000 ? 0 : c.s0 < 11322 ? 1 : c.s0 < 12822 ? 2 : 3, groups = new Map(); for (const c of j.chunks) { const k = grp(c); (groups.get(k) ?? groups.set(k, []).get(k)).push(c); }
    // (a group stays hidden until all its chunks are in, and counts as present only then: a late load shows the generated ground it replaces, never a part of the
    // corridor standing in it)
    async function addChunk(c, into, box) {
      const g = await loader.loadAsync(base + `conz_${c.i}.glb`).catch(() => null); if (!g) return;
      g.scene.position.set(c.cx, 0, c.cz);
      g.scene.traverse(o => {
        if (!o.isMesh) return; o.receiveShadow = true; o.castShadow = /beam|post|kerb/.test(o.name);
        // (the ground is in the terrain shadows' height map: without it the corridor was a pit there, and the generated hill
        // past its edge threw a straight-edged shadow into it, Street View Conzelman 1400 ahead)
        if (/^(terrain|rock_ext|verge|road|lot)/.test(o.name)) o.layers.enable(HZ_LAYER);
        // (a lot's and the road's paving one surface: its triangles over a bumpy lidar lit alike; at the junctions the road's fans read as dark wedges and radial bands, s6_1755_l, 1790_r; A27: the road's steps are gone, 1785-1800 inner edge 0.10 m over 0.45 m remains, and face lighting still draws bands there, 1790_a, 1790_r)
        if (/^(lot|road)/.test(o.name) && o.geometry.attributes.normal) { const N = o.geometry.attributes.normal; for (let k = 0; k < N.count; k++) N.setXYZ(k, 0, 1, 0); N.needsUpdate = true; }
        // (the ground round the road and the verges: jw-a19's photo-zoned ground textures, world space)
        if (/^(verge|terrain)/.test(o.name)) { o.material = groundMaterial({ lambert }); o.geometry.deleteAttribute('color'); return; }
        if (noExt && /^(terrain_ext|rock_ext|surf)/.test(o.name)) { o.visible = false; return; }
        // (the surf at the ridge's foot: white water, see-through by its vertex alpha, build_conz.py surf)
        if (/^surf/.test(o.name)) { o.material = lambert(foam(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }))); o.receiveShadow = false; return; }
        // (the W-beam's folds lit face by face: smooth normals averaged its profile flat, a pale plank)
        if (/^beam/.test(o.name)) { o.geometry = o.geometry.toNonIndexed(); o.geometry.computeVertexNormals(); }
        const s = o.material; let m = mats.get(s);
        if (!m) { m = new THREE.MeshLambertMaterial({ color: s.color, vertexColors: !!o.geometry.attributes.color, side: THREE.DoubleSide, polygonOffset: /paint/.test(o.name), polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
          // (the asphalt's grain: Street View 950 m, the paving mid grey with darker and lighter patches metres across and a fine
          // aggregate; the verges mottled)
          if (/lot_dirt|lot_gravel/.test(s.name)) grain(m, 0.32, [1.3, 5.3, 19.7]);
          else if (/asphalt|lot/.test(s.name)) grain(m, 0.11, [1.37, 9.7, 37.3]);
          // (galvanised steel: the sky's sheen on its shaded face, Street View: a light W-beam even with the sun behind it)
          if (/wbeam/.test(s.name)) m.emissive = new THREE.Color(0.10, 0.105, 0.11); 
          m = lambert(m); mats.set(s, m); }
        o.material = m;
      });
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
        for (const [k, cs] of groups) { if (!cs.some(c => (c.cx - x) ** 2 + (c.cz - z) ** 2 < D2)) continue; groups.delete(k);
          cs.sort((a, b) => ((a.cx - x) ** 2 + (a.cz - z) ** 2) - ((b.cx - x) ** 2 + (b.cz - z) ** 2));
          const into = new THREE.Group(); into.visible = false; group.add(into);
          // (lastBox: what this group covers, view.js builds again only the tiles it touches; prepare: slow work done in slices before the group shows)
          const box = new THREE.Box3(); for (const c of cs) await addChunk(c, into, box);
          await prepare?.(into); state.lastBox = box;
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
export function loadVeg({ scene, renderer = null, base = '/world/hand/', lambert = m => m }) {
  const group = new THREE.Group(); group.name = 'handVeg'; scene.add(group);
  const sets = [], CELL = 32, cam = { value: new THREE.Vector3(1e9, 0, 1e9) }; let own = null;
  // owns(x, z): inside the corridor this list owns (veg.json own: a 2 m bit grid), where the generated scrub and trees
  // give way; onOwn() once that is known
  const ownCbs = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const matAt = (a, i) => m4.compose(v.set(a[7 * i], a[7 * i + 1], a[7 * i + 2]), q.setFromAxisAngle(up, a[7 * i + 3]), s.set(a[7 * i + 4], a[7 * i + 5], a[7 * i + 6]));
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
  const groups = [], models = new Map(), loader = new GLTFLoader();
  let t0 = 0; const breath = async () => { if (performance.now() - t0 < 3) return; await new Promise(r => setTimeout(r, 6)); t0 = performance.now(); };
  // (a species' model and materials once, shared by its groups: no second shader compile when a group arrives)
  const model = sp => models.get(sp) ?? models.set(sp, loader.loadAsync(base + `veg/${sp}.glb`).catch(() => null).then(g => { if (!g) return null;
    const [near0, far] = J.lod?.[sp] || [30, 450], parts = [[], []];
    g.scene.updateMatrixWorld(true);
    g.scene.traverse(o => { if (!o.isMesh) return; parts[/lod1/.test(o.name) || /lod1/.test(o.parent?.name || '') ? 1 : 0].push({ geo: o.geometry.clone().applyMatrix4(o.matrixWorld), src: o.material }); });
    const near = parts[0].length ? near0 : 0;
    for (const p of parts[1]) p.mat = material(p.src, p.geo, near > 0 ? near - FADE : 0, far, { round: /brush|sage/.test(sp), fade: near > 0 ? -1 : 0 });
    return { near, parts, mats: parts[0].map(p => material(p.src, p.geo, 0, near + FADE, { fade: 1, meshNormals: !!J.mesh_normals?.[sp] })) };
  })).get(sp);
  async function addGroup(G, x, z) {
    const buf = await fetch(base + G.file).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null); if (!buf) return;
    let off = 0; t0 = performance.now();
    for (const [sp, n] of Object.entries(G.species)) {
      const a = new Float32Array(buf, off, n * 7); off += n * 28;
      const M = await model(sp); if (!M) continue; t0 = performance.now();
      // lod1: every plant of the group, written once
      for (const p of M.parts[1]) {
        const im = new THREE.InstancedMesh(p.geo, p.mat, n);
        for (let i = 0; i < n; i++) { im.setMatrixAt(i, matAt(a, i)); if (!(i & 255)) await breath(); }
        im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true; group.add(im); await breath();
      }
      // lod0: the plants by cell, every cell built now, nearest first
      if (!M.parts[0].length) continue;
      const cells = new Map();
      for (let i = 0; i < n; i++) { const cx = Math.floor(a[7 * i] / CELL), cz = Math.floor(a[7 * i + 2] / CELL), k = cx + ',' + cz; (cells.get(k) ?? cells.set(k, { ids: [], meshes: null, cx: (cx + 0.5) * CELL, cz: (cz + 0.5) * CELL }).get(k)).ids.push(i); }
      await breath();
      const S = { sp, a, near: M.near, parts: M.parts[0], mats: M.mats, cells: [...cells.values()] }; sets.push(S);
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
    } finally { pumping = false; state.busy = false; }
  }
  const wanted = () => groups.some(G => G && G.at.some(c => (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2 < D2));
  fetch(base + 'veg.json').then(r => r.ok ? r.json() : null).then(j => {
    if (!j) return; J = j; groups.push(...(j.groups || []));
    if (j.own) { const b = atob(j.own.bits), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); own = { ...j.own, u }; for (const f of ownCbs) f(); }
    if (at) pump();
  }).catch(() => {}).finally(() => { if (!at || !J || !wanted()) state.busy = false; });
  function build(S, c) {
    const R = S.near + FADE + CELL * 0.75 + 3, on = (c.cx - lx) ** 2 + (c.cz - lz) ** 2 < R * R;
    c.meshes = S.parts.map((p, k) => {
      const im = new THREE.InstancedMesh(p.geo, S.mats[k], c.ids.length);
      c.ids.forEach((i, j) => im.setMatrixAt(j, matAt(S.a, i)));
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
  return { group, update, want, owns, get busy() { return state.busy; }, onOwn: f => { if (own) f(); else ownCbs.push(f); } };
}

// A19 ground for the hand-built stretch: Poly Haven CC0 scans (private tools/blender/ground19.py; /world/hand/ground.json:
// box [x0, z0, x1, z1] in the game frame, a splat (r dirt, g chert cut, b scrub litter; the rest grass) and one tile per
// layer, each tiled in world metres, no UVs). The cut shows only where the ground is steep (its side projection then);
// a shallow cut zone stays grass. One shared material: groundMaterial({ lambert }) for the verges and the hand terrain.
let groundShared = null;
export function groundMaterial({ base = '/world/hand/', lambert = m => m } = {}) {
  if (groundShared) return groundShared;
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff }), U = {
    gBox: { value: new THREE.Vector4(0, 0, 1, 1) }, gBoxW: { value: new THREE.Vector4(1e9, 1e9, 1, 1) }, gSplatW: { value: null }, gRep: { value: new THREE.Vector4(3, 7, 4, 6) },
    gSplat: { value: null }, gDirt: { value: null }, gCut: { value: null }, gGrass: { value: null }, gLitter: { value: null } };
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
  const grey = new THREE.DataTexture(new Uint8Array([104, 120, 66, 255]), 1, 1); grey.colorSpace = THREE.SRGBColorSpace; grey.needsUpdate = true;
  U.gSplat.value = blank; U.gSplatW.value = blank; for (const k of ['gDirt', 'gCut', 'gGrass', 'gLitter']) U[k].value = grey;
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
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U); sh.uniforms.gNoise = { value: textures().noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGdW; varying vec3 vGdN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGdW = (modelMatrix * vec4(transformed, 1.0)).xyz; vGdN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vGdW; varying vec3 vGdN; uniform vec4 gBox; uniform vec4 gRep; uniform vec4 gBoxW; uniform sampler2D gSplatW;
      uniform sampler2D gSplat, gDirt, gCut, gGrass, gLitter, gNoise;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        // (the face's own slope from the surface itself, not the mesh's normals: a smoothed or exported-up normal had hidden
        // the cut faces)
        vec3 n = normalize(cross(dFdx(vGdW), dFdy(vGdW))); if (n.y < 0.0) n = -n; vec2 p = vGdW.xz;
        vec4 w = texture2D(gSplat, (p - gBox.xy) * gBox.zw);
        vec2 buW = (p - gBoxW.xy) * gBoxW.zw; float inW = step(0.0, buW.x) * step(buW.x, 1.0) * step(0.0, buW.y) * step(buW.y, 1.0) * (1.0 - step(gBox.x + 140.0, p.x));
        if (inW > 0.5) w = texture2D(gSplatW, buW);
        // (breaks the soft zone edges up a little with the grass tile's own tone)
        float steep = smoothstep(0.05, 0.34, 1.0 - n.y);  // (the lidar's 2 m mesh and the verges soften the cuts: 25 degrees and up reads as the face)
        vec2 side = abs(n.x) > abs(n.z) ? vGdW.zy : vGdW.xy;
        // (every layer from above on the flat and from the side on a steep face: no streaks down a bank)
        vec3 cDirt = mix(texture2D(gDirt, p / gRep.x).rgb, texture2D(gDirt, side / gRep.x).rgb, steep);
        vec3 cGrass = mix(texture2D(gGrass, p / gRep.z).rgb, texture2D(gGrass, side / gRep.z).rgb, steep);
        vec3 cLit = mix(texture2D(gLitter, p / gRep.w).rgb, texture2D(gLitter, side / gRep.w).rgb, steep);
        // (cz_1105_l, cz_1245_l: the chert fractured every way, not the scan's level strata: a finer lookup and a crossed one
        // mixed; grey-green tufts in clumps over it)
        // (three lookups at different angles and scales: the scan's level strata averaged out into fractured rock)
        vec2 sr = mat2(0.62, -0.78, 0.78, 0.62) * side;
        vec3 cFace = (texture2D(gCut, side / (gRep.y * 0.45)).rgb + texture2D(gCut, side.yx / (gRep.y * 1.15) + 0.37).rgb + texture2D(gCut, sr / (gRep.y * 0.7) + 0.71).rgb) / 3.0;
        // (cz_1105_a: pale weathered rock showing through the red in patches a metre or two across)
        cFace = mix(cFace, vec3(0.50, 0.44, 0.38) * (0.8 + 0.4 * texture2D(gNoise, side / 0.6).b), 0.14 * smoothstep(0.66, 0.74, texture2D(gNoise, side / 1.7 + 0.51).b));
        vec3 cCut = mix(texture2D(gCut, p / gRep.y).rgb, cFace, steep);
        // (the tufts' clumps and blades from the game's noise texture: its values spread evenly, unlike a grass tile's)
        // (cz_1105_l: green scrub patches over about a quarter of the face)
        { float clump = smoothstep(0.52, 0.64, texture2D(gNoise, side / 7.0 + 0.13).r), blade = smoothstep(0.45, 0.65, texture2D(gNoise, side / 0.9).g);
          // (A22, a19g_1105_l: the tufts grey-green sage and dry grass, not lime: the grass tile half greyed, its green held back)
          vec3 tg = texture2D(gGrass, side / 0.9).rgb; vec3 tuft = mix(vec3(dot(tg, vec3(0.3, 0.55, 0.15))), tg, 0.45) * vec3(1.02, 1.08, 0.9);
          cCut = mix(cCut, tuft, clump * blade * 0.8 * steep); }
        // (the splat's alpha below 1: the chert dark grey-brown there, cz_1205_l, cz_1380_l)
        cCut = mix(cCut, vec3(dot(cCut, vec3(0.3, 0.55, 0.15))) * vec3(0.92, 0.86, 0.80) * 0.8, 0.5 * clamp((1.0 - w.a) / 0.6, 0.0, 1.0));  // (alpha no lower than 0.4: the browser may premultiply)
        // (far off the tiles' repeats show: a second, larger lookup mixed in with distance)
        float far = smoothstep(40.0, 160.0, length(vGdW - cameraPosition));
        cGrass = mix(cGrass, texture2D(gGrass, p / (gRep.z * 7.3)).rgb, far * 0.6); cLit = mix(cLit, texture2D(gLitter, p / (gRep.w * 6.1)).rgb, far * 0.6);
        // (A22, coordinator: the scrub floor from afar: broad soft grey-green and fresh green patches over the fine tile, no fine worm marks;
        // the splat's own value (NAIP) darkens the real bush patches)
        { float m1 = texture2D(gNoise, p / 9.0 + 0.3).g, m3 = texture2D(gNoise, p / 3.7 + 0.11).b;
          cLit = mix(cLit, vec3(0.2, 0.25, 0.12), smoothstep(0.35, 0.75, m1) * 0.55);
          cLit = mix(cLit, vec3(0.27, 0.30, 0.19), smoothstep(0.4, 0.8, m3) * 0.45);
          cLit *= mix(1.0, 0.72, smoothstep(0.6, 0.95, w.b)); cLit *= mix(1.0, 0.62, inW * smoothstep(0.75, 1.0, w.b)); if (inW > 0.5) { cLit = mix(cLit, vec3(0.36, 0.38, 0.28), smoothstep(0.2, 0.85, texture2D(gNoise, p / 6.0 + 0.23).r) * 0.2); cLit = mix(cLit, vec3(0.13, 0.16, 0.09), smoothstep(0.2, 0.9, texture2D(gNoise, p / 2.6 + 0.67).g) * 0.2); } }
        // (A22: a red bare patch from the photos: the dirt tile, redder, where the splat's alpha marks it)
        cDirt = mix(cDirt, cDirt * vec3(0.92, 0.6, 0.6), clamp((1.0 - w.a) / 0.5, 0.0, 1.0));
        // (A22, coordinator round 2: Street View's slope scrub reads as faint irregular grey-green specks in the grass, not plants:
        // two noise scales, the coarse one leaving bare grass between the speckled patches)
        { float sk = smoothstep(0.5, 0.68, texture2D(gNoise, p / 2.3 + 0.17).g) * smoothstep(0.36, 0.6, texture2D(gNoise, p / 13.0 + 0.41).r);
          cGrass = mix(cGrass, vec3(dot(cGrass, vec3(0.3, 0.55, 0.15))) * vec3(0.8, 0.92, 0.66), sk * 0.75); }
        // (A26, west map only: alpha below 1 with neither dirt nor cut marks a bright lawn: the battery's mounds, the avenue, s7w_14255_a)
        cGrass = mix(cGrass, cGrass * vec3(0.94, 1.14, 0.66) * 1.06, inW * clamp((1.0 - w.a) / 0.5, 0.0, 1.0) * (1.0 - w.r) * (1.0 - w.g));
        // (A22, a22_1105_r: past the splat's box (jw-a21's terrain_ext, the ridge over the ravine) Street View's grass is vivid
        // green with darker scrub streaks down the fall line, not the tile's olive)
        { vec2 bu = (p - gBox.xy) * gBox.zw; float outBox = smoothstep(0.0, 0.04, max(max(-bu.x, bu.x - 1.0), max(-bu.y, bu.y - 1.0))) * (1.0 - inW);
          float streak = smoothstep(0.45, 0.7, texture2D(gNoise, vec2(p.x / 38.0, p.y / 9.0) + 0.29).g);
          cGrass = mix(cGrass, cGrass * vec3(0.78, 1.1, 0.62) * (1.0 - 0.35 * streak), outBox); }
        // (inside a drawn cut zone the face from about 15 degrees of true surface slope: the zone bounds it along the road,
        // the slope where it ends up the hill)
        // (the zone alone: it gives the face top, a clean line along the road; the terrain mesh's slope inside it is not
        // trusted, its flat facets showed as grass teeth in the face)
        // (the face's top edge ragged as the photo's, scrub and grass reaching down into it: the zone's soft edge broken by noise)
        float wc = smoothstep(0.4, 0.6, w.g + (texture2D(gNoise, p / 4.3).r - 0.5) * 0.9 * (1.0 - step(0.999, w.g))), wd = w.r * (1.0 - wc), wl = w.b * (1.0 - wc);
        vec3 c = cGrass;
        c = mix(c, cLit, clamp(wl, 0.0, 1.0));
        c = mix(c, cDirt, clamp(wd, 0.0, 1.0));
        c = mix(c, cCut, clamp(wc, 0.0, 1.0));
        diffuseColor.rgb *= c;
      }`);
  };
  m.customProgramCacheKey = () => 'jw-hand-ground19';
  groundShared = lambert(m); return groundShared;
}
