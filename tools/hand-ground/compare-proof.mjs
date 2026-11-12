import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const evidenceOpt=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
process.chdir(resolve(evidenceOpt('samples',process.cwd())));
// Strict comparison. The shared cmp.py also runs; it does not return failure on regressions itself.
import {readFileSync as read,writeFileSync as write,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {settledRow} from './settled-row.mjs';
const metrics=['hover','sunk','seam','buried','zfight'],critical=['hole','pit','float','onroad'],n=v=>Array.isArray(v)?v.length:v||0;
const load=f=>new Map(read(f,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.cells).map(r=>[r.road+'|'+r.st,r]));
const report={network:{},worseStops:Object.fromEntries(metrics.map(k=>[k,0])),regressions:[],missing:[],invalid:[],critical:[],comparisons:[]};
for(const q of [0,3])for(const network of ['network','mv']){
 const key=network+'_q'+q,a=evidenceOpt('before','before_corrected')+'_'+key+'.jsonl',b='after_canonical_'+key+'.jsonl';
 if(!existsSync(a)||!existsSync(b)){report.missing.push({key,files:[a,b].filter(f=>!existsSync(f))});continue;}
 const before=load(a),after=load(b),expected=JSON.parse(read(network+'_stops.json')),summary={expected:expected.length,stops:0,failed:0,...Object.fromEntries([...critical,...metrics].map(k=>[k,0]))};
 for(const [road,st]of expected){
  const k=road+'|'+st,A=before.get(k),B=after.get(k);if(!A||!B){summary.failed++;report.missing.push({key,road,st,before:!!A,after:!!B});continue;}
  const valid=v=>Array.isArray(v)||(typeof v==='number'&&Number.isFinite(v)&&v>=0);
  if(!settledRow(A)||!settledRow(B)||![...critical,...metrics].every(k=>valid(A[k])&&valid(B[k]))){summary.failed++;report.invalid.push({key,road,st});continue;}summary.stops++;
  for(const field of [...critical,...metrics])summary[field]+=n(B[field]);
  for(const field of critical)if(n(B[field]))report.critical.push({key,road,st,field,value:B[field]});
  for(const field of metrics)if(n(B[field])>n(A[field])){report.worseStops[field]++;report.regressions.push({key,road,st,field,before:n(A[field]),after:n(B[field]),at:B.at});}
 }
 report.network[key]=summary;
 const comparison=spawnSync('python',['-I',fileURLToPath(new URL('./cmp.py',import.meta.url)),a,b,'0'],{windowsHide:true,encoding:'utf8'}),log='compare_'+key+'.log';
 write(log,comparison.stdout+comparison.stderr);report.comparisons.push({key,before:a,after:b,log,exit:comparison.status});
}
report.pass=Object.keys(report.network).length===4&&!report.missing.length&&!report.invalid.length&&!report.critical.length&&!report.regressions.length&&report.comparisons.every(c=>c.exit===0);
write('comparison_proof.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,regressions:report.regressions.length,critical:report.critical.length,missing:report.missing.length,invalid:report.invalid.length},null,2));
if(!report.pass)process.exitCode=1;
