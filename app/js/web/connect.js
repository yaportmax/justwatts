// Hook for "Connect your services" (shown once after sign-up). The integrations UI (Settings > Integrations,
// branch upload-ui) owns connecting; this file is the seam between the two.
//
//   openConnectServices(service)   service: 'garmin' | 'strava' | 'trainingpeaks' | 'intervals' | undefined
//
// It first fires a cancelable `jw:connect-services` event on window ({ detail: { service } }). The integrations
// UI either listens and calls event.preventDefault() after starting its own flow, or replaces the stub below.
// Unhandled, the stub opens Settings at the Integrations section (#set-integrations) when it exists.
export const SERVICES = [
  { id: 'garmin', name: 'Garmin Connect', recommended: true },
  { id: 'strava', name: 'Strava' },
  { id: 'trainingpeaks', name: 'TrainingPeaks' },
  { id: 'intervals', name: 'Intervals.icu' },
];

let fallback = () => {};
export function setConnectFallback(fn) { fallback = fn; }

export function openConnectServices(service) {
  const ev = typeof CustomEvent === 'function' ? new CustomEvent('jw:connect-services', { detail: { service }, cancelable: true }) : null;
  if (ev && globalThis.dispatchEvent && globalThis.dispatchEvent(ev) === false) return true;  // handled by the integrations UI
  fallback(service);
  return false;
}
globalThis.JustWatts = Object.assign(globalThis.JustWatts || {}, { openConnectServices });
