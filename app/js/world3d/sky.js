// World 3D atmosphere: a scattering sky with the sun disk (three's Sky) under two drifting cloud layers (puffy cumulus
// and thin cirrus, lit from the sun's side), sun and sky light, height fog and aerial haze in the colour of the sky's
// own horizon (every material, through three's fog chunks), the sea (wave normals, fresnel, sun glint) and banks of
// Karl the fog off the coast that can be turned off: a volume ray marched in post (post.js) from a map of how high the
// fog stands, or soft billboards where there is no post-processing. Times of day are presets of the sun's position;
// every colour follows from the sun, so any time in between works too.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { Sky } from '../../vendor/three-0.180.0/addons/objects/Sky.js';
import { textures } from './tex.js';
import { noise3Pixels } from './texgen.js';
import { HORIZON } from './materials.js';
import { skyRadiance, sunTint } from './skymath.js';

// az: compass degrees, el: degrees above the horizon; turb/mie: haze in the sky; haze, low: aerial haze and the low
// marine layer (per million per metre); banks: fog bank amount; cl: cumulus cover, ci: cirrus; si: sun intensity;
// exp: exposure. Dusk: the sun just under the horizon, the lamps on.
export const TIMES = {
  dawn: { az: 78, el: 4, turb: 3.2, ray: 2.2, mie: 0.006, si: 2.0, haze: 22, low: 120, banks: 1, cl: 0.3, ci: 0.6, exp: 1.05 },
  morning: { az: 100, el: 15, turb: 2.6, ray: 1.6, mie: 0.005, si: 2.6, haze: 18, low: 110, banks: 1, cl: 0.22, ci: 0.4, exp: 0.92 },
  day: { az: 185, el: 58, turb: 2.0, ray: 1.2, mie: 0.004, si: 3.1, haze: 10, low: 16, banks: 0.5, cl: 0.34, ci: 0.3, exp: 0.82 },
  afternoon: { az: 228, el: 36, turb: 2.2, ray: 1.3, mie: 0.004, si: 3.0, haze: 12, low: 22, banks: 0.6, cl: 0.4, ci: 0.45, exp: 0.84 },
  golden: { az: 248, el: 13, turb: 2.6, ray: 1.6, mie: 0.005, si: 2.9, haze: 14, low: 30, banks: 0.75, cl: 0.3, ci: 0.55, exp: 0.88 },
  sunset: { az: 258, el: 3.5, turb: 3.4, ray: 2.4, mie: 0.006, si: 2.3, haze: 20, low: 50, banks: 0.8, cl: 0.36, ci: 0.7, exp: 1.02 },
  dusk: { az: 266, el: -3, turb: 3.2, ray: 2.8, mie: 0.006, si: 1.6, haze: 22, low: 55, banks: 0.85, cl: 0.32, ci: 0.6, exp: 1.9 },
};
export const TIME_ORDER = ['golden', 'sunset', 'dusk', 'dawn', 'morning', 'day', 'afternoon'];
// a time of day between two presets (f 0..1): every number eased across, the sun along the shorter way round
export function mixTimes(a, b, f) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = k === 'az' ? a.az + ((((b.az - a.az) % 360) + 540) % 360 - 180) * f : a[k] + (b[k] - a[k]) * f;
  return out;
}

/* ---------- three's fog chunks: height fog + aerial haze, warmer toward the sun ---------- */
// THREE.Fog carries two numbers: near = haze density (per million per metre, scale height 1.4 km), far = low marine
// layer density (scale height 110 m). Lit materials add the sun's colour looking toward the sun.
let patched = false;
function patchFog() {
  if (patched) return; patched = true;
  const C = THREE.ShaderChunk;
  C.lights_pars_begin += '\n#define JW_LIT 1\n';
  C.fog_pars_vertex = '#ifdef USE_FOG\nvarying float vFogDepth;\nvarying vec3 vFogW;\n#endif';
  C.fog_vertex = '#ifdef USE_FOG\nvFogDepth = - mvPosition.z;\nvFogW = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif';
  C.fog_pars_fragment = `#ifdef USE_FOG
uniform vec3 fogColor; varying float vFogDepth; varying vec3 vFogW;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear; uniform float fogFar;
#endif
float jwFogI(float d0, float H, float y0, float ry, float dist) {
  float k = ry * dist / H;
  return d0 * exp(-y0 / H) * (abs(k) > 1e-3 ? (1.0 - exp(-k)) * H / ry : dist);
}
#endif`;
  C.fog_fragment = `#ifdef USE_FOG
{
  vec3 fd = vFogW - cameraPosition; float fdist = length(fd), ry = fd.y / max(fdist, 1e-3), y0 = clamp(cameraPosition.y, -20.0, 3000.0);
  #ifdef FOG_EXP2
  float od = fogDensity * fdist;
  #else
  float od = jwFogI(fogNear * 1e-6, 1400.0, y0, ry, fdist) + jwFogI(fogFar * 1e-6, 110.0, y0 + 8.0, ry, fdist);
  #endif
  #ifdef JW_FOG_SCALE
  od *= JW_FOG_SCALE;
  #endif
  float fogFactor = 1.0 - exp(-max(od, 0.0));
  vec3 fogC = fogColor;
  #if defined(JW_LIT) && NUM_DIR_LIGHTS > 0
  float sa = max(dot(normalize(-vViewPosition), directionalLights[0].direction), 0.0);
  fogC += directionalLights[0].color * (0.05 * pow(sa, 5.0) + 0.12 * pow(sa, 40.0));
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogC, fogFactor);
}
#endif`;
}

export function createSky(scene, { far, quality = 0 }) {
  patchFog();
  const T = textures(), sunDir = new THREE.Vector3(0, 1, 0);
  /* the sky */
  const sky = new Sky(), su = sky.material.uniforms;
  const cu = { skyGain: { value: 1 }, tNoise: { value: T.noise }, cTime: { value: 0 }, cCover: { value: 0.3 }, cCirrus: { value: 0.5 }, cLit: { value: new THREE.Color() },
    cShade: { value: new THREE.Color() }, cHaze: { value: new THREE.Color() } };
  Object.assign(sky.material.uniforms, cu);
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('uniform vec3 up;', `uniform vec3 up;
      uniform float skyGain, cTime, cCover, cCirrus; uniform vec3 cLit, cShade, cHaze; uniform sampler2D tNoise;
      // cloud density on a layer at a point (metres): four octaves of the noise, cut at the cover
      float jwCl(vec2 p) { return texture2D(tNoise, p / 11000.0).a * 0.5 + texture2D(tNoise, p / 3900.0 + 0.37).b * 0.28 + texture2D(tNoise, p / 1300.0 + 0.71).g * 0.14 + texture2D(tNoise, p / 420.0 + 0.13).r * 0.08; }`)
    .replace('gl_FragColor = vec4( retColor, 1.0 );', /* glsl */`
      vec3 col = retColor * skyGain;
      if (direction.y > 0.0) {
        // cumulus 1700 m up, drifting east with the sea breeze; lit on the side toward the sun, grey beneath where it is
        // thick, a silver edge against the sun; far ones melt into the haze
        float h = max(1700.0 - cameraPosition.y, 200.0), t = h / max(direction.y, 0.012);
        vec2 p = cameraPosition.xz + direction.xz * t + cTime * vec2(5.0, 1.5);
        float n = jwCl(p), cut = 0.72 - cCover * 0.5, c = smoothstep(cut - 0.03, cut + 0.13, n);
        float ns = jwCl(p + vSunDirection.xz / max(length(vSunDirection.xz), 0.2) * 220.0), thick = smoothstep(cut, cut + 0.25, ns);
        float sa = max(dot(direction, vSunDirection), 0.0);
        vec3 cc = mix(cLit, cShade, clamp(thick * 0.85 + c * 0.25 - 0.15, 0.0, 1.0)) + cLit * pow(sa, 6.0) * (1.0 - c) * 1.6;
        float far = 1.0 - exp(-t / 26000.0);
        cc = mix(cc, cHaze, far * 0.85);
        col = mix(col, cc, c * smoothstep(0.0, 0.06, direction.y) * (1.0 - far * 0.6) * 0.96);
        // cirrus 7 km up: long thin streaks
        vec2 q = cameraPosition.xz + direction.xz * (7000.0 / max(direction.y, 0.02)) + cTime * vec2(12.0, 4.0);
        q = mat2(0.94, 0.34, -0.34, 0.94) * q;
        float s = texture2D(tNoise, q * vec2(1.0 / 24000.0, 1.0 / 5200.0)).g * 0.7 + texture2D(tNoise, q * vec2(1.0 / 6000.0, 1.0 / 1500.0)).r * 0.3;
        float pm = smoothstep(0.42, 0.62, texture2D(tNoise, q / 70000.0 + 0.5).a);
        col = mix(col, cLit * 1.05 + cHaze * 0.2, smoothstep(0.56, 0.86, s) * pm * cCirrus * 0.55 * smoothstep(0.0, 0.12, direction.y) * (1.0 - c));
      }
      gl_FragColor = vec4( col, 1.0 );`);
  sky.scale.setScalar(far * 0.85); sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3); scene.add(sun, sun.target);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 900; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.5;
  scene.fog = new THREE.Fog(0xffffff, 20, 50);

  /* the sea: wave normals in three scales, fresnel to the sky, the sun's glitter */
  const wu = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 }, sunD: { value: new THREE.Vector3() }, sunC: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, zen: { value: new THREE.Color() },
    deep: { value: new THREE.Color() }, waves: { value: null }, tNoise: { value: null } }]);
  wu.waves.value = T.waves; wu.tNoise.value = T.noise; Object.assign(wu, { hzH: HORIZON.heights, hzB: HORIZON.box, hzN: HORIZON.near, hzNB: HORIZON.nearBox });
  const seaMat = new THREE.ShaderMaterial({
    uniforms: wu, fog: true,
    vertexShader: `#include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vW;
      void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform float time; uniform vec3 sunD, sunC, hor, zen, deep; uniform sampler2D waves, tNoise, hzH, hzN; uniform vec4 hzB, hzNB; varying vec3 vW;
      vec2 wn(vec2 uv) { return texture2D(waves, uv).xy * 2.0 - 1.0; }
      // the ground under the water here (metres; below zero under the sea), from the height maps (horizon.js)
      float seaFloor(vec2 p) {
        vec2 u = vec2(p.x - hzNB.x, hzNB.y - p.y) * hzNB.z;
        if (hzNB.z > 0.0 && u.x > 0.002 && u.y > 0.002 && u.x < 0.998 && u.y < 0.998) return texture2D(hzN, u).r;
        u = vec2(p.x - hzB.x, hzB.y - p.y) * hzB.z;
        if (hzB.z > 0.0 && u.x > 0.0 && u.y > 0.0 && u.x < 1.0 && u.y < 1.0) return texture2D(hzH, u).r;
        return -60.0;
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 V = cameraPosition - vW; float dist = length(V); V /= dist;
        vec2 p = vW.xz;
        vec2 g = wn(p / 61.0 + time * vec2(0.010, 0.006)) * 0.55 + wn(p / 19.0 + time * vec2(-0.021, 0.013)) * 0.35 + wn(p / 233.0 + time * vec2(0.003, -0.002)) * 0.5;
        g *= 0.28 / (1.0 + dist / 1800.0);
        vec3 N = normalize(vec3(g.x, 1.0, g.y));
        float fr = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
        vec3 R = reflect(-V, N); R.y = abs(R.y);
        vec3 refl = mix(hor, zen, pow(R.y, 0.6));
        float sd = max(dot(R, sunD), 0.0);
        vec3 body = deep * (0.35 + 0.65 * clamp(sunD.y * 2.0, 0.0, 1.0)) * (0.9 + 0.2 * texture2D(waves, p / 41.0).z);
        vec3 c = mix(body, refl, fr) + sunC * (pow(sd, 900.0) * 30.0 + pow(sd, 90.0) * 0.6) * smoothstep(-0.02, 0.06, sunD.y);
        // the shallows: paler water over sand, then foam: lines of swash running in to the shore, a band at its edge
        float hf = seaFloor(p), nz = texture2D(tNoise, p / 23.0 + time * 0.01).r, nz2 = texture2D(tNoise, p / 7.0 - time * 0.02).g;
        c = mix(c, mix(c, vec3(0.16, 0.27, 0.25) * (0.4 + 0.6 * clamp(sunD.y * 3.0, 0.0, 1.0)), 0.5), smoothstep(-9.0, -1.0, hf) * (1.0 - fr));
        float swash = smoothstep(0.62, 0.95, sin(hf * 2.6 + time * 1.1 + nz * 4.0) * 0.5 + 0.5) * smoothstep(-4.0, -0.8, hf);
        float foam = max(swash * 0.55, smoothstep(-1.1, -0.15, hf)) * (0.55 + 0.6 * nz2) * smoothstep(1.2, 0.2, hf);
        c = mix(c, (hor * 1.15 + sunC * 0.06) * (0.9 + 0.1 * nz), clamp(foam, 0.0, 0.9) * (1.0 - smoothstep(600.0, 2500.0, dist)));
        gl_FragColor = vec4(c, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), seaMat);
  sea.scale.setScalar(far * 2.2); sea.frustumCulled = false; scene.add(sea);

  /* Karl the fog: a map of how high it stands (a smooth top over every bank) and billows of 3D noise in it, for the
     volume in post (post.js uses fog.u); without post, soft puffs low over the sea, one instanced draw facing the camera */
  const banks = { mesh: null, amount: 1, on: true };
  const n3 = new THREE.Data3DTexture(noise3Pixels(32), 32, 32, 32);
  n3.format = THREE.RedFormat; n3.wrapS = n3.wrapT = n3.wrapR = THREE.RepeatWrapping; n3.magFilter = n3.minFilter = THREE.LinearFilter; n3.unpackAlignment = 1; n3.needsUpdate = true;
  const fog = { vol: false, u: { fogMap: { value: null }, fogNoise: { value: n3 }, fogBox: { value: new THREE.Vector4() }, fogTop: { value: 400 }, fogAmount: { value: 0 },
    fogTime: { value: 0 }, sunD: { value: sunDir }, sunC: { value: new THREE.Color() }, ambC: { value: new THREE.Color() }, baseC: { value: new THREE.Color() } } };
  function bankMap(list) {
    // the top of the fog (metres, up to fogTop) on a 256 x 256 grid over the banks: each puff a smooth dome
    const S = 256; let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z, s] of list) { x0 = Math.min(x0, x - s); x1 = Math.max(x1, x + s); z0 = Math.min(z0, z - s); z1 = Math.max(z1, z + s); }
    const w = (x1 - x0) / S, h = (z1 - z0) / S, top = new Float32Array(S * S), M = fog.u.fogTop.value;
    for (const [x, z, s, y] of list) {
      const r = s * 0.7, t = Math.min(M * 0.8, 40 + y * 0.55 + s * 0.1);
      for (let j = Math.max(0, Math.floor((z - r - z0) / h)); j <= Math.min(S - 1, Math.ceil((z + r - z0) / h)); j++)
        for (let i = Math.max(0, Math.floor((x - r - x0) / w)); i <= Math.min(S - 1, Math.ceil((x + r - x0) / w)); i++) {
          const d = Math.hypot(x0 + (i + 0.5) * w - x, z0 + (j + 0.5) * h - z) / r; if (d >= 1) continue;
          const k = j * S + i, v = t * Math.sqrt(1 - d * d); top[k] = Math.max(top[k], v) + Math.min(top[k], v) * 0.15;
        }
    }
    const px = new Uint16Array(S * S); for (let k = 0; k < S * S; k++) px[k] = THREE.DataUtils.toHalfFloat(Math.min(1, top[k] / M));
    const tex = new THREE.DataTexture(px, S, S, THREE.RedFormat, THREE.HalfFloatType); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    fog.u.fogMap.value?.dispose(); fog.u.fogMap.value = tex; fog.u.fogBox.value.set(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0));
  }
  const bankMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true, defines: { JW_FOG_SCALE: 0.3 },
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: T.puff }, op: { value: 0.6 }, lit: { value: new THREE.Color() }, shade: { value: new THREE.Color() }, sunD: { value: new THREE.Vector3() } }]),
    vertexShader: `#include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 at; varying vec2 vUv; varying float vA; varying float vSide;
      void main() {
        vUv = uv; vec4 mvPosition = viewMatrix * vec4(at.xyz, 1.0);
        float d = length(mvPosition.xyz); vA = smoothstep(at.w * 0.25, at.w * 0.9, d);   // fade when the camera is inside
        mvPosition.xy += position.xy * vec2(at.w, at.w * 0.42);
        vSide = position.x; gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map; uniform float op; uniform vec3 lit, shade, sunD; varying vec2 vUv; varying float vA; varying float vSide;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 t = texture2D(map, vUv);
        float top = smoothstep(0.15, 0.95, vUv.y), side = 0.5 + 0.5 * vSide;
        gl_FragColor = vec4(mix(shade, lit, 0.35 + 0.65 * top), t.a * op * vA);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  function placeBanks(list) {
    if (banks.mesh) { scene.remove(banks.mesh); banks.mesh.geometry.dispose(); }
    const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1)), at = new Float32Array(list.length * 4);
    list.forEach(([x, z, s, y], i) => at.set([x, y, z, s], i * 4));
    g.setAttribute('at', new THREE.InstancedBufferAttribute(at, 4)); g.instanceCount = list.length;
    banks.mesh = new THREE.Mesh(g, bankMat); banks.mesh.frustumCulled = false; banks.mesh.renderOrder = 5; scene.add(banks.mesh);
    bankMap(list); showBanks();
  }
  const showBanks = () => {
    if (banks.mesh) banks.mesh.visible = banks.on && banks.amount > 0.05 && !fog.vol;
    bankMat.uniforms.op.value = 0.95 * banks.amount; fog.u.fogAmount.value = banks.on ? banks.amount : 0;
  };

  /* the time of day */
  let t = 'golden', exposure = 1, sunI = 3, hemiI = 1;
  const tmp = new THREE.Vector3(), col = new THREE.Color();
  // a preset at once; go(name): the sun and everything with it moves there over a few seconds
  let move = null, now = null;
  function set(name) { t = name in TIMES ? name : 'golden'; move = null; apply(TIMES[t]); }
  function go(name) { const to = name in TIMES ? name : 'golden'; if (!now) return set(to); move = { from: { ...now }, to: TIMES[to], f: 0 }; t = to; }
  function apply(P) {
    now = P;
    const az = P.az * Math.PI / 180, el = P.el * Math.PI / 180;
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    su.turbidity.value = P.turb; su.rayleigh.value = P.ray; su.mieCoefficient.value = P.mie; su.mieDirectionalG.value = 0.82;
    su.sunPosition.value.copy(sunDir);
    const gain = su.skyGain.value = 0.52;
    const sp = { turbidity: P.turb, rayleigh: su.rayleigh.value, mie: P.mie, mieG: 0.82 };
    // haze: the sky's horizon averaged round the compass (the sun's glow comes from the fog chunk), a little greyer
    const hz = [0, 0, 0];
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, c = skyRadiance([Math.cos(a) * 0.999, 0.035, Math.sin(a) * 0.999], [sunDir.x, sunDir.y, sunDir.z], sp); for (let i = 0; i < 3; i++) hz[i] += c[i] * gain / 8; }
    const zen = skyRadiance([0, 1, 0], [sunDir.x, sunDir.y, sunDir.z], sp).map(v => v * gain);
    scene.fog.color.setRGB(hz[0] * 0.86, hz[1] * 0.9, hz[2] * 0.97, THREE.LinearSRGBColorSpace);
    scene.fog.near = P.haze; scene.fog.far = P.low;
    // sunlight reddened by the air it crosses; sky light from the zenith; bounce light from the golden hills
    const tint = sunTint(Math.max(0.5, P.el), sp);
    sun.color.setRGB(tint[0], tint[1], tint[2], THREE.LinearSRGBColorSpace); sun.intensity = P.si * Math.min(1, 0.35 + P.el / 12);
    hemi.color.setRGB(zen[0] * 1.6 + 0.1, zen[1] * 1.5 + 0.12, zen[2] * 1.3 + 0.14, THREE.LinearSRGBColorSpace);
    hemi.groundColor.setRGB(0.42 * tint[0], 0.33 * tint[1], 0.2 * tint[2], THREE.LinearSRGBColorSpace);
    hemi.intensity = (1.25 + 0.5 * Math.min(1, P.el / 40)) * (P.el < 0 ? Math.max(0.3, 1 + P.el / 5) : 1);
    wu.hor.value.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace); wu.zen.value.setRGB(zen[0], zen[1], zen[2], THREE.LinearSRGBColorSpace);
    wu.sunC.value.copy(sun.color).multiplyScalar(sun.intensity); wu.sunD.value.copy(sunDir);
    wu.deep.value.setRGB(0.018, 0.075, 0.105, THREE.LinearSRGBColorSpace);
    const bu = bankMat.uniforms;
    bu.lit.value.setRGB(0.35 + 0.65 * tint[0], 0.35 + 0.62 * tint[1], 0.37 + 0.56 * tint[2], THREE.LinearSRGBColorSpace).multiplyScalar(1.05 * (0.6 + 0.4 * Math.min(1, P.el / 20)));
    bu.shade.value.setRGB(zen[0] * 0.7 + 0.25, zen[1] * 0.7 + 0.27, zen[2] * 0.6 + 0.32, THREE.LinearSRGBColorSpace);
    banks.amount = P.banks; showBanks();
    // clouds: lit by the sun's colour, shaded with the zenith's blue; the far ones take the haze
    cu.skyGain.value = gain; cu.cCover.value = P.cl; cu.cCirrus.value = P.ci;
    cu.cLit.value.setRGB(tint[0], tint[1], tint[2], THREE.LinearSRGBColorSpace).multiplyScalar(0.34 * P.si * Math.min(1, 0.3 + P.el / 10)).add(new THREE.Color().setRGB(zen[0] * 0.5, zen[1] * 0.5, zen[2] * 0.5, THREE.LinearSRGBColorSpace));
    cu.cShade.value.setRGB(zen[0] * 0.75 + hz[0] * 0.35, zen[1] * 0.75 + hz[1] * 0.35, zen[2] * 0.7 + hz[2] * 0.35, THREE.LinearSRGBColorSpace);
    cu.cHaze.value.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace);
    // the fog volume: the sun on its top, the sky's light in it
    fog.u.sunC.value.copy(sun.color).multiplyScalar(sun.intensity * 0.22);
    fog.u.ambC.value.setRGB(zen[0] * 0.9 + hz[0] * 0.5, zen[1] * 0.9 + hz[1] * 0.5, zen[2] * 0.8 + hz[2] * 0.5, THREE.LinearSRGBColorSpace);
    fog.u.baseC.value.copy(scene.fog.color);
    exposure = P.exp; sunI = sun.intensity; hemiI = hemi.intensity;
  }
  return {
    sunDir, sun, hemi, set, go, placeBanks, fog, get time() { return t; }, get moving() { return !!move; },
    // the fog banks as a volume (post draws them) or as billboards
    setVolume(on) { fog.vol = !!on; showBanks(); }, get exposure() { return exposure; }, get sunI() { return sunI; }, get hemiI() { return hemiI; },
    setBanks(on) { banks.on = !!on; showBanks(); return banks.on; }, get banksOn() { return banks.on; },
    // follow the camera (sky, sea); box: move the shadow box round the rider instead (snapped to its texels so shadows
    // do not swim; done on the frames the shadow map is drawn)
    update(cam, rider, dt, shadowSpan, box = false) {
      if (box) {   // only the shadow box round the rider
        const c = sun.shadow.camera, span = shadowSpan;
        if (span && c.right !== span) { c.left = c.bottom = -span; c.right = c.top = span; c.updateProjectionMatrix(); }
        const texel = (2 * (span || 50)) / (sun.shadow.mapSize.x || 1024), tx = Math.round(rider.x / texel) * texel, tz = Math.round(rider.z / texel) * texel;
        sun.target.position.set(tx, rider.y, tz); sun.position.set(tx + sunDir.x * 400, rider.y + sunDir.y * 400, tz + sunDir.z * 400);
        return;
      }
      sky.position.copy(cam.position);
      sea.position.set(cam.position.x, 0, cam.position.z);
      wu.time.value += dt; cu.cTime.value += dt; fog.u.fogTime.value += dt;
      if (move) { move.f = Math.min(1, move.f + dt / 4); const e = move.f * move.f * (3 - 2 * move.f); apply(mixTimes(move.from, move.to, e)); if (move.f >= 1) move = null; }
    },
  };
}
