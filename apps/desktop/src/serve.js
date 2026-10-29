// Static files for app://justwatts: the bundled web build (web/) and the app's own page modules (native/), with the
// website's security headers from vercel.json and its SPA fallback.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.gpx': 'application/gpx+xml', '.fit': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.pbf': 'application/x-protobuf',
};

function siteHeaders(webDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(webDir, 'vercel.json'), 'utf8'));
    const out = {};
    for (const h of v.headers?.find(x => x.source === '/(.*)')?.headers || []) if (h.key !== 'Strict-Transport-Security') out[h.key] = h.value;
    return out;
  } catch { return {}; }
}

function createServer({ webDir, nativeDir }) {
  const headers = siteHeaders(webDir);
  const file = (root, rel) => {
    const p = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (p !== root && !p.startsWith(root + path.sep)) return null;
    try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
  };
  const send = p => new Response(fs.readFileSync(p), { status: 200, headers: { ...headers, 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  return function serve(pathname) {
    let rel; try { rel = decodeURIComponent(pathname); } catch { return new Response('bad path', { status: 400 }); }
    if (rel.startsWith('/__native/')) { const p = file(nativeDir, rel.slice('/__native'.length)); return p ? send(p) : new Response('not found', { status: 404 }); }
    if (rel === '/privacy') rel = '/privacy.html';
    const p = file(webDir, rel === '/' ? '/index.html' : rel);
    if (p) return send(p);
    if (!path.posix.extname(rel)) return send(path.join(webDir, 'index.html'));  // views and /download: the app
    return new Response('not found', { status: 404 });
  };
}

module.exports = { createServer };
