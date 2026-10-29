// The API's copies of the workout parser and course check (web/api/_lib/appcopy.js) must be the app's code, verbatim.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const repo = process.argv[2];
const require = createRequire(import.meta.url);
const copy = require(`${repo}/web/api/_lib/appcopy.js`);
const core = await import(pathToFileURL(`${repo}/app/js/core.js`).href);
const course = await import(pathToFileURL(`${repo}/app/js/course.js`).href);
const out = { same: {}, consts: {} };
for (const [mod, names] of [[core, ['parseDur', 'parseTree', 'flattenTree']], [course, ['gainOf', 'checkCourse']]])
  for (const n of names) out.same[n] = typeof copy[n] === 'function' && copy[n].toString() === mod[n].toString();
for (const n of ['STEP_M', 'MIN_M', 'MAX_M']) out.consts[n] = copy[n] === course[n];
// and they behave the same on a sample of inputs
const texts = ['10m 50-75%, 2x(20m 90%, 5m 55%), 10m 50%', '1m30s 200w, 3x(30s free, 1h 60%)', '2x(5m 100%', 'nope', '5m 50%)', ''];
out.parse = texts.every(t => { const f = fn => { try { return JSON.stringify(fn(t)); } catch (e) { return 'E:' + e.message; } }; return f(copy.parseTree) === f(core.parseTree); });
console.log(JSON.stringify(out));
