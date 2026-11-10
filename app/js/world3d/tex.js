// World 3D procedural textures, made once at start (no image files): tileable value noise for the ground, a tileable
// wave normal map for the sea (texgen.js), the window atlas for buildings, a soft cloud puff for fog banks and the
// leaf atlas the trees' cards and their bark take their pixels from.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { vnoise, noisePixels, wavePixels, coverageMips } from './texgen.js';
import { hash2 } from './landuse.js';

const dataTex = (px, size, srgb = false) => {
  const t = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
};
let cache = null;
export function textures() {
  if (cache) return cache;
  cache = { noise: dataTex(noisePixels(256), 256), waves: dataTex(wavePixels(256), 256), windows: windowAtlas(), puff: puff(), leaves: leafAtlas() };
  return cache;
}

// The window atlas: 4 x 4 cells of 128 px, each one bay of one floor. Rows 0-1: upper floors (8 styles), rows 2-3:
// ground floors (doors, shop windows). RGB: the facade (white wall, tinted by the building's colour in the shader;
// darker frames and sills), A: glass (1) for the reflection.
function windowAtlas() {
  const S = 128, c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(S * 4, S * 4) : Object.assign(document.createElement('canvas'), { width: S * 4, height: S * 4 }), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, S * 4, S * 4);
  const glass = [];  // rects drawn as glass after the facade
  const win = (ox, oy, x, y, w, h, { frame = '#3b3a38', sill = true, mull = 0, shut = null, arch = false, rail = false, fw = 3 } = {}) => {
    if (shut) { g.fillStyle = shut; g.fillRect(ox + x - w * 0.42, oy + y, w * 0.38, h); g.fillRect(ox + x + w * 1.04, oy + y, w * 0.38, h); }
    g.fillStyle = frame; g.fillRect(ox + x - fw, oy + y - fw, w + 2 * fw, h + 2 * fw);
    glass.push([ox + x, oy + y, w, h, mull || (rail ? -1 : 0), arch]);
    if (sill) { g.fillStyle = '#d8d4cc'; g.fillRect(ox + x - 6, oy + y + h + 2, w + 12, 6); }
  };
  const cell = (k, row) => [(k % 4) * S, (row + Math.floor(k / 4)) * S];
  // upper floors
  let [x, y] = cell(0, 0); win(x, y, 34, 30, 60, 62, { mull: 1 });                                  // plain sash
  [x, y] = cell(1, 0); win(x, y, 40, 26, 48, 70, { shut: '#5f7d6a', mull: 1 });                    // shutters
  [x, y] = cell(2, 0); win(x, y, 14, 34, 100, 54, { mull: 3, sill: false, frame: '#2b2d30' });    // band of glass
  [x, y] = cell(3, 0); win(x, y, 22, 28, 36, 66, {}); win(x, y, 70, 28, 36, 66, {});               // pair
  [x, y] = cell(4, 0); win(x, y, 30, 22, 68, 80, { mull: 2, sill: false, frame: '#e9e6df' });     // bay window, light trim
  // (A37: the forts' white clapboard barracks: a tall narrow two-pane sash in a broad white frame, one a bay, Street View
  // fieldroad_0b_0830, murraycircle_0a_0230; it was a wide brown-framed pane over a stringcourse, read as big blue-grey glass)
  [x, y] = cell(5, 0); win(x, y, 47, 22, 34, 72, { frame: '#f4f2ec', rail: true, fw: 6, sill: false }); g.fillStyle = '#f4f2ec'; g.fillRect(x + 38, y + 98, 52, 6);  // white sash
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
  [x, y] = cell(5, 2); win(x, y, 47, 30, 34, 72, { frame: '#f4f2ec', rail: true, fw: 6, sill: false }); g.fillStyle = '#f4f2ec'; g.fillRect(x + 38, y + 106, 52, 6);  // (A37) the same sash on the ground floor
  [x, y] = cell(6, 2); win(x, y, 6, 20, 116, 108, { mull: 2, sill: false, frame: '#4a5058' });    // office lobby
  [x, y] = cell(7, 2); win(x, y, 36, 34, 56, 56, { frame: '#7a6a58' });
  const img = g.getImageData(0, 0, S * 4, S * 4), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 0;
  for (const [gx, gy, w, h, mull, arch] of glass) {
    for (let yy = gy; yy < gy + h; yy++) for (let xx = gx; xx < gx + w; xx++) {
      if (arch) { const r = w / 2, cy = gy + r; if (yy < cy && Math.hypot(xx - gx - r, yy - cy) > r) continue; }
      const o = (yy * S * 4 + xx) * 4, t = (yy - gy) / h;
      let m = false; for (let k = 1; k <= mull; k++) if (Math.abs(xx - gx - w * k / (mull + 1)) < 2) m = true;
      if (mull > 0 && Math.abs(yy - gy - h * 0.45) < 2) m = true;
      if (mull < 0 && (Math.abs(yy - gy - h * 0.5) < 3 || Math.abs(xx - gx - w * 0.5) < 2 || Math.abs(yy - gy - h * 0.25) < 1.5 || Math.abs(yy - gy - h * 0.75) < 1.5)) { d[o] = d[o + 1] = d[o + 2] = 238; d[o + 3] = 0; continue; }  // (a sash's white meeting rail and muntins, six over six: the facade's colour)
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

// The leaf atlas: 4 x 4 cells of 256 px (LEAF names them). Leaves are near white with a little hue and light
// variation (the tree's vertex colour tints them), clear between; sprays run left to right along a card's length, a
// frond bottom to top. Bark and the plain cell are opaque. Mipmaps keep the leaves' coverage (texgen.js).
export const LEAF = { oak: 0, bay: 1, fir: 2, redwood: 3, euc: 4, pine: 5, cypress: 6, scrub: 7, fern: 8, redwood2: 9, willow: 10, bark: 12, plain: 15 };
function leafAtlas() {
  const S = 256, N = 4, c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(S * N, S * N) : Object.assign(document.createElement('canvas'), { width: S * N, height: S * N }), g = c.getContext('2d', { willReadFrequently: true });
  let seed = 1; const rnd = () => hash2(seed++, 7919);
  const tone = (l0 = 0.62, l1 = 1, h0 = 70, h1 = 105, sat = 22) => `hsl(${h0 + (h1 - h0) * rnd()}, ${sat * (0.6 + 0.6 * rnd())}%, ${100 * (l0 + (l1 - l0) * rnd())}%)`;
  const at = k => [(k % N) * S, Math.floor(k / N) * S];
  const leaf = (x, y, a, len, wid, col, tip = 0.35) => {  // a pointed leaf from its stalk at (x, y) along angle a
    g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = col; g.beginPath(); g.moveTo(0, 0);
    g.quadraticCurveTo(len * tip, -wid, len, 0); g.quadraticCurveTo(len * tip, wid, 0, 0); g.fill(); g.restore();
  };
  const stroke = (pts, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.stroke(); };
  const clip = (k, f) => { const [x, y] = at(k); g.save(); g.beginPath(); g.rect(x + 2, y + 2, S - 4, S - 4); g.clip(); g.translate(x, y); f(); g.restore(); };
  // a rounded clump of small leaves on twigs: oak, scrub, cypress
  const clump = (n, len, wid, round, twigs, tones) => {
    for (let t = 0; t < twigs; t++) { const a = -Math.PI / 2 + (rnd() - 0.5) * 2.4; stroke([[128, 250], [128 + Math.cos(a) * 60, 250 + Math.sin(a) * 60], [128 + Math.cos(a) * 110, 250 + Math.sin(a) * 120]], 2.5, '#6b5a48'); }
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 112 * (0.8 + 0.25 * Math.sin(a * 5 + 1) * Math.sin(a * 3)), x = 128 + Math.cos(a) * r, y = 132 + Math.sin(a) * r * 0.92;
      leaf(x, y, a + (rnd() - 0.5) * 1.6, len * (0.75 + 0.5 * rnd()), wid * (0.8 + 0.4 * rnd()), tones(r / 112), round);
    }
  };
  // a spray: a stem left to right, side shoots, needles on all of them (fir; redwood flat and feathery)
  const spray = (shoot, needle, gap, flat, tones) => {
    const stem = x => 128 + Math.sin(x / 70) * 6 + (x / 256) ** 2 * 18;
    stroke([[4, stem(4)], [128, stem(128)], [252, stem(252)]], 2.6, '#5e4a38');
    const needles = (x0, y0, x1, y1, L) => {
      const d = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / d, uy = (y1 - y0) / d;
      for (let s = 0; s < d; s += gap) {
        const f = 1 - 0.5 * s / d, px = x0 + ux * s, py = y0 + uy * s, col = tones(s / d);
        for (const side of [-1, 1]) { const a = Math.atan2(uy, ux) + side * (flat ? 1.25 : 0.9 + rnd() * 0.5); stroke([[px, py], [px + Math.cos(a) * L * f, py + Math.sin(a) * L * f]], flat ? 2.2 : 1.5, col); }
      }
    };
    for (let x = 12, k = 0; x < 238; x += 10 + rnd() * 5, k++) {
      const side = k % 2 ? 1 : -1, len = shoot * (1 - x / 300) * (0.75 + 0.4 * rnd()), a = side * (flat ? 0.95 : 0.8 + rnd() * 0.4);
      const x1 = x + Math.cos(a) * len, y1 = stem(x) + Math.sin(a) * len;
      stroke([[x, stem(x)], [x1, y1]], 1.4, '#5e4a38'); needles(x, stem(x), x1, y1, needle);
    }
    needles(4, stem(4), 252, stem(252), needle * 1.1);
  };
  const green = (l0, l1, h0 = 72, h1 = 110) => () => tone(l0, l1, h0, h1);
  clip(LEAF.oak, () => clump(700, 16, 7, 0.45, 6, r => tone(0.66 - r * 0.12, 1, 62, 100)));
  clip(LEAF.bay, () => {
    for (let t = 0; t < 7; t++) {
      const a = -Math.PI / 2 + (t - 3) * 0.32 + (rnd() - 0.5) * 0.2, L = 200 + rnd() * 40, x1 = 128 + Math.cos(a) * L, y1 = 252 + Math.sin(a) * L;
      stroke([[128, 252], [x1, y1]], 2.2, '#5a4a3a');
      for (let s = 30; s < L; s += 9) { const px = 128 + Math.cos(a) * s, py = 252 + Math.sin(a) * s; for (const side of [-1, 1]) leaf(px, py, a + side * (0.5 + rnd() * 0.5), 26 + rnd() * 12, 5 + rnd() * 2, tone(0.6, 0.95, 78, 108), 0.4); }
    }
  });
  clip(LEAF.fir, () => spray(66, 12, 2.2, false, green(0.55, 0.9)));
  clip(LEAF.redwood, () => spray(58, 13, 2.6, true, green(0.5, 0.85, 80, 120)));
  clip(LEAF.redwood2, () => spray(46, 15, 3, true, green(0.45, 0.8, 85, 125)));
  clip(LEAF.euc, () => {
    stroke([[4, 30], [80, 24], [170, 36], [252, 26]], 2.4, '#8a7a66');
    for (let i = 0; i < 46; i++) {
      const x = 8 + rnd() * 240, y = 28 + rnd() * 10, a = Math.PI / 2 + (rnd() - 0.5) * 0.9, L = 70 + rnd() * 90;
      g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = tone(0.62, 0.95, 120, 165, 14); g.beginPath(); g.moveTo(0, 0);
      g.quadraticCurveTo(L * 0.4, -9, L, 4 * (rnd() - 0.2)); g.quadraticCurveTo(L * 0.4, 7, 0, 0); g.fill(); g.restore();
    }
  });
  clip(LEAF.pine, () => {
    for (let t = 0; t < 7; t++) {
      const cx = 40 + rnd() * 176, cy = 50 + rnd() * 150; stroke([[128, 250], [cx, cy]], 3, '#5a4632');
      for (let i = 0; i < 70; i++) { const a = rnd() * 6.283, L = 34 + rnd() * 30; stroke([[cx, cy], [cx + Math.cos(a) * L, cy + Math.sin(a) * L * 0.9 - 6]], 1.4, tone(0.55, 0.9, 75, 105)); }
    }
  });
  clip(LEAF.cypress, () => clump(1600, 7, 4.5, 0.5, 5, r => tone(0.56 - r * 0.1, 0.92, 80, 115, 18)));
  // arroyo willow: slender twigs fanning up, narrow lance-shaped leaves along them, olive above and paler beneath
  clip(LEAF.willow, () => {
    for (let t = 0; t < 9; t++) {
      const a = -Math.PI / 2 + (t - 4) * 0.22 + (rnd() - 0.5) * 0.15, L = 170 + rnd() * 70, x1 = 128 + Math.cos(a) * L, y1 = 252 + Math.sin(a) * L;
      stroke([[128, 252], [x1, y1]], 1.8, '#6a5a40');
      for (let s = 20; s < L; s += 7) { const px = 128 + Math.cos(a) * s, py = 252 + Math.sin(a) * s; for (const side of [-1, 1]) leaf(px, py, a + side * (0.35 + rnd() * 0.35), 30 + rnd() * 16, 3 + rnd() * 1.5, tone(0.58, 0.95, 70, 100, 20), 0.45); }
    }
  });
  clip(LEAF.scrub, () => clump(1300, 10, 4.5, 0.4, 7, r => tone(0.6 - r * 0.1, 0.95, 60, 95, 18)));
  clip(LEAF.fern, () => {
    const mid = t => [128 + Math.sin(t * 2.6) * 10 * t, 252 - t * 244];
    stroke([mid(0), mid(0.3), mid(0.6), mid(1)], 2.4, '#5d6b3a');
    for (let t = 0.08; t < 0.98; t += 0.035) {
      const [x, y] = mid(t), L = 74 * Math.sin(Math.PI * Math.min(1, t * 1.25)) * (1 - t * 0.55) + 6;
      for (const side of [-1, 1]) leaf(x, y, (side > 0 ? 0 : Math.PI) - side * 0.35, L, 5.5 * (1 - t * 0.5) + 2, tone(0.6, 0.95, 80, 110), 0.3);
    }
  });
  { const [x0, y0] = at(LEAF.bark); g.fillStyle = '#d6d0c8'; g.fillRect(x0, y0, S, S);  // bark: deep vertical fibres
    for (let i = 0; i < 260; i++) { const x = x0 + rnd() * S, w = 1 + rnd() * 4, l = 120 + rnd() * 110; g.fillStyle = `rgb(${l},${l * 0.95},${l * 0.9})`; g.fillRect(x, y0, w, S); }
    for (let i = 0; i < 60; i++) { const x = x0 + rnd() * S; g.fillStyle = 'rgba(60,50,40,0.5)'; g.fillRect(x, y0 + rnd() * S * 0.5, 1.5, 40 + rnd() * 200); } }
  { const [x0, y0] = at(LEAF.plain); g.fillStyle = '#fff'; g.fillRect(x0, y0, S, S); }
  const px = new Uint8Array(g.getImageData(0, 0, S * N, S * N).data.buffer.slice(0)), mips = coverageMips(px, S * N, S * N, N, N);
  const t = new THREE.DataTexture(mips[0].data, S * N, S * N, THREE.RGBAFormat);
  t.mipmaps = mips; t.generateMipmaps = false; t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}
// the uv rect [u0, v0, u1, v1] of a leaf atlas cell (v down the image), a little inside its edges
export function leafCell(k, inset = 3) { const x = (k % 4) * 256, y = Math.floor(k / 4) * 256; return [(x + inset) / 1024, (y + inset) / 1024, (x + 256 - inset) / 1024, (y + 256 - inset) / 1024]; }

// (A37) The roadside signs' faces (handlist.js SIGNS, view.js): a 4 x 3 atlas of 256 px cells drawn on a canvas, sRGB,
// transparent outside each sign's shape. SIGN_CELL names a cell: a warning diamond's symbol (MUTCD W-series: black on
// yellow), a plate under one, a white regulatory sign, a green street-name blade (white letters, its cell's top quarter).
export const SIGN_CELL = { twoway: 0, ped: 1, slow: 2, blank: 3, p_twoway: 4, p_arrow: 5, p_ahead: 6, r_speed15: 8, r_parking: 9, b_bodsworth: 10 };
let signTex = null;
export function signAtlas() {
  if (signTex) return signTex;
  const S = 256, c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(S * 4, S * 3) : Object.assign(document.createElement('canvas'), { width: S * 4, height: S * 3 }), g = c.getContext('2d');
  const Y = '#e6b41e', K = '#161616', W = '#f2f2ee', at = k => [(k % 4) * S, Math.floor(k / 4) * S];
  const diamond = (k, draw) => { const [x, y] = at(k); g.save(); g.translate(x + S / 2, y + S / 2);
    const d = (r, f) => { g.beginPath(); g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(0, r); g.lineTo(-r, 0); g.closePath(); g.fillStyle = f; g.fill(); };
    d(126, K); d(116, Y); g.fillStyle = K; g.strokeStyle = K; draw && draw(); g.restore(); };
  const arrow = (x, y0, y1, w) => { const dir = Math.sign(y1 - y0); g.fillRect(x - w / 2, Math.min(y0, y1 - dir * 30) , w, Math.abs(y1 - y0) - 26); g.beginPath(); g.moveTo(x - 26, y1 - dir * 34); g.lineTo(x + 26, y1 - dir * 34); g.lineTo(x, y1); g.closePath(); g.fill(); };
  diamond(SIGN_CELL.twoway, () => { arrow(-26, 62, -66, 18); arrow(26, -62, 66, 18); });
  diamond(SIGN_CELL.ped, () => {  // a walking figure
    g.beginPath(); g.arc(4, -64, 15, 0, 7); g.fill(); g.lineCap = 'round'; g.lineWidth = 17;
    const L = (a, b, c2, d) => { g.beginPath(); g.moveTo(a, b); g.lineTo(c2, d); g.stroke(); };
    L(0, -40, -6, 14); L(-6, 14, -34, 66); L(-6, 14, 22, 40); L(22, 40, 18, 72); L(0, -32, -30, -2); L(0, -32, 26, -6); L(26, -6, 40, 14); });
  diamond(SIGN_CELL.slow, () => { g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('SLOW', 0, 4); });
  diamond(SIGN_CELL.blank, null);
  const plate = (k, draw, bg = Y, fg = K) => { const [x, y] = at(k); g.fillStyle = fg; g.fillRect(x + 8, y + 40, S - 16, S - 80); g.fillStyle = bg; g.fillRect(x + 16, y + 48, S - 32, S - 96); g.fillStyle = fg; g.save(); g.translate(x + S / 2, y + S / 2); draw(); g.restore(); };
  const text = (t, yy, px) => { g.font = `bold ${px}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 0, yy); };
  plate(SIGN_CELL.p_twoway, () => { text('TWO WAY', -30, 50); text('TRAFFIC', 32, 50); });
  plate(SIGN_CELL.p_arrow, () => { g.rotate(Math.PI * 0.75); arrow(0, -60, 64, 22); });
  plate(SIGN_CELL.p_ahead, () => text('AHEAD', 0, 60));
  { const reg = (k, draw) => { const [x, y] = at(k); g.fillStyle = K; g.fillRect(x + 40, y + 8, S - 80, S - 16); g.fillStyle = W; g.fillRect(x + 48, y + 16, S - 96, S - 32); g.fillStyle = K; g.save(); g.translate(x + S / 2, y + S / 2); draw(); g.restore(); };
    reg(SIGN_CELL.r_speed15, () => { text('SPEED', -78, 34); text('LIMIT', -40, 34); text('15', 40, 104); });
    reg(SIGN_CELL.r_parking, () => { text('NO', -60, 36); text('PARKING', -20, 30); g.fillRect(-60, 24, 120, 8); g.fillRect(-60, 50, 90, 8); g.fillRect(-60, 76, 110, 8); }); }
  { const [x, y] = at(SIGN_CELL.b_bodsworth); g.fillStyle = '#1f6b45'; g.fillRect(x, y, S, 64); g.strokeStyle = W; g.lineWidth = 4; g.strokeRect(x + 4, y + 4, S - 8, 56); g.fillStyle = W; g.font = 'bold 36px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Bodsworth Rd', x + S / 2, y + 33); }
  signTex = new THREE.CanvasTexture(c); signTex.colorSpace = THREE.SRGBColorSpace; signTex.anisotropy = 8; signTex.generateMipmaps = true; signTex.minFilter = THREE.LinearMipmapLinearFilter;
  return signTex;
}
