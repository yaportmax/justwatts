import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';

import { hash2 } from './landuse.js';

// (A64: both directions along Miller at the athletic fields. The campus polygon
// beside a mapped pitch supplies the frontage. A repeating diamond mesh keeps
// the field visible through the fence without drawing each wire separately.)
export function athleticFenceMaterial() {
  const width = 256, height = 128, data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const x = (i + 0.5) / width, y = (j + 0.5) / height;
    const line = v => Math.abs(v - Math.round(v));
    const wire = Math.min(line(x * 20 + y * 11), line(x * 20 - y * 11));
    const frame = x < 0.012 || x > 0.988 || y < 0.018 || y > 0.976;
    const alpha = frame ? 1 : Math.max(0, 1 - wire / 0.135);
    const start = (j * width + i) * 4;
    data[start] = data[start + 1] = data[start + 2] = 255;
    data[start + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return new THREE.MeshLambertMaterial({color:0x536159, map:texture, alphaTest:0.28, side:THREE.DoubleSide});
}

export function athleticFence(rows, xz, ground, gap, blocked) {
  const pos = [], uv = [];
  for (const [la, lo, da, dO, dm, kind] of rows || []) {
    if (kind !== 2 && kind !== 7) continue;
    const a = xz(la / 1e6, lo / 1e6), b = xz((la + da) / 1e6, (lo + dO) / 1e6);
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    const count = Math.ceil(length / 0.75), height = dm / 10;
    let prev = null;
    for (let j = 0; j <= count; j++) {
      const t = j / count, x = a[0] + dx * t, z = a[1] + dz * t, y = ground(x,z);
      if (y == null || gap(x,z) < (kind === 7 ? 0.24 : 1.2) || blocked(x,z,kind === 7)) { prev = null; continue; }
      const base = [x,y - 0.06,z], top = [x,y + height,z], u = t * length / 2.8;
      if (prev && Math.abs(y - prev.base[1]) < 0.9) {
        pos.push(...prev.base,...base,...top,...prev.base,...top,...prev.top);
        uv.push(prev.u,0,u,0,u,1,prev.u,0,u,1,prev.u,1);
      }
      prev = { base, top, u };
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}


// (A69: Molino 610200, Edgewood 620900 and Panoramic 513960. The photographed
// planks and open slats have different profiles. Both share the garden mesh.)
function timberBoards(row, xz, ground, gap, blocked, quad) {
  const [lat, lon, dlat, dlon, dm, kind] = row;
  const a = xz(lat / 1e6, lon / 1e6);
  const b = xz((lat + dlat) / 1e6, (lon + dlon) / 1e6);
  const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  if (length < 0.25) return;
  const nx = -dz / length, nz = dx / length, height = dm / 10;
  const slatted = kind === 6, panelled = kind === 12;
  const wood = new THREE.Color(({3:0x827966, 4:0x885d48, 5:0xdadbd1, 6:0x5d5144, 12:0x87594f})[kind]);
  function column(t) {
    const x = a[0] + dx * t, z = a[1] + dz * t;
    const y = ground(x, z);
    if (y == null || gap(x, z) < 0.24 || blocked(x, z, true)) return null;
    return [x, y, z];
  }
  function board(p, q, lo, hi, thick, tint) {
    const side = (v, y, s) => [v[0] + nx * s, v[1] + y, v[2] + nz * s];
    const A = side(p,lo,thick), B = side(q,lo,thick), C = side(q,hi,thick), D = side(p,hi,thick);
    const E = side(p,lo,-thick), F = side(q,lo,-thick), G = side(q,hi,-thick), H = side(p,hi,-thick);
    quad(A,B,C,D,tint); quad(F,E,H,G,tint); quad(D,C,G,H,tint);
    quad(E,A,D,H,tint); quad(B,F,G,C,tint);
    if (lo > 0) quad(E,F,B,A,tint);
  }
  // (A69: Edgewood 620950. Opaque horizontal boards span between posts.
  // Each cap is level within its panel and steps with the grade at the post.)
  if (panelled) {
    const bays = Math.ceil(length / 1.85), courses = Math.round(height / 0.18);
    for (let i = 0; i < bays; i++) {
      const t0 = i / bays, t1 = (i + 1) / bays;
      const feet = Array.from({length: 7}, (_, j) => column(t0 + (t1 - t0) * j / 6));
      if (feet.some(p => !p)) continue;
      const ys = feet.map(p => p[1]);
      if (Math.max(...ys) - Math.min(...ys) > 0.7) continue;
      const p = feet[0], q = feet[6], sill = (p[1] + q[1]) * 0.5;
      const a = [p[0], sill, p[2]], b = [q[0], sill, q[2]];
      for (let j = 0; j < courses; j++) {
        const low = j ? j * height / courses : Math.min(...ys) - sill - 0.12;
        const tint = wood.clone().multiplyScalar(0.81 + 0.28 * hash2(i, j));
        board(a, b, low, (j + 1) * height / courses, 0.045, tint);
      }
      board(a, b, height, height + 0.055, 0.074, wood);
      for (const [start, end] of [[t0, t0 + 0.10 / length], ...(i === bays - 1 ? [[t1 - 0.10 / length, t1]] : [])]) {
        const p0 = column(start), p1 = column(end);
        if (!p0 || !p1) continue;
        const base = Math.min(p0[1], p1[1]) - 0.12;
        board([p0[0], base, p0[2]], [p1[0], base, p1[2]], 0, sill + height + 0.06 - base, 0.082, wood);
      }
    }
    return;
  }
  const bays = Math.ceil(length / (slatted ? 1.65 : 0.16));
  for (let i = 0; i < bays; i++) {
    const p = column(i / bays), q = column((i + 1) / bays);
    if (!p || !q || Math.abs(p[1] - q[1]) > 0.7) continue;
    const tint = wood.clone().multiplyScalar(0.84 + 0.23 * hash2(Math.round(p[0]*10),Math.round(p[2]*10)));
    if (slatted) {
      const layers = Math.max(3, Math.round(height / 0.2));
      for (let level = 0; level < layers; level++) {
        const top = height * (level + 1) / layers;
        board(p, q, top - height / layers * 0.77, top, 0.031, tint);
      }
      const end = column(Math.min(1, i / bays + 0.09 / length));
      if (end) board(p, end, -0.12, height + 0.045, 0.065, tint);
    } else {
      board(p, q, -0.12, height, 0.038, tint);
    }
  }
}

export function gardenBoundaries(rows, xz, ground, gardenGap, blocked) {
  const gardens = rows.filter(r => r[5] < 2).map(([a,o,da,dO,h,hedge]) => ({
    a: xz(a/1e6, o/1e6), b: xz((a+da)/1e6, (o+dO)/1e6), height: h/10, hedge,
  }));
  const pos = [], colors = [];
  const quad = (a,b,c,d,tint) => {
    pos.push(...a,...b,...c,...a,...c,...d);
    for (let i=0;i<6;i++) colors.push(tint.r,tint.g,tint.b);
  };
  for (const row of rows) {
    if ((row[5] >= 3 && row[5] <= 6) || row[5] === 12) timberBoards(row, xz, ground, gardenGap, blocked, quad);
  }
  // (A64: Molino and Edgewood front gardens. Only mapped fences and linear
  // lidar returns with a vegetated NAIP signal in front of a house enter this list.)
  for (const { a, b, height, hedge } of gardens) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx,dz);
    if (len < 0.3) continue;
    const nx = -dz / len, nz = dx / len, count = Math.ceil(len / 1.2);
    let last = null;
    for (let i = 0; i <= count; i++) {
      const t = i / count, x = a[0] + dx * t, z = a[1] + dz * t;
      const half = hedge ? 0.38 : 0.065;
      const sides = [-1,1].map(s => [x + nx * half * s, z + nz * half * s]);
      const ys = sides.map(([x,z]) => ground(x,z));
      if (ys.some(y => y == null) || sides.some(([x,z]) => gardenGap(x,z) < 1.5 || blocked(x,z))) { last = null; continue; }
      const noise = hash2(Math.round(x * 2),Math.round(z * 2));
      const y = Math.max(...ys), top = y + height * (hedge ? 0.90 + noise * 0.14 : 1);
      const row = [[sides[0][0],ys[0]-0.18,sides[0][1]],[sides[0][0],top-(hedge?0.25:0),sides[0][1]],
        [x,top,z],[sides[1][0],top-(hedge?0.25:0),sides[1][1]],[sides[1][0],ys[1]-0.18,sides[1][1]]];
      if (last) for (let j=0;j<4;j++) {
        const shade = (hedge ? (j === 0 || j === 3 ? 0x485337 : 0x68744c) : 0x88745c);
        const tint = new THREE.Color(shade).multiplyScalar(0.87 + noise * 0.20);
        quad(last[j],last[j+1],row[j+1],row[j],tint);
      }
      last = row;
    }
  }

  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  g.setAttribute('tag',new THREE.Float32BufferAttribute(new Float32Array(pos.length/3),1));
  g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

// (A69: Edgewood 620400, Molino 610150 and 610400. The visible toes of the
// retained banks locate the walls. Seat their faces on the lower side and use
// the photographed exposed height, including where terrain hides the back.)
export function gardenWallRuns(rows, xz, ground, gap, blocked) {
  const runs = [];
  for (const [lat, lon, da, dO, dm, type] of rows) {
    if (type < 8 || type > 11) continue;
    const a = xz(lat / 1e6, lon / 1e6), b = xz((lat + da) / 1e6, (lon + dO) / 1e6);
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 0.3) continue;
    const nx = -dz / len, nz = dx / len, n = Math.ceil(len / 0.45);
    let run;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a[0] + t * dx, z = a[1] + t * dz;
      const low = ground(x - nx * 0.15, z - nz * 0.15), high = ground(x + nx * 0.15, z + nz * 0.15);
      if (low == null || high == null || gap(x, z) < 0.33 || blocked(x, z, true)) { run = null; continue; }
      const y = Math.min(low, high);
      if (!run || Math.abs(run.pts[run.pts.length - 1][1] - y) > 0.6) {
        run = {kind:'wall', finish:type, pts:[], wh:[]};
        runs.push(run);
      }
      run.pts.push([x, y, z, nx, nz]);
      run.wh.push(dm / 10);
    }
  }
  return runs.filter(r => r.pts.length > 1);
}
