// Secrets at rest: AES-256-GCM with the server key JUSTWATTS_INTEGRATIONS_KEY (32 bytes, base64 or hex).
// Format "v1.<iv>.<tag>.<ciphertext>" (base64url). The user id and service are bound in as AAD, so a
// ciphertext copied to another user or service does not decrypt.
'use strict';
const crypto = require('node:crypto');

function loadKey(raw = process.env.JUSTWATTS_INTEGRATIONS_KEY) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (key.length !== 32) throw new Error('JUSTWATTS_INTEGRATIONS_KEY must be 32 bytes (base64 or hex)');
  return key;
}

function seal(key, obj, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function open(key, sealed, aad) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1' || !ct) throw new Error('bad secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}

module.exports = { loadKey, seal, open };
