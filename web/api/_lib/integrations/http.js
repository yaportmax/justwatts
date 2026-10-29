// HTTP glue for /api/integrations: auth, same-origin checks, routing by ?op=, error mapping.
// Pure: everything it needs is injected (fetch, raw store, key, userId), so tests drive it with fakes.
'use strict';
const { IntegrationError, AUTH, scrub } = require('./base');
const crypto = require('node:crypto');
const { userStore } = require('./store');
const { hub } = require('./hub');

const MAX_JSON = 16 * 1024, MAX_FIT = 4 * 1024 * 1024;  // Vercel caps request bodies at 4.5 MB
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// op=cron (Vercel Cron, every 15 min, Authorization: Bearer $CRON_SECRET): retries due uploads for users with jobs
// waiting, at most CRON_MAX uploads and CRON_MS per run; the hub's own rules (3 tries, a day at most) end each job.
const CRON_USERS = 50, CRON_MAX = 4, CRON_MS = 8000;

function send(res, code, obj, type = 'application/json') {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}

function readBody(req, max) {
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    const b = Buffer.from(req.body);
    return b.length > max ? Promise.reject(new Error('too large')) : Promise.resolve(b);
  }
  if (req.body && typeof req.body === 'object') return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Writes need the page itself: same Origin as the Host, plus X-HW: 1 (forces a CORS preflight we never answer).
function sameOrigin(req) {
  const host = req.headers.host, origin = req.headers.origin;
  return !!host && (origin === `https://${host}` || origin === `http://${host}`) && req.headers['x-hw'] === '1';
}

function bearerOk(req, secret) {
  const a = Buffer.from(String(req.headers.authorization || '')), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeHandler({ fetch = globalThis.fetch, store, key, userId, now, sleep, log = () => {}, cronSecret = () => null }) {
  async function cron(req, res) {
    const secret = cronSecret();
    if (!secret || secret.length < 16) return send(res, 503, { error: 'cron is not set up' });
    if (!bearerOk(req, secret)) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET') return send(res, 405, { error: 'GET' });
    const until = Date.now() + CRON_MS, more = () => Date.now() < until;
    let users = 0, tried = 0;
    for (const uid of await store.retryUsers(CRON_USERS)) {
      if (tried >= CRON_MAX || !more()) break;
      users++;
      try { tried += (await hub({ fetch, store: userStore(store, key, uid), now, sleep }).retryDue(CRON_MAX - tried, more)).tried; }
      catch (e) { log('integrations cron: ' + String(e && e.message).slice(0, 200)); }
    }
    return send(res, 200, { users, tried });
  }
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x'), q = url.searchParams, op = q.get('op') || 'list';
    if (!key) return send(res, 503, { error: 'integrations are not set up on this server' });
    if (op === 'cron') return cron(req, res);
    const uid = await userId(req);
    if (!uid) return send(res, 401, { error: 'sign in to connect services' });
    const write = req.method === 'POST';
    if (write && !sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    if (!write && req.method !== 'GET') return send(res, 405, { error: 'GET or POST' });
    const us = userStore(store, key, uid);
    const h = hub({ fetch, store: us, now, sleep });
    const svc = q.get('service') || '', rid = q.get('ride') || '';
    let body = {};
    try {
      if (write && op !== 'upload') body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'body must be an object' });
    } catch { return send(res, 400, { error: 'bad body' }); }
    try {
      if (!write && op === 'list') return send(res, 200, { integrations: await h.list() });
      if (!write && op === 'targets') return send(res, 200, await h.targets(rid));
      if (!write && op === 'planned') {
        const day = q.get('date') || new Date().toISOString().slice(0, 10);
        if (!DAY_RE.test(day)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
        return send(res, 200, await h.planned(day));
      }
      if (!write && op === 'fit') {
        const fit = await h.fit(rid);
        if (!fit) return send(res, 404, { error: 'no .fit file stored for this ride' });
        res.setHeader('Content-Disposition', `attachment; filename="${rid}.fit"`);
        return send(res, 200, fit, 'application/octet-stream');
      }
      if (write && op === 'connect') {
        const { ride_id: rideId, ...fields } = body;
        if (rideId && !/^[\w-]{1,80}$/.test(String(rideId))) return send(res, 400, { error: 'bad ride id' });
        try { return send(res, 200, await h.connect(svc, fields, rideId ? String(rideId) : null)); }
        catch (e) { e.extraSecrets = Object.values(fields).filter(v => typeof v === 'string'); throw e; }
      }
      if (write && op === 'disconnect') { await h.disconnect(svc); return send(res, 200, { integrations: await h.list() }); }
      if (write && op === 'auto') { await h.setAuto(svc, !!body.on); return send(res, 200, { integrations: await h.list() }); }
      if (write && op === 'syncs') { await h.setSyncs(body.syncs_to); return send(res, 200, { integrations: await h.list() }); }
      if (write && op === 'upload') {
        let fit;
        try { fit = await readBody(req, MAX_FIT); } catch { return send(res, 413, { error: 'too large' }); }
        if (fit.length < 14 || fit.toString('latin1', 8, 12) !== '.FIT') return send(res, 400, { error: 'FIT file expected' });
        const num = k => (q.get(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
        const meta = { name: (q.get('name') || 'Just Watts ride').slice(0, 120), description: (q.get('description') || '').slice(0, 2000),
          start_ms: num('start'), duration_s: num('duration'), local_start: (q.get('local') || '').slice(0, 19) || null, filename: `${rid}.fit` };
        const services = q.get('services') ? q.get('services').split(',') : null;
        return send(res, 200, await h.upload(rid, fit, meta, services));
      }
      if (write && op === 'retry') return send(res, 200, await h.retry(rid || null, svc || null));
      return send(res, 404, { error: 'unknown op' });
    } catch (e) {
      if (!(e instanceof IntegrationError)) { log('integrations error: ' + String(e && e.message).slice(0, 200)); return send(res, 500, { error: 'server error' }); }
      const secrets = [...(svc && h.conns[svc] ? await h.secretsOf(svc) : []), ...(e.extraSecrets || [])];
      return send(res, e.kind === AUTH ? 401 : 502, { error: scrub(e.message, secrets).slice(0, 300), kind: e.kind });
    }
  };
}

module.exports = { makeHandler, sameOrigin, CRON_MAX };
