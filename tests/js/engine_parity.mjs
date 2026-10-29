// Runs a scripted ride against the web build's engine (app/js/web/engine.js) and prints what it shows
// after every action. tests/test_manual_controls_parity.py runs the same script on the Python engine
// and compares. stdin: {workout: {name, text, test} | null, settings, script: [[op, ...args]]}
import { Engine } from '../../app/js/web/engine.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { workout, settings: s0, script } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const settings = { ftp: 200, afterWorkout: 'hold', ...s0 };
let t = 1000, wall = 1.7e12;
const hub = { mode: 'sim', r: { power: 0, cadence: 0, hr: 0, speed: 0, last: 0, hrLast: 0 }, wantCmd: null,
  want(c) { this.wantCmd = c; }, status() { return {}; } };
const lines = [];
const eng = new Engine({ hub, logEvent: l => { lines.push(l); eng.note(l); }, settings: () => settings, save: () => {}, archive: () => {},
  clock: () => t, wall: () => wall });
eng.control('load', { workout });
eng.control('start', {});

export function view(e) {
  const r = e.state({}).ride;
  if (!r) return null;
  return { el: Math.round(r.el), intensity: r.intensity, target_w: r.target_w, control: r.control, overtime: r.overtime, total_s: r.total_s,
    paused: r.paused, jr: r.jr, ov: r.ov, step: r.step && [r.step.index, r.step.duration_s, r.step.into_s],
    steps: r.steps && r.steps.map(x => [x.duration_s, x.free, x.start_w]), want: hub.wantCmd };
}
const out = [];
for (const [op, ...a] of script) {
  let res = null;
  if (op === 'tick') for (let i = 0; i < a[0]; i++) { t += 1; wall += 1000; eng.tick(1); }
  else if (op === 'set') Object.assign(settings, a[0]);
  else { try { eng.control(op, a[0] || {}); res = 'ok'; } catch (err) { res = 'error'; } }
  out.push({ op, res, view: view(eng) });
}
out.push({ lines: lines.filter(l => /^(MANUAL|EDIT|PAUSED|RESUMED)/.test(l)) });
process.stdout.write(JSON.stringify(out));
