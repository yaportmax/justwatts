// World 3D sound, all made in Web Audio from noise and a click (no files): wind that grows with speed, the hum of the
// tyres, the freewheel ticking when the rider coasts, and the sea breathing near the coast. Quiet by design. The gain
// curves are pure (tests/test_world3d.py); createAudio needs a browser.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// v: m/s. Wind in the ears: nothing standing, rising with the square of speed, capped
export const windGain = v => v < 0.3 ? 0 : clamp(0.012 + 0.00055 * v * v, 0, 0.22);
// the tyres on the road: from a walking pace, more on rough surfaces (surface 0 asphalt .. 1 gravel)
export const tireGain = (v, surface = 0) => v < 0.8 ? 0 : clamp(0.018 + 0.0048 * v, 0, 0.12) * (1 + surface * 0.8);
// the tyre hum's pitch in Hz
export const tireHz = v => 70 + 9 * v;
// freewheel clicks a second: only coasting (no cadence) and rolling; the hub's pawls, 24 a turn of a 0.335 m wheel
export const tickRate = (v, cadence) => cadence > 5 || v < 1 ? 0 : Math.min(140, v / (2 * Math.PI * 0.335) * 24);
// sea: the share of the ground round the rider that is sea (0..1)
export const oceanGain = sea => 0.1 * smooth(0.04, 0.5, sea);

export function createAudio({ on = true } = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return { update() {}, hush() {}, set() { return false; }, get on() { return false; }, dispose() {} };
  let ctx = null, nodes = null, enabled = on, nextTick = 0, dead = false;
  function build() {
    ctx = new AC();
    const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const brown = ctx.createBuffer(1, len, ctx.sampleRate), e = brown.getChannelData(0);
    for (let i = 0; i < len; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; e[i] = b * 3.5; }
    const loop = bf => { const s = ctx.createBufferSource(); s.buffer = bf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 2); return s; };
    const chain = (src, ...ns) => { let n = src; for (const x of ns) { n.connect(x); n = x; } return n; };
    // wind: band-passed noise, a slow gusting wobble
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 0.6; wf.frequency.value = 500;
    const wl = ctx.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 1800;
    const wg = ctx.createGain(); wg.gain.value = 0; chain(loop(buf), wf, wl, wg).connect(master);
    // tyres: a low rumble of noise round the hum's pitch
    const tf = ctx.createBiquadFilter(); tf.type = 'bandpass'; tf.Q.value = 2.2; tf.frequency.value = 200;
    const tg = ctx.createGain(); tg.gain.value = 0; chain(loop(buf), tf, tg).connect(master);
    // the sea: brown noise, low-passed, swelling every few seconds
    const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 650;
    const og = ctx.createGain(); og.gain.value = 0; chain(loop(brown), of, og).connect(master);
    // a freewheel click: a few milliseconds of bright noise
    const click = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.004), ctx.sampleRate), c = click.getChannelData(0);
    for (let i = 0; i < c.length; i++) c[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.length / 5));
    const kf = ctx.createBiquadFilter(); kf.type = 'highpass'; kf.frequency.value = 2500; const kg = ctx.createGain(); kg.gain.value = 0.05; kf.connect(kg).connect(master);
    nodes = { master, wf, wg, tf, tg, og, click, kf };
  }
  const resume = () => { if (ctx?.state === 'suspended' && enabled) ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, resume, { passive: true });
  let t = 0;
  return {
    // s: { dt, v (m/s), cad (rpm), sea (0..1), inside (0..1, a tunnel), surface (0..1) }
    update(s) {
      if (dead || !enabled) return;
      try {
        if (!ctx) build();
        resume();
        if (ctx.state !== 'running') return;
        t += s.dt || 0;
        const now = ctx.currentTime, v = s.v || 0, n = nodes, ramp = (p, x) => p.setTargetAtTime(x, now, 0.25);
        ramp(n.master.gain, 0.9);
        const gust = 0.8 + 0.2 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1);
        ramp(n.wg.gain, windGain(v) * gust * (1 - 0.6 * (s.inside || 0))); ramp(n.wf.frequency, 300 + 40 * v);
        ramp(n.tg.gain, tireGain(v, s.surface || 0)); ramp(n.tf.frequency, tireHz(v));
        ramp(n.og.gain, oceanGain(s.sea || 0) * (0.55 + 0.45 * Math.sin(t * 0.55)) * (1 - (s.inside || 0)));
        const rate = tickRate(v, s.cad || 0);
        if (rate > 0) {
          if (nextTick < now) nextTick = now + 0.02;
          while (nextTick < now + 0.22) {
            const src = ctx.createBufferSource(); src.buffer = n.click; src.playbackRate.value = 0.9 + 0.2 * Math.random();
            src.connect(n.kf); src.start(nextTick); nextTick += 1 / rate;
          }
        } else nextTick = 0;
      } catch { dead = true; }
    },
    // quiet until the next update (the world not drawn: the ride ended, the view or the tab hidden)
    hush() { if (ctx?.state === 'running') ctx.suspend().catch(() => {}); },
    set(on) { enabled = !!on; if (ctx) { if (enabled) resume(); else ctx.suspend().catch(() => {}); } return enabled; },
    get on() { return enabled; },
    dispose() { dead = true; for (const ev of ['pointerdown', 'keydown']) globalThis.removeEventListener?.(ev, resume); ctx?.close().catch(() => {}); ctx = null; },
  };
}
