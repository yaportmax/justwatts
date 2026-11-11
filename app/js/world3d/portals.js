// (A44) The portals of the bored tunnels, measured from Street View: the headwall at the way's end, the walls of its court, and the rules that keep the
// hill behind it whole. A portal's frame: s out of the tunnel along its axis from the way's end, d to the right of that (heights over the road at the end).
//   at, hd      the way's end and the heading out of the tunnel there
//   court       [d0, d1, out]: the ground in front of the headwall's plane between the walls, out to `out`: the hand-built ground's alone. The tile's
//               ground is not drawn there, is not pressed under the hand ground there (terrain.js pressUnderSteps skip) and behind the plane it keeps
//               the lidar's heights (view.js: no portal cut, no carve, no push), so the hill stands up to the headwall's back
//   sink        [d0, d1, out]: the hand ground there no higher than the road's level (the road's own width and the strips to the walls)
//   head        [d0, d1]: the headwall's ends; wing: its top line on from there in the same plane [[d, h], ...]; white: painted
//   walls       along the court's sides: a, b [s, d] of the face, top [h at a, h at b], th thick, to: 1 the body to the right of a to b, -1 to the left
//   generic     no measurements yet: view.js's headwall and wings as before, the rules above all the same
// Baker-Barry tunnel, east portal (Street View 37.83897,-122.48574 heading 295 and 37.83892,-122.48540 heading 300, 2026-11-10): a white painted headwall
// off centre (4.5 m south of the axis, 5.6 m north), a bare concrete wall along the road's south side from it, falling from just under the headwall's top to
// the ground 10 m out, and on the north a white wing in the headwall's plane stepping down to a low block; flat grass in front of that.
export const PLANE = -1.1;   // the headwall's mid plane, s
export const MOUTH = [1.6, 3.8];   // before the opening: out to s and the half width, the tunnel road's end and its floor (no hand ground there)
export const PORTALS = [
  { id: 'baker-barry-east', at: [37.839015, -122.485897], hd: 116.1, court: [-13.5, 4.5, 10.5], sink: [-4.5, 4.6, 10.5], head: [-5.6, 4.5], white: true,
    wing: [[-5.6, 6.9], [-10.2, 2.8], [-10.2, 1.9], [-13.5, 1.9]],
    walls: [{ a: [-1.1, 4.4], b: [10.5, 4.9], top: [6.4, 0.4], th: 0.5, to: 1 }] },
  { id: 'baker-barry-west', at: [37.841860, -122.493248], hd: 296.1, court: [-5.6, 5.6, 6], sink: [-4.5, 4.5, 9], generic: true },
];
export function portalFrame(p, proj) {
  const [ox, oz] = proj.xz(p.at[0], p.at[1]), a = p.hd * Math.PI / 180, ux = Math.sin(a), uz = -Math.cos(a);
  return { p, ox, oz, ux, uz, sd: (x, z) => [(x - ox) * ux + (z - oz) * uz, -(x - ox) * uz + (z - oz) * ux], xz: (s, d) => [ox + ux * s - uz * d, oz + uz * s + ux * d] };
}
const FR = new WeakMap();
export const portalFrames = proj => { let f = FR.get(proj); if (!f) FR.set(proj, f = PORTALS.map(p => portalFrame(p, proj))); return f; };
// the portal within r of a point (a way's end)
export const portalAt = (x, z, proj, r = 10) => portalFrames(proj).find(F => Math.hypot(x - F.ox, z - F.oz) < r) ?? null;
export const inCourt = (F, x, z) => { const s = (x - F.ox) * F.ux + (z - F.oz) * F.uz; if (s < PLANE || s > F.p.court[2]) return false; const d = -(x - F.ox) * F.uz + (z - F.oz) * F.ux; return d >= F.p.court[0] && d <= F.p.court[1]; };
// is a point in a court, for a box of ground: null where no court is near it
export function courtSkip(proj, x0, z0, x1, z1) {
  const L = portalFrames(proj).filter(F => F.ox > x0 - 40 && F.ox < x1 + 40 && F.oz > z0 - 40 && F.oz < z1 + 40); if (!L.length) return null;
  return (x, z) => { for (const F of L) if (Math.abs(x - F.ox) < 40 && Math.abs(z - F.oz) < 40 && inCourt(F, x, z)) return true; return false; };
}
