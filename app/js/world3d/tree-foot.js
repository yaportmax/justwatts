// (Owner shot 21: fit only the exposed basal edges to the drawn terrain. The bake
// stores centimetres of world-vertical drop at each root vertex, including tile seams.)
import * as THREE from '../../vendor/three-0.180.0/three.module.min.js';
import { LEAF, leafCell } from './tex.js';

const WIDTH = 1024;
const models = new Map(), variants = new WeakMap(), materials = new WeakMap();
let loading, depths;

const plantKey = (x, z) => Math.round(x * 100) + ',' + Math.round(z * 100);
export function readTreeFeet(buffer) {
  const data = new DataView(buffer), size = data.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
  const samples = [0], table = new Map();
  for (const [name, { offset, width, count, edges }] of Object.entries(header)) {
    let at = 4 + size + offset, deepest = 0;
    const plants = new Map();
    for (let i = 0; i < count; i++) {
      plants.set(data.getInt32(at, true) + ',' + data.getInt32(at + 4, true), samples.length);
      at += 8;
      for (let j = 0; j < width; j++, at += 2) {
        const drop = data.getUint16(at, true) / 100;
        samples.push(drop);
        deepest = Math.max(deepest, drop);
      }
    }
    table.set(name, { plants, edges, deepest, width });
  }
  const pixels = new Float32Array(WIDTH * Math.ceil(samples.length / WIDTH));
  pixels.set(samples);
  return { table, pixels };
}

export function loadTreeFeet() {
  return loading ??= fetch('/world/tree-feet.bin').then(async response => {
    if (!response.ok) throw Error('Tree feet ' + response.status);
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const { table, pixels } = readTreeFeet(await new Response(stream).arrayBuffer());
    depths = new THREE.DataTexture(pixels, WIDTH, pixels.length / WIDTH, THREE.RedFormat, THREE.FloatType);
    depths.needsUpdate = true;
    for (const [name, data] of table) models.set(name, data);
    return true;
  }).catch(error => { loading = null; console.warn(error); });
}

export const trunkProfile = name => models.get(name);
export const footRow = (profile, x, z) => profile.plants.get(plantKey(x, z)) ?? 0;

function skirtGeometry(source, profile) {
  if (variants.has(source)) return variants.get(source);
  // Copy the exact side corners, including their UV seams and normals. Each quad
  // has two copies of the rim, the lower pair displaced in the vertex shader.
  const g = new THREE.BufferGeometry(), n = source.attributes.position.count;
  const corners = [], indices = source.index ? Array.from(source.index.array) : Array.from({ length: n }, (_, i) => i);
  const foot = new Float32Array(2 * (n + 4 * profile.edges.length));
  for (const [a, b, ai, bi, rate] of profile.edges) {
    const k = n + corners.length;
    corners.push(a, b, a, b);
    indices.push(k + 1, k, k + 2, k + 1, k + 2, k + 3);
    foot.set([-1, 0, -1, 0, ai + 1, rate, bi + 1, rate], 2 * k);
  }
  for (const [name, attr] of Object.entries(source.attributes)) {
    const dim = attr.itemSize, values = new Float32Array((n + corners.length) * dim);
    for (let i = 0; i < n + corners.length; i++) {
      const from = i < n ? i : corners[i - n];
      for (let j = 0; j < dim; j++) values[i * dim + j] = attr.getComponent(from, j);
    }
    g.setAttribute(name, new THREE.BufferAttribute(values, dim));
  }
  g.setIndex(indices);
  g.setAttribute('jwFoot', new THREE.BufferAttribute(foot, 2));
  g.computeBoundingSphere(); g.computeBoundingBox();
  variants.set(source, g);
  return g;
}

// Use the normal material and shadow program for the original wood. A skirt has
// the side's V change per local metre. Only generated bark needs an atlas-cell wrap.
function skirtMaterial(source, atlas = false) {
  if (materials.has(source)) return materials.get(source);
  const m = source.clone(), key = source.customProgramCacheKey();
  m.customProgramCacheKey = () => key + (atlas ? '|atlas-skirt' : '|skirt');
  m.onBeforeCompile = (shader, renderer) => {
    source.onBeforeCompile.call(source, shader, renderer);
    shader.uniforms.jwDepths = { value: depths };
    const row = 'jwFootRow';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2D jwDepths;
        attribute vec2 jwFoot; attribute float jwFootRow;
        ${atlas ? 'varying float jwSkirt;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${atlas ? 'jwSkirt = float(jwFoot.x != 0.0);' : ''}
        if (jwFoot.x > 0.0 && ${row} > 0.0) {
          int slot = int(${row}) + int(jwFoot.x) - 1;
          float drop = texelFetch(jwDepths, ivec2(slot % ${WIDTH}, slot / ${WIDTH}), 0).r;
          transformed -= inverse(mat3(instanceMatrix)) * vec3(0., drop, 0.);
          #ifdef USE_MAP
          vMapUv.y += jwFoot.y * drop / length(instanceMatrix[1].xyz);
          #endif
        }`);
    if (atlas) {
      const [, lo, , hi] = leafCell(LEAF.bark);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float jwSkirt;')
        .replace('#include <map_fragment>', `vec2 jwBarkUv = vMapUv;
          if (jwSkirt > 0.5) {
            float v = mod((jwBarkUv.y - ${lo}) / ${hi-lo}, 2.0);
            jwBarkUv.y = ${lo} + (1.0 - abs(v - 1.0)) * ${hi-lo};
          }
          ${THREE.ShaderChunk.map_fragment.replaceAll('vMapUv', 'jwBarkUv')}`);
    }
  };
  materials.set(source, m);
  return m;
}

export function fitTrunkSkirts(mesh, source, profile, rows, atlas = false) {
  const template = skirtGeometry(source, profile), geo = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(template.attributes)) geo.setAttribute(name, attr);
  geo.setIndex(template.index);
  geo.boundingBox = template.boundingBox;
  geo.boundingSphere = template.boundingSphere;
  geo.setAttribute('jwFootRow', rows);
  mesh.geometry = geo;
  mesh.material = skirtMaterial(mesh.material, atlas);
  if (mesh.customDepthMaterial) mesh.customDepthMaterial = skirtMaterial(mesh.customDepthMaterial, atlas);
  // The original sphere already encloses most roots. Expand it only to include
  // the displaced corners of this batch, before any instance rows are reordered.
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), pos = source.attributes.position;
  const data = depths.image.data;
  for (let i = 0; i < mesh.count; i++) {
    const row = rows.getX(i);
    if (!row) continue;
    mesh.getMatrixAt(i, matrix);
    for (const [a, b, ai, bi] of profile.edges) {
      point.fromBufferAttribute(pos, a).applyMatrix4(matrix);
      point.y -= data[row + ai];
      mesh.boundingSphere.expandByPoint(point);
      point.fromBufferAttribute(pos, b).applyMatrix4(matrix);
      point.y -= data[row + bi];
      mesh.boundingSphere.expandByPoint(point);
    }
  }
  // Only the instance rows belong to this draw. The template buffers serve other cells.
  mesh.addEventListener('dispose', () => {
    for (const name of Object.keys(template.attributes)) geo.deleteAttribute(name);
    geo.setIndex(null);
    geo.dispose();
  });
}

// The buried disk becomes internal when its rim meets the ground all round.
// Retain the authored vertices and the atlas bake. Only the physical draw
// index omits the bottom caps of trunkG, the redwood flare and ground-born limbs.
export function omitBuriedCaps(geometry) {
  const caps = geometry.userData.footCaps;
  if (!caps || geometry.index) return;
  const indices = [];
  let start = 0;
  for (const [first, count] of caps) {
    for (let i = start; i < first; i++) indices.push(i);
    start = first + count;
  }
  for (let i = start; i < geometry.attributes.position.count; i++) indices.push(i);
  geometry.setIndex(indices);
}
