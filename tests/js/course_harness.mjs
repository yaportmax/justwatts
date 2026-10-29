// Test bridge for app/js/course.js and a course ride on the web build's engine. stdin: JSON array of
// requests, stdout: JSON array of results. tests/test_course.py runs the same on the Python side.
import * as C from '../../app/js/course.js';
import { Engine } from '../../app/js/web/engine.js';
import { fitEncode, toTcx, summarize } from '../../app/js/core.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const reqs = JSON.parse(Buffer.concat(chunks).toString('utf8'));

// ride script on a hub with a fixed power (no random sim rider): ops [power, w] [tick, n] [set, {...}] [<control>, body]
function ride({ workout, course, settings: s0, script }) {
  const settings = { ftp: 200, afterWorkout: 'hold', weight: 75, ...s0 };
  let t = 1000, wall = 1.7e12;
  const hub = { mode: 'ble', r: { power: 0, cadence: 0, hr: 0, speed: 0, last: 0, hrLast: 0 }, wantCmd: null, sent: [],
    want(c) { this.wantCmd = c; if (JSON.stringify(this.sent.at(-1)) !== JSON.stringify(c)) this.sent.push(c); }, status() { return {}; } };
  const lines = [];
  const eng = new Engine({ hub, logEvent: l => { lines.push(l); eng.note(l); }, settings: () => settings, save: () => {}, archive: () => {}, clock: () => t, wall: () => wall });
  const out = [];
  for (const [op, a] of script) {
    let res = null;
    if (op === 'power') { hub.r.power = a; hub.r.cadence = a > 0 ? 90 : 0; hub.r.last = t; }
    else if (op === 'tick') for (let i = 0; i < a; i++) { t += 1; wall += 1000; hub.r.last = t; eng.tick(1); }
    else if (op === 'set') Object.assign(settings, a);
    else { try { eng.control(op, a || {}); res = 'ok'; } catch (e) { res = 'error: ' + e.message; } }
    const r = eng.state({}).ride;
    out.push({ op, res, course: r?.course ? { ...r.course, profile: r.course.profile.length } : null, control: r?.control ?? null, want: hub.wantCmd,
      last: r ? eng.ride.samples.at(-1) ?? null : null });
  }
  const p = eng.ride?.payload();
  return { out, sent: hub.sent, lines: lines.filter(l => /^(COURSE|WORKOUT)/.test(l)), samples: p ? p.samples.map(x => x.slice(1)) : null, payload: p };
}

function run(r) {
  switch (r.op) {
    case 'parse': return C.parseTrack(r.text);
    case 'parseFit': { try { return C.parseFit(Buffer.from(r.b64, 'base64')); } catch (e) { return { error: e.message }; } }
    case 'build': { try { const t = C.parseTrack(r.text); return C.buildCourse(t.name, t.pts); } catch (e) { return { error: e.message }; } }
    case 'buildPts': { try { return C.buildCourse(r.name, r.pts); } catch (e) { return { error: e.message }; } }
    case 'lookup': return r.at.map(d => [C.gradeAt(r.course, d), C.eleAt(r.course, d)]);
    case 'speed': { let v = r.v0 || 0; return r.seq.map(([w, g, dt]) => (v = C.speedStep(v, w, g, r.mass, dt))); }
    case 'profile': return C.profileOf(r.course, r.n);
    case 'samples': return C.SAMPLE_COURSES;
    case 'check': { try { return C.checkCourse(r.course); } catch (e) { return { error: e.message }; } }
    case 'ride': return ride(r);
    case 'export': return { fit: Buffer.from(fitEncode(r.ride)).toString('base64'), tcx: toTcx(r.ride), dist: summarize(r.ride).dist };
    default: throw new Error('unknown op ' + r.op);
  }
}
process.stdout.write(JSON.stringify(reqs.map(run)));
