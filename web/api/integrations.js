// /api/integrations?op=...: connect services, upload rides, planned workouts (docs/INTEGRATIONS.md).
// Thin wrapper: the logic is in _lib/integrations. Wiring to accounts = replace `userId` and `store` below.
'use strict';
const { makeHandler } = require('./_lib/integrations/http');
const { loadKey } = require('./_lib/integrations/crypto');
const { memoryStore } = require('./_lib/integrations/store');
const { userId } = require('./_lib/integrations/session');

let handler;
module.exports = (req, res) => {
  handler = handler || makeHandler({ store: memoryStore(), key: loadKey(), userId });
  return handler(req, res);
};
