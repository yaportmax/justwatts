// The BLE host window: snapshots out, commands in.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const cfg = ipcRenderer.sendSync('host-config') || {};
contextBridge.exposeInMainWorld('JustWattsHost', {
  fake: !!cfg.fake,
  state: s => ipcRenderer.send('host-state', s),
  ready: () => ipcRenderer.send('host-ready'),
  onCmd: cb => ipcRenderer.on('host-cmd', (_e, c) => cb(c)),
  fakeSelect: list => ipcRenderer.invoke('host-fake-select', list),
});
