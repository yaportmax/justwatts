// World 3D coastal scrub: the Headlands' bushes on the ground cover's scrub (veg.js), in square cells round the camera
// built within a time budget each frame (as the grass), each cell the same every time (placement hashed from the
// cell). All the cells' bushes go into one instanced draw per kind, nearest first: in full near the camera, with
// fewer, bigger leaf cards further out, shrinking into the ground over the outer quarter of the radius (materials.js
// propMaterial fade). Coyote brush in most patches, sage in some, a bush every few metres where the scrub is: a
// continuous cover as high as the lidar has it (veg.js scrubH), with the grass openings the imagery shows. cellBushes is pure:
// tests/test_world3d.py.
import { hash2 } from './landuse.js';
import { SCRUB } from './veg.js';

export const SIZE = 32, STEP = 2.5;
// The bushes of cell (ci, cj) (SIZE metres a side, local metres): [[x, z, scale, turn, sage (0/1), tint, stretch, height
// scale], ...].
// cls(x, z): the ground cover's class there; hgt(x, z): the scrub's height there from the lidar (veg.js scrubH: metres, 0
// none, -1 under a tree's crown, null unknown): each bush's top that high, a fifth either way (Street View: coyote brush and
// sage 0.3 to 1.5 m along the roads, user_conzelman_railbend), none where it is under 0.25 m or a crown stands
export const TOP = 1.5;  // a bush's top at scale 1 (props.js scrubGeometries, its foot sunk 0.15)
export function cellBushes(ci, cj, cls, hgt = null) {
  const out = [], n = SIZE / STEP;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const gi = ci * n + a, gj = cj * n + b, x = (gi + hash2(gi, gj * 3 + 1)) * STEP, z = (gj + hash2(gj + 5, gi * 7)) * STEP;
    if (cls(x, z) !== SCRUB || hash2(gi * 5 + 3, gj) > 0.96) continue;  // a gap now and then (few: Street View's cover is unbroken)
    // patches of taller and lower scrub (about 60 m), sage on two in five (about 120 m)
    const tall = hash2(Math.floor(x / 60), Math.floor(z / 60) + 17), sage = hash2(Math.floor(x / 120) + 9, Math.floor(z / 120)) < 0.4 && hash2(gi, gj + 11) < 0.7 ? 1 : 0;
    const tint = hash2(gj * 3, gi + 5), H = hgt ? hgt(x, z) : null;
    if (H != null && H < 0.25) continue;  // (grass between the bushes, or a tree's crown over them)
    // (its spread as before (a continuous cover) within 1 to 2.2 times its height scale; its height the lidar's: the low
    // ones broad mounds, touching)
    let sc = (0.6 + 0.8 * hash2(gj, gi + 3) ** 1.5) * (0.8 + 0.45 * tall), vh = sc;
    if (H != null) { vh = H * (0.8 + 0.4 * hash2(gi + 17, gj)) / (TOP * (0.75 + 0.5 * tint)); sc = Math.max(vh, Math.min(sc, vh * 2.2)); }
    out.push([x, z, sc, hash2(gi + 1, gj + 2) * 6.283, sage, tint, 0.75 + 0.5 * hash2(gi * 7, gj + 13), vh]);
  }
  return out;
}

// geos: { brush, brushLo, sage, sageLo } (props.js scrubGeometries); mat: propMaterial({ fade }) with fade = { centre,
// radius }; cls(x, z): the cover's class; hgt(x, z): the scrub's height (cellBushes); ground(x, z, w) -> { h, skip, reach,
// top, slope } | null (null: not loaded yet, tried again later; w: the bush's widest stretch, for its clearance; reach, top:
// the largest spread and height scale it may have there (clear of a road's edge, low beside it); grad: the ground's
// slope there [dh/dx, dh/dz])
export const REACH = 2.6;  // how far a bush's leaves reach from its middle at scale 1 (props.js scrubGeometries)
export function createScrub({ THREE, scene, geos, mat, fade, cls, hgt = null, ground }) {
  const cells = new Map(), pend = new Map();
  let R = 150, NEAR = 45, gen = 0, dirty = true, at = [1e9, 1e9], cast = 0, merged = 0;
  const kinds = ['brush', 'brushLo', 'sage', 'sageLo'], mesh = {}, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qt = new THREE.Quaternion(), nv = new THREE.Vector3(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
  // a draw for kind k with room for n bushes: the full models cast shadows (the nearest ones only: they come first)
  function make(k, n) {
    const m = new THREE.InstancedMesh(geos[k], mat, n); m.count = 0; m.frustumCulled = false; m.receiveShadow = true;
    m.castShadow = k === 'brush' || k === 'sage'; m.customDepthMaterial = mat.userData.depth; m.userData.shared = true;
    m.onBeforeShadow = () => { m.userData.all = m.count; m.count = Math.min(m.count, m.userData.cast ?? 0); }; m.onAfterShadow = () => { m.count = m.userData.all; };
    scene.add(m); return m;
  }
  for (const k of kinds) mesh[k] = make(k, 64);
  // a cell's bushes on the ground: per bush [x, y, z, scale, turn, sage, tint, stretch, height scale, lean x, lean z]; a
  // generator (a slice at a time)
  function* build(ci, cj) {
    const list = cellBushes(ci, cj, cls, hgt), out = [];
    for (let k = 0; k < list.length; k++) {
      if ((k & 63) === 63) yield;
      const [x, z, sc0, turn, sage, t, st, vh0] = list[k], w = Math.max(st, 1 / Math.sqrt(st)), g = ground(x, z, w);
      if (g === null) return null;  // the ground is not there yet
      if (g.skip) continue;
      const sc = Math.min(sc0, g.reach ?? Infinity), vh = Math.min(vh0, g.top ?? Infinity, sc * 1.3); if (sc < 0.15 || vh < 0.12) continue;
      // (on a slope it leans with the ground, seven tenths of the way (Street View: coyote brush hugs a bank; upright, its
      // downhill side stood off it, its leaves' undersides showing); its foot sunk by what the lean leaves of the ground's
      // fall across its reach)
      const [gx, gz] = g.grad || [0, 0], f = 0.7, sl = Math.hypot(gx, gz) * (1 - f);
      out.push([x, g.h - Math.min(0.1 * vh + sl * 0.4 * REACH * sc * w, 0.4 * TOP * vh), z, sc, turn, sage, t, st, vh, -gx * f, -gz * f]);
    }
    return out;
  }
  // every cell's bushes into the four draws, nearest cell first: full models within NEAR, the light ones past it. Each
  // time new draws with their own buffers (the old ones dropped): writing into a buffer the GPU may still be drawing
  // from makes the browser wait for the GPU, hundreds of milliseconds on a busy frame
  function merge(x, z) {
    const list = [...cells.values()].map(c => [Math.hypot((c.i + 0.5) * SIZE - x, (c.j + 0.5) * SIZE - z), c]).sort((a, b) => a[0] - b[0]);
    const per = Object.fromEntries(kinds.map(k => [k, []]));
    for (const [d, c] of list) for (const b of c.bushes) per[(b[5] ? 'sage' : 'brush') + (d < NEAR ? '' : 'Lo')].push(b);
    for (const k of kinds) {
      const items = per[k], old = mesh[k], m = mesh[k] = make(k, Math.max(1, items.length));
      m.visible = old.visible; scene.remove(old); old.dispose();
      let n = 0, nc = 0;
      for (const [bx, by, bz, sc, turn, sage, t, st, vh, lx = 0, lz = 0] of items) {
        q.setFromAxisAngle(up, turn); if (lx || lz) q.premultiply(qt.setFromUnitVectors(up, nv.set(lx, 1, lz).normalize()));
        m.setMatrixAt(n, m4.compose(v.set(bx, by, bz), q, s.set(sc * st, vh * (0.75 + 0.5 * t), sc / Math.sqrt(st))));
        const kk = 0.84 + 0.3 * t, w = (hash2(Math.round(bx), Math.round(bz)) - 0.5) * 0.14;
        m.setColorAt(n++, tint.setRGB(kk * (1 + w), kk, kk * (1 - w * 0.6)));
        if (Math.hypot(bx - x, bz - z) < cast) nc = n;
      }
      m.count = n; m.userData.cast = nc;
    }
  }
  return {
    // keep the cells round (x, z) built (at most `budget` ms of new ones a frame, nearest first); shadows from the
    // bushes within `shadow` metres
    update(x, z, budget = 1.5, shadow = 60) {
      fade.centre.value.set(x, z); fade.radius.value = R; cast = shadow;
      const t0 = performance.now(), keep = new Set(), i0 = Math.floor((x - R) / SIZE), i1 = Math.floor((x + R) / SIZE), j0 = Math.floor((z - R) / SIZE), j1 = Math.floor((z + R) / SIZE), want = [];
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const d = Math.hypot(Math.max(i * SIZE - x, 0, x - (i + 1) * SIZE), Math.max(j * SIZE - z, 0, z - (j + 1) * SIZE));
        if (d < R) want.push([d, i, j]);
      }
      want.sort((a, b) => a[0] - b[0]);
      for (const [, i, j] of want) {
        const k = i + ',' + j; keep.add(k);
        if (cells.get(k)?.gen === gen || performance.now() - t0 > budget) continue;
        let p = pend.get(k); if (!p || p.gen !== gen) pend.set(k, p = { it: build(i, j), gen });
        let r; do r = p.it.next(); while (!r.done && performance.now() - t0 < budget);
        if (r.done) { pend.delete(k); if (r.value) { cells.set(k, { i, j, gen, bushes: r.value }); dirty = true; } }
      }
      for (const k of [...pend.keys()]) if (!keep.has(k)) pend.delete(k);
      for (const [k, c] of cells) if (!keep.has(k)) { const d = Math.hypot(Math.max(c.i * SIZE - x, 0, x - (c.i + 1) * SIZE), Math.max(c.j * SIZE - z, 0, z - (c.j + 1) * SIZE)); if (d > R + SIZE) { cells.delete(k); dirty = true; } }
      // the draws again when cells came or went (at most twice a second) or after 16 m
      if ((dirty && t0 - merged > 500) || Math.hypot(x - at[0], z - at[1]) > 16) { dirty = false; at = [x, z]; merged = t0; merge(x, z); }
    },
    // radius and the full models' radius; rebuilds every cell
    set(r, near) { if (r === R && near === NEAR) return; R = r; NEAR = near; gen++; dirty = true; },
    // the ground under box [x0, z0, x1, z1] changed: build its cells again (all without one)
    invalidate(box) {
      if (!box) { gen++; return; }
      for (const c of cells.values()) if ((c.i + 1) * SIZE > box[0] && c.i * SIZE < box[2] && (c.j + 1) * SIZE > box[1] && c.j * SIZE < box[3]) c.gen = -1;
      for (const [k, p] of pend) { const [i, j] = k.split(',').map(Number); if ((i + 1) * SIZE > box[0] && i * SIZE < box[2] && (j + 1) * SIZE > box[1] && j * SIZE < box[3]) p.gen = -1; }
    },
    show(on) { for (const k of kinds) mesh[k].visible = on; },
    get count() { return kinds.reduce((n, k) => n + mesh[k].count, 0); },
    dispose() { for (const k of kinds) { scene.remove(mesh[k]); mesh[k].dispose(); } cells.clear(); pend.clear(); },
  };
}
