// Browser UI. The local server owns the trainer, HR strap and the ride (see server/openspin/engine.py),
// so this page only renders state from /api/stream and sends controls. Reloading or closing it never
// interrupts a ride. Pure logic (workout format, summaries, FIT/TCX) lives in core.js.
import {
  fmtT, esc, ZONES, zoneIdx, HRZ_COLORS, hrZone as hrZoneOf, parseWorkout, toText, compile, stepAt, stepWatts,
  estimate, toZwo as toZwoCore, PRESETS, FTP_TESTS, testKind, summarize, fitEncode, toTcx,
  activeHrZones, validHrFloors, HR_MAX_DEFAULT, weightShow, weightKg, weightUnit, distText,
} from './core.js';
import { MODE } from './mode.js';
import { drawChart as drawChartOn, drawBlocks, maxTarget } from './chart.js';
import { createBuilder } from './builder.js';
import { LIBRARY, CATEGORIES } from './library.js';
import { createCourses } from './courses.js';

// One codebase, two backends: the local python server, or (web build) an in-page backend with the
// ride engine, Web Bluetooth and IndexedDB that answers the same /api/* requests.
const WEB = MODE === 'web';
const WB = WEB ? await import('./web/backend.js') : null;
const B = WB ? await WB.createWebBackend(globalThis.__openspinWeb || {}) : null;  // tests pass { tickMs: 0, store }
const F = B ? (p, o) => B.fetch(p, o) : (p, o) => globalThis.fetch(p, o);
const ES = B ? WB.makeEventSource(B) : globalThis.EventSource;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
// Settings live on the server (agents read the athlete profile there); localStorage is only migrated once.
const settings = Object.assign({ ftp: 200, weight: 0, beeps: true, autoGarmin: false, cadRange: [85, 95], voiceMode: 'all', units: 'imperial' }, store.get('hw.settings', {}));
let garminOn = false;
const api = (path, body) => F(path, { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const apiJson = async (path, body) => { const r = await api(path, body); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
function saveSettings(keys) {
  store.set('hw.settings', settings);
  const patch = {}; for (const k of keys || Object.keys(settings)) patch[k] = settings[k];
  api('/api/settings', patch).catch(() => {});
}
async function loadSettings() {
  try {
    const j = await (await F('/api/settings')).json();
    garminOn = !!j.garmin;
    if (j.stored) Object.assign(settings, j.settings);
    else saveSettings(['ftp', 'weight', 'beeps', 'autoGarmin', 'hrZones', 'hrMax', 'hrZonesSrc', 'cadRange', 'voiceMode', 'units']);
    if (!garminOn) settings.autoGarmin = false;
    store.set('hw.settings', settings);
  } catch {}
  showSettings();
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const zoneColor = f => css(ZONES[zoneIdx(f)][1]);
const hrZ = () => activeHrZones(settings);  // manual, Garmin or % of max HR
const hrZone = h => hrZoneOf(h, hrZ().floors);

let custom = store.get('hw.custom', []);
const allWorkouts = () => [...custom, ...LIBRARY];

/* ---------- canvas ---------- */
function fit(cv) {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const c = cv.getContext('2d'); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, r.width, r.height);
  return [c, r.width, r.height];
}
// charts live in chart.js (pure canvas drawing, decimated for long rides)
function drawThumb(cv, cw, ftp) {
  const [c, w, h] = fit(cv); const yMax = Math.max(maxTarget(cw, ftp) * 1.08, ftp * 1.2);
  drawBlocks(c, cw, ftp, t => t / cw.total * w, v => h - v / yMax * h, 0.9, 1, css);
  c.strokeStyle = 'rgba(255,255,255,.18)'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, h - ftp / yMax * h); c.lineTo(w, h - ftp / yMax * h); c.stroke(); c.setLineDash([]);
}
function drawChart(cv, o, box) {
  const [c, w, h] = box || fit(cv);
  o.hoverT = hoverT.get(cv) ?? null;
  const n = drawChartOn(c, w, h, o, css);
  chartOpts.set(cv, o);
  return n;
}
// hover (or touch) a chart to read the numbers at that moment
const hoverT = new WeakMap(), chartOpts = new WeakMap();
function hoverable(cv) {
  const at = e => { const o = chartOpts.get(cv); if (!o?.geom) return null; const r = cv.getBoundingClientRect(), g = o.geom; return (e.clientX - r.left - g.L) / g.pw * g.total; };
  const redraw = () => { const o = chartOpts.get(cv); if (o) drawChart(cv, o); };
  cv.onpointermove = e => { const t = at(e); if (t == null) return; hoverT.set(cv, t); redraw(); };
  cv.onpointerleave = () => { hoverT.delete(cv); redraw(); };
}
hoverable($('#rideChart')); hoverable($('#sumChart'));
const courses = createCourses({ $, store, toast, fit, css, units: () => settings.units, ride: c => loadRide(null, c) });

/* ---------- library + builder ---------- */
// library filters are a per-browser convenience
const libF = Object.assign({ q: '', cat: '', dur: '', lvl: '' }, store.get('hw.libFilter', {}));
const compiled = new Map();
function cwOf(w) { const k = w.id + '|' + w.text; if (!compiled.has(k)) { try { compiled.set(k, compile(w)); } catch { compiled.set(k, null); } } return compiled.get(k); }
function libMatch(w, cw) {
  if (libF.cat === 'Mine' ? !w.id.startsWith('c-') : libF.cat && w.category !== libF.cat) return false;
  if (libF.dur) { const [lo, hi] = libF.dur.split('-').map(Number), m = cw.total / 60; if (m < lo || m >= hi) return false; }
  if (libF.lvl) { const [lo, hi] = libF.lvl.split('-').map(Number); if (!w.level || w.level < lo || w.level > hi) return false; }
  if (libF.q) { const q = libF.q.toLowerCase(); if (![w.name, w.category, w.purpose, ...(w.tags || [])].some(x => x && String(x).toLowerCase().includes(q))) return false; }
  return true;
}
function renderLibBar() {
  const cats = [['', 'All'], ...(custom.length ? [['Mine', 'Mine']] : []), ...CATEGORIES.map(c => [c, c])];
  $('#libCat').innerHTML = cats.map(([v, t]) => `<button class="chip${libF.cat === v ? ' on' : ''}" data-cat="${esc(v)}">${esc(t)}</button>`).join('');
  $('#libQ').value = libF.q; $('#libDur').value = libF.dur; $('#libLvl').value = libF.lvl;
}
const setLibF = patch => { Object.assign(libF, patch); store.set('hw.libFilter', libF); renderLibBar(); renderLib(); };
$('#libCat').onclick = e => { const b = e.target?.closest?.('[data-cat]'); if (b) setLibF({ cat: b.dataset.cat }); };
$('#libQ').oninput = e => { libF.q = e.target.value; store.set('hw.libFilter', libF); renderLib(); };
$('#libDur').onchange = e => setLibF({ dur: e.target.value });
$('#libLvl').onchange = e => setLibF({ lvl: e.target.value });
const lvlDots = n => n ? `<span class="lvl" title="Difficulty ${n} of 5">${[1, 2, 3, 4, 5].map(i => `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}</span>` : '';
let libSel = null;
function renderLib() {
  const ftp = settings.ftp, lib = $('#lib'); lib.innerHTML = ''; let shown = 0;
  for (const w of allWorkouts()) {
    const cw = cwOf(w); if (!cw || !libMatch(w, cw)) continue;
    shown++;
    const e = estimate(cw, ftp), mine = w.id.startsWith('c-');
    const row = document.createElement('div'); row.className = 'lrow' + (libSel === w.id ? ' sel' : '');
    row.innerHTML = `<canvas></canvas><div class="lmain"><div class="t">${esc(w.name)}</div>
      <div class="m num">${fmtT(cw.total)} · TSS ${Math.round(e.tss)} · ${mine ? 'mine' : esc(w.category || '')} ${lvlDots(w.level)}</div>
      ${w.purpose ? `<div class="p">${esc(w.purpose)}</div>` : ''}</div>
      <div class="lact"><button class="pri" data-a="ride">Ride</button><button data-a="edit">Edit</button></div>`;
    lib.appendChild(row);
    requestAnimationFrame(() => drawThumb(row.querySelector('canvas'), cw, ftp));
    row.onclick = ev => {
      const a = ev?.target?.closest?.('[data-a]')?.dataset.a;
      if (a === 'ride') return loadRide(w);
      if (a === 'edit') return editWorkout(w);
      libSel = libSel === w.id ? null : w.id; renderLib();
    };
    row.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); loadRide(w); };
    row.querySelector('[data-a=edit]').onclick = ev => { ev?.stopPropagation?.(); editWorkout(w); };
  }
  $('#libEmpty').style.display = shown ? 'none' : '';
}
renderLibBar();
let editing = null;
function editWorkout(w) {
  editing = w.id.startsWith('c-') ? w.id : null;
  $('#bName').value = editing ? w.name : w.name + (w.id.startsWith('p-') ? ' (mine)' : '');
  $('#bText').value = w.text; $('#bDel').style.display = editing ? '' : 'none';
  renderBuilder(); $('#bName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function builderWorkout() { return { id: editing || 'c-' + Date.now().toString(36), name: $('#bName').value.trim() || 'Untitled', text: $('#bText').value }; }
const builder = createBuilder({ list: $('#bList'), chart: $('#bChart'), palette: $('#bPal'), fit, css, ftp: () => settings.ftp, onEdit: text => { $('#bText').value = text; renderBuilder(); } });
function renderBuilder() {
  const w = builderWorkout(), ok = builder.load(w.text);
  try {
    const cw = compile(w), e = estimate(cw, settings.ftp);
    $('#bErr').textContent = ''; $('#bStats').textContent = `${fmtT(cw.total)} · TSS ${Math.round(e.tss)} · IF ${e.IF.toFixed(2)} · NP ${Math.round(e.np)} W`;
    builder.draw(); return cw;
  } catch (err) { $('#bErr').textContent = ok ? err.message : err.message + ' (blocks show the last valid version)'; $('#bStats').textContent = ''; builder.draw(); return null; }
}
$('#bText').oninput = renderBuilder;
$('#bUndo').onclick = () => { if (!builder.undo()) toast('Nothing to undo'); };
$('#bSave').onclick = () => {
  const w = builderWorkout(); if (!renderBuilder()) return;
  const i = custom.findIndex(x => x.id === w.id); i >= 0 ? custom[i] = w : custom.unshift(w);
  editing = w.id; $('#bDel').style.display = ''; store.set('hw.custom', custom); renderLibBar(); renderLib(); toast('Saved');
};
$('#bDel').onclick = () => { custom = custom.filter(x => x.id !== editing); store.set('hw.custom', custom); editing = null; $('#bDel').style.display = 'none'; renderLibBar(); renderLib(); toast('Deleted'); };
$('#bRide').onclick = () => { if (renderBuilder()) loadRide(builderWorkout()); };
$('#bZwo').onclick = () => { const cw = renderBuilder(); if (cw) download(cw.name.replace(/[^\w\- ]+/g, '') + '.zwo', toZwoCore(cw, settings.ftp), 'application/xml'); };
$('#bImport').onclick = () => $('#zwoFile').click();
$('#zwoFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { const { name, text } = fromZwo(await f.text()); editing = null; $('#bName').value = name; $('#bText').value = text; $('#bDel').style.display = 'none'; renderBuilder(); toast('Imported'); }
  catch (err) { toast('Import failed: ' + err.message); }
};
function fromZwo(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const wk = doc.querySelector('workout'); if (!wk) throw new Error('no <workout>');
  const n = (el, a) => parseFloat(el.getAttribute(a)), steps = [];
  for (const el of wk.children) {
    const t = el.tagName, d = Math.round(n(el, 'Duration'));
    if (t === 'SteadyState') { const p = el.hasAttribute('Power') ? n(el, 'Power') : (n(el, 'PowerLow') + n(el, 'PowerHigh')) / 2; steps.push({ d, a: p, b: p, u: '%' }); }
    else if (t === 'Warmup' || t === 'Cooldown' || t === 'Ramp') steps.push({ d, a: n(el, 'PowerLow'), b: n(el, 'PowerHigh'), u: '%' });
    else if (t === 'IntervalsT') {
      const on = el.hasAttribute('OnPower') ? n(el, 'OnPower') : n(el, 'PowerOnHigh'), off = el.hasAttribute('OffPower') ? n(el, 'OffPower') : n(el, 'PowerOffLow');
      for (let k = 0; k < (n(el, 'Repeat') || 1); k++) { steps.push({ d: Math.round(n(el, 'OnDuration')), a: on, b: on, u: '%' }); steps.push({ d: Math.round(n(el, 'OffDuration')), a: off, b: off, u: '%' }); }
    } else if (t === 'FreeRide' || t === 'MaxEffort') steps.push({ d, free: true });
  }
  if (!steps.length) throw new Error('no steps');
  return { name: doc.querySelector('name')?.textContent.trim() || 'Imported', text: toText(steps) };
}

/* ---------- server link: state stream in, controls out ---------- */
let S = null;            // latest server state
let samples = [];        // samples of the server's current ride
let rideId = null;
let V = null;            // view of the current ride: {cw, name, ftp, el, k, test, ...}
let cwKey = '';
let online = true;
const control = (action, extra = {}) => apiJson('/api/ride/control', { action, ...extra }).catch(e => { toast(e.message); throw e; });

function onLive(msg) {
  if (msg.reset) samples = msg.samples; else if (msg.samples.length) samples.push(...msg.samples);
  rideId = msg.ride_id;
  const prev = S; S = msg.state;
  setOnline(true);
  const r = S.ride;
  if (r) {
    // the server sends the live step list (coach overrides and mid-ride edits included); rebuild on change
    const key = JSON.stringify(r.steps?.map(s => [s.duration_s, s.free, s.planned]) ?? null);
    if (key !== cwKey || !V) {
      cwKey = key; let cw = null;
      if (r.steps) {
        let t = 0;
        const steps = r.steps.map(s => { const x = s.free ? { d: s.duration_s, free: true } : { d: s.duration_s, a: s.planned.a, b: s.planned.b, u: s.planned.unit }; x.t0 = t; t += x.d; return x; });
        cw = { name: r.name, text: r.text, steps, total: t };
      }
      V = { cw };
    }
    Object.assign(V, { name: r.name, ftp: r.ftp, el: r.el, k: r.intensity, test: r.test, started: r.started, paused: r.paused, auto: r.auto_paused, jr: r.jr, samples });
  } else { V = null; cwKey = ''; }
  if (!prev || !!prev.ride !== !!r) rideShell();
  // each server notice is shown once per browser; viewing never changes server state
  if (S.notice && S.notice_id && S.notice_id !== store.get('hw.noticeId', 0)) { toast(S.notice); store.set('hw.noticeId', S.notice_id); }
  coachUpdate();
  voiceUpdate();
  beeps();
  testGuide();
  if (prev && S.last_finished && S.last_finished.id !== prev.last_finished?.id) finishedRide(S.last_finished);
  setStatus(); renderLive(); renderMeter(); if (V) renderRide();
}
// live LLM usage: wakes counted by the server; tokens and cost when the agent reports them
const kfmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
function usageText(wakes, cues, u) {
  const tok = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].reduce((a, k) => a + (u?.[k] || 0), 0);
  let t = `Agent ${wakes ?? 0} wake${wakes === 1 ? '' : 's'}`;
  if (tok) t += ` · ${kfmt(tok)} tok`;
  if (u?.cost_usd) t += ` · $${u.cost_usd.toFixed(2)}`;
  if (cues) t += ` · ${cues} local cues`;
  return t;
}
function renderMeter() {
  const a = S?.ride?.agent, el = $('#agentMeter');
  // only once an agent has connected during this ride; built-in cues are counted in the ride summary
  const on = !!(a?.seen && S.ride.started);
  el.style.display = on ? '' : 'none'; el.setAttribute('aria-hidden', on ? 'false' : 'true');
  if (a?.seen) el.textContent = usageText(a.wakes, 0, a.usage);
}
function setOnline(on) {
  $('#srvState').setAttribute('aria-hidden', on ? 'true' : 'false');
  if (on === online) return; online = on;
  $('#srvState').style.display = on ? 'none' : '';
}
let es = null;
function connect() {
  if (!ES) return poll();
  es = new ES('/api/stream');
  es.onmessage = e => { try { onLive(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
  es.onerror = () => setOnline(false);  // EventSource reconnects by itself
}
async function poll() {  // fallback when EventSource is unavailable
  try { onLive(await (await F(`/api/live?ride=${rideId || ''}&n=${samples.length}`)).json()); } catch { setOnline(false); }
  setTimeout(poll, 1000);
}

/* ---------- devices (owned by the server) ---------- */
function setStatus() {
  const d = S?.devices || {}, mode = d.trainer || 'none';
  $('#tDot').className = 'dot ' + ({ ble: 'on', wait: 'wait', sim: 'sim' }[mode] || '');
  $('#tTxt').textContent = { none: 'Trainer off', wait: 'Connecting…', ble: d.trainer_name || 'Trainer', sim: 'Simulated' }[mode] || 'Trainer off';
  const again = d.reconnect?.trainer;  // web: after a reload the browser needs one click to reconnect
  $('#btnTrainer').textContent = mode === 'ble' || mode === 'wait' ? 'Disconnect' : again ? `Reconnect ${d.trainer_name || 'trainer'}` : 'Connect trainer';
  $('#btnTrainer').className = mode === 'ble' || mode === 'wait' ? '' : again ? 'pri reconnect' : 'pri';
  $('#hDot').className = 'dot ' + (d.hr ? 'on' : d.hr_waiting || d.hr_name ? 'wait' : '');
  $('#hTxt').textContent = d.hr ? `HR ${d.hr}` : d.hr_state === 'waiting_heartbeat' ? 'Strap found, waiting for heartbeat (wet the contacts)' : d.hr_state === 'connecting' ? 'HR connecting…' : d.hr_waiting || d.hr_name ? 'HR waiting' : 'HR off';
  $('#btnHR').textContent = d.hr_name ? 'Disconnect HR' : d.reconnect?.hr ? 'Reconnect HR' : 'Connect HR';
}
let devKind = 'trainer';
function openDevices(kind) {
  devKind = kind; $('#devTitle').textContent = kind === 'trainer' ? 'Trainer (FTMS)' : 'Heart rate strap';
  $('#devList').innerHTML = ''; $('#devModal').classList.add('on'); scanDevices();
}
async function scanDevices() {
  const list = $('#devList'); list.innerHTML = '<div class="hint">Scanning…</div>'; $('#devScan').disabled = true;
  try {
    const j = await apiJson('/api/devices', { action: 'scan', kind: devKind, timeout: 5 });
    list.innerHTML = j.devices.length ? '' : '<div class="hint">Nothing found. Pedal or wet the strap, then scan again.</div>';
    for (const d of j.devices) {
      const b = document.createElement('button');
      b.innerHTML = `<span>${esc(d.name)}</span><span class="m">${esc(d.rssi ?? '')} dBm</span>`;
      b.onclick = async () => {
        try { await apiJson('/api/devices', { action: 'connect', kind: devKind, address: d.address, name: d.name }); $('#devModal').classList.remove('on'); toast('Connecting ' + d.name); }
        catch (e) { toast('Connect failed: ' + e.message); }
      };
      list.appendChild(b);
    }
  } catch (e) { list.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  $('#devScan').disabled = false;
}
$('#devScan').onclick = scanDevices;
$('#devClose').onclick = () => $('#devModal').classList.remove('on');
$('#btnTrainer').onclick = () => {
  const m = S?.devices?.trainer;
  if (m === 'ble' || m === 'wait') apiJson('/api/devices', { action: 'disconnect', kind: 'trainer' }).catch(e => toast(e.message));
  else if (WEB) apiJson('/api/devices', { action: 'choose', kind: 'trainer' }).catch(e => { if (!/cancel/i.test(e.message)) toast(e.message); });  // browser chooser
  else openDevices('trainer');
};
$('#btnHR').onclick = () => {
  if (S?.devices?.hr_name) apiJson('/api/devices', { action: 'disconnect', kind: 'hr' }).catch(e => toast(e.message));
  else if (WEB) apiJson('/api/devices', { action: 'choose', kind: 'hr' }).catch(e => { if (!/cancel/i.test(e.message)) toast(e.message); });
  else openDevices('hr');
};

/* ---------- ride ---------- */
let loadArmed = 0;
function loadRide(w, course = w?.test ? null : courses.selected()) {  // the course in use, if any (never for FTP tests)
  // loading ends the ride in progress: a second tap within 4 s confirms
  if (S?.ride?.started && Date.now() - loadArmed > 4000) { loadArmed = Date.now(); toast('Ride in progress. Tap again to end it and load this.'); return; }
  loadArmed = 0;
  control('load', { workout: w ? { name: w.name, text: w.text, test: !!w.test } : null, course }).then(() => show('ride')).catch(() => {});
}
function rideShell() {
  const on = !!V;
  $('#rideEmpty').style.display = on ? 'none' : ''; $('#rideOn').style.display = on ? '' : 'none';
  if (on) { $('#jrMode').style.display = V.cw ? 'none' : ''; $$('.wk').forEach(el => { el.style.display = V.cw ? '' : 'none'; }); }
  else { sheet(false); undo = null; }
}
const curTarget = () => S?.ride?.target_w ?? null;
let actx = null;
function beep(f = 880, d = 0.09) {
  if (!settings.beeps) return;
  try { actx = actx || new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.08, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + d); o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d); } catch {}
}
let lastBeep = -1;
function beeps() {  // 3-2-1 countdown to the next step, computed from server state
  const r = S.ride;
  if (!r || !r.started || r.paused || !r.step || !V?.cw) return;
  const i = r.step.index - 1, left = Math.ceil(V.cw.steps[i].t0 + V.cw.steps[i].d - r.el);
  if (left <= 3 && left >= 1 && i < r.step.count - 1 && lastBeep !== i * 10 + left) { lastBeep = i * 10 + left; beep(left === 1 ? 1320 : 880, left === 1 ? 0.25 : 0.09); }
}
/* ---------- FTP test guide: prompts on screen and spoken, from the plan and the live samples ---------- */
const TG = { id: null, said: new Set(), low: 0, est: null };
const meanOver = (t0, t1) => { let s = 0, n = 0; for (const x of samples) if (x[1] >= t0 && x[1] < t1) { s += x[2]; n++; } return n ? s / n : 0; };
function bestMinute() { let best = 0, sum = 0; for (let i = 0; i < samples.length; i++) { sum += samples[i][2]; if (i >= 60) sum -= samples[i - 60][2]; if (i >= 59) best = Math.max(best, sum / 60); } return best; }
function testGuide() {
  const box = $('#testCue');
  if (!V?.test || !V.cw) { box.style.display = 'none'; return; }
  if (TG.id !== rideId) Object.assign(TG, { id: rideId, said: new Set(), low: 0, est: null });
  const once = (k, t) => { if (!TG.said.has(k)) { TG.said.add(k); if (V.started) say(t, true); } };
  const steps = V.cw.steps, kind = testKind(steps), at = stepAt(V.cw, V.el), left = at ? Math.round(at.s.d - at.into) : 0;
  let main = '', sub = '';
  if (!V.started) {
    main = kind === 'ramp' ? 'Ramp FTP test' : '20 minute FTP test';
    sub = kind === 'ramp' ? '5 min warm up, then +20 W a minute to failure.' : 'Warm up, 5 min hard, recover, 20 min all out.';
  } else if (kind === 'ramp') {
    const b = bestMinute(), est = Math.round(b * 0.75);
    if (!at || at.i === 0) {
      main = 'Warm up'; sub = at ? `Ramp starts in ${fmtT(left)}` : '';
      once('w', 'Warm up easy. The ramp starts in 5 minutes.');
      if (at && left <= 10) once('w10', 'Ramp starts in 10 seconds. Power goes up 20 watts every minute.');
    } else {
      const tgt = S.ride.target_w ?? stepWatts(at.s, 0, V.ftp);
      main = `${tgt} W · segment ${at.i}`; sub = `Best minute ${Math.round(b)} W · FTP ≈ ${est} W`;
      once('r' + at.i, `${tgt} watts`);
      // failure: under 60% of the target (or stopped) for 8 s ends the test
      const p3 = S.live?.power_3s || 0;
      if (V.paused || p3 < tgt * 0.6) TG.low ||= Date.now(); else TG.low = 0;
      if (TG.low && Date.now() - TG.low >= 8000 && !TG.said.has('end')) { once('end', `Test over. Your FTP is about ${est} watts.`); toast(`FTP ≈ ${est} W`); control('end').catch(() => {}); }
    }
  } else {
    const E = steps.findIndex(s => s.free && s.d >= 1200), eff = steps[E];
    const i = at ? at.i : steps.length;
    if (i < E - 2) {
      main = 'Warm up'; sub = `20 min effort in ${fmtT(eff.t0 - V.el)}`;
      once('w', 'Warm up easy. About 20 minutes, with a few short pickups.');
      if (!at.s.free && at.s.a >= 1 && at.s.d <= 60) once('s' + i, 'One minute faster.');
    } else if (i === E - 2) {
      main = '5 min hard'; sub = `${fmtT(left)} left · steady, not a sprint`;
      once('h', 'Five minutes hard. Steady, not a sprint.'); if (left <= 60) once('h1', 'One minute left.');
    } else if (i === E - 1) {
      main = 'Recover'; sub = `20 min effort in ${fmtT(left)}`;
      once('rec', 'Easy now. Ten minutes to recover.');
      if (left <= 60) once('rec1', 'One minute. In the effort, plus and minus or your gears set the resistance.');
      if (left <= 10) once('rec10', 'Ten seconds.');
    } else if (i === E) {
      const avg = Math.round(meanOver(eff.t0, eff.t0 + eff.d));
      main = `${fmtT(left)} left`; sub = `Avg ${avg} W · FTP ≈ ${Math.round(avg * 0.95)} W · + and − change resistance`;
      once('go', 'Go. Twenty minutes, as hard as you can hold steady. Start a little easy.');
      for (const q of [5, 10, 15]) if (at.into >= q * 60) once('q' + q, `${20 - q} minutes left. Average ${avg} watts.`);
      if (left <= 60) once('last', 'One minute left.');
    } else {
      TG.est ??= Math.round(meanOver(eff.t0, eff.t0 + eff.d) * 0.95);
      main = `FTP ≈ ${TG.est} W`; sub = 'Cool down. End the ride to save it and set FTP.';
      once('done', `Done. Your FTP is about ${TG.est} watts. Cool down easy.`);
    }
  }
  box.style.display = ''; $('#tcMain').textContent = main; $('#tcSub').textContent = sub;
}
let wakeLock = null;
async function wake(on) { try { if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch {} }

function renderLive() {
  const live = S?.live || {}, p3 = live.power_3s || 0;
  $('#lP').textContent = p3;
  let m = 0; for (const x of samples) m += (x[5] || 0) / 3.6;  // virtual distance from trainer speed, like the summary
  $('#lPs').textContent = (V ? distText(m / 1000, settings.units) : '') + (settings.weight > 0 ? (V ? ' · ' : '') + (p3 / settings.weight).toFixed(1) + ' W/kg' : '');
  const cad = live.cadence || 0, [lo, hi] = settings.cadRange || [85, 95];
  $('#lC').textContent = cad;
  $('#lCs').textContent = `target ${lo}-${hi} rpm`;
  $('#cadTile').style.setProperty('--hrc', !cad ? 'var(--line)' : cad >= lo && cad <= hi ? 'var(--good)' : cad >= lo - 8 && cad <= hi + 8 ? 'var(--warn)' : 'var(--bad)');
  $('#hrTile').style.display = S?.devices?.hr || S?.devices?.hr_name ? '' : 'none';  // no strap: no HR anywhere
  const hrNow = live.hr || 0, hz = hrZone(hrNow);
  $('#lH').textContent = hrNow || '–';
  $('#hrTile').style.setProperty('--hrc', hz >= 0 ? `var(${HRZ_COLORS[hz]})` : 'var(--line)');
  const hmax = hrZ().max;
  $('#lHs').innerHTML = hrNow ? (hz >= 0 ? `<span class="zn">Z${hz + 1}</span>` : 'below Z1') + (hmax ? ` · ${Math.round(hrNow / hmax * 100)}% max` : '') : 'bpm';
}
// "Interval 4 of 18" counts the efforts (local peaks at or above 80% FTP), not warm-up ramps or recoveries
function intervalText(cw, i, ftp) {
  const mid = s => s.free ? 0 : (stepWatts(s, 0, ftp) + stepWatts(s, s.d, ftp)) / 2 / ftp, st = cw.steps;
  const work = st.map((s, j) => !s.free && mid(s) >= 0.8 && mid(s) >= mid(st[j - 1] || { free: true }) && mid(s) >= mid(st[j + 1] || { free: true }) && (mid(s) > mid(st[j - 1] || { free: true }) || mid(s) > mid(st[j + 1] || { free: true })));
  const n = work.filter(Boolean).length;
  if (n < 2) return `Segment ${i + 1} of ${st.length}`;
  const k = work.slice(0, i + 1).filter(Boolean).length;
  return work[i] ? `Interval ${k} of ${n}` : k < n ? `Next: interval ${k + 1} of ${n}` : 'Intervals done';
}
function renderRide() {
  if (!V) return;
  const t = curTarget(), m = S.ride.control; $('#lT').textContent = t ?? '–';
  $('#lI').parentElement.style.display = V.cw ? '' : 'none';  // no workout: no interval tile
  $('#tgtTile').querySelector('.of').style.display = t == null || (V.jr.wm && V.jr.wm !== 'e') ? 'none' : '';  // free riding: just the power
  $('#lTs').textContent = !V.cw && S.ride.course ? '' : V.cw ? (V.jr.wm && V.jr.wm !== 'e' ? 'ERG off · ' + valText(m) : t != null ? Math.round(t / V.ftp * 100) + '% FTP' : 'free · ' + valText(m)) : m === 'w' ? 'ERG' : valText(m);
  $('#lE').textContent = fmtT(V.started ? samples.length : 0);  // time ridden (1 sample a second)
  $('#rName').textContent = V.name;
  const st = !V.started ? ['Ready', ''] : V.auto ? ['Start pedaling', 'warn'] : V.paused ? ['Paused', 'warn'] : S.ride.overtime ? ['Workout done · riding free', 'done'] : ['Riding', ''];
  $('#rState').textContent = st[0]; $('#rState').className = 'badge ' + st[1];
  $('#cStart').style.display = V.started ? 'none' : ''; $('#cPause').style.display = V.started ? '' : 'none';
  $('#cPause').textContent = V.paused && !V.auto ? 'Resume' : 'Pause';  // auto-paused: Pause makes it stick
  $('#cAdj').textContent = m === 'k' ? Math.round(V.k * 100) + '%' : m === 'w' ? V.jr.w + ' W' : valText(m).replace(/^\w/, c => c.toUpperCase());
  $('#adjBox').style.display = V.test && m === 'k' ? 'none' : '';  // an FTP test keeps its targets
  $$('#jrMode button').forEach(b => b.classList.toggle('on', b.dataset.m === V.jr.m));
  const kk = V.test ? 1 : V.k;
  if (V.cw) {
    const at = stepAt(V.cw, V.el) || { i: V.cw.steps.length - 1, s: V.cw.steps.at(-1), into: V.cw.steps.at(-1).d };
    $('#lI').textContent = fmtT(at.s.d - at.into); $('#lIs').textContent = intervalText(V.cw, at.i, V.ftp);
    $('#lEs').textContent = fmtT(V.cw.total - V.el) + ' left';
    $('#ivNow').textContent = at.s.a !== at.s.b && !at.s.free ? `Ramp to ${stepWatts(at.s, at.s.d, V.ftp, kk)} W` : '';
    const nx = V.cw.steps[at.i + 1];
    $('#ivNext').textContent = nx ? `Next: ${nx.free ? 'free' : stepWatts(nx, 0, V.ftp, kk) + ' W'} for ${fmtT(nx.d)}` : 'Last segment';
    $('#ivBar').style.width = (at.into / at.s.d * 100) + '%';
    $('#ivBar').style.background = at.s.free ? css('--z1') : zoneColor(stepWatts(at.s, at.into, V.ftp, V.k) / V.ftp);
  } else {
    $('#lI').textContent = '–'; $('#lIs').textContent = ''; $('#lEs').textContent = '';
    $('#ivNow').textContent = S.ride.course ? '' : V.jr.m === 'w' ? `ERG ${V.jr.w} W` : V.jr.m === 'r' ? `Resistance level ${(+V.jr.r).toFixed(1)}` : valText('g').replace(/^\w/, c => c.toUpperCase());  // a course shows its own grade under the chart
    $('#ivNext').textContent = ''; $('#ivBar').style.width = '0';
  }
  $('#rClock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const cwDraw = V.cw && V.el > V.cw.total ? { ...V.cw, total: V.el * 1.02 } : V.cw;
  if ($('#v-ride').classList.contains('on')) drawChart($('#rideChart'), { cw: cwDraw, ftp: V.ftp, samples, el: V.el, k: kk });
  wake(V.started);
  courses.renderRide(S.ride.course);
  renderAdjust(); renderUndo();
}
// on a course, grade mode follows the road; +/- adds an offset to it
const gradeText = () => { const c = S?.ride?.course, g = +V.jr.g; return c ? `road ${c.grade.toFixed(1)}%${g ? ` ${g > 0 ? '+' : ''}${g.toFixed(1)}` : ''}` : `grade ${g.toFixed(1)}%`; };
const valText = m => m === 'r' ? `level ${(+V.jr.r).toFixed(1)}` : m === 'w' ? `${V.jr.w} W` : gradeText();

/* ---------- ride controls: everything a coach or an agent can change, by hand, mid-ride ---------- */
// Each control is one request; the engine applies it at once, logs it as a MANUAL line (coaches see
// it and hold off) and echoes what changed. Cheap inverses become a 15 s Undo.
let undo = null;
function renderUndo() {
  const b = $('#cUndo'), on = !!undo && Date.now() < undo.until;
  if (!on) undo = null;
  b.style.display = on ? '' : 'none'; b.title = on ? `Undo ${undo.label} change (Z)` : 'Undo (Z)';
}
function doUndo() {
  const u = undo; if (!u || Date.now() > u.until) return;
  undo = null; renderUndo();
  Promise.resolve(u.run()).then(() => toast('Undone')).catch(() => {});
}
const didText = d => d.replace(/^target step (\d+) (\d+)W$/, 'Segment $1: $2 W').replace(/^skip step (\d+)$/, 'Skipped segment $1')
  .replace(/^back step (\d+)$/, 'Again: segment $1').replace(/^mode (\w+)$/, 'Trainer: $1').replace(/^erg (\d+)W$/, '$1 W').replace(/^\w/, c => c.toUpperCase());
function act(action, body = {}, undoLabel = null, inverse = null, say = null) {
  return control(action, body).then(j => {
    toast(say ? say(j) : j.did ? didText(j.did) : j.detail || 'Done');
    if (inverse) { undo = { label: undoLabel, run: inverse, until: Date.now() + 15000 }; renderUndo(); setTimeout(renderUndo, 15100); }
    flash(); return j;
  }).catch(() => {});
}
function flash() { for (const id of ['#adjBox', '#tgtTile']) { const el = $(id); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 700); } }
const R = () => S?.ride;
const curStep = () => R()?.step?.index ?? null;
// +/-: intensity in ERG, else the grade, watts or level the trainer follows
function plusMinus(dir, big) {
  const r = R(); if (!r) return;
  const m = r.control, d = dir * (big ? 5 : 1);
  if (m === 'k') { const k0 = r.intensity; return act('adjust', { dir, big }, 'intensity', () => control('intensity', { percent: Math.round(k0 * 100) })); }
  const v0 = r.jr[m]; return act('adjust', { dir: d > 0 ? 1 : -1, big }, m === 'w' ? 'watts' : m === 'r' ? 'level' : 'grade', () => control(m === 'w' ? 'target' : 'free', m === 'w' ? { w: v0 } : { m, value: v0 }));
}
function setIntensity(p) { const r = R(); if (!r) return; const k0 = r.intensity; return act('intensity', { percent: p }, 'intensity', () => control('intensity', { percent: Math.round(k0 * 100) })); }
function stepWattsBy(delta) {
  const r = R(); if (!r) return;
  if (!V.cw) return r.control === 'w' ? act('target', { delta }, 'watts', () => control('target', { w: r.jr.w })) : null;
  if (!r.step || r.step.free || r.target_w == null) { toast('No ERG target in this segment'); return; }
  const i = r.step.index, w0 = r.target_w;
  return act('target', { step: i, delta }, 'segment watts', () => control('target', { step: i, w: w0 }));
}
const timeSteps = d => d < 120 ? [5, 15] : d < 600 ? [15, 60] : [60, 300];  // small and big change for a segment this long
function stepTimeBy(sec) {
  const r = R(); if (!r?.step) { toast('Workout done'); return; }
  const i = r.step.index, d0 = r.step.duration_s;
  return act('edit', { edit: { op: 'extend', seconds: sec } }, 'segment time', () => control('edit', { edit: { op: 'duration', step: i, seconds: d0 } }),
    j => `Segment ${i}: ${j.detail?.match(/-> (\S+)$/)?.[1] ?? ''}`);
}
function setMode(m) {
  const r = R(); if (!r) return;
  if (V.cw) m = m === 'w' ? 'e' : m; else if (m === 'e') m = 'w';
  const m0 = V.cw ? (r.jr.wm || 'e') : r.jr.m;
  if (m === m0) return;
  return act('mode', { m }, 'trainer', () => control('mode', { m: m0 }));
}
const skipAct = () => V?.cw && act('skip');
const backAct = () => V?.cw && act('back');
const pauseAct = () => V && control(!V.started ? 'start' : V.paused && !V.auto ? 'resume' : 'hold').catch(() => {});
function setSetting(key, val, label) {
  const old = JSON.parse(JSON.stringify(settings[key] ?? null));
  settings[key] = val; saveSettings([key]); renderAdjust(); renderLive();
  undo = { label, run: () => { settings[key] = old; saveSettings([key]); renderAdjust(); renderLive(); }, until: Date.now() + 15000 }; renderUndo();
}
const lcOn = () => ({ ...LC_DEFAULTS, ...(settings.localCoach || {}) }).enabled;

$('#cStart').onclick = () => control('start').catch(() => {});
$('#cPause').onclick = pauseAct;
$('#cSkip').onclick = skipAct;
$('#cBack').onclick = backAct;
$('#cMinus').onclick = () => plusMinus(-1);
$('#cPlus').onclick = () => plusMinus(1);
$('#cUndo').onclick = doUndo;
$('#cMore').onclick = () => sheet();
$('#cKeys').onclick = () => $('#keysModal').classList.add('on');
$('#keysClose').onclick = () => $('#keysModal').classList.remove('on');
$('#keysModal').onclick = e => { if (e.target?.id === 'keysModal') $('#keysModal').classList.remove('on'); };

// the Adjust sheet: one tap opens it, one tap applies
let nextBase = null, nextDirty = false;
function sheet(on = !$('#adjPanel').classList.contains('on')) {
  $('#adjPanel').classList.toggle('on', !!on && !!V);
  if (on && V) { nextDirty = false; renderAdjust(); }
}
function nextText() {
  const r = R(); if (!V?.cw) return ['', null];
  if (!r.step) return ['', null];  // after the plan: anything typed here is added now
  return [toText(V.cw.steps.slice(r.step.index - 1).map(({ t0, ...x }) => x)), r.step.index];  // from the segment in progress
}
function renderAdjust() {
  if (!V || !$('#adjPanel').classList.contains('on')) return;
  const r = R(), m = r.control, wk = !!V.cw;
  const cur = wk ? (V.jr.wm || 'e') : V.jr.m;
  $$('#aMode button').forEach(b => { const v = b.dataset.v; b.style.display = (wk ? v !== 'w' : v !== 'e') ? '' : 'none'; b.classList.toggle('on', v === cur); });
  $('#rowMode').style.display = wk ? 'none' : '';  // in a workout ERG follows the plan; free segments use + and −
  $('#rowVal').style.display = m === 'k' || wk ? 'none' : '';
  $('#aValL').textContent = { g: 'Grade', w: 'Watts', r: 'Level' }[m] || '';
  $('#aVal').textContent = m === 'k' ? '' : valText(m).replace(/^(grade|level) /, '');
  if (!nextDirty) { const [txt, base] = nextText(); $('#aNext').value = txt; nextBase = base; $('#aNextErr').textContent = ''; nextBuilder.load(txt); nextBuilder.draw(); }
  else if (nextBase != null && curStep() !== nextBase) { $('#aNextErr').textContent = 'Segment changed. Reset to see the new plan.'; }
  const [lo, hi] = settings.cadRange || [85, 95];
  $('#aCadLo').textContent = lo; $('#aCadHi').textContent = hi;
}
$('#aNext').oninput = () => { nextDirty = true; $('#aNextErr').textContent = ''; nextBuilder.load($('#aNext').value); nextBuilder.draw(); };
const nextBuilder = createBuilder({ list: $('#aNextList'), chart: $('#aNextChart'), palette: $('#aNextPal'), fit, css, ftp: () => V?.ftp || settings.ftp,
  prefix: () => V?.cw && nextBase != null ? V.cw.steps.slice(0, nextBase - 1) : [], now: () => V?.el ?? null,
  onEdit: text => { $('#aNext').value = text; nextDirty = true; $('#aNextErr').textContent = ''; nextBuilder.draw(); } });
function applyNext() {
  const txt = $('#aNext').value.trim();
  if (txt) { try { parseWorkout(txt); } catch (e) { $('#aNextErr').textContent = e.message; return; } }
  const body = { op: 'rest', steps: txt, with_current: nextBase != null }; if (nextBase != null) body.after = nextBase;
  return control('edit', { edit: body }).then(j => { nextDirty = false; toast(txt ? `Plan set · ${fmtT(j.total_s)}` : 'Plan ends after this segment'); renderAdjust(); })
    .catch(e => { $('#aNextErr').textContent = e.message; });
}
$('#adjPanel').onclick = e => {
  const b = e.target?.closest?.('[data-a]'); if (!b || !V) return;
  const a = b.dataset.a, v = b.dataset.v;
  if (a === 'close') return sheet(false);
  if (a === 'int') return setIntensity(Math.max(50, Math.min(150, Math.round(V.k * 100) + +v)));
  if (a === 'int0') return setIntensity(100);
  if (a === 'tgt') return stepWattsBy(+v);
  if (a === 'ext') return stepTimeBy(+v);
  if (a === 'back') return backAct();
  if (a === 'skip') return skipAct();
  if (a === 'mode') return setMode(v);
  if (a === 'adj') return plusMinus(+v > 0 ? 1 : -1, Math.abs(+v) > 1);
  if (a === 'next') return applyNext();
  if (a === 'nextReset') { nextDirty = false; return renderAdjust(); }
  if (a === 'after') return setSetting('afterWorkout', v, 'after plan');
  if (a === 'cad') {
    const [i, d] = v.split(',').map(Number), cr = [...(settings.cadRange || [85, 95])];
    cr[i] = Math.max(40, Math.min(130, cr[i] + d));
    if (cr[0] >= cr[1]) return;
    return setSetting('cadRange', cr, 'cadence');
  }
  if (a === 'coach') return setSetting('localCoach', { ...(settings.localCoach || {}), enabled: v === '1' }, 'coach');
  if (a === 'beeps') return setSetting('beeps', v === '1', 'beeps');
};
// End needs a second tap within 3 s so a stray tap never ends the ride
let endArmed = 0;
$('#cEnd').onclick = () => {
  if (Date.now() - endArmed < 3000) { endArmed = 0; $('#cEnd').classList.remove('confirm'); $('#cEnd').textContent = 'End ride'; control('end').catch(() => {}); return; }
  endArmed = Date.now(); $('#cEnd').classList.add('confirm'); $('#cEnd').textContent = 'Tap again to end';
  setTimeout(() => { if (endArmed && Date.now() - endArmed >= 3000) { endArmed = 0; $('#cEnd').classList.remove('confirm'); $('#cEnd').textContent = 'End ride'; } }, 3100);
};
$$('#jrMode button').forEach(b => b.onclick = () => setMode(b.dataset.m));
// keyboard: documented in the "?" overlay (index.html #keysModal) and the README
const KEYS = {
  Space: pauseAct, ArrowUp: e => plusMinus(1, e.shiftKey), ArrowDown: e => plusMinus(-1, e.shiftKey),
  ArrowRight: skipAct, ArrowLeft: backAct, BracketRight: () => stepTimeBy(timeSteps(R()?.step?.duration_s ?? 600)[1]), BracketLeft: () => stepTimeBy(-timeSteps(R()?.step?.duration_s ?? 600)[1]),
  Equal: () => stepWattsBy(5), NumpadAdd: () => stepWattsBy(5), Minus: () => stepWattsBy(-5), NumpadSubtract: () => stepWattsBy(-5),
  Digit1: () => setMode('e'), Digit2: () => setMode('g'), Digit3: () => setMode('r'),
  KeyA: () => sheet(), KeyZ: doUndo, KeyM: () => $('#coachMute').click(),
};
function onKey(e) {
  if (e.key === 'Escape') { sheet(false); $('#keysModal').classList.remove('on'); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !typing && $('#v-workouts').classList.contains('on')) { e.preventDefault(); builder.undo(); return; }
  if (!V || typing) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); return doUndo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); return $('#keysModal').classList.toggle('on'); }
  const f = KEYS[e.code]; if (!f) return;
  e.preventDefault(); f(e);
}
document.addEventListener('keydown', onKey);
$$('[data-feel]').forEach(b => b.onclick = () => control('feel', { feel: b.dataset.feel }).then(() => toast('Sent: ' + b.dataset.feel)).catch(() => {}));

/* ---------- coach bar + voice (speech out; Whisper transcripts in) ---------- */
// The coach voice mode lives in server settings (voiceMode: all | important | silent), so the athlete
// can also change it by saying "mute" / "unmute" and agents can see it. Muted messages still show.
let spokenSeq = null, lastBarge = null, speakingN = 0, lastLoud = 'all';
const voiceMode = () => S?.voice?.mode || settings.voiceMode || 'all';
function bestVoice() {
  const vs = (window.speechSynthesis?.getVoices() || []).filter(v => v.lang.startsWith('en'));
  for (const re of [/Google US English/, /Natural/i, /Google UK English Male/, /Online/i, /en-US/]) { const v = vs.find(x => re.test(x.name) || re.test(x.lang)); if (v) return v; }
  return vs[0] || null;
}
const voicePost = event => api('/api/voice', { event }).catch(() => {});
function say(text, important) {
  const mode = voiceMode();
  if (!window.speechSynthesis || mode === 'silent' || (mode === 'important' && !important)) return;
  const u = new SpeechSynthesisUtterance(text); const v = bestVoice(); if (v) u.voice = v;
  // tell the listener the coach is talking, so its own echo is not taken as the athlete barging in
  u.onstart = () => { if (speakingN++ === 0) voicePost('tts_start'); };
  u.onend = u.onerror = () => { if (--speakingN <= 0) { speakingN = 0; voicePost('tts_end'); } };
  speechSynthesis.speak(u);
}
function hush() { try { window.speechSynthesis?.cancel(); } catch {} if (speakingN) { speakingN = 0; voicePost('tts_end'); } }
function setVoiceMode(m) {
  if (m !== 'silent') lastLoud = m;
  settings.voiceMode = m; if (S?.voice) S.voice.mode = m;
  saveSettings(['voiceMode']); renderVoice();
  if (m === 'silent') hush();
}
function renderVoice() {
  const m = voiceMode(), b = $('#coachMute');
  b.textContent = m === 'silent' ? 'Unmute' : 'Mute'; b.classList.toggle('muted', m === 'silent');
  $('#coachVerb').value = m;
}
$('#coachMute').onclick = () => setVoiceMode(voiceMode() === 'silent' ? lastLoud : 'silent');
$('#coachVerb').onchange = e => setVoiceMode(e.target.value);
// barge-in: the voice listener reports the athlete starting to speak; stop talking at once
function voiceUpdate() {
  const v = S.voice || {};
  if (lastBarge !== null && v.barge > lastBarge) hush();
  lastBarge = v.barge ?? 0;
  if (v.mode === 'silent' && speakingN) hush();
  renderVoice();
}
const hm = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function coachUpdate() {
  $('#coach').style.display = S.agent?.connected ? '' : 'none';  // the coach bar is for a connected agent only
  const ms = S.messages || [], top = ms.at(-1);
  if (top) {
    $('#coachMsg').textContent = top.msg; $('#coachMsg').title = top.msg;
    $('#coachPrev').innerHTML = ms.slice(0, -1).reverse().map(x => `<div title="${esc(x.msg)}">${hm(x.ts)} · ${esc(x.msg)}</div>`).join('');
  } else {  // new ride: nothing left over from the last one
    $('#coachMsg').textContent = 'Watching'; $('#coachMsg').title = ''; $('#coachPrev').innerHTML = '';
  }
  // only speak and flash messages that arrive while the page is open, never replay old ones
  const newest = top?.seq ?? 0;
  if (spokenSeq === null) spokenSeq = newest;
  else if (newest > spokenSeq) {
    for (const m of ms) if (m.seq > spokenSeq) say(m.msg, m.important);
    spokenSeq = newest; beep(1046, 0.12);
    $('#coach').classList.add('flash'); setTimeout(() => $('#coach').classList.remove('flash'), 4000);
  }
  const said = S.said || [];
  $('#coachSaid').innerHTML = said.length ? `You: <b>${esc(said[0].text)}</b>` + (said[1] ? ` · ${esc(said[1].text)}` : '') : '';
  $('#coachSaid').title = said.map(x => x.text).join('\n');
}
// tap the coach text to expand clamped messages, tap again to collapse
$('#coachMsg').parentElement.onclick = () => $('#coach').classList.toggle('open');

/* ---------- history (server archive is the source of truth) ---------- */
let rows = [];
async function renderHistory() {
  try { rows = (await (await F('/api/rides')).json()).rides; } catch { return; }
  const tb = $('#hist'); tb.innerHTML = '';
  $('#histEmpty').style.display = rows.length ? 'none' : '';
  document.body.classList.toggle('noagent', !rows.some(r => r.agent_wakes > 0));
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>${esc(r.name)}${r.garmin ? ' <span class="badge">Garmin</span>' : ''}${r.strava ? ' <span class="badge">Strava</span>' : ''}${r.test ? ' <span class="badge">test</span>' : ''}</td><td class="num">${esc(fmtT(r.time_s))}</td><td class="num">${esc(r.avg_w)}</td><td class="num">${esc(r.np)}</td><td class="num">${esc(r.tss)}</td><td class="num">${esc(r.kJ)}</td><td class="num">${esc(r.avg_hr ?? '–')}</td><td class="num">${esc(r.best?.['5m'] ?? '–')}</td><td class="num agentcol" title="agent wakes / tokens">${esc(r.agent_wakes ?? '–')}${r.agent_tokens ? ' · ' + esc(kfmt(r.agent_tokens)) : ''}</td>`;
    tr.onclick = () => openSummary(r.id); tb.appendChild(tr);
  }
  renderTrends();
}
async function renderTrends() {
  let t; try { t = await (await F('/api/trends?weeks=12')).json(); } catch { return; }
  const [c, w, h] = fit($('#trendChart')), wk = t.weeks, max = Math.max(50, ...wk.map(x => x.tss));
  const bw = w / wk.length;
  c.font = '11px system-ui'; c.textAlign = 'center'; c.textBaseline = 'bottom';
  wk.forEach((x, i) => {
    const bh = (h - 30) * x.tss / max;
    c.fillStyle = css('--acc'); c.fillRect(i * bw + 4, h - 16 - bh, bw - 8, bh);
    c.fillStyle = css('--dim'); if (x.tss) c.fillText(x.tss, i * bw + bw / 2, h - 18 - bh);
    c.fillStyle = css('--faint'); c.fillText(x.week.slice(5), i * bw + bw / 2, h);
  });
  const f = t.ftp_history.at(-1);
  $('#tFtp').textContent = f ? `FTP ${f.ftp} W (${f.source}, ${f.date})` + (t.ftp_history.length > 1 ? ` · was ${t.ftp_history.at(-2).ftp}` : '') : '';
  $('#tBest').innerHTML = ['1m', '5m', '20m'].map(k => `<div class="stat"><div class="k">Best ${k}</div><div class="v">${esc(t.best[k] ? t.best[k].w + ' W' : '–')}</div><div class="hint">${esc(t.best[k]?.date || '')}</div></div>`).join('')
    + `<div class="stat"><div class="k">TSS this week</div><div class="v">${esc(wk.at(-1).tss)}</div></div>`;
}
// one-time move of rides that only exist in this browser's storage into the server archive
async function migrateLocalRides() {
  if (store.get('hw.migrated', false)) return;
  const local = store.get('hw.rides', []);
  let ok = true;
  for (const r of local) { try { if (!(await api('/api/ride', r)).ok) ok = false; } catch { ok = false; } }
  if (ok) store.set('hw.migrated', true);
}
async function finishedRide(f) {
  beep(660, 0.4);
  show('history'); await renderHistory(); openSummary(f.id);
}
let openId = null, openRide = null;
async function openSummary(id) {
  let r, d;
  try { [r, d] = await Promise.all([(await F('/api/rides/' + id)).json(), (await F('/api/rides/' + id + '/detail')).json()]); } catch { return; }
  if (!r?.samples) return;
  openId = id; openRide = r; const m = d.summary;
  $('#summary').style.display = ''; $('#sName').textContent = r.name;
  $('#sDate').textContent = new Date(r.start || r.samples[0][0]).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // the four numbers people look for first, then the rest on one quiet line
  const elev = m.elevation_gain_m ?? m.elev_gain_m;
  const hero = [['Time', fmtT(m.time_s)], ...(!settings.hideVirtualDistance ? [['Distance', distText(m.distance_km, settings.units)]] : []),
    ['Avg power', m.avg_w + ' W'], ['Normalized', m.np + ' W']];
  if (elev > 0) hero.splice(2, 0, ['Elevation', settings.units === 'metric' ? Math.round(elev) + ' m' : Math.round(elev * 3.28084) + ' ft']);
  const rest = [['TSS', m.tss], ['IF', m.if.toFixed(2)], ['Max', m.max_w + ' W'], ['Work', m.kJ + ' kJ'], ['Cadence', m.avg_cad + ' rpm'],
    ...(m.avg_hr ? [['HR', `${m.avg_hr} avg · ${m.max_hr} max`]] : []),
    ['Best', ['1m', '5m', '20m'].filter(k => d.best[k]).map(k => `${k.replace('m', ' min')} ${d.best[k]} W`).join(' · ') || '–']];
  if (d.agent?.local_cues) rest.push(['Coach cues', d.agent.local_cues]);
  if (d.agent?.wakes > 0) rest.push(['Coach', usageText(d.agent.wakes, d.agent.local_cues, d.agent.usage).replace('Agent ', '')]);
  const heroHtml = hero.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const restHtml = rest.map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('');
  $('#sStats').innerHTML = `<div class="shero">${heroHtml}</div><div class="srest">${restHtml}</div>`;
  let cw = null;
  if (r.steps) { let t = 0; cw = { steps: r.steps.map(s => { const x = { ...s, t0: t }; t += s.d; return x; }) }; cw.total = r.steps.reduce((a, s) => a + s.d, 0); }
  else if (r.text) { try { cw = compile(r); for (const [i, w] of Object.entries(r.ov || {})) { const s = cw.steps[i]; if (s && !s.free) { [s.a, s.b] = Array.isArray(w) ? w : [w, w]; s.u = 'w'; } } } catch {} }
  if (cw && r.samples.at(-1)[1] > cw.total) cw.total = r.samples.at(-1)[1];  // free riding after the plan
  requestAnimationFrame(() => drawChart($('#sumChart'), { cw, ftp: r.ftp, samples: r.samples, el: null, k: 1 }));
  const zt = Object.values(d.power_zones_s), tot = zt.reduce((a, b) => a + b, 0) || 1;
  $('#sZones').innerHTML = zt.map((t, i) => `<i style="width:${t / tot * 100}%;background:var(${ZONES[i][1]})"></i>`).join('');
  $('#sZleg').innerHTML = zt.map((t, i) => `<span><b style="background:var(${ZONES[i][1]})"></b>${ZONES[i][2]} ${fmtT(t)}</span>`).join('');
  const tb = $('#sTest');
  if (d.ftp_estimate) {
    const est = d.ftp_estimate; tb.style.display = '';
    tb.innerHTML = `<span class="badge">FTP estimate <b class="num" style="color:var(--ink)">${esc(est)} W</b></span><button id="sSetFtp">Set FTP</button>`;
    $('#sSetFtp').onclick = () => { settings.ftp = est; saveSettings(['ftp']); $('#ftp').value = est; renderLib(); renderBuilder(); toast(`FTP set to ${est} W`); };
  } else tb.style.display = 'none';
  const hz = d.hr_zones_s ? Object.values(d.hr_zones_s) : null, hn = hz ? hz.reduce((a, b) => a + b, 0) : 0;
  $('#sHR').style.display = hn ? '' : 'none';
  if (hn) {
    const fl = hrZ().floors;
    $('#sHZones').innerHTML = hz.map((t, i) => `<i style="width:${t / hn * 100}%;background:var(${HRZ_COLORS[i]})"></i>`).join('');
    $('#sHZleg').innerHTML = hz.map((t, i) => `<span><b style="background:var(${HRZ_COLORS[i]})"></b>Z${i + 1} ${esc(fl[i])}+ · ${esc(fmtT(t))}</span>`).join('');
  }
  $('#sLaps').innerHTML = d.laps.map(l => `<tr><td>${esc(l.overtime ? 'free' : l.index)}</td><td class="num">${esc(fmtT(l.time_s))}</td><td class="num">${esc(l.target_w ?? (l.free ? 'free' : '–'))}</td><td class="num">${esc(l.avg_w)}</td><td class="num">${esc(l.max_w)}</td><td class="num">${esc(l.np)}</td><td class="num">${esc(l.avg_hr ?? '–')}</td><td class="num">${esc(l.max_hr ?? '–')}</td><td class="num">${esc(l.avg_cad ?? '–')}</td></tr>`).join('');
  const cls = l => /^COACH|^EDIT/.test(l) ? 'c' : /^SAID/.test(l) ? 's' : /^FEEL|^PAUSED/.test(l) ? 'f' : '';
  $('#sEvents').innerHTML = d.events.length ? d.events.map(([ts, l]) => `<div class="${cls(l)}">${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}  ${esc(l)}</div>`).join('') : '<div class="hint">No transcript for this ride.</div>';
  renderGarminBtn(d.garmin);
  renderStravaBtn(d.strava);
  $('#summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderGarminBtn(g) {
  const b = $('#sGarmin'); b.disabled = !garminOn && !g;
  b.title = garminOn ? '' : 'Garmin is disabled on this server';
  b.textContent = g ? 'On Garmin ✓' : 'Upload to Garmin'; b.className = g ? '' : 'pri'; b.dataset.g = g || '';
}
function renderStravaBtn(sid) {
  const b = $('#sStrava'); b.dataset.s = sid || '';
  b.textContent = sid ? 'On Strava ✓' : 'Upload to Strava';
  b.disabled = !sid && !strava.connected; b.title = strava.connected || sid ? '' : 'Connect Strava in Settings';
}
$('#sStrava').onclick = async () => {
  const sid = $('#sStrava').dataset.s;
  if (sid) { window.open(`https://www.strava.com/activities/${sid}`, '_blank'); return; }
  if (!openId) return;
  if (settings.autoGarmin && !confirmDup()) return;
  $('#sStrava').disabled = true; $('#sStrava').textContent = 'Uploading…';
  try { const j = await apiJson(`/api/rides/${openId}/strava`, {}); toast(j.duplicate ? 'Already on Strava' : 'Uploaded to Strava'); renderStravaBtn(j.activity_id); }
  catch (e) { toast('Strava upload failed: ' + e.message); renderStravaBtn(null); }
  renderHistory();
};
let dupWarned = false;
function confirmDup() {  // Garmin auto-sync to Strava + direct upload = duplicate activity
  if (dupWarned) return true;
  dupWarned = true; toast('Garmin may already sync this ride to Strava. Tap Upload again to send anyway.');
  return false;
}
async function uploadGarmin(id) {
  if (openId === id) { $('#sGarmin').disabled = true; $('#sGarmin').textContent = 'Uploading…'; }
  let g = null;
  try {
    const res = await api(`/api/rides/${id}/garmin`, {});
    const j = await res.json().catch(() => ({ error: 'no local server (run: openspin serve)' }));
    if (!j.ok) throw new Error(j.error || res.status);
    g = j.activityId || true; toast(j.duplicate ? 'Already on Garmin' : 'Uploaded to Garmin');
  } catch (e) { toast('Garmin upload failed: ' + e.message); }
  if (openId === id) renderGarminBtn(g);
  renderHistory();
}
$('#sGarmin').onclick = () => {
  const g = $('#sGarmin').dataset.g;
  if (g) window.open(/^\d+$/.test(g) ? `https://connect.garmin.com/modern/activity/${g}` : 'https://connect.garmin.com/modern/activities', '_blank');
  else if (openId) uploadGarmin(openId);
};
$('#sClose').onclick = () => { $('#summary').style.display = 'none'; openId = null; };
$('#sDel').onclick = async () => { if (!openId) return; await api(`/api/rides/${openId}/delete`, {}).catch(() => {}); $('#summary').style.display = 'none'; openId = null; renderHistory(); toast('Deleted (kept in rides/trash)'); };
const fileLink = async ext => {
  if (!openId) return;
  if (WEB) { const data = await B.exportFile(openId, ext); if (data) download(fileBaseOf(openRide) + '.' + ext, data, ext === 'fit' ? 'application/octet-stream' : 'application/xml'); return; }
  const a = document.createElement('a'); a.href = `/api/rides/${openId}/${ext}`; a.download = ''; a.click();
};
$('#sFit').onclick = () => fileLink('fit');
$('#sTcx').onclick = () => fileLink('tcx');
function download(name, data, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}


/* ---------- settings tab ---------- */
const LC_DEFAULTS = { enabled: !WEB,  // the web build starts with the coach off
  countdown: true, cadence: true, recap: true, recovery: true, auto_adjust: 'no_agent' };
let strava = {};
async function renderSettings() {
  const lc = { ...LC_DEFAULTS, ...(settings.localCoach || {}) }, cr = settings.cadRange || [85, 95];
  $('#cadLo').value = cr[0]; $('#cadHi').value = cr[1];
  $('#sFtp').value = settings.ftp; $('#sWeight').value = weightShow(settings.weight, settings.units);
  $('#units').value = settings.units || 'imperial'; showUnits();
  renderHrZones();
  $('#virtDist').value = settings.hideVirtualDistance ? '1' : '0';
  $$('[data-lc]').forEach(b => { b.checked = !!lc[b.dataset.lc]; });
  $('#lcAuto').value = lc.auto_adjust; $('#afterWk').value = settings.afterWorkout || 'hold';
  $('#autoGarmin2').value = settings.autoGarmin ? '1' : '0'; $('#autoGarmin2').disabled = !garminOn;
  $('#gImport').style.display = garminOn ? '' : 'none';
  $('#garminState').textContent = garminOn ? '' : 'Garmin is off on this server (see README: Garmin upload)';
  $('#shareBase').value = settings.shareBaseUrl || '';
  try { strava = await (await F('/api/strava/status')).json(); } catch { strava = {}; }
  const own = strava.mode === 'own';
  $('#stId').value = own ? strava.client_id || '' : '';
  $('#stSecret').value = ''; $('#stSecret').placeholder = strava.has_secret ? 'saved (hidden)' : 'paste once';
  $('#stOwnBox').open = own; $('#stShared').style.display = own ? '' : 'none';
  $('#stConnect').textContent = strava.connected ? 'Reconnect Strava' : 'Connect Strava';
  $('#stConnect').disabled = !strava.configured;
  $('#stState').textContent = strava.connected ? `Connected${strava.athlete?.name ? ' as ' + strava.athlete.name : ''}` : strava.configured ? 'Not connected' : 'Set up your own Strava API app below';
  $('#autoStrava').value = settings.autoStrava ? '1' : '0'; $('#autoStrava').disabled = !strava.connected;
  $('#stDup').classList.toggle('hot', !!(settings.autoGarmin && settings.autoStrava));
  $('#agentState').textContent = S?.agent?.connected ? 'Connected' : 'Not connected';
}
// Settings > Athlete and the Workouts tab shortcuts edit the same values
$('#sFtp').onchange = e => { $('#ftp').value = e.target.value; $('#ftp').onchange({ target: $('#ftp') }); renderSettings(); };
$('#sWeight').onchange = e => { $('#weight').value = e.target.value; $('#weight').onchange({ target: $('#weight') }); renderSettings(); };
$('#units').onchange = e => { settings.units = e.target.value === 'metric' ? 'metric' : 'imperial'; saveSettings(['units']); showSettings(); renderSettings(); };
function showUnits() { $$('.wUnit').forEach(x => { x.textContent = weightUnit(settings.units); }); courses.render(); }
// HR zones: % of max HR (default), Custom floors, or Garmin (local server with Garmin on)
function renderHrZones() {
  const z = hrZ();
  $('#hrMax').value = settings.hrMax || ''; $('#hrMax').placeholder = HR_MAX_DEFAULT;
  const g = $('#hrSrc option[value="garmin"]'); if (g) g.hidden = !garminOn && z.src !== 'garmin';
  $('#hrSrc').value = z.src;
  $$('[data-hz]').forEach(x => { x.value = z.floors[+x.dataset.hz]; });
}
const saveHr = () => { saveSettings(['hrZones', 'hrMax', 'hrZonesSrc']); renderHrZones(); };
$('#hrSrc').onchange = async e => {
  const v = e.target.value;
  if (v === 'garmin') {
    try {
      const j = await (await F('/api/garmin/zones')).json();
      if (!validHrFloors(j.floors)) throw new Error(j.error || 'no zones');
      settings.hrZones = j.floors; if (j.max) settings.hrMax = j.max;
    } catch (err) { toast('Garmin zones: ' + err.message); renderHrZones(); return; }
  } else if (v === 'manual') settings.hrZones = [...hrZ().floors];
  else settings.hrZones = null;
  settings.hrZonesSrc = v; saveHr();
};
$$('[data-hz]').forEach(x => x.onchange = () => {
  const v = $$('[data-hz]').map(i => +i.value);
  if (validHrFloors(v)) { settings.hrZones = v; settings.hrZonesSrc = 'manual'; saveHr(); }
  else { toast('Zones must rise'); renderHrZones(); }
});
$('#virtDist').onchange = e => { settings.hideVirtualDistance = e.target.value === '1'; saveSettings(['hideVirtualDistance']); };
const setLC = patch => { settings.localCoach = { ...(settings.localCoach || {}), ...patch }; saveSettings(['localCoach']); };
$$('[data-lc]').forEach(b => b.onchange = () => setLC({ [b.dataset.lc]: b.checked }));
$('#lcAuto').onchange = e => setLC({ auto_adjust: e.target.value });
$('#afterWk').onchange = e => { settings.afterWorkout = e.target.value; saveSettings(['afterWorkout']); };
const cadSave = () => { const lo = +$('#cadLo').value, hi = +$('#cadHi').value; if (lo >= 40 && hi > lo && hi <= 130) { settings.cadRange = [lo, hi]; saveSettings(['cadRange']); } else toast('Cadence range: low < high'); };
$('#cadLo').onchange = cadSave; $('#cadHi').onchange = cadSave;
$('#hrMax').onchange = e => {
  const v = +e.target.value;
  if (!e.target.value) settings.hrMax = null; else if (v >= 100 && v <= 230) settings.hrMax = Math.round(v); else { toast('Max HR: 100 to 230'); renderHrZones(); return; }
  saveHr();
};
$('#autoGarmin2').onchange = e => { settings.autoGarmin = e.target.value === '1'; saveSettings(['autoGarmin']); renderSettings(); };
$('#autoStrava').onchange = e => { settings.autoStrava = e.target.value === '1'; saveSettings(['autoStrava']); renderSettings(); };
$('#shareBase').onchange = e => { settings.shareBaseUrl = e.target.value.trim(); saveSettings(['shareBaseUrl']); };
$('#stSave').onclick = async () => {
  try { await apiJson('/api/strava/config', { client_id: $('#stId').value.trim(), client_secret: $('#stSecret').value.trim() }); toast('Strava app saved'); }
  catch (e) { toast('Strava: ' + e.message); }
  $('#stSecret').value = ''; renderSettings();
};
$('#stShared').onclick = async () => {
  try { await apiJson('/api/strava/shared', {}); toast("Using OpenSpin's Strava app. Connect again."); } catch (e) { toast('Strava: ' + e.message); }
  renderSettings();
};
$('#stConnect').onclick = async () => {
  if (!WEB) { location.href = '/api/strava/connect'; return; }
  try { location.href = (await apiJson('/api/strava/connect', {})).url; } catch (e) { toast('Strava: ' + e.message); }
};
$('#gImport').onclick = async () => {
  try {
    const j = await apiJson('/api/garmin/import', { force: true });
    const got = Object.keys(j.imported); toast(got.length ? 'Imported from Garmin: ' + got.join(', ') : 'Garmin had nothing new');
    await loadSettings(); renderSettings();
  } catch (e) { toast('Garmin import failed: ' + e.message); }
};
{ const u = new URLSearchParams(globalThis.location?.search || ''); if (u.get('strava') === 'connected') toast('Strava connected'); if (u.get('strava_error')) toast('Strava: ' + u.get('strava_error')); }

/* ---------- share card (rendered here; Strava's API cannot take photos) ---------- */
async function shareCard() {
  const r = openRide; if (!r) return null;
  const d = await (await F(`/api/rides/${r.id}/detail`)).json(), m = d.summary;
  const W = 1080, H = 1080, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#0c0e11'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#38bdf8'; c.font = '700 40px system-ui'; c.textBaseline = 'top'; c.fillText('OpenSpin', 60, 52);
  c.fillStyle = '#e9edf2'; c.font = '700 64px system-ui'; c.fillText(r.name.slice(0, 28), 60, 120);
  c.fillStyle = '#8b95a4'; c.font = '30px system-ui';
  c.fillText(new Date(r.start || r.samples[0][0]).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }), 60, 200);
  const st = [['Time', fmtT(m.time_s)], ['NP', m.np + ' W'], ['Avg', m.avg_w + ' W'], ['TSS', m.tss], ['IF', m.if.toFixed(2)], ['Work', m.kJ + ' kJ'], ['Avg HR', m.avg_hr ?? '–'], ['Max HR', m.max_hr ?? '–']];
  st.forEach(([k, v], i) => {
    const x = 60 + (i % 4) * 245, y = 270 + Math.floor(i / 4) * 130;
    c.fillStyle = '#8b95a4'; c.font = '600 24px system-ui'; c.fillText(k.toUpperCase(), x, y);
    c.fillStyle = '#e9edf2'; c.font = '700 54px system-ui'; c.fillText(String(v), x, y + 34);
  });
  let cw = null;
  if (r.steps) { let t = 0; cw = { steps: r.steps.map(s => { const x = { ...s, t0: t }; t += s.d; return x; }) }; cw.total = Math.max(t, r.samples.at(-1)[1]); }
  c.save(); c.translate(40, 560); c.font = '22px system-ui';
  drawChart(null, { cw, ftp: r.ftp, samples: r.samples, el: null, k: 1 }, [c, W - 80, 460]);
  c.restore();
  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}
$('#sCard').onclick = async () => {
  const blob = await shareCard(); if (!blob) return;
  const url = URL.createObjectURL(blob);
  $('#cardImg').src = url; $('#cardModal').classList.add('on');
  $('#cardDl').onclick = () => { const a = document.createElement('a'); a.href = url; a.download = fileBaseOf(openRide) + '.png'; a.click(); };
  $('#cardShare').style.display = navigator.canShare?.({ files: [new File([blob], 'ride.png', { type: 'image/png' })] }) ? '' : 'none';
  $('#cardShare').onclick = () => navigator.share({ files: [new File([blob], 'ride.png', { type: 'image/png' })], title: openRide.name }).catch(() => {});
  F(`/api/rides/${openRide.id}/card`, { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'image/png' }, body: blob }).catch(() => {});
};
$('#cardClose').onclick = () => $('#cardModal').classList.remove('on');
const fileBaseOf = r => `${new Date(r.start || r.samples[0][0]).toISOString().slice(0, 16).replace(/[:T]/g, '-')} ${r.name.replace(/[^\w\- ]+/g, '')}`;

/* ---------- web build only: backup ---------- */
if (WEB) {
  document.body.classList.add('web');
  if (!navigator.bluetooth) $('#webNotice').style.display = '';
  $('#bkExport').onclick = async () => { const j = await (await F('/api/backup')).json(); download(`openspin-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(j), 'application/json'); };
  $('#bkImport').onclick = () => $('#bkFile').click();
  $('#bkFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try { const j = await apiJson('/api/restore', JSON.parse(await f.text())); toast(`Imported ${j.rides} rides`); await loadSettings(); renderHistory(); } catch (err) { toast('Import failed: ' + err.message); }
  };
}

/* ---------- nav + settings + init ---------- */
function show(v) {
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (v === 'workouts') { renderLib(); renderBuilder(); }
  if (v === 'ride' && V) renderRide();
  if (v === 'history') renderHistory();
  if (v === 'settings') renderSettings();
}
$$('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
$$('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('#btnJust').onclick = $('#btnJust2').onclick = () => loadRide(null);
$('#btnFtp').onclick = () => $('#ftpModal').classList.add('on');
$('#ftpClose').onclick = () => $('#ftpModal').classList.remove('on');
$('#ftpModal').onclick = e => {
  if (e.target?.id === 'ftpModal') return $('#ftpModal').classList.remove('on');
  const b = e.target?.closest?.('[data-t]'); if (!b) return;
  $('#ftpModal').classList.remove('on'); loadRide(FTP_TESTS.find(t => t.id === b.dataset.t));
};
function showSettings() {
  $('#ftp').value = settings.ftp; $('#weight').value = weightShow(settings.weight, settings.units); showUnits(); $('#beeps').value = settings.beeps ? '1' : '0';
  renderLib(); renderBuilder();
}
$('#ftp').onchange = e => { const v = +e.target.value; if (v >= 50 && v <= 600) { settings.ftp = Math.round(v); settings.ftpSrc = 'manual'; saveSettings(['ftp', 'ftpSrc']); renderLib(); renderBuilder(); } };
$('#weight').onchange = e => { settings.weight = weightKg(e.target.value, settings.units); saveSettings(['weight']); };
$('#beeps').onchange = e => { settings.beeps = e.target.value === '1'; saveSettings(['beeps']); };
if (globalThis.location?.hash === '#settings') setTimeout(() => show('settings'), 0);

async function syncHrZones() {
  if (settings.hrZonesSrc !== 'garmin' || !garminOn) return;  // Garmin zones only when chosen in Settings
  try {
    const j = await (await F('/api/garmin/zones')).json();
    if (j.floors?.length === 5) { settings.hrZones = j.floors; settings.hrMax = j.max; settings.hrZonesSrc = 'garmin'; saveSettings(['hrZones', 'hrMax', 'hrZonesSrc']); showSettings(); }
  } catch {}
}
$('#bName').value = 'My workout'; $('#bText').value = '10m 45-75%, 4x(5m 100%, 3m 55%), 8m 50-40%';
renderVoice(); setStatus();
loadSettings().then(syncHrZones);
migrateLocalRides().then(renderHistory);
F('/api/strava/status').then(r => r.json()).then(j => { strava = j; }).catch(() => {});
connect();
const setHH = () => document.documentElement.style.setProperty('--hh', document.querySelector('header').offsetHeight + 'px');
setHH();
window.addEventListener('resize', () => { setHH(); if ($('#v-workouts').classList.contains('on')) renderLib(); if (V) renderRide(); });
window.__hw = { parseWorkout, toText, fitEncode, compile, summarize, state: () => S, backend: B, mode: MODE };
