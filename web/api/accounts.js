// Accounts, sync, community and social API. vercel.json rewrites /api/{auth,sync,community,social,admin}/* here with the
// original path in ?__path= (Vercel has no catch-all routes outside Next.js); every route lives in _lib/app.js.
module.exports = require('./_lib/app').handler;
