// FIT activity files -> Just Watts rides. A general FIT decoder (the course import's parseFit in course.js reads
// only positions; this one reads every field of the messages asked for), then records -> 1 Hz samples in the ride
// format: [ts_ms, elapsed_s, watts, rpm, bpm, km/h, target] and, with distance, [.., altitude_m, distance_m].
// Missing fields are 0; a file without power still makes a ride (HR and speed). Pure: no DOM, used by node tests.
import { FIT_EPOCH } from './core.js';

const SIGNED = new Set([0x01, 0x83, 0x85]);  // sint8, sint16, sint32
const INVALID = { 0x00: 0xFF, 0x01: 0x7F, 0x02: 0xFF, 0x83: 0x7FFF, 0x84: 0xFFFF, 0x85: 0x7FFFFFFF, 0x86: 0xFFFFFFFF, 0x0A: 0, 0x8B: 0, 0x8C: 0, 0x0D: 0xFF };

// bytes -> [{ g: global message number, f: { fieldNum: value } }] for the global numbers in `want`
export function fitMessages(buf, want = null) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 12 || String.fromCharCode(u[8], u[9], u[10], u[11]) !== '.FIT') throw new Error('Not a FIT file');
  const hs = u[0], end = Math.min(u.length, hs + v.getUint32(4, true)), defs = {}, out = [];
  let p = hs, lastTs = 0;
  const read = (o, size, base, le) => {
    const bt = base & 0xFF, s = SIGNED.has(bt);
    if ((bt & 0x1F) === 7) { let x = ''; for (let i = 0; i < size && u[o + i]; i++) x += String.fromCharCode(u[o + i]); return x; }
    let x;
    if (size === 1) x = s ? v.getInt8(o) : u[o];
    else if (size === 2 && (bt & 0x1F) >= 3 && (bt & 0x1F) <= 4) x = s ? v.getInt16(o, le) : v.getUint16(o, le);
    else if (size === 4 && [5, 6, 0x0C].includes(bt & 0x1F)) x = s ? v.getInt32(o, le) : v.getUint32(o, le);
    else if (size >= 1 && [0, 2, 0x0A, 0x0D].includes(bt & 0x1F)) x = u[o];  // an array of bytes: the first one
    else if (size >= 2 && (bt & 0x1F) === 4) x = v.getUint16(o, le);       // an array of uint16: the first one
    else return null;
    return x === INVALID[bt] ? null : x;
  };
  function msg(d, o, ts) {
    const f = {};
    for (const [num, size, base] of d.fields) { if (o + size > u.length) throw new Error('Bad FIT file'); f[num] = read(o, size, base, d.le); o += size; }
    if (f[253] != null) lastTs = f[253]; else if (ts != null) f[253] = ts;
    if (!want || want.includes(d.g)) out.push({ g: d.g, f });
    return o + d.dev;
  }
  while (p < end) {
    const h = u[p++];
    if (h & 0x80) {  // compressed timestamp: 5 bits of offset on the last full timestamp
      const d = defs[(h >> 5) & 3]; if (!d) throw new Error('Bad FIT file');
      const off = h & 0x1F; let ts = (lastTs & ~0x1F) + off; if (off < (lastTs & 0x1F)) ts += 0x20;
      lastTs = ts; p = msg(d, p, ts); continue;
    }
    if (h & 0x40) {
      const le = u[p + 1] === 0, g = le ? v.getUint16(p + 2, true) : v.getUint16(p + 2, false), n = u[p + 4], fields = [];
      p += 5; for (let i = 0; i < n; i++, p += 3) fields.push([u[p], u[p + 1], u[p + 2]]);
      let dev = 0; if (h & 0x20) { const nd = u[p++]; for (let i = 0; i < nd; i++, p += 3) dev += u[p + 1]; }
      defs[h & 0xF] = { g, le, fields, dev };
    } else { const d = defs[h & 0xF]; if (!d) throw new Error('Bad FIT file'); p = msg(d, p, null); }
  }
  return out;
}

const SPORT_CYCLING = 2, INDOOR_SUB = new Set([6, 58]);  // sub_sport indoor_cycling, virtual_activity
const MAX_HOLD_S = 10, MAX_S = 16 * 3600;

// FIT bytes -> { start, samples, sport, indoor, ll, distance_m, has: { power, hr, ... }, missing: [field names] }
export function fitActivity(buf) {
  const msgs = fitMessages(buf, [18, 20]);
  const sess = msgs.find(m => m.g === 18)?.f || {};
  const recs = msgs.filter(m => m.g === 20 && m.f[253] != null).map(m => m.f).sort((a, b) => a[253] - b[253]);
  if (!recs.length) throw new Error('no records');
  const pick = (f, ...k) => { for (const x of k) if (f[x] != null) return f[x]; return null; };
  const rows = recs.map(f => {
    const spd = pick(f, 73, 6), dist = f[5], alt = pick(f, 78, 2), lat = f[0], lon = f[1];
    return { t: f[253] + FIT_EPOCH, w: f[7], hr: f[3], cad: f[4], kmh: spd != null ? spd / 1000 * 3.6 : null, dist: dist != null ? dist / 100 : null,
      alt: alt != null ? alt / 5 - 500 : null, ll: lat != null && lon != null ? [lat * 180 / 2 ** 31, lon * 180 / 2 ** 31] : null };
  });
  return { ...fromRows(rows), sport: sess[5] ?? null, indoor: sess[5] === SPORT_CYCLING && INDOOR_SUB.has(sess[6]) };
}

// Strava streams (key_by_type data arrays: time s from start, watts, heartrate, cadence, velocity_smooth m/s,
// latlng [lat, lon], altitude m, distance m) -> the same activity shape
export function streamsActivity(j) {
  const s = j?.streams || {}, T = s.time, at = (k, i) => (Array.isArray(s[k]) ? s[k][i] : undefined) ?? null;
  if (!Array.isArray(T) || !T.length || !(j.start_ms > 0)) throw new Error('no streams');
  const t0 = Math.round(j.start_ms / 1000), rows = T.map((t, i) => {
    const v = at('velocity_smooth', i), ll = at('latlng', i);
    return { t: t0 + Math.round(+t || 0), w: at('watts', i), hr: at('heartrate', i), cad: at('cadence', i), kmh: v != null ? v * 3.6 : null,
      dist: at('distance', i), alt: at('altitude', i), ll: Array.isArray(ll) && ll.length === 2 ? ll : null };
  });
  return { ...fromRows(rows), sport: null, indoor: false };
}

// rows { t: unix s, w, hr, cad, kmh, dist m, alt m, ll } (any may be null) -> 1 Hz samples and what the file had
function fromRows(input) {
  const has = { power: false, hr: false, cadence: false, speed: false, gps: false, distance: false, altitude: false };
  const rows = input.filter(x => Number.isFinite(x.t)).sort((a, b) => a.t - b.t).map(x => {
    const gps = !!x.ll && Number.isFinite(x.ll[0]) && Number.isFinite(x.ll[1]) && !(x.ll[0] === 0 && x.ll[1] === 0);
    if (x.w != null) has.power = true; if (x.hr > 0) has.hr = true; if (x.cad != null) has.cadence = true;
    if (x.kmh != null) has.speed = true; if (x.dist != null) has.distance = true; if (x.alt != null) has.altitude = true; if (gps) has.gps = true;
    return { t: x.t, w: +x.w || 0, hr: +x.hr || 0, cad: +x.cad || 0, kmh: x.kmh, dist: x.dist, alt: x.alt, ll: gps ? x.ll : null };
  });
  if (!rows.length) throw new Error('no records');
  // 1 Hz: short gaps hold the last values, long gaps are pauses (no samples, elapsed time stops)
  const samples = [], ll = [];
  let el = 0, prev = null, lastDist = 0, lastAlt = 0;
  const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
  for (const x of rows) {
    if (prev && x.t === prev.t) continue;
    const gap = prev ? x.t - prev.t : 1, fill = gap > 1 && gap <= MAX_HOLD_S ? gap - 1 : 0;
    for (let k = 1; k <= fill && samples.length < MAX_S; k++) push(prev, prev.t + k, k / gap, x);
    if (samples.length >= MAX_S) break;
    push(x, x.t, 1, null);
    prev = x;
  }
  function push(a, t, frac, b) {
    el += 1;
    let dist = a.dist, kmh = a.kmh;
    if (b && a.dist != null && b.dist != null) dist = a.dist + (b.dist - a.dist) * frac;  // distance moves on through a held gap
    if (dist == null && kmh != null) dist = lastDist + kmh / 3.6;
    if (dist != null) lastDist = Math.max(lastDist, dist);
    if (a.alt != null) lastAlt = a.alt;
    if (kmh == null) kmh = 0;
    const s = [t * 1000, el, Math.max(0, Math.round(a.w)), Math.round(a.cad), Math.round(a.hr), r2(kmh), 0];
    if (has.distance) s.push(r1(lastAlt), r1(lastDist));
    samples.push(s);
    if (a.ll && !b) ll.push(a.ll);
  }
  // speed from distance when the file has distance but no speed
  if (!has.speed && has.distance) for (let i = 1; i < samples.length; i++) samples[i][5] = r2(Math.max(0, samples[i][8] - samples[i - 1][8]) * 3.6);
  const missing = Object.entries({ power: has.power, heart_rate: has.hr, cadence: has.cadence, speed: has.speed || has.distance }).filter(([, v]) => !v).map(([k]) => k);
  return { start: samples[0][0], samples, ll: thin(ll, 600), distance_m: has.distance ? samples.at(-1)[8] : null, has, missing };
}

// at most n points, the first and last kept
function thin(pts, n) {
  if (pts.length <= n) return pts.map(p => [r6(p[0]), r6(p[1])]);
  const out = []; for (let i = 0; i < n; i++) { const p = pts[Math.round(i * (pts.length - 1) / (n - 1))]; out.push([r6(p[0]), r6(p[1])]); }
  return out;
}
const r6 = x => Math.round(x * 1e6) / 1e6;

// an import item + its FIT -> a ride for History (POST /api/ride). Imported rides carry imported/source and an imp- id.
export function rideFromFit(buf, item, { service, ftp }) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let a, meta = null;
  if (u[0] === 0x7B) { const j = JSON.parse(new TextDecoder().decode(u)); a = streamsActivity(j); meta = j.meta || null; }  // '{': Strava streams as JSON
  else a = fitActivity(u);
  const ride = { id: `imp-${service}-${String(item.id).replace(/[^\w-]/g, '').slice(0, 40)}`, name: item.name || 'Ride', start: a.start, ftp: ftp || 200,
    samples: a.samples, source: service, imported: { service, activity_id: String(item.id), at: Date.now() }, test: false };
  if (meta) {  // Strava's activity: kept with the ride (the name and description show in History)
    if (meta.name) ride.name = meta.name;
    if (meta.description) ride.description = meta.description;
    for (const k of ['trainer', 'device', 'gear', 'sport']) if (meta[k] != null) ride.imported[k] = meta[k];
  }
  if (a.ll.length > 1 && a.distance_m > 0) ride.course = { name: ride.name, dist: a.distance_m, ll: a.ll };  // the map on the summary
  return { ride, missing: a.missing };
}
