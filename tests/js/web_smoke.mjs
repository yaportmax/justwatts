// Web build smoke test: boots dist-web/js/app.js (MODE 'web') twice in one process with a stubbed DOM
// and a small in-memory IndexedDB that survives the "reload". Rides a simulated workout entirely in
// the page: no server, no Bluetooth, no network. Usage: node web_smoke.mjs <dist-web dir>
import { pathToFileURL } from 'node:url';
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
  appendChild() {} scrollIntoView() {} addEventListener() {} setAttribute(k, v) { (this.attrs ??= {})[k] = v; }
  getBoundingClientRect() { return { width: 300, height: 100 }; }
  getContext() { return ctx; }
  click() { this.onclick?.(); }
}
let els = {};
const multi = () => ({
  '[data-feel]': ['easier', 'good', 'harder'].map(f => new El('feel', { feel: f })),
  'nav button': ['workouts', 'ride', 'history', 'settings'].map(v => new El('nav', { v })),
  '.view': ['workouts', 'ride', 'history', 'settings'].map(v => Object.assign(new El('view'), { id: 'v-' + v })),
  '#jrMode button': [], '[data-lc]': [],
});
let M = multi();
const mkDoc = () => ({ querySelector: s => els[s] ??= new El(s), querySelectorAll: s => M[s] || [], createElement: () => new El('new'),
  addEventListener() {}, documentElement: new El('html'), body: new El('body'), activeElement: { tagName: 'BODY' }, hidden: false });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#38bdf8' });
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = { getVoices: () => [], speak: u => spoken.push(u.text), cancel() {} };
globalThis.fetch = async u => { throw new Error('network used in web mode: ' + u); };   // the web build must not need a server
globalThis.EventSource = undefined;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(5); } }

async function boot(n) {
  els = {}; M = multi(); globalThis.document = mkDoc();
  globalThis.__openspinWeb = { tickMs: 0 };
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
out.coachDefault = hw.backend.coach !== null;  // the web build has no built-in coach
hw.backend.updateSettings({ localCoach: { enabled: true } });  // even if a setting asks for it
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim');
$('#bText').value = '1m 50%, 2m 100%'; $('#bName').value = 'Web ride';
$('#bRide').click();
await until(() => hw.state().ride?.name === 'Web ride', 'loaded');
$('#cStart').click();
await until(() => hw.state().ride?.started, 'started');
for (let i = 0; i < 47; i++) hw.backend.tick();
await sleep(20);
out.before = { samples: hw.state().ride.samples, spoken: spoken.slice() };
// ---------- boot 2: the page reloads ----------
hw = await boot(2);
await until(() => hw.state().ride, 'resumed ride');
const r = hw.state().ride;
out.resumed = { name: r.name, samples: r.samples, paused: r.paused, auto: r.auto_paused, notice: hw.state().notice };
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim again');
await hw.backend.fetch('/api/coach', { method: 'POST', body: JSON.stringify({ edit: { op: 'insert', steps: '30s 120%' } }) });
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
  steps: backup.rides[0].steps.length, garminStatus: garmin.status, events: backup.rides[0].events.map(e => e[1]).filter(l => /^(RIDE|EDIT|WORKOUT)/.test(l)),
  agent: hw.state().agent, meter: $('#agentMeter').style.display };
// a backup carries custom workouts and imported courses (localStorage) next to the rides (IndexedDB)
const wk = { id: 'c-test1', name: 'Backup test', text: '10m 60%' }, crs = { id: 'k-test1', name: 'Backup hill', dist: 2000, gain: 80, ele: Array.from({ length: 201 }, (_, i) => i * 0.4), ll: [] };
await $('#bkFile').onchange({ target: { files: [{ text: async () => JSON.stringify({ ...backup, local: { custom: [wk, { id: 'x', text: 1 }], courses: [crs, { id: 'k-bad' }] } }) }], value: '' } });
out.restored = { custom: JSON.parse(mem.get('hw.custom')).map(w => w.id), courses: JSON.parse(mem.get('hw.courses')).map(c => c.id) };
out.spoken = spoken.slice(0, 6);
// ---------- boot 3: a course is in use, Just ride rides it ----------
mem.set('hw.course', JSON.stringify('s-climb'));
hw = await boot(3);
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim 3');
$('#btnJust').click();
await until(() => hw.state().ride?.course, 'course loaded');
$('#cStart').click();
await until(() => hw.state().ride?.started, 'course started');
for (let i = 0; i < 60; i++) hw.backend.tick();
await sleep(20);
const rc = hw.state().ride.course;
out.course = { name: hw.state().ride.name, course: rc.name, done: rc.done_m, profile: rc.profile.length, want: hw.backend.engine?.hub?.wantCmd ?? null,
  strip: $('#crsRide').style.display, text: $('#crsK').innerHTML, now: $('#crsNow').textContent };
process.stdout.write(JSON.stringify(out));
process.exit(0);
