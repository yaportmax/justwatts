// Drafting in the open world: a rider close ahead on my line takes some of my air drag. Pure. tests/test_world3d.py.
import { DRAFT_MAX } from '../course.js';

const M = 111195;
// me: { lat, lon, h: heading in degrees }, others: [{ lat, lon }] -> the share of air drag saved, 0 .. DRAFT_MAX:
// full from 1.5 to 4 m behind a wheel, fading out by 14 m, only within about a lane of my line
export function draftShare(me, others) {
  if (!me || !others?.length) return 0;
  const k = Math.cos(me.lat * Math.PI / 180), fx = Math.sin(me.h * Math.PI / 180), fy = Math.cos(me.h * Math.PI / 180);
  let best = 0;
  for (const o of others) {
    const dx = (o.lon - me.lon) * k * M, dy = (o.lat - me.lat) * M, ahead = dx * fx + dy * fy, side = Math.abs(dx * fy - dy * fx);
    if (ahead < 1.5 || ahead > 14 || side > 1.6) continue;
    best = Math.max(best, ahead <= 4 ? 1 : (14 - ahead) / 10);
  }
  return Math.round(best * DRAFT_MAX * 100) / 100;
}
