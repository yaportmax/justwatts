# Drawn-ground placement

Hand vegetation uses one fixed exported root height for all LODs. Seat against the completed runtime triangles, after terrain carving, hand-ground pressing, road pushes, and bank construction. Raw lidar tiles are not the drawn support.

`support.js` measures the actual scene, including hand surfaces and `gv` banks. It respects visibility, face side, draw ranges, material groups, and generated fallback floors. Its samples are checked against Three.js ray intersections. `seat_drawn.mjs` uses the valid support range from both quality levels. It prefers 15 cm embed below the lowest support, allowing a shallower fixed root when necessary to keep every measured visit within 2 cm minimum embed and 35 cm maximum burial (0.1 mm float32 tolerance). It lowers only roots more than 10 cm above the lowest support. Lowerings over 1 m require observations within 70 m at both qualities.

After investigating a support discrepancy, `--omit-unstable` can omit placements that cannot meet that fixed-root burial bound at every measured visit. The same geometric test applies to every placement; there are no coordinate or species exceptions. Omitted records and their support ranges are retained in the bake report. Without the flag, the bake refuses those placements instead of changing files.

`keep_drawn.mjs` uses the final visible paving triangles, including junction flares and width tapers. Tree roots require 60 cm clearance; other physical plants require 30 cm. Buried roads and tunnel floors do not create a surface keepout. Flat textured decals are preserved.

Neither operation changes a plant's position per frame. Neither subtracts its previous raw-tile planting depth, so repeated bakes do not accumulate burial.

## Measurements and write contract

Start a new evidence folder with `node tools/hand-ground/init-evidence.mjs --app=<absolute app path> --samples=<folder>`. It freezes the source files, placements and all route stops before any measurement, and refuses to overwrite an existing inventory.

Start `node tools/hand-ground/serve.mjs <absolute app path>` hidden at low priority. This harness provides `hop`. Use an existing Playwright installation through `JW_PLAYWRIGHT_MODULE` if it is not locally resolvable. Do not install or download anything for this workflow.

`scan.mjs <port> --file=<network-lines.json or mv-lines.json> --w3=noGov --q=0 --skip=0 --max=512 --seconds=340 --out=<file.jsonl>` records exact triangles and hand-root support. Repeat at `--q=3`, continuing with the actual completed stop count. A scan stops starting new locations after the seconds limit and bounds settlement by the turn deadline. Use the shared GPU queue for every browser job and release it afterward. Keep all original raw scans.

Name the files `before_network_q0_<skip>.jsonl`, `before_mv_q0_<skip>.jsonl`, and their q3 equivalents. Run `consolidate.mjs before --samples=<folder>` to write the canonical results and retry manifests. Scan every retry manifest into additional `before_retry_*_qQ_<skip>.jsonl` files and consolidate again. It marks the baseline complete only when all four route sets have settled results.

Run `coverage.mjs --app=<app> --samples=<folder>` to find unmeasured roots and paving, plus closer checks for large lowerings. It produces `coverage_lines_q0.json` and `coverage_lines_q3.json`. Scan those into `before_support_*_qQ_<skip>.jsonl`; repeat coverage until every missing count is zero. These probes supplement the route proof. They never replace it.

Each write requires a complete, settled baseline for all four network/quality combinations, complete support and paving coverage for active hand plants, closer observations for large lowerings, and matching geometry and placement stamps. The sample folder holds `before.done`, `before_proof.json`, `coverage.json`, `support_inputs.json`, and `placement_inputs.json`, plus the original `before_*_q[03]_<skip>.jsonl` samples. An unsettled row cannot supply support. The tools produce a plan by default:

```
node tools/hand-ground/seat_drawn.mjs --app=<absolute app path> --samples=<evidence folder>
node tools/hand-ground/keep_drawn.mjs --app=<absolute app path> --samples=<evidence folder>
```

Review the plan and resolve every rejected or uncovered placement before adding `--write`. The write guard rejects stale sources and missing proof. Receipts allow an identical bake to be repeated without lowering roots again.

## Physical-object audit

The raw historical scanner uses instance origins and terrain support for every object. That misclassifies center-origin bridge members attached to slabs and walls, and zero-height shadow decals on paving. `--audit=attachments,effects` applies two measured corrections and records every excluded raw row:

- An assembly member must have actual base contact with opaque static geometry in its parent assembly. Hidden, transparent, alpha-cut, and shader-cut members cannot certify support. A base contacting paving, including a base just below it, remains an obstruction.
- A horizontal textured cutout with no vertical extent cannot obstruct paving. It still fails the float check if unsupported.

These rules do not exempt a species, a location, or an entire bridge. Preserve raw counts alongside corrected counts. Secondary metrics retain their original definitions.

For a new proof, use the same explicit `--audit=attachments,effects` mode before and after. Every removed raw report remains in `auditExclusions`. Existing original raw baselines require a separately documented correction using their recorded runtime support evidence; do not silently treat their counters as corrected.

## Regression gate

`hand_ground_guard.mjs` verifies the complete recorded proof against all world geometry, placement files, Three.js inputs, and transitive JavaScript dependencies. The Python suite runs this gate and focused sampler/bake tests.

After changing a geometry input or regenerating plant data, repeat affected-stop checks and the full q0/q3 network proof, compare hover/sunk/seam/buried/zfight with the retained baseline, and run both offline keepout gates. Refresh the proof from those results. Updating hashes alone does not establish a valid proof.

Freeze final world files with `certify-proof.mjs --start --app=<app> --samples=<folder>` before starting the after-scans. Keep their cold-start batches and approach order consistent with the baseline. Consolidate them with `consolidate.mjs after --samples=<folder>` and compare with `compare-proof.mjs --samples=<folder> --before=before_canonical` when the baseline already used the physical audit. The comparison runs the included copy of the lead's `cmp.py`, then independently rejects missing/unsettled stops, any critical count, or even one added protected-secondary cell.

Retain the generated and hand keepout logs as `keepout_after.log` and `handkeep_after.log`, with their actual integer exit codes in matching `.exit` files. Run `certify-proof.mjs --app=<app> --samples=<folder>` after those gates. It refuses changed world files and failed or incomplete comparisons. Only the verified `hand-ground-proof.json` goes into `tests/fixtures/hand-ground-proof.json`; keep its underlying scans and logs with the evidence record.

The initial certificate retains one separately documented q3 baseline recapture at Almonte Boulevard station 560000. The scanner excludes generated billboard trees; the existing 60 m full-model update interval made one unchanged oak appear only in the final original-route count. Paired original/current runtime controls measured exactly identical roots, bank surfaces and all protected counts at matching LOD states, including the same pre-existing 1.61 m sunk report. The original comparison remains in the evidence. A complete f307 full-model observation replaces only that baseline row in separately named `before_comparable` files; no final count is removed or metric waived.

When a measured recapture is necessary, retain its original comparison, complete paired observations and source verification in `comparison_recaptures.json`. Certification verifies the recorded hashes of the original comparison, controls and original/matched baseline files and includes that provenance in the certificate. A recapture is evidence of an equivalent measured state, not permission to edit counters or refresh a certificate without new proof.
