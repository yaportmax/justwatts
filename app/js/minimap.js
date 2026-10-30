// Open-world minimap (the ride HUD): the loaded roads round the rider from above, heading up, the road ahead, the
// other ways at a junction and the rider. DOM-free apart from the canvas; fit(cv) -> [ctx, w, h] (app.js).
const R = Math.PI / 180, M = 111195;
const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const bearing = (a, b) => Math.atan2((b[1] - a[1]) * Math.cos(a[0] * R), b[0] - a[0]);  // radians, 0 north, clockwise

// ll: the course line (a point every 10 m), d: metres along it, roads: [[lat, lon, lat, lon, rank]] (world.roads),
// alts: the other ways at the junction ahead ([[lat, lon]]), m: metres from the rider to the top edge
export function drawMinimap(cv, { fit, css, ll, d, roads = [], alts = [], m = 500 }) {
  const [c, w, h] = fit(cv); c.clearRect(0, 0, w, h);
  if (!ll || ll.length < 2 || !w || !h) return null;
  const n = ll.length, x = Math.max(0, Math.min(d / 10, n - 1.001)), i = Math.floor(x), at = lerp(ll[i], ll[i + 1], x - i);
  const hb = bearing(ll[Math.max(0, i - 2)], ll[Math.min(n - 1, i + 3)]), k = Math.cos(at[0] * R), cx = w / 2, cy = h * 0.64, sc = cy / m;
  const cs = Math.cos(hb), sn = Math.sin(hb);  // turned so the heading points up
  const P = (lat, lon) => { const e = (lon - at[1]) * k * M, nn = (lat - at[0]) * M; return [cx + (e * cs - nn * sn) * sc, cy - (e * sn + nn * cs) * sc]; };
  c.save(); c.lineCap = c.lineJoin = 'round';
  c.strokeStyle = 'rgba(232,235,239,.32)';
  for (const r of [0, 1, 2]) {
    c.lineWidth = [1.2, 2, 3][r]; c.beginPath();
    for (const s of roads) if (s[4] === r) { const a = P(s[0], s[1]), b = P(s[2], s[3]); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
    c.stroke();
  }
  const line = (pts, col, lw) => { if (pts.length < 2) return; c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); pts.forEach((p, j) => { const q = P(p[0], p[1]); j ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke(); };
  for (const a of alts) line(a, css('--warn'), 3);
  const span = Math.ceil(m * 1.6 / 10);
  line(ll.slice(Math.max(0, i - span), i + 1).concat([at]), 'rgba(56,189,248,.35)', 3);
  line([at, ...ll.slice(i + 1, i + 1 + span)], css('--acc'), 3.5);
  // the rider: an arrow pointing up (the way they ride)
  c.translate(cx, cy); c.fillStyle = css('--ink'); c.strokeStyle = 'rgba(11,13,16,.9)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, -9); c.lineTo(6.5, 7); c.lineTo(0, 3.5); c.lineTo(-6.5, 7); c.closePath(); c.stroke(); c.fill();
  c.restore();
  return at;
}
