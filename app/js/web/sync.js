// Account sync for the web build: custom workouts, imported courses, settings and finished rides, through
// /api/sync (last write wins per record, tombstones for deletes). No DOM: app.js hands in a `local` adapter.
//   local.list(kind) -> [{ id, data, updatedAt }]           kind: workout | course | settings
//   local.put(kind, id, data, updatedAt), local.remove(kind, id)
//   local.rides() -> [{ id, updatedAt }]  (archived rides only), local.getRide(id), local.putRide(ride), local.removeRide(id)
//   local.rideActive() -> true while a ride is loaded: settings from the server wait until it ends
//   local.activeRideId() -> the ride in progress (never uploaded)
// State (rev, what the server has, rides still to download) lives in `storage` under one key per browser.
const KINDS = ['workout', 'course', 'settings'];
const PUSH_MAX = 200, PUSH_BYTES = 2.5 * 1024 * 1024, RIDE_UPLOADS = 20, RIDE_DOWNLOADS = 3;
const IDLE_MS = 120000, MAX_BACKOFF = 300000;

export class SyncError extends Error {
  constructor(status, code, extra = {}) { super(code || String(status)); this.status = status; this.code = code; this.extra = extra; }
}

export async function gzip(text) {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

const blank = uid => ({ uid, rev: 0, base: {}, rides: {}, want: {}, pending: null, at: 0 });

export function createSync({ fetch = (...a) => globalThis.fetch(...a), local, storage, key = 'hw.sync', now = () => Date.now(), onState = () => {}, onSignedOut = () => {},
  onRides = () => {}, timers = { set: (f, ms) => setTimeout(f, ms), clear: h => clearTimeout(h) }, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  let st = null, running = null, again = false, timer = null, fails = 0, status = 'off', lastError = null, stopped = true;
  const save = () => storage.set(key, st);
  const set = (s, err = null) => { status = s; lastError = err; onState({ status: s, at: st?.at || 0, error: err }); };

  async function req(method, path, body, raw) {
    const h = method === 'GET' ? {} : { 'X-HW': '1', 'Content-Type': raw ? 'application/gzip' : 'application/json' };
    let r;
    try { r = await fetch(path, { method, credentials: 'same-origin', headers: h, body: method === 'GET' ? undefined : raw || JSON.stringify(body ?? {}) }); }
    catch { throw new SyncError(0, 'offline'); }
    if (r.status === 401) { throw new SyncError(401, 'signed_out'); }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new SyncError(r.status, j.error || 'http_' + r.status, j); }
    return r;
  }
  const json = async (...a) => (await req(...a)).json();

  /* ---------- pull: changes since rev, applied unless the local copy is newer ---------- */
  async function pull() {
    for (let guard = 0; guard < 200; guard++) {
      const c = await json('GET', `/api/sync/changes?since=${st.rev}&limit=500`);
      const have = new Map(KINDS.map(k => [k, new Map(local.list(k).map(x => [x.id, x]))]));
      for (const r of c.records || []) {
        if (!KINDS.includes(r.kind)) continue;
        const k = r.kind + ':' + r.id, cur = have.get(r.kind).get(r.id), base = st.base[k];
        if (cur && !r.deleted && cur.updatedAt === r.updatedAt) { st.base[k] = r.updatedAt; continue; }  // the same version (often our own push)
        const dirty = cur && (base == null || cur.updatedAt > base);
        if (dirty && cur.updatedAt >= r.updatedAt && !(cur.updatedAt === r.updatedAt && r.deleted)) continue;  // ours is newer: the push sends it
        if (r.deleted) { if (cur) local.remove(r.kind, r.id); delete st.base[k]; continue; }
        if (r.kind === 'settings' && local.rideActive()) { st.pending = { id: r.id, data: r.data, updatedAt: r.updatedAt }; st.base[k] = r.updatedAt; continue; }
        local.put(r.kind, r.id, r.data, r.updatedAt); st.base[k] = r.updatedAt;
      }
      let got = false;
      for (const h of c.rides || []) {
        if (h.deleted) {
          if (st.rides[h.id] != null) { await local.removeRide(h.id); delete st.rides[h.id]; got = true; }
          delete st.want[h.id]; continue;
        }
        if (st.rides[h.id] >= h.updatedAt) continue;
        if (await local.getRide(h.id)) { st.rides[h.id] = h.updatedAt; continue; }  // same id, same ride: already here
        st.want[h.id] = h.updatedAt;
      }
      st.rev = c.rev; save();
      if (got) onRides();
      if (!c.more) return;
    }
  }

  /* ---------- push: records newer than what the server had, tombstones for local deletes ---------- */
  async function pushRecords() {
    const out = [], seen = new Set();
    for (const kind of KINDS) for (const x of local.list(kind)) {
      const k = kind + ':' + x.id; seen.add(k);
      if (st.base[k] == null || x.updatedAt > st.base[k]) out.push({ kind, id: x.id, data: x.data, updatedAt: x.updatedAt });
    }
    const t = now();
    for (const k of Object.keys(st.base)) if (!seen.has(k)) { const i = k.indexOf(':'); if (k.slice(0, i) !== 'settings') out.push({ kind: k.slice(0, i), id: k.slice(i + 1), deleted: true, updatedAt: t }); }
    let refetch = false;
    for (let i = 0; i < out.length;) {
      const batch = []; let bytes = 0;
      while (i < out.length && batch.length < PUSH_MAX) {
        const n = JSON.stringify(out[i]).length;
        if (batch.length && bytes + n > PUSH_BYTES) break;
        batch.push(out[i++]); bytes += n;
      }
      const j = await json('POST', '/api/sync/push', { records: batch });
      j.results.forEach((res, n) => {
        const r = batch[n], k = r.kind + ':' + r.id;
        if (r.deleted) delete st.base[k]; else st.base[k] = r.updatedAt;
        if (!res.applied) refetch = true;  // the server has a newer copy: pull everything again to get it
      });
      save();
    }
    if (refetch) { st.rev = 0; save(); }
    return out.length;
  }

  /* ---------- rides: upload finished rides (gzip), delete removed ones, download new ones lazily ---------- */
  async function pushRides() {
    const list = await local.rides(), active = local.activeRideId(), here = new Set(list.map(r => r.id));
    let n = 0;
    for (const r of list) {
      if (r.id === active || st.rides[r.id] != null || st.want[r.id] != null) continue;
      if (n++ >= RIDE_UPLOADS) { again = true; break; }
      const ride = await local.getRide(r.id); if (!ride?.samples?.length) continue;
      try { await req('PUT', `/api/sync/rides/${encodeURIComponent(r.id)}?updatedAt=${r.updatedAt}`, null, await gzip(JSON.stringify(ride))); }
      catch (e) { if (e.status === 413 || e.status === 400) { st.rides[r.id] = -1; save(); continue; } throw e; }  // too big or refused: skip it, keep going
      st.rides[r.id] = r.updatedAt; save();
    }
    for (const id of Object.keys(st.rides)) if (!here.has(id) && id !== active) {
      await json('DELETE', `/api/sync/rides/${encodeURIComponent(id)}`, { updatedAt: now() });
      delete st.rides[id]; save();
    }
  }
  async function pullRides() {
    let n = 0, got = false;
    for (const [id, at] of Object.entries(st.want)) {
      if (n++ >= RIDE_DOWNLOADS) { again = true; break; }
      let ride = null;
      try { ride = JSON.parse(await gunzip(new Uint8Array(await (await req('GET', `/api/sync/rides/${encodeURIComponent(id)}`)).arrayBuffer()))); }
      catch (e) { if (e.status !== 404 && !(e instanceof SyntaxError)) throw e; }
      if (ride?.samples?.length) { await local.putRide({ ...ride, id }); st.rides[id] = at; got = true; }
      delete st.want[id]; save();
    }
    if (got) onRides();
  }

  function applyPending() {
    const p = st?.pending; if (!p || local.rideActive()) return false;
    const cur = local.list('settings').find(x => x.id === p.id);
    if (!cur || p.updatedAt >= cur.updatedAt) local.put('settings', p.id, p.data, p.updatedAt);
    st.pending = null; save(); return true;
  }

  async function cycle() {
    if (!st || stopped) return;
    if (!isOnline()) { set('offline'); return schedule(30000); }
    set('syncing');
    again = false;
    try {
      applyPending();
      await pull();
      const pushed = await pushRecords();
      await pushRides();
      if (pushed || st.rev === 0) await pull();
      await pullRides();
      fails = 0; st.at = now(); save();
      set('synced');
      schedule(again ? 1000 : IDLE_MS);
    } catch (e) {
      if (e.status === 401) { set('off'); stop(); onSignedOut(); return; }
      fails++;
      const wait = e.status === 429 ? (e.extra?.retryAfter || 60) * 1000 : Math.min(MAX_BACKOFF, 5000 * 2 ** (fails - 1));
      set(e.status === 0 ? 'offline' : 'error', e.code || e.message);
      schedule(wait);
    }
  }
  function schedule(ms) { if (timer) timers.clear(timer); timer = stopped ? null : timers.set(() => { timer = null; kick(0); }, ms); }
  // run soon; one cycle at a time (a kick during a cycle runs one more right after)
  function kick(delay = 2000) {
    if (!st || stopped) return Promise.resolve();
    if (delay) { schedule(delay); return Promise.resolve(); }
    if (running) { again = true; return running; }
    running = cycle().finally(() => { running = null; });
    return running;
  }
  // signed in as uid: a different account than last time starts over (local data merges into it)
  function start(uid) {
    const saved = storage.get(key, null);
    st = saved && saved.uid === uid ? { ...blank(uid), ...saved } : blank(uid);
    stopped = false; fails = 0; save();
    return kick(0);
  }
  function stop() { stopped = true; if (timer) timers.clear(timer); timer = null; }
  // signed out: forget the server state so another account starts clean; local data stays on this device
  function signOut() { stop(); st = null; storage.set(key, null); set('off'); }
  return { start, stop, signOut, kick, applyPending, get status() { return status; }, get error() { return lastError; }, get state() { return st; }, flush: () => running || Promise.resolve() };
}
