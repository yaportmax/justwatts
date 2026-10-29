// Sortable list headers (Workouts and Courses lists). One sort value per list, persisted with its filters: '' is Featured,
// a Sort-select preset maps to a (column, direction), any other header sort is 'h:<column>:<asc|desc>'.
// presets: { value: [column, dir] }; select: [[value, label]] for the Sort select (Featured and the community sorts included).
import { esc } from './core.js';

export function createListSort(presets, select) {
  const of = v => presets[v] || ((m => m ? [m[1], m[2]] : null)(/^h:(\w+):(asc|desc)$/.exec(v || '')));
  const to = (k, d) => Object.keys(presets).find(p => presets[p][0] === k && presets[p][1] === d) || `h:${k}:${d}`;
  // a header click: the same column flips, another column starts ascending
  const click = (v, k) => { const c = of(v); return to(k, c && c[0] === k && c[1] === 'asc' ? 'desc' : 'asc'); };
  // header cells: cols [[column|'', label, extra class]]
  const head = (v, cols) => {
    const c = of(v);
    return cols.map(([k, label, cls = '']) => {
      if (!k) return `<span class="${cls}">${esc(label)}</span>`;
      const on = c && c[0] === k, aria = on ? (c[1] === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<button class="hs ${cls}${on ? ' on' : ''}" data-sort="${esc(k)}" aria-sort="${aria}">${esc(label)}<i class="ar" aria-hidden="true">${on ? (c[1] === 'asc' ? '↑' : '↓') : ''}</i></button>`;
    }).join('');
  };
  // the Sort select: its presets, plus the current header sort when no preset matches
  const options = (v, labels) => {
    const extra = /^h:/.test(v || '') && of(v) ? [[v, `${labels[of(v)[0]] || of(v)[0]} ${of(v)[1] === 'asc' ? '↑' : '↓'}`]] : [];
    return [...select, ...extra].map(([o, t]) => `<option value="${esc(o)}">${esc(t)}</option>`).join('');
  };
  // a comparator for a sort value (null: Featured or a community sort); get(x, column) reads a row's value; ties go by name
  const cmp = (v, get) => {
    const c = of(v); if (!c) return null;
    const [k, d] = c, s = d === 'desc' ? -1 : 1;
    return (a, b) => {
      const x = get(a, k), y = get(b, k);
      const r = typeof x === 'string' ? x.localeCompare(y) : (x ?? 0) - (y ?? 0);
      return s * r || String(get(a, 'name')).localeCompare(String(get(b, 'name')));
    };
  };
  return { of, to, click, head, options, cmp };
}
