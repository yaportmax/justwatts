// A zero from an incomplete scanner is not a world-surface certificate.
export const defectClasses = ['doubleGround', 'backFace', 'hole', 'unsupportedPart', 'unsupportedCard', 'disconnectedRoad', 'railOffPaving'];
export function checkProof(manifest, observations, witnesses) {
  const errors = [], totals = Object.fromEntries(defectClasses.map(k => [k, 0]));
  if (!manifest?.sourceHash || !Array.isArray(manifest.eyes) || !manifest.eyes.length) return { ok: false, errors: ['Missing frozen source and rider positions'], totals };
  const expected = new Set();
  for (const p of manifest.eyes) for (const q of [0, 3]) expected.add(p.id + ':' + q);
  const seen = new Map();
  for (const row of observations) {
    const key = row.id + ':' + row.quality;
    if (!expected.has(key)) { errors.push('Unexpected observation ' + key); continue; }
    if (seen.has(key)) { errors.push('Duplicate observation ' + key); continue; }
    seen.set(key, row);
    if (row.sourceHash !== manifest.sourceHash) errors.push('Changed source at ' + key);
    if (row.settled !== true) errors.push('Unsettled scene at ' + key);
    if (!(row.rays?.count >= manifest.minimumRays && row.rays.recorded === row.rays.count && row.rays.far >= row.cameraFar && row.cameraFar > 0)) errors.push('Incomplete view-ray record at ' + key);
    if (!row.rays?.allSurfaces || !row.rays?.artifactHash) errors.push('Missing complete surface-hit artifact at ' + key);
    for (const k of defectClasses) {
      if (row.checked?.[k] !== true || !Number.isSafeInteger(row.counts?.[k]) || row.counts[k] < 0) errors.push('Unchecked ' + k + ' at ' + key);
      else totals[k] += row.counts[k];
    }
  }
  for (const key of expected) if (!seen.has(key)) errors.push('Missing rider observation ' + key);
  for (let shot = 3; shot <= 14; shot++) {
    const w = witnesses?.find(w => w.shot === shot);
    if (!w || w.beforeSourceHash !== manifest.beforeSourceHash || !w.beforeSourceHash || !w.poseMatched || !w.reviewedPair || !w.artifactHash || !defectClasses.includes(w.defect) || !(w.beforeCount > 0)) errors.push('Owner shot ' + shot + ' lacks a matched positive baseline witness');
  }
  for (const [k, n] of Object.entries(totals)) if (n) errors.push(k + ': ' + n);
  return { ok: errors.length === 0, expected: expected.size, observed: seen.size, errors, totals };
}
