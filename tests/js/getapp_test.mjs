// The website's "Desktop app" entry (app/js/web/getapp.js) on the built site: OS detection and order, the fixed
// release asset links, hidden in the app and on phones and tablets, /download opens the dialog.
//   node getapp_test.mjs <dist-web>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const dist = process.argv[2];
const els = new Map();
const el = (id = null) => {
  const e = { id, hidden: true, removed: false, className: '', innerHTML: '', listeners: {}, classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.removed = true; els.delete(this.id); } };
  if (id) els.set(id, e);
  return e;
};
globalThis.document = {
  getElementById: id => els.get(id) || null,
  createElement: () => el(),
  body: { appendChild(e) { if (e.id) els.set(e.id, e); } },
};
globalThis.addEventListener = () => {};
const m = await import(pathToFileURL(`${dist}/js/web/getapp.js`).href);
const ua = s => ({ userAgent: s, platform: '', maxTouchPoints: 0 });
const WIN = ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36');
const MAC = ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141 Safari/537.36');
const IPAD = { ...ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15'), maxTouchPoints: 5 };
const IPHONE = ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
const ANDROID = ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36');
assert.equal(m.detectOS(WIN), 'windows'); assert.equal(m.detectOS(MAC), 'mac'); assert.equal(m.detectOS(IPAD), 'ios');
assert.equal(m.detectOS(IPHONE), 'ios'); assert.equal(m.detectOS(ANDROID), 'android');
assert.equal(m.detectOS({ userAgent: 'x', userAgentData: { platform: 'macOS' } }), 'mac');
assert.equal(m.detectOS(ua('Mozilla/5.0 (X11; Linux x86_64)')), 'other');
assert.equal(m.detectOS({ ...WIN, platform: 'Win32', maxTouchPoints: 10 }), 'windows');  // touch screen laptop
assert.equal(m.detectOS({ ...MAC, platform: 'MacIntel', maxTouchPoints: 0 }), 'mac');
assert.equal(m.detectOS({ ...IPAD, platform: 'MacIntel' }), 'ios');
assert.deepEqual(m.order('mac'), ['mac', 'windows']); assert.deepEqual(m.order('windows'), ['windows', 'mac']); assert.deepEqual(m.order('other'), ['windows', 'mac']);
assert.equal(m.DOWNLOADS.windows.url, 'https://github.com/yaportmax/justwatts/releases/latest/download/JustWatts-Setup.exe');
assert.equal(m.DOWNLOADS.mac.url, 'https://github.com/yaportmax/justwatts/releases/latest/download/JustWatts.dmg');

// desktop browser: the link shows; /download opens the dialog with the visitor's OS first
let link = el('getApp');
assert.equal(m.initGetApp({ nav: MAC, loc: { pathname: '/' } }), true);
assert.equal(link.hidden, false); assert.equal(els.get('appModal'), undefined);
els.clear(); link = el('getApp');
assert.equal(m.initGetApp({ nav: MAC, loc: { pathname: '/download' } }), true);
const dlg = els.get('appModal');
assert.ok(dlg.classList.contains('on'));
assert.ok(dlg.innerHTML.indexOf('data-os="mac"') < dlg.innerHTML.indexOf('data-os="windows"'));
assert.ok(dlg.innerHTML.includes('More stable Bluetooth connection.'));
els.clear(); el('getApp'); m.initGetApp({ nav: WIN, loc: { pathname: '/download' } });
assert.ok(els.get('appModal').innerHTML.indexOf('data-os="windows"') < els.get('appModal').innerHTML.indexOf('data-os="mac"'));
// phones and tablets, and inside the app: no link
for (const nav of [IPAD, IPHONE, ANDROID]) { els.clear(); link = el('getApp'); assert.equal(m.initGetApp({ nav, loc: { pathname: '/' } }), false); assert.ok(link.removed); }
// no Web Bluetooth: the banner names the browser and says what to do on that device (Chrome or Edge or the desktop app; Bluefy on iOS)
const SAFARI = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };
assert.match(m.bluetoothNotice(SAFARI), /Safari can't connect.*Chrome or Edge.*desktop app/);
assert.match(m.bluetoothNotice({ ...IPHONE, userAgent: IPHONE.userAgent + ' CriOS/126.0' }), /Chrome can't connect.*Bluefy/);
assert.match(m.bluetoothNotice({ userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0', platform: 'Linux armv8l' }), /Firefox can't connect.*in Chrome/);
assert.equal(m.bluetoothNotice({ ...WIN, bluetooth: {} }), null);
{ els.clear(); const n = el('webNotice'); n.style = { display: 'none' }; n.querySelector = () => null; assert.equal(m.initBluetoothNotice({ nav: SAFARI }), true); assert.equal(n.style.display, ''); assert.match(n.innerHTML, /Safari/); }
globalThis.JustWattsNative = {};
els.clear(); link = el('getApp'); assert.equal(m.initGetApp({ nav: WIN, loc: { pathname: '/download' } }), false); assert.ok(link.removed);
console.log(JSON.stringify({ getapp: 'ok' }));
