// World 3D life, kept cheap (a handful of instanced draws, updated each frame on the CPU): cars on the Golden Gate
// Bridge's six lanes and on the bigger roads round the rider (they pull out to pass a rider in their lane), people
// standing about at the vista points, gulls wheeling over the coast and turkey vultures soaring over the hills.
import { merge } from './props.js';
import { hash2 } from './landuse.js';

// vista points: [lat, lon, people]
const VISTAS = [[37.8277, -122.4836, 7], [37.8326, -122.4808, 9], [37.8259, -122.4996, 6], [37.9289, -122.5797, 6], [37.8637, -122.5824, 5],
  [37.8094, -122.4757, 8], [37.9046, -122.6029, 3], [37.8964, -122.6253, 4], [37.8580, -122.4840, 6], [37.8697, -122.4625, 4]];
const CAR_COLOURS = [0xf2f2f0, 0x1c1d20, 0x8d9196, 0xb9bcc0, 0x2c3e66, 0x7b1f1f, 0x355e3b, 0xd8d2c4, 0x4b4f55, 0xa33a2a, 0x2f5f86, 0xe0c060];
const SHIRTS = [0xd94b3d, 0x3d7bd9, 0xf2f2ee, 0x2b2f36, 0x6a8f4e, 0xe8a33a, 0x7a4fd1, 0x9fb3c8, 0xc9c0ae];

// speed (m/s) a car keeps behind a rider it cannot pass yet, and the side offset it moves to while passing: pure
export function passPlan(gap, lateral, carV, riderV) {
  if (gap < -6 || gap > 40 || Math.abs(lateral) > 3.2) return { v: carV, pull: 0 };   // not in the way
  const pull = Math.min(1, Math.max(0, (40 - gap) / 22));                             // pull out as it closes in
  return { v: Math.max(riderV + 3, carV * (0.55 + 0.45 * (1 - pull))), pull };
}

export function createLife({ THREE, scene, proj, marks, quality = 0 }) {
  const col = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  const B = (w, h, l, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, l).translate(x, y, z);
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();
  const lam = o => new THREE.MeshLambertMaterial({ vertexColors: true, ...o });

  /* cars: body (tinted per car), glass, wheels; faces -z */
  const white = col(0xffffff), glass = col(0x22282f), tyre = col(0x141414), lamp = col(0xfff2d8), red = col(0x9e1b1b);
  const wheel = (x, z) => [new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10).rotateZ(Math.PI / 2).translate(x, 0.33, z), tyre];
  const carGeo = merge([[B(1.82, 0.62, 4.4, 0, 0.62, 0), white], [B(1.62, 0.12, 4.2, 0, 0.98, 0.05), white], [B(1.56, 0.5, 2.3, 0, 1.25, 0.25), glass],
    [B(1.5, 0.06, 2.1, 0, 1.52, 0.3), white], [B(1.5, 0.12, 0.05, 0, 0.78, -2.21), lamp], [B(1.5, 0.12, 0.05, 0, 0.8, 2.21), red],
    wheel(-0.86, -1.35), wheel(0.86, -1.35), wheel(-0.86, 1.38), wheel(0.86, 1.38)]);
  const counts = [[44, 1, 1], [26, 1, 1], [10, 0.6, 0]][quality] ?? [26, 1, 1];
  const cars = new THREE.InstancedMesh(carGeo, lam(), counts[0]); cars.castShadow = quality === 0; cars.frustumCulled = false; scene.add(cars);
  for (let i = 0; i < counts[0]; i++) cars.setColorAt(i, C.set(CAR_COLOURS[i % CAR_COLOURS.length]));
  const fleet = [];
  for (let i = 0; i < counts[0]; i++) fleet.push({ i, kind: i < Math.round(counts[0] * 0.4) ? 'bridge' : 'road', live: false, s: 0, v: 0, pull: 0 });

  /* people: a shirt (tinted) and the rest (head, arms, legs) */
  const skin = col(0xd8a984), trousers = col(0x2e3440);
  const bodyGeo = merge([[new THREE.CapsuleGeometry(0.19, 0.42, 3, 8).scale(1, 1, 0.7).translate(0, 1.22, 0), white]]);
  const restGeo = merge([[new THREE.SphereGeometry(0.12, 8, 6).translate(0, 1.66, 0), skin], [new THREE.CylinderGeometry(0.075, 0.065, 0.86, 6).translate(-0.1, 0.43, 0), trousers],
    [new THREE.CylinderGeometry(0.075, 0.065, 0.86, 6).translate(0.1, 0.43, 0), trousers], [new THREE.CylinderGeometry(0.05, 0.045, 0.62, 5).translate(-0.24, 1.15, 0).rotateZ(0.05), skin],
    [new THREE.CylinderGeometry(0.05, 0.045, 0.62, 5).translate(0.24, 1.15, 0).rotateZ(-0.05), skin]]);
  const folk = [];
  for (const [la, lo, n] of VISTAS) {
    const [x, z] = proj.xz(la, lo);
    for (let k = 0; k < Math.round(n * counts[1]); k++) {
      const a = hash2(k, n * 17 + Math.round(x)) * 6.283, r = 3 + 12 * hash2(Math.round(z), k);
      folk.push({ x: x + Math.cos(a) * r, z: z + Math.sin(a) * r, yaw: hash2(k, 3) * 6.283, walk: hash2(k, 5) < 0.35, ph: hash2(k, 7) * 6.283, sc: 0.92 + 0.14 * hash2(k, 9), y: null, c: SHIRTS[(k + n) % SHIRTS.length] });
    }
  }
  const bodies = new THREE.InstancedMesh(bodyGeo, lam(), Math.max(1, folk.length)), rests = new THREE.InstancedMesh(restGeo, lam(), Math.max(1, folk.length));
  folk.forEach((p, i) => bodies.setColorAt(i, C.set(p.c)));
  for (const m of [bodies, rests]) { m.frustumCulled = false; m.castShadow = quality === 0; scene.add(m); }

  /* birds: a body and two wings that flap in the vertex shader (wing tips: attribute w = +-1); gulls white, vultures dark */
  const bird = (() => {
    const pos = [0, 0, -0.35, 0.06, 0, 0.3, -0.06, 0, 0.3, /* wings */ 0, 0, -0.12, 0.85, 0.02, 0.05, 0, 0, 0.18, 0, 0, -0.12, 0, 0, 0.18, -0.85, 0.02, 0.05];
    const w = [0, 0, 0, 0, 1, 0, 0, 0, -1], g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('w', new THREE.Float32BufferAttribute(w, 1)); g.computeVertexNormals();
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(27).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
    return g;
  })();
  const birdMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), bt = { value: 0 };
  birdMat.onBeforeCompile = sh => {
    sh.uniforms.bt = bt;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float w; uniform float bt;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21, sc = length(instanceMatrix[0].xyz);
        float flap = sc > 1.6 ? 0.06 * sin(bt * 1.3 + ph) : sin(bt * 7.0 + ph) * 0.45;  // vultures soar, gulls flap
        transformed.y += abs(w) * flap;
        #endif`);
  };
  birdMat.customProgramCacheKey = () => 'jw-bird-1';
  const NB = counts[2] ? 26 : 0, birds = new THREE.InstancedMesh(bird, birdMat, Math.max(1, NB)); birds.frustumCulled = false; birds.count = NB; scene.add(birds);
  const flocks = [];

  let t = 0;
  // ctx: { rider: { x, y, z, v, yaw }, roads: () => [{ P: [[x, y, z]], w, lanes, one, big }], ground: (x, z) -> h | null }
  function update(dt, ctx) {
    t += dt; bt.value = t;
    const R = ctx.rider;
    /* cars */
    let roads = null;
    const [bx, bz] = marks.lane ? [marks.lane(0, 0).x, marks.lane(0, 0).z] : [0, 0], nearBridge = marks.lane && Math.hypot(R.x - bx, R.z - bz) < 6000;
    for (const c of fleet) {
      if (c.kind === 'bridge') {
        if (!nearBridge) { c.live = false; continue; }
        if (!c.live) { const k = c.i; c.lane = (k % 3) + 1; c.dir = k % 2 ? 1 : -1; c.s = marks.span[0] + hash2(k, 11) * (marks.span[1] - marks.span[0]); c.v = 19 + 5 * hash2(k, 13); c.live = true; }
        c.s += c.dir * c.v * dt;
        if (c.s > marks.span[1] + 60) c.s = marks.span[0] - 60; if (c.s < marks.span[0] - 60) c.s = marks.span[1] + 60;
        const p = marks.lane(Math.max(marks.span[0], Math.min(marks.span[1], c.s)), c.dir * (c.lane * 3.33 - 1.66));
        const inside = c.s > marks.span[0] && c.s < marks.span[1];
        M4.compose(V.set(p.x, inside ? p.y : -50, p.z), Q.setFromEuler(E.set(0, p.yaw + (c.dir > 0 ? Math.PI : 0), 0)), S.set(1, 1, 1));
        cars.setMatrixAt(c.i, M4); continue;
      }
      // a car on a road near the rider
      if (!c.live || Math.hypot(c.x - R.x, c.z - R.z) > 900) {
        roads ??= ctx.roads();
        const cand = roads.filter(r => r.P.length > 4); c.live = false;
        if (!cand.length) { cars.setMatrixAt(c.i, M4.makeTranslation(0, -100, 0)); continue; }
        const r = cand[Math.floor(hash2(c.i, Math.floor(t * 3)) * cand.length) % cand.length], P = r.P;
        const k = Math.floor(hash2(Math.floor(t * 7), c.i) * (P.length - 2));
        if (Math.hypot(P[k][0] - R.x, P[k][2] - R.z) < 60) { cars.setMatrixAt(c.i, M4.makeTranslation(0, -100, 0)); continue; }  // never pop in next to the rider
        Object.assign(c, { r, k, f: 0, dir: r.one || hash2(c.i, k) < 0.5 ? 1 : -1, v0: (r.big ? 20 : 12) + 4 * hash2(k, c.i), live: true, x: P[k][0], z: P[k][2], pull: 0 });
        if (c.dir < 0) c.k = Math.max(1, k);
      }
      const P = c.r.P; let a = P[c.k], b = P[c.k + c.dir];
      if (!b) { c.live = false; continue; }
      let L = Math.hypot(b[0] - a[0], b[2] - a[2]) || 0.01;
      // the rider ahead in this lane: slow and pull out to pass
      const dx = (b[0] - a[0]) / L, dz = (b[2] - a[2]) / L, rx = -dz, rz = dx;
      const half = c.r.w / 2, laneOff = c.r.one ? half - 1.9 : Math.min(half - 1.6, c.r.w / (2 * c.r.lanes) * (c.r.lanes > 2 ? 3 : 1));
      const gx = R.x - c.x, gz = R.z - c.z, gap = gx * dx + gz * dz, lat = gx * rx + gz * rz, plan = passPlan(gap, lat, c.v0, R.v);
      c.pull += (plan.pull - c.pull) * Math.min(1, dt * 1.5);
      c.f += plan.v * dt / L;
      while (c.f >= 1) { c.f -= 1; c.k += c.dir; a = P[c.k]; b = P[c.k + c.dir]; if (!b) break; const L2 = Math.hypot(b[0] - a[0], b[2] - a[2]) || 0.01; c.f *= L / L2; L = L2; }
      if (!b) { c.live = false; continue; }
      const off = laneOff - c.pull * (laneOff + (c.r.one ? -1.2 : 1.0));
      const ex = (b[0] - a[0]) / L, ez = (b[2] - a[2]) / L;
      c.x = a[0] + (b[0] - a[0]) * c.f - ez * off; c.z = a[2] + (b[2] - a[2]) * c.f + ex * off;
      const y = a[1] + (b[1] - a[1]) * c.f - 0.2;
      M4.compose(V.set(c.x, y, c.z), Q.setFromEuler(E.set(Math.atan2(b[1] - a[1], L), Math.atan2(-ex, -ez), 0, 'YXZ')), S.set(1, 1, 1));
      cars.setMatrixAt(c.i, M4);
    }
    cars.instanceMatrix.needsUpdate = true;
    /* people: standing about near the rider, a few walking slowly to and fro */
    let n = 0;
    for (const p of folk) {
      if (Math.abs(p.x - R.x) > 1500 || Math.abs(p.z - R.z) > 1500) continue;
      p.y ??= ctx.ground(p.x, p.z);
      if (p.y == null || p.y < 0.5) { p.y = null; continue; }
      const w = p.walk ? Math.sin(t * 0.25 + p.ph) * 4 : 0, x = p.x + Math.cos(p.yaw) * w, z = p.z + Math.sin(p.yaw) * w;
      const yaw = p.walk ? -p.yaw + (Math.cos(t * 0.25 + p.ph) > 0 ? Math.PI / 2 : -Math.PI / 2) : -p.yaw + Math.sin(t * 0.3 + p.ph) * 0.4;
      M4.compose(V.set(x, p.y - 0.05, z), Q.setFromEuler(E.set(0, yaw, Math.sin(t * (p.walk ? 4 : 0.8) + p.ph) * 0.03)), S.set(p.sc, p.sc, p.sc));
      bodies.setMatrixAt(n, M4); rests.setMatrixAt(n, M4); if (bodies.instanceColor) bodies.setColorAt(n, C.set(p.c)); n++;
    }
    bodies.count = rests.count = n; bodies.instanceMatrix.needsUpdate = rests.instanceMatrix.needsUpdate = true; if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    /* birds: flocks round the rider; gulls where the ground below is the sea or the shore, vultures inland */
    if (NB) {
      while (flocks.length < 4) {
        const a = hash2(flocks.length, Math.floor(t)) * 6.283 + R.yaw, d = 140 + 360 * hash2(Math.floor(t), flocks.length);
        const fx = R.x + Math.sin(a) * d, fz = R.z - Math.cos(a) * d, g = ctx.ground(fx, fz) ?? 0, sea = g < 1.5;
        flocks.push({ x: fx, z: fz, y: Math.max(g, R.y) + (sea ? 25 : 60) + 50 * hash2(flocks.length, 9), r: sea ? 25 + 35 * hash2(3, flocks.length) : 60 + 50 * hash2(4, flocks.length), w: (sea ? 0.35 : 0.12) * (hash2(flocks.length, 5) < 0.5 ? 1 : -1), sea, n: sea ? 8 : 3 });
      }
      let i = 0;
      for (let f = flocks.length - 1; f >= 0; f--) if (Math.hypot(flocks[f].x - R.x, flocks[f].z - R.z) > 1100) flocks.splice(f, 1);
      for (const F of flocks) for (let k = 0; k < F.n && i < NB; k++, i++) {
        const a = t * F.w + k * (6.283 / F.n) + Math.sin(t * 0.3 + k) * 0.4, rr = F.r * (0.7 + 0.3 * hash2(k, 2)), y = F.y + Math.sin(t * 0.5 + k * 1.7) * 6;
        const x = F.x + Math.cos(a) * rr, z = F.z + Math.sin(a) * rr, hd = Math.atan2(-Math.sin(a), Math.cos(a)) * Math.sign(F.w);
        const sc = F.sea ? 1.1 : 2.1;
        M4.compose(V.set(x, y, z), Q.setFromEuler(E.set(0, -hd + (F.w > 0 ? 0 : Math.PI), F.w > 0 ? -0.25 : 0.25)), S.set(sc, sc, sc));
        birds.setMatrixAt(i, M4); birds.setColorAt(i, C.set(F.sea ? 0xf4f4f0 : 0x2a2522));
      }
      birds.count = i; birds.instanceMatrix.needsUpdate = true; if (birds.instanceColor) birds.instanceColor.needsUpdate = true;
    }
  }
  return {
    update,
    get counts() { return { cars: fleet.filter(c => c.live).length, people: bodies.count, birds: birds.count }; },
    dispose() { for (const m of [cars, bodies, rests, birds]) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); m.dispose(); } },
  };
}
