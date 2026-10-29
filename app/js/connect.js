// Integrations UI: Settings > Integrations, the ride summary Upload panel, the Today row data and the
// "Connect your services" step. API: docs/INTEGRATIONS.md (local /api/integrations, web /api/integrations?op=).
// Secrets go to the server once and are never shown again: inputs are cleared after every submit.
//
// Shared entry points (window.justwatts):
//   openConnectServices()  the connect step (Garmin first). The account UI calls it right after sign-up.
//   openSignIn()           provided by the account UI. Until it exists, "Sign in" opens Settings at #set-account
//                          (or says accounts are not available yet).
import { esc } from './core.js';
import { track } from './analytics.js';

const UPLOADERS = ['garmin', 'strava', 'trainingpeaks', 'intervals'], PLANS = ['trainingpeaks', 'intervals'];
const SHORT = { garmin: 'Garmin', strava: 'Strava', trainingpeaks: 'TrainingPeaks', intervals: 'intervals.icu', coros: 'COROS', polar: 'Polar', suunto: 'Suunto', wahoo: 'Wahoo' };
const OPEN = { garmin: 'Open Garmin Connect', strava: 'Open Strava', trainingpeaks: 'Open TrainingPeaks', intervals: 'Open intervals.icu', coros: 'Open COROS Training Hub' };
// Manual routes, a copy of server/justwatts/integrations/base.py MANUAL (tests/test_integrations_web.py keeps them equal):
// the page needs them signed out or offline, when the API cannot answer.
export const MANUAL = {
  garmin: {"url": "https://connect.garmin.com/modern/import-data", "steps": ["1. Download the .fit file.", "2. Open Garmin Connect Import Data.", "3. Drop the file in and click Import Data."], "help_url": null, "supported": true, "app_only": false},
  strava: {"url": "https://www.strava.com/upload/select", "steps": ["1. Download the .fit file.", "2. Open Strava Upload.", "3. Choose the file."], "help_url": "https://support.strava.com/hc/en-us/articles/216917807-Uploading-Files-to-Strava", "supported": true, "app_only": false},
  trainingpeaks: {"url": "https://app.trainingpeaks.com/#calendar", "steps": ["1. Download the .fit file.", "2. Open your TrainingPeaks calendar.", "3. Drag the file onto the calendar."], "help_url": "https://help.trainingpeaks.com/hc/en-us/articles/204072994-How-do-I-manually-Upload-a-workout-file-into-TrainingPeaks", "supported": true, "app_only": false},
  intervals: {"url": "https://intervals.icu/activities", "steps": ["1. Download the .fit file.", "2. Open intervals.icu Activities.", "3. Click the upload arrow and drop the file in."], "help_url": null, "supported": true, "app_only": false},
  coros: {"url": "https://t.coros.com/", "steps": ["1. Download the .fit file.", "2. Open COROS Training Hub, Activity List.", "3. Click Import Data and choose the file."], "help_url": "https://support.coros.com/hc/en-us/articles/4412176269844-COROS-Training-Hub-Manual", "supported": true, "app_only": false},
  polar: {"url": null, "steps": ["Polar Flow has no file import.", "Upload to Garmin Connect or Strava instead."], "help_url": "https://support.polar.com/en/export-training-sessions-flow", "supported": false, "app_only": false},
  suunto: {"url": null, "steps": ["The Suunto app has no workout file import.", "Upload to Garmin Connect or Strava instead."], "help_url": "https://us.suunto.com/pages/what-type-of-files-can-i-export-from-the-suunto-app", "supported": false, "app_only": false},
  wahoo: {"url": null, "steps": ["1. Download the .fit file to your phone.", "2. Open the Wahoo app, Add Activity.", "3. Tap Upload and choose the file."], "help_url": "https://support.wahoofitness.com/hc/en-us/articles/18790709768850", "supported": true, "app_only": true},
};
const NAMES = {"garmin": "Garmin Connect", "strava": "Strava", "trainingpeaks": "TrainingPeaks", "intervals": "intervals.icu", "coros": "COROS", "polar": "Polar", "suunto": "Suunto", "wahoo": "Wahoo"};
const short = id => SHORT[id] || id;
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const when = ms => { const d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };

let inst = null, queued = null;
export function openConnectServices(opts = {}) { if (inst) return inst.openConnectServices(opts); queued = opts; }
globalThis.justwatts = Object.assign(globalThis.justwatts || {}, { openConnectServices });

export function createConnect({ $, F, WEB, toast, fitOf, downloadFit, onPlanned = () => {}, onChange = () => {}, stravaSetup = () => {} }) {
  const st = { rows: null, signedOut: false, unavailable: false, planned: null, plannedDay: '' };
  const NET = (p, o) => (globalThis.__justwattsWeb?.net || globalThis.fetch)(p, { credentials: 'same-origin', ...o });

  /* ---------- API: one shape for the local server and the web functions ---------- */
  async function call(method, local, op, q = {}, body = null) {
    let r;
    try {
      const post = method === 'POST', bin = body instanceof Uint8Array;
      const o = post ? { method, headers: { 'X-HW': '1', 'Content-Type': bin ? 'application/octet-stream' : 'application/json' }, body: bin ? body : JSON.stringify(body || {}) } : { headers: { 'X-HW': '1' } };
      r = WEB ? await NET('/api/integrations?' + new URLSearchParams({ op, ...q }), o) : await F(local, o);
    } catch { if (WEB) st.unavailable = true; return { ok: false, status: 0, body: { error: 'offline' } }; }
    const j = await r.json().catch(() => ({}));
    if (WEB) { st.signedOut = r.status === 401 ? true : r.ok ? false : st.signedOut; st.unavailable = r.status === 503 || (st.unavailable && !r.ok); }
    return { ok: r.ok, status: r.status, body: j };
  }
  const api = {
    list: () => call('GET', '/api/integrations', 'list'),
    connect: (svc, fields, rid) => call('POST', `/api/integrations/${svc}/connect`, 'connect', { service: svc }, { ...fields, ...(rid ? { ride_id: rid } : {}) }),
    disconnect: svc => call('POST', `/api/integrations/${svc}/disconnect`, 'disconnect', { service: svc }, {}),
    auto: (svc, on) => call('POST', `/api/integrations/${svc}/auto`, 'auto', { service: svc }, { on }),
    syncs: list => call('POST', '/api/integrations/garmin/syncs', 'syncs', {}, { syncs_to: list }),
    targets: rid => call('GET', `/api/rides/${rid}/targets`, 'targets', { ride: rid }),
    retry: (rid, svc) => call('POST', `/api/rides/${rid}/uploads/${svc}`, 'retry', { ride: rid, ...(svc ? { service: svc } : {}) }, {}),
    planned: d => call('GET', `/api/integrations/planned?date=${d}`, 'planned', { date: d }),
  };
  // web: the FIT goes up once per ride (the server keeps it for retries); services = a manual Upload press
  async function postFit(rid, services) {
    const f = await fitOf(rid); if (!f) return { ok: false, body: { error: 'no ride' } };
    const q = { ride: rid, name: f.name || 'Just Watts ride', start: String(f.start || ''), duration: String(f.duration || ''), local: f.local || '' };
    if (services) q.services = services.join(',');
    return call('POST', null, 'upload', q, f.bytes);
  }

  async function load() {
    const r = await api.list();
    st.rows = r.ok ? r.body.integrations : st.rows && !WEB ? st.rows : null;
    return st.rows;
  }
  const row = id => st.rows?.find(x => x.id === id);
  const anyPlanned = () => (st.rows || []).some(x => x.caps?.planned && x.status?.connected);

  /* ---------- sign in (web) ---------- */
  function signIn() {
    const f = globalThis.justwatts?.openSignIn;
    if (typeof f === 'function') return f({ then: 'connect' });
    const sec = document.getElementById('set-account');
    if (sec) { location.hash = '#settings'; sec.scrollIntoView?.({ behavior: 'smooth' }); return; }
    toast('Accounts are not available yet. Use the .fit file for now.');
  }

  /* ---------- pieces shared by Settings and the panel ---------- */
  function manualHtml(id, m = MANUAL[id]) {
    if (!m) return '';
    const link = m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" data-manual="${esc(id)}">${esc(OPEN[id] || 'Open ' + short(id))}</a>`
      : m.help_url ? `<a href="${esc(m.help_url)}" target="_blank" rel="noopener" data-manual="${esc(id)}">${esc(short(id))} help</a>` : '';
    const tag = /^\d\./.test(m.steps[0] || '') ? 'ol' : 'ul';
    return `<${tag} class="steps">${m.steps.map(s => `<li>${esc(s.replace(/^\d\.\s*/, ''))}</li>`).join('')}</${tag}>${link ? `<div class="mlink">${link}</div>` : ''}`;
  }
  // unofficial: the owner's note, with its last words as the FIT link (in a ride) and the manual route
  function tipHtml(r, rid) {
    if (r.official || !r.unofficial_note) return '';
    const lead = r.unofficial_note.replace(/\s*If it does, upload the \.fit file manually:\s*$/, '');
    const fit = rid ? `<a href="#" data-fit="${esc(r.id)}">upload the .fit file manually</a>` : 'upload the .fit file manually';
    return `<span class="tip" tabindex="0">Unofficial<span class="pop" role="tooltip">${esc(lead)} If it does, ${fit}:${manualHtml(r.id, r.manual)}</span></span>`;
  }
  function statusLine(r) {
    if (r.connect === null || r.caps?.manual_only || r.manual_only) return '';
    const s = r.status || {};
    if (r.id === 'garmin' && s.enabled === false) return '<span class="warn">Off on this server</span>';
    if (r.needs_reconnect) return '<span class="warn">Signed out. Reconnect.</span>';
    if (!s.connected) return r.recommended ? esc(r.recommended_reason || '') : r.synced_by_garmin ? 'Garmin already sends rides here' : r.caps?.planned ? 'Uploads rides, brings in planned workouts' : 'Uploads rides';
    const bits = [`<span class="ok">Connected${s.account ? ' as ' + esc(s.account) : ''}</span>`];
    const le = r.last_error, ls = r.last_success;
    if (le && (!ls || le.at > ls.at)) bits.push(`<span class="${le.final ? 'bad' : 'warn'}">Last upload ${le.final ? 'failed' : 'retrying'}${le.error ? ': ' + esc(le.error) : ''}</span>`);
    else if (ls) bits.push(`Last upload ${esc(when(ls.at))}`);
    return bits.join(' · ');
  }

  /* ---------- Settings > Integrations ---------- */
  async function renderSettings() {
    const box = $('#intList'); if (!box) return;
    await load();
    const rows = st.rows || [];
    $('#intSignin').style.display = WEB && (st.signedOut || st.unavailable) ? '' : 'none';
    $('#intSigninBtn').style.display = st.signedOut || !st.unavailable ? '' : 'none';
    $('#intSigninTxt').textContent = st.unavailable && !st.signedOut ? 'Services are not available right now. Upload the .fit file by hand.' : 'Sign in to connect services. Until then, upload the .fit file by hand.';
    const auto = rows.filter(r => r.connect && !r.caps?.manual_only), manual = rows.filter(r => !r.connect || r.caps?.manual_only);
    const live = !(WEB && (st.signedOut || st.unavailable));
    box.innerHTML = (live ? auto : []).map(r => settingsRow(r)).join('')
      + `<div class="ihead">Upload by hand</div>` + (live ? manual : rows.length ? rows : FALLBACK_ROWS).map(r => manualRow(r)).join('');
  }
  function settingsRow(r) {
    const s = r.status || {}, on = !!s.connected, off = r.id === 'garmin' && s.enabled === false;
    const strNoApp = r.id === 'strava' && s.configured === false;
    const ctl = on ? `<select data-auto="${r.id}" aria-label="${esc(short(r.id))} uploads"><option value="1"${r.auto ? ' selected' : ''}>Auto upload</option><option value="0"${r.auto ? '' : ' selected'}>Manual</option></select>`
      + (r.needs_reconnect ? `<button class="pri" data-conn="${r.id}">Reconnect</button>` : '') + `<button class="ghost" data-disc="${r.id}">Disconnect</button>`
      : strNoApp ? `<button data-stsetup="1">Set up</button>` : `<button class="${r.recommended ? 'pri' : ''}" data-conn="${r.id}"${off ? ' disabled' : ''}>Connect</button>`;
    let extra = '';
    if (r.id === 'garmin' && on) {
      const syncs = r.syncs_to || [], q = SYNC_Q;
      extra = `<div class="isyncs"><span>${esc(q.text)}</span>${q.options.map(o => `<label class="chk"><input type="checkbox" data-sync="${o.id}"${syncs.includes(o.id) ? ' checked' : ''}>${esc(o.label)}</label>`).join('')}</div>`;
    }
    if (r.duplicate_risk && r.duplicate_warning) extra += `<div class="warnbox hot">${esc(r.duplicate_warning)}</div>`;
    return `<div class="irow" data-svc="${r.id}"><div class="imain"><div class="iname"><i class="dot${on ? r.needs_reconnect ? ' wait' : ' on' : ''}"></i>${esc(r.name)}${r.recommended ? '<span class="rec">Recommended</span>' : ''}${tipHtml(r)}</div>
      <div class="isub">${statusLine(r)}</div>${extra}</div><div class="sc">${ctl}</div></div>`;
  }
  function manualRow(r) {
    return `<details class="irow man" data-svc="${r.id}"><summary><span class="iname">${esc(r.name)}</span><span class="isub">${r.manual?.supported === false ? 'No file import' : r.manual?.app_only ? 'Phone app' : ''}</span><span class="grow"></span><span class="how">How</span></summary>${manualHtml(r.id, r.manual)}</details>`;
  }
  async function settingsClick(e) {
    const t = e.target?.closest?.('[data-conn],[data-disc],[data-stsetup],[data-manual],[data-fit]'); if (!t) return;
    if (t.dataset.conn) return openForm(t.dataset.conn);
    if (t.dataset.stsetup) return stravaSetup();
    if (t.dataset.manual) return track('manual_upload', { service: t.dataset.manual });
    if (t.dataset.disc) {
      const svc = t.dataset.disc; t.disabled = true;
      const r = await api.disconnect(svc);
      if (r.ok) { st.rows = r.body.integrations; toast(`${short(svc)} disconnected`); } else toast(r.body.error || 'Could not disconnect');
      refresh();
    }
  }
  async function settingsChange(e) {
    const t = e.target;
    if (t?.dataset?.auto) {
      const r = await api.auto(t.dataset.auto, t.value === '1');
      if (r.ok) st.rows = r.body.integrations; else toast(r.body.error || 'Not saved');
      refresh();
    } else if (t?.dataset?.sync) {
      const list = [...document.querySelectorAll('[data-sync]')].filter(x => x.checked).map(x => x.dataset.sync);
      const r = await api.syncs(list);
      if (r.ok) st.rows = r.body.integrations; refresh();
    }
  }
  const SYNC_Q = { text: 'Garmin also sends rides to', options: [{ id: 'strava', label: 'Strava' }, { id: 'trainingpeaks', label: 'TrainingPeaks' }, { id: 'other', label: 'other' }] };
  const FALLBACK_ROWS = Object.keys(MANUAL).map(id => ({ id, name: NAMES[id], manual: MANUAL[id], connected: false, manual_only: true }));

  /* ---------- connect forms (one dialog, a step at a time) ---------- */
  const F_ = { svc: null, rid: null, step: 'creds', after: null };
  function openForm(svc, rid = null, after = null) {
    const r = row(svc);
    if (WEB && (st.signedOut || st.unavailable)) return signIn();
    if (!r?.connect) return;
    if (r.connect.kind === 'oauth') {  // Strava: the existing OAuth flow
      if (r.status?.configured === false) return stravaSetup();
      track('integration_connect', { service: svc, ok: 'started' });
      location.href = r.connect.url || '/api/strava/connect'; return;
    }
    Object.assign(F_, { svc, rid, step: 'creds', after });
    formRender(); $('#connModal').classList.add('on');
    setTimeout(() => $('#connModal').querySelector('input,textarea')?.focus?.(), 30);
  }
  const closeForm = () => { $('#connModal').classList.remove('on'); clearSecrets(); };
  const clearSecrets = () => { for (const i of $('#connBody').querySelectorAll?.('input,textarea') || []) if (i.type !== 'checkbox') i.value = ''; };
  const field = (name, label, o = {}) => `<label class="f">${esc(label)}<input name="${name}" ${o.secret ? 'type="password" autocomplete="off"' : `type="${o.type || 'text'}" autocomplete="${o.ac || 'off'}"`} spellcheck="false"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}></label>`;
  function formRender() {
    const { svc, step } = F_, r = row(svc), body = $('#connBody');
    $('#connTitle').textContent = step === 'question' ? 'Garmin connected' : `Connect ${short(svc)}`;
    $('#connErr').textContent = '';
    let h = '', go = 'Connect';
    if (svc === 'garmin' && step === 'creds') {
      h = field('email', 'Email', { type: 'email', ac: 'username' }) + field('password', 'Password', { secret: true })
        + '<div class="hint">Sent to Garmin once. Only Garmin\'s sign-in token is kept.</div>';
    } else if (svc === 'garmin' && step === 'mfa') {
      h = field('mfa_code', 'Code from Garmin', { ph: '123456' }) + '<div class="hint">Garmin sent it by email or text.</div>'; go = 'Verify';
    } else if (step === 'question') {
      const q = r?.syncs_question || F_.question || SYNC_Q;
      h = `<p class="q">${esc(q.text)}</p><div class="chks">${q.options.map(o => `<label class="chk"><input type="checkbox" name="sync" value="${o.id}">${esc(o.label)}</label>`).join('')}</div>`
        + '<div class="hint">Ticked services get no direct upload, so rides are not duplicated. Change it any time in Settings.</div>'; go = 'Done';
    } else if (svc === 'trainingpeaks') {
      h = `<ol class="steps"><li>Sign in at <a href="https://app.trainingpeaks.com" target="_blank" rel="noopener">app.trainingpeaks.com</a>.</li><li>Press F12, open Application, then Cookies.</li><li>Copy the value of <b>Production_tpAuth</b>.</li></ol>`
        + field('cookie', 'Cookie value', { secret: true, ph: 'Paste here' });
    } else if (svc === 'intervals') {
      h = field('athlete_id', 'Athlete ID', { ph: 'i12345' }) + field('api_key', 'API key', { secret: true })
        + '<div class="hint">Both are in <a href="https://intervals.icu/settings" target="_blank" rel="noopener">intervals.icu Settings</a>, Developer Settings.</div>';
    }
    body.innerHTML = h + (step === 'creds' && r && !r.official ? `<div class="hint">${tipHtml(r, F_.rid)}</div>` : '');
    setTimeout(() => body.querySelector?.('input')?.focus?.(), 30);
    $('#connGo').textContent = go;
    $('#connGo').disabled = false;
  }
  async function formSubmit() {
    const { svc, rid } = F_, body = $('#connBody'), go = $('#connGo');
    if (F_.step === 'question') {
      const list = [...body.querySelectorAll('input[name=sync]')].filter(x => x.checked).map(x => x.value);
      const r = await api.syncs(list); if (r.ok) st.rows = r.body.integrations;
      closeForm(); refresh(); F_.after?.(); return;
    }
    const fields = {};
    for (const i of body.querySelectorAll('input,textarea')) if (i.name) fields[i.name] = i.value.trim();
    if (Object.values(fields).some(v => !v)) { $('#connErr').textContent = 'Fill in every field.'; return; }
    go.disabled = true; go.textContent = F_.step === 'mfa' ? 'Verifying…' : 'Connecting…';
    let r = await api.connect(svc, fields, rid);
    clearSecrets();
    if (r.ok && r.body.upload_needed && rid && WEB) await postFit(rid, [svc]);
    go.disabled = false;
    if (!r.ok) {
      formRender(); $('#connErr').textContent = r.body.error || 'Could not connect';
      track('integration_connect', { service: svc, ok: 0 }); return;
    }
    if (r.body.mfa_required) { F_.step = 'mfa'; formRender(); return; }
    track('integration_connect', { service: svc, ok: 1 });
    if (rid) track('upload', { service: svc, result: r.body.upload?.state || (r.body.upload_needed ? 'queued' : 'none') });
    await load(); refresh();
    toast(rid ? `${short(svc)} connected. Uploading this ride.` : `${short(svc)} connected`);
    if (svc === 'garmin' && r.body.question) { F_.step = 'question'; F_.question = r.body.question; formRender(); return; }
    closeForm(); F_.after?.();
  }

  /* ---------- the ride summary: Upload button, status line, panel ---------- */
  const P = { rid: null, t: null, poll: null, man: 'garmin', mode: 'ride' };
  async function loadTargets(rid) {
    if (WEB && !(st.signedOut || st.unavailable)) {
      let r = await api.targets(rid);
      if (r.ok && r.body.targets.some(t => t.upload?.state === 'pending' && t.upload.next_retry_at && t.upload.next_retry_at <= Date.now())) r = await api.retry(rid);
      return r.ok ? r.body : null;
    }
    if (WEB) return null;
    const r = await api.targets(rid); return r.ok ? r.body : null;
  }
  const stateOf = u => !u ? null : u.state === 'done' ? (u.duplicate ? 'there' : 'done') : u.state === 'failed' ? 'failed' : u.kind ? 'retrying' : 'uploading';
  const WORD = { done: 'Uploaded', there: 'Already there', failed: 'Failed', retrying: 'Retrying', uploading: 'Uploading…' };
  // the summary: the Upload button's label and a one-line status per connected service; Garmin nudge
  async function renderSummary(rid, { fresh = false } = {}) {
    P.rid = rid;
    const t = await loadTargets(rid); if (P.rid !== rid) return;
    P.t = t;
    const btn = $('#sUpload'), line = $('#sUpLine'), nudge = $('#sNudge');
    const conn = (t?.targets || []).filter(x => x.connected && !x.manual_only), ups = conn.map(x => stateOf(x.upload));
    const bad = ups.includes('failed'), busy = ups.some(s => s === 'uploading' || s === 'retrying'), done = conn.length && ups.every(s => s === 'done' || s === 'there');
    btn.textContent = bad ? 'Upload failed' : busy ? 'Uploading…' : done ? 'Uploaded' : 'Upload';
    btn.className = bad ? 'warn' : done ? 'done' : 'pri';
    line.innerHTML = conn.filter(x => x.upload).map(x => {
      const s = stateOf(x.upload), u = x.upload;
      const act = u.action === 'reconnect' ? `<button class="link" data-act="reconnect" data-svc="${x.id}">Reconnect</button>`
        : u.action === 'retry' || (s === 'retrying') ? `<button class="link" data-act="retry" data-svc="${x.id}">Retry</button>`
          : u.action === 'download_fit' ? `<button class="link" data-act="manual" data-svc="${x.id}">Upload by hand</button>` : '';
      const name = u.url ? `<a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(short(x.id))}</a>` : esc(short(x.id));
      return `<span class="us ${s}"><i></i>${name} <em>${WORD[s]}</em>${act}</span>`;
    }).join('');
    line.style.display = line.innerHTML ? '' : 'none';
    const g = t?.targets.find(x => x.id === 'garmin');
    const showNudge = !!g && !g.connected && !nudgeOff() && (fresh || (await rideCount()) >= 1) && g.connect;
    nudge.style.display = showNudge && !(WEB && st.unavailable) ? '' : 'none';
    if (busy) { clearTimeout(P.poll); P.poll = setTimeout(() => { if (P.rid === rid && document.getElementById?.('summary')?.style.display !== 'none') { renderSummary(rid); if ($('#upPanel').classList.contains('on')) panelRender(); } }, WEB || !ups.includes('uploading') ? 15000 : 2500); }
    if ($('#upPanel').classList.contains('on') && P.mode === 'ride') panelRender();
  }
  const nudgeOff = () => { try { return localStorage.getItem('hw.garminNudge') === '"off"'; } catch { return false; } };
  let rides = null; const rideCount = async () => { if (rides === null) { try { rides = (await (await F('/api/rides')).json()).rides.length; } catch { rides = 0; } } return rides; };

  function openPanel(mode = 'ride') {
    P.mode = mode; $('#upPanel').classList.add('on');
    $('#upTitle').textContent = mode === 'ride' ? 'Upload' : 'Connect your services';
    panelRender();
    if (mode === 'connect') load().then(panelRender);
  }
  const closePanel = () => { $('#upPanel').classList.remove('on'); if (P.mode === 'connect') P.mode = 'ride'; };
  function panelRender() {
    const t = P.mode === 'ride' ? P.t : null, rows = t?.targets || (st.rows || []).map(r => ({ ...r, connected: !!r.status?.connected, manual_only: !!r.caps?.manual_only || !r.connect }));
    const out = [], off = WEB && (st.signedOut || st.unavailable);
    if (off) out.push(`<div class="prow signin"><div class="pmain"><div class="pname">${st.signedOut || !st.unavailable ? 'Sign in to connect services' : 'Services are not available right now'}</div><div class="psub">Garmin, Strava, TrainingPeaks, intervals.icu</div></div>${st.signedOut || !st.unavailable ? '<button class="pri" data-act="signin">Sign in</button>' : ''}</div>`);
    const auto = off ? [] : rows.filter(r => !r.manual_only && UPLOADERS.includes(r.id));
    const on = auto.filter(r => r.connected), rest = auto.filter(r => !r.connected);
    if (on.length && t) { out.push('<h3 class="sh">This ride</h3>'); for (const r of on) out.push(panelRowUp(r)); }
    if (rest.length) {
      out.push(`<h3 class="sh">${on.length ? 'More services' : P.mode === 'ride' ? 'Connect and upload this ride' : 'Pick where rides go'}</h3>`);
      for (const r of rest) out.push(panelRowConnect(r));
    }
    if (P.mode === 'ride' || off) out.push(manualSection(rows));
    if (P.mode === 'connect') out.push('<div class="pfoot"><button class="ghost" data-act="skip">Skip for now</button></div>');
    $('#upBody').innerHTML = out.join('');
  }
  function panelRowConnect(r) {
    const why = r.recommended ? r.recommended_reason || '' : r.duplicate_warning ? 'Garmin already sends rides here' : PLANS.includes(r.id) ? 'Uploads rides, brings in planned workouts' : 'Uploads rides';
    const stravaWeb = r.id === 'strava' && (WEB || row('strava')?.status?.configured === false);
    return `<div class="prow" data-svc="${r.id}"><div class="pmain"><div class="pname">${esc(r.name)}${r.recommended ? '<span class="rec">Recommended</span>' : ''}${tipHtml(r, P.mode === 'ride' ? P.rid : null)}</div>${why ? `<div class="psub">${esc(why)}</div>` : ''}</div>`
      + (stravaWeb ? `<button data-act="manual" data-svc="strava">By hand</button>` : `<button class="${r.recommended ? 'pri' : ''}" data-act="connect" data-svc="${r.id}">Connect</button>`) + '</div>';
  }
  function panelRowUp(r) {
    const u = r.upload, s = stateOf(u);
    let sub = '', act = '';
    if (r.needs_reconnect && (!u || u.action === 'reconnect')) { sub = '<span class="warn">Signed out</span>'; act = `<button class="pri" data-act="reconnect" data-svc="${r.id}">Reconnect</button>`; }
    else if (!u) { sub = r.auto ? 'Not uploaded' : 'Manual upload'; act = `<button class="pri" data-act="retry" data-svc="${r.id}">Upload</button>`; }
    else if (s === 'done' || s === 'there') { sub = `<span class="ok">${WORD[s]}</span>`; act = u.url ? `<a class="btn" href="${esc(u.url)}" target="_blank" rel="noopener">Open</a>` : ''; }
    else if (s === 'uploading') sub = 'Uploading…';
    else if (s === 'retrying') { sub = `<span class="warn">Trying again${u.next_retry_at ? ' at ' + esc(when(u.next_retry_at)) : ''}</span>${u.error ? ` · ${esc(u.error)}` : ''}`; act = `<button data-act="retry" data-svc="${r.id}">Retry now</button>`; }
    else if (s === 'failed') {
      sub = `<span class="bad">Failed</span>${u.error ? ` · ${esc(u.error)}` : ''}`;
      act = u.action === 'reconnect' ? `<button class="pri" data-act="reconnect" data-svc="${r.id}">Reconnect</button>`
        : u.action === 'download_fit' ? `<button data-act="manual" data-svc="${r.id}">Upload by hand</button>` : `<button class="pri" data-act="retry" data-svc="${r.id}">Retry</button>`;
    }
    const dup = r.duplicate_risk && r.duplicate_warning ? `<div class="psub warn">${esc(r.duplicate_warning)}</div>` : '';
    return `<div class="prow" data-svc="${r.id}"><div class="pmain"><div class="pname"><i class="dot ${s === 'done' || s === 'there' ? 'on' : s === 'failed' ? 'bad' : s ? 'wait' : ''}"></i>${esc(r.name)}</div><div class="psub">${sub}</div>${dup}</div>${act}</div>`;
  }
  function manualSection(rows) {
    if (!rows.some(r => r.manual)) rows = FALLBACK_ROWS;
    const ids = rows.filter(r => r.manual).map(r => r.id);
    if (!ids.includes(P.man)) P.man = ids[0] || 'garmin';
    const r = rows.find(x => x.id === P.man) || {};
    return `<h3 class="sh">Upload by hand</h3><div class="manual"><button class="dl" data-act="fit"><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></svg>Download .fit</button>
      <div class="mchips" role="tablist">${ids.map(id => `<button role="tab" class="chip2${id === P.man ? ' on' : ''}" data-act="man" data-svc="${id}" aria-selected="${id === P.man}">${esc(short(id))}</button>`).join('')}</div>
      ${manualHtml(P.man, r.manual)}</div>`;
  }
  async function act(a, svc, from) {
    if (a === 'signin') return signIn();
    if (a === 'skip') { closePanel(); return; }
    if (a === 'fit') { track('manual_upload', { service: P.man }); return downloadFit(P.rid); }
    if (a === 'man') { P.man = svc; return panelRender(); }
    if (a === 'manual') {
      P.man = svc; track('manual_upload', { service: svc });
      if (!$('#upPanel').classList.contains('on')) openPanel('ride'); else panelRender();
      return;
    }
    if (a === 'connect' || a === 'reconnect') return openForm(svc, P.mode === 'ride' ? P.rid : null, () => { if (P.rid && P.mode === 'ride') renderSummary(P.rid); else panelRender(); });
    if (a === 'retry') {
      const rid = P.rid; if (!rid) return;
      if (from) from.disabled = true;
      let r;
      if (WEB && !P.t?.has_fit) r = await postFit(rid, [svc]); else r = await api.retry(rid, svc);
      const up = r.body?.upload || r.body?.targets?.find(x => x.id === svc)?.upload;
      track('upload', { service: svc, result: r.ok ? up?.state || 'queued' : 'error' });
      if (!r.ok) toast(r.body.error || 'Upload failed');
      return renderSummary(rid);
    }
  }
  const onAct = e => {
    const t = e.target?.closest?.('[data-act],[data-fit],[data-manual]'); if (!t) return;
    if (t.dataset.fit) { e.preventDefault?.(); track('manual_upload', { service: t.dataset.fit }); return downloadFit(P.rid); }
    if (t.dataset.manual) return track('manual_upload', { service: t.dataset.manual });
    act(t.dataset.act, t.dataset.svc, t);
  };

  /* ---------- after a ride (web: the page posts the FIT; the local server queues by itself) ---------- */
  async function afterRide(rid) {
    rides = null;
    if (!WEB) return;
    if (!st.rows) await load();
    if (st.signedOut || st.unavailable || !(st.rows || []).some(r => r.status?.connected && r.auto)) return;
    const r = await postFit(rid, null);
    for (const t of r.body?.targets || []) if (t.upload) track('upload', { service: t.id, result: t.upload.state });
  }

  /* ---------- Today: planned rides from TrainingPeaks / intervals.icu ---------- */
  async function loadPlanned(force = false) {
    const d = day();
    if (!force && st.plannedDay === d && st.planned) return st.planned;
    if (!st.rows) await load();
    if (!anyPlanned()) { st.planned = []; st.plannedDay = d; onPlanned([]); return []; }
    const r = await api.planned(d);
    st.planned = r.ok ? r.body.workouts.map(w => ({ ...w, sourceName: short(w.source) })) : [];
    st.plannedDay = d; onPlanned(st.planned);
    return st.planned;
  }

  function refresh() { renderSettings(); onChange(); if ($('#upPanel').classList.contains('on')) panelRender(); if (P.rid && document.getElementById?.('summary')?.style.display !== 'none') renderSummary(P.rid); loadPlanned(true); }

  /* ---------- wiring ---------- */
  $('#intList').onclick = settingsClick; $('#intList').onchange = settingsChange;
  $('#intSigninBtn').onclick = () => signIn();
  $('#connClose').onclick = closeForm; $('#connCancel').onclick = closeForm;
  $('#connGo').onclick = formSubmit;
  $('#connModal').onclick = e => { if (e.target?.id === 'connModal') closeForm(); else onAct(e); };
  $('#connModal').onkeydown = e => { if (e.key === 'Enter' && e.target?.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault?.(); formSubmit(); } if (e.key === 'Escape') closeForm(); };
  $('#upClose').onclick = closePanel;
  $('#upBody').onclick = onAct;
  $('#sUpLine').onclick = onAct;
  $('#sUpload').onclick = () => openPanel('ride');
  $('#sNudgeGo').onclick = () => { openPanel('ride'); openForm('garmin', P.rid, () => renderSummary(P.rid)); };
  $('#sNudgeX').onclick = () => { try { localStorage.setItem('hw.garminNudge', '"off"'); } catch {} $('#sNudge').style.display = 'none'; };

  const self = {
    load, renderSettings, renderSummary, afterRide, loadPlanned, openPanel, closePanel, openForm, state: st,
    openConnectServices: async () => { await load(); openPanel('connect'); },
    escape: () => { if ($('#connModal').classList.contains('on')) { closeForm(); return true; } if ($('#upPanel').classList.contains('on')) { closePanel(); return true; } return false; },
  };
  inst = self;
  if (queued) { const q = queued; queued = null; self.openConnectServices(q); }
  return self;
}
