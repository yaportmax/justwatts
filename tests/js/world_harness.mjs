// Open world on the page, end to end without a network: app/js/world.js (the road provider) drives the web build's
// engine over recorded Overpass cells and a made-up terrain, and courses.js shows the junction prompt in a stubbed
// DOM. Taps, arrow keys, the default way, a reload in the middle. stdout: JSON report for tests/test_world.py.
import { readFileSync, existsSync } from 'node:fs';
import { Engine } from '../../app/js/web/engine.js';
import { createWorld } from '../../app/js/world.js';
import { createCourses } from '../../app/js/courses.js';
import { parseWays, dist } from '../../app/js/roads.js';
import { track } from '../../app/js/course.js';

// ---------- a tiny DOM for courses.js / ridemap.js / map.js ----------
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { set src(v) { this._s = v; } };
const ctx = new Proxy({}, { get: (t, k) => k in t ? t[k] : () => ({ width: 10 }), set: (t, k, v) => { t[k] = v; return true; } });
class El {
  constructor(sel) { this.sel = sel; this.style = {}; this.dataset = {}; this.innerHTML = ''; this.textContent = ''; this.value = ''; this.cls = new Set();
    this.classList = { toggle: (c, on) => (on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c), add: c => this.cls.add(c), remove: c => this.cls.delete(c), contains: c => this.cls.has(c) }; }
  appendChild() {} setAttribute() {} querySelector(s) { return new El(s); } querySelectorAll() { return []; }
  getContext() { return ctx; } getBoundingClientRect() { return { width: 300, height: 100 }; }
}
const els = {};
const $ = s => s === '#crsList' ? null : els[s] ??= new El(s);  // no course list here
const mem = new Map();
const store = { get: (k, d) => mem.has(k) ? mem.get(k) : d, set: (k, v) => { mem.set(k, v); return true; }, del: k => mem.delete(k) };

// ---------- engine with a steady rider ----------
const settings = { ftp: 200, afterWorkout: 'hold', weight: 75 };
let t = 1000, wall = 1.7e12;
const hub = { mode: 'ble', r: { power: 230, cadence: 90, hr: 0, speed: 0, last: 0, hrLast: 0 }, wantCmd: null, want(c) { this.wantCmd = c; }, status() { return {}; } };
const eng = new Engine({ hub, logEvent: l => eng.note(l), settings: () => settings, save: () => {}, archive: () => {}, clock: () => t, wall: () => wall });
const control = async (a, b) => eng.control(a, b);
const course = async () => ({ course: eng.ride?.course ?? null, d: eng.ride?.cs.d ?? 0 });

// ---------- roads and terrain from fixtures ----------
const asked = [];
const loader = { get: async key => { asked.push(key); const f = new URL(`../fixtures/overpass/${key}.json`, import.meta.url); return existsSync(f) ? parseWays(JSON.parse(readFileSync(f))) : []; } };
const terrain = { ele: async lls => lls.map(([lat, lon]) => 80 + (lat - 37.829) * 9000 + (37.83 - Math.abs(lon + 122.487) * 0) * 0) };
const mkWorld = () => createWorld({ control, course, loader, terrain, onChange: () => courses?.renderRide(eng.state({}).ride?.course) });
let world = mkWorld(), courses = null;
courses = createCourses({ $, store, toast: () => {}, fit: () => [ctx, 300, 100], css: () => '#fff', units: () => 'metric', ride: () => {}, workouts: () => [], relayout: () => {}, world: { view: () => world.view(), choose: to => world.choose(to) } });

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const rc = () => eng.state({}).ride.course;
async function tick(n = 1) {
  for (let i = 0; i < n; i++) { t += 1; wall += 1000; hub.r.last = t; eng.tick(1); world.update(rc(), eng.ride.id); courses.renderRide(rc()); await flush(); }
}
const turnEl = () => $('#owTurn');
const buttons = () => [...turnEl().innerHTML.matchAll(/data-to="(\d+)" class="(on)?"/g)].map(m => ({ to: +m[1], on: !!m[2] }));
const nodeAfter = (id, c = eng.ride.course) => { const i = c.nd.findIndex(x => x[1] === id); return i >= 0 ? c.nd[i + 1]?.[1] : null; };
const out = { log: [] };

// start at Hawk Hill (Conzelman Road), the way world.js presets do
out.start = await world.start({ name: 'Hawk Hill', lat: 37.8295, lon: -122.4844, heading: 270 });
eng.control('start', {});
out.loaded = { name: eng.ride.name, open: rc().open, n: rc().n, dist: rc().dist_m };
out.noPromptKey = world.key('ArrowLeft');  // no junction ahead yet: arrows stay with the ride controls

// ride until a junction prompt with a choice shows
let j = null;
for (let s = 0; s < 400 && !j; s++) { await tick(); const v = world.view(); if (v?.turn && v.turn.opts.length > 1) j = v.turn; }
out.prompt = j && { m: j.m, opts: j.opts, html: turnEl().innerHTML, on: turnEl().cls.has('on'), buttons: buttons(), d: rc().odo_m };
out.alts = world.view().alts;
if (j) {
  const sel = j.opts.find(o => o.on), at = world.view().turn;
  const k = j.opts.findIndex(o => o.on), key = k > 0 ? 'ArrowLeft' : 'ArrowRight', want = j.opts[k > 0 ? k - 1 : k + 1];
  const jNode = eng.ride.course.nd.find(x => nodeAfter(x[1]) === sel.to)?.[1];
  out.defaultNext = { sel: sel.to, inEngine: nodeAfter(jNode) };
  out.key = world.key(key); await flush();
  out.afterKey = { want: want.to, sel: world.view().turn?.opts.find(o => o.on)?.to, inEngine: nodeAfter(jNode), buttons: buttons() };
  // ArrowUp: the straightest way
  out.up = world.key('ArrowUp'); await flush();
  const straight = [...j.opts].sort((a, b) => Math.abs(a.a) - Math.abs(b.a))[0].to;
  out.afterUp = { want: straight, sel: world.view().turn?.opts.find(o => o.on)?.to, inEngine: nodeAfter(jNode) };
  // a tap on a way that is not the straightest
  const other = buttons().find(b => b.to !== straight);
  turnEl().onclick({ target: { closest: () => ({ dataset: { to: String(other.to) } }) } }); await flush();
  out.afterTap = { want: other.to, sel: world.view().turn?.opts.find(o => o.on)?.to, inEngine: nodeAfter(jNode), buttons: buttons() };
  // ride through the junction: the rider ends up on that way
  const jd = eng.ride.course.nd.find(x => x[1] === jNode)[0];
  for (let s = 0; s < 120 && rc().odo_m < jd + 60; s++) await tick();
  out.through = { passed: rc().odo_m > jd + 30, onWay: nodeAfter(jNode) === other.to, pos: track(eng.ride.course)(rc().odo_m) };
}

// a reload: a new page (new world, empty graph) picks the ride up from the engine and keeps the road coming
const n0 = rc().n, d0 = rc().odo_m;
world = mkWorld();
await tick(3);
for (let s = 0; s < 240; s++) await tick();
out.reload = { n0, n1: rc().n, d0, d1: rc().odo_m, stuck: rc().odo_m >= rc().dist_m - 1, ahead: rc().dist_m - rc().odo_m };
out.view = (({ road, wait, n }) => ({ road, wait, n }))(world.view());
out.crsK = $('#crsK').innerHTML;
out.asked = [...new Set(asked)];
// the course behind the rider never changed: every point the engine had stays where it was
out.ll0 = eng.ride.course.ll.slice(0, 5);
out.ndOk = eng.ride.course.nd.every((x, i, a) => !i || x[0] >= a[i - 1][0]);
out.spacing = Math.max(...eng.ride.course.ll.slice(1).map((p, i) => dist(eng.ride.course.ll[i], p)));

// a start on a long bridge: its far end is not loaded yet, so it goes out flat and is sent again, as a straight line
// from the rider's point to the far end, once the road beyond it is known. The terrain under it is a 40 m deep valley.
{
  const O = [37.5005, -121.9995], K = 111195 * Math.cos(O[0] * Math.PI / 180), at = (y) => ({ lat: O[0] + y / 111195, lon: O[1] });
  const nodes = (a, b) => { const ids = [], geo = []; for (let y = a; y <= b; y += 100) { ids.push(500 + y / 100); geo.push(at(y)); } return [ids, geo]; };
  const [n1, g1] = nodes(0, 2000), [n2, g2] = nodes(2000, 3500);
  const ways = parseWays({ elements: [{ type: 'way', id: 1, nodes: n1, geometry: g1, tags: { highway: 'cycleway', bridge: 'yes', name: 'Long Bridge' } },
    { type: 'way', id: 2, nodes: n2, geometry: g2, tags: { highway: 'cycleway', name: 'Shore Path' } }] });
  let north = 3750;  // only the cells around the start answer at first
  const eng2 = new Engine({ hub, logEvent: l => eng2.note(l), settings: () => settings, save: () => {}, archive: () => {}, clock: () => t, wall: () => wall });
  const ground = ([lat]) => { const y = (lat - O[0]) * 111195; return 50 + y * 0.02 - (y > 300 && y < 1700 ? 40 : 0); };
  const w2 = createWorld({ control: async (a, b) => eng2.control(a, b), course: async () => ({ course: eng2.ride.course, d: eng2.ride.cs.d }),
    loader: { get: key => new Promise(ok => { const f = () => +key.split('_')[0] <= north ? ok(ways) : setTimeout(f, 5); f(); }) },
    terrain: { ele: async lls => lls.map(ground) }, inside: null });  // a made-up place outside the Marin world
  const started = await w2.start({ name: 'Bridge', lat: O[0] + 1e-4, lon: O[1], heading: 0 });
  eng2.control('start', {});
  const first = eng2.ride.course.ele.slice();
  const step = async () => { t += 1; wall += 1000; hub.r.last = t; eng2.tick(1); w2.update(eng2.state({}).ride.course, eng2.ride.id); await flush(); await new Promise(r => setTimeout(r, 10)); };
  for (let i = 0; i < 20; i++) await step();
  north = 3760;  // the rest of the road loads
  for (let i = 0; i < 40; i++) await step();
  const e = eng2.ride.course.ele, d = eng2.ride.cs.d;
  out.bridge = { started, first: [first.length, Math.min(...first), Math.max(...first)], n: e.length, d,
    jump: Math.max(...e.slice(1).map((x, i) => Math.abs(x - e[i]))), mid: e[100], end: e[200], beyond: e[250] };
}
process.stdout.write(JSON.stringify(out), () => process.exit(0));  // loaders still polling for cells never answered
