// Page side of the desktop app (loaded by app/js/web/backend.js through JustWattsNative.hubModule): the device hub
// with the WebHub interface, plus the few things only an app needs: the device chooser, "riding" for keep-awake and
// quit confirmation, and the update prompt. Everything else is the website, unchanged.
import { WebHub } from '/js/web/ble.js';
import { desktopHubClass } from './hub-core.js';

const N = globalThis.JustWattsNative;

export function createHub({ store }) {
  const Hub = desktopHubClass(WebHub, N);
  const hub = new Hub({ store });
  setup();
  return hub;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const X = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';

function setup() {
  const ready = () => {
    document.body.classList.add('native-app');
    const css = document.createElement('style');
    css.textContent = `.native-app .getapp{display:none !important}
.jwup{position:fixed;right:16px;bottom:16px;z-index:30;display:none;align-items:center;gap:10px;padding:8px 8px 8px 14px;border:1px solid var(--line2);border-radius:10px;background:var(--side);font-size:13px}
.jwup.on{display:flex}`;
    document.head.appendChild(css);
    chooser(); updates();
  };
  if (document.body) ready(); else addEventListener('DOMContentLoaded', ready, { once: true });
  // riding: keeps the display awake, asks before quitting, holds updates
  let was = null;
  setInterval(() => {
    const on = !!globalThis.__hw?.backend?.engine?.ride?.started;
    if (on !== was) { was = on; N.setRiding(on); }
  }, 2000);
}

function chooser() {
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'btChooser';
  m.innerHTML = `<div class="panel dlg" role="dialog" aria-labelledby="btTitle">
    <div class="dhead"><b id="btTitle">Trainer</b><button class="x" data-c="cancel" aria-label="Close">${X}</button></div>
    <div class="devlist" id="btList"></div>
    <div class="dfoot"><span class="hint" id="btHint"></span><button data-c="cancel">Cancel</button></div></div>`;
  document.body.appendChild(m);
  const list = m.querySelector('#btList');
  const close = id => { if (!m.classList.contains('on')) return; m.classList.remove('on'); N.pick(id); };
  m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-c=cancel]')) return close('');
    const b = e.target.closest('[data-id]'); if (b) close(b.dataset.id);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && m.classList.contains('on')) { e.stopPropagation(); close(''); } }, true);
  N.onChooser(({ kind, devices, done }) => {
    if (done) { m.classList.remove('on'); return; }
    m.querySelector('#btTitle').textContent = kind === 'hr' ? 'Heart rate strap' : 'Trainer';
    m.querySelector('#btHint').textContent = kind === 'hr' ? 'Not listed? Wet the strap and put it on.' : 'Not listed? Pedal to wake it.';
    list.innerHTML = devices.length ? devices.map(d => `<button data-id="${esc(d.id)}"><span>${esc(d.name || 'Unnamed device')}</span></button>`).join('') : '<div class="hint">Searching…</div>';
    m.classList.add('on');
  });
}

function updates() {
  const bar = document.createElement('div');
  bar.className = 'jwup'; bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>Update ready</span><button class="pri">Restart</button>';
  document.body.appendChild(bar);
  let ready = false;
  const show = () => bar.classList.toggle('on', ready && !globalThis.__hw?.backend?.engine?.ride?.started);
  N.onUpdate(() => { ready = true; show(); });
  setInterval(show, 3000);
  bar.querySelector('button').onclick = () => N.restartToUpdate();
}
