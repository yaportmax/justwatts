// Other riders glide between polls (ridemap.js createGlide). stdout: JSON report for tests/test_social_glide.py.
import { createGlide } from '../../app/js/ridemap.js';
const g = createGlide(2000), r = (lat, lon, id = 'a') => [{ id, lat, lon, label: id }];
const at = (list, t) => g.at(list, t).map(o => [+o.lat.toFixed(6), +o.lon.toFixed(6)]);
const out = {};
g.set(r(37, -122), 0); out.first = at(r(37, -122), 500);                       // first sight: drawn where it is
g.set(r(37.001, -122), 2000);
out.half = at(r(37.001, -122), 3000); out.end = at(r(37.001, -122), 4000); out.done = [g.done(3000), g.done(4000)];
g.set(r(37.002, -122), 3000 + 2000 + 0); g.set(r(37.004, -122), 5000 + 1000);  // a new poll mid-glide starts from the drawn spot
out.mid = at(r(37.004, -122), 6000);
g.set(r(37.5, -122), 9000); out.jump = at(r(37.5, -122), 9001);                // km away: snaps
g.set([...r(37.5, -122), ...r(1, 1, 'b')], 10000); out.newcomer = at([...r(37.5, -122), ...r(1, 1, 'b')], 10000);
out.empty = g.at([], 0).length;
console.log(JSON.stringify(out));
