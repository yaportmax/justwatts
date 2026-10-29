// /api/integrations?op=...: connect services, upload rides, planned workouts (docs/INTEGRATIONS.md).
// Thin wrapper: the logic is in _lib/integrations. The caller is the accounts session; secrets, job state and
// FIT files live in the accounts database (table integration_data), secrets sealed with JUSTWATTS_INTEGRATIONS_KEY.
'use strict';
const app = require('./_lib/app');
const { makeHandler } = require('./_lib/integrations/http');
const { loadKey } = require('./_lib/integrations/crypto');
const { accountsStore, memoryStore } = require('./_lib/integrations/store');
const { userId } = require('./_lib/integrations/session');

let handler;
module.exports = (req, res) => {
  handler = handler || makeHandler({
    store: accountsStore(() => app.storeOrNull(), { fallback: memoryStore() }),  // fallback: the dev user without a database
    key: loadKey(), userId, fetch: (...a) => globalThis.fetch(...a),
    log: m => console.error(m),
  });
  return handler(req, res);
};
