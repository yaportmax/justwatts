// The desktop device hub against a mocked Bluetooth layer: the BLE host runs the web build's WebHub on the fake
// radio, the page's DesktopHub mirrors it over a fake IPC. Same FTMS bytes as server/justwatts/ftms.py
// (tests/test_ftms_devices.py) and app/js/web/ble.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIBD, cpBytes, WebHub } from '../../../app/js/web/ble.js';
import { hostSnapshot, hostCommand, hostChoose, desktopHubClass } from '../native/hub-core.js';
import { fakeBluetooth } from '../native/fake-ble.js';

const dv = bytes => new DataView(new Uint8Array(bytes).buffer);
const u16 = v => [v & 255, (v >> 8) & 255];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, what, ms = 2000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(5); } };

test('IBD parsing: Zwift Hub style (speed, cadence, power)', () => {
  assert.deepEqual(parseIBD(dv([0x44, 0x00, ...u16(3125), ...u16(180), ...u16(250)])), { speed: 31.25, cadence: 90, power: 250 });
});
test('IBD parsing: every skipped field, negative power clamps, HR', () => {
  const flags = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512;
  const b = [...u16(flags), ...u16(1), ...u16(170), ...u16(1), 1, 2, 3, ...u16(5), ...u16(-20 & 0xffff), ...u16(1), 0, 0, 0, 0, 0, 142];
  assert.deepEqual(parseIBD(dv(b)), { cadence: 85, power: 0, hr: 142 });
});
test('control point bytes', () => {
  assert.deepEqual(cpBytes({ k: 'erg', w: 250 }), [0x05, 250, 0]);
  assert.deepEqual(cpBytes({ k: 'erg', w: 300 }), [0x05, 0x2c, 0x01]);
  assert.deepEqual(cpBytes({ k: 'erg', w: 5000 }), [0x05, 0xd0, 0x07]);
  assert.deepEqual(cpBytes({ k: 'sim', g: 2.5 }), [0x11, 0, 0, 0xfa, 0x00, 40, 51]);
  assert.deepEqual(cpBytes({ k: 'sim', g: -1 }), [0x11, 0, 0, 0x9c, 0xff, 40, 51]);
  assert.deepEqual(cpBytes({ k: 'res', r: 3.4 }), [0x04, 34]);
});

// host + page wired through a fake IPC, like main.js does
function rig({ pick = list => list[0].id } = {}) {
  const store = new Map(), kv = { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); } };
  let picker = pick;
  const bt = fakeBluetooth({ select: async list => picker(list), intervalMs: 20 });
  globalThis.navigator ??= {};
  Object.defineProperty(globalThis.navigator, 'bluetooth', { value: bt, configurable: true });
  const host = new WebHub({ store: kv });
  const listeners = new Set();
  const push = () => { const s = hostSnapshot(host); for (const f of listeners) f(structuredClone(s)); };
  const timer = setInterval(push, 10);
  const native = {
    hubState: async () => structuredClone(hostSnapshot(host)),
    onHub: f => listeners.add(f),
    choose: async kind => structuredClone(await hostChoose(host, kind)),
    command: (op, arg) => hostCommand(host, structuredClone({ op, arg })),
  };
  const Page = desktopHubClass(WebHub, native);
  const page = new Page({ store: kv });
  return { bt, host, page, native, listeners, setPick: f => { picker = f; }, stop() { clearInterval(timer); bt.stop(); } };
}

test('connect, readings and ERG commands go through the host', async () => {
  const t = rig();
  try {
    await t.page.init();
    assert.equal(t.page.supported, true);
    await t.page.choose('trainer');
    assert.equal(t.page.mode, 'ble'); assert.equal(t.host.mode, 'ble');
    assert.deepEqual(t.bt.state.writes.slice(0, 2), [[0x00], [0x07]]);  // request control, start
    await until(() => t.page.r.power === 150 && t.page.r.cadence === 90, 'first readings');
    assert.equal(t.page.r.speed, 25);
    assert.ok(t.page.clock() - t.page.r.last < 1, 'reading age translated to the page clock');
    t.page.want({ k: 'erg', w: 230 });
    await until(() => t.bt.state.writes.some(w => w.join() === [0x05, 230, 0].join()), 'ERG target written');
    await until(() => t.page.r.power === 230, 'trainer follows');
    t.page.want({ k: 'sim', g: 2.5 });
    await until(() => t.bt.state.writes.at(-1).join() === [0x11, 0, 0, 0xfa, 0, 40, 51].join(), 'grade written');
    assert.deepEqual(t.page.status().trainer_name, 'Fake Trainer');
    assert.equal(t.page.status().trainer, 'ble');
  } finally { t.stop(); }
});

test('a new page (reload) picks up the live link without reconnecting', async () => {
  const t = rig();
  try {
    await t.page.init(); await t.page.choose('trainer'); await t.page.choose('hr');
    t.page.want({ k: 'erg', w: 200 });
    await until(() => t.page.r.hr === 132, 'hr');
    const connects = t.bt.state.connects, writes = t.bt.state.writes.length;
    t.listeners.clear();  // the old page is gone
    const Page = desktopHubClass(WebHub, t.native);
    const fresh = new Page({ store: { get: async () => null, set: async () => {} } });
    await fresh.init();
    assert.equal(fresh.mode, 'ble'); assert.equal(fresh.status().hr_connected, true); assert.equal(fresh.status().hr_name, 'Fake Strap');
    await until(() => fresh.r.power === 200 && fresh.r.hr === 132, 'readings in the new page');
    assert.equal(t.bt.state.connects, connects);
    assert.equal(t.bt.state.writes.length, writes, 'no control point traffic from the reload');
  } finally { t.stop(); }
});

test('cancelled chooser, disconnect, simulated trainer', async () => {
  const t = rig({ pick: () => '' });
  try {
    await t.page.init();
    await assert.rejects(t.page.choose('trainer'), /cancelled/);
    assert.equal(t.page.mode, 'none');
    t.setPick(list => list[0].id);
    await t.page.choose('trainer');
    // the simulated trainer lives in the page and lets the real one go
    t.page.setSim(true);
    assert.equal(t.page.mode, 'sim'); assert.equal(t.host.mode, 'none'); assert.equal(t.host.trainer, null);
    await sleep(40);
    assert.equal(t.page.mode, 'sim', 'host snapshots do not override sim');
    t.page.setSim(false);
    await until(() => t.page.mode === 'none', 'back to none');
    await t.page.choose('trainer');
    t.page.disconnect('trainer');
    assert.equal(t.host.mode, 'none'); assert.equal(t.page.mode, 'none');
    assert.deepEqual(t.page.r.power, 0);
    // choosing the trainer while simulated switches the sim off
    t.page.setSim(true); await t.page.choose('trainer');
    assert.equal(t.page.mode, 'ble');
  } finally { t.stop(); }
});
