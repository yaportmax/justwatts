// (A54: cached OSM has cycleway buffer tags which packed road flags lost. Index paint only, leaving road widths, rails and chaining unchanged.)
export function bufferPaint(roads, xz) {
  const cells = new Map(), size = 32;
  for (const road of roads) {
    if (!road.pm || road.fl & 3) continue;
    const pts = road.pts.map(p => xz(...p));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
      if (l2 < 0.01) continue;
      const seg = { a, dx, dz, l2, pm: road.pm };
      for (let x = Math.floor((Math.min(a[0], b[0]) - 2) / size); x <= Math.floor((Math.max(a[0], b[0]) + 2) / size); x++)
        for (let z = Math.floor((Math.min(a[1], b[1]) - 2) / size); z <= Math.floor((Math.max(a[1], b[1]) + 2) / size); z++) {
          const k = x + ',' + z;
          (cells.get(k) ?? cells.set(k, []).get(k)).push(seg);
        }
    }
  }
  if (!cells.size) return null;
  return (x, z, tx, tz) => {
    let best = 4, bits = 0;
    for (const s of cells.get(Math.floor(x / size) + ',' + Math.floor(z / size)) || []) {
      const dot = (s.dx * tx + s.dz * tz) / Math.sqrt(s.l2);
      if (Math.abs(dot) < 0.85) continue;
      const u = Math.max(0, Math.min(1, ((x - s.a[0]) * s.dx + (z - s.a[1]) * s.dz) / s.l2));
      const d = (x - s.a[0] - u * s.dx) ** 2 + (z - s.a[1] - u * s.dz) ** 2;
      if (d >= best) continue;
      best = d;
      const pm = dot >= 0 ? s.pm : ((s.pm & 1) << 1) | ((s.pm & 2) >> 1);
      bits = (pm & 1 ? 128 : 0) | (pm & 2 ? 256 : 0);
    }
    return bits;
  };
}
