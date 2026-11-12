import assert from 'node:assert/strict';
import * as THREE from '../../app/vendor/three-0.180.0/three.module.min.js';
import {buildTree, intersectTree, buildBoundsTree, intersectBounds} from './rays.mjs';
// Independent Three.js intersections, both directions, over a tilted indexed surface.
const g = new THREE.TorusGeometry(8, 2, 9, 30);
g.rotateX(0.39); g.translate(7, 4, -6);
g.setDrawRange(9, g.index.count - 30);
const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({side: THREE.DoubleSide}));
mesh.updateMatrixWorld();
const tree = buildTree(g.attributes.position.array, g.index.array, g.drawRange.start, g.drawRange.count);
let checks = 0, intersections = 0;
for (let i = 0; i < 1200; i++) {
  const a = i * 2.399963, origin = new THREE.Vector3(7 + 13 * Math.cos(a), 4 + 6 * Math.sin(i * .21), -6 + 13 * Math.sin(a));
  const direction = new THREE.Vector3(7 + 4 * Math.sin(i * .17), 4, -6).sub(origin).normalize();
  const expected = new THREE.Raycaster(origin, direction, 0, 100).intersectObject(mesh);
  const actual = intersectTree(tree, origin.toArray(), direction.toArray(), 100);
  assert.equal(actual.length, expected.length);
  for (const hit of actual) {
    const ref = expected.find(h => h.faceIndex === hit.triangle);
    assert.ok(ref, 'same triangle, allowing equal-distance shared-edge ordering');
    assert.ok(Math.abs(hit.t - ref.distance) < 1e-6);
    assert.equal(hit.back, ref.face.normal.dot(direction) > 0);
  }
  checks++; intersections += actual.length;
}
assert.equal(intersectTree(buildTree(new Float32Array()), [0,0,0], [0,1,0]).length, 0);
const boxes = Array.from({length: 70}, (_, i) => {
  const x = Math.sin(i * 1.73) * 20, y = Math.cos(i * .91) * 8, z = Math.cos(i * 2.12) * 20;
  return [x, y, z, x + 2, y + 3, z + 4];
});
const bounds = buildBoundsTree(boxes);
for (let i = 0; i < 400; i++) {
  const origin = new THREE.Vector3(Math.sin(i) * 24, Math.cos(i * .6) * 12, Math.cos(i) * 24);
  const direction = new THREE.Vector3(-origin.x, Math.sin(i * .3), -origin.z).normalize(), ray = new THREE.Ray(origin, direction), point = new THREE.Vector3(), far = 5 + i % 50;
  const expected = boxes.flatMap((b, id) => {
    const box = new THREE.Box3(new THREE.Vector3(...b.slice(0, 3)), new THREE.Vector3(...b.slice(3)));
    const hit = ray.intersectBox(box, point);
    return box.containsPoint(origin) || hit && hit.distanceTo(origin) <= far ? [id] : [];
  });
  assert.deepEqual(intersectBounds(bounds, origin.toArray(), direction.toArray(), far).sort((a,b)=>a-b), expected);
}
assert.throws(() => intersectTree(tree, [0,0,0], undefined), TypeError);
console.log(JSON.stringify({checks,intersections,boundsChecks:400,empty:true}));
