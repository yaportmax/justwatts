// Web integrations (web/api/_lib/integrations) against stubbed fetch with recorded-shape responses.
// Never touches the network. Prints {checks, planned} as JSON; tests/test_integrations_web.py asserts on it.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const root = process.argv[2];
const L = m => require(`${root}/web/api/_lib/integrations/${m}.js`);
const { seal, open, loadKey } = L('crypto');
const { memoryStore, userStore } = L('store');
const { garmin, setCookies, jwtExp } = L('garmin');
const { trainingpeaks } = L('trainingpeaks');
const { intervals } = L('intervals');
const { hub, DELAYS } = L('hub');
const { makeHandler } = L('http');
const P = L('planned');
const base = L('base');
const { parseTree } = await import(`file:///${root.replace(/\\/g, '/')}/app/js/core.js`);

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const rejects = async (p, kind, m) => { try { await p; } catch (e) { eq(e.kind, kind, m + ': ' + e.message); return e; } assert.fail(m + ': did not throw'); };

const KEY = Buffer.alloc(32, 7);
const PASSWORD = 'garmin-pass-123456', ICU_KEY = 'icukey-0123456789abcdef', TP_COOKIE = 'tpcookie_' + 'A1b2C3d4'.repeat(6);
const FIT = Buffer.concat([Buffer.from([14, 32, 0, 0, 0, 0, 0, 0]), Buffer.from('.FIT'), Buffer.alloc(40)]);
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const clock = () => { const c = { t: 1_800_000_000 }; c.now = () => c.t; return c; };
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push({ url, ...opt, body: opt.body });
    for (const [method, sub, resp] of routes) {
      if ((opt.method || 'GET') === method && url.includes(sub)) {
        const r = Array.isArray(resp) ? (resp.length > 1 ? resp.shift() : resp[0]) : resp;
        return typeof r === 'function' ? r(url, opt) : r.clone();
      }
    }
    return json(404, {});
  };
  f.calls = calls;
  return f;
}
const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const us = () => userStore(memoryStore(), KEY, 'u1');

// ---------- crypto + store ----------
{
  const s = seal(KEY, { a: 1 }, 'justwatts:u1:garmin');
  eq(open(KEY, s, 'justwatts:u1:garmin'), { a: 1 }, 'roundtrip');
  assert.throws(() => open(KEY, s, 'justwatts:u2:garmin')); checks++;  // bound to user + service
  assert.throws(() => open(Buffer.alloc(32, 8), s, 'justwatts:u1:garmin')); checks++;
  eq(loadKey(KEY.toString('base64')).length, 32, 'base64 key');
  eq(loadKey('ab'.repeat(32)).length, 32, 'hex key');
  eq(loadKey(''), null, 'no key');
  assert.throws(() => loadKey('short')); checks++;
  const raw = memoryStore(), u = userStore(raw, KEY, 'u1');
  await u.setSecret('intervals', { api_key: ICU_KEY });
  ok(!JSON.stringify([...raw._map.values()]).includes(ICU_KEY), 'only ciphertext stored');
  eq((await u.secret('intervals')).api_key, ICU_KEY, 'read back');
}

// ---------- Garmin (web) ----------
{
  eq(setCookies(new Headers([['set-cookie', 'SESSION=abc; Path=/'], ['set-cookie', '__cf_bm=x; HttpOnly']])), ['SESSION=abc', '__cf_bm=x'], 'cookie jar');
  eq(jwtExp(jwt(123)), 123, 'jwt exp');
  const c = clock(), store = us();
  const login = [json(200, { responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: { mfaLastMethodUsed: 'email' } }, { 'set-cookie': 'GARMIN-SSO=1; Path=/' })];
  const f = fakeFetch([
    ['GET', '/mobile/sso/en_US/sign-in', new Response('<html/>', { status: 200, headers: [['set-cookie', 'SESSION=s1; Path=/'], ['set-cookie', '__cf_bm=cf; Path=/']] })],
    ['POST', '/mobile/api/login', login],
    ['POST', '/mobile/api/mfa/verifyCode', (url, opt) => JSON.parse(opt.body).mfaVerificationCode === '123456'
      ? json(200, { serviceTicketId: 'ST-123-abc' }) : json(200, { responseStatus: { type: 'INVALID_MFA_CODE' } })],
    ['POST', 'diauth.garmin.com', (url, opt) => {
      const b = new URLSearchParams(opt.body);
      if (b.get('grant_type') === 'refresh_token') return json(200, { access_token: jwt(c.t + 7200), refresh_token: 'di-refresh-2' });
      if (b.get('client_id') === 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2') return json(400, { error: 'invalid_client' });  // first client id retired
      return json(200, { access_token: jwt(c.t + 3600), refresh_token: 'di-refresh-1' });
    }],
    ['POST', 'upload-service/upload', [json(202, { detailedImportResult: { successes: [{ internalId: 555 }], failures: [] } }),
      json(409, { detailedImportResult: { failures: [{ messages: [{ code: 202, content: 'Duplicate Activity.' }] }] } }),
      json(401, {}), json(202, { detailedImportResult: { successes: [{ internalId: 556 }], failures: [] } })]],
  ]);
  const slept = [];
  const g = garmin({ fetch: f, now: c.now, sleep: async ms => { slept.push(ms); } });
  await rejects(g.connect(store, { email: 'a@example.com' }), 'auth', 'password required');
  const r1 = await g.connect(store, { email: 'a@example.com', password: PASSWORD });
  eq(r1, { mfa_required: true, mfa_method: 'email' }, 'mfa asked');
  ok(slept[0] >= 2000, 'waits between page and login');
  const loginCall = f.calls.find(x => x.url.includes('/mobile/api/login'));
  eq(JSON.parse(loginCall.body), { username: 'a@example.com', password: PASSWORD, rememberMe: true, captchaToken: '' }, 'login body');
  ok(loginCall.headers.Cookie.includes('SESSION=s1') && loginCall.headers.Cookie.includes('__cf_bm=cf'), 'sign-in cookies sent');
  ok(loginCall.url.includes('clientId=GCM_IOS_DARK'), 'mobile client id');
  await rejects(g.connect(store, { mfa_code: '000000' }), 'auth', 'wrong code');
  eq(await g.connect(store, { mfa_code: '123456' }), { connected: true }, 'connected after mfa');
  const mfaCall = f.calls.find(x => x.url.includes('verifyCode'));
  ok(mfaCall.headers.Cookie.includes('GARMIN-SSO=1'), 'mfa keeps the login cookies');
  const di = f.calls.filter(x => x.url.includes('diauth'));
  eq(di.map(x => new URLSearchParams(x.body).get('client_id')), ['GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2', 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4'], 'client id fallback');
  eq(new URLSearchParams(di[1].body).get('service_ticket'), 'ST-123-abc', 'ticket exchanged');
  eq(di[1].headers.Authorization, 'Basic ' + Buffer.from('GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4:').toString('base64'), 'basic client auth');
  const saved = await store.secret('garmin');
  eq(Object.keys(saved).sort(), ['di_client_id', 'di_refresh_token', 'di_token', 'expires_at'], 'only tokens stored');
  ok(!JSON.stringify(saved).includes(PASSWORD), 'password never stored');
  eq(await store.secret('garmin_mfa'), null, 'pending mfa cleared');
  const up = await g.upload(store, FIT, { ride_id: 'r1', filename: 'r1.fit' });
  eq(up, { activity_id: 555, url: 'https://connect.garmin.com/modern/activity/555' }, 'upload ok');
  const upCall = f.calls.find(x => x.url.includes('upload-service'));
  ok(upCall.headers.Authorization.startsWith('Bearer ') && upCall.headers['X-Garmin-Client-Platform'] === 'Android', 'native headers');
  ok(upCall.body.includes(FIT) && upCall.body.toString('latin1').includes('name="file"; filename="r1.fit"'), 'multipart file');
  eq((await g.upload(store, FIT, { ride_id: 'r1' })).duplicate, true, '409 duplicate');
  eq((await g.upload(store, FIT, { ride_id: 'r1' })).activity_id, 556, '401 refreshes once then succeeds');
  eq((await store.secret('garmin')).di_refresh_token, 'di-refresh-2', 'rotated refresh token stored');
  c.t += 7200;  // token near expiry: refreshed before the call
  const before = f.calls.filter(x => x.url.includes('diauth')).length;
  await g.upload(store, FIT, { ride_id: 'r2' });
  eq(f.calls.filter(x => x.url.includes('diauth')).length, before + 1, 'proactive refresh');
  // refresh refused: reconnect needed
  const g2 = garmin({ fetch: fakeFetch([['POST', 'diauth', json(401, {})]]), now: () => c.t + 99999, sleep: async () => {} });
  await rejects(g2.upload(store, FIT, { ride_id: 'r3' }), 'auth', 'expired refresh');
  // Garmin walls the login (429, captcha, 403): blocked, with the fallbacks in the message
  for (const resp of [json(429, {}), json(200, { responseStatus: { type: 'CAPTCHA_REQUIRED' } }), json(200, { error: { 'status-code': '429' } })]) {
    const g3 = garmin({ fetch: fakeFetch([['GET', 'sign-in', new Response('', { status: 200 })], ['POST', '/mobile/api/login', resp]]), now: c.now, sleep: async () => {} });
    const e = await rejects(g3.connect(us(), { email: 'a@example.com', password: PASSWORD }), 'blocked', 'login walled');
    ok(/manually/.test(e.message) && !e.message.includes(PASSWORD), 'blocked message');
  }
  const g4 = garmin({ fetch: fakeFetch([['GET', 'sign-in', new Response('', { status: 200 })], ['POST', '/mobile/api/login', json(200, { responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } })]]), now: c.now, sleep: async () => {} });
  await rejects(g4.connect(us(), { email: 'a@example.com', password: 'nope' }), 'auth', 'bad password');
  const g5 = garmin({ fetch: fakeFetch([['GET', 'sign-in', new Response('', { status: 200 })], ['POST', '/mobile/api/login', json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-9' })],
    ['POST', 'diauth', json(200, { access_token: jwt(c.t + 3600), refresh_token: 'r' })], ['POST', 'upload-service', json(429, {}, { 'retry-after': '120' })]]), now: c.now, sleep: async () => {} });
  const s5 = us();
  eq(await g5.connect(s5, { email: 'a@example.com', password: PASSWORD }), { connected: true }, 'no-mfa login');
  const e5 = await rejects(g5.upload(s5, FIT, { ride_id: 'r' }), 'temporary', 'upload 429');
  eq(e5.retryAfter, 120, 'retry-after');
  // MFA pending expires
  const c6 = clock(), s6 = us();
  const g6 = garmin({ fetch: fakeFetch([['GET', 'sign-in', new Response('', { status: 200 })], ['POST', '/mobile/api/login', json(200, { responseStatus: { type: 'MFA_REQUIRED' } })]]), now: c6.now, sleep: async () => {} });
  await g6.connect(s6, { email: 'a@example.com', password: PASSWORD });
  c6.t += 301;
  await rejects(g6.connect(s6, { mfa_code: '123456' }), 'auth', 'mfa timeout');
  // network down: temporary
  await rejects(garmin({ fetch: async () => { throw new Error('ECONNRESET'); }, now: c.now }).upload(store, FIT, { ride_id: 'r' }), 'temporary', 'network');
}

// ---------- TrainingPeaks (web) ----------
{
  const c = clock(), store = us();
  const user = json(200, { user: { userId: 11, personId: 22, firstName: 'Test', lastName: 'Rider', athletes: [{ athleteId: 33 }, { athleteId: 22 }] } });
  let day = [];
  const f = fakeFetch([
    ['GET', '/users/v3/token', (url, opt) => opt.headers.Cookie === `Production_tpAuth=${TP_COOKIE}` ? json(200, { success: true, token: { access_token: 'tp-access-1', expires_in: 3600 } }) : json(401, {})],
    ['GET', '/users/v3/user', user],
    ['GET', '/workouts/2026-10-28/2026-10-28', () => json(200, day)],
    ['POST', '/workouts/filedata', json(200, { workoutId: 77 })],
  ]);
  const tp = trainingpeaks({ fetch: f, now: c.now });
  await rejects(tp.connect(store, { cookie: 'nope' }), 'auth', 'bad cookie text');
  const st = await tp.connect(store, { cookie: `x=1; Production_tpAuth=${TP_COOKIE}; y=2` });
  eq([st.connected, st.athlete_id, st.account], [true, '22', 'Test Rider'], 'tp connect');
  ok(!JSON.stringify(st).includes(TP_COOKIE), 'cookie not in status');
  const meta = { ride_id: 'r1', filename: 'r1.fit', start_ms: Date.UTC(2026, 9, 28, 7), local_start: '2026-10-28T07:00:00', duration_s: 3600 };
  eq(await tp.upload(store, FIT, meta), { activity_id: 77, url: 'https://app.trainingpeaks.com/#calendar/workout/77' }, 'tp upload');
  const post = f.calls.find(x => x.method === 'POST');
  const body = JSON.parse(post.body);
  eq([Buffer.from(body.data, 'base64').equals(FIT), body.fileName, body.workoutDay], [true, 'r1.fit', null], 'tp upload body');
  ok(post.url.endsWith('/fitness/v6/athletes/22/workouts/filedata') && post.headers.Authorization === 'Bearer tp-access-1', 'tp upload call');
  day = [{ workoutId: 3, totalTime: 1.0, startTime: '2026-10-28T07:01:00' }];
  eq((await tp.upload(store, FIT, meta)).duplicate, true, 'tp duplicate by start time');
  eq(f.calls.filter(x => x.method === 'POST').length, 1, 'no second post');
  // planned with a real structure
  const fx = JSON.parse(readFileSync(`${root}/tests/fixtures/planned.json`, 'utf8')).trainingpeaks;
  day = [{ workoutId: 5, title: 'Threshold', workoutTypeValueId: 2, totalTimePlanned: 1.5, structure: fx[0].structure, workoutDay: '2026-10-28T00:00:00' },
    { workoutId: 7, title: 'Run', workoutTypeValueId: 3, totalTimePlanned: 1 }];
  eq((await tp.planned(store, '2026-10-28')).map(w => [w.id, w.text]), [['5', fx[0].expect]], 'tp planned');
  // cookie dies: auth everywhere
  const dead = trainingpeaks({ fetch: fakeFetch([['GET', '/users/v3/token', json(401, {})], ['GET', '/workouts/', json(401, {})]]), now: () => c.t + 99999 });
  const e = await rejects(dead.planned(store, '2026-10-28'), 'auth', 'tp expired');
  ok(/fresh/.test(e.message), 'reconnect message');
  await rejects(trainingpeaks({ fetch: fakeFetch([['GET', '/workouts/', json(429, {})], ['POST', 'filedata', json(429, {})]]), now: c.now }).upload(store, FIT, meta), 'temporary', 'tp 429');
}

// ---------- intervals.icu (web) ----------
{
  const store = us();
  const f = fakeFetch([
    ['GET', '/athlete/i123', (url, opt) => opt.headers.Authorization === 'Basic ' + Buffer.from(`API_KEY:${ICU_KEY}`).toString('base64') ? json(200, { id: 'i123', name: 'Test Rider' }) : json(401, {})],
    ['POST', '/activities', [json(201, { id: 'i9', activities: [{ id: 'i9' }] }), json(200, { id: 'i9', activities: [{ id: 'i9' }] }),
      new Response('<html>Just a moment...</html>', { status: 403, headers: { 'content-type': 'text/html' } })]],
  ]);
  const icu = intervals({ fetch: f });
  eq((await icu.connect(store, { athlete_id: 'i123', api_key: ICU_KEY })).account, 'Test Rider', 'icu connect');
  eq(await icu.upload(store, FIT, { ride_id: 'r1', name: 'Tempo' }), { activity_id: 'i9', url: 'https://intervals.icu/activities/i9', duplicate: false }, 'icu upload');
  eq((await icu.upload(store, FIT, { ride_id: 'r1' })).duplicate, true, 'icu 200 duplicate');
  await rejects(icu.upload(store, FIT, { ride_id: 'r1' }), 'blocked', 'cloudflare wall');
  await rejects(intervals({ fetch: fakeFetch([['GET', '/athlete/', json(403, { error: 'Access denied' })]]) }).connect(us(), { athlete_id: 'i1', api_key: ICU_KEY }), 'auth', 'icu bad key');
}

// ---------- hub: retries with a fake clock, defaults, targets ----------
{
  const c = clock(), raw = memoryStore(), store = userStore(raw, KEY, 'u1');
  await store.setSecret('intervals', { athlete_id: 'i1', api_key: ICU_KEY });
  const uploads = [json(503, {}), json(503, {}), json(201, { id: 'i5', activities: [{ id: 'i5' }] })];
  const f = fakeFetch([['POST', '/activities', uploads]]);
  const h = hub({ fetch: f, store, now: c.now, sleep: async () => {} });
  let t = await h.upload('r1', FIT, { name: 'R', start_ms: 1 });
  let row = t.targets.find(x => x.id === 'intervals');
  eq([row.upload.state, row.upload.tries, row.upload.action], ['pending', 1, 'retry'], 'first try failed, retry scheduled');
  eq(row.upload.next_retry_at, (c.t + DELAYS[0]) * 1000, 'backoff 1');
  eq(row.upload.fallback.fit_url, '/api/integrations?op=fit&ride=r1', 'fallback link');
  eq((await h.fit('r1')).equals(FIT), true, 'fit kept for the fallback');
  t = await h.retry(null, null);  // not due yet
  eq(f.calls.length, 1, 'not due: no call');
  c.t += DELAYS[0];
  t = await h.retry('r1', null);
  row = t.targets.find(x => x.id === 'intervals');
  eq([row.upload.state, row.upload.tries, row.upload.next_retry_at], ['pending', 2, (c.t + DELAYS[1]) * 1000], 'backoff 2');
  c.t += DELAYS[1];
  t = await h.retry('r1', null);
  row = t.targets.find(x => x.id === 'intervals');
  eq([row.upload.state, row.upload.activity_id, row.upload.fallback], ['done', 'i5', undefined], 'third try done');
  ok(!JSON.stringify([...raw._map.values()]).includes(ICU_KEY), 'no secret in stored state');
  // Garmin question and defaults
  await store.setSecret('garmin', { di_token: jwt(c.t + 9999), di_refresh_token: 'r', di_client_id: 'x', expires_at: c.t + 9999 });
  await store.setSecret('trainingpeaks', { cookie: TP_COOKIE, athlete_id: '1' });
  let rows = Object.fromEntries((await h.list()).map(r => [r.id, r]));
  eq(Object.keys(rows), ['garmin', 'strava', 'trainingpeaks', 'intervals', 'coros', 'polar', 'suunto', 'wahoo'], 'web order');
  ok(rows.garmin.syncs_question && rows.trainingpeaks.auto && !rows.trainingpeaks.duplicate_risk, 'unknown: ask, keep defaults');
  eq(rows.garmin.recommended_reason, 'Uploads here can sync on to apps you link in Garmin Connect.', 'generic reason');
  await h.setSyncs(['trainingpeaks']);
  rows = Object.fromEntries((await h.list()).map(r => [r.id, r]));
  eq([rows.trainingpeaks.auto, rows.intervals.auto, rows.garmin.recommended_reason], [false, true, 'Garmin also sends your rides to TrainingPeaks.'], 'answer sets defaults');
  await h.setAuto('trainingpeaks', true);
  rows = Object.fromEntries((await h.list()).map(r => [r.id, r]));
  eq(rows.trainingpeaks.duplicate_warning, 'Garmin already syncs to TrainingPeaks. Uploading to both makes duplicates.', 'dup warning');
  ok(rows.trainingpeaks.duplicate_risk && rows.garmin.unofficial_note.startsWith("Unfortunately Garmin Connect doesn't allow"), 'tooltip');
  eq(rows.strava.connect, null, 'strava manual on the web');
  // connect then upload this ride now
  const h2 = hub({ fetch: fakeFetch([['GET', '/athlete/i7', json(200, { id: 'i7' })], ['POST', '/activities', json(201, { id: 'i8', activities: [{ id: 'i8' }] })]]), store: us(), now: c.now });
  const st2 = h2;
  let t2 = await st2.upload('r9', FIT, { name: 'R' });
  eq(t2.any_connected, false, 'nothing connected');
  const cres = await st2.connect('intervals', { athlete_id: 'i7', api_key: ICU_KEY }, 'r9');
  eq([cres.connected, cres.upload.state, cres.upload.activity_id], [true, 'done', 'i8'], 'connect + upload this ride');
  eq((await st2.connect('intervals', { athlete_id: 'i7', api_key: ICU_KEY }, 'never-posted')).upload_needed, true, 'no FIT yet');
}

// ---------- HTTP handler ----------
async function call(handler, method, url, { body, headers = {} } = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]),
    { method, url, headers: { host: 'justwatts.com', ...headers } });
  return new Promise(resolve => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) {
      const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
      let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch {}
      resolve({ code: this.statusCode, body: j, raw: buf, headers: this.headers });
    } };
    handler(req, res);
  });
}
{
  const page = { origin: 'https://justwatts.com', 'x-hw': '1' };
  const logs = [];
  const f = fakeFetch([['GET', '/athlete/i123', json(200, { id: 'i123', name: 'Test Rider' })], ['POST', '/activities', json(201, { id: 'i9', activities: [{ id: 'i9' }] })],
    ['GET', '/events', json(200, [])]]);
  const store = memoryStore();
  const H = makeHandler({ fetch: f, store, key: KEY, userId: async req => (req.headers.cookie === 'sid=ok' ? 'u1' : null), log: m => logs.push(m) });
  const auth = { cookie: 'sid=ok' };
  eq((await call(makeHandler({ fetch: f, store, key: null, userId: async () => 'u1' }), 'GET', '/api/integrations')).code, 503, 'no key');
  eq((await call(H, 'GET', '/api/integrations')).code, 401, 'signed out');
  eq((await call(H, 'POST', '/api/integrations?op=connect&service=intervals', { body: {}, headers: auth })).code, 403, 'no same-origin');
  eq((await call(H, 'POST', '/api/integrations?op=connect&service=intervals', { body: {}, headers: { ...auth, origin: 'https://evil.example', 'x-hw': '1' } })).code, 403, 'cross-origin');
  const responses = [];
  const r = await call(H, 'POST', '/api/integrations?op=connect&service=intervals', { body: { athlete_id: 'i123', api_key: ICU_KEY }, headers: { ...auth, ...page } });
  responses.push(r);
  eq([r.code, r.body.connected], [200, true], 'handler connect');
  const bad = await call(makeHandler({ fetch: fakeFetch([['GET', '/athlete/', json(401, { msg: ICU_KEY })]]), store: memoryStore(), key: KEY, userId: async () => 'u1' }),
    'POST', '/api/integrations?op=connect&service=intervals', { body: { athlete_id: 'i1', api_key: ICU_KEY }, headers: page });
  responses.push(bad);
  eq([bad.code, bad.body.kind], [401, 'auth'], 'bad key -> 401 auth');
  eq((await call(H, 'POST', '/api/integrations?op=upload&ride=r1', { body: Buffer.from('not a fit'), headers: { ...auth, ...page } })).code, 400, 'FIT check');
  const up = await call(H, 'POST', '/api/integrations?op=upload&ride=r1&name=Tempo&start=1&duration=60', { body: FIT, headers: { ...auth, ...page } });
  responses.push(up);
  eq(up.body.targets.find(x => x.id === 'intervals').upload.state, 'done', 'handler upload');
  const fit = await call(H, 'GET', '/api/integrations?op=fit&ride=r1', { headers: auth });
  eq([fit.code, fit.raw.equals(FIT)], [200, true], 'fit download');
  eq((await call(H, 'GET', '/api/integrations?op=fit&ride=nope', { headers: auth })).code, 404, 'no fit');
  for (const u of ['/api/integrations', '/api/integrations?op=targets&ride=r1', '/api/integrations?op=planned&date=2026-10-28']) responses.push(await call(H, 'GET', u, { headers: auth }));
  eq(responses.slice(-3).map(x => x.code), [200, 200, 200], 'reads');
  eq((await call(H, 'GET', '/api/integrations?op=planned&date=nope', { headers: auth })).code, 400, 'bad date');
  responses.push(await call(H, 'POST', '/api/integrations?op=syncs', { body: { syncs_to: ['strava'] }, headers: { ...auth, ...page } }));
  responses.push(await call(H, 'POST', '/api/integrations?op=disconnect&service=intervals', { body: {}, headers: { ...auth, ...page } }));
  eq(responses.at(-1).body.integrations.find(x => x.id === 'intervals').status.connected, false, 'disconnected');
  const all = responses.map(x => x.raw.toString('utf8')).join('\n') + JSON.stringify([...store._map.values()].map(v => (Buffer.isBuffer(v) ? '' : v))) + logs.join('\n');
  ok(!all.includes(ICU_KEY) && !all.includes(Buffer.from(`API_KEY:${ICU_KEY}`).toString('base64')), 'secret never in responses, store or logs');
  eq((await call(H, 'GET', '/api/integrations?op=bogus', { headers: auth })).code, 404, 'unknown op');
}

// ---------- planned: same fixtures as Python, and core.js must read the result ----------
const fx = JSON.parse(readFileSync(`${root}/tests/fixtures/planned.json`, 'utf8'));
const planned = { intervals: fx.intervals.map(c => P.fromIntervals(c.doc)), trainingpeaks: fx.trainingpeaks.map(c => P.fromTrainingPeaks(c.structure)) };
for (const text of [...planned.intervals, ...planned.trainingpeaks]) { ok(parseTree(text).length > 0, 'core.js parses ' + text); }
eq(base.MANUAL.garmin.url, 'https://connect.garmin.com/modern/import-data', 'manual table');
console.log(JSON.stringify({ checks, planned, manual: base.MANUAL, note: base.UNOFFICIAL_NOTE }));
