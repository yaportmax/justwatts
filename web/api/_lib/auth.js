// /api/auth/*: email + password, sessions, Google and Strava sign-in, linking, reset, verification, delete.
'use strict';
const app = require('./app');
const { route, open, providers, env, secret, sessionUser, startSession, endSession, requireUser, limit, isAdmin, DAY } = app;
const { fail, readJson, checkWrite, redirect, parseCookies, cookie } = require('./http');
const { hashPassword, verifyPassword, sign, unsign, randomId, sha256 } = require('./crypto');
const { hasBadWord, hasLink, clean } = require('./moderation');
const crypto = require('node:crypto');

const MIN = 60000, HOUR = 3600000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OAUTH = '__Host-jw_oauth';
const TOKEN_TTL = { verify: 2 * DAY, reset: HOUR };

function readEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) fail(400, 'bad_email');
  return e;
}
function readPassword(v) {
  const p = String(v ?? '');
  if (typeof v !== 'string' || p.length < 8 || p.length > 200) fail(400, 'bad_password', { min: 8, max: 200 });
  return p;
}
function readName(v) {
  const n = clean(v).replace(/\s+/g, ' ').slice(0, 40);
  if (n && (hasBadWord(n) || hasLink(n))) fail(400, 'bad_name');
  return n;
}
const mailOn = () => providers().emailVerification;

async function publicUser(ctx, u) {
  const ids = await ctx.store.identitiesOf(u.id);
  const em = ids.find(i => i.provider === 'email');
  return {
    user: { id: u.id, name: u.name, createdAt: u.createdAt, email: em ? em.email : (ids.find(i => i.email)?.email || null), verified: !!(em ? em.verified : ids.some(i => i.verified)), hasPassword: !!u.passHash },
    identities: ids.map(i => ({ provider: i.provider, email: i.email || null, verified: !!i.verified, createdAt: i.createdAt })),
    admin: isAdmin(ids),
  };
}
const ok = (body = { ok: true }, status = 200) => ({ status, body });

/* ---------- email (Resend) ---------- */
async function sendMail(ctx, to, subject, text) {
  const r = await ctx.fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env().EMAIL_FROM, to: [to], subject, text }), signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!r || !r.ok) console.error('email send failed', r ? r.status : 'network');
}
async function mailToken(ctx, user, email, purpose) {
  const token = randomId(32);
  await ctx.store.putToken({ hash: sha256(token), userId: user.id, purpose, data: email, expiresAt: ctx.now + TOKEN_TTL[purpose] });
  const link = `${ctx.origin}/?${purpose}=${token}`;
  if (purpose === 'verify') await sendMail(ctx, email, 'Confirm your Just Watts email', `Confirm your email for Just Watts:\n\n${link}\n\nThe link works for 48 hours. If you did not sign up, ignore this email.`);
  else await sendMail(ctx, email, 'Reset your Just Watts password', `Set a new Just Watts password:\n\n${link}\n\nThe link works for 1 hour. If you did not ask for this, ignore this email.`);
}

/* ---------- providers, me ---------- */
route('GET', '/api/auth/providers', open(async () => ok(providers(), 200)));
route('GET', '/api/auth/me', async ctx => {
  const u = await sessionUser(ctx);
  if (!u) return ok({ user: null });
  if (ctx.session.exp - ctx.now < 15 * DAY) startSession(ctx, u);  // sliding renewal
  return ok(await publicUser(ctx, u));
});

/* ---------- email + password ---------- */
route('POST', '/api/auth/signup', async ctx => {
  checkWrite(ctx.req);
  const b = await readJson(ctx.req);
  const email = readEmail(b.email), password = readPassword(b.password), name = readName(b.name);
  await limit(ctx, [[`signup:ip:${ctx.ip}`, HOUR, 10], [`mail:${email}`, HOUR, 5]]);
  const id = randomId(12), passHash = await hashPassword(password);
  const existing = await ctx.store.getIdentity('email', email);
  if (existing) {
    if (!mailOn()) fail(409, 'email_taken');  // without email there is no way to hide this
    const owner = await ctx.store.getUser(existing.userId);
    if (owner) await mailToken(ctx, owner, email, 'reset');  // "you already have an account": a reset link
    return ok({ status: 'verify_sent' }, 202);
  }
  let user;
  try { user = await ctx.store.createUserWithIdentity({ id, name, passHash, createdAt: ctx.now }, { provider: 'email', subject: email, email, verified: false }); }
  catch (e) { if (e.code === 'exists') fail(409, 'email_taken'); throw e; }
  if (mailOn()) { await mailToken(ctx, user, email, 'verify'); return ok({ status: 'verify_sent' }, 202); }
  startSession(ctx, user);
  return ok(await publicUser(ctx, user), 201);
});

route('POST', '/api/auth/login', async ctx => {
  checkWrite(ctx.req);
  const b = await readJson(ctx.req);
  const email = String(b.email ?? '').trim().toLowerCase(), password = String(b.password ?? '');
  await limit(ctx, [[`login:ip:${ctx.ip}`, 15 * MIN, 30], [`login:email:${email.slice(0, 254)}`, 15 * MIN, 10]]);
  const ident = EMAIL_RE.test(email) ? await ctx.store.getIdentity('email', email) : null;
  const user = ident ? await ctx.store.getUser(ident.userId) : null;
  const v = await verifyPassword(password.slice(0, 200), user?.passHash);  // same scrypt cost with or without an account
  if (!user || !v.ok) fail(401, 'invalid_credentials');
  if (mailOn() && !ident.verified) {  // right password, unconfirmed address: send a fresh link
    const r = await ctx.store.hit(`mail:${email}`, HOUR, 5, ctx.now);
    if (r.ok) await mailToken(ctx, user, email, 'verify');
    fail(403, 'unverified');
  }
  if (v.rehash) await ctx.store.updateUser(user.id, { passHash: await hashPassword(password) });
  startSession(ctx, user);
  return ok(await publicUser(ctx, user));
});

route('POST', '/api/auth/logout', async ctx => { checkWrite(ctx.req); endSession(ctx); return ok(); });
route('POST', '/api/auth/logout-all', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx);
  await ctx.store.bumpSession(u.id); endSession(ctx);
  return ok();
});

route('POST', '/api/auth/profile', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await limit(ctx, [[`profile:${u.id}`, HOUR, 20]]);
  const name = readName(b.name);
  await ctx.store.updateUser(u.id, { name });
  return ok(await publicUser(ctx, { ...u, name }));
});

route('POST', '/api/auth/password', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await limit(ctx, [[`password:${u.id}`, HOUR, 10]]);
  if (!u.passHash) fail(409, 'no_password');  // OAuth-only: link an email first (/api/auth/link/email)
  if (!(await verifyPassword(String(b.current ?? '').slice(0, 200), u.passHash)).ok) fail(401, 'invalid_credentials');
  const password = readPassword(b.password);
  await ctx.store.updateUser(u.id, { passHash: await hashPassword(password) });
  const ver = await ctx.store.bumpSession(u.id);  // other devices sign out, this one stays in
  startSession(ctx, { ...u, sessionVersion: ver });
  return ok();
});

route('POST', '/api/auth/delete', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await limit(ctx, [[`delete:${u.id}`, HOUR, 10]]);
  if (b.confirm !== 'DELETE') fail(400, 'confirm_required');
  if (u.passHash) { if (!(await verifyPassword(String(b.password ?? '').slice(0, 200), u.passHash)).ok) fail(401, 'invalid_credentials'); }
  else if (ctx.now - ctx.session.iat > 15 * MIN) fail(403, 'reauth_required');  // OAuth-only: a fresh sign-in
  await ctx.store.deleteUser(u.id); endSession(ctx);
  return ok();
});

/* ---------- verification and reset (only with Resend) ---------- */
route('POST', '/api/auth/verify/resend', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx);
  if (!mailOn()) fail(503, 'email_unavailable');
  const em = (await ctx.store.identitiesOf(u.id)).find(i => i.provider === 'email');
  if (!em) fail(409, 'no_email');
  if (em.verified) return ok({ ok: true, verified: true });
  await limit(ctx, [[`verify:${u.id}`, HOUR, 3], [`mail:${em.email}`, HOUR, 5]]);
  await mailToken(ctx, u, em.email, 'verify');
  return ok();
});
route('POST', '/api/auth/verify', async ctx => {
  checkWrite(ctx.req);
  const b = await readJson(ctx.req);
  await limit(ctx, [[`token:ip:${ctx.ip}`, HOUR, 30]]);
  const t = await ctx.store.takeToken(sha256(String(b.token ?? '').slice(0, 100)), 'verify', ctx.now);
  const em = t && (await ctx.store.identitiesOf(t.userId)).find(i => i.provider === 'email' && i.email === t.data);
  if (!em) fail(400, 'bad_token');
  await ctx.store.setIdentityVerified('email', em.subject, true);
  const user = await ctx.store.getUser(t.userId);
  startSession(ctx, user);
  return ok(await publicUser(ctx, user));
});
route('POST', '/api/auth/reset/request', async ctx => {
  checkWrite(ctx.req);
  if (!mailOn()) fail(503, 'reset_unavailable');
  const b = await readJson(ctx.req);
  const email = readEmail(b.email);
  await limit(ctx, [[`reset:ip:${ctx.ip}`, HOUR, 5], [`mail:${email}`, HOUR, 5]]);
  const ident = await ctx.store.getIdentity('email', email);
  const user = ident && await ctx.store.getUser(ident.userId);
  if (user) await mailToken(ctx, user, email, 'reset');
  return ok({ status: 'reset_sent' }, 202);  // the same answer whether or not the account exists
});
route('POST', '/api/auth/reset/confirm', async ctx => {
  checkWrite(ctx.req);
  if (!mailOn()) fail(503, 'reset_unavailable');
  const b = await readJson(ctx.req);
  await limit(ctx, [[`token:ip:${ctx.ip}`, HOUR, 30]]);
  const password = readPassword(b.password);
  const t = await ctx.store.takeToken(sha256(String(b.token ?? '').slice(0, 100)), 'reset', ctx.now);
  const em = t && (await ctx.store.identitiesOf(t.userId)).find(i => i.provider === 'email' && i.email === t.data);
  if (!em) fail(400, 'bad_token');
  await ctx.store.updateUser(t.userId, { passHash: await hashPassword(password) });
  await ctx.store.setIdentityVerified('email', em.subject, true);  // the link proved the address
  await ctx.store.bumpSession(t.userId);
  const user = await ctx.store.getUser(t.userId);
  startSession(ctx, user);
  return ok(await publicUser(ctx, user));
});

/* ---------- linking ---------- */
route('POST', '/api/auth/link/email', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  await limit(ctx, [[`link:${u.id}`, HOUR, 10]]);
  const email = readEmail(b.email), password = readPassword(b.password);
  if ((await ctx.store.identitiesOf(u.id)).some(i => i.provider === 'email')) fail(409, 'already_linked');
  try { await ctx.store.addIdentity({ provider: 'email', subject: email, userId: u.id, email, verified: false, createdAt: ctx.now }); }
  catch (e) { if (e.code === 'exists') fail(409, 'email_taken'); throw e; }
  await ctx.store.updateUser(u.id, { passHash: await hashPassword(password) });
  if (mailOn()) await mailToken(ctx, u, email, 'verify');
  return ok(await publicUser(ctx, { ...u, passHash: 'set' }));
});
route('POST', '/api/auth/unlink', async ctx => {
  checkWrite(ctx.req);
  const u = await requireUser(ctx), b = await readJson(ctx.req);
  const ids = await ctx.store.identitiesOf(u.id);
  if (!ids.some(i => i.provider === b.provider)) fail(404, 'not_linked');
  if (ids.length < 2) fail(409, 'last_method');
  await ctx.store.removeIdentity(u.id, b.provider);
  if (b.provider === 'email') await ctx.store.updateUser(u.id, { passHash: null });
  return ok(await publicUser(ctx, { ...u, passHash: b.provider === 'email' ? null : u.passHash }));
});

/* ---------- OAuth: Google (OIDC code flow + PKCE) and Strava ---------- */
// Redirect URIs always come from PUBLIC_ORIGIN (registered with Google / Strava), never from the request host.
const oauthOrigin = () => (env().PUBLIC_ORIGIN || '').replace(/\/+$/, '') || null;
const OAUTH_CFG = {
  google: {
    on: () => providers().google,
    authorize: (ctx, st) => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: env().GOOGLE_CLIENT_ID, redirect_uri: `${oauthOrigin()}/api/auth/google/callback`, response_type: 'code',
      scope: 'openid email', state: st.s, nonce: st.n, code_challenge: crypto.createHash('sha256').update(st.v).digest('base64url'),
      code_challenge_method: 'S256', prompt: 'select_account',
    }),
    async profile(ctx, code, st) {
      const r = await ctx.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ code, client_id: env().GOOGLE_CLIENT_ID, client_secret: env().GOOGLE_CLIENT_SECRET, redirect_uri: `${oauthOrigin()}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: st.v }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || typeof body.id_token !== 'string') return null;
      // the ID token comes straight from Google's token endpoint over TLS, so its claims are checked, not its signature
      let c; try { c = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
      if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss) || c.aud !== env().GOOGLE_CLIENT_ID || !(c.exp * 1000 > ctx.now) || c.nonce !== st.n || !c.sub) return null;
      return { subject: String(c.sub), email: c.email ? String(c.email).toLowerCase() : null, verified: c.email_verified === true || c.email_verified === 'true', name: '' };
    },
  },
  strava: {
    on: () => providers().strava,
    authorize: (ctx, st) => 'https://www.strava.com/oauth/authorize?' + new URLSearchParams({
      client_id: env().STRAVA_CLIENT_ID, redirect_uri: `${oauthOrigin()}/api/auth/strava/callback`, response_type: 'code', approval_prompt: 'auto', scope: 'read', state: st.s,
    }),
    async profile(ctx, code) {
      const r = await ctx.fetch('https://www.strava.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ client_id: env().STRAVA_CLIENT_ID, client_secret: env().STRAVA_CLIENT_SECRET, code, grant_type: 'authorization_code' }),
      });
      const body = await r.json().catch(() => ({}));
      // the app's athlete cap (10 until Strava approves more): "Limit of connected athletes exceeded"
      if (!r.ok && /limit/i.test(JSON.stringify(body || {}))) return { error: 'strava_capped' };
      const a = body && body.athlete;
      if (!r.ok || !a || !(Number.isSafeInteger(a.id) || /^\d{1,20}$/.test(String(a.id)))) return null;
      let name = clean(a.firstname || '').slice(0, 40); if (hasBadWord(name) || hasLink(name)) name = '';
      return { subject: String(a.id), email: null, verified: false, name };
    },
  },
};
const safeReturn = r => typeof r === 'string' && /^\/(?![/\\])[\w\-./?=&#%]*$/.test(r) && r.length < 200 ? r : '/';
const withQuery = (path, q) => { const [p, h] = path.split('#'); return p + (p.includes('?') ? '&' : '?') + new URLSearchParams(q) + (h ? '#' + h : ''); };

for (const [name, cfg] of Object.entries(OAUTH_CFG)) {
  route('GET', `/api/auth/${name}/start`, async ctx => {
    const ret = safeReturn(ctx.url.searchParams.get('return')), mode = ctx.url.searchParams.get('mode') === 'link' ? 'link' : 'login';
    const back = q => redirect(ctx.res, withQuery(ret, { provider: name, ...q }), ctx.cookies);
    if (!cfg.on() || !oauthOrigin()) return back({ auth: 'error', reason: 'not_configured' });
    await limit(ctx, [[`oauth:ip:${ctx.ip}`, 15 * MIN, 30]]);
    let uid = '';
    if (mode === 'link') { const u = await sessionUser(ctx); if (!u) return back({ auth: 'error', reason: 'signed_out' }); uid = u.id; }
    const st = { s: randomId(16), n: randomId(16), v: randomId(32), p: name, m: mode, u: uid, r: ret, e: ctx.now + 10 * MIN };
    ctx.cookies.push(cookie(OAUTH, sign(secret(), Buffer.from(JSON.stringify(st)).toString('base64url')), 600));
    redirect(ctx.res, cfg.authorize(ctx, st), ctx.cookies);
  });
  route('GET', `/api/auth/${name}/callback`, async ctx => {
    const raw = unsign(secret(), decodeURIComponent(parseCookies(ctx.req)[OAUTH] || ''));
    let st = null; try { st = raw && JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { st = null; }
    ctx.cookies.push(cookie(OAUTH, '', 0));
    const ret = st ? safeReturn(st.r) : '/';
    const back = (q) => { redirect(ctx.res, withQuery(ret, { provider: name, ...q }), ctx.cookies); };
    const q = ctx.url.searchParams, state = q.get('state') || '', code = q.get('code') || '';
    if (!st || st.p !== name || !(st.e > ctx.now) || state.length !== st.s.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(st.s))) return back({ auth: 'error', reason: 'bad_state' });
    if (q.get('error') || !/^[\w\-./~]{4,512}$/.test(code)) return back({ auth: 'error', reason: 'denied' });
    if (!cfg.on() || !oauthOrigin()) return back({ auth: 'error', reason: 'not_configured' });
    let prof; try { prof = await cfg.profile(ctx, code, st); } catch { prof = null; }
    if (!prof || prof.error) return back({ auth: 'error', reason: prof?.error || 'provider_failed' });
    const ident = await ctx.store.getIdentity(name, prof.subject);
    if (st.m === 'link') {
      const u = await sessionUser(ctx);
      if (!u || u.id !== st.u) return back({ auth: 'error', reason: 'signed_out' });
      if (ident) return back(ident.userId === u.id ? { auth: 'linked' } : { auth: 'error', reason: 'identity_in_use' });
      try { await ctx.store.addIdentity({ provider: name, subject: prof.subject, userId: u.id, email: prof.email, verified: prof.verified, createdAt: ctx.now }); }
      catch (e) { if (e.code === 'exists') return back({ auth: 'error', reason: 'already_linked' }); throw e; }
      return back({ auth: 'linked' });
    }
    let user = ident && await ctx.store.getUser(ident.userId);
    if (!user && prof.email && prof.verified) {  // same verified email as an email account: link, if that email is verified too
      const em = await ctx.store.getIdentity('email', prof.email);
      if (em && !em.verified) return back({ auth: 'error', reason: 'email_in_use' });
      if (em) {
        user = await ctx.store.getUser(em.userId);
        try { await ctx.store.addIdentity({ provider: name, subject: prof.subject, userId: user.id, email: prof.email, verified: true, createdAt: ctx.now }); }
        catch (e) { if (e.code === 'exists') return back({ auth: 'error', reason: 'already_linked' }); throw e; }
      }
    }
    if (!user) {
      await limit(ctx, [[`signup:ip:${ctx.ip}`, HOUR, 10]]);
      user = await ctx.store.createUserWithIdentity({ id: randomId(12), name: prof.name, passHash: null, createdAt: ctx.now }, { provider: name, subject: prof.subject, email: prof.email, verified: prof.verified });
    }
    startSession(ctx, user);
    return back({ auth: 'ok' });
  });
}

module.exports = { readEmail, readPassword, readName };
