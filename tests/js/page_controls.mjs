// Drives every mid-ride control of the real app/js/app.js with a stubbed DOM: buttons, the Adjust
// sheet and keyboard shortcuts, then "reloads" the page and reports what the new page shows.
// Usage: node page_controls.mjs server <port>     (against a real test server; Python ticks the ride)
//        node page_controls.mjs web <dist-web dir> (the in-page engine; this script ticks it)
import { pathToFileURL } from 'node:url';
const [MODE, ARG] = process.argv.slice(2);
const WEB = MODE === 'web';
const BASE = WEB ? null : `http://127.0.0.1:${ARG}`;
const realFetch = globalThis.fetch;

// ---------- minimal IndexedDB for the web build (survives the reload) ----------
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
      r.result = db; if (fresh) r.onupgradeneeded?.(); r.onsuccess?.();
    });
    return r;
  },
};

// ---------- DOM stub ----------
class ClassList { constructor() { this.s = new Set(); } add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); return this.s.has(c); } contains(c) { return this.s.has(c); } }
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
let els = {}, M = {}, keydown = [];
const multi = () => ({
  '[data-feel]': ['easier', 'good', 'harder'].map(f => new El('feel', { feel: f })),
  'nav button': ['workouts', 'ride', 'history', 'settings'].map(v => new El('nav', { v })),
  '.view': ['workouts', 'ride', 'history', 'settings'].map(v => Object.assign(new El('view'), { id: 'v-' + v })),
  '#jrMode button': ['g', 'w', 'r'].map(m => new El('jr', { m })),
  '#aMode button': ['e', 'w', 'g', 'r'].map(v => new El('mode', { v })),
  '.wk': [new El('wk'), new El('wk')],
});
const mkDoc = () => ({ querySelector: s => els[s] ??= new El(s), querySelectorAll: s => M[s] || [], createElement: () => new El('new'),
  addEventListener(t, f) { if (t === 'keydown') keydown.push(f); }, documentElement: new El('html'), body: new El('body'), activeElement: { tagName: 'BODY' }, hidden: false });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#38bdf8' });
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = { getVoices: () => [], speak() {}, cancel() {} };

let streams = [];
if (WEB) {
  globalThis.fetch = async u => { throw new Error('network used in web mode: ' + u); };
  globalThis.EventSource = undefined;
} else {
  globalThis.fetch = (path, opt = {}) => {
    const headers = { ...(opt.headers || {}) };
    if (opt.method === 'POST') headers.Origin = BASE;   // the page: its controls are the rider's (MANUAL)
    return realFetch(BASE + path, { ...opt, headers });
  };
  globalThis.EventSource = class {
    constructor(url) {
      streams.push(this); this.ctl = new AbortController();
      (async () => {
        const r = await realFetch(BASE + url, { signal: this.ctl.signal });
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            this.onmessage?.({ data: chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n') });
          }
        }
      })().catch(e => { if (e.name !== 'AbortError') this.onerror?.(e); });
    }
    close() { this.ctl.abort(); }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 15000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what + ' toast=' + document.querySelector('#toast').textContent + ' err=' + document.querySelector('#aNextErr').textContent + ' ' + JSON.stringify(ride()?.step)); await sleep(5); } }
let hw = null;
async function boot(n) {
  for (const s of streams) s.close();
  streams = []; els = {}; M = multi(); keydown = []; globalThis.document = mkDoc();
  globalThis.__openspinWeb = { tickMs: 0 };
  const src = WEB ? pathToFileURL(`${ARG}/js/app.js`).href : new URL('../../app/js/app.js', import.meta.url).href;
  await import(src + `?boot=${n}`);
  hw = window.__hw; await until(() => hw.state(), 'first state');
}
const $ = s => document.querySelector(s);
const ride = () => hw?.state()?.ride;
const tick = async n => { if (WEB) { for (let i = 0; i < n; i++) hw.backend.tick(); await sleep(5); } else { const el = ride().el; await until(() => ride().el >= el + n, `${n} s of riding`); } };
const press = (a, v) => $('#adjPanel').onclick({ target: { closest: () => ({ dataset: { a, v } }) } });
const key = (code, o = {}) => { for (const f of keydown) f({ code, key: o.key ?? '', shiftKey: !!o.shiftKey, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }); };
const toastText = () => String($('#toast').textContent);
const log = [];
async function step(what, fn, cond) { fn(); await until(cond, what); log.push([what, toastText()]); }

// ---------- boot 1: ride and change everything by hand ----------
await boot(1);
await (WEB ? (u, o) => hw.backend.fetch(u, o) : (u, o) => fetch(u, o))('/api/devices', { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => hw.state().devices.trainer === 'sim', 'sim');
$('#bText').value = '10m 50%, 20m 100%, 10m 50%, 5m free'; $('#bName').value = 'Hands';
$('#bRide').click();
await until(() => ride()?.name === 'Hands', 'loaded');
$('#cStart').click();
await until(() => ride()?.started, 'started');
await tick(3);
const out = { mode: hw.mode };

await step('plus button', () => $('#cPlus').click(), () => ride().intensity === 1.01);
await step('shift up', () => key('ArrowUp', { shiftKey: true }), () => ride().intensity === 1.06);
out.undoShown = $('#cUndo').style.display;
await step('undo button', () => $('#cUndo').click(), () => ride().intensity === 1.01);
await step('down key', () => key('ArrowDown'), () => ride().intensity === 1.0);
key('KeyA');
out.sheetOpen = $('#adjPanel').classList.contains('on');
await step('intensity +5', () => press('int', '5'), () => ride().intensity === 1.05);
await step('intensity 100', () => press('int0'), () => ride().intensity === 1.0);
await step('skip key', () => key('ArrowRight'), () => ride().step?.index === 2);
await step('step watts +5', () => press('tgt', '5'), () => ride().target_w === 205);
await step('= key', () => key('Equal'), () => ride().target_w === 210);
await step('- key', () => key('Minus'), () => ride().target_w === 205);
out.tgtShown = String($('#lT').textContent);
await step('] key', () => key('BracketRight'), () => ride().step.duration_s === 1500);  // a 20 min segment moves in 5 min
await step('[ key', () => key('BracketLeft'), () => ride().step.duration_s === 1200);
await step('step +1m', () => press('ext', '60'), () => ride().step.duration_s === 1260);
await step('Z undoes it', () => key('KeyZ'), () => ride().step.duration_s === 1200);
await step('ERG off: grade', () => press('mode', 'g'), () => ride().control === 'g');
await step('grade ++', () => press('adj', '5'), () => ride().jr.g === 2.5);
await step('grade up key', () => key('ArrowUp'), () => ride().jr.g === 3);
out.adjGrade = String($('#cAdj').textContent);
out.tgtSub = String($('#lTs').textContent);
await step('level key', () => key('Digit3'), () => ride().control === 'r');
await step('ERG key', () => key('Digit1'), () => ride().control === 'k');
await tick(12);
const n0 = ride().steps.length;
await step('back key', () => key('ArrowLeft'), () => ride().steps.length === n0 + 1);
await step('back button', () => $('#cBack').click(), () => ride().steps.length >= n0 + 2);  // early in a step: the previous step again (+ this one if 1 s in)
await tick(2);  // the cut step lasts under a second more: let the copy start
const cur = ride().step.index;
$('#aNext').value = '2m 60%, 1m free'; $('#aNext').oninput();
await step('next steps', () => press('next'), () => ride().steps.length === cur + 2);
$('#aNext').value = '5m bogus'; $('#aNext').oninput(); press('next');
out.nextErr = String($('#aNextErr').textContent);
await step('after plan: flat', () => press('after', 'grade0'), () => hw.state().ride.after_workout === 'grade0');
press('cad', '0,5'); press('coach', '0'); press('beeps', '0');
await sleep(50);
await step('mute key', () => key('KeyM'), () => hw.state().voice.mode === 'silent');
await step('space pauses', () => key('Space'), () => ride().paused);
await step('space resumes', () => key('Space'), () => !ride().paused);
key('Slash', { key: '?', shiftKey: true });
out.keysOpen = $('#keysModal').classList.contains('on');
key('Escape', { key: 'Escape' });
out.closed = !$('#keysModal').classList.contains('on') && !$('#adjPanel').classList.contains('on');
await tick(2);
const pick = r => ({ name: r.name, intensity: r.intensity, jr: r.jr, control: r.control, total_s: r.total_s, ov: r.ov, after_workout: r.after_workout,
  steps: r.steps.map(s => [s.duration_s, s.free, s.start_w, s.manual]), manual: r.manual?.what });
out.before = pick(ride());
const F2 = WEB ? (u, o) => hw.backend.fetch(u, o) : (u, o) => fetch(u, o);
out.settings = (await (await F2('/api/settings')).json()).settings;
out.log = log;
const events = WEB ? hw.backend.log.map(l => l.replace(/^\[[\d:]+\] /, '')) : (await (await fetch('/api/events?n=400', { headers: { 'X-HW': '1', Origin: BASE } })).json()).events.map(e => e.text);
out.manual = events.filter(l => /^(MANUAL|EDIT)/.test(l));

// ---------- boot 2: the page reloads mid-ride ----------
await boot(2);
await until(() => ride()?.name === 'Hands', 'ride after reload');
await sleep(50);
out.after = pick(ride());
out.shown = { adj: String($('#cAdj').textContent), target: String($('#lT').textContent), badge: String($('#rState').textContent) };
for (const s of streams) s.close();
process.stdout.write(JSON.stringify(out));
process.exit(0);
