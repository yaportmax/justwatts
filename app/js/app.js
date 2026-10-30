// Browser UI. The local server owns the trainer, HR strap and the ride (see server/justwatts/engine.py),
// so this page only renders state from /api/stream and sends controls. Reloading or closing it never
// interrupts a ride. Pure logic (workout format, summaries, FIT/TCX) lives in core.js.
import {
  fmtT, esc, ZONES, zoneIdx, HRZ_COLORS, hrZone as hrZoneOf, parseWorkout, toText, compile, stepAt, stepWatts,
  estimate, toZwo as toZwoCore, PRESETS, FTP_TESTS, testKind, summarize, fitEncode, toTcx,
  activeHrZones, validHrFloors, HR_MAX_DEFAULT, fromErgMrc, weightShow, weightKg, weightUnit, distText, treeText,
} from './core.js';
import { MODE } from './mode.js';
import { drawChart as drawChartOn, drawBlocks, maxTarget } from './chart.js';
import { createBuilder } from './builder.js';
import { fromWords } from './words.js';
import { view as aView, track, workoutTag } from './analytics.js';
import { LIBRARY, CATEGORIES, FEATURED } from './library.js';
import { createCourses, authorCell } from './courses.js';
import { drawMap, lineDist, pointAt } from './map.js';
import { checkCourse, buildCourse } from './course.js';
import { createWorld, PRESETS as WORLD_PRESETS } from './world.js';
import { createPicker } from './worldpick.js';
import { createConnect } from './connect.js';
import { createDetail } from './detail.js';
import { createListSort } from './listsort.js';

// One codebase, two backends: the local python server, or (web build) an in-page backend with the
// ride engine, Web Bluetooth and IndexedDB that answers the same /api/* requests.
const WEB = MODE === 'web';
const WB = WEB ? await import('./web/backend.js') : null;
const B = WB ? await WB.createWebBackend(globalThis.__justwattsWeb || {}) : null;  // tests pass { tickMs: 0, store }
const F = B ? (p, o) => B.fetch(p, o) : (p, o) => globalThis.fetch(p, o);
const ES = B ? WB.makeEventSource(B) : globalThis.EventSource;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let onSaved = () => {};  // web build with an account: a synced key changed (custom workouts, courses, settings)
const SYNCED = new Set(['hw.custom', 'hw.courses', 'hw.settingsAt']);
let account = null, community = null, social = null, libSrc = 'all';  // web build: accounts, the community library, social; the library Source filter
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); if (SYNCED.has(k)) onSaved(k); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
// Settings live on the server; localStorage is only migrated once.
const settings = Object.assign({ ftp: 200, weight: 0, beeps: true, autoGarmin: false, cadRange: [85, 95], units: 'imperial' }, store.get('hw.settings', {}));
const cadOn = () => settings.cadOn !== false;  // cadence off: no readout, target or cues
let garminOn = false;
const api = (path, body) => F(path, { method: 'POST', headers: { 'X-HW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const apiJson = async (path, body) => { const r = await api(path, body); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
function saveSettings(keys, stamp = true) {
  store.set('hw.settings', settings); if (stamp) store.set('hw.settingsAt', Date.now());  // the time decides which device's settings win
  const patch = {}; for (const k of keys || Object.keys(settings)) patch[k] = settings[k];
  api('/api/settings', patch).catch(() => {});
}
async function loadSettings() {
  try {
    const j = await (await F('/api/settings')).json();
    garminOn = !!j.garmin;
    if (j.stored) Object.assign(settings, j.settings);
    else saveSettings(['ftp', 'weight', 'beeps', 'autoGarmin', 'hrZones', 'hrMax', 'hrZonesSrc', 'cadRange', 'units'], false);  // first run: defaults never beat synced settings
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
// integrations: Settings > Integrations, the Upload panel, Today's planned rides (connect.js)
const conn = createConnect({ $, F, WEB, toast,
  fitOf: async id => {  // web: the FIT the page posts to the integration functions
    const r = await (await F('/api/rides/' + id)).json(), data = await B.exportFile(id, 'fit'); if (!data || !r?.samples) return null;
    const t0 = r.start || r.samples[0][0], d = new Date(t0), p = n => String(n).padStart(2, '0');
    return { bytes: new Uint8Array(data), name: r.name, start: t0, duration: r.samples.length,
      local: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
  },
  downloadFit: id => fileLink('fit', id),
  onPlanned: list => { planned = list; if ($('#v-workouts').classList.contains('on') && wkTab === 'workouts') renderLib(); },
  stravaSetup: () => { const d = $('#stOwnBox'); d.open = true; d.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); },
  // import (connect.js + importer.js): profile values into settings, past rides into History (never uploaded back)
  settings: () => settings,
  applyProfile: patch => { Object.assign(settings, patch); saveSettings(Object.keys(patch)); renderSettings(); showSettings(); },
  listRides: async () => { try { return (await (await F('/api/rides')).json()).rides; } catch { return []; } },
  saveRide: async r => { try { return (await api('/api/ride', r)).ok; } catch { return false; } },
  deleteRide: async id => { try { return (await api(`/api/rides/${id}/delete`, {})).ok; } catch { return false; } },  // a poorer copy of an imported ride
  onImported: () => { renderHistory(); account?.sync.kick(); },
});
// open world: the page provides the road ahead (world.js); quiet controls (a refused road update is not an error to show)
const world = createWorld({ control: (action, b) => apiJson('/api/ride/control', { action, ...b }),
  course: async () => (await F('/api/ride/course', { headers: { 'X-HW': '1' } })).json(), onChange: () => { if (V) renderRide(); } });
const courses = createCourses({ world, live: () => S?.live, openWorld: wid => picker.open(wid), openCourse: c => detail.openCourse(c), $, store, toast, fit, css, units: () => settings.units, ride: (c, w) => loadRide(w, c), workouts: () => allWorkouts(), relayout: () => V && renderRide(),
  source: () => srcNow(), comm: f => commFeed('course', f), openComm: id => community?.openItem(id), rideComm: id => community?.rideItem(id), moreComm: () => community?.feedMore('course'),
  publish: c => community && account?.me() ? () => community.openPublish({ kind: 'course', course: c }) : null });

/* ---------- library + builder ---------- */
// library filters are a per-browser convenience
const libF = Object.assign({ q: '', cat: '', dur: '', lvl: '', sort: '' }, store.get('hw.libFilter', {}));
// Source, one filter for both tabs: all, Just Watts (built in), yours, or the community (web build, once it loads).
// Older pages stored the source bar's lib | mine | comm, or a "Mine" category.
libSrc = libF.cat === 'Mine' ? 'mine' : store.get('hw.libSrc', 'all');
if (libSrc === 'lib' || !['all', 'jw', 'mine', 'comm'].includes(libSrc)) libSrc = 'all';
if (libF.cat === 'Mine') libF.cat = '';
// the source in effect: Community only while the community library is there (no accounts, local app: All)
function srcNow() { return libSrc === 'comm' && !community ? 'all' : libSrc; }
function renderSrc() {
  const opts = [['all', 'All sources'], ['jw', 'Just Watts'], ['mine', 'Mine'], ...(community ? [['comm', 'Community']] : [])];
  for (const id of ['#libSrc', '#crsSrc']) { const el = $(id); if (!el) continue; el.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); el.value = srcNow(); }
}
function setSrc(v) { libSrc = v; store.set('hw.libSrc', v); showTab(wkTab); }
// community items for a tab's list (All or Community), from the current search and sort; null: local items only
const CSORT = { liked: 'liked', ridden: 'popular', new: 'new' };
function commFeed(kind, f) {
  const s = srcNow(); if (!community || (s !== 'all' && s !== 'comm')) return null;
  return community.feed(kind, { q: String(f.q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80), sort: CSORT[f.sort] || 'liked', dur: kind === 'workout' ? f.dur || '' : '' });
}
// a community row's second line: its tags (not the one shown as the category); on a phone, the author first
const commSub = (it, cat = '') => [`<span class="pau">${esc(it.author)}</span>`, ...(it.tags || []).filter(t => !cat || !isCat([t], cat)).map(esc)].join('<i class="psep"> · </i>');
const isCat = (tags, cat) => (tags || []).some(t => t.replace(/\s+/g, '') === cat.toLowerCase().replace(/\s+/g, ''));
const compiled = new Map();
function cwOf(w) { const k = w.id + '|' + w.text; if (!compiled.has(k)) { try { compiled.set(k, compile(w)); } catch { compiled.set(k, null); } } return compiled.get(k); }
function libMatch(w, cw, it = null) {
  const src = srcNow(), mine = w.id.startsWith('c-');
  if (!it && (src === 'comm' || (src === 'mine' && !mine) || (src === 'jw' && mine))) return false;
  if (libF.cat && (it ? !isCat(it.tags, libF.cat) : w.category !== libF.cat)) return false;  // community: a tag that names the category
  if (libF.dur) { const [lo, hi] = libF.dur.split('-').map(Number), m = cw.total / 60; if (m < lo || m >= hi) return false; }
  if (libF.lvl) { const [lo, hi] = libF.lvl.split('-').map(Number); if (!w.level || w.level < lo || w.level > hi) return false; }
  if (libF.q && !it) { const q = libF.q.trim().toLowerCase(); if (![w.name, w.category, w.purpose, mine ? 'You' : 'Just Watts', ...(w.tags || [])].some(x => x && String(x).toLowerCase().includes(q))) return false; }  // community: the server searched
  return true;
}
function renderLibBar() {
  const cats = [['', 'All'], ...CATEGORIES.map(c => [c, c])];
  $('#libCat').innerHTML = cats.map(([v, t]) => `<button class="chip${libF.cat === v ? ' on' : ''}" data-cat="${esc(v)}">${esc(t)}</button>`).join('');
  $('#libQ').value = libF.q; $('#libDur').value = libF.dur; $('#libLvl').value = libF.lvl;
  $('#libSort').innerHTML = WS.options(libF.sort, { name: 'Workout', author: 'Author', cat: 'Category', time: 'Time', tss: 'TSS', level: 'Level' }); $('#libSort').value = libF.sort || '';
  $('#libHead').innerHTML = WS.head(libF.sort, WCOLS);
  renderSrc();
}
const setLibF = patch => { Object.assign(libF, patch); store.set('hw.libFilter', libF); renderLibBar(); renderLib(); };
$('#libCat').onclick = e => { const b = e.target?.closest?.('[data-cat]'); if (b) setLibF({ cat: b.dataset.cat }); };
$('#libQ').oninput = e => { libF.q = e.target.value; store.set('hw.libFilter', libF); renderLib(); };
$('#libDur').onchange = e => setLibF({ dur: e.target.value });
$('#libLvl').onchange = e => setLibF({ lvl: e.target.value });
$('#libSort').onchange = e => setLibF({ sort: e.target.value });
$('#libHead').onclick = e => { const b = e?.target?.closest?.('[data-sort]'); if (b) setLibF({ sort: WS.click(libF.sort, b.dataset.sort) }); };
$('#libSrc').onchange = e => setSrc(e.target.value);
$('#crsSrc').onchange = e => setSrc(e.target.value);
$('#libMore').onclick = () => community?.feedMore('workout');
// Featured: your own workouts, the picks, then the rest taking turns across categories (not one long block per category)
// sort: Featured, the select's presets, or a header (Workout, Category, Author, Time, TSS, Level); ties go by name
const WS = createListSort({ short: ['time', 'asc'], long: ['time', 'desc'], easy: ['level', 'asc'], hard: ['level', 'desc'], name: ['name', 'asc'] },
  [['', 'Featured'], ['short', 'Shortest'], ['long', 'Longest'], ['easy', 'Easiest'], ['hard', 'Hardest'], ['name', 'Name'], ['liked', 'Most liked'], ['ridden', 'Most ridden'], ['new', 'Newest']]);
const WCOLS = [['', ''], ['name', 'Workout'], ['cat', 'Category'], ['author', 'Author'], ['time', 'Time', 'r'], ['tss', 'TSS', 'r'], ['level', 'Level']];
const wkVal = (x, k) => k === 'name' ? x.w.name : k === 'author' ? (x.it ? x.it.author : x.w.id.startsWith('c-') ? 'You' : 'Just Watts') : k === 'cat' ? x.w.category || ''
  : k === 'time' ? x.cw.total : k === 'tss' ? (x.tss ??= estimate(x.cw, settings.ftp).tss) : k === 'level' ? x.w.level || 0 : 0;
const LIB_SORT = () => WS.cmp(libF.sort, wkVal);
function sortedWorkouts(list) {
  const by = LIB_SORT();
  if (by) return list.sort(by);
  const pick = new Map(FEATURED.map((id, i) => [id, i])), mine = list.filter(x => x.w.id.startsWith('c-')), top = list.filter(x => pick.has(x.w.id)).sort((a, b) => pick.get(a.w.id) - pick.get(b.w.id));
  const rest = list.filter(x => !x.w.id.startsWith('c-') && !pick.has(x.w.id)), q = new Map();
  for (const x of rest) { const k = x.w.category || ''; if (!q.has(k)) q.set(k, []); q.get(k).push(x); }
  const mixed = []; for (let left = rest.length; left;) for (const a of q.values()) if (a.length) { mixed.push(a.shift()); left--; }
  return [...mine, ...top, ...mixed];
}
const lvlDots = n => n ? `<span class="lvl l${n}" title="Difficulty ${n} of 5">${[1, 2, 3, 4, 5].map(i => `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}</span>` : '';
let planned = [];  // today's planned rides from TrainingPeaks / intervals.icu (connect.js)
function renderToday(lib, ftp) {
  if (libF.q || srcNow() !== 'all') return 0;  // planned rides: in All, not while searching
  let n = 0;
  for (const p of planned) {
    const w = { id: 'planned-' + p.source, name: p.name, text: p.text }, cw = cwOf(w); if (!cw) continue;
    const e = estimate(cw, ftp), row = document.createElement('div'); row.className = 'lrow today';
    row.innerHTML = `<canvas></canvas><div class="lmain"><div class="t">${esc(p.name)}</div><div class="p">${esc(p.sourceName + (p.description ? ' · ' + p.description : ''))}</div></div>
      <div class="c">Today</div><div class="au"></div><div class="m num r">${fmtT(cw.total)}</div><div class="m num r">${Math.round(p.tss || e.tss)}</div><div></div>
      <div class="lact"><button class="pri" data-a="ride">Ride</button></div>`;
    lib.appendChild(row); n++;
    requestAnimationFrame(() => drawThumb(row.querySelector('canvas'), cw, ftp));
    row.onclick = () => loadRide(w);
    row.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); loadRide(w); };
  }
  return n;
}
// the list: today's planned rides, local workouts (yours and Just Watts), then community items (first, for the community sorts)
function libRows() {
  const local = sortedWorkouts(allWorkouts().map(w => ({ w, cw: cwOf(w) })).filter(x => x.cw && libMatch(x.w, x.cw)));
  const f = commFeed('workout', libF), saved = new Set(custom.map(w => w.name + '\n' + w.text.trim()));
  let cm = (f?.items || []).filter(it => it.kind === 'workout' && !(srcNow() === 'all' && saved.has(it.name + '\n' + String(it.text).trim())))  // saved to mine already
    .map(it => { const w = { id: 'm-' + it.id, name: it.name, text: it.text, category: CATEGORIES.find(c => isCat(it.tags, c)) || '' }; return { w, cw: cwOf(w), it }; })
    .filter(x => x.cw && libMatch(x.w, x.cw, x.it));
  const by = LIB_SORT(); if (by) cm.sort(by);
  return { list: CSORT[libF.sort] ? [...cm, ...local] : [...local, ...cm], f };
}
function renderLib() {
  const ftp = settings.ftp, lib = $('#lib'); lib.innerHTML = ''; let shown = renderToday(lib, ftp);
  const { list, f } = libRows(), src = srcNow();
  for (const { w, cw, it } of list) {
    shown++;
    const e = estimate(cw, ftp), mine = w.id.startsWith('c-');
    const row = document.createElement('div'); row.className = 'lrow' + (it ? ' cm' : '');
    const sub = it ? commSub(it, w.category) : w.purpose ? esc(w.purpose) : '';
    row.innerHTML = `<canvas></canvas><div class="lmain"><div class="t">${esc(w.name)}</div>
      ${sub ? `<div class="p">${sub}</div>` : ''}</div>
      <div class="c">${esc(w.category || '')}</div>${authorCell(it ? it.author : mine ? 'You' : 'Just Watts', it)}<div class="m num r">${fmtT(cw.total)}</div><div class="m num r">${Math.round(e.tss)}</div><div>${lvlDots(w.level)}</div>
      <div class="lact"><button class="pri" data-a="ride">Ride</button>${it ? '' : '<button data-a="edit">Edit</button>'}</div>`;
    lib.appendChild(row);
    requestAnimationFrame(() => drawThumb(row.querySelector('canvas'), cw, ftp));
    if (it) {  // a community workout: the row opens its page (likes, comments, Save to mine), Ride rides it
      row.onclick = ev => { if (ev?.target?.closest?.('[data-a]')?.dataset.a === 'ride') return community?.rideItem(it.id); community?.openItem(it.id); };
      row.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); community?.rideItem(it.id); };
      continue;
    }
    const go = () => detail.rideDefault(w);  // one click: the last course pick (flat at first)
    row.onclick = ev => {
      const a = ev?.target?.closest?.('[data-a]')?.dataset.a;
      if (a === 'ride') return go();
      if (a === 'edit') return editWorkout(w);
      if (a) return;
      detail.openWorkout(w);
    };
    row.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); go(); };
    row.querySelector('[data-a=edit]').onclick = ev => { ev?.stopPropagation?.(); editWorkout(w); };
  }
  $('#libEmpty').style.display = shown ? 'none' : '';
  $('#libEmpty').textContent = src === 'mine' && !custom.length ? 'No workouts of your own yet. New workout starts one.'
    : src === 'comm' && f?.busy ? 'Loading' : src === 'comm' && f?.error ? f.error : src === 'comm' && !libF.q && !libF.cat && !libF.dur && !libF.lvl ? 'Nothing published yet.' : 'No workouts match.';
  $('#libMore').style.display = src === 'comm' && f?.more && !f.busy ? '' : 'none';
}
renderLibBar();
let editing = null;
function editWorkout(w) {
  editing = w.id.startsWith('c-') ? w.id : null;
  $('#bName').value = editing ? w.name : w.name + (w.id.startsWith('p-') ? ' (mine)' : '');
  $('#bText').value = w.text; $('#bDel').style.display = editing ? '' : 'none'; pubBtn();
  openBuilder(true);
}
// the builder is its own page inside Workouts: New workout or Edit opens it, the crumb goes back
function openBuilder(on) {
  $('#libPane').style.display = on ? 'none' : ''; $('#builderPane').style.display = on ? '' : 'none';
  if (on) { renderBuilder(); globalThis.scrollTo?.(0, 0); } else renderLib();
}
$('#btnNew').onclick = () => {
  editing = null; $('#bName').value = 'My workout'; $('#bText').value = '10m 45-75%, 4x(5m 100%, 3m 55%), 8m 50-40%';
  $('#bDel').style.display = 'none'; pubBtn(); openBuilder(true);
};
$('#bBack').onclick = () => openBuilder(false);
function builderWorkout() { return { id: editing || 'c-' + Date.now().toString(36), name: $('#bName').value.trim() || 'Untitled', text: $('#bText').value }; }
const builder = createBuilder({ list: $('#bList'), chart: $('#bChart'), palette: $('#bPal'), fit, css, ftp: () => settings.ftp, onEdit: text => { $('#bText').value = text; renderBuilder(); } });
function renderBuilder() {
  const w = builderWorkout(), ok = builder.load(w.text);
  try {
    const cw = compile(w), e = estimate(cw, settings.ftp);
    $('#bErr').textContent = '';
    $('#bStats').innerHTML = [[fmtT(cw.total), 'Time'], [Math.round(e.tss), 'TSS'], [e.IF.toFixed(2), 'IF'], [Math.round(e.np) + ' W', 'NP']].map(([v, k]) => `<span><b>${esc(v)}</b><small>${k}</small></span>`).join('');
    builder.draw(); return cw;
  } catch (err) { $('#bErr').textContent = ok ? err.message : err.message + ' (blocks show the last valid version)'; $('#bStats').innerHTML = ''; builder.draw(); return null; }
}
$('#bText').oninput = renderBuilder;
// plain words -> the same text format (rules in words.js, nothing leaves the page)
const buildFromWords = () => {
  const t = $('#bWords').value.trim(); if (!t) return;
  try { $('#bText').value = treeText(fromWords(t)); renderBuilder(); $('#bErr').textContent = ''; track('words_build', { ok: 1 }); }
  catch (err) { $('#bErr').textContent = err.message; track('words_build', { ok: 0 }); }
};
$('#bWordsGo').onclick = buildFromWords;
$('#bWords').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); buildFromWords(); } };
$('#bUndo').onclick = () => { if (!builder.undo()) toast('Nothing to undo'); };
$('#bSave').onclick = () => {
  const w = builderWorkout(); if (!renderBuilder()) return;
  w.updatedAt = Date.now();
  const i = custom.findIndex(x => x.id === w.id); i >= 0 ? custom[i] = w : custom.unshift(w);
  editing = w.id; $('#bDel').style.display = ''; pubBtn(); track('workout_save'); store.set('hw.custom', custom); renderLibBar(); renderLib(); toast('Saved');
};
$('#bDel').onclick = () => { custom = custom.filter(x => x.id !== editing); store.set('hw.custom', custom); editing = null; $('#bDel').style.display = 'none'; pubBtn(); renderLibBar(); renderLib(); toast('Deleted'); };
// web build, signed in: a saved workout of your own can go to the community library
function pubBtn() { $('#bPub').style.display = community && account?.me() && editing ? '' : 'none'; }
$('#bPub').onclick = () => { const w = custom.find(x => x.id === editing); if (w && community) community.openPublish({ kind: 'workout', name: w.name, text: w.text }); };
$('#bRide').onclick = () => { if (renderBuilder()) loadRide(builderWorkout()); };
$('#bZwo').onclick = () => { const cw = renderBuilder(); if (cw) download(cw.name.replace(/[^\w\- ]+/g, '') + '.zwo', toZwoCore(cw, settings.ftp), 'application/xml'); };
$('#bImport').onclick = () => $('#zwoFile').click();
$('#zwoFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { const src = await f.text(), { name, text } = /\.(erg|mrc)$/i.test(f.name) ? fromErgMrc(src) : fromZwo(src); editing = null; $('#bName').value = name; $('#bText').value = text; $('#bDel').style.display = 'none'; renderBuilder(); toast('Imported'); }
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
    // the server sends the live step list (target changes and mid-ride edits included); rebuild on change
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
  beeps();
  testGuide();
  if (prev && S.last_finished && S.last_finished.id !== prev.last_finished?.id) { finishedRide(S.last_finished); social?.finished(S.last_finished); }
  if (prev?.ride && !r && account) { account.sync.applyPending(); account.sync.kick(); }  // ride over: pending settings apply, the ride syncs
  world.update(r?.course, r?.id);
  setStatus(); renderLive(); if (V) renderRide();
  if (social) try { social.tick(); } catch (e) { console.warn('social', e); }  // never in the ride's way
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
let simW = 200;  // the simulated trainer's power until the server reports one
function setStatus() {
  const d = S?.devices || {}, mode = d.trainer || 'none';
  $('#tDot').className = 'dot ' + ({ ble: 'on', wait: 'wait', sim: 'sim' }[mode] || '');
  $('#tTxt').textContent = { none: 'Trainer off', wait: 'Connecting…', ble: d.trainer_name || 'Trainer', sim: 'Simulated' }[mode] || 'Trainer off';
  const again = d.reconnect?.trainer;  // web: after a reload the browser needs one click to reconnect
  $('#btnTrainer').textContent = mode === 'ble' || mode === 'wait' ? 'Disconnect' : again ? 'Reconnect' : 'Connect';
  $('#btnTrainer').title = again ? `Reconnect ${d.trainer_name || 'trainer'}` : '';
  $('#btnTrainer').className = mode === 'ble' || mode === 'wait' || mode === 'sim' ? '' : again ? 'pri reconnect' : 'pri';  // simulated: a real trainer is optional
  $('#btnSim').hidden = mode === 'ble' || mode === 'wait' || !(account?.me()?.admin || mode === 'sim');  // the simulated trainer: the admin's testing tool $('#btnSim').textContent = mode === 'sim' ? 'Stop simulating' : 'No trainer? Simulate one';
  $('#simRow').hidden = mode !== 'sim';
  if (mode === 'sim' && document.activeElement !== $('#simW')) $('#simW').value = d.sim_w ?? simW;
  $('#hDot').className = 'dot ' + (d.hr ? 'on' : d.hr_waiting || d.hr_name ? 'wait' : '');
  $('#hTxt').textContent = d.hr ? `HR ${d.hr}` : d.hr_state === 'waiting_heartbeat' ? 'Strap found, waiting for heartbeat (wet the contacts)' : d.hr_state === 'connecting' ? 'HR connecting…' : d.hr_waiting || d.hr_name ? 'HR waiting' : 'HR off';
  $('#btnHR').textContent = d.hr_name ? 'Disconnect' : d.reconnect?.hr ? 'Reconnect' : 'Connect';
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
// simulated trainer: no bike needed, the power is whatever is set here
const setSimW = w => { simW = Math.max(0, Math.min(1500, Math.round(w) || 0)); $('#simW').value = simW; apiJson('/api/devices', { action: 'sim', kind: 'trainer', power: simW }).catch(e => toast(e.message)); };
const simStep = dw => S?.devices?.trainer === 'sim' && setSimW((S.devices.sim_w ?? simW) + dw);
$('#btnSim').onclick = () => S?.devices?.trainer === 'sim' ? apiJson('/api/devices', { action: 'sim', kind: 'trainer', on: false }).catch(e => toast(e.message)) : setSimW(simW);
$('#simDn').onclick = () => simStep(-10); $('#simUp').onclick = () => simStep(10);
$('#simW').onchange = e => setSimW(+e.target.value);
$('#btnHR').onclick = () => {
  if (S?.devices?.hr_name) apiJson('/api/devices', { action: 'disconnect', kind: 'hr' }).catch(e => toast(e.message));
  else if (WEB) apiJson('/api/devices', { action: 'choose', kind: 'hr' }).catch(e => { if (!/cancel/i.test(e.message)) toast(e.message); });
  else openDevices('hr');
};

/* ---------- ride ---------- */
let loadArmed = 0;
function loadRide(w, course = null) {  // course: the one picked for this ride, if any (never for FTP tests)
  if (w?.test) course = null;
  // loading ends the ride in progress: a second tap within 4 s confirms
  if (S?.ride?.started && Date.now() - loadArmed > 4000) { loadArmed = Date.now(); toast('Ride in progress. Tap again to end it and load this.'); return Promise.resolve(false); }
  loadArmed = 0;
  track('ride_load', { workout: workoutTag(w), course: !course ? 'flat' : String(course.id).startsWith('k-') ? 'imported' : String(course.id).startsWith('m-') ? 'community' : course.id });
  return control('load', { workout: w ? { name: w.name, text: w.text, test: !!w.test } : null, course }).then(() => { show('ride'); return true; }).catch(() => false);
}
// open world from a start point (picker): roads load, then the ride loads like any course ride
async function rideWorld(p, wid) {
  const w = wid ? allWorkouts().find(x => x.id === wid && !x.test) : null;
  return startWorld({ ...p, name: p.id ? p.name : 'Open world' }, w);
}
async function startWorld(p, w) {
  if (S?.ride?.started && Date.now() - loadArmed > 4000) { loadArmed = Date.now(); toast('Ride in progress. Tap again to end it and load this.'); return false; }
  loadArmed = 0;
  await world.start({ name: p.name || 'Open world', lat: p.lat, lon: p.lon, heading: p.heading, workout: w && { name: w.name, text: w.text, test: false } });
  track('ride_load', { workout: workoutTag(w), course: 'open' }); show('ride'); return true;
}
// social (web): a group ride's start or a friend's spot; plan { kind: 'course', id } | { kind: 'open', name, lat, lon, heading }
async function rideAt(plan, w) {
  if (plan?.kind === 'course') { const c = courses.byId(plan.id); if (!c) { toast('Course not on this device'); return false; } return loadRide(w, c); }
  if (plan?.kind !== 'open') return false;
  try { return await startWorld(plan, w); } catch (e) { toast(e.message || 'Could not load the roads'); return false; }
}
// where the rider is, for social presence: only while a course or open-world ride runs
const lineCache = new WeakMap();
function along(ll, dist, d) {  // [lat, lon, heading] d metres along a line dist metres long
  let D = lineCache.get(ll); if (!D || D.dist !== dist) { D = lineDist(ll, dist); D.dist = dist; lineCache.set(ll, D); }
  const x = Math.max(0, Math.min(d, dist)), p = pointAt(ll, D, x);
  const a0 = Math.max(0, Math.min(x, dist - 20)), a = pointAt(ll, D, a0), q = pointAt(ll, D, Math.min(dist, a0 + 20));
  const h = Math.atan2((q[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), q[0] - a[0]) * 180 / Math.PI;
  return [p[0], p[1], Math.round(h) || 0];
}
function ridePos() {
  const r = S?.ride, rc = r?.course; if (!rc || !r.started) return null;
  const w = S.live?.power_3s || 0, v = rc.speed_kmh || 0;
  if (rc.open) {
    const ow = world.view(); if (!ow?.ll?.length || ow.ll.length < 2) return null;
    const [lat, lon, h] = along(ow.ll, (ow.ll.length - 1) * 10, ow.d);
    return { open: true, lat, lon, h, w, v, d: rc.odo_m, road: ow.road || '' };
  }
  const src = courses.srcOf(rc), at = src?.ll?.length > 1 ? along(src.ll, rc.dist_m, rc.done_m) : null;
  return { open: false, course: `${rc.name}|${Math.round(rc.dist_m)}`, cid: src && !String(src.id).startsWith('k-') ? src.id : null,
    road: rc.name, d: rc.done_m, w, v, ...(at ? { lat: at[0], lon: at[1], h: at[2] } : {}) };
}
// other riders onto the ride maps: on my course, placed by distance along my own line
function placeRiders(list) {
  const rc = S?.ride?.course, src = rc && !rc.open ? courses.srcOf(rc) : null, key = rc && `${rc.name}|${Math.round(rc.dist_m)}`;
  return list.map(o => {
    const p = src?.ll?.length > 1 && !o.open && o.course === key ? along(src.ll, rc.dist_m, o.d) : [o.lat, o.lon];
    return p[0] == null ? null : { id: o.id, lat: p[0], lon: p[1], label: `${o.name} ${o.w} W`, hi: o.friend || o.group };
  }).filter(Boolean);
}
const picker = createPicker({ $, store, world, wOptions: (cur, free) => courses.wOptions(cur, free), go: rideWorld });
$('#owStart').onclick = () => picker.open();
// the workout and course dialogs (detail.js)
const detail = createDetail({ $, store, fit, css, units: () => settings.units, ftp: () => settings.ftp, compile, estimate, drawChart, courses, workouts: () => allWorkouts(),
  presets: WORLD_PRESETS, ride: (c, w) => loadRide(w, c), rideWorld: (p, w) => startWorld({ ...p, name: p.id ? p.name : 'Open world' }, w), openPicker: wid => picker.open(wid),
  edit: w => editWorkout(w), toast, meta: w => { const mine = w.id.startsWith('c-'); return { author: mine ? 'You' : 'Just Watts', source: mine ? 'Custom' : 'Built in', level: lvlDots(w.level) }; } });
// a course picker set to Open world: its start picker, with the workout (if any) chosen; the picker goes back to what it was
function pickedWorld(sel, wid, was) { if (sel.value !== 'ow') return false; sel.value = was; picker.open(wid); return true; }
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
/* ---------- FTP test guide: prompts on screen, from the plan and the live samples ---------- */
const TG = { id: null, ended: false, low: 0, est: null };
const meanOver = (t0, t1) => { let s = 0, n = 0; for (const x of samples) if (x[1] >= t0 && x[1] < t1) { s += x[2]; n++; } return n ? s / n : 0; };
function bestMinute() { let best = 0, sum = 0; for (let i = 0; i < samples.length; i++) { sum += samples[i][2]; if (i >= 60) sum -= samples[i - 60][2]; if (i >= 59) best = Math.max(best, sum / 60); } return best; }
function testGuide() {
  const box = $('#testCue');
  if (!V?.test || !V.cw) { box.style.display = 'none'; return; }
  if (TG.id !== rideId) Object.assign(TG, { id: rideId, ended: false, low: 0, est: null });
  const steps = V.cw.steps, kind = testKind(steps), at = stepAt(V.cw, V.el), left = at ? Math.round(at.s.d - at.into) : 0;
  let main = '', sub = '';
  if (!V.started) {
    main = kind === 'ramp' ? 'Ramp FTP test' : '20 minute FTP test';
    sub = kind === 'ramp' ? '5 min warm up, then +20 W a minute to failure.' : 'Warm up, 5 min hard, recover, 20 min all out.';
  } else if (kind === 'ramp') {
    const b = bestMinute(), est = Math.round(b * 0.75);
    if (!at || at.i === 0) {
      main = 'Warm up'; sub = at ? `Ramp starts in ${fmtT(left)}` : '';
    } else {
      const tgt = S.ride.target_w ?? stepWatts(at.s, 0, V.ftp);
      main = `${tgt} W · segment ${at.i}`; sub = `Best minute ${Math.round(b)} W · FTP ≈ ${est} W`;
      // failure: under 60% of the target (or stopped) for 8 s ends the test
      const p3 = S.live?.power_3s || 0;
      if (V.paused || p3 < tgt * 0.6) TG.low ||= Date.now(); else TG.low = 0;
      if (TG.low && Date.now() - TG.low >= 8000 && !TG.ended) { TG.ended = true; toast(`FTP ≈ ${est} W`); control('end').catch(() => {}); }
    }
  } else {
    const E = steps.findIndex(s => s.free && s.d >= 1200), eff = steps[E];
    const i = at ? at.i : steps.length;
    if (i < E - 2) {
      main = 'Warm up'; sub = `20 min effort in ${fmtT(eff.t0 - V.el)}`;
    } else if (i === E - 2) {
      main = '5 min hard'; sub = `${fmtT(left)} left · steady, not a sprint`;
    } else if (i === E - 1) {
      main = 'Recover'; sub = `20 min effort in ${fmtT(left)}`;
    } else if (i === E) {
      const avg = Math.round(meanOver(eff.t0, eff.t0 + eff.d));
      main = `${fmtT(left)} left`; sub = `Avg ${avg} W · FTP ≈ ${Math.round(avg * 0.95)} W · + and − change resistance`;
    } else {
      TG.est ??= Math.round(meanOver(eff.t0, eff.t0 + eff.d) * 0.95);
      main = `FTP ≈ ${TG.est} W`; sub = 'Cool down. End the ride to save it and set FTP.';
    }
  }
  box.style.display = ''; $('#tcMain').textContent = main; $('#tcSub').textContent = sub;
}
let wakeLock = null;
async function wake(on) { try { if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch {} }

function renderLive() {
  const live = S?.live || {}, p3 = live.power_3s || 0;
  $('#lP').textContent = p3;
  $('#lPs').textContent = settings.weight > 0 ? (p3 / settings.weight).toFixed(1) + ' W/kg' : '';
  // distance: along the course, else virtual distance from trainer speed (like the summary); climbed on a course
  const rc = S?.ride?.course; let m = 0;
  if (rc) m = rc.done_m; else for (const x of samples) m += (x[5] || 0) / 3.6;
  const [dv, du] = distText(m / 1000, settings.units).split(' ');
  $('#lD').textContent = dv; $('#lDu').textContent = du; $('#lDs').textContent = rc ? courses.upText(rc.climbed_m) + ' up' : '';
  $('#cadTile').style.display = cadOn() ? '' : 'none';  // cadence off: no readout, no target
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
  courses.renderRide(S.ride.course);  // first: Map focus may move the chart
  if ($('#v-ride').classList.contains('on')) drawChart($('#rideChart'), { cw: cwDraw, ftp: V.ftp, samples, el: V.el, k: kk });
  wake(V.started);
  renderAdjust(); renderUndo();
}
// on a course, grade mode follows the road; +/- adds an offset to it
const gradeText = () => { const c = S?.ride?.course, g = +V.jr.g; return c ? `road ${c.grade.toFixed(1)}%${g ? ` ${g > 0 ? '+' : ''}${g.toFixed(1)}` : ''}` : `grade ${g.toFixed(1)}%`; };
const valText = m => m === 'r' ? `level ${(+V.jr.r).toFixed(1)}` : m === 'w' ? `${V.jr.w} W` : gradeText();

/* ---------- ride controls: change anything by hand, mid-ride ---------- */
// Each control is one request; the engine applies it at once, logs it as a MANUAL line and echoes
// what changed. Cheap inverses become a 15 s Undo.
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
function act(action, body = {}, undoLabel = null, inverse = null, msg = null) {
  return control(action, body).then(j => {
    toast(msg ? msg(j) : j.did ? didText(j.did) : j.detail || 'Done');
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
  $$('#aCadOn button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === cadOn())); $('#aCadRange').style.display = cadOn() ? '' : 'none';
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
  if (a === 'cadon') return setSetting('cadOn', v === '1', 'cadence');
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
  KeyA: () => sheet(), KeyF: () => courses.map.toggleFocus(), KeyZ: doUndo,
  KeyV: () => courses.map.toggleCamera(), KeyT: () => courses.map.cycleTime(),  // the 3D world
  Comma: () => simStep(-10), Period: () => simStep(10),  // simulated trainer power
  KeyG: () => courses.map.toggleFog(), KeyM: () => courses.map.toggleSound(), KeyK: () => courses.map.cycleKit(),
};
function onKey(e) {
  if (e.key === 'Escape') { if (conn.escape()) return; picker.close(); detail.close(); sheet(false); $('#keysModal').classList.remove('on'); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !typing && $('#v-workouts').classList.contains('on')) { e.preventDefault(); builder.undo(); return; }
  if (!V || typing) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); return doUndo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); return $('#keysModal').classList.toggle('on'); }
  if (!e.shiftKey && world.key(e.code)) { e.preventDefault(); return; }  // open world: arrows pick the way at a junction
  const f = KEYS[e.code]; if (!f) return;
  e.preventDefault(); f(e);
}
document.addEventListener('keydown', onKey);
/* ---------- history (server archive is the source of truth) ---------- */
let rows = [];
const IMPORTED = { garmin: 'Garmin', intervals: 'intervals.icu', strava: 'Strava' };  // the source tag on imported rides
async function renderHistory() {
  try { rows = (await (await F('/api/rides')).json()).rides; } catch { return; }
  const tb = $('#hist'); tb.innerHTML = '';
  $('#histEmpty').style.display = rows.length ? 'none' : '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>${esc(r.name)}${r.garmin ? ' <span class="badge">Garmin</span>' : ''}${IMPORTED[r.source] && /^imp-/.test(r.id) ? ` <span class="badge src">${esc(IMPORTED[r.source])}</span>` : ''}${r.strava ? ' <span class="badge">Strava</span>' : ''}${r.test ? ' <span class="badge">test</span>' : ''}</td><td class="num">${esc(fmtT(r.time_s))}</td><td class="num">${esc(r.avg_w)}</td><td class="num">${esc(r.np)}</td><td class="num">${esc(r.tss)}</td><td class="num">${esc(r.kJ)}</td><td class="num">${esc(r.avg_hr ?? '–')}</td><td class="num">${esc(r.best?.['5m'] ?? '–')}</td>`;
    tr.onclick = () => openSummary(r.id); tb.appendChild(tr);
  }
  renderTrends();
}
const shortDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
async function renderTrends() {
  let t; try { t = await (await F('/api/trends?weeks=12')).json(); } catch { return; }
  const [c, w, h] = fit($('#trendChart')), wk = t.weeks, max = Math.max(50, ...wk.map(x => x.tss));
  const L = 0, B = 22, T = 18, bw = (w - L) / wk.length, ph = h - B - T, font = css('--font') || 'system-ui';
  c.font = `500 11px ${font}`; c.textAlign = 'center'; c.textBaseline = 'bottom';
  c.strokeStyle = css('--line'); c.beginPath(); c.moveTo(0, h - B + 0.5); c.lineTo(w, h - B + 0.5); c.stroke();
  wk.forEach((x, i) => {
    const bh = Math.max(x.tss ? 3 : 0, ph * x.tss / max), cx = L + i * bw + bw / 2, last = i === wk.length - 1, bwid = Math.min(44, bw * 0.56);
    c.fillStyle = last ? css('--acc') : 'rgba(56,189,248,.38)';
    if (bh) { c.beginPath(); (c.roundRect ? c.roundRect(cx - bwid / 2, h - B - bh, bwid, bh, [4, 4, 0, 0]) : c.rect(cx - bwid / 2, h - B - bh, bwid, bh)); c.fill(); }
    c.fillStyle = css('--dim'); if (x.tss) c.fillText(x.tss, cx, h - B - bh - 4);
    c.fillStyle = last ? css('--ink') : css('--faint'); c.textBaseline = 'top';
    c.fillText(shortDate(x.week), cx, h - B + 6); c.textBaseline = 'bottom';
  });
  const f = t.ftp_history.at(-1);
  $('#tFtp').textContent = f ? `FTP ${f.ftp} W · ${f.source} · ${shortDate(f.date)}` + (t.ftp_history.length > 1 ? ` · was ${t.ftp_history.at(-2).ftp} W` : '') : '';
  $('#tBest').innerHTML = `<div class="stat"><div class="k">TSS this week</div><div class="v">${esc(wk.at(-1).tss)}</div><div class="hint">${esc(rows.length)} rides in all</div></div>`
    + ['1m', '5m', '20m'].map(k => `<div class="stat"><div class="k">Best ${k.replace('m', ' min')}</div><div class="v">${esc(t.best[k] ? t.best[k].w + ' W' : '–')}</div><div class="hint">${esc(shortDate(t.best[k]?.date))}</div></div>`).join('');
}
// one-time move of rides that only exist in this browser's storage into the server archive
async function migrateLocalRides() {
  if (store.get('hw.migrated', false)) return;
  const local = store.get('hw.rides', []);
  let ok = true;
  for (const r of local) { try { if (!(await api('/api/ride', r)).ok) ok = false; } catch { ok = false; } }
  if (ok) store.set('hw.migrated', true);
}
let justFinished = null;
async function finishedRide(f) {
  beep(660, 0.4); track('ride_finish', { minutes: Math.round((f.samples || 0) / 60) });
  justFinished = f.id;
  show('history'); await renderHistory();
  await conn.afterRide(f.id).catch(() => {});  // web: send the FIT to connected services; local: the server already queued them
  openSummary(f.id);
}
let openId = null, openRide = null;
async function openSummary(id) {
  let r, d;
  try { [r, d] = await Promise.all([(await F('/api/rides/' + id)).json(), (await F('/api/rides/' + id + '/detail')).json()]); } catch { return; }
  if (!r?.samples) return;
  openId = id; openRide = r; const m = d.summary;
  $('#summary').style.display = ''; $('#histMain').style.display = 'none'; $('#sName').textContent = r.name;
  $('#sDate').textContent = new Date(r.start || r.samples[0][0]).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // the four numbers people look for first, then the rest on one quiet line
  const elev = m.elevation_gain_m ?? m.elev_gain_m;
  const hero = [['Time', fmtT(m.time_s)], ...(!settings.hideVirtualDistance ? [['Distance', distText(m.distance_km, settings.units)]] : []),
    ['Avg power', m.avg_w + ' W'], ['Normalized', m.np + ' W']];
  if (elev > 0) hero.splice(2, 0, ['Elevation', settings.units === 'metric' ? Math.round(elev) + ' m' : Math.round(elev * 3.28084) + ' ft']);
  const rest = [['TSS', m.tss], ['IF', m.if.toFixed(2)], ['Max', m.max_w + ' W'], ['Work', m.kJ + ' kJ'], ['Cadence', m.avg_cad + ' rpm'],
    ...(m.avg_hr ? [['HR', `${m.avg_hr} avg · ${m.max_hr} max`]] : []),
    ['Best', ['1m', '5m', '20m'].filter(k => d.best[k]).map(k => `${k.replace('m', ' min')} ${d.best[k]} W`).join(' · ') || '–']];
  const heroHtml = hero.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const restHtml = rest.map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('');
  $('#sStats').innerHTML = `<div class="shero">${heroHtml}</div><div class="srest">${restHtml}</div>`;
  // a course ride: its route, with how far the rider got
  const ll = r.course?.ll, done = r.samples.at(-1)?.[8], mapDraw = () => drawMap($('#sMap'), { ll, dist: r.course.dist, done, fit, css, redraw: () => openRide === r && mapDraw() });
  $('#sMap').style.display = ll?.length > 1 ? '' : 'none'; if (ll?.length > 1) requestAnimationFrame(mapDraw);
  $('#sSaveCrs').style.display = r.course?.open && r.course.dist >= 100 ? '' : 'none';  // open world: keep the road ridden as a course
  $('#sSaveCrs').disabled = false; $('#sSaveCrs').textContent = 'Save route';
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
    $('#sSetFtp').onclick = () => { settings.ftp = est; saveSettings(['ftp']); renderLib(); renderBuilder(); toast(`FTP set to ${est} W`); };
  } else tb.style.display = 'none';
  const hz = d.hr_zones_s ? Object.values(d.hr_zones_s) : null, hn = hz ? hz.reduce((a, b) => a + b, 0) : 0;
  $('#sHR').style.display = hn ? '' : 'none';
  if (hn) {
    const fl = hrZ().floors;
    $('#sHZones').innerHTML = hz.map((t, i) => `<i style="width:${t / hn * 100}%;background:var(${HRZ_COLORS[i]})"></i>`).join('');
    $('#sHZleg').innerHTML = hz.map((t, i) => `<span><b style="background:var(${HRZ_COLORS[i]})"></b>Z${i + 1} ${esc(i ? fl[i] + '+' : '<' + fl[1])} · ${esc(fmtT(t))}</span>`).join('');
  }
  $('#sLaps').innerHTML = d.laps.map(l => `<tr><td>${esc(l.overtime ? 'free' : l.index)}</td><td class="num">${esc(fmtT(l.time_s))}</td><td class="num">${esc(l.target_w ?? (l.free ? 'free' : '–'))}</td><td class="num">${esc(l.avg_w)}</td><td class="num">${esc(l.max_w)}</td><td class="num">${esc(l.np)}</td><td class="num">${esc(l.avg_hr ?? '–')}</td><td class="num">${esc(l.max_hr ?? '–')}</td><td class="num">${esc(l.avg_cad ?? '–')}</td></tr>`).join('');
  conn.renderSummary(id, { fresh: justFinished === id });
  globalThis.scrollTo?.(0, 0);
}
function closeSummary() { $('#summary').style.display = 'none'; $('#histMain').style.display = ''; openId = null; }
$('#sClose').onclick = () => { closeSummary(); renderTrends(); };
$('#sSaveCrs').onclick = () => {
  const r = openRide, c = r?.course; if (!c?.open) return;
  try { if (courses.add(buildCourse(r.name, c.ll.map((p, i) => ({ lat: p[0], lon: p[1], ele: c.ele[i] }))))) { toast('Saved to Courses'); $('#sSaveCrs').disabled = true; $('#sSaveCrs').textContent = 'Saved'; } } catch (e) { toast(e.message); }
};
$('#sDel').onclick = async () => { if (!openId) return; await api(`/api/rides/${openId}/delete`, {}).catch(() => {}); closeSummary(); renderHistory(); toast(WEB ? 'Deleted' : 'Deleted (kept in rides/trash)'); account?.sync.kick(); };
const fileLink = async (ext, id = openId) => {
  if (!id) return;
  if (WEB) { const data = await B.exportFile(id, ext); if (data) download(fileBaseOf(id === openId ? openRide : await (await F('/api/rides/' + id)).json()) + '.' + ext, data, ext === 'fit' ? 'application/octet-stream' : 'application/xml'); return; }
  const a = document.createElement('a'); a.href = `/api/rides/${id}/${ext}`; a.download = ''; a.click();
};
$('#sFit').onclick = () => fileLink('fit');
$('#sTcx').onclick = () => fileLink('tcx');
function download(name, data, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}


/* ---------- settings tab ---------- */
let strava = {};
async function renderSettings() {
  const cr = settings.cadRange || [85, 95];
  $('#cadLo').value = cr[0]; $('#cadHi').value = cr[1]; $('#cadOn').value = cadOn() ? '1' : '0'; $('#cadLo').disabled = $('#cadHi').disabled = !cadOn();
  $('#sFtp').value = settings.ftp; $('#sWeight').value = weightShow(settings.weight, settings.units);
  $('#units').value = settings.units || 'imperial'; showUnits();
  renderHrZones();
  $('#virtDist').value = settings.hideVirtualDistance ? '1' : '0';
  $('#afterWk').value = settings.afterWorkout || 'grade0';
  $('#gImport').style.display = garminOn ? '' : 'none';
  conn.renderSettings();
  if (WEB) return;
  $('#shareBase').value = settings.shareBaseUrl || '';
  try { strava = await (await F('/api/strava/status')).json(); } catch { strava = {}; }
  const own = strava.mode === 'own';
  $('#stId').value = own ? strava.client_id || '' : '';
  $('#stSecret').value = ''; $('#stSecret').placeholder = strava.has_secret ? 'saved (hidden)' : 'paste once';
  $('#stShared').style.display = own ? '' : 'none';
}
$('#sFtp').onchange = e => { const v = +e.target.value; if (v >= 50 && v <= 600) { settings.ftp = Math.round(v); settings.ftpSrc = 'manual'; saveSettings(['ftp', 'ftpSrc']); renderLib(); renderBuilder(); } renderSettings(); };
$('#sWeight').onchange = e => { settings.weight = weightKg(e.target.value, settings.units); saveSettings(['weight']); renderSettings(); };
$('#units').onchange = e => { settings.units = e.target.value === 'metric' ? 'metric' : 'imperial'; saveSettings(['units']); showSettings(); renderSettings(); };
function showUnits() { $$('.wUnit').forEach(x => { x.textContent = weightUnit(settings.units); }); courses.render(); }
// HR zones: % of max HR (default), Custom floors, or Garmin (local server with Garmin on)
function renderHrZones() {
  const z = hrZ();
  $('#hrMax').value = settings.hrMax || ''; $('#hrMax').placeholder = HR_MAX_DEFAULT;
  const g = $('#hrSrc option[value="garmin"]'); if (g) g.hidden = !garminOn && z.src !== 'garmin';
  $('#hrSrc').value = z.src;
  $$('[data-hz]').forEach(x => { x.value = z.floors[+x.dataset.hz]; });
  $('#hrZ1').textContent = 'below ' + z.floors[1];
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
  const v = [0, ...$$('[data-hz]').map(i => +i.value)]; v[0] = Math.min(hrZ().floors[0], v[1] - 1);  // Z1: everything below Z2 (no input)
  if (validHrFloors(v)) { settings.hrZones = v; settings.hrZonesSrc = 'manual'; saveHr(); }
  else { toast('Zones must rise'); renderHrZones(); }
});
$('#virtDist').onchange = e => { settings.hideVirtualDistance = e.target.value === '1'; saveSettings(['hideVirtualDistance']); };
$('#afterWk').onchange = e => { settings.afterWorkout = e.target.value; saveSettings(['afterWorkout']); };
const cadSave = () => { const lo = +$('#cadLo').value, hi = +$('#cadHi').value; if (lo >= 40 && hi > lo && hi <= 130) { settings.cadRange = [lo, hi]; saveSettings(['cadRange']); } else toast('Cadence range: low < high'); };
$('#cadLo').onchange = cadSave; $('#cadHi').onchange = cadSave;
$('#cadOn').onchange = e => { settings.cadOn = e.target.value === '1'; saveSettings(['cadOn']); renderSettings(); renderLive(); };
$('#hrMax').onchange = e => {
  const v = +e.target.value;
  if (!e.target.value) settings.hrMax = null; else if (v >= 100 && v <= 230) settings.hrMax = Math.round(v); else { toast('Max HR: 100 to 230'); renderHrZones(); return; }
  saveHr();
};
$('#shareBase').onchange = e => { settings.shareBaseUrl = e.target.value.trim(); saveSettings(['shareBaseUrl']); };
$('#stSave').onclick = async () => {
  try { await apiJson('/api/strava/config', { client_id: $('#stId').value.trim(), client_secret: $('#stSecret').value.trim() }); toast('Strava app saved'); }
  catch (e) { toast('Strava: ' + e.message); }
  $('#stSecret').value = ''; await conn.load(); renderSettings();
};
$('#stShared').onclick = async () => {
  try { await apiJson('/api/strava/shared', {}); toast("Using Just Watts's Strava app. Connect again."); } catch (e) { toast('Strava: ' + e.message); }
  await conn.load(); renderSettings();
};
$('#gImport').onclick = async () => {
  try {
    const j = await apiJson('/api/garmin/import', { force: true });
    const got = Object.keys(j.imported); toast(got.length ? 'Imported from Garmin: ' + got.join(', ') : 'Garmin had nothing new');
    await loadSettings(); renderSettings();
  } catch (e) { toast('Garmin import failed: ' + e.message); }
};
{ const u = new URLSearchParams(globalThis.location?.search || ''); if (u.get('strava') === 'connected') { toast('Strava connected'); track('integration_connect', { service: 'strava', ok: 1 }); } if (u.get('strava_error')) toast('Strava: ' + u.get('strava_error')); }

/* ---------- share card (rendered here; Strava's API cannot take photos) ---------- */
async function shareCard() {
  const r = openRide; if (!r) return null;
  const d = await (await F(`/api/rides/${r.id}/detail`)).json(), m = d.summary;
  const W = 1080, H = 1080, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#0c0e11'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#38bdf8'; c.font = '700 40px "Inter var", system-ui'; c.textBaseline = 'top'; c.fillText('Just Watts', 60, 52);
  c.fillStyle = '#e9edf2'; c.font = '700 64px "Inter var", system-ui'; c.fillText(r.name.slice(0, 28), 60, 120);
  c.fillStyle = '#8b95a4'; c.font = '30px "Inter var", system-ui';
  c.fillText(new Date(r.start || r.samples[0][0]).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }), 60, 200);
  const st = [['Time', fmtT(m.time_s)], ['NP', m.np + ' W'], ['Avg', m.avg_w + ' W'], ['TSS', m.tss], ['IF', m.if.toFixed(2)], ['Work', m.kJ + ' kJ'], ['Avg HR', m.avg_hr ?? '–'], ['Max HR', m.max_hr ?? '–']];
  st.forEach(([k, v], i) => {
    const x = 60 + (i % 4) * 245, y = 270 + Math.floor(i / 4) * 130;
    c.fillStyle = '#8b95a4'; c.font = '600 24px "Inter var", system-ui'; c.fillText(k.toUpperCase(), x, y);
    c.fillStyle = '#e9edf2'; c.font = '700 54px "Inter var", system-ui'; c.fillText(String(v), x, y + 34);
  });
  let cw = null;
  if (r.steps) { let t = 0; cw = { steps: r.steps.map(s => { const x = { ...s, t0: t }; t += s.d; return x; }) }; cw.total = Math.max(t, r.samples.at(-1)[1]); }
  c.save(); c.translate(40, 560); c.font = '22px "Inter var", system-ui';
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
  // rides and settings live in IndexedDB (the backend); custom workouts and imported courses in localStorage
  $('#bkExport').onclick = async () => { const j = await (await F('/api/backup')).json(); j.local = { custom, courses: store.get('hw.courses', []) }; download(`justwatts-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(j), 'application/json'); };
  $('#bkImport').onclick = () => $('#bkFile').click();
  $('#bkFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try {
      const b = JSON.parse(await f.text()), j = await apiJson('/api/restore', b);
      const merge = (mine, add, ok) => [...mine, ...(Array.isArray(add) ? add : []).filter(x => ok(x) && !mine.some(m => m.id === x.id))];
      const nw = merge(custom, b.local?.custom, x => typeof x?.id === 'string' && x.id.startsWith('c-') && typeof x.text === 'string' && typeof x.name === 'string');
      const nc = merge(store.get('hw.courses', []), b.local?.courses, x => { if (typeof x?.id !== 'string' || !x.id.startsWith('k-')) return false; try { checkCourse(x); return true; } catch { return false; } });
      const added = nw.length - custom.length; custom = nw; store.set('hw.custom', custom); store.set('hw.courses', nc); courses.reload();
      toast(`Imported ${j.rides} rides` + (added ? `, ${added} workouts` : '')); await loadSettings(); renderHistory(); renderLib();
    } catch (err) { toast('Import failed: ' + err.message); }
  };
}

/* ---------- web build only: optional account (sync) and the community library ---------- */
if (WEB) {
  const SYNC_SETTINGS = ['ftp', 'ftpSrc', 'weight', 'units', 'beeps', 'cadRange', 'cadOn', 'afterWorkout', 'hideVirtualDistance', 'hrZones', 'hrMax', 'hrZonesSrc'];
  const idTime = id => Math.max(1, parseInt(String(id).slice(2), 36) || 1);   // c-/k- ids carry their creation time
  let applying = false;  // sync writing local data: not a local change to push back
  const quiet = f => { applying = true; try { return f(); } finally { applying = false; } };
  const local = {
    list(kind) {
      if (kind === 'workout') return custom.map(w => ({ id: w.id, data: { name: w.name, text: w.text }, updatedAt: w.updatedAt || idTime(w.id) }));
      if (kind === 'course') return store.get('hw.courses', []).map(({ id, updatedAt, ...c }) => ({ id, data: c, updatedAt: updatedAt || idTime(id) }));
      const data = {}; for (const k of SYNC_SETTINGS) if (settings[k] !== undefined) data[k] = settings[k];
      return [{ id: 'main', data, updatedAt: store.get('hw.settingsAt', 1) }];
    },
    put(kind, id, data, at) {
      if (kind === 'workout') {
        if (typeof data?.text !== 'string') return;
        const w = { id, name: String(data.name || 'Untitled').slice(0, 80), text: data.text, updatedAt: at }, i = custom.findIndex(x => x.id === id);
        i >= 0 ? custom[i] = w : custom.unshift(w);
        quiet(() => store.set('hw.custom', custom)); compiled.clear(); renderLibBar(); renderLib();
      } else if (kind === 'course') {
        let c; try { c = checkCourse(data); } catch { return; }
        const list = store.get('hw.courses', []).filter(x => x.id !== id);
        quiet(() => store.set('hw.courses', [{ id, ...c, updatedAt: at }, ...list])); courses.reload();
      } else if (id === 'main' && data && typeof data === 'object') {
        const patch = {}; for (const k of SYNC_SETTINGS) if (k in data) patch[k] = data[k];
        Object.assign(settings, patch); store.set('hw.settings', settings); quiet(() => store.set('hw.settingsAt', at));
        api('/api/settings', patch).catch(() => {});
        showSettings(); if ($('#v-settings').classList.contains('on')) renderSettings();
      }
    },
    remove(kind, id) {
      if (kind === 'workout') { custom = custom.filter(x => x.id !== id); quiet(() => store.set('hw.custom', custom)); if (editing === id) editing = null; renderLibBar(); renderLib(); }
      if (kind === 'course') { quiet(() => store.set('hw.courses', store.get('hw.courses', []).filter(x => x.id !== id))); courses.reload(); }
    },
    async rides() { return (await B.store.rideIds()).map(id => ({ id, updatedAt: Math.max(1, +(/^r-(\d+)$/.exec(id)?.[1] || 1)) })); },
    getRide: id => B.store.getRide(id),
    putRide: r => B.store.putRide(r),
    removeRide: id => B.store.delRide(id),
    rideActive: () => !!S?.ride,
    activeRideId: () => S?.ride?.id || null,
  };
  const { createAccount } = await import('./web/account.js');
  account = createAccount({ $, toast, show, store, local, download,
    onUser: m => { pubBtn(); if (wkTab === 'courses') courses.render(); community?.redraw(); social?.onUser(m); },
    onRides: () => { if ($('#v-history').classList.contains('on') && !openId) renderHistory(); } });
  account.init().then(async on => {
    if (!on) { account = null; return; }
    onSaved = () => { if (!applying) account?.sync.kick(); };
    // the integrations UI's "Sign in" opens the account dialog
    globalThis.justwatts = Object.assign(globalThis.justwatts || {}, { openSignIn: () => account?.open('signin') });
    const { createCommunity } = await import('./web/community.js');
    community = createCommunity({ $, toast, account, ftp: () => settings.ftp, units: () => settings.units, compile, estimate, drawChart,
      drawProfile: (cv, ele, dist) => courses.draw(cv, ele, dist, null), ride: (w, c) => loadRide(w, c),
      drawRoute: (cv, ll, dist, redraw) => drawMap(cv, { ll, dist, fit, css, redraw, style: store.get('hw.mapStyle', 'osm') }),
      saveWorkout: w => { custom.unshift({ id: 'c-' + Date.now().toString(36), name: w.name, text: w.text, updatedAt: Date.now() }); store.set('hw.custom', custom); renderLibBar(); renderLib(); },
      saveCourse: c => courses.add(c), onBack: () => showTab(wkTab),
      onFeed: kind => { if (!$('#v-workouts').classList.contains('on') || community.detail()) return; if (kind === 'workout' && wkTab === 'workouts') renderLib(); if (kind === 'course' && wkTab === 'courses') courses.render(); } });
    renderSrc();
    pubBtn(); if ($('#v-workouts').classList.contains('on')) showTab(wkTab);
    // social: riders nearby, friends, group rides, chat (signed in only; never in the ride's way)
    const { createSocial } = await import('./web/social.js');
    social = createSocial({ $, toast, account, units: () => settings.units, workouts: () => allWorkouts(),
      starts: () => ({ courses: courses.builtIn(), presets: WORLD_PRESETS }), position: ridePos, ride: rideAt, start: () => control('start'),
      onRiders: list => courses.map.setOthers(placeRiders(list)),
      detail: async id => (await (await F(`/api/rides/${encodeURIComponent(id)}/detail`)).json()).summary });
  }).catch(e => console.warn('account', e));
}

/* ---------- nav + settings + init ---------- */
// the view is in the URL (#ride, #history, #settings; Workouts is the bare page) so reload and back keep it
const VIEWS = ['workouts', 'ride', 'history', 'settings'], viewOf = h => VIEWS.includes((h || '').slice(1)) ? h.slice(1) : 'workouts';
function show(v, push = true) {
  const want = v === 'workouts' ? '' : '#' + v, loc = globalThis.location;
  if (push && loc && (loc.hash || '') !== want) try { history.pushState(null, '', want || loc.pathname + loc.search); } catch {}
  aView(v);
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (v === 'workouts') { if (community?.detail()) community.closeItem(); showTab(wkTab); conn.loadPlanned().catch(() => {}); }
  if (v === 'ride' && V) renderRide();
  if (v === 'history') { closeSummary(); renderHistory(); }
  if (v === 'settings') { renderSettings(); account?.refresh(); social?.renderSettings(); }
}
$$('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
$$('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('#btnJust').onclick = () => loadRide(null, courses.byId($('#jrCourse').value));
let jrWas = '';
$('#jrCourse').onchange = e => { if (!pickedWorld(e.target, '', jrWas)) jrWas = e.target.value; };
$('#btnJust2').onclick = () => loadRide(null);
// Workouts page tabs: Workouts (library + builder) or Courses; the last one is remembered
let wkTab = store.get('hw.wkTab', 'workouts') === 'courses' ? 'courses' : 'workouts';
function showTab(t) {
  wkTab = t; store.set('hw.wkTab', t);
  $$('[data-tab]').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  $('#tabWorkouts').style.display = t === 'workouts' ? '' : 'none'; $('#tabCourses').style.display = t === 'courses' ? '' : 'none';
  renderSrc(); community?.refresh();  // showing a list: community items fetch again (the rows already there stay meanwhile)
  if (t === 'workouts') { renderLibBar(); renderLib(); renderBuilder(); } else courses.render();
}
$$('[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('#btnFtp').onclick = () => $('#ftpModal').classList.add('on');
$('#ftpClose').onclick = () => $('#ftpModal').classList.remove('on');
$('#ftpModal').onclick = e => {
  if (e.target?.id === 'ftpModal') return $('#ftpModal').classList.remove('on');
  const b = e.target?.closest?.('[data-t]'); if (!b) return;
  $('#ftpModal').classList.remove('on'); loadRide(FTP_TESTS.find(t => t.id === b.dataset.t));
};
function showSettings() {
  showUnits(); $('#beeps').value = settings.beeps ? '1' : '0';
  renderLib(); renderBuilder();
}
// Settings: the left index scrolls to a section and follows the scroll
$$('[data-set]').forEach(b => b.onclick = () => document.getElementById(b.dataset.set)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
if (globalThis.IntersectionObserver) {
  const seen = new Map(), io = new IntersectionObserver(es => {
    for (const e of es) seen.set(e.target.id, e.isIntersecting);
    const on = $$('[data-set]').find(b => seen.get(b.dataset.set) && b.offsetParent);
    if (on) $$('[data-set]').forEach(b => b.classList.toggle('on', b === on));
  }, { rootMargin: '0px 0px -60% 0px' });
  $$('.sset').forEach(x => io.observe(x));
}
$('#beeps').onchange = e => { settings.beeps = e.target.value === '1'; saveSettings(['beeps']); };
if (VIEWS.includes(globalThis.location?.hash?.slice(1)) && globalThis.location.hash !== '#workouts') setTimeout(() => show(viewOf(globalThis.location.hash), false), 0);
globalThis.addEventListener?.('popstate', () => show(viewOf(globalThis.location?.hash), false));

async function syncHrZones() {
  if (settings.hrZonesSrc !== 'garmin' || !garminOn) return;  // Garmin zones only when chosen in Settings
  try {
    const j = await (await F('/api/garmin/zones')).json();
    if (j.floors?.length === 5) { settings.hrZones = j.floors; settings.hrMax = j.max; settings.hrZonesSrc = 'garmin'; saveSettings(['hrZones', 'hrMax', 'hrZonesSrc']); showSettings(); }
  } catch {}
}
$('#bName').value = 'My workout'; $('#bText').value = '10m 45-75%, 4x(5m 100%, 3m 55%), 8m 50-40%';
showTab(wkTab); aView(document.querySelector('.view.on')?.id?.replace('v-', '') || 'workouts');
setStatus();
loadSettings().then(syncHrZones);
conn.load().then(() => { conn.offerImport(); return conn.loadPlanned(); }).catch(() => {});  // a paused import is offered again
migrateLocalRides().then(renderHistory);
F('/api/strava/status').then(r => r.json()).then(j => { strava = j; }).catch(() => {});
connect();
// --hh: height of the top bar on narrow screens; 0 when the shell is a sidebar
const setHH = () => { const h = document.querySelector('header'); document.documentElement.style.setProperty('--hh', (h.offsetWidth >= globalThis.innerWidth - 1 ? h.offsetHeight : 0) + 'px'); };
setHH();
window.addEventListener('resize', () => { setHH(); if ($('#v-workouts').classList.contains('on')) wkTab === 'workouts' ? renderLib() : courses.render(); if (V) renderRide(); });
window.__hw = { parseWorkout, toText, fitEncode, compile, summarize, state: () => S, backend: B, mode: MODE, conn, world, courses, detail, get account() { return account; }, get community() { return community; }, get social() { return social; } };
