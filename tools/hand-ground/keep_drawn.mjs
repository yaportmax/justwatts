import {fileURLToPath} from 'node:url';
// Actual completed paving, including runtime flares and tapers, is the keepout boundary.
// Evidence is from both qualities; hidden roads below another surface and tunnel floors do not count.
import {readFileSync as read,writeFileSync as write,readdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {flatDecals} from './plant-kinds.mjs';
import {settledRow} from './settled-row.mjs';
import {baselineWriteGuard} from './baseline-write-guard.mjs';
import {activePlants} from './active-plants.mjs';
const args=process.argv.slice(2),opt=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const APP=resolve(opt('app',fileURLToPath(new URL('../../app',import.meta.url)))),DIR=resolve(opt('samples',process.cwd())),WRITE=args.includes('--write');
const decals=flatDecals(APP);
const active=existsSync(join(APP,'js/world3d/hand.js'))?await activePlants(APP):()=>true;
const hash=b=>createHash('sha256').update(b).digest('hex'),evidence=new Map(),inputs=[];
for(const f of readdirSync(DIR).filter(f=>/^before_.*_q[03]_\d+\.jsonl$/.test(f)).sort()){
 const b=read(join(DIR,f)),q=+/_q([03])_/.exec(f)[1];inputs.push({file:f,sha256:hash(b)});
 for(const line of b.toString().split('\n').filter(Boolean)){
  const r=JSON.parse(line);if(!settledRow(r)||r.pavingVersion!==1)continue;
  const support=new Map((r.supportFeet||[]).map(([x,,z,g,b])=>[x+','+z,Math.max(g??-Infinity,b??-Infinity)]));
  for(const [x,y,z,hits]of r.pavingFeet||[]){
   const k=x+','+z,a=evidence.get(k)??{qualities:new Set(),hits:[]};a.qualities.add(q);
   for(const [height,gap,name,width]of hits)if(height>=support.get(k)-0.3)a.hits.push({height,gap,name,width,q,road:r.road,st:r.st});
   evidence.set(k,a);
  }
 }
}
const TREE=/^(oak|oakt|oaktf|dfir|dfirf|dfir2|dfir2f|bay|bayf|loak|loak2|rwd|rwdf|cyp2|cyp3|cypress|cypt|mcyp|mcyp2|mcypt|euc|euc2|avc|avc2|btree)$/;
const V=JSON.parse(read(join(APP,'world/hand/veg.json'))),removed=[],pending=[],rejected=[];
for(const G of V.groups){
 const file=join(APP,'world/hand',G.file),b=read(file),a=new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)),out=[];let off=0,changed=false;
 for(const [sp,n]of Object.entries(G.species)){
  const stride=V.stride?.[sp]||7,clearance=TREE.test(sp)?0.6:0.3;let kept=0;
  for(let i=0;i<n;i++){
   const o=off+i*stride,x=a[o],y=a[o+1],z=a[o+2],e=evidence.get(x+','+z),hit=active(sp,x,z)&&!decals.has(sp)&&e?.hits.find(h=>h.gap<clearance&&Math.abs(h.height-y)<2);
   if(hit){const row={file:G.file,sp,index:i,x,y,z,hit};if(e.qualities.size!==2)rejected.push(row);else{removed.push(row);changed=true;continue;}}
   for(let j=0;j<stride;j++)out.push(a[o+j]);kept++;
  }
  off+=n*stride;G.species[sp]=kept;
 }
 if(off!==a.length)throw Error('Manifest stride mismatch: '+G.file);
 if(changed)pending.push({file,data:Buffer.from(new Float32Array(out).buffer),before:hash(b)});
}
const report={rule:'actual visible paving with tree clearance0.6m or other0.3m; within2m of root; both qualities; exclude buried roads and tunnel floors',inputs,removed,rejected,files:pending.map(p=>({file:p.file,before:p.before,after:hash(p.data)})),write:WRITE,applied:false};
write(join(DIR,'keep_drawn_plan.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,inputs:inputs.length,removed:removed.length,rejected:rejected.length,files:pending.length}));
if(WRITE){
 const coverage=JSON.parse(read(join(DIR,'coverage.json')));
 if(rejected.length||coverage.pavingMissing.some(n=>n!==0))throw Error('Incomplete both-quality paving evidence; no files written');
 baselineWriteGuard(APP,DIR,inputs,{paving:true});
 for(const p of pending)write(p.file,p.data);
 if(pending.length)write(join(APP,'world/hand/veg.json'),JSON.stringify(V));
 write(join(DIR,'keeping_outputs.json'),JSON.stringify({inputs:hash(JSON.stringify(inputs)),manifest:hash(read(join(APP,'world/hand/veg.json'))),files:Object.fromEntries(V.groups.map(g=>[g.file,hash(read(join(APP,'world/hand',g.file)))]))},null,2));
 report.applied=true;write(join(DIR,'keep_drawn_applied.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({applied:true,removed:removed.length,files:pending.length}));
}
