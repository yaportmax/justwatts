// Visual workout builder: a block list you can drag to reorder, a palette to drag new blocks from,
// and a chart whose blocks you drag (top edge = power, right edge = length). The workout text in
// #bText stays the stored format; every edit here rewrites it through onEdit(text).
import { parseTree, treeText, flattenTree, flattenPaths, parseDur, stepWatts, ZONES, zoneIdx } from './core.js';
import { drawBlocks, hexA } from './chart.js';

const PALETTE = [
  ['Warm up', '10m 45-70%'], ['Steady', '10m 65%'], ['Effort', '5m 100%'], ['Intervals', '5x(3m 110%, 3m 50%)'],
  ['Recovery', '3m 50%'], ['Ramp', '5m 50-90%'], ['Cool down', '5m 60-40%'], ['Free ride', '10m free'],
];

export const fmtClock = d => {
  const h = Math.floor(d / 3600), m = Math.floor(d % 3600 / 60), s = d % 60, p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
};
// "5" = 5 min, "1:30" = 1 min 30 s, "1:00:00" = 1 h, or "45s", "2m30s"
export function parseClock(str) {
  const t = String(str).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(+t * 60);
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) return t.split(':').reduce((a, x) => a * 60 + +x, 0);
  return parseDur(t);
}
const samePath = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (p, pre) => pre && p.length >= pre.length && pre.every((x, i) => x === p[i]);
const pkey = p => p.join('.');
const unkey = k => k === '' ? [] : k.split('.').map(Number);

export function createBuilder({ list, chart: cv, palette: pal, fit, css, ftp, onEdit }) {
  let tree = [], text = null, sel = null, hover = null, chartDrag = null, listDrag = null, geom = null;
  const undo = [];

  /* ---------- tree edits ---------- */
  const arrOf = path => path.slice(0, -1).reduce((a, i) => a[i].items, tree);
  const nodeAt = path => arrOf(path)[path.at(-1)];
  function remove(path) { return arrOf(path).splice(path.at(-1), 1)[0]; }
  function insert(path, node) { arrOf(path).splice(path.at(-1), 0, node); }
  function snapshot() { undo.push(treeText(tree)); if (undo.length > 100) undo.shift(); }
  function commit({ list: relist = true } = {}) {
    text = treeText(tree);
    if (relist) renderList();
    onEdit(text);
  }
  function edit(fn) { snapshot(); fn(); commit(); }
  function move(src, dst) {
    if (startsWith(dst, src)) return;  // into itself
    edit(() => {
      const node = remove(src), k = src.length - 1;
      if (dst.length > k && samePath(dst.slice(0, k), src.slice(0, k)) && dst[k] > src[k]) dst[k]--;
      insert(dst, node); sel = dst;
    });
  }
  const template = t => parseTree(t)[0];

  /* ---------- list ---------- */
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  function btn(label, title, fn) { const b = el('button', 'bic', label); b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; return b; }
  function handle(path) {
    const h = el('span', 'bh', '⠿'); h.title = 'Drag to move';
    h.onpointerdown = e => startListDrag(e, { path });
    return h;
  }
  const zoneOf = n => n.free ? 0 : zoneIdx(((n.u === 'w' ? (n.a + n.b) / 2 / ftp() : (n.a + n.b) / 2)));
  const pctOf = (x, n) => n.u === 'w' ? x / ftp() : x;
  const showVal = (x, n) => n.u === 'w' ? Math.round(x) : +(x * 100).toFixed(1);
  const readVal = (v, n) => n.u === 'w' ? Math.max(0, Math.round(+v)) : Math.max(0, +v) / 100;
  function field(path, key, value, cls, onSet, type = 'number') {
    const i = el('input', cls); i.type = type; i.value = value; i.dataset.k = pkey(path) + ':' + key;
    if (type === 'number') { i.min = 0; i.inputMode = 'numeric'; } else i.inputMode = 'text';
    i.onchange = () => edit(() => onSet(i.value));
    i.onfocus = () => { sel = path; markSel(); draw(); };
    return i;
  }
  function stepRow(n, path) {
    const r = el('div', 'brow'); r.dataset.p = pkey(path);
    r.appendChild(handle(path));
    const sw = el('i', 'bsw'); sw.style.background = css(ZONES[zoneOf(n)][1]); r.appendChild(sw);
    r.appendChild(field(path, 'd', fmtClock(n.d), 'bdur', v => { const d = parseClock(v); if (d > 0) nodeAt(path).d = d; }, 'text'));
    if (n.free) r.appendChild(el('span', 'bfree', 'Free ride'));
    else {
      r.appendChild(field(path, 'a', showVal(n.a, n), 'bpw', v => { const x = nodeAt(path); const was = x.a === x.b && !x.ramp; x.a = readVal(v, x); if (was) x.b = x.a; }));
      if (n.a !== n.b || n.ramp) {
        r.appendChild(el('span', 'bto', '→'));
        r.appendChild(field(path, 'b', showVal(n.b, n), 'bpw', v => { nodeAt(path).b = readVal(v, nodeAt(path)); }));
      }
    }
    const u = el('select', 'bun'); u.dataset.k = pkey(path) + ':u';
    for (const [v, t] of [['%', '% FTP'], ['w', 'W'], ['free', 'Free']]) { const o = el('option', null, t); o.value = v; u.appendChild(o); }
    u.value = n.free ? 'free' : n.u;
    u.onchange = () => edit(() => {
      const x = nodeAt(path), f = ftp(), to = u.value;
      if (to === 'free') { for (const k of ['a', 'b', 'u', 'ramp']) delete x[k]; x.free = true; return; }
      if (x.free) { delete x.free; x.u = to; x.a = x.b = to === 'w' ? Math.round(0.65 * f) : 0.65; return; }
      if (to === x.u) return;
      const conv = v => to === 'w' ? Math.round(v * f) : Math.round(v / f * 100) / 100;
      x.a = conv(x.a); x.b = conv(x.b); x.u = to;
    });
    r.appendChild(u);
    if (!n.free) {
      const lo = stepWatts(n, 0, ftp()), hi = stepWatts(n, n.d, ftp());
      r.appendChild(el('span', 'bw num', n.u === 'w' ? `${Math.round(pctOf(n.a, n) * 100)}${n.a !== n.b ? '-' + Math.round(pctOf(n.b, n) * 100) : ''}%` : `${lo}${lo !== hi ? '-' + hi : ''} W`));
    }
    const tools = el('span', 'btools');
    if (!n.free) tools.appendChild(btn(n.a !== n.b || n.ramp ? '▭' : '◢', n.a !== n.b || n.ramp ? 'Make steady' : 'Make a ramp', () => edit(() => {
      const x = nodeAt(path); if (x.a !== x.b || x.ramp) { x.b = x.a; delete x.ramp; } else x.ramp = true;
    })));
    tools.appendChild(btn('⧉', 'Duplicate', () => edit(() => { const x = nodeAt(path); insert([...path.slice(0, -1), path.at(-1) + 1], structuredClone(x)); })));
    tools.appendChild(btn('✕', 'Remove', () => edit(() => { remove(path); sel = null; })));
    r.appendChild(tools);
    r.onclick = e => { if (e.target === r || e.target === sw) { sel = path; markSel(); draw(); } };
    return r;
  }
  const nodeDur = n => n.items ? n.n * n.items.reduce((a, x) => a + nodeDur(x), 0) : n.d;
  function groupRow(n, path) {
    const g = el('div', 'bgrp');
    const h = el('div', 'brow ghead'); h.dataset.p = pkey(path); h.dataset.g = '1';
    h.appendChild(handle(path));
    h.appendChild(el('span', 'glab', 'Repeat'));
    h.appendChild(field(path, 'n', n.n, 'bn', v => { const k = Math.round(+v); if (k >= 1 && k <= 99) nodeAt(path).n = k; }));
    h.appendChild(el('span', 'glab', '×'));
    h.appendChild(el('span', 'bw num', fmtClock(nodeDur(n))));
    const tools = el('span', 'btools');
    tools.appendChild(btn('+', 'Add a step inside', () => edit(() => { nodeAt(path).items.push(template('3m 100%')); })));
    tools.appendChild(btn('⇱', 'Ungroup', () => edit(() => { const x = remove(path); arrOf(path).splice(path.at(-1), 0, ...x.items); sel = null; })));
    tools.appendChild(btn('✕', 'Remove', () => edit(() => { remove(path); sel = null; })));
    h.appendChild(tools);
    h.onclick = e => { if (e.target === h) { sel = path; markSel(); draw(); } };
    g.appendChild(h);
    const body = el('div', 'gbody');
    n.items.forEach((x, j) => body.appendChild(rowFor(x, [...path, j])));
    const end = el('div', 'gend', 'Drop here'); end.dataset.into = pkey(path);
    body.appendChild(end);
    g.appendChild(body);
    return g;
  }
  const rowFor = (n, path) => n.items ? groupRow(n, path) : stepRow(n, path);
  function renderList() {
    const focusKey = document.activeElement?.dataset?.k;
    list.innerHTML = '';
    tree.forEach((n, j) => list.appendChild(rowFor(n, [j])));
    const end = el('div', 'bend', tree.length ? '' : 'Drag blocks here, or tap one above'); end.dataset.into = '';
    list.appendChild(end);
    if (focusKey && list.querySelector) list.querySelector(`[data-k="${focusKey}"]`)?.focus?.();
    markSel();
  }
  function markSel() {
    if (!list.querySelectorAll) return;
    for (const r of list.querySelectorAll('.brow')) r.classList.toggle('sel', !!sel && samePath(unkey(r.dataset.p), sel));
  }

  /* ---------- palette ---------- */
  if (pal) for (const [name, t] of PALETTE) {
    const c = el('button', 'chip', name); c.title = 'Tap to add, or drag into place';
    const sw = el('i', 'bsw'); const n = template(t), first = n.items ? n.items[0] : n;
    sw.style.background = css(ZONES[zoneOf(first)][1]); c.insertBefore?.(sw, c.firstChild);
    c.onpointerdown = e => startListDrag(e, { tpl: t, name });
    pal.appendChild(c);
  }

  /* ---------- list drag and drop (pointer events, works with touch) ---------- */
  function startListDrag(e, src) {
    if (e.button > 0) return;
    e.preventDefault();
    listDrag = { src, x0: e.clientX, y0: e.clientY, on: false, ghost: null, line: null, dst: null };
    addEventListener('pointermove', onListMove); addEventListener('pointerup', onListUp); addEventListener('pointercancel', onListCancel);
  }
  function dropTarget(x, y) {
    const t = document.elementFromPoint(x, y);
    const into = t?.closest?.('[data-into]');
    if (into && list.contains(into)) { const p = unkey(into.dataset.into); const arr = p.length ? nodeAt(p).items : tree; return { path: [...p, arr.length], rect: into.getBoundingClientRect(), top: true }; }
    const row = t?.closest?.('.brow');
    if (row && list.contains(row)) {
      const p = unkey(row.dataset.p), r = row.getBoundingClientRect(), below = y > r.top + r.height / 2;
      if (row.dataset.g && below) return { path: [...p, 0], rect: r, top: false };  // into the group, first
      if (!below) return { path: p, rect: r, top: true };
      if (row.dataset.g) { const gr = row.parentElement.getBoundingClientRect(); return { path: [...p.slice(0, -1), p.at(-1) + 1], rect: gr, top: false }; }
      return { path: [...p.slice(0, -1), p.at(-1) + 1], rect: r, top: false };
    }
    const lr = list.getBoundingClientRect();
    if (x >= lr.left && x <= lr.right && y >= lr.top - 30 && y <= lr.bottom + 30) return { path: [y < lr.top ? 0 : tree.length], rect: lr, top: y < lr.top };
    return null;
  }
  function onListMove(e) {
    const d = listDrag; if (!d) return;
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      d.on = true; document.body.classList.add('dragging');
      d.ghost = el('div', 'bghost', d.src.name || describe(nodeAt(d.src.path))); document.body.appendChild(d.ghost);
      d.line = el('div', 'bline'); document.body.appendChild(d.line);
    }
    d.ghost.style.left = e.clientX + 12 + 'px'; d.ghost.style.top = e.clientY + 8 + 'px';
    d.ghost.style.display = 'none'; d.dst = dropTarget(e.clientX, e.clientY); d.ghost.style.display = '';
    if (d.dst && d.src.path && startsWith(d.dst.path, d.src.path)) d.dst = null;
    if (d.dst) {
      const r = d.dst.rect;
      Object.assign(d.line.style, { display: 'block', left: r.left + 'px', width: r.width + 'px', top: (d.dst.top ? r.top - 2 : r.bottom) + 'px' });
    } else d.line.style.display = 'none';
  }
  function endListDrag() {
    const d = listDrag; listDrag = null;
    removeEventListener('pointermove', onListMove); removeEventListener('pointerup', onListUp); removeEventListener('pointercancel', onListCancel);
    d?.ghost?.remove(); d?.line?.remove(); document.body.classList.remove('dragging');
    return d;
  }
  function onListUp() {
    const d = endListDrag(); if (!d) return;
    if (!d.on) { if (d.src.tpl) edit(() => { tree.push(template(d.src.tpl)); sel = [tree.length - 1]; }); return; }
    if (!d.dst) return;
    if (d.src.tpl) edit(() => { insert(d.dst.path, template(d.src.tpl)); sel = d.dst.path; });
    else move(d.src.path, d.dst.path);
  }
  function onListCancel() { endListDrag(); }
  function describe(n) {
    if (!n) return '';
    if (n.items) return `Repeat ${n.n}×`;
    return n.free ? `${fmtClock(n.d)} free` : `${fmtClock(n.d)} · ${showVal(n.a, n)}${n.a !== n.b ? '→' + showVal(n.b, n) : ''}${n.u === 'w' ? ' W' : '%'}`;
  }

  /* ---------- chart: draw, hit test, drag edges ---------- */
  function draw() {
    const [c, w, h] = fit(cv), f = ftp();
    const steps = flattenTree(tree), paths = flattenPaths(tree);
    let t = 0; for (const s of steps) { s.t0 = t; t += s.d; }
    const total = chartDrag?.total || t || 1;
    let mx = 0; for (const s of steps) if (!s.free) mx = Math.max(mx, stepWatts(s, 0, f), stepWatts(s, s.d, f));
    const yMax = chartDrag?.yMax || Math.max(mx * 1.08, f * 1.2);
    const X = v => v / total * w, Y = v => h - v / yMax * h;
    geom = { w, h, X, Y, steps, paths, total, yMax };
    drawBlocks(c, { steps }, f, X, Y, 0.9, 1, css);
    c.strokeStyle = 'rgba(255,255,255,.18)'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, Y(f)); c.lineTo(w, Y(f)); c.stroke(); c.setLineDash([]);
    if (sel) {
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
      steps.forEach((s, i) => { if (startsWith(paths[i], sel)) { const top = s.free ? Y(0.5 * f) : Math.min(Y(stepWatts(s, 0, f)), Y(stepWatts(s, s.d, f))); c.strokeRect(X(s.t0) + 0.75, top + 0.75, X(s.t0 + s.d) - X(s.t0) - 1.5, h - top - 1.5); } });
    }
    const hot = chartDrag || hover;
    if (hot) {
      const s = steps[hot.i]; if (s) {
        c.strokeStyle = css('--acc'); c.lineWidth = 3; c.beginPath();
        if (hot.kind === 'd') { c.moveTo(X(s.t0 + s.d), s.free ? Y(0.5 * f) : Y(stepWatts(s, s.d, f))); c.lineTo(X(s.t0 + s.d), h); }
        else if (hot.kind === 'p') { c.moveTo(X(s.t0), Y(stepWatts(s, 0, f))); c.lineTo(X(s.t0 + s.d), Y(stepWatts(s, s.d, f))); }
        c.stroke();
        if (chartDrag) {
          const lbl = s.free ? `${fmtClock(s.d)} free` : `${fmtClock(s.d)} · ${s.u === 'w' ? Math.round(s.a) + ' W' : Math.round(s.a * 100) + '%'} · ${stepWatts(s, 0, f)} W`;
          c.font = '600 12px system-ui, sans-serif'; const tw = c.measureText(lbl).width;
          const lx = Math.min(Math.max(4, X(s.t0)), w - tw - 12), ly = Math.max(16, (s.free ? Y(0.5 * f) : Y(stepWatts(s, 0, f))) - 8);
          c.fillStyle = 'rgba(12,14,17,.85)'; c.fillRect(lx - 4, ly - 13, tw + 8, 18); c.fillStyle = '#fff'; c.fillText(lbl, lx, ly);
        }
      }
    }
    c.lineWidth = 1;
  }
  function hit(e) {
    if (!geom) return null;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, { steps, X, Y } = geom, f = ftp();
    let best = null;
    steps.forEach((s, i) => {
      const x0 = X(s.t0), x1 = X(s.t0 + s.d);
      const top = s.free ? Y(0.5 * f) : Y(stepWatts(s, Math.max(0, Math.min(s.d, (x - x0) / (x1 - x0) * s.d)), f));
      if (Math.abs(x - x1) < 7 && y > Math.min(top, Y(stepWatts(s, s.d, f) || 0)) - 8) { const dd = Math.abs(x - x1); if (!best || dd < best.dd) best = { i, kind: 'd', dd }; }
      if (!s.free && x >= x0 && x <= x1 && Math.abs(y - top) < 9) { const dd = Math.abs(y - top) + 0.5; if (!best || dd < best.dd) best = { i, kind: 'p', dd }; }
      if (!best && x >= x0 && x < x1 && y > top) best = { i, kind: 'sel', dd: 99 };
    });
    return best;
  }
  const snapD = d => { const q = d < 120 ? 5 : d < 600 ? 15 : 30; return Math.max(5, Math.round(d / q) * q); };
  cv.onpointermove = e => {
    if (chartDrag) {
      const g = geom, s = nodeAt(chartDrag.path), dx = e.clientX - chartDrag.x0, dy = e.clientY - chartDrag.y0;
      if (Math.abs(dx) + Math.abs(dy) > 2) chartDrag.moved = true;
      if (chartDrag.kind === 'd') s.d = snapD(chartDrag.d0 + dx / g.w * g.total);
      else if (chartDrag.kind === 'p') {
        const dw = -dy / g.h * g.yMax;
        if (s.u === 'w') { const q = v => Math.max(0, Math.round((v + dw) / 5) * 5); s.a = q(chartDrag.a0); s.b = q(chartDrag.b0); }
        else { const q = v => Math.max(0, Math.round((v + dw / ftp()) * 100) / 100); s.a = q(chartDrag.a0); s.b = q(chartDrag.b0); }
      }
      if (chartDrag.moved) commit({ list: false });
      return;
    }
    const h = hit(e); const prev = hover; hover = h && h.kind !== 'sel' ? h : null;
    cv.style.cursor = !h ? '' : h.kind === 'd' ? 'ew-resize' : h.kind === 'p' ? 'ns-resize' : 'pointer';
    if (prev?.i !== hover?.i || prev?.kind !== hover?.kind) draw();
  };
  cv.onpointerleave = () => { if (!chartDrag && hover) { hover = null; draw(); } };
  cv.onpointerdown = e => {
    const h = hit(e); if (!h) { sel = null; markSel(); draw(); return; }
    const path = geom.paths[h.i]; sel = path; markSel();
    if (h.kind === 'sel') { draw(); scrollToSel(); return; }
    const s = nodeAt(path);
    snapshot();
    chartDrag = { kind: h.kind, i: h.i, path, x0: e.clientX, y0: e.clientY, d0: s.d, a0: s.a, b0: s.b, total: geom.total, yMax: geom.yMax, moved: false };
    cv.setPointerCapture?.(e.pointerId); e.preventDefault(); draw();
  };
  const endChart = () => {
    if (!chartDrag) return;
    const moved = chartDrag.moved; chartDrag = null;
    if (moved) commit(); else { undo.pop(); scrollToSel(); }
    draw();
  };
  cv.onpointerup = endChart; cv.onpointercancel = endChart;
  function scrollToSel() { if (!sel || !list.querySelector) return; list.querySelector(`.brow[data-p="${pkey(sel)}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }

  return {
    // Take text typed or loaded from outside. Bad text keeps the last good blocks.
    load(t) {
      if (t === text) return true;
      try { tree = parseTree(t); text = t; sel = null; renderList(); return true; } catch { return false; }
    },
    undo() { if (!undo.length) return false; tree = parseTree(undo.pop()); sel = null; commit(); return true; },
    draw,
  };
}
