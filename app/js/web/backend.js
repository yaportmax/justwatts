// In-page backend for the web build. It answers the same /api/* requests and live stream the local
// server does, so app.js runs unchanged: F() and ES replace fetch and EventSource in web mode.
import { fitEncode, toTcx, activeHrZones } from '../core.js';
import { Engine } from './engine.js';
import { WebHub } from './ble.js';
import { openDB, MemStore } from './idb.js';
import { detail, metaRow, trends } from './history.js';
import { parseLine } from './lines.js';

const SETTINGS_DEFAULTS = { ftp: 200, weight: 0, beeps: true, autoGarmin: false, hrZones: null, hrMax: null, hrZonesSrc: null, cadRange: [85, 95],
  voiceMode: 'all', afterWorkout: 'hold', localCoach: {}, ftpSrc: null, hideVirtualDistance: false, units: 'imperial' };
const NOT_WEB = 'not available in the web version; use the local app';
const UNMUTE = /\b(unmute|voice on|talk to me|speak again|you can talk)\b/i, MUTE = /\b(mute|quiet|stop talking|shut up|silence|be silent|no talking)\b/i;
const pad = n => String(n).padStart(2, '0'), hms = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const resp = (status, obj, type = 'application/json') => new Response(type === 'application/json' ? JSON.stringify(obj) : obj, { status, headers: { 'Content-Type': type } });

export class WebBackend {
  constructor({ store, nav = globalThis.navigator, location = globalThis.location, tickMs = 1000 } = {}) {
    this.store = store; this.location = location; this.tickMs = tickMs;
    this.settings = { ...SETTINGS_DEFAULTS }; this.settingsStored = false;
    this.log = []; this.said = []; this.seq = 0; this.voice = { barge: 0, barge_at: null, tts: false, tts_at: null, listener_at: null };
    this.hub = new WebHub({ store });
    this.engine = new Engine({ hub: this.hub, logEvent: l => this.logEvent(l), settings: () => this.settings,
      save: p => this.persist(p), archive: p => this.store.putRide(p).then(() => this.bump()) });
    this.engine.onFinish = p => this.afterFinish(p);
    this.coach = null;  // no built-in coach on the public site for now (the local server keeps it)
    this.lastSnap = 0;
  }
  async init() {
    const s = await this.store.get('settings');
    if (s) { this.settings = { ...this.settings, ...s }; this.settingsStored = true; }
    const cur = await this.store.get('current');
    if (cur) {
      const j = (await this.store.get('journal')) || [];
      const last = cur.samples?.at(-1)?.[1] ?? 0;
      for (const x of j) if (x[1] > last) cur.samples.push(x);   // samples recorded after the last snapshot
      if (this.engine.resume(cur)) this.lastSnap = 0;
    }
    await this.hub.init();
    if (this.tickMs) this.timer = setInterval(() => this.tick(), this.tickMs);
    return this;
  }
  notice(t) { this.engine.notice = t; this.bump(); }
  bump() { this.engine.bump(); }
  tick() {
    this.engine.tick(1);
    const st = this.state(); this.coach?.observe(st);
    // crash safety: a snapshot at the first sample and every 30 s, the samples since then every second
    const r = this.engine.ride;
    if (r?.started && r.samples.length) {
      if (!this.lastSnap || r.samples.length - this.lastSnap >= 30 || this.lastSnap > r.samples.length) this.persist(r.payload());
      else this.store.set('journal', r.samples.slice(this.lastSnap));
    }
  }
  persist(p) {
    if (!p) { this.lastSnap = 0; this.store.del('current'); this.store.del('journal'); return; }
    this.lastSnap = p.samples.length; this.store.set('current', p); this.store.set('journal', []);
  }
  logEvent(line) {
    const now = new Date();
    this.log.push(`[${hms(now)}] ${line}`); if (this.log.length > 2000) this.log.splice(0, 500);
    this.engine.note(line);
    const ev = parseLine(line);
    if (ev.type === 'said') {
      this.said.unshift({ time: hms(now), text: ev.said, source: ev.source }); this.said = this.said.slice(0, 8);
      if (UNMUTE.test(ev.said)) { this.updateSettings({ voiceMode: 'all' }); this.logEvent('VOICE UNMUTED (said)'); }
      else if (MUTE.test(ev.said)) { this.updateSettings({ voiceMode: 'silent' }); this.voiceEvent('speech_start'); this.logEvent('VOICE MUTED (said)'); }
    }
    this.coach?.onEvent(line);
    this.bump();
  }
  addCmd(fields) { this.seq = Math.max(Date.now(), this.seq + 1); return { seq: this.seq, ...fields }; }
  localSay(text, important) { const c = this.addCmd({ msg: text, important: !!important, local: true }); this.engine.coach(c); this.countCue(); this.logEvent(`CUE ${text}`); }
  localAdjust(step, w, why) { const c = this.addCmd({ set: { step, w }, msg: why, important: true, local: true }); this.engine.coach(c); this.countCue(); this.logEvent(`CUE set step ${step} ${w}W | ${why}`); }
  countCue() { if (this.engine.ride) this.engine.ride.localCues++; }
  voiceEvent(ev) {
    const v = this.voice, now = Date.now();
    if (ev === 'speech_start') { v.barge++; v.barge_at = now; } else if (ev === 'tts_start' || ev === 'tts_end') { v.tts = ev === 'tts_start'; v.tts_at = now; } else throw new Error('bad voice event');
    this.bump(); return { ...v };
  }
  updateSettings(body) {
    for (const [k, v] of Object.entries(body)) {
      if (!(k in SETTINGS_DEFAULTS) || k === 'autoGarmin') continue;
      if (k === 'ftp' && !(+v >= 50 && +v <= 600)) continue;
      if (k === 'units' && v !== 'imperial' && v !== 'metric') continue;
      if (k === 'hrZonesSrc' && ![null, 'default', 'manual', 'garmin'].includes(v)) continue;
      this.settings[k] = k === 'localCoach' ? { ...(this.settings[k] || {}), ...v } : v;
    }
    this.settingsStored = true; this.store.set('settings', this.settings);
    this.bump(); return this.settingsPayload();
  }
  settingsPayload() { return { settings: { ...this.settings, autoGarmin: false }, stored: this.settingsStored, garmin: false, web: true, ble_supported: this.hub.supported }; }
  athlete() { const s = this.settings, z = activeHrZones(s); return { ftp: s.ftp, weight_kg: s.weight || null, hr_zones: z.floors, hr_max: s.hrMax, hr_zones_source: z.src, cadence_range: s.cadRange }; }
  state() {
    const st = this.engine.state(this.athlete(), { said: this.said.slice(0, 3) });
    st.voice = { ...this.voice, mode: this.settings.voiceMode || 'all' };
    st.agent = { connected: false };
    return st;
  }
  live(rid, n) { const [nr, samples] = this.engine.samplesSince(rid, n); const reset = nr !== rid; return { state: this.state(), ride_id: nr, reset, samples, n: (reset ? 0 : n) + samples.length }; }
  async rides() {
    const all = await this.store.allRides(), meta = (await this.store.get('meta')) || {};
    return all.filter(r => r.samples?.length).map(r => metaRow(r, meta[r.id])).sort((a, b) => (b.start || 0) - (a.start || 0));
  }
  async setMeta(id, patch) { const meta = (await this.store.get('meta')) || {}; meta[id] = { ...(meta[id] || {}), ...patch }; await this.store.set('meta', meta); }
  afterFinish(p) { this.store.putRide(p); }
  async exportFile(id, ext) { const r = await this.store.getRide(id); return r ? (ext === 'fit' ? fitEncode(r) : toTcx(r)) : null; }

  // ---------- the /api/* router ----------
  async fetch(input, opts = {}) {
    const url = new URL(input, 'http://web.local'), p = url.pathname, q = url.searchParams, method = (opts.method || 'GET').toUpperCase();
    let body = {};
    if (method === 'POST' && typeof opts.body === 'string') { try { body = JSON.parse(opts.body || '{}'); } catch { return resp(400, { error: 'bad json' }); } }
    try { return await this.route(p, q, method, body, opts); }
    catch (e) { return resp(400, { error: e.message }); }
  }
  async route(p, q, method, body, opts) {
    const E = this.engine;
    if (p === '/api/health') return resp(200, { ok: true, app: 'justwatts', web: true, garmin: false, ble: this.hub.supported });
    if (p === '/api/live') return resp(200, this.live(q.get('ride') || null, +(q.get('n') || 0)));
    if (p === '/api/state') return resp(200, { state: this.state(), age_s: 0, received_at: Date.now() / 1000 });
    if (p === '/api/settings') return resp(200, method === 'POST' ? this.updateSettings(body) : this.settingsPayload());
    if (p === '/api/devices') {
      if (method === 'GET') return resp(200, this.hub.status());
      const kind = body.kind || 'trainer';
      if (body.action === 'choose' || body.action === 'scan') await this.hub.choose(kind);
      else if (body.action === 'disconnect') this.hub.disconnect(kind);
      else if (body.action === 'sim') this.hub.setSim(body.on ?? this.hub.mode !== 'sim');
      else throw new Error('action must be choose, disconnect or sim');
      E.applyTarget(); this.bump();
      return resp(200, { ...this.hub.status(), devices: [] });
    }
    if (p === '/api/ride/control') return resp(200, { ok: true, ...E.control(String(body.action || ''), body) });
    if (p === '/api/coach' && method === 'POST') {
      const c = this.addCmd(Object.fromEntries(['msg', 'set', 'edit', 'important'].filter(k => k in body).map(k => [k, body[k]])));
      let result = null; if (c.edit) result = E.edit(c.edit);
      E.coach(c); return resp(200, result ? { ...c, result } : c);
    }
    if (p === '/api/voice') return resp(200, method === 'POST' ? this.voiceEvent(body.event) : { ...this.voice, mode: this.settings.voiceMode });
    if (p === '/api/said') return resp(200, { said: this.said });
    if (p === '/api/event' && method === 'POST') { this.logEvent(String(body.line || '').split('\n').join(' ')); return resp(200, { ok: true }); }
    if (p === '/api/events') return resp(200, { events: this.log.slice(-(+(q.get('n') || 50))).map(l => { const m = l.match(/^\[(\d\d:\d\d:\d\d)\] (.*)$/); return parseLine(m[2], m[1]); }) });
    if (p === '/api/ride' && method === 'POST') { if (body.id && body.samples?.length) await this.store.putRide({ ...body, source: body.source || 'browser' }); return resp(200, { ok: true }); }
    if (p === '/api/rides') return resp(200, { rides: await this.rides() });
    if (p === '/api/trends') return resp(200, trends(await this.rides(), +(q.get('weeks') || 12)));
    const m = p.match(/^\/api\/rides\/([\w-]+)(?:\/(\w+))?$/);
    if (m) {
      const [, id, sub] = m, r = await this.store.getRide(id);
      if (sub === 'delete') { await this.store.delRide(id); this.bump(); return resp(200, { ok: true }); }
      if (!r) return resp(404, { error: 'no such ride' });
      const meta = ((await this.store.get('meta')) || {})[id] || {};
      if (!sub) return resp(200, r);
      if (sub === 'detail') return resp(200, detail(r, activeHrZones(this.settings).floors, meta));
      if (sub === 'description') { await this.setMeta(id, { description: String(body.text || '').slice(0, 2000) }); return resp(200, { ok: true }); }
      if (sub === 'card') return resp(200, { ok: true, url: null });   // web: the card is for downloading and sharing
      if (sub === 'strava') return resp(503, { ok: false, error: 'Strava upload is ' + NOT_WEB });
      if (sub === 'garmin') return resp(503, { ok: false, disabled: true, error: 'Garmin upload is not available on the web. Download the .fit and import it in Garmin Connect, or use the local app.' });
      if (sub === 'fit' || sub === 'tcx') return resp(200, await this.exportFile(id, sub), 'application/octet-stream');
    }
    if (p === '/api/strava/status') return resp(200, { configured: false, connected: false, web: true });
    if (p.startsWith('/api/strava/')) return resp(503, { error: 'Strava is ' + NOT_WEB });
    if (p.startsWith('/api/garmin/')) return resp(503, { ok: false, linked: false, enabled: false, error: 'Garmin is not available on the web version' });
    if (p === '/api/backup') return resp(200, await this.store.exportAll());
    if (p === '/api/restore' && method === 'POST') return resp(200, { ok: true, rides: await this.store.importAll(body) });
    return resp(404, { error: 'not found' });
  }
}

// EventSource stand-in: pushes live messages on every engine change
export function makeEventSource(backend) {
  return class {
    constructor() {
      this.rid = null; this.n = 0; this.closed = false;
      const push = () => { if (this.closed || !this.onmessage) return; const msg = backend.live(this.rid, this.n); this.rid = msg.ride_id; this.n = msg.n; this.onmessage({ data: JSON.stringify(msg) }); };
      this.f = () => { if (!this.pending) { this.pending = true; queueMicrotask(() => { this.pending = false; push(); }); } };
      backend.engine.listeners.add(this.f); setTimeout(push, 0);
    }
    close() { this.closed = true; backend.engine.listeners.delete(this.f); }
  };
}

export async function createWebBackend(opts = {}) {
  let store = opts.store;
  if (!store) { try { store = await openDB(); } catch { store = new MemStore(); } }
  const b = new WebBackend({ ...opts, store });
  await b.init();
  return b;
}
