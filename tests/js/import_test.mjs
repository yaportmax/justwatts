// Import from connected services: the server ops (Garmin, intervals.icu, Strava) against stubbed HTTP with
// python-garminconnect-shaped answers, FIT activity parsing (files built with the repo's FIT encoder and a raw
// writer), and the page's import flow (options, progress, dedupe, stop and resume) with fakes.
// Never touches the network. Usage: node import_test.mjs <repo>. Prints {checks} as JSON.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const root = process.argv[2];
const L = m => require(`${root}/web/api/_lib/integrations/${m}.js`);
const url = p => `file:///${root.replace(/\\/g, '/')}/app/js/${p}`;
const { memoryStore, userStore } = L('store');
const { garmin } = L('garmin');
const { intervals } = L('intervals');
const { strava } = L('strava');
const { hub } = L('hub');
const { makeHandler } = L('http');
const I = L('importing');
const { fitEncode, fitCrc, FIT_EPOCH, summarize } = await import(url('core.js'));
const { fitMessages, fitActivity, rideFromFit, streamsActivity } = await import(url('fitread.js'));
const { createImporter, profileRows, infoOnly, rangeDates, DEFAULT_RANGE, KEY } = await import(url('importer.js'));
const { detail } = await import(url('web/history.js'));

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const rejects = async (p, kind, m) => { try { await p; } catch (e) { eq(e.kind, kind, m + ': ' + e.message); return e; } assert.fail(m + ': did not throw'); };
const KEY32 = Buffer.alloc(32, 7);
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const bin = (buf, status = 200) => new Response(buf, { status, headers: { 'content-type': 'application/octet-stream' } });
const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
function fakeFetch(routes) {
  const calls = [];
  const f = async (u, opt = {}) => {
    calls.push({ url: String(u), ...opt });
    for (const [method, sub, resp] of routes) {
      if ((opt.method || 'GET') === method && String(u).includes(sub)) {
        const r = Array.isArray(resp) ? (resp.length > 1 ? resp.shift() : resp[0]) : resp;
        return typeof r === 'function' ? r(String(u), opt) : r.clone();
      }
    }
    return json(404, {});
  };
  f.calls = calls; return f;
}
// a zip holding one file (deflated), as Garmin's download service sends
function zip(name, data) {
  const comp = zlib.deflateRawSync(data), n = Buffer.from(name), crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc >>> 0, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc >>> 0, 16);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + n.length + comp.length, cdLen = 46 + n.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, n, comp, cd, n, eocd]);
}

/* ---------- FIT files: the repo's encoder (a ride with power, HR, a course map) and a raw no-power file ---------- */
const T0 = Date.UTC(2026, 9, 20, 14, 0, 0);
const ll = [[47.6, -122.3], [47.61, -122.3], [47.62, -122.31]];
const encRide = { id: 'x', name: 'Tempo', ftp: 250, course: { ll, dist: 3000 },
  samples: Array.from({ length: 1200 }, (_, i) => [T0 + i * 1000, i + 1, 200 + (i % 60 < 30 ? 50 : 0), 90, 140 + (i % 10), 30, 0, 100 + i * 0.01, i * 2.5]) };
const FIT_POWER = Buffer.from(fitEncode(encRide));
// raw writer: records with only timestamp, HR, speed, distance (no power), smart-recording gaps, one compressed timestamp, a pause
function rawFit() {
  const b = [], put = (v, n) => { for (let i = 0; i < n; i++) b.push(Math.floor(v / 2 ** (8 * i)) & 255); };
  b.push(0x40, 0, 0); put(0, 2); b.push(5, 0, 1, 0, 1, 2, 0x84, 2, 2, 0x84, 3, 4, 0x8C, 4, 4, 0x86);  // file_id
  const t0 = Math.round(T0 / 1000) - FIT_EPOCH;
  b.push(0); put(4, 1); put(1, 2); put(1, 2); put(1, 4); put(t0, 4);
  b.push(0x41, 0, 0); put(18, 2); b.push(3, 253, 4, 0x86, 5, 1, 0x00, 6, 1, 0x00);              // session: sport cycling, sub_sport indoor
  b.push(1); put(t0 + 999, 4); b.push(2, 6);
  b.push(0x42, 0, 0); put(20, 2); b.push(4, 253, 4, 0x86, 3, 1, 0x02, 6, 2, 0x84, 5, 4, 0x86);  // record: ts, hr, speed, distance
  let d = 0;
  const rec = (t, hr) => { d += 8 * (t - (rec.last ?? t)); rec.last = t; b.push(2); put(t0 + t, 4); put(hr, 1); put(8000, 2); put(Math.round(d * 100), 4); };
  for (let t = 0; t < 600; t += 3) rec(t, 130);           // every 3 s: held to 1 Hz
  rec(900, 135);                                          // a 5 min stop: a pause, no samples
  b.push(0x43, 0, 0); put(20, 2); b.push(3, 3, 1, 0x02, 6, 2, 0x84, 5, 4, 0x86);  // record without a timestamp, for compressed headers
  b.push(0x80 | (3 << 5) | ((t0 + 901) & 0x1F)); put(136, 1); put(8000, 2); d += 8; put(Math.round(d * 100), 4);  // compressed timestamp
  const H = [14, 0x20, 2132 & 255, 2132 >> 8, b.length & 255, (b.length >> 8) & 255, (b.length >> 16) & 255, (b.length >>> 24) & 255, 0x2E, 0x46, 0x49, 0x54];
  const hc = fitCrc(H); H.push(hc & 255, hc >> 8);
  const all = H.concat(b), c = fitCrc(all); all.push(c & 255, c >> 8);
  return Buffer.from(all);
}
const FIT_HR = rawFit();
{
  const a = fitActivity(FIT_POWER);
  eq([a.start, a.samples.length, a.has.power, a.has.gps], [T0, 1200, true, true], 'encoded ride: 1 Hz, power, gps');
  eq(a.samples[10].slice(2, 6), [250, 90, 140, 30], 'power cadence hr speed');
  ok(a.ll.length > 1 && Math.abs(a.distance_m - 2997.5) < 5, 'route and distance');
  const { ride, missing } = rideFromFit(FIT_POWER, { id: '777', name: 'Morning Ride' }, { service: 'garmin', ftp: 250 });
  eq([ride.id, ride.source, ride.imported.service, missing], ['imp-garmin-777', 'garmin', 'garmin', []], 'ride from FIT');
  const m = summarize(ride), d = detail(ride, [100, 120, 140, 160, 175]);
  ok(Math.abs(m.avgP - 225) < 1 && m.np > m.avgP && m.tss > 0, 'NP, IF, TSS work');
  ok(d.best['5m'] > 0 && d.hr_zones_s.Z3 > 0 && Math.abs(d.summary.distance_km - 3) < 0.1, 'best efforts, HR zones, distance');
  eq(ride.course.ll.length > 1 && ride.course.dist > 2900, true, 'summary map');
  const h = fitActivity(FIT_HR);
  eq([h.has.power, h.indoor, h.sport], [false, true, 2], 'no power, indoor session');
  eq(h.samples.length, 598 + 1 + 1, '3 s recording held to 1 Hz, the stop is a pause');
  eq(h.samples.at(-1)[4], 136, 'compressed timestamp record read');
  eq(h.samples.at(-1)[0] - h.samples.at(-2)[0], 1000, 'compressed timestamp time');
  ok(h.samples[1][5] === 28.8 && h.samples[1][8] > 0, 'speed and distance without power');
  const r2 = rideFromFit(FIT_HR, { id: 'i55' }, { service: 'intervals', ftp: 200 });
  eq([r2.missing, r2.ride.course], [['power', 'cadence'], undefined], 'no power still a ride, no map without gps');
  eq(summarize(r2.ride).tss, 0, 'no power: TSS 0');
  assert.throws(() => fitActivity(Buffer.from('nope'))); checks++;
  eq(fitMessages(FIT_POWER, [34]).length, 1, 'activity message');
  const st = streamsActivity({ start_ms: T0, streams: { time: [0, 1, 2, 5, 6], watts: [100, 110, 120, 130, 140], heartrate: [120, 121, 122, 123, 124],
    velocity_smooth: [8, 8, 8, 8, 8], latlng: [[47.6, -122.3], [47.6, -122.31], [47.61, -122.31], [47.61, -122.32], [47.62, -122.32]], distance: [0, 8, 16, 40, 48], altitude: [10, 10, 11, 12, 12] } });
  eq([st.samples.length, st.samples[3][2], st.samples.at(-1)[8]], [7, 120, 48], 'strava streams to 1 Hz');
  const sj = rideFromFit(Buffer.from(JSON.stringify({ kind: 'streams', start_ms: T0, streams: { time: [0, 1], heartrate: [100, 101] } })), { id: '9' }, { service: 'strava', ftp: 200 });
  eq([sj.ride.id, sj.missing.includes('power')], ['imp-strava-9', true], 'streams JSON through rideFromFit');
}

/* ---------- importing.js readers ---------- */
{
  eq(I.fitFromZip(zip('123_ACTIVITY.fit', FIT_POWER)).equals(FIT_POWER), true, 'zip -> fit');
  eq(I.fitFromZip(FIT_POWER).equals(FIT_POWER), true, 'plain fit passes');
  eq(I.fitFromZip(zlib.gzipSync(FIT_POWER)).equals(FIT_POWER), true, 'gzip fit');
  assert.throws(() => I.fitFromZip(Buffer.from('PK nothing'))); checks++;
  const g = I.garminActivity({ activityId: 5, activityName: 'Zwift', startTimeGMT: '2026-10-20 14:00:00', activityType: { typeKey: 'virtual_ride' }, duration: 3600.5, avgPower: 200 });
  eq([g.start_ms, g.indoor, g.power, g.duration_s], [T0, true, true, 3601], 'garmin activity');
  eq(I.garminActivity({ activityId: 6, startTimeGMT: '2026-10-20 14:00:00', activityType: { typeKey: 'running' } }), null, 'running skipped');
  eq(I.garminActivity({ activityId: 7, activityType: { typeKey: 'road_biking' } }), null, 'no start skipped');
  eq(I.garminActivity({ activityId: 8, beginTimestamp: T0, activityType: { typeKey: 'road_biking' } }).indoor, false, 'outdoor');
  const p = I.garminProfile({ settings: { ok: false, error: 'Garmin said 500' }, weight: { ok: true, json: {} }, ftp: { ok: true, json: [] }, zones: { ok: true, json: 'x' }, lactate: { ok: true, json: null }, rhr: { ok: false, error: 'no displayName' } });
  eq([p.values, p.missing.length, Object.keys(p.errors)], [{}, 6, ['settings', 'rhr']], 'garmin: nothing readable, nothing thrown');
}

/* ---------- Garmin import ops (python-garminconnect shapes) ---------- */
const GARMIN = {
  settings: { id: 1, userData: { gender: 'MALE', weight: 79800.0, height: 180.0, birthDate: '1985-04-02', lactateThresholdHeartRate: 168, measurementSystem: 'metric' }, userSleep: {} },
  social: { displayName: 'abc-123', fullName: 'Test Rider' },
  weight: { startDate: '2025-10-29', endDate: '2026-10-29', dateWeightList: [{ samplePk: 1, date: 1790000000000, calendarDate: '2026-09-21', weight: 80100.0 }, { samplePk: 2, date: 1792000000000, calendarDate: '2026-10-14', weight: 78400.0 }], totalAverage: { weight: 79000.0 } },
  ftp: { userProfilePK: 1, functionalThresholdPower: 265, sport: 'CYCLING', calendarDate: '2026-10-01', isStale: false },
  zones: [{ trainingMethod: 'HR_MAX', restingHeartRateUsed: 48, lactateThresholdHeartRateUsed: 170, zone1Floor: 95, zone2Floor: 114, zone3Floor: 133, zone4Floor: 152, zone5Floor: 171, maxHeartRateUsed: 190, sport: 'DEFAULT' },
    { trainingMethod: 'LACTATE_THRESHOLD', lactateThresholdHeartRateUsed: 165, zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 155, zone5Floor: 166, maxHeartRateUsed: 188, sport: 'CYCLING' }],
  lactate: [{ userProfilePK: 1, calendarDate: '2026-10-01', speed: 0.37, heartRate: 167, heartRateCycling: null }],
  rhr: { userProfilePK: 1, calendarDate: '2026-10-29', restingHeartRate: 49, lastSevenDaysAvgRestingHeartRate: 50 },
};
const acts = n => Array.from({ length: n }, (_, i) => ({ activityId: 9000 + i, activityName: `Ride ${i}`, startTimeGMT: new Date(T0 - i * 864e5).toISOString().slice(0, 19).replace('T', ' '),
  activityType: { typeKey: i % 3 === 0 ? 'indoor_cycling' : i % 3 === 1 ? 'road_biking' : 'running' }, duration: 3600, distance: 30000, avgPower: i % 2 ? 180 : null }));
async function garminStore(c) {
  const us = userStore(memoryStore(), KEY32, 'u1');
  await us.setSecret('garmin', { di_token: jwt(c + 7200), di_refresh_token: 'r1', di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI', expires_at: c + 7200 });
  return us;
}
{
  const c = 1_800_000_000, us = await garminStore(c);
  const pages = [acts(50), acts(10)];
  const f = fakeFetch([
    ['GET', '/userprofile-service/userprofile/user-settings', json(200, GARMIN.settings)],
    ['GET', '/userprofile-service/socialProfile', json(200, GARMIN.social)],
    ['GET', '/weight-service/weight/dateRange', json(200, GARMIN.weight)],
    ['GET', '/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING', json(200, GARMIN.ftp)],
    ['GET', '/biometric-service/heartRateZones', json(200, GARMIN.zones)],
    ['GET', '/biometric-service/biometric/latestLactateThreshold', json(200, GARMIN.lactate)],
    ['GET', '/wellness-service/wellness/dailyHeartRate/abc-123', json(200, GARMIN.rhr)],
    ['GET', '/activitylist-service/activities/search/activities', () => json(200, pages.shift() || [])],
    ['GET', '/download-service/files/activity/9000', bin(zip('9000_ACTIVITY.fit', FIT_POWER))],
    ['GET', '/download-service/files/activity/9001', json(404, {})],
  ]);
  const g = garmin({ fetch: f, now: () => c, sleep: async () => {} });
  const p = await g.importProfile(us);
  eq(p.values, { ftp: 265, weight_kg: 78.4, hr_max: 188, hr_rest: 49, lthr: 167, hr_zones: [100, 120, 140, 155, 166] }, 'garmin profile: cycling zones, newest weigh-in');
  eq([p.missing, p.errors], [[], {}], 'garmin profile complete');
  const call0 = f.calls.find(x => x.url.includes('heartRateZones'));
  ok(call0.url.startsWith('https://connectapi.garmin.com/') && call0.headers.Authorization.startsWith('Bearer ') && call0.headers['X-Garmin-Client-Platform'] === 'Android', 'connectapi, bearer, app headers');
  const l1 = await g.importList(us, { since: '2026-01-01', until: '2026-10-30', start: 0 });
  eq([l1.items.length, l1.skipped, l1.more, l1.next], [34, 16, true, 50], 'page 1: cycling only, more');
  const q = new URL(f.calls.find(x => x.url.includes('activitylist')).url).searchParams;
  eq([q.get('startDate'), q.get('endDate'), q.get('start'), q.get('limit'), q.get('activityType')], ['2026-01-01', '2026-10-30', '0', '50', 'cycling'], 'list query');
  const l2 = await g.importList(us, { since: '2026-01-01', until: '2026-10-30', start: 50 });
  eq([l2.items.length, l2.more], [7, false], 'last page');
  eq((await g.importFit(us, '9000')).equals(FIT_POWER), true, 'fit from the zip');
  await rejects(g.importFit(us, '9001'), 'blocked', 'missing file');
  await rejects(g.importFit(us, '../x'), 'blocked', 'bad id');
  // every piece can break: what worked comes back, nothing throws
  const f2 = fakeFetch([['GET', '/biometric-service/heartRateZones', json(200, GARMIN.zones)], ['GET', 'user-settings', json(500, {})], ['GET', 'socialProfile', new Response('<html>', { status: 200 })],
    ['GET', 'latestFunctionalThresholdPower', json(200, [{ functionalThresholdPower: 240 }])]]);
  const p2 = await garmin({ fetch: f2, now: () => c, sleep: async () => {} }).importProfile(us);
  eq(p2.values, { ftp: 240, hr_max: 188, lthr: 165, hr_zones: [100, 120, 140, 155, 166] }, 'partial profile');
  eq(Object.keys(p2.errors).sort(), ['lactate', 'rhr', 'settings', 'weight'], 'failed pieces named');
  // signed out: auth
  const dead = garmin({ fetch: fakeFetch([['POST', 'diauth', json(401, {})], ['GET', 'connectapi', json(401, {})]]), now: () => c + 99999, sleep: async () => {} });
  await rejects(dead.importProfile(us), 'auth', 'expired token');
  // 429 on a file: temporary with retry-after
  const busy = garmin({ fetch: fakeFetch([['GET', '/download-service/', json(429, {}, { 'retry-after': '30' })]]), now: () => c, sleep: async () => {} });
  const e = await rejects(busy.importFit(us, '1'), 'temporary', '429');
  eq(e.retryAfter, 30, 'retry-after kept');
}

/* ---------- intervals.icu import ops ---------- */
{
  const us = userStore(memoryStore(), KEY32, 'u1');
  await us.setSecret('intervals', { athlete_id: 'i123', api_key: 'icukey-0123456789abcdef' });
  const athlete = { id: 'i123', name: 'Test', icu_weight: 72.5, icu_resting_hr: 46, sportSettings: [{ types: ['Run'], ftp: 300, lthr: 175 }, { types: ['Ride', 'VirtualRide'], ftp: 255, indoor_ftp: 245, lthr: 166, max_hr: 189, hr_zones: [140, 155, 166, 175, 181, 185, 189] }] };
  const list = [{ id: 'i1', start_date_local: '2026-10-20T07:00:00', start_date: '2026-10-20T14:00:00Z', type: 'VirtualRide', name: 'Zwift', moving_time: 3600, distance: 30000, icu_average_watts: 210 },
    { id: 'i2', start_date: '2026-10-19T14:00:00Z', type: 'Ride', trainer: false, name: 'Out', source: 'STRAVA' }, { id: 'i3', start_date: '2026-10-18T14:00:00Z', type: 'Run' }, { bad: 1 }];
  const f = fakeFetch([['GET', '/athlete/i123/activities', json(200, list)], ['GET', '/athlete/i123', json(200, athlete)], ['GET', '/activity/i1/fit-file', bin(zlib.gzipSync(FIT_POWER))]]);
  const icu = intervals({ fetch: f });
  const p = await icu.importProfile(us);
  eq(p.values, { ftp: 255, weight_kg: 72.5, hr_max: 189, hr_rest: 46, lthr: 166 }, 'intervals profile: the Ride settings');
  eq(p.missing, ['hr_zones'], 'its zones are not ours');
  const l = await icu.importList(us, { since: '2026-10-01', until: '2026-10-30' });
  eq(l.items.map(x => [x.id, x.indoor, !!x.no_file]), [['i1', true, false], ['i2', false, true]], 'rides only; strava-synced has no file');
  ok(f.calls.some(x => x.url.includes('oldest=2026-10-01&newest=2026-10-30')), 'date range query');
  eq((await icu.importFit(us, 'i1')).equals(FIT_POWER), true, 'gzipped fit-file');
  await rejects(intervals({ fetch: fakeFetch([['GET', '/athlete/', json(403, { error: 'denied' })]]) }).importProfile(us), 'auth', 'bad key');
  const half = await intervals({ fetch: fakeFetch([['GET', '/athlete/', json(500, {})]]) }).importProfile(us);
  eq([half.values, Object.keys(half.errors)], [{}, ['athlete']], 'intervals down: empty, named');
}

/* ---------- Strava: OAuth with the extra scopes, upload + poll, import ---------- */
{
  const env = { STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'stsecret-xyz', PUBLIC_ORIGIN: 'https://justwatts.test' };
  const c = { t: 1_800_000_000 }, now = () => c.t;
  const us = userStore(memoryStore(), KEY32, 'u1');
  const f = fakeFetch([
    ['POST', '/oauth/token', (u, o) => { const b = new URLSearchParams(o.body); return b.get('grant_type') === 'refresh_token' ? json(200, { access_token: 'acc-2', refresh_token: 'ref-2', expires_at: c.t + 21600 }) : b.get('code') === 'goodcode' ? json(200, { access_token: 'acc-1', refresh_token: 'ref-1', expires_at: c.t + 21600, athlete: { id: 42, firstname: 'Eddy' } }) : json(400, { message: 'Bad Request' }); }],
    ['POST', '/api/v3/uploads', [json(201, { id: 77, id_str: '77', status: 'Your activity is still being processed.' }), json(201, { id: 78, id_str: '78' })]],
    ['GET', '/api/v3/uploads/77', [json(200, { id: 77, status: 'still processing' }), json(200, { id: 77, activity_id: 555, status: 'ready' })]],
    ['GET', '/api/v3/uploads/78', json(200, { id: 78, error: '123.fit duplicate of <a href=\'/activities/444\'>Morning Ride</a>', status: 'There was an error' })],
    ['GET', '/api/v3/athlete/activities', json(200, [{ id: 1, name: 'Zwift', sport_type: 'VirtualRide', start_date: '2026-10-20T14:00:00Z', elapsed_time: 3600, device_watts: true },
      { id: 2, name: 'Run', sport_type: 'Run', start_date: '2026-10-19T14:00:00Z' }, { id: 3, name: 'Gravel', type: 'Ride', start_date: '2026-10-18T14:00:00Z', trainer: false }])],
    ['GET', '/api/v3/athlete/zones', json(200, { heart_rate: { custom_zones: true, zones: [{ min: 0, max: 123 }, { min: 123, max: 153 }, { min: 153, max: 169 }, { min: 169, max: 184 }, { min: 184, max: -1 }] }, power: { zones: [] } })],
    ['GET', '/api/v3/athlete', json(200, { id: 42, firstname: 'Eddy', weight: 71.2, ftp: 280, sex: 'M', bikes: [{ id: 'b1', name: 'Tarmac' }] })],
    ['GET', '/api/v3/activities/1/streams', json(200, { time: { data: [0, 1, 2] }, watts: { data: [200, 210, 220] }, heartrate: { data: [130, 131, 132] } })],
    ['GET', '/api/v3/activities/1?', json(200, { id: 1, name: 'Zwift - Watopia', description: 'Easy spin', trainer: true, device_name: 'Zwift', gear: { id: 'b1', name: 'Tarmac' }, sport_type: 'VirtualRide', start_date: '2026-10-20T14:00:00Z' })],
  ]);
  const s = strava({ fetch: f, now, env, key: KEY32, sleep: async () => {} });
  ok(s.configured(), 'configured from env');
  ok(!strava({ fetch: f, now, env: {}, key: KEY32 }).configured(), 'not configured without the app');
  const a = new URL(s.authorizeUrl('u1'));
  eq([a.origin + a.pathname, a.searchParams.get('scope'), a.searchParams.get('redirect_uri')], ['https://www.strava.com/oauth/authorize', 'read,activity:write,activity:read_all,profile:read_all', 'https://justwatts.test/api/integrations?op=strava_callback'], 'authorize url');
  const state = a.searchParams.get('state');
  await rejects(s.callback(us, 'u2', { code: 'goodcode', state, scope: 'read' }), 'auth', 'state bound to the user');
  await rejects(s.callback(us, 'u1', { code: 'goodcode', state: 'v1.x.y.z' }), 'auth', 'forged state');
  const cb = await s.callback(us, 'u1', { code: 'goodcode', state, scope: 'read,activity:write,activity:read_all,profile:read_all' });
  eq(cb, { connected: true, upload: true, read_all: true }, 'callback');
  eq((await s.status(us)).account, 'Eddy', 'status');
  const up = await s.upload(us, FIT_POWER, { ride_id: 'r1', name: 'Tempo', filename: 'r1.fit' });
  eq(up, { activity_id: 555, url: 'https://www.strava.com/activities/555' }, 'upload, polled until ready');
  const upCall = f.calls.find(x => x.url.endsWith('/api/v3/uploads'));
  ok(upCall.headers.Authorization === 'Bearer acc-1' && upCall.body.toString('latin1').includes('name="data_type"\r\n\r\nfit'), 'multipart upload');
  eq(await s.upload(us, FIT_POWER, { ride_id: 'r1' }), { duplicate: true, activity_id: '444', url: 'https://www.strava.com/activities/444' }, 'duplicate error');
  c.t += 30000;  // token old: refreshed before the call
  eq((await s.importProfile(us)).values, { ftp: 280, weight_kg: 71.2, hr_zones: [98, 123, 153, 169, 184] }, 'athlete ftp, weight, HR zones');
  eq((await us.secret('strava')).refresh_token, 'ref-2', 'refresh rotated');
  const l = await s.importList(us, { since: '2026-10-01', until: '2026-10-30', start: 0 });
  eq(l.items.map(x => [x.id, x.indoor]), [['1', true], ['3', false]], 'rides only');
  const lq = new URL(f.calls.find(x => x.url.includes('/athlete/activities')).url).searchParams;
  eq([lq.get('page'), lq.get('per_page'), lq.get('after')], ['1', '100', String(Date.UTC(2026, 9, 1) / 1000)], 'list query');
  const sbuf = await s.importFit(us, '1');
  const { ride } = rideFromFit(new Uint8Array(sbuf), l.items[0], { service: 'strava', ftp: 280 });
  eq([ride.start, ride.samples.map(x => x[2])], [Date.UTC(2026, 9, 20, 14), [200, 210, 220]], 'streams -> ride');
  eq([ride.name, ride.description, ride.imported.trainer, ride.imported.device, ride.imported.gear], ['Zwift - Watopia', 'Easy spin', true, 'Zwift', 'Tarmac'], 'activity fields kept');
  const sq = new URL(f.calls.find(x => x.url.includes('/streams')).url).searchParams.get('keys').split(',');
  ok(['time', 'watts', 'heartrate', 'cadence', 'velocity_smooth', 'distance', 'latlng', 'altitude', 'grade_smooth', 'temp'].every(k => sq.includes(k)), 'every stream asked for');
  eq((await s.status(us)).capped, true, 'capped unless STRAVA_CAPPED=0');
  // the 10-athlete cap
  const capped = strava({ fetch: fakeFetch([['POST', '/oauth/token', json(403, { message: 'Limit of connected athletes exceeded', errors: [] })]]), now, env, key: KEY32 });
  const st2 = new URL(capped.authorizeUrl('u1')).searchParams.get('state');
  const ce = await rejects(capped.callback(userStore(memoryStore(), KEY32, 'u1'), 'u1', { code: 'goodcode', state: st2, scope: 'read' }), 'blocked', 'capped');
  eq(ce.message, 'strava_capped', 'cap reason');
  // rate limit: temporary, wait for the window
  const rl = strava({ fetch: fakeFetch([['GET', '/streams', json(429, {})], ['GET', '/api/v3/activities/5', json(200, {})]]), now, env, key: KEY32 });
  const re = await rejects(rl.importFit(us, '5'), 'temporary', '429');
  ok(re.retryAfter > 0 && re.retryAfter <= 905, 'waits for the 15 min window');
}

/* ---------- hub + HTTP: the ops, partial answers, logs, Strava OAuth round trip, no upload of imported rides ---------- */
async function req(handler, method, path, headers = {}) {
  const r = Object.assign(Readable.from([]), { method, url: path, headers: { host: 'justwatts.test', ...headers } });
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) {
      const buf = b ? (Buffer.isBuffer(b) ? b : Buffer.from(String(b))) : Buffer.alloc(0); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch {}
      resolve({ code: this.statusCode, body: j, raw: buf, headers: this.headers });
    } };
    handler(r, res);
  });
}
{
  const c = 1_800_000_000, raw = memoryStore(), us = userStore(raw, KEY32, 'u1');
  await us.setSecret('garmin', { di_token: jwt(c + 7200), di_refresh_token: 'r1', di_client_id: 'X', expires_at: c + 7200 });
  const logs = [];
  const f = fakeFetch([['GET', '/biometric-service/heartRateZones', json(200, GARMIN.zones)], ['GET', 'activitylist-service', json(200, acts(5))],
    ['GET', '/download-service/files/activity/9000', bin(zip('a.fit', FIT_POWER))], ['GET', '/athlete/i9', json(200, { id: 'i9' })]]);
  const env = { STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'sec-123', PUBLIC_ORIGIN: 'https://justwatts.test' };
  const H = makeHandler({ fetch: f, store: raw, key: KEY32, userId: async r => (r.headers.cookie === 'sid=ok' ? 'u1' : null), now: () => c, sleep: async () => {}, log: m => logs.push(m), env });
  const auth = { cookie: 'sid=ok' };
  const prof = await req(H, 'GET', '/api/integrations?op=import_profile&service=garmin', auth);
  eq([prof.code, prof.body.values.hr_max, prof.body.values.ftp], [200, 188, undefined], 'partial profile over HTTP');
  ok(prof.body.missing.includes('ftp') && prof.body.errors.ftp, 'what failed is named');
  const line = logs.find(m => m.startsWith('import garmin profile'));
  ok(line && line.includes('ftp') && !line.includes('188') && !line.includes('Bearer'), 'log names fields, no values, no tokens');
  const list = await req(H, 'GET', '/api/integrations?op=import_list&service=garmin&since=2026-01-01&until=2026-10-30', auth);
  eq([list.code, list.body.items.length, list.body.more], [200, 4, false], 'list over HTTP');
  ok(logs.some(m => m === 'import garmin list: 1 entries not read as rides'), 'skipped count logged');
  eq((await req(H, 'GET', '/api/integrations?op=import_list&service=garmin&since=bad', auth)).code, 400, 'bad date');
  const fit = await req(H, 'GET', '/api/integrations?op=import_fit&service=garmin&activity=9000', auth);
  eq([fit.code, fit.raw.equals(FIT_POWER)], [200, true], 'fit over HTTP');
  const miss = await req(H, 'GET', '/api/integrations?op=import_fit&service=garmin&activity=9999', auth);
  eq([miss.code, miss.body.kind], [502, 'blocked'], 'missing file: blocked');
  eq((await req(H, 'GET', '/api/integrations?op=import_profile&service=trainingpeaks', auth)).body.kind, 'blocked', 'no import for TrainingPeaks');
  eq((await req(H, 'GET', '/api/integrations?op=import_profile&service=garmin')).code, 401, 'signed out');
  // listing: import caps, Strava with OAuth when its app is set up
  const rows = Object.fromEntries((await req(H, 'GET', '/api/integrations', auth)).body.integrations.map(r => [r.id, r]));
  eq([rows.garmin.caps.import, rows.intervals.caps.import, rows.trainingpeaks.caps.import, rows.strava.caps.import], [true, true, false, true], 'import caps');
  eq([rows.strava.connect.kind, rows.strava.connect.url, rows.strava.status.configured], ['oauth', '/api/integrations?op=strava_start', true], 'strava row');
  const noApp = makeHandler({ fetch: f, store: raw, key: KEY32, userId: async () => 'u1', env: {} });
  eq((await req(noApp, 'GET', '/api/integrations')).body.integrations.find(r => r.id === 'strava').connect, null, 'no Strava app: by hand');
  // Garmin syncs to Strava: the row says so, Connect stays for importing
  await us.setState('integrations', { garmin: { syncs_to: ['strava'] } });
  const r2 = (await req(H, 'GET', '/api/integrations', auth)).body.integrations.find(r => r.id === 'strava');
  eq([r2.synced_by_garmin, r2.auto, !!r2.connect], [true, false, true], 'synced by Garmin, still connectable');
  // OAuth round trip
  const start = await req(H, 'GET', '/api/integrations?op=strava_start', auth);
  eq(start.code, 302, 'start redirects');
  const st = new URL(start.headers.Location).searchParams.get('state');
  const f2 = fakeFetch([['POST', '/oauth/token', json(200, { access_token: 'a', refresh_token: 'b', expires_at: c + 9999, athlete: { id: 1, firstname: 'E' } })]]);
  const H2 = makeHandler({ fetch: f2, store: raw, key: KEY32, userId: async r => (r.headers.cookie === 'sid=ok' ? 'u1' : null), now: () => c, env });
  const cb = await req(H2, 'GET', `/api/integrations?op=strava_callback&code=abcdef&scope=read,activity:write&state=${encodeURIComponent(st)}`, auth);
  eq([cb.code, cb.headers.Location], [302, '/?integration=strava&result=connected#settings'], 'callback back to settings');
  const cbOut = await req(H2, 'GET', `/api/integrations?op=strava_callback&code=abcdef&state=${encodeURIComponent(st)}`);
  ok(cbOut.headers.Location.includes('reason=signed_out'), 'callback signed out');
  const H3 = makeHandler({ fetch: fakeFetch([['POST', '/oauth/token', json(403, { message: 'Limit of connected athletes exceeded' })]]), store: memoryStore(), key: KEY32, userId: async () => 'u1', now: () => c, env });
  const st3 = new URL((await req(H3, 'GET', '/api/integrations?op=strava_start')).headers.Location).searchParams.get('state');
  ok((await req(H3, 'GET', `/api/integrations?op=strava_callback&code=abcdef&state=${encodeURIComponent(st3)}`)).headers.Location.includes('reason=strava_capped'), 'cap reaches the page');
  // imported rides are never uploaded
  const h = hub({ fetch: f, store: us, now: () => c, sleep: async () => {} });
  await rejects(h.upload('imp-garmin-9000', FIT_POWER, { name: 'x' }, ['garmin']), 'blocked', 'no upload of imported rides');
}

/* ---------- the page's import flow: options, progress, dedupe, stop + resume, newest first, rate windows ---------- */
function mem() { const m = new Map(); return { get: (k, d) => (m.has(k) ? structuredClone(m.get(k)) : d), set: (k, v) => m.set(k, structuredClone(v)), del: k => m.delete(k), m }; }
{
  eq(DEFAULT_RANGE, 'all', 'All by default');
  eq(rangeDates('none'), null, 'none');
  eq(rangeDates('all').since, '2000-01-01', 'all since 2000');
  eq(rangeDates('30', new Date(2026, 9, 29, 12)), { since: '2026-09-29', until: '2026-10-30' }, '30 days');
  const rows = profileRows({ ftp: 265, weight_kg: 78.4, hr_max: 188, hr_zones: [100, 120, 140, 155, 166], hr_rest: 49, lthr: 167 }, { ftp: 200, weight: 78.4, hrMax: null, units: 'metric' }, { units: 'metric' });
  eq(rows.map(r => [r.key, r.text, r.nowText, r.differs]), [['ftp', '265 W', '200 W', true], ['weight_kg', '78.4 kg', '78.4 kg', false], ['hr_max', '188 bpm', null, true], ['hr_zones', '100 / 120 / 140 / 155 / 166', null, true]], 'checklist: differs pre-ticked');
  eq(rows[0].patch, { ftp: 265, ftpSrc: 'garmin' }, 'ftp patch');
  eq(rows[3].patch, { hrZones: [100, 120, 140, 155, 166], hrZonesSrc: 'garmin' }, 'zones patch');
  eq(profileRows({ weight_kg: 78.4 }, { weight: 0 }, { units: 'imperial' })[0].text, '173 lb', 'imperial weight');
  eq(infoOnly({ hr_rest: 49, lthr: 167 }), ['Resting HR 49 bpm', 'LTHR 167 bpm'], 'values without a setting are shown only');

  const DAY = 864e5, base = Date.UTC(2026, 9, 28, 7);
  const items = Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i), name: `R${i}`, start_ms: base - i * DAY, indoor: i % 2 === 0 }));
  const history = [{ id: 'web-1', start: base - 3 * DAY + 60000 }];   // a Just Watts ride, uploaded to Garmin: same ride, 1 min apart
  const saved = [], storage = mem(), slept = [];
  let fitCalls = 0, failOn = null, authOn = null, rlOn = null;
  const api = {
    list: async (svc, q) => { const s = q.start || 0; return { items: items.slice(s, s + 5), more: s + 5 < items.length, next: s + 5 }; },
    fit: async (svc, id) => {
      fitCalls++;
      if (id === failOn) throw Object.assign(new Error('Garmin said 404'), { status: 502, kind: 'blocked' });
      if (id === authOn) { authOn = null; throw Object.assign(new Error('signed out'), { status: 401, kind: 'auth' }); }
      if (id === rlOn) { rlOn = null; throw Object.assign(new Error('rate'), { status: 502, kind: 'temporary', retryAfter: 300 }); }
      const it = items.find(x => x.id === id), r = { ...encRide, samples: encRide.samples.slice(0, 120).map((x, i) => [it.start_ms + i * 1000, ...x.slice(1)]) };
      return fitEncode(r);
    },
  };
  const mk = () => createImporter({ api, rides: async () => [...history, ...saved.map(r => ({ id: r.id, start: r.start }))], saveRide: async r => { saved.push(r); return true; },
    storage, settings: () => ({ ftp: 250 }), sleep: async ms => { slept.push(ms); } });
  let imp = mk();
  const p = await imp.plan('garmin', { range: 'all', kind: 'cycling' });
  eq([p.total, p.items.length, p.dupes], [12, 11, 1], 'plan: every page, the uploaded ride deduped');
  eq(p.items.map(x => x.start_ms), [...p.items.map(x => x.start_ms)].sort((a, b) => b - a), 'newest first');
  eq((await imp.plan('garmin', { range: 'all', kind: 'indoor' })).items.length, 6, 'indoor only');
  eq((await imp.plan('garmin', { range: 'none' })).items.length, 0, 'none');
  // run, stop part way (the page closes), resume in a new page
  const seen = [];
  failOn = '104';
  let stopAfter = 4;
  const v1 = await imp.start('garmin', { range: 'all', kind: 'cycling' }, v => { seen.push(v); if (v.done === stopAfter) imp.stop(); });
  ok(seen[0].finding >= 5, 'finding rides shows a count');
  eq([v1.done, v1.imported, v1.left, v1.total], [4, 3, 7, 11], 'stopped after 4: one unreadable');
  eq(saved[0].id, 'imp-garmin-100', 'newest saved first');
  ok(seen.some(v => v.total === 11 && v.done === 1), 'progress per ride');
  eq(storage.get(KEY).todo.length, 7, 'job kept for later');
  imp = mk();  // next visit
  eq(imp.pending().left, 7, 'offered again');
  authOn = items[6].id;
  const v2 = await imp.run(() => {});
  eq([v2.paused, v2.left], ['auth', 6], 'sign-in trouble pauses, the ride stays queued');
  rlOn = items[8].id;
  const v3 = await imp.run(() => {});
  eq([v3.finished, v3.left, v3.imported, v3.failed], [true, 0, 10, 1], 'resumed to the end');
  ok(slept.filter(x => x === 1000).length >= 300, 'a rate window is waited out a second at a time');
  eq(new Set(saved.map(r => r.id)).size, saved.length, 'no ride twice');
  ok(saved.every(r => r.source === 'garmin' && r.imported && /^imp-garmin-/.test(r.id) && r.ftp === 250), 'imported rides tagged');
  eq(imp.pending(), null, 'nothing left');
  // run again: everything is already in History
  const p2 = await mk().plan('garmin', { range: 'all' });
  eq([p2.items.length, p2.dupes], [1, 11], 'second import: only the unreadable one is retried');
  imp.discard(); eq(storage.get(KEY, null), null, 'discard');
  // a page of the list fails: start throws, nothing saved
  const bad = createImporter({ api: { list: async () => { throw Object.assign(new Error('Garmin said 500'), { kind: 'temporary' }); }, fit: api.fit }, rides: async () => [], saveRide: async () => true, storage: mem(), sleep: async () => {} });
  await assert.rejects(bad.start('garmin', { range: '30' })); checks++;
  eq(fitCalls > 0, true, 'files fetched one at a time');
}

/* ---------- Strava rate limits: headers -> waits, the importer pauses and resumes by itself ---------- */
{
  const env = { STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'x-secret', PUBLIC_ORIGIN: 'https://justwatts.test', STRAVA_CAPPED: '0' };
  const c = 1_800_000_100, us = userStore(memoryStore(), KEY32, 'u1');
  await us.setSecret('strava', { access_token: 'a', refresh_token: 'b', expires_at: c + 9999 });
  const rate = (u15, uday) => ({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': `${u15},${uday}` });
  let usage = [10, 100];
  const f = fakeFetch([
    ['GET', '/streams', () => json(200, { time: { data: [0, 1] } }, rate(...usage))],
    ['GET', '/api/v3/activities/', () => json(200, { start_date: '2026-10-20T14:00:00Z' }, rate(...usage))],
    ['GET', '/athlete/activities', () => json(200, [], rate(...usage))],
  ]);
  const s = strava({ fetch: f, now: () => c, env, key: KEY32, sleep: async () => {} });
  eq((await s.status(us)).capped, false, 'cap lifted');
  eq((await s.importFit(us, '1')).wait, 0, 'far from the limits: no wait');
  usage = [97, 100];
  const w15 = (await s.importFit(us, '1')).wait;
  ok(w15 > 0 && w15 <= 905, '15 min window nearly used: wait for the next one');
  usage = [10, 998];
  ok((await s.importFit(us, '1')).wait > 900, 'daily limit nearly used: wait to the reset');
  eq((await s.importList(us, { since: '2026-01-01', until: '2026-10-30' })).wait > 900, true, 'list carries the wait');
  const f429 = fakeFetch([['GET', '/api/v3/activities/', json(429, { message: 'Rate Limit Exceeded' }, rate(100, 1000))]]);
  const e = await rejects(strava({ fetch: f429, now: () => c, env, key: KEY32 }).importFit(us, '1'), 'temporary', '429 at the daily limit');
  ok(e.retryAfter > 900, '429 waits to the daily reset');
  // over HTTP: the wait goes to the page as a header, a 429 as Retry-After
  const raw = memoryStore(); await userStore(raw, KEY32, 'u1').setSecret('strava', { access_token: 'a', refresh_token: 'b', expires_at: c + 9999 });
  usage = [98, 10];
  const H = makeHandler({ fetch: f, store: raw, key: KEY32, userId: async () => 'u1', now: () => c, env });
  const r = await req(H, 'GET', '/api/integrations?op=import_fit&service=strava&activity=1');
  ok(r.code === 200 && +r.headers['X-JW-Wait'] > 0, 'X-JW-Wait header');
  const r429 = await req(makeHandler({ fetch: f429, store: raw, key: KEY32, userId: async () => 'u1', now: () => c, env }), 'GET', '/api/integrations?op=import_fit&service=strava&activity=1');
  ok(r429.code === 502 && +r429.headers['Retry-After'] > 900 && r429.body.retry_after > 900, 'Retry-After on a 429');
  // the importer: a short window waits in place, the daily limit pauses with a resume time, then goes on by itself
  const clock = { t: Date.UTC(2026, 9, 29, 10) }, storage = mem(), slept = [];
  const items = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), name: `S${i}`, start_ms: T0 - i * 864e5 }));
  const waits = { 1: 600, 2: 50000 };
  const imp = createImporter({ storage, now: () => clock.t, settings: () => ({ ftp: 200 }), sleep: async ms => { slept.push(ms); clock.t += ms; },
    rides: async () => [], saveRide: async () => true,
    api: { list: async () => ({ items, more: false, next: 4 }),
      fit: async (svc, id) => { const b = new TextEncoder().encode(JSON.stringify({ kind: 'streams', start_ms: items[+id - 1].start_ms, streams: { time: [0, 1, 2], watts: [100, 100, 100] } })); b.wait = waits[id] || 0; return b; } } });
  const views = [];
  const v1 = await imp.start('strava', { range: 'all' }, v => views.push(v));
  ok(views.some(v => v.waiting_s > 500), 'the 15 min wait is shown');
  eq([v1.paused, v1.done, v1.left], ['rate', 2, 2], 'daily limit: paused');
  eq(v1.resume_at, clock.t + 50000 * 1000, 'with its resume time');
  eq((await imp.run()).paused, 'rate', 'not before its time');
  clock.t = v1.resume_at + 1;
  const v2 = await createImporter({ storage, now: () => clock.t, settings: () => ({ ftp: 200 }), sleep: async () => {}, rides: async () => [], saveRide: async () => true,
    api: { fit: async (svc, id) => new TextEncoder().encode(JSON.stringify({ kind: 'streams', start_ms: items[+id - 1].start_ms, streams: { time: [0, 1] } })) } }).run();
  eq([v2.finished, v2.imported], [true, 4], 'resumed after a page close, finished');
}

/* ---------- the same ride from two services: the richer copy stays ---------- */
{
  const start = T0, storage = mem();
  let hist = [{ id: 'imp-strava-55', start }, { id: 'web-own', start: start + 5 * 864e5 }];
  const deleted = [];
  const mk = svc => createImporter({ storage, settings: () => ({ ftp: 250 }), sleep: async () => {},
    rides: async () => hist, saveRide: async r => { hist.push({ id: r.id, start: r.start }); return true; }, deleteRide: async id => { deleted.push(id); hist = hist.filter(x => x.id !== id); return true; },
    api: { list: async () => ({ items: [{ id: '900', name: 'G', start_ms: start + 30000 }, { id: '901', name: 'Own', start_ms: start + 5 * 864e5 }], more: false, next: 2 }),
      fit: async (s, id) => { const st0 = id === '900' ? start + 30000 : start + 5 * 864e5; return fitEncode({ ...encRide, samples: encRide.samples.slice(0, 60).map((x, i) => [st0 + i * 1000, ...x.slice(1)]) }); } } });
  const p = await mk('garmin').plan('garmin', { range: 'all' });
  eq([p.items.map(x => x.id), p.dupes], [['900'], 1], 'Garmin beats Strava streams; never a Just Watts ride');
  const v = await mk('garmin').start('garmin', { range: 'all' });
  eq([v.imported, v.replaced, deleted], [1, 1, ['imp-strava-55']], 'the Strava copy is replaced');
  const back = await mk('strava').plan('strava', { range: 'all' });
  eq(back.items.length, 0, 'Strava never replaces Garmin');
}

/* ---------- Strava capped: the row says so, Connect only on request ---------- */
{
  const H = makeHandler({ fetch: fakeFetch([]), store: memoryStore(), key: KEY32, userId: async () => 'u1', env: { STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's', PUBLIC_ORIGIN: 'https://justwatts.test' } });
  const row = (await req(H, 'GET', '/api/integrations')).body.integrations.find(r => r.id === 'strava');
  eq([row.status.capped, row.status.connected, !!row.connect, row.manual.url], [true, false, true, 'https://www.strava.com/upload/select'], 'capped row: manual route at hand');
  const { CAP_NOTE } = await import(url('connect.js'));
  eq(CAP_NOTE, "Just Watts has hit Strava's user limit. Direct Strava connection is coming back soon.", 'cap wording');
  ok(!/\u2014/.test(CAP_NOTE), 'no em dash');
}

console.log(JSON.stringify({ checks }));
