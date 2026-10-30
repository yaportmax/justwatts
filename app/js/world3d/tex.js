// World 3D procedural textures, made once at start (no image files): tileable value noise for the ground, a tileable
// wave normal map for the sea (texgen.js), the window atlas for buildings and a soft cloud puff for fog banks.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { vnoise, noisePixels, wavePixels } from './texgen.js';

const dataTex = (px, size, srgb = false) => {
  const t = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
};
let cache = null;
export function textures() {
  if (cache) return cache;
  cache = { noise: dataTex(noisePixels(256), 256), waves: dataTex(wavePixels(256), 256), windows: windowAtlas(), puff: puff() };
  return cache;
}

// The window atlas: 4 x 4 cells of 128 px, each one bay of one floor. Rows 0-1: upper floors (8 styles), rows 2-3:
// ground floors (doors, shop windows). RGB: the facade (white wall, tinted by the building's colour in the shader;
// darker frames and sills), A: glass (1) for the reflection.
function windowAtlas() {
  const S = 128, c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(S * 4, S * 4) : Object.assign(document.createElement('canvas'), { width: S * 4, height: S * 4 }), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, S * 4, S * 4);
  const glass = [];  // rects drawn as glass after the facade
  const win = (ox, oy, x, y, w, h, { frame = '#3b3a38', sill = true, mull = 0, shut = null, arch = false } = {}) => {
    if (shut) { g.fillStyle = shut; g.fillRect(ox + x - w * 0.42, oy + y, w * 0.38, h); g.fillRect(ox + x + w * 1.04, oy + y, w * 0.38, h); }
    g.fillStyle = frame; g.fillRect(ox + x - 3, oy + y - 3, w + 6, h + 6);
    glass.push([ox + x, oy + y, w, h, mull, arch]);
    if (sill) { g.fillStyle = '#d8d4cc'; g.fillRect(ox + x - 6, oy + y + h + 2, w + 12, 6); }
  };
  const cell = (k, row) => [(k % 4) * S, (row + Math.floor(k / 4)) * S];
  // upper floors
  let [x, y] = cell(0, 0); win(x, y, 34, 30, 60, 62, { mull: 1 });                                  // plain sash
  [x, y] = cell(1, 0); win(x, y, 40, 26, 48, 70, { shut: '#5f7d6a', mull: 1 });                    // shutters
  [x, y] = cell(2, 0); win(x, y, 14, 34, 100, 54, { mull: 3, sill: false, frame: '#2b2d30' });    // band of glass
  [x, y] = cell(3, 0); win(x, y, 22, 28, 36, 66, {}); win(x, y, 70, 28, 36, 66, {});               // pair
  [x, y] = cell(4, 0); win(x, y, 30, 22, 68, 80, { mull: 2, sill: false, frame: '#e9e6df' });     // bay window, light trim
  [x, y] = cell(5, 0); g.fillStyle = '#e4e0d8'; g.fillRect(x, y + 104, S, 24); win(x, y, 38, 30, 52, 62, { frame: '#6b4a36' }); // wood trim, stringcourse
  [x, y] = cell(6, 0); win(x, y, 6, 8, 116, 112, { mull: 2, sill: false, frame: '#4a5058' });     // office curtain wall
  [x, y] = cell(7, 0); win(x, y, 36, 34, 56, 56, { arch: true, frame: '#7a6a58' });               // arched
  // ground floors
  [x, y] = cell(0, 2); win(x, y, 46, 30, 36, 98, { sill: false, frame: '#5a3a2a' });              // door
  [x, y] = cell(1, 2); win(x, y, 10, 30, 108, 80, { mull: 2, sill: false, frame: '#2e3a46' });    // shop window
  g.fillStyle = '#7d2e2a'; g.fillRect(x + 4, y + 8, 120, 16);                                       // awning band
  [x, y] = cell(2, 2); win(x, y, 34, 34, 60, 58, { mull: 1 });                                      // like the floors above
  [x, y] = cell(3, 2); g.fillStyle = '#8a8580'; g.fillRect(x + 12, y + 30, 104, 98);               // garage door
  for (let k = 0; k < 6; k++) { g.fillStyle = '#9b9690'; g.fillRect(x + 14, y + 36 + k * 15, 100, 8); }
  [x, y] = cell(4, 2); win(x, y, 20, 26, 88, 102, { mull: 3, sill: false, frame: '#3a3d40' });    // cafe front
  [x, y] = cell(5, 2); win(x, y, 40, 30, 48, 98, { sill: false, frame: '#2d4a3a' });              // green door
  [x, y] = cell(6, 2); win(x, y, 6, 20, 116, 108, { mull: 2, sill: false, frame: '#4a5058' });    // office lobby
  [x, y] = cell(7, 2); win(x, y, 36, 34, 56, 56, { frame: '#7a6a58' });
  const img = g.getImageData(0, 0, S * 4, S * 4), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 0;
  for (const [gx, gy, w, h, mull, arch] of glass) {
    for (let yy = gy; yy < gy + h; yy++) for (let xx = gx; xx < gx + w; xx++) {
      if (arch) { const r = w / 2, cy = gy + r; if (yy < cy && Math.hypot(xx - gx - r, yy - cy) > r) continue; }
      const o = (yy * S * 4 + xx) * 4, t = (yy - gy) / h;
      let m = false; for (let k = 1; k <= mull; k++) if (Math.abs(xx - gx - w * k / (mull + 1)) < 2) m = true;
      if (mull && Math.abs(yy - gy - h * 0.45) < 2) m = true;
      if (m) { d[o] = d[o + 1] = d[o + 2] = 70; continue; }
      d[o] = 40 + 30 * t; d[o + 1] = 52 + 30 * t; d[o + 2] = 64 + 26 * t; d[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), S * 4, S * 4, THREE.RGBAFormat);
  tex.flipY = false; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

// a soft, lumpy cloud puff (fog banks), white with alpha
function puff() {
  const S = 128, px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S - 0.5, v = y / S - 0.5, n = 0.6 * vnoise(x / 16, y / 16, 8, 3) + 0.4 * vnoise(x / 6, y / 6, 21, 4);
    const r = Math.hypot(u * 1.0, v * 1.25) * 2, edge = Math.max(0, 1 - r * (0.75 + 0.5 * n)), base = Math.min(1, (0.5 - v) * 2.2);
    const a = Math.pow(edge, 1.6) * base, o = (y * S + x) * 4;
    px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = Math.round(255 * Math.min(1, a * 1.3));
  }
  const t = new THREE.DataTexture(px, S, S, THREE.RGBAFormat); t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.flipY = true; t.needsUpdate = true; return t;
}
