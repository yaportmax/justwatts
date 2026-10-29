// Drives the accounts / sync / community API (web/api/_lib) in-process with fake requests, a fake clock
// and stubbed fetch (Resend, Google, Strava). Usage:
//   node accounts_api.mjs <repo> <section|all> [memory|pglite:<path to @electric-sql/pglite>]
// Prints {"<section>": "ok", ...}; any failed assertion exits 1 with the stack on stderr.
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [repo, which = 'all', storeArg = 'memory'] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const lib = n => require(`${repo}/web/api/_lib/${n}.js`);
const ORIGIN = 'https://justwatts.test';
const BASE_ENV = { JUSTWATTS_SESSION_SECRET: 's'.repeat(48), PUBLIC_ORIGIN: ORIGIN };
for (const k of Object.keys(process.env)) if (/^(DATABASE_URL|POSTGRES_|PG|JUSTWATTS_|PUBLIC_ORIGIN|GOOGLE_|STRAVA_|RESEND_|EMAIL_FROM|OWNER_EMAILS|VERCEL_ENV)/.test(k)) delete process.env[k];
Object.assign(process.env, BASE_ENV);
lib('crypto').SCRYPT.N = 1024;  // fast hashes in tests; the stored hash keeps its own parameters
const app = lib('app');
const { memoryStore } = lib('store-memory');
app.clock.now = () => NOW;
const { pgStore } = lib('store-pg');

/* ---------- fake clock, fetch, stores ---------- */
let NOW = Date.UTC(2026, 9, 1, 12);
const realNow = Date.now;
const advance = ms => { NOW += ms; };
const HOUR = 3600000, DAY = 86400000;

let fetchLog = [], fetchImpl = null;
globalThis.fetch = async (url, opt = {}) => {
  const call = { url: String(url), method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body instanceof URLSearchParams ? Object.fromEntries(opt.body) : (typeof opt.body === 'string' ? JSON.parse(opt.body) : opt.body) };
  fetchLog.push(call);
  if (!fetchImpl) throw new Error('unexpected fetch ' + url);
  const r = await fetchImpl(call);
  return { ok: r.status < 300, status: r.status, json: async () => r.body };
};
const mails = () => fetchLog.filter(c => c.url === 'https://api.resend.com/emails');

let pglite = null;
async function freshStore() {
  if (storeArg === 'memory') return memoryStore();
  if (!pglite) pglite = await import(pathToFileURL(storeArg.slice('pglite:'.length) + '/dist/index.js').href);
  const db = new pglite.PGlite();
  return pgStore({
    q: async (t, p = []) => (await db.query(t, p)).rows,
    tx: list => db.transaction(async tx => { const out = []; for (const [t, p = []] of list) out.push((await tx.query(t, p)).rows); return out; }),
  });
}
async function reset(env = {}) {
  for (const k of Object.keys(process.env)) if (/^(GOOGLE_|STRAVA_|RESEND_|EMAIL_FROM|OWNER_EMAILS|VERCEL_ENV|JUSTWATTS_STORE|DATABASE_URL)/.test(k)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, env);
  app.setStore(await freshStore());
  fetchLog = []; fetchImpl = null;
}

/* ---------- fake requests ---------- */
function call(method, path, { body, raw, headers = {}, jar = null, ip = '198.51.100.1' } = {}) {
  const buf = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const h = { host: 'justwatts.test', 'x-real-ip': ip, ...headers };
  if (jar && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const req = Object.assign(Readable.from(buf.length ? [buf] : []), { method, url: path, headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])) });
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) {
        const out = { status: this.statusCode, headers: this.headers, raw: b ? Buffer.from(b) : Buffer.alloc(0) };
        try { out.body = this.headers['content-type'] === 'application/json' ? JSON.parse(out.raw.toString('utf8')) : null; } catch (e) { reject(e); }
        const sc = this.headers['set-cookie']; out.cookies = Array.isArray(sc) ? sc : sc ? [sc] : [];
        if (jar) for (const c of out.cookies) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v); }
        resolve(out);
      },
    };
    const t0 = realNow(); Promise.resolve(app.handler(req, res)).then(() => { if (process.env.SLOW && realNow() - t0 > 500) console.error('slow', method, path, realNow() - t0); }).catch(reject);
  });
}
// a browser: cookie jar, same-origin headers on writes
function client(ip = '198.51.100.1') {
  const jar = new Map();
  const w = { origin: ORIGIN, 'x-hw': '1', 'content-type': 'application/json' };
  return {
    jar, ip,
    get: (p, o = {}) => call('GET', p, { jar, ip, ...o }),
    post: (p, body = {}, o = {}) => call('POST', p, { jar, ip, body, ...o, headers: { ...w, ...(o.headers || {}) } }),
    del: (p, body = {}, o = {}) => call('DELETE', p, { jar, ip, body, ...o, headers: { ...w, ...(o.headers || {}) } }),
    put: (p, raw, o = {}) => call('PUT', p, { jar, ip, raw, ...o, headers: { ...w, 'content-type': 'application/gzip', ...(o.headers || {}) } }),
  };
}
let ipN = 10;
async function signup(email, password = 'password123', name = '') {
  const c = client(`203.0.113.${ipN++ % 250}`);
  const r = await c.post('/api/auth/signup', { email, password, name });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

/* ---------- sections ---------- */
const S = {};

S.providers = async () => {
  await reset();
  let r = await call('GET', '/api/auth/providers');
  assert.deepEqual(r.body, { accounts: true, email: true, emailVerification: false, passwordReset: false, google: false, strava: false, stravaCapped: true });
  await reset({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs', STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 'ss', RESEND_API_KEY: 'rk', EMAIL_FROM: 'Just Watts <a@b.c>' });
  r = await call('GET', '/api/auth/providers');
  assert.deepEqual(r.body, { accounts: true, email: true, emailVerification: true, passwordReset: true, google: true, strava: true, stravaCapped: true });
  process.env.STRAVA_CAPPED = '0'; assert.equal((await call('GET', '/api/auth/providers')).body.stravaCapped, false);
  await reset({ STRAVA_CLIENT_ID: '1' });  // client id alone (the token relay's env) is not enough for sign-in
  assert.equal((await call('GET', '/api/auth/providers')).body.strava, false);
  // Google / Strava start without env: a clean redirect back, never a crash
  for (const p of ['google', 'strava']) {
    r = await call('GET', `/api/auth/${p}/start?return=/settings`);
    assert.equal(r.status, 302); assert.equal(r.headers.location, `/settings?provider=${p}&auth=error&reason=not_configured`);
  }
  // reset without Resend
  r = await client().post('/api/auth/reset/request', { email: 'a@b.co' });
  assert.deepEqual([r.status, r.body.error], [503, 'reset_unavailable']);
  // no session secret: everything but providers says not configured
  delete process.env.JUSTWATTS_SESSION_SECRET;
  assert.equal((await call('GET', '/api/auth/providers')).body.accounts, false);
  r = await client().post('/api/auth/signup', { email: 'a@b.co', password: 'password123' });
  assert.deepEqual([r.status, r.body.error], [503, 'not_configured']);
  // no database
  process.env.JUSTWATTS_SESSION_SECRET = BASE_ENV.JUSTWATTS_SESSION_SECRET; app.setStore(null);
  assert.equal((await call('GET', '/api/auth/providers')).body.accounts, false);
  assert.equal((await call('GET', '/api/auth/me')).status, 503);
  assert.equal((await call('GET', '/api/community')).status, 503);
  assert.equal((await call('GET', '/api/nope')).status, 404);
};

S.auth = async () => {
  await reset();
  const a = client();
  let r = await a.post('/api/auth/signup', { email: ' Rider@Example.com ', password: 'password123', name: 'Ann' });
  assert.equal(r.status, 201);
  const sc = r.cookies.find(c => c.startsWith('__Host-jw_session='));
  assert.match(sc, /; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(r.body.user.email, 'rider@example.com'); assert.equal(r.body.user.verified, false); assert.equal(r.body.user.name, 'Ann');
  assert.deepEqual(r.body.identities.map(i => i.provider), ['email']);
  r = await a.get('/api/auth/me'); assert.equal(r.body.user.email, 'rider@example.com'); assert.equal(r.body.admin, false);
  // the stored hash keeps its scrypt parameters
  const st = app.storeOrNull(), ident = await st.getIdentity('email', 'rider@example.com');
  assert.match((await st.getUser(ident.userId)).passHash, /^scrypt\$1024\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  // duplicate signup without email: 409 (documented exception), validation
  r = await client().post('/api/auth/signup', { email: 'rider@example.com', password: 'password123' });
  assert.deepEqual([r.status, r.body.error], [409, 'email_taken']);
  assert.equal((await client().post('/api/auth/signup', { email: 'nope', password: 'password123' })).body.error, 'bad_email');
  assert.equal((await client().post('/api/auth/signup', { email: 'x@y.co', password: 'short' })).body.error, 'bad_password');
  assert.equal((await client().post('/api/auth/signup', { email: 'x@y.co', password: 'password123', name: 'sh1t head' })).body.error, 'bad_name');
  // login: unknown email and wrong password look the same
  const b = client();
  const bad1 = await b.post('/api/auth/login', { email: 'rider@example.com', password: 'wrongpass1' });
  const bad2 = await b.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrongpass1' });
  assert.deepEqual([bad1.status, bad1.body], [401, { error: 'invalid_credentials' }]);
  assert.deepEqual([bad2.status, bad2.body], [bad1.status, bad1.body]);
  r = await b.post('/api/auth/login', { email: 'RIDER@example.com', password: 'password123' });
  assert.equal(r.status, 200); assert.equal(r.body.user.name, 'Ann');
  // tampered or expired cookies are signed out
  const t = client(); const good = a.jar.get('__Host-jw_session'); t.jar.set('__Host-jw_session', good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'));
  assert.equal((await t.get('/api/auth/me')).body.user, null);
  // profile
  r = await a.post('/api/auth/profile', { name: '  Ann   B ' }); assert.equal(r.body.user.name, 'Ann B');
  assert.equal((await a.post('/api/auth/profile', { name: 'visit spam.com' })).body.error, 'bad_name');
  // logout clears only this browser
  r = await b.post('/api/auth/logout');
  assert.ok(r.cookies.some(c => /^__Host-jw_session=; .*Max-Age=0/.test(c)));
  assert.equal((await b.get('/api/auth/me')).body.user, null);
  assert.ok((await a.get('/api/auth/me')).body.user);
  // logout-all: every session, including copied cookies
  await b.post('/api/auth/login', { email: 'rider@example.com', password: 'password123' });
  const copy = client(); copy.jar.set('__Host-jw_session', b.jar.get('__Host-jw_session'));
  r = await a.post('/api/auth/logout-all'); assert.equal(r.status, 200);
  assert.equal((await b.get('/api/auth/me')).body.user, null);
  assert.equal((await copy.get('/api/auth/me')).body.user, null);
  assert.equal((await a.get('/api/auth/me')).body.user, null);
  assert.equal((await a.post('/api/auth/logout-all')).status, 401);
  // change password: needs the current one; other devices drop, this one stays
  await a.post('/api/auth/login', { email: 'rider@example.com', password: 'password123' });
  await b.post('/api/auth/login', { email: 'rider@example.com', password: 'password123' });
  assert.equal((await a.post('/api/auth/password', { current: 'nope', password: 'newpassword1' })).status, 401);
  r = await a.post('/api/auth/password', { current: 'password123', password: 'newpassword1' }); assert.equal(r.status, 200);
  assert.ok((await a.get('/api/auth/me')).body.user);
  assert.equal((await b.get('/api/auth/me')).body.user, null);
  assert.equal((await b.post('/api/auth/login', { email: 'rider@example.com', password: 'password123' })).status, 401);
  assert.equal((await b.post('/api/auth/login', { email: 'rider@example.com', password: 'newpassword1' })).status, 200);
  // sliding expiry: renewed by /me in the second half, expired after 30 days idle
  advance(20 * DAY); r = await a.get('/api/auth/me'); assert.ok(r.cookies.some(c => c.startsWith('__Host-jw_session=') && !/Max-Age=0/.test(c)));
  advance(29 * DAY); assert.ok((await a.get('/api/auth/me')).body.user);
  assert.equal((await b.get('/api/auth/me')).body.user, null);  // b never renewed: 49 days old
  // delete account: confirm + password
  assert.equal((await a.post('/api/auth/delete', { password: 'newpassword1' })).body.error, 'confirm_required');
  assert.equal((await a.post('/api/auth/delete', { confirm: 'DELETE', password: 'x' })).status, 401);
  r = await a.post('/api/auth/delete', { confirm: 'DELETE', password: 'newpassword1' }); assert.equal(r.status, 200);
  assert.equal((await a.get('/api/auth/me')).body.user, null);
  assert.equal((await b.post('/api/auth/login', { email: 'rider@example.com', password: 'newpassword1' })).status, 401);
  assert.equal(await st.getIdentity('email', 'rider@example.com'), null);
  // a new account can take the address again
  assert.equal((await client('203.0.113.200').post('/api/auth/signup', { email: 'rider@example.com', password: 'password123' })).status, 201);
};

S.origin = async () => {
  await reset();
  const body = JSON.stringify({ email: 'o@example.com', password: 'password123' });
  const go = (headers, env) => { if (env) Object.assign(process.env, env); return call('POST', '/api/auth/signup', { raw: body, headers }); };
  const good = { origin: ORIGIN, 'x-hw': '1', 'content-type': 'application/json' };
  assert.deepEqual((await go({ ...good, origin: undefined })).body, { error: 'bad_origin' });
  assert.deepEqual((await go({ ...good, origin: 'https://evil.example' })).body, { error: 'bad_origin' });
  assert.deepEqual((await go({ ...good, origin: 'null' })).body, { error: 'bad_origin' });
  assert.deepEqual((await go({ ...good, 'x-hw': undefined })).body, { error: 'bad_origin' });
  let r = await go({ ...good, 'content-type': 'text/plain' }); assert.deepEqual([r.status, r.body.error], [415, 'bad_content_type']);
  r = await go({ ...good, 'content-type': 'application/x-www-form-urlencoded' }); assert.equal(r.status, 415);
  // a preview deployment accepts its own *.vercel.app host only when VERCEL_ENV=preview
  const pv = { ...good, host: 'openspin-abc123.vercel.app', origin: 'https://openspin-abc123.vercel.app' };
  assert.equal((await go(pv)).status, 403);
  assert.equal((await go(pv, { VERCEL_ENV: 'production' })).status, 403);
  assert.equal((await go({ ...pv, host: 'evil.example', origin: 'https://evil.example' }, { VERCEL_ENV: 'preview' })).status, 403);
  assert.equal((await go({ ...pv, origin: 'https://other.vercel.app' })).status, 403);
  r = await go(pv); assert.equal(r.status, 201);
  // the production origin keeps working on a preview too
  assert.equal((await call('POST', '/api/auth/login', { raw: body, headers: good })).status, 200);
  // bad JSON, oversized body
  assert.equal((await call('POST', '/api/auth/login', { raw: '{nope', headers: good })).body.error, 'bad_json');
  assert.equal((await call('POST', '/api/auth/login', { raw: '[1]', headers: good })).body.error, 'bad_json');
  assert.equal((await call('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'x'.repeat(20000) }), headers: good })).status, 413);
  // GET routes need no origin; unknown methods
  assert.equal((await call('GET', '/api/auth/providers')).status, 200);
  assert.equal((await call('PATCH', '/api/auth/login', { headers: good })).status, 405);
};

S.ratelimits = async () => {
  await reset();
  await signup('rl@example.com');
  const c = client('192.0.2.50');
  for (let i = 0; i < 10; i++) assert.equal((await c.post('/api/auth/login', { email: 'rl@example.com', password: 'wrongpass' + i })).status, 401);
  let r = await c.post('/api/auth/login', { email: 'rl@example.com', password: 'password123' });
  assert.equal(r.status, 429); assert.equal(r.body.error, 'rate_limited'); assert.ok(+r.headers['retry-after'] > 0 && +r.headers['retry-after'] <= 900);
  // per email: a different IP is still limited for this address, another address is not
  assert.equal((await client('192.0.2.51').post('/api/auth/login', { email: 'rl@example.com', password: 'password123' })).status, 429);
  assert.equal((await client('192.0.2.51').post('/api/auth/login', { email: 'other@example.com', password: 'password123' })).status, 401);
  advance(16 * 60000);
  assert.equal((await c.post('/api/auth/login', { email: 'rl@example.com', password: 'password123' })).status, 200);
  // per IP: many addresses from one IP
  const d = client('192.0.2.60');
  for (let i = 0; i < 30; i++) await d.post('/api/auth/login', { email: `u${i}@example.com`, password: 'password123' });
  assert.equal((await d.post('/api/auth/login', { email: 'rl@example.com', password: 'password123' })).status, 429);
  // signups per IP per hour
  const e = client('192.0.2.70');
  for (let i = 0; i < 10; i++) assert.equal((await e.post('/api/auth/signup', { email: `s${i}@example.com`, password: 'password123' })).status, 201);
  assert.equal((await e.post('/api/auth/signup', { email: 's99@example.com', password: 'password123' })).status, 429);
  // per user: password changes
  const u = await signup('pw@example.com');
  for (let i = 0; i < 10; i++) await u.post('/api/auth/password', { current: 'bad', password: 'password123' });
  assert.equal((await u.post('/api/auth/password', { current: 'password123', password: 'password456' })).status, 429);
};

S.email = async () => {
  await reset({ RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Just Watts <hi@justwatts.test>' });
  fetchImpl = () => ({ status: 200, body: { id: 'm1' } });
  const linkOf = (m, kind) => new RegExp(`^${ORIGIN.replace(/\./g, '\\.')}/\\?${kind}=([\\w-]{43})$`, 'm').exec(m.body.text)[1];
  const a = client();
  let r = await a.post('/api/auth/signup', { email: 'mail@example.com', password: 'password123' });
  assert.deepEqual([r.status, r.body], [202, { status: 'verify_sent' }]);
  assert.equal(r.cookies.length, 0);
  assert.equal(mails().length, 1);
  const m = mails()[0];
  assert.equal(m.headers.Authorization, 'Bearer re_test_key'); assert.deepEqual(m.body.to, ['mail@example.com']);
  const vtok = linkOf(m, 'verify');
  // unverified: the right password gets 403 unverified (and a fresh link); a wrong one stays 401
  assert.equal((await a.post('/api/auth/login', { email: 'mail@example.com', password: 'nope-nope' })).status, 401);
  r = await a.post('/api/auth/login', { email: 'mail@example.com', password: 'password123' });
  assert.deepEqual([r.status, r.body.error], [403, 'unverified']);
  const vtok2 = linkOf(mails()[1], 'verify');
  assert.equal((await a.post('/api/auth/verify', { token: vtok })).body.error, 'bad_token');  // superseded
  r = await a.post('/api/auth/verify', { token: vtok2 });
  assert.equal(r.status, 200); assert.equal(r.body.user.verified, true);
  assert.equal((await a.post('/api/auth/verify', { token: vtok2 })).body.error, 'bad_token');  // single use
  assert.ok((await a.get('/api/auth/me')).body.user);
  // signing up again with a known address: same answer, and the owner gets a reset link instead
  const before = mails().length;
  r = await client('203.0.113.77').post('/api/auth/signup', { email: 'mail@example.com', password: 'attacker123' });
  assert.deepEqual([r.status, r.body, r.cookies.length], [202, { status: 'verify_sent' }, 0]);
  assert.equal(mails().length, before + 1); assert.match(mails().at(-1).body.text, /\?reset=/);
  // reset: same answer for known and unknown addresses
  const r1 = await client('203.0.113.78').post('/api/auth/reset/request', { email: 'mail@example.com' });
  const r2 = await client('203.0.113.78').post('/api/auth/reset/request', { email: 'ghost@example.com' });
  assert.deepEqual([r1.status, r1.body], [202, { status: 'reset_sent' }]); assert.deepEqual([r2.status, r2.body], [r1.status, r1.body]);
  const rtok = linkOf(mails().at(-1), 'reset');
  assert.equal(mails().at(-1).body.to[0], 'mail@example.com');
  assert.equal((await client().post('/api/auth/reset/confirm', { token: rtok, password: 'short' })).body.error, 'bad_password');
  const c = client();
  r = await c.post('/api/auth/reset/confirm', { token: rtok, password: 'brandnew123' }); assert.equal(r.status, 200);
  assert.equal((await a.get('/api/auth/me')).body.user, null);  // old sessions end
  assert.ok((await c.get('/api/auth/me')).body.user);
  assert.equal((await c.post('/api/auth/reset/confirm', { token: rtok, password: 'brandnew456' })).body.error, 'bad_token');
  assert.equal((await client().post('/api/auth/login', { email: 'mail@example.com', password: 'brandnew123' })).status, 200);
  // expired reset token
  await client('203.0.113.79').post('/api/auth/reset/request', { email: 'mail@example.com' });
  const old = linkOf(mails().at(-1), 'reset'); advance(HOUR + 1000);
  assert.equal((await client().post('/api/auth/reset/confirm', { token: old, password: 'brandnew789' })).body.error, 'bad_token');
  // a failed email send never breaks signup
  fetchImpl = () => ({ status: 500, body: {} });
  assert.equal((await client('203.0.113.80').post('/api/auth/signup', { email: 'down@example.com', password: 'password123' })).status, 202);
  assert.ok(!JSON.stringify(fetchLog.map(f => f.body)).includes('re_test_key'));
};

// fake Google: token endpoint returns an ID token with the claims we want
function googleStub(claims, seen = []) {
  return call => {
    if (call.url !== 'https://oauth2.googleapis.com/token') return { status: 404, body: {} };
    seen.push(call.body);
    const payload = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'gid', exp: Math.floor(NOW / 1000) + 3600, ...claims(call) })).toString('base64url');
    return { status: 200, body: { access_token: 'at', id_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.sig` } };
  };
}
async function oauth(c, provider, { mode = 'login', state, ret } = {}) {
  const r = await c.get(`/api/auth/${provider}/start?mode=${mode}${ret ? '&return=' + encodeURIComponent(ret) : ''}`);
  assert.equal(r.status, 302, JSON.stringify(r.body));
  const loc = new URL(r.headers.location), q = loc.searchParams;
  const cb = await c.get(`/api/auth/${provider}/callback?code=authcode123&state=${state ?? q.get('state')}`);
  assert.equal(cb.status, 302);
  return { start: loc, back: cb.headers.location, cb };
}

S.google = async () => {
  await reset({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' });
  let sub = '111', email = 'g@example.com', verified = true, nonceOverride = null;
  const seen = [];
  let lastNonce = null;
  fetchImpl = googleStub(() => ({ sub, email, email_verified: verified, nonce: nonceOverride ?? lastNonce }), seen);
  const a = client();
  // start: PKCE, nonce, state cookie
  let r = await a.get('/api/auth/google/start?return=/workouts');
  const loc = new URL(r.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), ORIGIN + '/api/auth/google/callback');
  assert.equal(loc.searchParams.get('scope'), 'openid email'); assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(r.cookies.some(c => /^__Host-jw_oauth=.+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/.test(c)));
  lastNonce = loc.searchParams.get('nonce');
  // wrong state
  r = await a.get('/api/auth/google/callback?code=authcode123&state=wrong-state-value-xx');
  assert.equal(r.headers.location, '/workouts?provider=google&auth=error&reason=bad_state');
  // the state cookie is single use: the right state now fails too, so start again
  assert.equal((await a.get(`/api/auth/google/callback?code=authcode123&state=${loc.searchParams.get('state')}`)).headers.location, '/?provider=google&auth=error&reason=bad_state');
  r = await a.get('/api/auth/google/start?return=/workouts');
  const st = new URL(r.headers.location).searchParams; lastNonce = st.get('nonce');
  r = await a.get(`/api/auth/google/callback?code=authcode123&state=${st.get('state')}`);
  assert.equal(r.headers.location, '/workouts?provider=google&auth=ok');
  // PKCE verifier matches the challenge
  const v = seen.at(-1).code_verifier;
  assert.equal(crypto.createHash('sha256').update(v).digest('base64url'), st.get('code_challenge'));
  assert.equal(seen.at(-1).client_secret, 'gsecret'); assert.equal(seen.at(-1).redirect_uri, ORIGIN + '/api/auth/google/callback');
  let me = (await a.get('/api/auth/me')).body;
  assert.equal(me.user.email, 'g@example.com'); assert.equal(me.user.hasPassword, false); assert.deepEqual(me.identities.map(i => i.provider), ['google']);
  const uid = me.user.id;
  // again: same account
  const a2 = client();
  fetchImpl = googleStub(c => ({ sub, email, email_verified: true, nonce: lastNonce }));
  const flow = async (c, mode = 'login') => {
    const s = await c.get(`/api/auth/google/start?mode=${mode}`);
    if (s.headers.location.startsWith('/')) return s.headers.location;  // refused before leaving the site
    const q = new URL(s.headers.location).searchParams; lastNonce = q.get('nonce');
    return (await c.get(`/api/auth/google/callback?code=authcode123&state=${q.get('state')}`)).headers.location;
  };
  assert.equal(await flow(a2), '/?provider=google&auth=ok');
  assert.equal((await a2.get('/api/auth/me')).body.user.id, uid);
  // bad audience / nonce / token failure
  fetchImpl = googleStub(() => ({ sub, email, aud: 'someone-else', nonce: lastNonce }));
  assert.equal(await flow(client()), '/?provider=google&auth=error&reason=provider_failed');
  fetchImpl = googleStub(() => ({ sub, email, nonce: 'wrong' }));
  assert.equal(await flow(client()), '/?provider=google&auth=error&reason=provider_failed');
  fetchImpl = () => ({ status: 400, body: { error: 'invalid_grant' } });
  assert.equal(await flow(client()), '/?provider=google&auth=error&reason=provider_failed');
  const den = client(); const s0 = await den.get('/api/auth/google/start'); const q0 = new URL(s0.headers.location).searchParams;
  assert.equal((await den.get(`/api/auth/google/callback?error=access_denied&state=${q0.get('state')}`)).headers.location, '/?provider=google&auth=error&reason=denied');
  // expired state
  const late = client(); const s1 = await late.get('/api/auth/google/start'); const q1 = new URL(s1.headers.location).searchParams;
  advance(11 * 60000);
  assert.equal((await late.get(`/api/auth/google/callback?code=authcode123&state=${q1.get('state')}`)).headers.location, '/?provider=google&auth=error&reason=bad_state');
  // on a preview the redirect URI is still the registered PUBLIC_ORIGIN one
  process.env.VERCEL_ENV = 'preview';
  const pv = await call('GET', '/api/auth/google/start', { headers: { host: 'openspin-x.vercel.app' } });
  assert.equal(new URL(pv.headers.location).searchParams.get('redirect_uri'), 'https://justwatts.test/api/auth/google/callback');
  delete process.env.VERCEL_ENV;
  // open redirect attempts fall back to /
  const o = await client().get('/api/auth/google/start?return=//evil.example/x');
  assert.equal(JSON.parse(Buffer.from(o.cookies[0].split('=')[1].split(';')[0].split('.')[0], 'base64url')).r, '/');
  // unverified email account with the same address: refuse, no takeover
  await signup('victim@example.com');
  fetchImpl = googleStub(() => ({ sub: '222', email: 'victim@example.com', email_verified: true, nonce: lastNonce }));
  assert.equal(await flow(client()), '/?provider=google&auth=error&reason=email_in_use');
  // link Google to a signed-in email account; unlink; never the last method
  const e = await signup('linker@example.com');
  fetchImpl = googleStub(() => ({ sub: '333', email: 'linker@gmail.example', email_verified: true, nonce: lastNonce }));
  assert.equal(await flow(e, 'link'), '/?provider=google&auth=linked');
  me = (await e.get('/api/auth/me')).body; assert.deepEqual(me.identities.map(i => i.provider).sort(), ['email', 'google']);
  assert.equal(await flow(e, 'link'), '/?provider=google&auth=linked');  // same identity again: fine
  fetchImpl = googleStub(() => ({ sub: '111', email, email_verified: true, nonce: lastNonce }));
  assert.equal(await flow(e, 'link'), '/?provider=google&auth=error&reason=identity_in_use');
  assert.equal(await flow(client(), 'link'), '/?provider=google&auth=error&reason=signed_out');
  r = await e.post('/api/auth/unlink', { provider: 'google' }); assert.deepEqual(r.body.identities.map(i => i.provider), ['email']);
  r = await e.post('/api/auth/unlink', { provider: 'email' }); assert.deepEqual([r.status, r.body.error], [409, 'last_method']);
  assert.equal((await e.post('/api/auth/unlink', { provider: 'strava' })).body.error, 'not_linked');
  // a Google-only account adds email + password, then may drop Google
  r = await a.post('/api/auth/password', { current: '', password: 'password123' }); assert.equal(r.body.error, 'no_password');
  r = await a.post('/api/auth/link/email', { email: 'linker@example.com', password: 'password123' }); assert.equal(r.body.error, 'email_taken');
  r = await a.post('/api/auth/link/email', { email: 'g2@example.com', password: 'password123' });
  assert.equal(r.status, 200); assert.equal(r.body.user.hasPassword, true);
  r = await a.post('/api/auth/unlink', { provider: 'google' }); assert.equal(r.status, 200);
  assert.equal((await client().post('/api/auth/login', { email: 'g2@example.com', password: 'password123' })).status, 200);
  // verified email account + Google with that address: linked automatically (both verified)
  await reset({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' });
  fetchImpl = c => c.url.includes('resend') ? { status: 200, body: {} } : googleStub(() => ({ sub: '444', email: 'both@example.com', email_verified: true, nonce: lastNonce }))(c);
  const v1 = client(); await v1.post('/api/auth/signup', { email: 'both@example.com', password: 'password123' });
  await v1.post('/api/auth/verify', { token: /verify=([\w-]+)/.exec(mails().at(-1).body.text)[1] });
  const vid = (await v1.get('/api/auth/me')).body.user.id;
  const g = client(); assert.equal(await flow(g), '/?provider=google&auth=ok');
  me = (await g.get('/api/auth/me')).body; assert.equal(me.user.id, vid); assert.deepEqual(me.identities.map(i => i.provider), ['email', 'google']);
  // OAuth-only delete needs a fresh sign-in
  const go = client(); fetchImpl = googleStub(() => ({ sub: '555', email: 'only@example.com', email_verified: true, nonce: lastNonce }));
  assert.equal(await flow(go), '/?provider=google&auth=ok');
  advance(20 * 60000);
  assert.equal((await go.post('/api/auth/delete', { confirm: 'DELETE' })).body.error, 'reauth_required');
  assert.equal(await flow(go), '/?provider=google&auth=ok');
  assert.equal((await go.post('/api/auth/delete', { confirm: 'DELETE' })).status, 200);
};

S.strava = async () => {
  await reset({ STRAVA_CLIENT_ID: '4242', STRAVA_CLIENT_SECRET: 'stsecret' });
  const seen = [];
  fetchImpl = c => { seen.push(c); return c.url === 'https://www.strava.com/oauth/token' ? { status: 200, body: { access_token: 'x', athlete: { id: 9001, firstname: 'Eddy', lastname: 'M' } } } : { status: 404, body: {} }; };
  const a = client();
  const f = await oauth(a, 'strava');
  assert.equal(f.start.origin + f.start.pathname, 'https://www.strava.com/oauth/authorize');
  assert.equal(f.start.searchParams.get('client_id'), '4242'); assert.equal(f.start.searchParams.get('scope'), 'read');
  assert.equal(f.start.searchParams.get('redirect_uri'), ORIGIN + '/api/auth/strava/callback');
  assert.equal(f.back, '/?provider=strava&auth=ok');
  assert.deepEqual(seen[0].body, { client_id: '4242', client_secret: 'stsecret', code: 'authcode123', grant_type: 'authorization_code' });
  const me = (await a.get('/api/auth/me')).body;
  assert.equal(me.user.name, 'Eddy'); assert.equal(me.user.email, null); assert.deepEqual(me.identities.map(i => i.provider), ['strava']);
  const b = client(); await oauth(b, 'strava');
  assert.equal((await b.get('/api/auth/me')).body.user.id, me.user.id);
  // bad athlete payload
  fetchImpl = () => ({ status: 200, body: { athlete: { id: 'x;drop' } } });
  assert.equal((await oauth(client(), 'strava')).back, '/?provider=strava&auth=error&reason=provider_failed');
  fetchImpl = () => ({ status: 403, body: { message: 'Limit of connected athletes exceeded', errors: [{ resource: 'Application', code: 'limit exceeded' }] } });
  assert.equal((await oauth(client(), 'strava')).back, '/?provider=strava&auth=error&reason=strava_capped');
  fetchImpl = () => { throw new Error('network'); };
  assert.equal((await oauth(client(), 'strava')).back, '/?provider=strava&auth=error&reason=provider_failed');
  // link Strava to an email account; the provider shows up once
  fetchImpl = () => ({ status: 200, body: { athlete: { id: 77, firstname: 'K' } } });
  const e = await signup('st@example.com');
  assert.equal((await oauth(e, 'strava', { mode: 'link' })).back, '/?provider=strava&auth=linked');
  assert.deepEqual((await e.get('/api/auth/me')).body.identities.map(i => i.provider), ['email', 'strava']);
  // secret removed later: start and callback say not configured
  delete process.env.STRAVA_CLIENT_SECRET;
  const r = await client().get('/api/auth/strava/start');
  assert.equal(r.headers.location, '/?provider=strava&auth=error&reason=not_configured');
};

const gz = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
S.sync = async () => {
  await reset();
  const a = await signup('sync@example.com'), b = await signup('other@example.com');
  assert.equal((await client().get('/api/sync/changes?since=0')).status, 401);
  let r = await a.post('/api/sync/push', { records: [
    { kind: 'workout', id: 'c-1', data: { name: 'Over-unders', text: '3x(4m 95%, 2m 105%)' }, updatedAt: NOW - 1000 },
    { kind: 'settings', id: 'main', data: { ftp: 250 }, updatedAt: NOW - 1000 },
  ] });
  assert.equal(r.status, 200); assert.equal(r.body.rev, 1); assert.deepEqual(r.body.results.map(x => x.applied), [true, true]);
  r = await a.get('/api/sync/changes?since=0');
  assert.equal(r.body.rev, 1); assert.equal(r.body.more, false); assert.equal(r.body.records.length, 2);
  assert.deepEqual(r.body.records.find(x => x.id === 'c-1'), { kind: 'workout', id: 'c-1', data: { name: 'Over-unders', text: '3x(4m 95%, 2m 105%)' }, updatedAt: NOW - 1000, deleted: false, rev: 1 });
  assert.deepEqual((await a.get('/api/sync/changes?since=1')).body, { rev: 1, more: false, records: [], rides: [] });
  assert.equal((await b.get('/api/sync/changes?since=0')).body.records.length, 0);  // scoped to the user
  // last write wins: older loses, newer wins, equal time ties go to delete
  r = await a.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-1', data: { old: true }, updatedAt: NOW - 5000 }] });
  assert.equal(r.body.results[0].applied, false);
  r = await a.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-1', data: { v: 2 }, updatedAt: NOW - 1000 }] });
  assert.equal(r.body.results[0].applied, false);
  r = await a.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-1', deleted: true, updatedAt: NOW - 1000 }] });
  assert.equal(r.body.results[0].applied, true);
  r = await a.get('/api/sync/changes?since=1');
  assert.deepEqual(r.body.records, [{ kind: 'workout', id: 'c-1', data: null, updatedAt: NOW - 1000, deleted: true, rev: r.body.rev }]);
  r = await a.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-1', data: { back: 1 }, updatedAt: NOW }] });
  assert.equal(r.body.results[0].applied, true);
  // clock skew: future times are clamped to now + 60 s
  r = await a.post('/api/sync/push', { records: [{ kind: 'settings', id: 'main', data: { ftp: 260 }, updatedAt: NOW + 10 * HOUR }] });
  assert.equal((await a.get(`/api/sync/changes?since=${r.body.rev - 1}`)).body.records[0].updatedAt, NOW + 60000);
  // the same record twice in one push: the newer one
  r = await a.post('/api/sync/push', { records: [{ kind: 'workout', id: 'dup', data: { n: 1 }, updatedAt: NOW - 9 }, { kind: 'workout', id: 'dup', data: { n: 2 }, updatedAt: NOW - 8 }] });
  assert.deepEqual((await a.get(`/api/sync/changes?since=${r.body.rev - 1}`)).body.records.map(x => x.data), [{ n: 2 }]);
  // validation, sizes, quotas
  const bad = async (records, code, status = 400) => { const x = await a.post('/api/sync/push', { records }); assert.deepEqual([x.status, x.body.error], [status, code]); };
  await bad([{ kind: 'ride', id: 'x', data: {}, updatedAt: NOW }], 'bad_record');
  await bad([{ kind: 'workout', id: '../x', data: {}, updatedAt: NOW }], 'bad_record');
  await bad([{ kind: 'workout', id: 'x', data: 'str', updatedAt: NOW }], 'bad_record');
  await bad([{ kind: 'workout', id: 'x', data: {}, updatedAt: 'soon' }], 'bad_updated_at');
  await bad([], 'bad_records');
  await bad(Array.from({ length: 201 }, (_, i) => ({ kind: 'workout', id: 'w' + i, data: {}, updatedAt: NOW })), 'bad_records');
  await bad([{ kind: 'workout', id: 'big', data: { t: 'x'.repeat(40000) }, updatedAt: NOW }], 'record_too_large', 413);
  await bad(Array.from({ length: 10 }, (_, i) => ({ kind: 'settings', id: 's' + i, data: {}, updatedAt: NOW })), 'quota', 413);
  // paging never splits one push (one rev) across pages
  const c = await signup('pager@example.com');
  for (let p = 0; p < 3; p++) await c.post('/api/sync/push', { records: Array.from({ length: 200 }, (_, i) => ({ kind: 'workout', id: `p${p}-${i}`, data: { i }, updatedAt: NOW })) });
  let since = 0, seen = 0, pages = 0;
  for (;;) {
    const x = (await c.get(`/api/sync/changes?since=${since}&limit=250`)).body; pages++;
    assert.ok(new Set(x.records.map(r => r.rev)).size <= 1); seen += x.records.length; since = x.rev;
    if (!x.more) break;
  }
  assert.equal(seen, 600); assert.equal(since, 3);
  // rides: gzip upload, download, headers in changes, LWW, tombstones
  const ride = { id: 'r-2026-10-01', name: 'Lunch ride', start: NOW - HOUR, samples: Array.from({ length: 3600 }, (_, i) => [NOW - HOUR + i * 1000, 200, 90, 140]) };
  const body = gz(ride);
  r = await a.put(`/api/sync/rides/r-2026-10-01?updatedAt=${NOW}`, body);
  assert.equal(r.status, 200); assert.equal(r.body.applied, true);
  const got = await a.get('/api/sync/rides/r-2026-10-01');
  assert.equal(got.headers['content-type'], 'application/gzip'); assert.ok(got.raw.equals(body));
  assert.deepEqual(JSON.parse(zlib.gunzipSync(got.raw)), ride);
  assert.equal((await b.get('/api/sync/rides/r-2026-10-01')).status, 404);
  r = await a.get(`/api/sync/changes?since=${r.body.rev - 1}`);
  assert.deepEqual(r.body.rides, [{ id: 'r-2026-10-01', name: 'Lunch ride', start: NOW - HOUR, samples: 3600, size: body.length, updatedAt: NOW, deleted: false, rev: r.body.rev }]);
  assert.equal((await a.put(`/api/sync/rides/r-2026-10-01?updatedAt=${NOW - 5}`, gz({ ...ride, name: 'old' }))).body.applied, false);
  assert.equal((await a.put('/api/sync/rides/r-x?updatedAt=1', JSON.stringify(ride), { headers: { 'content-type': 'application/json' } })).status, 415);
  assert.equal((await a.put(`/api/sync/rides/r-x?updatedAt=${NOW}`, Buffer.from('not gzip at all, really'))).body.error, 'bad_gzip');
  assert.equal((await a.put(`/api/sync/rides/r-x?updatedAt=${NOW}`, zlib.gzipSync('[1,2]'))).body.error, 'bad_ride');
  assert.equal((await a.put(`/api/sync/rides/r-x?updatedAt=${NOW}`, gz({ id: 'r-y', samples: [] }))).body.error, 'id_mismatch');
  assert.equal((await a.put(`/api/sync/rides/r-x`, gz({ samples: [] }))).body.error, 'bad_updated_at');
  // gzip bomb: 40 MB of zeros in ~40 KB
  const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20), { level: 9 });
  assert.ok(bomb.length < 100000);
  r = await a.put(`/api/sync/rides/r-bomb?updatedAt=${NOW}`, bomb); assert.deepEqual([r.status, r.body.error], [413, 'ride_too_large']);
  r = await a.put(`/api/sync/rides/r-huge?updatedAt=${NOW}`, crypto.randomBytes(2 * 1024 * 1024 + 10)); assert.deepEqual([r.status, r.body.error], [413, 'too_large']);
  // delete: tombstone, then 404
  r = await a.del('/api/sync/rides/r-2026-10-01', { updatedAt: NOW + 1 }); assert.equal(r.body.applied, true);
  assert.equal((await a.get('/api/sync/rides/r-2026-10-01')).status, 404);
  const ch = (await a.get(`/api/sync/changes?since=${r.body.rev - 1}`)).body.rides[0];
  assert.deepEqual([ch.deleted, ch.size], [true, 0]);
  // export
  await a.put(`/api/sync/rides/r-keep?updatedAt=${NOW}`, gz({ name: 'Keep', start: 5, samples: [[1, 2]] }));
  r = await a.get('/api/sync/export');
  assert.match(r.headers['content-disposition'], /attachment/);
  assert.deepEqual(r.body.rides.map(x => [x.id, x.url]), [['r-keep', '/api/sync/rides/r-keep']]);
  assert.deepEqual(r.body.records.map(x => x.kind + '/' + x.id).sort(), ['settings/main', 'workout/c-1', 'workout/dup']);
  assert.equal(r.body.identities[0].email, 'sync@example.com');
  // writes need the origin checks too
  assert.equal((await call('POST', '/api/sync/push', { jar: a.jar, body: { records: [] }, headers: { 'content-type': 'application/json' } })).status, 403);
};

/* ---------- community ---------- */
const appCourse = await import(pathToFileURL(`${repo}/app/js/course.js`).href);
const appCore = await import(pathToFileURL(`${repo}/app/js/core.js`).href);
function courseFrom(seed = 0, km = 5) {
  const pts = []; for (let i = 0; i <= 400; i++) pts.push({ lat: 45 + seed + i * km / 400 / 111, lon: 7 + Math.sin(i / 40) * 0.001, ele: 300 + 50 * Math.sin(i / 60) });
  return appCourse.buildCourse('Test loop', pts);
}

S.community = async () => {
  await reset();
  const anon = client();
  const a = await signup('pub@example.com', 'password123', 'Pia'), b = await signup('liker@example.com'), c = await signup('third@example.com');
  advance(25 * HOUR);  // past the new-account limits
  assert.equal((await anon.post('/api/community', { kind: 'workout', name: 'x', text: '10m 50%' })).status, 401);
  let r = await a.post('/api/community', { kind: 'workout', name: 'Sweet spot 2x20', text: '10m 50-75%, 2x(20m 90%, 5m 55%), 10m 50%', tags: ['Sweet Spot', 'ftp', 'ftp'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const w1 = r.body.item;
  assert.deepEqual([w1.kind, w1.name, w1.author, w1.minutes, w1.tags], ['workout', 'Sweet spot 2x20', 'Pia', 70, ['sweet spot', 'ftp']]);
  assert.ok(w1.tss > 50 && w1.tss < 90, String(w1.tss));
  // parser parity: the API rejects exactly what the app's parser rejects, with the same message
  for (const text of ['10m 50%, 3x(5m 100%', 'ten minutes easy', '0m 50%', '1m30s 200w, 2x(30s 150%, 30s free))']) {
    let appErr = null; try { appCore.parseWorkout(text); } catch (e) { appErr = e.message; }
    r = await a.post('/api/community', { kind: 'workout', name: 'Parser test', text });
    if (appErr) assert.deepEqual([r.status, r.body.error, r.body.message], [400, 'bad_workout', appErr]);
  }
  for (const [text, msg] of [['', /1 to 2000/], ['999x(999x(1m 50%))', /At most 500 steps/], ['30s 50%', /Total/], ['10m 400%', /Targets/], ['10m 2500w', /Targets/], ['x'.repeat(2001), /1 to 2000/]]) {
    r = await a.post('/api/community', { kind: 'workout', name: 'Bad one', text });
    assert.equal(r.body.error, 'bad_workout'); assert.match(r.body.message, msg);
  }
  // names, tags, word filter with leetspeak
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'ab', text: '10m 50%' })).body.error, 'bad_name');
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'Sh!t ride', text: '10m 50%' })).body.error, 'blocked_words');
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'F.U.C.K intervals', text: '10m 50%' })).body.error, 'blocked_words');
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'Best at spam.com', text: '10m 50%' })).body.error, 'blocked_words');
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'Fine name', text: '10m 50%', tags: ['a1', 'b', 'c', 'd', 'e', 'f'] })).body.error, 'bad_tags');
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'Fine name', text: '10m 50%', tags: ['<b>'] })).body.error, 'bad_tags');
  assert.equal((await a.post('/api/community', { kind: 'workout', name: 'Fine name', text: '10m 50%', tags: ['n1gg3r'] })).body.error, 'blocked_words');
  assert.equal((await a.post('/api/community', { kind: 'nope', name: 'Fine name' })).body.error, 'bad_kind');
  // duplicate: same parsed workout from the same account, even with different spacing/case
  r = await a.post('/api/community', { kind: 'workout', name: 'Again', text: '10M 50-75% ,2x( 20m 90% , 5m 55% ),10m 50%' });
  assert.deepEqual([r.status, r.body.error, r.body.id], [409, 'duplicate', w1.id]);
  assert.equal((await b.post('/api/community', { kind: 'workout', name: 'Mine too', text: '10m 50-75%, 2x(20m 90%, 5m 55%), 10m 50%' })).status, 201);
  // courses: the app's compact course passes, bad ones do not
  const course = courseFrom(0, 5);
  r = await a.post('/api/community', { kind: 'course', name: 'Hill loop', course, tags: ['hills'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c1 = r.body.item;
  assert.deepEqual([c1.distM, c1.gainM, c1.profile.length], [course.dist, course.gain, 100]);
  assert.equal((await a.post('/api/community', { kind: 'course', name: 'Same line', course })).body.error, 'duplicate');
  for (const bad of [{ ...course, ele: [1] }, { ...course, dist: 50 }, { ...course, ele: course.ele.slice(0, 10) }, { ...course, ll: [[1, 2], ['x', 3]] }, { ...course, ll: [[95, 2], [1, 2]] }, 'gpx', { ...course, ele: course.ele.map(() => 'NaN') }]) {
    assert.equal((await a.post('/api/community', { kind: 'course', name: 'Broken course', course: bad })).body.error, 'bad_course');
  }
  assert.equal((await a.post('/api/community', { kind: 'course', name: 'Huge', course: { ...course, junk: 'x'.repeat(1100000) } })).status, 413);
  // browse: public, cacheable, no per-viewer fields
  r = await anon.get('/api/community');
  assert.equal(r.status, 200); assert.match(r.headers['cache-control'], /public.*s-maxage=30/); assert.equal(r.cookies.length, 0);
  assert.equal(r.body.items.length, 3);
  assert.deepEqual((await anon.get('/api/community?kind=course')).body.items.map(i => i.id), [c1.id]);
  assert.deepEqual((await anon.get('/api/community?q=SWEET')).body.items.map(i => i.id), [w1.id]);
  assert.deepEqual((await anon.get('/api/community?tag=hills')).body.items.map(i => i.id), [c1.id]);
  assert.deepEqual((await anon.get('/api/community?q=mine')).body.items.length, 1);
  assert.equal((await anon.get('/api/community?dur=60-90')).body.items.length, 2);
  assert.equal((await anon.get('/api/community?dur=0-60')).body.items.length, 0);
  assert.equal((await anon.get('/api/community?dur=60-')).body.items.length, 2);
  advance(60000);
  const w3 = (await c.post('/api/community', { kind: 'workout', name: 'Short spin', text: '20m 60%', tags: ['easy'] })).body.item;
  // likes: one per user
  for (const u of [a, b, c]) assert.equal((await u.post(`/api/community/${c1.id}/like`)).status, 200);
  r = await b.post(`/api/community/${c1.id}/like`); assert.deepEqual(r.body, { likes: 3, liked: true });
  await b.post(`/api/community/${w1.id}/like`);
  r = await b.del(`/api/community/${w1.id}/like`); assert.deepEqual(r.body, { likes: 0, liked: false });
  await c.post(`/api/community/${w1.id}/like`);
  // rides: one per rider per day
  r = await b.post(`/api/community/${w3.id}/ride`); assert.deepEqual(r.body, { counted: true, rides: 1 });
  r = await b.post(`/api/community/${w3.id}/ride`); assert.deepEqual(r.body, { counted: false, rides: 1 });
  await c.post(`/api/community/${w3.id}/ride`);
  advance(DAY);
  r = await b.post(`/api/community/${w3.id}/ride`); assert.deepEqual(r.body, { counted: true, rides: 3 });
  // sorts: liked, popular, new; periods
  const ids = async q => (await anon.get('/api/community?' + q)).body.items.map(i => i.id);
  assert.deepEqual((await ids('sort=liked')).slice(0, 2), [c1.id, w1.id]);
  assert.equal((await ids('sort=popular'))[0], w3.id);
  assert.equal((await ids('sort=new'))[0], w3.id);
  advance(8 * DAY);
  await a.post(`/api/community/${w3.id}/like`);
  assert.equal((await ids('sort=liked&period=week'))[0], w3.id);   // the only like this week
  assert.equal((await ids('sort=liked&period=all'))[0], c1.id);
  assert.deepEqual(await ids('sort=new&period=week'), []);
  assert.equal((await ids('sort=new&period=month')).length, 4);
  r = await anon.get('/api/community?sort=liked&period=week&limit=1');
  assert.deepEqual([r.body.items.length, r.body.more, r.body.items[0].score], [1, true, 1]);
  assert.equal((await anon.get('/api/community?sort=liked&period=week&limit=1&page=1')).body.items.length, 1);
  // detail with comments, liked flag
  assert.equal((await b.post(`/api/community/${c1.id}/comments`, { body: 'Great climb, see www.spam.example' })).body.error, 'no_links');
  assert.equal((await b.post(`/api/community/${c1.id}/comments`, { body: 'great c1imb http//x dot com' })).body.error, 'no_links');
  assert.equal((await b.post(`/api/community/${c1.id}/comments`, { body: 'what a pu55y climb' })).body.error, 'blocked_words');
  assert.equal((await b.post(`/api/community/${c1.id}/comments`, { body: '   ' })).body.error, 'bad_comment');
  assert.equal((await b.post(`/api/community/${c1.id}/comments`, { body: 'x'.repeat(501) })).body.error, 'bad_comment');
  r = await b.post(`/api/community/${c1.id}/comments`, { body: 'Great climb!\n\n\n\nLoved it' });
  assert.equal(r.status, 201); assert.equal(r.body.comment.body, 'Great climb!\n\nLoved it');
  const cm1 = r.body.comment;
  assert.equal((await b.post(`/api/community/${c1.id}/comments`, { body: 'great   CLIMB!\n\nloved it' })).body.error, 'duplicate');
  advance(1000);
  const cm2 = (await c.post(`/api/community/${c1.id}/comments`, { body: 'Too steep for me' })).body.comment;
  r = await b.get(`/api/community/${c1.id}`);
  assert.equal(r.body.liked, true); assert.equal(r.body.mine, false); assert.equal(r.body.item.course.ele.length, course.ele.length);
  assert.deepEqual(r.body.comments.map(x => [x.body, x.mine]), [['Great climb!\n\nLoved it', true], ['Too steep for me', false]]);
  assert.equal((await anon.get(`/api/community/${c1.id}`)).body.liked, false);
  assert.equal((await anon.get(`/api/community/${c1.id}`)).body.item.comments, 2);
  assert.equal((await anon.get('/api/community/nope!')).status, 404);
  // comment deletes: author yes, item owner yes, stranger no
  assert.equal((await c.del(`/api/community/comments/${cm1.id}`)).status, 403);
  assert.equal((await b.del(`/api/community/comments/${cm1.id}`)).status, 200);
  assert.equal((await a.del(`/api/community/comments/${cm2.id}`)).status, 200);
  assert.equal((await anon.get(`/api/community/${c1.id}`)).body.item.comments, 0);
  // item delete: owner only
  assert.equal((await b.del(`/api/community/${w3.id}`)).status, 403);
  assert.equal((await c.del(`/api/community/${w3.id}`)).status, 200);
  assert.equal((await anon.get(`/api/community/${w3.id}`)).status, 404);
  // account delete takes the user's likes and comments off other items
  const d = await signup('leaver@example.com');
  await d.post(`/api/community/${c1.id}/like`); await d.post(`/api/community/${c1.id}/comments`, { body: 'Bye all' });
  assert.equal((await anon.get(`/api/community/${c1.id}`)).body.item.likes, 4);
  await d.post('/api/auth/delete', { confirm: 'DELETE', password: 'password123' });
  r = (await anon.get(`/api/community/${c1.id}`)).body; assert.deepEqual([r.item.likes, r.item.comments], [3, 0]);
};

S.limits = async () => {
  await reset();
  const n = await signup('new@example.com');
  const w = i => ({ kind: 'workout', name: `Workout ${i}`, text: `${10 + i}m 50%` });
  assert.equal((await n.post('/api/community', w(1))).status, 201);
  assert.equal((await n.post('/api/community', w(2))).status, 201);
  let r = await n.post('/api/community', w(3)); assert.deepEqual([r.status, r.body.error], [429, 'rate_limited']);  // under 24 h: 2 a day
  advance(DAY);
  for (let i = 4; i < 14; i++) assert.equal((await n.post('/api/community', w(i))).status, 201, String(i));
  assert.equal((await n.post('/api/community', w(14))).status, 429);  // 10 a day
  // comments: 5 a day when new, 30 when not
  const item = (await call('GET', '/api/community?sort=new')).body.items[0].id;
  const m = await signup('newc@example.com');
  for (let i = 0; i < 5; i++) assert.equal((await m.post(`/api/community/${item}/comments`, { body: `Comment number ${i}` })).status, 201);
  assert.equal((await m.post(`/api/community/${item}/comments`, { body: 'One more' })).status, 429);
  // per IP: 20 publishes a day across accounts
  advance(2 * DAY);
  const users = []; for (let i = 0; i < 3; i++) { const u = await signup(`ip${i}@example.com`); users.push(u); }
  advance(2 * DAY);
  let ok = 0, limited = 0;
  for (let i = 0; i < 24; i++) {
    const u = users[i % 3]; const x = await call('POST', '/api/community', { jar: u.jar, ip: '192.0.2.99', body: w(100 + i), headers: { origin: ORIGIN, 'x-hw': '1', 'content-type': 'application/json' } });
    if (x.status === 201) ok++; else if (x.status === 429) limited++;
  }
  assert.deepEqual([ok, limited], [20, 4]);
};

S.moderation = async () => {
  await reset({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c', OWNER_EMAILS: 'Boss@Example.com, other@x.y' });
  fetchImpl = () => ({ status: 200, body: {} });
  const verified = async (email, ip) => {
    const u = client(ip); await u.post('/api/auth/signup', { email, password: 'password123' });
    await u.post('/api/auth/verify', { token: /verify=([\w-]+)/.exec(mails().at(-1).body.text)[1] });
    return u;
  };
  const owner = await verified('boss@example.com', '203.0.113.1'), a = await verified('author@example.com', '203.0.113.2');
  const rs = []; for (let i = 0; i < 4; i++) rs.push(await verified(`rep${i}@example.com`, `203.0.113.${10 + i}`));
  advance(2 * DAY);
  assert.equal((await owner.get('/api/auth/me')).body.admin, true);
  assert.equal((await a.get('/api/auth/me')).body.admin, false);
  assert.equal((await a.get('/api/admin/hidden')).status, 403);
  const it = (await a.post('/api/community', { kind: 'workout', name: 'Reported one', text: '30m 60%' })).body.item;
  // reports: own reports do nothing, repeats count once, 3 distinct accounts hide
  assert.deepEqual((await a.post(`/api/community/${it.id}/report`, { reason: 'mine' })).body, { ok: true, hidden: false });
  assert.deepEqual((await rs[0].post(`/api/community/${it.id}/report`, { reason: 'spam' })).body, { ok: true, hidden: false });
  assert.deepEqual((await rs[0].post(`/api/community/${it.id}/report`, { reason: 'spam' })).body, { ok: true, hidden: false });
  assert.deepEqual((await rs[1].post(`/api/community/${it.id}/report`, { reason: 'rude' })).body, { ok: true, hidden: false });
  assert.deepEqual((await rs[2].post(`/api/community/${it.id}/report`, {})).body, { ok: true, hidden: true });
  assert.equal((await call('GET', '/api/community')).body.items.length, 0);
  assert.equal((await rs[3].get(`/api/community/${it.id}`)).status, 404);
  assert.equal((await rs[3].post(`/api/community/${it.id}/report`)).status, 404);
  const r_ = (await a.get(`/api/community/${it.id}`)).body; assert.equal(r_.item.hidden, true);  // the owner still sees it
  // comment reports
  const it2 = (await a.post('/api/community', { kind: 'workout', name: 'Open one', text: '40m 60%' })).body.item;
  const cm = (await rs[3].post(`/api/community/${it2.id}/comments`, { body: 'Rude but no bad words' })).body.comment;
  for (const u of rs.slice(0, 3)) await u.post(`/api/community/comments/${cm.id}/report`, { reason: 'rude' });
  assert.equal((await call('GET', `/api/community/${it2.id}`)).body.comments.length, 0);
  assert.equal((await call('GET', `/api/community/${it2.id}`)).body.item.comments, 0);
  // admin: list, unhide (clears reports), delete
  let h = (await owner.get('/api/admin/hidden')).body;
  assert.deepEqual(h.items.map(i => [i.id, i.reasons.sort()]), [[it.id, ['', 'rude', 'spam']]]);
  assert.deepEqual(h.comments.map(c => [c.id, c.body]), [[cm.id, 'Rude but no bad words']]);
  assert.equal((await owner.post(`/api/admin/items/${it.id}`, { action: 'nope' })).body.error, 'bad_action');
  assert.equal((await owner.post(`/api/admin/items/${it.id}`, { action: 'unhide' })).status, 200);
  assert.equal((await call('GET', `/api/community/${it.id}`)).status, 200);
  assert.deepEqual((await rs[0].post(`/api/community/${it.id}/report`, { reason: 'again' })).body, { ok: true, hidden: false });  // count restarted
  assert.equal((await owner.post(`/api/admin/comments/${cm.id}`, { action: 'delete' })).status, 200);
  assert.equal((await owner.post(`/api/admin/items/${it2.id}`, { action: 'delete' })).status, 200);
  assert.equal((await call('GET', `/api/community/${it2.id}`)).status, 404);
  h = (await owner.get('/api/admin/hidden')).body; assert.deepEqual([h.items.length, h.comments.length], [0, 0]);
  assert.equal((await a.post(`/api/admin/items/${it.id}`, { action: 'delete' })).status, 403);
  assert.equal((await owner.post('/api/admin/items/zzzzzzzz', { action: 'delete' })).status, 404);
  // an unverified account with an owner address is not an admin
  await reset({ OWNER_EMAILS: 'boss@example.com' });
  const fake = await signup('boss@example.com');
  assert.equal((await fake.get('/api/auth/me')).body.admin, false);
  assert.equal((await fake.get('/api/admin/hidden')).status, 403);
};

/* ---------- run ---------- */
const names = which === 'all' ? Object.keys(S) : which.split(',');
const out = {};
for (const n of names) { if (!S[n]) throw new Error('no section ' + n); await S[n](); out[n] = 'ok'; }
console.log(JSON.stringify(out));
