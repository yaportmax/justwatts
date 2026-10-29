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
  // social: profiles, friend rows both ways (`${a}\n${b}` -> { state: out|in|yes }), blocks, presence, group rides,
  // members (`${group}\n${user}`), chat messages, activities (finished rides) and ride-ons
  const prof = new Map(), friends = new Map(), blocks = new Map(), pres = new Map(), groups = new Map(), members = new Map();
  const msgs = new Map(), acts = new Map(), rideons = new Set();
  let seq = 0;
  const nm = uid => users.get(uid)?.name || '';
  const blockedEither = (a, b) => blocks.has(`${a}\n${b}`) || blocks.has(`${b}\n${a}`);
  function dropSocial(uid) {
    prof.delete(uid); pres.delete(uid);
    for (const k of [...friends.keys()]) if (k.split('\n').includes(uid)) friends.delete(k);
    for (const k of [...blocks.keys()]) if (k.split('\n').includes(uid)) blocks.delete(k);
    for (const [id, g] of [...groups]) if (g.owner === uid) { groups.delete(id); for (const k of [...members.keys()]) if (k.startsWith(id + '\n')) members.delete(k); }
    for (const k of [...members.keys()]) if (k.split('\n')[1] === uid) members.delete(k);
    for (const [id, m] of [...msgs]) if (m.userId === uid) { msgs.delete(id); for (const [rk, r] of reports) if (r.type === 'message' && r.targetId === id) reports.delete(rk); }
    for (const [id, a] of [...acts]) if (a.userId === uid) { acts.delete(id); for (const k of [...rideons]) if (k.startsWith(id + '\n')) rideons.delete(k); }
    for (const k of [...rideons]) if (k.split('\n')[1] === uid) { rideons.delete(k); const a = acts.get(k.split('\n')[0]); if (a) a.rideons--; }
  }
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
      dropSocial(from);  // friends, groups and chat of the merged account are not carried over
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
      dropSocial(id);
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
    async integrationUsers(ns, name, limit) {  // oldest first
      return [...integ].filter(([k]) => { const [, a, b] = k.split('\n'); return a === ns && b === name; }).sort((a, b) => a[1].at - b[1].at).slice(0, limit).map(([k]) => k.split('\n')[0]);
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
      if (f.q) list = list.filter(i => i.search.includes(f.q) || String(users.get(i.owner)?.name || '').toLowerCase().includes(f.q));  // name, tags or the publisher
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
      const t = type === 'item' ? items.get(targetId) : type === 'message' ? msgs.get(targetId) : comments.get(targetId);
      if (t && count >= threshold && !t.hidden) { t.hidden = true; if (type === 'comment') recount(t.itemId); }
      return { count, hidden: !!t?.hidden };
    },
    async setHidden(type, id, hidden) {
      const t = type === 'item' ? items.get(id) : type === 'message' ? msgs.get(id) : comments.get(id); if (!t) return false;
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
        messages: [...msgs.values()].filter(m => m.hidden).map(m => ({ ...clone(m), userName: nm(m.userId), reasons: rc('message', m.id) })),
      };
    },
    /* social (social.js) */
    async socialMe(uid, code) {
      if (!prof.has(uid)) prof.set(uid, { code, visible: true });
      return clone(prof.get(uid));
    },
    async setVisible(uid, visible, code) { await this.socialMe(uid, code); prof.get(uid).visible = !!visible; return clone(prof.get(uid)); },
    async userByCode(code) {
      for (const [uid, p] of prof) if (p.code === code && users.has(uid)) return { id: uid, name: nm(uid) };
      return null;
    },
    async searchUsers(uid, q, lim) {
      const pre = u => u.name.toLowerCase().startsWith(q) ? 0 : 1;
      return [...users.values()].filter(u => u.id !== uid && u.name && u.name.toLowerCase().includes(q) && !blockedEither(uid, u.id))
        .sort((a, b) => pre(a) - pre(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, lim).map(u => ({ id: u.id, name: u.name }));
    },
    async relation(a, b) { return { state: friends.get(`${a}\n${b}`)?.state || null, blocked: blockedEither(a, b) }; },
    async setFriend(a, b, sa, sb, now) {
      if (!sa) { friends.delete(`${a}\n${b}`); friends.delete(`${b}\n${a}`); return; }
      if (!users.has(a) || !users.has(b)) return;
      friends.set(`${a}\n${b}`, { state: sa, at: now }); friends.set(`${b}\n${a}`, { state: sb, at: now });
    },
    async setBlock(a, b, on, now) {
      if (!on) { blocks.delete(`${a}\n${b}`); return; }
      if (!users.has(b)) return;
      friends.delete(`${a}\n${b}`); friends.delete(`${b}\n${a}`); blocks.set(`${a}\n${b}`, now);
    },
    async socialLists(uid, since) {
      const fr = [...friends].filter(([k]) => k.split('\n')[0] === uid).map(([k, f]) => {
        const id = k.split('\n')[1], p = pres.get(id);
        return { id, name: nm(id), state: f.state, riding: p && p.at > since ? clone(p) : null };
      });
      const bl = [...blocks.keys()].filter(k => k.split('\n')[0] === uid).map(k => { const id = k.split('\n')[1]; return { id, name: nm(id) }; });
      return { friends: fr, blocked: bl };
    },
    async putPresence(uid, row, look) {
      if (row) pres.set(uid, { ...clone(row), userId: uid }); else pres.delete(uid);
      const out = [];
      for (const [id, p] of pres) {
        if (id === uid || p.at <= look.since || blockedEither(uid, id)) continue;
        if (!(look.areas.includes(p.area) || (look.group && p.group === look.group))) continue;
        out.push({ id, name: nm(id), lat: p.lat, lon: p.lon, data: clone(p.data), group: p.group, friend: friends.get(`${uid}\n${id}`)?.state === 'yes' });
      }
      for (const [id, p] of [...pres]) if (p.at < look.since - 60000 && id !== uid) pres.delete(id);
      return out.slice(0, 200);
    },
    async dropPresence(uid) { pres.delete(uid); },
    async exportSocial(uid) {
      return {
        profile: clone(prof.get(uid)) || null,
        friends: [...friends].filter(([k]) => k.split('\n')[0] === uid).map(([k, f]) => ({ id: k.split('\n')[1], name: nm(k.split('\n')[1]), state: f.state })),
        blocked: [...blocks.keys()].filter(k => k.split('\n')[0] === uid).map(k => ({ id: k.split('\n')[1] })),
        groups: [...members].filter(([k]) => k.split('\n')[1] === uid).map(([k, m]) => { const g = groups.get(k.split('\n')[0]); return g && { id: g.id, name: g.name, startAt: g.startAt, plan: clone(g.plan), state: m.state, mine: g.owner === uid }; }).filter(Boolean),
        messages: [...msgs.values()].filter(m => m.userId === uid).sort((a, b) => a.seq - b.seq).map(m => ({ id: m.id, chan: m.chan, body: m.body, createdAt: m.createdAt })),
        activities: [...acts.values()].filter(a => a.userId === uid).map(a => ({ id: a.id, at: a.at, ...clone(a.data), rideons: a.rideons })),
      };
    },
    async createGroup(g) { groups.set(g.id, clone(g)); },
    async getGroup(id) { const g = groups.get(id); return g ? { ...clone(g), ownerName: nm(g.owner) } : null; },
    async deleteGroup(id) { groups.delete(id); for (const k of [...members.keys()]) if (k.startsWith(id + '\n')) members.delete(k); },
    async groupMembers(gid, viewer) {
      return [...members].filter(([k]) => k.split('\n')[0] === gid).map(([k, m]) => ({ id: k.split('\n')[1], name: nm(k.split('\n')[1]), state: m.state, at: m.at }))
        .filter(m => !viewer || m.id === viewer || !blockedEither(viewer, m.id)).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    },
    async memberState(gid, uid) { return members.get(`${gid}\n${uid}`)?.state || null; },
    async setMember(gid, uid, state, now) {
      const k = `${gid}\n${uid}`;
      if (!state) members.delete(k); else if (groups.has(gid) && users.has(uid)) members.set(k, { state, at: members.get(k)?.state === state ? members.get(k).at : now });
    },
    async myGroups(uid, since) {
      return [...members].filter(([k]) => k.split('\n')[1] === uid).map(([k, m]) => ({ g: groups.get(k.split('\n')[0]), state: m.state }))
        .filter(x => x.g && x.g.startAt >= since).sort((a, b) => a.g.startAt - b.g.startAt)
        .map(x => ({ ...clone(x.g), ownerName: nm(x.g.owner), state: x.state, members: [...members].filter(([k, m]) => k.split('\n')[0] === x.g.id && m.state === 'in').length }));
    },
    async addMessage(m) { const r = { ...clone(m), seq: ++seq, hidden: false }; msgs.set(m.id, r); return { seq: r.seq }; },
    async getMessage(id) { const m = msgs.get(id); return m ? clone(m) : null; },
    async readMessages(chan, viewer, since, lim) {
      return [...msgs.values()].filter(m => m.chan === chan && m.seq > since && !m.hidden && !blockedEither(viewer, m.userId))
        .sort((a, b) => a.seq - b.seq).slice(-lim).map(m => ({ ...clone(m), name: nm(m.userId) }));
    },
    async deleteMessage(id) { msgs.delete(id); for (const [k, r] of reports) if (r.type === 'message' && r.targetId === id) reports.delete(k); },
    async addActivity(a) { acts.set(a.id, { ...clone(a), rideons: 0 }); },
    async getActivity(id) { const a = acts.get(id); return a ? clone(a) : null; },
    async friendActivity(uid, since, lim) {
      const ok = id => id === uid || friends.get(`${uid}\n${id}`)?.state === 'yes';
      return [...acts.values()].filter(a => a.at >= since && ok(a.userId)).sort((a, b) => b.at - a.at).slice(0, lim)
        .map(a => ({ ...clone(a), name: nm(a.userId), gave: rideons.has(`${a.id}\n${uid}`) }));
    },
    async rideOn(aid, uid) {
      const a = acts.get(aid), k = `${aid}\n${uid}`;
      if (a && !rideons.has(k)) { rideons.add(k); a.rideons++; }
      return { rideons: a?.rideons || 0, gave: true };
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
