// Social (web build, signed in): riders nearby on the ride maps, friends, group rides, chat, ride-ons.
// Transport is plain HTTP polling to /api/social (see createLink): while riding, one call about every 2 s posts
// the rider's position and returns who is around (and new group chat). Social never blocks or breaks a ride:
// every call is fire-and-forget, a failure only backs off and clears the riders after 15 s.
// Signed out, nothing here sends anything.
import { esc, fmtT, distText, isMetric } from '../core.js';

const ERR = {
  not_found: 'Not found.', self: 'That is you.', bad_message: 'Message: 1 to 300 characters.', no_links: 'No links in chat.',
  blocked_words: 'Please change the wording.', not_friends: 'Friends only.', not_member: 'Join first.', bad_time: 'Pick a time in the next 14 days.',
  bad_plan: 'Pick a start.', bad_workout: 'This workout cannot be used.', full: 'Full.', offline: 'No connection.', signed_out: 'Sign in first.',
};
const errText = b => b?.error === 'rate_limited' ? 'Too many tries. Try again soon.' : ERR[b?.error] || 'Something went wrong.';
const X = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';
const BACK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5l-5 5 5 5"/></svg>';
const BEAT = 2000, STALE = 15000, CHAT_MS = 3000, PANEL_MS = 10000, LOAD_AHEAD = 15000;

// The transport: swap this for a pub/sub client later; the rest only calls these.
export function createLink(api) {
  return {
    beat: body => api('POST', '/api/social/presence', body),
    stop: () => api('POST', '/api/social/presence/stop', {}),
    panel: () => api('GET', '/api/social'),
    me: () => api('GET', '/api/social/me'),
    setVisible: visible => api('POST', '/api/social/me', { visible }),
    search: q => api('POST', '/api/social/search', { q }),
    friend: (verb, body) => api('POST', `/api/social/friends/${verb}`, body),
    block: (id, on) => api('POST', `/api/social/${on ? 'block' : 'unblock'}`, { id }),
    group: id => api('GET', `/api/social/groups/${encodeURIComponent(id)}`),
    newGroup: body => api('POST', '/api/social/groups', body),
    groupAct: (id, verb, body = {}) => api('POST', `/api/social/groups/${encodeURIComponent(id)}/${verb}`, body),
    read: (chan, since) => api('POST', '/api/social/chat/read', { ...chan, since }),
    send: (chan, body) => api('POST', '/api/social/chat/send', { ...chan, body }),
    report: id => api('POST', '/api/social/chat/report', { id }),
    post: a => api('POST', '/api/social/activity', a),
    rideOn: id => api('POST', `/api/social/activity/${encodeURIComponent(id)}/rideon`, {}),
  };
}

// position() -> the rider on a course or open world ({ open, lat, lon, h, d, course, cid, road, w, v }) or null;
// ride(plan, workout) starts a group or "Ride here" start; start() starts the loaded ride; starts: { courses, presets };
// onRiders(list) draws others on the ride maps; detail(id) -> a finished ride's summary.
export function createSocial({ $, toast, account, units, workouts, starts, position, ride, start, onRiders, detail, loc = globalThis.location, hist = globalThis.history, now = () => Date.now() }) {
  const link = createLink((m, p, b) => account.api(m, p, b));
  let profile = null, data = null, view = null, viewData = null, timer = 0, pending = null;
  let riders = [], inflight = 0, next = 0, lastOk = 0, sending = false, me = null;
  let group = null, groupInfo = null, groupAt = 0, chat = [], chatSeq = 0, chatOpen = false, armed = null, armTimer = 0, loaded = false;
  const signed = () => !!account.me();

  /* ---------- presence: one call about every 2 s while riding a course or open world ---------- */
  function tick() {
    const pos = signed() ? position() : null;
    if (!pos) { if (sending) stopPresence(); return; }
    sending = true; me = pos;
    const t = now();
    if (inflight && t - inflight < 10000) return;  // a call still out: never pile up (one lost reply is fine)
    if (t < next) { if (riders.length && t - lastOk > STALE) setRiders([]); return; }
    inflight = t; next = t + BEAT;
    const body = { ...pos, visible: profile?.visible !== false };
    if (group) {
      body.group = group; body.chat = { since: chatSeq };
      if (t - groupAt > 30000) { groupAt = t; const g = group; link.group(g).then(r => { if (r.status === 200 && group === g) { groupInfo = r.body; renderRide(); } }).catch(() => {}); }
    }
    link.beat(body).then(r => {
      if (!sending) return;
      if (r.status === 200) { lastOk = now(); setRiders(r.body.riders || []); if (r.body.chat) addChat(r.body.chat); }
      else next = now() + (r.status === 429 ? (r.body.retryAfter || 30) * 1000 : r.status === 401 ? 60000 : 10000);
    }).catch(() => { next = now() + 10000; }).finally(() => { inflight = 0; });
    renderRide();
  }
  function stopPresence() {
    sending = false; me = null; next = 0; setRiders([]);
    if (signed()) link.stop().catch(() => {});
    if (group && !armed) { group = null; groupInfo = null; chat = []; chatSeq = 0; }  // the group ride is over for this page
    renderRide();
  }
  function setRiders(list) {
    riders = list;
    try { onRiders(list); } catch {}
    renderRide();
  }
  function addChat(list) {
    const have = new Set(chat.map(m => m.id));
    for (const m of list) if (!have.has(m.id)) chat.push(m);
    chat.sort((a, b) => a.seq - b.seq); chat = chat.slice(-100);
    chatSeq = chat.length ? chat.at(-1).seq : chatSeq;
  }

  /* ---------- ride screen: "N riding here", the group with gaps, a small chat ---------- */
  const gapText = m => {
    const a = Math.abs(m);
    if (isMetric(units())) return a < 1000 ? `${Math.round(a / 10) * 10} m` : `${(a / 1000).toFixed(1)} km`;
    return a < 1609 ? `${Math.round(a * 3.28084 / 10) * 10} ft` : `${(a / 1609.34).toFixed(1)} mi`;
  };
  const distM = (a, b) => { const R = Math.PI / 180, s = Math.sin((b.lat - a.lat) * R / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin((b.lon - a.lon) * R / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(s))); };
  function gapOf(r) {
    if (!me) return '';
    if (!me.open && !r.open && r.course === me.course) { const g = r.d - me.d; return Math.abs(g) < 5 ? 'with you' : `${g > 0 ? '+' : '−'}${gapText(g)}`; }
    return me.lat != null && r.lat != null ? gapText(distM(me, r)) : '';
  }
  function renderRide() {
    const box = $('#socRide'); if (!box) return;
    const on = sending && signed() && (riders.length > 0 || !!group);
    box.style.display = on ? '' : 'none'; if (!on) return;
    const mates = riders.filter(r => r.group);
    $('#socHere').textContent = riders.length ? `${riders.length} riding here` : '';
    const grp = $('#socGrp');
    if (group && groupInfo) {
      const byId = new Map(mates.map(r => [r.id, r]));
      const list = groupInfo.members.filter(m => m.state === 'in' && !m.me);
      grp.innerHTML = `<b>${esc(groupInfo.group.name)}</b>` + list.map(m => { const r = byId.get(m.id); return `<span class="${r ? 'on' : ''}">${esc(m.name)} <i class="num">${r ? esc(gapOf(r)) : '–'}</i></span>`; }).join('');
    } else grp.innerHTML = '';
    $('#socChatBox').style.display = group ? '' : 'none';
    if (group) {
      const msgs = chat.slice(chatOpen ? -6 : -2);
      $('#socMsgs').innerHTML = msgs.map(m => `<div class="sm${m.mine ? ' mine' : ''}"><b>${esc(m.mine ? 'You' : m.name)}</b> ${esc(m.body)}</div>`).join('');
    }
  }
  async function sayRide(text) {
    const t = String(text || '').trim(); if (!t || !group) return false;
    const r = await link.send({ group }, t).catch(() => ({ status: 0, body: { error: 'offline' } }));
    if (r.status === 201) { addChat([r.body.message]); renderRide(); return true; }
    toast(errText(r.body)); return false;
  }

  /* ---------- group ride start: load about 15 s ahead, start at the time ---------- */
  function arm(g) {
    armed = g; group = g.group.id; groupInfo = g; groupAt = now(); loaded = false;
    clearInterval(armTimer); armTimer = setInterval(armTick, 500); armTick();
  }
  function disarm() { armed = null; loaded = false; clearInterval(armTimer); armTimer = 0; }
  async function armTick() {
    if (!armed || !signed()) return disarm();
    const g = armed.group, left = g.at - now();
    if (left > LOAD_AHEAD) return;
    if (!loaded) {
      loaded = true;
      const ok = await Promise.resolve(ride(g.plan, g.workout)).catch(() => false);
      if (!ok) { disarm(); toast('Group ride not loaded'); return; }
    }
    if (left <= 0) { disarm(); Promise.resolve(start()).catch(() => {}); toast(`${g.name}: go`); }
  }

  /* ---------- the Friends panel ---------- */
  async function refresh() {
    const r = await link.panel().catch(() => null);
    if (r?.status !== 200) return false;
    data = r.body; profile = data.me;
    if (view === 'main') renderMain();
    renderBadge();
    return true;
  }
  function renderBadge() {
    const n = (data?.incoming.length || 0) + (data?.groups.filter(g => g.state === 'invited').length || 0);
    account.setFriends?.(open, n);
  }
  function open(v = 'main', d = null) {
    if (!signed()) { account.open('signin'); return; }
    view = v; viewData = d;
    $('#socModal')?.classList.add('on');
    clearInterval(timer); timer = 0;
    if (v === 'main') { renderMain(); refresh(); timer = setInterval(refresh, PANEL_MS); }
    else if (v === 'chat') { chatView(); poll(); timer = setInterval(poll, CHAT_MS); }
    else if (v === 'group') { lobbyView(); poll(); timer = setInterval(poll, CHAT_MS); }
    else if (v === 'new') newView();
  }
  function close() { view = null; clearInterval(timer); timer = 0; $('#socModal')?.classList.remove('on'); }
  function head(title, back = false) {
    $('#socTitle').textContent = title;
    $('#socBack').style.display = back ? '' : 'none';
  }
  const when = t => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const countdown = t => { const s = Math.round((t - now()) / 1000); return s <= 0 ? 'Started' : s < 3600 ? `In ${fmtT(s)}` : s < 86400 ? `In ${Math.round(s / 3600)} h` : when(t); };
  const where = r => r.open ? (r.road || 'Open world') : (r.course?.split('|')[0] || r.road || 'Course');

  function renderMain() {
    head('Friends');
    const body = $('#socBody'); if (!body) return;
    if (!body.querySelector?.('#socList') || body.dataset.v !== 'main') {
      body.dataset.v = 'main';
      body.innerHTML = `<form class="socfind" data-f="find"><input id="socQ" placeholder="Find riders by name" aria-label="Find riders by name" autocomplete="off" maxlength="40"><button type="submit">Find</button></form>
        <div id="socFound"></div><div id="socList"></div>`;
    }
    const d = data, L = $('#socList');
    if (!d) { L.innerHTML = '<div class="hint">Loading</div>'; return; }
    const row = (main, sub, acts) => `<div class="socrow"><span class="sl">${main}${sub ? `<small>${sub}</small>` : ''}</span><span class="sc">${acts}</span></div>`;
    const btn = (a, label, id, cls = '') => `<button class="${cls}" data-s="${a}" data-id="${esc(id)}">${label}</button>`;
    const parts = [];
    if (d.incoming.length) parts.push('<h3 class="ssub">Requests</h3>' + d.incoming.map(f => row(esc(f.name), '', btn('accept', 'Accept', f.id, 'pri') + btn('remove', 'Decline', f.id, 'ghost'))).join(''));
    const riding = d.friends.filter(f => f.riding), idle = d.friends.filter(f => !f.riding);
    if (riding.length) parts.push('<h3 class="ssub">Riding now</h3>' + riding.map(f => row(`<span><i class="sdot"></i>${esc(f.name)}</span>`, `${esc(where(f.riding))} · <span class="num">${f.riding.w} W</span>`,
      btn('here', 'Ride here', f.id, 'pri') + btn('chat', 'Chat', f.id, 'ghost'))).join(''));
    parts.push('<h3 class="ssub">Friends</h3>' + (idle.length || riding.length ? idle.map(f => row(esc(f.name), '', btn('chat', 'Chat', f.id, 'ghost') + btn('remove', 'Remove', f.id, 'ghost') + btn('block', 'Block', f.id, 'ghost danger'))).join('')
      : '<div class="hint socempty">No friends yet. Find riders by name or share your link.</div>'));
    if (d.outgoing.length) parts.push(d.outgoing.map(f => row(esc(f.name), 'Request sent', btn('remove', 'Cancel', f.id, 'ghost'))).join(''));
    parts.push(`<div class="socrow"><span class="sl">Your link<small>Anyone who opens it can send you a request.</small></span><span class="sc">${btn('copy', 'Copy link', '')}</span></div>`);
    parts.push('<h3 class="ssub">Group rides</h3>' + d.groups.map(g => row(esc(g.name), `${esc(countdown(g.at))} · ${esc(g.plan.name)} · ${g.members} in${g.state === 'invited' ? ' · Invited' : ''}`, btn('lobby', 'Open', g.id, g.state === 'invited' ? 'pri' : ''))).join('')
      + `<div class="socrow"><span class="sl"></span><span class="sc">${btn('new', 'New group ride', '')}</span></div>`);
    if (d.activity.length) parts.push('<h3 class="ssub">Activity</h3>' + d.activity.map(a => row(`${esc(a.mine ? 'You' : a.name)} · ${esc(a.title)}`,
      `<span class="num">${fmtT(a.secs)}${a.dist ? ' · ' + distText(a.dist / 1000, units()) : ''}${a.avg ? ` · ${a.avg} W` : ''}</span>`,
      a.mine ? `<span class="hint num">${a.rideons} ride-on${a.rideons === 1 ? '' : 's'}</span>` : btn('rideon', `Ride on${a.rideons ? ` <span class="num">${a.rideons}</span>` : ''}`, a.id, a.gave ? 'on' : ''))).join(''));
    if (d.blocked.length) parts.push('<h3 class="ssub">Blocked</h3>' + d.blocked.map(b => row(esc(b.name), '', btn('unblock', 'Unblock', b.id, 'ghost'))).join(''));
    L.innerHTML = parts.join('');
  }
  async function find(q) {
    const box = $('#socFound'); if (!box) return;
    const r = await link.search(q).catch(() => null);
    if (r?.status !== 200) { box.innerHTML = `<div class="err">${esc(errText(r?.body))}</div>`; return; }
    const lab = { yes: 'Friends', out: 'Request sent', in: 'Asked you' };
    box.innerHTML = r.body.users.length ? r.body.users.map(u => `<div class="socrow"><span class="sl">${esc(u.name)}</span><span class="sc">${u.state === 'none' || u.state === 'in'
      ? `<button class="pri" data-s="${u.state === 'in' ? 'accept' : 'add'}" data-id="${esc(u.id)}">${u.state === 'in' ? 'Accept' : 'Add'}</button>` : `<span class="hint">${lab[u.state]}</span>`}</span></div>`).join('')
      : '<div class="hint socempty">No one by that name.</div>';
  }
  async function act(a, id) {
    const friendName = () => data?.friends.find(f => f.id === id)?.name || '';
    let r = null;
    if (a === 'add') { r = await link.friend('request', { id }); if (r.status === 200) toast(r.body.state === 'yes' ? 'Friends' : 'Request sent'); }
    else if (a === 'accept') { r = await link.friend('accept', { id }); if (r.status === 200) toast('Friends'); }
    else if (a === 'remove') r = await link.friend('remove', { id });
    else if (a === 'block') r = await link.block(id, true);
    else if (a === 'unblock') r = await link.block(id, false);
    else if (a === 'rideon') r = await link.rideOn(id);
    else if (a === 'chat') return open('chat', { to: id, name: friendName() });
    else if (a === 'lobby') return open('group', { id });
    else if (a === 'new') return open('new');
    else if (a === 'copy') return copy(`${loc?.origin || ''}/?friend=${profile?.code || ''}`);
    else if (a === 'here') {
      const f = data?.friends.find(x => x.id === id)?.riding; if (!f) return;
      close();
      return f.open ? ride({ kind: 'open', name: f.road || 'Open world', lat: f.lat, lon: f.lon, heading: f.h }, null) : ride({ kind: 'course', id: f.cid }, null);
    }
    if (r && r.status !== 200) toast(errText(r.body));
    if ($('#socFound')) $('#socFound').innerHTML = '';
    await refresh();
  }
  async function copy(text) {
    try { await globalThis.navigator.clipboard.writeText(text); toast('Link copied'); }
    catch { toast(text); }
  }

  /* ---------- chat with a friend ---------- */
  function chatView() {
    head(viewData.name || 'Chat', true);
    const body = $('#socBody'); body.dataset.v = 'chat';
    body.innerHTML = `<div class="socmsgs" id="socLog"></div><form class="socsay" data-f="say"><input id="socSayIn" placeholder="Message" aria-label="Message" maxlength="300" autocomplete="off"><button type="submit" class="pri">Send</button></form>`;
    viewData.msgs = []; viewData.seq = 0;
  }
  const chanOf = () => view === 'chat' ? { to: viewData.to } : { group: viewData.id };
  function renderLog() {
    const log = $('#socLog'); if (!log || !viewData) return;
    log.innerHTML = viewData.msgs.length ? viewData.msgs.map(m => `<div class="sm${m.mine ? ' mine' : ''}"><b>${esc(m.mine ? 'You' : m.name)}</b> ${esc(m.body)}${m.mine ? '' : `<span class="smact"><button class="lnk" data-s="report" data-id="${esc(m.id)}">Report</button><button class="lnk" data-s="blockmsg" data-id="${esc(m.by)}">Block</button></span>`}</div>`).join('')
      : '<div class="hint socempty">No messages yet.</div>';
    log.scrollTop = 1e9;
  }
  async function poll() {
    if (!viewData) return;
    const my = viewData;
    if (view === 'group') {
      const g = await link.group(my.id).catch(() => null);
      if (my !== viewData) return;
      if (g?.status !== 200) { $('#socLobby').innerHTML = `<div class="err">${esc(errText(g?.body))}</div>`; return; }
      my.g = g.body; renderLobby();
      if (g.body.group.state !== 'in') { renderLog(); return; }
    }
    const r = await link.read(chanOf(), my.seq || 0).catch(() => null);
    if (my !== viewData || r?.status !== 200) return;
    const have = new Set(my.msgs.map(m => m.id));
    const add = r.body.messages.filter(m => !have.has(m.id));
    if (add.length || !my.drawn) { my.msgs = [...my.msgs, ...add].sort((a, b) => a.seq - b.seq).slice(-100); my.seq = my.msgs.at(-1)?.seq || 0; my.drawn = true; renderLog(); }
  }
  async function say(text) {
    const t = String(text || '').trim(); if (!t || !viewData) return false;
    const r = await link.send(chanOf(), t).catch(() => ({ status: 0, body: { error: 'offline' } }));
    if (r.status !== 201) { toast(errText(r.body)); return false; }
    viewData.msgs.push(r.body.message); viewData.seq = Math.max(viewData.seq || 0, r.body.message.seq); renderLog();
    return true;
  }

  /* ---------- group ride: lobby (members, countdown, chat), new ---------- */
  function lobbyView() {
    head('Group ride', true);
    const body = $('#socBody'); body.dataset.v = 'group';
    body.innerHTML = `<div id="socLobby"><div class="hint">Loading</div></div><div class="socmsgs" id="socLog"></div><form class="socsay" data-f="say"><input id="socSayIn" placeholder="Message the group" aria-label="Message the group" maxlength="300" autocomplete="off"><button type="submit" class="pri">Send</button></form>`;
    viewData.msgs = []; viewData.seq = 0;
  }
  function renderLobby() {
    const box = $('#socLobby'), x = viewData?.g; if (!box || !x) return;
    const g = x.group, inn = g.state === 'in', started = g.at <= now();
    head(g.name, true);
    const wk = g.workout ? ` · ${esc(g.workout.name)}` : '';
    const list = [...x.members].sort((a, b) => (a.state === 'in' ? 0 : 1) - (b.state === 'in' ? 0 : 1)).map(m => `<span class="${m.state === 'in' ? '' : 'inv'}">${esc(m.me ? 'You' : m.name)}${m.state === 'in' ? '' : ' · invited'}</span>`).join('');
    const inv = inn && data?.friends.filter(f => !x.members.some(m => m.id === f.id)).length;
    box.innerHTML = `<div class="soclob"><div class="socwhen"><b class="num" id="socCount">${esc(countdown(g.at))}</b><small>${esc(when(g.at))} · ${esc(g.plan.name)}${wk}</small></div>
      <div class="socmem">${list}</div>
      <div class="row socacts">${inn ? (started ? '<button class="pri" data-s="gride">Ride now</button>' : armed?.group.id === g.id ? '<span class="hint">Starts here at the time</span>' : '<button class="pri" data-s="garm">Ready</button>')
        : '<button class="pri" data-s="gjoin">Join</button>'}<button data-s="gcopy">Copy link</button>${inv ? '<button data-s="ginvite">Invite friends</button>' : ''}${g.mine ? '<button class="ghost danger" data-s="gleave">Cancel ride</button>' : inn ? '<button class="ghost" data-s="gleave">Leave</button>' : ''}</div>
      <div id="socInv"></div></div>`;
    $('#socLog').style.display = inn ? '' : 'none';
    const f = $('#socBody').querySelector?.('form[data-f=say]'); if (f) f.style.display = inn ? '' : 'none';
  }
  async function groupAct(a) {
    const x = viewData?.g; if (!x) return;
    const g = x.group;
    if (a === 'gcopy') return copy(`${loc?.origin || ''}/?group=${g.id}`);
    if (a === 'gjoin') { const r = await link.groupAct(g.id, 'join'); if (r.status !== 200) toast(errText(r.body)); return poll(); }
    if (a === 'gleave') { const r = await link.groupAct(g.id, 'leave'); if (r.status !== 200) return toast(errText(r.body)); if (armed?.group.id === g.id) { disarm(); group = null; } open('main'); return; }
    if (a === 'garm' || a === 'gride') { arm(x); toast(a === 'gride' ? 'Loading' : 'Ready. The ride loads and starts at the time.'); if (a === 'gride') { close(); } else renderLobby(); return; }
    if (a === 'ginvite') {
      const box = $('#socInv'), fr = data?.friends.filter(f => !x.members.some(m => m.id === f.id)) || [];
      box.innerHTML = `<form class="socinv" data-f="invite">${fr.map(f => `<label><input type="checkbox" value="${esc(f.id)}"> ${esc(f.name)}</label>`).join('')}<button type="submit" class="pri">Invite</button></form>`;
    }
  }
  function newView() {
    head('New group ride', true);
    const body = $('#socBody'); body.dataset.v = 'new';
    const st = starts(), t = new Date(Math.ceil((now() + 15 * 60000) / 300000) * 300000);
    const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const opts = `<optgroup label="Open world">${st.presets.map(p => `<option value="o:${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`
      + `<optgroup label="Courses">${st.courses.map(c => `<option value="c:${esc(c.id)}">${esc(c.name)}</option>`).join('')}</optgroup>`;
    const ws = workouts().filter(w => !w.test);
    const fr = data?.friends || [];
    body.innerHTML = `<form class="aform socnew" data-f="new">
      <label class="f">Name<input name="name" maxlength="60" placeholder="Optional"></label>
      <label class="f">Start<select name="start">${opts}</select></label>
      <label class="f">Time<input name="at" type="datetime-local" value="${local}" required></label>
      <label class="f">Workout<select name="workout"><option value="">Free ride</option>${ws.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label>
      ${fr.length ? `<div class="f socinv"><span>Invite</span>${fr.map(f => `<label><input type="checkbox" name="invite" value="${esc(f.id)}"> ${esc(f.name)}</label>`).join('')}</div>` : ''}
      <div class="err" id="socErr"></div><button type="submit" class="pri wide">Create</button></form>`;
  }
  async function create(vals) {
    const st = starts(), [k, id] = String(vals.start || '').split(/:(.*)/s);
    const p = k === 'o' ? st.presets.find(x => x.id === id) : st.courses.find(x => x.id === id);
    if (!p) { $('#socErr').textContent = ERR.bad_plan; return null; }
    const plan = k === 'o' ? { kind: 'open', name: p.name, lat: p.lat, lon: p.lon, heading: p.heading } : { kind: 'course', id: p.id, name: p.name };
    const w = workouts().find(x => x.id === vals.workout);
    const at = new Date(vals.at).getTime();
    const r = await link.newGroup({ name: vals.name, plan, at: Number.isFinite(at) ? at : 0, workout: w ? { name: w.name, text: w.text } : null, invite: vals.invite || [] }).catch(() => null);
    if (r?.status !== 201) { $('#socErr').textContent = errText(r?.body); return null; }
    toast('Group ride created'); refresh();
    open('group', { id: r.body.group.id });
    return r.body.group;
  }

  /* ---------- settings: visibility ---------- */
  function renderSettings() {
    const box = $('#socSet'); if (!box) return;
    if (!signed() || !profile) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 class="ssub">Riding with others</h3>
      <label class="srow"><span class="sl">Visible to others<small>While you ride, others nearby see you on the map. Friends see your finished rides.</small></span>
      <span class="sc"><select id="socVis" aria-label="Visible to others"><option value="1"${profile.visible ? ' selected' : ''}>On</option><option value="0"${profile.visible ? '' : ' selected'}>Off</option></select></span></label>`;
  }
  async function setVisible(on) {
    const r = await link.setVisible(!!on).catch(() => null);
    if (r?.status === 200) { profile = r.body; toast(on ? 'Visible' : 'Hidden'); } else toast(errText(r?.body));
    renderSettings();
  }

  /* ---------- a finished ride: friends see it (if visible) ---------- */
  async function finished(f) {
    if (!signed() || !f?.id || profile?.visible === false) return;
    try {
      const s = await detail(f.id); if (!s || !(s.time_s >= 60)) return;
      await link.post({ name: f.name || 'Ride', secs: s.time_s, dist: Math.round((s.distance_km || 0) * 1000), avg: s.avg_w || 0 });
    } catch {}
  }

  /* ---------- share links: ?friend=CODE, ?group=ID ---------- */
  function readParams() {
    const u = new URLSearchParams(loc?.search || ''), p = { friend: u.get('friend'), group: u.get('group') };
    if (p.friend || p.group) {
      u.delete('friend'); u.delete('group');
      const q = u.toString();
      try { hist?.replaceState?.(null, '', (loc.pathname || '/') + (q ? '?' + q : '') + (loc.hash || '')); } catch {}
    }
    return p.friend || p.group ? p : null;
  }
  async function handleParams(p) {
    if (!p) return;
    if (!signed()) { pending = p; account.open('signin'); return; }
    pending = null;
    if (p.friend && /^[A-Za-z0-9]{4,20}$/.test(p.friend)) {
      const r = await link.friend('request', { code: p.friend }).catch(() => null);
      toast(r?.status === 200 ? (r.body.state === 'yes' ? `Friends with ${r.body.name}` : `Request sent to ${r.body.name}`) : r?.body?.error === 'self' ? 'That is your own link.' : errText(r?.body));
      refresh();
    }
    if (p.group && /^[A-Za-z0-9]{6,24}$/.test(p.group)) open('group', { id: p.group });
  }

  /* ---------- wiring ---------- */
  function wire() {
    const m = $('#socModal');
    if (m) {
      m.onclick = e => {
        if (e?.target?.id === 'socModal') return close();
        const b = e?.target?.closest?.('[data-s]'); if (!b || b.disabled) return;
        const a = b.dataset.s, id = b.dataset.id;
        if (a === 'close') return close();
        if (a === 'back') return open('main');
        if (a === 'report') return link.report(id).then(r => { toast(r.status === 200 ? 'Reported' : errText(r.body)); poll(); });
        if (a === 'blockmsg') return link.block(id, true).then(r => { toast(r.status === 200 ? 'Blocked' : errText(r.body)); if (view === 'chat') open('main'); else { viewData.msgs = viewData.msgs.filter(x => x.by !== id); renderLog(); } });
        if (a.startsWith('g')) return groupAct(a);
        return act(a, id);
      };
      m.onsubmit = e => {
        e?.preventDefault?.();
        const f = e?.target, kind = f?.dataset?.f; if (!kind) return;
        const vals = {}; for (const i of f.querySelectorAll?.('input,select') || []) { if (i.type === 'checkbox') { if (i.checked) (vals[i.name || 'ids'] ??= []).push(i.value); } else vals[i.name || i.id] = i.value; }
        if (kind === 'find') return find(vals.socQ || '');
        if (kind === 'say') { const inp = $('#socSayIn'); return say(inp.value).then(ok => { if (ok) inp.value = ''; }); }
        if (kind === 'new') return create(vals);
        if (kind === 'invite') return link.groupAct(viewData.g.group.id, 'invite', { ids: vals.ids || [] }).then(r => { toast(r.status === 200 ? `Invited ${r.body.invited}` : errText(r.body)); poll(); });
      };
    }
    const s = $('#socSet'); if (s) s.onchange = e => { if (e?.target?.id === 'socVis') setVisible(e.target.value === '1'); };
    const rs = $('#socRide');
    if (rs) {
      rs.onsubmit = e => { e?.preventDefault?.(); const inp = $('#socRideIn'); sayRide(inp.value).then(ok => { if (ok) inp.value = ''; }); };
      rs.onclick = e => { if (e?.target?.closest?.('[data-s=chatmore]')) { chatOpen = !chatOpen; renderRide(); } };
    }
    globalThis.document?.addEventListener?.('keydown', e => { if (e.key === 'Escape' && view) close(); });
  }
  async function onUser(u) {
    if (!u) { profile = null; data = null; disarm(); group = null; groupInfo = null; chat = []; if (sending) { sending = false; setRiders([]); } close(); renderSettings(); account.setFriends?.(open, 0); return; }
    account.setFriends?.(open, 0);
    const r = await link.me().catch(() => null);
    if (r?.status === 200) profile = r.body;
    renderSettings();
    refresh();
    if (pending) handleParams(pending);
  }
  wire();
  const params = readParams();
  if (signed()) onUser(account.me()).then(() => handleParams(params)); else if (params) handleParams(params);

  return {
    tick, finished, open, close, onUser, renderSettings, refresh, say, sayRide, find, act, create, setVisible, groupAct, handleParams, link,
    riders: () => riders, state: () => ({ view, sending, group, armed: armed?.group.id || null, profile, data, chat, viewData }),
  };
}
