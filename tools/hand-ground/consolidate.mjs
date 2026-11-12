import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const evidenceOpt=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
import {readFileSync as read,writeFileSync as write,readdirSync} from 'node:fs';
import {settledRow} from './settled-row.mjs';
const DIR=resolve(evidenceOpt('samples',process.cwd()))+'/',phase=process.argv[2]||'before',proof={};
const fields=['hole','pit','float','onroad','hover','sunk','seam','buried','zfight'];
for(const q of [0,3]){
 const all=new Map();
 for(const f of readdirSync(DIR).filter(f=>f.startsWith(phase+'_')&&f.endsWith('.jsonl')&&f.includes('_q'+q+'_'))){
  for(const l of read(DIR+f,'utf8').trim().split('\n').filter(Boolean)){
   const r=JSON.parse(l);if(!r.cells)continue;const k=r.road+'|'+r.st,old=all.get(k);
   if(settledRow(r)&&(!old||!settledRow(old.row)||f.includes('retry')))all.set(k,{file:f,row:r});else if(!old)all.set(k,{file:f,row:r});
  }
 }
 for(const network of ['network','mv']){
  const expected=JSON.parse(read(DIR+network+'_stops.json')),rows=[],missing=[],provenance=[];
  const summary={stops:0,failed:0,...Object.fromEntries(fields.map(k=>[k,0]))};
  for(const s of expected){const v=all.get(s[0]+'|'+s[1]);if(!v||!settledRow(v.row)){missing.push(s);continue;}const r=v.row;rows.push(r);provenance.push({road:r.road,st:r.st,source:v.file});summary.stops++;for(const k of fields)summary[k]+=Array.isArray(r[k])?r[k].length:r[k]||0;}
  summary.failed=missing.length;const stem=phase+'_canonical_'+network+'_q'+q;
  write(DIR+stem+'.jsonl',rows.map(r=>JSON.stringify(r)+'\n').join('')+JSON.stringify({summary})+'\n');
  write(DIR+stem+'_provenance.json',JSON.stringify(provenance));
  write(DIR+phase+'_retry_'+network+'_lines_q'+q+'.json',JSON.stringify(missing.map((s,i)=>({name:s[0],line:[s.slice(1)]}))));
  proof[network+'_q'+q]={expected:expected.length,...summary};
 }
}
write(DIR+phase+'_proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));

if(['before','after'].includes(phase)&&Object.values(proof).every(r=>r.stops===r.expected&&r.failed===0))write(DIR+phase+'.done',new Date().toISOString());
