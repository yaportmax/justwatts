// Workout from plain words, e.g. "20 min easy, 3 sets of 6x45s hard / 30s easy, 5 min easy between sets,
// easy to 60 min". Rules only: runs in the page, no model, no network. Returns a tree (see core.js parseTree).
// norm (text) -> lex (tokens) -> clauses (split at , ; . newlines "then", outside brackets) -> each clause is a
// total, set header, "repeat", fill, warm-up/cool-down or steps -> folded into the tree (a rest-looking step right
// after a repeat joins it). Ambiguous wording takes the most common reading; tests/words_cases.json lists them.

const HARD = d => d <= 60 ? 1.2 : d <= 300 ? 1.1 : 1.0;
const ALLOUT = d => d <= 60 ? 1.5 : d <= 120 ? 1.3 : d <= 300 ? 1.2 : d <= 1200 ? 1.05 : 1.0;  // "20 min all out" is a test, not a sprint
// effort words, most specific first -> fraction of FTP (d = step seconds: short "hard" efforts are harder)
const EFFORT = [
  [/\bover[\s-]?unders?\b|\bunder[\s-]?overs?\b|\b(?:above|over|supra)[\s-]?(?:threshold|ftp)\b/, () => 1.05],
  [/\b(?:sub|below|under)[\s-]?(?:threshold|ftp)\b/, () => 0.95],
  [/\ball[\s-]?out\b|\bsprints?\b|\bmax(?:imal|imum)?\b|\bflat[\s-]?out\b|\bfull[\s-]?gas\b|\bneuromuscular\b|\bas hard as\b/, ALLOUT],
  [/\banaerobic\b/, () => 1.3],
  [/\bvo2\b/, () => 1.18],
  [/\bthresh\w*|\btreshold\b|\bftp\b|\btt\b|\btime trial\b/, () => 1.0],
  [/\bsweet[\s-]?spot\b|\bsweetspot\b|\bsst?\b/, () => 0.9],
  [/\btempo\b/, () => 0.8],
  [/\bunders?\b/, () => 0.95],
  [/\bovers?\b/, () => 1.05],
  [/\bendur[ae]nce\b|\bsteady\b|\bmoderate\b|\baerobic\b|\bbase\b|\bconversational\b/, () => 0.65],
  [/\bhigh[\s-]?cadence\b|\bspin[\s-]?ups?\b|\bfast[\s-]?pedal\w*|\bcadence\b|\bdrills?\b/, () => 0.65],  // cadence drills: spin fast, not hard
  [/\brecover\w*|\brest\b|\boff\b|\bri\b|\brec\b|\bvery easy\b/, () => 0.5],
  [/\beasy\b|\bspin\w*|\blight\b|\bsoft\b|\bchill\b|\brelax\w*|\bgentle\b|\bcruis\w*/, () => 0.55],
  [/\bhard\w*|\bon\b|\bwork\b|\befforts?\b|\bfast\b|\bstrong\b|\binterval\w*|\bpush\w*/, HARD],
];
const ZONE = [0.5, 0.65, 0.8, 1.0, 1.18, 1.3, 1.5];                       // Z1..Z7, same values as the words
const RPE = [0.45, 0.45, 0.5, 0.55, 0.65, 0.75, 0.8, 0.9, 1.0, 1.18, 1.5];  // RPE 0..10
const FREE = /\bfree\w*|\bunstructured\b|\bas you (?:like|want|feel)\b|\bown pace\b|\bwhatever\b/;
const FILLW = /\b(?:remaining|remainder|rest of|the rest|fill\w*|what'?s left|left ?over)\b/;
// words that describe a step: written before the length they start a piece ("Z2 1h", "threshold 20 min")
const DESC = /^(?:free\w*|all|flat|full|sprints?|max\w*|anaerobic|vo2|thresh\w*|treshold|ftp|tt|sweet\w*|spot|sst?|tempo|over\w*|under\w*|endur[ae]nce|steady|moderate|aerobic|base|recover\w*|rest|off|ri|rec|easy|spin\w*|light|soft|chill|relax\w*|gentle|cruis\w*|hard\w*|on|work|efforts?|fast|strong|push\w*|ramp\w*|build\w*|progress\w*|increas\w*|from)$/;
const RAMPW = /^(?:ramp\w*|build\w*|progress\w*|increas\w*|rising|gradual\w*)$/, DOWNW = /^(?:down|decreas\w*|descend\w*)$/;
const COUNTW = /^(?:sets?|rounds?|reps?|repeats?|repetitions?|blocks?|cycles?|lots)$/;
const LABEL = /^(?:set|block|part|step|round|interval|rep|day|week|phase|section|workout|session)$/;
const SEGW = new Set(['with', 'and', 'plus']);  // piece breaks inside a clause
const MAX_D = 12 * 3600;

const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function norm(t) {
  return ('\n' + t.toLowerCase() + '\n').replace(/\r\n?/g, '\n')
    .replace(/[\u00d7\u2715\u2716\u2a2f]/g, 'x').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"').replace(/\u2082/g, '2').replace(/\u00bd/g, '.5')
    .replace(/(^|\n)[ \t]*(?:[-*>\u2022\u25cf\u25aa\u25e6\u2023\u2043]+|\d{1,2}[.)](?!\d))[ \t]*/g, '$1\x01 ')  // bullets, "1." lists
    .replace(/[^\x00-\x7f]/g, ' ')  // emoji and other symbols
    .replace(/\bb\/w\b/g, ' between ').replace(/\bw\/u\b|\bwarm(?:ing)?[\s-]*ups?\b/g, ' wu ').replace(/\bc\/d\b|\b(?:cool(?:ing)?|warm|spin|wind)[\s-]*downs?\b/g, ' cd ')
    .replace(/\/\s*(?=(?:wu|cd|ms)\b|main\s+set\b)/g, ' , ')  // "WU 20' / MS 3x15' / CD 10'"
    .replace(/\b(?:an?|one)\s+hour\s+and\s+a\s+half\b|\bhour\s+and\s+a\s+half\b/g, '90 min')
    .replace(/\b(last|final|first)\s+hour\b/g, '$1 1 hour').replace(/\b(?:a\s+)?half\s+(?:an\s+)?hour\b/g, '30 min').replace(/\b(?:a\s+)?quarter\s+(?:of\s+an\s+)?hour\b/g, '15 min')
    .replace(/\ban?\s+(hour|hr|minute|min|second|sec)\b/g, '1 $1').replace(/\btwice\b/g, '2x').replace(/\ba\s+couple\s+(?:of\s+)?/g, '2 ')
    .replace(/\b(twenty|thirty|fou?rty|fifty|sixty|seventy|eighty|ninety)(?:[\s-]+(one|two|three|four|five|six|seven|eight|nine))?\b/g,
      (_, a, b) => TENS[a] + (b ? ONES.indexOf(b) : 0))
    .replace(new RegExp(`\\b(${ONES.slice(1).join('|')})\\b`, 'g'), w => ONES.indexOf(w))
    .replace(/(\d+)\s+and\s+a\s+half\s+(hours?|hrs?|minutes?|mins?)\b/g, (_, n, u) => `${+n + 0.5} ${u}`)
    .replace(/(\d+)\s*(?:-|to|or)\s*(\d+)\s*(?=(?:x|by|sets?|reps?|rounds?)(?![a-z]))/g, (m, a, b) => +a < +b ? a + ' ' : m)  // "3-4 x": the lower
    .replace(/\bover\s+(?=\d|the\b|an?\b)/g, ' ')  // "ramp over 10 min"
    .replace(/(\d|\))\s*\*\s*(?=\d)/g, '$1x').replace(/\*/g, ' ').replace(/(\d)\s*\+/g, '$1 ').replace(/[+&]/g, ' and ')
    .replace(/\b(?:my\s+ftp|ftp\s*(?:is|of|=|:))\s*(?:is\s*)?(?:\d+\s*(?:w|watts?)?)?/g, ' ')  // "my FTP is 250": not a step
    .replace(/\b(?:tss|np|kj|if)\s*[:=~]*\s*\d*(?:\.\d+)?\b/g, ' ')
    .replace(/(?:@|\bat\b)?\s*\d+(?:\s*-\s*\d+)?\s*(?:rpm|bpm)\b\s*,?/g, ' ').replace(/\bcadence\s*(?:of|at|:|~|>|<)?\s*\d+(?:\s*-\s*\d+)?/g, ' ')
    .replace(/(?<![\d.]\s*)\bhr\s*(?:<|>|of|:|at|under|below)?\s*\d+(?:\s*-\s*\d+)?/g, ' ')
    .replace(/\b(?:and\s+)?(?:then|followed\s+by|after\s+that|afterwards?|finally|next|(?:and\s+)?finish(?:ing)?\s+with|end(?:ing)?\s+with)\b/g, ' , ');
}

/* ---------- tokens ---------- */
const H = 'hours?|hrs?|h', M = "minutes?|minuts?|mintues?|mins?|min|mn|m|'", S = 'seconds?|secs?|sec|s|"';
const unitOf = u => /^h/.test(u) ? 'h' : /^(?:s|"|'')/.test(u) ? 's' : 'm', SEC = { h: 3600, m: 60, s: 1 };
const D = (d, u, n) => ({ t: 'dur', d: Math.round(d), u, n });
const LEX = [
  [/\x01/y, () => ({ t: 'bullet' })],
  [/\n/y, () => ({ t: 'sep', nl: true })],
  [/[ \t]+/y, null],
  [/(\d+):(\d\d):(\d\d)(?!\d)/y, m => D(m[1] * 3600 + m[2] * 60 + +m[3], 'h', +m[1])],
  [RegExp(`(\\d+):([0-5]\\d)(?![\\d:])(?:\\s*(${H})(?![a-z]))?(?:\\s*(?:${M})(?![a-z]))?`, 'y'),
    m => m[3] ? D(m[1] * 3600 + m[2] * 60, 'h', +m[1]) : D(m[1] * 60 + +m[2], 'm', +m[1])],
  [RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${H})\\s*(\\d\\d?)\\s*(?:${M})(?![a-z])|(\\d+)\\s*(?:hrs?|h)\\s?(\\d\\d)(?![\\d.:%a-z])`, 'y'),
    m => D((m[1] ?? m[3]) * 3600 + (m[2] ?? m[4]) * 60, 'h', +(m[1] ?? m[3]))],
  [RegExp(`(\\d+)\\s*(?:${M})\\s*(\\d\\d?)\\s*(?:''|${S})(?![a-z])|(\\d+)(?:min|m|')([0-5]\\d)(?![\\d.:%a-z'"])`, 'y'),
    m => D((m[1] ?? m[3]) * 60 + +(m[2] ?? m[4]), 'm', +(m[1] ?? m[3]))],
  [RegExp(`(\\d+(?:\\.\\d+)?)\\s*-?\\s*(${H}|''|${M}|${S})(?![a-z])`, 'y'), m => D(m[1] * SEC[unitOf(m[2])], unitOf(m[2]), +m[1])],
  [/(\d+(?:\.\d+)?)\s*(%|percent\b|pct\b|watts?\b|w(?![a-z/])|kms?\b|k(?![a-z])|miles?\b|mi\b)/y, m =>
    /^[%p]/.test(m[2]) ? { t: 'pct', a: m[1] / 100, b: m[1] / 100 } : m[2][0] === 'w' ? { t: 'watt', a: +m[1], b: +m[1] } : { t: 'dist' }],
  [/rpe\s*:?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|to)\s*(\d+(?:\.\d+)?))?(?:\s*\/\s*10\b)?/y, m => ({ t: 'rpe', v: (+m[1] + +(m[2] ?? m[1])) / 2 })],
  [/(?:zones?|z)\s*([1-7])(?!\d|\.\d)(?:\s*(?:-|to)\s*(?:zones?|z)?\s*([1-7])(?!\d|\.\d|['"%]|\s*(?:min|mn|m\b|sec|s\b|h\b|hr|hour|x\b|w\b)))?/y,
    m => ({ t: 'zone', a: +m[1], b: +(m[2] ?? m[1]) })],
  [/v[o0]2(?:\s*max)?(?![a-z])/y, () => ({ t: 'word', v: 'vo2' })],
  [/w\//y, () => ({ t: 'word', v: 'with' })],
  [/x(?![a-z])/y, () => ({ t: 'x' })],
  [/\d+(?:\.\d+)?/y, m => ({ t: 'num', v: +m[0] })],
  [/[a-z]+(?:'[a-z]+)?/y, m => ({ t: 'word', v: m[0] })],
  [/[(\[{]/y, () => ({ t: 'open' })], [/[)\]}]/y, () => ({ t: 'close' })],
  [/[,;!?]|\.(?!\d)/y, () => ({ t: 'sep' })], [/\//y, () => ({ t: 'slash' })], [/-/y, () => ({ t: 'dash' })],
  [/:/y, () => ({ t: 'colon' })], [/@/y, () => ({ t: 'word', v: 'at' })],
  [/[^]/y, null],
];
function lex(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    for (const [re, f] of LEX) {
      re.lastIndex = i; const m = re.exec(s);
      if (!m || !m[0].length) continue;
      const t = f && f(m); if (t) { t.i = i; t.e = i + m[0].length; out.push(t); }
      i += m[0].length; break;
    }
  }
  return out;
}
const isD = t => t?.t === 'dur' || t?.t === 'num';
const isX = t => /^(?:pct|watt|zone|rpe)$/.test(t?.t) || (t?.t === 'word' && DESC.test(t.v));
const int = t => t?.t === 'num' && Number.isInteger(t.v) && t.v >= 1;
const effort = ws => EFFORT.find(([re]) => re.test(ws))?.[1] ?? null;

// clause list: split at separators outside brackets; "WU:" / "Main set:" / "60 min:" labels resolved at the colon
function clauses(T) {
  const out = []; let c = null, depth = 0, nls = 0;
  for (const t of T) {
    if (depth === 0 && t.t === 'sep') { if (c) out.push(c); c = null; if (t.nl) nls++; continue; }
    if (!c) { c = { toks: [], nl: nls > 0, blank: nls > 1, bullet: false }; nls = 0; }
    if (t.t === 'bullet') { if (!c.toks.length) c.bullet = true; continue; }
    if (t.t === 'open') depth++; else if (t.t === 'close' && depth > 0) depth--;
    c.toks.push(t);
  }
  if (c) out.push(c);
  return out.flatMap(colon);
}
function colon(c) {
  let depth = 0;
  const k = c.toks.findIndex(t => (depth += t.t === 'open' ? 1 : t.t === 'close' ? -1 : 0) === 0 && t.t === 'colon');
  if (k < 0) return [c];
  const L = c.toks.slice(0, k), R = c.toks.slice(k + 1), merged = { ...c, toks: [...L, ...R] };
  const content = X => X.some(t => /^(?:dur|num|x)$/.test(t.t)), lw = ' ' + L.filter(t => t.t === 'word').map(t => t.v).join(' ') + ' ';
  if (!content(L) && !R.length && /\b(?:wu|cd)\b/.test(lw)) return [{ ...c, toks: L, heading: /\bwu\b/.test(lw) ? 'wu' : 'cd' }];  // "Warm up:" over its lines
  if (!content(L)) {  // a label: keep it when it says something ("WU:", "Zone 2:", "Total:"), drop "Main set:"
    const say = /\b(?:wu|cd|total|duration)\b/.test(lw) || L.some(t => /^(?:pct|watt|zone|rpe)$/.test(t.t)) || EFFORT.slice(0, -1).some(([re]) => re.test(lw));
    return colon(say ? merged : { ...c, toks: R });
  }
  const durOnly = L.filter(t => t.t === 'dur').length === 1 && !L.some(t => /^(?:num|x|pct|watt|zone)$/.test(t.t)) && !/\b(?:wu|cd)\b/.test(lw);
  if (!R.length && durOnly) return [{ ...c, toks: [...L, { t: 'word', v: 'total' }] }];  // "Today's ride (75 min):" over its lines
  if (!content(R)) return colon(merged);  // "10 min: easy"
  if (durOnly) {
    L.push({ t: 'word', v: 'total' });    // "60 min:" / "1 hour ride:" heads the workout
  }
  return [{ ...c, toks: L, hdr: true }, ...colon({ ...c, toks: R, nl: false, bullet: false, blank: false })];
}

// brackets -> {t:'grp'}; "(x3)" is just a count
function groups(T) {
  const st = [[]];
  for (const t of T) {
    if (t.t === 'open') st.push([]);
    else if (t.t === 'close') { if (st.length > 1) { const g = st.pop(); st[st.length - 1].push({ t: 'grp', toks: g }); } }
    else st[st.length - 1].push(t);
  }
  while (st.length > 1) { const g = st.pop(); st[st.length - 1].push({ t: 'grp', toks: g }); }
  return st[0].flatMap(t => t.t === 'grp' && t.toks.length && tailAt(t.toks, 0)?.len === t.toks.length ? t.toks : [t]);
}

// "3 sets of", "6 x", "4 by", "2 rounds of" at T[i] -> tokens used (0: none)
function countAt(T, i) {
  const t = T[i], n = T[i + 1], n2 = T[i + 2];
  if (!int(t) || t.v > 200 || !n) return 0;
  let k = 0;
  if (n.t === 'x' || (n.t === 'word' && COUNTW.test(n.v))) k = 2;
  else if (n.t === 'word' && n.v === 'by' && /^(?:num|dur|grp|open)$/.test(n2?.t)) k = 2;
  else if (n.t === 'word' && /^(?:intervals?|efforts?|times)$/.test(n.v) && n2?.t === 'word' && n2.v === 'of') k = 2;
  else if (n.t === 'word' && n.v === 'times' && isD(n2)) k = 2;  // "3 times 10 minutes"
  if (!k) return 0;
  while (T[i + k]?.t === 'x' || T[i + k]?.t === 'colon' || (T[i + k]?.t === 'word' && /^(?:of|by|x)$/.test(T[i + k].v))) k++;
  return k;
}
// a count written after the steps: "x 3", "3x" at the end, "3 times", "repeat 3 times", "for 3 rounds"
function tailAt(T, j) {
  const t = T[j], n = T[j + 1], p = T[j - 1];
  if (t.t === 'x' && int(n) && (p?.t !== 'num' || T[j - 2]?.t === 'slash')) return { len: 2, n: n.v };
  if (int(t) && n?.t === 'x' && j > 0 && !/^(?:num|dur|grp|open)$/.test(T[j + 2]?.t)) return { len: 2, n: t.v };
  if (int(t) && n?.t === 'word' && n.v === 'times') return { len: 2, n: t.v };
  if (int(t) && n?.t === 'word' && COUNTW.test(n.v) && j > 0 && !T.slice(j + 2).some(isD)) return { len: 2, n: t.v };
  if (t.t === 'word' && /^repeat(?:ed)?$/.test(t.v)) {
    let k = j + 1;
    while (T[k]?.t === 'x' || (T[k]?.t === 'word' && /^(?:it|this|that|the|set|block|above|all|for|everything|x)$/.test(T[k].v))) k++;
    if (!int(T[k])) return null;
    const v = T[k++].v;
    if (T[k]?.t === 'x' || (T[k]?.t === 'word' && T[k].v === 'times')) k++;
    return { len: k - j, n: v };
  }
  if (t.t === 'word' && t.v === 'times' && int(n)) return { len: 2, n: n.v };
  return null;
}

// ranges and pairs: "88-94%", "200 to 250w", "8-10 min" (middle), "40-20s" (40s on / 20s off), "@ 250" (watts)
function fold(T) {
  const o = [];
  for (let k = 0; k < T.length; k++) {
    const t = T[k], n1 = T[k + 1], n2 = T[k + 2], prev = o[o.length - 1];
    const rng = n2 && (n1.t === 'dash' || (n1.t === 'word' && n1.v === 'to'));
    if (rng && (t.t === 'num' || t.t === 'pct') && n2.t === 'pct') { o.push({ t: 'pct', a: t.t === 'num' ? t.v / 100 : t.a, b: n2.b }); k += 2; continue; }
    if (rng && (t.t === 'num' || t.t === 'watt') && n2.t === 'watt') { o.push({ t: 'watt', a: t.t === 'num' ? t.v : t.a, b: n2.b }); k += 2; continue; }
    if (rng && t.t === 'num' && n2.t === 'dur') {
      if (n1.t === 'dash' && t.v >= n2.n) o.push(t, { t: 'slash' }, n2);
      else o.push(D((t.v * SEC[n2.u] + n2.d) / 2, n2.u, n2.n));
      k += 2; continue;
    }
    if (rng && t.t === 'dur' && n2.t === 'dur') { o.push(D((t.d + n2.d) / 2, t.u, t.n)); k += 2; continue; }
    if (rng && t.t === 'num' && n2.t === 'num') {
      if (prev?.t === 'word' && /^(?:from|ramp\w*|build\w*)$/.test(prev.v) && t.v >= 20 && n2.v <= 200) o.push({ t: 'pct', a: t.v / 100, b: n2.v / 100 });
      else if (n1.t === 'dash' && t.v >= n2.v) o.push(t, { t: 'slash' }, n2);
      else o.push({ t: 'num', v: (t.v + n2.v) / 2 });
      k += 2; continue;
    }
    if (t.t === 'num' && prev?.t === 'word' && prev.v === 'at') {  // "4x20 at 250": watts when large, % when it reads like a percent
      if (t.v >= 200 && t.v <= 2000) { o.push({ t: 'watt', a: t.v, b: t.v }); continue; }
      if (t.v >= 40 && t.v <= 160) { o.push({ t: 'pct', a: t.v / 100, b: t.v / 100 }); continue; }
    }
    o.push(t);
  }
  return o;
}

/* ---------- pieces: one length + what to ride ---------- */
function piece(toks, lead = null) {
  const p = { d: null, u: null, bare: null, pct: null, w: null, zone: null, rpe: null, words: [], ramp: false, down: false, from: false, between: null, lead, dist: false, extra: [] };
  toks.forEach((t, k) => {
    const prev = toks[k - 1], next = toks[k + 1];
    if (t.t === 'dur') { if (p.d == null && p.bare == null) { p.d = t.d; p.u = t.u; } else p.extra.push(t); }
    else if (t.t === 'num') { if (p.d == null && p.bare == null) p.bare = t.v; else p.extra.push(t); }
    else if (t.t === 'pct') p.pct ??= [t.a, t.b];
    else if (t.t === 'watt') p.w ??= [t.a, t.b];
    else if (t.t === 'zone') p.zone ??= [t.a, t.b];
    else if (t.t === 'rpe') p.rpe ??= t.v;
    else if (t.t === 'dist') p.dist = true;
    else if (t.t === 'word') {
      if (/^(?:on|off|work)$/.test(t.v) && !(isD(prev) && !(next?.t === 'word' && !DESC.test(next.v)))) return;  // "30s on", not "1h on the bike"
      if (t.v === 'between') p.between = 'any';
      if (RAMPW.test(t.v)) p.ramp = true; if (DOWNW.test(t.v)) p.down = true; if (t.v === 'from') p.from = true;
      p.words.push(t.v);
    }
  });
  p.ws = ` ${p.words.join(' ')} `;
  if (p.between) p.between = /\b(?:sets?|rounds?|blocks?)\b/.test(p.ws) ? 'sets' : /\b(?:reps?|intervals?|efforts?|each|repeats?)\b/.test(p.ws) ? 'reps' : 'any';
  p.free = FREE.test(p.ws); p.every = lead === 'every';
  const fr = /\bfrom ((?:\S+ )+?)to ((?:\S+ )+)/.exec(p.ws), fa = fr && effort(' ' + fr[1]), fb = fr && effort(' ' + fr[2]);
  if (fa && fb) p.er = [fa, fb];  // "build from tempo to threshold"
  return p;
}
const hasInt = p => p.pct || p.w || p.zone || p.rpe != null || p.free || effort(p.ws);
const restWords = p => /\b(?:rest|recover\w*|ri|rec|off|easy|spin\w*)\b/.test(p.ws);

// one segment (no / with and inside) -> pieces, split where a second length starts
function segPieces(seg, lead) {
  const fd = seg.findIndex(isD), fx = seg.findIndex(isX), before = fx >= 0 && (fd < 0 || fx < fd);
  const runs = []; let cur = [];
  for (const t of seg) {
    if (cur.some(isD) && (isD(t) || (before && isX(t)))) { runs.push(cur); cur = []; }
    cur.push(t);
  }
  runs.push(cur);
  const out = [];  // a run with no length joins its neighbour
  runs.forEach(r => { if (!r.some(isD) && out.length) out[out.length - 1].push(...r); else if (out.length && !out[out.length - 1].some(isD)) out[out.length - 1].push(...r); else out.push([...r]); });
  return out.map((r, k) => piece(r, k ? null : lead));
}

function pieces(T, ctx, rep = false) {
  T = fold(T);
  const items = []; let seg = [], lead = null, pair = false;
  const flush = () => {
    if (seg.length) segPieces(seg, lead).forEach((p, k) => { if (!k && pair) p.pair = items[items.length - 1]?.p; items.push({ p }); });
    seg = []; lead = null; pair = false;
  };
  T.forEach((t, k) => {
    if (t.t === 'slash') { const pr = isD(T[k - 1]) && isD(T[k + 1]); flush(); pair = pr; return; }
    if (t.t === 'word' && (SEGW.has(t.v) || t.v === 'every')) { flush(); lead = t.v === 'with' || t.v === 'every' ? t.v : null; return; }
    if (t.t === 'grp') {
      const g = fold(t.toks);
      if (g.some(x => /^(?:dur|num|x|grp|open)$/.test(x.t))) {  // "3x(30/15)": one clause in brackets is the repeat's body
        flush();
        const r = rep && !t.toks.some(x => x.t === 'sep' || x.t === 'open') ? seq(t.toks, ctx, 'rep', {}) : null;
        items.push({ nodes: r?.kind === 'steps' ? r.nodes : sub(t.toks, ctx) });
      }
      else seg.push(...g);  // "(88-94% FTP)" describes the piece it follows
      return;
    }
    seg.push(t);
  });
  flush();
  for (const { p } of items) {  // "30/30 at 120%": the effort after the pair is for the work
    const q = p?.pair;
    if (q && !hasInt(q) && hasInt(p) && !restWords(p)) {
      for (const f of ['pct', 'w', 'zone', 'rpe', 'words', 'ws']) [q[f], p[f]] = [p[f], f === 'words' ? [] : f === 'ws' ? '  ' : null];
    }
  }
  return items;
}

// pieces -> steps. role: 'rep' (first piece is the work, the rest recover), 'plain', 'wu', 'cd'
function mk(items, role, ctx, mult = 1) {
  const ps = items.filter(x => x.p && (x.p.d != null || x.p.bare != null)).map(x => x.p);
  const ex = ps.find(p => p.d != null)?.u, bares = ps.filter(p => p.d == null);
  // pairs "30/30", "30 on 30 off": seconds unless small; otherwise the first number sets the unit for the rest
  const pairs = bares.length > 1 && (bares.some(p => p.pair) || bares.every(p => /\b(?:on|off)\b/.test(p.ws)));
  let firstU = null;
  for (const p of bares) {  // a number with no unit: "2x20", "30/30", "take 4 easy in between"
    const hi = (effort(p.ws)?.(30) ?? 0) >= 1.18 || (p.pct?.[0] ?? 0) >= 1.18;
    const resty = role !== 'rep' && (p.between || p.lead === 'with' || restWords(p));
    let u = ex === 'h' ? 'm' : ex;
    if (!u && resty) u = p.between === 'sets' ? 'm' : ctx.unit;
    if (!u && pairs) u = Math.max(...bares.map(b => b.bare)) >= 15 ? 's' : 'm';
    if (!u) u = firstU || (p.bare >= 30 && (hi || mult * p.bare * 60 > 3 * 3600) ? 's' : 'm');
    firstU ??= u;
    if (u === 's' && p.bare < 10 && role !== 'rep') u = 'm';
    if (role === 'plain' && !resty && !hasInt(p) && !p.ramp) throw new Error(`Can't read "${ctx.raw}"`);
    p.d = Math.round(p.bare * SEC[u]); p.u = u;
  }
  const nodes = [], betweens = []; let first = true;
  for (const x of items) {
    if (x.nodes) { nodes.push(...x.nodes); first = false; continue; }
    const p = x.p;
    if (p.extra.length) throw new Error(`Can't read "${ctx.raw}"`);
    if (p.d == null) continue;
    const r = p.between ? 'rest' : role === 'rep' ? (first ? 'work' : 'rest') : role === 'plain' ? (p.lead === 'with' ? 'rest' : 'plain') : first ? role : 'plain';
    if (p.every) {  // "4 x 30s sprint every 5 min": the rest fills the cycle
      if (role !== 'rep' || (p.d -= total(nodes)) < 1) throw new Error(`Can't read "${ctx.raw}"`);
      p.pct = p.w = p.zone = p.er = null; p.rpe = null; p.ws = '  ';
    }
    const s = step(p, p.d, p.every ? 'rest' : r);
    if (p.between) betweens.push({ lvl: p.between, s }); else { nodes.push(s); first = false; }
  }
  if (role === 'rep') ctx.unit = ps[0]?.u || ctx.unit;
  return { nodes, betweens };
}

function step(p, d, role) {
  if (!(d >= 1)) throw new Error('A step needs a length above zero');
  if (d > MAX_D) throw new Error('Too long: keep it under 12 hours');
  if (p.free) return { d, free: true };
  const f = effort(p.ws), soft = role === 'wu' || role === 'cd';
  let a = null, b, u = '%';
  if (p.pct) [a, b] = p.pct;
  else if (p.w) { [a, b] = p.w; u = 'w'; }
  else if (p.zone) { [a, b] = p.zone.map(z => ZONE[z - 1]); if (a !== b && !p.ramp && !p.from && !soft) a = b = (a + b) / 2; }  // "Z2-3": a band, not a ramp
  else if (p.er) [a, b] = p.er.map(f => f(d));
  else if (p.rpe != null) { const r = Math.min(10, p.rpe), lo = Math.floor(r); a = b = RPE[lo] + (RPE[Math.min(10, lo + 1)] - RPE[lo]) * (r - lo); }
  else if (f && !(soft && f(d) === 0.55)) a = b = f(d);  // "easy warm-up" is still the warm-up ramp
  if (a == null) {
    [a, b] = role === 'wu' ? [0.45, 0.7] : role === 'cd' ? [0.65, 0.45] : p.ramp ? (p.down ? [0.7, 0.45] : [0.55, 0.8])
      : Array(2).fill(role === 'work' ? HARD(d) : role === 'rest' ? 0.5 : 0.55);
    if (role === 'plain' && !p.ramp) return { d, a, b, u, dflt: true };  // a zone note on the next clause may still set it
  } else if (a === b && u === '%' && (p.ramp || p.down)) {  // "build to threshold": ramp up to the one value given
    if (role === 'cd' || p.down) [a, b] = a > 0.45 ? [a, 0.45] : [0.65, a];
    else { const lo = role === 'wu' ? 0.45 : 0.55; if (a > lo) [a, b] = [lo, a]; }
  }
  if (u === '%' ? !(a >= 0.2 && b >= 0.2 && a <= 3 && b <= 3) : !(a >= 20 && b >= 20 && a <= 2500 && b <= 2500)) throw new Error(`Power looks wrong: ${u === '%' ? Math.round(a * 100) + '%' : a + 'w'}`);
  return { d, a: +a.toFixed(4), b: +b.toFixed(4), u };
}

/* ---------- clauses -> tree ---------- */
const total = items => items.reduce((t, x) => t + (x.items ? x.n * total(x.items) : x.d), 0);
const nest = (counts, items) => counts.reduceRight((acc, n) => [{ n, items: acc }], items)[0];
const chain = r => { const c = [r]; let x = r; while ((x = x.items.find(y => y.items))) c.push(x); return c; };
const firstStep = r => { for (const x of r.items) { const s = x.items ? firstStep(x) : x; if (s) return s; } return null; };
function restish(s, w) {
  if (!s || s.items || s.free) return false;
  if (s.u === 'w') return !!w && w.u === 'w' && s.a < w.a * 0.8;
  const hi = Math.max(s.a, s.b);
  return hi <= 0.75 && (!w || w.free || w.u !== '%' || hi < Math.min(w.a, w.b));
}
const hasRest = r => { const l = r.items[r.items.length - 1], w = firstStep(r); return !!l && l !== w && restish(l, w); };
// rest after a repeat: "between sets" -> outer, "between reps" -> inner, else the deepest repeat still without a rest
function attach(rep, lvl, s, mode) {
  const ch = chain(rep);
  // a rest longer than an inner rep cycle goes to the set around it: "3 sets of (2' / 1') x 3, 5 min rest"
  const open = [...ch].reverse().filter(r => !hasRest(r) && (mode === 'between' || !r.closed));
  let t = lvl === 'sets' ? ch[0] : lvl === 'reps' ? ch[ch.length - 1] : open.find(r => s.d <= Math.max(total(r.items), 60)) || open[open.length - 1];
  if (!t) { if (mode !== 'between') return false; t = ch[0]; }
  if (mode === 'guess' && (t.items.some(x => restish(x, firstStep(t))) || !restish(s, firstStep(t)) || s.d > Math.max(total(t.items), 300))) return false;
  t.items.push(s); return true;
}
// "repeat 3 times" after the steps: the last work steps and the rests after them
function again(L, n, ctx) {
  let k = L.length;
  const plain = x => x && !x.items && !ctx.special.has(x);
  while (k > 0 && plain(L[k - 1]) && restish(L[k - 1])) k--;
  while (k > 0 && plain(L[k - 1]) && !restish(L[k - 1])) k--;
  if (k === L.length) { if (L[k - 1]?.items) k--; else throw new Error(`Nothing to repeat ${n} times`); }
  L.push({ n, items: L.splice(k) });
}

function readClause(c, ctx) {
  let T = c.toks;
  while (T[0]?.t === 'word' && LABEL.test(T[0].v) && T[1]?.t === 'num' && !COUNTW.test(T[2]?.v ?? '')) T = T.slice(/^(?:colon|dash)$/.test(T[2]?.t) ? 3 : 2);  // "Set 1:"
  if (!T.length) return null;
  ctx.raw = ctx.src.slice(T[0].i ?? 0, T[T.length - 1].e ?? 0).trim() || ctx.raw;
  const ws = ' ' + T.filter(t => t.t === 'word').map(t => t.v).join(' ') + ' ';
  if (c.heading) { ctx.section = c.heading; return null; }
  let wu = /\bwu\b/.test(ws), cd = !wu && /\bcd\b/.test(ws);
  if (wu && /\bcd\b/.test(ws)) {  // "warm up and cool down 15 min each"
    const ds = T.filter(t => t.t === 'dur');
    if (ds.length === 1 && !T.some((t, j) => t.t === 'x' || countAt(T, j))) return { kind: 'wucd', d: ds[0].d };
  }
  if (ctx.section && !wu && !cd && !T.some((t, j) => countAt(T, j))) [wu, cd] = [ctx.section === 'wu', ctx.section === 'cd'];
  ctx.section = null;
  if (wu || cd) T = T.filter(t => !(t.t === 'word' && /^(?:wu|cd)$/.test(t.v)));
  const has = re => T.some(t => re.test(t.t)), durs = T.filter(t => t.t === 'dur');
  if (!durs.length && FILLW.test(ws) && !has(/^(?:num|x)$/)) return { kind: 'fill', to: null, p: piece(fold(T.filter(t => t.v !== 'rest'))) };  // "the rest easy"
  if (!durs.length && has(/^dist$/)) throw new Error(`Use times, not distances: "${ctx.raw}"`);
  if (!durs.length && !has(/^(?:num|pct|watt|x)$/)) {
    if (cd && ctx.total) return { kind: 'fill', to: null, p: piece(T), role: 'cd' };  // "60 min: ..., then cool down"
    if (wu || cd) throw new Error(`No length for the ${wu ? 'warm-up' : 'cool-down'}`);
    if (/\b(?:to|until|till) the hour\b/.test(ws)) return { kind: 'fill', to: 3600, p: piece(T) };
    if (has(/^(?:zone|rpe)$/)) return { kind: 'power', p: piece(T), soft: true };  // "1.5 hours, mostly zone 2"
    return null;  // a note: "keep cadence high", "focus on form"
  }
  if (durs.length === 1 && /\b(?:total|overall|duration)\b/.test(ws) && !has(/^(?:num|pct|watt|x|zone|rpe)$/) && !/\b(?:to|until|till)\b/.test(ws) && !effort(ws)) {
    return { kind: 'total', d: durs[0].d };
  }
  // fill: "easy to 60 min", "z2 until 90 min total"
  const fk = T.findIndex((t, j) => t.t === 'word' && /^(?:to|until|till|til)$/.test(t.v) && !/^(?:num|pct|dur|watt|zone)$/.test(T[j - 1]?.t)
    && (T[j + 1]?.t === 'dur' || (T[j + 1]?.t === 'num' && !/^(?:pct|watt|dur)$/.test(T[j + 2]?.t))));
  if (fk >= 0 && !has(/^x$/) && !T.some((t, j) => countAt(T, j))) {
    const n = T[fk + 1];
    return { kind: 'fill', to: n.t === 'dur' ? n.d : n.v * 60, p: piece(fold(T.filter((t, j) => j !== fk && j !== fk + 1 && !(t.t === 'word' && t.v === 'total')))) };
  }
  // base ride with efforts inside: "60 min z2 with 4x30s sprints"
  const wk = T.findIndex(t => t.t === 'word' && /^(?:with|including|incl|containing)$/.test(t.v));
  if (wk > 0 && !wu && !cd) {
    const B = T.slice(0, wk), A = T.slice(wk + 1), bd = B.filter(t => t.t === 'dur');
    if (bd.length === 1 && !B.some((t, j) => t.t === 'x' || countAt(B, j)) && A.some((t, j) => countAt(A, j))) {
      const r = seq(A, ctx, 'plain', {});
      if (r.kind !== 'steps' || !r.nodes.length) throw new Error(`Can't read "${ctx.raw}"`);
      return { kind: 'base', d: bd[0].d, p: piece(fold(B.filter(t => t !== bd[0]))), nodes: r.nodes };
    }
  }
  // a count after other steps starts a new clause: "warm up 10 min 4x8 threshold"
  let depth = T[0].t === 'open' ? 1 : 0;
  for (let j = 1; j < T.length; j++) {
    const t = T[j]; depth += t.t === 'open' ? 1 : t.t === 'close' ? -1 : 0;
    const k = depth === 0 && countAt(T, j);
    if (k && /^(?:dur|num|open)$/.test(T[j + k]?.t) && T.slice(0, j).some(isD) && !/^(?:slash|dash)$/.test(T[j - 1].t) && T[j - 1].v !== 'at') {
      return { kind: 'multi', parts: [readClause({ ...c, toks: T.slice(0, j).concat(wu ? [{ t: 'word', v: 'wu' }] : []) }, ctx), readClause({ ...c, toks: T.slice(j), nl: false, bullet: false }, ctx)] };
    }
  }
  const r = seq(T, ctx, wu ? 'wu' : cd ? 'cd' : 'plain', c);
  const w0 = T[0].t === 'word' ? T[0].v : '';
  if (/^(?:include|includes|including|incl|add)$/.test(w0)) r.incl = true;     // "Ride 90 min. Include 4x5 at threshold."
  if (/^(?:last|final|first)$/.test(w0)) r.carve = w0 === 'first' ? 'first' : 'last';  // "4 hours z2, last hour at tempo"
  if (r.kind === 'steps' && (wu || cd)) {
    if (!r.nodes.length) throw new Error(`No length for the ${wu ? 'warm-up' : 'cool-down'}`);
    if (!r.nodes[0].items) ctx.special.set(r.nodes[0], wu ? 'wu' : 'cd');
    r.kind = wu ? 'wu' : 'cd';
  }
  if (r.kind === 'steps' && !r.nodes.length && !r.betweens.length) {
    const g = fold(T);  // "10 min cool down, 70 to 40%": a power for the step before
    if (!g.some(isD) && g.some(t => /^(?:pct|watt|zone|rpe)$/.test(t.t))) {
      return /\b(?:under|below|less|max\w*|cap\w*|keep|stay|limit|no more)\b/.test(ws) ? null : { kind: 'power', p: piece(g) };  // "keep power under 150w": a cap, not a target
    }
    throw new Error(`No length in "${ctx.raw}"`);
  }
  return r;
}

function seq(T, ctx, role, c) {
  T = groups(T);
  let i = 0; while (/^(?:word|dash)$/.test(T[i]?.t) && !countAt(T, i)) i++;
  const counts = []; let j = i, k;
  while ((k = countAt(T, j))) { counts.push(T[j].v); j += k; }
  let body = counts.length ? [...T.slice(0, i), ...T.slice(j)] : T, tail = null, after = [];
  for (let q = 0; q < body.length && !tail; q++) if ((tail = tailAt(body, q))) { after = body.slice(q + tail.len); body = body.slice(0, q); }
  const hasBody = body.some(t => /^(?:dur|num|grp)$/.test(t.t));
  if (!hasBody && (counts.length || tail)) {
    const all = [...counts, ...(tail ? [tail.n] : [])];
    return counts.length || c.hdr ? { kind: 'header', counts: all } : { kind: 'again', n: tail.n };
  }
  const mult = counts.reduce((a, b) => a * b, tail ? tail.n : 1);
  const items = pieces(body, ctx, !!(counts.length || tail)), { nodes, betweens } = mk(items, counts.length || tail ? 'rep' : role, ctx, mult);
  if (!counts.length && !tail) {
    const ps = items.filter(x => x.p), p = ps.length === 1 && ps[0].p;
    return { kind: 'steps', nodes, betweens, rest: !!p && (p.lead === 'with' || /\b(?:rest|recover\w*|ri|rec|off)\b/.test(p.ws)) };
  }
  if (!nodes.length) throw new Error(`No length in "${ctx.raw}"`);
  let node = counts.length ? nest(counts, nodes) : { n: tail.n, items: nodes };
  if (counts.length && tail) node = { n: tail.n, items: [node] };
  if (items.every(x => x.nodes)) { let h = node; while (h.items !== nodes) h = h.items[0]; h.closed = true; }  // "3x(...)": brackets close it
  betweens.forEach(b => attach(node, b.lvl, b.s, 'between'));
  const out = [node];
  if (after.length) {  // "6 min @ 105% x 3 with 3 min rest"
    const items = pieces(after, ctx), a = mk(items, 'plain', ctx);
    const into = items.every(x => x.nodes || x.p.lead === 'with' || x.p.between || restWords(x.p));
    a.nodes.forEach(s => (into && attach(node, 'any', s, 'between')) || out.push(s));
    a.betweens.forEach(b => attach(node, b.lvl, b.s, 'between'));
  }
  // "30s on, 30s off x 10": a repeat of rests only takes the work written just before it
  const pull = !counts.length && nodes.every(x => !x.items && restish(x)) ? node : null;
  return { kind: 'steps', nodes: out, betweens: [], rest: false, pull };
}

function sub(T, ctx) { return build(clauses(T), ctx); }

function build(cls, ctx) {
  if (++ctx.depth > 6) throw new Error('Too many nested brackets');
  const out = []; let blk = null;
  const close = () => { if (blk && !blk.inner.items.length) throw new Error(`Nothing to repeat after "${blk.top.n}x"`); blk = null; };
  const lastRep = L => { const x = L[L.length - 1]; return x?.items ? x : null; };
  const add = (r, c) => {
    if (!r) return;
    if (!/^(?:total|header|multi)$/.test(r.kind)) ctx.seen = true;
    if (r.kind === 'multi') { r.parts.forEach(x => add(x, c)); return; }
    if (blk && blk.started && (c.blank || /^(?:wu|cd|fill|header|total)$/.test(r.kind) || (c.nl && (blk.bullets ? !c.bullet : blk.sameLine)))) close();
    if (blk && !blk.started) { blk.started = true; blk.bullets = c.bullet; blk.sameLine = !c.nl; }
    const L = blk ? blk.inner.items : out;
    if (r.kind === 'total') { ctx.total = r.d; ctx.late = !!ctx.seen; return; }  // a total after the steps is a summary
    if (r.kind === 'header') { close(); const node = nest(r.counts, []); out.push(node); blk = { top: node, inner: chain(node).pop(), started: false }; return; }
    if (r.kind === 'again') { again(L, r.n, ctx); return; }
    if (r.kind === 'wucd') {
      const w = { d: r.d, a: 0.45, b: 0.7, u: '%' }; ctx.special.set(w, 'wu'); out.unshift(w);
      ctx.cdLast = { d: r.d, a: 0.65, b: 0.45, u: '%' }; return;
    }
    if (r.kind === 'power') {
      const x = L[L.length - 1];
      if (r.soft && !x?.dflt) return;
      if (!x || x.items || x.free) throw new Error(`No length in "${ctx.raw}"`);
      delete x.dflt; Object.assign(x, step(r.p, x.d, ctx.special.get(x) === 'cd' ? 'cd' : ctx.special.get(x) === 'wu' ? 'wu' : 'plain')); return;
    }
    if (r.kind === 'fill') {
      const to = r.to ?? ctx.total;
      if (to == null) throw new Error('Nothing to fill up to: add a total, like "60 min total"');
      const left = to - total(out); ctx.filled = true;
      if (left >= 1) { const s = step(r.p, left, r.role || 'plain'); ctx.special.set(s, r.role || 'fill'); out.push(s); }
      return;
    }
    const px = L[L.length - 1], s0 = r.nodes?.[0], plain = px && !px.items && !px.free && !ctx.special.has(px);
    if (r.kind === 'steps' && r.incl && plain && r.nodes.some(n => n.items) && px.d > total(r.nodes)) {
      L.pop(); r = { kind: 'base', d: px.d, base: g => ({ ...px, d: g }), nodes: r.nodes };
    }
    if (r.kind === 'steps' && r.carve && plain && r.nodes.length === 1 && !s0.items && px.d > s0.d) {
      px.d -= s0.d; L.splice(r.carve === 'first' ? L.length - 1 : L.length, 0, s0); return;
    }
    if (r.kind === 'base') {  // efforts spread through a base ride
      const base = r.base || (g => step(r.p, g, 'plain'));
      const left = r.d - total(r.nodes), rep = r.nodes.length === 1 && r.nodes[0].items && !hasRest(chain(r.nodes[0]).pop()) ? r.nodes[0] : null;
      if (left < 2) L.push(...r.nodes);
      else if (rep) { const g = Math.round(left / (rep.n + 1)); L.push(base(g), rep); chain(rep).pop().items.push(base(g)); }
      else { const h = Math.round(left / 2); L.push(base(h), ...r.nodes, base(left - h)); }
      return;
    }
    const tgt = () => blk ? blk.inner.items : out;  // a "between sets" step closes the set block
    for (const b of r.betweens) {
      const lr = lastRep(tgt());
      if (blk && b.lvl !== 'reps' && (b.lvl === 'sets' || !lr || hasRest(chain(lr).pop()))) { attach(blk.top, 'sets', b.s, 'between'); close(); continue; }
      if (!(lr && attach(lr, b.lvl, b.s, 'between'))) tgt().push(b.s);
    }
    const L2 = tgt(), rep = lastRep(L2), s = r.nodes[0];
    if (r.pull) while (L2.length && !L2[L2.length - 1].items && !ctx.special.has(L2[L2.length - 1]) && !restish(L2[L2.length - 1])) r.pull.items.unshift(L2.pop());
    if (r.kind === 'steps' && r.nodes.length === 1 && !s.items && rep && attach(rep, 'any', s, r.rest ? 'rest' : 'guess')) return;
    L2.push(...r.nodes);
  };
  for (const c of cls) add(readClause(c, ctx), c);
  close(); ctx.depth--;
  return out;
}

// drop 1x wrappers and parser marks
const tidy = L => L.flatMap(x => x.items ? (x.n === 1 ? tidy(x.items) : [{ n: x.n, items: tidy(x.items) }]) : [x.free ? { d: x.d, free: true } : { d: x.d, a: x.a, b: x.b, u: x.u }]);

export function fromWords(text) {
  const src = String(text ?? '');
  if (src.length > 5000) throw new Error('Too long: keep it under 5000 characters');
  const ctx = { src: norm(src), total: null, filled: false, unit: 'm', special: new Map(), depth: 0, raw: '' };
  const out = build(clauses(lex(ctx.src)), ctx);
  if (ctx.cdLast) { ctx.special.set(ctx.cdLast, 'cd'); out.push(ctx.cdLast); }
  if (ctx.total && !ctx.filled && !ctx.late) {  // "60 min: ..." with time left over: ride it easy (before the cool-down)
    const left = ctx.total - total(out);
    if (left >= 60) { const at = ctx.special.get(out[out.length - 1]) === 'cd' ? out.length - 1 : out.length; out.splice(at, 0, { d: left, a: 0.55, b: 0.55, u: '%' }); }
  }
  const tree = tidy(out);
  if (!tree.length) throw new Error('No workout found: try "10 min easy, 4x8 min at threshold with 4 min easy"');
  const bad = x => x.items ? (x.n > 200 || x.items.length === 0 || x.items.some(bad)) : false;
  if (tree.some(bad)) throw new Error('Too many repeats');
  if (total(tree) > MAX_D) throw new Error('Too long: keep it under 12 hours');
  return tree;
}
