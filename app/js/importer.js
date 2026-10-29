// Import from a connected service (Garmin, intervals.icu): profile values with what would change, then past rides
// one FIT at a time into History. Pure logic, the page (connect.js) draws it; node tests drive it with fakes.
//   api.profile(svc) -> { values, missing, errors }       api.list(svc, { since, until, start }) -> { items, more, next }
//   api.fit(svc, id) -> Uint8Array (throws { status, kind, retryAfter } on failure)
//   rides() -> [{ id, start }] in History                  saveRide(ride) -> true when stored
//   storage: get(k, d) / set(k, v) / del(k)               the job (resume after the page closes) lives under KEY
import { rideFromFit } from './fitread.js';
import { activeHrZones } from './core.js';

export const KEY = 'hw.import';
export const RANGES = [['none', 'None'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year'], ['all', 'All']];
export const KINDS = [['cycling', 'Cycling only (indoor and outdoor)'], ['indoor', 'Indoor only']];
export const DEFAULT_RANGE = 'all';
export const DUP_MS = 120000;           // a ride starting within 2 min of one in History is the same ride
const GAP_MS = 500, MAX_ITEMS = 5000, MAX_TRIES = 3;

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function rangeDates(range, now = new Date()) {
  if (range === 'none') return null;
  const until = ymd(new Date(now.getTime() + 864e5));  // tomorrow: time zones never cut today's ride
  if (range === 'all') return { since: '2000-01-01', until };
  return { since: ymd(new Date(now.getTime() - (+range || 90) * 864e5)), until };
}

// profile values -> rows for the checklist: { key, label, value, now, differs, setting }
export function profileRows(values, settings, { units = 'imperial', service = 'garmin' } = {}) {
  const lb = units !== 'metric', w = kg => (lb ? `${Math.round(kg * 2.20462)} lb` : `${kg} kg`);
  const z = activeHrZones(settings), rows = [];
  const add = (key, label, val, cur, fmt, patch) => rows.push({ key, label, value: val, text: fmt(val), now: cur, nowText: cur == null ? null : fmt(cur),
    differs: cur == null || JSON.stringify(cur) !== JSON.stringify(val), patch });
  const v = values || {};
  if (v.ftp) add('ftp', 'FTP', v.ftp, settings.ftp ?? null, x => `${x} W`, { ftp: v.ftp, ftpSrc: service });
  if (v.weight_kg) add('weight_kg', 'Weight', v.weight_kg, settings.weight > 0 ? Math.round(settings.weight * 10) / 10 : null, w, { weight: v.weight_kg });
  if (v.hr_max) add('hr_max', 'Max HR', v.hr_max, settings.hrMax ?? null, x => `${x} bpm`, { hrMax: v.hr_max });
  if (v.hr_zones) add('hr_zones', 'HR zones', v.hr_zones, z.src === 'default' && !settings.hrZones ? null : z.floors, x => x.join(' / '), { hrZones: v.hr_zones, hrZonesSrc: service === 'garmin' ? 'garmin' : 'manual' });
  return rows;
}
// values Just Watts has no setting for: shown, never stored
export const infoOnly = values => [['hr_rest', 'Resting HR'], ['lthr', 'LTHR']].filter(([k]) => values?.[k]).map(([k, l]) => `${l} ${values[k]} bpm`);

// which copy of the same ride to keep: Just Watts's own recording, then original files, then Strava's streams
const RANK = { garmin: 3, intervals: 2, strava: 1 };
const rankOf = id => { const m = /^imp-(\w+)-/.exec(id || ''); return m ? RANK[m[1]] || 1 : 9; };
const INLINE_S = 16 * 60;  // waits up to a rate window run in place; longer ones (a daily limit) pause with a resume time

export function createImporter({ api, rides, saveRide, deleteRide = async () => false, storage, settings = () => ({}),
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), log = () => {} }) {
  let job = storage.get(KEY, null), stop = false, running = false, waitUntil = 0;
  const save = () => storage.set(KEY, job);
  // History rides near a start time; `better` when this service's copy should replace them
  const near = (have, t) => have.filter(r => r.start && Math.abs(r.start - t) <= DUP_MS);
  const better = (svc, list) => list.length > 0 && list.every(r => rankOf(r.id) < (RANK[svc] || 1));

  // wait `sec` (stoppable, shown as waiting) or, when longer than a rate window, pause the job until then
  async function rest(sec, onProgress) {
    if (!(sec > 0)) return true;
    if (sec > INLINE_S) { if (job) { job.paused = 'rate'; job.resume_at = now() + sec * 1000; save(); } return false; }
    waitUntil = now() + sec * 1000; onProgress(view());
    for (let t = 0; t < sec && !stop; t++) await sleep(1000);
    waitUntil = 0; onProgress(view());
    return !stop;
  }

  // the list of rides to bring in: every page, cycling only (or indoor), minus rides already in History
  async function plan(svc, { range = 'all', kind = 'cycling' } = {}, onPage = () => {}) {
    const span = rangeDates(range); if (!span) return { items: [], dupes: 0, total: 0 };
    const items = []; let start = 0;
    for (let guard = 0, tries = 0; guard < 400; guard++) {
      if (stop) return null;  // stopped while listing: nothing saved yet
      let page;
      try { page = await api.list(svc, { ...span, start }); tries = 0; }
      catch (e) {  // a rate window: wait it out and ask again
        if (e.kind === 'temporary' && e.retryAfter > 0 && e.retryAfter <= INLINE_S && ++tries <= 2) { if (!(await rest(e.retryAfter, () => onPage(items.length)))) return null; continue; }
        throw e;
      }
      items.push(...(page.items || [])); onPage(items.length);
      if (!page.more || items.length >= MAX_ITEMS || !(page.next > start)) break;
      start = page.next;
      if (page.wait > 0 && page.wait <= INLINE_S) { if (!(await rest(page.wait, () => onPage(items.length)))) return null; } else await sleep(GAP_MS);
    }
    const have = (await rides()) || [], ids = new Set(have.map(r => r.id));
    const seen = new Set(), out = []; let dupes = 0;
    for (const it of items) {
      if (seen.has(it.id) || it.no_file || (kind === 'indoor' && !it.indoor)) continue;
      seen.add(it.id);
      const same = near(have, it.start_ms);
      if (ids.has(`imp-${svc}-${it.id}`) || (same.length && !better(svc, same))) { dupes++; continue; }
      out.push({ id: it.id, name: it.name, start_ms: it.start_ms });
    }
    out.sort((a, b) => b.start_ms - a.start_ms);  // newest first: recent rides show up in History right away
    return { items: out, dupes, total: items.length };
  }

  async function start(svc, opts, onProgress = () => {}) {
    stop = false;
    const p = await plan(svc, opts, n => onProgress({ svc, finding: n, running: true, total: 0, done: 0, waiting_s: waitUntil ? Math.max(0, Math.round((waitUntil - now()) / 1000)) : 0 }));
    if (!p) return null;
    job = { svc, opts, todo: p.items, total: p.items.length, done: 0, imported: 0, replaced: 0, dupes: p.dupes, failed: [], no_power: 0, at: now() };
    save();
    return run(onProgress);
  }

  // one file at a time; a failed ride is skipped; sign-in trouble or a busy service pauses (the job stays for later);
  // the server's rate hints (Strava) are obeyed: short waits in place, a daily limit pauses until it resets
  async function run(onProgress = () => {}) {
    if (!job || running) return job;
    if (job.paused === 'rate' && job.resume_at > now()) return view();
    running = true; stop = false; job.paused = null; job.resume_at = null; save();
    const have = (await rides()) || [];
    try {
      while (job.todo.length && !stop) {
        const it = job.todo[0];
        let bytes = null, tries = 0, fail = null;
        while (!bytes && tries < MAX_TRIES && !stop) {
          tries++;
          try { bytes = await api.fit(job.svc, it.id); }
          catch (e) {
            if (e.kind === 'auth' || e.status === 401) { job.paused = 'auth'; stop = true; break; }
            if (e.kind === 'temporary' || e.status === 429 || e.status >= 500 || !e.status) {
              fail = e;
              const wait = e.retryAfter > 60 ? e.retryAfter : Math.min(60, e.retryAfter || 5 * tries);
              if (wait > 60) tries--;  // a rate window is not a failure
              if (!(await rest(wait, onProgress))) break;
              continue;
            }
            fail = e; break;  // blocked: this ride only
          }
        }
        if (job.paused) break;
        if (!bytes && fail && (fail.kind === 'temporary' || !fail.status) && tries >= MAX_TRIES) { job.paused = 'busy'; break; }
        if (stop && !bytes) break;
        job.todo.shift(); job.done++;
        if (bytes) {
          try {
            const { ride, missing } = rideFromFit(bytes, it, { service: job.svc, ftp: settings().ftp });
            const same = near(have, ride.start).filter(r => r.id !== ride.id);
            if (same.length && !better(job.svc, same)) job.dupes++;
            else if (await saveRide(ride)) {
              job.imported++; have.push({ id: ride.id, start: ride.start }); if (missing.includes('power')) job.no_power++;
              for (const old of same) if (await deleteRide(old.id)) { job.replaced++; have.splice(have.indexOf(old), 1); }  // the richer copy wins
            } else job.failed.push(it.id);
            if (missing.length) log(`import ${job.svc}: ride without ${missing.join(', ')}`);
          } catch (e) { job.failed.push(it.id); log(`import ${job.svc}: unreadable file (${String(e.message).slice(0, 60)})`); }
        } else job.failed.push(it.id);
        save(); onProgress(view());
        if (job.todo.length && !stop) { if (bytes?.wait > 0) { if (!(await rest(bytes.wait, onProgress))) break; } else await sleep(GAP_MS); }
      }
    } finally { running = false; }
    if (!job.todo.length) job.finished = now();
    save(); onProgress(view());
    return view();
  }
  function view() {
    return job ? { svc: job.svc, total: job.total, done: job.done, imported: job.imported, replaced: job.replaced || 0, dupes: job.dupes, failed: job.failed.length,
      no_power: job.no_power, left: job.todo.length, paused: job.paused || null, resume_at: job.resume_at || null, running, finished: !!job.finished,
      waiting_s: waitUntil ? Math.max(0, Math.round((waitUntil - now()) / 1000)) : 0 } : null;
  }
  return {
    plan, start, run, view,
    stop() { stop = true; },
    pending: () => (job && job.todo.length ? view() : null),
    discard() { job = null; stop = true; storage.del(KEY); },
    get running() { return running; },
  };
}
