import {fileURLToPath} from 'node:url';
// (A53: hand placement must use the completed runtime meshes, after carve, press, road push and bank construction.)
// Run on settled q0 AND q3 netscan samples. The samples come from the unmodified game build functions themselves.
// Fixed exported heights serve every LOD. No runtime re-seating, raw-tile depth subtraction or plant-specific exception.
import {readFileSync as read,writeFileSync as write,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {flatDecals} from './plant-kinds.mjs';
import {settledRow} from './settled-row.mjs';
import {baselineWriteGuard} from './baseline-write-guard.mjs';
import {activePlants} from './active-plants.mjs';
const args=process.argv.slice(2), opt=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const APP=resolve(opt('app',fileURLToPath(new URL('../../app',import.meta.url)))), DIR=resolve(opt('samples',process.cwd()));
const WRITE=args.includes('--write'), OMIT_UNSTABLE=args.includes('--omit-unstable'), PREFIX=opt('prefix','before_'), hash=b=>createHash('sha256').update(b).digest('hex');
const decals=flatDecals(APP);
const active=existsSync(join(APP,'js/world3d/hand.js'))?await activePlants(APP):()=>true;
const key=(x,z)=>x+','+z, supports=new Map(), inputs=[], failed=[], stamps=new Set();
for(const f of readdirSync(DIR).filter(f=>f.startsWith(PREFIX)&&/_q[03]_\d+\.jsonl$/.test(f)).sort()){
 const data=read(join(DIR,f)),q=+/_q([03])_/.exec(f)[1];inputs.push({file:f,sha256:hash(data)});
 for(const line of data.toString('utf8').split('\n').filter(Boolean)){
  const r=JSON.parse(line);if(r.summary){if(r.summary.failed)failed.push([f,'failed',r.summary.failed]);continue;}
  if(!r.cells)continue;if(!settledRow(r)){failed.push([f,r.road,r.st,'unsettled']);continue;}
  stamps.add(q+'|'+r.road+'|'+r.st);
  for(const [x,y,z,ground,bank,mesh]of [...(r.feet||[]),...(r.supportCost?.version===2?r.supportFeet||[]:[])]){
   const support=ground==null?bank:bank==null?ground:Math.max(ground,bank);
   if(support==null||!Number.isFinite(support))continue;
   const k=key(x,z),a=supports.get(k)??{x,z,min:Infinity,max:-Infinity,qualities:new Set(),samples:0,names:new Set(),sourceYs:new Set()};
   a.min=Math.min(a.min,support);a.max=Math.max(a.max,support);a.qualities.add(q);a.samples++;a.names.add(mesh);a.sourceYs.add(y);supports.set(k,a);
  }
 }
}
const V=JSON.parse(read(join(APP,'world/hand/veg.json'))),changes=[],omitted=[],pending=[],rejected=[];let total=0,measured=0,both=0;
for(const G of V.groups){
 const file=join(APP,'world/hand',G.file),b=read(file),a=new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)),removed=new Set();let off=0,changed=false;
 for(const [sp,n]of Object.entries(G.species)){
  const st=V.stride?.[sp]||7;
  for(let i=0;i<n;i++){
   total++;const o=off+i*st,x=a[o],y=a[o+1],z=a[o+2],s=supports.get(key(x,z));if(!s||decals.has(sp)||!active(sp,x,z))continue;measured++;
   if(s.qualities.size===2)both++;
   // A seated plant stays where it is. Never accumulate burial depth on a repeat bake.
   if(y<=s.min+0.1)continue;
   const row={file:G.file,sp,index:i,x,z,from:y,min:s.min,max:s.max,samples:s.samples};
   if(s.qualities.size!==2){rejected.push({...row,reason:'missing quality'});continue;}
   // Prefer 15cm embed, but use a shallower fixed root when measured support varies.
   // Every visit still gets at least 2cm embed and at most 35cm burial (plus float32 rounding).
   const target=Math.fround(Math.max(s.min-0.15,s.max-0.35));
   // The scan's sunk threshold is 1.5m. Refuse much earlier instead of hiding a varying support in that allowance.
   if(target>s.min-0.02+0.0001||s.max-target>0.35+0.0001){
    const unstable={...row,reason:'no fixed root can satisfy the measured 2cm embed and 35cm burial bounds at every visit'};
    if(OMIT_UNSTABLE){omitted.push(unstable);removed.add(o);G.species[sp]--;changed=true;}else rejected.push(unstable);
    continue;
   }
   a[o+1]=target;changed=true;changes.push({...row,to:target});
  }
  off+=n*st;
 }
 if(off!==a.length)throw Error('Bad manifest stride: '+G.file);
 if(changed){
  let data=a;
  if(removed.size){const out=[];let offset=0;for(const [sp,kept]of Object.entries(G.species)){const stride=V.stride?.[sp]||7,originalCount=kept+omitted.filter(r=>r.file===G.file&&r.sp===sp).length;for(let i=0;i<originalCount;i++){if(!removed.has(offset))for(let j=0;j<stride;j++)out.push(a[offset+j]);offset+=stride;}}if(offset!==a.length)throw Error('Unstable omission stride mismatch');data=new Float32Array(out);}
  pending.push({file,data:Buffer.from(data.buffer),before:hash(b)});
 }
}
const unresolved=failed.filter(r=>r[3]!=='unsettled'||!stamps.has(+/_q([03])_/.exec(r[0])[1]+'|'+r[1]+'|'+r[2]));
const report={rule:'fixed foot with preferred 0.15m embed, minimum 0.02m embed, maximum 0.35m burial with 0.1mm float32 tolerance; lower only above 0.1m; both qualities',omitUnstable:OMIT_UNSTABLE,total,measured,both,stops:stamps.size,inputs,rawIncomplete:failed,failed:unresolved,rejected,changes,omitted,files:pending.map(p=>({file:p.file,before:p.before,after:hash(p.data)})),write:WRITE,applied:false};
const receiptPath=join(DIR,'seating_outputs.json'),inputDigest=hash(JSON.stringify(inputs));
write(join(DIR,'seat_drawn_plan.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,inputs:inputs.length,failed:failed.length,rejected:rejected.length,changes:changes.length,omitted:omitted.length,files:pending.length}));
if(WRITE){
 if(unresolved.length||rejected.length)throw Error('Incomplete or inconsistent support evidence, no files written');
 baselineWriteGuard(APP,DIR,inputs,{paving:true});
 for(const p of pending)write(p.file,p.data);
 if(omitted.length)write(join(APP,'world/hand/veg.json'),JSON.stringify(V));
 write(receiptPath,JSON.stringify({inputs:inputDigest,manifest:hash(read(join(APP,'world/hand/veg.json'))),files:Object.fromEntries(V.groups.map(g=>[g.file,hash(read(join(APP,'world/hand',g.file)))]))},null,2));
 report.applied=true;write(join(DIR,'seat_drawn_applied.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({applied:true,changes:changes.length,omitted:omitted.length,files:pending.length}));
}
