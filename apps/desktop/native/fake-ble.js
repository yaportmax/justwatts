// A mocked Web Bluetooth layer for tests (JUSTWATTS_FAKE_BLE=1 and the unit tests): one FTMS trainer and one heart
// rate strap. The trainer answers control point writes like an FTMS device and reports the ERG target as power.
// Every control point write is kept in `writes` so tests can check the exact bytes.

class Char extends EventTarget {
  constructor(onWrite) { super(); this.value = null; this.onWrite = onWrite; this.notifying = false; }
  async startNotifications() { this.notifying = true; return this; }
  async writeValueWithResponse(bytes) { await this.onWrite?.([...new Uint8Array(bytes.buffer || bytes)]); }
  emit(bytes) { if (!this.notifying) return; this.value = new DataView(new Uint8Array(bytes).buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); }
}

export function fakeBluetooth({ select = async list => list[0]?.id || '', intervalMs = 250 } = {}) {
  const state = { writes: [], erg: 0, connects: 0, timers: [] };
  function makeTrainer() {
    const d = new EventTarget();
    d.id = 'fake-trainer'; d.name = 'Fake Trainer';
    const ibd = new Char(), cp = new Char(async b => {
      state.writes.push(b);
      if (b[0] === 0x05) state.erg = b[1] | (b[2] << 8);
      queueMicrotask(() => cp.emit([0x80, b[0], 0x01]));  // success
    });
    const tick = () => {
      if (!d.gatt.connected) return;
      const w = state.erg || 150, cad = 90;  // flags: cadence (bit 2) + power (bit 6); speed present (bit 0 clear)
      ibd.emit([0x44, 0x00, 0xc4, 0x09, cad * 2 & 255, (cad * 2) >> 8, w & 255, (w >> 8) & 255]);
    };
    d.gatt = {
      connected: false,
      async connect() { this.connected = true; state.connects++; state.timers.push(setInterval(tick, intervalMs)); return this; },
      disconnect() { this.connected = false; d.dispatchEvent(new Event('gattserverdisconnected')); },
      async getPrimaryService() { return { getCharacteristic: async uuid => (uuid === 0x2ad2 ? ibd : cp) }; },
    };
    d.ibd = ibd; d.cp = cp;
    return d;
  }
  function makeStrap() {
    const d = new EventTarget();
    d.id = 'fake-hr'; d.name = 'Fake Strap';
    const hrm = new Char();
    d.gatt = {
      connected: false,
      async connect() { this.connected = true; state.timers.push(setInterval(() => d.gatt.connected && hrm.emit([0x00, 132]), intervalMs)); return this; },
      disconnect() { this.connected = false; d.dispatchEvent(new Event('gattserverdisconnected')); },
      async getPrimaryService() { return { getCharacteristic: async () => hrm }; },
    };
    return d;
  }
  const devices = { 'fake-trainer': makeTrainer(), 'fake-hr': makeStrap() };
  return {
    state, devices,
    async requestDevice(opts) {
      const hr = JSON.stringify(opts).includes('heart_rate');
      const list = hr ? [{ id: 'fake-hr', name: 'Fake Strap' }] : [{ id: 'fake-trainer', name: 'Fake Trainer' }];
      const id = await select(list);
      if (!id || !devices[id]) throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
      return devices[id];
    },
    stop() { for (const t of state.timers) clearInterval(t); },
  };
}
