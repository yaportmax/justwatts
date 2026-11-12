// (A53: freeze source inputs before collecting exact runtime support, never after a bake.)
import {readFileSync as read,writeFileSync as write,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {geometryFiles} from './hand_ground_guard.mjs';
const opt=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const app=resolve(opt('app',fileURLToPath(new URL('../../app',import.meta.url)))),dir=resolve(opt('samples',process.cwd()));
mkdirSync(dir,{recursive:true});
for(const name of ['support_inputs.json','placement_inputs.json','network_stops.json','mv_stops.json'])if(existsSync(join(dir,name)))throw Error('Use a new evidence folder; preserve '+name);
const hash=b=>createHash('sha256').update(b).digest('hex');
const files={};for(const name of geometryFiles(app))if(!/^world\/hand\/veg\/.*\.bin$/.test(name)){const file=join(app,name);files[relative(dirname(app),file).replaceAll('\\','/')]=hash(read(file));}
const V=JSON.parse(read(join(app,'world/hand/veg.json'))),placements=Object.fromEntries(V.groups.map(g=>[g.file,hash(read(join(app,'world/hand',g.file)))]));
write(join(dir,'support_inputs.json'),JSON.stringify({at:new Date().toISOString(),files},null,2));
write(join(dir,'placement_inputs.json'),JSON.stringify({files:placements},null,2));
for(const network of ['network','mv']){const lines=JSON.parse(read(new URL('./'+network+'-lines.json',import.meta.url)));write(join(dir,network+'_stops.json'),JSON.stringify(lines.flatMap(r=>r.line.map(s=>[r.name,...s]))));}
console.log('Frozen runtime inputs, placement files and complete route manifests in '+dir);
