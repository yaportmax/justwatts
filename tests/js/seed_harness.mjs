// The roads baked around the presets: every preset's cell and its neighbours (some only water) load from app/roads with no Overpass.
// stdout: JSON report for tests/test_roads.py.
import { readFileSync } from 'node:fs';
import { createRoadLoader, PRESETS } from '../../app/js/world.js';
import { cellKey, cellsAround } from '../../app/js/roads.js';

const app = new URL('../../app/', import.meta.url), asked = [];
const fetch = async u => {
  asked.push(String(u));
  if (!String(u).startsWith('/roads/')) throw new Error('no network');
  const body = readFileSync(new URL(String(u).slice(1), app));
  return { ok: true, json: async () => JSON.parse(body) };
};
const loader = createRoadLoader({ fetch, caches: null }), out = {};
for (const p of PRESETS) {
  const cells = await Promise.all(cellsAround(p.lat, p.lon).map(k => loader.get(k)));
  out[p.id] = { here: cells[0].length, around: cells.every(Array.isArray) };
}
out.asked = asked;
console.log(JSON.stringify(out));
