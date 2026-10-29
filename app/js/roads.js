// Open world roads: OpenStreetMap ways from Overpass in small cells, a road graph, the rider's road plan (stay on
// the road; at a junction straight on or the main road; U-turn at a dead end), 10 m points along it and their
// elevation from Terrarium terrain tiles. Pure: no DOM, no network (world.js fetches). tests/test_roads.py.
import { haversine, smoothEle, STEP_M } from './course.js';

export const CELL = 0.01;   // degrees: about 1.1 x 0.9 km at 38 N
export const DEM_Z = 14;    // Terrarium zoom for grade: about 7.5 m pixels at 38 N
export const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const LOOK = 15;            // metres walked to measure a road's direction at a junction
// how main a road is (higher wins at a junction); links rank low so the default never takes a ramp
const RANK = { trunk: 7, primary: 6, secondary: 5, tertiary: 4, unclassified: 3, residential: 3, road: 2, living_street: 2, cycleway: 2,
  service: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1, path: 1, footway: 1, pedestrian: 1, bridleway: 1 };
const KIND = { cycleway: 'Bike path', path: 'Path', footway: 'Path', pedestrian: 'Path', bridleway: 'Path', service: 'Service road', living_street: 'Street', residential: 'Street' };
export const label = w => w.name || w.ref || KIND[w.hw] || 'Road';

/* ---------- cells and Overpass ---------- */
const f5 = x => +x.toFixed(5);
export const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;
export function cellBox(key) { const [i, j] = key.split('_').map(Number); return [f5(i * CELL), f5(j * CELL), f5((i + 1) * CELL), f5((j + 1) * CELL)]; }  // s, w, n, e
export function cellsAround(lat, lon, r = 1) {
  const i = Math.floor(lat / CELL), j = Math.floor(lon / CELL), out = [`${i}_${j}`];
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) if (a || b) out.push(`${i + a}_${j + b}`);
  return out;
}
// bikeable ways: roads (no motorways, private or no-bike ways, parking aisles, driveways) and paths open to bikes
export function overpassQuery(key, box = cellBox(key)) {
  const bb = box.join(',');
  return `[out:json][timeout:25];(way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road|service|cycleway)$"]`
    + `["access"!~"^(private|no)$"]["bicycle"!~"^(no|dismount|use_sidepath)$"]["motorroad"!="yes"]["area"!="yes"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"](${bb});`
    + `way["highway"~"^(path|footway|pedestrian|bridleway)$"]["bicycle"~"^(yes|designated|permissive)$"]["area"!="yes"](${bb}););out body geom qt;`;
}
// Overpass JSON -> compact ways { id, hw, name, ref, ow: 1 | -1 | 0, br: bridge or tunnel, rb: roundabout, nodes, pts },
// and for the 3D world: tn: 1 on a tunnel, ln: lanes when tagged, up: 1 when unpaved
export function parseWays(j) {
  const out = [];
  for (const e of j?.elements || []) {
    const t = e.tags || {};
    if (e.type !== 'way' || !RANK[t.highway] || !Array.isArray(e.nodes) || !Array.isArray(e.geometry) || e.nodes.length < 2 || e.nodes.length !== e.geometry.length) continue;
    if (!e.geometry.every(g => Number.isFinite(g?.lat) && Number.isFinite(g?.lon))) continue;
    const rb = t.junction === 'roundabout' || t.junction === 'circular';
    const ow = t['oneway:bicycle'] === 'no' || /^opposite/.test(t.cycleway || '') ? 0 : t.oneway === '-1' ? -1 : /^(yes|1|true)$/.test(t.oneway || '') || (rb && t.oneway !== 'no') ? 1 : 0;
    out.push({ id: e.id, hw: t.highway, name: (t.name || '').slice(0, 60), ref: (t.ref || '').slice(0, 20), ow,
      br: (t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') ? 1 : 0, rb: rb ? 1 : 0, ...(t.tunnel && t.tunnel !== 'no' ? { tn: 1 } : {}),
      ...(+t.lanes >= 1 && +t.lanes <= 8 ? { ln: Math.round(+t.lanes) } : {}), ...(/^(unpaved|gravel|fine_gravel|dirt|ground|compacted|earth|grass|sand|mud)$/.test(t.surface || '') ? { up: 1 } : {}),
      nodes: e.nodes, pts: e.geometry.map(g => [g.lat, g.lon]) });
  }
  return out;
}

/* ---------- graph ---------- */
const P = n => ({ lat: n[0], lon: n[1] });
export const dist = (a, b) => haversine(P(a), P(b));
export function bearing(a, b) {
  const y = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), x = b[0] - a[0];
  return x || y ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : 0;
}
export const turn = (inB, outB) => ((outB - inB) % 360 + 540) % 360 - 180;  // -180..180, negative: left

// nodes: id -> { lat, lon, adj: [{ to, w, f }] } (f: along the way's node order). A node is complete when its cell
// is loaded: every way through it is known, so a choice there is safe. Ways seen twice (cell edges) are added once.
// inside(lat, lon): where routes may go (the open world's edge); a way to a node outside is no option.
export class RoadGraph {
  constructor({ inside = null } = {}) { this.nodes = new Map(); this.cells = new Set(); this.ways = new Set(); this.inside = inside; }
  addCell(key, ways) {
    this.cells.add(key);
    for (const w of ways) {
      if (this.ways.has(w.id)) continue;
      this.ways.add(w.id);
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i];
        let n = this.nodes.get(id); if (!n) this.nodes.set(id, n = { id, lat: w.pts[i][0], lon: w.pts[i][1], adj: [] });
        const p = i && this.nodes.get(w.nodes[i - 1]);
        if (p && p.id !== id) { p.adj.push({ to: id, w, f: 1 }); n.adj.push({ to: p.id, w, f: 0 }); }
      }
    }
  }
  pos(id) { const n = this.nodes.get(id); return n ? [n.lat, n.lon] : null; }
  complete(id) { const n = this.nodes.get(id); return !!n && this.cells.has(cellKey(n.lat, n.lon)); }
  way(a, b) { return this.nodes.get(a)?.adj.find(e => e.to === b)?.w || null; }
  // ways leaving cur that do not go back to prev (one per neighbour), oneways the right way when there is a choice
  options(prev, cur) {
    const n = this.nodes.get(cur); if (!n) return [];
    const seen = new Set([prev]), all = [];
    for (const e of n.adj) if (!seen.has(e.to)) { seen.add(e.to); if (!this.inside || this.inside(...this.pos(e.to))) all.push(e); }
    const ok = all.filter(e => !e.w.ow || (e.w.ow === 1) === (e.f === 1));
    return ok.length ? ok : all;
  }
  // direction of the road leaving cur toward `to`, measured LOOK metres along the same way
  outBearing(cur, to) {
    let p = cur, c = to, d = 0; const a = this.pos(cur), w = this.way(cur, to);
    for (let i = 0; i < 50; i++) {
      d += dist(this.pos(p), this.pos(c)); if (d >= LOOK) break;
      const nx = this.nodes.get(c).adj.find(e => e.w === w && e.to !== p); if (!nx) break;
      p = c; c = nx.to;
    }
    return bearing(a, this.pos(c));
  }
  // nearest road to a point: { u, v, pt, w } (the road u -> v), heading: preferred direction in degrees
  snap(lat, lon, heading = null) {
    const k = Math.cos(lat * Math.PI / 180), X = p => [(p[1] - lon) * k, p[0] - lat];
    let best = null;
    for (const n of this.nodes.values()) for (const e of n.adj) {
      if (!e.f || (this.inside && !(this.inside(n.lat, n.lon) && this.inside(...this.pos(e.to))))) continue;
      const a = X([n.lat, n.lon]), b = X(this.pos(e.to)), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0.02, Math.min(0.98, -(a[0] * dx + a[1] * dy) / L)) : 0, x = a[0] + dx * t, y = a[1] + dy * t, d2 = x * x + y * y;
      if (!best || d2 < best.d2) best = { d2, a: n.id, b: e.to, w: e.w, t };
    }
    if (!best) return null;
    const A = this.pos(best.a), B = this.pos(best.b), pt = [f6(A[0] + (B[0] - A[0]) * best.t), f6(A[1] + (B[1] - A[1]) * best.t)];
    const fwd = heading == null ? best.w.ow !== -1 : Math.abs(turn(heading, bearing(A, B))) <= 90;
    return { u: fwd ? best.a : best.b, v: fwd ? best.b : best.a, pt, w: best.w, m: dist(pt, [lat, lon]) };
  }
}
const f6 = x => Math.floor(x * 1e6 + 0.5) / 1e6;

/* ---------- the road plan ---------- */
// seq: the nodes the rider rides, [{ id, d }] with d = metres from the start. seq[0] is the start point on the road
// (id: the node behind it, position pt); the rider rides toward seq[1]. The course point i is at i * STEP_M metres.
export class Plan {
  constructor(g, seq, pt) { this.g = g; this.seq = seq; this.pt = pt; }
  static at(g, s) { return new Plan(g, [{ id: s.u, d: 0 }, { id: s.v, d: dist(s.pt, g.pos(s.v)) }], s.pt); }
  pos(k) { return k ? this.g.pos(this.seq[k].id) : this.pt; }
  end() { return this.seq.at(-1).d; }
  wayAt(k) { return k > 0 ? this.g.way(this.seq[k - 1].id, this.seq[k].id) : null; }
  kAt(d) { let a = 1, b = this.seq.length - 1; while (a < b) { const m = (a + b) >> 1; if (this.seq[m].d < d) a = m + 1; else b = m; } return a; }  // first k with seq[k].d >= d
  // direction of travel arriving at seq[k], measured over the last LOOK metres
  inBearing(k) { let j = k - 1; while (j > 0 && this.seq[k].d - this.seq[j].d < LOOK) j--; return bearing(this.pos(j), this.pos(k)); }
  // the ways open at seq[k] with their turn angle, left to right
  options(k) {
    const g = this.g, cur = this.seq[k]?.id;
    if (k < 1 || k >= this.seq.length || !g.complete(cur)) return null;
    const inB = this.inBearing(k);
    return g.options(this.seq[k - 1].id, cur).map(e => ({ to: e.to, w: e.w, a: turn(inB, g.outBearing(cur, e.to)) })).sort((x, y) => x.a - y.a);
  }
  // the default way on at seq[k]: the same road, else straight on, else the main road; a dead end turns around
  next(k) {
    const o = this.options(k), prev = this.seq[k - 1].id, win = this.wayAt(k);
    if (!o.length) return prev;
    if (o.length === 1) return o[0].to;
    const r = x => RANK[x.w.hw] || 0, by = f => (x, y) => f(x) - f(y), abs = x => Math.abs(x.a);
    if (win?.rb) {  // a roundabout: leave by the exit closest to the way we came in on, else keep going round
      let j = k; while (j > 1 && this.wayAt(j)?.rb) j--;
      const inB = this.inBearing(j), exits = o.filter(x => !x.w.rb).map(x => ({ ...x, b: Math.abs(turn(inB, this.g.outBearing(this.seq[k].id, x.to))) })).sort(by(x => x.b));
      const round = o.find(x => x.w.rb);
      if (exits.length && (exits[0].b <= 60 || !round || k - j > 30)) return exits[0].to;
      if (round) return round.to;
    }
    const same = o.filter(x => abs(x) <= 100 && win && (x.w === win || (win.name && x.w.name === win.name) || (win.ref && x.w.ref === win.ref)));
    if (same.length) return same.sort(by(abs))[0].to;
    const straight = [...o].sort(by(abs))[0], main = [...o].sort((x, y) => r(y) - r(x) || abs(x) - abs(y))[0];
    return abs(straight) <= 35 && r(straight) >= Math.min(r(main), win ? RANK[win.hw] || 0 : 0) ? straight.to : main.to;
  }
  // plan on to toD metres. Returns null when done, else the cell to load first ('' when the tail node is unknown).
  extend(toD, max = 4000) {
    for (let n = 0; this.end() < toD && n < max; n++) {
      const k = this.seq.length - 1, cur = this.seq[k].id;
      if (!this.g.complete(cur)) { const p = this.g.pos(cur); return p ? cellKey(p[0], p[1]) : ''; }
      const nx = this.next(k);
      this.seq.push({ id: nx, d: this.seq[k].d + dist(this.pos(k), this.g.pos(nx)) });
    }
    return null;
  }
  // the rider picks `to` at seq[k]: drop the plan after it and go that way
  choose(k, to) { this.seq.length = k + 1; this.seq.push({ id: to, d: this.seq[k].d + dist(this.pos(k), this.g.pos(to)) }); }
  // the first junction (two or more ways on) or dead end after d metres, up to `upto`: { k, d, opts, sel } | null
  junction(d, upto) {
    for (let k = this.kAt(d + 1e-6); k < this.seq.length - 1 && this.seq[k].d <= upto; k++) {
      const o = this.options(k); if (!o) return null;
      if (o.length !== 1) return { k, d: this.seq[k].d, opts: o, sel: this.seq[k + 1].id };
    }
    return null;
  }
  // a short look down way `to` from seq[k] (for the map): the default road for about m metres
  peek(k, to, m = 150) {
    const p = new Plan(this.g, this.seq.slice(0, k + 1), this.pt);
    p.choose(k, to); p.extend(this.seq[k].d + m, 40);
    return p.seq.slice(k).map((_, i) => p.pos(k + i)).filter(Boolean);
  }
  // course points i0 .. i1 - 1 (or as far as the plan and the loaded nodes go): [{ ll, br }], br: on a bridge or in a tunnel
  points(i0, i1) {
    const out = [], seq = this.seq;
    for (let i = i0, k = this.kAt(i0 * STEP_M); i < i1; i++) {
      const x = i * STEP_M; if (x > this.end()) break;
      while (k < seq.length - 1 && seq[k].d < x) k++;
      const a = this.pos(k - 1), b = this.pos(k); if (!a || !b) break;
      const f = seq[k].d > seq[k - 1].d ? (x - seq[k - 1].d) / (seq[k].d - seq[k - 1].d) : 0;
      out.push({ ll: [f6(a[0] + (b[0] - a[0]) * f), f6(a[1] + (b[1] - a[1]) * f)], br: this.wayAt(k)?.br || 0 });
    }
    return out;
  }
  // nd for the engine: the nodes after point i0 - 1, up to the first one at or past point i1 - 1
  nd(i0, i1) {
    const out = [], lo = (i0 - 1) * STEP_M, hi = (i1 - 1) * STEP_M;
    for (let k = i0 > 0 ? this.kAt(lo + 1e-6) : 0; k < this.seq.length; k++) { out.push([Math.floor(this.seq[k].d * 100 + 0.5) / 100, this.seq[k].id]); if (this.seq[k].d >= hi) break; }
    return out;
  }
  // the plan from an engine course (a reload): nd gives the nodes, ll[0] the start point
  static fromCourse(g, c) {
    const seq = c.nd.map(([d, id]) => ({ id, d }));
    return seq.length > 1 && seq[0].d === 0 ? new Plan(g, seq, c.ll[0]) : null;
  }
}

/* ---------- elevation ---------- */
export const terrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;
// tile x, y and the pixel inside it for a position
export function tileAt(lat, lon, z = DEM_Z) {
  const n = 2 ** z, s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
  const X = (lon + 180) / 360 * n, Y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const x = Math.floor(X), y = Math.floor(Y);
  return { z, x, y, px: (X - x) * 256 - 0.5, py: (Y - y) * 256 - 0.5 };
}
// bilinear elevation from a decoded tile { w, h, data: RGBA bytes }
export function tileEle(t, px, py) {
  const cl = (v, m) => Math.max(0, Math.min(m - 1, v)), x = cl(px, t.w), y = cl(py, t.h), x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(t.w - 1, x0 + 1), y1 = Math.min(t.h - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const e = (i, j) => { const o = (j * t.w + i) * 4; return terrarium(t.data[o], t.data[o + 1], t.data[o + 2]); };
  return (e(x0, y0) * (1 - fx) + e(x1, y0) * fx) * (1 - fy) + (e(x0, y1) * (1 - fx) + e(x1, y1) * fx) * fy;
}
// bridges and tunnels: the terrain under them is the valley or the hill, so take a straight line between their ends
export function bridges(raw, br) {
  const out = raw.slice();
  for (let i = 0; i < out.length; i++) {
    if (!br[i]) continue;
    let j = i; while (j < out.length && br[j]) j++;
    const a = i > 0 ? out[i - 1] : raw[i], b = j < out.length ? raw[j] : a;
    for (let k = i; k < j; k++) out[k] = a + (b - a) * (k - i + 1) / (j - i + 1);
    i = j;
  }
  return out;
}
// smoothed elevation for points at .. raw.length - 1, the same smoothing as an imported course
export function smoothFrom(raw, at) { const s = Math.max(0, at - 6); return smoothEle(raw.slice(s)).slice(at - s); }
