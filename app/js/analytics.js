// Usage analytics (GA4) on the hosted site only: never in the local app, on self-hosted copies or in tests.
// No personal data: views, ride kinds, library ids (custom workouts are just "custom"), durations, outcomes.
const ID = 'G-X652VLD7W8', HOSTS = ['justwatts.com', 'www.justwatts.com'];
const on = typeof location !== 'undefined' && HOSTS.includes(location.hostname) && !globalThis.navigator?.globalPrivacyControl;
let ready = false;

function init() {
  if (!on || ready) return; ready = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', ID, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
  const s = document.createElement('script'); s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${ID}`;
  document.head.appendChild(s);
}

// one page view per app view (Workouts, Ride, History, Settings)
export function view(name) { if (!on) return; init(); window.gtag('event', 'page_view', { page_title: name, page_location: `${location.origin}/${name}` }); }
export function track(event, params = {}) { if (!on) return; init(); window.gtag('event', event, params); }
// a workout as analytics may see it: library id, never a custom workout's own name
export const workoutTag = w => !w ? 'free' : w.test ? 'ftp_test' : String(w.id || '').startsWith('c-') ? 'custom' : (w.id || 'text');
