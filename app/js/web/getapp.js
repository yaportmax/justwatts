// "Desktop app" on the website (sidebar, under the device buttons) and /download: one small dialog with the two
// installers, the visitor's own OS first. Hidden in the desktop app itself and in the local server app. The links
// are GitHub's "latest release" URLs with fixed asset names, so they never change between releases.
import { MODE } from '../mode.js';

const REL = 'https://github.com/yaportmax/justwatts/releases/latest/download/';
export const DOWNLOADS = {
  windows: { label: 'Windows', url: REL + 'JustWatts-Setup.exe' },
  mac: { label: 'Mac', url: REL + 'JustWatts.dmg' },
};

// 'windows' | 'mac' | 'ios' | 'android' | 'other'
export function detectOS(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || ''), plat = String(nav?.userAgentData?.platform || nav?.platform || '');
  const mac = plat ? /Mac/i.test(plat) : /Macintosh|Mac OS X/.test(ua);
  if (/iPhone|iPad|iPod/.test(ua) || (mac && nav?.maxTouchPoints > 1)) return 'ios';  // iPadOS Safari says "Macintosh"
  if (/Android/i.test(ua)) return 'android';
  if (plat ? /Win/i.test(plat) : /Windows/.test(ua)) return 'windows';
  return mac ? 'mac' : 'other';
}
export function order(os) { return os === 'mac' ? ['mac', 'windows'] : ['windows', 'mac']; }

export function dialog(os) {
  let m = document.getElementById('appModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal'; m.id = 'appModal';
    m.innerHTML = `<div class="panel dlg" role="dialog" aria-labelledby="appTitle">
      <div class="dhead"><b id="appTitle">Desktop app</b><button class="x" data-a="close" aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>
      <div class="hint">More stable Bluetooth connection.</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">${order(os).map((k, i) => `<button class="${i ? '' : 'pri'}" data-os="${k}" data-url="${DOWNLOADS[k].url}">${DOWNLOADS[k].label}</button>`).join('')}</div>
    </div>`;
    m.addEventListener('click', e => {
      const d = e.target.closest('[data-url]');
      if (d) { location.href = d.dataset.url; return; }
      if (e.target === m || e.target.closest('[data-a=close]')) m.classList.remove('on');
    });
    addEventListener('keydown', e => { if (e.key === 'Escape') m.classList.remove('on'); });
    document.body.appendChild(m);
  }
  m.classList.add('on');
}

export function initGetApp({ doc = globalThis.document, nav = globalThis.navigator, loc = globalThis.location } = {}) {
  const link = doc?.getElementById('getApp');
  if (!link) return false;
  const os = detectOS(nav);
  if (MODE !== 'web' || globalThis.JustWattsNative || os === 'ios' || os === 'android') { link.remove(); return false; }
  link.hidden = false;
  link.addEventListener('click', e => { e.preventDefault(); dialog(os); });
  if (loc?.pathname === '/download') dialog(os);
  return true;
}

// The browser's name for the no-Bluetooth banner: Safari and Firefox ship no Web Bluetooth (on iPhone and iPad no browser
// does: all of them are Safari underneath)
export function browserName(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox';
  if (/CriOS/.test(ua)) return 'Chrome';
  if (/EdgiOS|Edg\//.test(ua)) return 'Edge';
  if (/Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua)) return 'Safari';
  return 'This browser';
}

// The banner when there is no Web Bluetooth: what to do on this device. Returns its HTML (null: Bluetooth is there).
export function bluetoothNotice(nav = globalThis.navigator) {
  if (nav?.bluetooth) return null;
  const os = detectOS(nav), b = browserName(nav), cant = `<b>${b} can't connect to Bluetooth trainers.</b>`;
  if (os === 'ios') return `${cant} On iPhone and iPad no browser can, Chrome included. Use the Bluefy app from the App Store, or ride on a computer.`;
  if (os === 'android') return `${cant} Open justwatts.com in Chrome.`;
  return `${cant} Switch to Chrome or Edge, or <a href="/download" data-a="getapp">download the desktop app</a>.`;
}

export function initBluetoothNotice({ doc = globalThis.document, nav = globalThis.navigator } = {}) {
  const el = doc?.getElementById('webNotice'), html = MODE === 'web' && !globalThis.JustWattsNative ? bluetoothNotice(nav) : null;
  if (!el || !html) return false;
  el.innerHTML = html; el.style.display = '';
  el.querySelector('[data-a=getapp]')?.addEventListener('click', e => { e.preventDefault(); dialog(detectOS(nav)); });
  return true;
}

if (globalThis.document) { initGetApp(); initBluetoothNotice(); }
