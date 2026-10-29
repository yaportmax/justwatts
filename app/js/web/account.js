// Optional accounts (web build only): sidebar account slot, sign-in dialog, first-run steps (Strava email,
// connect services), the Account section in Settings, the owner's moderation list, and sync.
// The API is same-origin (/api/auth, /api/sync, /api/admin; see docs/API.md). Signed out, nothing here
// talks to the server except /api/auth/providers and /api/auth/me.
import { esc } from '../core.js';
import { track } from '../analytics.js';
import { createSync } from './sync.js';
import { SERVICES, openConnectServices, setConnectFallback } from './connect.js';

const PROV = { google: 'Google', strava: 'Strava', email: 'Email' };
const REASONS = {
  not_configured: p => `${p} sign-in is not set up yet.`,
  bad_state: () => 'Sign-in timed out. Try again.',
  denied: () => 'Sign-in cancelled.',
  provider_failed: p => `${p} sign-in failed. Try again.`,
  strava_capped: () => 'Strava sign-in is full for now. Use Google or email.',
  email_in_use: p => `That ${p} address has a Just Watts account. Sign in with email, then link ${p} in Settings.`,
  identity_in_use: p => `That ${p} account is linked to another Just Watts account.`,
  already_linked: p => `This account already has a different ${p} sign-in.`,
  signed_out: p => `Sign in first, then link ${p}.`,
};
const ERRORS = {
  invalid_credentials: 'Wrong email or password.', bad_email: 'Check the email address.', bad_password: 'Password: 8 to 200 characters.',
  email_taken: 'That email already has an account. Sign in instead.', bad_name: 'Pick another name.', unverified: 'Confirm your email first. A new link is on its way.',
  bad_token: 'This link has expired or was already used.', reset_unavailable: 'Password reset is not available yet.', email_unavailable: 'Email is not available yet.',
  already_linked: 'Already linked.', last_method: 'Keep at least one way to sign in.', no_password: 'This account has no password yet.',
  reauth_required: 'Sign in again with Google or Strava, then retry.', confirm_required: 'Type DELETE to confirm.', offline: 'No connection.',
  not_configured: 'Accounts are not available right now.',
};
const errText = b => b?.error === 'rate_limited' ? `Too many tries. Try again in ${Math.max(1, Math.ceil((b.retryAfter || 60) / 60))} min.` : ERRORS[b?.error] || 'Something went wrong. Try again.';
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const X = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';
export const ICONS = {
  google: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
  strava: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FC4C02" d="M15.39 17.94l-2.09-4.12h-3.07L15.39 24l5.15-10.18h-3.07M10.38 8.23l2.84 5.6h4.17L10.46 0l-7 13.83h4.17"/></svg>',
  email: '<svg viewBox="0 0 20 20" aria-hidden="true" class="ic"><rect x="3" y="5" width="14" height="10" rx="2"/><path d="M3.5 6l6.5 5 6.5-5"/></svg>',
};

export function createAccount({ $, toast, show, store, local, onUser = () => {}, onRides = () => {}, fetch = (...a) => globalThis.fetch(...a),
  loc = globalThis.location, hist = globalThis.history, download = () => {} }) {
  let providers = null, me = null, step = null, stepData = {}, menuOpen = false, delOpen = false, pwOpen = false, linkOpen = false;
  let friends = null, friendsN = 0;  // social.js: opens the Friends panel; requests and invites waiting

  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-HW': '1' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    } catch { return { status: 0, body: { error: 'offline' } }; }
    return { status: r.status, body: (await r.json().catch(() => null)) || {} };
  }

  /* ---------- sync ---------- */
  let syncState = { status: 'off', at: 0 };
  // another account's data on this device: ask before anything goes up (the dialog's 'device' step)
  let askRes = null, afterAsk = null;
  const ask = ({ name }) => new Promise(res => {
    askRes?.(null);
    afterAsk = step && step !== 'device' ? { s: step, data: stepData } : null;
    askRes = res; open('device', { name });
  });
  function answer(how) {
    const r = askRes, next = afterAsk; askRes = null; afterAsk = null;
    if (next) open(next.s, next.data); else close();
    r?.(how);
    if (how === 'clean') toast('Started clean');
  }
  const sync = createSync({ fetch, local, storage: store, onState: s => { syncState = s; renderSlot(); renderSyncRow(); },
    onSignedOut: () => { setMe(null); toast('Signed out'); }, onRides, ask });

  function setMe(m) {
    const was = me?.user?.id;
    me = m?.user ? m : null;
    if (me && me.user.id !== was) sync.start(me.user.id, me.user.name || me.user.email?.split('@')[0] || 'this account');
    if (!me && was) sync.signOut();
    render(); onUser(me);
  }
  const signedIn = () => !!me;

  /* ---------- URL callbacks: ?auth= (OAuth), ?verify=, ?reset=, ?claim= ---------- */
  function readParams() {
    const u = new URLSearchParams(loc?.search || ''), keys = ['auth', 'provider', 'reason', 'new', 'verify', 'reset', 'claim'];
    const p = Object.fromEntries(keys.filter(k => u.has(k)).map(k => [k, u.get(k)]));
    if (Object.keys(p).length) {
      for (const k of keys) u.delete(k);
      const q = u.toString();
      try { hist?.replaceState?.(null, '', (loc.pathname || '/') + (q ? '?' + q : '') + (loc.hash || '')); } catch {}
    }
    return p;
  }
  async function handleParams(p) {
    const prov = PROV[p.provider] || 'That';
    if (p.auth === 'ok') {
      const method = p.provider === 'strava' ? 'strava' : 'google';
      if (p.new) { track('sign_up', { method }); firstRun(method); }
      else { track('login', { method }); toast('Signed in'); }
    } else if (p.auth === 'linked') { toast(`${prov} linked`); show('settings'); scrollToAccount(); }
    else if (p.auth === 'error') {
      const msg = (REASONS[p.reason] || REASONS.provider_failed)(prov);
      if (me) { toast(msg); if (['identity_in_use', 'already_linked'].includes(p.reason)) { show('settings'); scrollToAccount(); } }
      else open('signin', { error: msg });
    }
    if (p.verify) {
      const r = await api('POST', '/api/auth/verify', { token: p.verify });
      if (r.status === 200) { setMe(r.body); track('sign_up', { method: 'email' }); toast('Email confirmed'); if (Date.now() - r.body.user.createdAt < 3 * 86400000) firstRun('email'); }
      else toast(errText(r.body));
    }
    if (p.reset) open('reset', { token: p.reset });
    if (p.claim) {
      const r = await api('POST', '/api/auth/email/confirm', { token: p.claim });
      if (r.status === 200) { setMe(r.body); toast(r.body.merged ? 'Strava added to your account' : 'Email confirmed'); }
      else if (r.status === 401) toast('Sign in with Strava in this browser, then open the link again.');
      else toast(r.body.error === 'already_linked' ? 'That account already has a Strava sign-in.' : errText(r.body));
    }
  }
  // right after sign-up: Strava has no email, so ask for one (when email works), then connect services
  function firstRun(method) {
    const seen = store.get('hw.firstRun', {});
    if (me && seen[me.user.id]) return;
    if (me) { seen[me.user.id] = 1; store.set('hw.firstRun', seen); }
    if (method === 'strava' && providers?.emailVerification && me && !me.user.email) open('email');
    else open('connect');
  }

  /* ---------- the sidebar slot ---------- */
  const syncLabel = () => ({ synced: 'Synced', syncing: 'Syncing', offline: 'Offline', error: 'Sync paused' })[syncState.status] || '';
  function renderSlot() {
    const slot = $('#acctSlot'); if (!slot) return;
    if (!providers) { slot.innerHTML = ''; return; }
    if (!me) {
      slot.innerHTML = `<button class="acctbtn" data-a="signin"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2"/><path d="M3.8 16.5c.9-3 3.3-4.6 6.2-4.6s5.3 1.6 6.2 4.6"/></svg><span>Sign in</span></button>`;
      return;
    }
    const name = me.user.name || me.user.email?.split('@')[0] || 'Rider', s = syncState.status;
    slot.innerHTML = `<button class="acctme${menuOpen ? ' open' : ''}" data-a="menu" aria-haspopup="menu" aria-expanded="${menuOpen}">
      <span class="av" aria-hidden="true">${esc(name[0].toUpperCase())}${friendsN ? '<i class="adot"></i>' : ''}</span>
      <span class="an"><b>${esc(name)}</b><small class="sy ${esc(s)}" title="${esc(syncState.error || '')}"><i></i>${esc(syncLabel())}</small></span>
      <svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 12l4-4 4 4"/></svg></button>
      <div class="amenu" role="menu"${menuOpen ? '' : ' hidden'}>${friends ? `<button role="menuitem" data-a="friends">Friends${friendsN ? ` <span class="badge num">${friendsN}</span>` : ''}</button>` : ''}<button role="menuitem" data-a="settings">Account settings</button><button role="menuitem" data-a="signout">Sign out</button></div>`;
  }
  function menu(on = !menuOpen) { menuOpen = !!on; renderSlot(); }
  function slotClick(e) {
    const a = e?.target?.closest?.('[data-a]')?.dataset.a;
    if (a === 'signin') return open('signin');
    if (a === 'menu') return menu();
    if (a === 'settings') { menu(false); show('settings'); return scrollToAccount(); }
    if (a === 'friends') { menu(false); return friends?.(); }
    if (a === 'signout') { menu(false); return signOut(); }
  }
  function scrollToAccount() { setTimeout(() => document.getElementById?.('set-account')?.scrollIntoView?.({ block: 'start' }), 0); }

  /* ---------- the dialog: sign in, sign up, reset, Strava email, connect services ---------- */
  const TITLES = { device: 'Data on this device', signin: 'Sign in', signup: 'Create account', forgot: 'Reset password', sent: 'Check your inbox', reset: 'New password', email: 'Add your email', connect: 'Connect your services' };
  function open(s, data = {}) {
    if (askRes && step === 'device' && s !== 'device') { afterAsk = { s, data }; return; }  // the question first, then this
    step = s; stepData = data; renderDialog(); $('#authModal')?.classList.add('on'); setTimeout(() => $('#authBody')?.querySelector?.('input')?.focus?.(), 30); }
  function close() {
    if (askRes && step === 'device') { const r = askRes; askRes = null; afterAsk = null; r(null); }  // dismissed: sync waits
    step = null; $('#authModal')?.classList.remove('on');
  }
  function oauthButtons() {
    const b = [];
    if (providers?.google) b.push(`<button type="button" class="oauth" data-a="google">${ICONS.google}<span>Continue with Google</span></button>`);
    if (providers?.strava) b.push(`<button type="button" class="oauth" data-a="strava">${ICONS.strava}<span>Continue with Strava</span></button>`);
    if (providers?.strava && providers.stravaCapped) b.push('<div class="hint capped">Strava sign-in is limited for now. If it fails, use Google or email.</div>');
    return b.length ? `<div class="oauths">${b.join('')}</div><div class="or"><span>or</span></div>` : '';
  }
  function renderDialog() {
    const body = $('#authBody'); if (!body || !step) return;
    $('#authTitle').textContent = TITLES[step] || '';
    const err = `<div class="err" id="authErr">${esc(stepData.error || '')}</div>`;
    if (step === 'signin' || step === 'signup') {
      const up = step === 'signup';
      body.innerHTML = `${oauthButtons()}<form class="aform" data-f="${step}" novalidate>
        ${up ? '<label class="f">Name<input name="name" autocomplete="nickname" maxlength="40" placeholder="Optional"></label>' : ''}
        <label class="f">Email<input name="email" type="email" autocomplete="email" required value="${esc(stepData.email || '')}"></label>
        <label class="f">Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required minlength="8"></label>
        ${err}<button class="pri wide" type="submit">${up ? 'Create account' : 'Sign in'}</button></form>
        <div class="aalt">${up ? '<span></span>' : '<button type="button" class="lnk" data-a="forgot">Forgot password?</button>'}
        <span>${up ? 'Have an account?' : 'New here?'} <button type="button" class="lnk" data-a="${up ? 'signin' : 'signup'}">${up ? 'Sign in' : 'Create account'}</button></span></div>`;
    } else if (step === 'forgot') {
      body.innerHTML = `<form class="aform" data-f="forgot" novalidate><label class="f">Email<input name="email" type="email" autocomplete="email" required value="${esc(stepData.email || '')}"></label>
        ${err}<button class="pri wide" type="submit">Send reset link</button></form><div class="aalt"><button type="button" class="lnk" data-a="signin">Back to sign in</button></div>`;
    } else if (step === 'sent') {
      body.innerHTML = `<p class="amsg">${esc(stepData.text || '')}</p><button class="wide" data-a="${stepData.next || 'close'}">${stepData.next === 'connect' ? 'Continue' : 'Done'}</button>`;
    } else if (step === 'reset') {
      body.innerHTML = `<form class="aform" data-f="reset" novalidate><label class="f">New password<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
        ${err}<button class="pri wide" type="submit">Set password</button></form>`;
    } else if (step === 'email') {
      body.innerHTML = `<p class="amsg">Strava does not share your email. Add one to sign in without Strava and to recover your account.</p>
        <form class="aform" data-f="email" novalidate><label class="f">Email<input name="email" type="email" autocomplete="email" required></label>
        ${err}<button class="pri wide" type="submit">Continue</button></form><div class="aalt"><span></span><button type="button" class="lnk" data-a="connect">Skip for now</button></div>`;
    } else if (step === 'device') {
      body.innerHTML = `<p class="amsg">Workouts, courses and rides here are from another account.</p>
        <div class="aform"><button class="pri wide" data-a="dmerge">Add this device's data to ${esc(stepData.name || 'this account')}</button>
        <button class="wide" data-a="dclean">Start clean</button><div class="hint">Start clean removes them from this device.</div></div>`;
    } else if (step === 'connect') {
      body.innerHTML = `<p class="amsg">Send rides where you train. You can change this later in Settings.</p><div class="svcs">${SERVICES.map(s => `
        <div class="svc"><span class="sn">${esc(s.name)}${s.recommended ? '<span class="badge rec">Recommended</span>' : ''}</span>
        <button class="${s.recommended ? 'pri' : ''}" data-a="svc" data-s="${esc(s.id)}">Connect</button></div>`).join('')}</div>
        <div class="aalt"><span></span><button type="button" class="lnk" data-a="close">Skip for now</button></div>`;
    }
  }
  function setErr(msg) { stepData.error = msg; const e = $('#authErr'); if (e) e.textContent = msg; }
  function busy(on) { const b = $('#authBody')?.querySelector?.('button[type=submit]'); if (b) b.disabled = on; }
  const startOAuth = (p, mode = 'login') => { const ret = (loc?.pathname || '/') + (mode === 'link' ? '#settings' : ''); loc.href = `/api/auth/${p}/start?mode=${mode}&return=${encodeURIComponent(ret)}`; };

  async function submit(form, vals) {
    busy(true);
    try {
      if (form === 'signin') return await signIn(vals.email, vals.password);
      if (form === 'signup') return await signUp(vals.email, vals.password, vals.name);
      if (form === 'forgot') {
        const r = await api('POST', '/api/auth/reset/request', { email: vals.email });
        if (r.status === 202) open('sent', { text: 'If that address has an account, a reset link is on its way.' }); else setErr(errText(r.body));
      } else if (form === 'reset') {
        const r = await api('POST', '/api/auth/reset/confirm', { token: stepData.token, password: vals.password });
        if (r.status === 200) { close(); setMe(r.body); toast('Password set'); } else setErr(errText(r.body));
      } else if (form === 'email') return await claimEmail(vals.email);
    } finally { busy(false); }
  }
  async function signIn(email, password) {
    const r = await api('POST', '/api/auth/login', { email, password });
    if (r.status === 200) { close(); setMe(r.body); track('login', { method: 'email' }); toast('Signed in'); return true; }
    setErr(errText(r.body)); return false;
  }
  async function signUp(email, password, name = '') {
    const r = await api('POST', '/api/auth/signup', { email, password, name });
    if (r.status === 201) { setMe(r.body); track('sign_up', { method: 'email' }); firstRun('email'); return true; }
    if (r.status === 202) { open('sent', { text: `Confirm your email: a link is on its way to ${email}.` }); return true; }
    setErr(errText(r.body)); return false;
  }
  async function claimEmail(email) {
    const r = await api('POST', '/api/auth/email/claim', { email });
    if (r.status === 202) { open('sent', { text: `A link is on its way to ${email}. Open it in this browser.`, next: step === 'email' ? 'connect' : 'close' }); return true; }
    setErr(errText(r.body)); return false;
  }
  async function signOut(all = false) {
    await sync.flush();
    const r = await api('POST', all ? '/api/auth/logout-all' : '/api/auth/logout', {});
    if (r.status !== 200 && all) { toast(errText(r.body)); return; }
    setMe(null); toast(all ? 'Signed out everywhere' : 'Signed out');
  }
  function dialogClick(e) {
    if (e?.target?.id === 'authModal') return close();
    const b = e?.target?.closest?.('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') return close();
    if (a === 'dmerge' || a === 'dclean') return answer(a === 'dmerge' ? 'merge' : 'clean');
    if (a === 'google' || a === 'strava') return startOAuth(a);
    if (a === 'svc') { close(); return openConnectServices(b.dataset.s); }
    if (['signin', 'signup', 'forgot', 'connect'].includes(a)) return open(a, { email: $('#authBody')?.querySelector?.('input[name=email]')?.value || '' });
  }
  function dialogSubmit(e) {
    e?.preventDefault?.();
    const f = e?.target; if (!f?.dataset?.f) return;
    const vals = {}; for (const i of f.querySelectorAll?.('input') || []) vals[i.name] = i.name === 'password' ? i.value : i.value.trim();
    submit(f.dataset.f, vals);
  }

  /* ---------- Settings > Account ---------- */
  function renderSyncRow() {
    const el = $('#acSync'); if (!el || !me) return;
    el.textContent = syncState.status === 'syncing' ? 'Syncing…' : syncState.status === 'offline' ? 'Offline. Changes sync when you are back.' : syncState.status === 'error' ? (syncState.error === 'choose' ? 'Paused. Sync now to choose.' : `Paused (${syncState.error || 'error'}). Retrying.`) : syncState.at ? `Synced ${ago(syncState.at)}` : '';
  }
  function renderSettings() {
    const box = $('#acctSet'); if (!box) return;
    if (!me) {
      box.innerHTML = `<div class="srow"><span class="sl">Sync<small>Rides, workouts, courses and settings on every device.</small></span><span class="sc"><button class="pri" data-a="signin">Sign in</button></span></div>`;
      return;
    }
    const u = me.user, ids = me.identities, has = p => ids.find(i => i.provider === p), em = has('email');
    const methods = ids.length;
    const linkRow = p => {
      const i = has(p), sub = i ? (i.email || 'Linked') : '';
      const act = i ? `<button data-a="unlink" data-p="${p}" ${methods < 2 ? 'disabled title="Keep at least one way to sign in"' : ''}>Unlink</button>`
        : p === 'email' ? `<button data-a="linkemail">Add</button>` : `<button data-a="link" data-p="${p}">Link</button>`;
      return `<div class="srow sprov"><span class="sl"><span class="pv">${ICONS[p]}${PROV[p]}</span><small>${esc(sub)}</small></span><span class="sc">${act}</span></div>`;
    };
    const emailRow = em || u.email
      ? `<div class="srow"><span class="sl">Email<small>${esc(u.email)} · ${u.verified ? '<span class="okc">Confirmed</span>' : 'Not confirmed'}</small></span><span class="sc">${em && !u.verified && providers?.emailVerification ? '<button data-a="resend">Resend link</button>' : ''}</span></div>`
      : providers?.emailVerification
        ? `<form class="srow" data-f="claim"><span class="sl">Email<small>Strava does not share it. Add one to sign in without Strava.</small></span><span class="sc"><input name="email" type="email" placeholder="you@example.com" aria-label="Email"><button type="submit">Add</button></span></form>`
        : '';
    const linkForm = linkOpen ? `<form class="srow sub" data-f="linkemail"><span class="sl">Email and password</span><span class="sc"><input name="email" type="email" placeholder="Email" aria-label="Email"><input name="password" type="password" placeholder="Password" aria-label="Password" autocomplete="new-password"><button type="submit" class="pri">Add</button></span></form>` : '';
    const pwRow = u.hasPassword
      ? `<div class="srow"><span class="sl">Password</span><span class="sc"><button data-a="pw">${pwOpen ? 'Cancel' : 'Change password'}</button></span></div>${pwOpen ? `<form class="srow sub" data-f="password"><span class="sl"></span><span class="sc"><input name="current" type="password" placeholder="Current" aria-label="Current password" autocomplete="current-password"><input name="password" type="password" placeholder="New" aria-label="New password" autocomplete="new-password"><button type="submit" class="pri">Save</button></span></form>` : ''}`
      : em && providers?.passwordReset ? `<div class="srow"><span class="sl">Password<small>None yet</small></span><span class="sc"><button data-a="setpw">Email me a link</button></span></div>` : '';
    box.innerHTML = `
      <label class="srow"><span class="sl">Name<small>Shown on what you publish</small></span><span class="sc"><input id="acName" maxlength="40" value="${esc(u.name || '')}" placeholder="Rider" style="width:220px"></span></label>
      ${emailRow}
      <div class="srow"><span class="sl">Sync<small id="acSync"></small></span><span class="sc"><button data-a="syncnow">Sync now</button></span></div>
      <h3 class="ssub">Sign-in methods</h3>
      ${['google', 'strava', 'email'].filter(p => p === 'email' || providers?.[p] || has(p)).map(linkRow).join('')}${linkForm}
      ${pwRow}
      <h3 class="ssub">Data and sessions</h3>
      <div class="srow"><span class="sl">Export<small>Everything in your account, as JSON</small></span><span class="sc"><button data-a="export">Export my data</button></span></div>
      <div class="srow"><span class="sl">Sessions</span><span class="sc"><button data-a="signout">Sign out</button><button data-a="signoutall">Sign out everywhere</button></span></div>
      <div class="srow"><span class="sl">Delete account<small>Removes synced data and what you published. Rides on this device stay.</small></span><span class="sc"><button class="danger" data-a="del">${delOpen ? 'Cancel' : 'Delete account'}</button></span></div>
      ${delOpen ? `<form class="srow sub" data-f="delete"><span class="sl"><small>Type DELETE to confirm${u.hasPassword ? ', and your password' : ''}.</small></span><span class="sc"><input name="confirm" placeholder="DELETE" aria-label="Type DELETE" autocomplete="off" style="width:110px">${u.hasPassword ? '<input name="password" type="password" placeholder="Password" aria-label="Password" autocomplete="current-password">' : ''}<button type="submit" class="danger solid">Delete</button></span></form>` : ''}
      <div class="err" id="acErr"></div>`;
    renderSyncRow();
  }
  async function settingsAction(a, b) {
    const err = m => { const e = $('#acErr'); if (e) e.textContent = m; if (m) toast(m); };
    err('');
    if (a === 'signin') return open('signin');
    if (a === 'link') return startOAuth(b.dataset.p, 'link');
    if (a === 'linkemail') { linkOpen = !linkOpen; return renderSettings(); }
    if (a === 'pw') { pwOpen = !pwOpen; return renderSettings(); }
    if (a === 'del') { delOpen = !delOpen; return renderSettings(); }
    if (a === 'syncnow') return sync.resume() || sync.kick(0);
    if (a === 'signout') return signOut(false);
    if (a === 'signoutall') return signOut(true);
    if (a === 'unlink') {
      const r = await api('POST', '/api/auth/unlink', { provider: b.dataset.p });
      if (r.status === 200) { setMe(r.body); toast(`${PROV[b.dataset.p]} unlinked`); } else err(errText(r.body));
    }
    if (a === 'resend') {
      const r = await api('POST', '/api/auth/verify/resend', {});
      if (r.status === 200) toast(r.body.verified ? 'Already confirmed' : 'Link sent'); else err(errText(r.body));
    }
    if (a === 'setpw') {
      const r = await api('POST', '/api/auth/reset/request', { email: me.user.email });
      if (r.status === 202) toast('Check your inbox'); else err(errText(r.body));
    }
    if (a === 'export') {
      const r = await api('GET', '/api/sync/export');
      if (r.status === 200) download(`justwatts-account-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(r.body, null, 1), 'application/json'); else err(errText(r.body));
    }
  }
  async function settingsForm(f, vals) {
    const err = m => { const e = $('#acErr'); if (e) e.textContent = m; if (m) toast(m); };
    if (f === 'claim') { const r = await api('POST', '/api/auth/email/claim', { email: vals.email }); if (r.status === 202) toast('Check your inbox. Open the link in this browser.'); else err(errText(r.body)); }
    if (f === 'linkemail') {
      const r = await api('POST', '/api/auth/link/email', { email: vals.email, password: vals.password });
      if (r.status === 200) { linkOpen = false; setMe(r.body); toast(providers?.emailVerification ? 'Added. Check your inbox to confirm.' : 'Email added'); } else err(errText(r.body));
    }
    if (f === 'password') {
      const r = await api('POST', '/api/auth/password', { current: vals.current, password: vals.password });
      if (r.status === 200) { pwOpen = false; renderSettings(); toast('Password changed. Other devices are signed out.'); } else err(errText(r.body));
    }
    if (f === 'delete') {
      const r = await api('POST', '/api/auth/delete', { confirm: vals.confirm, password: vals.password });
      if (r.status === 200) { delOpen = false; sync.signOut(); me = null; render(); onUser(null); toast('Account deleted'); }
      else err(errText(r.body));
    }
  }
  async function saveName(v) {
    const r = await api('POST', '/api/auth/profile', { name: v });
    if (r.status === 200) { setMe(r.body); toast('Saved'); } else { toast(errText(r.body)); renderSettings(); }
  }

  /* ---------- Settings > Moderation (owner accounts) ---------- */
  async function renderAdmin() {
    const box = $('#adminSet'); if (!box || !me?.admin) return;
    const r = await api('GET', '/api/admin/hidden');
    if (r.status !== 200) { box.innerHTML = `<div class="srow"><span class="sl"><small>${esc(errText(r.body))}</small></span></div>`; return; }
    const { items = [], comments = [], messages = [] } = r.body;
    const why = rs => rs.filter(Boolean).map(esc).join(', ') || 'no reason given';
    box.innerHTML = !items.length && !comments.length && !messages.length ? '<div class="srow"><span class="sl"><small>Nothing hidden.</small></span></div>'
      : items.map(i => `<div class="srow"><span class="sl">${esc(i.name)}<small>${esc(i.kind)} by ${esc(i.author)} · ${i.reasons.length} reports: ${why(i.reasons)}</small></span><span class="sc"><button data-adm="items" data-id="${esc(i.id)}" data-act="unhide">Unhide</button><button class="danger" data-adm="items" data-id="${esc(i.id)}" data-act="delete">Delete</button></span></div>`).join('')
      + comments.map(c => `<div class="srow"><span class="sl">${esc(c.body.slice(0, 140))}<small>Comment by ${esc(c.author)} · ${c.reasons.length} reports: ${why(c.reasons)}</small></span><span class="sc"><button data-adm="comments" data-id="${esc(c.id)}" data-act="unhide">Unhide</button><button class="danger" data-adm="comments" data-id="${esc(c.id)}" data-act="delete">Delete</button></span></div>`).join('')
      + messages.map(m => `<div class="srow"><span class="sl">${esc(m.body.slice(0, 140))}<small>Chat by ${esc(m.author)} · ${m.reasons.length} reports: ${why(m.reasons)}</small></span><span class="sc"><button data-adm="messages" data-id="${esc(m.id)}" data-act="unhide">Unhide</button><button class="danger" data-adm="messages" data-id="${esc(m.id)}" data-act="delete">Delete</button></span></div>`).join('');
  }
  async function adminAct(kind, id, action) {
    const r = await api('POST', `/api/admin/${kind}/${encodeURIComponent(id)}`, { action });
    toast(r.status === 200 ? (action === 'delete' ? 'Deleted' : 'Visible again') : errText(r.body));
    renderAdmin();
  }

  /* ---------- render all + wire ---------- */
  function render() {
    const on = !!providers;
    for (const sel of ['#set-account', '[data-set=set-account]']) { const el = $(sel); if (el) el.style.display = on ? '' : 'none'; }
    for (const sel of ['#set-admin', '[data-set=set-admin]']) { const el = $(sel); if (el) el.style.display = on && me?.admin ? '' : 'none'; }
    renderSlot(); renderSettings(); renderAdmin();
  }
  function wire() {
    const slot = $('#acctSlot'); if (slot) slot.onclick = slotClick;
    const m = $('#authModal'); if (m) { m.onclick = dialogClick; m.onsubmit = dialogSubmit; }
    const box = $('#acctSet');
    if (box) {
      box.onclick = e => { const b = e?.target?.closest?.('[data-a]'); if (b && !b.disabled) settingsAction(b.dataset.a, b); };
      box.onsubmit = e => { e?.preventDefault?.(); const f = e?.target; const vals = {}; for (const i of f?.querySelectorAll?.('input') || []) vals[i.name] = i.name === 'password' || i.name === 'current' ? i.value : i.value.trim(); settingsForm(f?.dataset?.f, vals); };
      box.onchange = e => { if (e?.target?.id === 'acName') saveName(e.target.value.trim()); };
    }
    const adm = $('#adminSet'); if (adm) adm.onclick = e => { const b = e?.target?.closest?.('[data-adm]'); if (b) adminAct(b.dataset.adm, b.dataset.id, b.dataset.act); };
    globalThis.document?.addEventListener?.('click', e => { if (menuOpen && !(e.composedPath?.() || []).some(n => n?.id === 'acctSlot')) menu(false); });  // the path, not target: the slot re-renders on click
    globalThis.document?.addEventListener?.('keydown', e => { if (e.key === 'Escape') { if (step) close(); if (menuOpen) menu(false); } });
    globalThis.addEventListener?.('online', () => sync.kick(0));
    globalThis.document?.addEventListener?.('visibilitychange', () => { if (!globalThis.document.hidden) sync.kick(0); });
    setConnectFallback(() => { show('settings'); setTimeout(() => (document.getElementById?.('set-integrations') || document.getElementById?.('set-uploads'))?.scrollIntoView?.({ block: 'start' }), 0); });
  }

  async function init() {
    wire();
    const params = readParams();
    const p = await api('GET', '/api/auth/providers');
    providers = p.status === 200 && p.body.accounts ? p.body : null;
    if (!providers) { render(); return false; }
    const m = await api('GET', '/api/auth/me');
    if (m.status === 200 && m.body.user) setMe(m.body); else render();
    await handleParams(params);
    return true;
  }

  return {
    init, open, close, signIn, signUp, signOut, claimEmail, api, sync, submit, firstRun, handleParams,
    me: () => me, signedIn, providers: () => providers, settingsAction, settingsForm, adminAct, renderSettings, slotClick, dialogClick, menu,
    refresh: () => { renderSettings(); renderAdmin(); },
    setFriends: (fn, n = 0) => { friends = fn; friendsN = n; renderSlot(); },
    state: () => ({ step, menuOpen, sync: syncState }),
  };
}
