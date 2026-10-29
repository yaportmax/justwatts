// World 3D cyclist: a procedural low-poly bike and rider. Cadence turns the crank and the legs follow the pedals
// (two-bone IK in the bike's plane), speed turns the wheels. The model faces -z (three.js forward), origin on the
// ground between the wheels. legs(): the pure leg solver, tested in tests/test_world3d.py.

export const BIKE = { wheel: 0.34, base: 1.0, bb: [0.0, 0.29, 0.02], crank: 0.17, saddle: [0, 1.0, 0.22], bars: [0, 1.02, -0.5], thigh: 0.46, shin: 0.47 };

// knee position for a hip and a foot in the bike plane (y up, z along the bike, -z forward): the knee bends forward
export function knee(hip, foot, a = BIKE.thigh, b = BIKE.shin) {
  const dy = foot[0] - hip[0], dz = foot[1] - hip[1], d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, Math.hypot(dy, dz)));
  const ux = dy / (Math.hypot(dy, dz) || 1), uz = dz / (Math.hypot(dy, dz) || 1), x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
  // the perpendicular toward the front (-z)
  let px = -uz, pz = ux; if (pz > 0) { px = -px; pz = -pz; }
  return [hip[0] + ux * x + px * h, hip[1] + uz * x + pz * h];
}

// THREE: the three.js module. kit: jersey colour. Returns { group, update(dt, cadence rpm, speed m/s, watts) }
export function makeRider(THREE, { kit = 0xf2c230, kit2 = 0x1d232b, skin = 0xe0b48f, bike = 0x2a2f36, accent = null } = {}) {
  const group = new THREE.Group(), mats = new Map();
  const mat = c => { if (!mats.has(c)) mats.set(c, new THREE.MeshLambertMaterial({ color: c, flatShading: true })); return mats.get(c); };
  const cyl = (r, l, c, s = 6) => { const g = new THREE.CylinderGeometry(r, r, l, s); return new THREE.Mesh(g, mat(c)); };
  // a tube between two points [x, y, z]
  const tube = (p, q, r, c, s = 6) => { const m = cyl(r, 1, c, s); place(m, p, q); return m; };
  const up = new THREE.Vector3(0, 1, 0), tv = new THREE.Vector3();
  function place(m, p, q) {
    tv.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]); const l = tv.length() || 1e-3;
    m.position.set((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2); m.scale.set(1, l, 1);
    m.quaternion.setFromUnitVectors(up, tv.normalize());
  }
  const W = BIKE.wheel, rear = [0, W, BIKE.base / 2], front = [0, W, -BIKE.base / 2], bb = BIKE.bb;
  const seat = [0, 0.93, 0.17], head = [0, 0.86, -0.43], barC = [0, BIKE.bars[1] - 0.04, BIKE.bars[2]];
  const frame = accent ?? bike;
  // wheels: tyre, rim, a few spokes; each spins about its axle
  const wheels = [];
  for (const at of [rear, front]) {
    const w = new THREE.Group(); w.position.set(...at);
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(W - 0.02, 0.022, 4, 18), mat(0x16181b)); tyre.rotation.y = Math.PI / 2; w.add(tyre);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(W - 0.06, 0.016, 3, 18), mat(0x3a4048)); rim.rotation.y = Math.PI / 2; w.add(rim);
    for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.008, 2 * (W - 0.06), 0.016), mat(0x8a9099)); s.rotation.x = k * Math.PI / 3; w.add(s); }
    group.add(w); wheels.push(w);
  }
  // frame
  for (const [p, q, r] of [[rear, bb, 0.016], [rear, seat, 0.014], [bb, seat, 0.022], [bb, head, 0.026], [seat, head, 0.022], [head, front, 0.016], [head, [0, 0.98, -0.47], 0.018]])
    group.add(tube([0.035, p[1], p[2]], [0.035, q[1], q[2]], r, frame)), r < 0.02 && group.add(tube([-0.035, p[1], p[2]], [-0.035, q[1], q[2]], r, frame));
  group.add(tube([0, seat[1], seat[2]], [0, BIKE.saddle[1] - 0.04, BIKE.saddle[2] + 0.02], 0.012, 0x22262b));
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 0.26), mat(0x111317)); saddle.position.set(0, BIKE.saddle[1] - 0.025, BIKE.saddle[2] + 0.02); group.add(saddle);
  const bar = cyl(0.014, 0.42, 0x22262b); bar.rotation.z = Math.PI / 2; bar.position.set(...barC); group.add(bar);
  for (const s of [1, -1]) group.add(tube([0.19 * s, barC[1], barC[2]], [0.19 * s, barC[1] - 0.1, barC[2] - 0.1], 0.013, 0x22262b));
  // crank and pedals
  const crank = new THREE.Group(); crank.position.set(...bb); group.add(crank);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 14), mat(0x60666e)); ring.rotation.z = Math.PI / 2; ring.position.x = -0.06; crank.add(ring);
  const arms = [];
  for (const s of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, BIKE.crank + 0.03), mat(0x2b2f35)); crank.add(arm); arms.push({ arm, s });
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.07), mat(0x111317)); crank.add(pedal); arms.at(-1).pedal = pedal;
  }
  // rider: torso from the hips to the shoulders, head, arms to the bars, legs to the pedals
  const hip = [0, BIKE.saddle[1] + 0.03, BIKE.saddle[2] - 0.02], sh = [0, 1.43, -0.3];
  const torso = tube([0, hip[1], hip[2]], [0, sh[1], sh[2]], 0.15, kit, 7); torso.scale.x = 1.15; group.add(torso);
  const shorts = tube([0, hip[1] - 0.04, hip[2] + 0.02], [0, hip[1] + 0.14, hip[2] - 0.04], 0.155, kit2, 7); group.add(shorts);
  const headG = new THREE.Group(); headG.position.set(0, sh[1] + 0.15, sh[2] - 0.16); group.add(headG);
  const face = new THREE.Mesh(new THREE.IcosahedronGeometry(0.105, 0), mat(skin)); headG.add(face);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(kit)); helmet.position.set(0, 0.03, 0.02); helmet.rotation.x = -0.35; headG.add(helmet);
  for (const s of [1, -1]) {
    const S = [0.17 * s, sh[1] - 0.02, sh[2]], E = [0.2 * s, sh[1] - 0.17, sh[2] - 0.2], H = [0.19 * s, barC[1] - 0.02, barC[2] - 0.03];
    group.add(tube(S, E, 0.045, kit)); group.add(tube(E, H, 0.038, skin));
  }
  const legs = [];
  for (const s of [1, -1]) {
    const th = cyl(0.068, 1, kit2, 6), sn = cyl(0.05, 1, skin, 6), shoe = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.24), mat(0x15171a));
    group.add(th, sn, shoe); legs.push({ s, th, sn, shoe });
  }
  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

  let ca = 0, wa = 0;
  function pose() {
    crank.rotation.x = 0;
    for (const { arm, s, pedal } of arms) {
      const a = ca + (s > 0 ? 0 : Math.PI), py = Math.sin(a) * BIKE.crank, pz = -Math.cos(a) * BIKE.crank;
      arm.position.set(0.09 * s, py / 2, pz / 2); arm.rotation.x = a;
      pedal.position.set(0.14 * s, py, pz);
    }
    for (const L of legs) {
      const a = ca + (L.s > 0 ? 0 : Math.PI), fy = bb[1] + Math.sin(a) * BIKE.crank + 0.03, fz = bb[2] - Math.cos(a) * BIKE.crank + 0.02;
      const k = knee([hip[1], hip[2]], [fy, fz]), x = 0.1 * L.s;
      place(L.th, [x, hip[1], hip[2]], [x, k[0], k[1]]); place(L.sn, [x, k[0], k[1]], [x, fy, fz]);
      L.shoe.position.set(x + 0.02 * L.s, fy - 0.01, fz - 0.03);
    }
  }
  pose();
  return {
    group,
    // dt seconds, cadence rpm, v m/s
    update(dt, cadence, v) {
      ca = (ca + (cadence || 0) / 60 * 2 * Math.PI * dt) % (2 * Math.PI);
      wa = (wa + (v || 0) / W * dt) % (2 * Math.PI);
      for (const w of wheels) w.rotation.x = -wa;
      pose();
    },
    dispose() { group.traverse(o => o.geometry?.dispose()); for (const m of mats.values()) m.dispose(); },
  };
}
