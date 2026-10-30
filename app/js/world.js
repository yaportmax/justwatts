// Open world: the page is the road provider. It loads OpenStreetMap roads around the rider (Overpass, small cells,
// one request at a time, cached), plans the road ahead (roads.js), samples its grade from terrain tiles and sends
// it to the engine (control 'road'), which only follows a growing course. A reload or a server restart rebuilds
// the plan from the engine's course. Junction choices: choose(), or key() with the arrow keys. uturn() rides back the
// way the rider came, teleport() jumps to another spot (a jump in the course, see course.js jp): both replace the road
// ahead from a point just ahead of the rider (pivot); the ride goes on.
import { RoadGraph, Plan, OVERPASS, overpassQuery, parseWays, cellKey, cellBox, cellsAround, tileAt, tileEle, bridges, smoothFrom, label } from './roads.js';
import { STEP_M } from './course.js';
import { onDeck } from './ggb.js';
import { gridAt, sharedBaked } from './world3d/baked.js';

export const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// The open world is the Marin Headlands for now (one small area at a time, each dialled in against Street View before
// the next opens): the Golden Gate Bridge from its south end, Vista Point, Conzelman, Field, Bunker (the Baker-Barry
// tunnel), Mitchell, McCullough and Alexander, Fort Baker. Routes never leave BOUNDS (a way out is no option: the
// default turns away or turns around); the land beyond stays as scenery.
export const BOUNDS = [[37.806, -122.545, 37.848, -122.465]];
export const inWorld = (lat, lon) => BOUNDS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
export const PRESETS = [
  { id: 'ggb', name: 'Golden Gate Bridge', lat: 37.83234, lon: -122.48061, heading: 160 },
  { id: 'conzelman', name: 'Conzelman Road', lat: 37.83300, lon: -122.48341, heading: 190 },
  { id: 'hawk', name: 'Hawk Hill', lat: 37.82625, lon: -122.49900, heading: 250 },
  { id: 'rodeo', name: 'Rodeo Beach', lat: 37.83406, lon: -122.53338, heading: 122 },
  { id: 'fortbaker', name: 'Fort Baker', lat: 37.83658, lon: -122.47779, heading: 330 },
];
// roads baked into the app (tools/bake_roads.mjs) in blocks of 5 x 5 cells, app/roads/<id>/<i>_<j>.json: the open
// world never waits on Overpass
export const SEEDS = [
  { id: 'marin', box: [37.79, -122.56, 37.86, -122.45], block: 5 },  // the Headlands (BOUNDS) and a cell or two round them
];
export const seedOf = key => {
  const [cs, cw, cn, ce] = cellBox(key);
  return SEEDS.find(({ box: [s, w, n, e] }) => cs >= s - 1e-9 && cw >= w - 1e-9 && cn <= n + 1e-9 && ce <= e + 1e-9) || null;
};
export const blockOf = (seed, key) => { const [i, j] = key.split('_').map(Number); return `${Math.floor(i / seed.block)}_${Math.floor(j / seed.block)}`; };
const AHEAD = 2500, PROMPT = 200, BATCH = 30, CACHE = 'jw-roads-1';
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

// Overpass cells: memory, then the browser cache, then the network: one worker per mirror, one request at a time each
// with a polite gap, a mirror that fails backs off (2x .. 32x the gap) while the other carries on; a cell another
// mirror has not answered in HEDGE ms is asked of an idle one too; a cell is retried until it loads.
// get(key) resolves to the ways.
export function createRoadLoader({ fetch = globalThis.fetch, caches = globalThis.caches, gap = 1100, now = () => Date.now(), base = '/roads/' } = {}) {
  const mem = new Map(), wait = new Map(), queue = [], busy = new Map(), working = new Set(), HEDGE = 10000;  // busy: key -> asked at
  const fails = OVERPASS.map(() => 0), last = OVERPASS.map(() => -1e9);
  const url = key => `https://roads.justwatts.invalid/${CACHE}/${key}`;
  async function fromCache(key) {
    try { const r = await (await caches?.open(CACHE))?.match(url(key)); const j = r && await r.json(); return Array.isArray(j?.ways) ? j.ways : null; } catch { return null; }
  }
  async function toCache(key, ways) { try { await (await caches?.open(CACHE))?.put(url(key), new Response(JSON.stringify({ ways }), { headers: { 'Content-Type': 'application/json' } })); } catch {} }
  const seeds = new Map();  // file -> Promise<{ cells, byId } | null>
  function fromSeed(key) {
    const seed = seedOf(key);
    if (!seed) return Promise.resolve(null);
    const file = `${seed.id}/${blockOf(seed, key)}.json`;
    if (!seeds.has(file)) seeds.set(file, (async () => {
      try {
        const r = await fetch(base + file); if (!r.ok) return null;
        const j = await r.json(); if (!j?.cells || !Array.isArray(j.ways)) return null;
        return { cells: j.cells, byId: new Map(j.ways.map(w => [w.id, w])) };
      } catch { return null; }
    })());
    return seeds.get(file).then(d => { const ids = d?.cells[key]; return Array.isArray(ids) ? ids.map(id => d.byId.get(id)).filter(Boolean) : d ? [] : null; });
  }
  function done(key, ways) {
    mem.set(key, ways); const i = queue.indexOf(key); if (i >= 0) queue.splice(i, 1);
    for (const f of wait.get(key) || []) f(ways); wait.delete(key);
  }
  async function fetchCell(key, w) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 30000);
    try {
      const r = await fetch(OVERPASS[w], { method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(key)), signal: ac.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('overpass ' + r.status);
      return parseWays(await r.json());
    } finally { clearTimeout(to); }
  }
  async function worker(w) {
    if (working.has(w)) return; working.add(w);
    try {
      const free = k => !mem.has(k) && !(now() - (busy.get(k) ?? -1e9) < HEDGE);
      for (let key; (key = queue.find(free));) {
        const dt = last[w] + gap * Math.min(32, 2 ** fails[w]) - now(); if (dt > 0) await sleep(dt);
        if (!free(key)) continue;
        busy.set(key, now()); last[w] = now(); setTimeout(run, HEDGE + 100);
        try { const ways = await fetchCell(key, w); fails[w] = 0; if (!mem.has(key)) { toCache(key, ways); done(key, ways); } }
        catch { fails[w]++; busy.delete(key); run(); }  // a failed cell goes to an idle mirror
        finally { busy.delete(key); }
      }
    } finally { working.delete(w); }
  }
  function run() { OVERPASS.forEach((_, w) => worker(w)); }
  // urgent: ahead of the queue
  function get(key, urgent = true) {
    if (mem.has(key)) return Promise.resolve(mem.get(key));
    return new Promise(ok => {
      if (!wait.has(key)) {
        wait.set(key, []);
        fromCache(key).then(ways => ways || fromSeed(key)).then(ways => {
          if (ways) return done(key, ways);
          if (!queue.includes(key)) urgent ? queue.unshift(key) : queue.push(key);
          run();
        });
      } else if (urgent) { const i = queue.indexOf(key); if (i > 0) { queue.splice(i, 1); queue.unshift(key); } }
      wait.get(key).push(ok);
    });
  }
  return { get, has: key => mem.has(key), clear: () => { queue.length = 0; wait.clear(); } };
}

// Terrarium tiles for grade: decoded once, kept for a while; a tile that will not load gives null (flat there).
// Inside the baked world the 3D view's own heights (world3d/baked.js), so the road and the ground agree.
export function createTerrain({ fetch = globalThis.fetch, decode = decodePng, max = 64, baked = null } = {}) {
  const tiles = new Map();
  async function load(z, x, y) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        if (r.ok) return await decode(await r.blob());
      } catch {}
      await sleep(500 * 2 ** i);
    }
    return null;
  }
  function tile(z, x, y) {
    const k = `${z}/${x}/${y}`;
    let t = tiles.get(k);
    if (!t) { if (tiles.size >= max) tiles.delete(tiles.keys().next().value); tiles.set(k, t = load(z, x, y)); }
    return t;
  }
  // elevation at each [lat, lon], null where no tile
  async function ele(lls) {
    const at = lls.map(([lat, lon]) => tileAt(lat, lon)), out = [];
    for (let i = 0; i < at.length; i++) {
      const a = at[i];
      if (baked && inWorld(...lls[i])) {
        const t = await baked.get(a.z, a.x, a.y), s = t ? t.n - 1 : 0;
        out.push(t ? gridAt(t.hs, t.n, (a.px + 0.5) / 256 * s, (a.py + 0.5) / 256 * s) : null);
        continue;
      }
      const t = await tile(a.z, a.x, a.y); out.push(t ? tileEle(t, a.px, a.py) : null);
    }
    return out;
  }
  return { ele };
}
async function decodePng(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, data: c.getImageData(0, 0, bmp.width, bmp.height).data };
}

// control(action, body) -> Promise (the engine), course() -> Promise<{ course, d }> (GET /api/ride/course)
export function createWorld({ control, course, loader = createRoadLoader(), terrain = createTerrain({ baked: sharedBaked() }), onChange = () => {}, inside = inWorld }) {
  const g = new RoadGraph({ inside });
  // ll, ele: the engine's course as sent; raw, br: terrain height and bridge/tunnel flag per point; dirty: first point a
  // junction choice changed; prov: first point of a bridge or tunnel still running at the end of what was sent (sent
  // flat for now, sent again once its far end is known)
  // jumps: the course's teleports (point indices, the engine's jp); pv: a U-turn or teleport on its way (no other sends)
  let plan = null, ll = [], ele = [], raw = [], br = [], n = 0, d = 0, v = 0, rid = null, dirty = Infinity, prov = Infinity, pumping = false, syncing = false, gen = 0, jx = null, jumps = [], pv = false;
  const reset = () => { plan = null; ll = []; ele = []; raw = []; br = []; n = 0; d = 0; dirty = prov = Infinity; jx = null; jumps = []; gen++; };
  async function cell(key) { if (!key || g.cells.has(key)) return; const ways = await loader.get(key); g.addCell(key, ways); }
  // cells within m metres of a point
  function near(lat, lon, m) {
    const dl = m / 111195, dk = dl / Math.cos(lat * Math.PI / 180), out = new Set();
    for (const a of [-dl, 0, dl]) for (const b of [-dk, 0, dk]) out.add(cellKey(lat + a, lon + b));
    return [...out];
  }
  const planned = at => plan.points(at, Math.floor(plan.end() / STEP_M) + 1);
  // on the Golden Gate Bridge the deck's own heights (ggb.js: what the 3D world draws), elsewhere the terrain
  async function elevation(pts, at) {
    const e = await terrain.ele(pts.map(p => p.ll)), R = raw.slice(0, at), B = br.slice(0, at);
    for (let i = 0; i < pts.length; i++) {
      const dk = /^Golden Gate Bridge/.test(pts[i].nm || '') ? onDeck(...pts[i].ll) : null;
      if (dk) { R.push(dk.h); B.push(0); } else { R.push(e[i] ?? (R.length ? R.at(-1) : 0)); B.push(pts[i].br); }
    }
    return [R, B];
  }
  // smoothed heights from point at on; a bridge already partly sent goes on in a straight line from the last point kept;
  // nothing is smoothed or bridged across a teleport (J)
  function heights(R, B, at, J = jumps) {
    const j = J.reduce((m, x) => x <= at ? x : m, 0); R = R.slice(j); B = B.slice(j); at -= j;
    if (at > 0 && B[at - 1]) { R[at - 1] = ele[j + at - 1]; B[at - 1] = 0; }
    return smoothFrom(bridges(R, B), at);
  }
  const tailSpan = B => { let i = B.length; while (i > 0 && B[i - 1]) i--; return i < B.length ? i : Infinity; };

  // start an open-world ride at a point: roads around it, the road nearest to it, the first stretch of road
  async function start({ name, lat, lon, heading = null, workout = null }) {
    reset(); loader.clear?.(); const my = gen;
    await Promise.all(near(lat, lon, 150).map(cell));
    const s = g.snap(lat, lon, heading);
    if (!s || s.m > 300) throw new Error('No road near here');
    // the first 600 m; the rest loads while the rider rides
    plan = Plan.at(g, s);
    for (let i = 0; i < 20; i++) { const k = plan.extend(600); if (!k) break; await cell(k); }
    if (my !== gen) return false;
    const pts = planned(0);
    if (pts.length < 11) throw new Error('No road near here');
    const [R, B] = await elevation(pts, 0);
    if (my !== gen) return false;
    const body = { name: name || 'Open world', open: true, ele: heights(R, B, 0), ll: pts.map(x => x.ll), nd: plan.nd(0, pts.length) };
    await control('load', { workout, course: body });
    raw = R; br = B; ele = body.ele; ll = body.ll; n = ll.length; prov = tailSpan(B);
    return true;
  }
  // the engine's course, after a reload, a restart or a refused road update
  async function sync() {
    if (syncing) return; syncing = true; const my = ++gen;
    try {
      const r = await course(), c = r?.course;
      if (my !== gen || !c?.open) return;
      ll = c.ll; ele = c.ele; raw = c.ele.slice(); br = c.ele.map(() => 0); n = ll.length; d = r.d; dirty = prov = Infinity; jumps = c.jp || [];
      const here = ll[Math.min(n - 1, Math.floor(d / STEP_M))], tail = ll[n - 1];
      await Promise.all([...near(here[0], here[1], 300), ...near(tail[0], tail[1], 300)].map(cell));
      if (my === gen) plan = Plan.fromCourse(g, c);
    } catch {} finally { syncing = false; onChange(); }
    pump();
  }
  async function send() {
    if (pv) return false;
    const lo = Math.min(n, Math.floor(d / STEP_M) + 2), at = Math.max(lo, (jumps.at(-1) ?? 0) + 1, Math.min(n, dirty, prov, n - 8));  // a teleport is never resent
    const pts = planned(at), N = at + pts.length;
    if (dirty === Infinity && (N - n < BATCH && n * STEP_M - d > 1000 || N <= n)) return false;
    dirty = Infinity;
    const my = gen, nd = plan.nd(at, N), [R, B] = await elevation(pts, at);
    if (my !== gen) return false;
    const e = heights(R, B, at), L = pts.map(p => p.ll);
    try { await control('road', { at, ele: e, ll: L, nd }); }
    catch { gen++; plan = null; sync(); return false; }  // refused (a choice too late): the engine's road is the truth
    if (my !== gen) return false;
    raw = R; br = B; ele = ele.slice(0, at).concat(e); ll = ll.slice(0, at).concat(L); n = ll.length; prov = tailSpan(B);
    onChange(); return true;
  }
  // keep the road ahead loaded and sent; one loop at a time
  async function pump() {
    if (pumping || !plan || pv) return; pumping = true;
    try {
      for (let i = 0; plan && i < 200; i++) {
        // the cells around the rider (the ways at a junction) and around the end of the road sent, ahead of need
        for (const p of [ll[Math.min(n - 1, Math.floor(d / STEP_M))], ll[n - 1]]) if (p) for (const k of cellsAround(p[0], p[1])) if (!g.cells.has(k)) loader.get(k, false).then(w => g.addCell(k, w));
        if (await send()) continue;
        if (!plan) break;
        const k = plan.extend(d + AHEAD);
        if (k == null) { if (dirty === Infinity && !(await send())) break; continue; }
        if (!k) break;  // the plan's end is a node not loaded yet and not known (sync loads around the tail)
        await Promise.race([cell(k), sleep(2000)]);
      }
    } finally { pumping = false; }
  }
  // the junction ahead the rider can still change (about PROMPT metres before it, until it is too close)
  function junction() {
    if (!plan || n < 2) return null;
    const lock = Math.max(20, v * 2.5), j = plan.junction(d + lock, d + PROMPT);
    return j && j.d < (n - 1) * STEP_M ? j : null;
  }

  // U-turn and teleport: the road of plan p from point at on (jump: point at is a teleport away from at - 1)
  async function pivot(at, p, jump = false) {
    if (!p) return false;
    pv = true; const my = ++gen; plan = p; jx = null; dirty = Infinity;
    try {
      for (let i = 0; i < 20; i++) { const k = p.extend(at * STEP_M + 600); if (!k) break; await cell(k); }
      const pts = my === gen ? planned(at) : [];
      if (pts.length < 2) throw new Error('No road here');
      const J = jumps.filter(x => x < at).concat(jump ? [at] : []), [R, B] = await elevation(pts, at);
      if (my !== gen) return false;
      const N = at + pts.length, hi = (N - 1) * STEP_M, nd = [], L = pts.map(x => x.ll), e = heights(R, B, at, J);
      for (const q of p.seq) { nd.push([Math.floor(q.d * 100 + 0.5) / 100, q.id]); if (q.d >= hi) break; }  // from its first node: a reload rebuilds this plan
      await control('road', { at, ele: e, ll: L, nd, ...(jump ? { jump: true } : {}) });
      // the engine has it; a sync started meanwhile (the state saw the new road first) takes it from there
      if (my === gen) { raw = R; br = B; ele = ele.slice(0, at).concat(e); ll = ll.slice(0, at).concat(L); n = ll.length; prov = tailSpan(B); jumps = J; }
      return true;
    } catch { if (my === gen) { gen++; plan = null; } return false; }
    finally { pv = false; if (!plan) sync(); else { jx = junction(); onChange(); pump(); } }
  }
  // the first point a pivot may change: far enough ahead that the engine has not passed it when the road arrives
  const pivotAt = () => Math.min(n, Math.floor((d + Math.max(20, v * 4)) / STEP_M) + 2);
  // turn round where the rider is (a few metres on) and ride back the way they came
  async function uturn() {
    if (!plan || !rid || pv || n < 2) return false;
    const at = pivotAt(), D = (at - 1) * STEP_M, k = plan.kAt(D), a = plan.seq[k - 1], b = plan.seq[k];
    if (!a || !b || b.d < D) return false;
    return pivot(at, Plan.pivot(g, b.id, a.id, ll[at - 1], D));
  }
  // jump to the road nearest to a point; the ride goes on there (same distance, time and samples)
  async function teleport({ lat, lon, heading = null }) {
    if (!rid || pv || n < 2) return false;
    await Promise.all(near(lat, lon, 150).map(cell));
    const s = g.snap(lat, lon, heading);
    if (!s || s.m > 300) throw new Error('No road near here');
    for (let i = 0; i < 2; i++) { const at = pivotAt(); if (await pivot(at, Plan.pivot(g, s.u, s.v, s.pt, at * STEP_M), true)) return true; if (!rid) break; }
    return false;
  }
  // the stretch shown (a teleport splits the course: from the last one passed up to the next), kept while unchanged
  let win = { ll: null };
  function stretch() {
    const a = jumps.reduce((m, j) => (j - 1) * STEP_M <= d ? j : m, 0), b = jumps.find(j => (j - 1) * STEP_M > d) ?? n;
    if (win.ll !== ll || win.ele !== ele || win.a !== a || win.b !== b) win = { ll, ele, a, b, L: a || b < n ? ll.slice(a, b) : ll, E: a || b < n ? ele.slice(a, b) : ele };
    return win;
  }

  return {
    start, uturn, teleport,
    busy: () => pv,
    // the road a start point snaps to (warms the road cache): { pt, name } | null
    async preview(lat, lon, heading = null) {
      await Promise.all(near(lat, lon, 150).map(cell));
      const s = g.snap(lat, lon, heading); return s && s.m <= 300 ? { pt: s.pt, name: label(s.w) } : null;
    },
    // every state update: rc = the ride's course state, id = the ride id
    update(rc, id) {
      if (!rc?.open) { if (rid) { rid = null; reset(); } return; }
      d = rc.odo_m; v = rc.speed_kmh / 3.6;
      if (id !== rid || rc.n !== n) { if (!syncing && (id !== rid || !pumping && !pv)) { rid = id; plan = null; sync(); } return; }
      jx = junction(); pump();
    },
    choose(to) {
      const j = jx; if (!j || to === j.sel || !j.opts.some(o => o.to === to)) return false;
      plan.choose(j.k, to); plan.extend(d + AHEAD);
      dirty = Math.min(dirty, Math.floor(j.d / STEP_M) + 1);
      jx = junction(); onChange(); pump(); return true;
    },
    // arrows: left and right move the choice one way over, up takes the straightest, down turns round. true when used.
    key(code) {
      if (code === 'ArrowDown') { if (!rid) return false; uturn(); return true; }
      const j = jx; if (!j?.opts.length || !['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(code)) return false;
      const i = j.opts.findIndex(o => o.to === j.sel), o = j.opts;
      const t = code === 'ArrowUp' ? [...o].sort((a, b) => Math.abs(a.a) - Math.abs(b.a))[0] : o[Math.max(0, Math.min(o.length - 1, i + (code === 'ArrowLeft' ? -1 : 1)))];
      this.choose(t.to); return true;
    },
    // what the ride screen shows: the course line, its elevation, the junction prompt and the other ways there; after a
    // teleport the stretch since it (ll, ele, n and d from its start; o: where it starts on the course, metres)
    view() {
      if (!rid || !n) return null;
      const k = plan ? plan.kAt(d) : 0, w = plan?.wayAt(k), j = jx, s = stretch();
      return { ll: s.L, ele: s.E, d: Math.max(0, d - s.a * STEP_M), n: s.L.length, o: s.a * STEP_M, road: w ? label(w) : '', wait: d >= (n - 1) * STEP_M - 30,  // at the end of the road loaded so far
        turn: j && { m: Math.max(0, Math.round(j.d - d)), dead: !j.opts.length, opts: j.opts.map(o => ({ to: o.to, a: Math.round(o.a), name: label(o.w), on: o.to === j.sel })) },
        alts: j ? j.opts.filter(o => o.to !== j.sel).map(o => plan.peek(j.k, o.to)) : [] };
    },
    active: () => !!rid,
    // the loaded roads within m metres of a point (the minimap): [[lat, lon, lat, lon, rank]], one per segment
    roads(lat, lon, m) {
      const dl = m / 111195, dk = dl / Math.cos(lat * Math.PI / 180), out = [], s = lat - dl, nn = lat + dl, w = lon - dk, e = lon + dk;
      for (const a of g.nodes.values()) {
        if (a.lat < s || a.lat > nn || a.lon < w || a.lon > e) continue;
        for (const x of a.adj) if (x.f) { const b = g.nodes.get(x.to); out.push([a.lat, a.lon, b.lat, b.lon, /^(trunk|primary|secondary)/.test(x.w.hw) ? 2 : /^(path|footway|cycleway|pedestrian|bridleway)$/.test(x.w.hw) ? 0 : 1]); }
      }
      return out;
    },
    // a rider close ahead (world3d/draft.js): the engine takes that share off the air drag for a few seconds
    draft(k) { if (rid) control('draft', { k }).catch(() => {}); },
  };
}
