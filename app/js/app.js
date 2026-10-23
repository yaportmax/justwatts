// Browser UI. The local server owns the trainer, HR strap and the ride (see server/trainer_coach/engine.py),
// so this page only renders state from /api/stream and sends controls. Reloading or closing it never
// interrupts a ride. Pure logic (workout format, summaries, FIT/TCX) lives in core.js.
import {
  fmtT, esc, ZONES, zoneIdx, HRZ_COLORS, hrZone as hrZoneOf, parseWorkout, toText, compile, stepAt, stepWatts,
  estimate, toZwo as toZwoCore, PRESETS, summarize, fitEncode, toTcx,
} from './core.js';

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
const api = (path, body) => fetch(path, { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const apiJson = async (path, body) => { const r = await api(path, body); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
function saveSettings(keys) {
  store.set('hw.settings', settings);
  const patch = {}; for (const k of keys || Object.keys(settings)) patch[k] = settings[k];
  api('/api/settings', patch).catch(() => {});
}
async function loadSettings() {
  try {
    const j = await (await fetch('/api/settings')).json();
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
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
// draws the target profile as zone-colored blocks
function drawBlocks(c, cw, ftp, X, Y, alpha, k = 1) {
  for (const s of cw.steps) {
    if (s.free) {
      c.fillStyle = hexA(css('--z1'), alpha * 0.5);
      c.fillRect(X(s.t0), Y(0.5 * ftp), X(s.t0 + s.d) - X(s.t0), Y(0) - Y(0.5 * ftp));
      continue;
    }
    const n = s.a === s.b ? 1 : Math.max(2, Math.min(40, Math.round(s.d / 15)));
    for (let j = 0; j < n; j++) {
      const t0 = s.d * j / n, t1 = s.d * (j + 1) / n;
      const w0 = stepWatts(s, t0, ftp, k), w1 = stepWatts(s, t1, ftp, k);
      c.fillStyle = hexA(zoneColor(((w0 + w1) / 2) / ftp), alpha);
      const ov = j < n - 1 ? 0.6 : 0;  // overlap neighbours so antialiasing leaves no seams
      c.beginPath(); c.moveTo(X(s.t0 + t0), Y(0)); c.lineTo(X(s.t0 + t0), Y(w0)); c.lineTo(X(s.t0 + t1) + ov, Y(w1)); c.lineTo(X(s.t0 + t1) + ov, Y(0)); c.closePath(); c.fill();
    }
  }
}
function maxTarget(cw, ftp, k = 1) { let m = 0; for (const s of cw.steps) if (!s.free) m = Math.max(m, stepWatts(s, 0, ftp, k), stepWatts(s, s.d, ftp, k)); return m; }
function drawThumb(cv, cw, ftp) {
  const [c, w, h] = fit(cv); const yMax = Math.max(maxTarget(cw, ftp) * 1.08, ftp * 1.2);
  drawBlocks(c, cw, ftp, t => t / cw.total * w, v => h - v / yMax * h, 0.9);
  c.strokeStyle = 'rgba(255,255,255,.18)'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, h - ftp / yMax * h); c.lineTo(w, h - ftp / yMax * h); c.stroke(); c.setLineDash([]);
}
// full chart: profile + power + HR (right-hand axis)
function drawChart(cv, o) {
  const [c, w, h] = fit(cv); const ftp = o.ftp, L = 40, B = 20, T = 8, R = 32, pw = w - L - R, ph = h - B - T;
  const smp = o.samples || [];
  const total = o.cw ? o.cw.total : Math.max(600, (o.el || 0) * 1.08, smp.length ? smp[smp.length - 1][1] : 0);
  let mp = 0; for (const s of smp) mp = Math.max(mp, s[2]);
  const yMax = Math.max(ftp * 1.3, (o.cw ? maxTarget(o.cw, ftp, o.k) : 0) * 1.12, Math.min(mp, ftp * 2.5) * 1.05);
  const X = t => L + t / total * pw, Y = v => T + ph - Math.max(0, v) / yMax * ph;
  c.font = '11px system-ui'; c.fillStyle = css('--faint'); c.textAlign = 'right'; c.textBaseline = 'middle';
  for (const f of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    const v = f * ftp; if (v > yMax) break;
    c.strokeStyle = f === 1 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.07)'; c.setLineDash(f === 1 ? [4, 4] : []);
    c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(w - R, Y(v)); c.stroke(); c.setLineDash([]);
    c.fillText(Math.round(v), L - 6, Y(v));
  }
  c.textAlign = 'center'; c.textBaseline = 'top';
  const stepT = [60, 300, 600, 900, 1800, 3600].find(s => total / s <= 8) || 3600;
  for (let t = 0; t <= total; t += stepT) c.fillText(fmtT(t), X(t), h - B + 5);
  if (o.cw) {
    c.save(); drawBlocks(c, o.cw, ftp, X, Y, 0.22, o.k); c.restore();
    if (o.el != null) { c.save(); c.beginPath(); c.rect(L, 0, X(o.el) - L, h); c.clip(); drawBlocks(c, o.cw, ftp, X, Y, 0.5, o.k); c.restore(); }
  }
  if (smp.some(s => s[4] > 0)) {
    const HY = v => T + ph - (v - 40) / 170 * ph;
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = hexA('#ef4444', 0.8);
    for (let v = 80; v <= 200; v += 20) c.fillText(v, w - R + 4, HY(v));
    c.strokeStyle = hexA('#ef4444', 0.75); c.lineWidth = 1.2; c.beginPath(); let on = false;
    for (const s of smp) { if (!(s[4] > 0)) { on = false; continue; } on ? c.lineTo(X(s[1]), HY(s[4])) : c.moveTo(X(s[1]), HY(s[4])); on = true; }
    c.stroke();
  }
  c.strokeStyle = '#e9edf2'; c.lineWidth = 1.5; c.lineJoin = 'round'; c.beginPath();
  let acc = []; smp.forEach((s, i) => { acc.push(s[2]); if (acc.length > 3) acc.shift(); const v = acc.reduce((a, b) => a + b, 0) / acc.length; i ? c.lineTo(X(s[1]), Y(v)) : c.moveTo(X(s[1]), Y(v)); });
  c.stroke(); c.lineWidth = 1;
  if (o.el != null && o.cw) { c.strokeStyle = css('--acc'); c.beginPath(); c.moveTo(X(o.el), T); c.lineTo(X(o.el), T + ph); c.stroke(); }
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
  if (S.notice && S.notice !== prev?.notice) { toast(S.notice); control('dismiss').catch(() => {}); }
  coachUpdate();
  voiceUpdate();
  beeps();
  if (prev && S.last_finished && S.last_finished.id !== prev.last_finished?.id) finishedRide(S.last_finished);
  setStatus(); renderLive(); if (V) renderRide();
}
function setOnline(on) {
  if (on === online) return; online = on;
  $('#srvState').style.display = on ? 'none' : '';
}
let es = null;
function connect() {
  if (typeof EventSource === 'undefined') return poll();
  es = new EventSource('/api/stream');
  es.onmessage = e => { try { onLive(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
  es.onerror = () => setOnline(false);  // EventSource reconnects by itself
}
async function poll() {  // fallback when EventSource is unavailable
  try { onLive(await (await fetch(`/api/live?ride=${rideId || ''}&n=${samples.length}`)).json()); } catch { setOnline(false); }
  setTimeout(poll, 1000);
}

/* ---------- devices (owned by the server) ---------- */
function setStatus() {
  const d = S?.devices || {}, mode = d.trainer || 'none';
  $('#tDot').className = 'dot ' + ({ ble: 'on', wait: 'wait', sim: 'sim' }[mode] || '');
  $('#tTxt').textContent = { none: 'Trainer off', wait: 'Connecting…', ble: d.trainer_name || 'Trainer', sim: 'Simulated' }[mode] || 'Trainer off';
  $('#btnTrainer').textContent = mode === 'ble' || mode === 'wait' ? 'Disconnect' : 'Connect trainer';
  $('#btnTrainer').className = mode === 'ble' || mode === 'wait' ? '' : 'pri';
  $('#btnSim').textContent = mode === 'sim' ? 'Stop sim' : 'Sim';
  $('#hDot').className = 'dot ' + (d.hr ? 'on' : d.hr_waiting || d.hr_name ? 'wait' : '');
  $('#hTxt').textContent = d.hr ? `HR ${d.hr}` : d.hr_waiting || d.hr_name ? 'HR waiting' : 'HR off';
  $('#btnHR').textContent = d.hr_name ? 'Disconnect HR' : 'Connect HR';
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
      b.innerHTML = `<span>${esc(d.name)}</span><span class="m">${d.rssi ?? ''} dBm</span>`;
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
  else openDevices('trainer');
};
$('#btnHR').onclick = () => {
  if (S?.devices?.hr_name) apiJson('/api/devices', { action: 'disconnect', kind: 'hr' }).catch(e => toast(e.message));
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
  try { rows = (await (await fetch('/api/rides')).json()).rides; } catch { return; }
  const tb = $('#hist'); tb.innerHTML = '';
  $('#histEmpty').style.display = rows.length ? 'none' : '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>${esc(r.name)}${r.garmin ? ' <span class="badge">Garmin</span>' : ''}${r.test ? ' <span class="badge">test</span>' : ''}</td><td class="num">${fmtT(r.time_s)}</td><td class="num">${r.avg_w}</td><td class="num">${r.np}</td><td class="num">${r.tss}</td><td class="num">${r.kJ}</td><td class="num">${r.avg_hr ?? '–'}</td><td class="num">${r.best?.['5m'] || '–'}</td>`;
    tr.onclick = () => openSummary(r.id); tb.appendChild(tr);
  }
  renderTrends();
}
async function renderTrends() {
  let t; try { t = await (await fetch('/api/trends?weeks=12')).json(); } catch { return; }
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
  $('#tBest').innerHTML = ['1m', '5m', '20m'].map(k => `<div class="stat"><div class="k">Best ${k}</div><div class="v">${t.best[k] ? t.best[k].w + ' W' : '–'}</div><div class="hint">${t.best[k]?.date || ''}</div></div>`).join('')
    + `<div class="stat"><div class="k">TSS this week</div><div class="v">${wk.at(-1).tss}</div></div>`;
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
  try { [r, d] = await Promise.all([(await fetch('/api/rides/' + id)).json(), (await fetch('/api/rides/' + id + '/detail')).json()]); } catch { return; }
  if (!r?.samples) return;
  openId = id; openRide = r; const m = d.summary;
  $('#summary').style.display = ''; $('#sName').textContent = r.name;
  $('#sDate').textContent = new Date(r.start || r.samples[0][0]).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const st = [['Time', fmtT(m.time_s)], ['Avg power', m.avg_w + ' W'], ['NP', m.np + ' W'], ['Max', m.max_w + ' W'], ['IF', m.if.toFixed(2)], ['TSS', m.tss], ['Work', m.kJ + ' kJ'], ['Cadence', m.avg_cad + ' rpm'], ['Avg HR', m.avg_hr ?? '–'], ['Max HR', m.max_hr ?? '–'], ['Best 1/5/20', `${d.best['1m']}/${d.best['5m'] || '–'}/${d.best['20m'] || '–'}`], ['Distance', m.distance_km.toFixed(1) + ' km']];
  $('#sStats').innerHTML = st.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
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
    tb.innerHTML = `<span class="badge">FTP estimate <b class="num" style="color:var(--ink)">${est} W</b></span><button id="sSetFtp">Set FTP</button>`;
    $('#sSetFtp').onclick = () => { settings.ftp = est; saveSettings(['ftp']); $('#ftp').value = est; renderLib(); renderBuilder(); toast(`FTP set to ${est} W`); };
  } else tb.style.display = 'none';
  const hz = d.hr_zones_s ? Object.values(d.hr_zones_s) : null, hn = hz ? hz.reduce((a, b) => a + b, 0) : 0;
  $('#sHR').style.display = hn ? '' : 'none';
  if (hn) {
    $('#sHZones').innerHTML = hz.map((t, i) => `<i style="width:${t / hn * 100}%;background:var(${HRZ_COLORS[i]})"></i>`).join('');
    $('#sHZleg').innerHTML = hz.map((t, i) => `<span><b style="background:var(${HRZ_COLORS[i]})"></b>Z${i + 1} ${settings.hrZones[i]}+ · ${fmtT(t)}</span>`).join('');
  }
  $('#sLaps').innerHTML = d.laps.map(l => `<tr><td>${l.overtime ? 'free' : l.index}</td><td class="num">${fmtT(l.time_s)}</td><td class="num">${l.target_w ?? (l.free ? 'free' : '–')}</td><td class="num">${l.avg_w}</td><td class="num">${l.max_w}</td><td class="num">${l.np}</td><td class="num">${l.avg_hr ?? '–'}</td><td class="num">${l.max_hr ?? '–'}</td><td class="num">${l.avg_cad ?? '–'}</td></tr>`).join('');
  const cls = l => /^COACH|^EDIT/.test(l) ? 'c' : /^SAID/.test(l) ? 's' : /^FEEL|^PAUSED/.test(l) ? 'f' : '';
  $('#sEvents').innerHTML = d.events.length ? d.events.map(([ts, l]) => `<div class="${cls(l)}">${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}  ${esc(l)}</div>`).join('') : '<div class="hint">No transcript for this ride.</div>';
  renderGarminBtn(d.garmin);
  $('#summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderGarminBtn(g) {
  const b = $('#sGarmin'); b.disabled = !garminOn && !g;
  b.title = garminOn ? '' : 'Garmin is disabled on this server';
  b.textContent = g ? 'On Garmin ✓' : 'Upload to Garmin'; b.className = g ? '' : 'pri'; b.dataset.g = g || '';
}
async function uploadGarmin(id) {
  if (openId === id) { $('#sGarmin').disabled = true; $('#sGarmin').textContent = 'Uploading…'; }
  let g = null;
  try {
    const res = await api(`/api/rides/${id}/garmin`, {});
    const j = await res.json().catch(() => ({ error: 'no local server (run: trainer-coach serve)' }));
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
const fileLink = ext => { if (!openId) return; const a = document.createElement('a'); a.href = `/api/rides/${openId}/${ext}`; a.download = ''; a.click(); };
$('#sFit').onclick = () => fileLink('fit');
$('#sTcx').onclick = () => fileLink('tcx');
function download(name, data, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- nav + settings + init ---------- */
function show(v) {
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (v === 'workouts') { renderLib(); renderBuilder(); }
  if (v === 'ride' && V) renderRide();
  if (v === 'history') renderHistory();
}
$$('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
$$('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('#btnJust').onclick = $('#btnJust2').onclick = () => loadRide(null);
function showSettings() {
  $('#ftp').value = settings.ftp; $('#weight').value = settings.weight || ''; $('#beeps').value = settings.beeps ? '1' : '0';
  $('#autoGarmin').value = settings.autoGarmin ? '1' : '0'; $('#autoGarmin').disabled = !garminOn;
  $('#autoGarmin').title = garminOn ? '' : 'Garmin is disabled on this server';
  $('#hrZones').value = settings.hrZones ? settings.hrZones.join(',') : '';
  renderLib(); renderBuilder();
}
$('#ftp').onchange = e => { const v = +e.target.value; if (v >= 50 && v <= 600) { settings.ftp = Math.round(v); saveSettings(['ftp']); renderLib(); renderBuilder(); } };
$('#weight').onchange = e => { settings.weight = +e.target.value || 0; saveSettings(['weight']); };
$('#beeps').onchange = e => { settings.beeps = e.target.value === '1'; saveSettings(['beeps']); };
$('#autoGarmin').onchange = e => { settings.autoGarmin = e.target.value === '1'; saveSettings(['autoGarmin']); };
$('#hrZones').onchange = e => {
  const v = e.target.value.split(/[,\s]+/).map(Number).filter(n => n > 30 && n < 230);
  if (v.length === 5 && v.every((x, i) => !i || x > v[i - 1])) { settings.hrZones = v; settings.hrZonesSrc = 'manual'; saveSettings(['hrZones', 'hrZonesSrc']); toast('HR zones saved'); }
  else { toast('Enter 5 rising numbers'); showSettings(); }
};
async function syncHrZones() {
  if (settings.hrZonesSrc === 'manual' || !garminOn) return;
  try {
    const j = await (await fetch('/api/garmin/zones')).json();
    if (j.floors?.length === 5) { settings.hrZones = j.floors; settings.hrMax = j.max; settings.hrZonesSrc = 'garmin'; saveSettings(['hrZones', 'hrMax', 'hrZonesSrc']); showSettings(); }
  } catch {}
}
$('#bName').value = 'My workout'; $('#bText').value = '10m 45-75%, 4x(5m 100%, 3m 55%), 8m 50-40%';
renderVoice(); setStatus();
loadSettings().then(syncHrZones);
migrateLocalRides().then(renderHistory);
connect();
const setHH = () => document.documentElement.style.setProperty('--hh', document.querySelector('header').offsetHeight + 'px');
setHH();
window.addEventListener('resize', () => { setHH(); if ($('#v-workouts').classList.contains('on')) renderLib(); if (V) renderRide(); });
window.__hw = { parseWorkout, toText, fitEncode, compile, summarize, state: () => S };
