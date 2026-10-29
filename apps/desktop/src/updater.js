// Auto-update from GitHub Releases (electron-updater reads latest.yml / latest-mac.yml there). Checks at launch and
// every 4 hours, downloads in the background, installs on quit. The page offers "Restart" when no ride is running;
// a restart never happens mid-ride. macOS needs a signed build for updates; unsigned builds just log the error.
'use strict';
const { app } = require('electron');

const EVERY_MS = 4 * 3600 * 1000;

function setupUpdater({ isRiding, notify, log, onQuit }) {
  if (!app.isPackaged || process.env.JUSTWATTS_NO_UPDATE === '1') return { restart: () => false };
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log('updater missing: ' + e.message); return { restart: () => false }; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: () => {}, warn: m => log('update: ' + m), error: m => log('update error: ' + m), debug: () => {} };
  let ready = null;
  autoUpdater.on('update-downloaded', info => { ready = info.version; notify(ready); });
  autoUpdater.on('error', e => log('update error: ' + (e?.message || e)));
  const check = () => autoUpdater.checkForUpdates().catch(e => log('update check: ' + (e?.message || e)));
  setTimeout(check, 10000);
  setInterval(check, EVERY_MS);
  return {
    restart() {
      if (!ready || isRiding()) return false;
      onQuit(); setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return true;
    },
  };
}

module.exports = { setupUpdater };
