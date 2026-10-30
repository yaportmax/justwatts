// Ride-screen map. 2D: the chosen style on a canvas (map.js). 3D: MapLibre (vendored, loaded on first use) with AWS
// Terrain Tiles under the same style, the camera behind the rider facing the road. Map focus swaps it with the power chart.
import { drawMap, MAP_STYLES, styleOf, lineDist, pointAt } from './map.js';
import { probeWebGL2, pickView } from './world3d/probe.js';
import { sharedBaked } from './world3d/baked.js';
import { draftShare } from './world3d/draft.js';

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
const OSM_ROADS = 'Roads © OpenStreetMap contributors · Imagery USDA NAIP · Elevation USGS 3DEP';

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

export function createRideMap({ $, store, fit, css, toast, relayout, live = () => null, onDraft = () => {} }) {
  let style = MAP_STYLES[store.get('hw.mapStyle', 'sat')] ? store.get('hw.mapStyle', 'sat') : 'sat';  // satellite and 3D by default
  let d3 = !!store.get('hw.map3d', true);
  // map focus, kept apart for the open world (the world fills the big panel by default) and for courses (the chart does)
  const fkey = () => cur?.open ? 'hw.worldFocus' : 'hw.mapFocus', isFocus = () => !!store.get(fkey(), !!cur?.open);
  // the open world's 3D world view (world3d/view.js, three.js loaded on first use); falls back to MapLibre 3D
  let wv = null, wvBusy = false, wvFailed = false, owPref = store.get('hw.owView', null), ow = null;
  let cur = null;  // { ll, n, D, dist, done, open, alts }
  let map = null, rider = null, anim = null, raf = 0, camB = null, ready = false, mapLL = null, mapStyle = null, mapAlts = '', busy = false, size = '', placedOn = false;
  let others = [], marks = new Map();  // other riders (social.js): [{ id, lat, lon, label, hi }]; their 3D markers by id
  const glide = createGlide(); let oraf = 0, o2d = 0;
  const box = $('#crsMapBox'), cv = $('#crsMap'), v3 = $('#crsMap3d');
  const doc = globalThis.document, wbox = doc?.createElement('div'), wbtn = doc?.createElement('button'), cbtn = doc?.createElement('button'), sbtn = doc?.createElement('button'), dbadge = doc?.createElement('span');
  if (wbox) {
    wbox.id = 'crsWorld'; wbox.style.display = 'none'; box.insertBefore?.(wbox, v3.nextSibling);
    wbtn.id = 'mapWorld'; wbtn.textContent = 'World'; wbtn.title = 'Open world in 3D'; wbtn.setAttribute('aria-pressed', 'false');
    cbtn.id = 'mapCam'; cbtn.title = 'Camera (V)'; cbtn.setAttribute('aria-label', 'Camera');
    cbtn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.2"/></svg>';
    sbtn.id = 'mapSound'; sbtn.title = 'Sound (M)'; sbtn.setAttribute('aria-label', 'Sound');
    dbadge.className = 'w3draft'; dbadge.textContent = 'Draft';
    const m3 = $('#map3d'); m3.parentNode?.insertBefore?.(wbtn, m3); m3.parentNode?.insertBefore?.(cbtn, $('#mapFocus')); m3.parentNode?.insertBefore?.(sbtn, $('#mapFocus')); box.appendChild?.(dbadge);
  }
  const kind = () => pickView({ pref: cur?.open ? owPref : null, open: !!cur?.open, gl: !!cur?.open && probeWebGL2(), failed: wvFailed, d3 });
  $('#mapStyle').innerHTML = Object.entries(MAP_STYLES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('');

  // Map focus: the map takes the big chart panel, the power chart its small slot
  function place() {
    const on = !!cur && isFocus();
    if (on === placedOn) return false;
    placedOn = on;
    (on ? $('#rideBig') : $('#crsSlot')).appendChild(box);
    (on ? $('#crsSlot') : $('#rideBig')).appendChild($('#rideChart'));
    $('#rideOn').classList.toggle('mapfocus', on);
    return true;
  }
  // the world HUD: the world fills the ride screen, the numbers, chart and controls over it (css #rideOn.hud)
  function hud(on) {
    const el = $('#rideOn'); if (!el?.classList || el.classList.contains('hud') === on) return;
    el.classList.toggle('hud', on); size = ''; setTimeout(relayout);
  }
  function ui() {
    const k = cur ? kind() : '2d', w = k === 'world';
    hud(!!cur && w && isFocus());
    if (wbox) {
      wbtn.style.display = cur?.open && probeWebGL2() && !wvFailed ? '' : 'none'; wbtn.classList.toggle('on', w); wbtn.setAttribute('aria-pressed', String(w));
      cbtn.style.display = w ? '' : 'none'; sbtn.style.display = w ? '' : 'none'; soundIcon(); wbox.style.display = w ? '' : 'none'; $('#mapStyle').style.display = w ? 'none' : '';
      if (!w) dbadge.classList.remove('on');
    }
    if (w) {
      $('#map3d').classList.remove('on'); $('#map3d').setAttribute('aria-pressed', 'false');
      $('#mapFocus').classList.toggle('on', isFocus()); $('#mapFocus').title = isFocus() ? 'Chart focus (F)' : 'Map focus (F)';
      $('#mapAttr').textContent = '© OpenStreetMap contributors · Terrain © Mapzen, AWS';
      v3.style.display = 'none'; cv.style.display = 'none'; return;
    }
    const live = d3 && ready;
    $('#mapStyle').value = style;
    $('#map3d').classList.toggle('on', d3); $('#map3d').setAttribute('aria-pressed', String(d3));
    $('#mapFocus').classList.toggle('on', isFocus()); $('#mapFocus').title = isFocus() ? 'Chart focus (F)' : 'Map focus (F)';
    const a = styleOf(style).attr;
    $('#mapAttr').textContent = a + (cur?.open && !a.includes('OpenStreetMap') ? ' · ' + OSM_ROADS : '') + (live ? ' · ' + DEM_ATTR : '');
    v3.style.display = d3 ? '' : 'none'; cv.style.display = live ? 'none' : '';  // 2D shows until the terrain is up
  }
  // 2D: the whole course; an open-world ride: about 1.6 km across, centred on the rider (points every 10 m)
  function draw2d() {
    if (!cur || (d3 && ready) || kind() === 'world') return;
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
  // drafting: a rider close ahead on my line (open world); the engine hears of it at most every 2 s
  let draft = 0, draftSent = 0;
  function drafts(now = performance.now()) {
    let k = 0;
    if (cur?.open && others.length && cur.D) {
      const d = Math.max(0, Math.min(cur.done, cur.dist)), p = pointAt(cur.ll, cur.D, d), q = pointAt(cur.ll, cur.D, Math.min(cur.dist, d + 8));
      k = draftShare({ lat: p[0], lon: p[1], h: bearing(p, q) }, shown());
    }
    if (Math.abs(k - draft) > 0.04 || (k > 0 && now - draftSent > 2000) || (!k && draft)) { draft = k; draftSent = now; onDraft(k); }
    dbadge?.classList.toggle('on', k > 0.1);
  }
  function glideFrame(now) {
    oraf = 0;
    if (!others.length) { drafts(now); return; }
    drafts(now);
    syncMarks();
    if (cur && !(d3 && ready) && kind() !== 'world' && now - o2d > 60) { o2d = now; draw2d(); }  // the 2D canvas: about 15 redraws a second
    if (!glide.done(now)) oraf = requestAnimationFrame(glideFrame);
    else if (cur && !(d3 && ready)) draw2d();
  }
  function draw() {
    if (!cur) { closeWorld(); return; }
    const k = kind(); ui();
    if (k === 'world') return drawWorld();
    closeWorld();
    if (d3) draw3d(); draw2d();
  }
  // the world view: built on first use, fed the ride on every update; any failure turns it off for this session
  function closeWorld() { if (wv) { wv.dispose(); wv = null; } }
  function worldFail(why) {
    if (wvFailed) return; wvFailed = true; wv = null; console.warn('world view off:', why);
    toast(/slow/.test(why || '') ? 'Switched to the 3D map for speed' : '3D world unavailable here, showing the 3D map');
    d3 = true; draw();
  }
  function worldState() {
    const lv = live() || {};
    return { ll: cur.ll, ele: ow?.ele, dist: cur.dist, d: cur.done, v: cur.v ?? 0, cad: lv.cadence || 0, alts: cur.alts || [], turn: ow?.turn || null };
  }
  async function drawWorld() {
    if (wv) { try { wv.update(worldState()); } catch (e) { worldFail(e.message); } return; }
    if (wvBusy) return; wvBusy = true;
    try {
      const m = await import('./world3d/view.js');
      if (!cur || kind() !== 'world') return;
      wv = m.createWorldView({ container: wbox, baked: sharedBaked(), getOthers: shown, onFail: worldFail, quality: store.get('hw.worldQ', 0),
        time: store.get('hw.worldTime', 'day'), sound: soundOn(), fog: store.get('hw.worldFog', true) !== false, kit: KITS[store.get('hw.worldKit', 0) % KITS.length] });
      wv.update(worldState());
    } catch (e) { worldFail(e?.message || String(e)); }
    finally { wvBusy = false; }
  }

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
    // open world: third person, low behind the rider looking down the road; a course: higher, to see more of it
    const z = (w > 600 ? 14.8 : 13.8) + (cur.open ? 1.5 : 0), pitch = cur.open ? (w > 600 ? 74 : 70) : w > 600 ? 62 : 56;
    map.jumpTo({ center, elevation: map.queryTerrainElevation(center) ?? 0, bearing: camB, pitch, zoom: z, padding: { top: Math.round(h * (cur.open ? 0.56 : 0.42)), bottom: 0, left: 0, right: 0 } });
    if (now - anim.t0 < 1100 || Math.abs(turn) > 0.3) raf = requestAnimationFrame(frame);
    else frame.t = 0;
  }

  // ll: the course line ([lat, lon]); rc: the ride's course state; alts: other roads at a junction (open world).
  // Returns true when the layout moved.
  function update(ll, rc, alts = null, view = null) {
    ow = view;
    const has = !!(rc && ll?.length > 1);
    if (!has) { cur = null; hud(false); }
    else {
      if (cur?.ll !== ll) {  // an open-world course grows: the rider glides on
        const keep = cur?.open && rc.open;
        cur = { ll, open: !!rc.open, D: lineDist(ll, rc.open ? (ll.length - 1) * 10 : rc.dist_m) }; if (!keep) anim = null;
      }
      cur.dist = rc.open ? (ll.length - 1) * 10 : rc.dist_m; cur.done = Math.min(rc.done_m, cur.dist); cur.alts = alts; cur.v = (rc.speed_kmh || 0) / 3.6;
    }
    const moved = place();
    drafts();
    $('#crsSlot').style.display = has ? '' : 'none';
    draw();
    return moved;
  }
  function toggleFocus() {
    if (!cur) return false;
    store.set(fkey(), !isFocus());
    place(); draw(); relayout();
    return true;
  }
  $('#mapStyle').onchange = e => { style = MAP_STYLES[e.target.value] ? e.target.value : 'osm'; store.set('hw.mapStyle', style); draw(); };
  $('#map3d').onclick = () => {
    if (cur?.open && kind() === 'world') { d3 = true; owPref = '3d'; }  // from the world view to the 3D map
    else { d3 = !d3; if (cur?.open) owPref = d3 ? '3d' : '2d'; }
    store.set('hw.map3d', d3); if (cur?.open) store.set('hw.owView', owPref); size = ''; anim = null; draw();
  };
  if (wbtn) {
    wbtn.onclick = () => { owPref = kind() === 'world' ? (d3 ? '3d' : '2d') : 'world'; store.set('hw.owView', owPref); size = ''; anim = null; draw(); };
    cbtn.onclick = () => toggleCamera();
  }
  function toggleCamera() { if (!wv) return false; const m = wv.toggleCamera(); cbtn?.classList.toggle('on', m === 'first'); return true; }
  const TIMES = ['day', 'afternoon', 'golden', 'sunset', 'dusk', 'dawn', 'morning'];
  function cycleTime() { if (!wv) return false; const t = TIMES[(TIMES.indexOf(store.get('hw.worldTime', 'day')) + 1) % TIMES.length]; store.set('hw.worldTime', wv.setTime(t)); return true; }
  // world sound: its own switch, off at first when the app's sounds (beeps) are off
  const soundOn = () => store.get('hw.worldSound', store.get('hw.settings', {})?.beeps !== false) !== false;
  const SPK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z"/>', WAVES = '<path d="M13 7.5a3.5 3.5 0 0 1 0 5M15 5.5a6.5 6.5 0 0 1 0 9"/></svg>', MUTE = '<path d="M13.5 8l4 4M17.5 8l-4 4"/></svg>';
  function soundIcon() { if (!sbtn) return; const on = soundOn(); sbtn.innerHTML = SPK + (on ? WAVES : MUTE); sbtn.classList.toggle('on', !on); sbtn.setAttribute('aria-pressed', String(!on)); }
  function toggleSound() { if (!wv) return false; store.set('hw.worldSound', !soundOn()); wv.setSound(soundOn()); soundIcon(); return true; }
  if (sbtn) sbtn.onclick = () => toggleSound();
  function toggleFog() { if (!wv) return false; store.set('hw.worldFog', wv.setFog(!wv.fog())); return true; }
  // kit colours for the rider in the world
  const KITS = [0xf2c230, 0xd94b3d, 0x2f7fd9, 0x2fbf71, 0xf2f2ee, 0x1d232b, 0xe8609a, 0xf08a24];
  function cycleKit() { if (!wv) return false; const k = (store.get('hw.worldKit', 0) + 1) % KITS.length; store.set('hw.worldKit', k); wv.setKit(KITS[k]); return true; }
  $('#mapFocus').onclick = toggleFocus;
  return { update, toggleFocus, setOthers, toggleCamera, cycleTime, toggleSound, toggleFog, cycleKit, focused: () => placedOn, worldStats: () => wv?.stats() ?? null, view: () => cur ? kind() : null };
}
