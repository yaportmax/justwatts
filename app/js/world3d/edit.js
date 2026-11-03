// World 3D: a dev-only live edit API (A17), window.__edit when the page asks for it (globalThis.__w3 = { edit: true } before
// the view starts). Hand-authored data is placed straight into the running scene: the near tiles' affected parts are
// rebuilt (roads, furniture, trees ...), nothing is baked or reloaded. Kinds are registered by whoever owns the data:
// conzelman.js's spec (section, rail, lot, walk) here; vegetation (veg.js) registers its own (tree, area ...).
//   __edit.kinds()                       the registered kinds
//   __edit.place({ kind, ...fields })    -> id
//   __edit.move(id, { ...fields })       a patch merged into the item
//   __edit.remove(id)
//   __edit.list(kind?)                   [{ id, kind, ...fields }]
//   __edit.save(kind?)                   the data as JSON text, to write back to its file (per kind's owner: { file, text })
//   __edit.at(lat, lon) / __edit.ll(station, offset)   Conzelman's station and offset (right of its line, looking ahead)
//   __edit.load({ SECTIONS, RAILS, LOTS, CROSSWALKS })    the spec replaced (a saved one into a new page)
// ctx: { rebuild(parts: ['roads', 'furn', 'trees', ...]) (the near tiles' parts built again), proj, spec, applySpec() }
export function createEdit(ctx) {
  const kinds = new Map();
  const api = {
    register(kind, h) { kinds.set(kind, h); },
    kinds: () => [...kinds.keys()],
    place(o) { const h = kinds.get(o.kind); if (!h) throw new Error(`no kind ${o.kind}`); return `${o.kind}:${h.place(o)}`; },
    move(id, patch) { const [k, i] = split(id); kinds.get(k).move(i, patch); return id; },
    remove(id) { const [k, i] = split(id); kinds.get(k).remove(i); return true; },
    list: kind => [...kinds].filter(([k]) => !kind || k === kind).flatMap(([k, h]) => h.list().map(o => ({ ...o, id: `${k}:${o.id}`, kind: k }))),
    save: kind => [...new Set([...kinds].filter(([k]) => !kind || k === kind).map(([, h]) => h.save))].map(f => f()),
    at: (la, lo) => { const [x, z] = ctx.proj.xz(la, lo), q = ctx.cz().at(x, z); return q && { s: +q.s.toFixed(2), d: +q.d.toFixed(2) }; },
    ll: (s, d = 0) => { const C = ctx.cz(), [la, lo] = C.latlon(s), [la2, lo2] = C.latlon(s + 1), [x, z] = ctx.proj.xz(la, lo), [x2, z2] = ctx.proj.xz(la2, lo2), l = Math.hypot(x2 - x, z2 - z) || 1;
      const px = x + (-(z2 - z) / l) * d, pz = z + ((x2 - x) / l) * d; return [+ctx.proj.lat(pz).toFixed(7), +ctx.proj.lon(px).toFixed(7)]; },
    rebuild: parts => ctx.rebuild(parts),
  };
  const split = id => { const k = id.indexOf(':'); return [id.slice(0, k), id.slice(k + 1)]; };
  // Conzelman's spec (conzelman.js): its arrays edited in place, then compiled again and the roads and furniture rebuilt
  const S = ctx.spec, fields = { section: S.SECTIONS, rail: S.RAILS, lot: S.LOTS, walk: S.CROSSWALKS };
  // (rails, lots and walks are arrays in the file; here as objects)
  const toObj = { rail: ([s0, s1, side, type, src]) => ({ s0, s1, side, type, src }), lot: ([ring, surface, src]) => ({ ring, surface, src }), walk: s => ({ s }), section: q => ({ ...q }) };
  const toRow = { rail: o => [o.s0, o.s1, o.side, o.type, o.src || []], lot: o => [o.ring, o.surface ?? 0, o.src || []], walk: o => o.s, section: o => { const q = { ...o }; delete q.kind; delete q.id; return q; } };
  const save = () => ({ file: 'app/js/world3d/conzelman.js (SECTIONS, RAILS, LOTS, CROSSWALKS)', text: JSON.stringify({ SECTIONS: S.SECTIONS, RAILS: S.RAILS, LOTS: S.LOTS, CROSSWALKS: S.CROSSWALKS }, null, 1) });
  // the whole spec replaced (a saved one put back into a new page): { SECTIONS, RAILS, LOTS, CROSSWALKS }
  api.load = d => { for (const [k, arr] of [['SECTIONS', S.SECTIONS], ['RAILS', S.RAILS], ['LOTS', S.LOTS], ['CROSSWALKS', S.CROSSWALKS]]) if (d[k]) arr.splice(0, arr.length, ...d[k]); ctx.applySpec(); return true; };
  for (const [kind, arr] of Object.entries(fields)) api.register(kind, {
    place(o) { const r = toRow[kind](o); arr.push(r); if (kind === 'section') arr.sort((a, b) => a.s - b.s); ctx.applySpec(); return arr.indexOf(r); },
    move(i, p) { const o = { ...toObj[kind](arr[+i]), ...p }; arr[+i] = toRow[kind](o); if (kind === 'section') arr.sort((a, b) => a.s - b.s); ctx.applySpec(); },
    remove(i) { arr.splice(+i, 1); ctx.applySpec(); },
    list: () => arr.map((r, i) => ({ id: i, ...toObj[kind](r) })),
    save,
  });
  return api;
}
