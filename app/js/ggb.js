// The Golden Gate Bridge's deck, shared by the ride and the 3D world so that what is ridden is what is drawn: the
// course takes its heights on the bridge from here (world.js), the 3D world draws the deck from here (world3d/marin.js)
// and stands the rider on it (world3d/view.js).
// Axis: the two tower centres (where the OpenStreetMap sidewalks step round the towers, 1281 m apart). Along it from
// mid span, s metres (south to north); across it, t metres (east +). The deck is one structure from the south abutment
// (s -1288, where the land meets it) over both anchorages to Vista Point (s 1415): straight between s -1130 and 1220, its centre line curving
// east to the south abutment and west to Vista Point (the mean of the two OpenStreetMap motorway ways, 537838948 and
// 595194543 south, 1557712986 and 1557712987 north). Both sidewalks are on it, stepping out round the tower legs.
export const GGB = {
  south: [37.814, -122.47788], north: [37.82547, -122.47923], span: [-1288, 1415], towers: 640.5, anchor: 981, deckW: 27.4, towerTop: 227,
  // the centre line's offset t at s where it curves (straight at 0 between; OpenStreetMap's ways run on to s -1302)
  curve: [[-1302, 56], [-1295, 51.6], [-1280, 42.8], [-1265, 34.9], [-1250, 27.4], [-1235, 20.9], [-1220, 15.3], [-1205, 10.6], [-1190, 6.5],
    [-1175, 3.4], [-1160, 1.1], [-1145, 0], [1220, 0], [1235, -0.9], [1250, -2.2], [1265, -4.2], [1280, -7], [1295, -10.4], [1310, -14.5],
    [1325, -19.4], [1340, -25.4], [1355, -32.1], [1370, -39.6], [1385, -48.2], [1400, -57], [1415, -66]],
};
const M = 111195, lat0 = (GGB.south[0] + GGB.north[0]) / 2, lon0 = (GGB.south[1] + GGB.north[1]) / 2, kx = Math.cos(lat0 * Math.PI / 180) * M;
const ax = (GGB.north[1] - GGB.south[1]) * kx, an = (GGB.north[0] - GGB.south[0]) * M, AL = Math.hypot(ax, an), ux = ax / AL, un = an / AL;
// lat, lon <-> s, t (metres on a local flat map round mid span: well under a centimetre off over the bridge)
export function toST(lat, lon) { const x = (lon - lon0) * kx, n = (lat - lat0) * M; return [x * ux + n * un, x * un - n * ux]; }
export function fromST(s, t) { const x = s * ux + t * un, n = s * un - t * ux; return [lat0 + n / M, lon0 + x / kx]; }
// the centre line's offset at s
export function centreT(s) {
  const C = GGB.curve;
  if (s <= C[0][0]) return C[0][1]; if (s >= C.at(-1)[0]) return C.at(-1)[1];
  let i = 1; while (C[i][0] < s) i++;
  return C[i - 1][1] + (C[i][1] - C[i - 1][1]) * (s - C[i - 1][0]) / (C[i][0] - C[i - 1][0]);
}
// The roadway's height at s: a straight line between the ground at the two ends (the DEM at the south abutment and
// at Vista Point), with a crown over the suspended spans (6 m at mid span, easing to none at the anchorages): about
// 68 m at mid span, the deck's underside some 60 m over the water. Grades stay under 1.6 %.
export const H0 = 53.8, H1 = 71.3;
export function deckH(s) {
  const c = Math.max(-1, Math.min(1, s / 985)), k = Math.cos(c * Math.PI / 2);
  return H0 + (H1 - H0) * (Math.max(GGB.span[0], Math.min(GGB.span[1], s)) - GGB.span[0]) / (GGB.span[1] - GGB.span[0]) + 6 * k * k;
}
// how far either side of the centre line the deck reaches at s: its sidewalks, round the tower legs, the wider north end
export function halfW(s) {
  const tw = Math.abs(Math.abs(s) - GGB.towers);
  return tw < 20 ? 21.5 : s > 1240 ? 15.5 + Math.min(3, (s - 1240) / 50) : 15.2;
}
// a point on the deck: { s, t (from the centre line), h (the roadway) }, or null off it
export function onDeck(lat, lon) {
  const [s, t] = toST(lat, lon);
  if (s < GGB.span[0] - 2 || s > GGB.span[1] + 2) return null;
  const dt = t - centreT(s);
  return Math.abs(dt) <= halfW(s) ? { s, t: dt, h: deckH(s) } : null;
}
