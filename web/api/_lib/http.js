// HTTP helpers for the account functions: JSON replies, bounded body reads, cookies, origin checks.
'use strict';

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, extra) => { throw new HttpError(status, code, extra); };

function send(res, code, obj, headers = {}) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  if (!headers['Cache-Control']) res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// Raw body, capped: Vercel's req.body when present (Buffer for gzip, object for JSON), else the stream.
function readRaw(req, max) {
  let body; try { body = req.body; } catch { return Promise.reject(new HttpError(400, 'bad_json')); }  // Vercel's lazy parser
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const b = Buffer.from(body);
    return b.length > max ? Promise.reject(new HttpError(413, 'too_large')) : Promise.resolve(b);
  }
  if (body && typeof body === 'object') return Promise.resolve(Buffer.from(JSON.stringify(body)));
  const len = +(req.headers['content-length'] || 0);
  if (len > max) return Promise.reject(new HttpError(413, 'too_large'));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new HttpError(413, 'too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpError(400, 'bad_body')));
  });
}
async function readJson(req, max = 16 * 1024) {
  const raw = await readRaw(req, max);
  if (!raw.length) return {};
  let v; try { v = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'bad_json'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'bad_json');
  return v;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}
// __Host- cookies: Secure, Path=/, no Domain. maxAge 0 clears.
function cookie(name, value, maxAge, sameSite = 'Lax') {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

function clientIp(req) {
  const h = req.headers;
  return String(h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '?').trim().slice(0, 64);
}

// The public origin: PUBLIC_ORIGIN, or on a Vercel preview the request's own *.vercel.app host.
function previewOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  return process.env.VERCEL_ENV === 'preview' && /^[a-z0-9-]+\.vercel\.app$/.test(host) ? 'https://' + host : null;
}
function publicOrigin(req) {
  return previewOrigin(req) || (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '') || null;
}
// Non-GET: Origin must be the public origin (or the preview's own host), X-HW: 1, and a JSON (or gzip) body type.
function checkWrite(req, types = ['application/json']) {
  const origin = String(req.headers.origin || '');
  const allowed = [(process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''), previewOrigin(req)].filter(Boolean);
  if (!origin || !allowed.includes(origin)) fail(403, 'bad_origin');
  if (req.headers['x-hw'] !== '1') fail(403, 'bad_origin');
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!types.includes(ct)) fail(415, 'bad_content_type');
}

module.exports = { HttpError, fail, send, redirect, readRaw, readJson, parseCookies, cookie, clientIp, publicOrigin, checkWrite };
