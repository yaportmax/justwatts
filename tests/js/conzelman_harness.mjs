// Conzelman Road's hand-authored spec (app/js/world3d/conzelman.js): its sections in order, every painted line on the
// paving, the rider's lines on it, the rails on the line, a ribbon built from it with the paved edges it gives and its paint
import { SECTIONS, RAILS, LOTS, CROSSWALKS, LINE, compileSpec, specPaint } from '../../app/js/world3d/conzelman.js';
import { builder, ribbon } from '../../app/js/world3d/ribbon.js';
import { makeProj } from '../../app/js/world3d/geo.js';
const proj = makeProj(37.83, -122.5), C = compileSpec(proj), out = { sections: SECTIONS.length, bad: [] };
let last = -1;
for (const q of SECTIONS) {
  if (q.s <= last) out.bad.push(['order', q.s]); last = q.s; if (q.gap) continue;
  if (!q.src?.length) out.bad.push(['source', q.s]);
  if (!(q.L < q.R)) out.bad.push(['edges', q.s]);
  for (const [o] of q.lines) if (o <= q.L || o >= q.R) out.bad.push(['line off the paving', q.s, o]);
  if (q.lines.some((l, i) => i && l[0] <= q.lines[i - 1][0])) out.bad.push(['lines out of order', q.s]);
  for (const r of [q.ride, q.rideUp]) if (!(r > q.L && r < q.R)) out.bad.push(['rider off the paving', q.s, r]);
}
const len = (() => { let s = 0; for (let i = 1; i < LINE.length; i++) { const a = proj.xz(...LINE[i - 1]), b = proj.xz(...LINE[i]); s += Math.hypot(b[0] - a[0], b[1] - a[1]); } return s; })();
out.length = Math.round(len); out.rails = RAILS.length; out.railsOn = RAILS.every(([s0, s1]) => s0 >= 0 && (s1 <= len || s0 >= 10000) && s1 > s0) && C.rails.length === RAILS.length;
out.lots = LOTS.length; out.walks = CROSSWALKS.length;
// a ribbon along 1400 to 1520 m: every vertex given the spec's edges, its paint present, the same edges either way round
const pts = []; for (let s = 1400; s <= 1520; s += 5) pts.push(proj.xz(...C.latlon(s)));
const cen = ribbon(builder(), pts, { w: 9.1, lm: 4, lanes: 1, a: 2.8, b: 2.7, pR: 2.8, hAt: () => 10, xs: C.edges }), back = ribbon(builder(), pts.slice().reverse(), { w: 9.1, lm: 4, lanes: 1, hAt: () => 10, xs: C.edges });
const wid = q => Math.hypot(q[4] - q[7], q[6] - q[9]);
out.ribbon = { all: cen.every(q => q.sp), width: +wid(cen[10]).toFixed(2), mirrored: +Math.abs(wid(cen[10]) - wid(back[back.length - 11])).toFixed(3), tris: specPaint(cen).pos.length / 9 };
// outside the spec's stretch (Alexander Avenue's mouth, 1817 m): nothing
out.outside = C.edges(...proj.xz(...C.latlon(1817)), 1, 0) === null;
const [x, z] = proj.xz(...C.latlon(1450)), [x2, z2] = proj.xz(...C.latlon(1451));
out.lanes = { down: +C.lane(x, z, x2 - x, z2 - z).toFixed(2), up: +C.lane(x, z, x - x2, z - z2).toFixed(2) };
process.stdout.write(JSON.stringify(out));
