import assert from 'node:assert/strict';
import { checkProof, defectClasses } from './proof.mjs';
const manifest = { sourceHash: 'candidate', beforeSourceHash: 'original', minimumRays: 36000, eyes: [{ id: 'east-1100-forward' }] };
const row = q => ({ id: manifest.eyes[0].id, quality: q, sourceHash: 'candidate', settled: true, cameraFar: 14000,
  rays: { count: 36000, recorded: 36000, far: 14000, allSurfaces: true, artifactHash: 'retained-hits' },
  checked: Object.fromEntries(defectClasses.map(k => [k, true])), counts: Object.fromEntries(defectClasses.map(k => [k, 0])) });
const witnesses = Array.from({ length: 12 }, (_, i) => ({ shot: i + 3, beforeSourceHash: 'original', poseMatched: true, reviewedPair: true, artifactHash: 'baseline-ray-and-pair', defect: 'doubleGround', beforeCount: 1 }));
assert.equal(checkProof(manifest, [row(0), row(3)], witnesses).ok, true);
for (const edit of [
  r => { r.sourceHash = 'stale'; }, r => { r.settled = false; },
  r => { r.rays.far = 48; }, r => { r.rays.recorded--; },
  r => { r.rays.allSurfaces = false; }, r => { delete r.rays.artifactHash; },
  ...defectClasses.map(k => r => { delete r.checked[k]; }),
  ...defectClasses.map(k => r => { r.counts[k] = 1; }),
]) { const a = row(0); edit(a); assert.equal(checkProof(manifest, [a, row(3)], witnesses).ok, false); }
assert.equal(checkProof(manifest, [row(0)], witnesses).ok, false);
assert.equal(checkProof(manifest, [row(0), row(3), row(3)], witnesses).ok, false);
for (let i = 0; i < 12; i++) assert.equal(checkProof(manifest, [row(0), row(3)], witnesses.filter((_, j) => i !== j)).ok, false);
const weak = structuredClone(witnesses); weak[0].beforeCount = 0;
assert.equal(checkProof(manifest, [row(0), row(3)], weak).ok, false);
console.log('Proof completeness: positive control and 35 incomplete/failed controls passed');
