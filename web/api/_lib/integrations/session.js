// Who is calling: the accounts session cookie (web/api/_lib/app.js sessionUser), or null when signed out.
// For local testing only, JUSTWATTS_INTEGRATIONS_DEV_USER names a fixed user outside production when nobody
// is signed in.
'use strict';
const app = require('../app');

async function userId(req) {
  const store = app.storeOrNull();
  if (store && app.secret()) {
    const u = await app.sessionUser({ req, store, now: app.clock.now() });
    if (u) return u.id;
  }
  const dev = process.env.JUSTWATTS_INTEGRATIONS_DEV_USER;
  return dev && process.env.VERCEL_ENV !== 'production' ? String(dev) : null;
}

module.exports = { userId };
