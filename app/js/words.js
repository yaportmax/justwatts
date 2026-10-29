// Workout from plain words, e.g. "20 min easy, 3 sets of 6x45s hard / 30s easy, 5 min easy between sets,
// easy to 60 min". Rules only: runs in the page, no model, no network. Returns a tree (see core.js parseTree).

// intensity words -> fraction of FTP; d = segment seconds (short "hard" efforts are harder)
const WORDS = [
  [/all[\s-]?out|sprint|max(?:imal|imum)?\b|z7/, () => 1.5],
  [/anaerobic|z6/, () => 1.3],
  [/vo2|z5/, () => 1.18],
  [/\bovers?\b|over[\s-]?unders?/, () => 1.05],
  [/threshold|ftp|z4/, () => 1.0],
  [/sweet\s*spot|sst/, () => 0.9],
  [/tempo|z3/, () => 0.8],
  [/hard|on\b|work|effort/, d => d <= 60 ? 1.2 : d <= 300 ? 1.1 : 1.0],
  [/endurance|steady|moderate|z2/, () => 0.65],
  [/recover|rest|off\b|z1/, () => 0.5],
  [/easy|spin|light/, () => 0.55],
];
const DUR = /(\d+(?:\.\d+)?)\s*(h|m|s)\b|(\d+):([0-5]\d)\b/;

function norm(t) {
  return ' ' + String(t || '').toLowerCase()
    .replace(/[×*]/g, 'x').replace(/@/g, ' at ').replace(/\bw\//g, 'with ')
    .replace(/(\d)\s*(?:hours?|hrs?)\b/g, '$1h').replace(/(\d)\s*(?:minutes?|mins?|')(?![a-z])/g, '$1m')
    .replace(/(\d)\s*(?:seconds?|secs?|"|'')(?![a-z])/g, '$1s').replace(/(\d)\s*watts?\b/g, '$1w')
    .replace(/[–—]/g, '-') + ' ';
}
const durOf = m => m[3] != null ? +m[3] * 60 + +m[4] : Math.round(+m[1] * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1));

// one "45s hard" / "5m at 250w" / "10m 50-70%" piece -> step, or null
function segment(p, { bare = null, defaultWork = false } = {}) {
  let m = DUR.exec(p), d;
  if (m) d = durOf(m);
  else if (bare != null) d = bare;  // "2x20 at sweet spot": the number after x is the length
  else return null;
  if (!(d > 0)) return null;
  if (/\bfree\b|as you (?:like|want)/.test(p)) return { d, free: true };
  const rest = m ? p.replace(m[0], ' ') : p;
  const x = /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(%|w)|(\d+(?:\.\d+)?)\s*(%|w)/.exec(rest);
  if (x) {
    const u = x[3] || x[5], a = +(x[1] ?? x[4]), b = +(x[2] ?? x[4]);
    return u === 'w' ? { d, a, b, u: 'w' } : { d, a: a / 100, b: b / 100, u: '%' };
  }
  for (const [re, f] of WORDS) if (re.test(rest)) return { d, a: f(d), b: f(d), u: '%' };
  const v = defaultWork ? WORDS.find(w => w[0].source.startsWith('hard'))[1](d) : 0.55;
  return { d, a: v, b: v, u: '%' };
}

const total = items => items.reduce((t, x) => t + (x.items ? x.n * total(x.items) : x.d), 0);
const lastRepeat = out => { const x = out[out.length - 1]; return x?.items ? x : null; };

export function fromWords(text) {
  const out = [];
  const clauses = norm(text).split(/[,;\n]|\bthen\b|\bfollowed by\b|\bafter that\b/).map(c => c.trim()).filter(Boolean);
  for (let c of clauses) {
    c = ' ' + c.replace(/^(?:and|do|ride|start with|finish with|end with)\s+/, '') + ' ';
    // "easy to 60m": fill up to a total
    const fill = /\b(?:to|until|till)\s+(\d+(?:\.\d+)?)\s*(h|m)\b/.exec(c);
    if (fill && !/\d\s*x/.test(c)) {
      const left = durOf(fill) - total(out);
      if (left > 0) out.push(segment(c.replace(fill[0], ' ') + ` ${left}s`));
      continue;
    }
    // "5m easy between sets" / "with 4m recovery": rest for the repeat just before
    const between = /\bbetween\b/.test(c), rec = /^\s*(?:with\s+)?\d[^x]*\b(?:recover\w*|rest|easy|off)\b/.test(c) && !/\d\s*x/.test(c);
    const rep = lastRepeat(out), bare1 = rep && rep.items.length === 1 && !rep.items[0].items;  // "2x20 sweet spot, 5m rest"
    if (rep && (between || (rec && (/^\s*with\b/.test(c) || bare1)))) {
      const s = segment(c.replace(/\bbetween\b.*$/, ' '));
      if (s) { attachRest(rep, s); continue; }
    }
    // warm up / cool down: ramps unless a power is given
    const wu = /warm[\s-]?up|\bwu\b/.test(c), cd = /cool[\s-]?down|\bcd\b/.test(c);
    if (wu || cd) {
      const s = segment(c.replace(/warm[\s-]?up|cool[\s-]?down|\bwu\b|\bcd\b/g, ' '));
      if (!s) throw new Error(`No length for the ${wu ? 'warm-up' : 'cool-down'}`);
      if (!s.free && !/\d\s*(?:%|w)|[a-z]{4,}/.test(c.replace(/warm[\s-]?up|cool[\s-]?down|\bwith\b/g, ''))) Object.assign(s, wu ? { a: 0.45, b: 0.7 } : { a: 0.65, b: 0.45 });
      out.push(s); continue;
    }
    // repeats: "3 sets of 6x ...", "4x8m at threshold with 4m recovery", "2x20 sweet spot, 5m rest"
    const counts = []; let body = c, m;
    while ((m = /^\s*(\d+)\s*(?:x|sets?\s+of|rounds?\s+of|times)\s*/.exec(body))) { counts.push(+m[1]); body = body.slice(m[0].length); }
    if (counts.length) {
      const parts = pieces(body);
      let bet = null, unit = 60; const seq = [];
      parts.forEach((p, k) => {
        if (/\bbetween\b/.test(p)) { bet = segment(p.replace(/\bbetween\b.*$/, ' ')); return; }
        let bare = null;
        if (!DUR.test(p)) {  // a length with no unit: "2x20", "10x30 all out / 30 off"
          const n = /^\s*(\d+(?:\.\d+)?)\b/.exec(p);
          if (k === 0) { bare = bareLen(p); if (bare && n) unit = bare / +n[1]; } else if (n) bare = +n[1] * unit;
        }
        const s = segment(p, { bare, defaultWork: k === 0 });
        if (s) seq.push(s);
      });
      if (!seq.length) throw new Error(`No length in "${c.trim()}"`);
      let node = { n: counts[counts.length - 1], items: seq };
      for (let k = counts.length - 2; k >= 0; k--) node = { n: counts[k], items: [node] };
      if (bet) attachRest(node, bet);
      out.push(node); continue;
    }
    // plain pieces: "10m easy and 5m tempo"
    const parts = pieces(c);
    let any = false;
    for (const p of parts) { const s = segment(p); if (s) { out.push(s); any = true; } }
    if (!any) throw new Error(`Can't read "${c.trim()}"`);
  }
  if (!out.length) throw new Error('Nothing to read');
  return out;
}

// "45s hard / 30s easy", "3m vo2 3m rest", "10m easy and 5m tempo" -> one piece per length
function pieces(t) {
  return t.split(/\s*\/\s*|\s+with\s+|\s+and\s+|\s+plus\s+/)
    .flatMap(p => p.split(/\s+(?=(?:\d+(?:\.\d+)?\s*[hms]\b|\d+:[0-5]\d\b))/)).filter(p => p.trim());
}

// the number right after "Nx" with no unit: minutes, except short hard efforts written in seconds ("10x30 all out")
function bareLen(p) {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(p); if (!m) return null;
  const n = +m[1];
  return n >= 30 && /all[\s-]?out|sprint|max|anaerobic|vo2|hard/.test(p) ? n : n * 60;
}

// rest after the work: inside the repeat, so "between sets" follows each set (the last one too)
function attachRest(rep, s) { rep.items.push(s); }
