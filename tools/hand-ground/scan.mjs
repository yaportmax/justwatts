// Whole-network ground and object scan (lead, 2026-11-09). No pictures: the scene's own triangles.
//   node netscan.mjs <port> --lines=link,tam,head,conz [--step=60] [--from=S] [--to=S] [--out=file.jsonl] [--half=48]
// At a stop every <step> m along every road line the page's rider is hopped there (h.js hop), the load settles, and
// every visible ground triangle within <half> m is sampled on a 1 m grid from above, by kind:
//   G generated ground (attribute mk), H hand terrain / verge / lot, R road surfaces (hand road*, generated ruv)
// Counted per stop:
//   hole     a cell with no G, H or R over it (nothing drawn: the sea plane or the sky shows)
//   zfight   G and H both there within 0.25 m of each other, or G above H (two grounds in one place)
//   buried   a road surface with G or H more than 0.08 m above it (ground through the road)
//   bored    ... over 3 m above a generated tunnel's floor (a mesh under the group 'tunnels'): the hill over the bore, not counted as buried
//   seam     neighbouring cells whose top ground comes from different meshes and whose heights break by over 0.6 m
//            more than the slope on either side carries (a crack or a step between two grounds)
//   float    an instanced object (tree, pole, lamp, prop, plant) whose foot is over 0.4 m above the top surface under it (not the tunnels' fixtures: they hang)
//   sunk     ... or over 1.5 m under it
//   onroad   an instanced object standing on a road surface (within 2 m of its height)
//   lean     an instanced object more than 12 degrees off vertical
// One JSON line per stop; a summary line at the end.
const { chromium } = await import(process.env.JW_PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2), opt = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || d;
const port = args.find(a => !a.startsWith('--')), STEP = +opt('step', 60), HALF = +opt('half', 48), OUT = opt('out', 'netscan.jsonl');
const S0 = +opt('from', -1), S1 = +opt('to', 1e12), want = opt('lines', 'link,tam').split(',');
const roads = JSON.parse(readFileSync(opt('file',new URL('./lines.json',import.meta.url)), 'utf8'));
const stops = [];
for (const r of roads) { let last = -1e9; for (const [st, la, lo, hd] of r.line) if (st >= S0 && st <= S1 && st - last >= STEP) { stops.push([r.name, st, la, lo, hd]); last = st; } }
{ const SK = +opt('skip', 0), MX = +opt('max', 1e9); stops.splice(0, SK); if (stops.length > MX) stops.length = MX; }  // (--skip=N --max=M: a slice of the stops, for runs in parts: gate.sh)
console.error(`${stops.length} stops on ${roads.length} roads`);
writeFileSync(OUT, '');
writeFileSync(OUT+'.args.json',JSON.stringify(args));
const b = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
let page = null;
async function fresh(la, lo, hd, extra = []) {
  if (page) await page.close().catch(() => {});
  page = await b.newPage({ viewport: { width: 200, height: 120 } });
  page.on('pageerror', e => console.error('PAGEERROR', String(e).slice(0, 200)));
  await page.addInitScript(fl => { globalThis.__w3 = { budget: 60 }; for (const f of fl) globalThis.__w3[f] = true; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => setTimeout(() => raf(cb), 70); }, opt('w3', '').split(',').filter(Boolean).concat(extra));  // (--w3=flag,flag: debug switches set in __w3; about 12 frames a second: the scan reads geometry, the picture does not matter, the GPU stays free for the lanes)
  await page.goto(`http://127.0.0.1:${port}/__h/index.html`); await page.waitForFunction(() => !!window.__h);
  await page.evaluate(async audits=>{window.__mount=await import('/__h/mounted.js');window.__surfaceEffect=await import('/__h/surface-effect.js');window.__auditAttachments=audits.includes('attachments');window.__auditEffects=audits.includes('effects');},opt('audit','').split(','));
  await page.evaluate(a => window.__h.fly(...a), [la, lo, hd, { time: 'day', quality: +opt('q', 0) }]);
}
const settled = (timeout = 180000) => page.waitForFunction(() => { const s = window.__h.stats(); return s?.ready && s.jobs === 0 && s.wait.handHere && !s.wait.handBusy && !s.wait.plantsBusy; }, null, { timeout: Math.max(1000, Math.min(timeout, 460000 - (Date.now() - t0))) }).then(() => true, () => false);
const scan = ([la, lo, HALF]) => {
  const D = window.__h.dbg(), [cx, cz] = D.xz ? D.xz(la, lo) : [0, 0];
  const C = 0.5, N = Math.round(2 * HALF / C), X0 = cx - HALF, Z0 = cz - HALF, X1 = cx + HALF, Z1 = cz + HALF;
  const top = { G: new Float32Array(N * N).fill(-1e9), H: new Float32Array(N * N).fill(-1e9), R: new Float32Array(N * N).fill(-1e9), F: new Float32Array(N * N).fill(-1e9), K: new Float32Array(N * N).fill(-1e9), Ht: new Float32Array(N * N).fill(-1e9), Hv: new Float32Array(N * N).fill(-1e9) }, who = { G: new Int32Array(N * N).fill(-1), H: new Int32Array(N * N).fill(-1), R: new Int32Array(N * N).fill(-1), K: new Int32Array(N * N).fill(-1) }, rk = new Float32Array(N * N).fill(-1), rw = new Float32Array(N * N), tunc = new Uint8Array(N * N), grounds = [], banks = [], c1 = new Int32Array(N * N).fill(-1), c2 = new Int32Array(N * N).fill(-1), y1 = new Float32Array(N * N).fill(-1e9), y2 = new Float32Array(N * N).fill(-1e9);
  const shown = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const under = (o, n) => { for (let p = o.parent; p; p = p.parent) if (p.name === n) return true; return false; };
  const box = new D.THREE.Box3(); let mid = 0, tris = 0; const inst = [], sigs = [];
  D.scene.traverse(o => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const A = o.geometry.attributes, hand = under(o, 'hand');
    if (o.isInstancedMesh) { if (o.count > 0 && o.instanceMatrix && shown(o) && o.material?.name !== 'jwLampPool' && !A.gA) inst.push(o); return; }
    if (!shown(o)) return;
    const cat = hand ? (/^(terrain|verge|lot)/.test(o.name) ? 'H' : /^road/.test(o.name) ? 'R' : 'K') : A.mk ? 'G' : A.ruv ? 'R' : null;   /* (K: the hand build's other solid meshes, a kerb, a wall, a deck: a cell with no ground under one is covered, not open) */
    if (A.gv) banks.push(o);
    if (!cat) return;
    const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox(); box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    if (box.max.x < X0 || box.min.x > X1 || box.max.z < Z0 || box.min.z > Z1) return;
    grounds.push(o); const RDa = cat === 'R' ? A.rd : null, tn = cat === 'R' && under(o, 'tunnels') ? 1 : 0;   /* (a generated tunnel's floor: the hill over it is not ground through a road) */ const P = A.position, I = g.index, e = o.matrixWorld.elements, n = I ? I.count : P.count, d0 = g.drawRange.start || 0, d1 = Math.min(n, d0 + (g.drawRange.count ?? Infinity)), T = top[cat], Wm = who[cat], id = mid++; sigs[id] = (o.name || '') + '<' + (o.parent?.name || '') + '|' + Object.keys(A).join(',');
    const hsub = cat === 'H' ? (/^(verge|lot)/.test(o.name) ? top.Hv : top.Ht) : null;   /* (the hand ground's two layers: its terrain, and its verges and lots) */
    const ch = cat === 'H' ? +(/^(?:terrain|verge|lot)(\d+)/.exec(o.name)?.[1] ?? -1) : -1;   /* (the hand chunk the ground is of) */
    const v = new Float64Array(9), f0 = cat === 'G' ? o.userData.floor0 ?? Infinity : Infinity;
    for (let t = d0; t + 2 < d1; t += 3) {
      const fl = t >= f0;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let k = 0; k < 3; k++) { const i = I ? I.getX(t + k) : t + k, x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        v[3 * k] = wx; v[3 * k + 1] = wy; v[3 * k + 2] = wz; if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wz < z0) z0 = wz; if (wz > z1) z1 = wz; }
      if (x1 < X0 || x0 > X1 || z1 < Z0 || z0 > Z1) continue;
      tris++;
      const den = (v[5] - v[8]) * (v[0] - v[6]) + (v[6] - v[3]) * (v[2] - v[8]); if (Math.abs(den) < 1e-9) continue;
      const i0 = Math.max(0, Math.ceil((x0 - X0) / C - 0.5)), i1 = Math.min(N - 1, Math.floor((x1 - X0) / C - 0.5)), j0 = Math.max(0, Math.ceil((z0 - Z0) / C - 0.5)), j1 = Math.min(N - 1, Math.floor((z1 - Z0) / C - 0.5));
      for (let j = j0; j <= j1; j++) { const pz = Z0 + (j + 0.5) * C; for (let i = i0; i <= i1; i++) { const px = X0 + (i + 0.5) * C;
        const a = ((v[5] - v[8]) * (px - v[6]) + (v[6] - v[3]) * (pz - v[8])) / den, bb = ((v[8] - v[2]) * (px - v[6]) + (v[0] - v[6]) * (pz - v[8])) / den, c = 1 - a - bb;
        if (a < -1e-6 || bb < -1e-6 || c < -1e-6) continue;
        const y = a * v[1] + bb * v[4] + c * v[7], k = j * N + i; if (hsub && y > hsub[k]) hsub[k] = y; if (ch >= 0) { if (ch === c1[k]) { if (y > y1[k]) y1[k] = y; } else if (ch === c2[k]) { if (y > y2[k]) { y2[k] = y; if (y > y1[k]) { const tc = c1[k], ty = y1[k]; c1[k] = ch; y1[k] = y; c2[k] = tc; y2[k] = ty; } } } else if (y > y1[k]) { c2[k] = c1[k]; y2[k] = y1[k]; c1[k] = ch; y1[k] = y; } else if (y > y2[k]) { c2[k] = ch; y2[k] = y; } } if (fl) { if (y > top.F[k]) top.F[k] = y; } else if (y > T[k]) { T[k] = y; Wm[k] = id; if (cat === 'R') { const i0v = I ? I.getX(t) : t; rk[k] = RDa ? RDa.getY(i0v) : 0; rw[k] = RDa ? RDa.getW(i0v) : 9; tunc[k] = tn; } } } }
    }
  });
  const ll = (x, z) => [+D.lat(z).toFixed(6), +D.lon(x).toFixed(6)];
  const out = { cells: N * N, tris, pit: 0, pitc: 0, pitBy: {}, pits: [], hole: 0, zfight: 0, gOver: 0, coplanar: 0, hfight: 0, hOver: 0, xrun: 0, xrunF: 0, xself: 0, xselfF: 0, xadj: 0, xadjF: 0, xr: [], xby: {}, hf: [], hd: [0, 0, 0, 0, 0, 0, 0, 0, 0], zfBy: {}, burBy: {}, buried: 0, bored: 0, seam: 0, holes: [], zf: [], bur: [], seams: [], float: [], sunk: [], onroad: [], lean: [], inst: 0 };
  const E = -1e8, surf = new Float32Array(N * N), sw = new Int32Array(N * N);
  for (let k = 0; k < N * N; k++) { const g = top.G[k], h = top.H[k], r = top.R[k], x = X0 + (k % N + 0.5) * C, z = Z0 + (Math.floor(k / N) + 0.5) * C;
    const gh = Math.max(g, h); surf[k] = Math.max(gh, r); sw[k] = gh >= r ? (g >= h ? who.G[k] : 100000 + who.H[k]) : 200000 + who.R[k];
    if (g < E && h < E && r < E) { if (top.K[k] > E) { out.pitc++; const sg = (sigs[who.K[k]] || '').split('<')[0].replace(/\d+/g, '#'); out.pitBy[sg] = (out.pitBy[sg] || 0) + 1; } else if (top.F[k] > E) { out.pit++; if (out.pits.length < 12 && (out.pit % 23 === 1)) out.pits.push(ll(x, z)); } else { out.hole++; if (out.holes.length < 12 && (out.hole % 23 === 1)) out.holes.push(ll(x, z)); } continue; }
    if (g > E && h > E && (g > h - 0.25)) { out.zfight++; if (g > h + 0.05) out.gOver++; else if (g > h - 0.05) out.coplanar++; { const sg = sigs[who.G[k]]; out.zfBy[sg] = (out.zfBy[sg] || 0) + 1; } if (out.zf.length < 8 && out.zfight % 9 === 1) out.zf.push([...ll(x, z), +(g - h).toFixed(2)]); }
    { const ht = top.Ht[k], hv = top.Hv[k]; if (ht > E && hv > E) { const d = ht - hv; out.hd[d < -0.5 ? 0 : d < -0.25 ? 1 : d < -0.12 ? 2 : d < -0.08 ? 3 : d < -0.04 ? 4 : d < 0 ? 5 : d < 0.04 ? 6 : d < 0.12 ? 7 : 8]++;
      if (d > -0.08) { out.hfight++; if (d > 0.03) out.hOver++; if (out.hf.length < 8 && out.hfight % 9 === 1) out.hf.push([...ll(x, z), +d.toFixed(2)]); } } }
    if (c2[k] >= 0) { const d = y1[k] - y2[k], S = window.__chS0 || {}, ra = Math.floor((S[c1[k]] ?? -1) / 10000), rb = Math.floor((S[c2[k]] ?? -2) / 10000), kind = ra !== rb ? 'xrun' : Math.abs(c1[k] - c2[k]) > 1 ? 'xself' : 'xadj';
      if (d < 3) { out[kind]++; if (d < 0.25) out[kind + 'F']++; if (kind !== 'xadj') { const pk = Math.min(c1[k], c2[k]) + '+' + Math.max(c1[k], c2[k]); out.xby[pk] = (out.xby[pk] || 0) + 1; if (out.xr.length < 8 && (out.xrun + out.xself) % 97 === 1) out.xr.push([...ll(x, z), +d.toFixed(2), c1[k], c2[k]]); } } }
    if (r > E && gh > r + 3 && tunc[k]) out.bored++;
    else if (r > E && gh > r + 0.08) { out.buried++; { const sg = (g >= h ? 'G ' + sigs[who.G[k]] : 'H') + ' over road surf ' + rk[k] + ' w ' + Math.round(rw[k]) + (gh > r + 0.3 ? ' deep' : ' thin'); out.burBy[sg] = (out.burBy[sg] || 0) + 1; } if (out.bur.length < 8 && out.buried % 17 === 1) out.bur.push([...ll(x, z), +(gh - r).toFixed(2), g >= h ? 'G' : 'H']); }
  }
  // seams: a break between two different top meshes that neither side's own slope explains
  const brk = (k, s) => { const a = surf[k], b2 = surf[k + s]; if (a < E || b2 < E || sw[k] === sw[k + s]) return 0; const pa = surf[k - s], pb = surf[k + 2 * s];
    const ga = pa > E && sw[k - s] === sw[k] ? a - pa : 0, gb = pb > E && sw[k + 2 * s] === sw[k + s] ? pb - b2 : 0, d = b2 - a, ex = Math.min(Math.abs(d - ga), Math.abs(d - gb)); return ex > 0.6 ? ex : 0; };
  for (let j = 2; j < N - 2; j++) for (let i = 2; i < N - 2; i++) { const k = j * N + i, e1 = brk(k, 1), e2 = brk(k, N), ex = Math.max(e1, e2); if (ex) { out.seam++; if (out.seams.length < 10 && out.seam % 6 === 1) out.seams.push([...ll(X0 + (i + 0.5) * C, Z0 + (j + 0.5) * C), +ex.toFixed(2), Math.floor(sw[k] / 100000) + '' + Math.floor(sw[k + (e1 ? 1 : N)] / 100000)]); } }
  // a road's edge: the ground in the cell beside a road cell (no road over that one). hover: the ground there over 0.35 m under the road (its side or underside
  // shows, no bank up to it); wall: over 0.6 m above it (a sheer step up at the paving's edge); edgeHole: nothing drawn there at all
  out.hover = 0; out.wall = 0; out.edgeHole = 0; out.edge = 0; out.hovers = []; out.walls = []; out.hovBy = {};
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) { const k = j * N + i, r = top.R[k]; if (r < E || Math.max(top.G[k], top.H[k]) > r + 0.08) continue;
    for (const s of [1, -1, N, -N]) { const n = k + s; if (top.R[n] > E) continue; const gn = Math.max(top.G[n], top.H[n]); out.edge++;
      if (gn < E) out.edgeHole++;
      else if (gn < r - 0.35) { out.hover++; const sg = (top.G[n] >= top.H[n] ? 'G' : 'H') + ' beside road surf ' + rk[k] + ' w ' + Math.round(rw[k]) + (under(grounds[who.R[k]] ?? {}, 'hand') ? ' hand' : ' gen'); out.hovBy[sg] = (out.hovBy[sg] || 0) + 1; if (out.hovers.length < 10 && out.hover % 7 === 1) out.hovers.push([...ll(X0 + (i + 0.5) * C, Z0 + (j + 0.5) * C), +(r - gn).toFixed(2)]); }
      else if (gn > r + 0.6) { out.wall++; if (out.walls.length < 10 && out.wall % 7 === 1) out.walls.push([...ll(X0 + (i + 0.5) * C, Z0 + (j + 0.5) * C), +(gn - r).toFixed(2), top.G[n] >= top.H[n] ? 'G' : 'H']); } } }
  // instanced objects
  const m4 = new D.THREE.Matrix4(), seen = new Set(), ray = new D.THREE.Raycaster(), dn = new D.THREE.Vector3(0, -1, 0), o3 = new D.THREE.Vector3();
  const exact = (x, z) => { ray.set(o3.set(x, 4000, z), dn); const h = ray.intersectObjects(grounds, false); return h.length ? h[0].point.y : null; };
  for (const o of inst) {
    const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox(); const hgt = +(g.boundingBox.max.y - g.boundingBox.min.y).toFixed(1), ymin = g.boundingBox.min.y;
    let par = ''; for (let p = o.parent; p && !par; p = p.parent) par = p.name || '';
    const sig = `${par || '-'}|${o.material?.name || o.material?.type}|${Object.keys(g.attributes).join(',')}|h${hgt}`;
    for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld); const e = m4.elements, x = e[12], z = e[14];
      if (x < X0 + 1 || x > X1 - 1 || z < Z0 + 1 || z > Z1 - 1) continue;
      const sy = Math.hypot(e[4], e[5], e[6]); if (sy < 1e-6) continue;  // (a hidden instance: zero scale)
      const y = e[13], key = `${Math.round(x * 4)}_${Math.round(z * 4)}`; if (seen.has(key)) continue; seen.add(key);
      out.inst++;
      const k = Math.floor((z - Z0) / C) * N + Math.floor((x - X0) / C), s = surf[k], r = top.R[k], tilt = Math.acos(Math.min(1, Math.abs(e[5]) / sy)) * 180 / Math.PI;
      const row = [...ll(x, z), sig];
      const floatBefore=out.float.length,onroadBefore=out.onroad.length;
      if (s > E && (y - s > 0.3 || s - y > 1.2)) { const ey = exact(x, z); if (par === 'handVeg' && ey != null && y-ey > 0.4) { ray.set(o3.set(x,4000,z),dn); const bank=ray.intersectObjects(banks,false)[0]?.point.y??null; (out.floatEvidence??=[]).push({at:ll(x,z),x,y,z,support:ey,bank,probe:D.probe(x,z),hand:D.hand(x,z),quad:D.quad(x,z),mesh:o.name}); } if (ey != null && y - ey > 0.4 && par !== 'tunnels') out.float.push([...row, +(y - ey).toFixed(2)]); else if (ey != null && ey - y > 1.5 && hgt * sy > 0.5) out.sunk.push([...row, +(ey - y).toFixed(2)]); }
      if (r > E && Math.abs(y - r) < 2 && top.G[k] < r + 0.3 && top.H[k] < r + 0.3) {
        out.onroad.push([...row, +(hgt * sy).toFixed(1), rk[k], +rw[k].toFixed(1)]);
        ray.set(o3.set(x,4000,z),dn);
        const hits=ray.intersectObjects(grounds.filter(m=>m.geometry.attributes.ruv||/^road/.test(m.name)),false);
        (out.onroadEvidence??=[]).push({x,y,z,at:ll(x,z),gridRoad:r,gridWidth:rw[k],hits:hits.slice(0,6).map(h=>{
          const g=h.object.geometry,p=g.attributes.position,rd=g.attributes.rd;
          return {name:h.object.name,parent:h.object.parent?.name,height:h.point.y,width:rd?.getW(h.face.a),triangle:[h.face.a,h.face.b,h.face.c].map(i=>new D.THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(h.object.matrixWorld).toArray())};
        })});
      }
      if (tilt > 12) out.lean.push([...row, +tilt.toFixed(0)]);
      if(out.onroad.length>onroadBefore&&window.__surfaceEffect.isSurfaceEffect(o,m4)){
        (out.surfaceEffectEvidence??=[]).push({at:ll(x,z),x,y,z,signature:sig,verticalExtent:g.boundingBox.max.y-g.boundingBox.min.y});
        if(window.__auditEffects)(out.auditExclusions??=[]).push({kind:'onroad',row:out.onroad.pop(),reason:'horizontal textured surface effect has no obstacle height'});
      }
      if(par!=='handVeg'&&(out.float.length>floatBefore||out.onroad.length>onroadBefore)){
        const attached=window.__mount.attachmentAt(D,o,m4,grounds.filter(m=>m.geometry.attributes.ruv||/^road/.test(m.name)));
        const addedFloat=out.float.length>floatBefore,addedOnroad=out.onroad.length>onroadBefore;
        (out.attachmentEvidence??=[]).push({at:ll(x,z),x,y,z,signature:sig,mesh:o.name,minY:ymin,attached,flags:{float:addedFloat,onroad:addedOnroad}});
        if(window.__auditAttachments&&attached){
          if(addedFloat){(out.auditExclusions??=[]).push({kind:'float',row:out.float.pop(),reason:'base supported by opaque assembly member'});}
          if(addedOnroad&&!attached.onPaving){(out.auditExclusions??=[]).push({kind:'onroad',row:out.onroad.pop(),reason:'mounted base does not contact paving'});}
        }
      }
    }
  }
  return out;
};
const tot = { stops: 0, failed: 0, cells: 0, pit: 0, hole: 0, zfight: 0, gOver: 0, hfight: 0, hOver: 0, xrun: 0, xrunF: 0, xself: 0, xselfF: 0, xadj: 0, xadjF: 0, bored: 0, buried: 0, seam: 0, hover: 0, wall: 0, edgeHole: 0, edge: 0, float: 0, sunk: 0, onroad: 0, lean: 0, inst: 0 }, byRoad = {};
let here = null, t0 = Date.now();
for (const [name, st, la, lo, hd] of stops) {
  if (Date.now()-t0 > +opt('seconds', 340)*1000) break;
  try {
    if (!page || !here || Math.hypot((la - here[0]) * 111195, (lo - here[1]) * 87830) > 1500) await fresh(la, lo, hd); else await page.evaluate(a => window.__h.hop(...a), [la, lo, hd]);
    here = [la, lo]; await page.waitForTimeout(250);
    let ok = await settled(); if (!ok && Date.now()-t0 >= 450000) { console.error('DEFERRED at turn deadline', name, st); break; } await page.waitForTimeout(300);
    await page.evaluate(async () => { if (!window.__chS0) { const J = await (await fetch('/world/hand/conz.json')).json(); const S = {}; for (const c of J.chunks) S[c.i] = c.s0; window.__chS0 = S; } });
    let r;
    for(let attempt=0;attempt<3;attempt++){
    if(attempt){
      // A tile can enqueue work between measurement calls. Keep the rejected evidence and resample this stop.
      appendFileSync(OUT+'.unsettled.jsonl',JSON.stringify({attempt,reason:'load changed during measurement',row:r})+'\n');
      console.error('RECAPTURE',name,st,'attempt',attempt+1);
      await page.evaluate(()=>{window.__seatSeen=new Set();window.__supportChecked=false;});
      ok=await settled();await page.waitForTimeout(300);
    }
    r = await page.evaluate(scan, [la, lo, HALF]);
    if (ok) {
      const broad = await page.evaluate(async at => { window.__seatAt=at; const {captureSupport,checkSupport}=await import('/__h/support.js'); const D=window.__h.dbg(),result=captureSupport(D); if (!window.__supportChecked && result.points.length) { result.check=checkSupport(D,result.points); window.__supportChecked=true; } return result; }, [la,lo]);
      r.supportFeet=broad.points; r.supportCost={ms:broad.ms,triangles:broad.triangles,version:broad.version}; if (broad.check) r.supportCheck=broad.check;
      r.pavingFeet=broad.paving; r.pavingVersion=broad.pavingVersion;
    }
    r.road = name; r.st = st; r.at = [la, lo]; r.settled = ok; r.loadStats = await page.evaluate(() => window.__h.stats());
    r.settledBefore=ok;r.settled=ok&&r.loadStats.ready&&r.loadStats.jobs===0&&r.loadStats.wait.handHere&&!r.loadStats.wait.handBusy&&!r.loadStats.wait.plantsBusy;
    r.measurementAttempts=attempt+1;
    if(r.settled||Date.now()-t0>=420000)break;
    }
    if(!r.settled&&Date.now()-t0>=420000){
      appendFileSync(OUT+'.unsettled.jsonl',JSON.stringify({reason:'turn deadline during measurement',row:r})+'\n');
      console.error('DEFERRED after measurement at turn deadline',name,st);break;
    }
    appendFileSync(OUT, JSON.stringify(r) + '\n');
    const B = byRoad[name] ??= { stops: 0, hole: 0, zfight: 0, buried: 0, seam: 0, float: 0, sunk: 0, onroad: 0, lean: 0 };
    tot.stops++; B.stops++; tot.cells += r.cells; tot.inst += r.inst;
    for (const k of ['hole', 'zfight', 'buried', 'seam']) { tot[k] += r[k]; B[k] += r[k]; }
    for (const k of ['pit', 'gOver', 'hover', 'wall', 'edgeHole', 'edge', 'hfight', 'hOver', 'bored', 'xrun', 'xrunF', 'xself', 'xselfF', 'xadj', 'xadjF']) { tot[k] += r[k]; B[k] = (B[k] || 0) + r[k]; }
    for (const k of ['float', 'sunk', 'onroad', 'lean']) { tot[k] += r[k].length; B[k] += r[k].length; }
    if (tot.stops % 10 === 0) console.error(`${tot.stops}/${stops.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ${name} ${st} pit ${tot.pit} hole ${tot.hole} zf ${tot.zfight} gOver ${tot.gOver} hf ${tot.hfight} hOver ${tot.hOver} xrun ${tot.xrun}/${tot.xrunF} xself ${tot.xself}/${tot.xselfF} bur ${tot.buried} hover ${tot.hover} wall ${tot.wall} seam ${tot.seam} float ${tot.float} onroad ${tot.onroad} lean ${tot.lean}`);
  } catch (e) { tot.failed++; console.error('FAILED', name, st, String(e).slice(0, 160)); page = null; }
}
console.log(JSON.stringify({ tot, byRoad }));
appendFileSync(OUT, JSON.stringify({ summary: tot, byRoad }) + '\n');
await b.close();
