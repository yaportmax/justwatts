// Storage interface for web integrations. The accounts branch supplies a real backend with these methods:
//   getSecret(userId, service) -> string|null        setSecret(userId, service, string|null)   (ciphertext only)
//   getState(userId, key) -> object|null             setState(userId, key, object|null)        (jobs, status: no secrets)
//   getFile(userId, name) -> Buffer|null             putFile(userId, name, Buffer|null)        (FIT files for retries + fallback)
// userStore() gives connectors one user's view: plain objects in, sealed ciphertext stored.
'use strict';
const { seal, open } = require('./crypto');

function memoryStore() {
  const m = new Map();
  const k = (u, ns, n) => `${u}\u0000${ns}\u0000${n}`;
  const get = (u, ns, n) => (m.has(k(u, ns, n)) ? m.get(k(u, ns, n)) : null);
  const put = (u, ns, n, v) => { if (v === null || v === undefined) m.delete(k(u, ns, n)); else m.set(k(u, ns, n), v); };
  return {
    _map: m,
    async getSecret(u, s) { return get(u, 'secret', s); },
    async setSecret(u, s, v) { put(u, 'secret', s, v); },
    async getState(u, key) { const v = get(u, 'state', key); return v ? JSON.parse(v) : null; },
    async setState(u, key, v) { put(u, 'state', key, v === null ? null : JSON.stringify(v)); },
    async getFile(u, n) { return get(u, 'file', n); },
    async putFile(u, n, b) { put(u, 'file', n, b ? Buffer.from(b) : null); },
  };
}

function userStore(raw, key, userId) {
  const aad = s => `justwatts:${userId}:${s}`;
  return {
    async secret(service) { const v = await raw.getSecret(userId, service); return v ? open(key, v, aad(service)) : null; },
    async setSecret(service, obj) { await raw.setSecret(userId, service, obj ? seal(key, obj, aad(service)) : null); },
    state: k => raw.getState(userId, k),
    setState: (k, v) => raw.setState(userId, k, v),
    file: n => raw.getFile(userId, n),
    putFile: (n, b) => raw.putFile(userId, n, b),
  };
}

module.exports = { memoryStore, userStore };
