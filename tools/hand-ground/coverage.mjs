import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const evidenceOpt=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
import {readFileSync as read,writeFileSync as write,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {activePlants} from './active-plants.mjs';
import {settledRow} from './settled-row.mjs';
const APP=resolve(evidenceOpt('app',fileURLToPath(new URL('../../app',import.meta.url)))),DIR=resolve(evidenceOpt('samples',process.cwd()))+'/';
const CELL=+(process.argv.find(a=>a.startsWith('--cell='))?.slice(7)||400);
const {makeProj}=await import('file:///'+APP+'/js/world3d/geo.js'),P=makeProj(37.93,-122.63);
const activeAt=await activePlants(APP);
const V=JSON.parse(read(APP+'/world/hand/veg.json')),seen=[new Set(),new Set()],paving=[new Set(),new Set()],close=[new Set(),new Set()],minimum=new Map(),DROP=new Set(['brush','brushg','mat_o','mat_g','mat_l','mat_d','mat_r']),inputs=[],hash=b=>createHash('sha256').update(b).digest('hex');
for(const f of readdirSync(DIR).filter(f=>/^before_.*_q[03]_\d+\.jsonl$/.test(f)).sort()){
 const q=/_q0_/.test(f)?0:1;
 const bytes=read(DIR+f);inputs.push({file:f,sha256:hash(bytes)});
 for(const l of bytes.toString('utf8').trim().split('\n').filter(Boolean)){
  const r=JSON.parse(l);if(!settledRow(r))continue;
  const [cx,cz]=P.xz(...r.at);
  for(const [x,,z,g,b]of [...(r.feet||[]),...(r.supportCost?.version===2?r.supportFeet||[]:[])])if(g!=null||b!=null){const key=x+','+z,s=Math.max(g??-Infinity,b??-Infinity);seen[q].add(key);minimum.set(key,Math.min(minimum.get(key)??Infinity,s));if(Math.hypot(x-cx,z-cz)<=70)close[q].add(key);}
  if(r.pavingVersion===1)for(const [x,,z]of r.pavingFeet||[])paving[q].add(x+','+z);
 }
}
let active=0;const missing=[[],[]],pavingMissing=[[],[]],closeMissing=[[],[]],bySpecies={};
for(const G of V.groups){const b=read(APP+'/world/hand/'+G.file),a=new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));let off=0;
 for(const [sp,n]of Object.entries(G.species)){
  const stride=V.stride?.[sp]||7;if(!DROP.has(sp))for(let i=0;i<n;i++){
   const o=off+i*stride,x=a[o],z=a[o+2],key=x+','+z;if(!activeAt(sp,x,z))continue;active++;
   for(let q=0;q<2;q++)if(!seen[q].has(key)){missing[q].push({x,z,key,file:G.file,sp,i});(bySpecies[sp]??=[0,0])[q]++;}
   for(let q=0;q<2;q++)if(!paving[q].has(key))pavingMissing[q].push({x,z,key,file:G.file,sp,i});
   if(a[o+1]-(minimum.get(key)??Infinity)>1)for(let q=0;q<2;q++)if(!close[q].has(key))closeMissing[q].push({x,z,key,file:G.file,sp,i});
  }off+=n*stride;
 }
}
const counts=[];
for(let q=0;q<2;q++){
 const cells=new Map();for(const p of [...missing[q],...pavingMissing[q]]){const k=Math.floor(p.x/CELL)+','+Math.floor(p.z/CELL);(cells.get(k)??cells.set(k,[]).get(k)).push(p);}
 const lines=[];for(const [k,points]of cells){const [ix,iz]=k.split(',').map(Number),x=(ix+0.5)*CELL,z=(iz+0.5)*CELL;lines.push({name:'Support'+CELL+' '+k,line:[[9000000+ix*10000+iz,P.lat(z),P.lon(x),0]]});}
 const nearCells=new Set(closeMissing[q].map(p=>Math.floor(p.x/80)+','+Math.floor(p.z/80)));
 for(const k of nearCells){const [ix,iz]=k.split(',').map(Number);lines.push({name:'SupportClose80 '+k,line:[[9000000+ix*10000+iz,P.lat((iz+0.5)*80),P.lon((ix+0.5)*80),0]]});}
 // Keep derived probes spatially adjacent to avoid needless cold scene rebuilds between GPU turns.
 const pending=lines.map(line=>({line,p:P.xz(line.line[0][1],line.line[0][2])})),ordered=[];let at=pending[0]?.p;
 while(pending.length){let best=0,distance=Infinity;for(let i=0;i<pending.length;i++){const p=pending[i].p,d=(p[0]-at[0])**2+(p[1]-at[1])**2;if(d<distance){distance=d;best=i;}}const next=pending.splice(best,1)[0];ordered.push(next.line);at=next.p;}
 write(DIR+'coverage_missing_q'+(q?3:0)+'.json',JSON.stringify(missing[q]));write(DIR+'coverage_lines_q'+(q?3:0)+'.json',JSON.stringify(ordered));counts.push(lines.length);
}
const result={inputs:hash(JSON.stringify(inputs)),active,measured:[active-missing[0].length,active-missing[1].length],missing:missing.map(a=>a.length),pavingMissing:pavingMissing.map(a=>a.length),closeMissing:closeMissing.map(a=>a.length),extraStops:counts,bySpecies};write(DIR+'coverage.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,bySpecies:undefined}));
