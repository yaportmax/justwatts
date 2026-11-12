// (A53: bake evidence from the exact runtime triangles, including gv banks. No second terrain implementation.)
export function captureSupport(D, radius = 400) {
  const T=D.THREE, [cx,cz]=D.xz(...window.__seatAt), plants=new Map(), meshes=[];
  const seen=window.__seatSeen??=new Set(), mat=new T.Matrix4(),box=new T.Box3();
  const shown=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
  const under=(o,name)=>{for(let p=o.parent;p;p=p.parent)if(p.name===name)return true;return false;};
  D.scene.traverse(o=>{
    if(!o.isMesh||!o.geometry?.attributes.position||!shown(o))return;
    if(o.isInstancedMesh){
      if(!under(o,'handVeg'))return;
      for(let i=0;i<o.count;i++){
        o.getMatrixAt(i,mat);mat.premultiply(o.matrixWorld);const e=mat.elements,x=e[12],y=e[13],z=e[14],key=x+','+z;
        const distance=Math.hypot(x-cx,z-cz);
        if((seen.has(key)&&distance>70)||plants.has(key)||distance>radius||Math.hypot(e[4],e[5],e[6])<1e-6)continue;
        plants.set(key,{x,y,z,key,name:o.name,ground:null,bank:null,paving:[]});
      }
      return;
    }
    const A=o.geometry.attributes,hand=under(o,'hand'),bank=!!A.gv;
    if(!(hand||A.mk||A.ruv||bank))return;
    if(!o.geometry.boundingBox)o.geometry.computeBoundingBox();box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    if(box.max.x<cx-radius||box.min.x>cx+radius||box.max.z<cz-radius||box.min.z>cz+radius)return;
    meshes.push({o,bank,road:!under(o,'tunnels')&&(hand?/^road/.test(o.name):!!A.ruv)});
  });
  const points=[...plants.values()],C=16,bins=new Map();
  for(const p of points){const k=Math.floor(p.x/C)+','+Math.floor(p.z/C);(bins.get(k)??bins.set(k,[]).get(k)).push(p);}
  if(!points.length)return {points:[],ms:0,version:2};
  const start=performance.now(),v=new Float64Array(9);
  let triangles=0;
  for(const {o,bank,road}of meshes){
    const g=o.geometry,P=g.attributes.position,I=g.index,M=o.matrixWorld.elements,orientation=o.matrixWorld.determinant()<0?-1:1;
    const n=I?I.count:P.count,begin=g.drawRange.start||0,end=Math.min(n,begin+(g.drawRange.count??Infinity),g.attributes.mk?(o.userData.floor0??Infinity):Infinity);
    for(let t=begin;t+2<end;t+=3){
      let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;
      for(let k=0;k<3;k++){const i=I?I.getX(t+k):t+k,x=P.getX(i),y=P.getY(i),z=P.getZ(i);
        const X=M[0]*x+M[4]*y+M[8]*z+M[12],Y=M[1]*x+M[5]*y+M[9]*z+M[13],Z=M[2]*x+M[6]*y+M[10]*z+M[14];
        v[3*k]=X;v[3*k+1]=Y;v[3*k+2]=Z;x0=Math.min(x0,X);x1=Math.max(x1,X);z0=Math.min(z0,Z);z1=Math.max(z1,Z);
      }
      if(x1<cx-radius||x0>cx+radius||z1<cz-radius||z0>cz+radius)continue;
      const den=(v[5]-v[8])*(v[0]-v[6])+(v[6]-v[3])*(v[2]-v[8]);if(Math.abs(den)<1e-9)continue;triangles++;
      const material=Array.isArray(o.material)?o.material[g.groups.find(a=>t>=a.start&&t<a.start+a.count)?.materialIndex]:o.material;
      if(!material||(material.side===T.FrontSide&&den*orientation>0)||(material.side===T.BackSide&&den*orientation<0))continue;
      const pad=road?0.6:0;
      for(let iz=Math.floor(Math.max(z0-pad,cz-radius)/C);iz<=Math.floor(Math.min(z1+pad,cz+radius)/C);iz++)for(let ix=Math.floor(Math.max(x0-pad,cx-radius)/C);ix<=Math.floor(Math.min(x1+pad,cx+radius)/C);ix++){
        const cell=bins.get(ix+','+iz);if(!cell)continue;
        for(const p of cell){if(p.x<x0-pad||p.x>x1+pad||p.z<z0-pad||p.z>z1+pad)continue;
          const a=((v[5]-v[8])*(p.x-v[6])+(v[6]-v[3])*(p.z-v[8]))/den,b=((v[8]-v[2])*(p.x-v[6])+(v[0]-v[6])*(p.z-v[8]))/den,c=1-a-b;
          const inside=a>=-1e-6&&b>=-1e-6&&c>=-1e-6;
          if(road){
            let gap=0,ry=a*v[1]+b*v[4]+c*v[7];
            if(!inside){gap=Infinity;for(let e=0;e<3;e++){const j=3*e,k=3*((e+1)%3),dx=v[k]-v[j],dz=v[k+2]-v[j+2],l=dx*dx+dz*dz,u=l?Math.max(0,Math.min(1,((p.x-v[j])*dx+(p.z-v[j+2])*dz)/l)):0,d=Math.hypot(p.x-v[j]-u*dx,p.z-v[j+2]-u*dz);if(d<gap){gap=d;ry=v[j+1]+u*(v[k+1]-v[j+1]);}}}
            if(gap<=0.6){const rd=g.attributes.rd,entry=[ry,gap,o.name,rd?rd.getW(I?I.getX(t):t):null],previous=p.paving.find(q=>Math.abs(q[0]-ry)<0.1);if(!previous)p.paving.push(entry);else if(gap<previous[1])previous.splice(0,previous.length,...entry);}
          }
          if(!inside)continue;
          const y=a*v[1]+b*v[4]+c*v[7],k=bank?'bank':'ground';if(p[k]==null||y>p[k])p[k]=y;
        }
      }
    }
  }
  for(const p of points)if(p.ground!=null||p.bank!=null)seen.add(p.key);
  return {points:points.map(p=>[p.x,p.y,p.z,p.ground,p.bank,p.name]),paving:points.map(p=>[p.x,p.y,p.z,p.paving]),pavingVersion:1,ms:performance.now()-start,triangles,version:2};
}

export function checkSupport(D, points) {
  const T=D.THREE,meshes=[],shown=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
  D.scene.traverse(o=>{
    if(!o.isMesh||o.isInstancedMesh||!o.geometry?.attributes.position||!shown(o))return;
    let hand=false;for(let p=o.parent;p;p=p.parent)if(p.name==='hand')hand=true;
    const A=o.geometry.attributes;if(hand||A.mk||A.ruv||A.gv)meshes.push(o);
  });
  const ray=new T.Raycaster(),down=new T.Vector3(0,-1,0),origin=new T.Vector3(),rows=[];
  const usable=points.filter(p=>p[3]!=null||p[4]!=null),n=Math.min(16,usable.length);
  for(let i=0;i<n;i++){
    const p=usable[Math.floor(i*usable.length/n)],expected=Math.max(p[3]??-Infinity,p[4]??-Infinity);
    ray.set(origin.set(p[0],4000,p[2]),down);
    const hit=ray.intersectObjects(meshes,false).find(h=>!(h.object.geometry.attributes.mk&&h.faceIndex*3>=(h.object.userData.floor0??Infinity)));
    rows.push({x:p[0],z:p[2],expected,ray:hit?.point.y??null,error:hit?Math.abs(expected-hit.point.y):null});
  }
  return {samples:rows.length,maxError:Math.max(0,...rows.map(r=>r.error??Infinity)),mismatch:rows.filter(r=>r.error==null||r.error>0.001),rows};
}
