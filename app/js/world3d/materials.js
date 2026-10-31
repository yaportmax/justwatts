// World 3D materials. The ground is coloured in the shader from its class weights (terrain.js classMasks), the slope,
// the way a slope faces, hollows and one tileable noise texture at four scales: golden grass going green on the
// shaded north slopes and in the gullies, coyote brush, oak woods, rock on the steep, a bump close up. The same
// colour function runs in the grass blades' vertex shader, so the grass is the ground's colour. Roads draw their
// markings and asphalt in the shader; buildings take windows from a mipmapped atlas (tex.js). Colours are in sRGB.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { textures } from './tex.js';

// shared by every material that moves in the wind
export const WIND = { time: { value: 0 }, gust: { value: 0.6 } };
// tunnel bores near the rider: the ground inside one is not drawn (seen through a portal it would fill the bore).
// a: [x0, z0, x1, z1] a straight piece of bore, b: [floor y at 0, at 1, half width, height]
// the redwood groves (props.js REDWOODS) in local metres [x0, z0, x1, z1]: needle litter on the ground under them
export const REDWOOD = { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, -1, -1)) };
// the Marin Headlands (props.js HEADLANDS) in local metres [x0, z0, x1, z1]: green coastal grass on the open hills
export const HL = { value: new THREE.Vector4(0, 0, -1, -1) };
// San Francisco north of the park, seen across the strait (props.js SF_CITY): its ground a city's, not open hills
export const SFB = { value: new THREE.Vector4(0, 0, -1, -1) };
// the Headlands' ground cover (veg.js): per cell scrub, trees, bare earth, known (RGBA, blended between cells) over
// box [x0, z0, x1, z1] in local metres (none until it loads); near: the radius the scrub's bushes are drawn in
export const VEG = { tex: { value: null }, box: { value: new THREE.Vector4(0, 0, -1, -1) }, near: { value: 150 } };
export const BORES = { a: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) }, b: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) }, n: { value: 0 } };

const GLSL_COMMON = /* glsl */`
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
`;
// p: world xz; n: world normal; m: [wood, green, sand, town]; m2: [cut bank, rock, lake, farm]; cv: hollow (+) or
// ridge (-); h: height. Returns the albedo; rk: how much of it is rock or bare earth (no grass grows there).
const GLSL_GROUND = /* glsl */`
uniform sampler2D tNoise; uniform vec4 rwBox[4]; uniform vec4 hlBox; uniform vec4 sfBox; uniform sampler2D tVeg; uniform vec4 vegBox;
vec4 jwN(vec2 uv) { return texture2D(tNoise, uv); }
vec4 jwVeg(vec2 p) {
  vec2 uv = (p - vegBox.xy) / (vegBox.zw - vegBox.xy);
  return texture2D(tVeg, clamp(uv, 0.0, 1.0)) * step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
}
// set by jwGround: how much of the point is coastal scrub from the aerial imagery, and whether there is any there; set
// before it: how near the point is (1: among the scrub's drawn bushes, its ground the litter and grass under them)
float jwScrub = 0.0, jwKnown = 0.0, jwNear = 0.0, jwPav = 0.0;
vec3 jwGround(vec2 p, vec3 n, vec4 m, vec4 m2, float cv, float h, out float rk) {
  float slope = 1.0 - n.y;
  float north = clamp(-n.z * 1.9, 0.0, 1.0) * smoothstep(0.03, 0.22, slope);
  // two looks at the noise give every scale (its four channels are four sizes): about 2 km, 250 m, 160 m, 80 m, 40 m, 20 m
  vec4 nA = jwN(p / 4100.0 + 0.31), nB = jwN(mat2(0.8, -0.6, 0.6, 0.8) * p / 330.0 + 0.7);
  float big = nA.a, mid = nA.r, small = nB.g, fine = nB.r, patch80 = nB.b, patch160 = nB.a;
  float wood = m.x, green = m.y, sand = m.z, town = m.w, cut = m2.x, rockc = m2.y, lake = m2.z, farm = m2.w;
  // the Headlands' cover from the aerial imagery where there is one (veg.js), the cells' edges broken up a little; its
  // trees in place of OpenStreetMap's woods and scrub there
  vec4 vg = jwVeg(p + (jwN(p / 13.0).ba - 0.5) * 7.0); float known = vg.a;
  float pav = min(vg.r, min(vg.g, vg.b)); vg.rgb -= pav;  // paving and gravel by the roads (all three at once, veg.js)
  wood = mix(wood, vg.g, known);
  // the open hills: straw, gold and tawny patches
  vec3 straw = srgb(vec3(0.85, 0.75, 0.52)), gold = srgb(vec3(0.76, 0.62, 0.37)), tawny = srgb(vec3(0.62, 0.49, 0.31));
  vec3 c = mix(gold, straw, smoothstep(0.25, 0.8, mid * 0.75 + small * 0.25));
  c = mix(c, tawny, smoothstep(0.5, 0.9, small) * 0.5);
  // the Headlands: green coastal grass with dry patches (Street View, spring), the edge eased over a kilometre
  float hl = smoothstep(hlBox.x, hlBox.x + 1000.0, p.x) * (1.0 - smoothstep(hlBox.z - 1000.0, hlBox.z, p.x)) * smoothstep(hlBox.y, hlBox.y + 1000.0, p.y) * (1.0 - smoothstep(hlBox.w - 1000.0, hlBox.w, p.y));
  vec3 hlg = mix(srgb(vec3(0.47, 0.49, 0.35)), srgb(vec3(0.58, 0.57, 0.44)), smoothstep(0.3, 0.75, mid * 0.6 + small * 0.4));
  // and coastal scrub over most of it (coyote brush, sage: dark olive, about #6f7a52 to #8a8f6a), grass in the clearings
  vec3 scrubC = mix(srgb(vec3(0.38, 0.40, 0.29)), srgb(vec3(0.49, 0.50, 0.39)), smoothstep(0.35, 0.7, fine)) * (0.9 + 0.2 * small);
  float scrA = smoothstep(0.42, 0.62, mid * 0.5 + small * 0.35 + patch80 * 0.15 + north * 0.25) * (1.0 - town);
  hlg = mix(hlg, scrubC, scrA);
  c = mix(c, mix(hlg, srgb(vec3(0.66, 0.61, 0.43)), smoothstep(0.78, 0.95, small) * 0.5), hl * 0.9);
  // the scrub's clumps: bushes a few metres across, darker in their hollows
  if (hl * scrA > 0.02) { float bc = jwN(p / 4.3 + 0.17).g; c *= 1.0 - hl * scrA * (0.3 - 0.5 * bc); }
  float sf = step(sfBox.x, p.x) * step(p.x, sfBox.z) * step(sfBox.y, p.y) * step(p.y, sfBox.w);
  c *= 0.9 + 0.2 * fine;
  // green: shaded north slopes, hollows and gullies, parks and lawns, the damp coast
  float moist = north * 0.72 + max(cv, 0.0) * 1.3 - max(-cv, 0.0) * 0.5 + (big - 0.5) * 0.35 + (mid - 0.5) * 0.25 + green * 1.1 + town * 0.35;
  vec3 g1 = srgb(vec3(0.50, 0.55, 0.29)), g2 = srgb(vec3(0.34, 0.42, 0.20));
  c = mix(c, mix(g1, g2, small), smoothstep(0.38, 0.8, moist));
  // coyote brush and coastal scrub: dark olive patches, more where it is damp
  float scr = smoothstep(0.58, 0.92, small * 0.6 + mid * 0.3 + north * 0.22 + max(cv, 0.0) * 0.6 + wood * 0.25) * (1.0 - town) * (1.0 - green * 0.7) * (1.0 - known);
  c = mix(c, srgb(vec3(0.33, 0.36, 0.21)) * (0.88 + 0.24 * fine), scr * 0.6);
  // woods: dark under the canopy (and the canopy itself from far away)
  vec3 forest = mix(srgb(vec3(0.13, 0.19, 0.10)), srgb(vec3(0.21, 0.28, 0.14)), smoothstep(0.3, 0.7, small)) * (0.8 + 0.4 * fine);
  c = mix(c, forest, smoothstep(0.3, 0.7, wood + (small - 0.5) * 0.5));
  // farms: pasture and hay in long fields
  vec3 field = mix(srgb(vec3(0.70, 0.64, 0.40)), srgb(vec3(0.46, 0.54, 0.28)), step(0.5, patch160));
  c = mix(c, field * (0.9 + 0.2 * fine), farm * 0.85);
  // town: lawns, gardens, paving
  c = mix(c, mix(srgb(vec3(0.42, 0.50, 0.27)), srgb(vec3(0.55, 0.54, 0.50)), smoothstep(0.45, 0.7, small)), town * 0.7);
  // San Francisco seen across the strait (the Presidio, Sea Cliff, the Richmond, the Marina): the city's speckle of pale
  // roofs and streets, grey-green gardens and woods, over whatever grows there (its blocks are too small to survive into
  // the distant tiles, which would leave it golden hills and dark woods; Street View: blue-grey with pale houses)
  // (houses, streets and gardens in the finest noise, no hard edges; its parks and woods dark grey green: Lincoln Park,
  // the Presidio)
  c = mix(c, mix(mix(srgb(vec3(0.68, 0.68, 0.66)), srgb(vec3(0.42, 0.45, 0.42)), smoothstep(0.3, 0.7, fine)), srgb(vec3(0.24, 0.29, 0.26)), smoothstep(0.3, 0.6, wood)), sf * 0.9);
  // the Headlands from the aerial imagery (veg.js; its colours from the same imagery, USDA NAIP): grass in the
  // openings, greener in the shade and the hollows; coastal scrub, coyote brush to sage, in clumps of bushes with shade
  // between them; bare red-brown earth; the litter under the groves
  jwScrub = 0.0; jwKnown = known;
  if (known > 0.0) {
    float sc = smoothstep(0.25, 0.75, vg.r + (fine - 0.5) * 0.35), br = smoothstep(0.3, 0.7, vg.b + (fine - 0.5) * 0.3), tr = smoothstep(0.3, 0.7, vg.g);
    vec3 grassC = mix(srgb(vec3(0.41, 0.47, 0.31)), srgb(vec3(0.51, 0.52, 0.38)), smoothstep(0.3, 0.75, mid * 0.6 + small * 0.4));
    grassC = mix(grassC, srgb(vec3(0.36, 0.45, 0.25)), clamp(north * 0.5 + max(cv, 0.0) * 0.6, 0.0, 0.7));
    vec3 scrC = mix(srgb(vec3(0.31, 0.36, 0.29)), srgb(vec3(0.42, 0.45, 0.38)), smoothstep(0.3, 0.7, patch80 * 0.7 + fine * 0.3));  // grey olive to the sage's grey green
    float bush = jwN(p / 3.1 + 0.37).g;
    scrC *= 0.68 + 0.5 * smoothstep(0.25, 0.75, bush);
    scrC = mix(scrC, scrC * 0.72, jwNear);  // near the camera its bushes stand on it: the shade under them
    vec3 bareC = mix(srgb(vec3(0.49, 0.43, 0.37)), srgb(vec3(0.57, 0.46, 0.37)), smoothstep(0.3, 0.7, fine));
    vec3 d = mix(grassC, scrC, sc); d = mix(d, bareC, br); d = mix(d, srgb(vec3(0.24, 0.22, 0.17)), tr);
    // the pullouts, car parks and gravel shoulders: pale grey, a little warm, mottled
    d = mix(d, mix(srgb(vec3(0.47, 0.46, 0.43)), srgb(vec3(0.58, 0.56, 0.51)), smoothstep(0.3, 0.7, fine * 0.7 + small * 0.3)), smoothstep(0.25, 0.65, pav));
    c = mix(c, d * (0.92 + 0.16 * fine), known * (1.0 - town * 0.6));
    jwScrub = sc * known * (1.0 - br) * (1.0 - tr);
  }
  // sand: the beach and dunes
  c = mix(c, srgb(vec3(0.84, 0.77, 0.61)) * (0.94 + 0.12 * fine), sand);
  // rock: cliffs and bluffs; bare earth on road banks and steep grass
  rk = max(rockc, smoothstep(0.5, 0.78, slope + (small - 0.5) * 0.22) * (1.0 - jwScrub * 0.8)) * (1.0 - cut * 0.5) * (1.0 - wood * 0.5);
  vec3 rockC = mix(srgb(vec3(0.47, 0.43, 0.38)), srgb(vec3(0.60, 0.56, 0.50)), smoothstep(0.3, 0.7, fine)) * (0.85 + 0.3 * patch80);
  c = mix(c, rockC, rk);
  float bare = smoothstep(0.45, 0.95, cut + (fine - 0.5) * 0.6) * smoothstep(mix(0.2, 0.07, hl), mix(0.5, 0.28, hl), slope + (small - 0.5) * 0.2) * mix(0.65, 0.92, hl) * mix(1.0, smoothstep(0.1, 0.3, slope) * mix(0.75, 1.0, smoothstep(0.1, 0.5, vg.b)), jwKnown);  // the Headlands' road cuts bare even where the grid softens them (where the imagery says what grows there: the steep cuts mostly, fully where it shows bare earth)
  c = mix(c, mix(srgb(vec3(0.55, 0.45, 0.33)), mix(srgb(vec3(0.50, 0.39, 0.34)), srgb(vec3(0.59, 0.45, 0.38)), smoothstep(0.3, 0.7, small)), hl) * (0.85 + 0.3 * fine), bare);  // the Headlands' road cuts: red chert, weathered (USDA NAIP's bare red earth, about #8e7a70)
  rk = max(rk, bare); jwPav = smoothstep(0.25, 0.65, pav) * known;
  // under the redwoods: red-brown needle litter, patches of sorrel
  float rw = 0.0;
  for (int i = 0; i < 4; i++) rw = max(rw, step(rwBox[i].x, p.x) * step(p.x, rwBox[i].z) * step(rwBox[i].y, p.y) * step(p.y, rwBox[i].w));
  rw *= smoothstep(0.3, 0.65, wood);
  vec3 duff = mix(srgb(vec3(0.38, 0.27, 0.19)), srgb(vec3(0.33, 0.42, 0.18)), smoothstep(0.52, 0.68, small) * 0.85) * (0.85 + 0.3 * fine);
  c = mix(c, duff, rw * 0.9);
  // the shore and the sea floor (heights in the lidar's datum: mean sea level 0.9 m, sky.js SEA)
  if (lake < 0.5) c = mix(c, srgb(vec3(0.80, 0.74, 0.58)), smoothstep(3.9, 1.7, h) * (1.0 - smoothstep(0.3, 0.5, slope)));
  c = mix(c, srgb(vec3(0.20, 0.34, 0.38)), lake);
  c = mix(c, srgb(vec3(0.24, 0.30, 0.28)), smoothstep(0.5, -2.1, h));
  return c;
}
`;

// attributes: normal (smooth), mk / mk2 (class weights, normalised bytes), cv (hollow / ridge). bores: the tunnel test
// (only tiles with a tunnel use it: a discard anywhere in the shader costs the GPU its early depth test)
export function terrainMaterial({ detail = true, bores = false } = {}) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const T = textures();
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { tNoise: { value: T.noise }, rwBox: REDWOOD, hlBox: HL, sfBox: SFB, tVeg: VEG.tex, vegBox: VEG.box, scrubR: VEG.near, boreA: BORES.a, boreB: BORES.b, boreN: BORES.n });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 mk; attribute vec4 mk2; attribute float cv;\nvarying vec4 vMk; varying vec4 vMk2; varying float vCv; varying vec3 vW; varying vec3 vNw;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMk = mk; vMk2 = mk2; vCv = cv; vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vNw = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vMk; varying vec4 vMk2; varying float vCv; varying vec3 vW; varying vec3 vNw;\nuniform vec4 boreA[12]; uniform vec4 boreB[12]; uniform int boreN; uniform float scrubR;\n' + GLSL_COMMON + GLSL_GROUND)
      .replace('#include <color_fragment>', /* glsl */`
        bool inBore = false;
        ${bores ? `
        for (int i = 0; i < 12; i++) {
          vec2 e = boreA[i].zw - boreA[i].xy; float tu = dot(vW.xz - boreA[i].xy, e) / max(dot(e, e), 1e-3), t = clamp(tu, 0.0, 1.0);
          float fy = mix(boreB[i].x, boreB[i].y, t);
          // (square ends at the portals: no round hole in the ground in front of one)
          inBore = inBore || (i < boreN && tu > -0.002 && tu < 1.002 && distance(vW.xz, boreA[i].xy + e * t) < boreB[i].z && vW.y > fy - 2.0 && vW.y < fy + boreB[i].w);
        }
        if (inBore) discard;` : ''}
        vec3 nW = normalize(vNw); float rk;
        float dist = length(vViewPosition);
        jwNear = 1.0 - smoothstep(scrubR * 0.6, scrubR * 0.95, dist);
        vec3 c = jwGround(vW.xz, nW, vMk, vMk2, vCv, vW.y, rk);
        // hollows a little darker (sky light does not reach the bottom of a gully)
        c *= 1.0 - clamp(vCv, 0.0, 1.0) * 0.25;
        // past the grass: the hills mottled, dots of scrub and their shade, drier and greener patches
        { float far = smoothstep(50.0, 220.0, dist), open = (1.0 - vMk.x) * (1.0 - vMk.w) * (1.0 - vMk.z) * (1.0 - rk) * (1.0 - jwKnown * 0.75) * (1.0 - jwPav);
          vec4 ms = jwN(vW.xz / 19.0 + 0.21); float sp = ms.g, sp2 = ms.r, pt = jwN(vW.xz / 2400.0 + 0.53).r;
          c *= 1.0 - far * open * (0.22 * smoothstep(0.6, 0.78, sp) + 0.12 * smoothstep(0.58, 0.8, sp2));
          c = mix(c, c * vec3(0.9, 1.0, 0.82), far * open * 0.6 * smoothstep(0.5, 0.75, pt));
          c = mix(c, c * vec3(1.08, 1.02, 0.94), far * open * 0.5 * (1.0 - smoothstep(0.3, 0.55, pt))); }
        ${detail ? `
        // close up: clumps of grass and earth, and a bump to light them
        float near = 1.0 - smoothstep(40.0, 260.0, dist);
        float f1 = jwN(vW.xz / 9.0).r, f2 = jwN(mat2(0.8, 0.6, -0.6, 0.8) * vW.xz / 2.3).g;
        c *= 1.0 + near * ((f1 - 0.5) * 0.16 + (f2 - 0.5) * 0.1 * (1.0 - rk * 0.5));
        float hb = (f1 * 0.35 + f2 * 0.3) * (1.0 - jwPav * 0.8) + rk * jwN(vW.xz / 1.1).b * 0.6 + jwScrub * (1.0 - jwNear) * jwN(vW.xz / 3.1 + 0.37).g * 1.4;
        vec3 dpx = dFdx(vW), dpy = dFdy(vW); float dhx = dFdx(hb), dhy = dFdy(hb);
        vec3 r1 = cross(dpy, nW), r2 = cross(nW, dpx); float det = dot(dpx, r1);
        vec3 bumpV = abs(det) * nW - sign(det) * (dhx * r1 + dhy * r2) * (0.55 + rk) * near;
        if (abs(det) > 1e-9 && dot(bumpV, bumpV) > 1e-18) nW = normalize(bumpV);  // never a NaN (bloom would smear it)` : ''}
        diffuseColor.rgb *= c;`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);');
  };
  m.customProgramCacheKey = () => 'jw-terrain-5' + (detail ? 'd' : '') + (bores ? 'b' : '');
  return m;
}

// Grass: instanced clumps of blades. Per instance gA = [normal x, normal z, hollow, height scale], gB = class weights
// [wood, green, sand, town]. The colour comes from the ground's (jwGround at the root), lighter to the tips; the
// blades sway in the wind more at the tip, and shrink away at the edge of the field (radius uniform).
export function grassMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const T = textures(), U = { radius: { value: 60 }, centre: { value: new THREE.Vector2() } };
  m.userData.u = U;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { tNoise: { value: T.noise }, rwBox: REDWOOD, hlBox: HL, sfBox: SFB, tVeg: VEG.tex, vegBox: VEG.box, wTime: WIND.time, wGust: WIND.gust, radius: U.radius, centre: U.centre });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 gA; attribute vec4 gB; uniform float wTime, wGust, radius; uniform vec2 centre; varying vec3 vGc;\n' + GLSL_COMMON + GLSL_GROUND)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3(position);
        vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float tip = clamp(position.y / 0.6, 0.0, 1.0), dc = distance(root.xz, centre);
        float fade = 1.0 - smoothstep(radius * 0.72, radius, dc);
        // dense near the camera, a third of the clumps further out
        fade *= step(gA.w, mix(1.0, 0.33, smoothstep(radius * 0.25, radius * 0.5, dc)));
        transformed *= fade;
        float ph = dot(root.xz, vec2(0.21, 0.17));
        float sway = (sin(wTime * 1.7 + ph) * 0.6 + sin(wTime * 3.1 + ph * 2.3) * 0.25 + 0.35) * wGust;
        transformed.x += sway * tip * tip * 0.22; transformed.z += sway * tip * tip * 0.12;
        vec3 gn = normalize(vec3(gA.x, sqrt(max(0.0, 1.0 - gA.x * gA.x - gA.y * gA.y)), gA.y)); float rk;
        jwNear = 1.0; vec3 gc = jwGround(root.xz, gn, gB, vec4(0.0), gA.z, root.y, rk);
        float l = dot(gc, vec3(0.3, 0.55, 0.15)), far = smoothstep(10.0, 40.0, distance(root, cameraPosition));
        vec3 blade = mix(gc, vec3(l) * vec3(1.08, 1.0, 0.82), tip * 0.35) * mix(0.62, 1.22, tip) * (0.92 + 0.16 * h21(root.xz));
        vGc = mix(blade, gc * 0.97, far);   // further away the blades take the ground's own colour (no speckle)`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGc;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGc;')
      // both faces lit like the ground under them
      .replace('#include <normal_fragment_begin>', 'float faceDirection = gl_FrontFacing ? 1.0 : -1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;');
  };
  m.customProgramCacheKey = () => 'jw-grass-3';
  return m;
}

// road attributes rd = [marking, surface, lanes, width], rd2 = [a, b, pL, pR] (ribbon.js roadStyle); uv: across in
// metres from the right edge, metres along
// a bike lane's symbol (a bicycle and its rider, an arrow ahead), white on the road: q in metres, x across the lane, y
// along it (the arrow toward +y); coverage 0..1 over antialiasing width aa
const GLSL_BIKE = /* glsl */`
float jwSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float jwBike(vec2 q, float aa) {
  q = q / 0.75 + vec2(0.35, 0.6);
  float d = min(abs(length(q - vec2(0.0, -0.55)) - 0.3), abs(length(q - vec2(0.0, 0.55)) - 0.3));
  d = min(d, min(jwSeg(q, vec2(0.0, -0.55), vec2(0.42, -0.18)), jwSeg(q, vec2(0.42, -0.18), vec2(0.0, -0.02))));
  d = min(d, min(jwSeg(q, vec2(0.0, -0.02), vec2(0.0, 0.55)), jwSeg(q, vec2(0.0, -0.02), vec2(0.42, 0.33))));
  d = min(d, min(jwSeg(q, vec2(0.42, -0.18), vec2(0.42, 0.33)), jwSeg(q, vec2(0.42, 0.33), vec2(0.0, 0.55))));
  d = min(d, min(jwSeg(q, vec2(0.52, -0.16), vec2(0.88, 0.16)), jwSeg(q, vec2(0.84, 0.18), vec2(0.5, 0.42))));
  d = min(d, abs(length(q - vec2(1.04, 0.2)) - 0.06));
  d = min(d, jwSeg(q, vec2(0.25, 1.15), vec2(0.25, 1.85)));
  d = min(d, min(jwSeg(q, vec2(0.25, 2.15), vec2(0.0, 1.8)), jwSeg(q, vec2(0.25, 2.15), vec2(0.5, 1.8))));
  return 1.0 - smoothstep(0.045, 0.045 + aa / 0.75, d);
}
// BIKE LANE in words (Center Road at Fort Baker, Street View; MUTCD 9C.04): q in metres, x across the lane to the
// reader's right from its middle, y along from the legend's near end; letters 1.8 m long, 0.36 m wide, strokes 0.1 m,
// BIKE nearest, LANE 1.2 m beyond it
#define JW_SG(ax, ay, bx, by) d = min(d, jwSeg(pm, vec2(ax, ay) * S, vec2(bx, by) * S))
float jwWords(vec2 q, float aa) {
  float cw = 0.36, gp = 0.06, h = 1.8, tot = 4.0 * cw + 3.0 * gp, y = q.y < h + 0.6 ? q.y : q.y - h - 1.2;
  if (y < -0.1 || y > h + 0.1 || abs(q.x) > tot * 0.5 + 0.1 || q.y > 2.0 * h + 1.3) return 0.0;
  float x = q.x + tot * 0.5; int i = int(clamp(floor(x / (cw + gp)), 0.0, 3.0)), ch = (q.y < h + 0.6 ? 0 : 4) + i;
  vec2 S = vec2(cw, h), pm = vec2(x - float(i) * (cw + gp), y); float d = 1e3;
  if (ch == 0) { JW_SG(0., 0., 0., 1.); JW_SG(0., 1., .75, 1.); JW_SG(.75, 1., 1., .85); JW_SG(1., .85, 1., .62); JW_SG(1., .62, .75, .5); JW_SG(0., .5, .75, .5);
    JW_SG(.75, .5, 1., .38); JW_SG(1., .38, 1., .15); JW_SG(1., .15, .75, 0.); JW_SG(.75, 0., 0., 0.); }
  else if (ch == 1) { JW_SG(.5, 0., .5, 1.); JW_SG(.15, 0., .85, 0.); JW_SG(.15, 1., .85, 1.); }
  else if (ch == 2) { JW_SG(0., 0., 0., 1.); JW_SG(0., .42, 1., 1.); JW_SG(.32, .6, 1., 0.); }
  else if (ch == 3 || ch == 7) { JW_SG(0., 0., 0., 1.); JW_SG(0., 1., 1., 1.); JW_SG(0., .5, .8, .5); JW_SG(0., 0., 1., 0.); }
  else if (ch == 4) { JW_SG(0., 0., 0., 1.); JW_SG(0., 0., 1., 0.); }
  else if (ch == 5) { JW_SG(0., 0., .5, 1.); JW_SG(.5, 1., 1., 0.); JW_SG(.22, .4, .78, .4); }
  else { JW_SG(0., 0., 0., 1.); JW_SG(0., 1., 1., 0.); JW_SG(1., 0., 1., 1.); }
  return 1.0 - smoothstep(0.05, 0.05 + aa, d);
}
`;
export function roadMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const T = textures();
  m.onBeforeCompile = sh => {
    sh.uniforms.tNoise = { value: T.noise };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 rd;\nattribute vec4 rd2;\nattribute vec4 rd3;\nattribute vec2 ruv;\nvarying vec4 vRd;\nvarying vec4 vRd2;\nflat varying vec4 vRd3;\nvarying vec2 vRuv;\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRd = rd; vRd2 = rd2; vRd3 = rd3; vRuv = ruv; vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tNoise;\nvarying vec4 vRd;\nvarying vec4 vRd2;\nflat varying vec4 vRd3;\nvarying vec2 vRuv;\nvarying vec3 vW;\n' + GLSL_COMMON + GLSL_BIKE)
      .replace('#include <color_fragment>', /* glsl */`
        float lm = floor(vRd.x + 0.5), surf = floor(vRd.y + 0.5), lanes = floor(vRd.z + 0.5), W = vRd.w;
        float along = vRuv.y, x = vRuv.x - W * 0.5, ax = abs(x);
        float n1 = texture2D(tNoise, vW.xz / 31.0).g, n2 = texture2D(tNoise, vW.xz / 3.7).r, n3 = texture2D(tNoise, vW.xz / 0.9).r;
        // asphalt as it is on the Headlands' roads (Street View, sRGB about #8c8b87 to #a7a59f): pale weathered grey,
        // darker patches where it was mended, black sealed cracks, the wheel tracks a little darker, the edges dusty
        vec3 c = mix(srgb(vec3(0.43, 0.425, 0.41)), srgb(vec3(0.54, 0.53, 0.51)), n1) * (0.93 + 0.14 * n3);
        float n4 = texture2D(tNoise, vW.xz / 9.0 + 0.37).b, n5 = texture2D(tNoise, vW.xz / 5.3 + 0.11).a;
        c *= 1.0 - 0.16 * smoothstep(0.78, 0.8, n4);                                        // patches
        c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0015, 0.005, abs(n5 - 0.5))) * step(0.62, n2);  // sealed cracks
        float lane = W / max(1.0, lanes), lx = mod(x + W * 0.5, max(lane, 1.0)) / max(lane, 1.0);
        c *= 1.0 - 0.07 * (smoothstep(0.12, 0.25, abs(lx - 0.28)) < 0.5 || smoothstep(0.12, 0.25, abs(lx - 0.72)) < 0.5 ? 1.0 : 0.0) * step(0.5, lanes);
        c = mix(c, srgb(vec3(0.66, 0.62, 0.54)), smoothstep(W * 0.5 - 0.6, W * 0.5, ax) * 0.55 * n2 * step(lm, 0.5));  // dust on the edges of unmarked lanes only (marked ones are clean to their edge, Street View)
        if (surf == 1.0) c = mix(srgb(vec3(0.50, 0.50, 0.48)), srgb(vec3(0.60, 0.59, 0.56)), n1) * (0.92 + 0.16 * n3);
        if (surf == 2.0) {
          // a dirt trail: packed earth with two worn lines, ragged grassy edges
          float edge = ax / max(W * 0.5, 0.1) + (n2 - 0.5) * 0.7 + (n3 - 0.5) * 0.25;
          if (edge > 0.98) discard;
          c = mix(srgb(vec3(0.60, 0.51, 0.38)), srgb(vec3(0.52, 0.43, 0.31)), n1) * (0.85 + 0.3 * n3);
          c = mix(c, srgb(vec3(0.62, 0.56, 0.38)), smoothstep(0.55, 0.95, edge) * 0.7);
        }
        if (lm < 0.0) c = srgb(vec3(0.62, 0.61, 0.58));
        // the markings across the road, r metres from its right edge: the travel lanes from a to W - b, bike lanes and
        // parking outside them (their lines solid white), 12 cm lines; yellow: the double centre line, a oneway's left edge
        float aa = max(fwidth(x) * 0.8, 0.02), line = 0.0, yel = 0.0, wear = 0.75 + 0.25 * smoothstep(0.2, 0.6, n2);
        float r = x + W * 0.5, ta = vRd2.x, tb = W - vRd2.y, ln1 = 0.0;
        // the hand list's markings (ribbon.js markCode): mc the centre line, mb bits
        int mc = int(vRd3.x + 0.5), mb = int(vRd3.y + 0.5); bool noEdge = (mb & 1) != 0;
        #define LN(at, hw) (1.0 - smoothstep(hw, hw + aa, abs(r - (at))))
        if (lm >= 1.0) {
          float rr = ta > 0.5 ? ta : 0.3, ll = W - (vRd2.y > 0.5 ? vRd2.y : 0.3);
          if (!noEdge || ta > 0.5) line = max(line, LN(rr, 0.06));
          if (vRd2.w > 0.5 && ta - vRd2.w > 0.5) line = max(line, LN(vRd2.w, 0.06));                 // parking, then a bike lane
          if (vRd2.z > 0.5 && vRd2.y - vRd2.z > 0.5) line = max(line, LN(W - vRd2.z, 0.06));
          if (lm == 4.0) {
            // the buffer against a contraflow bike lane (YB, ribbon.js: 0.9 m): a yellow line at each side, ticks across it
            // every 6 m, or cross hatched
            yel = max(yel, max(LN(ll + 0.08, 0.05), LN(ll + 0.82, 0.05)));
            float inb = step(ll + 0.08, r) * step(r, ll + 0.82);
            if ((mb & 8) != 0) { float tk = fract(along / 6.0) * 6.0; yel = max(yel, inb * (1.0 - smoothstep(0.08, 0.08 + aa * 2.0, min(tk, 6.0 - tk)))); }
            if ((mb & 16) != 0) { float dg = fract((along + (r - ll) * 1.5) / 2.0) * 2.0; yel = max(yel, inb * (1.0 - smoothstep(0.1, 0.1 + aa * 2.0, min(dg, 2.0 - dg)))); }
          }
          else if (lm == 3.0) { if (mc != 1) yel = max(yel, LN(ll, 0.06)); }                       // a oneway's left edge
          else if (!noEdge || vRd2.y > 0.5) line = max(line, LN(ll, 0.06));
        }
        if (lm == 2.0) {
          float mid = (ta + tb) * 0.5, per = max(1.0, floor(lanes * 0.5)), lw = (tb - ta) * 0.5 / per, dash = step(fract(along / 12.0), 0.3);
          // the centre line: double yellow, or as the hand list has it (c1 the one of the pair nearer the right edge)
          float c1 = LN(mid - 0.11, 0.05), c2 = LN(mid + 0.11, 0.05);
          if (mc == 0) yel = max(yel, max(c1, c2));
          else if (mc == 2) yel = max(yel, LN(mid, 0.05) * dash);
          else if (mc == 3) yel = max(yel, max(c1 * dash, c2));
          else if (mc == 4) yel = max(yel, max(c1, c2 * dash));
          else if (mc == 5) line = max(line, max(c1, c2));
          else if (mc == 6) { float dd = fract(along / 2.5) * 2.5 - 1.25; yel = max(yel, 1.0 - smoothstep(0.05, 0.05 + aa, length(vec2(abs(r - mid) - 0.11, dd)))); }
          for (int i = 1; i < 4; i++) { if (float(i) >= per) break; ln1 = max(ln1, max(LN(mid - lw * float(i), 0.06), LN(mid + lw * float(i), 0.06))); }
          line = max(line, ln1 * dash);
        }
        if (lm >= 3.0 && lanes >= 2.0) {
          float lw = (tb - ta) / lanes, dash = step(fract(along / 12.0), 0.3);
          for (int i = 1; i < 6; i++) { if (float(i) >= lanes) break; ln1 = max(ln1, LN(ta + lw * float(i), 0.06)); }
          line = max(line, ln1 * dash);
        }
        // a parking lane beside a lane with a bike lane against it (lower Conzelman, Street View): a buffer 0.9 m wide on
        // its inner side, a second line and bars across it every 6 m
        if (lm == 4.0 && vRd2.w > 1.5 && (mb & 32) == 0) {
          float b0 = vRd2.w - 0.9; line = max(line, LN(b0, 0.06));
          float hz = step(b0, r) * step(r, vRd2.w), dg = fract((along + (r - b0) * 0.8) / 6.0) * 6.0;
          line = max(line, hz * (1.0 - smoothstep(0.07, 0.07 + aa * 2.0, min(dg, 6.0 - dg))));
        }
        // the bike lanes' symbols every 150 m, each pointing the way its lane runs (the right one with the way, the left
        // one against it)
        // (none where the hand list says; BIKE LANE in words where it says so)
        if (lm >= 1.0 && (mb & 2) == 0) {
          float pr = vRd2.w, pl = vRd2.z, rl = W - pl; bool wd = (mb & 4) != 0;
          if (ta - pr > 1.2 && r > pr && r < ta) line = max(line, wd ? jwWords(vec2((pr + ta) * 0.5 - r, mod(along, 150.0) - 75.0), aa) : jwBike(vec2(r - (pr + ta) * 0.5, mod(along, 150.0) - 75.0), aa));
          if (rl - tb > 1.2 && r > tb && r < rl) line = max(line, wd ? jwWords(vec2(r - (tb + rl) * 0.5, 75.0 - mod(along + 40.0, 150.0)), aa) : jwBike(vec2((tb + rl) * 0.5 - r, 75.0 - mod(along + 40.0, 150.0)), aa));
        }
        // stall ticks across a parking lane every 6.7 m (22 ft, a parallel stall), the hand list's
        if ((mb & 32) != 0 && vRd2.w > 1.5 && r < vRd2.w) { float sl = fract(along / 6.7) * 6.7; line = max(line, 1.0 - smoothstep(0.06, 0.06 + aa * 2.0, min(sl, 6.7 - sl))); }
        if ((mb & 64) != 0 && vRd2.z > 1.5 && r > W - vRd2.z) { float sl = fract(along / 6.7) * 6.7; line = max(line, 1.0 - smoothstep(0.06, 0.06 + aa * 2.0, min(sl, 6.7 - sl))); }
        float fade = wear * (1.0 - smoothstep(0.25, 0.6, aa));  // lines fade where they would shimmer
        c = mix(c, srgb(vec3(0.86, 0.68, 0.22)), yel * 0.92 * fade);
        c = mix(c, srgb(vec3(0.88, 0.88, 0.85)), line * 0.92 * fade);
        diffuseColor.rgb *= c;`);
  };
  m.customProgramCacheKey = () => 'jw-road-7';
  return m;
}

// Trees and shrubs: vertex coloured, bark and leaf cards from the leaf atlas (alpha tested; the shadows too), the
// crowns lit with soft (spherical) normals, the same on both faces of a card, and glowing a little with the sun
// behind them. They lean with the wind by height, the leaves flutter. Instanced; per instance colour varies the green.
// fade: { centre, radius } uniforms: each instance shrinks into the ground over the outer quarter of the radius round
// the centre (the scrub: no edge where its bushes end)
export function propMaterial({ fade = null } = {}) {
  const T = textures(), m = new THREE.MeshLambertMaterial({ vertexColors: true, map: T.leaves, alphaTest: 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { wTime: WIND.time, wGust: WIND.gust }, fade ? { fadeC: fade.centre, fadeR: fade.radius } : {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float wTime, wGust;' + (fade ? '\nuniform vec2 fadeC; uniform float fadeR;' : ''))
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        vec3 jwRoot = instanceMatrix[3].xyz;
        float jwPh = dot(jwRoot.xz, vec2(0.11, 0.07)), jwK = max(0.0, position.y - 1.5) * 0.012 * wGust;
        transformed.x += jwK * (sin(wTime * 0.9 + jwPh) + 0.4 * sin(wTime * 2.3 + jwPh * 3.0 + position.y));
        transformed.z += jwK * 0.6 * sin(wTime * 1.1 + jwPh * 1.7);
        // leaves (the atlas's top three rows) flutter
        float jwLf = step(uv.y, 0.74) * wGust;
        transformed += normal * sin(wTime * 6.0 + dot(position, vec3(3.1, 2.3, 2.7)) + jwPh) * 0.05 * jwLf;
        ${fade ? 'transformed *= 1.0 - smoothstep(fadeR * 0.75, fadeR, distance(jwRoot.xz, fadeC));' : ''}
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        float jwBack = pow(max(dot(normalize(-vViewPosition), directionalLights[0].direction), 0.0), 4.0) * step(vMapUv.y, 0.74);
        reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color * jwBack * 0.16;
        #endif`);
  };
  m.customProgramCacheKey = () => 'jw-prop-3' + (fade ? 'f' : '');
  // the shadow: the same wind, the cards a third of them (attribute sk), alpha tested
  const d = m.userData.depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: T.leaves, alphaTest: 0.5, side: THREE.DoubleSide });
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { wTime: WIND.time, wGust: WIND.gust });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float wTime, wGust;\nattribute float sk;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        vec3 jwRoot = instanceMatrix[3].xyz;
        float jwPh = dot(jwRoot.xz, vec2(0.11, 0.07)), jwK = max(0.0, position.y - 1.5) * 0.012 * wGust;
        transformed.x += jwK * (sin(wTime * 0.9 + jwPh) + 0.4 * sin(wTime * 2.3 + jwPh * 3.0 + position.y));
        transformed.z += jwK * 0.6 * sin(wTime * 1.1 + jwPh * 1.7);
        #endif
        transformed *= step(0.5, sk);`);
  };
  d.customProgramCacheKey = () => 'jw-prop-depth-1';
  return m;
}

// A tunnel's lining: lit by its lamps (rows high on both walls, every 9 m): pools of warm light along the bore,
// brightest under the lamps. attribute tl = [metres along, height share 0 floor .. 1 crown, side -1 .. 1]
export function tunnelMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0x9c9586, side: THREE.DoubleSide });  // pale concrete (Street View: the Baker-Barry tunnel)
  m.onBeforeCompile = sh => {
    sh.uniforms.tNoise = { value: textures().noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 tl; varying vec3 vTl; varying vec3 vTw;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTl = tl; vTw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tNoise; varying vec3 vTl; varying vec3 vTw;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // concrete in pours 3 m long, stained toward the floor
        float n = texture2D(tNoise, vTw.xz / 3.0 + vTw.y / 7.0).r, ring = step(0.93, fract(vTl.x / 6.0));
        diffuseColor.rgb *= (0.88 + 0.2 * n) * (1.0 - 0.3 * ring) * mix(0.7, 1.0, smoothstep(0.0, 0.3, vTl.y));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float pool = pow(0.5 + 0.5 * cos(6.2832 * vTl.x / 9.0), 2.0), lamp = exp(-pow((vTl.y - 0.72) * 5.0, 2.0));
        totalEmissiveRadiance += vec3(1.0, 0.88, 0.6) * diffuseColor.rgb * (0.35 + 1.3 * pool * (0.45 + 0.55 * lamp));`);
  };
  m.customProgramCacheKey = () => 'jw-tunnel-2';
  return m;
}
// A portal's headwall: concrete in courses with a coping, an arch ring round the opening (lighter), weathered lower down
export function portalMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0xc4bfb3 });
  m.onBeforeCompile = sh => {
    sh.uniforms.tNoise = { value: textures().noise };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 pl; varying vec3 vPl;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPl = pl;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tNoise; varying vec3 vPl;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // cast concrete (Street View: the Headlands' portals and headwalls): faint lines of the forms' boards, rain streaks
        // down from the top, darker toward the foot
        float board = step(0.97, fract(vPl.y / 0.3)) * 0.06, streak = texture2D(tNoise, vec2(vPl.x / 1.3, vPl.y / 14.0)).g;
        float n = texture2D(tNoise, vPl.xy / 4.0).g, f = texture2D(tNoise, vPl.xy / 0.8).r;
        diffuseColor.rgb *= (0.86 + 0.16 * n + 0.06 * f) * (1.0 - board) * (1.0 - 0.18 * smoothstep(0.55, 0.85, streak)) * mix(0.78, 1.0, smoothstep(-1.0, 3.0, vPl.y));`);
  };
  m.customProgramCacheKey = () => 'jw-portal-2';
  return m;
}

// Street furniture: vertex coloured; tag 2 (a street lamp) lights up with LAMPS (0 off .. 1 on, dusk and dark)
export const LAMPS = { value: 0 };
export function furnitureMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = sh => {
    sh.uniforms.lamps = LAMPS;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float tag; varying float vTag;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvTag = tag;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float lamps; varying float vTag;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (vTag > 3.5) totalEmissiveRadiance += vec3(0.25, 1.0, 0.55) * 4.0; else if (vTag > 1.5) totalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * lamps * 14.0;');
  };
  m.customProgramCacheKey = () => 'jw-furn-2';
  return m;
}

// Buildings: wall colour from the vertex colour, windows from the atlas (one bay of one floor per cell, the ground
// floor its own row) by bw = [metres along the wall, metres up, style, 0 wall / 1 roof / 2 trim]. Glass reflects
// the haze colour; at dusk some windows are lit (LAMPS). A darker band at the foot of the walls. Roofs: tiles or
// shingles in rows.
export function buildingMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  const T = textures();
  m.onBeforeCompile = sh => {
    sh.uniforms.tWin = { value: T.windows };
    sh.uniforms.tNoise = { value: T.noise }; sh.uniforms.lamps = LAMPS;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 bw;\nvarying vec4 vBw;\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBw = bw; vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tWin, tNoise; uniform float lamps;\nvarying vec4 vBw;\nvarying vec3 vW;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.7, 0.38) * jwWin * 0.75;')
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        float kind = floor(vBw.w + 0.5), style = floor(vBw.z + 0.5), jwWin = 0.0;
        float nz = texture2D(tNoise, vW.xz / 7.0 + vW.y / 5.0).r;
        if (kind == 0.0) {
          float fh = style >= 6.0 ? 3.7 : 3.0, bay = style == 2.0 || style == 6.0 ? 4.2 : 3.2;
          vec2 q = vec2(vBw.x / bay, vBw.y / fh), cell = floor(q), f = fract(q);
          float ground = step(cell.y, 0.5) * step(-0.5, cell.y);
          float s = ground > 0.5 ? mod(style + floor(mod(cell.x * 7.0 + style, 3.0)) * (style == 6.0 ? 0.0 : 1.0), 8.0) : style;
          vec2 org = vec2(mod(s, 4.0), floor(s / 4.0) + ground * 2.0);
          vec2 uv = (org + vec2(f.x, 1.0 - f.y)) / 4.0;
          vec4 w = textureGrad(tWin, uv, dFdx(q) / 4.0 * vec2(1.0, -1.0), dFdy(q) / 4.0 * vec2(1.0, -1.0));
          vec3 wall = diffuseColor.rgb * (0.92 + 0.12 * nz);
          if (style == 5.0) wall *= 0.9 + 0.1 * step(0.5, fract(vBw.y / 0.22));   // clapboard / shingle siding
          vec3 glass = w.rgb * 0.5;
          #ifdef USE_FOG
          vec3 vd = normalize(vViewPosition); glass = mix(glass, fogColor * 0.55, 0.25 + 0.5 * pow(1.0 - abs(vd.z), 3.0));
          #endif
          diffuseColor.rgb = mix(wall * w.rgb, glass, w.a);
          diffuseColor.rgb *= vBw.y < 0.5 ? 0.62 : 1.0;   // the foundation
          jwWin = w.a * lamps * step(0.68, fract(sin(dot(cell + floor(vW.xz * 0.05), vec2(12.9898, 78.233))) * 43758.5453));
        } else if (kind == 1.0) {
          float rows = fract(vBw.y / 0.32), tiles = fract(vBw.x / 0.45 + floor(vBw.y / 0.32) * 0.5);
          diffuseColor.rgb *= (0.86 + 0.14 * smoothstep(0.0, 0.25, rows)) * (0.95 + 0.05 * step(0.08, tiles)) * (0.9 + 0.2 * nz);
        } else {
          diffuseColor.rgb *= 0.95 + 0.1 * nz;
        }`);
  };
  m.customProgramCacheKey = () => 'jw-bldg-2';
  return m;
}

// Terrain shadows at any distance (horizon.js draws the map): a lit material takes the sun as the map says at its own
// place, past the shadow map's few dozen metres too. Wraps the material's onBeforeCompile (call it once, last).
// The heights themselves too (the sea finds its shallows in them): far (the shadow map's 40 km) and near (4 km, finer)
export const HORIZON = { map: { value: null }, box: { value: new THREE.Vector4(0, 0, 0, 0) }, heights: { value: null }, near: { value: null }, nearBox: { value: new THREE.Vector4(0, 0, 0, 0) } };
export function withSun(m) {
  const f = m.onBeforeCompile, key = m.customProgramCacheKey.call(m) + '|sun';
  m.onBeforeCompile = function (sh, r) {
    f.call(this, sh, r);
    Object.assign(sh.uniforms, { hzMap: HORIZON.map, hzBox: HORIZON.box });
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
        uniform sampler2D hzMap; uniform vec4 hzBox;
        #ifdef JW_VIS_V
        varying float vJwVis;
        float jwSunVis() { return vJwVis; }
        #else
        float jwSunVis() {
          #ifdef USE_FOG
          vec2 u = vec2(vFogW.x - hzBox.x, hzBox.y - vFogW.z) * hzBox.z;
          if (hzBox.z > 0.0 && u.x > 0.0 && u.y > 0.0 && u.x < 1.0 && u.y < 1.0) return texture2D(hzMap, u).r;
          #endif
          return 1.0;
        }
        #endif`)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= jwSunVis();'));
  };
  m.customProgramCacheKey = () => key;
  return m;
}
