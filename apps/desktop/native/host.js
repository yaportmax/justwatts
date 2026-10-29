// The BLE host: a hidden window that never reloads. It runs the web build's WebHub, so the desktop app speaks
// FTMS and heart rate with exactly the code the website uses, and sends the page a snapshot four times a second.
import { WebHub } from '/js/web/ble.js';
import { openDB, MemStore } from '/js/web/idb.js';
import { hostSnapshot, hostCommand, hostChoose } from './hub-core.js';

const H = window.JustWattsHost;
if (H.fake) {  // tests only: a mocked trainer and strap instead of the radio
  const { fakeBluetooth } = await import('./fake-ble.js');
  Object.defineProperty(navigator, 'bluetooth', { value: fakeBluetooth({ select: list => H.fakeSelect(list) }), configurable: true });
}
let store; try { store = await openDB(); } catch { store = new MemStore(); }
const hub = new WebHub({ store, log: m => console.warn(m) });
hub.remembered = (await store.get('devices')) || hub.remembered;  // names only; the main process reconnects by device id

window.__host = { choose: kind => hostChoose(hub, kind), snapshot: () => hostSnapshot(hub), hub };
H.onCmd(c => hostCommand(hub, c));
setInterval(() => H.state(hostSnapshot(hub)), 250);
H.ready();
