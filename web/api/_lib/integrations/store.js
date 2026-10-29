// Storage interface for web integrations. The accounts branch supplies a real backend with these methods:
//   getSecret(userId, service) -> string|null        setSecret(userId, service, string|null)   (ciphertext only)
//   getState(userId, key) -> object|null             setState(userId, key, object|null)        (jobs, status: no secrets)
//   getFile(userId, name) -> Buffer|null             putFile(userId, name, Buffer|null)        (FIT files for retries + fallback)
//   retryUsers(limit) -> [userId]                    users with uploads waiting (state "retry"), for the cron
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
    async retryUsers(limit) { return [...m.keys()].map(x => x.split('\u0000')).filter(([, ns, n]) => ns === 'state' && n === 'retry').map(([u]) => u).slice(0, limit); },
  };
}

// The accounts database (store-memory.js / store-pg.js, table integration_data) behind the interface above.
// getStore() is read on every call, so a missing DATABASE_URL never crashes at load; `fallback` (a memoryStore)
// serves only the dev user when there is no database. FIT files and ride metadata older than 30 days are pruned
// now and then on a write.
const FILE_DAYS = 30, DAY = 86400000;
function accountsStore(getStore, { fallback = null, now = () => Date.now(), prune = () => Math.random() < 0.02 } = {}) {
  const db = () => { const s = getStore(); if (!s) throw new Error('no database'); return s; };
  const get = (u, ns, n) => db().getIntegrationData(u, ns, n);
  const put = async (u, ns, n, buf) => {
    const s = db();
    await s.putIntegrationData(u, ns, n, buf, now());
    if (buf && ns === 'file' && prune()) await s.pruneIntegrationData(now() - FILE_DAYS * DAY);
  };
  const real = {
    async getSecret(u, svc) { const b = await get(u, 'secret', svc); return b ? b.toString('utf8') : null; },
    async setSecret(u, svc, v) { await put(u, 'secret', svc, v === null || v === undefined ? null : Buffer.from(String(v), 'utf8')); },
    async getState(u, k) { const b = await get(u, 'state', k); return b ? JSON.parse(b.toString('utf8')) : null; },
    async setState(u, k, v) { await put(u, 'state', k, v === null || v === undefined ? null : Buffer.from(JSON.stringify(v), 'utf8')); },
    async getFile(u, n) { return get(u, 'file', n); },
    async putFile(u, n, b) { await put(u, 'file', n, b ? Buffer.from(b) : null); },
    async retryUsers(limit) { return db().integrationUsers('state', 'retry', limit); },
  };
  if (!fallback) return real;
  const pick = () => (getStore() ? real : fallback);
  return Object.fromEntries(Object.keys(real).map(m => [m, (...a) => pick()[m](...a)]));
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

module.exports = { memoryStore, userStore, accountsStore, FILE_DAYS };
