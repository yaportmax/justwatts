// Headless smoke test of app/js/app.js against a real justwatts test server (JUSTWATTS_SMOKE_PORT).
// Stubs only the DOM; fetch and the SSE stream go to the server. No browser, no Bluetooth.
// Mode "ride" (default): Sim, load, start, a target change, wait for the end, check History.
// Mode "boot": just boot and report what the page shows (used to test a reload mid-ride).
// Mode "pick": a workout with a course picked on its row, then a course with a workout picked on its row.
// Mode "connect": Settings > Integrations, the Upload panel with nothing connected, connect-with-ride, mixed
// upload states, the manual fallback and the Today row (Python stubs intervals.icu behind the test server).
const PORT = process.env.JUSTWATTS_SMOKE_PORT, MODE = process.argv[2] || 'ride';
const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch;

class ClassList { constructor() { this.s = new Set(); } add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); } contains(c) { return this.s.has(c); } }
const ctx = new Proxy({}, { get: (t, k) => k in t ? t[k] : () => {}, set: (t, k, v) => { t[k] = v; return true; } });
class El {
  constructor(sel, data = {}) { this.sel = sel; this.dataset = data; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this.classList = new ClassList(); this.kids = {}; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.tagName = 'DIV'; this.width = 0; this.height = 0; this.offsetHeight = 50; }
  querySelector(s) { return this.kids[s] ??= new El(s); }
  get parentElement() { return this._parent ??= new El("parent"); }
  appendChild() {} scrollIntoView() {} addEventListener() {} querySelectorAll() { return this.qsa || []; }
  setAttribute(k, v) { (this.attrs ??= {})[k] = v; }
  getBoundingClientRect() { return { width: 300, height: 100 }; }
  getContext() { return ctx; }
  click() { this.onclick?.(); }
}
const els = {}, made = [];  // made: elements the page created (list rows)
const multi = {
  'nav button': ['workouts', 'ride', 'history', 'settings'].map(v => new El('nav', { v })),
  '.view': ['workouts', 'ride', 'history', 'settings'].map(v => Object.assign(new El('view'), { id: 'v-' + v })),
  '#jrMode button': ['g', 'w'].map(m => new El('jr', { m })),
};
globalThis.document = {
  querySelector: s => els[s] ??= new El(s), getElementById: id => els['#' + id] ??= new El('#' + id),
  querySelectorAll: s => multi[s] || [],
  createElement: () => { const e = new El('new'); made.push(e); return e; },
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
  else headers['Sec-Fetch-Site'] = 'same-origin';  // what a browser adds to the page's own GET (it sends no Origin)
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

if (MODE === 'pick') {
  const rowOf = name => made.findLast(e => e.className?.startsWith('lrow') && String(e.innerHTML).includes(`<div class="t">${name}</div>`));
  const tap = el => el.onclick({ target: { closest: () => null } });
  const ride = () => ({ name: S().ride.name, course: S().ride.course?.name ?? null });
  const out = {};
  tap(rowOf('Sweet spot 2x12'));
  let row = rowOf('Sweet spot 2x12');
  row.querySelector('[data-a=pick]').onchange({ target: { value: 's-climb' } });
  row.querySelector('[data-a=ride]').onclick();
  await until(() => S().ride?.course?.name === 'The climb', 'workout + course');
  out.workoutCourse = ride();
  tap(rowOf('Rolling hills'));
  row = rowOf('Rolling hills');
  row.querySelector('[data-a=pick]').onchange({ target: { value: 'l-ss-2x12' } });
  row.querySelector('[data-a=ride]').onclick();
  await until(() => S().ride?.course?.name === 'Rolling hills', 'course + workout');
  out.courseWorkout = ride();
  finish({ ...out, posts: posts.filter(p => p.body?.action === 'load').map(p => ({ w: p.body.workout?.name ?? null, c: p.body.course?.id ?? null })) });
}

if (MODE === 'connect') {
  const KEY = process.env.JUSTWATTS_SMOKE_KEY, out = {};
  const nav = v => document.querySelectorAll('nav button').find(b => b.dataset.v === v).click();
  const tapIn = (sel, act, svc) => $(sel).onclick({ target: { closest: () => ({ dataset: { act, svc }, disabled: false }) } });
  const html = sel => String($(sel).innerHTML);
  const text = sel => html(sel).replace(/<[^>]+>/g, ' ').replace(/&#0?39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const order = h => [...h.matchAll(/data-svc="(\w+)"/g)].map(m => m[1]).filter((x, i, a) => a.indexOf(x) === i);
  // Settings > Integrations: Garmin first and recommended, unofficial note, manual-only services last
  nav('settings');
  await until(() => html('#intList').includes('data-svc="wahoo"'), 'integrations listed');
  const st = html('#intList');
  out.settings = { order: order(st), recommended: (st.match(/class="rec"/g) || []).length, garminRecommended: st.split('data-svc="strava"')[0].includes('Recommended'),
    note: text('#intList').includes("Unfortunately Garmin Connect doesn't allow official integrations, so we use a little workaround. It can break. If it does, upload the .fit file manually:"),
    manualHead: st.includes('Upload by hand'), connectButtons: (st.match(/data-conn="/g) || []).length, polar: st.includes('Polar Flow has no file import.') };
  // the ride summary with nothing connected: one Upload button, the Garmin nudge, the panel
  nav('history');
  const rideId = process.env.JUSTWATTS_SMOKE_RIDE;
  await until(() => made.some(e => String(e.innerHTML).includes('Smoke ride')), 'history row');
  made.find(e => String(e.innerHTML).includes('Smoke ride')).onclick();
  await until(() => $('#sName').textContent === 'Smoke ride' && $('#sUpload').textContent, 'summary');
  await until(() => $('#sNudge').style.display === '', 'nudge');
  out.summary0 = { button: $('#sUpload').textContent, cls: $('#sUpload').className, line: $('#sUpLine').style.display, nudge: $('#sNudge').style.display };
  $('#sUpload').onclick();
  const p0 = html('#upBody');
  out.panel0 = { on: $('#upPanel').classList.contains('on'), order: order(p0), fit: p0.includes('Download .fit'), steps: p0.includes('Drop the file in and click Import Data.'),
    link: p0.includes('href="https://connect.garmin.com/modern/import-data"'), connects: (p0.match(/data-act="connect"/g) || []).length, title: $('#upTitle').textContent };
  tapIn('#upBody', 'man', 'coros');
  out.manualCoros = html('#upBody').includes('Open COROS Training Hub') && html('#upBody').includes('Click Import Data and choose the file.');
  const before = made.length;
  tapIn('#upBody', 'fit');
  await until(() => made.slice(before).some(e => String(e.href || '').endsWith(`/api/rides/${rideId}/fit`)), 'fit download');
  out.fitHref = made.slice(before).find(e => e.href).href;
  // connect from the panel uploads this ride at once (connect with ride_id)
  tapIn('#upBody', 'connect', 'intervals');
  out.form = { open: $('#connModal').classList.contains('on'), title: $('#connTitle').textContent, fields: ['athlete_id', 'api_key'].every(n => html('#connBody').includes(`name="${n}"`)),
    keyIsPassword: /name="api_key" type="password"/.test(html('#connBody')), help: html('#connBody').includes('Developer Settings') };
  const inputs = [{ name: 'athlete_id', value: 'i123' }, { name: 'api_key', value: KEY }];
  $('#connBody').qsa = inputs;
  await $('#connGo').onclick();
  await until(() => !$('#connModal').classList.contains('on'), 'form closed');
  out.cleared = inputs.every(i => i.value === '');
  out.connectPost = posts.filter(p => p.path === '/api/integrations/intervals/connect').map(p => ({ ride: p.body.ride_id, hasKey: p.body.api_key === KEY }));
  await until(() => html('#sUpLine').includes('Uploaded'), 'uploaded line');
  out.summary1 = { button: $('#sUpload').textContent, cls: $('#sUpload').className, line: text('#sUpLine') };
  // mixed: a retry that fails for now (503), one the service refuses (blocked), one signed out (401)
  const states = [];
  for (const want of ['Retrying', 'Upload by hand', 'Reconnect']) {
    tapIn('#sUpLine', 'retry', 'intervals');
    await until(() => html('#sUpLine').includes(want), want);
    states.push({ line: text('#sUpLine'), button: $('#sUpload').textContent, panel: text('#upBody') });
  }
  out.states = states;
  tapIn('#sUpLine', 'manual', 'intervals');
  out.fallback = html('#upBody').includes('Open intervals.icu') && html('#upBody').includes('Click the upload arrow and drop the file in.');
  nav('settings');
  await until(() => html('#intList').includes('Signed out. Reconnect.'), 'settings reconnect');
  out.settingsReconnect = /data-svc="intervals".*?data-conn="intervals"/s.test(html('#intList'));
  // Today: intervals.icu has a planned ride; one click rides it
  nav('workouts');
  await until(() => made.some(e => e.className === 'lrow today'), 'today row');
  const today = made.findLast(e => e.className === 'lrow today');
  out.today = String(today.innerHTML).includes('Tempo') && String(today.innerHTML).includes('intervals.icu') && String(today.innerHTML).includes('>Today<');
  today.querySelector('[data-a=ride]').onclick();
  await until(() => S().ride?.name === 'Tempo', 'planned ride loaded');
  out.loaded = { name: S().ride.name, text: S().ride.text };
  out.leak = Object.values(els).some(e => String(e.innerHTML).includes(KEY) || String(e.textContent).includes(KEY)) || made.some(e => String(e.innerHTML).includes(KEY));
  finish(out);
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
