// Open world start: a preset or a tap on the map (the nearest road), a workout to run on top or none, Ride.
import { esc } from './core.js';
import { loadML } from './ridemap.js';
import { MAP_STYLES } from './map.js';
import { PRESETS, DEM } from './world.js';

// go(start, workoutId) -> Promise (throws with a message to show)
export function createPicker({ $, store, world, wOptions, go }) {
  const box = $('#owModal'), osm = MAP_STYLES.osm;
  let map = null, mk = null, at = null, seq = 0, busy = false;
  $('#owPre').innerHTML = PRESETS.map(p => `<button class="chip" data-p="${p.id}">${esc(p.name)}</button>`).join('');
  const hint = (t, err = false) => { $('#owAt').textContent = t; $('#owAt').classList.toggle('err', err); };
  function ui() {
    for (const b of box.querySelectorAll('#owPre button')) b.classList.toggle('on', at?.id === b.dataset.p);
    $('#owGo').disabled = busy || !at; $('#owGo').textContent = busy ? 'Loading roads' : 'Ride';
  }
  async function pick(p, fly = false) {
    at = p; store.set('hw.owStart', p); ui();
    if (map) { mk?.setLngLat([p.lon, p.lat]); if (fly) map.jumpTo({ center: [p.lon, p.lat], zoom: 14 }); }
    hint(p.id ? p.name : 'Finding the nearest road');
    const my = ++seq, r = await world.preview(p.lat, p.lon, p.heading).catch(() => null);
    if (my !== seq) return;
    if (!r) { hint('No road near here', true); at = null; ui(); return; }
    mk?.setLngLat([r.pt[1], r.pt[0]]);
    hint(p.id ? `${p.name} · ${r.name}` : r.name);
  }
  async function initMap() {
    const ml = await loadML(), c = at || PRESETS[0];
    map = new ml.Map({ container: $('#owMap'), attributionControl: false, center: [c.lon, c.lat], zoom: 14, maxPitch: 0, dragRotate: false,
      transformRequest: url => ({ url, referrerPolicy: 'strict-origin' }),
      style: { version: 8, sources: { base: { type: 'raster', tiles: [osm.tiles], tileSize: 256, maxzoom: osm.max },
        dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: 'terrarium' } },
      layers: [{ id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-min': 0.8, 'raster-brightness-max': 0.04, 'raster-hue-rotate': 180, 'raster-saturation': -0.6 } },
        { id: 'relief', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000', 'hillshade-highlight-color': '#fff' } }] } });
    const dot = document.createElement('div'); dot.className = 'rmapdot';
    mk = new ml.Marker({ element: dot }).setLngLat([c.lon, c.lat]).addTo(map);
    map.on('click', e => pick({ lat: e.lngLat.lat, lon: e.lngLat.lng, heading: null, name: 'Open world' }));
  }
  // wid: the workout to ride there ('' free ride)
  function open(wid = '') {
    box.classList.add('on'); busy = false;
    $('#owWk').innerHTML = wOptions(wid, 'Free ride'); $('#owWk').value = wid;
    $('#owAttr').textContent = osm.attr + ' · Terrain © Mapzen, AWS';
    const last = store.get('hw.owStart', null);
    if (!map) initMap().then(() => pick(last || PRESETS[0])).catch(() => hint('Map unavailable here', true));
    else { map.resize(); pick(at || last || PRESETS[0], true); }
    ui();
  }
  const close = () => { box.classList.remove('on'); };
  $('#owPre').onclick = e => { const b = e?.target?.closest?.('[data-p]'); if (b) pick(PRESETS.find(p => p.id === b.dataset.p), true); };
  $('#owClose').onclick = close;
  box.onclick = e => { if (e.target === box) close(); };
  $('#owGo').onclick = async () => {
    if (!at || busy) return;
    busy = true; ui(); hint('Loading roads');
    try { if (await go(at, $('#owWk').value)) close(); else hint('A ride is in progress. Ride again to end it and start here.', true); }
    catch (e) { hint(e.message || 'Could not load the roads', true); }
    finally { busy = false; ui(); }
  };
  return { open, close, isOpen: () => box.classList.contains('on') };
}
