// Headless smoke test of app/js/app.js against a real justwatts test server (JUSTWATTS_SMOKE_PORT).
// Stubs only the DOM; fetch and the SSE stream go to the server. No browser, no Bluetooth.
// Mode "ride" (default): Sim, load, start, a target change, wait for the end, check History.
// Mode "boot": just boot and report what the page shows (used to test a reload mid-ride).
const PORT = process.env.JUSTWATTS_SMOKE_PORT, MODE = process.argv[2] || 'ride';
const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch;

class ClassList { constructor() { this.s = new Set(); } add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); } contains(c) { return this.s.has(c); } }
const ctx = new Proxy({}, { get: (t, k) => k in t ? t[k] : () => {}, set: (t, k, v) => { t[k] = v; return true; } });
class El {
  constructor(sel, data = {}) { this.sel = sel; this.dataset = data; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this.classList = new ClassList(); this.kids = {}; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.tagName = 'DIV'; this.width = 0; this.height = 0; this.offsetHeight = 50; }
  querySelector(s) { return this.kids[s] ??= new El(s); }
  get parentElement() { return this._parent ??= new El("parent"); }
  appendChild() {} scrollIntoView() {} addEventListener() {}
  setAttribute(k, v) { (this.attrs ??= {})[k] = v; }
  getBoundingClientRect() { return { width: 300, height: 100 }; }
  getContext() { return ctx; }
  click() { this.onclick?.(); }
}
const els = {};
const multi = {
  'nav button': ['workouts', 'ride', 'history'].map(v => new El('nav', { v })),
  '.view': ['workouts', 'ride', 'history'].map(v => Object.assign(new El('view'), { id: 'v-' + v })),
  '#jrMode button': ['g', 'w'].map(m => new El('jr', { m })),
};
globalThis.document = {
  querySelector: s => els[s] ??= new El(s),
  querySelectorAll: s => multi[s] || [],
  createElement: () => new El('new'),
  addEventListener() {}, documentElement: new El('html'), body: new El('body'), activeElement: { tagName: 'BODY' }, hidden: false,
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#38bdf8' });
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };

const posts = [];
globalThis.fetch = (path, opt = {}) => {
  const headers = { ...(opt.headers || {}) };
  if (opt.method === 'POST') { headers.Origin = BASE; posts.push({ path, body: typeof opt.body === 'string' ? JSON.parse(opt.body) : '(binary)' }); }
  return realFetch(BASE + path, { ...opt, headers });
};
let es = null;
globalThis.EventSource = class {
  constructor(url) {
    es = this; this.ctl = new AbortController();
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

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(20); }
}
const finish = out => { es?.close(); process.stdout.write(JSON.stringify(out)); process.exit(0); };

await import('../../app/js/app.js');
const S = () => window.__hw.state();
await until(() => S(), 'first state');

if (MODE === 'state') {  // boot at any moment: report what the page shows, touch nothing
  await sleep(300);
  finish({ ride: S().ride ? { name: S().ride.name, started: S().ride.started, paused: S().ride.paused, overtime: S().ride.overtime } : null,
           rideOn: $('#rideOn').style.display, rideEmpty: $('#rideEmpty').style.display, badge: String($('#rState').textContent),
           pause: String($('#cPause').textContent), start: $('#cStart').style.display, posts: posts.map(p => p.path + (p.body?.action ? ':' + p.body.action : '')) });
}
if (MODE === 'boot') {
  await until(() => S().ride && $('#rName').textContent, 'ride shown');
  await sleep(200);
  finish({ ride: S().ride.name, started: S().ride.started, rideOn: $('#rideOn').style.display, el: String($("#lE").textContent),
           tTxt: $('#tTxt').textContent, posts: posts.map(p => p.path) });
}

await fetch('/api/devices', { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sim', kind: 'trainer', on: true }) });
await until(() => S().devices.trainer === 'sim', 'sim on');
$('#bText').value = '1m 50%, 1m 100%';
$('#bName').value = 'Smoke';
$('#bRide').click();
await until(() => S().ride?.name === 'Smoke', 'ride loaded');
$('#cStart').click();
await until(() => S().ride?.started, 'started');
await until(() => S().ride && S().ride.el > 70, 'into step 2');
await fetch('/api/ride/control', { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'target', w: 230 }) });
await until(() => S().ride?.target_w === 230 && String($("#lT").textContent) === '230', 'target applied');
const offline = $('#srvState').attrs?.['aria-hidden'] ?? 'unset';
const during = { offline, target: String($("#lT").textContent), cad: $('#lCs').textContent, cadColor: $('#cadTile').style.props['--hrc'], tiles: $('#lP').textContent, interval: String($("#lIs").textContent) };
// the plan ends: the ride keeps going as a free ride until End (two taps)
await until(() => S().ride?.overtime, 'workout done');
const overBadge = $('#rState').textContent;
await fetch('/api/ride/control', { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save' }) });
await until(() => S().last_saved, 'saved copy');
$('#cEnd').click();
await sleep(100);
const stillRiding = !!S().ride;
$('#cEnd').click();
await until(() => S().last_finished, 'ride end');
await until(() => $('#sName').textContent === 'Smoke', 'summary opened');
await until(() => String($('#sLaps').innerHTML).includes('<tr>'), 'detail rendered');
const rides = (await (await fetch('/api/rides')).json()).rides;
const raw = await (await fetch('/api/rides/' + rides[0].id)).json();
finish({
  during, overBadge, stillRiding, sName: $('#sName').textContent,
  laps: String($('#sLaps').innerHTML).split('<tr>').length - 1,
  histRides: [{ id: raw.id, n: raw.samples.length, ov: raw.ov }],
  posts: posts.map(p => p.path + (p.body?.action ? ':' + p.body.action : '')), settings: JSON.parse(mem.get('hw.settings')),
});
