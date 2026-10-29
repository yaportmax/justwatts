// Courses: GPX/TCX import, a compact elevation profile (one point every 10 m), grade lookup and
// virtual speed from power. Pure: no DOM, no globals. server/justwatts/course.py mirrors every
// function here; tests/test_course.py checks they agree.
//
// course = { name, dist: metres, gain: metres climbed, ele: [m every STEP_M from 0], ll: [[lat, lon]] }
// ll is a decimated polyline for a mini map (empty for synthetic courses).
// Open world: { ..., open: true, ll: one point per ele point, nd: [[metres, OSM node id]] (the page's road plan) }.
// The page extends it as the rider rides (roadExtend); the road behind the rider never changes.

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

// FIT course or activity (bytes) -> { name, pts }: record messages with a position; altitude from
// enhanced_altitude or altitude; the name from the course message. Throws on a file that is not FIT.
export function parseFit(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 12 || String.fromCharCode(u[8], u[9], u[10], u[11]) !== '.FIT') throw new Error('Not a FIT file');
  const hs = u[0], end = Math.min(u.length, hs + v.getUint32(4, true)), defs = {}, pts = [];
  let p = hs, name = '';
  const read = (o, size, base, le) => {
    const t = base & 0x1F;  // base type number
    if (t === 7) { let s = ''; for (let i = 0; i < size && u[o + i]; i++) s += String.fromCharCode(u[o + i]); return s; }
    if (size === 1) return t === 1 ? v.getInt8(o) : u[o];
    if (size === 2) return t === 3 ? v.getInt16(o, le) : v.getUint16(o, le);
    if (size === 4) return t === 5 ? v.getInt32(o, le) : v.getUint32(o, le);
    return null;
  };
  while (p < end) {
    const h = u[p++];
    if (h & 0x80) { const d = defs[(h >> 5) & 3]; if (!d) throw new Error('Bad FIT file'); p = msg(d, p); continue; }  // compressed timestamp
    if (h & 0x40) {
      const le = u[p + 1] === 0, g = le ? v.getUint16(p + 2, true) : v.getUint16(p + 2, false), n = u[p + 4], fields = [];
      p += 5; for (let i = 0; i < n; i++, p += 3) fields.push([u[p], u[p + 1], u[p + 2]]);
      let dev = 0; if (h & 0x20) { const nd = u[p++]; for (let i = 0; i < nd; i++, p += 3) dev += u[p + 1]; }
      defs[h & 0xF] = { g, le, fields, dev };
    } else { const d = defs[h & 0xF]; if (!d) throw new Error('Bad FIT file'); p = msg(d, p); }
  }
  function msg(d, o) {
    const f = {};
    for (const [num, size, base] of d.fields) { if (o + size > u.length) throw new Error('Bad FIT file'); f[num] = read(o, size, base, d.le); o += size; }
    if (d.g === 20 && f[0] != null && f[1] != null && f[0] !== 0x7FFFFFFF && f[1] !== 0x7FFFFFFF) {
      const alt = f[78] != null && f[78] !== 0xFFFFFFFF ? f[78] : f[2] != null && f[2] !== 0xFFFF ? f[2] : null;
      pts.push({ lat: f[0] * 180 / 2 ** 31, lon: f[1] * 180 / 2 ** 31, ele: alt == null ? null : alt / 5 - 500 });
    }
    if (d.g === 31 && typeof f[5] === 'string') name = f[5];
    return o + d.dev;
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
// 50 m median, then 90 m moving average, 0.1 m
export const smoothEle = raw => movingAvg(median(raw, 2), 4).map(r1);
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
  const ele = smoothEle(raw);
  const ll = [], m = Math.min(200, P.length);
  for (let k = 0, q = 0; k < m; k++) {
    const want = m > 1 ? k * total / (m - 1) : 0; while (q < P.length - 1 && D[q] < want) q++;
    ll.push([Math.floor(P[q].lat * 1e5 + 0.5) / 1e5, Math.floor(P[q].lon * 1e5 + 0.5) / 1e5]);
  }
  return { name: String(name || 'Course').slice(0, 80), dist: Math.floor(total + 0.5), gain: gainOf(ele), ele, ll };
}

/* ---------- lookups on a course ---------- */
// position on the map line at d metres -> [lat, lon] (1e-6 deg), or null without a line.
// The line is decimated, so its length is scaled to the course length.
export function track(c) {
  const ll = Array.isArray(c?.ll) ? c.ll : []; if (ll.length < 2) return null;
  const D = [0]; for (let i = 1; i < ll.length; i++) D.push(D[i - 1] + haversine({ lat: ll[i - 1][0], lon: ll[i - 1][1] }, { lat: ll[i][0], lon: ll[i][1] }));
  const k = D[D.length - 1] > 0 ? c.dist / D[D.length - 1] : 0, r6 = x => Math.floor(x * 1e6 + 0.5) / 1e6;
  for (let i = 0; i < D.length; i++) D[i] *= k;
  let j = 1;
  return d => {
    d = clamp(d, 0, D[D.length - 1]); if (D[j - 1] > d) j = 1;
    while (j < D.length - 1 && D[j] < d) j++;
    const f = D[j] > D[j - 1] ? (d - D[j - 1]) / (D[j] - D[j - 1]) : 0, a = ll[j - 1], b = ll[j];
    return [r6(a[0] + (b[0] - a[0]) * f), r6(a[1] + (b[1] - a[1]) * f)];
  };
}

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
const MAX_N = MAX_M / STEP_M + 2, MAX_ND = 100000;
const num = x => typeof x === 'number' && Number.isFinite(x);
// open-world parts: ele and ll the same length (one point per STEP_M), nd ascending [metres, node id]. Throws.
function openParts(ele, ll, nd, min) {
  if (!Array.isArray(ele) || ele.length < min || ele.length > MAX_N || !ele.every(x => num(x) && Math.abs(x) < 10000)) throw new Error('course.ele must be numbers');
  if (!Array.isArray(ll) || ll.length !== ele.length || !ll.every(p => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)) throw new Error('course.ll must be one [lat, lon] per point');
  if (!Array.isArray(nd) || nd.length > MAX_ND || !nd.every((x, i) => Array.isArray(x) && x.length === 2 && num(x[0]) && Number.isInteger(x[1]) && (!i || x[0] >= nd[i - 1][0]))) throw new Error('course.nd must be ascending [metres, id]');
  return [ele.slice(), ll.map(p => [p[0], p[1]]), nd.map(x => [x[0], x[1]])];
}
// a course sent with a load: an open-world course or a plain one (web/api copies checkCourse verbatim)
export const checkRideCourse = c => c?.open === true ? checkOpen(c) : checkCourse(c);
export function checkOpen(c) {
  const [ele, ll, nd] = openParts(c.ele, c.ll, c.nd ?? [], Math.ceil(MIN_M / STEP_M) + 1);
  return { name: String(c.name || 'Open world').slice(0, 80), dist: (ele.length - 1) * STEP_M, gain: gainOf(ele), ele, ll, open: true, nd };
}
export function checkCourse(c) {
  if (!c || typeof c !== 'object') throw new Error('course must be an object');
  const ele = c.ele, dist = typeof c.dist === 'number' ? c.dist : NaN;
  if (!Array.isArray(ele) || ele.length < 2 || ele.length > MAX_M / STEP_M + 2 || !ele.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10000)) throw new Error('course.ele must be 2.. numbers');
  if (!(dist >= MIN_M && dist <= MAX_M)) throw new Error('course.dist out of range');
  return { name: String(c.name || 'Course').slice(0, 80), dist, gain: gainOf(ele), ele: ele.slice(), ll: (Array.isArray(c.ll) ? c.ll : []).filter(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'number' && Number.isFinite(x))).slice(0, 500) };
}
// open world: replace the points from index at on ({at, ele, ll, nd}); d = metres ridden. Never touches the
// segment under the rider (a plain append always fits). nd entries from the first new one on are replaced. Throws.
export function roadExtend(c, b, d) {
  if (!c?.open) throw new Error('not an open-world ride');
  const n = c.ele.length, at = b?.at;
  if (!Number.isInteger(at) || at < 1 || at > n) throw new Error('road.at out of range');
  if (at < Math.min(n, Math.floor(Math.max(0, d) / STEP_M) + 2)) throw new Error('road.at is behind the rider');
  const [ele, ll, nd] = openParts(b.ele, b.ll, b.nd ?? [], 1);
  if (at + ele.length > MAX_N) throw new Error('course too long');
  const cut = nd.length ? nd[0][0] : Infinity, E = c.ele.slice(0, at).concat(ele);
  return { ...c, dist: (E.length - 1) * STEP_M, gain: gainOf(E), ele: E, ll: c.ll.slice(0, at).concat(ll), nd: c.nd.filter(x => x[0] < cut).concat(nd) };
}
// open world at the end of a ride: only the road ridden (d metres), so the saved ride shows where the rider went
export function ridden(c, d) {
  if (!c?.open) return c;
  const n = Math.max(2, Math.min(c.ele.length, Math.floor(Math.max(0, d) / STEP_M) + 2)), ele = c.ele.slice(0, n);
  return { ...c, dist: (n - 1) * STEP_M, gain: gainOf(ele), ele, ll: c.ll.slice(0, n), nd: c.nd.filter(x => x[0] <= (n - 1) * STEP_M) };
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
