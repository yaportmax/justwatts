// Postgres store (Neon over HTTP in production). Same interface and rules as store-memory.js.
// db = { q(text, params) -> rows, tx([[text, params], ...]) -> [rows, ...] } (one transaction).
// Times are ms since epoch in float8; counters are int4, so drivers hand back plain numbers.
// Writes that bump the per-user rev are single statements: the users row lock orders them, so a
// pull that reads users.rev first never skips a change.
'use strict';
const { StoreError, pageChanges } = require('./store-memory');

const S = 'justwatts';
const MIGRATIONS = [
  { version: 1, sql: [
    `CREATE TABLE IF NOT EXISTS ${S}.users (id text PRIMARY KEY, name text NOT NULL DEFAULT '', pass_hash text,
      created_at float8 NOT NULL, session_version int NOT NULL DEFAULT 1, rev int NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${S}.identities (provider text NOT NULL, subject text NOT NULL,
      user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE, email text, verified bool NOT NULL DEFAULT false,
      created_at float8 NOT NULL, PRIMARY KEY (provider, subject), UNIQUE (user_id, provider))`,
    `CREATE TABLE IF NOT EXISTS ${S}.one_time_tokens (hash text PRIMARY KEY, user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      purpose text NOT NULL, data text, expires_at float8 NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS one_time_tokens_user ON ${S}.one_time_tokens (user_id, purpose)`,
    `CREATE TABLE IF NOT EXISTS ${S}.rate_limits (key text NOT NULL, window_start float8 NOT NULL, count int NOT NULL, PRIMARY KEY (key, window_start))`,
    `CREATE TABLE IF NOT EXISTS ${S}.records (user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE, kind text NOT NULL, id text NOT NULL,
      data jsonb, updated_at float8 NOT NULL, deleted bool NOT NULL DEFAULT false, rev int NOT NULL, PRIMARY KEY (user_id, kind, id))`,
    `CREATE INDEX IF NOT EXISTS records_rev ON ${S}.records (user_id, rev)`,
    `CREATE TABLE IF NOT EXISTS ${S}.rides (user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE, id text NOT NULL,
      body bytea, size int NOT NULL DEFAULT 0, name text NOT NULL DEFAULT '', start_ms float8, samples int NOT NULL DEFAULT 0,
      updated_at float8 NOT NULL, deleted bool NOT NULL DEFAULT false, rev int NOT NULL, PRIMARY KEY (user_id, id))`,
    `CREATE INDEX IF NOT EXISTS rides_rev ON ${S}.rides (user_id, rev)`,
    `CREATE TABLE IF NOT EXISTS ${S}.items (id text PRIMARY KEY, kind text NOT NULL, owner text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      name text NOT NULL, text text, course jsonb, tags text[] NOT NULL DEFAULT '{}', minutes float8, tss float8, dist_m float8, gain_m float8,
      likes int NOT NULL DEFAULT 0, comments int NOT NULL DEFAULT 0, rides int NOT NULL DEFAULT 0,
      created_at float8 NOT NULL, updated_at float8 NOT NULL, hidden bool NOT NULL DEFAULT false, hash text NOT NULL, search text NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS items_owner ON ${S}.items (owner, kind, hash)`,
    `CREATE INDEX IF NOT EXISTS items_new ON ${S}.items (hidden, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${S}.likes (item_id text NOT NULL REFERENCES ${S}.items(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE, created_at float8 NOT NULL, PRIMARY KEY (item_id, user_id))`,
    `CREATE INDEX IF NOT EXISTS likes_user ON ${S}.likes (user_id)`,
    `CREATE TABLE IF NOT EXISTS ${S}.item_rides (item_id text NOT NULL REFERENCES ${S}.items(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE, day float8 NOT NULL, PRIMARY KEY (item_id, user_id, day))`,
    `CREATE INDEX IF NOT EXISTS item_rides_user ON ${S}.item_rides (user_id)`,
    `CREATE TABLE IF NOT EXISTS ${S}.comments (id text PRIMARY KEY, item_id text NOT NULL REFERENCES ${S}.items(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE, body text NOT NULL, hash text NOT NULL,
      created_at float8 NOT NULL, hidden bool NOT NULL DEFAULT false)`,
    `CREATE INDEX IF NOT EXISTS comments_item ON ${S}.comments (item_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS comments_user ON ${S}.comments (user_id, hash)`,
    `CREATE TABLE IF NOT EXISTS ${S}.reports (type text NOT NULL, target_id text NOT NULL, user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      reason text NOT NULL DEFAULT '', created_at float8 NOT NULL, PRIMARY KEY (type, target_id, user_id))`,
  ] },
  // integrations: secrets (AES-256-GCM sealed before they get here), job state and FIT files, per user
  { version: 2, sql: [
    `CREATE TABLE IF NOT EXISTS ${S}.integration_data (user_id text NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      ns text NOT NULL, name text NOT NULL, value bytea NOT NULL, updated_at float8 NOT NULL, PRIMARY KEY (user_id, ns, name))`,
    `CREATE INDEX IF NOT EXISTS integration_data_age ON ${S}.integration_data (ns, updated_at)`,
  ] },
];

const USER = 'id, name, pass_hash AS "passHash", created_at AS "createdAt", session_version AS "sessionVersion", rev';
const IDENT = 'provider, subject, user_id AS "userId", email, verified, created_at AS "createdAt"';
const RIDE = 'id, name, start_ms AS start, samples, size, updated_at AS "updatedAt", deleted, rev';
const ITEM = `i.id, i.kind, i.owner, coalesce(u.name, '') AS "ownerName", i.name, i.text, i.course, i.tags, i.minutes, i.tss,
  i.dist_m AS "distM", i.gain_m AS "gainM", i.likes, i.comments, i.rides, i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.hidden, i.hash, i.search`;
const COMMENT = `c.id, c.item_id AS "itemId", c.user_id AS "userId", coalesce(u.name, '') AS "userName", c.body, c.hash, c.created_at AS "createdAt", c.hidden`;
const RECOUNT = `UPDATE ${S}.items SET likes = (SELECT count(*) FROM ${S}.likes WHERE item_id = $1),
  comments = (SELECT count(*) FROM ${S}.comments WHERE item_id = $1 AND NOT hidden),
  rides = (SELECT count(*) FROM ${S}.item_rides WHERE item_id = $1) WHERE id = $1`;
const LWW = t => `excluded.updated_at > ${t}.updated_at OR (excluded.updated_at = ${t}.updated_at AND excluded.deleted AND NOT ${t}.deleted)`;
const unique = e => e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));
const one = rows => rows[0] || null;

function pgStore(db) {
  let ready = null;
  async function migrate() {
    let have = new Set();
    try { have = new Set((await db.q(`SELECT version FROM ${S}.schema_migrations`)).map(r => r.version)); } catch { /* first run */ }
    for (const m of MIGRATIONS) {
      if (have.has(m.version)) continue;
      await db.tx([
        ['SELECT pg_advisory_xact_lock(7316001)'],
        [`CREATE SCHEMA IF NOT EXISTS ${S}`],
        [`CREATE TABLE IF NOT EXISTS ${S}.schema_migrations (version int PRIMARY KEY, applied_at float8 NOT NULL)`],
        ...m.sql.map(s => [s]),
        [`INSERT INTO ${S}.schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [m.version, Date.now()]],
      ]);
    }
  }
  const q = async (text, params = []) => { if (!ready) ready = migrate().catch(e => { ready = null; throw e; }); await ready; return db.q(text, params); };
  const tx = async list => { if (!ready) ready = migrate().catch(e => { ready = null; throw e; }); await ready; return db.tx(list); };

  return {
    kind: 'pg',
    migrate: () => q('SELECT 1'),
    /* users + identities */
    async createUserWithIdentity(u, i) {
      try {
        const [rows] = await tx([
          [`INSERT INTO ${S}.users (id, name, pass_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING ${USER}`, [u.id, u.name || '', u.passHash || null, u.createdAt]],
          [`INSERT INTO ${S}.identities (provider, subject, user_id, email, verified, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [i.provider, i.subject, u.id, i.email || null, !!i.verified, u.createdAt]],
        ]);
        return rows[0];
      } catch (e) { if (unique(e)) throw new StoreError('exists'); throw e; }
    },
    async getUser(id) { return one(await q(`SELECT ${USER} FROM ${S}.users WHERE id = $1`, [id])); },
    async getIdentity(p, s) { return one(await q(`SELECT ${IDENT} FROM ${S}.identities WHERE provider = $1 AND subject = $2`, [p, s])); },
    async identitiesOf(uid) { return q(`SELECT ${IDENT} FROM ${S}.identities WHERE user_id = $1 ORDER BY created_at`, [uid]); },
    async addIdentity(i) {
      try { await q(`INSERT INTO ${S}.identities (provider, subject, user_id, email, verified, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [i.provider, i.subject, i.userId, i.email || null, !!i.verified, i.createdAt]); }
      catch (e) { if (unique(e)) throw new StoreError('exists'); throw e; }
    },
    async removeIdentity(uid, p) { return (await q(`DELETE FROM ${S}.identities WHERE user_id = $1 AND provider = $2 RETURNING provider`, [uid, p])).length > 0; },
    async identityByEmail(email) {
      return one(await q(`SELECT ${IDENT} FROM ${S}.identities WHERE email = $1 AND (provider = 'email' OR verified) ORDER BY (provider = 'email') DESC, created_at LIMIT 1`, [email]));
    },
    async mergeUser(from, to) {
      const [mine, theirs] = [await this.identitiesOf(from), await this.identitiesOf(to)];
      if (mine.some(i => theirs.some(x => x.provider === i.provider))) throw new StoreError('exists');
      const rev = `(SELECT rev FROM ${S}.users WHERE id = $2)`;
      try {
        await tx([
          [`UPDATE ${S}.identities SET user_id = $2 WHERE user_id = $1`, [from, to]],
          [`UPDATE ${S}.users SET rev = rev + 1 WHERE id = $1`, [to]],
          [`INSERT INTO ${S}.records AS t (user_id, kind, id, data, updated_at, deleted, rev)
            SELECT $2, kind, id, data, updated_at, deleted, ${rev} FROM ${S}.records WHERE user_id = $1
            ON CONFLICT (user_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, rev = excluded.rev
            WHERE ${LWW('t')}`, [from, to]],
          [`INSERT INTO ${S}.rides AS t (user_id, id, body, size, name, start_ms, samples, updated_at, deleted, rev)
            SELECT $2, id, body, size, name, start_ms, samples, updated_at, deleted, ${rev} FROM ${S}.rides WHERE user_id = $1
            ON CONFLICT (user_id, id) DO UPDATE SET body = excluded.body, size = excluded.size, name = excluded.name, start_ms = excluded.start_ms,
              samples = excluded.samples, updated_at = excluded.updated_at, deleted = excluded.deleted, rev = excluded.rev
            WHERE ${LWW('t')}`, [from, to]],
          [`UPDATE ${S}.items SET owner = $2 WHERE owner = $1`, [from, to]],
          [`UPDATE ${S}.comments SET user_id = $2 WHERE user_id = $1`, [from, to]],
          [`INSERT INTO ${S}.likes (item_id, user_id, created_at) SELECT item_id, $2, created_at FROM ${S}.likes WHERE user_id = $1 ON CONFLICT DO NOTHING`, [from, to]],
          [`INSERT INTO ${S}.item_rides (item_id, user_id, day) SELECT item_id, $2, day FROM ${S}.item_rides WHERE user_id = $1 ON CONFLICT DO NOTHING`, [from, to]],
          [`INSERT INTO ${S}.reports (type, target_id, user_id, reason, created_at) SELECT type, target_id, $2, reason, created_at FROM ${S}.reports WHERE user_id = $1 ON CONFLICT DO NOTHING`, [from, to]],
          [`DELETE FROM ${S}.users WHERE id = $1`, [from]],  // cascades the old rows
          [`UPDATE ${S}.items i SET likes = (SELECT count(*) FROM ${S}.likes WHERE item_id = i.id), rides = (SELECT count(*) FROM ${S}.item_rides WHERE item_id = i.id)
            WHERE i.id IN (SELECT item_id FROM ${S}.likes WHERE user_id = $1 UNION SELECT item_id FROM ${S}.item_rides WHERE user_id = $1)`, [to]],
        ]);
      } catch (e) { if (unique(e)) throw new StoreError('exists'); throw e; }
      return true;
    },
    async setIdentityVerified(p, s, v) { await q(`UPDATE ${S}.identities SET verified = $3 WHERE provider = $1 AND subject = $2`, [p, s, !!v]); },
    async updateUser(id, patch) {
      if ('name' in patch) await q(`UPDATE ${S}.users SET name = $2 WHERE id = $1`, [id, patch.name]);
      if ('passHash' in patch) await q(`UPDATE ${S}.users SET pass_hash = $2 WHERE id = $1`, [id, patch.passHash]);
    },
    async bumpSession(id) { return one(await q(`UPDATE ${S}.users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version AS v`, [id]))?.v || 0; },
    async deleteUser(id) {
      await tx([
        [`UPDATE ${S}.items i SET likes = i.likes - 1 FROM ${S}.likes l WHERE l.user_id = $1 AND l.item_id = i.id AND i.owner <> $1`, [id]],
        [`UPDATE ${S}.items i SET comments = i.comments - c.n FROM (SELECT item_id, count(*)::int n FROM ${S}.comments WHERE user_id = $1 AND NOT hidden GROUP BY item_id) c WHERE c.item_id = i.id AND i.owner <> $1`, [id]],
        [`UPDATE ${S}.items i SET rides = i.rides - r.n FROM (SELECT item_id, count(*)::int n FROM ${S}.item_rides WHERE user_id = $1 GROUP BY item_id) r WHERE r.item_id = i.id AND i.owner <> $1`, [id]],
        [`DELETE FROM ${S}.users WHERE id = $1`, [id]],
      ]);
    },
    /* integrations (web/api/_lib/integrations): values are bytes */
    async getIntegrationData(uid, ns, name) {
      const r = one(await q(`SELECT encode(value, 'base64') AS b64 FROM ${S}.integration_data WHERE user_id = $1 AND ns = $2 AND name = $3`, [uid, ns, name]));
      return r ? Buffer.from(r.b64, 'base64') : null;
    },
    async putIntegrationData(uid, ns, name, value, now) {
      if (value === null || value === undefined) { await q(`DELETE FROM ${S}.integration_data WHERE user_id = $1 AND ns = $2 AND name = $3`, [uid, ns, name]); return; }
      await q(`INSERT INTO ${S}.integration_data (user_id, ns, name, value, updated_at) VALUES ($1, $2, $3, decode($4::text, 'base64'), $5)
        ON CONFLICT (user_id, ns, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [uid, ns, name, Buffer.from(value).toString('base64'), now]);
    },
    async pruneIntegrationData(before) {
      await q(`DELETE FROM ${S}.integration_data WHERE updated_at < $1 AND (ns = 'file' OR (ns = 'state' AND name LIKE 'meta:%'))`, [before]);
    },
    async countIntegrationData(uid) { return one(await q(`SELECT count(*)::int AS n FROM ${S}.integration_data WHERE user_id = $1`, [uid])).n; },
    /* one-time tokens */
    async putToken(t) {
      await tx([
        [`DELETE FROM ${S}.one_time_tokens WHERE user_id = $1 AND purpose = $2`, [t.userId, t.purpose]],
        [`INSERT INTO ${S}.one_time_tokens (hash, user_id, purpose, data, expires_at) VALUES ($1, $2, $3, $4, $5)`, [t.hash, t.userId, t.purpose, t.data ?? null, t.expiresAt]],
      ]);
    },
    async takeToken(hash, purpose, now) {
      const t = one(await q(`DELETE FROM ${S}.one_time_tokens WHERE hash = $1 AND purpose = $2 RETURNING user_id AS "userId", purpose, data, expires_at AS "expiresAt"`, [hash, purpose]));
      return t && t.expiresAt > now ? t : null;
    },
    /* rate limits */
    async hit(key, windowMs, limit, now) {
      const start = Math.floor(now / windowMs) * windowMs;
      const r = one(await q(`INSERT INTO ${S}.rate_limits (key, window_start, count) VALUES ($1, $2, 1)
        ON CONFLICT (key, window_start) DO UPDATE SET count = ${S}.rate_limits.count + 1 RETURNING count`, [key, start]));
      if (Math.random() < 0.01) await q(`DELETE FROM ${S}.rate_limits WHERE window_start < $1`, [now - 2 * 86400000]);
      return { ok: r.count <= limit, count: r.count, resetAt: start + windowMs };
    },
    /* sync */
    async countRecords(uid) {
      const out = {}; for (const r of await q(`SELECT kind, count(*)::int n FROM ${S}.records WHERE user_id = $1 AND NOT deleted GROUP BY kind`, [uid])) out[r.kind] = r.n;
      return out;
    },
    async pushRecords(uid, recs) {
      const input = recs.map(r => ({ kind: r.kind, id: r.id, data: r.deleted ? null : r.data, updated_at: r.updatedAt, deleted: !!r.deleted }));
      const row = one(await q(`WITH r AS (UPDATE ${S}.users SET rev = rev + 1 WHERE id = $1 RETURNING rev),
        inp AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(kind text, id text, data jsonb, updated_at float8, deleted bool)),
        up AS (INSERT INTO ${S}.records AS t (user_id, kind, id, data, updated_at, deleted, rev)
          SELECT $1, inp.kind, inp.id, CASE WHEN inp.deleted THEN NULL ELSE inp.data END, inp.updated_at, inp.deleted, r.rev FROM inp, r
          ON CONFLICT (user_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, rev = excluded.rev
          WHERE ${LWW('t')} RETURNING kind, id)
        SELECT (SELECT rev FROM r) AS rev, coalesce((SELECT json_agg(kind || '/' || id) FROM up), '[]'::json) AS applied`, [uid, JSON.stringify(input)]));
      const ok = new Set(row.applied);
      return { rev: row.rev, results: recs.map(r => ({ kind: r.kind, id: r.id, applied: ok.has(r.kind + '/' + r.id) })) };
    },
    async changes(uid, since, limit) {
      const R = one(await q(`SELECT rev FROM ${S}.users WHERE id = $1`, [uid]))?.rev || 0;  // first: see the header note
      const recs = await q(`SELECT kind, id, data, updated_at AS "updatedAt", deleted, rev FROM ${S}.records WHERE user_id = $1 AND rev > $2 AND rev <= $3 ORDER BY rev LIMIT $4`, [uid, since, R, limit + 1]);
      const rds = await q(`SELECT ${RIDE} FROM ${S}.rides WHERE user_id = $1 AND rev > $2 AND rev <= $3 ORDER BY rev LIMIT $4`, [uid, since, R, limit + 1]);
      return pageChanges(recs, rds, limit, R);
    },
    async putRide(uid, r) {
      const row = one(await q(`WITH r AS (UPDATE ${S}.users SET rev = rev + 1 WHERE id = $1 RETURNING rev),
        up AS (INSERT INTO ${S}.rides AS t (user_id, id, body, size, name, start_ms, samples, updated_at, deleted, rev)
          SELECT $1, $2, CASE WHEN $9::bool THEN NULL ELSE decode($3::text, 'base64') END, $4::int, $5::text, $6::float8, $7::int, $8::float8, $9::bool, r.rev FROM r
          ON CONFLICT (user_id, id) DO UPDATE SET body = excluded.body, size = excluded.size, name = excluded.name, start_ms = excluded.start_ms,
            samples = excluded.samples, updated_at = excluded.updated_at, deleted = excluded.deleted, rev = excluded.rev
          WHERE ${LWW('t')} RETURNING rev)
        SELECT (SELECT rev FROM r) AS rev, (SELECT count(*)::int FROM up) AS n`,
      [uid, r.id, r.deleted ? '' : Buffer.from(r.body).toString('base64'), r.deleted ? 0 : r.size, r.name || '', r.start ?? null, r.samples || 0, r.updatedAt, !!r.deleted]));
      return { applied: row.n > 0, rev: row.rev };
    },
    async getRide(uid, id) {
      const r = one(await q(`SELECT ${RIDE}, encode(body, 'base64') AS b64 FROM ${S}.rides WHERE user_id = $1 AND id = $2`, [uid, id]));
      if (!r) return null;
      const { b64, ...head } = r; return { ...head, body: b64 ? Buffer.from(b64, 'base64') : null };
    },
    async rideUsage(uid) { return one(await q(`SELECT count(*)::int AS count, coalesce(sum(size), 0)::float8 AS bytes FROM ${S}.rides WHERE user_id = $1 AND NOT deleted`, [uid])); },
    async exportUser(uid) {
      return {
        records: await q(`SELECT kind, id, data, updated_at AS "updatedAt" FROM ${S}.records WHERE user_id = $1 AND NOT deleted ORDER BY kind, id`, [uid]),
        rides: await q(`SELECT ${RIDE} FROM ${S}.rides WHERE user_id = $1 AND NOT deleted ORDER BY start_ms, id`, [uid]),
      };
    },
    /* community */
    async insertItem(it) {
      await q(`INSERT INTO ${S}.items (id, kind, owner, name, text, course, tags, minutes, tss, dist_m, gain_m, created_at, updated_at, hash, search)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [it.id, it.kind, it.owner, it.name, it.text ?? null, it.course ? JSON.stringify(it.course) : null, it.tags, it.minutes ?? null, it.tss ?? null, it.distM ?? null, it.gainM ?? null, it.createdAt, it.updatedAt, it.hash, it.search]);
    },
    async findItemByHash(owner, kind, hash) { return one(await q(`SELECT ${ITEM} FROM ${S}.items i LEFT JOIN ${S}.users u ON u.id = i.owner WHERE i.owner = $1 AND i.kind = $2 AND i.hash = $3 LIMIT 1`, [owner, kind, hash])); },
    async getItem(id) { return one(await q(`SELECT ${ITEM} FROM ${S}.items i LEFT JOIN ${S}.users u ON u.id = i.owner WHERE i.id = $1`, [id])); },
    async deleteItem(id) {
      await tx([[`DELETE FROM ${S}.reports WHERE type = 'comment' AND target_id IN (SELECT id FROM ${S}.comments WHERE item_id = $1)`, [id]],
        [`DELETE FROM ${S}.reports WHERE type = 'item' AND target_id = $1`, [id]], [`DELETE FROM ${S}.items WHERE id = $1`, [id]]]);
    },
    async searchItems(f) {
      const p = [], w = ['NOT i.hidden'], arg = v => { p.push(v); return '$' + p.length; };
      if (f.kind) w.push(`i.kind = ${arg(f.kind)}`);
      if (f.tag) w.push(`${arg(f.tag)} = ANY(i.tags)`);
      if (f.durMin != null) w.push(`i.minutes >= ${arg(f.durMin)}`);
      if (f.durMax != null) w.push(`i.minutes < ${arg(f.durMax)}`);
      if (f.q) w.push(`position(${arg(f.q)} in i.search) > 0`);
      const since = f.since || 0;
      if (f.sort === 'new' && since) w.push(`i.created_at >= ${arg(since)}`);
      const score = f.sort === 'liked' ? (since ? `(SELECT count(*) FROM ${S}.likes l WHERE l.item_id = i.id AND l.created_at >= ${arg(since)})::int` : 'i.likes')
        : f.sort === 'popular' ? (since ? `(SELECT count(*) FROM ${S}.item_rides r WHERE r.item_id = i.id AND r.day >= ${arg(since)})::int` : 'i.rides') : '0';
      const rows = await q(`SELECT ${ITEM}, ${score} AS score FROM ${S}.items i LEFT JOIN ${S}.users u ON u.id = i.owner
        WHERE ${w.join(' AND ')} ORDER BY score DESC, i.created_at DESC, i.id COLLATE "C" LIMIT ${arg(f.limit + 1)} OFFSET ${arg(f.offset)}`, p);
      return { items: rows.slice(0, f.limit), more: rows.length > f.limit };
    },
    async setLike(itemId, uid, on, now) {
      const [, , rows] = await tx([
        on ? [`INSERT INTO ${S}.likes (item_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [itemId, uid, now]]
          : [`DELETE FROM ${S}.likes WHERE item_id = $1 AND user_id = $2`, [itemId, uid]],
        [RECOUNT, [itemId]],
        [`SELECT likes FROM ${S}.items WHERE id = $1`, [itemId]],
      ]);
      return { likes: rows[0]?.likes || 0, liked: on };
    },
    async isLiked(itemId, uid) { return (await q(`SELECT 1 FROM ${S}.likes WHERE item_id = $1 AND user_id = $2`, [itemId, uid])).length > 0; },
    async countRide(itemId, uid, day) {
      const [ins, , rows] = await tx([
        [`INSERT INTO ${S}.item_rides (item_id, user_id, day) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING day`, [itemId, uid, day]],
        [RECOUNT, [itemId]],
        [`SELECT rides FROM ${S}.items WHERE id = $1`, [itemId]],
      ]);
      return { counted: ins.length > 0, rides: rows[0]?.rides || 0 };
    },
    async insertComment(c) {
      await tx([[`INSERT INTO ${S}.comments (id, item_id, user_id, body, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [c.id, c.itemId, c.userId, c.body, c.hash, c.createdAt]], [RECOUNT, [c.itemId]]]);
    },
    async getComment(id) { return one(await q(`SELECT ${COMMENT} FROM ${S}.comments c LEFT JOIN ${S}.users u ON u.id = c.user_id WHERE c.id = $1`, [id])); },
    async listComments(itemId, limit) {
      return (await q(`SELECT ${COMMENT} FROM ${S}.comments c LEFT JOIN ${S}.users u ON u.id = c.user_id WHERE c.item_id = $1 AND NOT c.hidden ORDER BY c.created_at DESC, c.id COLLATE "C" DESC LIMIT $2`, [itemId, limit])).reverse();
    },
    async deleteComment(id) {
      const [, rows] = await tx([[`DELETE FROM ${S}.reports WHERE type = 'comment' AND target_id = $1`, [id]],
        [`DELETE FROM ${S}.comments WHERE id = $1 RETURNING item_id AS ref`, [id]]]);
      if (rows.length) await q(RECOUNT, [rows[0].ref]);
    },
    async findCommentByHash(uid, hash, since) { return (await q(`SELECT 1 FROM ${S}.comments WHERE user_id = $1 AND hash = $2 AND created_at >= $3 LIMIT 1`, [uid, hash, since])).length > 0; },
    async addReport(type, targetId, uid, reason, now, threshold) {
      const tbl = type === 'item' ? 'items' : 'comments';
      const [, cnt, hid] = await tx([
        [`INSERT INTO ${S}.reports (type, target_id, user_id, reason, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [type, targetId, uid, reason, now]],
        [`SELECT count(*)::int AS n FROM ${S}.reports WHERE type = $1 AND target_id = $2`, [type, targetId]],
        [`UPDATE ${S}.${tbl} SET hidden = true WHERE id = $1 AND (hidden OR (SELECT count(*) FROM ${S}.reports WHERE type = $2 AND target_id = $1) >= $3) RETURNING ${type === 'comment' ? 'item_id' : 'id'} AS ref`, [targetId, type, threshold]],
      ]);
      if (type === 'comment' && hid.length) await q(RECOUNT, [hid[0].ref]);
      return { count: cnt[0].n, hidden: hid.length > 0 };
    },
    async setHidden(type, id, hidden) {
      const tbl = type === 'item' ? 'items' : 'comments';
      const list = [[`UPDATE ${S}.${tbl} SET hidden = $2 WHERE id = $1 RETURNING ${type === 'comment' ? 'item_id' : 'id'} AS ref`, [id, !!hidden]]];
      if (!hidden) list.push([`DELETE FROM ${S}.reports WHERE type = $1 AND target_id = $2`, [type, id]]);
      const [rows] = await tx(list);
      if (rows.length && type === 'comment') await q(RECOUNT, [rows[0].ref]);
      return rows.length > 0;
    },
    async listHidden() {
      const reasons = `coalesce((SELECT json_agg(r.reason) FROM ${S}.reports r WHERE r.type = $1 AND r.target_id = x.id), '[]'::json) AS reasons`;
      return {
        items: await q(`SELECT x.*, ${reasons} FROM (SELECT ${ITEM} FROM ${S}.items i LEFT JOIN ${S}.users u ON u.id = i.owner WHERE i.hidden) x ORDER BY x."createdAt"`, ['item']),
        comments: await q(`SELECT x.*, ${reasons} FROM (SELECT ${COMMENT} FROM ${S}.comments c LEFT JOIN ${S}.users u ON u.id = c.user_id WHERE c.hidden) x ORDER BY x."createdAt"`, ['comment']),
      };
    },
  };
}

// Neon over HTTP (pooled URL). Loaded lazily so tests never need the package.
function neonDb(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  return { q: (t, p = []) => sql.query(t, p), tx: list => sql.transaction(list.map(([t, p = []]) => sql.query(t, p))) };
}

module.exports = { pgStore, neonDb, MIGRATIONS };
