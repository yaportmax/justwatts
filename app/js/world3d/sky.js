// World 3D atmosphere: sky dome with the sun, sun and sky light (soft shadows near the rider), distance fog, a faceted
// moving sea, and low banks of Karl the fog off the coast. Times of day: morning (fog in), midday, golden hour.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';

export const TIMES = {
  morning: { az: 105, el: 16, sun: 0xffe2c0, si: 2.4, hemi: [0xbfd2ea, 0x7d7258, 1.7], zen: 0x6f98c8, hor: 0xd9dfe2, fog: 0xd2dade, fogN: 900, fogF: 16000, banks: 1 },
  day: { az: 190, el: 58, sun: 0xfff6e8, si: 3.0, hemi: [0xc3d8f2, 0x7f7458, 1.5], zen: 0x3f7cc4, hor: 0xc9dceb, fog: 0xbfd2e2, fogN: 2500, fogF: 30000, banks: 0.45 },
  golden: { az: 238, el: 24, sun: 0xffdcae, si: 3.1, hemi: [0xb9d0ee, 0x8a7656, 1.6], zen: 0x4a83c8, hor: 0xe8dccb, fog: 0xd9d3c8, fogN: 2500, fogF: 30000, banks: 0.7 },
};

export function createSky(scene, { far }) {
  const sunDir = new THREE.Vector3();
  // dome
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sun: { value: new THREE.Color() }, dir: { value: sunDir } },
    vertexShader: 'varying vec3 vD; void main() { vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 zen, hor, sun, dir; varying vec3 vD;
      void main() {
        float y = max(vD.y, 0.0), s = max(dot(normalize(vD), dir), 0.0);
        vec3 c = mix(hor, zen, pow(y, 0.45));
        c = mix(c, hor * 0.92, smoothstep(0.0, -0.08, vD.y));
        c += sun * (pow(s, 1500.0) * 5.0 + pow(s, 60.0) * 0.25 + pow(s, 6.0) * 0.07);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  dome.renderOrder = -10; dome.frustumCulled = false; dome.scale.setScalar(far * 0.9); scene.add(dome);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3); scene.add(sun, sun.target);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 900; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  scene.fog = new THREE.Fog(0xffffff, 1000, 20000);

  // the sea: a faceted swell near the camera, a flat plane to the horizon
  const segs = 90, size = 3600;
  const seaG = new THREE.PlaneGeometry(size, size, segs, segs).rotateX(-Math.PI / 2).toNonIndexed();
  const seaMat = new THREE.MeshPhongMaterial({ color: 0x2c6a85, specular: 0x9fb8c4, shininess: 60, flatShading: true });
  const sh = { time: { value: 0 }, sky: { value: new THREE.Color() }, sunV: { value: new THREE.Vector3() } };
  const glints = s => {  // the sky in the water at a low angle, glitter toward the sun
    s.uniforms.skyC = sh.sky; s.uniforms.sunV = sh.sunV;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 skyC; uniform vec3 sunV;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        vec3 vd = normalize(vViewPosition), n2 = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
        float fr = pow(1.0 - clamp(abs(dot(vd, n2)), 0.0, 1.0), 4.0);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, skyC, fr * 0.55);
        float g = pow(max(dot(reflect(-vd, n2), normalize(sunV)), 0.0), 220.0);
        gl_FragColor.rgb += vec3(1.0, 0.92, 0.75) * g * 1.4;`);
  };
  seaMat.onBeforeCompile = s => {
    glints(s);
    s.uniforms.time = sh.time;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform float time;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 w = (modelMatrix * vec4(transformed, 1.0)).xyz;
        float e = smoothstep(${(size * 0.5).toFixed(1)}, ${(size * 0.32).toFixed(1)}, max(abs(position.x), abs(position.z)));
        transformed.y += e * (sin(w.x * 0.045 + time * 0.9) * 0.35 + sin(w.z * 0.06 - time * 1.2) * 0.3 + sin((w.x + w.z) * 0.11 + time * 1.7) * 0.15);`);
  };
  const sea = new THREE.Mesh(seaG, seaMat); sea.receiveShadow = false; scene.add(sea);
  const deepMat = new THREE.MeshPhongMaterial({ color: 0x2a6580, specular: 0x6f8a96, shininess: 30 }); deepMat.onBeforeCompile = glints;
  const deep = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), deepMat);
  deep.scale.setScalar(far * 2.2); deep.position.y = -0.6; scene.add(deep);

  // fog banks: soft billboards low over the sea (the Golden Gate, the ocean off the Headlands and Stinson)
  const tex = (() => {
    const c = new OffscreenCanvas(128, 128), g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.5, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const banks = new THREE.Group(); scene.add(banks);
  const bankMat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, fog: true });

  let t = 'golden';
  function set(name) {
    const T = TIMES[name] || TIMES.golden; t = name in TIMES ? name : 'golden';
    const az = T.az * Math.PI / 180, el = T.el * Math.PI / 180;
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    dome.material.uniforms.zen.value.set(T.zen); dome.material.uniforms.hor.value.set(T.hor); dome.material.uniforms.sun.value.set(T.sun);
    hemi.color.set(T.hemi[0]); hemi.groundColor.set(T.hemi[1]); hemi.intensity = T.hemi[2];
    sun.color.set(T.sun); sun.intensity = T.si;
    scene.fog.color.set(T.fog); scene.fog.near = T.fogN; scene.fog.far = Math.min(T.fogF, far * 0.95);
    seaMat.color.set(name === 'golden' ? 0x35708a : name === 'morning' ? 0x4d7a8a : 0x2a6a88);
    bankMat.opacity = 0.55 * T.banks; banks.visible = T.banks > 0.05; sh.sky.value.set(T.hor);
  }
  // banks at local positions [[x, z, size], ...] (marin.js)
  function placeBanks(list) {
    banks.clear();
    for (const [x, z, s, y = 60] of list) { const sp = new THREE.Sprite(bankMat); sp.position.set(x, y + s * 0.12, z); sp.scale.set(s, s * 0.32, 1); banks.add(sp); }
  }
  return {
    sunDir, sun, set, placeBanks, get time() { return t; },
    // follow the camera (dome, sea), the shadow box around the rider (snapped to its texels so shadows do not swim)
    update(cam, rider, dt, shadowSpan) {
      dome.position.copy(cam.position);
      const g = size / segs; sea.position.set(Math.round(cam.position.x / g) * g, 0, Math.round(cam.position.z / g) * g);
      deep.position.x = cam.position.x; deep.position.z = cam.position.z;
      sh.time.value += dt; sh.sunV.value.copy(sunDir).transformDirection(cam.matrixWorldInverse);
      const c = sun.shadow.camera, span = shadowSpan;
      if (c.right !== span) { c.left = c.bottom = -span; c.right = c.top = span; c.updateProjectionMatrix(); }
      const texel = (2 * span) / (sun.shadow.mapSize.x || 1024);
      const tx = Math.round(rider.x / texel) * texel, tz = Math.round(rider.z / texel) * texel;
      sun.target.position.set(tx, rider.y, tz); sun.position.set(tx + sunDir.x * 400, rider.y + sunDir.y * 400, tz + sunDir.z * 400);
    },
  };
}
