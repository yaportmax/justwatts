// Runs Bluetooth outside the page. A hidden window (native/host.html) holds the WebHub and the GATT links; it never
// navigates or reloads, so reloading the app's page, a page crash or an update prompt cannot drop the trainer.
// Chromium's Web Bluetooth is the same radio stack Chrome uses on justwatts.com, on Windows and macOS.
//
// The device chooser: requestDevice in the host fires select-bluetooth-device here; the list goes to the page's
// chooser and the pick comes back. Device ids are remembered so the app reconnects by itself after a restart
// (silently: the chooser is answered here when the remembered id shows up).
'use strict';
const fs = require('node:fs');
const { BrowserWindow, ipcMain } = require('electron');

const AUTO_SCAN_MS = 20000, AUTO_EVERY_MS = 60000;

class BleHost {
  constructor({ url, preload, file, fake = false, toPage, log = () => {} }) {
    Object.assign(this, { url, preload, file, fake, toPage, log });
    this.state = null; this.choosing = null; this.selCb = null; this.win = null; this.ready = false; this.stopped = false;
    this.ids = this.loadIds();
    ipcMain.on('host-state', (e, s) => { if (this.isHost(e)) { this.state = s; this.toPage('hub-state', s); } });
    ipcMain.on('host-ready', e => { if (this.isHost(e)) { this.ready = true; this.autoConnect(); } });
    ipcMain.on('host-config', e => { e.returnValue = this.isHost(e) ? { fake: this.fake } : {}; });
    ipcMain.handle('host-fake-select', (e, list) => (this.isHost(e) && this.fake ? new Promise(cb => this.onSelect(list, cb)) : ''));
    this.timer = setInterval(() => this.autoConnect(), AUTO_EVERY_MS);
  }
  isHost(e) { return !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents; }
  start() {
    if (this.stopped) return;
    this.ready = false;
    const win = this.win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('select-bluetooth-device', (e, list, cb) => {
      e.preventDefault();
      this.onSelect(list.map(d => ({ id: d.deviceId, name: d.deviceName })), cb);
    });
    win.webContents.on('render-process-gone', (_e, d) => { this.log('ble host gone: ' + d.reason); this.restart(); });
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.loadURL(this.url);
  }
  restart() {
    this.cancelSelect();
    const w = this.win; this.win = null; this.state = null;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch {}
    if (!this.stopped) setTimeout(() => this.start(), 1000);
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.cancelSelect(); try { this.win?.destroy(); } catch {} }

  /* ---------- the chooser ---------- */
  onSelect(list, cb) {
    this.selCb = cb;  // Chromium calls again as devices show up; the newest callback is the live one
    const cur = this.choosing;
    if (!cur) return this.finishSelect('');
    if (cur.auto) { if (list.some(d => d.id === cur.auto)) this.finishSelect(cur.auto); return; }
    this.toPage('chooser', { kind: cur.kind, devices: list });
  }
  finishSelect(id) {
    const cb = this.selCb; this.selCb = null;
    if (this.choosing) this.choosing.picked = id || null;
    if (cb) { try { cb(id || ''); } catch {} }
  }
  cancelSelect() { if (this.selCb) this.finishSelect(''); if (this.choosing && !this.choosing.auto) this.toPage('chooser', { done: true }); }
  pick(id) { if (this.choosing && !this.choosing.auto) this.finishSelect(id); }

  // kind: 'trainer' | 'hr'. auto: a remembered device id (no chooser). Resolves { ok, error, state }.
  async choose(kind, { auto = null } = {}) {
    if (!this.win || !this.ready) return { ok: false, error: 'Bluetooth is starting, try again in a moment.', state: this.state };
    if (this.choosing) {
      if (!this.choosing.auto) return { ok: false, error: 'A device chooser is already open.', state: this.state };
      this.finishSelect(''); await this.choosing.done.catch(() => {});
    }
    const cur = this.choosing = { kind, auto, picked: null };
    const t = auto ? setTimeout(() => { if (this.choosing === cur) this.finishSelect(''); }, AUTO_SCAN_MS) : null;
    cur.done = this.win.webContents.executeJavaScript(`window.__host.choose(${JSON.stringify(kind)})`, true)
      .catch(e => ({ ok: false, error: String(e?.message || e) }));
    const res = await cur.done;
    clearTimeout(t); this.choosing = null;
    if (!auto) this.toPage('chooser', { done: true });
    if (res.ok && cur.picked) this.remember(kind, cur.picked);
    if (res.state) this.state = res.state;
    return res;
  }
  command(c) {
    if (!this.win || this.win.isDestroyed()) return;
    if (c.op === 'disconnect') this.remember(c.arg === 'hr' ? 'hr' : 'trainer', null);
    this.win.webContents.send('host-cmd', c);
  }

  /* ---------- reconnect after a restart ---------- */
  async autoConnect() {
    if (!this.ready || this.choosing || this.autoBusy) return;
    this.autoBusy = true;
    try {
      for (const kind of ['trainer', 'hr']) {
        const id = this.ids[kind], s = this.state;
        if (!id || !s) continue;
        const linked = kind === 'trainer' ? s.mode !== 'none' : !!s.hrDev;
        if (linked || this.choosing) continue;
        await this.choose(kind, { auto: id });
      }
    } finally { this.autoBusy = false; }
  }
  loadIds() { try { return { trainer: null, hr: null, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { return { trainer: null, hr: null }; } }
  remember(kind, id) { this.ids[kind] = id; try { fs.writeFileSync(this.file, JSON.stringify(this.ids)); } catch {} }
}

module.exports = { BleHost };
