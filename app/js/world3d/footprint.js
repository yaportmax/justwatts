// (A55: cx-leaves roof-baseline and owner shot 17. Area alone does not prove that
// a roof fits a concave footprint. Shared, metre-space boundary tests.)
export function footprintGap(ring, x, z) {
  let inside = false, distance = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], dx = b[0] - a[0], dz = b[1] - a[1];
    if ((a[1] > z) !== (b[1] > z) && x < dx * (z - a[1]) / dz + a[0]) inside = !inside;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    distance = Math.min(distance, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
  }
  return inside ? -distance : distance;
}

export function footprintContains(ring, outline, margin = 0) {
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
    for (let j = 0; j <= steps; j++) {
      if (footprintGap(ring, a[0] + (b[0] - a[0]) * j / steps, a[1] + (b[1] - a[1]) * j / steps) > margin + 1e-6) return false;
    }
  }
  return true;
}

export function simpleOutline(ring) {
  const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-5) return false;
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      const c = ring[j], d = ring[(j + 1) % ring.length];
      if (cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10) return false;
    }
  }
  return true;
}
