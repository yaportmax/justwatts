// Courses: GPX/TCX import, a compact elevation profile (one point every 10 m), grade lookup and
// virtual speed from power. Pure: no DOM, no globals. server/openspin/course.py mirrors every
// function here; tests/test_course.py checks they agree.
//
// course = { name, dist: metres, gain: metres climbed, ele: [m every STEP_M from 0], ll: [[lat, lon]] }
// ll is a decimated polyline for a mini map (empty for synthetic courses).

export const STEP_M = 10, G_MIN = -15, G_MAX = 20, MAX_M = 500000, MIN_M = 100;
export const PHYS = { crr: 0.004, cda: 0.32, rho: 1.2, eta: 0.97, bike: 9, rider: 75, g: 9.81, vmax: 30 };
const R_EARTH = 6371000, rad = x => x * Math.PI / 180;
const r1 = x => Math.floor(x * 10 + 0.5) / 10;           // 0.1 resolution, half up (same in Python)
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function haversine(a, b) {
  const s1 = Math.sin(rad(b.lat - a.lat) / 2), s2 = Math.sin(rad(b.lon - a.lon) / 2);
  const h = s1 * s1 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * s2 * s2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ---------- import ---------- */
const NUM = '([-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)';
const tag = (name, body) => { const m = new RegExp(`<(?:\\w+:)?${name}>\\s*${NUM}\\s*</(?:\\w+:)?${name}>`).exec(body); return m ? +m[1] : null; };
const attr = (name, s) => { const m = new RegExp(`\\b${name}\\s*=\\s*["']${NUM}["']`).exec(s); return m ? +m[1] : null; };
const xmlText = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

// GPX (trkpt, else rtept) or TCX (Trackpoint with a position). -> { name, pts: [{lat, lon, ele|null}] }
export function parseTrack(text) {
  text = String(text || '');
  const pts = [];
  let name = '';
  if (/<(?:\w+:)?TrainingCenterDatabase\b/.test(text)) {
    for (const m of text.matchAll(/<(?:\w+:)?Trackpoint>([\s\S]*?)<\/(?:\w+:)?Trackpoint>/g)) {
      const lat = tag('LatitudeDegrees', m[1]), lon = tag('LongitudeDegrees', m[1]);
      if (lat != null && lon != null) pts.push({ lat, lon, ele: tag('AltitudeMeters', m[1]) });
    }
    const n = /<(?:\w+:)?(?:Name|Id)>([\s\S]*?)<\/(?:\w+:)?(?:Name|Id)>/.exec(text); if (n) name = xmlText(n[1]);
  } else {
    for (const kind of ['trkpt', 'rtept']) {
      for (const m of text.matchAll(new RegExp(`<(?:\\w+:)?${kind}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${kind}>)`, 'g'))) {
        const lat = attr('lat', m[1]), lon = attr('lon', m[1]);
        if (lat != null && lon != null) pts.push({ lat, lon, ele: m[2] ? tag('ele', m[2]) : null });
      }
      if (pts.length) break;
    }
    const n = /<(?:\w+:)?name>([\s\S]*?)<\/(?:\w+:)?name>/.exec(text); if (n) name = xmlText(n[1]);
  }
  return { name: name.slice(0, 80), pts };
}

/* ---------- profile ---------- */
// median over +-k points, edges use the points that exist (upper median for an even count)
function median(a, k) {
  return a.map((_, i) => { const w = a.slice(Math.max(0, i - k), i + k + 1).sort((x, y) => x - y); return w[Math.floor(w.length / 2)]; });
}
function movingAvg(a, k) {
  return a.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k); j++) { s += a[j]; n++; } return s / n; });
}
export function gainOf(ele) { let g = 0; for (let i = 1; i < ele.length; i++) if (ele[i] > ele[i - 1]) g += ele[i] - ele[i - 1]; return Math.floor(g + 0.5); }

// track points -> compact course. Throws on a track that is too short or too long.
export function buildCourse(name, pts) {
  const P = [], D = [];
  for (const p of pts || []) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    if (P.length) { const s = haversine(P[P.length - 1], p); if (!(s > 0)) continue; D.push(D[D.length - 1] + s); } else D.push(0);
    P.push(p);
  }
  const total = D.length ? D[D.length - 1] : 0;
  if (total < MIN_M) throw new Error('Course too short');
  if (total > MAX_M) throw new Error('Course too long (500 km max)');
  // missing elevation: carry the last known value (the first known one at the start); none at all: flat
  let first = null; for (const p of P) if (Number.isFinite(p.ele)) { first = p.ele; break; }
  const E = []; let last = first ?? 0; for (const p of P) { if (Number.isFinite(p.ele)) last = p.ele; E.push(last); }
  // resample every STEP_M metres
  const n = Math.floor(total / STEP_M) + 1, raw = []; let j = 0;
  for (let i = 0; i < n; i++) {
    const x = i * STEP_M; while (j < D.length - 2 && D[j + 1] < x) j++;
    const f = D[j + 1] > D[j] ? clamp((x - D[j]) / (D[j + 1] - D[j]), 0, 1) : 0;
    raw.push(E[j] + (E[j + 1] - E[j]) * f);
  }
  const ele = movingAvg(median(raw, 2), 4).map(r1);   // 50 m median, then 90 m moving average
  const ll = [], m = Math.min(200, P.length);
  for (let k = 0, q = 0; k < m; k++) {
    const want = m > 1 ? k * total / (m - 1) : 0; while (q < P.length - 1 && D[q] < want) q++;
    ll.push([Math.floor(P[q].lat * 1e5 + 0.5) / 1e5, Math.floor(P[q].lon * 1e5 + 0.5) / 1e5]);
  }
  return { name: String(name || 'Course').slice(0, 80), dist: Math.floor(total + 0.5), gain: gainOf(ele), ele, ll };
}

/* ---------- lookups on a course ---------- */
export function eleAt(c, d) {
  const e = c.ele, x = clamp(d, 0, (e.length - 1) * STEP_M), i = Math.min(e.length - 2, Math.floor(x / STEP_M));
  return e[i] + (e[i + 1] - e[i]) * ((x - i * STEP_M) / STEP_M);
}
// grade (%) of the 10 m segment under position d, clamped, 0.1 resolution. Past the end: the last segment.
export function gradeAt(c, d) {
  const e = c.ele, i = clamp(Math.floor(Math.max(0, d) / STEP_M), 0, e.length - 2);
  return r1(clamp((e[i + 1] - e[i]) / STEP_M * 100, G_MIN, G_MAX));
}
// at most n points for drawing (rounded to 0.1 m)
export function profileOf(c, n = 300) {
  const e = c.ele; if (e.length <= n) return e.slice();
  const out = []; for (let k = 0; k < n; k++) out.push(e[Math.floor(k * (e.length - 1) / (n - 1) + 0.5)]);
  return out;
}

/* ---------- speed from power, with momentum ---------- */
// One tick: integrate kinetic energy in 0.25 s sub-steps. v in m/s, grade in %, mass = rider + bike in kg.
export function speedStep(v, watts, grade, mass, dt) {
  const a = Math.atan(grade / 100), n = Math.max(1, Math.ceil(dt / 0.25 - 1e-9)), h = dt / n, p = Math.max(0, watts) * PHYS.eta;
  const fk = mass * PHYS.g * (PHYS.crr * Math.cos(a) + Math.sin(a)), air = 0.5 * PHYS.rho * PHYS.cda;
  for (let k = 0; k < n; k++) {
    const e = 0.5 * mass * v * v + (p - (fk + air * v * v) * v) * h;
    v = e > 0 ? Math.min(PHYS.vmax, Math.sqrt(2 * e / mass)) : 0;
  }
  return v;
}
export const massOf = weightKg => (weightKg > 0 ? +weightKg : PHYS.rider) + PHYS.bike;

/* ---------- validation of a course sent to an engine ---------- */
export function checkCourse(c) {
  if (!c || typeof c !== 'object') throw new Error('course must be an object');
  const ele = c.ele, dist = typeof c.dist === 'number' ? c.dist : NaN;
  if (!Array.isArray(ele) || ele.length < 2 || ele.length > MAX_M / STEP_M + 2 || !ele.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10000)) throw new Error('course.ele must be 2.. numbers');
  if (!(dist >= MIN_M && dist <= MAX_M)) throw new Error('course.dist out of range');
  return { name: String(c.name || 'Course').slice(0, 80), dist, gain: gainOf(ele), ele: ele.slice(), ll: (Array.isArray(c.ll) ? c.ll : []).filter(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'number' && Number.isFinite(x))).slice(0, 500) };
}

/* ---------- bundled synthetic courses (no GPX needed) ---------- */
function synth(id, name, km, f) {
  const n = Math.floor(km * 1000 / STEP_M) + 1, ele = [];
  for (let i = 0; i < n; i++) ele.push(r1(f(i * STEP_M)));
  return { id, name, dist: km * 1000, gain: gainOf(ele), ele, ll: [] };
}
const TAU = 2 * Math.PI;
export const SAMPLE_COURSES = [
  synth('s-flat', 'Flat', 20, x => 20 + 1.5 * Math.sin(TAU * x / 5000)),
  synth('s-rolling', 'Rolling hills', 30, x => 100 + 25 * Math.sin(TAU * x / 4000) + 12 * Math.sin(TAU * x / 1700 + 1)),
  synth('s-climb', 'The climb', 12, x => 50 + (x < 2000 ? 0 : x > 10000 ? 520 : 0.065 * (x - 2000) + 4 * Math.sin(TAU * (x - 2000) / 2000))),
];
