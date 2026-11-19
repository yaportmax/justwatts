// Read the exact runtime's exclusion functions without importing its browser-only loaders.
import {readFileSync as read} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {flatDecals} from './plant-kinds.mjs';
export async function activePlants(APP){
 const source=read(APP+'/js/world3d/hand.js','utf8');
 const {compileSpec}=await import(pathToFileURL(APP+'/js/world3d/conzelman.js'));
 const {makeProj}=await import(pathToFileURL(APP+'/js/world3d/geo.js'));
 const PROJ=makeProj(37.93,-122.63),spec=compileSpec(PROJ);
 const start=source.indexOf('function boreZone('),end=source.indexOf('// its mouths:',start);
 if(start<0||end<0)throw Error('Runtime boreZone source not found');
 const ranges=/const BORED_ = \(\) => globalThis\.__w3\?\.handBore \? \[\] : (\[\[.*?\]\]);/.exec(source)?.[1];
 const drop=/const DROP = new Set\((\[[^\n]+?\])\)/.exec(source)?.[1];
 if(!ranges||!drop)throw Error('Runtime plant exclusion source not found');
 const bore=Function('PROJ_','spec_',source.slice(start,end)+'; return boreZone('+ranges+');')(PROJ,()=>spec);
 const dropped=new Set([...Function('return '+drop)(),...flatDecals(APP)]);
 // (A70: hand.js omits the stems a tile's measured street crowns replace, tam-climb-crowns.json streetReplacements)
 const replaced=new Set();try{const fits=JSON.parse(read(APP+'/world/tam-climb-crowns.json','utf8'));for(const g of Object.values(fits))for(const [sp,list] of Object.entries(g?.streetReplacements||{}))for(const [,x,z] of list)replaced.add(sp+'|'+x+'|'+z);}catch(e){if(e.code!=='ENOENT')throw e;}
 return (sp,x,z)=>!dropped.has(sp)&&!bore(x,z)&&!replaced.has(sp+'|'+Math.round(x*100)+'|'+Math.round(z*100));
}
