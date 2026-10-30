// World 3D streaming bookkeeping: which tiles should be built around the rider and at what detail, what to build
// next (nearest first), what to drop (with a margin so a rider on a tile edge does not thrash). Pure.
import { tileX, tileY, key, unkey } from './geo.js';

export const NEAR_Z = 14, FAR_Z = 11;

// tiles wanted at zoom z around a point: key -> detail (0 the finest, rings further out get higher numbers);
// rings: the Chebyshev radius of each detail, e.g. [1, 2]: the 3x3 at detail 0, the ring around it at detail 1
export function wanted(lat, lon, z, rings) {
  const X = tileX(lon, z), Y = tileY(lat, z), cx = Math.floor(X), cy = Math.floor(Y), R = rings.at(-1), out = new Map();
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const r = Math.max(Math.abs(dx), Math.abs(dy)), lod = rings.findIndex(x => r <= x);
    out.set(key(z, cx + dx, cy + dy), lod);
  }
  return out;
}
// distance in tiles from a point to a tile's centre (to build the nearest first)
export function tileDist(k, lat, lon) { const [z, x, y] = unkey(k); return Math.hypot(tileX(lon, z) - x - 0.5, tileY(lat, z) - y - 0.5); }

// have: key -> detail now built (or building); want: key -> detail wanted. keep: tiles further than the last ring by
// up to this many tiles stay. Returns { add: [[key, lod]] nearest first, change: [[key, lod]], drop: [key] }
export function plan(have, want, lat, lon, keep = 1) {
  const add = [], change = [], drop = [];
  for (const [k, lod] of want) { if (!have.has(k)) add.push([k, lod]); else if (have.get(k) !== lod) change.push([k, lod]); }
  let R = 0; for (const k of want.keys()) { const [z, x, y] = unkey(k); R = Math.max(R, Math.abs(x + 0.5 - tileX(lon, z)), Math.abs(y + 0.5 - tileY(lat, z))); }
  for (const k of have.keys()) {
    if (want.has(k)) continue;
    const [z, x, y] = unkey(k), r = Math.max(Math.abs(x + 0.5 - tileX(lon, z)), Math.abs(y + 0.5 - tileY(lat, z)));
    if (r > R + keep) drop.push(k);
  }
  const by = (a, b) => tileDist(a[0], lat, lon) - tileDist(b[0], lat, lon);
  return { add: add.sort(by), change: change.sort(by), drop };
}

// the near tiles a far tile holds (its quads under them are left out once they are built)
export function childrenOf(k, z = NEAR_Z) {
  const [fz, x, y] = unkey(k), s = 2 ** (z - fz), out = [];
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) out.push(key(z, x * s + i, y * s + j));
  return out;
}
export function parentOf(k, z = FAR_Z) { const [nz, x, y] = unkey(k), s = 2 ** (nz - z); return key(z, Math.floor(x / s), Math.floor(y / s)); }

// A time-sliced job queue: run(budget ms) runs jobs until the budget is spent; a job with the same id replaces the
// queued one (and drops one half done). Jobs are ordered by priority (lower first) when added. A job may return an
// iterator (a generator: the build yields between its slices): it then runs a slice at a time within the budget, over
// as many frames as it takes, so no build holds up a frame for long.
export function jobQueue(now = () => performance.now()) {
  let q = [];
  const slow = [];  // the last jobs that took over 6 ms in all: [id, ms in all, started at, longest slice ms] (for checks)
  return {
    add(id, pri, fn) { q = q.filter(j => j.id !== id); q.push({ id, pri, fn }); q.sort((a, b) => a.pri - b.pri); },
    drop(pred) { q = q.filter(j => !pred(j.id)); },
    run(budget) {
      const t0 = now(); let n = 0;
      while (q.length && (n === 0 || now() - t0 < budget)) {
        const j = q[0], a = now(); let done = true;
        if (!j.it) { j.at = a; j.ms = j.max = 0; const r = j.fn(); if (r && typeof r.next === 'function') { j.it = r; done = false; } }
        if (j.it) { let r; do { const b = now(); r = j.it.next(); j.max = Math.max(j.max, now() - b); } while (!r.done && now() - t0 < budget); done = !!r.done; }
        j.ms += now() - a; n++;
        if (!done) break;  // the budget is spent in the middle of it: on with it next frame
        q.shift();
        if (j.ms > 6) { slow.push([j.id, Math.round(j.ms * 10) / 10, Math.round(j.at), Math.round(j.max * 10) / 10]); if (slow.length > 200) slow.shift(); }
      }
      return n;
    },
    slow,
    get size() { return q.length; },
    has: id => q.some(j => j.id === id),
  };
}
