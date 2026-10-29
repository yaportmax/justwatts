// Pure logic shared by the browser app and the node test harness. No DOM, no globals.
'use strict';
import { track } from './course.js';

export function fmtT(s) {
  s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/* ---------- zones ---------- */
export const ZONES = [[0.55, '--z1', 'Z1'], [0.76, '--z2', 'Z2'], [0.91, '--z3', 'Z3'], [1.06, '--z4', 'Z4'], [1.21, '--z5', 'Z5'], [Infinity, '--z6', 'Z6']];
export const zoneIdx = f => ZONES.findIndex(z => f < z[0]);
// heart rate zones: zones = lower bpm of Z1..Z5
export const HRZ_COLORS = ['--z1', '--z2', '--z3', '--z5', '--z6'];
export function hrZone(h, zones) {
  if (!zones || !(h > 0)) return -1;
  let i = -1; zones.forEach((f, k) => { if (h >= f) i = k; }); return i;
}
// Active zones: manual or Garmin floors when set, else 50/60/70/80/90% of max HR (185 when unset).
// Mirrored by history.active_hr_zones.
export const HR_MAX_DEFAULT = 185, HRZ_PCT = [50, 60, 70, 80, 90];
const validMax = m => Number.isFinite(m) && m >= 100 && m <= 230;
export const validHrFloors = z => Array.isArray(z) && z.length === 5 && z.every((x, i) => Number.isFinite(x) && x > 30 && x < 230 && (!i || x > z[i - 1]));
export const defaultHrFloors = max => HRZ_PCT.map(p => Math.round(max * p / 100));
export function activeHrZones(s) {
  const src = s?.hrZonesSrc, set = validMax(+s?.hrMax) ? +s.hrMax : null;
  if (src !== 'default' && validHrFloors(s?.hrZones)) return { floors: s.hrZones, max: set, src: src || 'manual' };
  const max = set || HR_MAX_DEFAULT;
  return { floors: defaultHrFloors(max), max, src: 'default' };
}

/* ---------- units (storage is metric: weight kg, distance km) ---------- */
export const LB_PER_KG = 2.20462, MI_PER_KM = 0.621371;
export const isMetric = units => units === 'metric';
export const weightUnit = units => isMetric(units) ? 'kg' : 'lb';
export function weightShow(kg, units) {  // value for the weight input; '' when unset
  if (!(kg > 0)) return '';
  return Math.round((isMetric(units) ? kg : kg * LB_PER_KG) * 10) / 10;
}
export function weightKg(v, units) {  // input value -> kg (2 decimals so 182.3 lb round-trips)
  v = +v; if (!(v > 0)) return 0;
  return Math.round((isMetric(units) ? v : v / LB_PER_KG) * 100) / 100;
}
export const distText = (km, units) => isMetric(units) ? (+km).toFixed(1) + ' km' : (km * MI_PER_KM).toFixed(1) + ' mi';

/* ---------- workout text format ---------- */
// step: {d: sec, a, b, u: '%'|'w'} or {d, free: true}; a/b are fractions of FTP when u === '%'
export function parseDur(str) {
  let t = 0; const re = /(\d+(?:\.\d+)?)\s*(h|min|m|sec|s)/g; let m;
  while ((m = re.exec(str))) t += +m[1] * (m[2] === 'h' ? 3600 : m[2][0] === 'm' ? 60 : 1);
  return Math.round(t);
}
// Workout text <-> tree. A tree node is a step { d, a, b, u } | { d, free: true } or a repeat { n, items }.
// The builder edits the tree; the text stays the stored format.
export function parseTree(src) {
  const s = src.toLowerCase(); let i = 0;
  const DUR = '((?:\\d+(?:\\.\\d+)?\\s*(?:h|min|m|sec|s)(?![a-z])\\s*)+)';  // unit may be followed by digits: 1m30s
  const reRep = /^(\d+)\s*x\s*\(/, reFree = new RegExp('^' + DUR + '\\s*@?\\s*free'),
    reStep = new RegExp('^' + DUR + '\\s*@?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:-\\s*(\\d+(?:\\.\\d+)?))?\\s*(%|w)?');
  const ws = () => { while (i < s.length && /[\s,;]/.test(s[i])) i++; };
  function list(end) {
    const out = [];
    for (;;) { ws(); if (i >= s.length || s[i] === end || s[i] === ')') break; out.push(item()); }
    return out;
  }
  function item() {
    const rest = s.slice(i); let m;
    if ((m = reRep.exec(rest))) {
      i += m[0].length; const items = list(')');
      if (s[i] !== ')') throw new Error('Missing )');
      i++; return { n: +m[1], items };
    }
    if ((m = reFree.exec(rest))) { i += m[0].length; return { d: parseDur(m[1]), free: true }; }
    if ((m = reStep.exec(rest))) {
      i += m[0].length; const u = m[4] || '%';
      let a = +m[2], b = m[3] != null ? +m[3] : a;
      if (u === '%') { a /= 100; b /= 100; }
      const d = parseDur(m[1]);
      if (!d) throw new Error(`Zero duration near "${rest.slice(0, 14)}"`);
      return { d, a, b, u };
    }
    throw new Error(`Can't read "${rest.slice(0, 16).trim()}"`);
  }
  const tree = list(null);
  if (i < s.length) throw new Error('Unexpected )');
  return tree;
}
export function flattenTree(tree) {
  const out = [];
  for (const x of tree) {
    if (x.items) { const inner = flattenTree(x.items); for (let k = 0; k < x.n; k++) out.push(...inner.map(y => ({ ...y }))); }
    else out.push({ ...x });
  }
  return out;
}
// Same order as flattenTree, with the tree path of each step (repeats share the path).
export function flattenPaths(tree, pre = []) {
  const out = [];
  tree.forEach((x, j) => {
    if (x.items) { const inner = flattenPaths(x.items, [...pre, j]); for (let k = 0; k < x.n; k++) out.push(...inner); }
    else out.push([...pre, j]);
  });
  return out;
}
export function treeText(tree) {
  return tree.map(x => x.items ? `${x.n}x(${treeText(x.items)})` : stepText(x)).join(', ');
}
export function parseWorkout(src) {
  const steps = flattenTree(parseTree(src));
  if (!steps.length) throw new Error('Empty workout');
  return steps;
}
export function fmtDurShort(d) { const m = Math.floor(d / 60), s = d % 60; return m && s ? `${m}m${s}s` : m ? `${m}m` : `${s}s`; }
export function stepText(s) {
  if (s.free) return `${fmtDurShort(s.d)} free`;
  const k = s.u === 'w' ? 1 : 100, v = x => +(x * k).toFixed(1);
  return `${fmtDurShort(s.d)} ${v(s.a)}${s.a !== s.b ? '-' + v(s.b) : ''}${s.u === 'w' ? 'w' : '%'}`;
}
export function toText(steps) {
  const tok = steps.map(stepText), out = [];
  for (let i = 0; i < tok.length;) {
    let best = null;
    for (let L = 1; L <= 6 && i + L * 2 <= tok.length; L++) {
      let k = 1; while (tok.slice(i + k * L, i + (k + 1) * L).join() === tok.slice(i, i + L).join()) k++;
      if (k >= 2 && (!best || k * L > best.k * best.L)) best = { k, L };
    }
    if (best) { out.push(`${best.k}x(${tok.slice(i, i + best.L).join(', ')})`); i += best.k * best.L; }
    else out.push(tok[i++]);
  }
  return out.join(', ');
}
export const frac = (x, s, ftp) => s.u === 'w' ? x / ftp : x;
export function compile(w) {
  const steps = parseWorkout(w.text); let t = 0;
  for (const s of steps) { s.t0 = t; t += s.d; }
  return { ...w, steps, total: t };
}
export function stepAt(cw, el) {
  for (let i = 0; i < cw.steps.length; i++) { const s = cw.steps[i]; if (el < s.t0 + s.d) return { i, s, into: el - s.t0 }; }
  return null;
}
export function stepWatts(s, into, ftp, k = 1) {
  if (s.free) return null;
  const x = s.a + (s.b - s.a) * (s.d > 0 ? Math.min(1, into / s.d) : 1);
  return Math.round((s.u === 'w' ? x : x * ftp) * k);
}
export function normPower(p) {
  if (p.length < 30) return p.length ? p.reduce((a, b) => a + b, 0) / p.length : 0;
  let sum = 0, acc = 0, n = 0;
  for (let i = 0; i < p.length; i++) { sum += p[i]; if (i >= 30) sum -= p[i - 30]; if (i >= 29) { acc += (sum / 30) ** 4; n++; } }
  return (acc / n) ** 0.25;
}
export function estimate(cw, ftp) {
  const p = []; for (const s of cw.steps) for (let t = 0; t < s.d; t++) p.push(s.free ? 0.5 * ftp : stepWatts(s, t, ftp));
  const np = normPower(p), IF = np / ftp;
  return { np, IF, tss: p.length * np * IF / (ftp * 3600) * 100 };
}
export function toZwo(cw, ftp) {
  const f = (x, s) => frac(x, s, ftp).toFixed(3);
  const body = cw.steps.map(s => s.free ? `    <FreeRide Duration="${s.d}"/>`
    : s.a === s.b ? `    <SteadyState Duration="${s.d}" Power="${f(s.a, s)}"/>`
    : `    <Ramp Duration="${s.d}" PowerLow="${f(s.a, s)}" PowerHigh="${f(s.b, s)}"/>`).join('\n');
  return `<workout_file>\n  <author>Just Watts</author>\n  <name>${esc(cw.name)}</name>\n  <description>${esc(cw.text)}</description>\n  <sportType>bike</sportType>\n  <tags/>\n  <workout>\n${body}\n  </workout>\n</workout_file>\n`;
}

/* ---------- presets ---------- */
export function rampTestText() { let s = '5m 100w'; for (let w = 100; w <= 600; w += 20) s += `, 1m ${w}w`; return s; }
export const PRESETS = [
  { id: 'p-recovery', name: 'Recovery spin', text: '5m 40-55%, 20m 55%, 5m 55-40%' },
  { id: 'p-endurance', name: 'Endurance hour', text: '10m 45-65%, 45m 68%, 5m 60-45%' },
  { id: 'p-sweetspot', name: 'Sweet spot 3×10', text: '10m 40-75%, 3x(10m 90%, 5m 55%), 5m 50-40%' },
  { id: 'p-threshold', name: 'Threshold 2×20', text: '12m 40-80%, 2x(20m 97%, 5m 50%), 8m 50-40%' },
  { id: 'p-overunder', name: 'Over-unders', text: '10m 45-75%, 3x(4x(2m 95%, 1m 108%), 4m 50%), 6m 50-40%' },
  { id: 'p-vo2', name: 'VO2 5×3', text: '12m 40-75%, 2m 50%, 5x(3m 115%, 3m 50%), 8m 50-40%' },
  { id: 'p-3030', name: '30/30s', text: '10m 45-75%, 2x(10x(30s 130%, 30s 50%), 5m 50%), 6m 50-40%' },
  { id: 'p-pyramid', name: 'Pyramid', text: '10m 45-75%, 1m 100%, 1m 50%, 2m 100%, 2m 50%, 3m 100%, 3m 50%, 4m 100%, 4m 50%, 3m 100%, 3m 50%, 2m 100%, 2m 50%, 1m 100%, 8m 50-40%' },
];
// FTP tests live outside the library. Ramp: FTP = 75% of the best minute. 20 min: FTP = 95% of the 20 min free effort.
export const FTP_TESTS = [
  { id: 't-ramp', kind: 'ramp', name: 'Ramp FTP test', text: rampTestText(), test: true },
  { id: 't-20', kind: '20', name: '20 min FTP test', text: '10m 45-65%, 3x(1m 100%, 1m 50%), 4m 55%, 5m 105%, 10m 50%, 20m free, 10m 50-40%', test: true },
];
export const testKind = steps => steps.some(s => s.free && s.d >= 1200) ? '20' : 'ramp';

/* ---------- ride summary ---------- */
// sample = [epochMs, elapsedS, watts, cadence, hr, speedKmh, targetW] (+ [altitudeM, distanceM] on a course)
const onCourse = s => s.length > 0 && s[s.length - 1].length > 8;
export function summarize(r) {
  const s = r.samples, n = s.length, P = s.map(x => x[2]);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const np = normPower(P), IF = np / r.ftp, hr = s.map(x => x[4]).filter(x => x > 0), cad = s.map(x => x[3]).filter(x => x > 0);
  let dist = 0; if (onCourse(s)) dist = s[n - 1][8]; else for (const x of s) dist += x[5] / 3.6;
  let best60 = 0; if (n >= 60) { let sum = 0; for (let i = 0; i < n; i++) { sum += P[i]; if (i >= 60) sum -= P[i - 60]; if (i >= 59) best60 = Math.max(best60, sum / 60); } }
  const zt = ZONES.map(() => 0); for (const p of P) zt[zoneIdx(p / r.ftp)]++;
  return { dur: n, avgP: avg(P), np, IF, tss: n * np * IF / (r.ftp * 3600) * 100, maxP: Math.max(0, ...P), kJ: P.reduce((a, b) => a + b, 0) / 1000, avgHR: avg(hr), maxHR: Math.max(0, ...hr), avgC: avg(cad), dist, best60, zt, elapsed: n ? (s[n - 1][0] - s[0][0]) / 1000 + 1 : 0 };
}

/* ---------- ride event lines (format documented in docs/PROTOCOL.md) ---------- */
export const lineRideStart = (name, ftp, cw) => `RIDE START ${name} | FTP ${ftp} | ${cw ? cw.steps.length + ' steps, ' + fmtT(cw.total) : 'free'}`;
export const lineRideEnd = el => `RIDE END ${fmtT(el)}`;
export const lineResumed = (el, n) => `RIDE RESUMED after reload at T+${fmtT(el)} (${n} samples kept)`;
export const lineStepStart = (i, n, d, tgt) => `START step ${i + 1}/${n} ${fmtT(d)} @${tgt ?? 'free'}W`;
// a = {i, p: [watts], h: [hr], c: [cadence], tg: [target]}
export function lineStepEnd(a) {
  return `END step ${a.i + 1}: avg ${Math.round(mean(a.p))}W (tgt ${Math.round(mean(a.tg))}) | HR avg ${Math.round(mean(a.h)) || '-'} max ${Math.max(0, ...a.h) || '-'} end ${a.h.at(-1) || '-'} | cad ${Math.round(mean(a.c))}`;
}

/* ---------- FIT encoder ---------- */
export const FIT_EPOCH = 631065600;
const CRC_T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
export function fitCrc(bytes, c = 0) {
  for (const x of bytes) {
    let t = CRC_T[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ CRC_T[x & 0xF];
    t = CRC_T[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ CRC_T[(x >> 4) & 0xF];
  }
  return c;
}
export function fitEncode(r) {
  const ENUM = 0x00, U8 = 0x02, U16 = 0x84, S32 = 0x85, U32 = 0x86, U32Z = 0x8C;
  const SZ = { [ENUM]: 1, [U8]: 1, [U16]: 2, [S32]: 4, [U32]: 4, [U32Z]: 4 }, INV = { [ENUM]: 0xFF, [U8]: 0xFF, [U16]: 0xFFFF, [S32]: 0x7FFFFFFF, [U32]: 0xFFFFFFFF, [U32Z]: 0 };
  const b = [], defs = {};
  const put = (v, n) => { for (let i = 0; i < n; i++) b.push(Math.floor(v / 2 ** (8 * i)) & 255); };
  function def(local, global, fields) { defs[local] = fields; b.push(0x40 | local, 0, 0); put(global, 2); b.push(fields.length); for (const [num, t] of fields) b.push(num, SZ[t], t); }
  function msg(local, vals) { b.push(local); defs[local].forEach(([, t], i) => { let v = vals[i]; if (v == null || !isFinite(v)) v = INV[t]; else if (t === S32) v = Math.max(-0x7FFFFFFF, Math.min(0x7FFFFFFE, Math.round(v))) >>> 0; else v = Math.max(0, Math.min(INV[t] === 0 ? 0xFFFFFFFE : INV[t] - 1, Math.round(v))); put(v, SZ[t]); }); }
  const s = r.samples, m = summarize(r), ts = x => Math.round(x / 1000) - FIT_EPOCH;
  const t0 = ts(s[0][0]), tEnd = ts(s[s.length - 1][0]);
  def(0, 0, [[0, ENUM], [1, U16], [2, U16], [3, U32Z], [4, U32]]);           // file_id
  msg(0, [4, 255, 1, 0x48554221, t0]);
  def(1, 21, [[253, U32], [0, ENUM], [1, ENUM]]);                            // event
  msg(1, [t0, 0, 0]);                                                        // timer start
  const crs = onCourse(s);  // a course ride also records altitude (scale 5, offset 500) and its own distance
  const pos = crs ? track(r.course) : null, semi = x => x * 2 ** 31 / 180;  // and, with a map line, a position
  def(2, 20, [[253, U32], [7, U16], [4, U8], [3, U8], [6, U16], [5, U32], ...(crs ? [[2, U16]] : []), ...(pos ? [[0, S32], [1, S32]] : [])]);  // record
  let dist = 0, prevT = null;
  for (const x of s) {
    const t = ts(x[0]);
    if (prevT != null && t - prevT > 2) { msg(1, [prevT, 0, 4]); msg(1, [t, 0, 0]); }  // pause gap: stop_all, start
    if (t === prevT) continue;
    dist = crs ? x[8] : dist + x[5] / 3.6;
    const at = pos?.(dist);
    msg(2, [t, x[2], x[3], x[4] || null, x[5] / 3.6 * 1000, dist * 100, ...(crs ? [(x[7] + 500) * 5] : []), ...(at ? [semi(at[0]), semi(at[1])] : [])]); prevT = t;
  }
  msg(1, [tEnd, 0, 4]);                                                      // timer stop_all
  const kcal = m.kJ * 1.0;  // ~1 kcal per kJ of mechanical work
  def(3, 19, [[253, U32], [2, U32], [7, U32], [8, U32], [9, U32], [11, U16], [15, U8], [16, U8], [17, U8], [19, U16], [20, U16], [0, ENUM], [1, ENUM], [25, ENUM], [39, ENUM]]);
  msg(3, [tEnd, t0, m.elapsed * 1000, m.dur * 1000, dist * 100, kcal, m.avgHR || null, m.maxHR || null, m.avgC, m.avgP, m.maxP, 9, 1, 2, pos ? 58 : 6]);
  def(4, 18, [[253, U32], [2, U32], [7, U32], [8, U32], [9, U32], [5, ENUM], [6, ENUM], [11, U16], [16, U8], [17, U8], [18, U8], [20, U16], [21, U16], [34, U16], [35, U16], [36, U16], [45, U16], [25, U16], [26, U16], [0, ENUM], [1, ENUM], [28, ENUM]]);
  msg(4, [tEnd, t0, m.elapsed * 1000, m.dur * 1000, dist * 100, 2, pos ? 58 : 6, kcal, m.avgHR || null, m.maxHR || null, m.avgC, m.avgP, m.maxP, m.np, m.tss * 10, m.IF * 1000, r.ftp, 0, 1, 8, 1, 0]);
  def(5, 34, [[253, U32], [0, U32], [1, U16], [2, ENUM], [3, ENUM], [4, ENUM], [5, U32]]);  // activity
  msg(5, [tEnd, m.dur * 1000, 1, 0, 26, 1, tEnd - new Date().getTimezoneOffset() * 60]);
  const H = [14, 0x20, 2132 & 255, 2132 >> 8, b.length & 255, (b.length >> 8) & 255, (b.length >> 16) & 255, (b.length >>> 24) & 255, 0x2E, 0x46, 0x49, 0x54];
  const hc = fitCrc(H); H.push(hc & 255, hc >> 8);
  const all = H.concat(b), c = fitCrc(all); all.push(c & 255, c >> 8);
  return new Uint8Array(all);
}
export function toTcx(r) {
  const s = r.samples, m = summarize(r), iso = x => new Date(x).toISOString().replace(/\.\d+Z$/, 'Z');
  let dist = 0; const crs = onCourse(s), pos = crs ? track(r.course) : null;
  const pts = s.map(x => { dist = crs ? x[8] : dist + x[5] / 3.6; const at = pos?.(dist); return `<Trackpoint><Time>${iso(x[0])}</Time>${at ? `<Position><LatitudeDegrees>${at[0]}</LatitudeDegrees><LongitudeDegrees>${at[1]}</LongitudeDegrees></Position>` : ''}${crs ? `<AltitudeMeters>${(+x[7]).toFixed(1)}</AltitudeMeters>` : ''}<DistanceMeters>${dist.toFixed(1)}</DistanceMeters>${x[4] ? `<HeartRateBpm><Value>${x[4]}</Value></HeartRateBpm>` : ''}<Cadence>${x[3]}</Cadence><Extensions><ns3:TPX><ns3:Speed>${(x[5] / 3.6).toFixed(2)}</ns3:Speed><ns3:Watts>${x[2]}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>`; }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities><Activity Sport="Biking"><Id>${iso(s[0][0])}</Id><Lap StartTime="${iso(s[0][0])}"><TotalTimeSeconds>${m.dur}</TotalTimeSeconds><DistanceMeters>${dist.toFixed(1)}</DistanceMeters><Calories>${Math.round(m.kJ)}</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>
${pts}
</Track></Lap><Notes>${esc(r.name)}</Notes></Activity></Activities></TrainingCenterDatabase>
`;
}

/* ---------- ERG / MRC import (TrainingPeaks, TrainerRoad and others export these) ---------- */
// [COURSE DATA] holds "minutes value" points: the same value at two points is a steady segment, different values a
// ramp. MRC values are % FTP, ERG values watts. -> { name, text } in the workout text format.
export function fromErgMrc(src) {
  const t = String(src || ''), head = /\[COURSE HEADER\]([\s\S]*?)\[END COURSE HEADER\]/i.exec(t)?.[1] || '';
  const data = /\[COURSE DATA\]([\s\S]*?)\[END COURSE DATA\]/i.exec(t)?.[1];
  if (data == null) throw new Error('no [COURSE DATA]');
  const pct = /\bPERCENT\b/i.test(head), u = pct ? '%' : 'w';
  const pts = data.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite));
  if (pts.length < 2) throw new Error('no points');
  const steps = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [m0, v0] = pts[i], [m1, v1] = pts[i + 1], d = Math.round((m1 - m0) * 60);
    if (d <= 0) continue;  // a vertical jump: the next pair starts the new value
    const k = x => pct ? x / 100 : Math.round(x);
    steps.push({ d, a: k(v0), b: k(v1), u });
  }
  if (!steps.length) throw new Error('no steps');
  const name = (/^\s*(?:DESCRIPTION|FILE NAME)\s*=\s*(.+)$/im.exec(head)?.[1] || 'Imported').trim().replace(/\.(erg|mrc)$/i, '').slice(0, 80);
  return { name, text: toText(steps) };
}

