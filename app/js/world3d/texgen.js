// World 3D procedural texture pixels (pure, tested): tileable value noise for the ground, a tileable wave normal map
// for the sea. tex.js turns them into three.js textures.
import { hash2 } from './landuse.js';

// tileable value noise in 0..1 at (x, y) in lattice units, wrapping every `per` cells
export function vnoise(x, y, per, seed) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash2(((a % per) + per) % per + seed * 1013, ((b % per) + per) % per - seed * 7);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
// tileable gradient (Perlin) noise, about -0.7..0.7, wrapping every `per` cells: no square blocks like value noise
export function gnoise(x, y, per, seed) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const g = (a, b) => { const h = hash2(((a % per) + per) % per + seed * 977, ((b % per) + per) % per - seed * 13) * 6.283185; return [Math.cos(h), Math.sin(h)]; };
  const d = (a, b, dx, dy) => { const q = g(a, b); return q[0] * dx + q[1] * dy; };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n0 = d(i, j, fx, fy) * (1 - u) + d(i + 1, j, fx - 1, fy) * u, n1 = d(i, j + 1, fx, fy - 1) * (1 - u) + d(i + 1, j + 1, fx - 1, fy - 1) * u;
  return n0 * (1 - v) + n1 * v;
}
// size x size RGBA bytes: four tileable fractal noises, R finest (base 16 cells) to A coarsest (base 2 cells); no
// octave finer than 8 pixels a cell, so the texture stays smooth when magnified
export function noisePixels(size = 256) {
  const out = new Uint8Array(size * size * 4), base = [16, 8, 4, 2];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0, a = 0.5, w = 0, f = base[c];
      for (let o = 0; o < 4 && f <= size / 8; o++, f *= 2, a *= 0.55) { s += a * gnoise(x / size * f, y / size * f, f, c * 5 + o); w += a; }
      out[(y * size + x) * 4 + c] = Math.round(255 * Math.max(0, Math.min(1, s / w * 1.25 + 0.5)));
    }
  }
  return out;
}
// size x size RGBA bytes: a tileable normal map of a wind sea (waves with whole wave numbers so it wraps), normal xy in
// RG (0.5 flat), height in B
export function wavePixels(size = 256, waves = 28) {
  const W = [];
  for (let k = 0; k < waves; k++) {
    const a = (hash2(k, 1) - 0.5) * 2.6 + 0.3, f = 2 + Math.floor(hash2(k, 2) * 14);    // mostly one wind direction
    const kx = Math.round(Math.cos(a) * f), ky = Math.round(Math.sin(a) * f); if (!kx && !ky) continue;
    W.push([kx, ky, hash2(k, 3) * 6.283, 1 / Math.pow(Math.hypot(kx, ky), 1.25)]);
  }
  const out = new Uint8Array(size * size * 4), tau = 2 * Math.PI;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let h = 0, dx = 0, dy = 0;
    for (const [kx, ky, p, am] of W) { const ph = tau * (kx * x + ky * y) / size + p, c = Math.cos(ph); h += am * Math.sin(ph); dx += am * c * tau * kx / size; dy += am * c * tau * ky / size; }
    const s = 6, l = Math.hypot(dx * s, dy * s, 1), o = (y * size + x) * 4;
    out[o] = Math.round((-dx * s / l * 0.5 + 0.5) * 255); out[o + 1] = Math.round((-dy * s / l * 0.5 + 0.5) * 255);
    out[o + 2] = Math.round(Math.max(0, Math.min(1, h * 0.35 + 0.5)) * 255); out[o + 3] = 255;
  }
  return out;
}

// Mipmaps for an alpha-tested atlas of cols x rows cells (RGBA bytes, w x h). Each level halves the one above, the
// colour weighted by alpha (leaves keep their colour to the edge); then alpha is scaled per cell so the share of
// texels that pass the alpha test (cut) stays what it is at full size: leaf cards do not thin out with distance. Clear
// texels first take their cell's mean colour (no dark fringe where filtering meets an edge). -> [{ data, width, height }]
export function coverageMips(px, w, h, cols, rows, cut = 128) {
  const cw = w / cols, ch = h / rows;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    let r = 0, g = 0, b = 0, s = 0;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) { const o = (y * w + x) * 4, a = px[o + 3]; r += px[o] * a; g += px[o + 1] * a; b += px[o + 2] * a; s += a; }
    if (!s) continue;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) { const o = (y * w + x) * 4; if (!px[o + 3]) { px[o] = r / s; px[o + 1] = g / s; px[o + 2] = b / s; } }
  }
  const cover = (d, W, H, cx, cy, k) => {
    const x0 = Math.floor(cx * W / cols), x1 = Math.floor((cx + 1) * W / cols), y0 = Math.floor(cy * H / rows), y1 = Math.floor((cy + 1) * H / rows); let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (Math.min(255, d[(y * W + x) * 4 + 3] * k) >= cut) n++;
    return n / Math.max(1, (x1 - x0) * (y1 - y0));
  };
  const base = []; for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) base.push(cover(px, w, h, cx, cy, 1));
  const out = [{ data: px, width: w, height: h }];
  let src = px, W = w, H = h;
  while (W > 1 || H > 1) {
    const W2 = Math.max(1, W >> 1), H2 = Math.max(1, H >> 1), d = new Uint8Array(W2 * H2 * 4);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
      let r = 0, g = 0, b = 0, a = 0, m = [0, 0, 0];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const o = (Math.min(H - 1, y * 2 + dy) * W + Math.min(W - 1, x * 2 + dx)) * 4, q = src[o + 3];
        r += src[o] * q; g += src[o + 1] * q; b += src[o + 2] * q; a += q; m[0] += src[o]; m[1] += src[o + 1]; m[2] += src[o + 2];
      }
      const o = (y * W2 + x) * 4;
      if (a) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; } else { d[o] = m[0] / 4; d[o + 1] = m[1] / 4; d[o + 2] = m[2] / 4; }
      d[o + 3] = Math.round(a / 4);
    }
    // the next level halves this one unscaled; the copy kept is scaled per cell
    const keep = d.slice();
    if (W2 >= cols && H2 >= rows) for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      const want = base[cy * cols + cx]; if (!want) continue;
      let lo = 1, hi = 12; for (let i = 0; i < 14; i++) { const k = (lo + hi) / 2; if (cover(d, W2, H2, cx, cy, k) < want) lo = k; else hi = k; }
      if (Math.abs(cover(d, W2, H2, cx, cy, lo) - want) < Math.abs(cover(d, W2, H2, cx, cy, hi) - want)) hi = lo;  // the nearer of the two
      const x0 = Math.floor(cx * W2 / cols), x1 = Math.floor((cx + 1) * W2 / cols), y0 = Math.floor(cy * H2 / rows), y1 = Math.floor((cy + 1) * H2 / rows);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W2 + x) * 4 + 3; keep[o] = Math.min(255, Math.round(d[o] * hi)); }
    }
    out.push({ data: keep, width: W2, height: H2 });
    src = d; W = W2; H = H2;
  }
  return out;
}
// size^3 bytes: tileable 3D noise for the fog banks' billows, puffy (inverted cell noise over value noise), 0..255
export function noise3Pixels(size = 32) {
  const out = new Uint8Array(size * size * size), cells = 4, pts = [];
  const h3 = (a, b, c, s) => hash2(hash2(a * 73 + s, b * 151) * 1e6 | 0, c * 89 + s * 7);
  for (let k = 0; k < cells; k++) for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) pts.push([(i + h3(i, j, k, 1)) / cells, (j + h3(i, j, k, 2)) / cells, (k + h3(i, j, k, 3)) / cells]);
  const v3 = (x, y, z, per, s) => {  // tileable value noise
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const g = (a, b, c) => h3(((a % per) + per) % per, ((b % per) + per) % per, ((c % per) + per) % per, s);
    const l = (b, c) => g(i, b, c) * (1 - u) + g(i + 1, b, c) * u;
    return (l(j, k) * (1 - v) + l(j + 1, k) * v) * (1 - w) + (l(j, k + 1) * (1 - v) + l(j + 1, k + 1) * v) * w;
  };
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = [x / size, y / size, z / size]; let d = 9;
    for (const q of pts) { let dd = 0; for (let a = 0; a < 3; a++) { let e = Math.abs(p[a] - q[a]); e = Math.min(e, 1 - e); dd += e * e; } d = Math.min(d, dd); }
    const cell = 1 - Math.min(1, Math.sqrt(d) * cells * 0.9), val = 0.6 * v3(x / size * 6, y / size * 6, z / size * 6, 6, 1) + 0.4 * v3(x / size * 12, y / size * 12, z / size * 12, 12, 2);
    out[(z * size + y) * size + x] = Math.round(255 * Math.max(0, Math.min(1, cell * 0.6 + val * 0.55 - 0.05)));
  }
  return out;
}
