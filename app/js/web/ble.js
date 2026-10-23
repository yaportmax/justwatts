// Web Bluetooth device hub for the web build (same interface as server/openspin/devices.py).
// A page reload drops the GATT link, so after a reload the user clicks Reconnect once; where the
// browser allows it (navigator.bluetooth.getDevices + watchAdvertisements) we reconnect by ourselves.
const FTMS = 0x1826, IBD = 0x2ad2, CP = 0x2ad9, HRS = 'heart_rate', HRM = 'heart_rate_measurement';

export function parseIBD(v) {
  const f = v.getUint16(0, true), out = {}; let i = 2;
  if (!(f & 1)) { out.speed = v.getUint16(i, true) / 100; i += 2; }
  if (f & 2) i += 2;
  if (f & 4) { out.cadence = v.getUint16(i, true) / 2; i += 2; }
  if (f & 8) i += 2;
  if (f & 16) i += 3;
  if (f & 32) i += 2;
  if (f & 64) { out.power = Math.max(0, v.getInt16(i, true)); i += 2; }
  if (f & 128) i += 2;
  if (f & 256) i += 5;
  if (f & 512) out.hr = v.getUint8(i);
  return out;
}
export function cpBytes(c) {
  if (c.k === 'erg') { const w = Math.max(0, Math.min(2000, Math.round(c.w))); return [0x05, w & 255, (w >> 8) & 255]; }
  if (c.k === 'res') return [0x04, Math.max(0, Math.min(255, Math.round(c.r * 10)))];
  const g = Math.round(c.g * 100); return [0x11, 0, 0, g & 255, (g >> 8) & 255, 40, 51];
}

export class WebHub {
  constructor({ clock = () => performance.now() / 1000, store, log = () => {} } = {}) {
    this.clock = clock; this.store = store; this.log = log;
    this.r = { power: 0, cadence: 0, speed: 0, hr: 0, last: 0, hrLast: 0, hrSrc: null };
    this.mode = 'none'; this.trainer = null; this.hrDev = null; this.hrConnected = false; this.hrState = null; this.error = null;
    this.cp = null; this.wantCmd = null; this.sent = null; this.busy = false; this.remembered = { trainer: null, hr: null };
  }
  get supported() { return !!globalThis.navigator?.bluetooth; }
  status() {
    const now = this.clock(), hrOn = !!this.r.hrSrc && now - this.r.hrLast < 5;
    return { trainer: this.mode, trainer_name: this.mode === 'sim' ? 'Simulated' : this.trainer?.name || this.remembered.trainer || null,
      hr: hrOn ? this.r.hrSrc : null, hr_name: this.hrDev?.name || null, hr_connected: this.hrConnected, hr_waiting: !!this.r.hrSrc && !hrOn,
      hr_state: this.hrState, ble: this.supported, error: this.error, web: true,
      reconnect: { trainer: !!this.remembered.trainer && this.mode === 'none', hr: !!this.remembered.hr && !this.hrDev } };
  }
  async init() {  // remembered names + auto reconnect where the browser allows it
    this.remembered = (await this.store?.get('devices')) || { trainer: null, hr: null };
    if (!this.supported || !navigator.bluetooth.getDevices) return;
    let ds = []; try { ds = await navigator.bluetooth.getDevices(); } catch { return; }
    for (const d of ds) {
      const kind = d.name === this.remembered.trainer ? 'trainer' : d.name === this.remembered.hr ? 'hr' : null;
      if (!kind) continue;
      const go = () => this.attach(kind, d).catch(() => {});
      if (d.watchAdvertisements) {  // connect when it is in range and advertising
        d.addEventListener('advertisementreceived', go, { once: true });
        try { await d.watchAdvertisements(); } catch { go(); }
      } else go();
    }
  }
  remember(kind, name) { this.remembered[kind] = name; this.store?.set('devices', this.remembered); }
  async choose(kind) {  // must run inside the click that asked for it (browser chooser)
    if (!this.supported) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge on desktop or Android (on iOS: Bluefy).');
    const d = kind === 'trainer'
      ? await navigator.bluetooth.requestDevice({ filters: [{ services: [FTMS] }], optionalServices: [0x1818, 0x180a, 0x180d] })
      : await navigator.bluetooth.requestDevice({ filters: [{ services: [HRS] }] });
    await this.attach(kind, d);
  }
  async attach(kind, d) {
    if (kind === 'trainer') { if (this.mode === 'sim') this.setSim(false); this.trainer = d; this.mode = 'wait'; }
    else { this.hrDev = d; this.hrState = 'connecting'; }
    this.remember(kind, d.name || kind);
    d.addEventListener('gattserverdisconnected', () => this.lost(kind, d));
    await (kind === 'trainer' ? this.setupTrainer(d) : this.setupHR(d));
  }
  async setupTrainer(d) {
    const server = await d.gatt.connect(), ftms = await server.getPrimaryService(FTMS);
    const data = await ftms.getCharacteristic(IBD);
    data.addEventListener('characteristicvaluechanged', e => {
      const x = parseIBD(e.target.value), r = this.r;
      if (x.speed != null) r.speed = x.speed; if (x.cadence != null) r.cadence = x.cadence; if (x.power != null) r.power = x.power;
      if (x.hr > 0 && (!r.hrSrc || r.hrSrc === 'hub')) { r.hr = x.hr; r.hrLast = this.clock(); r.hrSrc = 'hub'; }
      r.last = this.clock();
    });
    await data.startNotifications();
    this.cp = await ftms.getCharacteristic(CP);
    this.cp.addEventListener('characteristicvaluechanged', e => { const v = e.target.value; if (v.getUint8(0) === 0x80 && v.getUint8(2) === 5) { this.sent = null; this.raw([0x00]).then(() => this.pump()); } });
    await this.cp.startNotifications();
    await this.raw([0x00]); await this.raw([0x07]);
    this.sent = null; this.mode = 'ble'; this.error = null; this.pump();
  }
  async setupHR(d) {
    for (let tries = 0; ; tries++) {
      try {
        const ch = await (await (await d.gatt.connect()).getPrimaryService(HRS)).getCharacteristic(HRM);
        ch.addEventListener('characteristicvaluechanged', e => { const v = e.target.value, f = v.getUint8(0); this.r.hr = f & 1 ? v.getUint16(1, true) : v.getUint8(1); this.r.hrLast = this.clock(); });
        await ch.startNotifications();
        this.hrConnected = true; this.hrState = 'connected'; this.r.hrSrc = d.name || 'strap'; return;
      } catch (e) {
        // straps that hide the HR service until they feel a heartbeat: retry every few seconds
        if (this.hrDev !== d || tries > 200) throw e;
        this.hrState = 'waiting_heartbeat';
        try { d.gatt.disconnect(); } catch {}
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  async lost(kind, d) {
    if (kind === 'trainer') {
      if (this.trainer !== d) return; this.cp = null; this.mode = 'wait';
      for (let i = 1; this.trainer === d; i++) {  // keep trying while the page is open
        await new Promise(r => setTimeout(r, Math.min(10, i) * 1000));
        try { await this.setupTrainer(d); return; } catch {}
      }
    } else if (this.hrDev === d) {
      this.hrConnected = false; this.hrState = 'connecting';
      try { await this.setupHR(d); } catch { this.hrState = null; }
    }
  }
  disconnect(kind) {
    if (kind === 'trainer') { const d = this.trainer; this.trainer = null; this.cp = null; if (this.mode !== 'sim') this.mode = 'none'; try { d?.gatt.disconnect(); } catch {} Object.assign(this.r, { power: 0, cadence: 0, speed: 0 }); this.remember('trainer', null); }
    else { const d = this.hrDev; this.hrDev = null; this.hrConnected = false; this.hrState = null; try { d?.gatt.disconnect(); } catch {} if (!['hub', 'sim'].includes(this.r.hrSrc)) this.r.hrSrc = null; this.remember('hr', null); }
  }
  setSim(on) {
    const r = this.r;
    if (on) { if (this.mode === 'ble' || this.mode === 'wait') this.disconnect('trainer'); this.mode = 'sim'; r.hrSrc = 'sim'; }
    else if (this.mode === 'sim') { this.mode = 'none'; Object.assign(r, { power: 0, cadence: 0, speed: 0 }); if (r.hrSrc === 'sim') { r.hrSrc = null; r.hr = 0; } }
  }
  want(cmd) { this.wantCmd = cmd; this.pump(); }
  async raw(bytes) { try { await this.cp.writeValueWithResponse(new Uint8Array(bytes)); } catch (e) { this.log('cp ' + e); } }
  async pump() {
    if (this.busy || !this.cp || this.mode !== 'ble' || !this.wantCmd) return;
    const key = JSON.stringify(this.wantCmd); if (key === this.sent) return;
    this.busy = true; const c = this.wantCmd;
    await this.raw(cpBytes(c)); this.sent = JSON.stringify(c); this.busy = false; this.pump();
  }
}
