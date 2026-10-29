// The page calls /api/auth, /api/sync, /api/community... on its own origin (app://justwatts), exactly like on the
// website. The main process forwards those requests to justwatts.com with the site's Origin and keeps the session
// cookie in its own jar (encrypted on disk with the OS keychain or DPAPI when available). So there is no CORS, no
// third-party cookie, and the API needs no app-specific mode beyond the OAuth handoff.
'use strict';
const fs = require('node:fs');

const SKIP_REQ = new Set(['host', 'cookie', 'origin', 'referer', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']);
const SKIP_RES = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'strict-transport-security']);

class CookieJar {
  // file: where to keep it; crypt: { encrypt(str) -> Buffer, decrypt(Buffer) -> str } or null (plain JSON)
  constructor({ file = null, crypt = null, now = () => Date.now() } = {}) {
    this.file = file; this.crypt = crypt; this.now = now; this.c = new Map();
    this.load();
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = fs.readFileSync(this.file);
      const list = JSON.parse(this.crypt ? this.crypt.decrypt(raw) : raw.toString('utf8'));
      for (const [k, v, exp] of list) this.c.set(k, { v, exp });
    } catch { this.c.clear(); }
  }
  save() {
    if (!this.file) return;
    const list = JSON.stringify([...this.c].filter(([, x]) => x.exp > this.now()).map(([k, x]) => [k, x.v, x.exp]));
    try { fs.writeFileSync(this.file, this.crypt ? this.crypt.encrypt(list) : list, { mode: 0o600 }); } catch {}
  }
  header() {
    const t = this.now(), out = [];
    for (const [k, x] of this.c) if (x.exp > t) out.push(`${k}=${x.v}`);
    return out.join('; ');
  }
  absorb(setCookies) {
    if (!setCookies?.length) return;
    for (const line of setCookies) {
      const [kv, ...attrs] = line.split(';'), i = kv.indexOf('=');
      if (i < 1) continue;
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      let exp = this.now() + 400 * 86400000;  // session cookies: keep (the app is the browser here)
      for (const a of attrs) {
        const [ak, av = ''] = a.split('='), n = ak.trim().toLowerCase();
        if (n === 'max-age') exp = this.now() + (+av) * 1000;
        else if (n === 'expires' && !attrs.some(x => /max-age/i.test(x))) { const d = Date.parse(av); if (!isNaN(d)) exp = d; }
      }
      if (!v || exp <= this.now()) this.c.delete(k); else this.c.set(k, { v, exp });
    }
    this.save();
  }
  clear() { this.c.clear(); this.save(); }
}

function createProxy({ api, jar, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const base = api.replace(/\/+$/, '');
  async function forward(method, pathAndQuery, headers, body) {
    const h = new Headers();
    for (const [k, v] of Object.entries(headers || {})) if (!SKIP_REQ.has(k.toLowerCase()) && !k.toLowerCase().startsWith('sec-')) h.set(k, v);
    h.set('origin', base);
    const c = jar.header(); if (c) h.set('cookie', c);
    const r = await fetchImpl(base + pathAndQuery, { method, headers: h, body: body && body.length ? body : undefined, redirect: 'manual' });
    jar.absorb(typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []);
    return r;
  }
  return {
    // a Request from protocol.handle -> a Response for the page
    async handle(req) {
      const u = new URL(req.url);
      const body = ['GET', 'HEAD'].includes(req.method) ? null : Buffer.from(await req.arrayBuffer());
      let r;
      try { r = await forward(req.method, u.pathname + u.search, Object.fromEntries(req.headers), body); }
      catch { return new Response(JSON.stringify({ error: 'offline' }), { status: 502, headers: { 'Content-Type': 'application/json' } }); }
      const out = new Headers();
      for (const [k, v] of r.headers) if (!SKIP_RES.has(k)) out.set(k, v);
      const empty = [101, 204, 205, 304].includes(r.status) || req.method === 'HEAD';
      return new Response(empty ? null : Buffer.from(await r.arrayBuffer()), { status: r.status, statusText: r.statusText, headers: out });
    },
    // JSON calls from the main process itself (the OAuth handoff)
    async json(method, path, obj) {
      try {
        const r = await forward(method, path, { 'content-type': 'application/json', 'x-hw': '1' }, obj ? Buffer.from(JSON.stringify(obj)) : null);
        let body = {}; try { body = await r.json(); } catch {}
        return { ok: r.ok, status: r.status, body };
      } catch { return { ok: false, status: 0, body: { error: 'offline' } }; }
    },
  };
}

module.exports = { CookieJar, createProxy };
