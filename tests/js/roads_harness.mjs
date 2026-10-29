// Test bridge for app/js/roads.js (road graph, plan, terrain grade). stdin: JSON array of requests, stdout: results.
// Overpass answers come from recorded fixtures (tests/fixtures/overpass); nothing here touches the network.
import * as R from '../../app/js/roads.js';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const reqs = JSON.parse(Buffer.concat(chunks).toString('utf8'));

// PNG (8-bit RGB or RGBA, no interlace) -> { w, h, data: RGBA }: what the browser's canvas gives world.js
export function decodePng(buf) {
  let p = 8, w = 0, h = 0, ch = 3; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ch = d[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), bpr = w * ch, out = new Uint8Array(w * h * 4), prev = new Uint8Array(bpr), cur = new Uint8Array(bpr);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (bpr + 1)], row = raw.subarray(y * (bpr + 1) + 1, (y + 1) * (bpr + 1));
    for (let i = 0; i < bpr; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      cur[i] = (row[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < ch ? cur[x * ch + k] : 255;
    prev.set(cur);
  }
  return { w, h, data: out };
}

const graph = cells => { const g = new R.RoadGraph(); for (const [k, j] of cells) g.addCell(k, R.parseWays(j)); return g; };
const fixture = k => [k, JSON.parse(readFileSync(new URL(`../fixtures/overpass/${k}.json`, import.meta.url)))];
const names = (p, k0 = 1) => { const out = []; for (let k = k0; k < p.seq.length; k++) { const l = R.label(p.wayAt(k)); if (out.at(-1) !== l) out.push(l); } return out; };
const jx = j => j && { k: j.k, d: Math.round(j.d), sel: j.sel, opts: j.opts.map(o => ({ to: o.to, a: Math.round(o.a), name: R.label(o.w) })) };

function run(r) {
  switch (r.op) {
    case 'parse': return R.parseWays(r.json ?? fixture(r.key)[1]).map(w => ({ id: w.id, hw: w.hw, name: w.name, ow: w.ow, br: w.br, rb: w.rb, n: w.nodes.length }));
    case 'cells': return { key: R.cellKey(r.lat, r.lon), box: R.cellBox(R.cellKey(r.lat, r.lon)), around: R.cellsAround(r.lat, r.lon), q: R.overpassQuery(R.cellKey(r.lat, r.lon)) };
    // plan from a start; picks: [[at node id, to node id]] taken when that junction is reached; later: cells loaded when asked for
    case 'plan': {
      const cells = (r.cells || []).map(c => typeof c === 'string' ? fixture(c) : c), later = new Map((r.later || []).map(c => typeof c === 'string' ? fixture(c) : c));
      const g = graph(cells), s = g.snap(r.lat, r.lon, r.heading ?? null);
      if (!s) return { snap: null };
      const p = R.Plan.at(g, s), asked = [];
      for (const [at, to] of r.picks || []) {
        while (!p.seq.some(x => x.id === at) && p.extend(p.end() + 50) == null && p.end() < r.to);
        const k = p.seq.findIndex(x => x.id === at); if (k > 0) p.choose(k, to);
      }
      let b;
      while ((b = p.extend(r.to)) && later.has(b)) { asked.push(b); g.addCell(b, R.parseWays(later.get(b))); later.delete(b); }
      const pts = p.points(0, r.pts ?? 0), js = [];
      for (let x = 0, j; (j = p.junction(x, p.end())); x = j.d) js.push(jx(j));
      return { snap: { u: s.u, v: s.v, pt: s.pt, name: R.label(s.w), m: s.m }, blocked: b, asked, end: p.end(), seq: p.seq.map(x => [x.id, x.d]), names: names(p),
        junctions: js, pts, nd: p.nd(0, pts.length), peek: r.peek ? p.peek(...r.peek) : null };
    }
    // the plan rebuilt from an engine course: the same road on as the original plan
    case 'roundtrip': {
      const g = graph(r.cells.map(fixture)), p = R.Plan.at(g, g.snap(r.lat, r.lon, r.heading)); p.extend(r.cut);
      const n = Math.floor(p.end() / 10) + 1, pts = p.points(0, n), c = { ll: pts.map(x => x.ll), nd: p.nd(0, n) };
      const q = R.Plan.fromCourse(g, c); p.extend(r.to); q.extend(r.to);
      return { a: p.seq.map(x => x.id), b: q.seq.map(x => x.id), da: p.end(), db: q.end(), more: q.points(n, n + 20).length };
    }
    case 'tile': {
      const t = decodePng(readFileSync(new URL(`../fixtures/${r.file}`, import.meta.url)));
      const raw = r.pts.map(([lat, lon]) => { const a = R.tileAt(lat, lon); return R.tileEle(t, a.px, a.py); });
      const fixed = R.bridges(raw, r.br || raw.map(() => 0));
      return { at: R.tileAt(...r.pts[0]), raw, fixed, ele: R.smoothFrom(fixed, 0), tail: R.smoothFrom(fixed, r.from ?? 0) };
    }
    case 'terrarium': return r.rgb.map(([a, b, c]) => R.terrarium(a, b, c));
    case 'bridges': return R.bridges(r.raw, r.br);
    default: throw new Error('unknown op ' + r.op);
  }
}
process.stdout.write(JSON.stringify(reqs.map(run)));
