// Community library (web build): the "Community" source on the Workouts and Courses tabs, the item page with
// comments, likes and reports, and publishing a custom workout or an imported course. Browsing and riding work
// signed out; liking, commenting, reporting and publishing need an account. API: /api/community (docs/API.md).
import { esc, fmtT, distText } from '../core.js';
import { track } from '../analytics.js';

const SVG = {
  like: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z"/></svg>',
  ride: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M8.5 7.2v5.6l4.4-2.8z"/></svg>',
  cmt: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12v8H9l-3.5 2.5v-2.5H4z"/></svg>',
};
const ago = t => { const s = (Date.now() - t) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 60 ? `${Math.round(s / 86400)} d ago` : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); };
const ERR = {
  bad_name: 'Name: 3 to 60 characters.', bad_tags: 'Up to 5 tags: letters, numbers, spaces.', blocked_words: 'Please change the wording.', no_links: 'No links in comments.',
  bad_comment: 'Comment: 1 to 500 characters.', duplicate: 'Already published.', bad_workout: 'This workout cannot be published.', bad_course: 'This course cannot be published.',
  signed_out: 'Sign in first.', offline: 'No connection.', not_found: 'Not found. It may have been removed.',
};
const errText = b => b?.error === 'rate_limited' ? 'Daily limit reached. Try again later.' : (b?.error === 'bad_workout' || b?.error === 'bad_course') && b.message ? `${ERR[b.error]} ${b.message}` : ERR[b?.error] || 'Something went wrong.';

export function createCommunity({ $, toast, account, ftp, units, compile, estimate, drawThumb, drawChart, drawProfile, ride, saveWorkout, saveCourse, onBack, fetch = (...a) => globalThis.fetch(...a) }) {
  const F = { kind: 'workout', q: '', sort: 'liked', period: 'all', dur: '', page: 0 };
  let items = [], more = false, loading = 0, detail = null, qTimer = null, reportArm = null, pub = null;
  const api = (m, p, b) => account.api(m, p, b);

  /* ---------- list ---------- */
  function query() {
    const q = new URLSearchParams({ kind: F.kind, sort: F.sort, period: F.period, page: String(F.page), limit: '20' });
    if (F.q) q.set('q', F.q);
    if (F.dur && F.kind === 'workout') q.set('dur', F.dur);
    return '/api/community?' + q;
  }
  async function load(append = false) {
    const my = ++loading;
    if (!append) { F.page = 0; renderList(true); }
    let r; try { r = await fetch(query(), { credentials: 'same-origin' }); } catch { r = null; }
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (my !== loading) return;
    if (!j) { items = append ? items : []; more = false; renderList(false, r ? errText(await r.json().catch(() => ({}))) : ERR.offline); return; }
    items = append ? [...items, ...j.items] : j.items; more = !!j.more;
    renderList(false);
  }
  function renderBar() {
    const bar = $('#cmBar'); if (!bar) return;
    $('#cmQ').value = F.q; $('#cmQ').placeholder = F.kind === 'workout' ? 'Search community workouts' : 'Search community courses';
    $('#cmSort').value = F.sort; $('#cmPeriod').value = F.period; $('#cmDur').value = F.dur;
    $('#cmDur').style.display = F.kind === 'workout' ? '' : 'none';
    $('#cmHead').innerHTML = F.kind === 'workout' ? '<span></span><span>Workout</span><span class="r">Time</span><span class="r">TSS</span><span></span>' : '<span></span><span>Course</span><span class="r">Distance</span><span class="r">Climb</span><span></span>';
  }
  const social = i => `<div class="soc num"><span title="Likes">${SVG.like}${i.likes}</span><span title="Rides">${SVG.ride}${i.rides}</span><span title="Comments">${SVG.cmt}${i.comments}</span></div>`;
  const up = m => units() === 'metric' ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`;
  function renderList(busy = false, error = '') {
    const box = $('#cmList'); if (!box) return;
    box.innerHTML = '';
    $('#cmEmpty').style.display = !busy && !items.length ? '' : 'none';
    $('#cmEmpty').textContent = error || (F.q ? 'Nothing matches.' : 'Nothing published yet.');
    $('#cmMore').style.display = more && !busy ? '' : 'none';
    if (busy) { box.innerHTML = '<div class="hint cmload">Loading…</div>'; return; }
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'lrow'; row.dataset.id = it.id;
      const sub = [`by ${esc(it.author)}`, ...(it.tags || []).map(esc)].join(' · ');
      const cw = it.kind === 'workout' ? cwOf(it) : null;  // time and TSS the same way the library shows them
      const cols = it.kind === 'workout' ? `<div class="m num r">${fmtT(cw ? cw.total : Math.round(it.minutes * 60))}</div><div class="m num r">${Math.round(cw ? estimate(cw, ftp()).tss : it.tss)}</div>`
        : `<div class="m num r">${distText(it.distM / 1000, units())}</div><div class="m num r">${up(it.gainM)}</div>`;
      row.innerHTML = `<canvas></canvas><div class="lmain"><div class="t">${esc(it.name)}</div><div class="p">${sub}</div></div>${cols}${social(it)}
        <div class="lact"><button class="pri" data-a="ride">Ride</button></div>`;
      box.appendChild(row);
      requestAnimationFrame(() => thumb(row.querySelector('canvas'), it));
      row.onclick = ev => { const a = ev?.target?.closest?.('[data-a]')?.dataset.a; if (a === 'ride') return rideItem(it.id); if (!a) openItem(it.id); };
    }
  }
  function thumb(cv, it) {
    if (!cv) return;
    if (it.kind === 'workout') { const cw = cwOf(it); if (cw) drawThumb(cv, cw, ftp()); }
    else if (it.profile?.length > 1) drawProfile(cv, it.profile, it.distM);
  }
  function cwOf(it) { try { return compile({ id: 'm-' + it.id, name: it.name, text: it.text }); } catch { return null; } }

  /* ---------- item page ---------- */
  async function openItem(id, keep = false) {
    const r = await api('GET', `/api/community/${encodeURIComponent(id)}`);
    if (r.status !== 200) { toast(errText(r.body)); return; }
    detail = r.body; if (!keep) reportArm = null;
    $('#libPane').style.display = 'none'; $('#commPane').style.display = '';
    renderItem(); if (!keep) globalThis.scrollTo?.(0, 0);
  }
  function closeItem() { detail = null; $('#commPane').style.display = 'none'; $('#libPane').style.display = ''; onBack(); }
  function renderItem() {
    const box = $('#commPane'); if (!box || !detail) return;
    const { item: it, liked, mine, comments } = detail, me = account.me(), admin = !!me?.admin;
    const w = it.kind === 'workout', cw = w ? cwOf(it) : null, e = cw ? estimate(cw, ftp()) : null;
    const stats = w ? [[fmtT(cw ? cw.total : it.minutes * 60), 'Time'], [Math.round(e ? e.tss : it.tss), 'TSS'], [e ? e.IF.toFixed(2) : '–', 'IF']]
      : [[distText(it.course.dist / 1000, units()), 'Distance'], [up(it.course.gain ?? it.gainM), 'Climb']];
    stats.push([it.rides, it.rides === 1 ? 'Ride' : 'Rides']);
    box.innerHTML = `<div class="phead bhead">
      <div class="ptitle"><button class="crumb" data-a="back"><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4l-6 6 6 6"/></svg>Community</button>
        <h1>${esc(it.name)}</h1><div class="sub">by ${esc(it.author)} · ${esc(ago(it.createdAt))}${(it.tags || []).map(t => ` · <span class="tag">${esc(t)}</span>`).join('')}</div></div>
      <div class="pact">
        ${mine || admin ? '<button class="ghost danger" data-a="delete">Delete</button>' : ''}
        ${!mine ? `<button class="ghost${reportArm === 'item' ? ' armed' : ''}" data-a="report">${reportArm === 'item' ? 'Tap again to report' : 'Report'}</button>` : ''}
        <button class="likeb${liked ? ' on' : ''}" data-a="like" aria-pressed="${!!liked}" title="${liked ? 'Unlike' : 'Like'}">${SVG.like}<span class="num">${it.likes}</span></button>
        <button data-a="save">Save to mine</button>
        <button class="pri" data-a="ride">Ride</button>
      </div></div>
      <div class="bstats num">${stats.map(([v, k]) => `<span><b>${esc(v)}</b><small>${esc(k)}</small></span>`).join('')}</div>
      <canvas id="cmChart" class="cmchart${w ? '' : ' crs'}"></canvas>
      ${w ? `<div class="cmtext">${esc(it.text)}</div>` : ''}
      <div class="sec-h">Comments <span class="hint">${comments.length || ''}</span></div>
      <div class="cmts">${comments.map(c => `<div class="cmt" data-c="${esc(c.id)}"><div class="ch"><b>${esc(c.author)}</b><span class="hint">${esc(ago(c.createdAt))}</span><span class="grow"></span>
        ${c.mine || mine || admin ? '<button class="lnk" data-a="cdel">Delete</button>' : ''}${!c.mine ? `<button class="lnk" data-a="creport">${reportArm === c.id ? 'Tap again to report' : 'Report'}</button>` : ''}</div>
        <p>${esc(c.body)}</p></div>`).join('') || '<div class="hint">No comments yet.</div>'}</div>
      ${me ? `<form class="cform" data-f="comment"><textarea name="body" rows="2" maxlength="500" placeholder="Add a comment" aria-label="Comment"></textarea><div class="row"><span class="err" id="cmErr"></span><span class="grow"></span><button class="pri" type="submit">Comment</button></div></form>`
        : '<div class="cform signed"><span class="hint">Sign in to like and comment.</span><button data-a="signin">Sign in</button></div>'}`;
    requestAnimationFrame(() => {
      const cv = $('#cmChart'); if (!cv) return;
      if (cw) drawChart(cv, { cw, ftp: ftp(), samples: [], el: null, k: 1 });
      else if (it.course) drawProfile(cv, it.course.ele, it.course.dist);
    });
  }
  const needAccount = () => { if (account.me()) return false; account.open('signin'); return true; };
  async function itemAction(a, el) {
    const it = detail?.item; if (!it) return;
    if (a === 'back') return closeItem();
    if (a === 'signin') return account.open('signin');
    if (a === 'ride') return rideItem(it.id, detail);
    if (a === 'save') {
      if (it.kind === 'workout') saveWorkout({ name: it.name, text: it.text }); else saveCourse({ ...it.course, name: it.name });
      return toast('Saved to Mine');
    }
    if (a === 'like') {
      if (needAccount()) return;
      const on = !detail.liked, r = await api(on ? 'POST' : 'DELETE', `/api/community/${it.id}/like`, {});
      if (r.status !== 200) return toast(errText(r.body));
      detail.liked = r.body.liked; it.likes = r.body.likes; if (on) track('community_like');
      const li = items.find(x => x.id === it.id); if (li) li.likes = r.body.likes;
      return renderItem();
    }
    if (a === 'report' || a === 'creport') {
      if (needAccount()) return;
      const cid = a === 'creport' ? el?.closest?.('[data-c]')?.dataset.c : null, target = cid || 'item';
      if (reportArm !== target) { reportArm = target; return renderItem(); }
      reportArm = null;
      const r = await api('POST', cid ? `/api/community/comments/${cid}/report` : `/api/community/${it.id}/report`, { reason: '' });
      toast(r.status === 200 ? 'Reported. Thanks.' : errText(r.body));
      return r.status === 200 && r.body.hidden && !cid ? closeItem() : openItem(it.id, true);
    }
    if (a === 'cdel') {
      const cid = el?.closest?.('[data-c]')?.dataset.c; if (!cid) return;
      const r = await api('DELETE', `/api/community/comments/${cid}`, {});
      if (r.status !== 200) return toast(errText(r.body));
      return openItem(it.id, true);
    }
    if (a === 'delete') {
      if (reportArm !== 'del') { reportArm = 'del'; toast('Tap Delete again to remove it for everyone'); return; }
      const r = await api('DELETE', `/api/community/${it.id}`, {});
      if (r.status !== 200) return toast(errText(r.body));
      items = items.filter(x => x.id !== it.id); toast('Deleted'); return closeItem();
    }
  }
  async function comment(body) {
    const it = detail?.item; if (!it || !body.trim()) return false;
    const r = await api('POST', `/api/community/${it.id}/comments`, { body });
    if (r.status !== 201) { const e = $('#cmErr'); if (e) e.textContent = errText(r.body); return false; }
    detail.comments.push(r.body.comment); it.comments++; renderItem(); return true;
  }
  // riding a community item counts one ride for it (signed in, once a day per rider)
  async function rideItem(id, d = null) {
    if (!d) { const r = await api('GET', `/api/community/${encodeURIComponent(id)}`); if (r.status !== 200) return toast(errText(r.body)); d = r.body; }
    const it = d.item;
    const ok = it.kind === 'workout' ? await ride({ id: 'm-' + it.id, name: it.name, text: it.text }, null) : await ride(null, { id: 'm-' + it.id, ...it.course, name: it.name });
    if (ok && account.me()) { const r = await api('POST', `/api/community/${it.id}/ride`, {}); if (r.status === 200) { it.rides = r.body.rides; const li = items.find(x => x.id === it.id); if (li) li.rides = r.body.rides; } }
    return ok;
  }

  /* ---------- publish ---------- */
  function openPublish(what) {  // what: { kind: 'workout', name, text } | { kind: 'course', course }
    if (needAccount()) return;
    pub = what;
    $('#pubName').value = what.kind === 'workout' ? what.name : what.course.name; $('#pubTags').value = ''; $('#pubErr').textContent = '';
    $('#pubKind').textContent = what.kind === 'workout' ? 'Workout' : 'Course';
    $('#pubModal').classList.add('on');
  }
  async function publish(name, tagText) {
    if (!pub) return null;
    const tags = tagText.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    const body = pub.kind === 'workout' ? { kind: 'workout', name, text: pub.text, tags }
      : { kind: 'course', name, course: { name, dist: pub.course.dist, ele: pub.course.ele, ll: pub.course.ll || [] }, tags };
    const r = await api('POST', '/api/community', body);
    if (r.status === 201) { $('#pubModal').classList.remove('on'); track('community_publish'); toast('Published'); pub = null; return r.body.item; }
    if (r.status === 409 && r.body.error === 'duplicate' && r.body.id) { $('#pubModal').classList.remove('on'); toast('Already published'); pub = null; return { id: r.body.id }; }
    $('#pubErr').textContent = errText(r.body); return null;
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('#cmQ').oninput = e => { F.q = e.target.value.trim().slice(0, 80); clearTimeout(qTimer); qTimer = setTimeout(() => load(), 250); };
    $('#cmSort').onchange = e => { F.sort = e.target.value; load(); };
    $('#cmPeriod').onchange = e => { F.period = e.target.value; load(); };
    $('#cmDur').onchange = e => { F.dur = e.target.value; load(); };
    $('#cmMore').onclick = () => { F.page++; load(true); };
    const pane = $('#commPane');
    pane.onclick = e => { const b = e?.target?.closest?.('[data-a]'); if (b) itemAction(b.dataset.a, b); };
    pane.onsubmit = e => { e?.preventDefault?.(); const t = e?.target?.querySelector?.('textarea'); if (t) comment(t.value).then(ok => { if (ok) t.value = ''; }); };
    $('#pubModal').onclick = e => { if (e?.target?.id === 'pubModal' || e?.target?.closest?.('[data-a=close]')) $('#pubModal').classList.remove('on'); };
    $('#pubForm').onsubmit = e => { e?.preventDefault?.(); publish($('#pubName').value.trim(), $('#pubTags').value); };
  }
  wire();
  // show the list for a tab: kind 'workout' | 'course'
  function show(kind) {
    const changed = F.kind !== kind || !items.length; F.kind = kind;
    renderBar(); if (changed) load(); else renderList();
  }
  return { show, load, openItem, closeItem, itemAction, comment, rideItem, openPublish, publish, items: () => items, detail: () => detail, filter: F, redraw: () => detail ? renderItem() : renderList() };
}
