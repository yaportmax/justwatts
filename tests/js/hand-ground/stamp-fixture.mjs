import {readFileSync as read,writeFileSync as write,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function stampFixture(app,samples){
 const manifest=read(app+'/world/hand/veg.json'),v=JSON.parse(manifest);
 write(samples+'/support_inputs.json',JSON.stringify({files:{'app/world/hand/veg.json':hash(manifest)}}));
 write(samples+'/placement_inputs.json',JSON.stringify({files:Object.fromEntries(v.groups.map(g=>[g.file,hash(read(app+'/world/hand/'+g.file))]))}));
 write(samples+'/before.done','synthetic test fixture');
 write(samples+'/before_proof.json',JSON.stringify(Object.fromEntries(['network_q0','network_q3','mv_q0','mv_q3'].map(k=>[k,{expected:1,stops:1,failed:0}]))));
 const inputs=readdirSync(samples).filter(f=>/^before_.*_q[03]_\d+\.jsonl$/.test(f)).sort().map(file=>({file,sha256:hash(read(samples+'/'+file))}));
 write(samples+'/coverage.json',JSON.stringify({inputs:hash(JSON.stringify(inputs)),missing:[0,0],closeMissing:[0,0],pavingMissing:[0,0]}));
}
