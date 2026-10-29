// Test bridge: reads a JSON array of requests on stdin, runs them against app/js/core.js,
// writes a JSON array of results to stdout. Used by tests/test_js_core.py.
import * as core from '../../app/js/core.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const reqs = JSON.parse(Buffer.concat(chunks).toString('utf8'));

function run(r) {
  switch (r.op) {
    case 'parse':
      try {
        const steps = core.parseWorkout(r.text);
        return { ok: true, steps, text: core.toText(steps), total: steps.reduce((a, s) => a + s.d, 0) };
      } catch (e) { return { ok: false, error: e.message }; }
    case 'presets':
      return [...core.PRESETS, ...core.FTP_TESTS];
    case 'fit':
      return { b64: Buffer.from(core.fitEncode(r.ride)).toString('base64'), summary: core.summarize(r.ride) };
    case 'tcx':
      return core.toTcx(r.ride);
    case 'zwo':
      return core.toZwo(core.compile(r.workout), r.ftp);
    case 'watts': {
      const cw = core.compile({ text: r.text });
      return r.at.map(el => { const at = core.stepAt(cw, el); return at ? core.stepWatts(at.s, at.into, r.ftp, r.k ?? 1) : null; });
    }
    case 'lines':
      return {
        rideStart: core.lineRideStart(r.name, r.ftp, r.cw ? core.compile({ text: r.cw }) : null),
        rideEnd: core.lineRideEnd(r.el),
        resumed: core.lineResumed(r.el, r.n),
        stepStart: core.lineStepStart(r.i, r.count, r.d, r.tgt),
        stepEnd: core.lineStepEnd(r.acc),
        tick: core.lineTick(r.el, r.i, r.count, r.into, r.d, r.tgt, r.l30, r.stepP),
        feel: core.lineFeel(r.feel, r.stepNo, r.l30, r.hr),
      };
    case 'fmtT':
      return r.values.map(core.fmtT);
    case 'crc':
      return core.fitCrc(r.bytes);
    default:
      throw new Error('unknown op ' + r.op);
  }
}
process.stdout.write(JSON.stringify(reqs.map(run)));
