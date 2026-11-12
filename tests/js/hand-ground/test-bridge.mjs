// Every instanced bridge member must attach to its actual constructed support, including fence posts.
import assert from 'node:assert/strict';
import * as THREE from '../../../app/vendor/three-0.180.0/three.module.min.js';
import {createLandmarks} from '../../../app/js/world3d/marin.js';
import {makeProj} from '../../../app/js/world3d/geo.js';
import {attachmentAt} from '../../../tools/hand-ground/mounted.js';
const scene=new THREE.Scene();createLandmarks({THREE,scene,proj:makeProj(37.93,-122.63),sky:{placeBanks(){}},mats:{road:new THREE.MeshLambertMaterial()},baked:null});scene.updateMatrixWorld(true);
const bridge=scene.children[0].children[0],matrix=new THREE.Matrix4(),errors=[];let fixtures=0;
for(const object of bridge.children){if(!object.isInstancedMesh)continue;
 for(let i=0;i<object.count;i++){
  fixtures++;object.getMatrixAt(i,matrix);matrix.premultiply(object.matrixWorld);const result=attachmentAt({THREE},object,matrix),at=[matrix.elements[12],matrix.elements[13],matrix.elements[14]];
  if(!result)errors.push({at,reason:'unsupported'});
  else if(result.onPaving)errors.push({at,reason:'on paving'});
  else if(Math.min(...result.contacts.map(c=>c.gap))>0.03)errors.push({at,reason:'base visibly above its support'});
 }
}
assert.equal(fixtures,3592,'Preserve every existing bridge fixture');assert.deepEqual(errors,[]);
console.log(JSON.stringify({fixtures,unsupported:0,onPaving:0}));
