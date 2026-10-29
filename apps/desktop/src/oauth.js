// Google and Strava sign-in from the app. Google refuses embedded browsers, so the page's own navigation to
// /api/auth/<provider>/start is caught and opened in the system browser with a PKCE challenge. The site answers
// with justwatts://auth?code=..., and the app trades code + verifier for its session (POST /api/auth/app/exchange).
// Then the page loads the same ?provider=&auth= return URL the website gets, so the page code is unchanged.
'use strict';
const crypto = require('node:crypto');

const START = /^\/api\/auth\/(google|strava)\/start$/;
const safeReturn = r => (typeof r === 'string' && /^\/(?![/\\])[\w\-./?=&#%]*$/.test(r) && r.length < 200 ? r : '/');
const withQuery = (path, q) => { const [p, h] = path.split('#'); return p + (p.includes('?') ? '&' : '?') + new URLSearchParams(q) + (h ? '#' + h : ''); };

function createOAuth({ api, proxy, openExternal, ttlMs = 15 * 60000, now = () => Date.now() }) {
  let pending = null;  // one sign-in at a time: { v, at }
  return {
    isStart: pathname => START.test(pathname),
    // u: the URL the page navigated to. Returns the page URL to show on failure, or null when the browser opened.
    async start(u) {
      const provider = u.pathname.match(START)[1], mode = u.searchParams.get('mode') === 'link' ? 'link' : 'login';
      const ret = safeReturn(u.searchParams.get('return') || '/');
      const v = crypto.randomBytes(32).toString('base64url'), c = crypto.createHash('sha256').update(v).digest('base64url');
      const q = new URLSearchParams({ mode, return: ret, app: c });
      if (mode === 'link') {
        const t = await proxy.json('POST', '/api/auth/app/ticket', {});
        if (!t.ok || !t.body.ticket) return withQuery(ret, { provider, auth: 'error', reason: t.body.error === 'offline' ? 'offline' : 'signed_out' });
        q.set('ticket', t.body.ticket);
      }
      pending = { v, at: now() };
      await openExternal(`${api}/api/auth/${provider}/start?${q}`);
      return null;
    },
    // the justwatts:// link -> the page URL to load (or null if it is not ours)
    async finish(link) {
      let u; try { u = new URL(link); } catch { return null; }
      if (u.protocol !== 'justwatts:' || (u.hostname || u.pathname.replace(/^\/+/, '')) !== 'auth') return null;
      const q = u.searchParams, ret = safeReturn(q.get('return') || '/');
      const out = { provider: q.get('provider') || '', auth: q.get('auth') || 'error' };
      for (const k of ['new', 'reason']) if (q.get(k)) out[k] = q.get(k);
      const code = q.get('code');
      if (code) {
        const p = pending; pending = null;
        if (!p || now() - p.at > ttlMs) { delete out.new; Object.assign(out, { auth: 'error', reason: 'bad_state' }); }
        else {
          const r = await proxy.json('POST', '/api/auth/app/exchange', { code, verifier: p.v });
          if (!r.ok) { delete out.new; Object.assign(out, { auth: 'error', reason: r.body.error || 'provider_failed' }); }
        }
      }
      return withQuery(ret, out);
    },
  };
}

module.exports = { createOAuth, safeReturn, withQuery };
