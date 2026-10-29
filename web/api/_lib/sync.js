// /api/sync/*: records (workout | course | settings) and rides, last write wins with tombstones.
'use strict';
const zlib = require('node:zlib');
const { route, requireUser, limit } = require('./app');
const { fail, readJson, readRaw, checkWrite } = require('./http');

const HOUR = 3600000, SKEW = 60000;
const KINDS = { workout: { max: 2000, bytes: 32 * 1024 }, course: { max: 200, bytes: 1024 * 1024 }, settings: { max: 10, bytes: 32 * 1024 } };
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const LIMITS = { pushRecords: 200, pushBytes: 3 * 1024 * 1024, rideGzip: 2 * 1024 * 1024, rideJson: 16 * 1024 * 1024, rides: 3000, rideBytes: 200 * 1024 * 1024, pull: 500 };

// client time, clamped to server time + 60 s so a fast clock cannot win every future conflict
function stamp(ctx, v) {
  const t = Number(v);
  if (!Number.isFinite(t) || t <= 0) fail(400, 'bad_updated_at');
  return Math.min(Math.floor(t), ctx.now + SKEW);
}

route('GET', '/api/sync/changes', async ctx => {
  const u = await requireUser(ctx);
  const since = Math.max(0, Math.floor(+ctx.url.searchParams.get('since') || 0));
  const lim = Math.min(LIMITS.pull, Math.max(1, Math.floor(+ctx.url.searchParams.get('limit') || LIMITS.pull)));
  const c = await ctx.store.changes(u.id, since, lim);
  return { body: c };
});

route('POST', '/api/sync/push', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx);
  const b = await readJson(ctx.req, LIMITS.pushBytes);
  await limit(ctx, [[`push:${u.id}`, HOUR, 600]]);
  if (!Array.isArray(b.records) || !b.records.length || b.records.length > LIMITS.pushRecords) fail(400, 'bad_records', { max: LIMITS.pushRecords });
  const byKey = new Map();
  b.records.forEach((r, i) => {
    if (!r || typeof r !== 'object' || !KINDS[r.kind] || !ID_RE.test(String(r.id))) fail(400, 'bad_record', { index: i });
    const rec = { kind: r.kind, id: String(r.id), updatedAt: stamp(ctx, r.updatedAt), deleted: r.deleted === true, data: null };
    if (!rec.deleted) {
      if (r.data === undefined || r.data === null || typeof r.data !== 'object') fail(400, 'bad_record', { index: i });
      if (JSON.stringify(r.data).length > KINDS[r.kind].bytes) fail(413, 'record_too_large', { index: i, max: KINDS[r.kind].bytes });
      rec.data = r.data;
    }
    const k = rec.kind + '/' + rec.id, cur = byKey.get(k);  // the same record twice in one push: keep the winner
    if (!cur || rec.updatedAt > cur.updatedAt || (rec.updatedAt === cur.updatedAt && rec.deleted)) byKey.set(k, rec);
  });
  const recs = [...byKey.values()];
  const have = await ctx.store.countRecords(u.id);
  for (const k of Object.keys(KINDS)) {
    const adds = recs.filter(r => r.kind === k && !r.deleted).length;
    if (adds && (have[k] || 0) + adds > KINDS[k].max) fail(413, 'quota', { kind: k, max: KINDS[k].max });
  }
  return { body: await ctx.store.pushRecords(u.id, recs, ctx.now) };
});

// gzip of the ride JSON. Bounded twice: the compressed upload and the inflated size (gzip bombs).
function inflate(buf) {
  if (buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b) fail(400, 'bad_gzip');
  try { return zlib.gunzipSync(buf, { maxOutputLength: LIMITS.rideJson }); }
  catch (e) { if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /buffer|too large/i.test(e.message || ''))) fail(413, 'ride_too_large', { maxInflated: LIMITS.rideJson }); fail(400, 'bad_gzip'); }
}

route('PUT', '/api/sync/rides/:id', async ctx => {
  checkWrite(ctx.req, ['application/gzip']);
  const u = await requireUser(ctx), id = ctx.params.id;
  if (!ID_RE.test(id)) fail(400, 'bad_id');
  const updatedAt = stamp(ctx, ctx.url.searchParams.get('updatedAt'));
  await limit(ctx, [[`ride:${u.id}`, HOUR, 300]]);
  const body = await readRaw(ctx.req, LIMITS.rideGzip);
  let ride; try { ride = JSON.parse(inflate(body).toString('utf8')); } catch (e) { if (e.status) throw e; fail(400, 'bad_ride'); }
  if (!ride || typeof ride !== 'object' || Array.isArray(ride) || !Array.isArray(ride.samples)) fail(400, 'bad_ride');
  if (ride.id !== undefined && String(ride.id) !== id) fail(400, 'id_mismatch');
  const use = await ctx.store.rideUsage(u.id);
  if (use.count >= LIMITS.rides || use.bytes + body.length > LIMITS.rideBytes) {
    const cur = await ctx.store.getRide(u.id, id);  // replacing an existing ride is fine if it still fits
    if (!cur || cur.deleted || use.bytes - cur.size + body.length > LIMITS.rideBytes) fail(413, 'quota', { rides: LIMITS.rides, bytes: LIMITS.rideBytes });
  }
  const start = Number.isFinite(+ride.start) ? +ride.start : (Number.isFinite(+ride.samples[0]?.[0]) ? +ride.samples[0][0] : null);
  const r = await ctx.store.putRide(u.id, { id, body, size: body.length, name: String(ride.name || '').slice(0, 120), start, samples: ride.samples.length, updatedAt, deleted: false });
  return { body: r };
});

route('DELETE', '/api/sync/rides/:id', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), id = ctx.params.id;
  if (!ID_RE.test(id)) fail(400, 'bad_id');
  const b = await readJson(ctx.req);
  await limit(ctx, [[`ride:${u.id}`, HOUR, 300]]);
  return { body: await ctx.store.putRide(u.id, { id, body: null, size: 0, name: '', start: null, samples: 0, updatedAt: stamp(ctx, b.updatedAt), deleted: true }) };
});

route('GET', '/api/sync/rides/:id', async ctx => {
  const u = await requireUser(ctx), id = ctx.params.id;
  if (!ID_RE.test(id)) fail(400, 'bad_id');
  const r = await ctx.store.getRide(u.id, id);
  if (!r || r.deleted || !r.body) fail(404, 'not_found');
  const res = ctx.res;
  if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Updated-At', String(r.updatedAt));
  res.setHeader('X-Rev', String(r.rev));
  res.end(r.body);
});

route('GET', '/api/sync/export', async ctx => {
  const u = await requireUser(ctx);
  await limit(ctx, [[`export:${u.id}`, HOUR, 20]]);
  const ids = await ctx.store.identitiesOf(u.id), data = await ctx.store.exportUser(u.id);
  return {
    body: {
      exportedAt: ctx.now, user: { id: u.id, name: u.name, createdAt: u.createdAt },
      identities: ids.map(i => ({ provider: i.provider, email: i.email || null, verified: !!i.verified, createdAt: i.createdAt })),
      records: data.records, rides: data.rides.map(r => ({ ...r, url: `/api/sync/rides/${encodeURIComponent(r.id)}` })),
    },
    headers: { 'Content-Disposition': 'attachment; filename="justwatts-account.json"' },
  };
});

module.exports = { LIMITS, KINDS };
