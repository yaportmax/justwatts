// End-to-end: launches the app (dev, or a packaged build with --exe <path>) on a throwaway profile, with a local
// accounts API (memory store) and the mocked Bluetooth layer. Checks: the site loads, the views work, sign-up and
// sign-in go through the API proxy with cookies, the device chooser connects the (fake) trainer, a ride records,
// a page reload keeps both the ride and the trainer link (no reconnect), and the simulated trainer rides.
//   node e2e/smoke.mjs [--exe <packaged app>] [--shots <dir>] [--playwright <path to playwright index.mjs>]
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..'), repo = path.resolve(appDir, '../..');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const exe = arg('--exe'), shots = arg('--shots');
const pw = arg('--playwright');
const { _electron: electron } = pw ? await import(pathToFileURL(pw).href) : await import('playwright-core');
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };
const step = m => console.log('- ' + m);

/* ---------- a local justwatts.com API (accounts, sync, social) on a memory store ---------- */
Object.assign(process.env, { JUSTWATTS_STORE: 'memory', JUSTWATTS_SESSION_SECRET: 'e2e-'.repeat(12) });
const require = createRequire(import.meta.url);
const accounts = require(path.join(repo, 'web/api/_lib/app.js')).handler;
const server = createServer((req, res) => accounts(req, res));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const API = `http://localhost:${server.address().port}`;
process.env.PUBLIC_ORIGIN = API;

const profile = mkdtempSync(path.join(tmpdir(), 'jw-desktop-'));
const env = { ...process.env, JUSTWATTS_DESKTOP_PROFILE: profile, JUSTWATTS_FAKE_BLE: '1', JUSTWATTS_NO_UPDATE: '1', JUSTWATTS_API: API };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch(exe ? { executablePath: exe, args: [], env } : { args: [appDir], cwd: appDir, env });
let failed = null;
try {
  const findWin = async (pred, what) => {  // the main window, or the hidden Bluetooth host window
    for (let i = 0; i < 300; i++) {
      for (const w of app.windows()) { const u = await w.evaluate(() => location.href).catch(() => ''); if (u && pred(u)) return w; }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('no window: ' + what);
  };
  const page = await findWin(u => u.startsWith('app://justwatts/') && !u.includes('/__native/'), 'main');
  await page.waitForFunction(() => location.href.startsWith('app://justwatts/') && window.__hw?.backend, null, { timeout: 30000 });
  await page.setViewportSize?.({ width: 1360, height: 880 }).catch(() => {});
  step('loaded ' + await page.evaluate(() => location.href));
  const hub = () => page.evaluate(() => { const h = window.__hw.backend.hub; return { mode: h.mode, cls: h.constructor.name, power: h.r.power, hr: h.r.hr, status: h.status() }; });
  assert.equal((await hub()).cls, 'DesktopHub');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#webNotice')).display), 'none');  // Bluetooth is available
  assert.equal(await page.evaluate(() => !!document.querySelector('#getApp')), false);  // no "Desktop app" link inside the app
  await shot(page, 'desktop-workouts');

  // views
  for (const v of ['history', 'settings', 'ride', 'workouts']) {
    await page.click(`nav button[data-v="${v}"]`);
    await page.waitForFunction(v => document.querySelector('#v-' + v)?.classList.contains('on'), v);
    if (v === 'settings') await shot(page, 'desktop-settings');
  }
  step('views ok');

  // accounts through the proxy: sign up, the session cookie lives in the app's jar, survives a reload
  const api = (p, body) => page.evaluate(async ([p, body]) => {
    const r = await fetch(p, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-HW': '1' }, body: JSON.stringify(body) } : { credentials: 'same-origin' });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [p, body]);
  assert.equal((await api('/api/auth/providers')).body.accounts, true);
  const su = await api('/api/auth/signup', { email: 'rider@example.com', password: 'password123', name: 'Rider' });
  assert.equal(su.status, 201, JSON.stringify(su.body));
  assert.equal((await api('/api/auth/me')).body.user.email, 'rider@example.com');
  step('signed up through the proxy');

  // the trainer: Connect -> the app's chooser -> the fake trainer
  await page.click('#btnTrainer');
  await page.waitForSelector('#btChooser.on [data-id="fake-trainer"]', { timeout: 10000 });
  await page.waitForTimeout(300);  // fade-in
  await shot(page, 'desktop-chooser');
  await page.click('#btChooser [data-id="fake-trainer"]');
  await page.waitForFunction(() => window.__hw.backend.hub.mode === 'ble' && window.__hw.backend.hub.r.power > 0, null, { timeout: 10000 });
  step('trainer connected: ' + JSON.stringify((await hub()).status.trainer_name));
  await page.click('#btnHR');
  await page.waitForSelector('#btChooser.on [data-id="fake-hr"]', { timeout: 10000 });
  await page.click('#btChooser [data-id="fake-hr"]');
  await page.waitForFunction(() => window.__hw.backend.hub.status().hr_connected && window.__hw.backend.hub.r.hr === 132, null, { timeout: 10000 });
  step('HR strap connected');

  // ride: Just ride, a few seconds of samples, ERG/grade commands reach the trainer
  await page.click('#btnJust');
  await page.click('#cStart');
  await page.waitForFunction(() => (window.__hw.backend.engine.ride?.samples.length || 0) >= 3, null, { timeout: 20000 });
  const host = await findWin(u => u.includes('/__native/host.html'), 'BLE host');
  const fake = () => host.evaluate(() => { const s = navigator.bluetooth.state; return { connects: s.connects, writes: s.writes.length, last: s.writes.at(-1) }; });
  const f1 = await fake();
  assert.ok(f1.writes >= 3, JSON.stringify(f1));  // request control, start, a target
  await shot(page, 'desktop-ride');
  const n1 = await page.evaluate(() => window.__hw.backend.engine.ride.samples.length);
  step(`riding: ${n1} samples, ${f1.writes} control point writes`);

  // reload the page: the ride resumes from IndexedDB, the trainer link is untouched (same connection, no reconnect)
  await page.reload();
  await page.waitForFunction(() => window.__hw?.backend?.engine?.ride?.started, null, { timeout: 30000 });
  const afterReload = await hub();
  assert.equal(afterReload.mode, 'ble', JSON.stringify(afterReload));
  assert.ok(afterReload.status.hr_connected);
  const f2 = await fake();
  assert.equal(f2.connects, f1.connects, 'the trainer did not reconnect');
  // the resumed ride starts paused (auto) and picks up as soon as the trainer reports pedaling
  await page.waitForFunction(n => window.__hw.backend.engine.ride.samples.length > Math.max(n + 2, 11), n1, { timeout: 30000 });  // 10 samples to save a ride
  assert.equal((await api('/api/auth/me')).body.user.email, 'rider@example.com');
  await shot(page, 'desktop-after-reload');
  step('reload kept the ride, the trainer link and the session');

  // end the ride, then the simulated trainer rides too
  await page.evaluate(() => window.__hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify({ action: 'end' }) }));
  await page.waitForFunction(() => !window.__hw.backend.engine.ride?.started, null, { timeout: 10000 });
  await page.evaluate(() => window.__hw.backend.fetch('/api/devices', { method: 'POST', body: JSON.stringify({ action: 'sim', on: true }) }));
  assert.equal((await hub()).mode, 'sim');
  await page.waitForTimeout(800);
  assert.equal((await fake()).connects, f1.connects);
  assert.equal(await host.evaluate(() => window.__host.hub.mode), 'none');  // sim took over: the host let the trainer go
  await page.click('nav button[data-v="workouts"]');
  await page.click('#btnJust');
  await page.click('#cStart');
  await page.waitForFunction(() => (window.__hw.backend.engine.ride?.samples.length || 0) >= 12 && window.__hw.backend.hub.r.power > 0, null, { timeout: 30000 });
  step('simulated ride ok');
  await page.evaluate(() => window.__hw.backend.fetch('/api/ride/control', { method: 'POST', body: JSON.stringify({ action: 'end' }) }));
  await page.waitForFunction(() => !window.__hw.backend.engine.ride?.started, null, { timeout: 10000 });
  await page.click('nav button[data-v="history"]');
  await page.waitForTimeout(500);
  await shot(page, 'desktop-history');
  const rides = await page.evaluate(async () => (await (await window.__hw.backend.fetch('/api/rides')).json()).rides.length);
  assert.ok(rides >= 2, 'two rides in history: ' + rides);
  step(`history: ${rides} rides`);
} catch (e) {
  failed = e;
  for (const w of app.windows()) {  // diagnostics
    const d = await w.evaluate(() => ({ url: location.href, toast: document.querySelector('#toast')?.textContent, host: !!window.__host, hub: window.__host?.snapshot?.() || window.__hw?.backend?.hub?.status?.() })).catch(x => String(x));
    console.error(JSON.stringify(d));
  }
}
await app.close().catch(() => {});
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
if (failed) { console.error(failed); process.exit(1); }
console.log('e2e ok');
