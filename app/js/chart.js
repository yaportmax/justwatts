// Ride and workout charts on a 2D canvas context. No DOM access: colors come from css(name).
import { fmtT, stepWatts, stepAt, ZONES, zoneIdx } from './core.js';

export const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
export function maxTarget(cw, ftp, k = 1) { let m = 0; for (const s of cw.steps) if (!s.free) m = Math.max(m, stepWatts(s, 0, ftp, k), stepWatts(s, s.d, ftp, k)); return m; }

// the target profile as zone-colored blocks
// edge: alpha of a crisp top line in the zone color (0: none), so faint blocks still read clearly
export function drawBlocks(c, cw, ftp, X, Y, alpha, k, css, edge = 0) {
  const zoneColor = f => css(ZONES[zoneIdx(f)][1]);
  for (const s of cw.steps) {
    if (s.free) {
      c.fillStyle = hexA(css('--z1'), alpha * 0.5);
      c.fillRect(X(s.t0), Y(0.5 * ftp), X(s.t0 + s.d) - X(s.t0), Y(0) - Y(0.5 * ftp));
      if (edge) { c.strokeStyle = hexA(css('--z1'), edge * 0.6); c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(s.t0), Y(0.5 * ftp)); c.lineTo(X(s.t0 + s.d), Y(0.5 * ftp)); c.stroke(); c.lineWidth = 1; }
      continue;
    }
    const n = s.a === s.b ? 1 : Math.max(2, Math.min(40, Math.round(s.d / 15)));
    for (let j = 0; j < n; j++) {
      const t0 = s.d * j / n, t1 = s.d * (j + 1) / n;
      const w0 = stepWatts(s, t0, ftp, k), w1 = stepWatts(s, t1, ftp, k);
      c.fillStyle = hexA(zoneColor(((w0 + w1) / 2) / ftp), alpha);
      const ov = j < n - 1 ? 0.6 : 0;  // overlap neighbours so antialiasing leaves no seams
      c.beginPath(); c.moveTo(X(s.t0 + t0), Y(0)); c.lineTo(X(s.t0 + t0), Y(w0)); c.lineTo(X(s.t0 + t1) + ov, Y(w1)); c.lineTo(X(s.t0 + t1) + ov, Y(0)); c.closePath(); c.fill();
      if (edge) { c.strokeStyle = hexA(zoneColor(((w0 + w1) / 2) / ftp), edge); c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(s.t0 + t0), Y(w0)); c.lineTo(X(s.t0 + t1), Y(w1)); c.stroke(); c.lineWidth = 1; }
    }
  }
}

/** Reduce samples to at most `maxPts` points: bucket means of power (3 s smoothed when not
 * decimated) and HR (buckets without HR break the line). Keeps a 3-hour ride cheap to draw. */
export function decimate(smp, maxPts) {
  const n = smp.length, power = [], hr = [];
  if (n <= maxPts) {
    let a0 = 0, a1 = 0, a2 = 0;
    for (let i = 0; i < n; i++) {
      a0 = a1; a1 = a2; a2 = smp[i][2];
      const m = i === 0 ? a2 : i === 1 ? (a1 + a2) / 2 : (a0 + a1 + a2) / 3;
      power.push([smp[i][1], m]);
      hr.push(smp[i][4] > 0 ? [smp[i][1], smp[i][4]] : null);
    }
    return { power, hr };
  }
  const step = n / maxPts;
  for (let b = 0; b < maxPts; b++) {
    const i0 = Math.floor(b * step), i1 = Math.min(n, Math.floor((b + 1) * step));
    if (i1 <= i0) continue;
    let ps = 0, hs = 0, hn = 0;
    for (let i = i0; i < i1; i++) { ps += smp[i][2]; if (smp[i][4] > 0) { hs += smp[i][4]; hn++; } }
    const t = smp[i1 - 1][1];
    power.push([t, ps / (i1 - i0)]);
    hr.push(hn ? [t, hs / hn] : null);
  }
  return { power, hr };
}

// full chart: profile + power + HR (right-hand axis)
export function drawChart(c, w, h, o, css) {
  const ftp = o.ftp, L = 40, B = 20, T = 8, R = 32, pw = w - L - R, ph = h - B - T;
  const smp = o.samples || [];
  const total = o.cw ? o.cw.total : Math.max(600, (o.el || 0) * 1.08, smp.length ? smp[smp.length - 1][1] : 0);
  let mp = 0; for (const s of smp) if (s[2] > mp) mp = s[2];
  const yMax = Math.max(ftp * 1.3, (o.cw ? maxTarget(o.cw, ftp, o.k) : 0) * 1.12, Math.min(mp, ftp * 2.5) * 1.05);
  const X = t => L + t / total * pw, Y = v => T + ph - Math.max(0, v) / yMax * ph;
  c.font = '11px "Inter var", system-ui'; c.fillStyle = css('--faint'); c.textAlign = 'right'; c.textBaseline = 'middle';
  let lastY = Infinity;  // a short chart: labels that would touch are skipped (the lines stay)
  for (const f of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    const v = f * ftp; if (v > yMax) break;
    c.strokeStyle = f === 1 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.06)'; c.setLineDash(f === 1 ? [4, 4] : []);
    c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(w - R, Y(v)); c.stroke(); c.setLineDash([]);
    if (lastY - Y(v) >= 13) { c.fillText(Math.round(v), L - 6, Y(v)); lastY = Y(v); }
  }
  c.textAlign = 'center'; c.textBaseline = 'top';
  const stepT = [60, 300, 600, 900, 1800, 3600].find(s => total / s <= 8) || 3600;
  for (let t = 0; t <= total; t += stepT) c.fillText(fmtT(t), X(t), h - B + 5);
  if (o.cw) {
    c.save(); drawBlocks(c, o.cw, ftp, X, Y, 0.26, o.k, css, 0.9); c.restore();
    if (o.el != null) { c.save(); c.beginPath(); c.rect(L, 0, X(o.el) - L, h); c.clip(); drawBlocks(c, o.cw, ftp, X, Y, 0.34, o.k, css); c.restore(); }
  }
  const pts = decimate(smp, Math.max(100, Math.round(pw * 2)));
  // a jump in ride time (an old skip, a resumed ride) is a gap, never a straight line across it
  const gapT = Math.max(5, pts.power.length > 1 ? 3 * (pts.power.at(-1)[0] - pts.power[0][0]) / (pts.power.length - 1) : 5);
  if (pts.hr.some(Boolean)) {
    const HY = v => T + ph - (v - 40) / 170 * ph;
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = hexA('#ef4444', 0.8);
    const hrStep = ph / 170 * 20 >= 13 ? 20 : ph / 170 * 40 >= 13 ? 40 : 60;
    for (let v = 80; v <= 200; v += hrStep) c.fillText(v, w - R + 4, HY(v));
    c.strokeStyle = hexA('#ef4444', 0.75); c.lineWidth = 1.2; c.beginPath(); let on = false;
    let pt = null;
    for (const p of pts.hr) { if (!p) { on = false; continue; } if (pt != null && p[0] - pt > gapT) on = false; on ? c.lineTo(X(p[0]), HY(p[1])) : c.moveTo(X(p[0]), HY(p[1])); on = true; pt = p[0]; }
    c.stroke();
  }
  c.strokeStyle = '#e9edf2'; c.lineWidth = 1.5; c.lineJoin = 'round'; c.beginPath();
  pts.power.forEach((p, i) => i && p[0] - pts.power[i - 1][0] <= gapT ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])));
  c.stroke(); c.lineWidth = 1;
  if (o.el != null && o.cw) { c.strokeStyle = css('--acc'); c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(o.el), T); c.lineTo(X(o.el), T + ph); c.stroke(); c.lineWidth = 1; c.fillStyle = css('--acc'); c.beginPath(); c.arc(X(o.el), T + 2, 3, 0, 2 * Math.PI); c.fill(); }
  o.geom = { L, R, pw, total };
  if (o.hoverT != null && o.hoverT >= 0 && o.hoverT <= total) drawHover(c, w, h, o, X, T, ph, css);
  return pts.power.length;
}

// the readout under the pointer: target there, and what was ridden there (power, HR, cadence)
export function sampleAt(smp, t) {
  let lo = 0, hi = smp.length - 1;
  if (hi < 0 || t < smp[0][1] - 1.5 || t > smp[hi][1] + 1.5) return null;
  while (lo < hi) { const m = (lo + hi) >> 1; if (smp[m][1] < t) lo = m + 1; else hi = m; }
  const x = lo > 0 && Math.abs(smp[lo - 1][1] - t) < Math.abs(smp[lo][1] - t) ? smp[lo - 1] : smp[lo];
  return Math.abs(x[1] - t) <= 1.5 ? x : null;
}
function drawHover(c, w, h, o, X, T, ph, css) {
  const t = o.hoverT, x = X(t), rows = [fmtT(t)];
  if (o.cw) {
    const at = stepAt(o.cw, t);
    if (at) rows.push(at.s.free ? 'Target free' : `Target ${stepWatts(at.s, at.into, o.ftp, o.k ?? 1)} W`);
  }
  const s = sampleAt(o.samples || [], t);
  if (s) { rows.push(`Power ${s[2]} W`); if (s[4] > 0) rows.push(`HR ${s[4]}`); if (s[3] > 0) rows.push(`Cadence ${s[3]}`); }
  c.strokeStyle = 'rgba(255,255,255,.5)'; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + ph); c.stroke(); c.setLineDash([]);
  c.font = '12px "Inter var", system-ui'; c.textAlign = 'left'; c.textBaseline = 'top';
  const bw = Math.max(...rows.map(r => c.measureText(r).width)) + 14, bh = rows.length * 16 + 8;
  const bx = x + 10 + bw > w ? x - 10 - bw : x + 10;
  c.fillStyle = 'rgba(19,22,27,.96)'; c.beginPath(); (c.roundRect ? c.roundRect(bx, T + 4, bw, bh, 6) : c.rect(bx, T + 4, bw, bh)); c.fill();
  rows.forEach((r, i) => { c.fillStyle = i ? css('--ink') || '#e9edf2' : css('--dim') || '#8b95a4'; c.fillText(r, bx + 7, T + 8 + i * 16); });
}
