// Social on the web build: boots dist-web/js/app.js under node like account_web.mjs (stubbed DOM and IndexedDB,
// the real accounts handler on the in-memory store) and drives presence, friends, group rides, chat and ride-ons
// against a second and third rider talking to the same server. Nothing leaves the process.
// Usage: node social_web.mjs <repo> <dist-web dir>
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const [REPO, DIST] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const ORIGIN = 'https://justwatts.test';
for (const k of Object.keys(process.env)) if (/^(DATABASE_URL|POSTGRES_|JUSTWATTS_|PUBLIC_ORIGIN|GOOGLE_|STRAVA_|RESEND_|EMAIL_FROM|OWNER_EMAILS|VERCEL_ENV)/.test(k)) delete process.env[k];
const ENV = { JUSTWATTS_STORE: 'memory', JUSTWATTS_SESSION_SECRET: 's'.repeat(48), PUBLIC_ORIGIN: ORIGIN };
Object.assign(process.env, ENV);
require(`${REPO}/web/api/_lib/crypto.js`).SCRYPT.N = 1024;
const app = require(`${REPO}/web/api/_lib/app.js`);
const { memoryStore } = require(`${REPO}/web/api/_lib/store-memory.js`);
app.setStore(memoryStore());

/* ---------- the server side: real handler, a browser cookie jar, stubbed Resend / Strava ---------- */
const jar = new Map(), mails = [], calls = [];
let netDown = false, athlete = 7;
function handle(method, path, { body, headers = {}, cookies = jar } = {}) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  const h = { host: 'justwatts.test', 'x-real-ip': '198.51.100.9', ...headers };
  if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const req = Object.assign(Readable.from(buf.length ? [buf] : []), { method, url: path, headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])) });
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) {
        const sc = this.headers['set-cookie']; for (const c of (Array.isArray(sc) ? sc : sc ? [sc] : [])) { const [kv] = c.split(';'), i = kv.indexOf('='); /Max-Age=0/.test(c) ? cookies.delete(kv.slice(0, i)) : cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
        resolve({ status: this.statusCode, headers: this.headers, body: b ? Buffer.from(b) : Buffer.alloc(0) });
      } };
    Promise.resolve(app.handler(req, res)).catch(reject);
  });
}
globalThis.fetch = async (url, o = {}) => {
  const u = String(url), method = (o.method || 'GET').toUpperCase();
  if (u === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{"id":"m"}', { status: 200 }); }
  if (u === 'https://www.strava.com/oauth/token') return new Response(JSON.stringify({ athlete: { id: athlete, firstname: 'Eddy' } }), { status: 200 });
  if (!u.startsWith('/api/')) throw new Error('unexpected fetch ' + u);
  if (netDown) throw new TypeError('fetch failed');
  calls.push(method + ' ' + u.split('?')[0]);
  const headers = { ...(o.headers || {}) };
  if (method !== 'GET') headers.origin = ORIGIN;  // the browser adds Origin to same-origin writes
  let body = o.body; if (body instanceof Uint8Array) body = Buffer.from(body);
  const r = await handle(method, u, { body, headers });
  return new Response(r.status === 204 || r.status === 302 ? null : r.body, { status: r.status, headers: { 'content-type': r.headers['content-type'] || 'application/json' } });
};
// a second device: its own jar, talking to the same server
function device() {
  const j = new Map(), w = { origin: ORIGIN, 'x-hw': '1', 'content-type': 'application/json' };
  const json = r => JSON.parse(r.body.toString() || '{}');
  return {
    post: async (p, b) => json(await handle('POST', p, { body: JSON.stringify(b), headers: w, cookies: j })),
    get: async p => json(await handle('GET', p, { cookies: j })),
    put: async (p, raw) => handle('PUT', p, { body: raw, headers: { ...w, 'content-type': 'application/gzip' }, cookies: j }),
  };
}

/* ---------- minimal IndexedDB + DOM (as web_smoke.mjs) ---------- */
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
globalThis.indexedDB = { open(name) { const r = {}; later(() => { let db = DBS.get(name), fresh = false; if (!db) { fresh = true; db = { stores: new Map(), keys: new Map(), createObjectStore(n, o) { this.stores.set(n, new Map()); this.keys.set(n, o?.keyPath); } }; DBS.set(name, db); } db.transaction = s => ({ objectStore: () => new FakeStore(db, s) }); r.result = db; if (fresh) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
class ClassList { constructor() { this.s = new Set(); } add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); } contains(c) { return this.s.has(c); } }
const ctx = new Proxy({}, { get: (t, k) => k in t ? t[k] : k === 'measureText' ? () => ({ width: 40 }) : () => {}, set: (t, k, v) => { t[k] = v; return true; } });
class El {
  constructor(sel, data = {}) { this.sel = sel; this.dataset = data; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this.classList = new ClassList(); this.kids = {}; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.tagName = 'DIV'; this.offsetHeight = 50; }
  querySelector(s) { return this.kids[s] ??= new El(s); }
  get parentElement() { return this._p ??= new El('parent'); }
  appendChild() {} scrollIntoView() {} addEventListener() {} setAttribute(k, v) { (this.attrs ??= {})[k] = v; } focus() {}
  getBoundingClientRect() { return { width: 300, height: 100 }; }
  getContext() { return ctx; }
  click() { this.onclick?.(); }
}
let els = {}, made = [], M = {};
const multi = () => ({
  'nav button': ['workouts', 'ride', 'history', 'settings'].map(v => new El('nav', { v })),
  '.view': ['workouts', 'ride', 'history', 'settings'].map(v => Object.assign(new El('view'), { id: 'v-' + v })),
  '#jrMode button': [],
});
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } };  // map tiles never load here
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#38bdf8' });
globalThis.scrollTo = () => {};
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.EventSource = undefined;
const replaced = [];
globalThis.history = { replaceState: (s, t, u) => replaced.push(u) };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(5); } }

let hw = null;
async function boot(n, search = '') {
  els = {}; M = multi(); made = [];
  globalThis.location = { search, pathname: '/', hash: '', hostname: 'localhost', href: '/' };
  globalThis.document = { querySelector: s => els[s] ??= new El(s), querySelectorAll: s => M[s] || [], createElement: () => { const e = new El('new'); made.push(e); return e; },
    addEventListener() {}, getElementById: id => els['#' + id] ??= new El('#' + id), documentElement: new El('html'), body: new El('body'), activeElement: { tagName: 'BODY' }, hidden: false };
  globalThis.__justwattsWeb = { tickMs: 0 };
  await import(pathToFileURL(`${DIST}/js/app.js`).href + `?boot=${n}`);
  hw = window.__hw; await until(() => hw.state(), 'first state');
  return hw;
}
const $ = s => document.querySelector(s);
const out = {};
const socialCalls = () => calls.filter(c => c.includes('/api/social'));
const ctl = body => hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify(body) });
const HAWK = 'Hawk Hill, Marin|2907';
// the browser gets a state update every second; here the engine ticks twice a second while a ride runs
setInterval(() => { try { if (hw?.state()?.ride?.started) hw.backend.tick(); } catch {} }, 500).unref();

/* ---------- 1. accounts off: no social at all ---------- */
delete process.env.JUSTWATTS_SESSION_SECRET;
await boot(1);
await sleep(30);
out.off = { social: hw.social, calls: socialCalls().length };
process.env.JUSTWATTS_SESSION_SECRET = ENV.JUSTWATTS_SESSION_SECRET;

/* ---------- 2. signed out: a course ride sends nothing ---------- */
await boot(2);
await until(() => hw.account?.providers(), 'providers');
await until(() => hw.social, 'social module');
await hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await ctl({ action: 'load', workout: null, course: hw.courses.byId('r-hawk') });
await ctl({ action: 'start' });
await until(() => hw.state().ride?.started, 'started signed out');
for (let i = 0; i < 5; i++) hw.backend.tick();
await sleep(2500);
out.signedOut = { calls: socialCalls().length, strip: $('#socRide').style.display };
await ctl({ action: 'end' });
await until(() => !hw.state().ride, 'ended');

/* ---------- 3. sign in; a friend request arrives; the Friends panel; accept ---------- */
await hw.account.signUp('ann@example.com', 'password123', 'Ann');
hw.account.close();
const bob = device(); await bob.post('/api/auth/signup', { email: 'bob@example.com', password: 'password123', name: 'Bob' });
const cat = device(); await cat.post('/api/auth/signup', { email: 'cat@example.com', password: 'password123', name: 'Cat' });
const ann = (await bob.post('/api/social/search', { q: 'ann' })).users[0];
await bob.post('/api/social/friends/request', { id: ann.id });
await until(() => hw.social.state().profile, 'profile');
hw.account.slotClick({ target: { closest: () => ({ dataset: { a: 'menu' } }) } });
out.menu = $('#acctSlot').innerHTML;
hw.account.slotClick({ target: { closest: () => ({ dataset: { a: 'friends' } }) } });
await until(() => $('#socList').innerHTML.includes('Requests'), 'requests listed');
out.panel = { on: $('#socModal').classList.contains('on'), title: $('#socTitle').textContent, html: $('#socList').innerHTML };
const bobId = hw.social.state().data.incoming[0].id;
await hw.social.act('accept', bobId);
out.accepted = hw.social.state().data.friends.map(f => f.name);
// search and add by name
await hw.social.find('cat');
out.found = $('#socFound').innerHTML;
const catId = (await cat.get('/api/auth/me')).user.id;
await hw.social.act('add', catId);
out.catIncoming = (await cat.get('/api/social')).incoming.map(f => f.name);
hw.social.close();

/* ---------- 4. riding a course: presence every ~2 s, riders on the strip, the friend highlighted ---------- */
await bob.post('/api/social/presence', { open: false, course: HAWK, cid: 'r-hawk', d: 900, w: 240, road: 'Hawk Hill, Marin' });
await ctl({ action: 'load', workout: null, course: hw.courses.byId('r-hawk') });
await ctl({ action: 'start' });
await until(() => hw.state().ride?.started, 'started signed in');
for (let i = 0; i < 20; i++) hw.backend.tick();
const nBefore = socialCalls().filter(c => c.endsWith('/presence')).length;
await until(() => hw.social.riders().length === 1, 'bob seen', 8000);
out.riding = { riders: hw.social.riders().map(r => [r.name, r.friend, r.w, r.course]), here: $('#socHere').textContent, strip: $('#socRide').style.display };
await sleep(6500);
out.rate = socialCalls().filter(c => c.endsWith('/presence')).length - nBefore;
// Bob sees Ann on the course, placed by distance
const seen = await bob.post('/api/social/presence', { open: false, course: HAWK, cid: 'r-hawk', d: 950, w: 240 });
out.bobSees = seen.riders.map(r => [r.name, r.friend, r.course, typeof r.d, typeof r.lat]);
// the Friends panel: Bob riding now, with where; Ride here is offered
hw.social.open('main');
await until(() => $('#socList').innerHTML.includes('Riding now'), 'riding now');
out.ridingNow = $('#socList').innerHTML;
hw.social.close();
// switched off: Ann disappears for Bob at once, and her calls say so
await hw.social.setVisible(false);
await sleep(2300);
out.hidden = { bob: (await bob.post('/api/social/presence', { open: false, course: HAWK, d: 950 })).riders.map(r => r.name), sees: hw.social.riders().map(r => r.name) };
hw.backend.fetch('/api/settings', { method: 'POST', body: '{}' }).catch(() => {});
await hw.social.setVisible(true);
// a failing network: the ride goes on, the riders clear after 15 s, no errors
netDown = true;
const samplesBefore = hw.state().ride.samples;
for (let i = 0; i < 5; i++) hw.backend.tick();
await sleep(2200);
out.netDown = { ride: hw.state().ride?.started, samples: hw.state().ride.samples - samplesBefore };
netDown = false;
// ending the ride stops presence (one stop call), the strip hides
for (let i = 0; i < 60; i++) hw.backend.tick();
await ctl({ action: 'end' });
await until(() => !hw.state().ride, 'ended 2');
await until(() => socialCalls().includes('POST /api/social/presence/stop'), 'stop sent');
await sleep(1200);
out.ended = { strip: $('#socRide').style.display, riders: hw.social.riders().length };
// the finished ride goes to friends: Bob sees it and gives a ride-on
await until(async () => (await bob.get('/api/social')).activity.length === 1, 'activity posted');
const act = (await bob.get('/api/social')).activity[0];
out.activity = [act.name, act.title, act.secs >= 60, act.mine];
await bob.post(`/api/social/activity/${act.id}/rideon`, {});
hw.social.open('main');
await until(() => $('#socList').innerHTML.includes('ride-on'), 'activity listed');
out.activityHtml = $('#socList').innerHTML;
hw.social.close();

/* ---------- 5. group ride: create, lobby, auto load and start at the time, chat on the ride screen ---------- */
const local = t => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
hw.social.open('new');
out.newForm = $('#socBody').innerHTML;
// datetime-local has minutes only: create for later, then Bob joins; a second one starts in a few seconds via the API
const g1 = await hw.social.create({ name: 'Tuesday spin', start: 'c:r-hawk', at: local(Date.now() + 3600e3), workout: '', invite: [bobId] });
out.created = g1 && [g1.name, g1.plan.kind, g1.plan.id];
await until(() => hw.social.state().viewData?.g, 'lobby');
out.lobby = { title: $('#socTitle').textContent, html: $('#socLobby').innerHTML };
out.bobInvited = (await bob.get('/api/social')).groups.map(g => [g.name, g.state]);
const g2 = (await hw.account.api('POST', '/api/social/groups', { name: 'Right now', plan: { kind: 'course', id: 'r-hawk', name: 'Hawk Hill, Marin' }, at: Date.now() + 4000, invite: [bobId] })).body.group;
await bob.post(`/api/social/groups/${g2.id}/join`, {});
hw.social.open('group', { id: g2.id });
await until(() => hw.social.state().viewData?.g?.group.id === g2.id, 'lobby 2');
out.lobby2 = $('#socLobby').innerHTML;
await hw.social.groupAct('garm');
out.armed = hw.social.state().armed === g2.id;
hw.social.close();
await until(() => hw.state().ride?.name === 'Hawk Hill, Marin', 'group ride loaded', 8000);
out.loadedEarly = !hw.state().ride.started;
await until(() => hw.state().ride?.started, 'group ride started at the time', 10000);
for (let i = 0; i < 5; i++) hw.backend.tick();
await bob.post('/api/social/presence', { open: false, course: HAWK, cid: 'r-hawk', d: 120, w: 260, group: g2.id });
await bob.post('/api/social/chat/send', { group: g2.id, body: 'Go go go' });
await until(() => $('#socMsgs').innerHTML.includes('Go go go'), 'group chat on the ride screen', 8000);
await until(() => $('#socGrp').innerHTML.includes('Bob'), 'group strip', 8000);
out.groupRide = { grp: $('#socGrp').innerHTML, msgs: $('#socMsgs').innerHTML, chat: $('#socChatBox').style.display, here: $('#socHere').textContent, mates: hw.social.riders().map(r => [r.name, r.group]) };
out.said = await hw.social.sayRide('On your wheel');
out.bobReads = (await bob.post('/api/social/chat/read', { group: g2.id, since: 0 })).messages.map(m => [m.name, m.body]);
await ctl({ action: 'end' });
await until(() => !hw.state().ride, 'ended 3');

/* ---------- 5b. Ready survives a reload: stored per group until the start, the new page arms and starts it ---------- */
const g3 = (await hw.account.api('POST', '/api/social/groups', { name: 'After reload', plan: { kind: 'course', id: 'r-hawk', name: 'Hawk Hill, Marin' }, at: Date.now() + 5000, invite: [] })).body.group;
hw.social.open('group', { id: g3.id });
await until(() => hw.social.state().viewData?.g?.group.id === g3.id, 'lobby 3');
await hw.social.groupAct('garm');
hw.social.close();
const stored = JSON.parse(localStorage.getItem('jw.groupReady') || 'null');
const oldHw = hw; oldHw.account.me = () => null;  // the old page is gone
await boot(51);
await until(() => hw.social?.state().armed === g3.id, 'ready restored after reload', 8000);
await until(() => hw.state().ride?.started, 'restored group ride started at the time', 12000);
out.reloadReady = { stored: stored && [stored.id === g3.id, stored.at === g3.at, typeof stored.uid], armed: true, started: true, after: localStorage.getItem('jw.groupReady') };
await ctl({ action: 'end' });
await until(() => !hw.state().ride, 'ended 4');
// expired or another account: dropped, nothing armed
localStorage.setItem('jw.groupReady', JSON.stringify({ id: g3.id, at: Date.now() - 120000, uid: stored.uid }));
await boot(52);
await until(() => hw.social?.state().profile, 'profile 52');
await sleep(300);
out.expiredReady = { armed: hw.social.state().armed, kept: localStorage.getItem('jw.groupReady') };

/* ---------- 6. share links: ?friend=CODE sends a request, ?group=ID opens the lobby; the URL is cleaned ---------- */
const catCode = (await cat.get('/api/social/me')).code;
await cat.post('/api/social/friends/remove', { id: (await hw.account.api('GET', '/api/auth/me')).body.user.id });
await boot(6, `?friend=${catCode}&group=${g1.id}`);
await until(() => hw.social?.state().view === 'group', 'group link opens the lobby');
await until(async () => (await cat.get('/api/social')).incoming.length === 1, 'friend link request');
out.links = { stripped: replaced.at(-1), view: hw.social.state().view, toast: $('#toast').textContent };

/* ---------- 7. sign out: no more social calls during a ride ---------- */
hw.social.close();
await hw.account.signOut();
const nOut = socialCalls().length;
await ctl({ action: 'load', workout: null, course: hw.courses.byId('r-hawk') });
await ctl({ action: 'start' });
for (let i = 0; i < 5; i++) hw.backend.tick();
await sleep(2500);
out.afterSignOut = { calls: socialCalls().length - nOut, strip: $('#socRide').style.display };
process.stdout.write(JSON.stringify(out));
process.exit(0);
