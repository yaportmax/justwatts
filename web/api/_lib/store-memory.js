// In-memory store with the same interface and rules as store-pg.js. Used by the tests (and by
// JUSTWATTS_STORE=memory for local experiments). Every method is async like the Postgres one.
'use strict';

class StoreError extends Error { constructor(code) { super(code); this.code = code; } }
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const DAY = 86400000;

function memoryStore() {
  const users = new Map(), idents = new Map(), tokens = new Map(), rate = new Map();
  const records = new Map(), rides = new Map();           // key `${user}\n${kind}\n${id}` / `${user}\n${id}`
  const items = new Map(), likes = new Map(), itemRides = new Set(), comments = new Map(), reports = new Map();
  const integ = new Map();                                 // `${user}\n${ns}\n${name}` -> { value: Buffer, at }
  const ik = (p, s) => `${p}\n${s}`;
  const userIdents = uid => [...idents.values()].filter(i => i.userId === uid);
  const bumpRev = uid => ++users.get(uid).rev;
  const recount = id => {
    const it = items.get(id); if (!it) return;
    it.likes = [...likes.values()].filter(l => l.itemId === id).length;
    it.comments = [...comments.values()].filter(c => c.itemId === id && !c.hidden).length;
    it.rides = [...itemRides].filter(k => k.startsWith(id + '\n')).length;
  };
  const LWW = (cur, inc) => !cur || inc.updatedAt > cur.updatedAt || (inc.updatedAt === cur.updatedAt && inc.deleted && !cur.deleted);

  return {
    kind: 'memory',
    async migrate() {},
    /* users + identities */
    async createUserWithIdentity(user, ident) {
      if (idents.has(ik(ident.provider, ident.subject))) throw new StoreError('exists');
      users.set(user.id, { name: '', ...clone(user), sessionVersion: 1, rev: 0 });
      idents.set(ik(ident.provider, ident.subject), { ...clone(ident), userId: user.id, createdAt: user.createdAt });
      return clone(users.get(user.id));
    },
    async getUser(id) { return clone(users.get(id)) || null; },
    async getIdentity(provider, subject) { return clone(idents.get(ik(provider, subject))) || null; },
    async identitiesOf(uid) { return clone(userIdents(uid).sort((a, b) => a.createdAt - b.createdAt)); },
    async addIdentity(ident) {
      if (idents.has(ik(ident.provider, ident.subject)) || userIdents(ident.userId).some(i => i.provider === ident.provider)) throw new StoreError('exists');
      idents.set(ik(ident.provider, ident.subject), clone(ident));
    },
    async removeIdentity(uid, provider) {
      const i = userIdents(uid).find(x => x.provider === provider); if (!i) return false;
      idents.delete(ik(i.provider, i.subject)); return true;
    },
    // the account an address belongs to: its email sign-in, else a verified provider address (Google)
    async identityByEmail(email) {
      const all = [...idents.values()].filter(i => i.email === email && (i.provider === 'email' || i.verified)).sort((a, b) => a.createdAt - b.createdAt);
      return clone(all.find(i => i.provider === 'email') || all[0]) || null;
    },
    // fold account `from` into `to`: sign-ins, synced records and rides (last write wins), community content; then drop `from`
    async mergeUser(from, to) {
      const src = users.get(from), dst = users.get(to); if (!src || !dst) return false;
      const mine = userIdents(from), theirs = userIdents(to);
      if (mine.some(i => theirs.some(x => x.provider === i.provider))) throw new StoreError('exists');
      for (const i of mine) i.userId = to;
      const rev = ++dst.rev;
      for (const [k, r] of [...records]) if (r.userId === from) {
        records.delete(k); const nk = `${to}\n${r.kind}\n${r.id}`;
        if (LWW(records.get(nk), r)) records.set(nk, { ...r, userId: to, rev });
      }
      for (const [k, r] of [...rides]) if (r.userId === from) {
        rides.delete(k); const nk = `${to}\n${r.id}`;
        if (LWW(rides.get(nk), r)) rides.set(nk, { ...r, userId: to, rev });
      }
      const touched = new Set();
      for (const it of items.values()) if (it.owner === from) it.owner = to;
      for (const c of comments.values()) if (c.userId === from) c.userId = to;
      for (const [k, l] of [...likes]) if (l.userId === from) { likes.delete(k); touched.add(l.itemId); const nk = `${l.itemId}\n${to}`; if (!likes.has(nk)) likes.set(nk, { ...l, userId: to }); }
      for (const k of [...itemRides]) { const [it, uid, day] = k.split('\n'); if (uid === from) { itemRides.delete(k); itemRides.add(`${it}\n${to}\n${day}`); touched.add(it); } }
      for (const [k, r] of [...reports]) if (r.userId === from) { reports.delete(k); const nk = `${r.type}\n${r.targetId}\n${to}`; if (!reports.has(nk)) reports.set(nk, { ...r, userId: to }); }
      for (const [k, t] of tokens) if (t.userId === from) tokens.delete(k);
      users.delete(from);
      for (const t of touched) recount(t);
      return true;
    },
    async setIdentityVerified(provider, subject, verified) { const i = idents.get(ik(provider, subject)); if (i) i.verified = !!verified; },
    async updateUser(id, patch) { const u = users.get(id); if (u) for (const k of ['name', 'passHash']) if (k in patch) u[k] = patch[k]; },
    async bumpSession(id) { const u = users.get(id); return u ? ++u.sessionVersion : 0; },
    async deleteUser(id) {
      for (const i of userIdents(id)) idents.delete(ik(i.provider, i.subject));
      for (const [k, t] of tokens) if (t.userId === id) tokens.delete(k);
      for (const [k, r] of records) if (r.userId === id) records.delete(k);
      for (const [k, r] of rides) if (r.userId === id) rides.delete(k);
      const touched = new Set();
      for (const [k, l] of likes) if (l.userId === id) { likes.delete(k); touched.add(l.itemId); }
      for (const k of [...itemRides]) if (k.split('\n')[1] === id) { itemRides.delete(k); touched.add(k.split('\n')[0]); }
      for (const [k, c] of comments) if (c.userId === id) { comments.delete(k); touched.add(c.itemId); }
      for (const [k, r] of reports) if (r.userId === id) reports.delete(k);
      for (const [k, it] of items) if (it.owner === id) {
        items.delete(k);
        for (const [ck, c] of comments) if (c.itemId === k) comments.delete(ck);
        for (const [lk, l] of likes) if (l.itemId === k) likes.delete(lk);
        for (const rk of [...itemRides]) if (rk.startsWith(k + '\n')) itemRides.delete(rk);
      }
      for (const k of [...integ.keys()]) if (k.split('\n')[0] === id) integ.delete(k);
      for (const t of touched) recount(t);
      users.delete(id);
    },
    /* integrations (web/api/_lib/integrations): sealed secrets, job state, FIT files; values are bytes */
    async getIntegrationData(uid, ns, name) { const v = integ.get(`${uid}\n${ns}\n${name}`); return v ? Buffer.from(v.value) : null; },
    async putIntegrationData(uid, ns, name, value, now) {
      const k = `${uid}\n${ns}\n${name}`;
      if (value === null || value === undefined) integ.delete(k); else integ.set(k, { value: Buffer.from(value), at: now });
    },
    async pruneIntegrationData(before) {
      for (const [k, v] of integ) { const [, ns, name] = k.split('\n'); if (v.at < before && (ns === 'file' || (ns === 'state' && name.startsWith('meta:')))) integ.delete(k); }
    },
    async countIntegrationData(uid) { return [...integ.keys()].filter(k => k.split('\n')[0] === uid).length; },
    /* one-time tokens (hashed) */
    async putToken(t) {
      for (const [k, x] of tokens) if (x.userId === t.userId && x.purpose === t.purpose) tokens.delete(k);
      tokens.set(t.hash, clone(t));
    },
    async takeToken(hash, purpose, now) {
      const t = tokens.get(hash); if (!t || t.purpose !== purpose) return null;
      tokens.delete(hash); return t.expiresAt > now ? t : null;
    },
    /* fixed-window rate limits */
    async hit(key, windowMs, limit, now) {
      const start = Math.floor(now / windowMs) * windowMs, k = `${key}\n${start}`;
      const n = (rate.get(k) || 0) + 1; rate.set(k, n);
      if (rate.size > 50000) for (const [x] of rate) if (+x.split('\n').pop() + DAY * 2 < now) rate.delete(x);
      return { ok: n <= limit, count: n, resetAt: start + windowMs };
    },
    /* sync records */
    async countRecords(uid) {
      const out = {}; for (const r of records.values()) if (r.userId === uid && !r.deleted) out[r.kind] = (out[r.kind] || 0) + 1;
      return out;
    },
    async pushRecords(uid, recs) {
      const rev = bumpRev(uid), results = [];
      for (const r of recs) {
        const k = `${uid}\n${r.kind}\n${r.id}`, cur = records.get(k), ok = LWW(cur, r);
        if (ok) records.set(k, { userId: uid, kind: r.kind, id: r.id, data: r.deleted ? null : clone(r.data), updatedAt: r.updatedAt, deleted: !!r.deleted, rev });
        results.push({ kind: r.kind, id: r.id, applied: ok });
      }
      return { rev, results };
    },
    async changes(uid, since, limit) {
      const byRev = (a, b) => a.rev - b.rev;
      const recs = [...records.values()].filter(r => r.userId === uid && r.rev > since).sort(byRev).slice(0, limit + 1)
        .map(r => ({ kind: r.kind, id: r.id, data: clone(r.data), updatedAt: r.updatedAt, deleted: r.deleted, rev: r.rev }));
      const rds = [...rides.values()].filter(r => r.userId === uid && r.rev > since).sort(byRev).slice(0, limit + 1).map(rideHead);
      return pageChanges(recs, rds, limit, users.get(uid)?.rev || 0);
    },
    async putRide(uid, r) {
      const k = `${uid}\n${r.id}`, cur = rides.get(k);
      if (!LWW(cur, r)) return { applied: false, rev: users.get(uid).rev };
      const rev = bumpRev(uid);
      rides.set(k, { userId: uid, ...r, body: r.deleted ? null : Buffer.from(r.body), size: r.deleted ? 0 : r.size, rev });
      return { applied: true, rev };
    },
    async getRide(uid, id) { const r = rides.get(`${uid}\n${id}`); return r ? { ...rideHead(r), body: r.body } : null; },
    async rideUsage(uid) {
      const rs = [...rides.values()].filter(r => r.userId === uid && !r.deleted);
      return { count: rs.length, bytes: rs.reduce((a, r) => a + r.size, 0) };
    },
    async exportUser(uid) {
      return {
        records: [...records.values()].filter(r => r.userId === uid && !r.deleted).map(r => ({ kind: r.kind, id: r.id, data: clone(r.data), updatedAt: r.updatedAt })),
        rides: [...rides.values()].filter(r => r.userId === uid && !r.deleted).map(rideHead),
      };
    },
    /* community */
    async insertItem(it) { items.set(it.id, { likes: 0, comments: 0, rides: 0, hidden: false, ...clone(it) }); },
    async findItemByHash(owner, kind, hash) { return clone([...items.values()].find(i => i.owner === owner && i.kind === kind && i.hash === hash)) || null; },
    async getItem(id) { const it = items.get(id); return it ? { ...clone(it), ownerName: users.get(it.owner)?.name || '' } : null; },
    async deleteItem(id) {
      items.delete(id);
      for (const [k, c] of comments) if (c.itemId === id) comments.delete(k);
      for (const [k, l] of likes) if (l.itemId === id) likes.delete(k);
      for (const k of [...itemRides]) if (k.startsWith(id + '\n')) itemRides.delete(k);
      for (const [k, r] of reports) if (r.type === 'item' && r.targetId === id) reports.delete(k);
    },
    async searchItems(f) {
      let list = [...items.values()].filter(i => !i.hidden);
      if (f.kind) list = list.filter(i => i.kind === f.kind);
      if (f.tag) list = list.filter(i => i.tags.includes(f.tag));
      if (f.durMin != null) list = list.filter(i => i.minutes != null && i.minutes >= f.durMin);
      if (f.durMax != null) list = list.filter(i => i.minutes != null && i.minutes < f.durMax);
      if (f.q) list = list.filter(i => i.search.includes(f.q));
      const since = f.since || 0;
      if (f.sort === 'new' && since) list = list.filter(i => i.createdAt >= since);
      const score = i => f.sort === 'liked' ? (since ? [...likes.values()].filter(l => l.itemId === i.id && l.createdAt >= since).length : i.likes)
        : f.sort === 'popular' ? (since ? [...itemRides].filter(k => k.startsWith(i.id + '\n') && +k.split('\n')[2] >= since).length : i.rides) : 0;
      const s = new Map(list.map(i => [i.id, score(i)]));
      list.sort((a, b) => s.get(b.id) - s.get(a.id) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
      const page = list.slice(f.offset, f.offset + f.limit + 1);
      return { items: page.slice(0, f.limit).map(i => ({ ...clone(i), ownerName: users.get(i.owner)?.name || '', score: s.get(i.id) })), more: page.length > f.limit };
    },
    async setLike(itemId, uid, on, now) {
      const k = `${itemId}\n${uid}`;
      if (on && !likes.has(k)) likes.set(k, { itemId, userId: uid, createdAt: now });
      if (!on) likes.delete(k);
      recount(itemId);
      return { likes: items.get(itemId)?.likes || 0, liked: on };
    },
    async isLiked(itemId, uid) { return likes.has(`${itemId}\n${uid}`); },
    async countRide(itemId, uid, day) {
      const k = `${itemId}\n${uid}\n${day}`, counted = !itemRides.has(k);
      itemRides.add(k); recount(itemId);
      return { counted, rides: items.get(itemId)?.rides || 0 };
    },
    async insertComment(c) { comments.set(c.id, { hidden: false, ...clone(c) }); recount(c.itemId); },
    async getComment(id) { const c = comments.get(id); return c ? clone(c) : null; },
    async listComments(itemId, limit) {
      return [...comments.values()].filter(c => c.itemId === itemId && !c.hidden).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).slice(-limit)
        .map(c => ({ ...clone(c), userName: users.get(c.userId)?.name || '' }));
    },
    async deleteComment(id) {
      const c = comments.get(id); if (!c) return;
      comments.delete(id); for (const [k, r] of reports) if (r.type === 'comment' && r.targetId === id) reports.delete(k);
      recount(c.itemId);
    },
    async findCommentByHash(uid, hash, since) { return [...comments.values()].some(c => c.userId === uid && c.hash === hash && c.createdAt >= since); },
    async addReport(type, targetId, uid, reason, now, threshold) {
      const k = `${type}\n${targetId}\n${uid}`;
      if (!reports.has(k)) reports.set(k, { type, targetId, userId: uid, reason, createdAt: now });
      const count = [...reports.values()].filter(r => r.type === type && r.targetId === targetId).length;
      const t = type === 'item' ? items.get(targetId) : comments.get(targetId);
      if (t && count >= threshold && !t.hidden) { t.hidden = true; if (type === 'comment') recount(t.itemId); }
      return { count, hidden: !!t?.hidden };
    },
    async setHidden(type, id, hidden) {
      const t = type === 'item' ? items.get(id) : comments.get(id); if (!t) return false;
      t.hidden = !!hidden;
      if (!hidden) for (const [k, r] of reports) if (r.type === type && r.targetId === id) reports.delete(k);
      if (type === 'comment') recount(t.itemId);
      return true;
    },
    async listHidden() {
      const rc = (type, id) => [...reports.values()].filter(r => r.type === type && r.targetId === id).map(r => r.reason);
      return {
        items: [...items.values()].filter(i => i.hidden).map(i => ({ ...clone(i), ownerName: users.get(i.owner)?.name || '', reasons: rc('item', i.id) })),
        comments: [...comments.values()].filter(c => c.hidden).map(c => ({ ...clone(c), userName: users.get(c.userId)?.name || '', reasons: rc('comment', c.id) })),
      };
    },
  };
}
// merge record and ride rows by rev; never split one rev across pages (a push shares one rev)
function pageChanges(recs, rds, limit, R) {
  const all = [...recs.map(r => ['r', r]), ...rds.map(r => ['d', r])].sort((a, b) => a[1].rev - b[1].rev);
  let page = all.slice(0, limit + 1); const more = page.length > limit;
  if (more) { page = page.slice(0, limit); const last = page[page.length - 1][1].rev; if (page[0][1].rev !== last) page = page.filter(x => x[1].rev < last); }
  return { rev: more ? page[page.length - 1][1].rev : R, more, records: page.filter(x => x[0] === 'r').map(x => x[1]), rides: page.filter(x => x[0] === 'd').map(x => x[1]) };
}
function rideHead(r) { return { id: r.id, name: r.name, start: r.start, samples: r.samples, size: r.size, updatedAt: r.updatedAt, deleted: r.deleted, rev: r.rev }; }

module.exports = { memoryStore, StoreError, pageChanges };
