// World 3D post-processing: the scene renders to a multisampled half-float target (with its depth), the fog banks are
// ray marched through at half size and laid over it (FogPass), bright light blooms (three's UnrealBloomPass), then
// one pass tone maps (ACES), grades for a warm Marin light (a little warmth in the highlights,
// cooler shadows, gentle contrast and saturation), adds a soft vignette and dithers the sky's gradients. Low quality
// renders straight to the screen with the same tone mapping and no bloom. Edges: MSAA in the scene target, or FXAA
// after the grade where MSAA on a half-float target costs too much.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { EffectComposer } from '../../vendor/three-0.180.0/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three-0.180.0/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../../vendor/three-0.180.0/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from '../../vendor/three-0.180.0/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from '../../vendor/three-0.180.0/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from '../../vendor/three-0.180.0/addons/shaders/FXAAShader.js';

const GradeShader = {
  name: 'JwGrade',
  uniforms: { tDiffuse: { value: null }, exposure: { value: 1 }, warm: { value: 0.5 }, vig: { value: 0.28 }, sat: { value: 1.08 }, res: { value: new THREE.Vector2(1, 1) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float exposure, warm, vig, sat; uniform vec2 res; varying vec2 vUv;
    vec3 rrt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 c) {
      const mat3 i = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 o = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      return clamp(o * rrt(i * c), 0.0, 1.0);
    }
    vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * exposure / 0.6;
      c = aces(c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, sat);                                                     // saturation
      c *= mix(vec3(0.97, 0.99, 1.04), vec3(1.05, 1.0, 0.92), smoothstep(0.05, 0.75, l) * warm + (1.0 - warm) * 0.5);  // split tone
      vec2 q = vUv - 0.5; c *= 1.0 - vig * smoothstep(0.25, 0.85, dot(q, q) * 2.2);  // vignette
      c = toSrgb(clamp(c, 0.0, 1.0));
      c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;  // dither
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// Karl the fog as a volume: the ray from the eye to the scene's depth (logarithmic, as the renderer writes it) through
// the layer under the fog's top (a map, sky.js), in STEPS steps closer together near the eye; billows of 3D noise
// drifting in it; lit by the sun on its top (glowing toward the sun) and by the sky inside. Half size: in-scattered
// light and what is left of the scene, laid over the scene in one blend.
const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
class FogPass extends Pass {
  constructor(camera, u, steps) {
    super(); this.needsSwap = false; this.camera = camera;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.u = { tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() }, logC: { value: 1 }, ...u };
    this.march = new THREE.ShaderMaterial({ uniforms: this.u, defines: { STEPS: steps }, vertexShader: VS, depthTest: false, depthWrite: false, fragmentShader: /* glsl */`
      uniform sampler2D tDepth, fogMap; uniform sampler3D fogNoise; uniform mat4 invProj, camWorld; uniform vec3 camPos, sunD, sunC, ambC;
      uniform float logC, fogTop, fogAmount, fogTime; uniform vec4 fogBox; varying vec2 vUv;
      float topAt(vec2 xz) { vec2 m = (xz - fogBox.xy) * fogBox.zw; return m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0 ? 0.0 : texture(fogMap, m).r * fogTop; }
      void main() {
        float d = texture(tDepth, vUv).r;
        vec4 v = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0); vec3 dv = normalize(v.xyz / v.w), dir = normalize((camWorld * vec4(dv, 0.0)).xyz);
        float w = d >= 0.99999 ? 1e7 : exp2(d * logC) - 1.0, t0 = 0.0, t1 = min(w / max(-dv.z, 1e-4), 40000.0);
        // the part of the ray between the sea and the highest top
        if (abs(dir.y) > 1e-4) { float ta = -camPos.y / dir.y, tb = (fogTop - camPos.y) / dir.y; t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb)); }
        else if (camPos.y > fogTop || camPos.y < 0.0) t1 = 0.0;
        vec3 L = vec3(0.0); float T = 1.0;
        if (t1 > t0 && fogAmount > 0.01) {
          float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))), span = t1 - t0, prev = t0;
          float g = 0.6, ct = dot(dir, sunD), ph = 0.35 + 0.3 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * ct, 1.5);
          for (int i = 0; i < STEPS; i++) {
            float f = (float(i) + j) / float(STEPS), t = t0 + span * f * f, dt = t - prev; prev = t;
            vec3 p = camPos + dir * t; float top = topAt(p.xz);
            if (p.y > top) continue;
            // a rolling top: the map's height lifted and dropped by big slow billows
            float b = texture(fogNoise, vec3(p.xz / 1100.0, fogTime * 0.0015) + vec3(fogTime * 0.003, 0.0, 0.0)).r;
            top *= 0.55 + 0.75 * b;
            if (p.y > top) continue;
            float n = texture(fogNoise, p * vec3(1.0 / 380.0, 1.0 / 140.0, 1.0 / 380.0) + vec3(fogTime * 0.004, 0.0, fogTime * 0.0012)).r;
            float n2 = texture(fogNoise, p * vec3(1.0 / 110.0, 1.0 / 50.0, 1.0 / 110.0) + vec3(0.37, fogTime * 0.006, 0.0)).r;
            float dens = 0.03 * fogAmount * clamp((n + n2 * 0.55 - 0.6) * 2.6, 0.0, 1.6) * smoothstep(0.0, 35.0, top - p.y);
            if (dens < 1e-5) continue;
            float sunT = exp(-0.008 * fogAmount * max(top - p.y, 0.0));
            vec3 S = sunC * ph * sunT + ambC * (0.6 + 0.4 * sunT);
            float a = exp(-dens * dt); L += T * S * (1.0 - a); T *= a;
            if (T < 0.02) break;
          }
        }
        gl_FragColor = vec4(L, T);
      }` });
    this.blend = new THREE.ShaderMaterial({ uniforms: { tFog: { value: this.rt.texture } }, vertexShader: VS, depthTest: false, depthWrite: false, transparent: true,
      fragmentShader: 'uniform sampler2D tFog; varying vec2 vUv; void main() { gl_FragColor = texture2D(tFog, vUv); }',
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    this.quad = new FullScreenQuad(this.march);
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); }
  render(renderer, writeBuffer, readBuffer) {
    if (this.u.fogAmount.value < 0.01 || !this.u.fogMap.value) return;
    const c = this.camera, u = this.u;
    u.tDepth.value = readBuffer.depthTexture; u.invProj.value.copy(c.projectionMatrixInverse); u.camWorld.value.copy(c.matrixWorld); u.camPos.value.setFromMatrixPosition(c.matrixWorld);
    u.logC.value = Math.log2(c.far + 1);
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(this.rt); this.quad.material = this.march; this.quad.render(renderer);
    renderer.setRenderTarget(readBuffer); this.quad.material = this.blend; this.quad.render(renderer);
    renderer.autoClear = ac;
  }
  dispose() { this.rt.dispose(); this.march.dispose(); this.blend.dispose(); this.quad.dispose(); }
}

// Q: { post, bloom, msaa, fxaa, vol: fog steps } (no post: straight to the screen); fog: sky.fog.u (the fog's map,
// noise and light)
export function createPost(renderer, scene, camera, fog = null) {
  let composer = null, grade = null, bloom = null, fxaa = null, fogp = null, on = false, cfg = null, size = [1, 1, 1];
  function build(Q) {
    dispose();
    cfg = Q; on = !!Q.post;
    if (!on) { renderer.toneMapping = THREE.ACESFilmicToneMapping; return; }
    renderer.toneMapping = THREE.NoToneMapping;
    const rt = new THREE.WebGLRenderTarget(size[0] * size[2], size[1] * size[2], { type: THREE.HalfFloatType, samples: Q.msaa || 0, depthTexture: Q.vol && fog ? new THREE.DepthTexture(1, 1) : null });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    if (Q.vol && fog) { fogp = new FogPass(camera, fog, Q.vol); composer.addPass(fogp); }
    if (Q.bloom) { bloom = new UnrealBloomPass(new THREE.Vector2(size[0], size[1]), 0.22, 0.45, 1.15); composer.addPass(bloom); }
    grade = new ShaderPass(GradeShader); composer.addPass(grade);
    if (Q.fxaa) { fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa); }
    composer.setPixelRatio(size[2]); composer.setSize(size[0], size[1]); fxRes();
  }
  const fxRes = () => fxaa?.material.uniforms.resolution.value.set(1 / (size[0] * size[2]), 1 / (size[1] * size[2]));
  function dispose() {
    if (composer) { for (const t of [composer.renderTarget1, composer.renderTarget2]) { t.depthTexture?.dispose(); t.dispose(); } bloom?.dispose(); grade?.material.dispose(); fxaa?.material.dispose(); fogp?.dispose(); }
    composer = null; bloom = null; grade = null; fxaa = null; fogp = null;
  }
  return {
    build,
    setSize(w, h, pr) { size = [w, h, pr]; if (composer) { composer.setPixelRatio(pr); composer.setSize(w, h); fxRes(); } },
    render(exposure = 1) {
      if (composer) { grade.uniforms.exposure.value = exposure; composer.render(); }
      else { renderer.toneMappingExposure = exposure; renderer.render(scene, camera); }
    },
    dispose,
    get on() { return on; }, get fog() { return !!fogp; },
  };
}
