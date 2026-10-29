// Garmin Connect for the web (unofficial). Garth's OAuth1 flow stopped working for new logins in March 2026
// (github.com/matin/garth README "[DEPRECATED]", issue #217), so this ports the flow python-garminconnect
// uses since 0.3.0 (github.com/cyberjunky/python-garminconnect, garminconnect/client/sso.py, session.py,
// transport.py, api/activities.py; "mobile" strategy):
//   1. GET  sso.garmin.com/mobile/sso/en_US/sign-in?clientId=GCM_IOS_DARK&service=...   (sets SESSION + Cloudflare cookies;
//      skipping it makes the login answer 429, fix #479)
//   2. POST sso.garmin.com/mobile/api/login  {username, password, rememberMe, captchaToken}
//      -> responseStatus.type SUCCESSFUL (serviceTicketId) | MFA_REQUIRED (customerMfaInfo.mfaLastMethodUsed) |
//         INVALID_USERNAME_PASSWORD | CAPTCHA_REQUIRED
//   3. POST sso.garmin.com/mobile/api/mfa/verifyCode  {mfaMethod, mfaVerificationCode, ...} -> serviceTicketId
//   4. POST diauth.garmin.com/di-oauth2-service/oauth/token  (Basic client_id:, grant service_ticket) -> DI access +
//      refresh token; several client ids are tried in order
//   5. refresh: same URL, grant_type=refresh_token; refresh 15 min before the JWT exp
//   6. upload: POST connectapi.garmin.com/upload-service/upload (multipart "file"), Bearer, Android app headers;
//      409 = duplicate ("Duplicate Activity.", CHANGELOG 0.3.19)
//   7. import (same Bearer, connectapi.garmin.com; paths as python-garminconnect garmin.py):
//      /userprofile-service/userprofile/user-settings (userData: weight g, lactateThresholdHeartRate),
//      /userprofile-service/socialProfile (displayName), /weight-service/weight/dateRange,
//      /biometric-service/biometric/latestFunctionalThresholdPower/CYCLING, /biometric-service/heartRateZones,
//      /biometric-service/biometric/latestLactateThreshold, /wellness-service/wellness/dailyHeartRate/{displayName},
//      /activitylist-service/activities/search/activities, /download-service/files/activity/{id} (zip, original FIT)
// Only {di_token, di_refresh_token, di_client_id} are stored; the password is used once and dropped.
// Risk: Garmin may refuse logins from datacenter IPs or Node's TLS fingerprint (garth #217, garminconnect #369);
// that surfaces as `blocked`, and the page offers the local app or the manual FIT upload.
'use strict';
const { AUTH, BLOCKED, TEMPORARY, DUPLICATE, IntegrationError, kindForStatus, retryAfter, call, multipart, realSleep } = require('./base');
const I = require('./importing');

const SSO = 'https://sso.garmin.com';
const SERVICE = 'https://mobile.integration.garmin.com/gcm/ios';
const CLIENT = 'GCM_IOS_DARK';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const DI_TOKEN = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const DI_GRANT = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
const DI_CLIENTS = ['GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2', 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4', 'GARMIN_CONNECT_MOBILE_ANDROID_DI', 'GARMIN_CONNECT_MOBILE_IOS_DI'];
const API = 'https://connectapi.garmin.com';
const UPLOAD = `${API}/upload-service/upload`;
const NATIVE = { 'User-Agent': 'GCM-Android-5.23', 'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861', 'X-Garmin-Client-Platform': 'Android', 'X-App-Ver': '10861', 'X-Lang': 'en', 'X-GCExperience': 'GC5', 'Accept-Language': 'en-US,en;q=0.9' };
const MFA_TTL_S = 300;
const BLOCKED_MSG = 'Garmin refused the sign-in from our server. Try again later, use the Just Watts app on your computer, or upload the .fit file manually';

// minimal cookie jar: name=value pairs from Set-Cookie
function setCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  return list.map(c => String(c).split(';')[0].trim()).filter(c => c.includes('='));
}
function mergeJar(jar, add) {
  const m = new Map(jar.map(c => [c.split('=')[0], c]));
  for (const c of add) m.set(c.split('=')[0], c);
  return [...m.values()];
}
function jwtExp(tok) {
  try { return Number(JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8')).exp) || null; } catch { return null; }
}

const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const PAGE = 50;

function garmin({ fetch, now = () => Date.now() / 1000, sleep = realSleep }) {
  const q = new URLSearchParams({ clientId: CLIENT, locale: 'en-US', service: SERVICE }).toString();
  const signIn = `${SSO}/mobile/sso/en_US/sign-in?clientId=${CLIENT}&service=${encodeURIComponent(SERVICE)}`;
  const jsonHeaders = jar => ({ 'User-Agent': IOS_UA, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9', Origin: SSO, Referer: signIn, ...(jar.length ? { Cookie: jar.join('; ') } : {}) });

  function ssoFail(r) {
    const t = (r.json && r.json.responseStatus && r.json.responseStatus.type) || '';
    const code = r.json && r.json.error && r.json.error['status-code'];
    if (r.status === 429 || r.status === 427 || code === '429' || t === 'CAPTCHA_REQUIRED' || r.status === 403) return new IntegrationError(BLOCKED, BLOCKED_MSG);
    if (t === 'INVALID_USERNAME_PASSWORD' || r.status === 401) return new IntegrationError(AUTH, 'Garmin did not accept that email and password');
    if (r.status >= 500) return new IntegrationError(TEMPORARY, `Garmin sign-in is down (${r.status})`);
    return new IntegrationError(AUTH, `Garmin sign-in failed (${t || r.status})`);
  }

  async function exchange(ticket) {
    let last = null;
    for (const cid of DI_CLIENTS) {
      const body = new URLSearchParams({ client_id: cid, service_ticket: ticket, grant_type: DI_GRANT, service_url: SERVICE }).toString();
      const r = await call(fetch, DI_TOKEN, { method: 'POST', body, headers: { ...NATIVE, Authorization: 'Basic ' + Buffer.from(cid + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      if (r.status === 200 && r.json && r.json.access_token) return tokens(r.json, cid);
      last = r;
      if (r.status === 429 || r.status >= 500) break;
    }
    throw last && (last.status === 429 || last.status >= 500) ? new IntegrationError(TEMPORARY, `Garmin token service busy (${last.status})`, retryAfter(last.headers))
      : new IntegrationError(AUTH, 'Garmin did not issue a token; sign in again');
  }
  function tokens(j, cid, old = {}) {
    return { di_token: j.access_token, di_refresh_token: j.refresh_token || old.di_refresh_token, di_client_id: cid,
      expires_at: jwtExp(j.access_token) || now() + Number(j.expires_in || 3600) };
  }
  async function refresh(us, s) {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: s.di_client_id, refresh_token: s.di_refresh_token }).toString();
    const r = await call(fetch, DI_TOKEN, { method: 'POST', body, headers: { ...NATIVE, Authorization: 'Basic ' + Buffer.from(s.di_client_id + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (r.status === 200 && r.json && r.json.access_token) { const t = tokens(r.json, s.di_client_id, s); await us.setSecret('garmin', t); return t; }
    if (r.status === 429 || r.status >= 500) throw new IntegrationError(TEMPORARY, `Garmin token service busy (${r.status})`, retryAfter(r.headers));
    throw new IntegrationError(AUTH, 'Garmin sign-in expired; connect Garmin again');
  }
  async function token(us, force) {
    const s = await us.secret('garmin');
    if (!s || !s.di_refresh_token) throw new IntegrationError(AUTH, 'Garmin not connected');
    if (force || !s.di_token || (s.expires_at || 0) - 900 < now()) return refresh(us, s);
    return s;
  }
  async function finish(us, ticket) {
    await us.setSecret('garmin', await exchange(ticket));
    await us.setSecret('garmin_mfa', null);
    return { connected: true };
  }

  // GET on connectapi with the DI token; one forced refresh on 401. Returns { status, json, buf }.
  async function get(us, path, { raw = false } = {}) {
    let r;
    for (const attempt of [0, 1]) {
      const s = await token(us, attempt === 1);
      try {
        const res = await fetch(API + path, { redirect: 'manual', headers: { ...NATIVE, Accept: raw ? '*/*' : 'application/json', Authorization: `Bearer ${s.di_token}` },
          ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(9000) } : {}) });
        const buf = Buffer.from(await res.arrayBuffer());
        let json = null; if (!raw) { try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { json = null; } }
        r = { status: res.status, headers: res.headers, json, buf };
      } catch (e) { throw new IntegrationError(TEMPORARY, 'network: ' + String((e && e.name) || e).slice(0, 60)); }
      if (r.status !== 401) break;
    }
    if (r.status === 401) throw new IntegrationError(AUTH, 'Garmin sign-in expired; connect Garmin again');
    if (r.status >= 300) throw new IntegrationError(kindForStatus(r.status), `Garmin said ${r.status}`, retryAfter(r.headers));
    return r;
  }
  const piece = p => p.then(r => ({ ok: true, json: r.json }), e => ({ ok: false, error: e.message, kind: e.kind }));

  return {
    id: 'garmin', name: 'Garmin Connect', official: false, imports: true,
    fields: [{ name: 'email', label: 'Garmin email', secret: false },
      { name: 'password', label: 'Garmin password', secret: true, help: 'Sent to Garmin once, never stored' },
      { name: 'mfa_code', label: 'Code from Garmin', secret: false, step: 'mfa' }],
    secrets: s => (s ? [s.di_token, s.di_refresh_token, s.jar && s.jar.join('; ')].filter(Boolean) : []),
    async status(us) { const s = await us.secret('garmin'); return { connected: !!(s && s.di_refresh_token), account: null }; },
    async connect(us, f) {
      const code = String(f.mfa_code || '').trim();
      if (code) {
        const p = await us.secret('garmin_mfa');
        if (!p || now() - p.at >= MFA_TTL_S) { await us.setSecret('garmin_mfa', null); throw new IntegrationError(AUTH, 'the sign-in timed out; enter your email and password again'); }
        let r;
        for (const path of ['/mobile/api/mfa/verifyCode', '/portal/api/mfa/verifyCode']) {
          r = await call(fetch, `${SSO}${path}?${q}`, { method: 'POST', headers: jsonHeaders(p.jar),
            body: JSON.stringify({ mfaMethod: p.method, mfaVerificationCode: code, rememberMyBrowser: true, reconsentList: [], mfaSetup: false }) });
          if (r.status !== 404) break;
        }
        const ticket = r.json && r.json.serviceTicketId;
        if (!ticket) { const e = ssoFail(r); throw e.kind === BLOCKED ? e : new IntegrationError(AUTH, 'Garmin did not accept that code'); }
        return finish(us, ticket);
      }
      const email = String(f.email || '').trim(), password = String(f.password || '');
      if (!email || !password) throw new IntegrationError(AUTH, 'enter your Garmin email and password');
      const page = await call(fetch, signIn, { method: 'GET', headers: { 'User-Agent': IOS_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
      if (page.status === 429 || page.status === 403) throw new IntegrationError(BLOCKED, BLOCKED_MSG);
      let jar = setCookies(page.headers);
      await sleep(2000);  // the app waits 2-5 s between the page and the login
      const r = await call(fetch, `${SSO}/mobile/api/login?${q}`, { method: 'POST', headers: jsonHeaders(jar),
        body: JSON.stringify({ username: email, password, rememberMe: true, captchaToken: '' }) });
      jar = mergeJar(jar, setCookies(r.headers));
      const type = r.json && r.json.responseStatus && r.json.responseStatus.type;
      if (type === 'SUCCESSFUL' && r.json.serviceTicketId) return finish(us, r.json.serviceTicketId);
      if (type === 'MFA_REQUIRED') {
        const method = (r.json.customerMfaInfo && r.json.customerMfaInfo.mfaLastMethodUsed) || 'email';
        await us.setSecret('garmin_mfa', { jar, method, at: now() });
        return { mfa_required: true, mfa_method: method };
      }
      throw ssoFail(r);
    },
    async disconnect(us) { await us.setSecret('garmin', null); await us.setSecret('garmin_mfa', null); },
    // profile: each call on its own; one failing never fails the rest. The token is read (and refreshed) once first.
    async importProfile(us) {
      await token(us);
      const today = ymd(now() * 1000), yearAgo = ymd((now() - 365 * 86400) * 1000);
      const social = piece(get(us, '/userprofile-service/socialProfile'));
      const pieces = {
        settings: piece(get(us, '/userprofile-service/userprofile/user-settings')),
        weight: piece(get(us, `/weight-service/weight/dateRange?startDate=${yearAgo}&endDate=${today}`)),
        ftp: piece(get(us, '/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING')),
        zones: piece(get(us, '/biometric-service/heartRateZones')),
        lactate: piece(get(us, '/biometric-service/biometric/latestLactateThreshold')),
        rhr: social.then(s => {
          const name = s.ok && s.json && s.json.displayName;
          if (!name) return { ok: false, error: s.ok ? 'no displayName' : s.error };
          return piece(get(us, `/wellness-service/wellness/dailyHeartRate/${encodeURIComponent(name)}?date=${today}`));
        }),
      };
      const done = {};
      for (const [k, p] of Object.entries(pieces)) done[k] = await p;
      if (Object.values(done).every(p => !p.ok) && Object.values(done).some(p => p.kind === AUTH)) throw new IntegrationError(AUTH, 'Garmin sign-in expired; connect Garmin again');
      return I.garminProfile(done);
    },
    // one page of cycling activities between two days (inclusive), newest first
    async importList(us, { since, until, start = 0 }) {
      const q = new URLSearchParams({ startDate: since, endDate: until, start: String(start), limit: String(PAGE), activityType: 'cycling' });
      const r = await get(us, `/activitylist-service/activities/search/activities?${q}`);
      const raw = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.activityList) ? r.json.activityList : []);
      const items = raw.map(I.garminActivity).filter(Boolean);
      return { items, skipped: raw.length - items.length, more: raw.length >= PAGE, next: start + raw.length };
    },
    async importFit(us, id) {
      if (!/^\d{1,20}$/.test(String(id))) throw new IntegrationError(BLOCKED, 'bad activity id');
      const r = await get(us, `/download-service/files/activity/${id}`, { raw: true });
      try { return I.fitFromZip(r.buf); } catch (e) { throw new IntegrationError(BLOCKED, `Garmin file: ${e.message}`); }
    },
    async upload(us, fit, meta) {
      let r;
      for (const attempt of [0, 1]) {
        const s = await token(us, attempt === 1);
        const mp = multipart({}, 'file', meta.filename || 'ride.fit', fit);
        r = await call(fetch, UPLOAD, { method: 'POST', body: mp.body, headers: { ...NATIVE, Accept: 'application/json', Authorization: `Bearer ${s.di_token}`, 'Content-Type': mp.type } });
        if (r.status !== 401) break;
      }
      const det = r.json && r.json.detailedImportResult;
      const fails = (det && det.failures) || [];
      if (r.status === 409 || fails.some(f => (f.messages || []).some(m => m.code === 202))) return { duplicate: true, activity_id: null, url: null };
      if (r.status === 401) throw new IntegrationError(AUTH, 'Garmin sign-in expired; connect Garmin again');
      if (r.status >= 300) throw new IntegrationError(kindForStatus(r.status), `Garmin refused the upload (${r.status})`, retryAfter(r.headers));
      if (fails.length) throw new IntegrationError(BLOCKED, 'Garmin could not import the file: ' + JSON.stringify(fails[0]).slice(0, 200));
      const id = det && det.successes && det.successes[0] && det.successes[0].internalId;
      return { activity_id: id || null, url: id ? `https://connect.garmin.com/modern/activity/${id}` : null };
    },
  };
}

module.exports = { garmin, setCookies, jwtExp, DUPLICATE };
