// Passwords (scrypt, parameters stored with the hash), HMAC signing, random ids, token hashing.
'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, len: 32 };
const b64u = buf => Buffer.from(buf).toString('base64url');
const scryptAsync = (pw, salt, len, o) => new Promise((ok, no) => crypto.scrypt(pw, salt, len, o, (e, k) => e ? no(e) : ok(k)));

// "scrypt$N$r$p$salt$hash" (base64url)
async function hashPassword(pw, P = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw).normalize('NFKC'), salt, P.len, { N: P.N, r: P.r, p: P.p, maxmem: 256 * P.N * P.r });
  return `scrypt$${P.N}$${P.r}$${P.p}$${b64u(salt)}$${b64u(key)}`;
}
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
// -> { ok, rehash } ; a missing hash still costs one scrypt so timing does not tell accounts apart
async function verifyPassword(pw, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored || DUMMY) || /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(DUMMY);
  const [N, r, p] = [+m[1], +m[2], +m[3]];
  if (N > 1 << 20 || r > 32 || p > 4) return { ok: false };
  const want = Buffer.from(m[5], 'base64url');
  const key = await scryptAsync(String(pw).normalize('NFKC'), Buffer.from(m[4], 'base64url'), want.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  const ok = !!stored && key.length === want.length && crypto.timingSafeEqual(key, want);
  return { ok, rehash: ok && (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p) };
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
// value.signature ; verify -> value or null
function sign(secret, value) { return `${value}.${hmac(secret, value)}`; }
function unsign(secret, signed) {
  const s = String(signed || ''), i = s.lastIndexOf('.'); if (i < 1) return null;
  const v = s.slice(0, i), a = Buffer.from(s.slice(i + 1)), b = Buffer.from(hmac(secret, v));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? v : null;
}
const randomId = (n = 16) => b64u(crypto.randomBytes(n));
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function shortId(n = 10) { const b = crypto.randomBytes(n); let s = ''; for (const x of b) s += ALNUM[x % 62]; return s; }
const sha256 = s => crypto.createHash('sha256').update(s).digest('base64url');

module.exports = { SCRYPT, hashPassword, verifyPassword, sign, unsign, randomId, shortId, sha256 };
