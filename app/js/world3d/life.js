// World 3D life, kept cheap (a handful of instanced draws, updated each frame on the CPU): cars on the Golden Gate
// Bridge's six lanes and on the bigger roads round the rider (they wait behind a rider until they can pass with room,
// and never touch one; lamps and light on the road at dusk), people standing about at the vista points, gulls
// wheeling over the coast and turkey vultures soaring over the hills.
import { merge } from './props.js';
import { withSun } from './materials.js';
import { hash2 } from './landuse.js';

// vista points: [lat, lon, people]
const VISTAS = [[37.8277, -122.4836, 7], [37.8326, -122.4808, 9], [37.8259, -122.4996, 6], [37.9289, -122.5797, 6], [37.8637, -122.5824, 5],
  [37.8094, -122.4757, 8], [37.9046, -122.6029, 3], [37.8964, -122.6253, 4], [37.8580, -122.4840, 6], [37.8697, -122.4625, 4]];
const CAR_COLOURS = [0xf2f2f0, 0x1c1d20, 0x8d9196, 0xb9bcc0, 0x2c3e66, 0x7b1f1f, 0x355e3b, 0xd8d2c4, 0x4b4f55, 0xa33a2a, 0x2f5f86, 0xe0c060];
const SHIRTS = [0xd94b3d, 0x3d7bd9, 0xf2f2ee, 0x2b2f36, 0x6a8f4e, 0xe8a33a, 0x7a4fd1, 0x9fb3c8, 0xc9c0ae];

// A car near riders on its road: the speed (m/s) it may go and the offset it steers for (metres right of the road's
// centre line). gap: the rider's distance ahead of the car's middle along the road; rl: the rider's offset; laneOff:
// the car's lane; leftmost: as far left as it may go (the oncoming lane when that is clear); off: where it is now.
// It passes only with room (CLEAR centre to centre across: half a car, a shoulder and well over a metre between),
// slowing behind until it has moved over; with no room it follows at the rider's speed. Pure: tests/test_world3d.py.
export const CLEAR = 2.4;
export function passPlan(gap, rl, off, laneOff, leftmost, carV, riderV) {
  if (gap < -7 || gap > 70) return { v: carV, target: laneOff };                    // past it, or far ahead
  const room = rl - CLEAR;                                                           // the offset that leaves room
  if (laneOff <= room || rl - laneOff > CLEAR + 1.5) return { v: carV, target: laneOff };  // its lane clears the rider
  if (rl + CLEAR < laneOff && gap > 0) return { v: carV, target: laneOff };          // a rider well left of the lane
  if (room >= leftmost) {
    const short = off - room;                                                        // metres still to move over
    const v = short < 0.2 ? Math.max(Math.min(carV, riderV + 6), carV * 0.6) : Math.min(carV, riderV + Math.max(0, gap - 9) * 0.6);
    return { v: Math.max(0, v), target: room };
  }
  return { v: Math.max(0, Math.min(carV, riderV + (gap - 12) * 0.5)), target: laneOff };  // no room: follow 12 m back
}
// One step of a car on its road, in road terms: the car's middle at 0 along and `off` across, riders [{ gap, rl, v }];
// it eases toward the plan's speed and offset (ahead: a speed the car in front allows) and moves on, unless moving
// would bring it within half a metre of a rider: then it waits. -> { v, off, move } (metres along). Pure:
// tests/test_world3d.py drives a car up behind riders with it.
export function carStep(c, riders, { laneOff, leftmost, L, W, ahead = Infinity }, dt) {
  let vT = Math.min(c.v0, ahead), target = laneOff;
  for (const o of riders) { const p = passPlan(o.gap, o.rl, c.off, laneOff, leftmost, c.v0, o.v); vT = Math.min(vT, p.v); target = Math.min(target, p.target); }
  const off = c.off + Math.max(-1.7 * dt, Math.min(1.7 * dt, target - c.off)), v = Math.max(0, c.v + Math.max(-7 * dt, Math.min(2.5 * dt, vT - c.v))), move = v * dt;
  if (riders.some(o => Math.abs(o.gap - move) < L / 2 + 0.5 && Math.abs(o.rl - off) < W / 2 + 0.5)) return { v: 0, off, move: 0 };
  return { v, off, move };
}

export function createLife({ THREE, scene, proj, marks, quality = 0 }) {
  const col = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  const B = (w, h, l, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, l).translate(x, y, z);
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();
  const lam = o => new THREE.MeshLambertMaterial({ vertexColors: true, ...o });

  /* cars: five bodies (saloon, hatchback, SUV, pickup, van) from side profiles, extruded with rounded edges; paint
     tinted per car, glass with a sheen of the sky, tyres and hubs, lamps that light at dusk and in tunnels (tag: 1
     paint, 2 head lamp, 3 tail lamp); each faces -z */
  const glass = col(0x1b2128), tyre = col(0x131313), hub = col(0x8a8d90), trim = col(0x2a2c30), white = col(0xffffff), lamp = col(0xfff4e0), red = col(0xb01a14);
  const side = (pts, w, bevel = 0.05) => {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: w - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 2 });
    return g.translate(0, 0, -(w - 2 * bevel) / 2).rotateY(-Math.PI / 2);
  };
  // L, W, wheel radius, ride (wheel centre height), lamp height; profiles [z, y] front (-z) to back: body, glass, roof
  const BODIES = {
    saloon: [4.7, 1.82, 0.33, 0.33, 0.74, [[-2.35, 0.36], [-2.35, 0.7], [-2.18, 0.82], [-1.3, 0.94], [-0.78, 0.98], [1.3, 0.98], [2.2, 0.93], [2.35, 0.8], [2.35, 0.36]],
      [[-0.82, 0.96], [-0.08, 1.38], [0.95, 1.4], [1.6, 0.96]], [[-0.1, 1.36], [0.97, 1.38], [0.92, 1.44], [-0.03, 1.43]]],
    hatch: [4.1, 1.76, 0.32, 0.32, 0.76, [[-2.05, 0.35], [-2.05, 0.7], [-1.9, 0.83], [-1.15, 0.95], [-0.75, 0.99], [1.86, 0.99], [2.05, 0.9], [2.05, 0.35]],
      [[-0.8, 0.97], [-0.06, 1.42], [1.52, 1.43], [1.98, 0.98]], [[-0.07, 1.4], [1.5, 1.41], [1.45, 1.48], [-0.02, 1.47]]],
    suv: [4.8, 1.94, 0.39, 0.39, 0.92, [[-2.4, 0.44], [-2.4, 0.86], [-2.25, 0.99], [-1.5, 1.08], [-1.0, 1.12], [2.3, 1.12], [2.4, 1.0], [2.4, 0.44]],
      [[-1.05, 1.1], [-0.36, 1.62], [2.0, 1.64], [2.32, 1.12]], [[-0.36, 1.6], [2.0, 1.62], [1.95, 1.72], [-0.3, 1.7]]],
    pickup: [5.6, 2.0, 0.41, 0.41, 0.96, [[-2.8, 0.47], [-2.8, 0.92], [-2.65, 1.05], [-1.8, 1.14], [-1.3, 1.16], [2.8, 1.16], [2.8, 0.47]],
      [[-1.35, 1.14], [-0.74, 1.74], [0.36, 1.76], [0.55, 1.14]], [[-0.74, 1.71], [0.36, 1.73], [0.33, 1.81], [-0.7, 1.79]]],
    van: [5.1, 1.98, 0.36, 0.36, 0.86, [[-2.55, 0.4], [-2.55, 0.84], [-2.4, 0.99], [-1.7, 1.1], [-1.4, 1.13], [2.5, 1.13], [2.55, 1.0], [2.55, 0.4]],
      [[-1.45, 1.11], [-0.6, 1.78], [2.36, 1.8], [2.5, 1.12]], [[-0.6, 1.75], [2.36, 1.77], [2.3, 1.85], [-0.55, 1.83]]],
  };
  const carGeos = Object.entries(BODIES).map(([name, [L, W, wr, wy, ly, body, gl, roof]]) => {
    const wheel = (x, z) => [[new THREE.CylinderGeometry(wr, wr, 0.26, 14).rotateZ(Math.PI / 2).translate(x, wy, z), tyre], [new THREE.CylinderGeometry(wr * 0.58, wr * 0.58, 0.27, 10).rotateZ(Math.PI / 2).translate(x * 1.005, wy, z), hub]];
    const fz = -L / 2 + 0.88, rz = L / 2 - 0.95, wx = W / 2 - 0.08;
    const parts = [[side(body, W), white, null, { tag: 1 }], [side(gl, W * 0.88, 0.04), glass], [side(roof, W * 0.84, 0.03), white, null, { tag: 1 }],
      [B(W * 0.94, 0.24, L * 0.9, 0, wy * 0.95, 0), trim], [B(W * 0.99, 0.17, 0.14, 0, ly - 0.3, -L / 2), trim], [B(W * 0.99, 0.17, 0.14, 0, ly - 0.24, L / 2), trim],
      ...[-1, 1].flatMap(s => [[B(0.38, 0.13, 0.06, s * (W / 2 - 0.3), ly, -L / 2 - 0.02), lamp, null, { tag: 2 }], [B(0.34, 0.12, 0.06, s * (W / 2 - 0.27), ly + 0.06, L / 2 + 0.02), red, null, { tag: 3 }]]),
      ...[[-wx, fz], [wx, fz], [-wx, rz], [wx, rz]].flatMap(([x, z]) => wheel(x, z))];
    if (name === 'pickup') parts.push([B(W * 0.86, 0.05, 2.1, 0, 1.17, 1.65), trim]);  // the bed
    return { name, L, W, g: merge(parts) };
  });
  const carMat = lam(), lamps = { value: 0 }, sheen = { value: new THREE.Color(0.5, 0.6, 0.7) };
  carMat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { lamps, sheen });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float tag; varying float vTag;')
      .replace("#include <color_vertex>", `vColor = color;
        #ifdef USE_INSTANCING_COLOR
        if (tag > 0.5 && tag < 1.5) vColor.rgb *= instanceColor.rgb;
        #endif
        vTag = tag;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float lamps; uniform vec3 sheen; varying float vTag;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vTag > 1.5 && vTag < 2.5) totalEmissiveRadiance += vec3(1.0, 0.92, 0.78) * (0.15 + lamps * 12.0);
        else if (vTag > 2.5) totalEmissiveRadiance += vec3(1.0, 0.06, 0.03) * (0.25 + lamps * 4.0);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // paint and glass catch the sky at a glancing angle
        float jwFr = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0) * step(vTag, 1.5);
        reflectedLight.indirectDiffuse += sheen * (0.02 + 0.28 * jwFr);`);
  };
  carMat.customProgramCacheKey = () => 'jw-car-1'; withSun(carMat);
  const counts = [[44, 1, 1], [26, 1, 1], [10, 0.6, 0]][quality] ?? [26, 1, 1];
  const nT = carGeos.length, perType = Math.ceil(counts[0] / nT) + 2;
  const carSets = carGeos.map(({ g }) => { const m = new THREE.InstancedMesh(g, carMat, perType); m.castShadow = quality === 0; m.frustumCulled = false; m.count = 0; scene.add(m); return m; });
  // headlight pools on the road ahead, added light at dusk (one instanced draw, flat quads)
  const poolMat = new THREE.ShaderMaterial({ uniforms: { lamps }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vP; varying float vD; void main() { vP = position.xz; vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vD = distance(w.xyz, cameraPosition); gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform float lamps; varying vec2 vP; varying float vD; void main() { float a = max(0.0, 1.0 - length(vP / vec2(2.2, 7.0))); a = a * a * smoothstep(0.0, 0.6, vP.y + 7.0) * lamps * (1.0 - smoothstep(150.0, 400.0, vD)); gl_FragColor = vec4(vec3(1.0, 0.85, 0.62) * a * 0.55, 1.0); }' });
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(4.4, 14, 1, 1).rotateX(-Math.PI / 2), poolMat, counts[0]); pools.frustumCulled = false; pools.count = 0; pools.renderOrder = 2; scene.add(pools);
  const fleet = [];
  for (let i = 0; i < counts[0]; i++) fleet.push({ i, kind: i < Math.round(counts[0] * 0.4) ? 'bridge' : 'road', type: Math.floor(hash2(i, 29) * nT) % nT, col: CAR_COLOURS[i % CAR_COLOURS.length], live: false, s: 0, v: 0, off: 0 });

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
  const bodies = new THREE.InstancedMesh(bodyGeo, withSun(lam()), Math.max(1, folk.length)), rests = new THREE.InstancedMesh(restGeo, withSun(lam()), Math.max(1, folk.length));
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
  // ctx: { rider: { x, y, z, v, yaw }, riders: [{ x, z, v }] (all on the roads), roads: () => [{ P: [[x, y, z]], w, lanes, one, big }],
  // ground: (x, z) -> h | null }
  function update(dt, ctx) {
    t += dt; bt.value = t;
    const R = ctx.rider;
    /* cars */
    let roads = null, pn = 0;
    const riders = ctx.riders || [R], fill = carSets.map(() => 0);
    const put = (c, x, y, z, yaw, pitch = 0) => {
      const m = carSets[c.type], i = fill[c.type]++; if (i >= perType) return;
      M4.compose(V.set(x, y, z), Q.setFromEuler(E.set(pitch, yaw, 0, 'YXZ')), S.set(1, 1, 1)); m.setMatrixAt(i, M4); m.setColorAt(i, C.set(c.col));
      if (lamps.value > 0.05 && pn < counts[0]) { V.set(0, 0, -9.5).applyQuaternion(Q); M4.compose(V.set(x + V.x, y + 0.08, z + V.z), Q.setFromEuler(E.set(0, yaw, 0)), S.set(1, 1, 1)); pools.setMatrixAt(pn++, M4); }
    };
    const [bx, bz] = marks.lane ? [marks.lane(0, 0).x, marks.lane(0, 0).z] : [0, 0], nearBridge = marks.lane && Math.hypot(R.x - bx, R.z - bz) < 6000;
    for (const c of fleet) {
      if (c.kind === 'bridge') {
        if (!nearBridge) { c.live = false; continue; }
        if (!c.live) { const k = c.i; c.lane = (k % 3) + 1; c.dir = k % 2 ? 1 : -1; c.s = marks.span[0] + hash2(k, 11) * (marks.span[1] - marks.span[0]); c.v = 19 + 5 * hash2(k, 13); c.live = true; }
        c.s += c.dir * c.v * dt;
        if (c.s > marks.span[1] + 60) c.s = marks.span[0] - 60; if (c.s < marks.span[0] - 60) c.s = marks.span[1] + 60;
        if (c.s <= marks.span[0] || c.s >= marks.span[1]) continue;
        const p = marks.lane(c.s, c.dir * (c.lane * 3.33 - 1.66));
        put(c, p.x, p.y, p.z, p.yaw + (c.dir > 0 ? Math.PI : 0)); continue;
      }
      // a car on a road near the rider
      if (!c.live || Math.hypot(c.x - R.x, c.z - R.z) > 900) {
        roads ??= ctx.roads();
        const cand = roads.filter(r => r.P.length > 4); c.live = false;
        if (!cand.length) continue;
        const r = cand[Math.floor(hash2(c.i, Math.floor(t * 3)) * cand.length) % cand.length], P = r.P;
        const k = Math.floor(hash2(Math.floor(t * 7), c.i) * (P.length - 2));
        if (riders.some(o => Math.hypot(P[k][0] - o.x, P[k][2] - o.z) < 70)) continue;  // never pop in next to a rider
        const dir = r.one || hash2(c.i, k) < 0.5 ? 1 : -1;
        Object.assign(c, { r, k: dir < 0 ? Math.max(1, k) : k, f: 0, dir, v0: (r.big ? 20 : 12) + 4 * hash2(k, c.i), live: true, x: P[k][0], z: P[k][2], off: null });
        c.v = c.v0;
      }
      const P = c.r.P; let a = P[c.k], b = P[c.k + c.dir];
      if (!b) { c.live = false; continue; }
      let L = Math.hypot(b[0] - a[0], b[2] - a[2]) || 0.01;
      const dx = (b[0] - a[0]) / L, dz = (b[2] - a[2]) / L, rx = -dz, rz = dx, half = c.r.w / 2, body = carGeos[c.type];
      const laneOff = c.r.one ? half - 1.9 : Math.min(half - 1.6, c.r.w / (2 * c.r.lanes) * (c.r.lanes > 2 ? 3 : 1));
      c.off ??= laneOff;
      // as far left as it may go: the next lane of a oneway, the oncoming lane of a two-way road while nothing comes
      const cx = a[0] + (b[0] - a[0]) * c.f, cz = a[2] + (b[2] - a[2]) * c.f;
      const oncoming = !c.r.one && fleet.some(d => d !== c && d.live && d.r === c.r && d.dir !== c.dir && (() => { const g = (d.x - cx) * dx + (d.z - cz) * dz; return g > -10 && g < 170; })());
      const leftmost = c.r.one || !oncoming ? -half + 1.15 : 1.1;
      // the riders in road terms, and the car ahead in its lane
      const near = riders.map(o => { const gx = o.x - cx, gz = o.z - cz; return { gap: gx * dx + gz * dz, rl: gx * rx + gz * rz, v: o.v }; }).filter(o => o.gap > -20 && o.gap < 90 && Math.abs(o.rl) < 12);
      let ahead = Infinity;
      for (const d of fleet) if (d !== c && d.live && d.kind === 'road' && d.r === c.r && d.dir === c.dir) {
        const g = (d.x - c.x) * dx + (d.z - c.z) * dz; if (g > 0 && g < 35 && Math.abs((d.x - c.x) * rx + (d.z - c.z) * rz) < 2.3) ahead = Math.min(ahead, Math.max(0, d.v + (g - 10) * 0.6));
      }
      const st = carStep(c, near, { laneOff, leftmost, L: body.L, W: body.W, ahead }, dt);
      c.v = st.v; c.off = st.off; c.f += st.move / L;
      while (c.f >= 1) { c.f -= 1; c.k += c.dir; a = P[c.k]; b = P[c.k + c.dir]; if (!b) break; const L2 = Math.hypot(b[0] - a[0], b[2] - a[2]) || 0.01; c.f *= L / L2; L = L2; }
      if (!b) { c.live = false; continue; }
      const ex = (b[0] - a[0]) / L, ez = (b[2] - a[2]) / L;
      c.x = a[0] + (b[0] - a[0]) * c.f - ez * c.off; c.z = a[2] + (b[2] - a[2]) * c.f + ex * c.off;
      put(c, c.x, a[1] + (b[1] - a[1]) * c.f - 0.2, c.z, Math.atan2(-ex, -ez), Math.atan2(b[1] - a[1], L));
    }
    carSets.forEach((m, k) => { m.count = Math.min(perType, fill[k]); m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    pools.count = pn; pools.instanceMatrix.needsUpdate = true;
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
    // the car bodies (for checks), the cars' lamps: 0 off .. 1 full (dusk, tunnels); the sky's colour on their paint
    models: carGeos, carMaterial: carMat,
    setLamps(k, sky) { lamps.value = k; if (sky) sheen.value.copy(sky); },
    dispose() { for (const m of [...carSets, pools, bodies, rests, birds]) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); m.dispose(); } },
  };
}
