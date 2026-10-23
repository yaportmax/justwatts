// Times drawChart on a 3-hour ride (10800 samples) with a counting stub context; prints JSON.
import { drawChart, decimate } from '../../app/js/chart.js';
import { compile } from '../../app/js/core.js';
let ops = 0;
const c = new Proxy({}, { get: (t, k) => k in t ? t[k] : () => { ops++; }, set: (t, k, v) => { t[k] = v; return true; } });
const css = () => '#38bdf8';
const cw = compile({ text: '10m 45-70%, 16x(5m 95%, 5m 55%), 10m 60-40%' });
const smp = Array.from({ length: 10800 }, (_, i) => [i * 1000, i + 1, 150 + (i % 50), 90, i % 900 === 0 ? 0 : 140, 30, 150]);
const W = 1200, H = 400, runs = 200;
const pts = drawChart(c, W, H, { cw, ftp: 250, samples: smp, el: 10800, k: 1 }, css);
ops = 0;
const t0 = performance.now();
for (let i = 0; i < runs; i++) drawChart(c, W, H, { cw, ftp: 250, samples: smp, el: 10800, k: 1 }, css);
const ms = (performance.now() - t0) / runs;
const small = decimate(smp.slice(0, 100), 500);
process.stdout.write(JSON.stringify({ points: pts, ms_per_draw: +ms.toFixed(3), ops_per_draw: Math.round(ops / runs), small_points: small.power.length,
  hr_gaps: decimate(smp, 2272).hr.filter(x => !x).length }));
