// Router and shared context for /api/auth/*, /api/sync/*, /api/community*, /api/admin/*.
// One handler serves every entry file under web/api; it routes on the request path.
'use strict';
const { HttpError, fail, send, parseCookies, cookie, clientIp, publicOrigin } = require('./http');
const { sign, unsign } = require('./crypto');
const { memoryStore } = require('./store-memory');
const { pgStore, neonDb } = require('./store-pg');

const SESSION = '__Host-jw_session';
const SESSION_DAYS = 30, DAY = 86400000;

/* ---------- config (read at call time, so a missing env reports "not configured", never crashes) ---------- */
const env = () => process.env;
const secret = () => { const s = env().JUSTWATTS_SESSION_SECRET || ''; return s.length >= 32 ? s : null; };
const providers = () => {
  const e = env(), mail = !!(e.RESEND_API_KEY && e.EMAIL_FROM);
  const accounts = !!(storeOrNull() && secret());
  return {
    accounts, email: accounts, emailVerification: accounts && mail, passwordReset: accounts && mail,
    google: accounts && !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
    strava: accounts && !!(e.STRAVA_CLIENT_ID && e.STRAVA_CLIENT_SECRET),
    stravaCapped: e.STRAVA_CAPPED !== '0',  // Strava apps start with a 10-athlete cap; set STRAVA_CAPPED=0 once lifted
  };
};

let store = null;
function storeOrNull() {
  if (store) return store;
  const e = env(), url = e.DATABASE_URL || e.JUSTWATTS_DATABASE_URL || e.POSTGRES_URL;
  if (e.JUSTWATTS_STORE === 'memory') store = memoryStore();
  else if (url) store = pgStore(neonDb(url));
  return store;
}
const setStore = s => { store = s; };
const clock = { now: () => Date.now() };  // tests swap this for a fake clock

/* ---------- session cookie: uid.version.iat.exp, HMAC signed; the version in users revokes all ---------- */
async function sessionUser(ctx) {
  if (ctx._user !== undefined) return ctx._user;
  ctx._user = null;
  const key = secret(), raw = parseCookies(ctx.req)[SESSION];
  if (!key || !raw) return null;
  const v = unsign(key, decodeURIComponent(raw)); if (!v) return null;
  const [uid, ver, iat, exp] = v.split('.');
  if (!(+exp > ctx.now)) return null;
  const u = await ctx.store.getUser(uid);
  if (!u || u.sessionVersion !== +ver) return null;
  ctx.session = { iat: +iat, exp: +exp };
  return (ctx._user = u);
}
function startSession(ctx, user) {
  const exp = ctx.now + SESSION_DAYS * DAY;
  ctx.cookies.push(cookie(SESSION, sign(secret(), `${user.id}.${user.sessionVersion}.${ctx.now}.${exp}`), SESSION_DAYS * 86400));
  ctx.session = { iat: ctx.now, exp }; ctx._user = user;
}
const endSession = ctx => { ctx.cookies.push(cookie(SESSION, '', 0)); ctx._user = null; };
async function requireUser(ctx) { const u = await sessionUser(ctx); if (!u) fail(401, 'signed_out'); return u; }

/* ---------- rate limits: each rule [key, windowMs, limit]; all rules are counted, any over -> 429 ---------- */
async function limit(ctx, rules) {
  let worst = null;
  for (const [key, win, max] of rules) {
    const r = await ctx.store.hit(key, win, max, ctx.now);
    if (!r.ok && (!worst || r.resetAt > worst)) worst = r.resetAt;
  }
  if (worst) fail(429, 'rate_limited', { retryAfter: Math.max(1, Math.ceil((worst - ctx.now) / 1000)) });
}

function isAdmin(idents) {
  const owners = String(env().OWNER_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return idents.some(i => i.verified && i.email && owners.includes(i.email.toLowerCase()));
}

/* ---------- routing ---------- */
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const ctx = { req, res, url, now: clock.now(), cookies: [], ip: clientIp(req), headers: {}, fetch: globalThis.fetch, origin: publicOrigin(req) };
  const out = (code, body, headers = {}) => {
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    send(res, code, body, { ...ctx.headers, ...headers });
  };
  try {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const match = routes.map(r => ({ r, m: r.re.exec(path) })).filter(x => x.m);
    if (!match.length) return out(404, { error: 'not_found' });
    const hit = match.find(x => x.r.method === req.method);
    if (!hit) return out(405, { error: 'method_not_allowed' });
    ctx.params = Object.fromEntries(Object.entries(hit.m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    if (!hit.r.fn.open) {  // everything but /providers needs the database and the session secret
      ctx.store = storeOrNull();
      if (!ctx.store || !secret()) return out(503, { error: 'not_configured' });
    } else ctx.store = storeOrNull();
    const r = await hit.r.fn(ctx);
    if (r === undefined) return;  // handler wrote the response itself (redirects, binary)
    return out(r.status || 200, r.body, r.headers);
  } catch (e) {
    if (e instanceof HttpError) return out(e.status, { error: e.code, ...(e.extra || {}) }, e.code === 'rate_limited' ? { 'Retry-After': String(e.extra.retryAfter) } : {});
    console.error('api error', req.method, (req.url || '').split('?')[0], e && e.code, e && e.message && e.message.slice(0, 200));
    return out(500, { error: 'server_error' });
  }
}
const open = fn => Object.assign(fn, { open: true });

module.exports = { clock, handler, route, open, providers, env, secret, setStore, storeOrNull, sessionUser, startSession, endSession, requireUser, limit, isAdmin, SESSION, DAY };
// load the route tables (they call route() above)
require('./auth'); require('./sync'); require('./community');
