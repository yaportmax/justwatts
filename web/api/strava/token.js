// Just Watts's shared Strava app: exchanges an OAuth code or refresh token for access tokens.
// The client secret lives only in this function's environment (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET),
// never in the open-source app. Stateless: nothing is stored or logged. Only token fields go back.
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const TOKEN_RE = /^[A-Za-z0-9]{8,128}$/;
const MAX_BODY = 4096;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  // Vercel may hand over the body already read: parsed (JSON), or as a string/Buffer (other types)
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8');
    if (text.length > MAX_BODY) return Promise.reject(new Error('too large'));
    try { return Promise.resolve(JSON.parse(text || '{}')); } catch (e) { return Promise.reject(e); }
  }
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function pick(body) {
  const a = body.athlete || {};
  return {
    access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at,
    athlete: body.athlete ? { id: a.id, firstname: a.firstname, lastname: a.lastname } : undefined,
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { message: 'POST only' });
  const id = process.env.STRAVA_CLIENT_ID, secret = process.env.STRAVA_CLIENT_SECRET;
  if (!id || !secret) return send(res, 503, { message: 'Strava is not set up on this server' });
  let b;
  try { b = await readJson(req); } catch { return send(res, 400, { message: 'bad request' }); }
  if (!b || typeof b !== 'object') return send(res, 400, { message: 'bad grant' });
  const form = new URLSearchParams({ client_id: id, client_secret: secret });
  if (b.grant_type === 'authorization_code' && TOKEN_RE.test(String(b.code || ''))) {
    form.set('grant_type', 'authorization_code'); form.set('code', b.code);
  } else if (b.grant_type === 'refresh_token' && TOKEN_RE.test(String(b.refresh_token || ''))) {
    form.set('grant_type', 'refresh_token'); form.set('refresh_token', b.refresh_token);
  } else {
    return send(res, 400, { message: 'bad grant' });
  }
  let r, body;
  try {
    r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15000) });
    body = await r.json();
  } catch {
    return send(res, 502, { message: 'Strava did not answer' });
  }
  if (!r.ok || !body || !body.access_token) return send(res, r.ok ? 502 : r.status, { message: String((body && body.message) || 'Strava refused the token request').slice(0, 200) });
  return send(res, 200, pick(body));
}

module.exports = handler;
module.exports.pick = pick;
module.exports.TOKEN_RE = TOKEN_RE;
