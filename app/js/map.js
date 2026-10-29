// Route map: raster tiles on a canvas, the course line, the rider. No library and no key; every source is keyless
// and keeps its attribution. Without network the line still draws on the plain background. The 3D view is ridemap.js.
import { haversine } from './course.js';

const TILE = 256, MAXZ = 17;
// keyless tile sources; dark: inverted to match the page, dim: toned down (satellite stays as is)
export const MAP_STYLES = {
  osm: { name: 'Map', tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, dark: true, attr: '© OpenStreetMap contributors' },
  sat: { name: 'Satellite', tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, attr: 'Tiles © Esri, Maxar, Earthstar Geographics, GIS User Community' },
  topo: { name: 'Topo', tiles: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, dim: 0.85, attr: '© OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA)' },
  cycle: { name: 'Cycling', tiles: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', max: 20, dim: 0.85, attr: '© CyclOSM · © OpenStreetMap contributors' },
};
export const styleOf = k => MAP_STYLES[k] || MAP_STYLES.osm;
const URL_OF = (st, z, x, y) => st.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y);
const filterOf = st => st.dark ? 'invert(1) hue-rotate(180deg) brightness(.75) contrast(.9) saturate(.4)' : st.dim ? `brightness(${st.dim})` : 'none';

const cache = new Map();  // url -> Image (loaded or loading); bounded below
function tile(url, onload) {
  let im = cache.get(url);
  if (!im) {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    im = new Image(); im.referrerPolicy = 'strict-origin'; im.onload = () => onload(); im.src = url; cache.set(url, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

// world pixels at zoom 0
const wx = lon => (lon + 180) / 360 * TILE;
const wy = lat => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE; };

// metres along the line at each point, scaled to the course length
export function lineDist(ll, dist) {
  const D = [0];
  for (let i = 1; i < ll.length; i++) D.push(D[i - 1] + haversine({ lat: ll[i - 1][0], lon: ll[i - 1][1] }, { lat: ll[i][0], lon: ll[i][1] }));
  const k = D.at(-1) > 0 ? dist / D.at(-1) : 0;
  return D.map(d => d * k);
}

// position at d metres: [lat, lon]
export function pointAt(ll, D, d) {
  if (d <= 0) return ll[0];
  for (let i = 1; i < ll.length; i++) if (D[i] >= d) {
    const f = D[i] > D[i - 1] ? (d - D[i - 1]) / (D[i] - D[i - 1]) : 0;
    return [ll[i - 1][0] + (ll[i][0] - ll[i - 1][0]) * f, ll[i - 1][1] + (ll[i][1] - ll[i - 1][1]) * f];
  }
  return ll.at(-1);
}

// draw the whole route fitted to the canvas; done = metres ridden (null: no rider); ends: start and finish dots;
// alts: other roads to show dashed (an open-world junction); view: { at: [lat, lon], m } centres on a point, m metres across
export function drawMap(cv, { ll, dist, done = null, fit, css, redraw, style = 'osm', attr = true, ends = true, alts = null, view = null }) {
  const st = styleOf(style), filter = filterOf(st);
  const [c, w, h] = fit(cv); if (!ll?.length || w < 10 || h < 10) return;
  const pad = 14, xs = ll.map(p => wx(p[1])), ys = ll.map(p => wy(p[0]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const z = view ? Math.min(MAXZ, Math.log2(40075016.686 * Math.cos(view.at[0] * Math.PI / 180) / TILE / (view.m / Math.min(w, h))))
    : Math.min(MAXZ, Math.log2(Math.min((w - 2 * pad) / Math.max(x1 - x0, 1e-9), (h - 2 * pad) / Math.max(y1 - y0, 1e-9))));
  const s = 2 ** z, cx = (view ? wx(view.at[1]) : (x0 + x1) / 2) * s - w / 2, cy = (view ? wy(view.at[0]) : (y0 + y1) / 2) * s - h / 2;
  const P = (lat, lon) => [wx(lon) * s - cx, wy(lat) * s - cy];

  c.fillStyle = css('--panel'); c.fillRect(0, 0, w, h);
  // tiles: one zoom level above the fitted scale so they are never blurry, drawn scaled down
  const zt = Math.max(0, Math.min(st.max, MAXZ + 1, Math.ceil(z)));
  const ts = TILE * 2 ** (z - zt), n = 2 ** zt;
  let pending = false;
  for (let ty = Math.floor(cy / ts); ty * ts < cy + h; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(cx / ts); tx * ts < cx + w; tx++) {
      const im = tile(URL_OF(st, zt, ((tx % n) + n) % n, ty), () => { if (!pending) { pending = true; requestAnimationFrame(redraw); } });
      if (im) { c.filter = filter; c.drawImage(im, tx * ts - cx, ty * ts - cy, ts + 0.5, ts + 0.5); c.filter = 'none'; }
    }
  }

  const pts = ll.map(p => P(p[0], p[1])), line = (a, b) => { c.beginPath(); for (let i = a; i <= b; i++) (i === a ? c.moveTo : c.lineTo).apply(c, pts[i]); c.stroke(); };
  c.lineJoin = c.lineCap = 'round';
  c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 6; line(0, pts.length - 1);
  c.strokeStyle = css('--ink'); c.lineWidth = 3; line(0, pts.length - 1);
  if (alts?.length) {
    c.strokeStyle = css('--warn'); c.setLineDash([6, 5]); c.globalAlpha = 0.85; c.lineWidth = 3;
    for (const a of alts) { c.beginPath(); a.forEach((p, i) => (i ? c.lineTo : c.moveTo).apply(c, P(p[0], p[1]))); c.stroke(); }
    c.setLineDash([]); c.globalAlpha = 1;
  }
  if (ends) {  // start and finish
    c.fillStyle = css('--good'); c.beginPath(); c.arc(...pts[0], 4, 0, 2 * Math.PI); c.fill();
    c.fillStyle = css('--bad'); c.beginPath(); c.arc(...pts.at(-1), 4, 0, 2 * Math.PI); c.fill();
  }
  if (done != null) {
    const D = lineDist(ll, dist), d = Math.min(done, dist);
    let k = 0; while (k < D.length - 1 && D[k + 1] <= d) k++;
    const at = P(...pointAt(ll, D, d));
    c.strokeStyle = css('--acc'); c.lineWidth = 3; c.beginPath(); c.moveTo(...pts[0]); for (let i = 1; i <= k; i++) c.lineTo(...pts[i]); c.lineTo(...at); c.stroke();
    c.fillStyle = css('--acc'); c.strokeStyle = css('--bg'); c.lineWidth = 2;
    c.beginPath(); c.arc(...at, 6, 0, 2 * Math.PI); c.fill(); c.stroke();
  }
  if (!attr) return;  // the ride screen shows it as text over the map
  c.font = '10px "Inter var", system-ui, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'bottom';
  c.fillStyle = 'rgba(12,14,17,.7)'; const tw = c.measureText(st.attr).width; c.fillRect(w - tw - 8, h - 15, tw + 8, 15);
  c.fillStyle = css('--dim'); c.fillText(st.attr, w - 4, h - 2);
}
