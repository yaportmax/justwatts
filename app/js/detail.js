// Detail dialogs on the Workouts page: a workout (chart, numbers, segments, then a visual course choice and Ride) and
// a course (map first, profile under it, numbers, an optional workout, Ride). DOM only; rides start through app.js.
// Course thumbs for list rows live here too: a small route map over the ride map's tiles, a slim profile under it,
// drawn when a row first scrolls into view (tiles are cached by map.js; a course without GPS shows its profile).
import { esc, fmtT, distText, stepWatts } from './core.js';
import { drawMap } from './map.js';

const X = '<button class="x" data-d="close" aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button>';
const GLOBE = '<svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c-2.5 2.2-2.5 11.8 0 14M10 3c2.5 2.2 2.5 11.8 0 14"/></svg>';

// steepest 100 m of a course (ele: one point every 10 m), in %
export function maxGrade(ele) {
  if (!ele?.length || ele.length < 2) return 0;
  const n = Math.min(10, ele.length - 1); let m = 0;
  for (let i = 0; i + n < ele.length; i++) m = Math.max(m, (ele[i + n] - ele[i]) / (n * 10) * 100);
  return m;
}
// work in kJ at this FTP (free segments as half FTP, as the TSS estimate does)
export function workKj(cw, ftp) {
  let j = 0; for (const s of cw.steps) for (let t = 0; t < s.d; t++) j += s.free ? 0.5 * ftp : stepWatts(s, t, ftp);
  return Math.round(j / 1000);
}

// ride(c|null, w|null) rides a course (null: flat); rideWorld(start, w) rides open world from a start; openPicker(wid) opens
// the open-world map picker; edit(w) opens the builder (a copy for built-ins); meta(w) -> { author, source, level } for a workout.
export function createDetail({ $, store, fit, css, units, ftp, compile, estimate, drawChart, courses, workouts, presets, ride, rideWorld, openPicker, edit, meta, toast }) {
  const box = $('#detModal'), dlg = $('#detDlg');
  let cur = null;  // { kind: 'workout', w, cw, pick } | { kind: 'course', c, wid, q }
  const lastPick = () => { const v = store.get('hw.wkCourse', ''); return v === 'ow' || courses.byId(v) ? v : ''; };
  const owStart = () => store.get('hw.owStart', null) || presets[0];
  const up = m => units() === 'metric' ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`;
  const close = () => { box.classList.remove('on'); cur = null; };
  const stats = list => `<div class="bstats num">${list.map(([v, k]) => `<span><b>${esc(v)}</b><small>${esc(k)}</small></span>`).join('')}</div>`;
  const later = f => (globalThis.requestAnimationFrame || setTimeout)(f);

  // the route on a canvas (redrawn as tiles arrive, while it is still on the page)
  function route(cv, c, attr = true) {
    const go = () => { if (cv.isConnected !== false) drawMap(cv, { ll: c.ll, dist: c.dist, fit, css, redraw: go, attr, style: store.get('hw.mapStyle', 'osm') }); };
    go();
  }
  // a course preview: the map, the profile under it (no GPS: a larger profile)
  const preview = (c, big = false) => c.ll?.length > 1
    ? `<canvas class="dmap${big ? ' big' : ''}" data-cv="map"></canvas><canvas class="dprof" data-cv="prof"></canvas>`
    : `<div class="dnomap"><canvas class="dprof tall" data-cv="prof"></canvas></div>`;
  function drawPreview(c) {
    later(() => {
      const m = dlg.querySelector('[data-cv=map]'), p = dlg.querySelector('[data-cv=prof]');
      if (m && c.ll?.length > 1) route(m, c);
      if (p && c.ele?.length) courses.draw(p, c.ele, c.dist, null);
    });
  }

  /* ---------- workout ---------- */
  function openWorkout(w) {
    const cw = (() => { try { return compile(w); } catch { return null; } })(); if (!cw) return;
    cur = { kind: 'workout', w, cw, pick: lastPick() };
    box.classList.add('on'); renderWorkout();
  }
  function coursePreview() {
    const p = cur.pick;
    if (p === 'ow') {
      const at = owStart();
      return `<div class="dow"><div class="chips">${presets.map(s => `<button class="chip${at.id === s.id ? ' on' : ''}" data-d="start" data-v="${esc(s.id)}">${esc(s.name)}</button>`).join('')}</div>
        <div class="hint">${esc(at.id ? at.name : 'Picked on the map')}</div><button data-d="map">${GLOBE}Pick on map</button></div>`;
    }
    const c = courses.byId(p);
    return c ? preview(c) + `<div class="dcs num">${distText(c.dist / 1000, units())} · ${up(c.gain)} up · max ${maxGrade(c.ele).toFixed(1)}%</div>` : '<div class="dflat hint">Flat road. ERG holds the watts.</div>';
  }
  function renderWorkout() {
    const { w, cw, pick } = cur, f = ftp(), e = estimate(cw, f), m = meta(w), own = w.id.startsWith('c-');
    const opts = [['', 'Flat', ''], ['ow', 'Open world: Marin', 'Any road'], ...courses.all().map(c => [c.id, c.name, distText(c.dist / 1000, units())])];
    dlg.innerHTML = `<div class="dhead"><div class="dtitle"><b>${esc(w.name)}</b><div class="sub">${[m.author, m.source, w.category].filter(Boolean).map(esc).join(' · ')}${m.level ? ' ' + m.level : ''}</div></div>${X}</div>
      ${w.purpose ? `<p class="dpur">${esc(w.purpose)}</p>` : ''}
      <canvas class="dchart" data-cv="chart"></canvas>
      ${stats([[fmtT(cw.total), 'Time'], [Math.round(e.tss), 'TSS'], [e.IF.toFixed(2), 'IF'], [workKj(cw, f), 'kJ']])}
      <div class="cmtext">${esc(w.text)}</div>
      <div class="sec-h">Course</div>
      <div class="cpick"><div class="clist" role="listbox" aria-label="Course">${opts.map(([v, n, d]) => `<button role="option" class="copt${v === pick ? ' on' : ''}" aria-selected="${v === pick}" data-d="pick" data-v="${esc(v)}"><span>${esc(n)}</span><small class="num">${esc(d)}</small></button>`).join('')}</div>
        <div class="cprev">${coursePreview()}</div></div>
      <div class="dfoot"><span></span><div class="row" style="gap:8px">${w.test ? '' : `<button data-d="edit">${own ? 'Edit' : 'Edit a copy'}</button>`}<button class="pri" data-d="ride">Ride</button></div></div>`;
    later(() => { const cv = dlg.querySelector('[data-cv=chart]'); if (cv) drawChart(cv, { cw, ftp: f, samples: [], el: null, k: 1 }); });
    const c = courses.byId(pick); if (c) drawPreview(c);
  }
  function pick(v) { if (cur?.kind !== 'workout') return; cur.pick = v; store.set('hw.wkCourse', v); renderWorkout(); }
  // ride a workout on a pick: '' flat, 'ow' open world from the last start, or a course id
  async function rideOn(w, p) {
    if (p === 'ow') { try { return await rideWorld(owStart(), w); } catch (e) { toast(e.message || 'Could not load the roads'); return false; } }
    return ride(courses.byId(p), w);
  }
  const rideDefault = w => rideOn(w, lastPick());

  /* ---------- course ---------- */
  function openCourse(c) { cur = { kind: 'course', c, wid: '', q: '' }; box.classList.add('on'); renderCourse(); }
  function wList() {
    const q = cur.q.trim().toLowerCase(), ws = workouts().filter(w => !w.test && (!q || w.name.toLowerCase().includes(q) || String(w.category || '').toLowerCase().includes(q)));
    return [['', 'Free ride', 'Follow the road'], ...ws.map(w => { let t = ''; try { t = fmtT(compile(w).total); } catch {} return [w.id, w.name, t]; })]
      .map(([v, n, d]) => `<button role="option" class="copt${v === cur.wid ? ' on' : ''}" aria-selected="${v === cur.wid}" data-d="wk" data-v="${esc(v)}"><span>${esc(n)}</span><small class="num">${esc(d)}</small></button>`).join('');
  }
  function renderCourse() {
    const { c } = cur, own = c.id.startsWith('k-');
    dlg.innerHTML = `<div class="dhead"><div class="dtitle"><b>${esc(c.name)}</b><div class="sub">${own ? 'You · Imported' : 'Just Watts'}</div></div>${X}</div>
      ${preview(c, true)}
      ${stats([[distText(c.dist / 1000, units()), 'Distance'], [up(c.gain), 'Climb'], [maxGrade(c.ele).toFixed(1) + '%', 'Max grade']])}
      <div class="sec-h">Workout</div>
      <label class="search"><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/></svg><input data-d="q" type="search" placeholder="Search workouts" aria-label="Search workouts" value="${esc(cur.q)}"></label>
      <div class="clist wlist" role="listbox" aria-label="Workout">${wList()}</div>
      <div class="dfoot"><span class="hint">Watt segments stay ERG, free ones follow the road.</span><button class="pri" data-d="ride">Ride</button></div>`;
    drawPreview(c);
  }
  function pickWorkout(id) { if (cur?.kind !== 'course') return; cur.wid = id; const l = dlg.querySelector('.wlist'); if (l) l.innerHTML = wList(); else renderCourse(); }

  async function rideNow() {
    if (!cur) return false;
    const k = cur, ok = k.kind === 'workout' ? await rideOn(k.w, k.pick) : await ride(k.c, workouts().find(w => w.id === k.wid) || null);
    if (ok !== false && cur === k) close();
    return ok;
  }
  async function act(a, el) {
    if (!cur) return;
    if (a === 'close') return close();
    if (a === 'pick') return pick(el.dataset.v);
    if (a === 'start') { store.set('hw.owStart', presets.find(p => p.id === el.dataset.v)); return renderWorkout(); }
    if (a === 'map') { const wid = cur.w.id; close(); return openPicker(wid); }
    if (a === 'edit') { const w = cur.w; close(); return edit(w); }
    if (a === 'wk') return pickWorkout(el.dataset.v);
    if (a === 'ride') return rideNow();
  }
  box.onclick = e => { if (e?.target === box) return close(); const b = e?.target?.closest?.('[data-d]'); if (b && b.dataset.d !== 'q') act(b.dataset.d, b); };
  box.oninput = e => { if (e?.target?.dataset?.d === 'q' && cur?.kind === 'course') { cur.q = e.target.value; dlg.querySelector('.wlist').innerHTML = wList(); } };
  return { openWorkout, openCourse, close, pick, pickWorkout, act, ride: rideNow, rideDefault, lastPick, isOpen: () => box.classList.contains('on'), state: () => cur, html: () => dlg.innerHTML };
}

// course thumbs on list rows: drawn when first seen; later renders draw at once (tiles are cached in map.js)
export function createThumbs({ fit, css, store, draw }) {
  const seen = new Set();
  const io = globalThis.IntersectionObserver ? new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); paint(e.target); }
  }, { rootMargin: '200px 0px' }) : null;
  function paint(el) {
    const c = el._course; if (!c) return; seen.add(c.id);
    const m = el.querySelector('canvas.tmap'), p = el.querySelector('canvas.tprof');
    if (m && c.ll?.length > 1) { const go = () => { if (el.isConnected !== false) drawMap(m, { ll: c.ll, dist: c.dist, fit, css, redraw: go, attr: false, ends: false, style: store.get('hw.mapStyle', 'osm') }); }; go(); }
    if (p && c.ele?.length) draw(p, c.ele, c.dist, null);
  }
  // the thumb's markup (a map with a slim profile, or a profile placeholder) and, once on the page, mount(el, c)
  const html = c => c.ll?.length > 1 ? '<div class="cthumb"><canvas class="tmap"></canvas><canvas class="tprof"></canvas></div>' : '<div class="cthumb nomap"><canvas class="tprof"></canvas></div>';
  function mount(el, c) {
    if (!el) return; el._course = c;
    if (!io || seen.has(c.id)) (globalThis.requestAnimationFrame || setTimeout)(() => paint(el)); else io.observe(el);
  }
  return { html, mount };
}
