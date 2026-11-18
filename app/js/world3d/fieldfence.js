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
    if (kind !== 2) continue;
    const a = xz(la / 1e6, lo / 1e6), b = xz((la + da) / 1e6, (lo + dO) / 1e6);
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    const count = Math.ceil(length / 0.75), height = dm / 10;
    let prev = null;
    for (let j = 0; j <= count; j++) {
      const t = j / count, x = a[0] + dx * t, z = a[1] + dz * t, y = ground(x,z);
      if (y == null || gap(x,z) < 1.2 || blocked(x,z)) { prev = null; continue; }
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


export function gardenBoundaries(rows, xz, ground, gardenGap, blocked) {
  const gardens = rows.filter(r => r[5] < 2).map(([a,o,da,dO,h,hedge]) => ({
    a: xz(a/1e6, o/1e6), b: xz((a+da)/1e6, (o+dO)/1e6), height: h/10, hedge,
  }));
  const pos = [], colors = [];
  const quad = (a,b,c,d,tint) => {
    pos.push(...a,...b,...c,...a,...c,...d);
    for (let i=0;i<6;i++) colors.push(tint.r,tint.g,tint.b);
  };
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
