// Drives the accounts / sync / community / social API (web/api/_lib) in-process with fake requests, a fake clock
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
function call(method, path, { body, raw, headers = {}, jar = null, ip = '198.51.100.1', handler = app.handler } = {}) {
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
    const t0 = realNow(); Promise.resolve(handler(req, res)).then(() => { if (process.env.SLOW && realNow() - t0 > 500) console.error('slow', method, path, realNow() - t0); }).catch(reject);
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
  // the vercel.json rewrite: /api/accounts?__path=<original path>&<original query>
  assert.equal((await call('GET', '/api/accounts?__path=/api/auth/providers')).body.accounts, true);
  assert.equal((await call('GET', '/api/accounts?__path=/api/community&sort=new')).body.sort, 'new');
  assert.equal((await call('GET', '/api/accounts?__path=/api/strava/token')).status, 404);
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
  assert.equal(r.headers.location, '/workouts?provider=google&auth=ok&new=1');
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
  assert.equal(await flow(go), '/?provider=google&auth=ok&new=1');
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
  assert.equal(f.back, '/?provider=strava&auth=ok&new=1');
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
  // group chat: 3 members hide a message; the owner lists, unhides and deletes it
  const g = (await a.post('/api/social/groups', { plan: { kind: 'course', id: 'hawk-hill', name: 'Hawk Hill' }, at: NOW + HOUR })).body.group;
  for (const u of rs.slice(0, 3)) await u.post(`/api/social/groups/${g.id}/join`);
  const msg = (await a.post('/api/social/chat/send', { group: g.id, body: 'Mean words here' })).body.message;
  for (const u of rs.slice(0, 3)) await u.post('/api/social/chat/report', { id: msg.id, reason: 'mean' });
  h = (await owner.get('/api/admin/hidden')).body;
  assert.deepEqual(h.messages.map(m => [m.id, m.body, m.reasons]), [[msg.id, 'Mean words here', ['mean', 'mean', 'mean']]]);
  assert.equal((await owner.post(`/api/admin/messages/${msg.id}`, { action: 'unhide' })).status, 200);
  assert.equal((await rs[0].post('/api/social/chat/read', { group: g.id, since: 0 })).body.messages.length, 1);
  assert.equal((await owner.post(`/api/admin/messages/${msg.id}`, { action: 'delete' })).status, 200);
  assert.equal((await rs[0].post('/api/social/chat/read', { group: g.id, since: 0 })).body.messages.length, 0);
  assert.equal((await a.post(`/api/admin/messages/${msg.id}`, { action: 'delete' })).status, 403);
  // an unverified account with an owner address is not an admin
  await reset({ OWNER_EMAILS: 'boss@example.com' });
  const fake = await signup('boss@example.com');
  assert.equal((await fake.get('/api/auth/me')).body.admin, false);
  assert.equal((await fake.get('/api/admin/hidden')).status, 403);
};

// /api/integrations wired to accounts: the session cookie is the caller, secrets sealed in integration_data
S.integrations = async () => {
  await reset();
  process.env.JUSTWATTS_INTEGRATIONS_KEY = Buffer.alloc(32, 9).toString('base64');
  const H = { handler: require(`${repo}/web/api/integrations.js`) };
  const KEYV = 'icukey-0123456789abcdef';
  const FIT = Buffer.concat([Buffer.from([14, 32, 0, 0, 0, 0, 0, 0]), Buffer.from('.FIT'), Buffer.alloc(40)]);
  const saved = globalThis.fetch, calls = [];
  const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, opt = {}) => {
    calls.push(`${opt.method || 'GET'} ${url}`);
    if (/intervals\.icu\/api\/v1\/athlete\/i42$/.test(url)) return res(200, { id: 'i42', name: 'Test Rider' });
    if (/intervals\.icu\/api\/v1\/athlete\/i42\/activities/.test(url)) return res(201, { id: 'i42', activities: [{ id: 'i900' }] });
    return res(404, {});
  };
  try {
    // signed out: 401, the page offers manual upload and sign in
    let r = await call('GET', '/api/integrations?op=list', H);
    assert.equal(r.status, 401);
    const a = await signup('icu@example.com'), uid = (await a.get('/api/auth/me')).body.user.id;
    r = await a.get('/api/integrations?op=list', H);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.integrations.map(x => x.id), ['garmin', 'strava', 'trainingpeaks', 'intervals', 'coros', 'polar', 'suunto', 'wahoo']);
    // a write without the page's Origin + X-HW is refused, even with the session
    r = await call('POST', '/api/integrations?op=connect&service=intervals', { ...H, jar: a.jar, body: { athlete_id: 'i42', api_key: KEYV } });
    assert.equal(r.status, 403);
    r = await a.post('/api/integrations?op=connect&service=intervals', { athlete_id: 'i42', api_key: KEYV }, H);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.connected, true);
    assert.ok(!r.raw.toString().includes(KEYV), 'never echo the key');
    r = await a.get('/api/integrations?op=list', H);
    const icu = r.body.integrations.find(x => x.id === 'intervals');
    assert.deepEqual([icu.status.connected, icu.status.account], [true, 'Test Rider']);
    assert.ok(!r.raw.toString().includes(KEYV));
    // sealed at rest in the accounts store, bound to this user
    const st = app.storeOrNull(), sealed = (await st.getIntegrationData(uid, 'secret', 'intervals')).toString('utf8');
    assert.match(sealed, /^v1\./); assert.ok(!sealed.includes(KEYV));
    const b = await signup('other@example.com'), uidB = (await b.get('/api/auth/me')).body.user.id;
    assert.equal((await b.get('/api/integrations?op=list', H)).body.integrations.find(x => x.id === 'intervals').status.connected, false);
    await st.putIntegrationData(uidB, 'secret', 'intervals', Buffer.from(sealed), NOW);  // copied to another user: does not open
    r = await b.get('/api/integrations?op=list', H);
    assert.equal(r.body.integrations.find(x => x.id === 'intervals').status.connected, false);
    // a ride's FIT: queued and uploaded, kept for retries and the manual link
    r = await call('POST', `/api/integrations?op=upload&ride=r-1&name=Test&start=${NOW}&duration=3600`, { ...H, jar: a.jar, raw: FIT, headers: { origin: ORIGIN, 'x-hw': '1' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const up = r.body.targets.find(x => x.id === 'intervals').upload;
    assert.deepEqual([up.state, up.activity_id, up.url], ['done', 'i900', 'https://intervals.icu/activities/i900']);
    r = await a.get('/api/integrations?op=fit&ride=r-1', H);
    assert.equal(r.status, 200); assert.ok(r.raw.equals(FIT));
    assert.equal((await b.get('/api/integrations?op=fit&ride=r-1', H)).status, 404);
    // auto upload choice and the Garmin answer persist in the user's state
    r = await a.post('/api/integrations?op=auto&service=intervals', { on: false }, H);
    assert.equal(r.body.integrations.find(x => x.id === 'intervals').auto, false);
    r = await a.post('/api/integrations?op=syncs', { syncs_to: ['strava', 'bogus'] }, H);
    assert.deepEqual(r.body.integrations.find(x => x.id === 'garmin').syncs_to, ['strava']);
    // old FIT files are pruned; the secret and state stay
    await st.pruneIntegrationData(NOW + 31 * DAY);
    assert.equal(await st.getIntegrationData(uid, 'file', 'fit:r-1'), null);
    assert.ok(await st.getIntegrationData(uid, 'secret', 'intervals'));
    // disconnect deletes the secret
    r = await a.post('/api/integrations?op=disconnect&service=intervals', {}, H);
    assert.equal(r.body.integrations.find(x => x.id === 'intervals').status.connected, false);
    assert.equal(await st.getIntegrationData(uid, 'secret', 'intervals'), null);
    // deleting the account deletes everything integrations kept for it
    assert.ok(await st.countIntegrationData(uid) > 0);
    assert.equal((await a.post('/api/auth/delete', { confirm: 'DELETE', password: 'password123' })).status, 200);
    assert.equal(await st.countIntegrationData(uid), 0);
    assert.equal((await a.get('/api/integrations?op=list', H)).status, 401);
    assert.ok(calls.every(c => c.includes('intervals.icu')), 'only the stubbed service was called');
  } finally { globalThis.fetch = saved; delete process.env.JUSTWATTS_INTEGRATIONS_KEY; }
};

// Strava gives no email: the account asks for one once. Free address: a link adds it. Taken: the link merges
// the new account into the owner's. The answer is the same either way, and the link only works in the asking browser.
S.claim = async () => {
  await reset({ STRAVA_CLIENT_ID: '4242', STRAVA_CLIENT_SECRET: 'stsecret' });
  let athlete = 1;
  const stub = c => c.url === 'https://www.strava.com/oauth/token' ? { status: 200, body: { athlete: { id: athlete, firstname: 'Eddy' } } } : { status: 200, body: { id: 'm' } };
  fetchImpl = stub;
  const s0 = client('203.0.113.200'); await oauth(s0, 'strava');
  let r = await s0.post('/api/auth/email/claim', { email: 'x@example.com' });
  assert.deepEqual([r.status, r.body.error], [503, 'email_unavailable']);  // without Resend there is no link to send

  await reset({ STRAVA_CLIENT_ID: '4242', STRAVA_CLIENT_SECRET: 'stsecret', RESEND_API_KEY: 're_k', EMAIL_FROM: 'a@b.c' });
  fetchImpl = stub;
  const linkOf = m => /\?claim=([\w-]{43})$/m.exec(m.body.text)[1];
  assert.equal((await client().post('/api/auth/email/claim', { email: 'x@example.com' })).status, 401);
  // free address
  athlete = 101; const a = client('203.0.113.201');
  assert.equal((await oauth(a, 'strava')).back, '/?provider=strava&auth=ok&new=1');
  const aid = (await a.get('/api/auth/me')).body.user.id;
  assert.equal((await a.post('/api/auth/email/claim', { email: 'nope' })).body.error, 'bad_email');
  const free = await a.post('/api/auth/email/claim', { email: ' Free@Example.com ' });
  assert.deepEqual([free.status, free.body], [202, { status: 'email_sent' }]);
  assert.equal((await a.get('/api/auth/me')).body.user.email, null);  // nothing changes until the link is opened
  let m = mails().at(-1); assert.deepEqual(m.body.to, ['free@example.com']); assert.doesNotMatch(m.body.text, /already has/);
  const tok = linkOf(m);
  assert.equal((await client().post('/api/auth/email/confirm', { token: tok })).status, 401);  // another browser, signed out: kept
  athlete = 150; const other = client('203.0.113.209'); await oauth(other, 'strava');
  assert.equal((await other.post('/api/auth/email/confirm', { token: tok })).body.error, 'bad_token');  // another account: refused (and spent)
  await a.post('/api/auth/email/claim', { email: 'free@example.com' });
  r = await a.post('/api/auth/email/confirm', { token: linkOf(mails().at(-1)) });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, false); assert.equal(r.body.user.id, aid);
  assert.equal(r.body.user.email, 'free@example.com'); assert.equal(r.body.user.verified, true); assert.equal(r.body.user.hasPassword, false);
  assert.deepEqual(r.body.identities.map(i => i.provider), ['strava', 'email']);
  assert.equal((await a.post('/api/auth/email/claim', { email: 'two@example.com' })).body.error, 'already_linked');
  // no password yet: a reset link sets one
  await client('203.0.113.202').post('/api/auth/reset/request', { email: 'free@example.com' });
  const rt = /reset=([\w-]{43})/.exec(mails().at(-1).body.text)[1];
  assert.equal((await client().post('/api/auth/reset/confirm', { token: rt, password: 'password123' })).status, 200);
  assert.equal((await client().post('/api/auth/login', { email: 'free@example.com', password: 'password123' })).status, 200);

  // taken address: the existing account (unconfirmed email) with synced data and a community item
  const e = client('203.0.113.203');
  await e.post('/api/auth/signup', { email: 'owner@example.com', password: 'password123', name: 'Owner' });
  await e.post('/api/auth/verify', { token: /verify=([\w-]{43})/.exec(mails().at(-1).body.text)[1] });
  const eid = (await e.get('/api/auth/me')).body.user.id;
  await e.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-own', data: { name: 'Own' }, updatedAt: NOW - 5000 }, { kind: 'settings', id: 'main', data: { ftp: 250 }, updatedAt: NOW - 5000 }] });
  const item = (await e.post('/api/community', { kind: 'workout', name: 'Merge test', text: '10m 60%, 5m 90%', tags: [] })).body.item;
  await e.post(`/api/community/${item.id}/like`);
  athlete = 102; const b = client('203.0.113.204'); await oauth(b, 'strava');
  const bid = (await b.get('/api/auth/me')).body.user.id;
  await b.post('/api/sync/push', { records: [{ kind: 'workout', id: 'c-new', data: { name: 'New' }, updatedAt: NOW - 1000 }, { kind: 'settings', id: 'main', data: { ftp: 270 }, updatedAt: NOW - 1000 }] });
  assert.equal((await b.put(`/api/sync/rides/r-1?updatedAt=${NOW - 1000}`, gz({ id: 'r-1', name: 'Merged ride', samples: [[NOW, 200]] }))).status, 200);
  await b.post(`/api/community/${item.id}/like`);
  assert.equal((await e.get(`/api/community/${item.id}`)).body.item.likes, 2);
  const before = mails().length;
  const taken = await b.post('/api/auth/email/claim', { email: 'OWNER@example.com' });
  assert.deepEqual([taken.status, taken.body], [free.status, free.body]);  // the same answer as a free address
  assert.equal(mails().length, before + 1); m = mails().at(-1);
  assert.deepEqual(m.body.to, ['owner@example.com']); assert.match(m.body.text, /already has a Just Watts account/);
  r = await b.post('/api/auth/email/confirm', { token: linkOf(m) });
  assert.equal(r.status, 200); assert.equal(r.body.merged, true); assert.equal(r.body.user.id, eid);
  assert.deepEqual(r.body.identities.map(i => i.provider).sort(), ['email', 'strava']);
  assert.equal((await b.get('/api/auth/me')).body.user.id, eid);  // this browser is now in the owner's account
  assert.equal((await e.get('/api/auth/me')).body.user.id, eid);  // the owner's other sessions stay
  const ch = (await e.get('/api/sync/changes?since=0')).body;
  assert.deepEqual(ch.records.map(x => x.id).sort(), ['c-new', 'c-own', 'main']);
  assert.equal(ch.records.find(x => x.id === 'main').data.ftp, 270);  // newer wins
  assert.deepEqual(ch.rides.map(x => [x.id, x.name]), [['r-1', 'Merged ride']]);
  assert.equal((await e.get(`/api/community/${item.id}`)).body.item.likes, 1);  // one like per account after the merge
  athlete = 102; const again = client('203.0.113.205');
  assert.equal((await oauth(again, 'strava')).back, '/?provider=strava&auth=ok');  // Strava now signs in to the owner's account
  assert.equal((await again.get('/api/auth/me')).body.user.id, eid);
  assert.equal((await client('203.0.113.206').post('/api/auth/login', { email: 'owner@example.com', password: 'password123' })).status, 200);
  assert.notEqual(bid, eid);
  // the owner already has a Strava sign-in: nothing merges
  athlete = 103; const c = client('203.0.113.207'); await oauth(c, 'strava');
  await c.post('/api/auth/email/claim', { email: 'owner@example.com' });
  r = await c.post('/api/auth/email/confirm', { token: linkOf(mails().at(-1)) });
  assert.deepEqual([r.status, r.body.error], [409, 'already_linked']);
  assert.ok((await c.get('/api/auth/me')).body.user);
  // expired link, and rate limits per account
  athlete = 104; const d = client('203.0.113.208'); await oauth(d, 'strava');
  await d.post('/api/auth/email/claim', { email: 'late@example.com' });
  const lt = linkOf(mails().at(-1)); advance(DAY + 1000);
  assert.equal((await d.post('/api/auth/email/confirm', { token: lt })).body.error, 'bad_token');
  for (let i = 0; i < 5; i++) assert.equal((await d.post('/api/auth/email/claim', { email: `rl${i}@example.com` })).status, 202);
  r = await d.post('/api/auth/email/claim', { email: 'rl9@example.com' });
  assert.deepEqual([r.status, r.body.error], [429, 'rate_limited']);
};

S.social = async () => {
  await reset({ OWNER_EMAILS: 'boss@example.com' });
  const ann = await signup('ann@example.com', 'password123', 'Ann'), bob = await signup('bob@example.com', 'password123', 'Bob');
  const cat = await signup('cat@example.com', 'password123', 'Cat'), dan = await signup('dan@example.com', 'password123', 'Dan');
  const id = async c => (await c.get('/api/auth/me')).body.user.id;
  const [A, B, C, D] = [await id(ann), await id(bob), await id(cat), await id(dan)];
  // signed out: nothing
  for (const [m, p] of [['GET', '/api/social'], ['POST', '/api/social/presence'], ['POST', '/api/social/search'], ['GET', '/api/social/me']]) {
    const r = m === 'GET' ? await client().get(p) : await client().post(p, { open: true, lat: 1, lon: 1 });
    assert.equal(r.status, 401, p);
  }
  assert.equal((await ann.post('/api/social/presence', { open: true, lat: 1, lon: 1 }, { headers: { origin: 'https://evil.test' } })).status, 403);
  // profile: a share code, visible by default
  let me = (await ann.get('/api/social/me')).body;
  assert.match(me.code, /^[A-Za-z0-9]{10}$/); assert.equal(me.visible, true);
  assert.equal((await ann.get('/api/social/me')).body.code, me.code);  // stable

  // search by display name; request, accept; requests by share code; remove
  let r = await ann.post('/api/social/search', { q: 'bo' });
  assert.deepEqual(r.body.users, [{ id: B, name: 'Bob', state: 'none' }]);
  assert.deepEqual((await ann.post('/api/social/search', { q: 'b' })).body.users, []);  // 2 characters at least
  assert.deepEqual((await ann.post('/api/social/search', { q: 'ann' })).body.users, []);  // never yourself
  r = await ann.post('/api/social/friends/request', { id: B }); assert.deepEqual(r.body, { state: 'out', id: B, name: 'Bob' });
  assert.equal((await ann.post('/api/social/friends/request', { id: A })).body.error, 'self');
  assert.equal((await ann.post('/api/social/friends/request', { id: 'nobody123' })).status, 404);
  let bs = (await bob.get('/api/social')).body;
  assert.deepEqual(bs.incoming, [{ id: A, name: 'Ann' }]); assert.deepEqual(bs.friends, []);
  assert.deepEqual((await ann.get('/api/social')).body.outgoing, [{ id: B, name: 'Bob' }]);
  assert.equal((await cat.post('/api/social/friends/accept', { id: A })).status, 404);  // nothing to accept
  assert.deepEqual((await bob.post('/api/social/friends/accept', { id: A })).body, { state: 'yes' });
  assert.deepEqual((await ann.get('/api/social')).body.friends, [{ id: B, name: 'Bob', riding: null }]);
  const catCode = (await cat.get('/api/social/me')).body.code;
  r = await ann.post('/api/social/friends/request', { code: catCode }); assert.equal(r.body.state, 'out'); assert.equal(r.body.name, 'Cat');
  r = await cat.post('/api/social/friends/request', { id: A }); assert.equal(r.body.state, 'yes');  // asking back accepts
  assert.equal((await ann.post('/api/social/friends/request', { code: 'nope' })).status, 404);
  assert.deepEqual((await ann.post('/api/social/search', { q: 'cat' })).body.users[0].state, 'yes');

  // presence: open world, 5 km; the same course; friends flagged; invisible riders send nothing
  const at = (lat, lon, extra = {}) => ({ open: true, lat, lon, w: 210, v: 31.4, road: 'Conzelman Road', h: 90, ...extra });
  r = await ann.post('/api/social/presence', at(37.8324, -122.4795));
  assert.equal(r.status, 200); assert.deepEqual(r.body.riders, []);
  await bob.post('/api/social/presence', at(37.8330, -122.4790, { w: 250 }));       // about 80 m away
  await cat.post('/api/social/presence', at(37.8324, -122.4195));                   // about 5.3 km east
  await dan.post('/api/social/presence', at(37.8000, -122.4795));                   // 3.6 km south, a stranger
  r = await ann.post('/api/social/presence', at(37.8324, -122.4795));
  assert.deepEqual(r.body.riders.map(x => [x.name, x.friend, x.w]), [['Bob', true, 250], ['Dan', false, 210]]);
  const bobRow = r.body.riders[0];
  assert.deepEqual([bobRow.road, bobRow.v, bobRow.open, bobRow.h], ['Conzelman Road', 31.4, true, 90]);
  // the friends panel shows who is riding, and where
  let as = (await ann.get('/api/social')).body;
  assert.deepEqual(as.friends.map(f => [f.name, f.riding?.road]), [['Bob', 'Conzelman Road'], ['Cat', 'Conzelman Road']]);
  assert.equal(as.friends[0].riding.lat, 37.833);
  // a course: riders on that course only
  const crs = { open: false, course: 'Hawk Hill|5200', cid: 'hawk-hill', d: 1200, w: 180, road: 'Hawk Hill' };
  await bob.post('/api/social/presence', crs);
  await cat.post('/api/social/presence', { ...crs, course: 'Other|100', d: 50 });
  r = await ann.post('/api/social/presence', { ...crs, d: 1000 });
  assert.deepEqual(r.body.riders.map(x => [x.name, x.d, x.course]), [['Bob', 1200, 'Hawk Hill|5200']]);
  assert.equal((await ann.post('/api/social/presence', { open: false })).body.error, 'bad_course');
  assert.equal((await ann.post('/api/social/presence', { open: true, lat: 'x' })).body.error, 'bad_position');
  // stale after 15 s
  advance(16000);
  assert.deepEqual((await ann.post('/api/social/presence', { ...crs, d: 1000 })).body.riders, []);
  assert.deepEqual((await ann.get('/api/social')).body.friends.map(f => f.riding), [null, null]);
  // visible: false drops the row at once and sends nothing more; the rider still sees others
  await bob.post('/api/social/presence', crs);
  assert.equal((await bob.post('/api/social/me', { visible: false })).body.visible, false);
  assert.deepEqual((await ann.post('/api/social/presence', { ...crs, d: 1000 })).body.riders, []);
  r = await bob.post('/api/social/presence', { ...crs, visible: false });
  assert.deepEqual(r.body.riders.map(x => x.name), ['Ann']);
  assert.deepEqual((await ann.post('/api/social/presence', { ...crs, d: 1000 })).body.riders, []);
  await bob.post('/api/social/me', { visible: true });
  await bob.post('/api/social/presence', crs);
  assert.equal((await ann.post('/api/social/presence/stop')).status, 200);
  assert.deepEqual((await bob.post('/api/social/presence', crs)).body.riders, []);  // Ann stopped
  // rate limit per account: 60 a minute
  advance(60000);
  for (let i = 0; i < 59; i++) await dan.post('/api/social/presence', crs);
  r = await dan.post('/api/social/presence', crs); assert.equal(r.status, 200);
  r = await dan.post('/api/social/presence', crs); assert.deepEqual([r.status, r.body.error], [429, 'rate_limited']);

  // block hides both ways: presence, search, friends; a blocked request looks like no account
  advance(60000);
  await dan.post('/api/social/presence', crs); await bob.post('/api/social/presence', crs);
  assert.deepEqual((await ann.post('/api/social/presence', crs)).body.riders.map(x => x.name).sort(), ['Bob', 'Dan']);
  assert.deepEqual((await dan.post('/api/social/block', { id: A })).body, { blocked: true });
  assert.deepEqual((await ann.post('/api/social/presence', crs)).body.riders.map(x => x.name), ['Bob']);
  assert.deepEqual((await dan.post('/api/social/presence', crs)).body.riders.map(x => x.name), ['Bob']);
  assert.deepEqual((await ann.post('/api/social/search', { q: 'dan' })).body.users, []);
  assert.equal((await ann.post('/api/social/friends/request', { id: D })).status, 404);
  assert.deepEqual((await dan.get('/api/social')).body.blocked, [{ id: A, name: 'Ann' }]);
  await dan.post('/api/social/unblock', { id: A });
  assert.deepEqual((await ann.post('/api/social/search', { q: 'dan' })).body.users.map(u => u.name), ['Dan']);
  // blocking a friend ends the friendship
  await ann.post('/api/social/friends/request', { id: D }); await dan.post('/api/social/friends/accept', { id: A });
  await ann.post('/api/social/block', { id: D });
  assert.deepEqual((await ann.get('/api/social')).body.friends.map(f => f.name), ['Bob', 'Cat']);
  await ann.post('/api/social/unblock', { id: D });

  // group rides: create with a plan, time and workout; invite friends only; lobby; join by link; leave; organizer cancels
  const plan = { kind: 'open', name: 'Golden Gate Bridge', lat: 37.80817, lon: -122.47641, heading: 340 };
  assert.equal((await ann.post('/api/social/groups', { plan: { kind: 'x' }, at: NOW + HOUR })).body.error, 'bad_plan');
  assert.equal((await ann.post('/api/social/groups', { plan, at: NOW + 30 * DAY })).body.error, 'bad_time');
  assert.equal((await ann.post('/api/social/groups', { plan, at: NOW + HOUR, workout: { name: 'x', text: 'nonsense' } })).body.error, 'bad_workout');
  r = await ann.post('/api/social/groups', { plan, at: NOW + HOUR, name: 'Tuesday spin', workout: { name: 'Tempo', text: '10m 60%, 20m 80%' }, invite: [B, D, 'junk'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const g = r.body.group;
  assert.match(g.id, /^[A-Za-z0-9]{12}$/);
  assert.deepEqual([g.name, g.plan.kind, g.workout.name, g.mine, g.state, g.owner.name], ['Tuesday spin', 'open', 'Tempo', true, 'in', 'Ann']);
  let lobby = (await bob.get(`/api/social/groups/${g.id}`)).body;
  const names = l => l.members.map(m => [m.name, m.state]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  assert.deepEqual(names(lobby), [['Ann', 'in'], ['Bob', 'invited']]);  // Dan is not a friend now
  assert.equal(lobby.group.state, 'invited');
  bs = (await bob.get('/api/social')).body;
  assert.deepEqual(bs.groups.map(x => [x.name, x.state, x.members]), [['Tuesday spin', 'invited', 1]]);
  assert.deepEqual((await bob.post(`/api/social/groups/${g.id}/join`)).body, { state: 'in' });
  assert.equal((await dan.post(`/api/social/groups/${g.id}/join`)).status, 200);  // the share link works for anyone
  lobby = (await ann.get(`/api/social/groups/${g.id}`)).body;
  assert.deepEqual(names(lobby), [['Ann', 'in'], ['Bob', 'in'], ['Dan', 'in']]);
  assert.equal((await cat.post(`/api/social/groups/${g.id}/invite`, { ids: [A] })).status, 403);  // members invite
  assert.deepEqual((await ann.post(`/api/social/groups/${g.id}/invite`, { ids: [C] })).body, { invited: 1 });
  assert.equal((await ann.get('/api/social/groups/nope12345')).status, 404);
  // presence in a group ride: members anywhere, flagged; group chat piggybacks
  await dan.post('/api/social/presence', { ...at(45.05, 6.03), group: g.id });
  r = await bob.post('/api/social/presence', { ...at(37.8, -122.47), group: g.id, chat: { since: 0 } });
  assert.deepEqual(r.body.riders.map(x => [x.name, x.group]), [['Dan', true]]);
  assert.deepEqual(r.body.chat, []);
  // chat: group members only, moderated, rate limited; read since a cursor
  assert.equal((await cat.post('/api/social/chat/send', { group: g.id, body: 'hi' })).body.error, 'not_member');
  let m1 = await ann.post('/api/social/chat/send', { group: g.id, body: '  Rolling in 5  ' });
  assert.equal(m1.status, 201); m1 = m1.body.message;
  assert.deepEqual([m1.body, m1.name, m1.mine], ['Rolling in 5', 'Ann', true]);
  assert.equal((await ann.post('/api/social/chat/send', { group: g.id, body: 'see example.com' })).body.error, 'no_links');
  assert.equal((await ann.post('/api/social/chat/send', { group: g.id, body: 'oh sh1t' })).body.error, 'blocked_words');
  assert.equal((await ann.post('/api/social/chat/send', { group: g.id, body: 'x'.repeat(301) })).body.error, 'bad_message');
  const m2 = (await dan.post('/api/social/chat/send', { group: g.id, body: 'Ready' })).body.message;
  r = await bob.post('/api/social/presence', { ...at(37.8, -122.47), group: g.id, chat: { since: 0 } });
  assert.deepEqual(r.body.chat.map(x => [x.name, x.body, x.mine]), [['Ann', 'Rolling in 5', false], ['Dan', 'Ready', false]]);
  r = await bob.post('/api/social/chat/read', { group: g.id, since: m2.seq + 5 });
  assert.deepEqual(r.body.messages, []);
  r = await bob.post('/api/social/chat/read', { group: g.id, since: m2.seq });
  assert.ok(r.body.messages.every(x => x.seq <= m2.seq));  // a few of overlap, the page keeps ids it has
  // a block hides chat both ways
  await bob.post('/api/social/block', { id: D });
  assert.deepEqual((await bob.post('/api/social/chat/read', { group: g.id, since: 0 })).body.messages.map(x => x.name), ['Ann']);
  assert.deepEqual((await dan.post('/api/social/chat/read', { group: g.id, since: 0 })).body.messages.map(x => x.name), ['Ann', 'Dan']);
  assert.deepEqual((await dan.get(`/api/social/groups/${g.id}`)).body.members.map(m => m.name).sort(), ['Ann', 'Cat', 'Dan']);  // Bob blocked Dan
  await bob.post('/api/social/unblock', { id: D });
  // reports: 3 members hide a group message; the owner reviews it
  const rude = (await dan.post('/api/social/chat/send', { group: g.id, body: 'You are all slow' })).body.message;
  await cat.post(`/api/social/groups/${g.id}/join`);
  for (const u of [ann, bob]) assert.deepEqual((await u.post('/api/social/chat/report', { id: rude.id, reason: 'rude' })).body, { ok: true, hidden: false });
  assert.deepEqual((await cat.post('/api/social/chat/report', { id: rude.id })).body, { ok: true, hidden: true });
  assert.ok(!(await ann.post('/api/social/chat/read', { group: g.id, since: 0 })).body.messages.some(x => x.id === rude.id));
  // direct chat: friends only; one report hides it for both
  assert.equal((await ann.post('/api/social/chat/send', { to: D, body: 'hey' })).body.error, 'not_friends');
  const dm = (await ann.post('/api/social/chat/send', { to: B, body: 'Ride tonight?' })).body.message;
  assert.deepEqual((await bob.post('/api/social/chat/read', { to: A, since: 0 })).body.messages.map(x => x.body), ['Ride tonight?']);
  assert.equal((await dan.post('/api/social/chat/read', { to: A, since: 0 })).body.error, 'not_friends');
  assert.equal((await dan.post('/api/social/chat/report', { id: dm.id })).body.error, 'not_friends');
  assert.deepEqual((await bob.post('/api/social/chat/report', { id: dm.id })).body, { ok: true, hidden: true });
  assert.deepEqual((await ann.post('/api/social/chat/read', { to: B, since: 0 })).body.messages, []);
  // chat rate limit: 20 a minute
  advance(60000);
  for (let i = 0; i < 20; i++) assert.equal((await ann.post('/api/social/chat/send', { to: B, body: `m${i}` })).status, 201);
  assert.equal((await ann.post('/api/social/chat/send', { to: B, body: 'one more' })).status, 429);
  // leaving; the organizer leaving cancels
  assert.deepEqual((await bob.post(`/api/social/groups/${g.id}/leave`)).body, { state: null });
  assert.equal((await bob.post('/api/social/chat/send', { group: g.id, body: 'hi' })).body.error, 'not_member');
  await ann.post(`/api/social/groups/${g.id}/leave`);
  assert.equal((await dan.get(`/api/social/groups/${g.id}`)).status, 404);
  assert.deepEqual((await dan.get('/api/social')).body.groups, []);
  // a group with a course plan
  r = await bob.post('/api/social/groups', { plan: { kind: 'course', id: 'hawk-hill', name: 'Hawk Hill' }, at: NOW + 120000 });
  assert.equal(r.status, 201); assert.deepEqual(r.body.group.plan, { kind: 'course', id: 'hawk-hill', name: 'Hawk Hill' });
  assert.equal(r.body.group.workout, null);

  // ride-ons: a finished ride shows to friends, who can ride it on once; strangers cannot
  assert.equal((await bob.post('/api/social/activity', { name: 'Short', secs: 30 })).body.error, 'too_short');
  r = await bob.post('/api/social/activity', { name: 'Hawk Hill repeats', secs: 3600, dist: 30500, avg: 215 });
  assert.equal(r.status, 201);
  as = (await ann.get('/api/social')).body;
  assert.deepEqual(as.activity.map(a => [a.name, a.title, a.secs, a.dist, a.avg, a.rideons, a.gave, a.mine]), [['Bob', 'Hawk Hill repeats', 3600, 30500, 215, 0, false, false]]);
  assert.deepEqual((await ann.post(`/api/social/activity/${r.body.id}/rideon`)).body, { rideons: 1, gave: true });
  assert.deepEqual((await ann.post(`/api/social/activity/${r.body.id}/rideon`)).body, { rideons: 1, gave: true });
  assert.equal((await dan.post(`/api/social/activity/${r.body.id}/rideon`)).status, 404);
  assert.equal((await bob.post(`/api/social/activity/${r.body.id}/rideon`)).status, 404);  // not your own
  assert.deepEqual((await bob.get('/api/social')).body.activity.map(a => [a.mine, a.rideons]), [[true, 1]]);
  assert.deepEqual((await ann.get('/api/social')).body.activity[0].gave, true);
  // hidden riders post no activity
  await cat.post('/api/social/me', { visible: false });
  assert.deepEqual((await cat.post('/api/social/activity', { name: 'Secret', secs: 600 })).body, { ok: true, posted: false });
  // a week later the list is empty
  advance(8 * DAY);
  assert.deepEqual((await ann.get('/api/social')).body.activity, []);

  // the account export carries social data
  const ex = (await ann.get('/api/sync/export')).body.social;
  assert.equal(ex.profile.code, me.code);
  assert.deepEqual(ex.friends.map(f => f.name).sort(), ['Bob', 'Cat']);
  assert.ok(ex.messages.some(m => m.body === 'Rolling in 5'));
  assert.ok(Array.isArray(ex.groups) && Array.isArray(ex.activities) && Array.isArray(ex.blocked));
  // deleting an account removes its social rows; friends see it gone
  await bob.post('/api/auth/delete', { confirm: 'DELETE', password: 'password123' });
  as = (await ann.get('/api/social')).body;
  assert.deepEqual(as.friends.map(f => f.name), ['Cat']);
  assert.deepEqual((await ann.post('/api/social/search', { q: 'bob' })).body.users, []);
};

/* ---------- run ---------- */
const names = which === 'all' ? Object.keys(S) : which.split(',');
const out = {};
for (const n of names) { if (!S[n]) throw new Error('no section ' + n); await S[n](); out[n] = 'ok'; }
console.log(JSON.stringify(out));
