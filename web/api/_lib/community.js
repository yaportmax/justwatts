// /api/community*: publish, browse, likes, rides, comments, reports; /api/admin/*: owner review (chat messages too).
'use strict';
const { route, open, sessionUser, requireUser, limit, isAdmin, DAY } = require('./app');
const { fail, readJson, checkWrite } = require('./http');
const { shortId, sha256 } = require('./crypto');
const { hasBadWord, hasLink, normalize, clean } = require('./moderation');
const { parseTree, flattenTree, checkCourse, STEP_M } = require('./appcopy');

const L = {
  name: [3, 60], comment: [1, 500], reason: 200, tags: 5, tag: 20, text: 2000, steps: 500, total: [60, 6 * 3600],
  pct: 3, watts: 2000, course: 1024 * 1024, ll: 500, pageSize: 50, pages: 50, q: 80,
  publish: { day: 10, newDay: 2, ipDay: 20 }, comments: { day: 30, newDay: 5, ipDay: 60 },
  likes: 300, rides: 200, reports: 20, hideAt: 3, newAccount: DAY,
};
const ID_RE = /^[A-Za-z0-9]{6,20}$/;
const PERIOD = { week: 7 * DAY, month: 30 * DAY, all: 0 };

/* ---------- validation ---------- */
function readItemName(v) {
  const n = clean(v).replace(/\s+/g, ' ');
  if (n.length < L.name[0] || n.length > L.name[1]) fail(400, 'bad_name', { min: L.name[0], max: L.name[1] });
  if (hasBadWord(n) || hasLink(n)) fail(400, 'blocked_words', { field: 'name' });
  return n;
}
function readTags(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > L.tags) fail(400, 'bad_tags', { max: L.tags });
  const out = [];
  for (const t of v) {
    const s = clean(t).toLowerCase().replace(/\s+/g, ' ');
    if (!/^[a-z0-9][a-z0-9 -]*$/.test(s) || s.length > L.tag) fail(400, 'bad_tags', { max: L.tags, maxLength: L.tag });
    if (hasBadWord(s)) fail(400, 'blocked_words', { field: 'tags' });
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
// steps a tree expands to, counted before flattening (so "999x(999x(...))" cannot blow up)
const stepCount = tree => tree.reduce((n, x) => n + (x.items ? x.n * stepCount(x.items) : 1), 0);

function readWorkout(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > L.text) fail(400, 'bad_workout', { message: `Workout text 1 to ${L.text} characters` });
  let tree;
  try { tree = parseTree(text); } catch (e) { fail(400, 'bad_workout', { message: String(e.message).slice(0, 120) }); }
  const n = stepCount(tree);
  if (!n) fail(400, 'bad_workout', { message: 'Empty workout' });
  if (n > L.steps) fail(400, 'bad_workout', { message: `At most ${L.steps} steps` });
  const steps = flattenTree(tree);
  let total = 0, load = 0;
  for (const s of steps) {
    total += s.d;
    if (!s.free && (s.u === '%' ? Math.max(s.a, s.b) > L.pct : Math.max(s.a, s.b) > L.watts)) fail(400, 'bad_workout', { message: `Targets up to ${L.pct * 100}% or ${L.watts} W` });
    const f = s.free ? 0.5 : (s.a + s.b) / 2 / (s.u === 'w' ? 200 : 1);  // watt steps against FTP 200
    load += s.d * f * f;
  }
  if (total < L.total[0] || total > L.total[1]) fail(400, 'bad_workout', { message: 'Total 1 minute to 6 hours' });
  return { tree, total, tss: Math.round(load / 36) };
}

function readCourse(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || JSON.stringify(c).length > L.course) fail(400, 'bad_course', { message: 'Course too large' });
  let out;
  try { out = checkCourse(c); } catch (e) { fail(400, 'bad_course', { message: String(e.message).slice(0, 120) }); }
  if (Math.abs(out.ele.length - (Math.floor(out.dist / STEP_M) + 1)) > 2) fail(400, 'bad_course', { message: 'course.ele must have one point every 10 m' });
  if (Array.isArray(c.ll) && c.ll.length > L.ll) fail(400, 'bad_course', { message: `course.ll at most ${L.ll} points` });
  if (out.ll.length !== (Array.isArray(c.ll) ? c.ll.length : 0) || out.ll.some(([a, o]) => Math.abs(a) > 90 || Math.abs(o) > 180)) fail(400, 'bad_course', { message: 'course.ll must be [lat, lon] pairs' });
  return out;
}

/* ---------- shapes ---------- */
const profile = (ele, n = 100) => { if (ele.length <= n) return ele.slice(); const o = []; for (let k = 0; k < n; k++) o.push(ele[Math.floor(k * (ele.length - 1) / (n - 1) + 0.5)]); return o; };
function summary(i) {
  const o = { id: i.id, kind: i.kind, name: i.name, author: i.ownerName || 'Rider', tags: i.tags, likes: i.likes, rides: i.rides, comments: i.comments, createdAt: i.createdAt };
  if (i.kind === 'workout') Object.assign(o, { minutes: i.minutes, tss: i.tss, text: i.text });
  else Object.assign(o, { distM: i.distM, gainM: i.gainM, profile: profile(i.course?.ele || []) });
  if (i.score !== undefined) o.score = i.score;
  return o;
}
const commentOut = (c, viewer) => ({ id: c.id, author: c.userName || 'Rider', body: c.body, createdAt: c.createdAt, mine: !!viewer && c.userId === viewer.id });

async function viewItem(ctx, id, viewer) {
  if (!ID_RE.test(id)) fail(404, 'not_found');
  const it = await ctx.store.getItem(id);
  if (!it) fail(404, 'not_found');
  if (it.hidden && !(viewer && (viewer.id === it.owner || isAdmin(await ctx.store.identitiesOf(viewer.id))))) fail(404, 'not_found');
  return it;
}
const isNew = (u, ctx) => ctx.now - u.createdAt < L.newAccount;

/* ---------- browse (public, cacheable: no per-viewer fields) ---------- */
route('GET', '/api/community', open(async ctx => {
  if (!ctx.store) fail(503, 'not_configured');
  const p = ctx.url.searchParams;
  const sort = ['liked', 'popular', 'new'].includes(p.get('sort')) ? p.get('sort') : 'liked';
  const period = p.get('period') in PERIOD ? p.get('period') : 'all';
  const kind = ['workout', 'course'].includes(p.get('kind')) ? p.get('kind') : null;
  const q = normalize(p.get('q') || '').slice(0, L.q) || null;
  const tag = normalize(p.get('tag') || '').slice(0, L.tag) || null;
  const dur = /^(\d{1,3})?-(\d{1,3})?$/.exec(p.get('dur') || '');
  const page = Math.min(L.pages, Math.max(0, Math.floor(+p.get('page') || 0)));
  const size = Math.min(L.pageSize, Math.max(1, Math.floor(+p.get('limit') || 20)));
  const r = await ctx.store.searchItems({
    q, kind, tag, sort, since: PERIOD[period] ? ctx.now - PERIOD[period] : 0,
    durMin: dur && dur[1] ? +dur[1] : null, durMax: dur && dur[2] ? +dur[2] : null, limit: size, offset: page * size,
  });
  return { body: { items: r.items.map(summary), more: r.more, page, sort, period }, headers: { 'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=120' } };
}));

route('GET', '/api/community/:id', open(async ctx => {
  if (!ctx.store) fail(503, 'not_configured');
  const viewer = await sessionUser(ctx).catch(() => null);
  const it = await viewItem(ctx, ctx.params.id, viewer);
  const out = summary(it);
  if (it.kind === 'workout') out.text = it.text; else out.course = it.course;
  return {
    body: {
      item: { ...out, hidden: it.hidden }, mine: !!viewer && viewer.id === it.owner, liked: viewer ? await ctx.store.isLiked(it.id, viewer.id) : false,
      comments: (await ctx.store.listComments(it.id, 200)).map(c => commentOut(c, viewer)),
    },
  };
}));

/* ---------- publish, delete ---------- */
route('POST', '/api/community', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req, L.course + 16 * 1024);
  const kind = b.kind;
  if (!['workout', 'course'].includes(kind)) fail(400, 'bad_kind');
  const name = readItemName(b.name), tags = readTags(b.tags);
  const it = { id: shortId(10), kind, owner: u.id, name, tags, createdAt: ctx.now, updatedAt: ctx.now, search: normalize([name, ...tags].join(' ')) };
  if (kind === 'workout') {
    const w = readWorkout(b.text);
    Object.assign(it, { text: b.text.trim(), minutes: Math.round(w.total / 6) / 10, tss: w.tss, hash: sha256('w' + JSON.stringify(w.tree)) });
  } else {
    const c = readCourse(b.course);
    Object.assign(it, { course: { name, dist: c.dist, gain: c.gain, ele: c.ele, ll: c.ll }, distM: c.dist, gainM: c.gain, hash: sha256('c' + JSON.stringify(c.ll.length ? c.ll : c.ele)) });
  }
  const dup = await ctx.store.findItemByHash(u.id, kind, it.hash);
  if (dup) fail(409, 'duplicate', { id: dup.id });
  await limit(ctx, [[`publish:${u.id}`, DAY, isNew(u, ctx) ? L.publish.newDay : L.publish.day], [`publish:ip:${ctx.ip}`, DAY, L.publish.ipDay]]);
  await ctx.store.insertItem(it);
  return { status: 201, body: { item: summary({ ...it, ownerName: u.name, likes: 0, rides: 0, comments: 0 }) } };
});

route('DELETE', '/api/community/:id', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), it = await viewItem(ctx, ctx.params.id, u);
  if (it.owner !== u.id && !isAdmin(await ctx.store.identitiesOf(u.id))) fail(403, 'forbidden');
  await ctx.store.deleteItem(it.id);
  return { body: { ok: true } };
});

/* ---------- likes, rides ---------- */
for (const method of ['POST', 'DELETE']) {
  route(method, '/api/community/:id/like', async ctx => {
    checkWrite(ctx.req);
    const u = await requireUser(ctx), it = await viewItem(ctx, ctx.params.id, u);
    await limit(ctx, [[`like:${u.id}`, DAY, L.likes]]);
    return { body: await ctx.store.setLike(it.id, u.id, method === 'POST', ctx.now) };
  });
}
route('POST', '/api/community/:id/ride', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), it = await viewItem(ctx, ctx.params.id, u);
  await limit(ctx, [[`itemride:${u.id}`, DAY, L.rides]]);
  return { body: await ctx.store.countRide(it.id, u.id, Math.floor(ctx.now / DAY) * DAY, ctx.now) };  // one per rider per UTC day
});

/* ---------- comments ---------- */
route('POST', '/api/community/:id/comments', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), it = await viewItem(ctx, ctx.params.id, u), b = await readJson(ctx.req);
  const body = clean(b.body, true).replace(/\n{3,}/g, '\n\n');
  if (body.length < L.comment[0] || body.length > L.comment[1]) fail(400, 'bad_comment', { min: L.comment[0], max: L.comment[1] });
  if (hasLink(body)) fail(400, 'no_links');
  if (hasBadWord(body)) fail(400, 'blocked_words', { field: 'body' });
  const hash = sha256(normalize(body));
  if (await ctx.store.findCommentByHash(u.id, hash, ctx.now - DAY)) fail(409, 'duplicate');
  await limit(ctx, [[`comment:${u.id}`, DAY, isNew(u, ctx) ? L.comments.newDay : L.comments.day], [`comment:ip:${ctx.ip}`, DAY, L.comments.ipDay]]);
  const c = { id: shortId(12), itemId: it.id, userId: u.id, body, hash, createdAt: ctx.now };
  await ctx.store.insertComment(c);
  return { status: 201, body: { comment: commentOut({ ...c, userName: u.name }, u) } };
});
route('DELETE', '/api/community/comments/:cid', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), c = ID_RE.test(ctx.params.cid) ? await ctx.store.getComment(ctx.params.cid) : null;
  if (!c) fail(404, 'not_found');
  const it = await ctx.store.getItem(c.itemId);
  if (c.userId !== u.id && it?.owner !== u.id && !isAdmin(await ctx.store.identitiesOf(u.id))) fail(403, 'forbidden');
  await ctx.store.deleteComment(c.id);
  return { body: { ok: true } };
});

/* ---------- reports: 3 distinct accounts hide the target until the owner reviews it ---------- */
async function report(ctx, type, target, ownerId) {
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await limit(ctx, [[`report:${u.id}`, DAY, L.reports]]);
  if (u.id === ownerId) return { body: { ok: true, hidden: false } };  // own content: nothing to do
  const reason = clean(b.reason).slice(0, L.reason);
  const r = await ctx.store.addReport(type, target, u.id, reason, ctx.now, L.hideAt);
  return { body: { ok: true, hidden: r.hidden } };
}
route('POST', '/api/community/:id/report', async ctx => {
  checkWrite(ctx.req);
  const it = await viewItem(ctx, ctx.params.id, null);
  return report(ctx, 'item', it.id, it.owner);
});
route('POST', '/api/community/comments/:cid/report', async ctx => {
  checkWrite(ctx.req);
  const c = ID_RE.test(ctx.params.cid) ? await ctx.store.getComment(ctx.params.cid) : null;
  if (!c || c.hidden) fail(404, 'not_found');
  return report(ctx, 'comment', c.id, c.userId);
});

/* ---------- admin (OWNER_EMAILS, verified address) ---------- */
async function requireAdmin(ctx) {
  const u = await requireUser(ctx);
  if (!isAdmin(await ctx.store.identitiesOf(u.id))) fail(403, 'forbidden');
  return u;
}
route('GET', '/api/admin/hidden', async ctx => {
  await requireAdmin(ctx);
  const h = await ctx.store.listHidden();
  return {
    body: {
      items: h.items.map(i => ({ ...summary(i), owner: i.owner, reasons: i.reasons, ...(i.kind === 'workout' ? { text: i.text } : {}) })),
      comments: h.comments.map(c => ({ id: c.id, itemId: c.itemId, author: c.userName || 'Rider', userId: c.userId, body: c.body, createdAt: c.createdAt, reasons: c.reasons })),
      messages: (h.messages || []).map(m => ({ id: m.id, author: m.userName || 'Rider', userId: m.userId, body: m.body, createdAt: m.createdAt, reasons: m.reasons })),
    },
  };
});
const ADMIN = {  // chat messages (social.js) are reviewed here too
  items: { t: 'item', get: (s, id) => s.getItem(id), del: (s, id) => s.deleteItem(id) },
  comments: { t: 'comment', get: (s, id) => s.getComment(id), del: (s, id) => s.deleteComment(id) },
  messages: { t: 'message', get: (s, id) => s.getMessage(id), del: (s, id) => s.deleteMessage(id) },
};
for (const [type, A] of Object.entries(ADMIN)) {
  route('POST', `/api/admin/${type}/:id`, async ctx => {
    checkWrite(ctx.req);
    await requireAdmin(ctx);
    const b = await readJson(ctx.req), id = ctx.params.id, t = A.t;
    const exists = /^[A-Za-z0-9_-]{6,24}$/.test(id) && await A.get(ctx.store, id);
    if (!exists) fail(404, 'not_found');
    if (b.action === 'unhide') await ctx.store.setHidden(t, id, false);
    else if (b.action === 'hide') await ctx.store.setHidden(t, id, true);
    else if (b.action === 'delete') await A.del(ctx.store, id);
    else fail(400, 'bad_action');
    return { body: { ok: true } };
  });
}

module.exports = { L, readWorkout, readCourse, stepCount };
