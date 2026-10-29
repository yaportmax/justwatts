// intervals.icu, official API (athlete id + API key). Twin of server/justwatts/integrations/intervals.py.
// Docs: https://forum.intervals.icu/t/api-access-to-intervals-icu/609, spec https://intervals.icu/api/v1/docs.
// Import: GET /athlete/{id} (icu_weight, icu_resting_hr, sportSettings ftp/lthr/max_hr), GET /athlete/{id}/activities
// ?oldest=&newest= (one list for the range), GET /activity/{id}/fit-file (the FIT intervals.icu builds; may be gzipped).
'use strict';
const { AUTH, BLOCKED, TEMPORARY, IntegrationError, kindForStatus, retryAfter, call, multipart } = require('./base');
const P = require('./planned');
const I = require('./importing');

const BASE = 'https://intervals.icu/api/v1';
const UA = 'Mozilla/5.0 (compatible; JustWatts/0.1; +https://justwatts.com)';
const RIDE_TYPES = ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', null, undefined, ''];

function intervals({ fetch }) {
  async function api(method, path, key, body, headers = {}) {
    const auth = Buffer.from(`API_KEY:${key}`).toString('base64');
    const r = await call(fetch, BASE + path, { method, body, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'User-Agent': UA, ...headers } });
    if (r.status < 300) return r;
    let kind = kindForStatus(r.status);
    if (r.status === 403) kind = /html/.test(r.headers.get('content-type') || '') || r.text.trimStart().startsWith('<') ? BLOCKED : AUTH;
    const msg = { auth: 'intervals.icu refused the athlete id or API key', blocked: `intervals.icu refused the request (${r.status})`,
      temporary: `intervals.icu is busy or down (${r.status})` }[kind] || `intervals.icu said ${r.status}`;
    throw new IntegrationError(kind, msg, retryAfter(r.headers));
  }
  async function creds(us) {
    const s = await us.secret('intervals');
    if (!s || !s.api_key) throw new IntegrationError(AUTH, 'intervals.icu not connected');
    return s;
  }
  return {
    id: 'intervals', name: 'intervals.icu', plannedWorkouts: true, imports: true,
    fields: [{ name: 'athlete_id', label: 'Athlete ID', secret: false, help: 'Settings, Developer Settings, e.g. i12345' },
      { name: 'api_key', label: 'API key', secret: true, help: 'Settings, Developer Settings' }],
    secrets: s => (s && s.api_key ? [s.api_key, Buffer.from(`API_KEY:${s.api_key}`).toString('base64')] : []),
    async status(us) { const s = await us.secret('intervals'); return { connected: !!(s && s.api_key), account: (s && s.name) || null, athlete_id: (s && s.athlete_id) || null }; },
    async connect(us, f) {
      const aid = String(f.athlete_id || '').trim(), key = String(f.api_key || '').trim();
      if (!/^(i?\d{1,12}|0)$/.test(aid) || !/^[\w-]{8,128}$/.test(key)) throw new IntegrationError(AUTH, 'paste the athlete id (like i12345) and API key from intervals.icu Settings');
      const body = (await api('GET', `/athlete/${encodeURIComponent(aid)}`, key)).json || {};
      await us.setSecret('intervals', { athlete_id: String(body.id || aid), api_key: key, name: String(body.name || '').slice(0, 80) });
      return { connected: true, ...(await this.status(us)) };
    },
    async disconnect(us) { await us.setSecret('intervals', null); },
    async upload(us, fit, meta) {
      const s = await creds(us);
      const q = new URLSearchParams({ name: meta.name || 'Just Watts ride', description: meta.description || '', external_id: meta.ride_id });
      const mp = multipart({}, 'file', meta.filename || 'ride.fit', fit);
      const r = await api('POST', `/athlete/${encodeURIComponent(s.athlete_id)}/activities?${q}`, s.api_key, mp.body, { 'Content-Type': mp.type });
      const b = r.json, acts = b && !Array.isArray(b) ? b.activities : Array.isArray(b) ? b : null;
      const first = acts && acts.length ? acts[0] : (b && !Array.isArray(b) ? b : {});
      const id = (first || {}).id || null;
      return { activity_id: id, url: id ? `https://intervals.icu/activities/${id}` : null, duplicate: r.status === 200 };
    },
    async importProfile(us) {
      const s = await creds(us);
      let athlete;
      try { athlete = { ok: true, json: (await api('GET', `/athlete/${encodeURIComponent(s.athlete_id)}`, s.api_key)).json }; }
      catch (e) { if (e.kind === AUTH) throw e; athlete = { ok: false, error: e.message }; }
      return I.intervalsProfile({ athlete });
    },
    async importList(us, { since, until }) {
      const s = await creds(us);
      const q = new URLSearchParams({ oldest: since, newest: until });
      const raw = (await api('GET', `/athlete/${encodeURIComponent(s.athlete_id)}/activities?${q}`, s.api_key)).json;
      const all = Array.isArray(raw) ? raw : [], items = all.map(I.intervalsActivity).filter(Boolean);
      return { items, skipped: all.length - items.length, more: false, next: all.length };
    },
    async importFit(us, id) {
      if (!/^i?\d{1,20}$/.test(String(id))) throw new IntegrationError(BLOCKED, 'bad activity id');
      const s = await creds(us);
      const r = await api('GET', `/activity/${encodeURIComponent(id)}/fit-file`, s.api_key, undefined, { Accept: '*/*' });
      try { return I.fitFromZip(r.buf); } catch (e) { throw new IntegrationError(BLOCKED, `intervals.icu file: ${e.message}`); }
    },
    async planned(us, day) {
      const s = await creds(us);
      const q = new URLSearchParams({ oldest: day, newest: day, category: 'WORKOUT', resolve: 'true' });
      const evs = (await api('GET', `/athlete/${encodeURIComponent(s.athlete_id)}/events?${q}`, s.api_key)).json;
      const out = [];
      for (const ev of Array.isArray(evs) ? evs : []) {
        if (!ev || typeof ev !== 'object' || ![undefined, null, 'WORKOUT'].includes(ev.category) || !RIDE_TYPES.includes(ev.type)) continue;
        const doc = ev.workout_doc || {};
        const text = P.fromIntervals(ev.workout_doc) || P.freeFor(ev.moving_time);
        if (!text) continue;
        out.push({ id: String(ev.id), name: String(ev.name || 'Planned ride').slice(0, 120), date: String(ev.start_date_local || day).slice(0, 10), text,
          duration_s: doc.duration || ev.moving_time || null, description: String(ev.description || '').slice(0, 2000), structured: !!(doc.steps && doc.steps.length) });
      }
      return out;
    },
  };
}

module.exports = { intervals, TEMPORARY };
