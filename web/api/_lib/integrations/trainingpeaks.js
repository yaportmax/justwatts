// TrainingPeaks through the web app's own API (unofficial). Twin of server/justwatts/integrations/trainingpeaks.py;
// sources for every endpoint are cited there and in docs/INTEGRATIONS.md.
'use strict';
const { AUTH, BLOCKED, TEMPORARY, DUPLICATE, IntegrationError, kindForStatus, retryAfter, call } = require('./base');
const P = require('./planned');

const API = 'https://tpapi.trainingpeaks.com';
const COOKIE = 'Production_tpAuth';
const BIKE = 2;
const HEADERS = { Accept: 'application/json', Origin: 'https://app.trainingpeaks.com', Referer: 'https://app.trainingpeaks.com/',
  'User-Agent': 'Mozilla/5.0 (compatible; JustWatts/0.1; +https://justwatts.com)' };
const EXPIRED = 'TrainingPeaks session expired: copy a fresh Production_tpAuth cookie and reconnect';

function cookieValue(raw) {
  raw = String(raw || '').trim().replace(/^"|"$/g, '');
  const m = new RegExp(COOKIE + '=([^;\\s]+)').exec(raw);
  const v = m ? m[1] : raw;
  return /^[A-Za-z0-9\-_.~%+/=]{20,4096}$/.test(v) ? v : '';
}

function trainingpeaks({ fetch, now = () => Date.now() / 1000 }) {
  async function mint(s) {
    const r = await call(fetch, `${API}/users/v3/token`, { method: 'GET', headers: { ...HEADERS, Cookie: `${COOKIE}=${s.cookie}` } });
    const tok = r.json && r.json.token;
    if (r.status === 401 || r.status === 403 || (r.status === 200 && (!r.json || r.json.success === false || !(tok && tok.access_token)))) throw new IntegrationError(AUTH, EXPIRED);
    if (r.status !== 200) throw new IntegrationError(r.status === 409 ? TEMPORARY : kindForStatus(r.status), `TrainingPeaks token request failed (${r.status})`, retryAfter(r.headers));
    return { ...s, access_token: tok.access_token, expires_at: now() + Number(tok.expires_in || 3600) };
  }
  async function token(us, force) {
    let s = await us.secret('trainingpeaks');
    if (!s || !s.cookie) throw new IntegrationError(AUTH, 'TrainingPeaks not connected');
    if (force || !s.access_token || (s.expires_at || 0) - 60 < now()) { s = await mint(s); await us.setSecret('trainingpeaks', s); }
    return s;
  }
  async function api(us, method, path, body) {
    let r;
    for (const attempt of [0, 1]) {
      const s = await token(us, attempt === 1);
      const h = { ...HEADERS, Authorization: `Bearer ${s.access_token}` };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      r = await call(fetch, API + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (r.status !== 401) break;
    }
    if (r.status < 300) return r;
    let kind = kindForStatus(r.status);
    if (r.status === 401) kind = AUTH;
    else if (r.status === 403 && !/html/.test(r.headers.get('content-type') || '')) kind = AUTH;
    if (/duplicate/i.test(r.text)) kind = DUPLICATE;
    throw new IntegrationError(kind, kind === AUTH ? EXPIRED : `TrainingPeaks said ${r.status}`, retryAfter(r.headers));
  }
  function athlete(body) {
    const u = (body && body.user) || {};
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
    const aths = (u.athletes || []).filter(a => a && typeof a === 'object');
    const match = aths.find(a => u.personId && a.athleteId === u.personId) || aths.find(a => u.email && a.email === u.email);
    const aid = u.personId || (match && match.athleteId) || u.userId;
    return [aid ? String(aid) : null, name];
  }
  const done = w => !!w.completed || (w.totalTime !== null && w.totalTime !== undefined);
  async function day(us, d) {
    const s = await token(us);
    const w = (await api(us, 'GET', `/fitness/v6/athletes/${s.athlete_id}/workouts/${d}/${d}`)).json;
    return Array.isArray(w) ? w.filter(x => x && typeof x === 'object') : [];
  }
  const url = wid => (wid ? `https://app.trainingpeaks.com/#calendar/workout/${wid}` : null);
  return {
    id: 'trainingpeaks', name: 'TrainingPeaks', official: false, plannedWorkouts: true,
    fields: [{ name: 'cookie', label: 'Production_tpAuth cookie', secret: true, help: 'Signed in at app.trainingpeaks.com: browser dev tools, Application, Cookies, Production_tpAuth' }],
    secrets: s => (s ? [s.cookie, s.access_token].filter(Boolean) : []),
    async status(us) { const s = await us.secret('trainingpeaks'); return { connected: !!(s && s.cookie), account: (s && s.name) || null, athlete_id: (s && s.athlete_id) || null }; },
    async connect(us, f) {
      const ck = cookieValue(f.cookie);
      if (!ck) throw new IntegrationError(AUTH, 'paste the Production_tpAuth cookie value from app.trainingpeaks.com');
      await us.setSecret('trainingpeaks', await mint({ cookie: ck }));
      const [aid, name] = athlete((await api(us, 'GET', '/users/v3/user')).json);
      if (!aid) { await us.setSecret('trainingpeaks', null); throw new IntegrationError(BLOCKED, 'TrainingPeaks did not return an athlete for this login'); }
      await us.setSecret('trainingpeaks', { ...(await us.secret('trainingpeaks')), athlete_id: aid, name: name.slice(0, 80) });
      return { connected: true, ...(await this.status(us)) };
    },
    async disconnect(us) { await us.setSecret('trainingpeaks', null); },
    async upload(us, fit, meta) {
      const s = await token(us);
      // the filedata endpoint does not report duplicates: look for a finished workout at the same start first
      if (meta.start_ms) {
        const local = meta.local_start || new Date(meta.start_ms).toISOString().slice(0, 19);  // page sends the rider's local time
        const dur = Number(meta.duration_s || 0);
        for (const w of await day(us, local.slice(0, 10))) {
          if (!done(w)) continue;
          const st = String(w.startTime || '');
          const sameStart = st && Math.abs(Date.parse(st.slice(0, 19) + 'Z') - Date.parse(local.slice(0, 19) + 'Z')) <= 120000;
          const sameLen = dur && w.totalTime != null && Math.abs(Number(w.totalTime) * 3600 - dur) <= 60;
          if (sameStart || (!st && sameLen)) return { duplicate: true, activity_id: w.workoutId || null, url: url(w.workoutId) };
        }
      }
      const res = (await api(us, 'POST', `/fitness/v6/athletes/${s.athlete_id}/workouts/filedata`,
        { workoutDay: null, data: Buffer.from(fit).toString('base64'), fileName: meta.filename || 'ride.fit', uploadClient: 'TP Web App' })).json;
      const first = Array.isArray(res) ? res[0] : res;
      const wid = (first && first.workoutId) || null;
      return { activity_id: wid, url: url(wid) };
    },
    async planned(us, d) {
      const out = [];
      for (const w of await day(us, d)) {
        if (w.workoutTypeValueId !== BIKE || done(w)) continue;
        const hours = w.totalTimePlanned;
        const text = P.fromTrainingPeaks(w.structure) || P.freeFor(hours ? hours * 3600 : null);
        if (!text) continue;
        out.push({ id: String(w.workoutId), name: String(w.title || 'Planned ride').slice(0, 120), date: String(w.workoutDay || d).slice(0, 10), text,
          duration_s: hours ? Math.round(hours * 3600) : null, description: String(w.description || '').slice(0, 2000), structured: !!w.structure, tss: w.tssPlanned ?? null });
      }
      return out;
    },
  };
}

module.exports = { trainingpeaks, cookieValue };
