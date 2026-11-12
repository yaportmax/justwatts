// (A53: a raw-tile export or changed terrain invalidates the measured drawn-ground proof.)
import {readFileSync as read,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export function geometryFiles(app){
 const files=[];
 function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else files.push(relative(app,path).replaceAll('\\','/'));}}
 for(const dir of ['js/world3d','world','vendor/three-0.180.0'])walk(join(app,dir));
 const seen=new Set(files);
 for(let i=0;i<files.length;i++){
  const name=files[i];if(!/\.(m?js)$/.test(name))continue;
  const source=read(join(app,name),'utf8');
  for(const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)){
   const path=resolve(dirname(join(app,name)),match[1]),dep=relative(app,path).replaceAll('\\','/');
   if(dep.startsWith('../')||!existsSync(path))throw Error('Unresolved world geometry dependency: '+name+' -> '+match[1]);
   if(!seen.has(dep)){seen.add(dep);files.push(dep);}
  }
 }
 return files.sort();
}
export function digest(path){
 const bytes=read(path),data=/\.(js|mjs|json)$/.test(path)?bytes.toString('utf8').replaceAll('\r\n','\n'):bytes;
 return createHash('sha256').update(data).digest('hex');
}
export function verifyProof(app,proof){
 const errors=[],names=geometryFiles(app),listed=Object.keys(proof.files||{}).sort();
 if(JSON.stringify(names)!==JSON.stringify(listed))errors.push('Geometry input inventory changed');
 for(const name of names)if(proof.files?.[name]!==digest(join(app,name)))errors.push('Changed measured input/output: '+name);
 for(const network of ['network_q0','network_q3','mv_q0','mv_q3']){
  const row=proof.network?.[network];if(!row||!Number.isInteger(row.expected)||row.expected<=0||row.stops!==row.expected||row.failed!==0)errors.push('Incomplete network: '+network);
  for(const key of ['hole','pit','float','onroad'])if(row?.[key]!==0)errors.push(network+': '+key+' must be zero');
 }
 for(const key of ['hover','sunk','seam','buried','zfight'])if(proof.worseStops?.[key]!==0)errors.push(key+': regression proof missing or nonzero');
 if(proof.coverage?.missing?.some(n=>n!==0)||proof.coverage?.missing?.length!==2)errors.push('Both-quality root support coverage is incomplete');
 if(proof.coverage?.pavingMissing?.some(n=>n!==0)||proof.coverage?.pavingMissing?.length!==2)errors.push('Both-quality paving coverage is incomplete');
 if(proof.coverage?.closeMissing?.some(n=>n!==0)||proof.coverage?.closeMissing?.length!==2)errors.push('Closer support checks for large lowerings are incomplete');
 if(proof.gates?.generatedKeepout!==0||proof.gates?.handKeepout!==0)errors.push('Offline keepout gates did not pass');
 return errors;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=resolve(process.argv[2]||new URL('../../app',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
 const proof=JSON.parse(read(process.argv[3]||new URL('../../tests/fixtures/hand-ground-proof.json',import.meta.url)));
 const errors=verifyProof(app,proof);
 if(errors.length){console.error(errors.join('\n'));console.error('Rebuild hand placement against completed runtime meshes and repeat the documented scans; do not refresh hashes alone.');process.exitCode=1;}
 else console.log('PASS: complete drawn-ground proof matches current geometry and hand placements');
}
