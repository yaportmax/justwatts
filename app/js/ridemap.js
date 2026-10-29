// Ride-screen map. 2D: the chosen style on a canvas (map.js). 3D: MapLibre (vendored, loaded on first use) with AWS
// Terrain Tiles under the same style, the camera behind the rider facing the road. Map focus swaps it with the power chart.
import { drawMap, MAP_STYLES, styleOf, lineDist, pointAt } from './map.js';

const ML = 'vendor/maplibre-gl-5.24.0/';
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', DEM_ATTR = 'Terrain © Mapzen, AWS';
let mlLoad = null;
export function loadML() {
  return mlLoad ??= new Promise((ok, bad) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ML + 'maplibre-gl.css'; document.head.appendChild(l);
    const s = document.createElement('script'); s.src = ML + 'maplibre-gl-csp.js';
    s.onload = () => { const m = globalThis.maplibregl; if (!m) return bad(new Error('no MapLibre')); m.setWorkerUrl(ML + 'maplibre-gl-csp-worker.js'); ok(m); };
    s.onerror = () => { mlLoad = null; bad(new Error('MapLibre did not load')); };
    document.head.appendChild(s);
  });
}
const R = Math.PI / 180;
const bearing = (a, b) => Math.atan2(Math.sin((b[1] - a[1]) * R) * Math.cos(b[0] * R),
  Math.cos(a[0] * R) * Math.sin(b[0] * R) - Math.sin(a[0] * R) * Math.cos(b[0] * R) * Math.cos((b[1] - a[1]) * R)) / R;
const NONE = { type: 'FeatureCollection', features: [] };
const lineGeo = pts => pts.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(p => [p[1], p[0]]) } } : NONE;
const linesGeo = ls => ({ type: 'FeatureCollection', features: ls.filter(l => l.length > 1).map(lineGeo) });
const OSM_ROADS = 'Roads © OpenStreetMap contributors';

// Others move every poll (about 2 s): each marker glides from where it is drawn to its new spot over one poll;
// a jump of a km or more snaps. at(list, now): the list at its drawn positions; done(now): the glide is over.
export function createGlide(ms = 2000) {
  let g = new Map(), t0 = 0;  // id -> { a: [lat, lon] drawn before, b: the latest }
  const k = now => Math.min(1, (now - t0) / ms);
  const pos = (id, f) => { const x = g.get(id); return x && [x.a[0] + (x.b[0] - x.a[0]) * f, x.a[1] + (x.b[1] - x.a[1]) * f]; };
  return {
    set(list, now) {
      const f = k(now), next = new Map();
      for (const o of list) {
        const from = pos(o.id, f), far = from && (Math.abs(from[0] - o.lat) > 0.02 || Math.abs(from[1] - o.lon) > 0.02);
        next.set(o.id, { a: from && !far ? from : [o.lat, o.lon], b: [o.lat, o.lon] });
      }
      g = next; t0 = now;
    },
    at(list, now) { if (!list.length) return list; const f = k(now); return list.map(o => { const p = pos(o.id, f); return p ? { ...o, lat: p[0], lon: p[1] } : o; }); },
    done: now => k(now) >= 1,
  };
}

export function createRideMap({ $, store, fit, css, toast, relayout }) {
  let style = MAP_STYLES[store.get('hw.mapStyle', 'sat')] ? store.get('hw.mapStyle', 'sat') : 'sat';  // satellite and 3D by default
  let d3 = !!store.get('hw.map3d', true), focus = !!store.get('hw.mapFocus', false);
  let cur = null;  // { ll, n, D, dist, done, open, alts }
  let map = null, rider = null, anim = null, raf = 0, camB = null, ready = false, mapLL = null, mapStyle = null, mapAlts = '', busy = false, size = '', placedOn = false;
  let others = [], marks = new Map();  // other riders (social.js): [{ id, lat, lon, label, hi }]; their 3D markers by id
  const glide = createGlide(); let oraf = 0, o2d = 0;
  const box = $('#crsMapBox'), cv = $('#crsMap'), v3 = $('#crsMap3d');
  $('#mapStyle').innerHTML = Object.entries(MAP_STYLES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('');

  // Map focus: the map takes the big chart panel, the power chart its small slot
  function place() {
    const on = focus && !!cur;
    if (on === placedOn) return false;
    placedOn = on;
    (on ? $('#rideBig') : $('#crsSlot')).appendChild(box);
    (on ? $('#crsSlot') : $('#rideBig')).appendChild($('#rideChart'));
    $('#rideOn').classList.toggle('mapfocus', on);
    return true;
  }
  function ui() {
    const live = d3 && ready;
    $('#mapStyle').value = style;
    $('#map3d').classList.toggle('on', d3); $('#map3d').setAttribute('aria-pressed', String(d3));
    $('#mapFocus').classList.toggle('on', focus); $('#mapFocus').title = focus ? 'Chart focus (F)' : 'Map focus (F)';
    const a = styleOf(style).attr;
    $('#mapAttr').textContent = a + (cur?.open && !a.includes('OpenStreetMap') ? ' · ' + OSM_ROADS : '') + (live ? ' · ' + DEM_ATTR : '');
    v3.style.display = d3 ? '' : 'none'; cv.style.display = live ? 'none' : '';  // 2D shows until the terrain is up
  }
  // 2D: the whole course; an open-world ride: about 1.6 km across, centred on the rider (points every 10 m)
  function draw2d() {
    if (!cur || (d3 && ready)) return;
    const others = shown();
    if (!cur.open) return drawMap(cv, { ll: cur.ll, dist: cur.dist, done: cur.done, fit, css, redraw: draw2d, style, attr: false, others });
    const i = Math.floor(cur.done / 10), a = Math.max(0, i - 150), b = Math.min(cur.ll.length, i + 250), w = cur.ll.slice(a, b);
    drawMap(cv, { ll: w, dist: (w.length - 1) * 10, done: cur.done - a * 10, fit, css, redraw: draw2d, style, attr: false, ends: false, alts: cur.alts,
      view: { at: pointAt(cur.ll, cur.D, cur.done), m: 1600 }, others });
  }
  // other riders as 3D markers: a dot and "name watts", friends and group mates highlighted
  function syncMarks() {
    if (!map || !ready || !globalThis.maplibregl) return;
    const keep = new Set();
    for (const o of shown()) {
      keep.add(o.id);
      let m = marks.get(o.id);
      if (!m) { const el = document.createElement('div'); el.className = 'rmo'; m = new globalThis.maplibregl.Marker({ element: el, anchor: 'left', offset: [-6, 0] }).setLngLat([o.lon, o.lat]).addTo(map); marks.set(o.id, m); }
      const el = m.getElement(); el.classList.toggle('hi', !!o.hi);  // classList: MapLibre adds its own classes
      if (!el.firstChild) el.innerHTML = '<i></i><span></span>';
      el.lastChild.textContent = o.label;
      m.setLngLat([o.lon, o.lat]);
    }
    for (const [id, m] of marks) if (!keep.has(id)) { m.remove(); marks.delete(id); }
  }
  const shown = () => glide.at(others, performance.now());
  function setOthers(list) {
    others = Array.isArray(list) ? list : [];
    glide.set(others, performance.now());
    syncMarks();
    if (others.length && !oraf) oraf = requestAnimationFrame(glideFrame);
  }
  function glideFrame(now) {
    oraf = 0;
    if (!others.length) return;
    syncMarks();
    if (cur && !(d3 && ready) && now - o2d > 60) { o2d = now; draw2d(); }  // the 2D canvas: about 15 redraws a second
    if (!glide.done(now)) oraf = requestAnimationFrame(glideFrame);
    else if (cur && !(d3 && ready)) draw2d();
  }
  function draw() { if (!cur) return; ui(); if (d3) draw3d(); draw2d(); }

  function spec() {
    const st = styleOf(style), round = { 'line-join': 'round', 'line-cap': 'round' };
    const paint = st.dark ? { 'raster-brightness-min': 0.8, 'raster-brightness-max': 0.04, 'raster-hue-rotate': 180, 'raster-saturation': -0.6 }  // inverted, like the 2D map
      : st.dim ? { 'raster-brightness-max': st.dim } : {};
    mapStyle = style; mapLL = cur.ll; mapAlts = '';
    return { version: 8,
      sources: {
        base: { type: 'raster', tiles: [st.tiles], tileSize: 256, maxzoom: st.max },
        dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: 'terrarium' },
        route: { type: 'geojson', data: lineGeo(cur.ll) }, done: { type: 'geojson', data: NONE }, alts: { type: 'geojson', data: NONE },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint },
        { id: 'alts', type: 'line', source: 'alts', layout: round, paint: { 'line-color': css('--warn'), 'line-opacity': 0.75, 'line-width': 4 } },
        { id: 'casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#000', 'line-opacity': 0.5, 'line-width': 9 } },
        { id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-color': css('--ink'), 'line-width': 4 } },
        { id: 'done', type: 'line', source: 'done', layout: round, paint: { 'line-color': css('--acc'), 'line-width': 5 } },
      ],
      terrain: { source: 'dem', exaggeration: 1.3 },
      sky: { 'sky-color': '#16202b', 'horizon-color': '#2a3442', 'fog-color': '#151920', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.75 },
    };
  }
  async function draw3d() {
    if (map) {
      if (!ready) return;
      if (mapStyle !== style) map.setStyle(spec());
      else if (mapLL !== cur.ll) { map.getSource('route')?.setData(lineGeo(cur.ll)); mapLL = cur.ll; }  // a course that grows: no restyle
      const ak = JSON.stringify(cur.alts || []); if (ak !== mapAlts) { mapAlts = ak; map.getSource('alts')?.setData(linesGeo(cur.alts || [])); }
      const D = cur.D, d = Math.max(0, Math.min(cur.done ?? 0, cur.dist)); let k = 0; while (k < D.length - 1 && D[k + 1] <= d) k++;
      map.getSource('done')?.setData(lineGeo([...cur.ll.slice(0, k + 1), pointAt(cur.ll, D, d)]));
      // glide from where the rider is drawn now to the new position over the next second
      const now = performance.now();
      anim = { d0: anim ? animAt(now) : d, d1: d, t0: now };
      if (!raf) raf = requestAnimationFrame(frame);
      return;
    }
    if (busy) return; busy = true;
    try {
      const ml = await loadML();
      if (!cur) return;
      map = new ml.Map({ container: v3, style: spec(), attributionControl: false, interactive: false, fadeDuration: 0, maxPitch: 75,
        center: [cur.ll[0][1], cur.ll[0][0]], zoom: 14, pitch: 60, transformRequest: url => ({ url, referrerPolicy: 'strict-origin' }) });  // OSM needs the origin
      const dot = document.createElement('div'); dot.className = 'rmapdot';
      rider = new ml.Marker({ element: dot }).setLngLat([cur.ll[0][1], cur.ll[0][0]]).addTo(map);
      map.on('load', () => { ready = true; draw(); syncMarks(); });
      map.on('error', e => console.warn('map:', e?.error?.message || e));
    } catch (e) {
      console.warn(e); d3 = false; store.set('hw.map3d', false); toast('3D map unavailable here'); map = null; draw();
    } finally { busy = false; }
  }
  // The camera sits behind the rider facing the next 100 m of road, the rider low in the frame. jumpTo every frame,
  // not easeTo: an eased camera freezes its terrain height for the flight and can end up inside the mountain.
  const animAt = now => anim.d0 + (anim.d1 - anim.d0) * Math.min(1, (now - anim.t0) / 1100);
  function frame(now) {
    raf = 0;
    if (!map || !ready || !d3 || !cur || !anim) return;
    const w = v3.clientWidth, h = v3.clientHeight; if (!w || !h) return;  // hidden: stop until the next update
    if (w + 'x' + h !== size) { size = w + 'x' + h; map.resize(); camB = null; }
    const { ll, D, dist } = cur, d = animAt(now), at = pointAt(ll, D, d);
    const a = Math.max(0, Math.min(d - 20, dist - 100)), tb = bearing(pointAt(ll, D, a), pointAt(ll, D, Math.min(dist, a + 100)));
    const turn = ((tb - (camB ?? tb)) % 360 + 540) % 360 - 180;
    camB = camB == null ? tb : camB + turn * Math.min(1, (now - (frame.t || now)) / 900);  // ease the heading through hairpins
    frame.t = now;
    rider.setLngLat([at[1], at[0]]);
    const center = [at[1], at[0]];  // elevation given: jumpTo looks it up at a fractional zoom and gets 0 (MapLibre 5.24)
    const z = (w > 600 ? 14.8 : 13.8) + (cur.open ? 1.2 : 0);  // open world: closer, to see the junction ahead
    map.jumpTo({ center, elevation: map.queryTerrainElevation(center) ?? 0, bearing: camB, pitch: w > 600 ? 62 : 56, zoom: z, padding: { top: Math.round(h * 0.42), bottom: 0, left: 0, right: 0 } });
    if (now - anim.t0 < 1100 || Math.abs(turn) > 0.3) raf = requestAnimationFrame(frame);
    else frame.t = 0;
  }

  // ll: the course line ([lat, lon]); rc: the ride's course state; alts: other roads at a junction (open world).
  // Returns true when the layout moved.
  function update(ll, rc, alts = null) {
    const has = !!(rc && ll?.length > 1);
    if (!has) cur = null;
    else {
      if (cur?.ll !== ll) {  // an open-world course grows: the rider glides on
        const keep = cur?.open && rc.open;
        cur = { ll, open: !!rc.open, D: lineDist(ll, rc.open ? (ll.length - 1) * 10 : rc.dist_m) }; if (!keep) anim = null;
      }
      cur.dist = rc.open ? (ll.length - 1) * 10 : rc.dist_m; cur.done = Math.min(rc.done_m, cur.dist); cur.alts = alts;
    }
    const moved = place();
    $('#crsSlot').style.display = has ? '' : 'none';
    draw();
    return moved;
  }
  function toggleFocus() {
    if (!cur) return false;
    focus = !focus; store.set('hw.mapFocus', focus);
    place(); draw(); relayout();
    return true;
  }
  $('#mapStyle').onchange = e => { style = MAP_STYLES[e.target.value] ? e.target.value : 'osm'; store.set('hw.mapStyle', style); draw(); };
  $('#map3d').onclick = () => { d3 = !d3; store.set('hw.map3d', d3); size = ''; anim = null; draw(); };
  $('#mapFocus').onclick = toggleFocus;
  return { update, toggleFocus, setOthers, focused: () => placedOn };
}
