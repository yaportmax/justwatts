// Who is calling. Stub until the accounts branch lands: wiring is replacing userId() with its session lookup
// (one line in web/api/integrations.js, see docs/INTEGRATIONS.md "Wiring to accounts").
// Without accounts nobody is signed in, so the integration endpoints answer 401 in production. For local
// testing only, JUSTWATTS_INTEGRATIONS_DEV_USER names a fixed user.
'use strict';

async function userId(req) {  // eslint-disable-line no-unused-vars
  const dev = process.env.JUSTWATTS_INTEGRATIONS_DEV_USER;
  return dev && process.env.VERCEL_ENV !== 'production' ? String(dev) : null;
}

module.exports = { userId };
