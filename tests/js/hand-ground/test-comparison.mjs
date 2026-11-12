import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync as write,readFileSync as read} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const folder=resolve(process.argv[2]||'comparison-fixture');mkdirSync(folder,{recursive:true});
const row={road:'test',st:0,at:[0,0],cells:1,settled:true,hole:0,pit:0,float:[],onroad:[],hover:0,sunk:[],seam:0,buried:0,zfight:0};
for(const n of ['network','mv']){write(folder+'/'+n+'_stops.json',JSON.stringify([['test',0,0,0,0]]));for(const q of [0,3])for(const p of ['before','after'])write(folder+'/'+p+'_canonical_'+n+'_q'+q+'.jsonl',JSON.stringify(row)+'\n');}
const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../../../tools/hand-ground/compare-proof.mjs',import.meta.url)),'--samples='+folder,'--before=before_canonical'],{windowsHide:true,encoding:'utf8'});
let result=run();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(read(folder+'/comparison_proof.json')).pass,true);
write(folder+'/after_canonical_network_q0.jsonl',JSON.stringify({...row,hover:1})+'\n');result=run();assert.notEqual(result.status,0);assert.equal(JSON.parse(read(folder+'/comparison_proof.json')).worseStops.hover,1);
write(folder+'/after_canonical_network_q0.jsonl',JSON.stringify({...row,float:[[1,2,'plant']]})+'\n');result=run();assert.notEqual(result.status,0);assert.equal(JSON.parse(read(folder+'/comparison_proof.json')).critical.length,1);
write(folder+'/after_canonical_network_q0.jsonl',JSON.stringify({...row,settled:false})+'\n');result=run();assert.notEqual(result.status,0);assert.equal(JSON.parse(read(folder+'/comparison_proof.json')).invalid.length,1);
const incomplete={...row};delete incomplete.float;write(folder+'/after_canonical_network_q0.jsonl',JSON.stringify(incomplete)+'\n');result=run();assert.notEqual(result.status,0);assert.equal(JSON.parse(read(folder+'/comparison_proof.json')).invalid.length,1);
console.log('PASS: complete matching physical proof accepted; one-cell regression, floater, unsettled stop and missing metric rejected even though cmp.py returns zero');
