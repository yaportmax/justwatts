// World 3D atmosphere: a scattering sky with the sun disk (three's Sky), sun and sky light, height fog and aerial
// haze in the colour of the sky's own horizon (every material, through three's fog chunks), the sea (wave normals,
// fresnel, sun glint) and banks of Karl the fog off the coast that can be turned off. Times of day are presets of the
// sun's position; every colour follows from the sun, so any time in between works too.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { Sky } from '../../vendor/three-0.180.0/addons/objects/Sky.js';
import { textures } from './tex.js';
import { skyRadiance, sunTint } from './skymath.js';

// az: compass degrees, el: degrees above the horizon; turb/mie: haze in the sky; haze, low: aerial haze and the low
// marine layer (per million per metre); banks: fog bank amount; si: sun intensity; exp: exposure
export const TIMES = {
  dawn: { az: 78, el: 4, turb: 3.2, ray: 2.2, mie: 0.006, si: 2.0, haze: 22, low: 120, banks: 1, exp: 1.05 },
  morning: { az: 100, el: 15, turb: 2.6, ray: 1.6, mie: 0.005, si: 2.6, haze: 18, low: 110, banks: 1, exp: 0.92 },
  day: { az: 185, el: 58, turb: 2.0, ray: 1.2, mie: 0.004, si: 3.1, haze: 10, low: 16, banks: 0.5, exp: 0.82 },
  afternoon: { az: 228, el: 36, turb: 2.2, ray: 1.3, mie: 0.004, si: 3.0, haze: 12, low: 22, banks: 0.6, exp: 0.84 },
  golden: { az: 248, el: 13, turb: 2.6, ray: 1.6, mie: 0.005, si: 2.9, haze: 14, low: 30, banks: 0.75, exp: 0.88 },
  sunset: { az: 258, el: 3.5, turb: 3.4, ray: 2.4, mie: 0.006, si: 2.3, haze: 20, low: 50, banks: 0.8, exp: 1.02 },
};
export const TIME_ORDER = ['golden', 'sunset', 'dawn', 'morning', 'day', 'afternoon'];

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
  sky.material.uniforms.skyGain = { value: 1 };
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('uniform vec3 up;', 'uniform vec3 up;\nuniform float skyGain;')
    .replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * skyGain, 1.0 );');
  sky.scale.setScalar(far * 0.85); sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3); scene.add(sun, sun.target);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 900; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.5;
  scene.fog = new THREE.Fog(0xffffff, 20, 50);

  /* the sea: wave normals in three scales, fresnel to the sky, the sun's glitter */
  const wu = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 }, sunD: { value: new THREE.Vector3() }, sunC: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, zen: { value: new THREE.Color() },
    deep: { value: new THREE.Color() }, waves: { value: null } }]);
  wu.waves.value = T.waves;
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
      uniform float time; uniform vec3 sunD, sunC, hor, zen, deep; uniform sampler2D waves; varying vec3 vW;
      vec2 wn(vec2 uv) { return texture2D(waves, uv).xy * 2.0 - 1.0; }
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
        gl_FragColor = vec4(c, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), seaMat);
  sea.scale.setScalar(far * 2.2); sea.frustumCulled = false; scene.add(sea);

  /* Karl the fog: soft puffs low over the sea, one instanced draw, facing the camera */
  const banks = { mesh: null, amount: 1, on: true };
  const bankMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true,
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
        float top = smoothstep(0.2, 0.9, vUv.y);
        gl_FragColor = vec4(mix(shade, lit, 0.55 + 0.45 * top), t.a * op * vA);
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
    showBanks();
  }
  const showBanks = () => { if (banks.mesh) banks.mesh.visible = banks.on && banks.amount > 0.05; bankMat.uniforms.op.value = 0.85 * banks.amount; };

  /* the time of day */
  let t = 'golden', exposure = 1, sunI = 3, hemiI = 1;
  const tmp = new THREE.Vector3(), col = new THREE.Color();
  function set(name) {
    const P = TIMES[name] || TIMES.golden; t = name in TIMES ? name : 'golden';
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
    hemi.intensity = 1.25 + 0.5 * Math.min(1, P.el / 40);
    wu.hor.value.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace); wu.zen.value.setRGB(zen[0], zen[1], zen[2], THREE.LinearSRGBColorSpace);
    wu.sunC.value.copy(sun.color).multiplyScalar(sun.intensity); wu.sunD.value.copy(sunDir);
    wu.deep.value.setRGB(0.018, 0.075, 0.105, THREE.LinearSRGBColorSpace);
    const bu = bankMat.uniforms;
    bu.lit.value.setRGB(0.25 + 0.75 * tint[0], 0.25 + 0.72 * tint[1], 0.27 + 0.66 * tint[2], THREE.LinearSRGBColorSpace).multiplyScalar(0.55 + 0.45 * Math.min(1, P.el / 20));
    bu.shade.value.setRGB(hz[0] * 0.8, hz[1] * 0.84, hz[2] * 0.92, THREE.LinearSRGBColorSpace);
    banks.amount = P.banks; showBanks();
    exposure = P.exp; sunI = sun.intensity; hemiI = hemi.intensity;
  }
  return {
    sunDir, sun, hemi, set, placeBanks, get time() { return t; }, get exposure() { return exposure; }, get sunI() { return sunI; }, get hemiI() { return hemiI; },
    setBanks(on) { banks.on = !!on; showBanks(); return banks.on; }, get banksOn() { return banks.on; },
    // follow the camera (sky, sea), the shadow box around the rider (snapped to its texels so shadows do not swim)
    update(cam, rider, dt, shadowSpan) {
      sky.position.copy(cam.position);
      sea.position.set(cam.position.x, 0, cam.position.z);
      wu.time.value += dt;
      const c = sun.shadow.camera, span = shadowSpan;
      if (span && c.right !== span) { c.left = c.bottom = -span; c.right = c.top = span; c.updateProjectionMatrix(); }
      const texel = (2 * (span || 50)) / (sun.shadow.mapSize.x || 1024);
      const tx = Math.round(rider.x / texel) * texel, tz = Math.round(rider.z / texel) * texel;
      sun.target.position.set(tx, rider.y, tz); sun.position.set(tx + sunDir.x * 400, rider.y + sunDir.y * 400, tz + sunDir.z * 400);
    },
  };
}
