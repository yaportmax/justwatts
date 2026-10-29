// Courses UI: the Courses tab on the Workouts page, the course pickers and the elevation strip on the ride screen.
// DOM only. The course math is in course.js; position, grade and speed come from the ride engine.
import { esc, distText, isMetric } from './core.js';
import { parseTrack, parseFit, buildCourse, SAMPLE_COURSES } from './course.js';
import { ROUTE_COURSES } from './course-routes.js';
import { createRideMap } from './ridemap.js';

const FT = 3.28084;

// ride(course, workout|null) starts a ride; workouts() lists what the course row can pair with.
export function createCourses({ $, store, toast, fit, css, units, ride, workouts, relayout }) {
  let mine = store.get('hw.courses', []);
  store.del('hw.course');  // the old "use this course for every ride" choice: rides now pick a course each time
  let sel = '', pickW = '';  // the selected course row and the workout picked on it
  const all = () => [...mine, ...ROUTE_COURSES, ...SAMPLE_COURSES];
  const byId = id => (id && all().find(c => c.id === id)) || null;
  const upText = m => isMetric(units()) ? `${Math.round(m)} m` : `${Math.round(m * FT)} ft`;
  const info = c => `${distText(c.dist / 1000, units())} · ${upText(c.gain)} up`;
  // <option>s for a course picker: Flat (no course), then every course with its distance and climb
  const options = cur => `<option value="">Flat</option>` + all().map(c => `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.name)} · ${info(c)}</option>`).join('');
  // <option>s for a workout picker on a course: free ride, then my workouts, then the library by category
  function wOptions(cur) {
    const groups = new Map();
    for (const w of workouts()) { const g = w.id.startsWith('c-') ? 'Mine' : w.category || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(w); }
    return `<option value="">Free ride on this course</option>` + [...groups].map(([g, ws]) => `<optgroup label="${esc(g)}">${ws.map(w => `<option value="${esc(w.id)}"${w.id === cur ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</optgroup>`).join('');
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

  function render() {
    const jr = $('#jrCourse');  // Just ride's course: Flat unless picked
    if (jr) { const v = byId(jr.value) ? jr.value : ''; jr.innerHTML = options(v); jr.value = v; }
    const box = $('#crsList'); if (!box) return;
    box.innerHTML = '';
    for (const c of all()) {
      const own = c.id.startsWith('k-'), on = c.id === sel;
      const card = document.createElement('div'); card.className = 'lrow' + (on ? ' sel' : '');
      card.innerHTML = `<canvas></canvas><div class="lmain"><div class="t">${esc(c.name)}</div>${own ? '<div class="p">Imported</div>' : ''}</div>
        <div class="m num r">${distText(c.dist / 1000, units())}</div><div class="m num r">${upText(c.gain)}</div>
        <div class="lact">${on ? `<select class="pick" data-a="pick" aria-label="Workout">${wOptions(pickW)}</select>` : ''}<button class="pri" data-a="ride">Ride</button>${own ? '<button data-a="del" class="danger">Delete</button>' : ''}</div>`;
      box.appendChild(card);
      requestAnimationFrame(() => draw(card.querySelector('canvas'), c.ele, c.dist, null));
      const go = () => ride(c, on ? workouts().find(w => w.id === pickW) || null : null);
      card.onclick = ev => {
        const a = ev?.target?.closest?.('[data-a]')?.dataset.a;
        if (a === 'ride') return go();
        if (a) return;
        sel = on ? '' : c.id; pickW = ''; render();
      };
      card.querySelector('[data-a=ride]').onclick = ev => { ev?.stopPropagation?.(); go(); };
      if (on) card.querySelector('[data-a=pick]').onchange = e => { pickW = e.target.value; };
      if (own) card.querySelector('[data-a=del]').onclick = ev => { ev?.stopPropagation?.(); mine = mine.filter(x => x.id !== c.id); if (sel === c.id) sel = ''; store.set('hw.courses', mine); render(); };
    }
  }

  async function importFile(file) {
    try {
      const t = /\.fit$/i.test(file.name) ? parseFit(new Uint8Array(await file.arrayBuffer())) : parseTrack(await file.text());
      if (!t.pts.length) throw new Error('No track points');
      const c = { id: 'k-' + Date.now().toString(36), ...buildCourse(t.name || file.name.replace(/\.\w+$/, ''), t.pts) };
      if (!store.set('hw.courses', [c, ...mine])) throw new Error('No room to save it');
      mine = [c, ...mine]; render(); toast(`Added ${c.name}`);
    } catch (e) { toast('Import failed: ' + e.message); }
  }
  $('#crsImport').onclick = () => $('#crsFile').click();
  $('#crsFile').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); };

  const map = createRideMap({ $, store, fit, css, toast, relayout });
  // ride screen: map, profile with the rider's position, distance left, grade, speed (distance and climbed are in the top row)
  function renderRide(rc) {
    const box = $('#crsRide'); if (!box) return;
    // the map: the ride state has no line, so take it from the course list (gone if the course was deleted)
    const src = rc && all().find(c => c.name === rc.name && Math.abs(c.dist - rc.dist_m) < 1);
    box.style.display = rc ? '' : 'none';
    map.update(src?.ll, rc); if (!rc) return;
    draw($('#crsChart'), rc.profile, rc.dist_m, rc.done_m);
    const u = units(), [left, lu] = distText(Math.max(0, rc.dist_m - rc.done_m) / 1000, u).split(' '), spd = isMetric(u) ? `${Math.round(rc.speed_kmh)} km/h` : `${Math.round(rc.speed_kmh * 0.621371)} mph`;
    $('#crsK').innerHTML = `<span><b>${rc.grade.toFixed(1)}%</b></span>${rc.end ? '<span>Finished</span>' : `<span><b>${left}</b> ${lu} to go</span>`}<span>${spd}</span>`;
  }

  render();
  return { byId, options, render, renderRide, map, upText, reload: () => { mine = store.get('hw.courses', []); render(); } };
}
