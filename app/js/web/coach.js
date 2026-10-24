// Built-in rule coach for the web build: a port of LocalCoach in server/openspin/agent_gate.py.
import { parseLine } from './lines.js';

const DEFAULTS = { enabled: false, countdown: true, cadence: true, recap: true, recovery: true, auto_adjust: 'no_agent', easier_pct: 5, harder_pct: 3, hr_cap_pct: 5 };
const spokenDur = s => { const m = Math.floor(s / 60), x = s % 60; return m && x ? `${m} minute${m !== 1 ? 's' : ''} ${x} seconds` : m ? `${m} minute${m !== 1 ? 's' : ''}` : `${x} seconds`; };

export class LocalCoach {
  constructor({ settings, say, adjust, agentConnected = () => false }) {
    Object.assign(this, { settings, say, adjust, agentConnected });
    this.ftp = 200; this.countdownDone = new Set(); this.cadLowSince = null; this.lastCadNag = -1e9; this.lastWorkHr = null;
    this.lastSt = null; this.hrOverSince = null; this.hrAdjusted = new Set(); this.cues = 0;
  }
  cfg() { return { ...DEFAULTS, ...(this.settings().localCoach || {}) }; }
  speak(t, imp = false) { this.cues++; this.say(t, imp); }
  mayAdjust(c) { return !!this.adjust && (c.auto_adjust === 'always' || (c.auto_adjust === 'no_agent' && !this.agentConnected())); }
  current() {
    const st = this.lastSt || {}, ride = st.ride || {}, step = ride.step;
    if (!ride.started || !step || step.free || !ride.target_w || ride.test) return null;
    return [st, ride, step];
  }
  onEvent(line) {
    const c = this.cfg(); if (!c.enabled) return;
    const ev = parseLine(line), t = ev.type;
    if (t === 'ride_start') { this.ftp = ev.ftp || this.ftp; this.countdownDone.clear(); this.lastWorkHr = null; this.hrAdjusted.clear(); }
    else if (t === 'feel') this.feel(ev.feel, c);
    else if (t === 'step_start' && c.countdown && ev.target_w) this.speak(`${spokenDur(ev.duration_s)} at ${ev.target_w} watts`);
    else if (t === 'step_end' && ev.target_w) {
      const rel = ev.target_w / (this.ftp || 200);
      if (rel >= 0.88) { this.lastWorkHr = ev.hr_end; if (c.recap) this.speak(`Rep done. ${ev.avg_w} average${ev.hr_max ? `, heart rate ${ev.hr_max} max` : ''}.`); }
      else if (rel < 0.7 && c.recovery && this.lastWorkHr && ev.hr_end) { this.speak(`Recovery heart rate ${ev.hr_end}, down ${this.lastWorkHr - ev.hr_end}.`); this.lastWorkHr = null; }
    }
  }
  feel(f, c) {
    const cur = this.current(); if (!cur || !this.mayAdjust(c) || f === 'good') return;
    const [st, ride, step] = cur, ftp = ride.ftp || this.ftp, tgt = ride.target_w;
    if (f === 'easier') { const nw = Math.max(Math.round(0.3 * ftp), Math.round((tgt - c.easier_pct / 100 * ftp) / 5) * 5); this.adjust(step.index, nw, `Easier: ${nw} watts.`); }
    else {
      const fl = st.athlete?.hr_zones, hr = st.live?.hr || 0;
      if (fl && hr >= fl[4]) { this.speak('Heart rate is in zone 5. Holding the target.'); return; }
      const nw = Math.min(Math.round(1.5 * ftp), Math.round((tgt + c.harder_pct / 100 * ftp) / 5) * 5);
      if (!ride.paused && nw > tgt) this.adjust(step.index, nw, `Harder: ${nw} watts.`);
    }
  }
  observe(st) {
    const c = this.cfg(); this.lastSt = st; if (!c.enabled) return;
    const ride = st.ride; if (!ride?.started || ride.paused) { this.cadLowSince = null; return; }
    const now = ride.elapsed_s || 0;
    // HR cap guard
    const cur = this.current(), ath = st.athlete || {}, hr = st.live?.hr || 0;
    const cap = ath.hr_max ? Math.round(ath.hr_max * 0.95) : ath.hr_zones ? ath.hr_zones[4] : null;
    if (!cur || !cap || !this.mayAdjust(c) || hr < cap) this.hrOverSince = null;
    else {
      this.hrOverSince ??= now;
      const [, r, step] = cur;
      if (now - this.hrOverSince >= 30 && !this.hrAdjusted.has(step.index)) {
        this.hrAdjusted.add(step.index); const ftp = r.ftp || this.ftp;
        const nw = Math.max(Math.round(0.3 * ftp), Math.round((r.target_w - c.hr_cap_pct / 100 * ftp) / 5) * 5);
        this.adjust(step.index, nw, `Heart rate ${hr}. Easing to ${nw} watts.`);
      }
    }
    const step = ride.step, steps = ride.steps || [];
    if (c.countdown && step && step.index < step.count && step.left_s === 10 && !this.countdownDone.has(step.index)) {
      const nx = steps[step.index];
      if (nx && step.duration_s >= 30) { this.countdownDone.add(step.index); this.speak(`10 seconds. Then ${nx.free ? 'free ride' : nx.start_w + ' watts'}.`); }
    }
    const lo = (ath.cadence_range || [85, 95])[0], cad = st.live?.cadence || 0;
    if (c.cadence && cad > 0 && cad < lo) {
      this.cadLowSince ??= now;
      if (now - this.cadLowSince >= 20 && now - this.lastCadNag >= 120) { this.lastCadNag = now; this.speak(`Cadence ${cad}. Spin up.`); }
    } else this.cadLowSince = null;
  }
}
