// Shared pieces for the web connectors: failure kinds, HTTP helpers, manual-upload metadata.
// Mirrors server/justwatts/integrations/base.py. Every connector takes an injected fetch, so tests never
// reach a real service.
'use strict';
const crypto = require('node:crypto');

const AUTH = 'auth', BLOCKED = 'blocked', TEMPORARY = 'temporary', DUPLICATE = 'duplicate';
const KINDS = [AUTH, BLOCKED, TEMPORARY, DUPLICATE];
const ACTION = { auth: 'reconnect', blocked: 'download_fit', temporary: 'retry' };

class IntegrationError extends Error {
  constructor(kind, message, retryAfter = null) {
    if (!KINDS.includes(kind)) throw new Error('bad kind ' + kind);
    super(message); this.kind = kind; this.retryAfter = retryAfter;
  }
}

function kindForStatus(code) {
  if (code === 401 || code === 419) return AUTH;
  if (code === 409) return DUPLICATE;
  if (code === 408 || code === 425 || code === 429 || code >= 500) return TEMPORARY;
  return BLOCKED;  // 403 (bot wall, refused), 400/404/413/415/422: retrying will not help
}

function retryAfter(headers) {
  const v = Number(headers && headers.get ? headers.get('retry-after') : NaN);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// fetch that turns network trouble into a temporary failure and reads the body once
async function call(fetch, url, opt = {}) {
  let res;
  try { res = await fetch(url, { redirect: 'manual', ...opt }); }
  catch (e) { throw new IntegrationError(TEMPORARY, 'network: ' + String((e && e.message) || e).slice(0, 150)); }
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json, buf };
}

function multipart(fields, fileField, filename, data, ctype = 'application/octet-stream') {
  const b = crypto.randomBytes(16).toString('hex'), parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n`), Buffer.from(data), Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

function scrub(text, secrets) {
  let out = String(text);
  for (const s of [...secrets].filter(s => s && String(s).length >= 4).sort((a, b) => String(b).length - String(a).length)) out = out.split(String(s)).join('[hidden]');
  return out;
}

const UNOFFICIAL_NOTE = "Unfortunately {name} doesn't allow official integrations, so we use a little workaround. It can break. If it does, upload the .fit file manually:";

// Same table as base.py MANUAL (tests/test_integrations_web.py checks they agree).
const MANUAL = {
  garmin: { url: 'https://connect.garmin.com/modern/import-data', steps: ['1. Download the .fit file.', '2. Open Garmin Connect Import Data.', '3. Drop the file in and click Import Data.'] },
  strava: { url: 'https://www.strava.com/upload/select', steps: ['1. Download the .fit file.', '2. Open Strava Upload.', '3. Choose the file.'], help_url: 'https://support.strava.com/hc/en-us/articles/216917807-Uploading-Files-to-Strava' },
  trainingpeaks: { url: 'https://app.trainingpeaks.com/#calendar', steps: ['1. Download the .fit file.', '2. Open your TrainingPeaks calendar.', '3. Drag the file onto the calendar.'], help_url: 'https://help.trainingpeaks.com/hc/en-us/articles/204072994-How-do-I-manually-Upload-a-workout-file-into-TrainingPeaks' },
  intervals: { url: 'https://intervals.icu/activities', steps: ['1. Download the .fit file.', '2. Open intervals.icu Activities.', '3. Click the upload arrow and drop the file in.'] },
  coros: { url: 'https://t.coros.com/', steps: ['1. Download the .fit file.', '2. Open COROS Training Hub, Activity List.', '3. Click Import Data and choose the file.'], help_url: 'https://support.coros.com/hc/en-us/articles/4412176269844-COROS-Training-Hub-Manual' },
  wahoo: { url: null, app_only: true, steps: ['1. Download the .fit file to your phone.', '2. Open the Wahoo app, Add Activity.', '3. Tap Upload and choose the file.'], help_url: 'https://support.wahoofitness.com/hc/en-us/articles/18790709768850' },
  polar: { url: null, supported: false, steps: ['Polar Flow has no file import.', 'Upload to Garmin Connect or Strava instead.'], help_url: 'https://support.polar.com/en/export-training-sessions-flow' },
  suunto: { url: null, supported: false, steps: ['The Suunto app has no workout file import.', 'Upload to Garmin Connect or Strava instead.'], help_url: 'https://us.suunto.com/pages/what-type-of-files-can-i-export-from-the-suunto-app' },
};
for (const m of Object.values(MANUAL)) {
  if (m.supported === undefined) m.supported = true;
  if (m.app_only === undefined) m.app_only = false;
  if (m.help_url === undefined) m.help_url = null;
}

function describe(c) {
  const d = {
    id: c.id, name: c.name, official: c.official !== false,
    caps: { upload: c.uploads !== false, planned: !!c.plannedWorkouts, import: !!c.imports },
    connect: c.connectKind === null ? null : { kind: c.connectKind || 'fields', ...(c.connectUrl ? { url: c.connectUrl } : {}), fields: (c.fields || []).map(f => ({ ...f })) },
    manual: MANUAL[c.id] || null,
  };
  if (c.official === false) d.unofficial_note = UNOFFICIAL_NOTE.replace('{name}', c.name);
  return d;
}

const realSleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { AUTH, BLOCKED, TEMPORARY, DUPLICATE, KINDS, ACTION, IntegrationError, kindForStatus, retryAfter, call,
  multipart, scrub, MANUAL, UNOFFICIAL_NOTE, describe, realSleep };
