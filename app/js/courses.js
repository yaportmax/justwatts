// Courses UI: the Courses tab on the Workouts page, the course pickers and the elevation strip on the ride screen.
// DOM only. The course math is in course.js; position, grade and speed come from the ride engine.
import { esc, distText, isMetric } from './core.js';
import { parseTrack, parseFit, buildCourse, SAMPLE_COURSES } from './course.js';
import { ROUTE_COURSES } from './course-routes.js';
import { createRideMap } from './ridemap.js';
import { createThumbs } from './detail.js';
import { createListSort } from './listsort.js';
import { track } from './analytics.js';

const FT = 3.28084;
const HEART = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z"/></svg>';
// the Author cell of a library row: Just Watts, You, or a community publisher with the item's likes
export const authorCell = (name, it = null) => `<div class="au${name === 'You' ? ' you' : ''}"><span>${esc(name)}</span>${it ? `<span class="lk num" title="Likes">${HEART}${it.likes | 0}</span>` : ''}</div>`;

// ride(course, workout|null) starts a ride; workouts() lists what a course can pair with; openCourse(c) opens a course's dialog (detail.js).
// source() is the Source filter shared with the Workouts tab: 'all' | 'jw' | 'mine' | 'comm'. comm(filter) returns the
// community feed for the list (web build, community.js) or null; openComm / rideComm / moreComm act on it.
// publish(c) returns a handler when the course may be published (web, signed in).
// world: the open-world road provider (world.js), for its map line, junction prompt and road name.
export function createCourses({ $, store, toast, fit, css, units, ride, workouts, relayout, source = () => 'all', comm = () => null, openComm = () => {}, rideComm = () => {}, moreComm = () => {}, publish = () => null, world = null, openWorld = null, openCourse = () => {} }) {
  let mine = store.get('hw.courses', []);
  store.del('hw.course');  // the old "use this course for every ride" choice: rides now pick a course each time
  const cf = Object.assign({ q: '', sort: '' }, store.get('hw.crsFilter', {}));  // search and sort: a per-browser convenience
  const builtIn = () => [...ROUTE_COURSES, ...SAMPLE_COURSES];
  const all = () => [...mine, ...builtIn()];
  const byId = id => (id && all().find(c => c.id === id)) || null;
  // the course a ride is on (the ride state has its name and length, not its line)
  const srcOf = rc => (rc && !rc.open && all().find(c => c.name === rc.name && Math.abs(c.dist - rc.dist_m) < 1)) || null;
  const upText = m => isMetric(units()) ? `${Math.round(m)} m` : `${Math.round(m * FT)} ft`;
  const info = c => `${distText(c.dist / 1000, units())} · ${upText(c.gain)} up`;
  // <option>s for a course picker: Flat (no course), Open world (opens its start picker: value 'ow'), then every course
  const options = cur => `<option value="">Flat</option>` + (openWorld ? '<option value="ow">Open world: Marin</option>' : '') + all().map(c => `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.name)} · ${info(c)}</option>`).join('');
  // <option>s for a workout picker on a course: free ride, then my workouts, then the library by category
  function wOptions(cur, free = 'Free ride on this course') {
    const groups = new Map();
    for (const w of workouts()) { const g = w.id.startsWith('c-') ? 'Mine' : w.category || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(w); }
    return `<option value="">${esc(free)}</option>` + [...groups].map(([g, ws]) => `<optgroup label="${esc(g)}">${ws.map(w => `<option value="${esc(w.id)}"${w.id === cur ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</optgroup>`).join('');
  }

  // elevation profile; done = metres ridden (null: no marker). Flat courses get a 20 m scale so they look flat.
  function draw(cv, ele, dist, done) {
    const [c, w, h] = fit(cv); if (!ele?.length) return;
    let lo = Math.min(...ele), hi = Math.max(...ele); if (hi - lo < 150) { lo = Math.min(...ele) - 5; hi = lo + 150; }  // a flat course looks flat
    const X = i => i / (ele.length - 1) * w, Y = e => h - 3 - (e - lo) / (hi - lo) * (h - 10);
    const path = () => { c.beginPath(); c.moveTo(0, h); ele.forEach((e, i) => c.lineTo(X(i), Y(e))); c.lineTo(w, h); c.closePath(); };
    c.fillStyle = css('--panel2'); path(); c.fill();
    const fx = done == null ? 0 : Math.min(1, done / dist) * w;
    if (fx > 0) { c.save(); c.beginPath(); c.rect(0, 0, fx, h); c.clip(); c.globalAlpha = 0.35; c.fillStyle = css('--acc'); path(); c.fill(); c.restore(); }
    c.strokeStyle = css('--dim'); c.lineWidth = 1.25; c.beginPath(); ele.forEach((e, i) => (i ? c.lineTo : c.moveTo).call(c, X(i), Y(e))); c.stroke();
    if (done != null) {
      const f = Math.min(1, done / dist) * (ele.length - 1), i = Math.min(ele.length - 2, Math.floor(f)), e = ele[i] + (ele[i + 1] - ele[i]) * (f - i);
      c.fillStyle = css('--ink'); c.beginPath(); c.arc(fx, Y(e), 4, 0, 2 * Math.PI); c.fill();
    }
  }

  // the list: yours and the Just Watts courses (Featured: yours first), community items after them (first, for the community sorts)
  // sort: Featured, the select's presets, or a header (Course, Author, Distance, Climb); community sorts put community first
  const LS = createListSort({ short: ['dist', 'asc'], long: ['dist', 'desc'], hilly: ['climb', 'desc'], name: ['name', 'asc'] },
    [['', 'Featured'], ['short', 'Shortest'], ['long', 'Longest'], ['hilly', 'Most climb'], ['name', 'Name'], ['liked', 'Most liked'], ['ridden', 'Most ridden'], ['new', 'Newest']]);
  const COLS = [['', '', ''], ['name', 'Course'], ['author', 'Author'], ['dist', 'Distance', 'r'], ['climb', 'Climb', 'r']];
  const val = (x, k) => k === 'name' ? x.c.name : k === 'author' ? x.au : k === 'dist' ? x.c.dist : k === 'climb' ? x.c.gain : 0;
  const hit = (q, ...xs) => !q || xs.some(x => x && String(x).toLowerCase().includes(q));
  function rows() {
    const src = source(), q = cf.q.trim().toLowerCase(), by = LS.cmp(cf.sort, val);
    const local = (src === 'comm' ? [] : src === 'mine' ? mine : src === 'jw' ? builtIn() : all())
      .map(c => ({ c, au: c.id.startsWith('k-') ? 'You' : 'Just Watts' })).filter(x => hit(q, x.c.name, x.au));
    if (by) local.sort(by);
    const f = comm(cf);
    let cm = (f?.items || []).filter(it => it.kind === 'course' && it.distM > 0)
      .map(it => ({ c: { id: 'm-' + it.id, name: it.name, dist: it.distM, gain: it.gainM || 0, ele: it.profile || [] }, it, au: it.author }));
    if (src === 'all') cm = cm.filter(x => !mine.some(k => k.name === x.c.name && Math.abs(k.dist - x.c.dist) < 5));  // saved to mine already
    if (by) cm.sort(by);
    return { list: ['liked', 'ridden', 'new'].includes(cf.sort) ? [...cm, ...local] : [...local, ...cm], f, src };
  }
  function render() {
    const jr = $('#jrCourse');  // Just ride's course: Flat unless picked
    if (jr) { const v = byId(jr.value) ? jr.value : ''; jr.innerHTML = options(v); jr.value = v; }
    const box = $('#crsList'); if (!box) return;
    box.innerHTML = '';
    if ($('#crsQ')) $('#crsQ').value = cf.q;
    if ($('#crsSort')) { $('#crsSort').innerHTML = LS.options(cf.sort, { name: 'Course', author: 'Author', dist: 'Distance', climb: 'Climb' }); $('#crsSort').value = cf.sort; }
    if ($('#crsHead')) $('#crsHead').innerHTML = LS.head(cf.sort, COLS);
    const { list, f, src } = rows();
    const empty = $('#crsEmpty'), more = $('#crsMore');
    if (empty) {
      empty.style.display = list.length ? 'none' : '';
      empty.textContent = src === 'mine' && !mine.length ? 'No imported routes yet. Import route adds a GPX, TCX or FIT file.'
        : src === 'comm' && f?.busy ? 'Loading' : src === 'comm' && f?.error ? f.error : src === 'comm' && !cf.q ? 'Nothing published yet.' : 'No courses match.';
    }
    if (more) more.style.display = src === 'comm' && f?.more && !f.busy ? '' : 'none';
    // Open world first: any road from a start you pick (its picker has the workout choice)
    if (openWorld && (src === 'all' || src === 'jw') && hit(cf.q.trim().toLowerCase(), 'Open world: Marin', 'Just Watts')) {
      const card = document.createElement('div'); card.className = 'lrow ow';
      card.innerHTML = `<div class="owic"><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c-2.5 2.2-2.5 11.8 0 14M10 3c2.5 2.2 2.5 11.8 0 14"/></svg></div>
        <div class="lmain"><div class="t">Open world: Marin</div><div class="p">Any road, pick a start</div></div>${authorCell('Just Watts')}<div class="m num r">Any</div><div class="m num r"></div>
        <div class="lact"><button class="pri" data-a="ride">Ride</button></div>`;
      box.appendChild(card);
      card.onclick = () => openWorld('');
      if (empty && !list.length) empty.style.display = 'none';
    }
    for (const { c, it, au } of list) {
      const own = c.id.startsWith('k-'), pub = own && publish(c);
      const card = document.createElement('div'); card.className = 'lrow' + (it ? ' cm' : '');
      card.innerHTML = `${thumbs.html(c)}<div class="lmain"><div class="t">${esc(c.name)}</div>${own ? '<div class="p">Imported</div>' : it ? `<div class="p">${[`<span class="pau">${esc(it.author)}</span>`, ...(it.tags || []).map(esc)].join('<i class="psep"> · </i>')}</div>` : ''}</div>
        ${authorCell(au, it)}<div class="m num r">${distText(c.dist / 1000, units())}</div><div class="m num r">${upText(c.gain)}</div>
        <div class="lact"><button class="pri" data-a="ride">Ride</button>${pub ? '<button data-a="pub">Publish</button>' : ''}${own ? '<button data-a="del" class="danger">Delete</button>' : ''}</div>`;
      box.appendChild(card);
      thumbs.mount(card.querySelector('.cthumb'), c);
      if (it) {  // a community course: the row opens its page, Ride rides it
        card.onclick = ev => { if (ev?.target?.closest?.('[data-a]')?.dataset.a === 'ride') return rideComm(it.id); openComm(it.id); };
        card.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); rideComm(it.id); };
        continue;
      }
      const go = () => ride(c, null);  // one click: a free ride; the dialog pairs a workout
      card.onclick = ev => {
        const a = ev?.target?.closest?.('[data-a]')?.dataset.a;
        if (a === 'ride') return go();
        if (a) return;
        openCourse(c);
      };
      card.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); go(); };
      if (pub) card.querySelector('[data-a=pub]').onclick = ev => { ev?.stopPropagation?.(); pub(); };
      if (own) card.querySelector('[data-a=del]').onclick = ev => { ev?.stopPropagation?.(); mine = mine.filter(x => x.id !== c.id); store.set('hw.courses', mine); render(); };
    }
  }
  const setCf = patch => { Object.assign(cf, patch); store.set('hw.crsFilter', cf); render(); };
  if ($('#crsQ')) $('#crsQ').oninput = e => setCf({ q: e.target.value });
  if ($('#crsSort')) $('#crsSort').onchange = e => setCf({ sort: e.target.value });
  if ($('#crsHead')) $('#crsHead').onclick = e => { const b = e?.target?.closest?.('[data-sort]'); if (b) setCf({ sort: LS.click(cf.sort, b.dataset.sort) }); };
  if ($('#crsMore')) $('#crsMore').onclick = () => moreComm();

  async function importFile(file) {
    try {
      const t = /\.fit$/i.test(file.name) ? parseFit(new Uint8Array(await file.arrayBuffer())) : parseTrack(await file.text());
      if (!t.pts.length) throw new Error('No track points');
      const c = { id: 'k-' + Date.now().toString(36), ...buildCourse(t.name || file.name.replace(/\.\w+$/, ''), t.pts) };
      if (!store.set('hw.courses', [c, ...mine])) throw new Error('No room to save it');
      mine = [c, ...mine]; render(); toast(`Added ${c.name}`); track('course_import');
    } catch (e) { toast('Import failed: ' + e.message); }
  }
  $('#crsImport').onclick = () => $('#crsFile').click();
  $('#crsFile').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); };

  const thumbs = createThumbs({ fit, css, store, draw });
  const map = createRideMap({ $, store, fit, css, toast, relayout });
  // ride screen: map, profile with the rider's position, distance left, grade, speed (distance and climbed are in the top row)
  function renderRide(rc) {
    const box = $('#crsRide'); if (!box) return;
    // the map: the ride state has no line, so take it from the course list (gone if the course was deleted); open world: from the page's road plan
    const ow = rc?.open ? world?.view() : null, src = srcOf(rc);
    box.style.display = rc ? '' : 'none';
    map.update(rc?.open ? ow?.ll : src?.ll, rc, ow?.alts); turnPrompt(ow); if (!rc) return;
    const u = units(), spd = isMetric(u) ? `${Math.round(rc.speed_kmh)} km/h` : `${Math.round(rc.speed_kmh * 0.621371)} mph`;
    if (ow) {  // open world: about 1 km behind and 2.5 km ahead
      const i = Math.floor(ow.d / 10), a = Math.max(0, i - 100), b = Math.min(ow.ele.length, i + 250);
      draw($('#crsChart'), ow.ele.slice(a, b), (b - a - 1) * 10, ow.d - a * 10);
      $('#crsK').innerHTML = `<span><b>${rc.grade.toFixed(1)}%</b></span>${ow.road ? `<span>${esc(ow.road)}</span>` : ''}<span>${spd}</span>`;
      return;
    }
    draw($('#crsChart'), rc.profile, rc.dist_m, rc.done_m);
    const [left, lu] = distText(Math.max(0, rc.dist_m - rc.done_m) / 1000, u).split(' ');
    $('#crsK').innerHTML = `<span><b>${rc.grade.toFixed(1)}%</b></span>${rc.end ? '<span>Finished</span>' : `<span><b>${left}</b> ${lu} to go</span>`}<span>${spd}</span>`;
  }
  // open world: the junction ahead, its ways left to right (tap one, or the arrow keys), the road ahead still loading
  let turnKey = '';
  function turnPrompt(ow) {
    const el = $('#owTurn'); if (!el) return;
    const t = ow?.turn, k = !ow ? '' : t ? JSON.stringify(t.opts) + t.dead : ow.wait ? 'wait' : '';
    if (k !== turnKey) {
      turnKey = k; el.classList.toggle('on', !!k);
      el.innerHTML = !k ? '' : !t ? '<span class="owm">Loading roads</span>' : `<span class="owm num" id="owDist"></span>` + (t.dead ? '<span class="owd">Dead end</span>'
        : t.opts.map(o => `<button data-to="${o.to}" class="${o.on ? 'on' : ''}" aria-pressed="${o.on}"><svg class="owa" viewBox="0 0 20 20" aria-hidden="true" style="transform:rotate(${o.a}deg)"><path d="M10 17V4M5 9l5-5 5 5"/></svg>${esc(o.name)}</button>`).join(''));
    }
    if (t) { const m = t.m, ft = m * 3.28084; $('#owDist').textContent = isMetric(units()) ? `${Math.round(m / 10) * 10} m` : `${Math.round(ft / 50) * 50} ft`; }
  }
  if ($('#owTurn')) $('#owTurn').onclick = e => { const b = e?.target?.closest?.('[data-to]'); if (b) world?.choose(+b.dataset.to); };

  render();
  // a copy of a course (community "Save to mine"): imported like a file
  function add(c) {
    const k = { id: 'k-' + Date.now().toString(36), name: c.name, dist: c.dist, gain: c.gain, ele: c.ele, ll: c.ll || [], updatedAt: Date.now() };
    if (!store.set('hw.courses', [k, ...mine])) { toast('No room to save it'); return null; }
    mine = [k, ...mine]; render(); return k;
  }
  return { byId, srcOf, builtIn, all, filter: () => cf, options, wOptions, render, renderRide, map, upText, draw, add, reload: () => { mine = store.get('hw.courses', []); render(); } };
}
