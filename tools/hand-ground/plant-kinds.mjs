// Surface decals in the vegetation manifest are not physical plant placements.
// Recognize the source model's geometry/material semantics, not individual coordinates.
import {readFileSync as read} from 'node:fs';
export function flatDecals(app){
 const manifest=JSON.parse(read(app+'/world/hand/veg.json')),species=new Set(manifest.groups.flatMap(g=>Object.keys(g.species))),out=[];
 for(const sp of species){
  const bytes=read(app+'/world/hand/veg/'+sp+'.glb'),j=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
  const nodes=(j.nodes||[]).filter(n=>n.mesh!=null);
  const plain=n=>!n.matrix&&(!n.rotation||n.rotation.every((v,i)=>v===(i===3?1:0)));
  if(!nodes.length||!j.nodes.every(plain))continue;
  const primitives=nodes.flatMap(n=>j.meshes[n.mesh].primitives),flat=primitives.every(p=>{
   const a=j.accessors[p.attributes.POSITION],m=j.materials[p.material];
   return a.min&&a.max&&Math.abs(a.max[1]-a.min[1])<1e-5&&m?.alphaMode==='BLEND'&&m.pbrMetallicRoughness?.baseColorTexture;
  });
  if(flat)out.push(sp);
 }
 return new Set(out);
}
