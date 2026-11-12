import {readFileSync as read,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function baselineWriteGuard(APP,DIR,inputs,{paving=false}={}){
 const stamp=join(DIR,'support_inputs.json');if(!existsSync(stamp))throw Error('Baseline geometry stamp required before writing');
 if(!existsSync(join(DIR,'before.done')))throw Error('Complete original network baseline required before writing');
 const proof=JSON.parse(read(join(DIR,'before_proof.json')));
 if(['network_q0','network_q3','mv_q0','mv_q3'].some(k=>!proof[k]||!Number.isInteger(proof[k].expected)||proof[k].expected<=0||proof[k].failed!==0||proof[k].stops!==proof[k].expected))throw Error('Complete settled baseline proof required before writing');
 const coverage=JSON.parse(read(join(DIR,'coverage.json')));
 if(['missing','closeMissing',...(paving?['pavingMissing']:[])].some(k=>coverage[k]?.length!==2||coverage[k].some(n=>n!==0)))throw Error('Complete both-quality support, close approach and paving evidence required');
 const inputDigest=hash(JSON.stringify(inputs)),receipts=['seating_outputs.json','keeping_outputs.json'].filter(f=>existsSync(join(DIR,f))).map(f=>JSON.parse(read(join(DIR,f)))).filter(r=>r.inputs===inputDigest);
 if(coverage.inputs!==inputDigest)throw Error('Coverage does not match current sample inputs; regenerate coverage');
 const changed=Object.entries(JSON.parse(read(stamp)).files).filter(([f,h])=>{
  const actual=hash(read(resolve(APP,'..',f)));
  return actual!==h&&!(f.replaceAll('\\','/').endsWith('/world/hand/veg.json')&&receipts.some(r=>r.manifest===actual));
 }).map(([f])=>f);
 if(changed.length)throw Error('Stale runtime support inputs: '+changed.join(', '));
 const placements=JSON.parse(read(join(DIR,'placement_inputs.json')));
 const replaced=Object.entries(placements.files).filter(([f,h])=>{const actual=hash(read(join(APP,'world/hand',f)));return actual!==h&&!receipts.some(r=>r.files?.[f]===actual);}).map(([f])=>f);
 if(replaced.length)throw Error('Placement source changed since measurement: '+replaced.join(', '));
}
