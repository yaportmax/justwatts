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

async function gunzip(r) { return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
// one per page: Promise<veg | null> (null: none baked, or it failed: the world goes on without it)
let shared = null;
export function loadVeg({ fetch = globalThis.fetch?.bind(globalThis), url = '/world/veg.bin' } = {}) {
  return shared ??= (async () => {
    try { const r = await fetch(url); if (!r.ok) return null; return parseVeg(await gunzip(r)); } catch { return null; }
  })();
}
