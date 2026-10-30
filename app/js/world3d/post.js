// World 3D post-processing: the scene renders to a multisampled half-float target, bright light blooms (three's
// UnrealBloomPass), then one pass tone maps (ACES), grades for a warm Marin light (a little warmth in the highlights,
// cooler shadows, gentle contrast and saturation), adds a soft vignette and dithers the sky's gradients. Low quality
// renders straight to the screen with the same tone mapping and no bloom. Edges: MSAA in the scene target, or FXAA
// after the grade where MSAA on a half-float target costs too much.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { EffectComposer } from '../../vendor/three-0.180.0/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three-0.180.0/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../../vendor/three-0.180.0/addons/postprocessing/ShaderPass.js';
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

// q: { bloom, msaa } or null (straight to the screen)
export function createPost(renderer, scene, camera) {
  let composer = null, grade = null, bloom = null, fxaa = null, on = false, cfg = null, size = [1, 1, 1];
  function build(Q) {
    dispose();
    cfg = Q; on = !!Q.post;
    if (!on) { renderer.toneMapping = THREE.ACESFilmicToneMapping; return; }
    renderer.toneMapping = THREE.NoToneMapping;
    const rt = new THREE.WebGLRenderTarget(size[0] * size[2], size[1] * size[2], { type: THREE.HalfFloatType, samples: Q.msaa || 0 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    if (Q.bloom) { bloom = new UnrealBloomPass(new THREE.Vector2(size[0], size[1]), 0.22, 0.45, 1.15); composer.addPass(bloom); }
    grade = new ShaderPass(GradeShader); composer.addPass(grade);
    if (Q.fxaa) { fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa); }
    composer.setPixelRatio(size[2]); composer.setSize(size[0], size[1]); fxRes();
  }
  const fxRes = () => fxaa?.material.uniforms.resolution.value.set(1 / (size[0] * size[2]), 1 / (size[1] * size[2]));
  function dispose() { if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); bloom?.dispose(); grade?.material.dispose(); fxaa?.material.dispose(); } composer = null; bloom = null; grade = null; fxaa = null; }
  return {
    build,
    setSize(w, h, pr) { size = [w, h, pr]; if (composer) { composer.setPixelRatio(pr); composer.setSize(w, h); fxRes(); } },
    render(exposure = 1) {
      if (composer) { grade.uniforms.exposure.value = exposure; composer.render(); }
      else { renderer.toneMappingExposure = exposure; renderer.render(scene, camera); }
    },
    dispose,
    get on() { return on; },
  };
}
