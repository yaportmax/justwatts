// World 3D ground cover of the Marin Headlands (tools/veg_bake.py: from USDA NAIP aerial imagery and OpenStreetMap):
// one grid over VEG's box, linear in latitude and longitude, a class per cell of about 3.3 by 3.8 m: 0 none (sea,
// water, sand, buildings, outside the Headlands), 1 grass, 2 coastal scrub, 3 cypress or pine, 4 bare earth or rock,
// 5 eucalyptus, 6 paving or gravel by a road; 128 over a tree's class: its crown stands over mown lawn (a traced lawn,
// Street View: Fort Baker's), the ground grass under it. The ground shader reads it as a texture (scrub, trees, bare, known:
// blended between cells; paving as all three), the scrub (scrub.js), the trees and the grass by cell. Pure apart from
// fetch.

export const NONE = 0, GRASS = 1, SCRUB = 2, CYPRESS = 3, BARE = 4, EUC = 5, PAVED = 6;

// buf: the file's bytes (gunzipped): [u32 header length][header JSON][pad to 2][n * n classes]
export function parseVeg(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl))), off = 4 + hl + ((4 + hl) % 2), n = head.n;
  // (pads: the paving Street View shows and OpenStreetMap lacks, traced on NAIP: [[surface, [[lat, lon], ...]], ...], surface
  // 0 asphalt, 3 gravel, 4 dirt (the road shader's); drawn as car parks are)
  // (scrubh: the scrub's height plane at half the grid's resolution after the classes (veg_patch.py, the USGS 3DEP lidar):
  // 0 none (grass between the bushes), 1..30 decimetres, 31 over 3 m, 255 a tree's crown over it (no scrub))
  const H = head.scrubh || 0, sh = H ? buf.subarray(off + n * n, off + n * n + H * H) : null;
  return { ...makeVeg(head.box, n, buf.subarray(off, off + n * n), sh, H), pads: head.pads || [] };
}
// [s, w, n, e], cells per side, the classes (rows north to south); sh, H: the scrub's height plane and its cells a side
export function makeVeg(box, n, cls, sh = null, H = 0) {
  const [s, w, nn, e] = box, ky = n / (nn - s), kx = n / (e - w);
  const cell = (lat, lon) => { const j = Math.floor((nn - lat) * ky), i = Math.floor((lon - w) * kx); return i >= 0 && j >= 0 && i < n && j < n ? j * n + i : -1; };
  return {
    box, n, cls,
    // the class at a point (0 outside)
    at(lat, lon) { const k = cell(lat, lon); return k < 0 ? NONE : cls[k] & 127; },
    // the scrub's height there from the lidar (metres; 0: none, grass; -1: under a tree's crown; null: no plane baked)
    scrubH(lat, lon) {
      if (!sh) return null;
      const fj = (nn - lat) * ky / 2 - 0.5, fi = (lon - w) * kx / 2 - 0.5, j = Math.round(fj), i = Math.round(fi); if (i < 0 || j < 0 || i >= H || j >= H) return 0;
      if (sh[j * H + i] === 255) return -1;
      // (eased between the cells' centres: no step in the bushes' height at a cell's edge)
      const at = (a, b) => { a = Math.max(0, Math.min(H - 1, a)); b = Math.max(0, Math.min(H - 1, b)); const v = sh[a * H + b]; return v === 255 ? 3.1 : v / 10; };
      const j0 = Math.floor(fj), i0 = Math.floor(fi), u = fi - i0, t = fj - j0;
      return (at(j0, i0) * (1 - u) + at(j0, i0 + 1) * u) * (1 - t) + (at(j0 + 1, i0) * (1 - u) + at(j0 + 1, i0 + 1) * u) * t;
    },
    // class k painted over every grass, scrub or bare cell within w / 2 metres of a line [[lat, lon], ...] (the hand list's
    // exposed cuts, handlist.js CUTS: bare earth NAIP's colours miss; a grove's trees and paving kept)
    paint(pts, w, k) {
      const my = 111195, mx = 111195 * Math.cos((s + nn) / 2 * Math.PI / 180), r = w / 2;
      for (let a = 1; a < pts.length; a++) {
        const [la0, lo0] = pts[a - 1], [la1, lo1] = pts[a], L = Math.hypot((la1 - la0) * my, (lo1 - lo0) * mx), m = Math.max(1, Math.ceil(L));
        for (let q = 0; q <= m; q++) {
          const la = la0 + (la1 - la0) * q / m, lo = lo0 + (lo1 - lo0) * q / m;
          for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) { if (dx * dx + dy * dy > r * r) continue; const c = cell(la + dy / my, lo + dx / mx); if (c >= 0 && [GRASS, SCRUB, BARE].includes(cls[c] & 127)) cls[c] = k; }
        }
      }
    },
    // the cell's index and its centre [lat, lon] (for scattering by cell)
    cellOf: cell,
    centre: k => [nn - (Math.floor(k / n) + 0.5) / ky, w + (k % n + 0.5) / kx],
    size: [1 / ky, 1 / kx],
    // RGBA per cell for the ground shader: scrub, trees, bare earth, known (0 or 255); paving all three (no cell has
    // more than one of them, so only paving, or a blend with it, has all three)
    rgba() {
      const out = new Uint8Array(n * n * 4);
      for (let k = 0; k < n * n; k++) {
        const c = cls[k] & 127, o = 4 * k, lawn = cls[k] & 128;
        out[o] = c === SCRUB || c === PAVED ? 255 : 0; out[o + 1] = (c === CYPRESS || c === EUC) && !lawn || c === PAVED ? 255 : 0; out[o + 2] = c === BARE || c === PAVED ? 255 : 0; out[o + 3] = c ? 255 : 0;
      }
      return out;
    },
  };
}

// The Headlands' trees one by one (tools/veg_trees.py, app/world/trees.bin): where each stands, its height and crown
// radius from the USGS 3DEP lidar's canopy height model (2018 QL1), its species from the Marin County fine scale
// vegetation map (2018). buf (gunzipped): [u32 header length][header JSON][pad to 4][n records of 8 bytes: u16 x, u16 y
// (0..65535 across the box west to east, north to south), u8 height (quarter metres), u8 crown radius (decimetres),
// u8 species (header.species), u8 0][cov * cov bytes: 1 where the lidar and the map cover the cell, rows north down].
export function parseTrees(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl))), n = head.n, C = head.cov;
  let off = 4 + hl; off += (4 - off % 4) % 4;
  const [s, w, nn, e] = head.box, B = 128, lat = new Float64Array(n), lon = new Float64Array(n), h = new Float32Array(n), r = new Float32Array(n), sp = new Uint8Array(n);
  const cov = buf.slice(off + 8 * n, off + 8 * n + C * C), bucket = new Int32Array(n), start = new Int32Array(B * B + 1);
  for (let i = 0; i < n; i++) {
    const o = off + 8 * i, x = dv.getUint16(o, true) / 65535, y = dv.getUint16(o + 2, true) / 65535;
    lat[i] = nn - y * (nn - s); lon[i] = w + x * (e - w); h[i] = buf[o + 4] / 4; r[i] = buf[o + 5] / 10; sp[i] = buf[o + 6];
    bucket[i] = Math.min(B - 1, Math.floor(y * B)) * B + Math.min(B - 1, Math.floor(x * B)); start[bucket[i] + 1]++;
  }
  for (let k = 0; k < B * B; k++) start[k + 1] += start[k];
  const order = new Int32Array(n), fill = start.slice(0, B * B); for (let i = 0; i < n; i++) order[fill[bucket[i]]++] = i;
  return {
    box: head.box, n, species: head.species,
    // the lidar and the map cover the point (there the app draws these trees, not the imagery's groves)
    covered(la, lo) { const j = Math.floor((nn - la) / (nn - s) * C), i = Math.floor((lo - w) / (e - w) * C); return i >= 0 && j >= 0 && i < C && j < C && cov[j * C + i] === 1; },
    // fn(lat, lon, height m, crown radius m, species name) for each tree in [la0, la1] x [lo0, lo1]
    each(la0, lo0, la1, lo1, fn) {
      const j0 = Math.max(0, Math.floor((nn - la1) / (nn - s) * B)), j1 = Math.min(B - 1, Math.floor((nn - la0) / (nn - s) * B));
      const i0 = Math.max(0, Math.floor((lo0 - w) / (e - w) * B)), i1 = Math.min(B - 1, Math.floor((lo1 - w) / (e - w) * B));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (let k = start[j * B + i]; k < start[j * B + i + 1]; k++) {
        const t = order[k]; if (lat[t] >= la0 && lat[t] <= la1 && lon[t] >= lo0 && lon[t] <= lo1) fn(lat[t], lon[t], h[t], r[t], head.species[sp[t]]);
      }
    },
  };
}
// A lidar tree's model scaled to it: dim the model's { H: top, R: crown radius, base: its lowest leaves' height } at scale
// 1; h, r the lidar's height and crown radius; gap how far the trunk stands from the nearest road's paved edge (null:
// no road near). -> { s: the width scale, hf: height over width scale } or null (none: a trunk within a metre of the
// paving). The crown keeps the lidar's height; its width the lidar's within the model's own shape squeezed to 1.6 times
// as tall (a lidar crown split between close tops is narrower than the tree) or spread to 0.6 times (crowns merged in a
// grove read wider than one tree), and over a road only where its lowest leaves clear 4.5 m (a truck's height, the
// road's clearance); a lower crown ends at the road's edge.
export const CLEAR = 4.5;
export function fitTree(dim, h, r, gap = null) {
  const sy = h / dim.H; let sx = Math.min(sy / 0.6, Math.max(r / dim.R, sy / 1.6));
  if (gap != null) {
    if (gap < 1) return null;
    if (sx * dim.R > gap && dim.base * sy < CLEAR) { sx = (gap - 0.2) / dim.R; if (sx < sy / 2.5) return null; }  // (thinner: a pole)
  }
  return { s: sx, hf: sy / sx };
}

async function gunzip(r) { return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
// one per page: Promise<veg | null> (null: none baked, or it failed: the world goes on without it)
let shared = null;
export function loadVeg({ fetch = globalThis.fetch?.bind(globalThis), url = '/world/veg.bin' } = {}) {
  return shared ??= (async () => {
    try { const r = await fetch(url); if (!r.ok) return null; return parseVeg(await gunzip(r)); } catch { return null; }
  })();
}
let sharedTrees = null;
export function loadTrees({ fetch = globalThis.fetch?.bind(globalThis), url = '/world/trees.bin' } = {}) {
  return sharedTrees ??= (async () => {
    try { const r = await fetch(url); if (!r.ok) return null; return parseTrees(await gunzip(r)); } catch { return null; }
  })();
}
