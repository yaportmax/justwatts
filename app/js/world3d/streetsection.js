// (A64: Miller 590300 to 591100. The divided road has a median kerb and an outside
// sidewalk. The baked widths keep the source way's direction when the ride line reverses.)
export function streetSections(rows, xz) {
  if (!rows?.length) return null;
  const cells = new Map(), cell = v => Math.floor(v / 24);
  for (const [lat, lon, dLat, dLon, left, right, leftMid = 0, rightMid = 0, leftFront = 0, rightFront = 0] of rows) {
    const a = xz(lat / 1e6, lon / 1e6), b = xz((lat + dLat) / 1e6, (lon + dLon) / 1e6);
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    if (l2 < 0.01) continue;
    const s = { a, dx, dz, l2, left, right, leftMid, rightMid, leftFront, rightFront };
    for (let i = cell(Math.min(a[0], b[0]) - 3); i <= cell(Math.max(a[0], b[0]) + 3); i++)
      for (let j = cell(Math.min(a[1], b[1]) - 3); j <= cell(Math.max(a[1], b[1]) + 3); j++) {
        const key = i + ',' + j;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(s);
      }
  }
  return (x, z, tx, tz) => {
    let best = null, d2 = 9;
    for (const s of cells.get(cell(x) + ',' + cell(z)) || []) {
      if ((s.dx * tx + s.dz * tz) ** 2 < 0.8 ** 2 * s.l2) continue;
      const px = x - s.a[0], pz = z - s.a[1], u = Math.max(0, Math.min(1, (px * s.dx + pz * s.dz) / s.l2));
      const d = (px - u * s.dx) ** 2 + (pz - u * s.dz) ** 2;
      if (d < d2) { d2 = d; best = s; }
    }
    return best && { s: best, dx: best.dx, dz: best.dz };
  };
}

// (A64: Miller 590950. The prop-placement bank cells can differ from the
// visible triangle by several centimetres. Sample the emitted paving and bank
// triangles for sidewalk corners, and use the terrain grid everywhere else.)
export function* sidewalkSupport(roadMeshes, floor, rows, project, walk) {
  const cell = v => Math.floor(v / 8);
  const key = (i, j) => i * 65536 + j;
  const nearby = new Set(), buckets = new Map();
  if (walk) for (const [dx, dz] of walk.points) {
    const x = (walk.origin[0] + dx) / 100, z = (walk.origin[1] + dz) / 100;
    nearby.add(key(cell(x), cell(z)));
  }
  for (const [lat, lon, da, dO] of rows || []) {
    const a = project(lat / 1e6, lon / 1e6);
    const b = project((lat + da) / 1e6, (lon + dO) / 1e6);
    for (let i = cell(Math.min(a[0], b[0]) - 24); i <= cell(Math.max(a[0], b[0]) + 24); i++) {
      for (let j = cell(Math.min(a[1], b[1]) - 24); j <= cell(Math.max(a[1], b[1]) + 24); j++) nearby.add(key(i, j));
    }
  }
  for (const mesh of roadMeshes || []) {
    const g = mesh.geometry, pos = g?.attributes.position;
    if (!pos || (!g.attributes.mk && !g.attributes.ruv)) continue;
    const index = g.index, indices = index?.array, count = index?.count ?? pos.count;
    for (let k = 0; k + 2 < count; k += 3) {
      if (k && k % 6144 === 0) yield;
      const a = indices ? indices[k] : k, b = indices ? indices[k + 1] : k + 1, c = indices ? indices[k + 2] : k + 2;
      const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c);
      const ux = ax - cx, uz = az - cz, vx = bx - cx, vz = bz - cz, den = ux * vz - uz * vx;
      if (den >= -1e-8) continue;
      let triangle;
      for (let i = cell(Math.min(ax, bx, cx)); i <= cell(Math.max(ax, bx, cx)); i++) {
        for (let j = cell(Math.min(az, bz, cz)); j <= cell(Math.max(az, bz, cz)); j++) {
          const id = key(i, j);
          if (!nearby.has(id)) continue;
          triangle ??= [cx, cz, vz / den, -vx / den, -uz / den, ux / den, pos.getY(c), pos.getY(a) - pos.getY(c), pos.getY(b) - pos.getY(c)];
          if (!buckets.has(id)) buckets.set(id, []);
          buckets.get(id).push(triangle);
        }
      }
    }
  }
  return (x, z) => {
    let top = floor(x, z);
    for (const t of buckets.get(key(cell(x), cell(z))) || []) {
      const u = x - t[0], v = z - t[1], a = u * t[2] + v * t[3], b = u * t[4] + v * t[5];
      if (a >= -1e-6 && b >= -1e-6 && a + b <= 1.000001) {
        const y = t[6] + a * t[7] + b * t[8];
        top = top == null ? y : Math.max(top, y);
      }
    }
    return top;
  };
}
