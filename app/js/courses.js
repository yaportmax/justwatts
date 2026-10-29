// Courses UI: the course list on the Workouts page and the elevation strip on the ride screen.
// DOM only. The course math is in course.js; position, grade and speed come from the ride engine.
import { esc, distText, isMetric } from './core.js';
import { parseTrack, buildCourse, SAMPLE_COURSES } from './course.js';

const FT = 3.28084;

export function createCourses({ $, store, toast, fit, css, units, ride }) {
  let mine = store.get('hw.courses', []);
  let sel = store.get('hw.course', '');
  const all = () => [...mine, ...SAMPLE_COURSES];
  const selected = () => all().find(c => c.id === sel) || null;
  const upText = m => isMetric(units()) ? `${Math.round(m)} m` : `${Math.round(m * FT)} ft`;

  // elevation profile; done = metres ridden (null: no marker). Flat courses get a 20 m scale so they look flat.
  function draw(cv, ele, dist, done) {
    const [c, w, h] = fit(cv); if (!ele?.length) return;
    let lo = Math.min(...ele), hi = Math.max(...ele); if (hi - lo < 150) { lo = Math.min(...ele) - 5; hi = lo + 150; }  // a flat course looks flat
    const X = i => i / (ele.length - 1) * w, Y = e => h - 3 - (e - lo) / (hi - lo) * (h - 10);
    const path = () => { c.beginPath(); c.moveTo(0, h); ele.forEach((e, i) => c.lineTo(X(i), Y(e))); c.lineTo(w, h); c.closePath(); };
    c.fillStyle = css('--panel2'); path(); c.fill();
    const fx = done == null ? 0 : Math.min(1, done / dist) * w;
    if (fx > 0) { c.save(); c.beginPath(); c.rect(0, 0, fx, h); c.clip(); c.globalAlpha = 0.35; c.fillStyle = css('--acc'); path(); c.fill(); c.restore(); }
    c.strokeStyle = css('--faint'); c.lineWidth = 1.25; c.beginPath(); ele.forEach((e, i) => (i ? c.lineTo : c.moveTo).call(c, X(i), Y(e))); c.stroke();
    if (done != null) {
      const f = Math.min(1, done / dist) * (ele.length - 1), i = Math.min(ele.length - 2, Math.floor(f)), e = ele[i] + (ele[i + 1] - ele[i]) * (f - i);
      c.fillStyle = css('--ink'); c.beginPath(); c.arc(fx, Y(e), 4, 0, 2 * Math.PI); c.fill();
    }
  }

  function render() {
    const box = $('#crsList'); if (!box) return;
    box.innerHTML = '';
    for (const c of all()) {
      const own = !c.id.startsWith('s-'), on = c.id === sel;
      const card = document.createElement('div'); card.className = 'lrow' + (on ? ' sel' : '');
      card.innerHTML = `<canvas></canvas><div class="lmain"><div class="t">${esc(c.name)}</div>
        <div class="m num">${distText(c.dist / 1000, units())} · ${upText(c.gain)} up${on ? ' · used for every ride' : ''}</div></div>
        <div class="lact"><button class="pri" data-a="ride">Ride</button><button data-a="use" aria-pressed="${on}" title="Use this road for workouts and Just ride">${on ? 'Stop using' : 'Use'}</button>${own ? '<button data-a="del" class="danger">Delete</button>' : ''}</div>`;
      box.appendChild(card);
      requestAnimationFrame(() => draw(card.querySelector('canvas'), c.ele, c.dist, null));
      card.querySelector('[data-a=ride]').onclick = () => ride(c);
      card.querySelector('[data-a=use]').onclick = () => { sel = on ? '' : c.id; store.set('hw.course', sel); render(); };
      if (own) card.querySelector('[data-a=del]').onclick = () => { mine = mine.filter(x => x.id !== c.id); if (sel === c.id) sel = ''; store.set('hw.courses', mine); store.set('hw.course', sel); render(); };
    }
    $('#crsNow').textContent = selected() ? `Rides use ${selected().name}` : 'Rides are flat';
  }

  async function importFile(file) {
    try {
      const t = parseTrack(await file.text());
      if (!t.pts.length) throw new Error('No track points');
      const c = { id: 'k-' + Date.now().toString(36), ...buildCourse(t.name || file.name.replace(/\.\w+$/, ''), t.pts) };
      if (!store.set('hw.courses', [c, ...mine])) throw new Error('No room to save it');
      mine = [c, ...mine]; render(); toast(`Added ${c.name}`);
    } catch (e) { toast('Import failed: ' + e.message); }
  }
  $('#crsImport').onclick = () => $('#crsFile').click();
  $('#crsFile').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); };

  // ride screen: profile with the rider's position, distance, grade, climbed, speed
  function renderRide(rc) {
    const box = $('#crsRide'); if (!box) return;
    box.style.display = rc ? '' : 'none'; if (!rc) return;
    draw($('#crsChart'), rc.profile, rc.dist_m, rc.done_m);
    const u = units(), km = x => distText(x / 1000, u).split(' ');
    const [d, du] = km(rc.done_m), [t] = km(rc.dist_m), spd = isMetric(u) ? `${Math.round(rc.speed_kmh)} km/h` : `${Math.round(rc.speed_kmh * 0.621371)} mph`;
    $('#crsK').innerHTML = `<span><b>${d}</b> / ${t} ${du}</span><span><b>${rc.grade.toFixed(1)}%</b></span><span><b>${upText(rc.climbed_m)}</b> up</span><span>${spd}</span>${rc.end ? '<span>Finished</span>' : ''}`;
  }

  render();
  return { selected, render, renderRide };
}
