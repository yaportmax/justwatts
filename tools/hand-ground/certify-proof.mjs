import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const evidenceOpt=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
process.chdir(resolve(evidenceOpt('samples',process.cwd())));
// Freeze final inputs before scanning, then certify only unchanged inputs and a complete strict comparison.
import {readFileSync as read,writeFileSync as write,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {geometryFiles,digest,verifyProof} from './hand_ground_guard.mjs';
const app=resolve(evidenceOpt('app',fileURLToPath(new URL('../../app',import.meta.url)))),stamp='after_inputs.json';
const files=Object.fromEntries(geometryFiles(app).map(p=>[p,digest(app+'/'+p)]));
if(process.argv.includes('--start')){
 if(existsSync(stamp))throw Error('Final input stamp already exists; preserve the first attempt evidence');
 write(stamp,JSON.stringify({at:new Date().toISOString(),files},null,2));console.log('Final scan input inventory frozen');
}else{
 const before=JSON.parse(read(stamp)),comparison=JSON.parse(read('comparison_proof.json'));
 if(JSON.stringify(files)!==JSON.stringify(before.files))throw Error('World changed during final proof');
 if(!existsSync('after.done')||!comparison.pass)throw Error('Final network comparison has not passed');
 const coverage=JSON.parse(read('coverage.json'));
 const hash=b=>createHash('sha256').update(b).digest('hex'),samples=readdirSync('.').filter(f=>/^before_.*_q[03]_\d+\.jsonl$/.test(f)).sort().map(file=>({file,sha256:hash(read(file))}));
 if(coverage.inputs!==hash(JSON.stringify(samples)))throw Error('Coverage no longer matches the preserved baseline samples');
 const exit=f=>{const value=read(f,'utf8').trim();if(!/^-?\d+$/.test(value))throw Error('Missing recorded exit code: '+f);return Number(value);};
 const gates={generatedKeepout:exit('keepout_after.exit'),handKeepout:exit('handkeep_after.exit')};
 const recaptures=existsSync('comparison_recaptures.json')?JSON.parse(read('comparison_recaptures.json')):null;
 const extra=new Set(['comparison_original_proof.json','comparison_recaptures.json']);
 if(recaptures){
  if(hash(read(recaptures.originalComparison.file))!==recaptures.originalComparison.sha256)throw Error('Original comparison changed');
  for(const entry of recaptures.recaptures)for(const [file,sha256]of Object.entries(entry.controls)){if(hash(read(file))!==sha256)throw Error('Recapture control changed: '+file);extra.add(file);}
  for(const entry of Object.values(recaptures.files))if(hash(read(entry.source))!==entry.sourceHash||hash(read(entry.matched))!==entry.matchedHash)throw Error('Matched baseline provenance changed');
 }
 const evidence={};for(const f of readdirSync('.').filter(f=>/^(before|after)_.*\.jsonl$/.test(f)||/^compare_.*\.log$/.test(f)||['comparison_proof.json','coverage.json','audit_catalog.json','original_baseline_manifest.json','keepout_after.log','handkeep_after.log','seat_drawn_applied.json','keep_drawn_applied.json'].includes(f))){const bytes=read(f);evidence[f]={bytes:bytes.length,sha256:hash(bytes)};}
 for(const f of extra)if(existsSync(f)){const bytes=read(f);evidence[f]={bytes:bytes.length,sha256:hash(bytes)};}
 const proof={version:1,at:new Date().toISOString(),started:before.at,files,network:comparison.network,worseStops:comparison.worseStops,coverage,gates,audit:'attachments,effects; original raw baseline retained with explicit measured exclusions',comparisons:comparison.comparisons,recaptures,evidence};
 const errors=verifyProof(app,proof);if(errors.length)throw Error(errors.join('\n'));
 write('hand-ground-proof.json',JSON.stringify(proof,null,2)+'\n');console.log('Certified complete, unchanged final world inputs and zero-regression proof');
}
