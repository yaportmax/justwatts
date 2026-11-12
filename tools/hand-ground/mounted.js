// Test a component's real base against opaque static members in the same assembly.
// No location/species exemption: unsupported parts and parts resting on paving still fail.
export function attachmentAt(D,object,matrix,extraRoads=[]){
 const T=D.THREE,parent=object.parent;if(!parent)return null;
 const shown=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
 const solids=[],roads=[...extraRoads];
 for(const o of parent.children){
  if(!o.isMesh||o.isInstancedMesh||!o.geometry?.attributes.position||!shown(o))continue;
  const a=o.geometry.attributes;if(a.ruv){roads.push(o);continue;}if(a.mk||a.gv)continue;
  const materials=Array.isArray(o.material)?o.material:[o.material];
  if(materials.some(m=>!m||m.transparent||m.alphaTest>0||m.onBeforeCompile!==T.Material.prototype.onBeforeCompile))continue;
  solids.push(o);
 }
 if(!solids.length)return null;
 const g=object.geometry;if(!g.boundingBox)g.computeBoundingBox();
 const y=g.boundingBox.min.y,p=g.attributes.position,points=new Map();
 for(let i=0;i<p.count;i++)if(Math.abs(p.getY(i)-y)<1e-4){const x=p.getX(i),z=p.getZ(i);points.set(x.toFixed(5)+','+z.toFixed(5),new T.Vector3(x,y,z).applyMatrix4(matrix));}
 if(!points.size)return null;
 const list=[...points.values()],centre=new T.Vector3();for(const p of list)centre.add(p);centre.multiplyScalar(1/list.length);list.push(centre);
 const ray=new T.Raycaster(),down=new T.Vector3(0,-1,0),origin=new T.Vector3(),contacts=[];let onPaving=false;
 ray.far=0.48;
 for(const foot of list){
  ray.set(origin.copy(foot).addScaledVector(down,-0.08),down);
  const support=ray.intersectObjects(solids,false)[0];
  if(support)contacts.push({foot:foot.toArray(),height:support.point.y,gap:foot.y-support.point.y,mesh:support.object.name,type:support.object.geometry.type});
  // The obstruction test is at the base centre, like the plant-root test; corners only establish support.
  if(foot===centre&&roads.length){
   // A base below the pavement still obstructs it. A raised wall mount above it does not.
   ray.set(origin.copy(foot).addScaledVector(down,-0.4),down);
   if(ray.intersectObjects([...new Set(roads)],false).length)onPaving=true;
  }
 }
 return contacts.length?{version:2,contacts,onPaving,basePoints:list.length}:null;
}
