// Runs web/api/strava/token.js with a fake Strava: body parsing, grant validation, response filtering.
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const handler = require(process.argv[2]);
process.env.STRAVA_CLIENT_ID = '1'; process.env.STRAVA_CLIENT_SECRET = 'relay-secret-value';
const sent = [];
globalThis.fetch = async (url, opt) => {
  sent.push({ url, body: String(opt.body) });
  return { ok: true, status: 200, json: async () => ({ token_type: 'Bearer', access_token: 'a'.repeat(40), refresh_token: 'r'.repeat(40), expires_at: 9, athlete: { id: 7, firstname: 'A', lastname: 'B', city: 'X', profile: 'p' } }) };
};
function call(method, body, raw) {
  const req = raw === undefined ? Object.assign(Readable.from([]), { method, body }) : Object.assign(Readable.from([Buffer.from(raw)]), { method });
  return new Promise(resolve => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ code: this.statusCode, body: JSON.parse(b) }); } };
    handler(req, res);
  });
}
const out = {};
const good = { grant_type: 'refresh_token', refresh_token: 'x'.repeat(40) };
out.get = (await call('GET', undefined)).code;
out.object = await call('POST', good);
out.string = await call('POST', JSON.stringify(good));
out.buffer = await call('POST', Buffer.from(JSON.stringify(good)));
out.stream = await call('POST', undefined, JSON.stringify(good));
out.badGrant = (await call('POST', { grant_type: 'password', refresh_token: 'x'.repeat(40) })).code;
out.badToken = (await call('POST', { grant_type: 'refresh_token', refresh_token: 'x&client_secret=y' })).code;
out.nullBody = (await call('POST', 'null')).code;
out.badJson = (await call('POST', '{nope')).code;
out.sent = sent;
console.log(JSON.stringify(out));
