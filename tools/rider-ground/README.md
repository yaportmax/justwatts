# Rider-eye ground investigation

This is experimental verification tooling, not a completed world certificate.

`rays.mjs` intersects both triangle sides, respects index draw ranges, and retains all intersections rather than only the nearest downward height. It has no production runtime cost. `test-rays.mjs` compares its hits with Three.js on a tilted, translated torus, including face identities and back faces.

`proof.mjs` rejects a nominal zero unless both quality levels cover every frozen rider position, the complete full-distance surface-hit artifacts are recorded, all seven defect classes were checked, and every owner screenshot has a reviewed, matched positive baseline witness. `test-proof.mjs` exercises missing qualities, truncated rays, changed sources, missing defect checks and absent positive controls.

Current private evidence is in `C:/Dev/justwatts-private/work/codex/cx-ground2/`. The station-1100 prototype records 36,000 rays to the camera's 14 km far plane and exposes scrub-shell, hand/hand and hand/tile overlaps. It omits instanced surfaces and does not yet implement complete hole, object-contact, flat-card, disconnected-road or network rail coverage checks. Its raw double-hit count includes same-surface folds. Therefore its zero would not satisfy `checkProof`, and no C1/C2 certificate has been produced.

Run the independent geometry and completeness controls with:

```
node tools/rider-ground/test-rays.mjs
node tools/rider-ground/test-proof.mjs
```
