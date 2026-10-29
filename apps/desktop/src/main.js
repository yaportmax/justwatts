// Just Watts desktop: the website's own build (web/, bundled at release time) in a window, with Bluetooth in a
// hidden host window that never reloads (ble-host.js), the API proxied to justwatts.com (proxy.js), sign-in through
// the system browser (oauth.js), keep-awake and quit confirmation while riding, and auto-update from GitHub Releases.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, protocol, safeStorage, session, shell } = require('electron');
const { CookieJar, createProxy } = require('./proxy');
const { createOAuth } = require('./oauth');
const { createServer } = require('./serve');
const { BleHost } = require('./ble-host');
const { setupUpdater } = require('./updater');

const SCHEME = 'app', HOST = 'justwatts', ORIGIN = `${SCHEME}://${HOST}`, LINK = 'justwatts';
const API = (process.env.JUSTWATTS_API || 'https://justwatts.com').replace(/\/+$/, '');
const ROOT = path.join(__dirname, '..');
const TEST_PROFILE = process.env.JUSTWATTS_DESKTOP_PROFILE;  // tests: a throwaway profile, no protocol registration
if (TEST_PROFILE) app.setPath('userData', TEST_PROFILE);

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null, ble = null, proxy = null, oauth = null, updater = null, riding = false, blocker = null, quitting = false;
const linkQueue = [];
const log = m => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `[${new Date().toISOString()}] ${m}\n`); } catch {} };
const toPage = (ch, x) => { if (win && !win.isDestroyed()) win.webContents.send(ch, x); };
const ours = url => { try { const u = new URL(url); return u.protocol === SCHEME + ':' && u.host === HOST; } catch { return false; } };  // URL.origin is 'null' for custom schemes
const fromApp = e => e.sender === win?.webContents && ours(e.senderFrame?.url);

// deep links: justwatts://auth?... (Windows passes them on the command line, macOS through open-url)
const linkIn = argv => argv.find(a => typeof a === 'string' && a.startsWith(LINK + '://'));
async function onLink(url) {
  if (!oauth || !win) { linkQueue.push(url); return; }
  if (win.isMinimized()) win.restore();
  win.focus();
  const to = await oauth.finish(url);
  if (to) win.loadURL(ORIGIN + to);
}
app.on('open-url', (e, url) => { e.preventDefault(); onLink(url); });
app.on('second-instance', (_e, argv) => { const l = linkIn(argv); if (l) onLink(l); else if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
{ const l = linkIn(process.argv); if (l) linkQueue.push(l); }

function cryptOrNull() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return { encrypt: s => safeStorage.encryptString(s), decrypt: b => safeStorage.decryptString(b) };
}

function setRiding(on) {
  riding = on;
  if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

function menu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 380, minHeight: 500, backgroundColor: '#0b0d10', title: 'Just Watts', autoHideMenuBar: true, show: false,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  const wc = win.webContents;
  // in-app links stay in the app; sign-in goes to the system browser; everything else opens in the browser
  wc.on('will-navigate', (e, url) => {
    let u; try { u = new URL(url); } catch { e.preventDefault(); return; }
    if (ours(url)) {
      if (!u.pathname.startsWith('/api/')) return;
      e.preventDefault();
      if (oauth.isStart(u.pathname)) oauth.start(u).then(back => { if (back) win.loadURL(ORIGIN + back); });
      else shell.openExternal(API + u.pathname + u.search);
      return;
    }
    e.preventDefault();
    if (/^https?:$/.test(u.protocol)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('did-start-navigation', d => { if (d.isMainFrame && !d.isSameDocument) ble?.cancelSelect(); });
  wc.on('render-process-gone', (_e, d) => { log('page gone: ' + d.reason); if (!quitting) setTimeout(() => win && !win.isDestroyed() && win.reload(), 500); });
  win.on('close', e => {
    if (quitting || !riding) return;
    e.preventDefault();
    dialog.showMessageBox(win, { type: 'question', buttons: ['Keep riding', 'Quit'], defaultId: 0, cancelId: 0, message: 'A ride is in progress.', detail: 'It is saved and continues when you open Just Watts again.' })
      .then(({ response }) => { if (response === 1) { quitting = true; app.quit(); } });
  });
  win.on('closed', () => { win = null; app.quit(); });
  win.loadURL(ORIGIN + '/');
}

function ipc() {
  ipcMain.on('app-info', e => { e.returnValue = { version: app.getVersion(), platform: process.platform }; });
  ipcMain.handle('hub-state', e => (fromApp(e) ? ble.state : null));
  ipcMain.handle('hub-choose', (e, kind) => (fromApp(e) ? ble.choose(kind === 'hr' ? 'hr' : 'trainer') : { ok: false, error: 'denied' }));
  ipcMain.on('hub-cmd', (e, c) => { if (fromApp(e) && c && ['want', 'disconnect'].includes(c.op)) ble.command({ op: c.op, arg: c.arg }); });
  ipcMain.on('chooser-pick', (e, id) => { if (fromApp(e)) ble.pick(typeof id === 'string' ? id : ''); });
  ipcMain.on('riding', (e, on) => { if (fromApp(e)) setRiding(!!on); });
  ipcMain.handle('update-restart', e => (fromApp(e) && !riding ? updater.restart() : false));
}

app.whenReady().then(() => {
  const jar = new CookieJar({ file: path.join(app.getPath('userData'), 'session.dat'), crypt: cryptOrNull() });
  proxy = createProxy({ api: API, jar });
  oauth = createOAuth({ api: API, proxy, openExternal: url => shell.openExternal(url) });
  const serve = createServer({ webDir: path.join(ROOT, 'web'), nativeDir: path.join(ROOT, 'native') });
  protocol.handle(SCHEME, req => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('not found', { status: 404 });
    if (u.pathname.startsWith('/api/')) return proxy.handle(req);
    return serve(u.pathname);
  });
  // Bluetooth pairing prompts (Windows, Linux): FTMS trainers and HR straps pair without a PIN
  session.defaultSession.setBluetoothPairingHandler?.((details, cb) => cb({ confirmed: details.pairingKind === 'confirm' }));
  if (!TEST_PROFILE) {
    if (process.defaultApp) app.setAsDefaultProtocolClient(LINK, process.execPath, [path.resolve(process.argv[1] || '.')]);
    else app.setAsDefaultProtocolClient(LINK);
  }
  menu();
  ble = new BleHost({ url: ORIGIN + '/__native/host.html', preload: path.join(__dirname, 'host-preload.js'), file: path.join(app.getPath('userData'), 'devices.json'),
    fake: process.env.JUSTWATTS_FAKE_BLE === '1', toPage, log });
  ipc();
  ble.start();
  createWindow();
  updater = setupUpdater({ isRiding: () => riding, notify: v => toPage('update', { version: v }), log, onQuit: () => { quitting = true; } });
  win.webContents.once('did-finish-load', () => { for (const l of linkQueue.splice(0)) onLink(l); });
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { ble?.stop(); setRiding(false); });
app.on('window-all-closed', () => app.quit());
