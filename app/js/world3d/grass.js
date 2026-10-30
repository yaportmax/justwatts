// World 3D grass: clumps of blades in square cells round the camera, built a few cells a frame, each cell the same
// every time (placement hashed from the cell). The blades take the ground's colour and sway in the vertex shader
// (materials.js grassMaterial). cellPoints and cellsAround are pure: tests/test_world3d.py.
import { hash2 } from './landuse.js';

// n points in cell (ci, cj) of `size` metres: [[x, z, r], ...], r a random 0..1; the same for the same cell
export function cellPoints(ci, cj, size, n, seed = 0) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = hash2(ci * 977 + k * 13, cj * 131 + seed), b = hash2(cj * 733 + k * 7, ci * 389 - seed * 3), r = hash2(ci + k * 31, cj - k * 17 + seed);
    out.push([(ci + a) * size, (cj + b) * size, r]);
  }
  return out;
}
// the cells within radius R of (x, z), nearest first: [[ci, cj, distance to the cell's nearest point], ...]
export function cellsAround(x, z, R, size) {
  const out = [], i0 = Math.floor((x - R) / size), i1 = Math.floor((x + R) / size), j0 = Math.floor((z - R) / size), j1 = Math.floor((z + R) / size);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const dx = Math.max(i * size - x, 0, x - (i + 1) * size), dz = Math.max(j * size - z, 0, z - (j + 1) * size), d = Math.hypot(dx, dz);
    if (d < R) out.push([i, j, d]);
  }
  return out.sort((a, b) => a[2] - b[2]);
}

// a clump of tapered, bent blades (three segments each), about 0.5 to 0.8 m: { pos, idx } for a BufferGeometry
export function clumpGeometry(blades = 9) {
  const pos = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const a = b * 2.39996 + 0.3, r = 0.03 + 0.17 * hash2(b, 3), h = 0.3 + 0.32 * hash2(b, 5), lean = 0.08 + 0.22 * hash2(b, 7), w = 0.018 + 0.012 * hash2(b, 9);
    const cx = Math.cos(a), cz = Math.sin(a), px = -cz, pz = cx, base = pos.length / 3;
    for (let s = 0; s <= 3; s++) {
      const t = s / 3, y = h * t, out = r + lean * t * t, ww = s === 3 ? 0 : w * (1 - t * 0.7);
      pos.push(cx * out + px * ww, y, cz * out + pz * ww);
      if (s < 3) pos.push(cx * out - px * ww, y, cz * out - pz * ww);
    }
    // 0 1 / 2 3 / 4 5 / 6 (tip)
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3, base + 2, base + 4, base + 3, base + 3, base + 4, base + 5, base + 4, base + 6, base + 5);
  }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) };
}

// THREE, scene, mat: grassMaterial(); sample(x, z) -> { h, nx, ny, nz, cv, m: [wood, green, sand, town], skip } | null
export function createGrass({ THREE, scene, mat, sample }) {
  const SIZE = 20, cells = new Map(), g0 = clumpGeometry(), geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g0.pos, 3)); geo.setIndex(new THREE.BufferAttribute(g0.idx, 1));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(g0.pos.length).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
  let R = 60, density = 3, gen = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  // a cell: two sets, the sparse third of the clumps (drawn out to the edge) and the dense rest (drawn near only)
  const DENSE = 0.33;
  function build(ci, cj) {
    const pts = cellPoints(ci, cj, SIZE, Math.round(SIZE * SIZE * density)), sets = [[[], [], []], [[], [], []]];
    for (const [x, z, r] of pts) {
      const g = sample(x, z); if (!g || g.skip) continue;
      const m = g.m, keep = 1 - m[0] * 0.5 - m[2] * 0.75 - m[3] * 0.35 - Math.max(0, 0.86 - g.ny) * 6;
      if (r > keep) continue;
      const sc = 0.7 + 0.6 * hash2(Math.round(x * 10), Math.round(z * 10)), w = hash2(Math.round(z * 10), Math.round(x * 10)), [M, A, B] = sets[w < DENSE ? 0 : 1];
      M.push(m4.compose(v.set(x, g.h - 0.04, z), q.setFromAxisAngle(up, r * 40), s.set(sc, sc * (0.75 + 0.5 * ((r * 7.3) % 1)) * (1 - m[2] * 0.4), sc)).clone());
      A.push(g.nx, g.nz, g.cv, w); B.push(m[0], m[1], m[2], m[3]);
    }
    const mk = ([M, A, B]) => {
      if (!M.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, M.length);
      M.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.geometry = geo.clone(); im.geometry.setAttribute('gA', new THREE.InstancedBufferAttribute(new Float32Array(A), 4)); im.geometry.setAttribute('gB', new THREE.InstancedBufferAttribute(new Float32Array(B), 4));
      im.computeBoundingSphere(); im.receiveShadow = true; im.frustumCulled = true; im.matrixAutoUpdate = false; scene.add(im);
      return im;
    };
    return { sparse: mk(sets[0]), dense: mk(sets[1]) };
  }
  function drop(k) { const c = cells.get(k); for (const m of [c?.mesh?.sparse, c?.mesh?.dense]) if (m) { scene.remove(m); m.geometry.dispose(); m.dispose(); } cells.delete(k); }
  return {
    // keep the cells round (x, z) built; build at most `budget` ms of new ones (nearest first)
    update(x, z, budget = 2) {
      mat.userData.u.centre.value.set(x, z); mat.userData.u.radius.value = R;
      const want = cellsAround(x, z, R, SIZE), keep = new Set(), t0 = performance.now();
      for (const [i, j] of want) {
        const k = i + ',' + j; keep.add(k);
        if (cells.has(k) && cells.get(k).gen === gen) continue;
        if (performance.now() - t0 > budget) continue;
        drop(k); cells.set(k, { mesh: build(i, j), gen, i, j });
      }
      // the dense sets only near the camera (the shader thins them out from a quarter of the radius anyway)
      for (const c of cells.values()) if (c.mesh?.dense) { const dx = Math.max(c.i * SIZE - x, 0, x - (c.i + 1) * SIZE), dz = Math.max(c.j * SIZE - z, 0, z - (c.j + 1) * SIZE); c.mesh.dense.visible = Math.hypot(dx, dz) < R * 0.5; }
      for (const k of [...cells.keys()]) if (!keep.has(k)) { const [i, j] = k.split(',').map(Number), dx = Math.max(i * SIZE - x, 0, x - (i + 1) * SIZE), dz = Math.max(j * SIZE - z, 0, z - (j + 1) * SIZE); if (Math.hypot(dx, dz) > R + SIZE) drop(k); }
    },
    // radius and clumps per square metre; rebuilds every cell
    set(r, d) { if (r === R && d === density) return; R = r; density = d; gen++; },
    // the ground under some cells changed (a tile was rebuilt): build them again
    invalidate() { gen++; },
    get count() { let n = 0; for (const c of cells.values()) n += (c.mesh?.sparse?.count || 0) + (c.mesh?.dense?.visible ? c.mesh.dense.count : 0); return n; },
    dispose() { for (const k of [...cells.keys()]) drop(k); geo.dispose(); },
  };
}
