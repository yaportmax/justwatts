// Web build with an account: boots dist-web/js/app.js under node with a stubbed DOM and IndexedDB (as in
// web_smoke.mjs), and a fetch that serves /api/auth, /api/sync, /api/community and /api/admin from the real
// handler (web/api/_lib, in-memory store) with a cookie jar. Resend and Strava are stubbed; nothing leaves
// the process. Usage: node account_web.mjs <repo> <dist-web dir>
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
  '[data-src]': ['lib', 'mine', 'comm'].map(src => new El('src', { src })),
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
const tap = (el, a = el) => el.onclick({ target: { closest: s => (s === '[data-a]' || s === '[data-adm]' ? a : null), id: '' } });
const out = {};
const synced = () => until(async () => { await hw.account.sync.flush(); return hw.account.sync.status === 'synced'; }, 'synced');

/* ---------- 1. accounts off on the server: no account UI, no community, the app works ---------- */
delete process.env.JUSTWATTS_SESSION_SECRET;
await boot(1);
await sleep(30);
out.off = { slot: $('#acctSlot').innerHTML, account: hw.account, comm: $('[data-src=comm]').style.display, setAccount: $('#set-account').style.display };
process.env.JUSTWATTS_SESSION_SECRET = ENV.JUSTWATTS_SESSION_SECRET;

/* ---------- 2. signed out, local data; sign up; connect step; sync merges local data ---------- */
mem.set('hw.custom', JSON.stringify([{ id: 'c-local1', name: 'Local over-unders', text: '3x(4m 95%, 2m 105%)' }]));
await boot(2);
await until(() => hw.account?.providers(), 'providers');
await hw.backend.store.putRide({ id: 'r-1790000000000', name: 'Old ride', start: 1790000000000, samples: Array.from({ length: 120 }, (_, i) => [1790000000000 + i * 1000, i, 180, 85, 0, 30]) });
out.signedOut = { slot: $('#acctSlot').innerHTML.includes('Sign in'), comm: $('[data-src=comm]').style.display, settings: $('#acctSet').innerHTML.includes('Sign in') };
tap($('#acctSlot'), { dataset: { a: 'signin' } });
out.dialog = { on: $('#authModal').classList.contains('on'), title: $('#authTitle').textContent, html: $('#authBody').innerHTML };
await hw.account.signUp('ann@example.com', 'password123', 'Ann');
out.connect = { step: hw.account.state().step, html: $('#authBody').innerHTML };
hw.account.dialogClick({ target: { id: '', closest: () => ({ dataset: { a: 'svc', s: 'garmin' } }) } });
out.connectTap = { closed: !$('#authModal').classList.contains('on'), settings: M['.view'].find(v => v.id === 'v-settings').classList.contains('on') };
await synced();
const dev2 = device(); await dev2.post('/api/auth/login', { email: 'ann@example.com', password: 'password123' });
let ch = await dev2.get('/api/sync/changes?since=0');
out.pushed = { records: ch.records.map(r => r.kind + ':' + r.id).sort(), workout: ch.records.find(r => r.id === 'c-local1')?.data, rides: ch.rides.map(r => [r.id, r.samples]) };
hw.account.menu(true);
out.menu = $('#acctSlot').innerHTML;
hw.account.menu(false);
out.settingsHtml = $('#acctSet').innerHTML;

/* ---------- 3. changes from another device arrive; settings wait for the ride; deletes propagate ---------- */
const t = Date.now();
await dev2.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-remote', data: { name: 'From the laptop', text: '20m 70%' }, updatedAt: t }, { kind: 'settings', id: 'main', data: { ftp: 280, units: 'metric' }, updatedAt: t }] });
const rr = { id: 'r-1790000500000', name: 'Laptop ride', start: 1790000500000, samples: Array.from({ length: 90 }, (_, i) => [1790000500000 + i * 1000, i, 200, 90]) };
assert.equal((await dev2.put(`/api/sync/rides/${rr.id}?updatedAt=${t}`, zlib.gzipSync(JSON.stringify(rr)))).status, 200);
await hw.account.sync.kick(0); await synced();
const lsCustom = () => JSON.parse(mem.get('hw.custom')).map(w => w.id);
out.pulled = { custom: lsCustom(), ftp: JSON.parse(mem.get('hw.settings')).ftp, units: JSON.parse(mem.get('hw.settings')).units, ride: (await hw.backend.store.getRide(rr.id))?.samples.length };
// a ride is loaded: settings from elsewhere wait, then apply when it ends
await hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify({ action: 'load', workout: { name: 'Hold', text: '10m 60%' } }) });
await until(() => hw.state().ride, 'ride loaded');
await dev2.post('/api/sync/push', { records: [{ kind: 'settings', id: 'main', data: { ftp: 300 }, updatedAt: Date.now() + 1 }, { kind: 'workout', id: 'c-remote', deleted: true, updatedAt: Date.now() + 1 }] });
await hw.account.sync.kick(0); await synced();
out.during = { ftp: JSON.parse(mem.get('hw.settings')).ftp, pending: hw.account.sync.state.pending?.data, custom: lsCustom() };
await hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify({ action: 'end' }) });
await until(() => !hw.state().ride, 'ride unloaded');
await until(() => JSON.parse(mem.get('hw.settings')).ftp === 300, 'pending settings applied');
out.after = { ftp: JSON.parse(mem.get('hw.settings')).ftp, pending: hw.account.sync.state.pending };
// a local settings change goes up
$('#sFtp').onchange({ target: { value: '310' } });
await sleep(10); await hw.account.sync.kick(0); await synced();
ch = await dev2.get('/api/sync/changes?since=0');
out.localEdit = ch.records.find(r => r.kind === 'settings').data.ftp;
// offline: the indicator says so, and the next try catches up
netDown = true; await hw.account.sync.kick(0);
out.offline = { status: hw.account.sync.status, slot: $('#acctSlot').innerHTML.includes('Offline') };
netDown = false; await hw.account.sync.kick(0); await synced();
out.backOnline = hw.account.sync.status;

/* ---------- 4. community: list, item page, like, comment, publish ---------- */
const pub = await hw.account.api('POST', '/api/community', { kind: 'workout', name: 'Sweet spot ladder', text: '10m 55%, 3x(10m 90%, 5m 55%), 5m 50%', tags: ['sweet spot'] });
assert.equal(pub.status, 201, JSON.stringify(pub.body));
await dev2.post(`/api/community/${pub.body.item.id}/comments`, { body: 'Great one' });
await until(() => hw.community, 'community module');
{ const b = M['[data-src]'].find(x => x.dataset.src === 'comm'); b.onclick(); }
const rowOf = name => made.findLast(e => e.className === 'lrow' && String(e.innerHTML).includes(`<div class="t">${name}</div>`));
await until(() => rowOf('Sweet spot ladder'), 'community row');
out.list = { tab: $('#tabComm').style.display, row: rowOf('Sweet spot ladder').innerHTML, head: $('#cmHead').innerHTML };
await hw.community.openItem(pub.body.item.id);
out.item = { pane: $('#commPane').style.display, html: $('#commPane').innerHTML };
await hw.community.itemAction('like');
await hw.community.comment('Did it twice');
out.liked = { likes: hw.community.detail().item.likes, liked: hw.community.detail().liked, comments: hw.community.detail().comments.map(c => c.body) };
await hw.community.rideItem(pub.body.item.id);
await until(() => hw.state().ride?.name === 'Sweet spot ladder', 'community ride loaded');
out.rode = (await hw.account.api('GET', `/api/community/${pub.body.item.id}`)).body.item.rides;
await hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify({ action: 'end' }) });
hw.community.openPublish({ kind: 'workout', name: 'Local over-unders', text: '3x(4m 95%, 2m 105%)' });
const item = await hw.community.publish('Local over-unders', 'vo2, Threshold');
out.published = { item: item && [item.name, item.tags], modal: $('#pubModal').classList.contains('on') };
hw.community.itemAction('back');
// a community course: its route on a small map above the profile, before it is saved
const hawk = hw.courses.byId('r-hawk');
const dan = device(); await dan.post('/api/auth/signup', { email: 'dan@example.com', password: 'password123', name: 'Dan' });
const pubC = await dan.post('/api/community', { kind: 'course', name: 'Hawk Hill loop', course: { name: hawk.name, dist: hawk.dist, gain: hawk.gain, ele: hawk.ele, ll: hawk.ll } });
assert.ok(pubC.item, JSON.stringify(pubC).slice(0, 200));
await hw.community.openItem(pubC.item.id);
await sleep(30);
out.courseItem = { map: $('#commPane').innerHTML.includes('id="cmMap"'), profile: $('#commPane').innerHTML.includes('id="cmChart"') };
hw.community.itemAction('back');

/* ---------- 5. sign out: the slot goes back to Sign in, local data stays ---------- */
await hw.account.signOut();
out.signedOutAgain = { slot: $('#acctSlot').innerHTML.includes('Sign in'), custom: lsCustom().length, sync: mem.get('hw.sync') };

/* ---------- 5b. another account on this device: ask before merging; the same account carries on ---------- */
const rideIds = async () => (await hw.backend.store.rideIds()).sort();
const tapDialog = a => hw.account.dialogClick({ target: { id: '', closest: () => ({ dataset: { a } }) } });
await hw.account.signIn('ann@example.com', 'password123');
await synced();
out.sameAgain = { step: hw.account.state().step, owner: mem.get('hw.sync.owner') === JSON.stringify(hw.account.me().user.id) };
await hw.account.signOut();
// Bob signs up here: Ann's data is on the device, so ask; the connect step waits for the answer
const nRides = (await rideIds()).length;
await hw.account.signUp('bob@example.com', 'password123', 'Bob');
await until(() => hw.account.state().step === 'device', 'merge question');
const bobDev = device(); await bobDev.post('/api/auth/login', { email: 'bob@example.com', password: 'password123' });
out.asked = { title: $('#authTitle').textContent, html: $('#authBody').innerHTML, status: hw.account.sync.status, server: (await bobDev.get('/api/sync/changes?since=0')).records.length };
tapDialog('dmerge');
out.afterMerge = { step: hw.account.state().step };
await synced();
ch = await bobDev.get('/api/sync/changes?since=0');
out.merged = { records: ch.records.map(r => r.kind + ':' + r.id).sort(), rides: ch.rides.length === nRides };
hw.account.close();
await hw.account.signOut();
// Cat: dismiss the question (nothing goes up, sync waits), Sync now asks again, Start clean
await hw.account.signUp('cat@example.com', 'password123', 'Cat');
await until(() => hw.account.state().step === 'device', 'merge question 2');
const catDev = device(); await catDev.post('/api/auth/login', { email: 'cat@example.com', password: 'password123' });
tapDialog('close');
await sleep(50);
out.dismissed = { status: hw.account.sync.status, error: hw.account.sync.error, step: hw.account.state().step, server: (await catDev.get('/api/sync/changes?since=0')).records.length };
hw.account.settingsAction('syncnow');
await until(() => hw.account.state().step === 'device', 'asked again');
tapDialog('dclean');
await synced();
ch = await catDev.get('/api/sync/changes?since=0');
out.clean = { custom: lsCustom().length, courses: JSON.parse(mem.get('hw.courses') || '[]').length, rides: (await rideIds()).length, server: ch.records.map(r => r.kind + ':' + r.id), serverRides: ch.rides.length, step: hw.account.state().step };
await hw.account.signOut();

/* ---------- 6. Strava sign-up: ask for an email once, then connect; the emailed link confirms it ---------- */
Object.assign(process.env, { STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' });
jar.clear(); athlete = 4242;
const st = await handle('GET', '/api/auth/strava/start?mode=login&return=/');
const state = new URL(st.headers.location).searchParams.get('state');
const cb = await handle('GET', `/api/auth/strava/callback?code=abcd1234&state=${state}`);
await boot(6, cb.headers.location.slice(1));
await until(() => hw.account?.me(), 'strava me');
await until(() => hw.account.state().step, 'first-run step');
out.strava = { back: cb.headers.location, step: hw.account.state().step, html: $('#authBody').innerHTML, stripped: replaced.at(-1) };
await hw.account.claimEmail('eddy@example.com');
out.claim = { step: hw.account.state().step, html: $('#authBody').innerHTML, mail: mails.at(-1)?.to };
const claimTok = /claim=([\w-]+)/.exec(mails.at(-1).text)[1];
await boot(7, '?claim=' + claimTok);
await until(() => hw.account?.me()?.user.email, 'claimed email');
out.claimed = { email: hw.account.me().user.email, verified: hw.account.me().user.verified, toast: $('#toast').textContent };
// OAuth errors open the dialog with the reason; the URL is cleaned
jar.clear();
await boot(8, '?provider=strava&auth=error&reason=strava_capped');
await until(() => hw.account?.state().step, 'error dialog');
out.oauthError = { step: hw.account.state().step, html: $('#authBody').innerHTML, stripped: replaced.at(-1) };
// a verify link signs in; a reset link asks for a new password
out.calls = [...new Set(calls)].length;
process.stdout.write(JSON.stringify(out));
process.exit(0);
