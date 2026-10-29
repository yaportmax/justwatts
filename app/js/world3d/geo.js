// World 3D coordinates: metres around an origin (x east, y up = metres above sea level, z south, as three.js has it),
// Web Mercator tiles (Terrarium terrain) and headings. Pure.
const R = Math.PI / 180;
export const M = 111195;  // metres per degree of latitude (the haversine Earth of course.js)

export function makeProj(lat0, lon0) {
  const k = Math.cos(lat0 * R) * M;
  return { lat0, lon0, x: lon => (lon - lon0) * k, z: lat => -(lat - lat0) * M, lon: x => lon0 + x / k, lat: z => lat0 - z / M,
    xz: (lat, lon) => [(lon - lon0) * k, -(lat - lat0) * M] };
}
// fractional tile coordinates at zoom z, and back
export const tileX = (lon, z) => (lon + 180) / 360 * 2 ** z;
export function tileY(lat, z) { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z; }
export const lonOf = (X, z) => X / 2 ** z * 360 - 180;
export const latOf = (Y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / 2 ** z))) / R;
// a tile's [s, w, n, e]
export const tileBox = (z, x, y) => [latOf(y + 1, z), lonOf(x, z), latOf(y, z), lonOf(x + 1, z)];
export const key = (z, x, y) => `${z}/${x}/${y}`;
export const unkey = k => k.split('/').map(Number);

// a heading in degrees (clockwise from north) as a direction [dx, dz]
export const dirOf = deg => [Math.sin(deg * R), -Math.cos(deg * R)];
export const headingOf = (dx, dz) => (Math.atan2(dx, -dz) / R + 360) % 360;
export const angDiff = (a, b) => ((b - a) % 360 + 540) % 360 - 180;
