// World 3D impostors: every tree species drawn once at start into an atlas, its colour and its normals (for the light),
// seen from the side and from 50 degrees up. Trees past the full models' radius are cards facing the camera that show
// it: one instanced draw a tile, every tree in it, the near ones (the full models' circle) left out in the vertex
// shader, so moving the circle costs nothing on the CPU. Far away they thin out, the ones left a little bigger.
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { withSun } from './materials.js';

const CW = 256, CH = 512, TOP = 50 * Math.PI / 180;

// geos: { name: geometry } (merge() output: position, normal, color, uv), names: the order of the cells; leaves: the
// leaf atlas; near: the share of the full models' radius per name. -> { color, normal: textures, cells: [[half width,
// half height, centre height, near share], ...] }
export function bakeImpostors(renderer, geos, names, leaves, near = {}) {
  const n = names.length, W = n * CW, H = 2 * CH;
  const rt = fill => { const t = new THREE.WebGLRenderTarget(W, H, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    t.texture.anisotropy = 4; t.fill = fill; return t; };
  const color = rt([0.035, 0.05, 0.025, 0]), normal = rt([0.5, 0.5, 1, 0]);
  const vs = `attribute vec3 color; varying vec3 vC; varying vec3 vN; varying vec2 vUv;
    void main() { vC = color; vUv = uv; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const mk = out => new THREE.ShaderMaterial({ uniforms: { leaves: { value: leaves } }, side: THREE.DoubleSide, vertexShader: vs,
    fragmentShader: `uniform sampler2D leaves; varying vec3 vC; varying vec3 vN; varying vec2 vUv;
      void main() { vec4 t = texture2D(leaves, vUv); if (t.a < 0.5) discard; ${out} }` });
  // albedo in linear light (the atlas is sRGB, decoded when sampled); normals in the camera's frame
  const mats = [[color, mk('gl_FragColor = vec4(vC * t.rgb, 1.0);')], [normal, mk('vec3 n = normalize(vN); gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);')]];
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400), cells = [];
  const prev = renderer.getRenderTarget(), pc = renderer.getClearColor(new THREE.Color()), pa = renderer.getClearAlpha(), pt = renderer.toneMapping, pac = renderer.autoClear;
  renderer.toneMapping = THREE.NoToneMapping; renderer.autoClear = true;
  names.forEach((name, i) => {
    const g = geos[name]; g.computeBoundingBox(); const b = g.boundingBox, cy = (b.min.y + b.max.y) / 2;
    const hw = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.52, h = b.max.y - b.min.y;
    const hh = Math.max(h, h * Math.cos(TOP) + 2 * hw * Math.sin(TOP)) * 0.52;
    cells.push([hw, hh, cy, near[name] ?? 1]);
    const mesh = new THREE.Mesh(g); scene.add(mesh);
    cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh; cam.updateProjectionMatrix();
    for (const [row, el] of [[0, 0], [1, TOP]]) {
      // seen from the south (+z) at that elevation, centred on the tree's middle
      cam.position.set(0, cy + Math.sin(el) * 200, Math.cos(el) * 200); cam.up.set(0, 1, 0); cam.lookAt(0, cy, 0); cam.updateMatrixWorld();
      for (const [t, m] of mats) {
        // the target's rows run bottom up: the side view in the top half (v 0.5 .. 1), the view from above below it;
        // each cell cleared to its fill (the colour mipmaps blend toward at the edges)
        const vy = (1 - row) * CH; t.viewport.set(i * CW, vy, CW, CH); t.scissor.set(i * CW, vy, CW, CH); t.scissorTest = true;
        mesh.material = m; renderer.setRenderTarget(t); renderer.setClearColor(new THREE.Color().setRGB(t.fill[0], t.fill[1], t.fill[2], THREE.LinearSRGBColorSpace), 0);
        renderer.render(scene, cam);
      }
    }
    scene.remove(mesh);
  });
  for (const [t] of mats) { t.scissorTest = false; t.viewport.set(0, 0, W, H); }
  renderer.setRenderTarget(prev); renderer.setClearColor(pc, pa); renderer.toneMapping = pt; renderer.autoClear = pac;
  for (const [, m] of mats) m.dispose();
  return { color: color.texture, normal: normal.texture, cells, n, targets: [color, normal] };
}

// The impostor material: a MeshLambertMaterial (three's lights, fog and haze) on an InstancedBufferGeometry quad with
// per instance ia = [x, y, z, scale], ib = [cell, height scale (negative: a far tile's tree, never thinned), light,
// warm]. One per tile (they share the program): userData.u.nearC / nearR, the full models' circle, and nearBox
// [x0, z0, x1, z1] the near tiles' square (a far tile's trees), none drawn inside them.
export function impostorMaterial(imp) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff }), u = m.userData.u = { nearC: { value: new THREE.Vector2(0, 0) }, nearR: { value: 0 }, nearBox: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) } };
  imp.cellU ??= { value: Array.from({ length: 16 }, (_, i) => new THREE.Vector4(...(imp.cells[i] || [1, 1, 0, 0]))) };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { impColor: { value: imp.color }, impNormal: { value: imp.normal }, impCell: imp.cellU, impN: { value: imp.n }, nearC: u.nearC, nearR: u.nearR, nearBox: u.nearBox });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 ia; attribute vec4 ib; uniform vec4 impCell[16]; uniform float impN; uniform vec2 nearC; uniform float nearR; uniform vec4 nearBox;
        varying vec2 vIu; varying vec3 vIR; varying vec3 vIU; varying vec3 vIF; varying vec3 vItint;`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', /* glsl */`
        vec4 cell = impCell[int(ib.x + 0.5)];
        float s = ia.w, d = distance(ia.xz, cameraPosition.xz);
        // thin out far away: keep a share, the kept ones grow to cover for the rest
        float keep = ib.y < 0.0 ? 1.0 : mix(1.0, 0.3, clamp((d - 140.0) / 1500.0, 0.0, 1.0)), r = fract(ia.x * 0.1731 + ia.z * 0.2917), hs = abs(ib.y);
        float inBox = step(nearBox.x, ia.x) * step(ia.x, nearBox.z) * step(nearBox.y, ia.z) * step(ia.z, nearBox.w);
        float on = step(r, keep) * step(nearR * cell.w, distance(ia.xz, nearC)) * (1.0 - step(14000.0, d)) * (1.0 - inBox);
        s *= inversesqrt(keep) * 0.92 + 0.08;
        vec3 ctr = ia.xyz + vec3(0.0, cell.z * s * hs, 0.0);
        vec3 F = cameraPosition - ctr; F = normalize(F);
        vec3 R = normalize(cross(vec3(0.0, 1.0, 0.0), F)), U = cross(F, R);
        vec3 transformed = ctr + (R * position.x * cell.x * s + U * position.y * cell.y * s * hs) * on;
        vec2 quv = position.xy * 0.5 + 0.5;
        // the view from the side or from above, each tree crossing over at its own angle between 18 and 34 degrees up
        float top = step(fract(ia.x * 0.37 + ia.z * 0.61), smoothstep(0.31, 0.6, asin(clamp(F.y, -1.0, 1.0))));
        vIR = R; vIU = U; vIF = F;
        vIu = vec2((ib.x + quv.x) / impN, quv.y * 0.5 + (1.0 - top) * 0.5);
        vItint = ib.z * vec3(1.0 + ib.w, 1.0, 1.0 - ib.w);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D impColor, impNormal; varying vec2 vIu; varying vec3 vIR; varying vec3 vIU; varying vec3 vIF; varying vec3 vItint;`)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 iuv = vIu;
        vec4 ic = texture2D(impColor, iuv);
        // alpha thins in the mipmaps: scale it back up by the level (the trees keep their size far away)
        vec2 px = iuv * vec2(textureSize(impColor, 0));
        float lod = max(0.0, 0.5 * log2(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px)))));
        if (ic.a * (1.0 + lod * 0.45) < 0.5) discard;
        diffuseColor.rgb *= ic.rgb * vItint;
        vec3 inrm = texture2D(impNormal, iuv).xyz * 2.0 - 1.0;
        vec3 jwImpN = normalize(vIR * inrm.x + vIU * inrm.y + vIF * inrm.z);`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(jwImpN, 0.0)).xyz);');
  };
  m.customProgramCacheKey = () => 'jw-imp-1';
  return withSun(m);
}

// one tile's far trees: list [[x, y, z, scale, cell, height scale, light, warm], ...] -> a mesh with its own material
export function impostorMesh(imp, list, sphere) {
  const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(2, 2));
  const ia = new Float32Array(list.length * 4), ib = new Float32Array(list.length * 4);
  list.forEach((t, i) => { ia.set(t.slice(0, 4), i * 4); ib.set(t.slice(4, 8), i * 4); });
  g.setAttribute('ia', new THREE.InstancedBufferAttribute(ia, 4)); g.setAttribute('ib', new THREE.InstancedBufferAttribute(ib, 4)); g.instanceCount = list.length;
  g.boundingSphere = sphere;
  const mesh = new THREE.Mesh(g, impostorMaterial(imp)); mesh.matrixAutoUpdate = false;
  return mesh;
}
