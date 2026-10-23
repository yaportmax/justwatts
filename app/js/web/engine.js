// In-page ride engine for the web build: a port of server/openspin/engine.py.
// Same state shape, controls, coach commands, mid-ride edits, overtime and persistence semantics;
// persistence goes to IndexedDB (snapshot every 30 s + a sample journal every 5 s, see backend.js).
import { parseWorkout, toText, stepAt, stepWatts, fmtT, lineRideStart, lineRideEnd, lineStepStart, lineStepEnd, lineTick, lineFeel } from '../core.js';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const jsr = Math.round;

export class Ride {
  constructor(name, text, test, ftp) {
    Object.assign(this, { name, text, test, ftp, steps: null, total: 0, el: 0, started: false, paused: false, auto: false, pp: false, idle: 0, k: 1,
      samples: [], jr: { m: 'g', g: 0, w: jsr(ftp * 0.6), r: 5 }, startTs: null, ov: {}, lastStep: -1, acc: null, lastLine: 0, events: [],
      overtime: false, agentWakes: 0, localCues: 0, usage: {}, agentSeen: false });
    if (text) { this.steps = parseWorkout(text); this.retime(); }
  }
  get id() { return `r-${this.startTs || 0}`; }
  retime() { let t = 0; for (const s of this.steps || []) { s.t0 = t; t += s.d; } this.total = t; }
  plainSteps() { return this.steps ? this.steps.map(({ t0, ...s }) => s) : null; }
  applyOverride(i, w) {
    const s = this.steps?.[i]; if (!s || s.free) return false;
    s.a = s.b = w; s.u = 'w'; this.ov[i] = w; return true;
  }
  payload() {
    return { id: this.id, name: this.name, text: this.text, steps: this.plainSteps(), test: this.test, ftp: this.ftp, events: this.events,
      overtime: this.overtime, agent: { wakes: this.agentWakes, local_cues: this.localCues, usage: this.usage, seen: this.agentSeen },
      start: this.startTs, samples: this.samples, el: this.el, k: this.k, jr: this.jr, ov: Object.fromEntries(Object.entries(this.ov)), source: 'web' };
  }
}

export class Engine {
  constructor({ hub, logEvent, settings, save, archive, clock = () => performance.now() / 1000, wall = () => Date.now() }) {
    Object.assign(this, { hub, logEvent, settings, saveFn: save, archiveFn: archive, clock, wall });
    this.ride = null; this.pHist = []; this.messages = []; this.lastFinished = null; this.lastSaved = null; this.notice = null;
    this.version = 0; this.simT = 0; this.listeners = new Set(); this.onFinish = null;
  }
  bump() { this.version++; for (const f of this.listeners) f(); }
  note(line) { const r = this.ride; if (r && (r.started || line.startsWith('RIDE START'))) r.events.push([this.wall(), line]); }
  log(line) { this.logEvent(line); }

  // ---------- persistence ----------
  save() { const r = this.ride; if (r && r.started && r.samples.length) this.saveFn(r.payload()); }
  resume(cur) {
    if (!cur?.samples?.length) return false;
    if (this.wall() - cur.samples.at(-1)[0] > 6 * 3600e3) { cur.name += ' (recovered)'; this.archiveFn(cur); this.notice = 'Saved an old unfinished ride to History'; return false; }
    const r = new Ride(cur.name, cur.text || '', !!cur.test, cur.ftp);
    if (cur.steps) { r.steps = cur.steps.map(s => ({ ...s })); r.retime(); }
    Object.assign(r, { el: Math.max(cur.el || 0, cur.samples.at(-1)[1]), started: true, paused: true, auto: true, pp: true, k: cur.k || 1,
      samples: cur.samples, jr: { ...r.jr, ...(cur.jr || {}) }, startTs: cur.start, events: cur.events || [], overtime: !!cur.overtime });
    r.ov = Object.fromEntries(Object.entries(cur.ov || {}).map(([k, v]) => [+k, v]));
    const ag = cur.agent || {}; r.agentWakes = ag.wakes || 0; r.localCues = ag.local_cues || 0; r.usage = ag.usage || {};
    this.ride = r;
    this.log(`RIDE RESUMED after reload at T+${fmtT(r.el)} (${r.samples.length} samples kept)`);
    this.notice = 'Ride restored. Reconnect the trainer, then pedal to continue.';
    this.applyTarget(); this.bump(); return true;
  }

  // ---------- targets ----------
  curTarget() {
    const r = this.ride; if (!r) return null;
    if (!r.steps) return r.jr.m === 'w' ? r.jr.w : null;
    const at = stepAt({ steps: r.steps }, r.el);
    if (!at) {
      if (r.overtime && (this.settings().afterWorkout || 'hold') === 'hold') { const last = r.steps.at(-1); return stepWatts(last, last.d, r.ftp, r.test ? 1 : r.k); }
      return null;
    }
    return stepWatts(at.s, at.into, r.ftp, r.test ? 1 : r.k);
  }
  applyTarget() {
    const r = this.ride; if (!r) return;
    if (!r.steps) { const m = r.jr.m; return this.hub.want(m === 'w' ? { k: 'erg', w: r.jr.w } : m === 'r' ? { k: 'res', r: r.jr.r } : { k: 'sim', g: r.jr.g }); }
    const t = this.curTarget(); this.hub.want(t == null ? { k: 'sim', g: 0 } : { k: 'erg', w: t });
  }

  // ---------- controls ----------
  control(action, body = {}) {
    const fn = { load: this.load, start: this.start, pause: this.togglePause, hold: this.hold, resume: this.resumeRide, skip: this.skip, end: this.finish,
      adjust: this.adjust, mode: this.setMode, intensity: this.setIntensity, free: this.setFree, feel: this.feel, save: this.saveCopy,
      dismiss: () => { this.notice = null; }, edit: b => this.edit(b.edit || {}) }[action];
    if (!fn) throw new Error(`unknown action ${action}`);
    const res = fn.call(this, body) || {};
    this.save(); this.bump(); return res;
  }
  load(body) {
    const w = body.workout;
    if (this.ride?.started) this.finish();
    const ftp = +(this.settings().ftp || 200);
    this.ride = w ? new Ride(w.name, w.text, !!w.test, ftp) : new Ride('Just ride', '', false, ftp);
    this.notice = null; this.applyTarget(); return { loaded: this.ride.name };
  }
  start() {
    const r = this.ride; if (!r || r.started) return;
    r.started = true; r.startTs = this.wall(); r.pp = false; this.messages = [];
    this.log(lineRideStart(r.name, r.ftp, r.steps ? { steps: r.steps, total: r.total } : null));
    if (this.hub.mode === 'ble' && !(this.hub.r.cadence > 0 || this.hub.r.power > 0)) r.paused = r.auto = true;
  }
  togglePause() { const r = this.ride; if (!r) return; if (!r.started) return this.start(); r.paused = !r.paused; r.auto = false; }
  hold() { const r = this.ride; if (r?.started && !r.paused) { r.paused = true; r.auto = false; } }
  resumeRide() { const r = this.ride; if (!r) return; if (!r.started) return this.start(); r.paused = r.auto = false; }
  skip() { const r = this.ride; if (!r?.steps) return; const at = stepAt({ steps: r.steps }, r.el); if (at) { r.el = at.s.t0 + at.s.d + 0.01; this.applyTarget(); } }
  adjust(body) {
    const r = this.ride; if (!r) return; const d = (body.dir ?? 1) > 0 ? 1 : -1;
    if (r.steps) r.k = Math.max(0.5, Math.min(1.5, +(r.k + d * 0.01).toFixed(2)));
    else if (r.jr.m === 'g') r.jr.g = Math.max(-10, Math.min(20, +(r.jr.g + d * 0.5).toFixed(1)));
    else if (r.jr.m === 'r') r.jr.r = Math.max(0, Math.min(25, +(r.jr.r + d * 0.5).toFixed(1)));
    else r.jr.w = Math.max(30, Math.min(1500, r.jr.w + d * 5));
    this.applyTarget();
  }
  setMode(body) { const r = this.ride; if (r && ['g', 'w', 'r'].includes(body.m)) { r.jr.m = body.m; this.applyTarget(); } }
  setIntensity(body) { const r = this.ride; if (!r) throw new Error('no ride loaded'); const p = +(body.percent ?? 100); if (!(p >= 50 && p <= 150)) throw new Error('percent must be 50..150'); r.k = +(p / 100).toFixed(2); this.applyTarget(); }
  setFree(body) {
    const r = this.ride; if (!r || r.steps) throw new Error('free-ride targets need a free ride');
    const m = body.m; if (!['g', 'w', 'r'].includes(m)) throw new Error('m must be g, w or r');
    const v = body.value != null ? +body.value : r.jr[m], lim = { g: [-10, 20], w: [30, 1500], r: [0, 25] }[m];
    if (!(v >= lim[0] && v <= lim[1])) throw new Error(`value out of range ${lim[0]}..${lim[1]}`);
    r.jr.m = m; r.jr[m] = m === 'w' ? jsr(v) : +v.toFixed(1); this.applyTarget();
  }
  feel(body) {
    const f = String(body.feel || '').toLowerCase(); if (!['easier', 'good', 'harder'].includes(f)) throw new Error('feel must be easier, good or harder');
    const r = this.ride, at = r?.steps ? stepAt({ steps: r.steps }, r.el) : null;
    this.log(lineFeel(f, at ? at.i + 1 : null, r ? r.samples.slice(-30) : [], this.hub.r.hr));
  }
  saveCopy() {
    const r = this.ride; if (!r?.started || r.samples.length < 10) throw new Error('nothing to save yet');
    const p = r.payload(); this.archiveFn(p); this.lastSaved = { id: p.id, samples: r.samples.length, ts: this.wall() };
    return { saved: true, id: p.id, samples: r.samples.length };
  }
  finish() {
    const r = this.ride; if (!r) return;
    if (r.acc?.p.length) { this.log(lineStepEnd(r.acc)); r.acc = null; }
    this.log(lineRideEnd(r.el)); this.ride = null; this.hub.want({ k: 'sim', g: 0 }); this.saveFn(null);
    if (r.samples.length < 10) { this.notice = 'Ride too short, not saved'; this.lastFinished = null; return { saved: false }; }
    const p = r.payload(); this.archiveFn(p);
    this.lastFinished = { id: p.id, name: r.name, samples: r.samples.length, ts: this.wall() };
    this.onFinish?.(p);
    return { saved: true, id: p.id };
  }

  // ---------- coach commands + edits ----------
  coach(cmd) {
    if (cmd.msg) { this.messages.push({ seq: cmd.seq, msg: cmd.msg, ts: this.wall(), important: !!cmd.important }); this.messages = this.messages.slice(-10); }
    const s = cmd.set, r = this.ride;
    if (s && r?.steps) {
      const at = stepAt({ steps: r.steps }, r.el), idx = s.step === 'cur' ? at?.i : s.step - 1;
      if (idx != null && r.applyOverride(idx, s.w)) { this.applyTarget(); this.save(); }
    }
    this.bump();
  }
  edit(e) {
    const r = this.ride; if (!r?.steps) throw new Error('no structured workout loaded');
    let at = stepAt({ steps: r.steps }, r.el), cur, into;
    if (!at && e.op === 'insert') {
      const gap = Math.ceil(r.el - r.total); if (gap > 0) { r.steps.push({ d: gap, free: true }); r.retime(); }
      r.overtime = false; cur = r.steps.length; into = 0; e = { ...e, after: r.steps.length };
    } else { cur = at ? at.i : r.steps.length; into = at ? at.into : 0; }
    const index = (v, name) => {
      if (v === 'cur' || v == null) { if (!at) throw new Error('workout already finished'); return cur; }
      const i = +v - 1; if (!(i >= 0 && i < r.steps.length)) throw new Error(`${name} ${v} out of range 1..${r.steps.length}`);
      if (i < cur && !(name === 'after step' && i === cur - 1 && !at)) throw new Error(`${name} ${v} is already done (current step ${cur + 1})`);
      return i;
    };
    const parse = t => { try { return parseWorkout(String(t || '')); } catch (err) { throw new Error('bad steps: ' + err.message); } };
    const remap = (f, drop) => { const o = {}; for (const [k, v] of Object.entries(r.ov)) { if (+k === drop) continue; o[f(+k)] = v; } r.ov = o; };
    let desc; const op = e.op;
    if (op === 'insert') {
      const nw = parse(e.steps), after = index(e.after ?? 'cur', 'after step'), pos = after + 1;
      r.steps.splice(pos, 0, ...nw); remap(k => k >= pos ? k + nw.length : k); desc = `insert ${nw.length} after step ${after + 1}: ${toText(nw)}`;
    } else if (op === 'replace') {
      const i = index(e.step ?? 'cur', 'step'), nw = parse(e.steps);
      if (i === cur) { r.steps[i].d = Math.max(1, Math.ceil(into)); r.steps.splice(i + 1, 0, ...nw); remap(k => k > i ? k + nw.length : k); }
      else { r.steps.splice(i, 1, ...nw); remap(k => k > i ? k + nw.length - 1 : k, i); }
      desc = `replace step ${i + 1} with ${nw.length}: ${toText(nw)}`;
    } else if (op === 'delete') {
      const i = index(e.step, 'step');
      if (i === cur) { r.steps[i].d = Math.max(1, Math.ceil(into)); desc = `end step ${i + 1} now`; }
      else { r.steps.splice(i, 1); remap(k => k > i ? k - 1 : k, i); desc = `delete step ${i + 1}`; }
    } else if (op === 'total') {
      if (!at) throw new Error('workout finished: insert steps instead');
      let want = Math.max(+e.seconds, Math.ceil(r.el)), delta = want - r.total;
      if (e.how === 'scale' && delta) {
        const left = []; for (let i = cur; i < r.steps.length; i++) left.push([i, r.steps[i].d - (i === cur ? into : 0)]);
        const rem = left.reduce((a, [, d]) => a + d, 0) || 1;
        for (const [i, d] of left) { const base = i === cur ? into : 0; r.steps[i].d = Math.max(i !== cur ? 1 : Math.ceil(into), jsr(base + d * (rem + delta) / rem)); }
      } else {
        while (delta < 0 && r.steps.length - 1 > cur && r.steps.at(-1).d <= -delta) { delta += r.steps.at(-1).d; delete r.ov[r.steps.length - 1]; r.steps.pop(); }
        const last = r.steps.at(-1), floor = r.steps.length - 1 === cur ? Math.ceil(into) : 1; last.d = Math.max(floor, last.d + delta);
      }
      const old = r.total; r.retime(); desc = `duration total ${fmtT(old)} -> ${fmtT(r.total)}`;
    } else if (op === 'duration' || op === 'extend') {
      const i = index(op === 'duration' ? (e.step ?? 'cur') : 'cur', 'step'), s = r.steps[i];
      let d = op === 'duration' ? +e.seconds : s.d + +e.seconds; d = Math.max(1, Math.min(14400, d)); if (i === cur) d = Math.max(d, Math.ceil(into));
      desc = `duration step ${i + 1} ${fmtT(s.d)} -> ${fmtT(d)}`; s.d = d;
    } else throw new Error('edit.op must be insert, replace, delete, duration, extend or total');
    r.retime(); r.text = toText(r.plainSteps());
    this.log(`EDIT ${desc} | ${r.steps.length} steps, ${fmtT(r.total)}`);
    this.applyTarget(); this.save(); this.bump();
    return { op, detail: desc, steps: r.steps.length, total_s: r.total };
  }

  // ---------- tick ----------
  simStep() {
    const h = this.hub, d = h.r, want = h.wantCmd || {};
    this.simT++;
    const tgt = want.k === 'erg' ? want.w : want.k === 'res' ? 60 + (want.r || 0) * 12 : 150 + (want.g || 0) * 25;
    d.power = Math.max(0, jsr(d.power + (tgt - d.power) * 0.5 + (Math.random() - 0.5) * 18));
    d.cadence = jsr(88 + Math.sin(this.simT / 40) * 4 + (Math.random() - 0.5) * 3);
    d.speed = +(Math.cbrt(d.power / 0.0055) * 0.1 * 3.6 / 1.6).toFixed(1);
    const ftp = this.ride?.ftp || this.settings().ftp || 200, hrT = 95 + d.power / ftp * 70;
    d.hr = jsr((d.hr || 90) + (hrT - (d.hr || 90)) * 0.04); d.hrLast = d.last = this.clock();
  }
  hrNow() { const d = this.hub.r; return d.hr && this.clock() - d.hrLast < 5 ? d.hr : 0; }
  tick(dt = 1) {
    const h = this.hub, d = h.r, now = this.clock();
    if (h.mode === 'sim') this.simStep(); else if (now - d.last > 3) { d.power = d.cadence = d.speed = 0; }
    this.pHist = [...this.pHist, d.power].slice(-3);
    const r = this.ride;
    if (r?.started) {
      const pedaling = d.cadence > 0 || d.power > 0;
      if (h.mode !== 'sim') {
        if (!pedaling) { if (++r.idle >= 3 && !r.paused) r.paused = r.auto = true; }
        else { r.idle = 0; if (r.auto) r.paused = r.auto = false; }
      } else if (r.auto) r.paused = r.auto = false;  // the simulated rider always pedals (e.g. after a resume)
      if (!r.paused) {
        r.el += dt;
        r.samples.push([this.wall(), +r.el.toFixed(1), jsr(d.power), jsr(d.cadence), this.hrNow(), +(+d.speed).toFixed(2), this.curTarget() || 0]);
        this.coachTick();
        if (r.steps && r.el >= r.total && !r.overtime) {
          r.overtime = true;
          if (r.acc?.p.length) this.log(lineStepEnd(r.acc));
          r.acc = null; r.lastStep = -1;
          this.log(`WORKOUT DONE at T+${fmtT(r.el)}, riding free until End`);
          this.notice = 'Workout done. Keep riding or press End ride.'; this.save();
        }
      }
      if (r.paused !== r.pp) { r.pp = r.paused; this.log(r.paused ? (r.auto ? 'PAUSED (stopped pedaling)' : 'PAUSED') : 'RESUMED'); }
      this.applyTarget();
    }
    this.bump();
  }
  coachTick() {
    const r = this.ride; if (!r.steps) return;
    const x = r.samples.at(-1), at = stepAt({ steps: r.steps }, r.el); if (!at) return;
    if (at.i !== r.lastStep) {
      if (r.acc?.p.length) this.log(lineStepEnd(r.acc));
      r.acc = { i: at.i, p: [], h: [], c: [], tg: [] }; r.lastStep = at.i; r.lastLine = r.el;
      this.log(lineStepStart(at.i, r.steps.length, at.s.d, this.curTarget()));
    }
    r.acc.p.push(x[2]); if (x[4]) r.acc.h.push(x[4]); r.acc.c.push(x[3]); r.acc.tg.push(x[6]);
    if (r.el - r.lastLine >= 30) { r.lastLine = r.el; this.log(lineTick(r.el, at.i, r.steps.length, at.into, at.s.d, this.curTarget(), r.samples.slice(-30), r.acc.p)); }
  }

  // ---------- state (same shape as the server's) ----------
  state(athlete, extra = {}) {
    const d = this.hub.r, st = { v: 1, source: 'web', ts: this.wall(), athlete, devices: this.hub.status(),
      live: { power: jsr(d.power), power_3s: this.pHist.length ? jsr(mean(this.pHist)) : 0, cadence: jsr(d.cadence), hr: this.hrNow() || null, speed_kmh: +(+d.speed).toFixed(1) },
      ride: null, messages: this.messages.slice(-3), said: [], last_finished: this.lastFinished, last_saved: this.lastSaved, notice: this.notice, version: this.version, ...extra };
    const r = this.ride; if (!r) return st;
    const l30 = r.samples.slice(-30), h = l30.map(x => x[4]).filter(Boolean), kk = r.test ? 1 : r.k;
    const ride = st.ride = { id: r.id, name: r.name, text: r.text, mode: r.steps ? 'workout' : { w: 'erg', r: 'resistance' }[r.jr.m] || 'grade',
      started: r.started, paused: r.paused, auto_paused: r.auto, elapsed_s: jsr(r.el), el: r.el, ftp: r.ftp, intensity: r.k, test: r.test,
      target_w: this.curTarget(), grade: r.steps ? null : r.jr.g, level: r.steps ? null : r.jr.r, overtime: r.overtime,
      after_workout: this.settings().afterWorkout || 'hold', agent: { wakes: r.agentWakes, local_cues: r.localCues, usage: r.usage, seen: r.agentSeen },
      jr: r.jr, samples: r.samples.length, ov: Object.fromEntries(Object.entries(r.ov)),
      last30: { power: jsr(mean(l30.map(x => x[2]))), cadence: jsr(mean(l30.map(x => x[3]))), hr: h.at(-1) || null, hr_delta: h.length ? h.at(-1) - h[0] : null },
      total_s: null, step: null, steps: null };
    if (r.steps) {
      const at = stepAt({ steps: r.steps }, r.el); ride.total_s = r.total;
      if (at) ride.step = { index: at.i + 1, count: r.steps.length, duration_s: at.s.d, into_s: jsr(at.into), left_s: jsr(at.s.d - at.into), free: !!at.s.free };
      ride.steps = r.steps.map((s, i) => ({ index: i + 1, start_s: s.t0, duration_s: s.d, free: !!s.free, start_w: s.free ? null : stepWatts(s, 0, r.ftp, kk),
        end_w: s.free ? null : stepWatts(s, s.d, r.ftp, kk), planned: s.free ? null : { a: s.a, b: s.b, unit: s.u }, override_w: r.ov[i] ?? null }));
    }
    return st;
  }
  samplesSince(rid, n) { const r = this.ride; if (!r) return [null, []]; return rid !== r.id ? [r.id, r.samples.slice()] : [r.id, r.samples.slice(n)]; }
}
