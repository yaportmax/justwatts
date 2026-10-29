// Copies of the app's workout parser (app/js/core.js) and course check (app/js/course.js).
// The web build drops app/js/package.json, so core.js would load as untyped ESM in the function bundle;
// tests/js/accounts_parity.mjs proves these copies are identical to the app's source. Do not edit by hand:
// change core.js / course.js and re-copy.
'use strict';

const STEP_M = 10, MIN_M = 100, MAX_M = 500000;
function parseDur(str) {
  let t = 0; const re = /(\d+(?:\.\d+)?)\s*(h|min|m|sec|s)/g; let m;
  while ((m = re.exec(str))) t += +m[1] * (m[2] === 'h' ? 3600 : m[2][0] === 'm' ? 60 : 1);
  return Math.round(t);
}
function parseTree(src) {
  const s = src.toLowerCase(); let i = 0;
  const DUR = '((?:\\d+(?:\\.\\d+)?\\s*(?:h|min|m|sec|s)(?![a-z])\\s*)+)';  // unit may be followed by digits: 1m30s
  const reRep = /^(\d+)\s*x\s*\(/, reFree = new RegExp('^' + DUR + '\\s*@?\\s*free'),
    reStep = new RegExp('^' + DUR + '\\s*@?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:-\\s*(\\d+(?:\\.\\d+)?))?\\s*(%|w)?');
  const ws = () => { while (i < s.length && /[\s,;]/.test(s[i])) i++; };
  function list(end) {
    const out = [];
    for (;;) { ws(); if (i >= s.length || s[i] === end || s[i] === ')') break; out.push(item()); }
    return out;
  }
  function item() {
    const rest = s.slice(i); let m;
    if ((m = reRep.exec(rest))) {
      i += m[0].length; const items = list(')');
      if (s[i] !== ')') throw new Error('Missing )');
      i++; return { n: +m[1], items };
    }
    if ((m = reFree.exec(rest))) { i += m[0].length; return { d: parseDur(m[1]), free: true }; }
    if ((m = reStep.exec(rest))) {
      i += m[0].length; const u = m[4] || '%';
      let a = +m[2], b = m[3] != null ? +m[3] : a;
      if (u === '%') { a /= 100; b /= 100; }
      const d = parseDur(m[1]);
      if (!d) throw new Error(`Zero duration near "${rest.slice(0, 14)}"`);
      return { d, a, b, u };
    }
    throw new Error(`Can't read "${rest.slice(0, 16).trim()}"`);
  }
  const tree = list(null);
  if (i < s.length) throw new Error('Unexpected )');
  return tree;
}
function flattenTree(tree) {
  const out = [];
  for (const x of tree) {
    if (x.items) { const inner = flattenTree(x.items); for (let k = 0; k < x.n; k++) out.push(...inner.map(y => ({ ...y }))); }
    else out.push({ ...x });
  }
  return out;
}
function gainOf(ele) { let g = 0; for (let i = 1; i < ele.length; i++) if (ele[i] > ele[i - 1]) g += ele[i] - ele[i - 1]; return Math.floor(g + 0.5); }
function checkCourse(c) {
  if (!c || typeof c !== 'object') throw new Error('course must be an object');
  const ele = c.ele, dist = typeof c.dist === 'number' ? c.dist : NaN;
  if (!Array.isArray(ele) || ele.length < 2 || ele.length > MAX_M / STEP_M + 2 || !ele.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10000)) throw new Error('course.ele must be 2.. numbers');
  if (!(dist >= MIN_M && dist <= MAX_M)) throw new Error('course.dist out of range');
  return { name: String(c.name || 'Course').slice(0, 80), dist, gain: gainOf(ele), ele: ele.slice(), ll: (Array.isArray(c.ll) ? c.ll : []).filter(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'number' && Number.isFinite(x))).slice(0, 500) };
}

module.exports = { STEP_M, MIN_M, MAX_M, parseDur, parseTree, flattenTree, gainOf, checkCourse };
