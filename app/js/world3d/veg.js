// World 3D ground cover of the Marin Headlands (tools/veg_bake.py: from USDA NAIP aerial imagery and OpenStreetMap):
// one grid over VEG's box, linear in latitude and longitude, a class per cell of about 3.3 by 3.8 m: 0 none (sea,
// water, sand, buildings, outside the Headlands), 1 grass, 2 coastal scrub, 3 cypress or pine, 4 bare earth or rock,
// 5 eucalyptus. The ground shader reads it as a texture (scrub, trees, bare, known: blended between cells), the
// scrub (scrub.js), the trees and the grass by cell. Pure apart from fetch.

export const NONE = 0, GRASS = 1, SCRUB = 2, CYPRESS = 3, BARE = 4, EUC = 5;

// buf: the file's bytes (gunzipped): [u32 header length][header JSON][pad to 2][n * n classes]
export function parseVeg(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl))), off = 4 + hl + ((4 + hl) % 2), n = head.n;
  return makeVeg(head.box, n, buf.subarray(off, off + n * n));
}
// [s, w, n, e], cells per side, the classes (rows north to south)
export function makeVeg(box, n, cls) {
  const [s, w, nn, e] = box, ky = n / (nn - s), kx = n / (e - w);
  const cell = (lat, lon) => { const j = Math.floor((nn - lat) * ky), i = Math.floor((lon - w) * kx); return i >= 0 && j >= 0 && i < n && j < n ? j * n + i : -1; };
  return {
    box, n, cls,
    // the class at a point (0 outside)
    at(lat, lon) { const k = cell(lat, lon); return k < 0 ? NONE : cls[k]; },
    // the cell's index and its centre [lat, lon] (for scattering by cell)
    cellOf: cell,
    centre: k => [nn - (Math.floor(k / n) + 0.5) / ky, w + (k % n + 0.5) / kx],
    size: [1 / ky, 1 / kx],
    // RGBA per cell for the ground shader: scrub, trees, bare earth, known (0 or 255)
    rgba() {
      const out = new Uint8Array(n * n * 4);
      for (let k = 0; k < n * n; k++) {
        const c = cls[k], o = 4 * k;
        out[o] = c === SCRUB ? 255 : 0; out[o + 1] = c === CYPRESS || c === EUC ? 255 : 0; out[o + 2] = c === BARE ? 255 : 0; out[o + 3] = c ? 255 : 0;
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
