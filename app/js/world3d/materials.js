// World 3D materials: stylized flat-shaded ground coloured in the shader by ground class, height, slope and the way a
// slope faces; roads with their markings drawn in the shader; vertex-coloured props. Colours are written in sRGB.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';

const GLSL_COMMON = /* glsl */`
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
`;

// cls attribute: ground class (0 none, else landuse.js KINDS index + 1) + a random fraction per vertex (per face, flat)
export function terrainMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cls;\nflat varying float vCls;\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCls = cls;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying float vCls;\nvarying vec3 vW;\n' + GLSL_COMMON)
      .replace('#include <color_fragment>', /* glsl */`
        vec3 fn = inverseTransformDirection(normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))), viewMatrix); if (fn.y < 0.0) fn = -fn;  // view space: precise far from the origin
        float slope = 1.0 - fn.y, h = vW.y, k = floor(vCls + 0.01), rnd = fract(vCls), cut = 0.0;
        if (k >= 32.0) { k -= 32.0; cut = 1.0; }
        float big = vnoise(vW.xz / 900.0), mid = vnoise(vW.xz / 160.0 + 7.0), north = clamp(-fn.z * 2.2, 0.0, 1.0) * smoothstep(0.04, 0.2, slope);
        // open hills: golden grass, greener and scrubbier on the slopes that face north and in the hollows
        vec3 gold = srgb(vec3(0.80, 0.68, 0.40)), straw = srgb(vec3(0.86, 0.76, 0.50)), green = srgb(vec3(0.47, 0.55, 0.28));
        vec3 scrub = srgb(vec3(0.42, 0.47, 0.27)), wood = srgb(vec3(0.22, 0.33, 0.17)), rock = srgb(vec3(0.58, 0.53, 0.46));
        vec3 c = mix(mix(gold, straw, mid), green, clamp(north * 0.55 + big * 0.4 - 0.15, 0.0, 0.8));
        c = mix(c, scrub, smoothstep(0.6, 0.95, north * 0.8 + mid * 0.45) * 0.6);
        if (k == 1.0) c = mix(srgb(vec3(0.45, 0.58, 0.28)), green, mid);                 // park
        else if (k == 2.0) c = mix(c, srgb(vec3(0.62, 0.62, 0.34)), 0.45);              // grass, meadow
        else if (k == 3.0) c = mix(srgb(vec3(0.70, 0.66, 0.40)), srgb(vec3(0.50, 0.56, 0.30)), mid); // farm
        else if (k == 4.0) c = mix(srgb(vec3(0.56, 0.56, 0.50)), srgb(vec3(0.46, 0.52, 0.34)), mid * 0.7); // town
        else if (k == 5.0) c = mix(scrub, srgb(vec3(0.44, 0.47, 0.27)), mid);           // coastal scrub
        else if (k == 6.0) c = mix(wood, srgb(vec3(0.26, 0.36, 0.19)), mid);            // wood
        else if (k == 7.0) c = rock;
        else if (k == 8.0) c = srgb(vec3(0.86, 0.79, 0.62));                             // beach
        else if (k == 9.0) c = srgb(vec3(0.20, 0.38, 0.45));                             // lake
        c = mix(c, rock, smoothstep(0.42, 0.62, slope) * (k == 6.0 ? 0.35 : 0.85) * (1.0 - cut * 0.85));  // cliffs and bluffs, not road banks
        c = mix(c, srgb(vec3(0.55, 0.47, 0.33)), cut * smoothstep(0.25, 0.5, slope) * 0.5);
        if (k != 9.0) c = mix(c, srgb(vec3(0.80, 0.74, 0.58)), smoothstep(3.5, 1.0, h) * (1.0 - smoothstep(0.3, 0.5, slope))); // the shore
        c = mix(c, srgb(vec3(0.22, 0.30, 0.30)), smoothstep(-0.5, -3.0, h));             // under water
        c *= 0.93 + 0.14 * rnd;                                                          // facets
        float near = 1.0 - smoothstep(60.0, 220.0, length(vViewPosition));
        c *= 1.0 + near * (0.16 * vnoise(vW.xz * 0.45) + 0.1 * vnoise(vW.xz * 2.1) - 0.13);  // close up: patchy grass
        diffuseColor.rgb *= c;`);
  };
  m.customProgramCacheKey = () => 'jw-terrain-1';
  return m;
}

// road attribute rd = [marking, surface, lanes, width]; uv: across 0..1, metres along
export function roadMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 rd;\nattribute vec2 ruv;\nvarying vec4 vRd;\nvarying vec2 vRuv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRd = rd; vRuv = ruv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRd;\nvarying vec2 vRuv;\n' + GLSL_COMMON)
      .replace('#include <color_fragment>', /* glsl */`
        float lm = floor(vRd.x + 0.5), surf = floor(vRd.y + 0.5), lanes = floor(vRd.z + 0.5), W = vRd.w;
        float along = vRuv.y, x = (vRuv.x - 0.5) * W, ax = abs(x), n = vnoise(vec2(x * 0.7, along * 0.15));
        vec3 c = mix(srgb(vec3(0.33, 0.335, 0.34)), srgb(vec3(0.40, 0.40, 0.405)), n * 0.7) * (0.96 + 0.08 * vnoise(vec2(x * 3.0, along * 2.0)));
        if (surf == 1.0) c = mix(srgb(vec3(0.33, 0.34, 0.33)), srgb(vec3(0.38, 0.38, 0.36)), n);
        if (surf == 2.0) c = mix(srgb(vec3(0.62, 0.52, 0.38)), srgb(vec3(0.54, 0.44, 0.31)), n);
        if (lm < 0.0) c = srgb(vec3(0.62, 0.61, 0.58));
        float aa = max(fwidth(x) * 0.8, 0.02), line = 0.0;
        vec3 lc = srgb(vec3(0.92, 0.92, 0.88));
        if (lm >= 1.0) line = max(line, 1.0 - smoothstep(0.06, 0.06 + aa, abs(ax - (W * 0.5 - 0.3))));
        if (lm == 2.0) {
          float y = 1.0 - smoothstep(0.05, 0.05 + aa, abs(ax - 0.11));
          float per = max(1.0, floor(lanes * 0.5)), lw = (W * 0.5 - 0.4) / per, dash = step(fract(along / 12.0), 0.3);
          float lane = 0.0; for (int i = 1; i < 4; i++) { if (float(i) >= per) break; lane = max(lane, 1.0 - smoothstep(0.06, 0.06 + aa, abs(ax - lw * float(i)))); }
          line = max(line, lane * dash);
          if (y > 0.0) { c = mix(c, srgb(vec3(0.90, 0.72, 0.22)), y * 0.95); }
        }
        if (lm == 3.0 && lanes >= 2.0) {
          float lw = (W - 0.8) / lanes, dash = step(fract(along / 12.0), 0.3), lane = 0.0;
          for (int i = 1; i < 6; i++) { if (float(i) >= lanes) break; lane = max(lane, 1.0 - smoothstep(0.06, 0.06 + aa, abs(x + W * 0.5 - 0.4 - lw * float(i)))); }
          line = max(line, lane * dash);
        }
        c = mix(c, lc, line * (1.0 - smoothstep(0.25, 0.6, aa)));  // lines fade where they would shimmer
        diffuseColor.rgb *= c;`);
  };
  m.customProgramCacheKey = () => 'jw-road-1';
  return m;
}

export const propMaterial = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

// buildings: vertex-coloured walls with rows of windows (by floor, fading out with distance), plain roofs
export function buildingMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 bn = inverseTransformDirection(normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))), viewMatrix);
        if (abs(bn.y) < 0.3) {
          vec2 t = normalize(vec2(-bn.z, bn.x)); float u = dot(vW.xz, t) / 2.8, v = vW.y / 3.1, fy = fract(v), fu = fract(u);
          vec2 aa = max(vec2(fwidth(u), fwidth(v)), 1e-4);
          float win = (smoothstep(0.32 - aa.y, 0.32 + aa.y, fy) - smoothstep(0.78 - aa.y, 0.78 + aa.y, fy)) * (smoothstep(0.22 - aa.x, 0.22 + aa.x, fu) - smoothstep(0.78 - aa.x, 0.78 + aa.x, fu));
          float fade = 1.0 - smoothstep(0.05, 0.14, max(aa.x, aa.y));  // too small to draw: no windows (no shimmer)
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.09, 0.12) + diffuseColor.rgb * 0.2, win * fade * 0.75);
        }`);
  };
  m.customProgramCacheKey = () => 'jw-bldg-1';
  return m;
}
