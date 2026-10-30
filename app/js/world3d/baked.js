// The baked Marin world (tools/bake_world.mjs): per Web Mercator tile a gzip file app/world/<z>/<x>_<y>.bin with the
// tile's ground features (landuse, nature, water, buildings; landuse.js compact form), its power lines ([[lat, lon], ...]), guard rails (lines)
// car parks (rings) and marked crossings (points) from OpenStreetMap, and a height grid at the mesh's
// vertices (z14: 257 x 257 from USGS 3DEP lidar, about 7.5 m apart, or 129 x 129 from Terrarium; z11: 65 x 65). index.json
// lists the tiles there are (the rest is sea). rails.bin: the rails of every road the rides reach (rail.js), the roads in
// the tiles carrying theirs (rh).
// The ride engine's grade (world.js) and the 3D view read the same heights. Pure apart from fetch.
import { decode, decodeRoads } from './landuse.js';
import { unpackH } from './rail.js';

export const GRID = { 14: 128, 11: 64 };  // the coarsest grid per zoom (a tile may be finer: its size says)

// pack / unpack one tile: [u32 json length][json][pad][int16 heights in decimetres, each the change from its left
// neighbour (the first of a row: from the one above)]
export function packTile(json, hs, n) {
  const j = new TextEncoder().encode(JSON.stringify(json)), off = 4 + j.length + ((4 + j.length) & 1);
  const buf = new Uint8Array(off + n * n * 2), dv = new DataView(buf.buffer);
  dv.setUint32(0, j.length, true); buf.set(j, 4);
  const q = Array.from(hs, h => Math.max(-3000, Math.min(30000, Math.round(h * 10))));
  for (let i = 0; i < n * n; i++) dv.setInt16(off + 2 * i, q[i] - (i % n ? q[i - 1] : i >= n ? q[i - n] : 0), true);
  return buf;
}
// (n: the grid's side, by default from the size of what follows the json)
export function unpackTile(buf, n = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), jl = dv.getUint32(0, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + jl))), off = 4 + jl + ((4 + jl) & 1);
  n ||= Math.round(Math.sqrt((buf.byteLength - off) / 2));
  const hs = new Float32Array(n * n), q = new Int32Array(n * n);
  for (let i = 0; i < n * n; i++) { q[i] = dv.getInt16(off + 2 * i, true) + (i % n ? q[i - 1] : i >= n ? q[i - n] : 0); hs[i] = q[i] / 10; }
  return { json, hs, n };
}

async function gunzip(r) {
  if (typeof DecompressionStream === 'function') return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  throw new Error('no gzip');
}

// get(z, x, y) -> Promise<{ hs, n, features } | null> (null: sea or not baked), peek: the same when loaded
export function createBaked({ fetch = globalThis.fetch?.bind(globalThis), base = '/world/', unzip = gunzip, max = 200 } = {}) {
  let index = null; const tiles = new Map(), done = new Map();
  const idx = () => index ??= fetch(base + 'index.json').then(r => r.ok ? r.json() : null).then(j => j && { ...j, has: new Set(j.tiles) }).catch(() => null);
  function get(z, x, y) {
    const k = `${z}/${x}/${y}`;
    if (tiles.has(k)) { const p = tiles.get(k); tiles.delete(k); tiles.set(k, p); return p; }  // the most recent last
    while (tiles.size >= max) { const old = tiles.keys().next().value; tiles.delete(old); done.delete(old); }
    tiles.set(k, idx().then(async ix => {
      if (!ix?.has.has(k)) return null;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(`${base}${z}/${x}_${y}.bin`); if (!r.ok) return null;
          const { json, hs, n } = unpackTile(await unzip(r));
          const roads = decodeRoads(json.r || []); if (json.rh) roads.forEach((r, i) => { if (json.rh[i]) r.h = unpackH(json.rh[i]); });  // the roads' rails (rail.js)
          return { z, x, y, n, hs, features: decode(json.f || [], k + ':'), roads, places: json.p || [], power: json.w || [], rails: json.g || [], lots: json.pk || [], xings: json.x || [] };
        } catch { await new Promise(ok => setTimeout(ok, 500 * 2 ** i)); }
      }
      return null;
    }).then(t => { done.set(k, t); return t; }));
    return tiles.get(k);
  }
  // the whole area's rails (rail.js railIndex's json), once; null without them
  let rails = null;
  const railJson = () => rails ??= (async () => { for (let i = 0; i < 3; i++) { try { const r = await fetch(base + 'rails.bin'); if (!r.ok) return null; return JSON.parse(new TextDecoder().decode(await unzip(r))); } catch { await new Promise(ok => setTimeout(ok, 500 * 2 ** i)); } } return null; })();
  return {
    get, index: idx, rails: railJson,
    peek: (z, x, y) => done.get(`${z}/${x}/${y}`),   // undefined while loading, null for sea
    drop(k) { tiles.delete(k); done.delete(k); },
  };
}

// one per page: the ride engine's grade and the 3D view share the tiles
let shared = null;
export const sharedBaked = () => shared ??= createBaked();

// height inside a tile grid at fractional grid coordinates (the mesh's triangles: the diagonal from (i+1, j) to (i, j+1))
export function gridAt(hs, n, fi, fj) {
  const s = n - 1, i = Math.max(0, Math.min(s - 1, Math.floor(fi))), j = Math.max(0, Math.min(s - 1, Math.floor(fj)));
  const u = Math.max(0, Math.min(1, fi - i)), v = Math.max(0, Math.min(1, fj - j));
  const a = hs[j * n + i], b = hs[j * n + i + 1], c = hs[(j + 1) * n + i], d = hs[(j + 1) * n + i + 1];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
