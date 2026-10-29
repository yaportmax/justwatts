// In-page ride engine for the web build: a port of server/justwatts/engine.py.
// Same state shape, controls, mid-ride edits, overtime and persistence semantics;
// persistence goes to IndexedDB (snapshot every 30 s + a sample journal every 5 s, see backend.js).
import { parseWorkout, toText, stepAt, stepWatts, fmtT, lineRideStart, lineRideEnd, lineStepStart, lineStepEnd } from '../core.js';
import { G_MIN, G_MAX, checkRideCourse, eleAt, gradeAt, massOf, profileOf, ridden, roadExtend, speedStep } from '../course.js';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const jsr = Math.round;
const r1 = x => Math.floor(x * 10 + 0.5) / 10;

export class Ride {
  constructor(name, text, test, ftp) {
    Object.assign(this, { name, text, test, ftp, steps: null, total: 0, el: 0, started: false, paused: false, auto: false, pp: false, idle: 0, k: 1,
      samples: [], jr: { m: 'g', g: 0, w: jsr(ftp * 0.6), r: 5, wm: 'e' }, startTs: null, ov: {}, lastStep: -1, acc: null, events: [], overtime: false,
      // course: cs = {d: metres ridden, v: virtual speed m/s, up: metres climbed, end}; sg/st: grade rate limit
      course: null, cs: { d: 0, v: 0, up: 0, end: false }, prof: null, sg: null, st: -1e9 });
    if (text) { this.steps = parseWorkout(text); this.retime(); }
  }
  setCourse(c) { this.course = c; this.prof = c ? profileOf(c) : null; }
  resumeCourse() {  // position from the last recorded sample (the journal is newer than the snapshot's cs)
    const s = this.samples.filter(x => x.length > 8); if (!s.length) return;
    let up = Math.max(0, s[0][7] - this.course.ele[0]); for (let i = 1; i < s.length; i++) up += Math.max(0, s[i][7] - s[i - 1][7]);
    Object.assign(this.cs, { d: s.at(-1)[8], v: s.at(-1)[5] / 3.6, up, end: !this.course.open && !!(this.cs.end || s.at(-1)[8] >= this.course.dist) });
  }
  get id() { return `r-${this.startTs || 0}`; }
  retime() { let t = 0; for (const s of this.steps || []) { s.t0 = t; t += s.d; } this.total = t; }
  plainSteps() { return this.steps ? this.steps.map(({ t0, ...s }) => s) : null; }
  applyOverride(i, w) {
    const s = this.steps?.[i]; if (!s || s.free) return false;
    [s.a, s.b] = Array.isArray(w) ? w : [w, w]; s.u = 'w'; this.ov[i] = w; return true;  // [start, end] keeps a ramp's shape
  }
  payload() {
    return { id: this.id, name: this.name, text: this.text, steps: this.plainSteps(), test: this.test, ftp: this.ftp, events: this.events,
      overtime: this.overtime, start: this.startTs, samples: this.samples, el: this.el, k: this.k, jr: this.jr, ov: Object.fromEntries(Object.entries(this.ov)), source: 'web',
      course: this.course, cs: this.cs };
  }
}

export class Engine {
  constructor({ hub, logEvent, settings, save, archive, clock = () => performance.now() / 1000, wall = () => Date.now() }) {
    Object.assign(this, { hub, logEvent, settings, saveFn: save, archiveFn: archive, clock, wall });
    this.ride = null; this.pHist = []; this.lastFinished = null; this.lastSaved = null; this._notice = null; this.noticeId = 0;
    this.version = 0; this.simT = 0; this.listeners = new Set(); this.onFinish = null;
  }
  get notice() { return this._notice; }
  set notice(t) { if (t && t !== this._notice) this.noticeId = Math.max(this.noticeId + 1, Date.now()); this._notice = t; }
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
    if (cur.course) { try { r.setCourse(checkRideCourse(cur.course)); r.cs = { ...r.cs, ...(cur.cs || {}) }; r.resumeCourse(); } catch {} }
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
  // what the trainer follows and +/- changes: k (ERG at plan x intensity), w (ERG watts), g (grade), r (level)
  controlMode() {
    const r = this.ride; if (!r) return null;
    if (!r.steps) return r.jr.m;
    const wm = r.jr.wm || 'e'; if (wm === 'g' || wm === 'r') return wm;
    return this.curTarget() != null ? 'k' : 'g';
  }
  applyTarget() {
    const r = this.ride; if (!r) return;
    const m = this.controlMode();
    this.hub.want(m === 'k' ? { k: 'erg', w: this.curTarget() } : m === 'w' ? { k: 'erg', w: r.jr.w } : m === 'r' ? { k: 'res', r: r.jr.r } : { k: 'sim', g: r.course ? this.courseGrade() : r.jr.g });
  }
  // grade sent on a course: the road under the rider plus the +/- offset (jr.g); after the finish the last grade,
  // or 0 % with afterWorkout grade0. Rate limited: over 0.1 % at once, smaller changes at most every 2 s.
  courseGrade() {
    const r = this.ride, base = r.cs.end && (this.settings().afterWorkout || 'hold') !== 'hold' ? 0 : gradeAt(r.course, r.cs.d);
    const want = r1(Math.min(G_MAX, Math.max(G_MIN, base + r.jr.g)));
    if (r.sg == null || Math.abs(want - r.sg) > 0.1 + 1e-9 || r.el - r.st >= 2) { r.sg = want; r.st = r.el; }
    return r.sg;
  }

  // ---------- controls ----------
  control(action, body = {}) {
    const fn = { load: this.load, start: this.start, pause: this.togglePause, hold: this.hold, resume: this.resumeRide, skip: this.skip, back: this.back, end: this.finish,
      adjust: this.adjust, mode: this.setMode, intensity: this.setIntensity, free: this.setFree, target: this.setTarget, save: this.saveCopy,
      dismiss: () => { this.notice = null; }, edit: b => this.edit(b.edit || {}), road: this.road }[action];
    if (!fn) throw new Error(`unknown action ${action}`);
    this.did = null;
    let res = fn.call(this, body) || {};
    if (this.did) res = { ...res, did: this.did };   // the page confirms exactly what changed
    this.save(); this.bump(); return res;
  }
  // a target or plan change by the rider: logged as a MANUAL line
  changed(what) {
    if (!this.ride) return;
    this.did = what; this.log(`MANUAL ${what}`);
  }
  jrText(m) { const v = this.ride.jr[m]; return m === 'g' ? `grade ${(+v).toFixed(1)}%` : m === 'r' ? `level ${(+v).toFixed(1)}` : `erg ${v}W`; }
  // {workout, course}: a course alone is a free ride on it; with a workout, ERG segments keep their watts
  // and free segments ride the course grade
  load(body) {
    const w = body.workout, c = body.course ? checkRideCourse(body.course) : null;
    if (this.ride?.started) this.finish();
    const ftp = +(this.settings().ftp || 200);
    const r = w ? new Ride(w.name, w.text, !!w.test, ftp) : new Ride(c ? c.name : 'Just ride', '', false, ftp);
    r.setCourse(c); this.ride = r;
    this.notice = null; this.applyTarget(); return { loaded: this.ride.name };
  }
  // open world: the page extends the road ahead ({at, ele, ll, nd}, see course.js roadExtend)
  road(b) {
    const r = this.ride; if (!r?.course) throw new Error('no open-world ride');
    r.setCourse(roadExtend(r.course, b, r.cs.d)); return { n: r.course.ele.length };
  }
  start() {
    const r = this.ride; if (!r || r.started) return;
    r.started = true; r.startTs = this.wall(); r.pp = false;
    this.log(lineRideStart(r.name, r.ftp, r.steps ? { steps: r.steps, total: r.total } : null));
    if (this.hub.mode === 'ble' && !(this.hub.r.cadence > 0 || this.hub.r.power > 0)) r.paused = r.auto = true;
  }
  togglePause() { const r = this.ride; if (!r) return; if (!r.started) return this.start(); r.paused = !r.paused; r.auto = false; }
  hold() {  // during an auto-pause it makes the pause stick: pedaling no longer resumes
    const r = this.ride; if (!r?.started || (r.paused && !r.auto)) return;
    if (r.paused && r.pp) this.log('PAUSED');
    r.paused = true; r.auto = false;
  }
  resumeRide() { const r = this.ride; if (!r) return; if (!r.started) return this.start(); r.paused = r.auto = false; }
  skip() {
    const r = this.ride; if (!r?.steps) return; const at = stepAt({ steps: r.steps }, r.el);
    if (!at) return;  // the rest of the step leaves the plan, so ride time and plan time stay the same clock
    if (at.into >= 1) at.s.d = Math.max(1, Math.ceil(at.into));
    else { r.steps.splice(at.i, 1); const ov = {}; for (const [k, v] of Object.entries(r.ov)) if (+k !== at.i) ov[+k > at.i ? +k - 1 : k] = v; r.ov = ov; }
    r.retime(); if (at.into >= 1) r.el = Math.max(r.el, at.s.t0 + at.s.d + 0.01);
    this.applyTarget(); this.changed(`skip step ${at.i + 1}`);
  }
  // like a music player's previous button: restart the current step, or in its first 10 s go back to the
  // previous one, by inserting copies now (time only moves forward). After the plan: the last step again.
  back() {
    const r = this.ride; if (!r?.steps) return;
    const copy = ({ t0, ...s }) => ({ ...s }), at = stepAt({ steps: r.steps }, r.el);
    let nw, pos, src;
    if (!at) {
      src = r.steps.length - 1; nw = [copy(r.steps[src])];
      const gap = Math.ceil(r.el - r.total); if (gap > 0) r.steps.push({ d: gap, free: true });
      r.overtime = false; pos = r.steps.length;
    } else {
      const { i, s, into } = at, prev = i > 0 && into < 10; src = prev ? i - 1 : i;
      if (into >= 1) { nw = prev ? [copy(r.steps[i - 1]), copy(s)] : [copy(s)]; s.d = Math.max(1, Math.ceil(into)); pos = i + 1; }
      else if (prev) { nw = [copy(r.steps[i - 1])]; pos = i; r.acc = null; r.lastStep = -1; }
      else return;
    }
    const old = { ...r.ov }; r.steps.splice(pos, 0, ...nw);
    r.ov = {}; for (const [k, v] of Object.entries(old)) r.ov[+k >= pos ? +k + nw.length : +k] = v;
    nw.forEach((_, j) => { if (old[src + j] != null) r.ov[pos + j] = old[src + j]; });
    r.retime(); r.text = toText(r.plainSteps()); this.applyTarget(); this.changed(`back step ${src + 1}`);
  }
  // +/-: intensity 1 % in ERG workouts, else grade 0.5 %, level 0.5 or 5 W; big: five times that
  adjust(body) {
    const r = this.ride; if (!r) return; const d = ((body.dir || 1) > 0 ? 1 : -1) * (body.big ? 5 : 1), m = this.controlMode();
    if (m === 'k') {
      if (r.test) throw new Error('FTP test: intensity is fixed');
      r.k = Math.max(0.5, Math.min(1.5, +(r.k + d * 0.01).toFixed(2))); this.applyTarget(); return this.changed(`intensity ${jsr(r.k * 100)}%`);
    }
    if (m === 'g') r.jr.g = Math.max(-10, Math.min(20, +(r.jr.g + d * 0.5).toFixed(1)));
    else if (m === 'r') r.jr.r = Math.max(0, Math.min(25, +(r.jr.r + d * 0.5).toFixed(1)));
    else r.jr.w = Math.max(30, Math.min(1500, r.jr.w + d * 5));
    this.applyTarget(); this.changed(this.jrText(m));
  }
  setMode(body) {  // free ride: m = g|w|r; workout: m = e (ERG follows the plan), g or r (ERG off)
    const r = this.ride; if (!r) return; let m = body.m;
    if (r.steps) { if (m === 'w') m = 'e'; if (!['e', 'g', 'r'].includes(m)) throw new Error('m must be e (ERG), g (grade) or r (level)'); r.jr.wm = m; }
    else { if (!['g', 'w', 'r'].includes(m)) throw new Error('m must be g (grade), w (ERG watts) or r (level)'); r.jr.m = m; }
    this.applyTarget(); this.changed(`mode ${{ g: 'grade', w: 'erg', r: 'level', e: 'erg' }[m]}`);
  }
  setIntensity(body) {
    const r = this.ride; if (!r) throw new Error('no ride loaded'); if (r.test) throw new Error('FTP test: intensity is fixed');
    const p = +(body.percent ?? 100); if (!(p >= 50 && p <= 150)) throw new Error('percent must be 50..150');
    r.k = +(p / 100).toFixed(2); this.applyTarget(); this.changed(`intensity ${jsr(r.k * 100)}%`);
  }
  setFree(body) {  // in a workout, g and r set the grade or level used with ERG off, in free steps and after the plan
    const r = this.ride; if (!r) throw new Error('no ride loaded');
    const m = body.m; if (!['g', 'w', 'r'].includes(m)) throw new Error('m must be g, w or r');
    if (r.steps && m === 'w') throw new Error('in a workout, set watts with the target action');
    const v = body.value != null ? +body.value : r.jr[m], lim = { g: [-10, 20], w: [30, 1500], r: [0, 25] }[m];
    if (!(v >= lim[0] && v <= lim[1])) throw new Error(`value out of range ${lim[0]}..${lim[1]}`);
    if (!r.steps) r.jr.m = m;
    r.jr[m] = m === 'w' ? jsr(v) : +v.toFixed(1); this.applyTarget(); this.changed(this.jrText(m));
  }
  // a step's target in watts as the trainer gets it now ({w} or {delta}, step 1-based or the current one)
  setTarget(body) {
    const r = this.ride; if (!r) throw new Error('no ride loaded');
    if (!r.steps) { const w = body.w != null ? +body.w : r.jr.w + +(body.delta || 0); return this.setFree({ m: 'w', value: Math.min(1500, Math.max(30, w)) }); }
    const at = stepAt({ steps: r.steps }, r.el), step = body.step ?? 'cur'; let idx;
    if (step === 'cur') { if (!at) throw new Error('workout finished'); idx = at.i; }
    else { idx = +step - 1; if (!at || !(idx >= at.i && idx < r.steps.length)) throw new Error(`step ${step} is not the current or an upcoming step`); }
    const s = r.steps[idx]; if (s.free) throw new Error('free step: no ERG target');
    const kk = r.test ? 1 : r.k, now = idx === at.i ? this.curTarget() : stepWatts(s, 0, r.ftp, kk);
    let w = body.w != null ? +body.w : (now || 0) + +(body.delta || 0); w = Math.max(0, Math.min(2000, jsr(w)));
    if (s.a !== s.b && now) { const plan = x => s.u === 'w' ? x : x * r.ftp, d = (w - now) / kk; r.applyOverride(idx, [Math.max(0, jsr(plan(s.a) + d)), Math.max(0, jsr(plan(s.b) + d))]); }
    else r.applyOverride(idx, jsr(w / kk));
    this.applyTarget(); this.changed(`target step ${idx + 1} ${w}W`); return { step: idx + 1, w };
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
    if (r.course?.open) r.course = ridden(r.course, r.cs.d);
    if (r.samples.length < 10) { this.notice = 'Ride too short, not saved'; this.lastFinished = null; return { saved: false }; }
    const p = r.payload(); this.archiveFn(p);
    this.lastFinished = { id: p.id, name: r.name, samples: r.samples.length, ts: this.wall() };
    this.onFinish?.(p);
    return { saved: true, id: p.id };
  }

  // ---------- edits ----------
  edit(e) {
    const r = this.ride; if (!r?.steps) throw new Error('no structured workout loaded');
    let at = stepAt({ steps: r.steps }, r.el), cur, into;
    const parse = t => { try { return parseWorkout(String(t || '')); } catch (err) { throw new Error('bad steps: ' + err.message); } };
    if (!at && (e.op === 'insert' || e.op === 'rest')) {
      if (!String(e.steps || '').trim()) throw new Error('nothing to add');
      parse(e.steps);  // check before anything changes
      const gap = Math.ceil(r.el - r.total); if (gap > 0) { r.steps.push({ d: gap, free: true }); r.retime(); }
      r.overtime = false; cur = r.steps.length; into = 0; e = { ...e, after: r.steps.length };
    } else { cur = at ? at.i : r.steps.length; into = at ? at.into : 0; }
    const index = (v, name) => {
      if (v === 'cur' || v == null) { if (!at) throw new Error('workout already finished'); return cur; }
      const i = +v - 1; if (!(i >= 0 && i < r.steps.length)) throw new Error(`${name} ${v} out of range 1..${r.steps.length}`);
      if (i < cur && !(name === 'after step' && i === cur - 1 && !at)) throw new Error(`${name} ${v} is already done (current step ${cur + 1})`);
      return i;
    };
    const remap = (f, drop) => { const o = {}; for (const [k, v] of Object.entries(r.ov)) { if (+k === drop) continue; o[f(+k)] = v; } r.ov = o; };
    let desc; const op = e.op;
    if (op === 'insert') {
      const nw = parse(e.steps), after = index(e.after ?? 'cur', 'after step'), pos = after + 1;
      r.steps.splice(pos, 0, ...nw); remap(k => k >= pos ? k + nw.length : k); desc = `insert ${nw.length} after step ${after + 1}: ${toText(nw)}`;
    } else if (op === 'replace') {
      const i = index(e.step ?? 'cur', 'step'), nw = parse(e.steps);
      if (i === cur && into >= 1) { r.steps[i].d = Math.max(1, Math.ceil(into)); r.steps.splice(i + 1, 0, ...nw); remap(k => k > i ? k + nw.length : k); }
      else { if (i === cur) { r.acc = null; r.lastStep = -1; } r.steps.splice(i, 1, ...nw); remap(k => k > i ? k + nw.length - 1 : k, i); }
      desc = `replace step ${i + 1} with ${nw.length}: ${toText(nw)}`;
    } else if (op === 'delete') {
      const i = index(e.step, 'step');
      if (i === cur && (into >= 1 || r.steps.length === 1)) { r.steps[i].d = Math.max(1, Math.ceil(into)); desc = `end step ${i + 1} now`; }
      else { if (i === cur) { r.acc = null; r.lastStep = -1; } r.steps.splice(i, 1); remap(k => k > i ? k - 1 : k, i); desc = `delete step ${i + 1}`; }
    } else if (op === 'total') {
      if (!at) throw new Error('workout finished: insert steps instead');
      let want = Math.max(+e.seconds, Math.ceil(r.el)), delta = want - r.total;
      if (e.how === 'scale' && delta) {
        const left = []; for (let i = cur; i < r.steps.length; i++) left.push([i, r.steps[i].d - (i === cur ? into : 0)]);
        const rem = left.reduce((a, [, d]) => a + d, 0) || 1;
        for (const [i, d] of left) { const base = i === cur ? into : 0; r.steps[i].d = Math.max(i !== cur ? 1 : Math.ceil(into), jsr(base + d * (rem + delta) / rem)); }
      } else {
        while (delta < 0 && r.steps.length - 1 > cur && r.steps.at(-1).d <= -delta) { delta += r.steps.at(-1).d; delete r.ov[r.steps.length - 1]; r.steps.pop(); }
        const last = r.steps.at(-1), floor = r.steps.length - 1 === cur ? Math.max(1, Math.ceil(into)) : 1; last.d = Math.max(floor, last.d + delta);
      }
      const old = r.total; r.retime(); desc = `duration total ${fmtT(old)} -> ${fmtT(r.total)}`;
    } else if (op === 'rest') {  // replace everything after the current step (the rider's "next steps" box)
      const text = String(e.steps || '').trim(); let nw = text ? parse(text) : [], keep = at ? cur : r.steps.length - 1;
      if (e.after != null && +e.after - 1 !== keep) throw new Error('the step changed; check the next steps and apply again');
      if (e.with_current && at && nw.length) {  // nw[0] is the current step as edited: what was ridden stays, the rest follows the edit
        const s = r.steps[cur], first = { ...nw[0] }, ridden = Math.ceil(into);
        if (ridden < 1) { keep = cur - 1; r.acc = null; r.lastStep = -1; }
        else {
          if (!s.free && s.a !== s.b) s.b = s.a + (s.b - s.a) * Math.min(1, ridden / s.d);
          s.d = ridden;
          if (first.d > ridden) { if (!first.free && first.a !== first.b) first.a = first.a + (first.b - first.a) * ridden / first.d; first.d -= ridden; nw = [first, ...nw.slice(1)]; }
          else nw = nw.slice(1);
        }
      }
      r.steps.splice(keep + 1, r.steps.length, ...nw);
      for (const k of Object.keys(r.ov)) if (+k > keep) delete r.ov[k];
      desc = `rest after step ${keep + 1}: ${toText(nw) || 'none'}`;
    } else if (op === 'duration' || op === 'extend') {
      const i = index(op === 'duration' ? (e.step ?? 'cur') : 'cur', 'step'), s = r.steps[i];
      let d = op === 'duration' ? +e.seconds : s.d + +e.seconds; d = Math.max(1, Math.min(14400, d)); if (i === cur) d = Math.max(d, Math.ceil(into));
      desc = `duration step ${i + 1} ${fmtT(s.d)} -> ${fmtT(d)}`; s.d = d;
    } else throw new Error('edit.op must be insert, replace, delete, duration, extend, total or rest');
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
      const pedaling = d.cadence > 0 || d.power > 0 || (!!r.course && r.cs.v > 0.5);  // coasting downhill on a course still moves
      if (h.mode !== 'sim') {
        if (!pedaling) { if (++r.idle >= 3 && !r.paused) r.paused = r.auto = true; }
        else { r.idle = 0; if (r.auto) r.paused = r.auto = false; }
      } else if (r.auto) r.paused = r.auto = false;  // the simulated rider always pedals (e.g. after a resume)
      if (!r.paused) {
        r.el += dt;
        this.courseTick(dt);
        const x = [this.wall(), +r.el.toFixed(1), jsr(d.power), jsr(d.cadence), this.hrNow(), +(+d.speed).toFixed(2), this.curTarget() || 0];
        if (r.course) { x[5] = Math.floor(r.cs.v * 360 + 0.5) / 100; x.push(r1(eleAt(r.course, r.cs.d)), r1(r.cs.d)); }  // virtual speed, altitude, distance
        r.samples.push(x);
        this.stepTick();
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
  // move along the course at the speed the rider's power gives on the road under them
  courseTick(dt) {
    const r = this.ride, c = r.course, cs = r.cs; if (!c) return;
    cs.v = speedStep(cs.v, this.hub.r.power, gradeAt(c, cs.d), massOf(+this.settings().weight), dt);
    const e0 = eleAt(c, cs.d); cs.d += cs.v * dt;
    if (c.open) cs.d = Math.min(cs.d, c.dist);  // open world: wait at the end of the known road until the page adds more
    cs.up += Math.max(0, eleAt(c, cs.d) - e0);
    if (cs.d >= c.dist && !cs.end && !c.open) {
      cs.end = true; this.log(`COURSE DONE at T+${fmtT(r.el)}, riding on until End`);
      this.notice = 'Course done. Keep riding or press End ride.';
    }
  }
  // START/END lines per step, with the step's averages
  stepTick() {
    const r = this.ride; if (!r.steps) return;
    const x = r.samples.at(-1), at = stepAt({ steps: r.steps }, r.el); if (!at) return;
    if (at.i !== r.lastStep) {
      if (r.acc?.p.length) this.log(lineStepEnd(r.acc));
      r.acc = { i: at.i, p: [], h: [], c: [], tg: [] }; r.lastStep = at.i;
      this.log(lineStepStart(at.i, r.steps.length, at.s.d, this.curTarget()));
    }
    r.acc.p.push(x[2]); if (x[4]) r.acc.h.push(x[4]); r.acc.c.push(x[3]); r.acc.tg.push(x[6]);
  }

  // ---------- state (same shape as the server's) ----------
  state(athlete) {
    const d = this.hub.r, st = { v: 1, source: 'web', ts: this.wall(), athlete, devices: this.hub.status(),
      live: { power: jsr(d.power), power_3s: this.pHist.length ? jsr(mean(this.pHist)) : 0, cadence: jsr(d.cadence), hr: this.hrNow() || null, speed_kmh: +(+d.speed).toFixed(1) },
      ride: null, last_finished: this.lastFinished, last_saved: this.lastSaved, notice: this.notice, notice_id: this.noticeId, version: this.version };
    const r = this.ride; if (!r) return st;
    const l30 = r.samples.slice(-30), h = l30.map(x => x[4]).filter(Boolean), kk = r.test ? 1 : r.k;
    const ride = st.ride = { id: r.id, name: r.name, text: r.text, mode: r.steps ? 'workout' : { w: 'erg', r: 'resistance' }[r.jr.m] || 'grade',
      started: r.started, paused: r.paused, auto_paused: r.auto, elapsed_s: jsr(r.el), el: r.el, ftp: r.ftp, intensity: r.k, test: r.test,
      target_w: this.curTarget(), grade: r.steps ? null : r.jr.g, level: r.steps ? null : r.jr.r, overtime: r.overtime,
      after_workout: this.settings().afterWorkout || 'hold',
      jr: r.jr, samples: r.samples.length, control: this.controlMode(), ov: Object.fromEntries(Object.entries(r.ov)),
      last30: { power: jsr(mean(l30.map(x => x[2]))), cadence: jsr(mean(l30.map(x => x[3]))), hr: h.at(-1) || null, hr_delta: h.length ? h.at(-1) - h[0] : null },
      total_s: null, step: null, steps: null, course: null };
    if (r.course) {
      const c = r.course, cs = r.cs;
      ride.course = { name: c.name, dist_m: c.dist, gain_m: c.gain, done_m: r1(Math.min(cs.d, c.dist)), odo_m: r1(cs.d), ele_m: r1(eleAt(c, cs.d)),
        climbed_m: r1(cs.up), grade: gradeAt(c, cs.d), speed_kmh: r1(cs.v * 3.6), end: cs.end, profile: r.prof, open: !!c.open, n: c.ele.length };
    }
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
