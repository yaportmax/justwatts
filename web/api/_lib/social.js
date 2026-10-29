// /api/social/*: friends, presence (who rides nearby), group rides, chat, ride-ons. Plain HTTP polling: the page
// posts its position about every 2 s and gets the riders around it back in the same reply. Everything here needs
// a signed-in account; signed out, the page sends nothing.
'use strict';
const { route, requireUser, limit, DAY } = require('./app');
const { fail, readJson, checkWrite } = require('./http');
const { shortId } = require('./crypto');
const { hasBadWord, hasLink, normalize, clean } = require('./moderation');
const { readWorkout } = require('./community');

const MIN = 60000;
const L = {
  stale: 15000, near: 5000, riders: 50, cell: 0.05, msg: [1, 300], msgPage: 50, search: [2, 40], groupName: 60,
  groupAhead: 14 * DAY, groupLate: 3 * 3600000, invites: 50, members: 100, activity: 7 * DAY, activities: 20,
  presence: [[MIN, 60]], chat: [[MIN, 20], [DAY, 1000]], chatNew: 100, friendReq: [DAY, 50], groups: [DAY, 20],
  searches: [MIN, 30], posts: [DAY, 30], rideons: [DAY, 300], blocks: [DAY, 100], reports: [DAY, 20], hideAt: 3,
};
const ID_RE = /^[A-Za-z0-9_-]{6,24}$/, KEY_RE = /^[\w-]{1,40}$/;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const str = (v, max) => clean(typeof v === 'string' ? v : '').replace(/\s+/g, ' ').slice(0, max);
const userId = v => { if (typeof v !== 'string' || !ID_RE.test(v)) fail(400, 'bad_user'); return v; };
const nameOf = n => n || 'Rider';
const isNew = (u, ctx) => ctx.now - u.createdAt < DAY;

/* ---------- area cells: 0.05 degrees of latitude (5.6 km), as many longitude cells as 5 km needs ---------- */
function cellsNear(lat, lon) {
  const c = L.cell, y = Math.floor(lat / c), x = Math.floor(lon / c);
  const k = Math.min(20, Math.ceil(L.near / (c * 111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)))));
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -k; dx <= k; dx++) out.push(`o:${y + dy}:${x + dx}`);
  return { own: `o:${y}:${x}`, near: out };
}
const R = Math.PI / 180;
function metres(a, b) {
  const s = Math.sin((b.lat - a.lat) * R / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin((b.lon - a.lon) * R / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---------- profile: friend code (share link) and visibility ---------- */
const profile = (ctx, u) => ctx.store.socialMe(u.id, shortId(10));
route('GET', '/api/social/me', async ctx => {
  const u = await requireUser(ctx);
  return { body: await profile(ctx, u) };
});
route('POST', '/api/social/me', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  if (typeof b.visible !== 'boolean') fail(400, 'bad_visible');
  const me = await ctx.store.setVisible(u.id, b.visible, shortId(10));
  if (!b.visible) await ctx.store.dropPresence(u.id);
  return { body: me };
});

/* ---------- the Friends panel: friends (riding now or not), requests, blocked, group rides, activity ---------- */
const ridingOut = p => p && { open: !!p.data.open, road: p.data.road || '', course: p.data.course || null, cid: p.data.cid || null,
  lat: p.lat, lon: p.lon, h: p.data.h ?? null, w: p.data.w ?? 0, group: p.group || null };
route('GET', '/api/social', async ctx => {
  const u = await requireUser(ctx);
  const [me, lists, groups, acts] = await Promise.all([profile(ctx, u), ctx.store.socialLists(u.id, ctx.now - L.stale),
    ctx.store.myGroups(u.id, ctx.now - L.groupLate), ctx.store.friendActivity(u.id, ctx.now - L.activity, L.activities)]);
  const by = s => lists.friends.filter(f => f.state === s).map(f => ({ id: f.id, name: nameOf(f.name) }));
  return {
    body: {
      me,
      friends: lists.friends.filter(f => f.state === 'yes').map(f => ({ id: f.id, name: nameOf(f.name), riding: ridingOut(f.riding) }))
        .sort((a, b) => !!b.riding - !!a.riding || a.name.localeCompare(b.name)),
      incoming: by('in'), outgoing: by('out'), blocked: lists.blocked.map(x => ({ id: x.id, name: nameOf(x.name) })),
      groups: groups.map(g => groupOut(g, u.id)),
      activity: acts.map(a => ({ id: a.id, name: nameOf(a.name), mine: a.userId === u.id, at: a.at, ...a.data, rideons: a.rideons, gave: !!a.gave })),
    },
  };
});

route('POST', '/api/social/search', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  const q = normalize(str(b.q, L.search[1]));
  if (q.length < L.search[0]) return { body: { users: [] } };
  await limit(ctx, [[`social:search:${u.id}`, ...L.searches]]);
  const found = await ctx.store.searchUsers(u.id, q, 10);
  const rels = await Promise.all(found.map(x => ctx.store.relation(u.id, x.id)));
  return { body: { users: found.map((x, i) => ({ id: x.id, name: nameOf(x.name), state: rels[i].state || 'none' })) } };
});

/* ---------- friends: request (by id or share code), accept, remove; block hides both ways ---------- */
async function target(ctx, u, b) {
  const t = typeof b.code === 'string' && b.code ? await ctx.store.userByCode(str(b.code, 20)) : await ctx.store.getUser(userId(b.id));
  if (!t) fail(404, 'not_found');
  if (t.id === u.id) fail(400, 'self');
  return t;
}
route('POST', '/api/social/friends/request', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req), t = await target(ctx, u, b);
  const rel = await ctx.store.relation(u.id, t.id);
  if (rel.blocked) fail(404, 'not_found');  // a block looks like no account at all
  if (rel.state === 'yes' || rel.state === 'out') return { body: { state: rel.state, id: t.id, name: nameOf(t.name) } };
  await limit(ctx, [[`social:friend:${u.id}`, ...L.friendReq]]);
  const state = rel.state === 'in' ? 'yes' : 'out';  // they asked first: this accepts
  await ctx.store.setFriend(u.id, t.id, state, state === 'yes' ? 'yes' : 'in', ctx.now);
  return { body: { state, id: t.id, name: nameOf(t.name) } };
});
route('POST', '/api/social/friends/accept', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req), id = userId(b.id);
  if ((await ctx.store.relation(u.id, id)).state !== 'in') fail(404, 'not_found');
  await ctx.store.setFriend(u.id, id, 'yes', 'yes', ctx.now);
  return { body: { state: 'yes' } };
});
route('POST', '/api/social/friends/remove', async ctx => {  // unfriend, decline, or cancel a request
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await ctx.store.setFriend(u.id, userId(b.id), null, null, ctx.now);
  return { body: { state: 'none' } };
});
for (const on of [true, false]) {
  route('POST', `/api/social/${on ? 'block' : 'unblock'}`, async ctx => {
    checkWrite(ctx.req);
    const u = await requireUser(ctx), b = await readJson(ctx.req), id = userId(b.id);
    if (id === u.id) fail(400, 'self');
    await limit(ctx, [[`social:block:${u.id}`, ...L.blocks]]);
    await ctx.store.setBlock(u.id, id, on, ctx.now);
    return { body: { blocked: on } };
  });
}

/* ---------- presence: post where I am, get who is around ---------- */
// body: { lat, lon, h, w, v, d, road, open, course, cid, group, visible, chat: { since } }
// open world: riders within 5 km; a course: riders on the same course; a group ride: its members wherever they are
function readPresence(b) {
  const open = b.open === true, course = open ? null : str(b.course, 120) || null;
  const lat = num(b.lat, -85, 85), lon = num(b.lon, -180, 180), has = lat !== null && lon !== null;
  if (open && !has) fail(400, 'bad_position');
  if (!open && !course) fail(400, 'bad_course');
  const group = typeof b.group === 'string' && ID_RE.test(b.group) ? b.group : null;
  const data = { open, course, cid: typeof b.cid === 'string' && KEY_RE.test(b.cid) ? b.cid : null, road: str(b.road, 60),
    w: Math.round(num(b.w, 0, 3000) ?? 0), v: Math.round((num(b.v, 0, 200) ?? 0) * 10) / 10, d: Math.round(num(b.d, 0, 1e7) ?? 0), h: num(b.h, -360, 360) };
  return { open, course, group, lat: has ? lat : null, lon: has ? lon : null, data };
}
route('POST', '/api/social/presence', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req), p = readPresence(b);
  await limit(ctx, L.presence.map(([w, n]) => [`social:presence:${u.id}`, w, n]));
  const cells = p.open ? cellsNear(p.lat, p.lon) : null;
  const area = p.open ? cells.own : 'c:' + p.course;
  const row = b.visible === false ? null : { area, group: p.group, lat: p.lat, lon: p.lon, data: p.data, at: ctx.now };
  const seen = await ctx.store.putPresence(u.id, row, { areas: p.open ? cells.near : [area], group: p.group, since: ctx.now - L.stale });
  const riders = seen.map(r => {
    const g = !!p.group && r.group === p.group, dist = p.open && r.lat != null && r.data.open ? metres(p, r) : null;
    return { r, g, dist };
  }).filter(x => x.g || (p.open ? x.dist !== null && x.dist <= L.near : !x.r.data.open && x.r.data.course === p.course))
    .sort((a, b) => b.g - a.g || b.r.friend - a.r.friend || (a.dist ?? 0) - (b.dist ?? 0)).slice(0, L.riders)
    .map(({ r, g }) => ({ id: r.id, name: nameOf(r.name), lat: r.lat, lon: r.lon, w: r.data.w, v: r.data.v, d: r.data.d, h: r.data.h,
      road: r.data.road, open: r.data.open, course: r.data.course, friend: !!r.friend, group: g }));
  const out = { riders, at: ctx.now };
  if (p.group && b.chat && num(b.chat.since, 0, 1e12) !== null) out.chat = await readChat(ctx, u, 'g:' + p.group, b.chat.since, p.group);
  return { body: out };
});
route('POST', '/api/social/presence/stop', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx);
  await ctx.store.dropPresence(u.id);
  return { body: { ok: true } };
});

/* ---------- group rides: a start (a course or an open-world point), a time, maybe a workout; a lobby ---------- */
function readPlan(p) {
  if (!p || typeof p !== 'object') fail(400, 'bad_plan');
  const name = str(p.name, L.groupName);
  if (p.kind === 'course' && typeof p.id === 'string' && KEY_RE.test(p.id) && name) return { kind: 'course', id: p.id, name };
  const lat = num(p.lat, -85, 85), lon = num(p.lon, -180, 180);
  if (p.kind === 'open' && lat !== null && lon !== null) return { kind: 'open', name: name || 'Open world', lat, lon, heading: num(p.heading, -360, 360) };
  fail(400, 'bad_plan');
}
function groupOut(g, uid) {
  return { id: g.id, name: g.name, at: g.startAt, plan: g.plan, workout: g.workout || null, owner: { id: g.owner, name: nameOf(g.ownerName) },
    mine: g.owner === uid, state: g.state || null, members: g.members ?? undefined };
}
async function getGroup(ctx, id) {
  const g = typeof id === 'string' && ID_RE.test(id) ? await ctx.store.getGroup(id) : null;
  if (!g) fail(404, 'not_found');
  return g;
}
route('POST', '/api/social/groups', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req, 32 * 1024);
  const plan = readPlan(b.plan), at = num(b.at, ctx.now - MIN, ctx.now + L.groupAhead);
  if (at === null) fail(400, 'bad_time');
  const name = str(b.name, L.groupName) || plan.name;
  if (hasBadWord(name) || hasLink(name)) fail(400, 'blocked_words', { field: 'name' });
  let workout = null;
  if (b.workout) { const w = b.workout; readWorkout(w.text); workout = { name: str(w.name, 80) || 'Workout', text: String(w.text).trim() }; }
  if (workout && (hasBadWord(workout.name) || hasLink(workout.name))) fail(400, 'blocked_words', { field: 'workout' });
  await limit(ctx, [[`social:group:${u.id}`, ...L.groups]]);
  const g = { id: shortId(12), owner: u.id, name, startAt: Math.round(at), plan, workout, createdAt: ctx.now };
  await ctx.store.createGroup(g);
  await ctx.store.setMember(g.id, u.id, 'in', ctx.now);
  await invite(ctx, u, g, b.invite);
  return { status: 201, body: { group: groupOut({ ...g, ownerName: u.name, state: 'in' }, u.id) } };
});
async function invite(ctx, u, g, ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  let n = 0;
  for (const id of [...new Set(ids)].slice(0, L.invites)) {
    if (typeof id !== 'string' || !ID_RE.test(id)) continue;
    if ((await ctx.store.relation(u.id, id)).state !== 'yes' || await ctx.store.memberState(g.id, id)) continue;  // friends only
    await ctx.store.setMember(g.id, id, 'invited', ctx.now); n++;
  }
  return n;
}
route('GET', '/api/social/groups/:id', async ctx => {
  const u = await requireUser(ctx), g = await getGroup(ctx, ctx.params.id);
  const members = await ctx.store.groupMembers(g.id, u.id);
  const me = members.find(m => m.id === u.id);
  return { body: { group: groupOut({ ...g, state: me?.state || null }, u.id), members: members.map(m => ({ id: m.id, name: nameOf(m.name), state: m.state, me: m.id === u.id })) } };
});
route('POST', '/api/social/groups/:id/join', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), g = await getGroup(ctx, ctx.params.id);
  if ((await ctx.store.relation(u.id, g.owner)).blocked) fail(404, 'not_found');
  if ((await ctx.store.groupMembers(g.id, u.id)).filter(m => m.state === 'in').length >= L.members) fail(409, 'full');
  await ctx.store.setMember(g.id, u.id, 'in', ctx.now);
  return { body: { state: 'in' } };
});
route('POST', '/api/social/groups/:id/leave', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), g = await getGroup(ctx, ctx.params.id);
  if (g.owner === u.id) await ctx.store.deleteGroup(g.id);  // the organizer leaving cancels it
  else await ctx.store.setMember(g.id, u.id, null, ctx.now);
  return { body: { state: null } };
});
route('POST', '/api/social/groups/:id/invite', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), g = await getGroup(ctx, ctx.params.id), b = await readJson(ctx.req);
  if (await ctx.store.memberState(g.id, u.id) !== 'in') fail(403, 'forbidden');
  return { body: { invited: await invite(ctx, u, g, b.ids) } };
});

/* ---------- chat: per group ride (members) and per friend; text only, moderated like comments ---------- */
const dmChan = (a, b) => 'd:' + [a, b].sort().join(':');
async function chanOf(ctx, u, b) {
  if (typeof b.group === 'string') {
    const g = await getGroup(ctx, b.group);
    if (await ctx.store.memberState(g.id, u.id) !== 'in') fail(403, 'not_member');
    return 'g:' + g.id;
  }
  const id = userId(b.to);
  if ((await ctx.store.relation(u.id, id)).state !== 'yes') fail(403, 'not_friends');
  return dmChan(u.id, id);
}
const msgOut = (m, uid) => ({ id: m.id, seq: m.seq, by: m.userId, name: nameOf(m.name), body: m.body, at: m.createdAt, mine: m.userId === uid });
async function readChat(ctx, u, chan, since, group = null) {
  if (group && await ctx.store.memberState(group, u.id) !== 'in') return null;
  // a few messages of overlap: a send that committed late still shows (the page drops ids it has)
  const list = await ctx.store.readMessages(chan, u.id, Math.max(0, Math.floor(since) - 5), L.msgPage);
  return list.map(m => msgOut(m, u.id));
}
route('POST', '/api/social/chat/read', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await limit(ctx, [[`social:read:${u.id}`, MIN, 60]]);
  const chan = await chanOf(ctx, u, b);
  return { body: { messages: await readChat(ctx, u, chan, num(b.since, 0, 1e12) ?? 0) } };
});
route('POST', '/api/social/chat/send', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  const body = clean(b.body).replace(/\s+/g, ' ');
  if (body.length < L.msg[0] || body.length > L.msg[1]) fail(400, 'bad_message', { min: L.msg[0], max: L.msg[1] });
  if (hasLink(body)) fail(400, 'no_links');
  if (hasBadWord(body)) fail(400, 'blocked_words', { field: 'body' });
  const chan = await chanOf(ctx, u, b);
  await limit(ctx, [[`social:chat:${u.id}`, ...L.chat[0]], [`social:chatday:${u.id}`, L.chat[1][0], isNew(u, ctx) ? L.chatNew : L.chat[1][1]]]);
  const m = { id: shortId(12), chan, userId: u.id, body, createdAt: ctx.now };
  const { seq } = await ctx.store.addMessage(m);
  return { status: 201, body: { message: msgOut({ ...m, seq, name: u.name }, u.id) } };
});
route('POST', '/api/social/chat/report', async ctx => {  // 3 reports hide a message until the owner reviews it
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  const m = typeof b.id === 'string' && ID_RE.test(b.id) ? await ctx.store.getMessage(b.id) : null;
  if (!m || m.hidden) fail(404, 'not_found');
  await chanOf(ctx, u, m.chan.startsWith('g:') ? { group: m.chan.slice(2) } : { to: m.chan.slice(2).split(':').find(x => x !== u.id) || u.id });
  await limit(ctx, [[`report:${u.id}`, DAY, L.reports[1]]]);
  if (m.userId === u.id) return { body: { ok: true, hidden: false } };
  const r = await ctx.store.addReport('message', m.id, u.id, str(b.reason, 200), ctx.now, m.chan.startsWith('d:') ? 1 : L.hideAt);
  return { body: { ok: true, hidden: r.hidden } };
});

/* ---------- ride-ons: a finished ride shows to friends, who can give it a ride-on ---------- */
route('POST', '/api/social/activity', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  const secs = num(b.secs, 60, 24 * 3600);
  if (secs === null) fail(400, 'too_short');
  const me = await profile(ctx, u);
  if (!me.visible) return { body: { ok: true, posted: false } };
  await limit(ctx, [[`social:post:${u.id}`, ...L.posts]]);
  const name = str(b.name, 80) || 'Ride';
  const data = { title: hasBadWord(name) || hasLink(name) ? 'Ride' : name, secs: Math.round(secs), dist: Math.round(num(b.dist, 0, 1e6) ?? 0), avg: Math.round(num(b.avg, 0, 3000) ?? 0) };
  const id = shortId(12);
  await ctx.store.addActivity({ id, userId: u.id, at: ctx.now, data });
  return { status: 201, body: { ok: true, posted: true, id } };
});
route('POST', '/api/social/activity/:id/rideon', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx);
  const a = ID_RE.test(ctx.params.id) ? await ctx.store.getActivity(ctx.params.id) : null;
  if (!a || a.userId === u.id || (await ctx.store.relation(u.id, a.userId)).state !== 'yes') fail(404, 'not_found');
  await limit(ctx, [[`social:rideon:${u.id}`, ...L.rideons]]);
  return { body: await ctx.store.rideOn(a.id, u.id, ctx.now) };
});

module.exports = { L, cellsNear, metres, dmChan };
