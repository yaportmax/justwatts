// Community library (web build): community items for the Workouts and Courses lists (feed), the item page with
// comments, likes and reports, and publishing a custom workout or an imported course. Browsing and riding work
// signed out; liking, commenting, reporting and publishing need an account. API: /api/community (docs/API.md).
import { esc, fmtT, distText } from '../core.js';
import { track } from '../analytics.js';

const SVG = {
  like: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z"/></svg>',
};
const ago = t => { const s = (Date.now() - t) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 60 ? `${Math.round(s / 86400)} d ago` : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); };
const ERR = {
  bad_name: 'Name: 3 to 60 characters.', bad_tags: 'Up to 5 tags: letters, numbers, spaces.', blocked_words: 'Please change the wording.', no_links: 'No links in comments.',
  bad_comment: 'Comment: 1 to 500 characters.', duplicate: 'Already published.', bad_workout: 'This workout cannot be published.', bad_course: 'This course cannot be published.',
  signed_out: 'Sign in first.', offline: 'No connection.', not_found: 'Not found. It may have been removed.',
};
const errText = b => b?.error === 'rate_limited' ? 'Daily limit reached. Try again later.' : (b?.error === 'bad_workout' || b?.error === 'bad_course') && b.message ? `${ERR[b.error]} ${b.message}` : ERR[b?.error] || 'Something went wrong.';

export function createCommunity({ $, toast, account, ftp, units, compile, estimate, drawChart, drawProfile, drawRoute = null, ride, saveWorkout, saveCourse, onBack, onFeed = () => {}, fetch = (...a) => globalThis.fetch(...a) }) {
  let detail = null, reportArm = null, pub = null;
  const api = (m, p, b) => account.api(m, p, b);

  /* ---------- feed: one page of community items for a tab's list (the lists themselves are in app.js and courses.js) ---------- */
  // feed(kind, { q, sort, dur }) answers at once from the last fetch for the same filter, and starts a fetch when the
  // filter changed (typing waits a moment). onFeed(kind) fires when a fetch lands. The same filter fetches again
  // (keeping its rows meanwhile) after refresh(), after 2 min, or 30 s after a failure.
  const feeds = { workout: null, course: null }, timers = {};
  function feed(kind, f) {
    const key = JSON.stringify([f.q || '', f.sort || 'liked', f.dur || '']);
    let s = feeds[kind];
    if (s && s.key === key) {
      if (!s.busy && (s.stale || Date.now() - s.at > (s.error ? 30000 : 120000))) { s.stale = false; s.busy = true; s.page = 0; fetchPage(s, true); }
      return s;
    }
    const typing = s && s.key !== key && JSON.parse(s.key)[0] !== (f.q || '');
    s = feeds[kind] = { kind, key, f: { ...f }, items: [], more: false, page: 0, busy: true, error: '', at: Date.now() };
    clearTimeout(timers[kind]);
    if (typing) timers[kind] = setTimeout(() => fetchPage(s), 250); else fetchPage(s);
    return s;
  }
  async function fetchPage(s, replace = false) {
    const q = new URLSearchParams({ kind: s.kind, sort: s.f.sort || 'liked', page: String(s.page), limit: '20' });
    if (s.f.q) q.set('q', s.f.q);
    if (s.f.dur && s.kind === 'workout') q.set('dur', s.f.dur);
    let r = null, j = null;
    try { r = await fetch('/api/community?' + q, { credentials: 'same-origin' }); j = r.ok ? await r.json() : null; } catch { j = null; }
    if (feeds[s.kind] !== s) return;  // the filter changed meanwhile
    s.busy = false; s.at = Date.now();
    if (!Array.isArray(j?.items)) { s.error = r ? errText(await r.json().catch(() => ({}))) : ERR.offline; if (!replace) s.more = false; }
    else { s.items = replace ? j.items : [...s.items, ...j.items]; s.more = !!j.more; s.error = ''; }
    onFeed(s.kind);
  }
  function feedMore(kind) {
    const s = feeds[kind]; if (!s || s.busy || !s.more) return;
    s.page++; s.busy = true; fetchPage(s); onFeed(kind);
  }
  const refresh = () => { for (const s of Object.values(feeds)) if (s) s.stale = true; };
  const feedItem = id => feeds.workout?.items.find(x => x.id === id) || feeds.course?.items.find(x => x.id === id);
  const up = m => units() === 'metric' ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`;
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
      <div class="ptitle"><button class="crumb" data-a="back"><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4l-6 6 6 6"/></svg>${w ? 'Workouts' : 'Courses'}</button>
        <h1>${esc(it.name)}</h1><div class="sub">by ${esc(it.author)} · ${esc(ago(it.createdAt))}${(it.tags || []).map(t => ` · <span class="tag">${esc(t)}</span>`).join('')}</div></div>
      <div class="pact">
        ${mine || admin ? '<button class="ghost danger" data-a="delete">Delete</button>' : ''}
        ${!mine ? `<button class="ghost${reportArm === 'item' ? ' armed' : ''}" data-a="report">${reportArm === 'item' ? 'Tap again to report' : 'Report'}</button>` : ''}
        <button class="likeb${liked ? ' on' : ''}" data-a="like" aria-pressed="${!!liked}" title="${liked ? 'Unlike' : 'Like'}">${SVG.like}<span class="num">${it.likes}</span></button>
        <button data-a="save">Save to mine</button>
        <button class="pri" data-a="ride">Ride</button>
      </div></div>
      <div class="bstats num">${stats.map(([v, k]) => `<span><b>${esc(v)}</b><small>${esc(k)}</small></span>`).join('')}</div>
      ${!w && drawRoute && it.course?.ll?.length > 1 ? '<canvas id="cmMap" class="cmmap"></canvas>' : ''}
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
      const mv = $('#cmMap'), d = detail;  // the route on the map (tiles redraw it as they load, while this item is open)
      const route = () => { if (detail === d && $('#cmMap') === mv) drawRoute(mv, it.course.ll, it.course.dist, route); };
      if (mv && drawRoute && it.course?.ll?.length > 1) route();
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
      const li = feedItem(it.id); if (li) li.likes = r.body.likes;
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
      for (const f of Object.values(feeds)) if (f) f.items = f.items.filter(x => x.id !== it.id);
      toast('Deleted'); return closeItem();
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
    if (ok && account.me()) { const r = await api('POST', `/api/community/${it.id}/ride`, {}); if (r.status === 200) { it.rides = r.body.rides; const li = feedItem(it.id); if (li) li.rides = r.body.rides; } }
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
    if (r.status === 201) { $('#pubModal').classList.remove('on'); track('community_publish'); toast('Published'); pub = null; refresh(); return r.body.item; }
    if (r.status === 409 && r.body.error === 'duplicate' && r.body.id) { $('#pubModal').classList.remove('on'); toast('Already published'); pub = null; return { id: r.body.id }; }
    $('#pubErr').textContent = errText(r.body); return null;
  }

  /* ---------- wiring ---------- */
  function wire() {
    const pane = $('#commPane');
    pane.onclick = e => { const b = e?.target?.closest?.('[data-a]'); if (b) itemAction(b.dataset.a, b); };
    pane.onsubmit = e => { e?.preventDefault?.(); const t = e?.target?.querySelector?.('textarea'); if (t) comment(t.value).then(ok => { if (ok) t.value = ''; }); };
    $('#pubModal').onclick = e => { if (e?.target?.id === 'pubModal' || e?.target?.closest?.('[data-a=close]')) $('#pubModal').classList.remove('on'); };
    $('#pubForm').onsubmit = e => { e?.preventDefault?.(); publish($('#pubName').value.trim(), $('#pubTags').value); };
  }
  wire();
  return { feed, feedMore, refresh, openItem, closeItem, itemAction, comment, rideItem, openPublish, publish, detail: () => detail, redraw: () => { if (detail) renderItem(); } };
}
