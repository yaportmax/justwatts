// Data import (profile, past rides) from connected services: tolerant readers for Garmin Connect and
// intervals.icu answers, and a small zip reader for Garmin's original-file download. Every piece is optional:
// a reader returns what it found and the names of the fields it could not read, never throws on a bad shape.
// The fields' names (never their values) go to the server log so a live failure can be read from Vercel logs.
'use strict';
const zlib = require('node:zlib');

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : null);
const inRange = (v, lo, hi) => (v != null && v >= lo && v <= hi ? v : null);
const first = (...vs) => { for (const v of vs) if (v != null) return v; return null; };
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const list = v => (Array.isArray(v) ? v : []);

// sane bounds for every value the page may write into settings
const CHECK = {
  ftp: v => inRange(Math.round(num(v) ?? NaN), 50, 600),
  weight_kg: v => { const n = num(v); return n == null ? null : inRange(Math.round((n > 1000 ? n / 1000 : n) * 10) / 10, 25, 250); },  // Garmin: grams
  hr_max: v => inRange(Math.round(num(v) ?? NaN), 100, 230),
  hr_rest: v => inRange(Math.round(num(v) ?? NaN), 25, 120),
  lthr: v => inRange(Math.round(num(v) ?? NaN), 80, 220),
  hr_zones: v => (Array.isArray(v) && v.length === 5 && v.every((x, i) => Number.isFinite(x) && x > 30 && x < 230 && (!i || x > v[i - 1])) ? v.map(Math.round) : null),
};
const PROFILE_KEYS = Object.keys(CHECK);

// pieces: { name: { ok, json } | { ok: false, error } } -> { values, missing, errors }
function garminProfile(pieces) {
  const j = name => (pieces[name] && pieces[name].ok ? pieces[name].json : null);
  const settings = obj(j('settings')), user = obj(settings && settings.userData) || settings || {};
  // heart rate zones: a list, one per sport; cycling first, then the default
  const zl = list(j('zones')).filter(obj);
  const z = zl.find(x => x.sport === 'CYCLING') || zl.find(x => x.sport === 'DEFAULT' || !x.sport) || zl[0] || {};
  const floors = [1, 2, 3, 4, 5].map(i => num(z[`zone${i}Floor`]));
  // FTP: a dict or a one-item list; older accounts keep it in the profile
  const ftpRes = j('ftp'), ftpObj = Array.isArray(ftpRes) ? obj(ftpRes[0]) : obj(ftpRes);
  // weight: the newest weigh-in in the range, else the range average, else the profile
  const w = obj(j('weight')) || {};
  const when = x => num(x.date) ?? num(x.timestampGMT) ?? (Date.parse(x.calendarDate) || 0);
  const ins = list(w.dateWeightList).filter(x => obj(x) && num(x.weight) != null).sort((a, b) => when(b) - when(a));
  // lactate threshold: list or dict, speed+HR entries
  const lt = j('lactate'), ltObj = Array.isArray(lt) ? obj(lt.find(x => obj(x) && num(x.heartRate) != null) || lt[0]) : obj(lt);
  const ltHr = ltObj && first(num(ltObj.heartRate), num(obj(ltObj.speed_and_heart_rate) && ltObj.speed_and_heart_rate.heartRate));
  const hr = obj(j('rhr')) || {};
  const raw = {
    ftp: first(ftpObj && num(ftpObj.functionalThresholdPower), ftpObj && num(ftpObj.value), num(user.functionalThresholdPower), num(user.ftp)),
    weight_kg: first(ins.length ? num(ins[0].weight) : null, num(obj(w.totalAverage) && w.totalAverage.weight), num(user.weight)),
    hr_max: first(num(z.maxHeartRateUsed), num(user.maxHeartRate)),
    hr_rest: first(num(hr.restingHeartRate), num(hr.lastSevenDaysAvgRestingHeartRate), num(z.restingHeartRateUsed)),
    lthr: first(ltHr, num(z.lactateThresholdHeartRateUsed), num(user.lactateThresholdHeartRate)),
    hr_zones: floors.every(x => x != null) ? floors : null,
  };
  return finish(raw, pieces);
}

// intervals.icu GET /athlete/{id}: icu_weight, icu_resting_hr, sportSettings[] with types, ftp, lthr, max_hr
function intervalsProfile(pieces) {
  const a = (pieces.athlete && pieces.athlete.ok && obj(pieces.athlete.json)) || {};
  const ss = list(a.sportSettings).filter(obj);
  const ride = ss.find(s => list(s.types).includes('Ride')) || ss.find(s => list(s.types).includes('VirtualRide')) || {};
  const raw = { ftp: first(num(ride.ftp), num(ride.indoor_ftp)), weight_kg: first(num(a.icu_weight), num(a.weight)),
    hr_max: num(ride.max_hr), hr_rest: num(a.icu_resting_hr), lthr: num(ride.lthr), hr_zones: null };  // its zones are upper bounds of 5-7 zones: not ours
  return finish(raw, pieces);
}

function finish(raw, pieces) {
  const values = {}, missing = [];
  for (const k of PROFILE_KEYS) { const v = raw[k] == null ? null : CHECK[k](raw[k]); if (v == null) missing.push(k); else values[k] = v; }
  const errors = {};
  for (const [k, p] of Object.entries(pieces)) if (!p.ok) errors[k] = String(p.error || 'failed').slice(0, 120);
  return { values, missing, errors };
}

// Strava GET /athlete (weight kg, ftp) and /athlete/zones ({ heart_rate: { zones: [{ min, max }] x5 } })
function stravaProfile(pieces) {
  const a = (pieces.athlete && pieces.athlete.ok && obj(pieces.athlete.json)) || {};
  const z = (pieces.zones && pieces.zones.ok && obj(pieces.zones.json)) || {};
  const hz = list(obj(z.heart_rate) && z.heart_rate.zones).filter(obj).map(x => num(x.min));
  const floors = hz.length === 5 && hz.slice(1).every(x => x != null) ? [Math.round(hz[1] * 0.8), ...hz.slice(1)] : null;
  return finish({ ftp: num(a.ftp), weight_kg: num(a.weight), hr_max: null, hr_rest: null, lthr: null, hr_zones: floors }, pieces);
}

/* ---------- activities ---------- */
const INDOOR_GARMIN = /indoor|virtual|trainer/i;
const CYCLING_GARMIN = /cycl|bik|ride|velo/i;
// Garmin "2026-10-01 07:00:00" (GMT) -> ms
function gmtMs(s) { const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(s || '')); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; }
function garminActivity(a) {
  if (!obj(a) || num(a.activityId) == null) return null;
  const t = obj(a.activityType) || {}, type = String(t.typeKey || a.activityTypeKey || '');
  if (!CYCLING_GARMIN.test(type)) return null;
  const start = first(num(a.beginTimestamp), gmtMs(a.startTimeGMT), a.startTimeLocal ? Date.parse(String(a.startTimeLocal).replace(' ', 'T')) || null : null);
  if (start == null) return null;
  return { id: String(a.activityId), name: String(a.activityName || 'Ride').slice(0, 120), start_ms: start, duration_s: Math.round(num(a.duration) || num(a.elapsedDuration) || 0),
    distance_m: Math.round(num(a.distance) || 0), type, indoor: INDOOR_GARMIN.test(type), power: num(a.avgPower) != null || num(a.normPower) != null };
}
const INDOOR_ICU = /^Virtual/;
function intervalsActivity(a) {
  if (!obj(a) || a.id == null) return null;
  const type = String(a.type || '');
  if (!/Ride/.test(type)) return null;
  const start = first(a.start_date ? Date.parse(a.start_date) || null : null, a.start_date_local ? Date.parse(a.start_date_local) || null : null);
  if (start == null) return null;
  return { id: String(a.id), name: String(a.name || 'Ride').slice(0, 120), start_ms: start, duration_s: Math.round(num(a.elapsed_time) || num(a.moving_time) || 0),
    distance_m: Math.round(num(a.distance) || 0), type, indoor: INDOOR_ICU.test(type) || a.trainer === true, power: num(a.icu_average_watts) != null || a.device_watts === true,
    ...(a.source === 'STRAVA' ? { no_file: true } : {}) };  // Strava-synced activities have no downloadable file
}

/* ---------- files ---------- */
// zip -> the first .fit inside (stored or deflated), using the central directory sizes
function fitFromZip(buf) {
  const b = Buffer.from(buf);
  if (b.length >= 12 && b.toString('latin1', 8, 12) === '.FIT') return b;  // already a FIT
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return fitFromZip(zlib.gunzipSync(b));
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  let p = b.readUInt32LE(eocd + 16);
  const n = b.readUInt16LE(eocd + 10);
  for (let k = 0; k < n && p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50; k++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42), name = b.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!/\.fit$/i.test(name)) continue;
    const data = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28), raw = b.subarray(data, data + csize);
    const out = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (out && out.length >= 12 && out.toString('latin1', 8, 12) === '.FIT') return out;
  }
  throw new Error('no .fit in the zip');
}

module.exports = { garminProfile, intervalsProfile, stravaProfile, garminActivity, intervalsActivity, fitFromZip, PROFILE_KEYS, CHECK };
