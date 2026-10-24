// Browser UI. The local server owns the trainer, HR strap and the ride (see server/openspin/engine.py),
// so this page only renders state from /api/stream and sends controls. Reloading or closing it never
// interrupts a ride. Pure logic (workout format, summaries, FIT/TCX) lives in core.js.
import {
  fmtT, esc, ZONES, zoneIdx, HRZ_COLORS, hrZone as hrZoneOf, parseWorkout, toText, compile, stepAt, stepWatts,
  estimate, toZwo as toZwoCore, PRESETS, summarize, fitEncode, toTcx,
} from './core.js';
import { MODE } from './mode.js';
import { drawChart as drawChartOn, drawBlocks, maxTarget } from './chart.js';

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
const settings = Object.assign({ ftp: 200, weight: 0, beeps: true, autoGarmin: false, cadRange: [85, 95], voiceMode: 'all' }, store.get('hw.settings', {}));
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
    else saveSettings(['ftp', 'weight', 'beeps', 'autoGarmin', 'hrZones', 'hrMax', 'hrZonesSrc', 'cadRange', 'voiceMode']);
    if (!garminOn) settings.autoGarmin = false;
    store.set('hw.settings', settings);
  } catch {}
  showSettings();
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const zoneColor = f => css(ZONES[zoneIdx(f)][1]);
const hrZone = h => hrZoneOf(h, settings.hrZones);

let custom = store.get('hw.custom', []);
const allWorkouts = () => [...custom, ...PRESETS];

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
  return drawChartOn(c, w, h, o, css);
}

/* ---------- library + builder ---------- */
function renderLib() {
  const ftp = settings.ftp, lib = $('#lib'); lib.innerHTML = '';
  for (const w of allWorkouts()) {
    let cw; try { cw = compile(w); } catch { continue; }
    const e = estimate(cw, ftp);
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<canvas></canvas><div><div class="t">${esc(w.name)}</div><div class="m num">${w.test ? 'until failure · ~' + fmtT(cw.total / 2) : fmtT(cw.total) + ' · TSS ' + Math.round(e.tss) + ' · IF ' + e.IF.toFixed(2)}${w.id.startsWith('c-') ? ' · custom' : ''}</div></div>
      <div class="row"><button class="pri" data-a="ride">Ride</button><button data-a="edit">Edit</button></div>`;
    lib.appendChild(card);
    requestAnimationFrame(() => drawThumb(card.querySelector('canvas'), cw, ftp));
    card.querySelector('[data-a=ride]').onclick = () => loadRide(w);
    card.querySelector('[data-a=edit]').onclick = () => editWorkout(w);
  }
}
let editing = null;
function editWorkout(w) {
  editing = w.id.startsWith('c-') ? w.id : null;
  $('#bName').value = editing ? w.name : w.name + (w.id.startsWith('p-') ? ' (mine)' : '');
  $('#bText').value = w.text; $('#bDel').style.display = editing ? '' : 'none';
  renderBuilder(); $('#bName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function builderWorkout() { return { id: editing || 'c-' + Date.now().toString(36), name: $('#bName').value.trim() || 'Untitled', text: $('#bText').value }; }
function renderBuilder() {
  const w = builderWorkout();
  try {
    const cw = compile(w), e = estimate(cw, settings.ftp);
    $('#bErr').textContent = ''; $('#bStats').textContent = `${fmtT(cw.total)} · TSS ${Math.round(e.tss)} · IF ${e.IF.toFixed(2)} · NP ${Math.round(e.np)} W`;
    drawThumb($('#bChart'), cw, settings.ftp); return cw;
  } catch (err) { $('#bErr').textContent = err.message; $('#bStats').textContent = ''; fit($('#bChart')); return null; }
}
$('#bText').oninput = renderBuilder;
$('#bSave').onclick = () => {
  const w = builderWorkout(); if (!renderBuilder()) return;
  const i = custom.findIndex(x => x.id === w.id); i >= 0 ? custom[i] = w : custom.unshift(w);
  editing = w.id; $('#bDel').style.display = ''; store.set('hw.custom', custom); renderLib(); toast('Saved');
};
$('#bDel').onclick = () => { custom = custom.filter(x => x.id !== editing); store.set('hw.custom', custom); editing = null; $('#bDel').style.display = 'none'; renderLib(); toast('Deleted'); };
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
  $('#btnSim').textContent = mode === 'sim' ? 'Stop sim' : 'Sim';
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
    list.innerHTML = j.devices.length ? '' : '<div class="hint">Nothing found. Wake the device (pedal, wet the strap) and scan again.</div>';
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
$('#btnSim').onclick = () => apiJson('/api/devices', { action: 'sim', kind: 'trainer', on: S?.devices?.trainer !== 'sim' }).catch(e => toast(e.message));

/* ---------- ride ---------- */
function loadRide(w) {
  control('load', { workout: w ? { name: w.name, text: w.text, test: !!w.test } : null }).then(() => show('ride')).catch(() => {});
}
function rideShell() {
  const on = !!V;
  $('#rideEmpty').style.display = on ? 'none' : ''; $('#rideOn').style.display = on ? '' : 'none';
  if (on) { $('#jrMode').style.display = V.cw ? 'none' : ''; $('#cSkip').style.display = V.cw ? '' : 'none'; }
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
let wakeLock = null;
async function wake(on) { try { if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch {} }

function renderLive() {
  const live = S?.live || {}, p3 = live.power_3s || 0;
  $('#lP').textContent = p3;
  $('#lPs').textContent = settings.weight > 0 ? (p3 / settings.weight).toFixed(1) + ' W/kg' : 'W';
  const cad = live.cadence || 0, [lo, hi] = settings.cadRange || [85, 95];
  $('#lC').textContent = cad;
  $('#lCs').textContent = `target ${lo}-${hi} rpm`;
  $('#cadTile').style.setProperty('--hrc', !cad ? 'var(--line)' : cad >= lo && cad <= hi ? 'var(--good)' : cad >= lo - 8 && cad <= hi + 8 ? 'var(--warn)' : 'var(--bad)');
  const hrNow = live.hr || 0, hz = hrZone(hrNow);
  $('#lH').textContent = hrNow || '–';
  $('#hrTile').style.setProperty('--hrc', hz >= 0 ? `var(${HRZ_COLORS[hz]})` : 'var(--line)');
  $('#lHs').innerHTML = hrNow && settings.hrZones ? (hz >= 0 ? `<span class="zn">Z${hz + 1}</span>` : 'below Z1') + (settings.hrMax ? ` · ${Math.round(hrNow / settings.hrMax * 100)}% max` : '') : 'bpm';
}
function renderRide() {
  if (!V) return;
  const t = curTarget(); $('#lT').textContent = t ?? '–';
  $('#lTs').textContent = V.cw ? (t != null ? Math.round(t / V.ftp * 100) + '% FTP' : 'free ride') : V.jr.m === 'w' ? 'ERG' : V.jr.m === 'r' ? `level ${V.jr.r}` : `grade ${V.jr.g}%`;
  $('#lE').textContent = fmtT(V.el);
  $('#rName').textContent = V.name;
  const st = !V.started ? ['Ready', ''] : V.auto ? ['Start pedaling', 'warn'] : V.paused ? ['Paused', 'warn'] : S.ride.overtime ? ['Workout done · riding free', 'done'] : ['Riding', ''];
  $('#rState').textContent = st[0]; $('#rState').className = 'badge ' + st[1];
  $('#cStart').style.display = V.started ? 'none' : ''; $('#cPause').style.display = V.started ? '' : 'none';
  $('#cPause').textContent = V.paused ? 'Resume' : 'Pause';
  $('#cSave').style.display = V.started ? '' : 'none';
  $('#lenAdj').style.display = V.cw ? '' : 'none';
  if (V.cw) $('#cLen').textContent = fmtT(S.ride.total_s);
  $('#cAdj').textContent = V.cw ? Math.round(V.k * 100) + '%' : V.jr.m === 'w' ? V.jr.w + ' W' : V.jr.m === 'r' ? 'Level ' + (+V.jr.r).toFixed(1) : (+V.jr.g).toFixed(1) + '%';
  $$('#jrMode button').forEach(b => b.classList.toggle('on', b.dataset.m === V.jr.m));
  const kk = V.test ? 1 : V.k;
  if (V.cw) {
    const at = stepAt(V.cw, V.el) || { i: V.cw.steps.length - 1, s: V.cw.steps.at(-1), into: V.cw.steps.at(-1).d };
    $('#lI').textContent = fmtT(at.s.d - at.into); $('#lIs').textContent = `${at.i + 1} / ${V.cw.steps.length}`;
    $('#lEs').textContent = fmtT(V.cw.total - V.el) + ' left';
    $('#ivNow').textContent = `${fmtT(at.s.d)} · ${at.s.free ? 'free' : stepWatts(at.s, 0, V.ftp, kk) + (at.s.a !== at.s.b ? '→' + stepWatts(at.s, at.s.d, V.ftp, kk) : '') + ' W'}`;
    const nx = V.cw.steps[at.i + 1];
    $('#ivNext').textContent = nx ? `Next ${fmtT(nx.d)} · ${nx.free ? 'free' : stepWatts(nx, 0, V.ftp, kk) + ' W'}` : 'Last interval';
    $('#ivBar').style.width = (at.into / at.s.d * 100) + '%';
    $('#ivBar').style.background = at.s.free ? css('--z1') : zoneColor(stepWatts(at.s, at.into, V.ftp, V.k) / V.ftp);
  } else {
    $('#lI').textContent = '–'; $('#lIs').textContent = ''; $('#lEs').textContent = '';
    $('#ivNow').textContent = V.jr.m === 'w' ? `ERG ${V.jr.w} W` : V.jr.m === 'r' ? `Resistance level ${(+V.jr.r).toFixed(1)}` : `Grade ${(+V.jr.g).toFixed(1)}%`; $('#ivNext').textContent = ''; $('#ivBar').style.width = '0';
  }
  $('#rClock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const cwDraw = V.cw && V.el > V.cw.total ? { ...V.cw, total: V.el * 1.02 } : V.cw;
  if ($('#v-ride').classList.contains('on')) drawChart($('#rideChart'), { cw: cwDraw, ftp: V.ftp, samples, el: V.el, k: kk });
  wake(V.started);
}
$('#cStart').onclick = () => control('start').catch(() => {});
$('#cPause').onclick = () => control(V?.paused ? 'resume' : 'hold').catch(() => {});
$('#cSave').onclick = () => control('save').then(j => toast(`Saved to History (${fmtT(j.samples)})`)).catch(() => {});
$('#cShorter').onclick = () => changeLength(-300);
$('#cLonger').onclick = () => changeLength(300);
function changeLength(d) {
  const r = S?.ride; if (!r?.total_s) return;
  control('edit', { edit: { op: 'total', seconds: Math.max(1, r.total_s + d), how: 'last' } }).then(() => toast(`Workout ${d > 0 ? 'longer' : 'shorter'}: ${fmtT(Math.max(r.el, r.total_s + d))}`)).catch(() => {});
}
$('#cSkip').onclick = () => control('skip').catch(() => {});
$('#cMinus').onclick = () => control('adjust', { dir: -1 }).catch(() => {});
$('#cPlus').onclick = () => control('adjust', { dir: 1 }).catch(() => {});
// End needs a second tap within 3 s so a stray tap never ends the ride
let endArmed = 0;
$('#cEnd').onclick = () => {
  if (Date.now() - endArmed < 3000) { endArmed = 0; $('#cEnd').classList.remove('confirm'); $('#cEnd').textContent = 'End ride'; control('end').catch(() => {}); return; }
  endArmed = Date.now(); $('#cEnd').classList.add('confirm'); $('#cEnd').textContent = 'Tap again to end';
  setTimeout(() => { if (endArmed && Date.now() - endArmed >= 3000) { endArmed = 0; $('#cEnd').classList.remove('confirm'); $('#cEnd').textContent = 'End ride'; } }, 3100);
};
$$('#jrMode button').forEach(b => b.onclick = () => control('mode', { m: b.dataset.m }).catch(() => {}));
document.addEventListener('keydown', e => {
  if (!V || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); control(!V.started ? 'start' : V.paused ? 'resume' : 'hold').catch(() => {}); }
  if (e.code === 'ArrowUp') { e.preventDefault(); control('adjust', { dir: 1 }).catch(() => {}); }
  if (e.code === 'ArrowDown') { e.preventDefault(); control('adjust', { dir: -1 }).catch(() => {}); }
});
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
  const st = [['Time', fmtT(m.time_s)], ['Avg power', m.avg_w + ' W'], ['NP', m.np + ' W'], ['Max', m.max_w + ' W'], ['IF', m.if.toFixed(2)], ['TSS', m.tss], ['Work', m.kJ + ' kJ'], ['Cadence', m.avg_cad + ' rpm'], ['Avg HR', m.avg_hr ?? '–'], ['Max HR', m.max_hr ?? '–'], ['Best 1/5/20', ['1m', '5m', '20m'].map(k => d.best[k] ?? '–').join('/')]];
  if (!settings.hideVirtualDistance) st.push(['Virtual distance', m.distance_km.toFixed(1) + ' km']);
  if (d.agent?.local_cues) st.push(['Built-in coach cues', d.agent.local_cues]);
  if (d.agent?.wakes > 0) st.push(['Coach usage', usageText(d.agent.wakes, d.agent.local_cues, d.agent.usage).replace('Agent ', '')]);
  $('#sStats').innerHTML = st.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  let cw = null;
  if (r.steps) { let t = 0; cw = { steps: r.steps.map(s => { const x = { ...s, t0: t }; t += s.d; return x; }) }; cw.total = r.steps.reduce((a, s) => a + s.d, 0); }
  else if (r.text) { try { cw = compile(r); for (const [i, w] of Object.entries(r.ov || {})) { const s = cw.steps[i]; if (s && !s.free) { s.a = s.b = w; s.u = 'w'; } } } catch {} }
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
    $('#sHZones').innerHTML = hz.map((t, i) => `<i style="width:${t / hn * 100}%;background:var(${HRZ_COLORS[i]})"></i>`).join('');
    $('#sHZleg').innerHTML = hz.map((t, i) => `<span><b style="background:var(${HRZ_COLORS[i]})"></b>Z${i + 1} ${esc(settings.hrZones[i])}+ · ${esc(fmtT(t))}</span>`).join('');
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
  dupWarned = true; toast('Garmin may already sync this ride to Strava. Tap Upload again to send it directly anyway.');
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
  $('#cadLo').value = cr[0]; $('#cadHi').value = cr[1]; $('#hrMax').value = settings.hrMax || '';
  $('#sFtp').value = settings.ftp; $('#sWeight').value = settings.weight || '';
  $('#sHrZones').value = settings.hrZones ? settings.hrZones.join(',') : '';
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
  $('#agentState').textContent = S?.agent?.connected ? 'An agent is connected and coaching.' : 'OpenSpin works fully without an agent. The built-in coach handles cues and safe adjustments.';
}
// Settings > Athlete and the Workouts tab shortcuts edit the same values
$('#sFtp').onchange = e => { $('#ftp').value = e.target.value; $('#ftp').onchange({ target: $('#ftp') }); renderSettings(); };
$('#sWeight').onchange = e => { $('#weight').value = e.target.value; $('#weight').onchange({ target: $('#weight') }); renderSettings(); };
$('#sHrZones').onchange = e => {
  const v = e.target.value.split(/[,\s]+/).map(Number).filter(n => n > 30 && n < 230);
  if (v.length === 5 && v.every((x, i) => !i || x > v[i - 1])) { settings.hrZones = v; settings.hrZonesSrc = 'manual'; saveSettings(['hrZones', 'hrZonesSrc']); toast('HR zones saved'); }
  else toast('Enter 5 rising numbers');
  renderSettings();
};
$('#virtDist').onchange = e => { settings.hideVirtualDistance = e.target.value === '1'; saveSettings(['hideVirtualDistance']); };
const setLC = patch => { settings.localCoach = { ...(settings.localCoach || {}), ...patch }; saveSettings(['localCoach']); };
$$('[data-lc]').forEach(b => b.onchange = () => setLC({ [b.dataset.lc]: b.checked }));
$('#lcAuto').onchange = e => setLC({ auto_adjust: e.target.value });
$('#afterWk').onchange = e => { settings.afterWorkout = e.target.value; saveSettings(['afterWorkout']); };
const cadSave = () => { const lo = +$('#cadLo').value, hi = +$('#cadHi').value; if (lo >= 40 && hi > lo && hi <= 130) { settings.cadRange = [lo, hi]; saveSettings(['cadRange']); } else toast('Cadence range: low < high'); };
$('#cadLo').onchange = cadSave; $('#cadHi').onchange = cadSave;
$('#hrMax').onchange = e => { const v = +e.target.value; if (v >= 100 && v <= 230) { settings.hrMax = v; saveSettings(['hrMax']); } };
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
function showSettings() {
  $('#ftp').value = settings.ftp; $('#weight').value = settings.weight || ''; $('#beeps').value = settings.beeps ? '1' : '0';
  renderLib(); renderBuilder();
}
$('#ftp').onchange = e => { const v = +e.target.value; if (v >= 50 && v <= 600) { settings.ftp = Math.round(v); settings.ftpSrc = 'manual'; saveSettings(['ftp', 'ftpSrc']); renderLib(); renderBuilder(); } };
$('#weight').onchange = e => { settings.weight = +e.target.value || 0; saveSettings(['weight']); };
$('#beeps').onchange = e => { settings.beeps = e.target.value === '1'; saveSettings(['beeps']); };
if (globalThis.location?.hash === '#settings') setTimeout(() => show('settings'), 0);

async function syncHrZones() {
  if (settings.hrZonesSrc === 'manual' || !garminOn) return;
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
