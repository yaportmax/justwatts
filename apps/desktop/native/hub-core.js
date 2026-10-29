// The desktop device hub, split in two. The BLE host (a hidden window that never reloads) runs the web build's
// WebHub with the real Bluetooth link. The page gets a DesktopHub: the same WebHub interface, fed by snapshots
// from the host, so a page reload never touches the trainer or the strap. Nothing here imports by absolute path,
// so the unit tests run it under node with a mocked Bluetooth layer.

const FAR = 1e9;  // "never": no reading yet

// host side: what the page needs to mirror. Times are ages, because the two windows have different clocks.
export function hostSnapshot(hub) {
  const now = hub.clock(), r = hub.r;
  return {
    mode: hub.mode, trainer: hub.trainer ? (hub.trainer.name || 'Trainer') : null, hrDev: hub.hrDev ? (hub.hrDev.name || 'Heart rate') : null,
    hrConnected: hub.hrConnected, hrState: hub.hrState, error: hub.error, remembered: { ...hub.remembered }, wantCmd: hub.wantCmd,
    r: { power: r.power, cadence: r.cadence, speed: r.speed, hr: r.hr, hrSrc: r.hrSrc, lastAge: r.last ? now - r.last : FAR, hrLastAge: r.hrLast ? now - r.hrLast : FAR },
  };
}

// host side: commands from the page (choose runs separately, inside a user gesture)
export function hostCommand(hub, c) {
  if (c.op === 'want') hub.want(c.arg);
  else if (c.op === 'disconnect') hub.disconnect(c.arg === 'hr' ? 'hr' : 'trainer');
}

export async function hostChoose(hub, kind) {
  try { await hub.choose(kind === 'hr' ? 'hr' : 'trainer'); return { ok: true, state: hostSnapshot(hub) }; }
  catch (e) { return { ok: false, error: String(e?.message || e), state: hostSnapshot(hub) }; }
}

// page side: native = { hubState(), onHub(cb), choose(kind), command(op, arg) }
export function desktopHubClass(WebHub, native) {
  return class DesktopHub extends WebHub {
    get supported() { return true; }
    async init() {
      this.remembered = (await this.store?.get('devices')) || this.remembered;
      native.onHub(s => this.apply(s));
      const s = await native.hubState();
      if (s) this.apply(s);
    }
    apply(s) {
      if (!s) return;
      const now = this.clock(), r = this.r, x = s.r || {};
      this.remembered = s.remembered || this.remembered;
      this.hrDev = s.hrDev ? { name: s.hrDev } : null; this.hrConnected = !!s.hrConnected; this.hrState = s.hrState ?? null;
      if (this.mode === 'sim') return;  // the simulated trainer lives in the page (the engine drives it)
      this.mode = s.mode; this.trainer = s.trainer ? { name: s.trainer } : null; this.error = s.error ?? null;
      if (x.lastAge < FAR) { r.power = x.power; r.cadence = x.cadence; r.speed = x.speed; r.last = now - x.lastAge; }
      if (x.hrLastAge < FAR) { r.hr = x.hr; r.hrLast = now - x.hrLastAge; }
      r.hrSrc = x.hrSrc ?? null;
    }
    async choose(kind) {
      const res = await native.choose(kind);
      if (res?.ok && kind === 'trainer' && this.mode === 'sim') super.setSim(false);
      this.apply(res?.state);
      if (!res?.ok) throw new Error(res?.error || 'Bluetooth error');
    }
    disconnect(kind) { native.command('disconnect', kind); super.disconnect(kind); }
    want(cmd) { this.wantCmd = cmd; native.command('want', cmd); }
    pump() {}
  };
}
