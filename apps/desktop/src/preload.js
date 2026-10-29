// The page's only window into the app: device hub snapshots and commands, the chooser, riding, updates.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('app-info') || {};
const on = (ch, cb) => ipcRenderer.on(ch, (_e, x) => cb(x));

contextBridge.exposeInMainWorld('JustWattsNative', {
  app: 'desktop', platform: info.platform, version: info.version,
  hubModule: '/__native/hub.js',
  hubState: () => ipcRenderer.invoke('hub-state'),
  onHub: cb => on('hub-state', cb),
  choose: kind => ipcRenderer.invoke('hub-choose', kind),
  command: (op, arg) => ipcRenderer.send('hub-cmd', { op, arg }),
  onChooser: cb => on('chooser', cb),
  pick: id => ipcRenderer.send('chooser-pick', id),
  setRiding: v => ipcRenderer.send('riding', !!v),
  onUpdate: cb => on('update', cb),
  restartToUpdate: () => ipcRenderer.invoke('update-restart'),
});
