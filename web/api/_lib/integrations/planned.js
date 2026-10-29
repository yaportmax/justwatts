// Planned workouts -> the app's workout text. JS twin of server/justwatts/integrations/planned.py
// (tests/test_integrations_planned.py runs both on the same fixtures and checks app/js/core.js parses the result).
'use strict';

const OPEN_S = 300, FLAT_MPS = 30 / 3.6;
const ZONE_MID = { 1: 50, 2: 65, 3: 83, 4: 98, 5: 113, 6: 135, 7: 160 };
const r4 = x => Math.round(x * 1e4) / 1e4;
const pct = (a, b = a) => ({ a: r4(a / 100), b: r4(b / 100), u: '%' });
const watts = (a, b = a) => ({ a: Math.round(a), b: Math.round(b), u: 'w' });
const num = x => typeof x === 'number' && Number.isFinite(x);

// same as core.js fmtDurShort / stepText
function fmtDurShort(d) { const m = Math.floor(d / 60), s = d % 60; return m && s ? `${m}m${s}s` : m ? `${m}m` : `${s}s`; }
function stepText(s) {
  if (s.free) return `${fmtDurShort(s.d)} free`;
  const k = s.u === 'w' ? 1 : 100, v = x => +(x * k).toFixed(1);
  return `${fmtDurShort(s.d)} ${v(s.a)}${s.a !== s.b ? '-' + v(s.b) : ''}${s.u === 'w' ? 'w' : '%'}`;
}
function treeText(tree) { return tree.map(x => x.items ? `${x.n}x(${treeText(x.items)})` : stepText(x)).join(', '); }

function simplify(tree) {
  const out = [];
  for (let x of tree) {
    if (x.items) {
      const items = simplify(x.items);
      if (!items.length || x.n < 1) continue;
      if (x.n === 1) { out.push(...items); continue; }
      x = { n: x.n, items };
    } else if (!(x.d > 0)) continue;
    const last = out[out.length - 1];
    if (x.free && last && last.free) out[out.length - 1] = { d: last.d + x.d, free: true };
    else out.push(x);
  }
  return out;
}
const treeSeconds = t => t.reduce((s, x) => s + (x.items ? x.n * treeSeconds(x.items) : x.d), 0);

function finish(tree) {
  tree = simplify(tree);
  if (!tree.length) return null;
  return treeText(tree);
}

// ---------- intervals.icu workout_doc ----------
function icuTarget(st, ftp) {
  if (st.freeride || st.maxeffort) return null;
  const p = st.power;
  if (!p || typeof p !== 'object') return null;
  const units = p.units || '%ftp', lo = p.start, hi = p.end, val = p.value;
  const ramp = !!st.ramp && lo != null && hi != null;
  const span = f => ramp ? f(lo, hi) : (lo != null && hi != null) ? f((lo + hi) / 2) : val != null ? f(val) : null;
  if (units === '%ftp') return span(pct);
  if (units === 'w') return span(watts);
  if (units === 'power_zone') { const z = val != null ? val : lo; return num(z) && ZONE_MID[Math.trunc(z)] ? pct(ZONE_MID[Math.trunc(z)]) : null; }
  const rp = st._power;
  if (rp && typeof rp === 'object') {
    let rlo = rp.start, rhi = rp.end; let t;
    if (ramp && rlo != null && rhi != null) {
      if (lo != null && hi != null && (hi - lo) * (rhi - rlo) < 0) [rlo, rhi] = [rhi, rlo];
      t = watts(rlo, rhi);
    } else if (rp.value != null) t = watts(rp.value);
    else return null;
    return ftp ? pct(t.a / ftp * 100, t.b / ftp * 100) : t;
  }
  return null;
}

function icuSteps(steps, ftp) {
  const out = [];
  for (const st of steps || []) {
    if (!st || typeof st !== 'object') continue;
    if (Array.isArray(st.steps)) { out.push({ n: Math.trunc(st.reps || 1), items: icuSteps(st.steps, ftp) }); continue; }
    let d = st.duration, target = icuTarget(st, ftp);
    if (!d) { const dist = st.distance || st._distance; d = dist ? Math.round(dist / FLAT_MPS) : OPEN_S; target = null; }
    d = Math.round(d);
    out.push(target ? { d, ...target } : { d, free: true });
  }
  return out;
}

function fromIntervals(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.steps) || !doc.steps.length) return null;
  return finish(icuSteps(doc.steps, doc.ftp));
}

// ---------- TrainingPeaks structure ----------
const LEN_S = { second: 1, minute: 60, hour: 3600 }, LEN_M = { meter: 1, kilometer: 1000, mile: 1609.344 };
function tpLen(len) {
  if (!len || typeof len !== 'object' || !num(len.value)) return [null, false];
  const unit = String(len.unit || '').toLowerCase();
  if (LEN_S[unit]) return [Math.round(len.value * LEN_S[unit]), true];
  if (LEN_M[unit]) return [Math.round(len.value * LEN_M[unit] / FLAT_MPS), false];
  return [null, false];
}
function tpStep(st, metric) {
  const [d, timed] = tpLen(st.length);
  if (st.openDuration || !d) return { d: d || OPEN_S, free: true };
  if (!timed || metric !== 'percentofftp') return { d, free: true };
  const t = (st.targets || []).find(t => t && typeof t === 'object' && !t.unit);
  if (!t || !num(t.minValue)) return { d, free: true };
  return { d, ...pct(num(t.maxValue) ? (t.minValue + t.maxValue) / 2 : t.minValue) };
}
function tpItems(items, metric) {
  const out = [];
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const typ = String(it.type || 'step');
    if (Array.isArray(it.steps)) {
      const ln = it.length || {};
      const n = String(ln.unit || 'repetition') === 'repetition' ? Math.trunc(ln.value || 1) : 1;
      out.push({ n: typ === 'repetition' ? n : 1, items: tpItems(it.steps, metric) });
    } else out.push(tpStep(it, metric));
  }
  return out;
}
function fromTrainingPeaks(structure) {
  if (typeof structure === 'string') { try { structure = JSON.parse(structure); } catch { return null; } }
  if (!structure || typeof structure !== 'object' || !Array.isArray(structure.structure) || !structure.structure.length) return null;
  const metric = String(structure.primaryIntensityMetric || 'percentOfFtp').toLowerCase();
  return finish(tpItems(structure.structure, metric));
}

const freeFor = s => (s && s > 0 ? `${Math.max(1, Math.round(s / 60))}m free` : null);

module.exports = { fromIntervals, fromTrainingPeaks, freeFor, treeText, stepText, simplify, treeSeconds };
