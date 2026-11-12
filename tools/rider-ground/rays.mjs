// Exact two-sided triangle intersections. The caller retains material-side metadata.
// A54 cx-ground2: downward samples miss the exposed undersides in owner shots 9, 13, 14.
export function buildTree(position, index, start = 0, count = Infinity) {
  const end = Math.min(index?.length ?? position.length / 3, start + count);
  const ids = [], bounds = [], centers = [];
  for (let k = start; k + 2 < end; k += 3) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let j = 0; j < 3; j++) {
      const v = 3 * (index ? index[k + j] : k + j);
      for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], position[v + a]); b[a + 3] = Math.max(b[a + 3], position[v + a]); }
    }
    ids.push(k); bounds[k / 3] = b; centers[k / 3] = b.slice(0, 3).map((v, a) => (v + b[a + 3]) / 2);
  }
  function node(lo, hi) {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) for (let a = 0; a < 3; a++) { const b = bounds[ids[i] / 3]; box[a] = Math.min(box[a], b[a]); box[a + 3] = Math.max(box[a + 3], b[a + 3]); }
    if (hi - lo <= 12) return {box, lo, hi};
    const spans = box.slice(0, 3).map((v, a) => box[a + 3] - v), axis = spans.indexOf(Math.max(...spans));
    const sorted = ids.slice(lo, hi).sort((a, b) => centers[a / 3][axis] - centers[b / 3][axis]);
    for (let i = lo; i < hi; i++) ids[i] = sorted[i - lo];
    const mid = (lo + hi) >> 1;
    return {box, left: node(lo, mid), right: node(mid, hi)};
  }
  return {position, index, ids, root: ids.length ? node(0, ids.length) : null};
}

export function intersectTree(tree, origin, direction, far = Infinity) {
  if (!direction || direction.length !== 3 || !Array.from(direction).every(Number.isFinite)) throw new TypeError('Ray direction requires three finite components');
  const hits = [], {position: p, index: ix, ids} = tree;
  function boxHit(b) {
    let lo = 0, hi = far;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(direction[a]) < 1e-14) { if (origin[a] < b[a] || origin[a] > b[a + 3]) return false; continue; }
      let u = (b[a] - origin[a]) / direction[a], v = (b[a + 3] - origin[a]) / direction[a];
      if (u > v) [u, v] = [v, u]; lo = Math.max(lo, u); hi = Math.min(hi, v); if (hi < lo) return false;
    }
    return true;
  }
  const vertex = k => { const v = 3 * (ix ? ix[k] : k); return [p[v], p[v + 1], p[v + 2]]; };
  function visit(n) {
    if (!n || !boxHit(n.box)) return;
    if (n.left) { visit(n.left); visit(n.right); return; }
    for (let i = n.lo; i < n.hi; i++) {
      const k = ids[i], a = vertex(k), b = vertex(k + 1), c = vertex(k + 2);
      const e = b.map((v, j) => v - a[j]), f = c.map((v, j) => v - a[j]);
      const h = [direction[1] * f[2] - direction[2] * f[1], direction[2] * f[0] - direction[0] * f[2], direction[0] * f[1] - direction[1] * f[0]];
      const det = e[0] * h[0] + e[1] * h[1] + e[2] * h[2]; if (Math.abs(det) < 1e-12) continue;
      const s = origin.map((v, j) => v - a[j]), u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < -1e-8 || u > 1 + 1e-8) continue;
      const q = [s[1] * e[2] - s[2] * e[1], s[2] * e[0] - s[0] * e[2], s[0] * e[1] - s[1] * e[0]], v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
      if (v < -1e-8 || u + v > 1 + 1e-8) continue;
      const t = (f[0] * q[0] + f[1] * q[1] + f[2] * q[2]) / det;
      if (t > 1e-6 && t <= far) hits.push({t, triangle: k / 3, back: det < 0});
    }
  }
  visit(tree.root); return hits.sort((a, b) => a.t - b.t);
}

export function buildBoundsTree(boxes) {
  function build(ids) {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const i of ids) for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], boxes[i][a]); box[a + 3] = Math.max(box[a + 3], boxes[i][a + 3]); }
    if (ids.length <= 4) return {box, ids};
    const spans = box.slice(0, 3).map((v, a) => box[a + 3] - v), axis = spans.indexOf(Math.max(...spans));
    ids.sort((a, b) => boxes[a][axis] + boxes[a][axis + 3] - boxes[b][axis] - boxes[b][axis + 3]);
    const mid = ids.length >> 1; return {box, left: build(ids.slice(0, mid)), right: build(ids.slice(mid))};
  }
  return {root: boxes.length ? build(boxes.map((_, i) => i)) : null, boxes};
}

export function intersectBounds(tree, origin, direction, far = Infinity) {
  if (!direction || direction.length !== 3 || !Array.from(direction).every(Number.isFinite)) throw new TypeError('Ray direction requires three finite components');
  const out = [];
  const intersects = b => {
    let lo = 0, hi = far;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(direction[a]) < 1e-14) { if (origin[a] < b[a] || origin[a] > b[a + 3]) return false; continue; }
      let u = (b[a] - origin[a]) / direction[a], v = (b[a + 3] - origin[a]) / direction[a];
      if (u > v) [u, v] = [v, u]; lo = Math.max(lo, u); hi = Math.min(hi, v); if (lo > hi) return false;
    }
    return true;
  };
  const visit = n => {
    if (!n || !intersects(n.box)) return;
    if (n.ids) { for (const i of n.ids) if (intersects(tree.boxes[i])) out.push(i); }
    else { visit(n.left); visit(n.right); }
  };
  visit(tree.root); return out;
}
