// World 3D terrain shadows at any distance: the terrain round the rider is drawn from straight above into a height map
// (2048 texels over 40 km), then each texel walks toward the sun along it, ever further apart, and keeps the steepest
// rise it meets: past the sun's own height it is in a hill's shadow (soft over about a degree). Lit materials read the
// map (materials.js withSun). Made again when the sun moves, the rider gets 4 km from its middle or tiles were built.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { HORIZON } from './materials.js';

export const HZ_SIZE = 40000, HZ_RES = 2048, HZ_LAYER = 2;
export function createHorizon(renderer, scene, sunDir) {
  const opt = { type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
  const heights = new THREE.WebGLRenderTarget(HZ_RES, HZ_RES, { ...opt, depthBuffer: true }), vis = new THREE.WebGLRenderTarget(HZ_RES, HZ_RES, { ...opt, depthBuffer: false });
  const cam = new THREE.OrthographicCamera(-HZ_SIZE / 2, HZ_SIZE / 2, HZ_SIZE / 2, -HZ_SIZE / 2, 1, 5000); cam.up.set(0, 0, -1); cam.layers.set(HZ_LAYER);
  const hMat = new THREE.ShaderMaterial({ vertexShader: 'varying float vY; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'varying float vY; void main() { gl_FragColor = vec4(max(vY, 0.0), 0.0, 0.0, 1.0); }' });
  const walk = new THREE.ShaderMaterial({ uniforms: { hMap: { value: heights.texture }, step: { value: new THREE.Vector2() }, tanSun: { value: 0 } }, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      uniform sampler2D hMap; uniform vec2 step; uniform float tanSun; varying vec2 vUv;
      void main() {
        float h0 = texture2D(hMap, vUv).r, m = -1.0, s = 1.5;
        for (int i = 0; i < 44; i++) {
          vec2 u = vUv + step * s;
          if (u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0) break;
          m = max(m, (texture2D(hMap, u).r - h0) / (s * ${(HZ_SIZE / HZ_RES).toFixed(4)}));
          s *= 1.16;
        }
        gl_FragColor = vec4(smoothstep(-0.02, 0.02, tanSun - m), 0.0, 0.0, 1.0);
      }` });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), walk); quad.frustumCulled = false; quad.layers.set(HZ_LAYER);
  const qScene = new THREE.Scene(); qScene.add(quad);
  let at = null, sun = new THREE.Vector3(), dirty = true, last = 0;
  HORIZON.map.value = vis.texture;
  function draw(cx, cz) {
    const prev = renderer.getRenderTarget(), au = renderer.shadowMap.autoUpdate, ac = renderer.autoClear, cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(), tm = renderer.toneMapping;
    renderer.shadowMap.autoUpdate = false; renderer.autoClear = true; renderer.toneMapping = THREE.NoToneMapping; renderer.setClearColor(0x000000, 1);
    cam.position.set(cx, 4000, cz); cam.lookAt(cx, 0, cz); cam.updateMatrixWorld();
    const ov = scene.overrideMaterial, fog = scene.fog, bg = scene.background; scene.overrideMaterial = hMat; scene.fog = null; scene.background = null;
    renderer.setRenderTarget(heights); renderer.render(scene, cam);
    scene.overrideMaterial = ov; scene.fog = fog; scene.background = bg;
    // toward the sun across the map: u east, v north (the camera's up is north)
    const hl = Math.hypot(sunDir.x, sunDir.z) || 1e-6, k = 1 / HZ_RES;
    walk.uniforms.step.value.set(sunDir.x / hl * k, -sunDir.z / hl * k); walk.uniforms.tanSun.value = sunDir.y / hl;
    renderer.setRenderTarget(vis); renderer.render(qScene, cam);
    renderer.setRenderTarget(prev); renderer.shadowMap.autoUpdate = au; renderer.autoClear = ac; renderer.setClearColor(cc, ca); renderer.toneMapping = tm;
    HORIZON.box.value.set(cx - HZ_SIZE / 2, cz + HZ_SIZE / 2, 1 / HZ_SIZE, 0);
    at = [cx, cz]; sun.copy(sunDir); dirty = false;
  }
  return {
    // the terrain changed (a tile built): draw again within a couple of seconds
    touch() { dirty = true; },
    update(x, z, now) {
      if (!at || Math.hypot(x - at[0], z - at[1]) > 4000 || sun.angleTo(sunDir) > 0.004 || (dirty && now - last > 2000)) { last = now; draw(x, z); }
    },
    targets: { heights, vis },
    dispose() { heights.dispose(); vis.dispose(); hMat.dispose(); walk.dispose(); quad.geometry.dispose(); HORIZON.map.value = null; HORIZON.box.value.set(0, 0, 0, 0); },
  };
}
