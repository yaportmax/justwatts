import { Engine } from '/js/web/engine.js';
import { createWorld } from '/js/world.js';
import { createWorldView } from '/js/world3d/view.js';
import { sharedBaked } from '/js/world3d/baked.js';

const settings = { ftp: 250, afterWorkout: 'hold', weight: 75 };
let t = 1000, wall = Date.now(), K = 1;  // K: time scale (ridenet --speed): the engine steps K x 0.25 s each 250 ms
const hub = { mode: 'ble', r: { power: 240, cadence: 88, hr: 0, speed: 0, last: 0, hrLast: 0 }, wantCmd: null, want(c) { this.wantCmd = c; }, status() { return {}; } };
const eng = new Engine({ hub, logEvent: l => eng.note(l), settings: () => settings, save: () => {}, archive: () => {}, clock: () => t, wall: () => wall });
const control = async (a, b) => eng.control(a, b);
const course = async () => ({ course: eng.ride?.course ?? null, d: eng.ride?.cs.d ?? 0 });
const world = createWorld({ control, course });
let view = null, others = [], timer = 0;
const rc = () => eng.state({}).ride?.course;
// d: the stretch since the last teleport counts from its start (ow.d), as the app does (courses.js renderRide)
function feed() {
  const r = rc(), ow = world.view(); if (!r || !ow) return;
  view?.update({ ll: ow.ll, ele: ow.ele, dist: (ow.ll.length - 1) * 10, d: ow.d, v: r.speed_kmh / 3.6 * K, cad: hub.r.cadence, alts: ow.alts, turn: ow.turn });
}
function step(dt) { const a = performance.now(); t += dt; wall += dt * 1000; hub.r.last = t; eng.tick(dt); const b = performance.now(); world.update(rc(), eng.ride.id); const c = performance.now(); feed(); const e = performance.now(); if (e - a > 5) (window.__steps ??= []).push([Math.round(a), +(b - a).toFixed(1), +(c - b).toFixed(1), +(e - c).toFixed(1)]); }
window.__h = {
  async start(lat, lon, heading, { quality = 0, time = 'golden', power = 240, others: no = 0 } = {}) {
    hub.r.power = power;
    await world.start({ name: 'Open world', lat, lon, heading });
    eng.control('start', {});
    for (let i = 0; i < 4; i++) { step(0.25); await new Promise(r => setTimeout(r, 30)); }
    view = createWorldView({ container: document.getElementById('w'), baked: sharedBaked(), quality, time, getOthers: () => others, onFail: e => { window.__fail = e; } });
    feed();
    clearInterval(timer); timer = setInterval(() => { step(0.25 * K); if (no) placeOthers(no); }, 250);
    return true;
  },
  viewFrom: v => view.viewFrom(v), dbg: () => view.debug(), stats: () => view?.stats(), chase: (a, b) => view.setChase(a, b), fail: () => window.__fail || null,
  pause() { clearInterval(timer); }, setTime: x => view.setTime(x), cam: () => view.toggleCamera(), quality: n => view.setQuality(n),
  async ride(secs) { for (let i = 0; i < secs * 4; i++) step(0.25); },
  // where the rider is: the snapped point on the road and the way it faces (for Street View pairs)
  where: () => { const ow = world.view(); if (!ow) return null; const i = Math.max(0, Math.min(ow.ll.length - 2, Math.floor(ow.d / 10))), f = Math.min(1, ow.d / 10 - i), [a, b] = [ow.ll[i], ow.ll[i + 1]], R = Math.PI / 180;
    const y = Math.sin((b[1] - a[1]) * R) * Math.cos(b[0] * R), x = Math.cos(a[0] * R) * Math.sin(b[0] * R) - Math.sin(a[0] * R) * Math.cos(b[0] * R) * Math.cos((b[1] - a[1]) * R);
    return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, heading: (Math.atan2(y, x) / R + 360) % 360, ele: ow.ele[i] + (ow.ele[i + 1] - ow.ele[i]) * f, road: ow.road }; },
  // ridenet: the world (choose, uturn, teleport, view), the engine's course (nd, jp), the time scale, the power
  world, course: () => eng.ride?.course ?? null, setK: k => { K = k; }, power: w => { hub.r.power = w; },
  pos: () => { const r = rc(), ow = world.view(); return { d: r.odo_m, v: r.speed_kmh, road: ow.road, n: ow.ll.length }; },
};
// riders ahead on my road: one drafting distance ahead, one further, a friend
function placeOthers(n) {
  const ow = world.view(), r = rc(); if (!ow) return;
  const at = d => { const i = Math.max(0, Math.min(ow.ll.length - 1, Math.round(d / 10))); return ow.ll[i]; };
  others = [[6, 'Ana 262 W', false], [28, 'Ben 231 W', true], [60, 'Chloe 198 W', false], [95, 'Dev 305 W', false]].slice(0, n)
    .map(([ahead, label, hi], i) => { const p = at(r.odo_m + ahead); return { id: 'o' + i, lat: p[0] + (i % 2 ? 0.000012 : -0.000012), lon: p[1], label, hi }; });
}
// no engine: a straight line from a point (to look at any spot)
window.__h.fly = (lat, lon, heading, { quality = 0, time = 'golden' } = {}) => {
  const ll = [], k = Math.cos(lat * Math.PI / 180) * 111195, r = heading * Math.PI / 180;
  for (let i = 0; i < 300; i++) ll.push([lat + Math.cos(r) * i * 10 / 111195, lon + Math.sin(r) * i * 10 / k]);
  view = createWorldView({ container: document.getElementById('w'), baked: sharedBaked(), quality, time, getOthers: () => others, onFail: e => { window.__fail = e; } });
  view.update({ ll, ele: null, dist: 2990, d: 20, v: 0, cad: 0, alts: [], turn: null });
  return true;
};
// (A49: local harness compatibility with netscan3. Same fly line on the existing view.)
window.__h.hop = (lat, lon, heading) => {
  const ll = [], k = Math.cos(lat * Math.PI / 180) * 111195, r = heading * Math.PI / 180;
  for (let i = 0; i < 300; i++) ll.push([lat + Math.cos(r) * i * 10 / 111195, lon + Math.sin(r) * i * 10 / k]);
  view.update({ ll, ele: null, dist: 2990, d: 20, v: 0, cad: 0, alts: [], turn: null });
  return true;
};
