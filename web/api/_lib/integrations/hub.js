// Web integrations hub: same rules as server/justwatts/integrations (__init__.py, jobs.py), per signed-in user.
// Serverless functions keep no worker, so retries run when the page calls retry() after next_retry_at, or when the
// cron (http.js op=cron) calls retryDue() for users flagged with state "retry" (set while a job is pending or running).
// Jobs live in the user's state ("jobs"), FIT files in the user's files.
'use strict';
const { AUTH, BLOCKED, TEMPORARY, DUPLICATE, ACTION, IntegrationError, MANUAL, describe, scrub } = require('./base');
const { garmin } = require('./garmin');
const { trainingpeaks } = require('./trainingpeaks');
const { intervals } = require('./intervals');
const { strava } = require('./strava');

const DELAYS = [120, 480], MAX_TRIES = DELAYS.length + 1, MAX_RETRY_AFTER = 1800;
const STUCK_S = 600, GIVE_UP_S = 86400;  // a 'running' job this old died mid-upload; a job still pending after a day gives up
const ORDER = ['garmin', 'strava', 'trainingpeaks', 'intervals', 'coros', 'polar', 'suunto', 'wahoo'];
const MANUAL_ONLY = { strava: 'Strava', coros: 'COROS', polar: 'Polar', suunto: 'Suunto', wahoo: 'Wahoo' };
const GARMIN_REASON = 'Uploads here can sync on to apps you link in Garmin Connect.';
const SYNC_OPTIONS = ['strava', 'trainingpeaks', 'intervals', 'other'];
const SYNC_QUESTION = { id: 'garmin_syncs', text: 'Does your Garmin account already send rides to:',
  options: [{ id: 'strava', label: 'Strava' }, { id: 'trainingpeaks', label: 'TrainingPeaks' }, { id: 'other', label: 'other' }] };
const FIT_LABEL = 'upload the .fit file manually';
const RIDE_RE = /^[\w-]{1,80}$/;
const IMPORTED_RE = /^imp-/;  // rides brought in by an import never go back out

function hub({ fetch, store, now = () => Date.now() / 1000, sleep, log = () => {}, env = process.env, key = null, fitUrl = rid => `/api/integrations?op=fit&ride=${encodeURIComponent(rid)}` }) {
  const conns = {};
  const st = strava({ fetch, now, sleep, env, key });  // Strava: OAuth on this server when its app is set up, else by hand
  for (const c of [garmin({ fetch, now, sleep }), trainingpeaks({ fetch, now }), intervals({ fetch }), ...(st.configured() ? [st] : [])]) conns[c.id] = c;
  for (const [id, name] of Object.entries(MANUAL_ONLY)) if (!conns[id]) conns[id] = { id, name, uploads: false, connectKind: null, manualOnly: true,
    secrets: () => [], async status() { return { connected: false, manual_only: true }; }, async disconnect() {} };
  const ids = ORDER.filter(id => conns[id]);
  const importer = svc => { const c = get(svc); if (!c.imports) throw new IntegrationError(BLOCKED, `${c.name} has no import`); return c; };
  const get = svc => { if (!conns[svc]) throw new IntegrationError(BLOCKED, 'no such integration'); return conns[svc]; };

  const state = async () => (await store.state('integrations')) || {};
  async function patch(svc, kw) { const s = await state(); s[svc] = { ...(s[svc] || {}), ...kw }; await store.setState('integrations', s); }
  const jobs = async () => (await store.state('jobs')) || {};
  async function saveJobs(j) {
    await store.setState('jobs', j);
    const open = Object.values(j).filter(x => x.state === 'pending' || x.state === 'running');
    await store.setState('retry', open.length ? { at: Math.min(...open.map(x => x.next_at || 0)) } : null);  // the cron's index
  }
  async function connected(svc) { try { return !!(await conns[svc].status(store)).connected; } catch { return false; } }
  async function secretsOf(svc) { try { return conns[svc].secrets(await store.secret(svc)); } catch { return []; } }
  function syncsTo(s) { const v = s.garmin && s.garmin.syncs_to; return Array.isArray(v) ? v.filter(x => SYNC_OPTIONS.includes(x)) : null; }
  async function auto(svc, s, garminOn) {
    if (conns[svc].uploads === false) return false;
    const v = s[svc] && s[svc].auto;
    if (v !== undefined && v !== null) return !!v;
    return !(garminOn && (syncsTo(s) || []).includes(svc));
  }
  const fallback = (svc, rid) => ({ ride_id: rid, fit_url: fitUrl(rid), label: FIT_LABEL, manual: MANUAL[svc] || null });
  function pub(j, rid) {
    if (!j) return null;
    const failing = j.state === 'failed' || (j.state === 'pending' && j.kind);
    return { service: j.service, state: j.state, kind: j.kind, error: j.error, tries: j.tries, max_tries: MAX_TRIES,
      activity_id: j.activity_id || null, url: j.url || null, duplicate: !!j.duplicate,
      next_retry_at: j.state === 'pending' && j.tries ? Math.round(j.next_at * 1000) : null, updated_at: Math.round((j.updated || 0) * 1000),
      action: failing ? ACTION[j.kind] || null : null, ...(failing ? { fallback: fallback(j.service, rid) } : {}) };
  }

  async function attempt(all, key) {
    const j = all[key], c = conns[j.service];
    j.tries += 1; j.state = 'running'; j.updated = now();
    await saveJobs(all);
    let res = null, err = null;
    try {
      const fit = await store.file(`fit:${j.ride_id}`);
      if (!fit) throw new IntegrationError(BLOCKED, 'the .fit file for this ride is gone; upload it again');
      res = (await c.upload(store, fit, j.meta || { ride_id: j.ride_id })) || {};
    } catch (e) { err = e instanceof IntegrationError ? e : new IntegrationError(TEMPORARY, `${e && e.name}: ${e && e.message}`); }
    if (err && err.kind === DUPLICATE) { res = { duplicate: true }; err = null; }
    const t = now();
    if (!err) {
      Object.assign(j, { state: 'done', kind: res.duplicate ? DUPLICATE : null, error: null, next_at: null, activity_id: res.activity_id || null,
        url: res.url || null, duplicate: !!res.duplicate, updated: t });
      await patch(j.service, { last_success: { ride_id: j.ride_id, at: Math.round(t * 1000) }, last_error: null });
    } else {
      const msg = scrub(err.message, await secretsOf(j.service)).slice(0, 300);
      const again = err.kind === TEMPORARY && j.tries < MAX_TRIES;
      let wait = again ? DELAYS[Math.min(j.tries, DELAYS.length) - 1] : 0;
      if (again && err.retryAfter) wait = Math.max(wait, Math.min(err.retryAfter, MAX_RETRY_AFTER));
      Object.assign(j, { state: again ? 'pending' : 'failed', kind: err.kind, error: msg, next_at: again ? t + wait : null, updated: t });
      await patch(j.service, { last_error: { ride_id: j.ride_id, kind: err.kind, error: msg, at: Math.round(t * 1000), final: !again } });
    }
    await saveJobs(all);
    return j;
  }

  async function queueAndRun(rid, svcs, restart) {
    const all = await jobs(), t = now();
    for (const svc of svcs) {
      const k = `${rid}:${svc}`, old = all[k];
      if (old && !restart && ['pending', 'done', 'failed', 'running'].includes(old.state)) continue;
      const meta = (old && old.meta) || ((await store.state(`meta:${rid}`)) || { ride_id: rid });
      all[k] = { ride_id: rid, service: svc, state: 'pending', tries: 0, next_at: t, kind: null, error: null, meta, created: (old && old.created) || t, updated: t };
    }
    await saveJobs(all);
    for (const svc of svcs) { const k = `${rid}:${svc}`; if (all[k].state === 'pending' && all[k].next_at <= t) await attempt(all, k); }
    return all;
  }

  const api = {
    async list() {
      const s = await state(), garminOn = await connected('garmin'), syncs = syncsTo(s), out = [];
      for (const id of ids) {
        const c = conns[id], d = describe(c);
        let st; try { st = await c.status(store); } catch (e) { st = { connected: false, error: String(e.message).slice(0, 200) }; }
        const x = s[id] || {}, a = await auto(id, s, garminOn);
        Object.assign(d, { status: st, auto: a, last_success: x.last_success || null, last_error: x.last_error || null,
          needs_reconnect: !!(x.last_error && x.last_error.kind === AUTH), recommended: id === 'garmin' });
        if (c.manualOnly) d.caps.manual_only = true;
        if (id === 'garmin') {
          const names = (syncs || []).filter(k => conns[k]).map(k => conns[k].name);
          d.recommended_reason = names.length ? `Garmin also sends your rides to ${names.join(' and ')}.` : GARMIN_REASON;
          d.syncs_to = syncs; d.syncs_question = garminOn && syncs === null ? SYNC_QUESTION : null;
        }
        if (SYNC_OPTIONS.includes(id)) {
          const synced = garminOn && (syncs || []).includes(id);
          d.synced_by_garmin = synced; d.duplicate_risk = !!(synced && st.connected && a);
          d.duplicate_warning = synced ? `Garmin already syncs to ${c.name}. Uploading to both makes duplicates.` : null;
        }
        out.push(d);
      }
      return out;
    },
    async connect(svc, fields, rideId) {
      const c = get(svc);
      if (c.manualOnly) throw new IntegrationError(BLOCKED, `${c.name} has no automatic upload yet`);
      const res = { ...(await c.connect(store, fields || {})) };
      if (res.connected) {
        await patch(svc, { last_error: null });
        if (svc === 'garmin') { const syncs = syncsTo(await state()); res.syncs_to = syncs; if (syncs === null) res.question = SYNC_QUESTION; }
        if (rideId && await store.file(`fit:${rideId}`)) res.upload = pub((await queueAndRun(rideId, [svc], true))[`${rideId}:${svc}`], rideId);
        else if (rideId) res.upload_needed = true;  // no FIT stored for that ride yet: the page posts op=upload next
      } else if (rideId) res.ride_id = rideId;
      return res;
    },
    async disconnect(svc) { await get(svc).disconnect(store); await patch(svc, { last_error: null }); },
    async setAuto(svc, on) { get(svc); await patch(svc, { auto: !!on }); },
    async setSyncs(list) {
      if (!Array.isArray(list)) throw new IntegrationError(BLOCKED, 'syncs_to must be a list');
      await patch('garmin', { syncs_to: [...new Set(list.map(String).filter(x => SYNC_OPTIONS.includes(x)))].sort() });
    },
    // The page posts the FIT after a ride is saved; it is kept for retries and the fallback link.
    async upload(rid, fit, meta, services) {
      if (!RIDE_RE.test(rid)) throw new IntegrationError(BLOCKED, 'bad ride id');
      if (IMPORTED_RE.test(rid)) throw new IntegrationError(BLOCKED, 'imported rides are not uploaded');
      await store.putFile(`fit:${rid}`, fit);
      await store.setState(`meta:${rid}`, { ...meta, ride_id: rid });
      const s = await state(), garminOn = await connected('garmin'), svcs = [];
      for (const id of ids) {
        if (conns[id].uploads === false || !(await connected(id))) continue;
        if (services ? services.includes(id) : await auto(id, s, garminOn)) svcs.push(id);
      }
      await queueAndRun(rid, svcs, !!services);
      return api.targets(rid);
    },
    async retry(rid, svc) {
      const all = await jobs(), t = now();
      if (svc) { get(svc); await queueAndRun(rid, [svc], true); return api.targets(rid); }
      for (const k of Object.keys(all)) if (all[k].state === 'pending' && all[k].next_at <= t && (!rid || all[k].ride_id === rid)) await attempt(all, k);
      return rid ? api.targets(rid) : { ok: true };
    },
    // the cron: at most `max` due uploads for this user while more() holds; stuck and day-old jobs give up
    async retryDue(max = 3, more = () => true) {
      const all = await jobs(), t = now();
      let changed = false, tried = 0;
      const giveUp = async (j, msg) => {
        Object.assign(j, { state: 'failed', kind: TEMPORARY, error: msg, next_at: null, updated: t }); changed = true;
        await patch(j.service, { last_error: { ride_id: j.ride_id, kind: TEMPORARY, error: msg, at: Math.round(t * 1000), final: true } });
      };
      for (const j of Object.values(all)) {
        if (j.state === 'running' && t - (j.updated || 0) > STUCK_S) {
          if (j.tries >= MAX_TRIES) await giveUp(j, 'upload stopped part way; gave up');
          else { Object.assign(j, { state: 'pending', next_at: t, updated: t }); changed = true; }
        }
        if (j.state === 'pending' && t - (j.created || j.updated || t) > GIVE_UP_S) await giveUp(j, 'not uploaded within a day; gave up');
      }
      if (changed) await saveJobs(all);
      for (const k of Object.keys(all)) {
        if (tried >= max || !more()) break;
        if (all[k].state === 'pending' && all[k].next_at <= t) { await attempt(all, k); tried++; }
      }
      return { tried };
    },
    async targets(rid) {
      const all = await jobs(), rows = [];
      for (const d of await api.list()) {
        if (!d.caps.upload && !d.manual) continue;
        rows.push({ id: d.id, name: d.name, official: d.official, unofficial_note: d.unofficial_note || null, connected: !!d.status.connected,
          auto: d.auto, manual_only: !d.caps.upload, recommended: d.recommended, recommended_reason: d.recommended_reason || null,
          needs_reconnect: d.needs_reconnect, duplicate_risk: !!d.duplicate_risk, duplicate_warning: d.duplicate_warning || null,
          connect: d.connect, manual: d.manual, upload: pub(all[`${rid}:${d.id}`], rid) });
      }
      return { ride_id: rid, fit_url: fitUrl(rid), fit_label: FIT_LABEL, has_fit: !!(await store.file(`fit:${rid}`)),
        any_connected: rows.some(r => r.connected), targets: rows };
    },
    async planned(day) {
      const workouts = [], errors = {};
      for (const id of ids) {
        const c = conns[id];
        if (!c.plannedWorkouts || !(await connected(id))) continue;
        try { for (const w of await c.planned(store, day)) workouts.push({ ...w, source: id }); }
        catch (e) {
          const kind = e instanceof IntegrationError ? e.kind : TEMPORARY;
          errors[id] = { kind, error: scrub(String(e.message), await secretsOf(id)).slice(0, 200), action: ACTION[kind] || null };
        }
      }
      return { date: day, workouts, errors };
    },
    fit: rid => (RIDE_RE.test(rid) ? store.file(`fit:${rid}`) : null),
    stravaStart: uid => { if (!conns.strava || conns.strava.manualOnly) throw new IntegrationError(BLOCKED, 'Strava is not set up on this server'); return conns.strava.authorizeUrl(uid); },
    async stravaCallback(uid, q) {
      if (!conns.strava || conns.strava.manualOnly) throw new IntegrationError(BLOCKED, 'Strava is not set up on this server');
      const res = await conns.strava.callback(store, uid, q);
      await patch('strava', { last_error: null });
      return res;
    },
    // import: profile values (each piece optional), a page of past rides, one ride's FIT. Logs field names only.
    async importProfile(svc) {
      const c = importer(svc);
      const res = await c.importProfile(store);
      if (res.missing.length || Object.keys(res.errors).length) {
        log(`import ${svc} profile: missing [${res.missing.join(', ')}]; failed [${Object.entries(res.errors).map(([k, e]) => `${k}: ${scrub(e, []).replace(/\d{6,}/g, '#').slice(0, 60)}`).join('; ')}]`);
      }
      return { service: svc, ...res };
    },
    async importList(svc, opts) {
      const res = await importer(svc).importList(store, opts);
      if (res.skipped) log(`import ${svc} list: ${res.skipped} entries not read as rides`);
      return { service: svc, ...res };
    },
    async importFit(svc, id) {
      try { return await importer(svc).importFit(store, id); }
      catch (e) { log(`import ${svc} fit: ${e.kind || 'error'} ${String(e.message).replace(/\d{6,}/g, '#').slice(0, 80)}`); throw e; }
    },
    secretsOf, conns,
  };
  return api;
}

module.exports = { hub, DELAYS, MAX_TRIES, SYNC_QUESTION, STUCK_S, GIVE_UP_S };
