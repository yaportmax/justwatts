// World 3D procedural texture pixels (pure, tested): tileable value noise for the ground, a tileable wave normal map
// for the sea. tex.js turns them into three.js textures.
import { hash2 } from './landuse.js';

// tileable value noise in 0..1 at (x, y) in lattice units, wrapping every `per` cells
export function vnoise(x, y, per, seed) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash2(((a % per) + per) % per + seed * 1013, ((b % per) + per) % per - seed * 7);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
// size x size RGBA bytes: four tileable fractal noises, R finest (base 16 cells) to A coarsest (base 2 cells); no
// octave finer than 8 pixels a cell, so the texture stays smooth when magnified
export function noisePixels(size = 256) {
  const out = new Uint8Array(size * size * 4), base = [16, 8, 4, 2];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0, a = 0.5, w = 0, f = base[c];
      for (let o = 0; o < 4 && f <= size / 8; o++, f *= 2, a *= 0.55) { s += a * vnoise(x / size * f, y / size * f, f, c * 5 + o); w += a; }
      out[(y * size + x) * 4 + c] = Math.round(255 * Math.max(0, Math.min(1, (s / w - 0.5) * 1.6 + 0.5)));
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

