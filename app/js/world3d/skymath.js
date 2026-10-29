// World 3D sky colours on the CPU: the same Preetham scattering as three's Sky shader (vendor addons/objects/Sky.js),
// so the haze, the sky light and the sea's reflection take the colour the sky shows. Pure. tests/test_world3d.py.
const TOTAL_R = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734, STEEP = 1.5, EE = 1000, RZ = 8.4e3, MZ = 1.25e3, SUN_COS = 0.999956676946448;

const betas = ({ turbidity = 2, rayleigh = 1, mie = 0.005 }) => {
  const c = 0.2 * turbidity * 10e-18;
  return { R: TOTAL_R.map(v => v * rayleigh), M: MIE.map(v => 0.434 * c * v * mie) };
};
const sunE = cz => EE * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(Math.max(-1, Math.min(1, cz)))) / STEEP)));
// optical path factor for a direction `y` above the horizon (cosine of the zenith angle)
const airmass = y => { const za = Math.acos(Math.max(0, y)); return 1 / (Math.cos(za) + 0.15 * Math.pow(93.885 - za * 180 / Math.PI, -1.253)); };

// linear RGB the sky shader draws looking along dir [x, y, z] (unit) with the sun at sun (unit, y up); params:
// { turbidity, rayleigh, mie, mieG }. The sun disk itself is left out.
export function skyRadiance(dir, sun, p = {}) {
  const { R, M } = betas(p), g = p.mieG ?? 0.8, E = sunE(sun[1]), k = airmass(dir[1]);
  const Fex = [0, 1, 2].map(i => Math.exp(-(R[i] * RZ * k + M[i] * MZ * k)));
  const ct = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const rP = 3 / (16 * Math.PI) * (1 + Math.pow(ct * 0.5 + 0.5, 2));
  const mP = 1 / (4 * Math.PI) * ((1 - g * g) / Math.pow(1 - 2 * g * ct + g * g, 1.5));
  const mixK = Math.max(0, Math.min(1, Math.pow(1 - sun[1], 5)));
  return [0, 1, 2].map(i => {
    const ratio = (R[i] * rP + M[i] * mP) / (R[i] + M[i]);
    let Lin = Math.pow(E * ratio * (1 - Fex[i]), 1.5);
    Lin *= 1 + (Math.pow(E * ratio * Fex[i], 0.5) - 1) * mixK;
    const L0 = 0.1 * Fex[i], tex = (Lin + L0) * 0.04 + [0, 0.0003, 0.00075][i];
    return Math.pow(tex, 1 / 2.4);
  });
}
// the sun's light after the air it crosses at `el` degrees up: RGB scaled so the brightest channel is 1
export function sunTint(el, p = {}) {
  const { R, M } = betas(p), k = airmass(Math.sin(el * Math.PI / 180));
  const f = [0, 1, 2].map(i => Math.exp(-(R[i] * RZ * k + M[i] * MZ * k) * 0.55));
  const m = Math.max(...f); return f.map(v => v / m);
}
export const SUN_DISK_COS = SUN_COS;
