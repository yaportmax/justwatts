// The API proxy and cookie jar (src/proxy.js) and the OAuth handoff (src/oauth.js), against the real accounts API
// (web/api/_lib) on a memory store: sign-up, the session cookie, the system-browser sign-in round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CookieJar, createProxy } = require('../src/proxy.js');
const { createOAuth } = require('../src/oauth.js');

test('cookie jar: Max-Age, Expires, delete, persistence with a cipher', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jw-jar-'));
  try {
    let now = 1_000_000;
    const crypt = { encrypt: s => Buffer.from(s, 'utf8').reverse(), decrypt: b => Buffer.from(b).reverse().toString('utf8') };
    const jar = new CookieJar({ file: path.join(dir, 'j'), crypt, now: () => now });
    jar.absorb(['__Host-jw_session=abc.def; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax', 'b=2; Expires=Thu, 01 Jan 2099 00:00:00 GMT']);
    assert.equal(jar.header(), '__Host-jw_session=abc.def; b=2');
    assert.ok(!readFileSync(path.join(dir, 'j'), 'utf8').includes('abc.def'), 'stored through the cipher');
    const again = new CookieJar({ file: path.join(dir, 'j'), crypt, now: () => now });
    assert.equal(again.header(), '__Host-jw_session=abc.def; b=2');
    now += 61000;
    assert.equal(again.header(), 'b=2');
    again.absorb(['b=; Max-Age=0']);
    assert.equal(again.header(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proxy: forwards with the site Origin and the jar, strips cookies from the page', async () => {
  const seen = [];
  const fetchImpl = async (url, o) => {
    seen.push({ url, method: o.method, h: Object.fromEntries(o.headers), body: o.body && o.body.toString() });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: [['content-type', 'application/json'], ['set-cookie', 'k=v; Max-Age=100'], ['strict-transport-security', 'max-age=1']] });
  };
  const jar = new CookieJar();
  const p = createProxy({ api: 'https://justwatts.com/', jar, fetchImpl });
  const req = new Request('app://justwatts/api/sync/state?x=1', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hw': '1', cookie: 'evil=1', origin: 'app://justwatts' }, body: '{"a":1}' });
  const r = await p.handle(req);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('strict-transport-security'), null);
  assert.equal(seen[0].url, 'https://justwatts.com/api/sync/state?x=1');
  assert.equal(seen[0].h.origin, 'https://justwatts.com'); assert.equal(seen[0].h['x-hw'], '1'); assert.equal(seen[0].h.cookie, undefined);
  assert.equal(seen[0].body, '{"a":1}');
  await p.handle(new Request('app://justwatts/api/auth/me'));
  assert.equal(seen[1].h.cookie, 'k=v');
  const off = createProxy({ api: 'https://justwatts.com', jar, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal((await off.handle(new Request('app://justwatts/api/auth/me'))).status, 502);
});

test('sign-up and Google sign-in through the system browser, against the accounts API', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { JUSTWATTS_STORE: 'memory', JUSTWATTS_SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gs' });
  const lib = require('../../../web/api/_lib/app.js');
  const server = createServer((q, s) => lib.handler(q, s));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_ORIGIN = api;
  const realFetch = globalThis.fetch;
  let nonce = null;
  globalThis.fetch = async (url, o) => {  // Google's token endpoint, stubbed; everything else is real
    if (String(url) !== 'https://oauth2.googleapis.com/token') return realFetch(url, o);
    const claims = { iss: 'https://accounts.google.com', aud: 'gid', exp: Math.floor(Date.now() / 1000) + 600, sub: 'g-1', email: 'g@example.com', email_verified: true, nonce };
    return new Response(JSON.stringify({ id_token: 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s' }), { status: 200 });
  };
  try {
    const browser = async start => {  // the system browser: follows /start to Google and back to the callback
      const jar = new CookieJar();
      const s = await realFetch(start, { redirect: 'manual' });
      jar.absorb(s.headers.getSetCookie());
      const g = new URL(s.headers.get('location')); nonce = g.searchParams.get('nonce');
      const cb = await realFetch(`${api}/api/auth/google/callback?code=abcd1234&state=${g.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: jar.header() } });
      return cb.headers.get('location');
    };
    // login
    const jar = new CookieJar(), proxy = createProxy({ api, jar });
    let opened = null;
    const oauth = createOAuth({ api, proxy, openExternal: async u => { opened = u; } });
    assert.ok(oauth.isStart('/api/auth/google/start')); assert.ok(!oauth.isStart('/api/auth/me'));
    assert.equal(await oauth.start(new URL('app://justwatts/api/auth/google/start?mode=login&return=%2F%23settings')), null);
    assert.match(opened, new RegExp(`^${api}/api/auth/google/start\\?mode=login&return=%2F%23settings&app=[\\w-]{43}$`));
    const link = await browser(opened);
    assert.match(link, /^justwatts:\/\/auth\?/);
    assert.equal(await oauth.finish(link), '/?provider=google&auth=ok&new=1#settings');
    const me = await proxy.json('GET', '/api/auth/me');
    assert.equal(me.body.user.email, 'g@example.com');
    // a replayed link fails cleanly
    assert.equal(await oauth.finish(link), '/?provider=google&auth=error&reason=bad_state#settings');
    // not ours
    assert.equal(await oauth.finish('https://example.com/auth?code=1'), null);
    // link mode: the app's ticket names the account (an email account linking Google)
    const jar2 = new CookieJar(), p2 = createProxy({ api, jar: jar2 });
    assert.equal((await p2.json('POST', '/api/auth/signup', { email: 'e@example.com', password: 'password123' })).status, 201);
    const o2 = createOAuth({ api, proxy: p2, openExternal: async u => { opened = u; } });
    // Google sub g-1 is taken by the first account: identity_in_use comes back to the app
    assert.equal(await o2.start(new URL('app://justwatts/api/auth/google/start?mode=link&return=%2F%23settings')), null);
    assert.match(opened, /mode=link&.*&ticket=/);
    assert.equal(await o2.finish(await browser(opened)), '/?provider=google&auth=error&reason=identity_in_use#settings');
    // signed out: no ticket, the page gets the website's signed_out error without leaving the app
    const o3 = createOAuth({ api, proxy: createProxy({ api, jar: new CookieJar() }), openExternal: async () => { throw new Error('should not open'); } });
    assert.equal(await o3.start(new URL('app://justwatts/api/auth/google/start?mode=link&return=%2F')), '/?provider=google&auth=error&reason=signed_out');
  } finally {
    globalThis.fetch = realFetch; server.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
