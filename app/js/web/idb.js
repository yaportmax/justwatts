// Tiny IndexedDB wrapper: a key/value store ("kv") and a ride archive ("rides", keyed by id).
// the IndexedDB name is from before the rename: changing it would hide saved rides
export function openDB(name = 'openspin', idb = globalThis.indexedDB) {
  return new Promise((res, rej) => {
    if (!idb) return rej(new Error('no IndexedDB'));
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('kv'); db.createObjectStore('rides', { keyPath: 'id' }); };
    req.onsuccess = () => res(new Store(req.result));
    req.onerror = () => rej(req.error);
  });
}
const done = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class Store {
  constructor(db) { this.db = db; }
  tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); }
  get(k) { return done(this.tx('kv').get(k)); }
  set(k, v) { return done(this.tx('kv', 'readwrite').put(v, k)); }
  del(k) { return done(this.tx('kv', 'readwrite').delete(k)); }
  putRide(r) { return done(this.tx('rides', 'readwrite').put(r)); }
  getRide(id) { return done(this.tx('rides').get(id)); }
  delRide(id) { return done(this.tx('rides', 'readwrite').delete(id)); }
  allRides() { return done(this.tx('rides').getAll()); }
  rideIds() { return done(this.tx('rides').getAllKeys()); }
  async exportAll() {
    const kv = {};
    for (const k of ['settings', 'custom', 'meta', 'devices']) kv[k] = await this.get(k);
    return { app: 'justwatts', version: 1, exported: new Date().toISOString(), kv, rides: await this.allRides() };
  }
  async importAll(data) {
    if (!['justwatts', 'openspin'].includes(data?.app) || !Array.isArray(data.rides)) throw new Error('not a Just Watts backup');
    for (const [k, v] of Object.entries(data.kv || {})) if (v != null && k !== 'devices') await this.set(k, v);
    for (const r of data.rides) if (r?.id && r.samples?.length) await this.putRide(r);
    return data.rides.length;
  }
}

// Memory fallback (private windows without IndexedDB, and tests)
export class MemStore extends Store {
  constructor() { super(null); this.kv = new Map(); this.rides = new Map(); }
  async get(k) { return structuredClone(this.kv.get(k)); }
  async set(k, v) { this.kv.set(k, structuredClone(v)); }
  async del(k) { this.kv.delete(k); }
  async putRide(r) { this.rides.set(r.id, structuredClone(r)); }
  async getRide(id) { return structuredClone(this.rides.get(id)); }
  async delRide(id) { this.rides.delete(id); }
  async allRides() { return [...this.rides.values()].map(r => structuredClone(r)); }
  async rideIds() { return [...this.rides.keys()]; }
}
