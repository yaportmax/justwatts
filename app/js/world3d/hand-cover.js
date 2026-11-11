// (A53 ground: suppress a tile quad only with a complete triangle-cover certificate
// and every contributing hand chunk loaded. cx-ground: 17 pit cells to zero at q0 and q3.)
// Baked with cx-ground/cover-deps-bake.mjs; check-cover-inputs.mjs verifies its asset and geometry-function stamps.
export function createCoverage(data) {
  if (data?.version !== 2 || !Number.isInteger(data.segs) || data.segs < 1 || !Array.isArray(data.requirements)) throw new Error('Invalid hand coverage certificate');
  const segs = data.segs, tiles = new Map(), loaded = new Set(), ready = new Uint8Array(data.requirements.length);
  const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [key, t] of Object.entries(data.tiles)) {
    const bits = bytes(t.bits), raw = bytes(t.deps);
    if (bits.length !== Math.ceil(segs * segs / 8) || raw.length !== segs * segs * 2) throw new Error('Invalid hand coverage tile ' + key);
    const view = new DataView(raw.buffer), deps = new Uint16Array(segs * segs);
    for (let i = 0; i < deps.length; i++) { deps[i] = view.getUint16(i * 2, true); if (deps[i] >= ready.length) throw new Error('Invalid hand coverage dependency'); }
    tiles.set(key, { bits, deps });
  }
  return {
    mark(chunks) { for (const i of chunks) loaded.add(i); for (let i = 1; i < ready.length; i++) if (!ready[i] && data.requirements[i].every(c => loaded.has(c))) ready[i] = 1; },
    forGrid(g) {
      if (g.segs !== segs) return null;
      const t = tiles.get(g.z + '/' + g.x + '/' + g.y); if (!t) return null;
      return (i, j) => { if (i < 0 || j < 0 || i >= segs || j >= segs) return false;
        const q = j * segs + i; return !!((t.bits[q >> 3] & (1 << (q & 7))) && ready[t.deps[q]]); };
    },
    full(g, i, j) { return this.forGrid(g)?.(i, j) ?? false; },
  };
}
