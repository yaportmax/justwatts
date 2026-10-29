// History analytics for the web build: a port of server/openspin/history.py (detail, laps, trends).
import { summarize, normPower, parseWorkout, stepAt, ZONES, hrZone } from '../core.js';

const jsr = Math.round, WINDOWS = [60, 300, 1200];
export function bestMean(P, w) {
  if (P.length < w) return 0;
  let s = 0; for (let i = 0; i < w; i++) s += P[i];
  let best = s; for (let i = w; i < P.length; i++) { s += P[i] - P[i - w]; if (s > best) best = s; }
  return best / w;
}
export const bestEfforts = P => Object.fromEntries(WINDOWS.map(w => [`${w / 60}m`, P.length >= w ? jsr(bestMean(P, w)) : null]));

export function rideSteps(r) {
  let steps = null;
  if (r.steps) steps = r.steps.map(s => ({ ...s }));
  else if (r.text) {
    try { steps = parseWorkout(r.text); } catch { return null; }
    for (const [i, w] of Object.entries(r.ov || {})) { const s = steps[i]; if (s && !s.free) Object.assign(s, { a: Array.isArray(w) ? w[0] : w, b: Array.isArray(w) ? w[1] : w, u: 'w' }); }
  }
  if (steps) { let t = 0; for (const s of steps) { s.t0 = t; t += s.d; } }
  return steps;
}
export function laps(r) {
  const steps = rideSteps(r), groups = new Map();
  for (const x of r.samples) {
    let i = 0;
    if (steps) { const at = stepAt({ steps }, Math.max(0, x[1] - 0.5)); i = at ? at.i : steps.length; }
    if (!groups.has(i)) groups.set(i, []); groups.get(i).push(x);
  }
  return [...groups.keys()].sort((a, b) => a - b).map(i => {
    const g = groups.get(i), P = g.map(x => x[2]), hr = g.map(x => x[4]).filter(v => v > 0), cad = g.map(x => x[3]).filter(v => v > 0), tg = g.map(x => x[6]).filter(Boolean);
    const st = steps && i < steps.length ? steps[i] : null, avg = a => jsr(a.reduce((x, y) => x + y, 0) / a.length);
    return { index: i + 1, planned_s: st ? st.d : null, time_s: g.length, free: !!(st?.free) || (!!steps && !st), overtime: !!steps && !st,
      target_w: tg.length ? avg(tg) : null, avg_w: avg(P), max_w: Math.max(...P), np: jsr(normPower(P)), avg_hr: hr.length ? avg(hr) : null,
      max_hr: hr.length ? Math.max(...hr) : null, avg_cad: cad.length ? avg(cad) : null, kJ: +(P.reduce((a, b) => a + b, 0) / 1000).toFixed(1), start_s: g[0][1] - 1 };
  });
}
// FTP from a test ride: 95% of the best 20 min when the plan has a 20 min free effort, else 75% of the best minute (ramp)
export function ftpEstimate(r, m, P) {
  if (!r.test) return null;
  let twenty = false; try { twenty = parseWorkout(r.text || '').some(s => s.free && s.d >= 1200); } catch {}
  if (twenty) return P.length >= 1200 ? jsr(bestMean(P, 1200) * 0.95) : null;
  return m.best60 ? jsr(m.best60 * 0.75) : null;
}
// metres climbed on a course ride (sample altitude), null otherwise. Same as history.py _climbed().
function climbed(s) {
  if (!(s.length && s[s.length - 1].length > 8)) return null;
  let up = 0; for (let i = 1; i < s.length; i++) up += Math.max(0, s[i][7] - s[i - 1][7]);
  return jsr(up);
}
export function detail(r, floors, meta = {}) {
  const m = summarize(r), P = r.samples.map(x => x[2]), hz = [0, 0, 0, 0, 0];
  for (const x of r.samples) { const i = hrZone(x[4], floors); if (i >= 0) hz[i]++; }
  const out = { id: r.id, name: r.name, start: r.start, ftp: r.ftp, test: r.test,
    summary: { time_s: m.dur, elapsed_s: jsr(m.elapsed), avg_w: jsr(m.avgP), np: jsr(m.np), max_w: m.maxP, if: +m.IF.toFixed(2), tss: jsr(m.tss), kJ: jsr(m.kJ),
      avg_hr: jsr(m.avgHR) || null, max_hr: m.maxHR || null, avg_cad: jsr(m.avgC), distance_km: +(m.dist / 1000).toFixed(2), elevation_gain_m: climbed(r.samples) },
    best: bestEfforts(P), power_zones_s: Object.fromEntries(ZONES.map((z, i) => [z[2], m.zt[i]])),
    hr_zones_s: floors ? Object.fromEntries(hz.map((t, i) => [`Z${i + 1}`, t])) : null, laps: laps(r), events: r.events || [],
    garmin: null, strava: meta.strava || null, description: meta.description || null, agent: r.agent || { wakes: null, local_cues: null, usage: {} } };
  const est = ftpEstimate(r, m, P); if (est) out.ftp_estimate = est;
  return out;
}
export function metaRow(r, meta = {}) {
  const m = summarize(r), P = r.samples.map(x => x[2]), a = r.agent || {}, u = a.usage || {};
  const tokens = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].reduce((s, k) => s + (u[k] || 0), 0);
  return { id: r.id, name: r.name, start: r.start || r.samples[0]?.[0], samples: r.samples.length, source: r.source, ftp: r.ftp, test: !!r.test,
    time_s: m.dur, avg_w: jsr(m.avgP), np: jsr(m.np), tss: jsr(m.tss), if: +m.IF.toFixed(2), kJ: jsr(m.kJ), avg_hr: jsr(m.avgHR) || null,
    best: bestEfforts(P), ftp_estimate: ftpEstimate(r, m, P), garmin: null, strava: meta.strava || null,
    agent_wakes: a.wakes ?? null, local_cues: a.local_cues ?? null, agent_tokens: tokens || null, agent_cost_usd: u.cost_usd ?? null };
}
const iso = d => d.toISOString().slice(0, 10);
export function trends(rows, weeks = 12, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()), monday = new Date(t - ((t.getDay() + 6) % 7) * 864e5);
  const buckets = [];
  for (let k = weeks - 1; k >= 0; k--) buckets.push({ week: iso(new Date(monday - k * 7 * 864e5 + 12 * 3600e3)), tss: 0, time_s: 0, kJ: 0, rides: 0 });
  const index = Object.fromEntries(buckets.map(b => [b.week, b])), ftpHist = [], best = {};
  for (const r of [...rows].sort((a, b) => (a.start || 0) - (b.start || 0))) {
    if (!r.start) continue;
    const d = new Date(r.start), day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const wk = iso(new Date(day - ((day.getDay() + 6) % 7) * 864e5 + 12 * 3600e3));
    if (index[wk]) { const b = index[wk]; b.tss += r.tss; b.time_s += r.time_s; b.kJ += r.kJ; b.rides++; }
    const f = r.ftp_estimate || r.ftp;
    if (f && (!ftpHist.length || ftpHist.at(-1).ftp !== f)) ftpHist.push({ date: iso(new Date(day.getTime() + 12 * 3600e3)), ftp: f, source: r.ftp_estimate ? 'test' : 'setting', ride: r.id });
    for (const [k, v] of Object.entries(r.best || {})) if (v && v > (best[k]?.w || 0)) best[k] = { w: v, date: iso(new Date(day.getTime() + 12 * 3600e3)), ride: r.id };
  }
  return { weeks: buckets, ftp_history: ftpHist, best };
}
export function summaryText(d, link, coach) {
  const s = d.summary, lines = [];
  if (coach) lines.push(coach.trim(), '');
  lines.push(`NP ${s.np} W | avg ${s.avg_w} W | IF ${s.if.toFixed(2)} | TSS ${s.tss} | ${s.kJ} kJ` + (s.avg_hr ? ` | HR ${s.avg_hr} avg, ${s.max_hr} max` : ''));
  const work = (d.laps || []).filter(l => l.target_w && !l.free && d.ftp && l.target_w >= 0.88 * d.ftp);
  if (work.length) lines.push(`Intervals (${work.length}): ${work.slice(0, 12).map(l => l.avg_w).join(', ')} W`);
  if (link) lines.push(link);
  lines.push('Recorded with OpenSpin');
  return lines.join('\n');
}
