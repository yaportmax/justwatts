// Web build smoke test: boots dist-web/js/app.js (MODE 'web') twice in one process with a stubbed DOM
// and a small in-memory IndexedDB that survives the "reload". Rides a simulated workout entirely in
// the page: no server, no Bluetooth, no network. Usage: node web_smoke.mjs <dist-web dir>
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
const DIST = process.argv[2];

// ---------- minimal IndexedDB (enough for app/js/web/idb.js) ----------
const DBS = new Map();
const later = f => setTimeout(f, 0);
function request(fn) { const r = {}; later(() => { try { r.result = fn(); r.onsuccess?.({ target: r }); } catch (e) { r.error = e; r.onerror?.(e); } }); return r; }
class FakeStore {
  constructor(db, name) { this.m = db.stores.get(name); this.key = db.keys.get(name); }
  get(k) { return request(() => structuredClone(this.m.get(k))); }
  put(v, k) { return request(() => { this.m.set(this.key ? v[this.key] : k, structuredClone(v)); }); }
  delete(k) { return request(() => { this.m.delete(k); }); }
  getAll() { return request(() => [...this.m.values()].map(v => structuredClone(v))); }
  getAllKeys() { return request(() => [...this.m.keys()]); }
}
globalThis.indexedDB = {
  open(name) {
    const r = {};
    later(() => {
      let db = DBS.get(name), fresh = false;
      if (!db) { fresh = true; db = { stores: new Map(), keys: new Map(), createObjectStore(n, o) { this.stores.set(n, new Map()); this.keys.set(n, o?.keyPath); } }; DBS.set(name, db); }
      db.transaction = store => ({ objectStore: () => new FakeStore(db, store) });
      r.result = db;
      if (fresh) r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  },
};

// ---------- DOM stub (same idea as app_smoke.mjs) ----------
class ClassList { constructor() { this.s = new Set(); } add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); } contains(c) { return this.s.has(c); } }
const ctx = new Proxy({}, { get: (t, k) => k in t ? t[k] : () => {}, set: (t, k, v) => { t[k] = v; return true; } });
class El {
  constructor(sel, data = {}) { this.sel = sel; this.dataset = data; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this.classList = new ClassList(); this.kids = {}; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.tagName = 'DIV'; this.offsetHeight = 50; this.checked = false; }
  querySelector(s) { return this.kids[s] ??= new El(s); }
  get parentElement() { return this._p ??= new El('parent'); }
  appendChild() {} scrollIntoView() {} addEventListener() {} setAttribute(k, v) { (this.attrs ??= {})[k] = v; } querySelectorAll() { return this.qsa || []; }
  getBoundingClientRect() { return { width: 300, height: 100 }; }
  getContext() { return ctx; }
  click() { this.onclick?.(); }
}
let els = {}, made = [];  // made: elements the page created (list rows)
const multi = () => ({
  'nav button': ['workouts', 'ride', 'history', 'settings'].map(v => new El('nav', { v })),
  '.view': ['workouts', 'ride', 'history', 'settings'].map(v => Object.assign(new El('view'), { id: 'v-' + v })),
  '#jrMode button': [],
});
let M = multi();
const mkDoc = () => ({ querySelector: s => els[s] ??= new El(s), querySelectorAll: s => M[s] || [], getElementById: id => els['#' + id] ??= new El('#' + id), createElement: () => { const e = new El('new'); made.push(e); return e; },
  addEventListener() {}, documentElement: new El('html'), body: new El('body'), activeElement: { tagName: 'BODY' }, hidden: false });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#38bdf8' });
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.fetch = async u => { throw new Error('network used in web mode: ' + u); };   // the web build must not need a server
globalThis.EventSource = undefined;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(5); } }

async function boot(n, extra = {}) {
  els = {}; M = multi(); globalThis.document = mkDoc();
  globalThis.__justwattsWeb = { tickMs: 0, ...extra };
  const mod = pathToFileURL(`${DIST}/js/app.js`).href + `?boot=${n}`;
  await import(mod);
  const hw = window.__hw; await until(() => hw.state(), 'first state');
  return hw;
}
const $ = s => document.querySelector(s);
const out = {};

// ---------- boot 1: ride, then "crash" mid-ride ----------
let hw = await boot(1);
out.mode = hw.mode; out.webClass = document.body.classList.contains('web');
out.notice = $('#webNotice').style.display;            // no navigator.bluetooth in node
hw.backend.updateSettings({ voiceMode: 'all', localCoach: { enabled: true } });  // keys from older versions are ignored
out.oldKeys = ['voiceMode', 'localCoach'].filter(k => k in hw.backend.settings);
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim');
$('#bText').value = '1m 50%, 2m 100%'; $('#bName').value = 'Web ride';
$('#bRide').click();
await until(() => hw.state().ride?.name === 'Web ride', 'loaded');
$('#cStart').click();
await until(() => hw.state().ride?.started, 'started');
for (let i = 0; i < 47; i++) hw.backend.tick();
await sleep(20);
out.before = { samples: hw.state().ride.samples };
// ---------- boot 2: the page reloads ----------
hw = await boot(2);
await until(() => hw.state().ride, 'resumed ride');
const r = hw.state().ride;
out.resumed = { name: r.name, samples: r.samples, paused: r.paused, auto: r.auto_paused, notice: hw.state().notice };
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim again');
await hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify({ action: 'edit', edit: { op: 'insert', steps: '30s 120%' } }) });
for (let i = 0; i < 200; i++) hw.backend.tick();
await sleep(20);
out.overtime = hw.state().ride?.overtime;
$('#cEnd').click(); await sleep(10); $('#cEnd').click();
await until(() => hw.state().last_finished, 'finished');
await until(() => $('#sName').textContent === 'Web ride', 'summary');
const rides = await (await hw.backend.fetch('/api/rides')).json();
const fit = await hw.backend.exportFile(rides.rides[0].id, 'fit');
const backup = await (await hw.backend.fetch('/api/backup')).json();
const garmin = await hw.backend.fetch(`/api/rides/${rides.rides[0].id}/garmin`, { method: 'POST', body: '{}' });
out.final = { rides: rides.rides.length, samples: rides.rides[0].samples, fit: Buffer.from(fit.slice(8, 12)).toString(), backupRides: backup.rides.length,
  steps: backup.rides[0].steps.length, garminStatus: garmin.status, events: backup.rides[0].events.map(e => e[1]).filter(l => /^(RIDE|EDIT|WORKOUT)/.test(l)) };
// a backup carries custom workouts and imported courses (localStorage) next to the rides (IndexedDB)
const wk = { id: 'c-test1', name: 'Backup test', text: '10m 60%' }, crs = { id: 'k-test1', name: 'Backup hill', dist: 2000, gain: 80, ele: Array.from({ length: 201 }, (_, i) => i * 0.4), ll: [] };
await $('#bkFile').onchange({ target: { files: [{ text: async () => JSON.stringify({ ...backup, local: { custom: [wk, { id: 'x', text: 1 }], courses: [crs, { id: 'k-bad' }] } }) }], value: '' } });
out.restored = { custom: JSON.parse(mem.get('hw.custom')).map(w => w.id), courses: JSON.parse(mem.get('hw.courses')).map(c => c.id) };
// ---------- boot 3: per-ride course picks ----------
mem.set('hw.course', JSON.stringify('s-climb'));  // the old global course: dropped, rides are flat unless picked
hw = await boot(3);
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim 3');
out.oldCourse = mem.has('hw.course');
// rows are the last element made whose markup names it (lists re-render on every pick)
const rowOf = name => made.findLast(e => e.className?.startsWith('lrow') && String(e.innerHTML).includes(`<div class="t">${name}</div>`));
const tap = el => el.onclick({ target: { closest: () => null } });
const load = async (go, what) => { go(); await until(() => hw.state().ride && what(hw.state().ride), 'load'); const r = hw.state().ride; return { name: r.name, course: r.course?.name ?? null, plan: !!r.steps?.length }; };
out.picks = {};
// a workout row: Ride alone is flat; selected, it offers a course picker
out.picks.flatWorkout = await load(() => rowOf('Sweet spot 2x12').querySelector('[data-a=ride]').onclick(), r => r.name === 'Sweet spot 2x12');
tap(rowOf('Sweet spot 2x12'));
let row = rowOf('Sweet spot 2x12');
out.picks.wPicker = { sel: row.className, html: String(row.innerHTML).includes('<option value="">Flat</option>') && String(row.innerHTML).includes('The climb · ') };
row.querySelector('[data-a=pick]').onchange({ target: { value: 's-rolling' } });
out.picks.workoutCourse = await load(() => row.querySelector('[data-a=ride]').onclick(), r => r.course?.name === 'Rolling hills');
// a course row, selected: a workout picker; Ride starts the course with that workout
tap(rowOf('Hawk Hill, Marin'));
row = rowOf('Hawk Hill, Marin');
out.picks.cPicker = { sel: row.className, html: String(row.innerHTML).includes('Free ride on this course') && String(row.innerHTML).includes('>Sweet spot 2x12</option>') };
row.querySelector('[data-a=pick]').onchange({ target: { value: 'l-ss-2x12' } });
out.picks.courseWorkout = await load(() => row.querySelector('[data-a=ride]').onclick(), r => r.course?.name === 'Hawk Hill, Marin' && r.name === 'Sweet spot 2x12');
// FTP tests never take a course
out.picks.test = await load(() => $('#ftpModal').onclick({ target: { closest: () => ({ dataset: { t: 't-ramp' } }) } }), r => /ramp/i.test(r.name));
// Just ride: flat in one click, or on the course picked next to it
out.picks.justFlat = await load(() => $('#btnJust').click(), r => !r.steps?.length && !r.course);
$('#jrCourse').value = 's-climb';
$('#btnJust').click();
await until(() => hw.state().ride?.course, 'course loaded');
$('#cStart').click();
await until(() => hw.state().ride?.started, 'course started');
for (let i = 0; i < 60; i++) hw.backend.tick();
await sleep(20);
const rc = hw.state().ride.course;
out.course = { name: hw.state().ride.name, course: rc.name, done: rc.done_m, profile: rc.profile.length, want: hw.backend.engine?.hub?.wantCmd ?? null,
  strip: $('#crsRide').style.display, text: $('#crsK').innerHTML };
// ---------- boot 4: integrations on the web, through the real /api/integrations handler (dist-web/api) ----------
// Signed out: manual upload and "Sign in". Signed in: connect from the Upload panel uploads this ride (the page
// posts its FIT), Today's planned ride. intervals.icu itself is a stub; the user is whoever `uid` says.
{
  const require = createRequire(import.meta.url);
  const { makeHandler } = require(`${DIST}/api/_lib/integrations/http.js`);
  const { memoryStore } = require(`${DIST}/api/_lib/integrations/store.js`);
  const KEY = 'icukey-0123456789abcdef';
  let uid = null; const svc = [], net = [];
  const R = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const H = makeHandler({ store: memoryStore(), key: Buffer.alloc(32, 3), userId: async () => uid, fetch: async (url, opt = {}) => {
    svc.push(`${opt.method || 'GET'} ${url}`);
    if (/\/athlete\/i42$/.test(url)) return R(200, { id: 'i42', name: 'Web Rider' });
    if (/\/athlete\/i42\/activities/.test(url)) return R(201, { id: 'i42', activities: [{ id: 'i77' }] });
    if (/\/athlete\/i42\/events/.test(url)) return R(200, [{ id: 5, category: 'WORKOUT', type: 'Ride', name: 'Tempo', workout_doc: { steps: [{ duration: 600, power: { value: 80, units: '%ftp' } }] } }]);
    return R(404, {});
  } });
  const netFetch = (url, opt = {}) => {
    const b = opt.body instanceof Uint8Array ? Buffer.from(opt.body) : Buffer.from(opt.body || '');
    net.push({ url, method: opt.method || 'GET', fit: b.length > 12 && b.toString('latin1', 8, 12) === '.FIT', hasKey: b.toString('latin1').includes(KEY) });
    const headers = { host: 'justwatts.test', 'x-hw': (opt.headers || {})['X-HW'] };
    if (opt.method === 'POST') headers.origin = 'https://justwatts.test';  // the browser adds it to a POST
    const req = Object.assign(Readable.from(b.length ? [b] : []), { method: opt.method || 'GET', url, headers });
    return new Promise(resolve => {
      const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(x) { resolve(new Response(x ?? null, { status: this.statusCode, headers: this.h })); } };
      H(req, res);
    });
  };
  let signIns = 0;
  globalThis.justwatts.openSignIn = () => { signIns++; };  // what the account UI adds next to openConnectServices
  hw = await boot(4, { net: netFetch });
  const nav = v => M['nav button'].find(b => b.dataset.v === v).click();
  const html = sel => String($(sel).innerHTML);
  const tapIn = (sel, act, svcId) => $(sel).onclick({ target: { closest: () => ({ dataset: { act, svc: svcId }, disabled: false }) } });
  const w = out.web = {};
  // signed out: Settings offers sign in and the manual routes; the Upload panel too
  nav('settings');
  await until(() => $('#intSignin').style.display === '' && html('#intList').includes('Upload by hand'), 'signed out settings');
  w.signedOut = { connects: (html('#intList').match(/data-conn=/g) || []).length, manual: ['garmin', 'strava', 'coros', 'wahoo'].every(id => html('#intList').includes(`data-svc="${id}"`)),
    steps: html('#intList').includes('Drop the file in and click Import Data.') };
  const rid = (await (await hw.backend.fetch('/api/rides')).json()).rides.find(r => r.name === 'Web ride').id;
  nav('history');
  await until(() => made.some(e => String(e.innerHTML).includes('Web ride')), 'history');
  made.findLast(e => String(e.innerHTML).includes('Web ride')).onclick();
  await until(() => $('#sName').textContent === 'Web ride' && $('#sUpload').textContent === 'Upload', 'summary');
  $('#sUpload').onclick();
  w.panelOut = { signin: html('#upBody').includes('Sign in to connect services'), fit: html('#upBody').includes('Download .fit'), steps: html('#upBody').includes('Open Garmin Connect') };
  tapIn('#upBody', 'signin');
  w.signIns = signIns;
  // the account UI signs the rider in, then calls openConnectServices()
  uid = 'u1';
  await globalThis.justwatts.openConnectServices();
  w.connectStep = { title: $('#upTitle').textContent, first: (html('#upBody').match(/data-svc="(\w+)"/) || [])[1], skip: html('#upBody').includes('Skip for now') };
  tapIn('#upBody', 'skip');
  // connect with this ride from the Upload panel: no FIT on the server yet, so the page posts it
  hw.conn.openPanel('ride'); await hw.conn.renderSummary(rid);
  tapIn('#upBody', 'connect', 'intervals');
  $('#connBody').qsa = [{ name: 'athlete_id', value: 'i42' }, { name: 'api_key', value: KEY }];
  await $('#connGo').onclick();
  await until(() => String($('#sUpLine').innerHTML).includes('Uploaded'), 'web uploaded');
  w.after = { button: $('#sUpload').textContent, line: String($('#sUpLine').innerHTML).includes('https://intervals.icu/activities/i77') };
  w.posts = net.filter(c => c.method === 'POST').map(c => ({ op: new URL(c.url, 'https://x').searchParams.get('op'), services: new URL(c.url, 'https://x').searchParams.get('services'), fit: c.fit, key: c.hasKey }));
  // a ride saved later goes up by itself (auto upload, no services list)
  const n0 = net.length;
  await hw.conn.afterRide(rid);
  w.auto = net.slice(n0).map(c => ({ op: new URL(c.url, 'https://x').searchParams.get('op'), services: new URL(c.url, 'https://x').searchParams.get('services'), fit: c.fit }));
  // Today
  nav('workouts');
  await until(() => made.some(e => e.className === 'lrow today' && String(e.innerHTML).includes('Tempo')), 'web today');
  w.today = true;
  w.leak = Object.values(els).some(e => String(e.innerHTML).includes(KEY));
  w.svc = [...new Set(svc.map(x => x.split(' ')[0] + ' ' + new URL(x.split(' ')[1]).pathname.replace(/\d+/g, 'N')))];
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
