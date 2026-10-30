// World 3D cyclist: a procedural road bike and rider in one skinned mesh, one draw call per rider. Every rider shares
// the geometry; a material per colour scheme carries the kit colours. Cadence turns the crank and the legs follow the
// pedals (two-bone IK), speed turns the wheels, and the grade makes the rider sway on climbs, stand on steep ones and
// tuck on fast descents. The model faces -z (three.js forward), x is the rider's right, origin on the ground between
// the wheels, metres. knee(), ik() and stance() are pure; knee() is tested in tests/test_world3d.py.

const DEG = Math.PI / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => mul(a, 1 / (len(a) || 1));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = t => t * t * (3 - 2 * t);
const approach = (x, to, step) => x < to ? Math.min(to, x + step) : Math.max(to, x - step);
// rotation about the z axis through the origin (the bike's roll about its tyre contact line)
const rotZ = (p, r) => [p[0] * Math.cos(r) - p[1] * Math.sin(r), p[0] * Math.sin(r) + p[1] * Math.cos(r), p[2]];
// a smooth minimum: the hips settle onto the lower limit without a corner
const softmin = (a, b, k = 0.012) => Math.min(a, b) - k * Math.log(1 + Math.exp(-Math.abs(a - b) / k));

/* ---------- the bike and the body in numbers ---------- */
const WR = 0.335, BB = [0, 0.265, 0.09], REAR = [0, WR, 0.495], FRONT = [0, WR, -0.495], CR = 0.1725;
const UPS = [0, Math.sin(73.5 * DEG), Math.cos(73.5 * DEG)];   // up the seat tube (it leans back)
const DNH = [0, -Math.sin(73 * DEG), -Math.cos(73 * DEG)];     // down the steerer (it leans forward)
const SADDLE = add(BB, mul(UPS, 0.79));                        // the saddle top over the seat post
const HTT = [0, 0.85, -0.3], HTB = add(HTT, mul(DNH, 0.165));   // head tube top and bottom
const STEM = add(HTT, mul(DNH, -0.046)), STEMD = [0, Math.sin(11 * DEG), -Math.cos(11 * DEG)];
const BAR = add(STEM, mul(STEMD, 0.11));                       // the bar clamp
const HOOD = [0.203, BAR[1] + 0.04, BAR[2] - 0.095];           // the palm on the right hood

export const BIKE = { wheel: WR, base: 0.99, bb: BB, crank: CR, saddle: SADDLE, bars: BAR, hoods: HOOD, thigh: 0.46, shin: 0.47 };

// body: hip joints apart, pelvis and chest segments of the spine, shoulders apart, arm bones, longest leg
const HIPW = 0.088, LP = 0.27, LC = 0.25, SHW = 0.178, UA = 0.29, FA = 0.265, LMAX = 0.915;

// knee position for a hip and a foot in the bike plane (y up, z along the bike, -z forward): the knee bends forward
export function knee(hip, foot, a = BIKE.thigh, b = BIKE.shin) {
  const dy = foot[0] - hip[0], dz = foot[1] - hip[1], d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, Math.hypot(dy, dz)));
  const ux = dy / (Math.hypot(dy, dz) || 1), uz = dz / (Math.hypot(dy, dz) || 1), x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
  // the perpendicular toward the front (-z)
  let px = -uz, pz = ux; if (pz > 0) { px = -px; pz = -pz; }
  return [hip[0] + ux * x + px * h, hip[1] + uz * x + pz * h];
}

// two-bone IK in 3D: the middle joint for a root, a target, bone lengths a and b, bending toward the pole direction
export function ik(root, target, a, b, pole) {
  const t = sub(target, root), L = len(t) || 1e-6, u = mul(t, 1 / L);
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, L)), x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = unit(sub(pole, mul(u, dot(pole, u))));
  return add(root, add(mul(u, x), mul(p, h)));
}

// the point r1 from (y1, z1) and r2 from (y2, z2), the upper of the two; on the line when out of reach
function meet(y1, z1, r1, y2, z2, r2) {
  const dy = y2 - y1, dz = z2 - z1, d = Math.hypot(dy, dz) || 1e-6, uy = dy / d, uz = dz / d;
  if (d >= r1 + r2) return [y1 + uy * r1, z1 + uz * r1];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  let py = -uz, pz = uy; if (py < 0) { py = -py; pz = -pz; }
  return [y1 + uy * a + py * h, z1 + uz * a + pz * h];
}

// the animation state: crank angle and speed, wheel angle, smoothed grade, standing and tucking (with hysteresis) and
// their blends (0..1, about a second each), how much of a climb (0..1). dt seconds, cadence rpm, speed m/s, grade a
// fraction. Coasting brings the cranks round to level and holds them there.
export function stance(s, dt, cad = 0, v = 0, grade = 0) {
  dt = Math.min(Math.max(dt || 0, 0), 0.1); cad = cad || 0; v = v || 0;
  const pedal = cad > 1, k = 40, w = Math.sqrt(k);
  if (pedal) { s.coast = null; s.cw += (cad / 60 * 2 * Math.PI - s.cw) * Math.min(1, dt * 3); s.ca += s.cw * dt; }
  else {
    // the next level crank far enough ahead to stop on without going past it
    if (s.coast == null) s.coast = Math.PI / 2 + Math.ceil((s.ca + Math.max(0, s.cw) / w - Math.PI / 2) / Math.PI) * Math.PI;
    s.cw += (k * (s.coast - s.ca) - 2 * w * s.cw) * dt; s.ca += s.cw * dt;
  }
  if (s.ca > 4 * Math.PI) { s.ca -= 2 * Math.PI; if (s.coast != null) s.coast -= 2 * Math.PI; }
  s.wa = (s.wa + v / WR * dt) % (2 * Math.PI);
  s.g += ((Number.isFinite(grade) ? grade : 0) - s.g) * Math.min(1, dt * 1.5);
  if (!s.up && pedal && s.g > 0.075) s.up = true; else if (s.up && (!pedal || s.g < 0.06)) s.up = false;
  if (!s.tuck && !s.up && v > 12.5 && s.g < -0.025) s.tuck = true; else if (s.tuck && (s.up || v < 10.5 || s.g > -0.012)) s.tuck = false;
  s.sb = approach(s.sb, s.up ? 1 : 0, dt); s.tb = approach(s.tb, s.tuck ? 1 : 0, dt / 1.2);
  s.cl = approach(s.cl, pedal ? clamp((s.g - 0.02) / 0.04, 0, 1) : 0, dt);
  return s;
}
export const newStance = (ca = 0) => ({ ca, cw: 0, coast: null, wa: 0, g: 0, up: false, sb: 0, tuck: false, tb: 0, cl: 0 });

/* ---------- mesh building: lofts of rings, painted per face ---------- */
const sp = (c, p) => Math.sign(c) * Math.abs(c) ** p;
const centroid = r => mul(r.reduce(add, [0, 0, 0]), 1 / r.length);

// rings of points (same count) into triangles; F tags each triangle with its row and column. Faces point away from the
// ring's centre (or from `inside`).
function loft(rings, { closed = true, cap0 = false, cap1 = false, inside = null } = {}) {
  const R = rings.length, M = rings[0].length, P = rings.flat(), I = [], F = [], J = closed ? M : M - 1;
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < J; j++) {
    const a = i * M + j, b = i * M + (j + 1) % M;
    I.push(a, b, b + M, a, b + M, a + M); F.push([i, j], [i, j]);
  }
  if (cap0) { const c = P.push(centroid(rings[0])) - 1; for (let j = 0; j < J; j++) { I.push(c, (j + 1) % M, j); F.push([-1, j]); } }
  if (cap1) { const c = P.push(centroid(rings[R - 1])) - 1, o = (R - 1) * M; for (let j = 0; j < J; j++) { I.push(c, o + j, o + (j + 1) % M); F.push([R - 1, j]); } }
  const mid = Math.floor((R - 1) / 2), t = mid * J * 6, [a, b, c] = [P[I[t]], P[I[t + 1]], P[I[t + 2]]];
  if (dot(cross(sub(b, a), sub(c, a)), sub(mul(add(add(a, b), c), 1 / 3), inside ?? centroid(rings[mid]))) < 0)
    for (let k = 0; k < I.length; k += 3) { const x = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = x; }
  return { P, I, F };
}

// a tube along a path: radii [r1 along the reference side, r2 across] per point; pw < 1 squares the section off
function sweep(pts, rad, M, { ref = [1, 0, 0], phase = 0, pw = 1, ...o } = {}) {
  let n = null; const rings = [];
  pts.forEach((p, i) => {
    const t = unit(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)])), r0 = n ?? ref;
    n = unit(sub(r0, mul(t, dot(r0, t)))); const b = cross(t, n);
    const r = typeof rad === 'number' ? [rad, rad] : Array.isArray(rad[0]) ? rad[i] : typeof rad[0] === 'number' && rad.length === 2 ? rad : [rad[i], rad[i]];
    rings.push(Array.from({ length: M }, (_, j) => { const a = phase + j / M * 2 * Math.PI; return add(p, add(mul(n, r[0] * sp(Math.cos(a), pw)), mul(b, r[1] * sp(Math.sin(a), pw)))); }));
  });
  return loft(rings, o);
}

// a profile [radius, x] turned about the x axis
function lathe(prof, N, o) {
  return loft(prof.map(([r, x]) => Array.from({ length: N }, (_, j) => { const a = j / N * 2 * Math.PI; return [x, r * Math.cos(a), r * Math.sin(a)]; })), o);
}

// sections [y, half width, half depth front, half depth back, z offset] round the y axis; +z is the front for limbs
function limb(rows, M, front = 1) {
  return loft(rows.map(([y, rx, rf, rb = rf, cz = 0]) => Array.from({ length: M }, (_, j) => {
    const a = j / M * 2 * Math.PI, s = Math.sin(a);
    return [rx * Math.cos(a), y, cz + (s * front > 0 ? rf : rb) * s];
  })), { cap0: true, cap1: true });
}

// how each painted part looks: palette slot (1 kit, 2 kit2, 3 accent, 4 skin, 5 helmet, 6 bike) with a shade, or a
// fixed colour; roughness, metalness
const LOOKS = {
  kit: [1, 1, 0.72], kitD: [1, 0.7, 0.72], acc: [3, 1, 0.68], kit2: [2, 1, 0.5], grip: [2, 0.7, 0.32], skin: [4, 1, 0.6],
  helmet: [5, 1, 0.3], bike: [6, 1, 0.26],
  black: [0, 0x17181b, 0.6], tape: [0, 0x18191c, 0.85], tyre: [0, 0x1d1d1f, 0.88], carbon: [0, 0x1e2024, 0.3],
  decal: [0, 0xdadcdf, 0.4], spoke: [0, 0x1a1b1e, 0.4], metal: [0, 0xa3a8ae, 0.3, 0.3], dark: [0, 0x2b2d32, 0.34, 0.15],
  chain: [0, 0x5c6066, 0.45, 0.3], sock: [0, 0xf1f1ee, 0.85], shoe: [0, 0x1b1c20, 0.36], sole: [0, 0x34363a, 0.55],
  glove: [0, 0x25272c, 0.75], lens: [0, 0x1a2135, 0.08, 0.45], white: [0, 0xf3f3f1, 0.32], vent: [0, 0x0d0e10, 0.7], ventG: [0, 0x34373d, 0.75],
  saddle: [0, 0x151618, 0.45], bottle: [0, 0xebebe7, 0.4], crank: [0, 0x232529, 0.28, 0.2], hub: [0, 0x2d2f34, 0.35, 0.25],
};

function emitter(THREE) {
  const pos = [], nrm = [], col = [], pal = [], rm = [], si = [], sw = [], c = new THREE.Color(), looks = {};
  for (const [k, [slot, v, r, m = 0]] of Object.entries(LOOKS)) {
    if (slot) looks[k] = { slot, rgb: [v, v, v], r, m }; else { c.setHex(v); looks[k] = { slot: 0, rgb: [c.r, c.g, c.b], r, m }; }
  }
  return {
    // part: { P, I, F } in the bone's space (or placed by the basis m); paint: a look name or (tag, centroid) => name;
    // w: (point) => [second bone, its weight]
    add({ P, I, F }, paint, bone, { m = null, w = null } = {}) {
      const N = P.map(() => [0, 0, 0]);
      for (let t = 0; t < I.length; t += 3) {
        const a = P[I[t]], n = cross(sub(P[I[t + 1]], a), sub(P[I[t + 2]], a));
        for (let k = 0; k < 3; k++) { const v = N[I[t + k]]; v[0] += n[0]; v[1] += n[1]; v[2] += n[2]; }
      }
      const at = p => m ? add(m[3], add(add(mul(m[0], p[0]), mul(m[1], p[1])), mul(m[2], p[2]))) : p;
      const dir = p => unit(m ? add(add(mul(m[0], p[0]), mul(m[1], p[1])), mul(m[2], p[2])) : p);
      for (let t = 0; t < I.length; t += 3) {
        const L = looks[typeof paint === 'string' ? paint : paint(F[t / 3], mul(add(add(P[I[t]], P[I[t + 1]]), P[I[t + 2]]), 1 / 3))];
        for (let k = 0; k < 3; k++) {
          const v = I[t + k], q = at(P[v]), n = dir(N[v]);
          pos.push(q[0], q[1], q[2]); nrm.push(n[0], n[1], n[2]); col.push(...L.rgb); pal.push(L.slot); rm.push(L.r * 255 | 0, L.m * 255 | 0);
          const [b2, w2] = w ? w(P[v]) : [0, 0]; si.push(bone, b2, 0, 0); sw.push(1 - w2, w2, 0, 0);
        }
      }
    },
    done() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('pal', new THREE.Uint8BufferAttribute(pal, 1));
      g.setAttribute('rm', new THREE.Uint8BufferAttribute(rm, 2, true));
      g.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.85, 0), 1.3);
      return g;
    },
  };
}

/* ---------- the bike (bone 0), the wheels (1 rear, 2 front), the crank (3) ---------- */
function bikeParts(E) {
  const T = (pts, r, M, look, o) => E.add(sweep(pts, r, M, { cap0: true, cap1: true, ...o }), look, 0);
  const dtTop = add(HTT, mul(DNH, 0.13)), stTop = add(BB, mul(UPS, 0.5)), ttA = add(BB, mul(UPS, 0.488)), ttB = add(HTT, mul(DNH, 0.03));
  // the main triangle: an aero down tube with its decal, seat tube, sloping top tube, tapered head tube
  T([BB, mix(BB, dtTop, 0.3), mix(BB, dtTop, 0.78), dtTop], [0.023, 0.032], 8, (f, c) => f[0] === 1 && Math.abs(c[0]) > 0.012 ? 'decal' : 'bike');
  T([BB, stTop], [0.019, 0.024], 8, 'bike');
  T([ttA, mix(ttA, ttB, 0.5), ttB], [[0.016, 0.019], [0.017, 0.021], [0.018, 0.022]], 8, (f, c) => f[0] === 1 && c[1] > 0.79 ? 'acc' : 'bike');
  T([add(HTT, mul(DNH, -0.008)), HTB], [[0.024, 0.025], [0.029, 0.03]], 8, 'bike');
  T([[-0.044, BB[1], BB[2]], [0.044, BB[1], BB[2]]], 0.024, 8, 'bike', { ref: [0, 1, 0] });
  T([[-0.04, HTB[1] - 0.012, HTB[2] - 0.004], [0.04, HTB[1] - 0.012, HTB[2] - 0.004]], [0.022, 0.026], 6, 'bike', { ref: [0, 1, 0] });
  for (const s of [1, -1]) {
    T([[s * 0.03, BB[1] + 0.01, BB[2] + 0.03], [s * 0.058, 0.315, 0.43], [s * 0.067, WR, REAR[2]]], [[0.01, 0.017], [0.009, 0.013], [0.008, 0.012]], 6, 'bike');
    T([[s * 0.066, WR + 0.012, REAR[2] - 0.008], [s * 0.022, 0.675, 0.212]], [[0.007, 0.01], [0.009, 0.012]], 6, 'bike');
    T([[s * 0.036, HTB[1] - 0.02, HTB[2] - 0.006], [s * 0.047, 0.5, -0.43], [s * 0.054, WR, FRONT[2]]], [[0.012, 0.021], [0.011, 0.017], [0.008, 0.011]], 6, 'bike');
  }
  // seat post, saddle clamp and rails, the saddle
  const clampAt = add(BB, mul(UPS, 0.745));
  T([add(BB, mul(UPS, 0.47)), clampAt], [0.0135, 0.017], 6, 'black');
  T([[-0.024, clampAt[1], clampAt[2]], [0.024, clampAt[1], clampAt[2]]], 0.011, 6, 'black', { ref: [0, 1, 0] });
  for (const s of [1, -1]) T([[s * 0.02, SADDLE[1] - 0.012, SADDLE[2] - 0.1], [s * 0.021, SADDLE[1] - 0.03, SADDLE[2] - 0.05], [s * 0.021, SADDLE[1] - 0.03, SADDLE[2] + 0.05], [s * 0.03, SADDLE[1] - 0.012, SADDLE[2] + 0.09]], 0.0035, 3, 'metal', { cap0: false, cap1: false });
  const SD = [[-0.155, 0.012, -0.007, 0.012], [-0.14, 0.02, -0.003, 0.017], [-0.1, 0.025, 0, 0.02], [-0.05, 0.033, 0, 0.022], [0, 0.055, 0.002, 0.024], [0.045, 0.068, 0.004, 0.025], [0.085, 0.07, 0.006, 0.024], [0.11, 0.058, 0.004, 0.019], [0.12, 0.035, 0, 0.012]];
  E.add(loft(SD.map(([dz, w, top, th]) => Array.from({ length: 8 }, (_, j) => {
    const a = j / 8 * 2 * Math.PI, x = w * sp(Math.cos(a), 0.6);
    return [x, SADDLE[1] + top - th / 2 + th / 2 * sp(Math.sin(a), 0.6) - 0.006 * (x / w) ** 2, SADDLE[2] + dz];
  })), { cap0: true, cap1: true }), (f, c) => c[1] < SADDLE[1] - 0.012 ? 'black' : 'saddle', 0);
  // steerer and spacers, stem, bar clamp, drop bar, hoods and levers
  T([add(HTT, mul(DNH, 0.004)), add(HTT, mul(DNH, -0.068))], 0.0185, 6, 'black');
  T([STEM, BAR], [0.018, 0.02], 6, 'black');
  T([add(BAR, [-0.022, 0, 0]), add(BAR, [0.022, 0, 0])], 0.0205, 6, 'black', { ref: [0, 1, 0] });
  const half = [[0, 0, 0], [0.13, 0, 0], [0.18, 0, -0.015], [0.2, -0.003, -0.055], [0.205, -0.02, -0.09], [0.209, -0.055, -0.098], [0.213, -0.088, -0.083], [0.217, -0.115, -0.045], [0.219, -0.124, 0.0], [0.22, -0.124, 0.068]];
  const bar = [...half.slice(1).reverse().map(([x, y, z]) => [-x, y, z]), ...half].map(p => add(BAR, p));
  T(bar, bar.map(p => Math.abs(p[0]) < 0.06 ? 0.0159 : 0.0125), 6, (f, c) => Math.abs(c[0]) < 0.075 ? 'carbon' : 'tape', { ref: [0, 1, 0] });
  for (const s of [1, -1]) {
    T([[s * 0.203, 0, -0.058], [s * 0.203, 0.017, -0.093], [s * 0.203, 0.029, -0.123], [s * 0.203, 0.033, -0.14]].map(p => add(BAR, p)), [[0.015, 0.016], [0.016, 0.021], [0.014, 0.017], [0.009, 0.009]], 6, 'black', { phase: Math.PI / 6 });
    T([[s * 0.204, 0.0, -0.133], [s * 0.205, -0.035, -0.135], [s * 0.208, -0.068, -0.126], [s * 0.211, -0.092, -0.11]].map(p => add(BAR, p)), [0.005, 0.009], 4, 'carbon', { phase: Math.PI / 4 });
  }
  // bottle and cage on the down tube
  const u = unit(sub(dtTop, BB)), up = [0, -u[2], u[1]], bAt = t => add(BB, add(mul(u, t), mul(up, 0.056)));
  const BP = [[0.13, 0.026], [0.14, 0.036], [0.29, 0.036], [0.31, 0.031], [0.325, 0.018], [0.335, 0.015], [0.352, 0.011]];
  E.add(sweep(BP.map(([t]) => bAt(t)), BP.map(([, r]) => r), 7, { cap0: true, cap1: true }), f => f[0] >= 4 ? 'kit' : 'bottle', 0);
  for (const s of [1, -1]) T([add(bAt(0.15), [s * 0.03, 0, 0]), add(add(bAt(0.29), [s * 0.03, 0, 0]), mul(up, -0.012))], 0.0035, 4, 'black');
  // rear derailleur, chain, disc calipers
  const jU = [0.066, WR - 0.07, REAR[2] + 0.012], jL = [0.066, WR - 0.142, REAR[2] - 0.006];
  T([[0.07, WR - 0.01, REAR[2] + 0.006], [0.074, WR - 0.06, REAR[2] + 0.028]], [0.011, 0.014], 6, 'dark');
  T([add(jU, [0, 0.004, 0.004]), add(jL, [0, -0.012, -0.004])], [0.003, 0.016], 4, 'dark');
  for (const j of [jU, jL]) T([add(j, [-0.006, 0, 0]), add(j, [0.008, 0, 0])], 0.0165, 6, 'black', { ref: [0, 1, 0] });
  T([[0.047, BB[1] + 0.106, BB[2]], [0.047, WR + 0.047, REAR[2]]], 0.0045, 4, 'chain');
  T([[0.047, BB[1] - 0.106, BB[2]], add(jL, [-0.004, -0.017, 0])], 0.0045, 4, 'chain');
  T([[-0.052, WR + 0.065, FRONT[2] + 0.055], [-0.052, WR + 0.105, FRONT[2] + 0.028]], [0.011, 0.02], 4, 'dark', { phase: Math.PI / 4 });
  T([[-0.064, WR + 0.045, REAR[2] - 0.028], [-0.064, WR + 0.055, REAR[2] - 0.08]], [0.011, 0.018], 4, 'dark', { phase: Math.PI / 4 });
}

function wheelParts(E, bone, n, rear) {
  // tyre and deep carbon rim in one turned profile, rim logos that show the spin
  const prof = [[0.266, 0], [0.29, -0.0135], [0.312, -0.012], [0.327, -0.0128], [WR, 0], [0.327, 0.0128], [0.312, 0.012], [0.29, 0.0135], [0.266, 0]];
  E.add(lathe(prof, 32, { inside: [0, 0.3, 0] }), ([i, j]) => i >= 2 && i <= 5 ? 'tyre' : (i === 1 || i === 6) && (j % 16 === 3 || j % 16 === 4) ? 'decal' : 'carbon', bone);
  for (let k = 0; k < n; k++) {
    const side = k % 2 ? 1 : -1, a = k / n * 2 * Math.PI, b = a + (rear && side > 0 ? (k % 4 < 2 ? 0.2 : -0.2) : 0);
    E.add(sweep([[side * 0.027, 0.024 * Math.cos(a), 0.024 * Math.sin(a)], [side * 0.004, 0.268 * Math.cos(b), 0.268 * Math.sin(b)]], 0.0018, 3), 'spoke', bone);
  }
  E.add(sweep([[-0.05, 0, 0], [0.05, 0, 0]], 0.019, 8, { ref: [0, 1, 0], cap0: true, cap1: true }), 'hub', bone);
  if (rear) E.add(lathe([[0.014, 0.02], [0.054, 0.022], [0.028, 0.058], [0.014, 0.06]], 12, { inside: [0.025, 0.02, 0] }), 'metal', bone);
  else E.add(lathe([[0.08, -0.05], [0.064, -0.052], [0.08, -0.054]], 16, { inside: [-0.052, 0.074, 0.01] }), 'metal', bone);
}

function crankParts(E) {
  E.add(sweep([[-0.07, 0, 0], [0.07, 0, 0]], 0.012, 6, { ref: [0, 1, 0] }), 'dark', 3);
  E.add(lathe([[0.07, 0.047], [0.108, 0.045], [0.108, 0.05], [0.07, 0.047]], 28, { inside: [0.0475, 0.1, 0] }), ([i]) => i === 1 ? 'metal' : 'crank', 3);
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) / 4 * 2 * Math.PI;
    E.add(sweep([[0.052, 0.012 * Math.cos(a), 0.012 * Math.sin(a)], [0.047, 0.078 * Math.cos(a), 0.078 * Math.sin(a)]], [0.004, 0.01], 4), 'crank', 3);
  }
  // the right arm points up at angle 0, the left one down
  for (const s of [1, -1]) E.add(sweep([[s * 0.058, 0, 0], [s * 0.07, s * 0.09, 0], [s * 0.078, s * CR, 0]], [[0.008, 0.021], [0.007, 0.016], [0.007, 0.013]], 6, { cap0: true, cap1: true }), 'crank', 3);
}

/* ---------- the rider: pelvis 4, chest 5, head 6, legs 7-12 (thigh, shin, foot), arms 13-18 (upper, fore, hand) ---------- */
function bodyParts(E) {
  // torso in the pelvis's space (y up the spine, +z the back), blended into the chest above the waist
  const TS = [[-0.125, 0.07, 0.03, 0.045, 0.045], [-0.1, 0.115, 0.06, 0.086, 0.04], [-0.06, 0.137, 0.08, 0.104, 0.03], [-0.01, 0.146, 0.088, 0.106, 0.02],
    [0.035, 0.144, 0.09, 0.1, 0.012], [0.1, 0.141, 0.09, 0.092, 0.005], [0.17, 0.142, 0.088, 0.086, 0], [0.25, 0.146, 0.093, 0.086, 0],
    [0.33, 0.155, 0.102, 0.092, 0], [0.4, 0.164, 0.106, 0.096, 0], [0.46, 0.168, 0.097, 0.094, 0], [0.51, 0.158, 0.076, 0.085, 0.008],
    [0.548, 0.122, 0.056, 0.072, 0.018], [0.575, 0.072, 0.045, 0.052, 0.024]];
  const TM = 14;
  E.add(loft(TS.map(([y, hw, fd, bd, cz]) => Array.from({ length: TM }, (_, j) => {
    const a = (j - 0.5) / TM * 2 * Math.PI, s = Math.sin(a);
    return [hw * sp(Math.cos(a), 0.8), y, cz + (s > 0 ? bd : fd) * sp(s, 0.8)];
  })), { cap0: true, cap1: true }), ([i, j]) => {
    const a = j / TM * 2 * Math.PI;
    if (i <= 3) return 'kit2';
    if (i >= 12) return 'acc';
    if (Math.abs(Math.cos(a)) > 0.97 && i >= 5 && i <= 9) return 'acc';
    if ((i === 4 || i === 5) && Math.sin(a) > 0.3) return 'kitD';
    return 'kit';
  }, 4, { w: p => [5, clamp((p[1] - LP + 0.07) / 0.14, 0, 1)] });
  // legs: one skin from the hip joint down the thigh and shin (+z the front), straight in the bind pose with the shin's
  // bone at the knee, blended across the knee; the shoe from the ankle (y forward, z up)
  const K = BIKE.thigh, LEG = [[-0.05, 0.038, 0.038], [-0.015, 0.068, 0.07], [0.05, 0.077, 0.084, 0.08], [0.17, 0.074, 0.085, 0.072], [0.28, 0.066, 0.072, 0.062],
    [0.325, 0.061, 0.065, 0.058], [0.355, 0.059, 0.062, 0.056], [0.41, 0.05, 0.056, 0.048], [0.455, 0.047, 0.055, 0.045], [K + 0.04, 0.048, 0.046, 0.05, -0.002],
    [K + 0.1, 0.05, 0.044, 0.06, -0.006], [K + 0.16, 0.05, 0.041, 0.064, -0.008], [K + 0.23, 0.043, 0.036, 0.052, -0.006], [K + 0.3, 0.036, 0.034, 0.036],
    [K + 0.32, 0.035, 0.034, 0.035], [K + 0.4, 0.031, 0.031], [K + 0.47, 0.03, 0.03], [K + 0.495, 0.018, 0.018]];
  const SHOE = [[-0.078, 0.018, 0, -0.075], [-0.068, 0.032, 0.03, -0.088], [-0.035, 0.039, 0.045, -0.092], [0.01, 0.042, 0.04, -0.094], [0.06, 0.046, 0.005, -0.095],
    [0.11, 0.049, -0.025, -0.096], [0.16, 0.044, -0.045, -0.095], [0.2, 0.03, -0.058, -0.092], [0.222, 0.014, -0.068, -0.086]];
  for (const b of [7, 10]) {
    E.add(limb(LEG, 10), ([i]) => i < 0 || i <= 4 ? 'kit2' : i === 5 ? 'grip' : i <= 12 ? 'skin' : i === 13 ? 'acc' : 'sock', b, { w: p => [b + 1, clamp((p[1] - K + 0.03) / 0.06, 0, 1)] });
    E.add(loft(SHOE.map(([y, w, zt, zb]) => Array.from({ length: 8 }, (_, j) => {
      const a = (j + 0.5) / 8 * 2 * Math.PI;
      return [w * sp(Math.cos(a), 0.6), y, (zt + zb) / 2 + (zt - zb) / 2 * sp(Math.sin(a), 0.6)];
    })), { cap0: true, cap1: true }), ([i], c) => c[2] < -0.085 ? 'sole' : i === 1 && c[2] > 0.0 ? 'acc' : 'shoe', b + 2);
    E.add(sweep([[-0.034, 0.125, -0.106], [0.034, 0.125, -0.106]], [0.0127, 0.06], 4, { ref: [0, 0, 1], phase: Math.PI / 4, cap0: true, cap1: true }), 'black', b + 2);
  }
  // arms: short sleeves with a band above the elbow, gloves with bare fingers
  const ARM = [[-0.045, 0.022, 0.022], [-0.025, 0.044, 0.044], [0.005, 0.052, 0.052], [0.07, 0.049, 0.049], [0.15, 0.045, 0.045], [0.19, 0.045, 0.045],
    [0.2, 0.04, 0.04], [0.25, 0.037, 0.037], [UA, 0.035, 0.035], [UA + 0.05, 0.039, 0.039], [UA + 0.13, 0.034, 0.034], [UA + 0.215, 0.027, 0.024],
    [UA + 0.245, 0.026, 0.024], [UA + 0.27, 0.028, 0.025], [UA + 0.285, 0.015, 0.015]];
  const HP = [[0, -0.012, 0.002], [0, 0.035, 0.004], [0, 0.08, 0], [0, 0.103, -0.016], [0, 0.11, -0.042], [0, 0.1, -0.064]];
  const HR = [[0.026, 0.02], [0.04, 0.02], [0.043, 0.017], [0.041, 0.015], [0.038, 0.013], [0.032, 0.011]];
  for (const [b, s] of [[13, 1], [16, -1]]) {
    E.add(limb(ARM, 8), ([i]) => i < 0 || i <= 3 ? 'kit' : i === 4 ? 'acc' : i <= 11 ? 'skin' : 'glove', b, { w: p => [b + 1, clamp((p[1] - UA + 0.025) / 0.05, 0, 1)] });
    E.add(sweep(HP, HR, 6, { cap0: true, cap1: true, phase: Math.PI / 6 }), ([i]) => i >= 2 ? 'skin' : 'glove', b + 2);
    E.add(sweep([[-s * 0.028, 0.01, -0.012], [-s * 0.04, 0.045, -0.022], [-s * 0.036, 0.075, -0.038]], [0.013, 0.011, 0.009], 5, { cap0: true, cap1: true }), 'skin', b + 2);
  }
  headParts(E);
}

// the head (bone 6) from the top of the neck: y up, -z the face
function headParts(E) {
  const C = [0, 0.065, -0.012], NR = 10, rings = [];
  for (let i = 0; i < 9; i++) {
    const th = 0.28 + i / 8 * (Math.PI - 0.5);
    rings.push(Array.from({ length: NR }, (_, j) => {
      const ph = j / NR * 2 * Math.PI, d = [Math.sin(th) * Math.sin(ph), Math.cos(th), -Math.sin(th) * Math.cos(ph)];
      const jaw = d[1] < -0.25 ? 1 - 0.5 * (-d[1] - 0.25) : 1, back = d[1] < -0.2 && d[2] > 0 ? 0.72 : 1;
      return add(C, [d[0] * 0.075 * jaw, d[1] * (d[1] > 0 ? 0.108 : 0.118), d[2] * (d[2] < 0 ? 0.1 : 0.095) * back]);
    }));
  }
  E.add(loft(rings, { cap0: true, cap1: true }), 'skin', 6);
  E.add(sweep([[0, 0.05, -0.105], [0, 0.03, -0.12], [0, 0.015, -0.118]], [[0.01, 0.008], [0.011, 0.01], [0.008, 0.006]], 5, { cap0: true, cap1: true }), 'skin', 6);
  for (const s of [1, -1]) E.add(limb([[-0.03, 0.007, 0.01], [0, 0.012, 0.019], [0.032, 0.006, 0.009]], 4), 'skin', 6, { m: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [s * 0.074, 0.03, 0.012]] });
  E.add(sweep([[0, 0.035, -0.005], [0, -0.025, 0.02], [0, -0.075, 0.058]], [0.054, 0.058, 0.066], 10, { cap1: true }), 'skin', 6);
  // helmet: sections front to back, each a dome over the head with a lip inside the rim; vents as dark stripes
  const HS = [[-0.132, 0.03, 0.105, 0.088], [-0.118, 0.07, 0.15, 0.082], [-0.085, 0.093, 0.188, 0.076], [-0.04, 0.104, 0.208, 0.074], [0.01, 0.107, 0.214, 0.07],
    [0.06, 0.103, 0.2, 0.052], [0.1, 0.089, 0.172, 0.032], [0.13, 0.065, 0.133, 0.018], [0.152, 0.033, 0.092, 0.02]];
  E.add(loft(HS.map(([z, hw, top, rim]) => {
    const arc = Array.from({ length: 13 }, (_, k) => { const p = k / 12 * Math.PI; return [hw * sp(Math.cos(p), 0.85), rim + (top - rim) * sp(Math.sin(p), 0.8), z]; });
    return [[hw * 0.78, rim + 0.012, z], ...arc, [-hw * 0.78, rim + 0.012, z]];
  }), { closed: false, cap0: true, cap1: true }), ([i, j]) => {
    if (i < 0 || i >= HS.length - 1) return 'helmet';
    if (j === 0 || j === 13) return 'vent';
    const k = j - 1;
    if ((k === 2 || k === 9) && i >= 2 && i <= 5 || (k === 4 || k === 7) && i >= 1 && i <= 4) return 'ventG';
    if ((k === 5 || k === 6) && i >= 5) return 'kit';
    return 'helmet';
  }, 6);
  // wraparound glasses: lens with a white top frame
  E.add(loft(Array.from({ length: 11 }, (_, k) => {
    const b = (-1 + k / 5) * 1.9, x = 0.085 * Math.sin(b), z = C[2] - 0.108 * Math.cos(b);
    return [[x, 0.036, z], [x, 0.064, z], [x, 0.073, z]];
  }), { closed: false, inside: C }), ([, j]) => j === 0 ? 'lens' : 'white', 6);
  // helmet straps down past the ears
  for (const s of [1, -1]) E.add(sweep([[s * 0.084, 0.075, 0.03], [s * 0.081, 0.0, 0.012], [s * 0.066, -0.05, -0.038], [s * 0.03, -0.074, -0.068]], [0.003, 0.007], 3), 'vent', 6);
}

/* ---------- shared geometry and materials ---------- */
const SHARED = { geo: null, users: 0, mats: new Map() };
function useGeometry(THREE) {
  if (!SHARED.geo) { const E = emitter(THREE); bikeParts(E); wheelParts(E, 1, 24, true); wheelParts(E, 2, 20, false); crankParts(E); bodyParts(E); SHARED.geo = E.done(); }
  SHARED.users++; return SHARED.geo;
}
function dropGeometry() { if (--SHARED.users <= 0 && SHARED.geo) { SHARED.geo.dispose(); SHARED.geo = null; SHARED.users = 0; } }
// one shader for every scheme: the palette slots and per-face roughness and metalness come from vertex attributes
function onCompile(sh) {
  sh.uniforms.uPal = this.userData.pal;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float pal;\nattribute vec2 rm;\nuniform vec3 uPal[6];\nvarying vec2 vRm;')
    .replace('#include <color_vertex>', '#include <color_vertex>\n\tif (pal > 0.5) vColor.rgb *= uPal[int(pal + 0.5) - 1];\n\tvRm = rm;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vRm;')
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRm.x;').replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRm.y;');
}
function useMaterial(THREE, cols) {
  const key = cols.join(); let e = SHARED.mats.get(key);
  if (!e) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true }), c = new THREE.Color(), pal = new Float32Array(18);
    cols.forEach((h, i) => { c.setHex(h); pal[i * 3] = c.r; pal[i * 3 + 1] = c.g; pal[i * 3 + 2] = c.b; });
    m.userData.pal = { value: pal }; m.onBeforeCompile = onCompile;
    e = { m, key, n: 0 }; SHARED.mats.set(key, e);
  }
  e.n++; return e;
}
function dropMaterial(e) { if (--e.n <= 0) { e.m.dispose(); SHARED.mats.delete(e.key); } }

/* ---------- a rider ---------- */
// THREE: the three.js module. Colours as hex: kit (jersey), kit2 (bib shorts, collar), accent (side panels, bands; kit2
// when not given), skin, bike (frame), helmet. Returns { group, update(dt s, cadence rpm, speed m/s, grade fraction),
// setKit(kit, accent), state, dispose() }.
export function makeRider(THREE, { kit = 0xf2c230, kit2 = 0x1b1f25, accent = null, skin = 0xe8bd98, bike = 0x2a2f36, helmet = 0xf2f2f0 } = {}) {
  const geo = useGeometry(THREE), scheme = { kit, kit2, accent, skin, bike, helmet };
  const cols = () => [scheme.kit, scheme.kit2, scheme.accent ?? scheme.kit2, scheme.skin, scheme.helmet, scheme.bike];
  let mat = useMaterial(THREE, cols());
  const bones = Array.from({ length: 19 }, () => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; return b; });
  // bind poses: the chest above the pelvis, shins below straight thighs, forearms below straight upper arms
  const inv = bones.map(() => new THREE.Matrix4()); inv[5].makeTranslation(0, -LP, 0);
  for (const i of [8, 11]) inv[i].makeTranslation(0, -BIKE.thigh, 0);
  for (const i of [14, 17]) inv[i].makeTranslation(0, -UA, 0);
  const mesh = new THREE.SkinnedMesh(geo, mat.m);
  for (const b of bones) mesh.add(b);
  mesh.bind(new THREE.Skeleton(bones, inv), new THREE.Matrix4());
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.85, 0), 1.3);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-0.7, -0.05, -1), new THREE.Vector3(0.7, 1.95, 1));
  mesh.castShadow = true; mesh.receiveShadow = false;
  const group = new THREE.Group(); group.add(mesh);
  const s = newStance(Math.random() * 2 * Math.PI);

  const setB = (i, [x, y, z, o]) => { bones[i].matrix.set(x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2], 0, 0, 0, 1); bones[i].matrixWorldNeedsUpdate = true; };
  // a frame at o: y along dir, x toward the hint
  const basis = (o, dir, xh) => { const y = unit(dir), x = unit(sub(xh, mul(y, dot(xh, y)))); return [x, y, cross(x, y), o]; };
  const at = (m, p) => add(m[3], add(add(mul(m[0], p[0]), mul(m[1], p[1])), mul(m[2], p[2])));
  // a part turning about x at a pivot, on the bike rolled by r
  const spin = (i, p, a, r) => setB(i, [[Math.cos(r), Math.sin(r), 0], rotZ([0, Math.cos(a), Math.sin(a)], r), rotZ([0, -Math.sin(a), Math.cos(a)], r), rotZ(p, r)]);

  function pose() {
    const e = smooth(s.sb), tk = smooth(s.tb) * (1 - e), cl = s.cl * (1 - e), sn = Math.sin(s.ca);
    // the bike rocks under a standing rider, barely when seated
    const roll = sn * (0.012 * cl + 0.085 * e), R = p => rotZ(p, roll), lat = [Math.cos(roll), Math.sin(roll), 0];
    spin(0, [0, 0, 0], 0, roll); spin(1, REAR, -s.wa, roll); spin(2, FRONT, -s.wa, roll); spin(3, BB, -s.ca, roll);
    // feet on the pedals, the ankle dropping the heel on the push and the toes on the way round
    const foot = [1, -1].map(side => {
      const a = s.ca + (side > 0 ? 0 : Math.PI), ph = (17.5 - 12.5 * Math.sin(a) - 2.5 * Math.cos(a)) * DEG;
      const f = [0, -Math.sin(ph), -Math.cos(ph)], n = [0, Math.cos(ph), -Math.sin(ph)], P = [side * 0.115, BB[1] + CR * Math.cos(a), BB[2] - CR * Math.sin(a)];
      return { A: R(add(P, add(mul(n, 0.1), mul(f, -0.125)))), f: R(f) };
    });
    // hips: on the saddle, a little forward in the tuck, up over the cranks standing, never higher than the legs reach
    const Hs = [0, SADDLE[1] + 0.085, SADDLE[2] - 0.015], Hseat = R(mix(Hs, add(Hs, [0, -0.012, -0.065]), tk));
    const H = mix(Hseat, [0.02 * sn, SADDLE[1] + 0.17, SADDLE[2] - 0.28], e);
    const rP = lerp(roll - 0.015 * sn * (1 + cl), -0.05 * sn, e), latP = [Math.cos(rP), Math.sin(rP), 0];
    foot.forEach(({ A }, k) => {
      const side = k ? -1 : 1, J = add(H, mul(latP, side * HIPW)), dx = J[0] - A[0], dz = J[2] - A[2];
      H[1] = softmin(H[1], A[1] + Math.sqrt(Math.max(0, LMAX * LMAX - dx * dx - dz * dz)) - latP[1] * side * HIPW);
    });
    // torso: the shoulders where the arms reach the hoods; a rounded back through the mid spine
    const G = R([0, HOOD[1], HOOD[2]]), D = lerp(lerp(0.6, 0.44, tk), 0.56, e) + 0.01 * cl, LS = lerp(lerp(0.505, 0.495, tk), 0.516, e);
    const s2 = meet(H[1], H[2], LS, G[1], G[2], D), Sc = [lerp(H[0], G[0], 0.55), s2[0], s2[1]];
    const m2 = meet(H[1], H[2], LP, Sc[1], Sc[2], LC), M = [(H[0] + Sc[0]) / 2, m2[0], m2[1]];
    const latC = unit([1, lerp(roll - 0.03 * sn * cl, roll * 0.35, e), 0.04 * sn * cl]);
    setB(4, basis(H, sub(M, H), latP)); const chest = basis(M, sub(Sc, M), latC); setB(5, chest);
    // legs
    foot.forEach(({ A, f }, k) => {
      const side = k ? -1 : 1, J = add(H, mul(latP, side * HIPW)), pole = R([side * 0.05, 0.25, -1]);
      const K = ik(J, A, BIKE.thigh, BIKE.shin, pole), n = unit(cross(sub(A, J), pole)), b = 7 + 3 * k;
      setB(b, basis(J, sub(K, J), n)); setB(b + 1, basis(K, sub(A, K), n)); setB(b + 2, basis(A, f, lat));
    });
    // arms: hands on the hoods, elbows out and down
    for (const [k, side] of [[0, 1], [1, -1]]) {
      const Sh = at(chest, [side * SHW, LC - 0.022, -0.004]), g = R([side * HOOD[0], HOOD[1] + 0.022, HOOD[2]]), Wr = add(g, R([0, 0.025, 0.07]));
      const pole = [side * 0.6, -0.5, 0.5], El = ik(Sh, Wr, UA, FA, pole), n = unit(cross(sub(Wr, Sh), pole)), b = 13 + 3 * k;
      setB(b, basis(Sh, sub(El, Sh), n)); setB(b + 1, basis(El, sub(Wr, El), n)); setB(b + 2, basis(Wr, sub(g, Wr), lat));
    }
    // head: level, looking down the road
    const C7 = at(chest, [0, LC + 0.045, 0.03]), z = unit([0, 0.2, 1]), lh = unit(mix([1, 0, 0], latC, 0.3));
    const x = unit(sub(lh, mul(z, dot(lh, z)))), y = cross(z, x);
    setB(6, [x, y, z, add(C7, add(mul(y, 0.068), mul(z, -0.05)))]);
  }
  pose();
  return {
    group, state: s,
    // dt seconds, cadence rpm, v m/s, grade a fraction (0.08 is 8 percent up)
    update(dt, cadence, v, grade = 0) { stance(s, dt, cadence, v, grade); pose(); },
    // a new jersey colour (and accent) at any time
    setKit(kitHex, accentHex) {
      if (!mat) return;
      if (kitHex != null) scheme.kit = kitHex;
      if (accentHex !== undefined) scheme.accent = accentHex;
      const next = useMaterial(THREE, cols()); dropMaterial(mat); mat = next; mesh.material = mat.m;
    },
    dispose() { if (!mat) return; dropMaterial(mat); mat = null; dropGeometry(); mesh.skeleton.dispose(); },
  };
}
