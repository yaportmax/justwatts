// Strava, official API (https://developers.strava.com/docs/reference/). Twin in spirit of server/justwatts/strava.py.
// The sign-in (web/api/_lib/auth.js) asks only for "read" and keeps no tokens, so connecting here is its own OAuth
// with the scopes uploads and imports need:
//   GET  /api/integrations?op=strava_start      -> www.strava.com/oauth/authorize (scope read,activity:write,
//        activity:read_all,profile:read_all), state = sealed { user, expiry }
//   GET  /api/integrations?op=strava_callback   -> POST www.strava.com/oauth/token (code), tokens sealed per user
//   refresh: same token URL, grant_type=refresh_token, 5 min before expires_at
//   upload: POST /api/v3/uploads (multipart file, data_type=fit, external_id), then GET /api/v3/uploads/{id} until
//           activity_id or error; "duplicate of activity 123" = duplicate
//   import: GET /api/v3/athlete (weight kg, ftp), GET /api/v3/athlete/zones (HR zones), GET /api/v3/athlete/activities
//           ?after&before&page&per_page, per ride GET /api/v3/activities/{id} (description, trainer, device_name, gear)
//           and /activities/{id}/streams?keys=...&key_by_type=true (Strava has no original-file download)
//   rate limits: 100 reads / 15 min and 1000 / day per app (X-ReadRateLimit-*, else X-RateLimit-* "15min,day").
//           Near a limit the answer carries `wait` (seconds): the page waits for the next window, or pauses to the
//           daily reset (midnight UTC). A 429 is temporary with the same wait.
// The app is capped at 10 athletes until Strava lifts it (STRAVA_CAPPED): the token call then answers
// "Limit of connected athletes exceeded", and the page shows the manual upload instead.
'use strict';
const { AUTH, BLOCKED, TEMPORARY, IntegrationError, kindForStatus, retryAfter, call, multipart, realSleep } = require('./base');
const { seal, open } = require('./crypto');
const I = require('./importing');

const WWW = 'https://www.strava.com', API = `${WWW}/api/v3`;
const SCOPE = 'read,activity:write,activity:read_all,profile:read_all';
const PER_PAGE = 100, POLLS = 4, POLL_MS = 1500;
const STREAMS = 'time,watts,heartrate,cadence,velocity_smooth,distance,latlng,altitude,grade_smooth,temp';
const RIDES = /^(Ride|VirtualRide|EBikeRide|GravelRide|MountainBikeRide|EMountainBikeRide)$/;
const MARGIN = 3;  // stop this many requests short of a limit

// seconds to the next 15-minute window (Strava's short rate limit) when it answers 429 without Retry-After
const toWindow = now => 900 - (Math.floor(now) % 900) + 5;
const toMidnight = now => 86400 - (Math.floor(now) % 86400) + 30;
// seconds to wait before the next read, from the rate headers (0 = go on)
function rateWait(h, now, hit = false) {
  const pair = n => String((h && h.get && h.get(n)) || '').split(',').map(Number);
  let [l15, lday] = pair('x-readratelimit-limit'), [u15, uday] = pair('x-readratelimit-usage');
  if (!(l15 > 0)) { [l15, lday] = pair('x-ratelimit-limit'); [u15, uday] = pair('x-ratelimit-usage'); }
  if (lday > 0 && uday >= lday - MARGIN) return toMidnight(now);
  if (l15 > 0 && u15 >= l15 - MARGIN) return toWindow(now);
  return hit ? toWindow(now) : 0;
}

function strava({ fetch, now = () => Date.now() / 1000, sleep = realSleep, env = process.env, key = null }) {
  const cfg = () => ({ id: env.STRAVA_CLIENT_ID, secret: env.STRAVA_CLIENT_SECRET, origin: String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '') });
  const configured = () => { const c = cfg(); return !!(c.id && c.secret && c.origin && key); };
  const redirect = () => `${cfg().origin}/api/integrations?op=strava_callback`;

  async function tokenCall(form) {
    const c = cfg();
    const r = await call(fetch, `${WWW}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...form }).toString() });
    if (r.status === 200 && r.json && r.json.access_token) return r.json;
    if (/limit/i.test(r.text || '') && r.status < 500) throw new IntegrationError(BLOCKED, 'strava_capped');
    if (r.status === 429 || r.status >= 500) throw new IntegrationError(TEMPORARY, `Strava is busy (${r.status})`, retryAfter(r.headers));
    throw new IntegrationError(AUTH, 'Strava sign-in expired; connect Strava again');
  }
  const keep = (j, old = {}) => ({ access_token: j.access_token, refresh_token: j.refresh_token || old.refresh_token, expires_at: Number(j.expires_at) || now() + 3600,
    athlete_id: (j.athlete && j.athlete.id) || old.athlete_id || null, name: (j.athlete && String(j.athlete.firstname || '').slice(0, 40)) || old.name || null, scope: old.scope || null });
  async function token(us, force) {
    const s = await us.secret('strava');
    if (!s || !s.refresh_token) throw new IntegrationError(AUTH, 'Strava not connected');
    if (!force && s.access_token && s.expires_at - 300 > now()) return s;
    const t = { ...keep(await tokenCall({ grant_type: 'refresh_token', refresh_token: s.refresh_token }), s), scope: s.scope };
    await us.setSecret('strava', t);
    return t;
  }
  let lastWait = 0;
  async function api(us, method, path, opt = {}) {
    let r;
    for (const attempt of [0, 1]) {
      const s = await token(us, attempt === 1);
      r = await call(fetch, API + path, { method, ...opt, headers: { Accept: 'application/json', ...(opt.headers || {}), Authorization: `Bearer ${s.access_token}` } });
      if (r.status !== 401) break;
    }
    lastWait = rateWait(r.headers, now());
    if (r.status < 300) return r;
    if (r.status === 401) throw new IntegrationError(AUTH, 'Strava sign-in expired; connect Strava again');
    if (r.status === 429) throw new IntegrationError(TEMPORARY, 'Strava rate limit', retryAfter(r.headers) || rateWait(r.headers, now(), true));
    throw new IntegrationError(kindForStatus(r.status), `Strava said ${r.status}`, retryAfter(r.headers));
  }

  return {
    id: 'strava', name: 'Strava', imports: true, connectKind: 'oauth', connectUrl: '/api/integrations?op=strava_start', configured,
    fields: [],
    secrets: s => (s ? [s.access_token, s.refresh_token].filter(Boolean) : []),
    // capped: only once the app's athlete limit is hit (STRAVA_CAPPED=1); until then anyone can connect, and a refused
    // connect answers strava_capped on its own. Connected riders keep working either way
    async status(us) { const s = await us.secret('strava'); return { connected: !!(s && s.refresh_token), configured: configured(), capped: env.STRAVA_CAPPED === '1', account: (s && s.name) || null }; },
    async connect() { throw new IntegrationError(BLOCKED, 'connect Strava from Settings'); },
    async disconnect(us) {
      const s = await us.secret('strava');
      if (s && s.access_token) { try { await call(fetch, `${WWW}/oauth/deauthorize`, { method: 'POST', headers: { Authorization: `Bearer ${s.access_token}` } }); } catch {} }
      await us.setSecret('strava', null);
    },
    // OAuth: the state is sealed with the integrations key and bound to the signed-in user, 10 minutes
    authorizeUrl(uid) {
      if (!configured()) throw new IntegrationError(BLOCKED, 'Strava is not set up on this server');
      const state = seal(key, { u: uid, e: now() + 600 }, `strava-state:${uid}`);  // base64url parts: URL-safe
      return `${WWW}/oauth/authorize?` + new URLSearchParams({ client_id: cfg().id, redirect_uri: redirect(), response_type: 'code', approval_prompt: 'auto', scope: SCOPE, state });
    },
    async callback(us, uid, { code, state, scope, error }) {
      let st = null;
      try { st = open(key, String(state || ''), `strava-state:${uid}`); } catch { st = null; }
      if (!st || st.u !== uid || !(st.e > now())) throw new IntegrationError(AUTH, 'bad_state');
      if (error || !/^[\w-]{4,200}$/.test(String(code || ''))) throw new IntegrationError(AUTH, 'denied');
      const granted = String(scope || '').split(',');
      const t = keep(await tokenCall({ code, grant_type: 'authorization_code' }));
      t.scope = granted.filter(Boolean).join(',');
      await us.setSecret('strava', t);
      return { connected: true, upload: granted.includes('activity:write'), read_all: granted.includes('activity:read_all') };
    },
    async upload(us, fit, meta) {
      const mp = multipart({ data_type: 'fit', name: meta.name || 'Just Watts ride', description: meta.description || '', external_id: `${meta.ride_id}.fit` }, 'file', meta.filename || 'ride.fit', fit);
      let r;
      try { r = await api(us, 'POST', '/uploads', { body: mp.body, headers: { 'Content-Type': mp.type } }); }
      catch (e) { if (e.kind === BLOCKED && /40[03]/.test(e.message)) throw new IntegrationError(AUTH, 'Strava needs upload permission; connect Strava again'); throw e; }
      let u = r.json || {};
      for (let i = 0; i < POLLS && !u.activity_id && !u.error && u.id; i++) {
        await sleep(POLL_MS);
        u = (await api(us, 'GET', `/uploads/${u.id_str || u.id}`)).json || u;
      }
      if (u.error) {
        const dup = /duplicate of(?:.*?activities\/|\s+activity\s+)?(\d+)/i.exec(u.error);
        if (/duplicate/i.test(u.error)) return { duplicate: true, activity_id: dup ? dup[1] : null, url: dup ? `${WWW}/activities/${dup[1]}` : null };
        throw new IntegrationError(BLOCKED, 'Strava could not read the file: ' + String(u.error).slice(0, 150));
      }
      const id = u.activity_id || null;  // still processing after the polls: Strava finishes it on its own
      return { activity_id: id, url: id ? `${WWW}/activities/${id}` : null };
    },
    // weight and FTP from the athlete, HR zones from /athlete/zones (5 zones, min..max; Z1 starts at 0, so its floor
    // is put at 80% of Z2's). Sex, bikes and shoes have no use in Just Watts. Each piece is optional.
    async importProfile(us) {
      const pieces = {};
      for (const [k, path] of [['athlete', '/athlete'], ['zones', '/athlete/zones']]) {
        try { pieces[k] = { ok: true, json: (await api(us, 'GET', path)).json }; }
        catch (e) { if (e.kind === AUTH) throw e; pieces[k] = { ok: false, error: e.message }; }
      }
      return I.stravaProfile(pieces);
    },
    async importList(us, { since, until, start = 0 }) {
      const after = Math.floor(Date.parse(since + 'T00:00:00Z') / 1000), before = Math.floor(Date.parse(until + 'T23:59:59Z') / 1000);
      const q = new URLSearchParams({ after: String(after), before: String(before), page: String(start + 1), per_page: String(PER_PAGE) });
      const raw = (await api(us, 'GET', `/athlete/activities?${q}`)).json;
      const all = Array.isArray(raw) ? raw : [], items = [];
      for (const a of all) {
        const type = String((a && (a.sport_type || a.type)) || '');
        if (!a || a.id == null || !RIDES.test(type) || !Date.parse(a.start_date)) continue;
        items.push({ id: String(a.id), name: String(a.name || 'Ride').slice(0, 120), start_ms: Date.parse(a.start_date), duration_s: Math.round(Number(a.elapsed_time) || 0),
          distance_m: Math.round(Number(a.distance) || 0), type, indoor: type === 'VirtualRide' || a.trainer === true, power: !!a.device_watts });
      }
      return { items, skipped: all.length - items.length, more: all.length >= PER_PAGE, next: start + 1, wait: lastWait };
    },
    // the ride as JSON: { kind: 'streams', start_ms, meta: { name, description, trainer, device, gear }, streams: { key: [..] } };
    // `wait` on the buffer: seconds the page should rest before the next one (rate limit)
    async importFit(us, id) {
      if (!/^\d{1,20}$/.test(String(id))) throw new IntegrationError(BLOCKED, 'bad activity id');
      const act = (await api(us, 'GET', `/activities/${id}?include_all_efforts=false`)).json || {};
      const st = (await api(us, 'GET', `/activities/${id}/streams?keys=${STREAMS}&key_by_type=true`)).json || {};
      const streams = {};
      for (const [k, v] of Object.entries(Array.isArray(st) ? Object.fromEntries(st.filter(x => x && x.type).map(x => [x.type, x])) : st)) if (v && Array.isArray(v.data)) streams[k] = v.data;
      if (!streams.time) throw new IntegrationError(BLOCKED, 'Strava streams: no time');
      const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
      const meta = { name: str(act.name, 120), description: str(act.description, 2000), trainer: act.trainer === true, device: str(act.device_name, 80),
        gear: str(act.gear && act.gear.name, 80), sport: str(act.sport_type || act.type, 40) };
      const buf = Buffer.from(JSON.stringify({ kind: 'streams', start_ms: Date.parse(act.start_date) || null, meta, streams }));
      buf.wait = lastWait;
      return buf;
    },
  };
}

module.exports = { strava, SCOPE };
