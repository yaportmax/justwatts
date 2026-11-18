// (A64: Miller 591300. Crossing bars and turning arrows follow the same
// triangles that carry the rider, including the crossfall and lane tapers.)
function section(lines, x, z, bearing) {
  const angle=bearing*Math.PI/180, tx=Math.sin(angle), tz=-Math.cos(angle);
  let best=null, bestDistance=4;
  for (const line of lines) {
    if (line.hand || line.br || ['service','footway','path','cycleway'].includes(line.hw)) continue;
    for (let i=1;i<line.P.length;i++) {
      const a=line.P[i-1], b=line.P[i], dx=b[0]-a[0], dz=b[2]-a[2], len=Math.hypot(dx,dz);
      const alignment=tx*dx+tz*dz;
      if (len<0.1 || Math.abs(alignment)<len*0.8) continue;
      const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[2])*dz)/(len*len)));
      const cx=a[0]+t*dx, cz=a[2]+t*dz, d=Math.hypot(x-cx,z-cz);
      if (d>=bestDistance) continue;
      const sign=Math.sign(alignment);
      bestDistance=d;
      best={line,cx,cz,sign,dx:sign*dx/len,dz:sign*dz/len,half:a[3]+t*(b[3]-a[3])};
    }
  }
  return best;
}

// Clip a sloping road triangle to a convex paint outline in road coordinates.
function insidePaint(points, shape) {
  for(let j=0;j<shape.length && points.length;j++){
    const a=shape[j], b=shape[(j+1)%shape.length], dx=b[0]-a[0], dy=b[1]-a[1];
    const distance=p=>dx*(p[1]-a[1])-dy*(p[0]-a[0]), keep=[];
    for(let i=0;i<points.length;i++){
      const p=points[i], q=points[(i+1)%points.length], u=distance(p), v=distance(q);
      if(u>=0)keep.push(p);
      if((u<0)!==(v<0))keep.push(p.map((n,k)=>n+(q[k]-n)*u/(u-v)));
    }
    points=keep;
  }
  return points;
}
function paint(s, shapes, positions) {
  const {line,cx,cz,dx,dz,half}=s, before=positions.length;
  const local=(p,k)=>{const x=p[k]-cx,z=p[k+2]-cz;return [dx*x+dz*z,dx*z-dz*x,p[k+1]];};
  for(let i=1;i<line.P.length;i++){
    const a=line.P[i-1],b=line.P[i];
    if(Math.min(a[0],b[0])>cx+half+3 || Math.max(a[0],b[0])<cx-half-3 ||
       Math.min(a[2],b[2])>cz+half+3 || Math.max(a[2],b[2])<cz-half-3)continue;
    const ar=local(a,4),al=local(a,7),br=local(b,4),bl=local(b,7);
    for(const tri of [[ar,br,al],[al,br,bl]])for(const shape of shapes){
      const p=insidePaint(tri,shape);
      for(let j=2;j<p.length;j++)for(const [u,v,y] of [p[0],p[j-1],p[j]])
        positions.push(cx+dx*u-dz*v,y+0.012,cz+dz*u+dx*v);
    }
  }
  return positions.length>before;
}
const rect=(u,v,lo,hi)=>[[u,lo],[v,lo],[v,hi],[u,hi]];
export function roadCrossing(lines,x,z,bearing,twoLines,positions) {
  const s=section(lines,x,z,bearing);
  if(!s)return false;
  const h=s.half,shapes=[];
  if(twoLines)shapes.push(rect(-1.52,-1.27,-h,h),rect(1.27,1.52,-h,h));
  else for(let v=-Math.floor((h-.35)/1.05)*1.05;v<h-.24;v+=1.05)shapes.push(rect(-1.45,1.45,v-.24,v+.24));
  return paint(s,shapes,positions);
}

export function turnArrows(lines,x,z,bearing,lanes,opposite,positions) {
  const s=section(lines,x,z,bearing);
  if(!s)return false;
  const style=s.line.st || {}, total=2*s.half, scale=total/(style.w || total);
  const left=-s.half+(s.sign>0 ? style.b || 0 : style.a || 0)*scale;
  const right=s.half-(s.sign>0 ? style.a || 0 : style.b || 0)*scale;
  const width=(right-left)/(lanes.length+opposite);
  if(width<2.15)return false;
  const shapes=[];
  for(let i=0;i<lanes.length;i++){
    const mask=lanes[i];
    if(!mask)continue;
    const v=left+(opposite+i+.5)*width;
    shapes.push(rect(-1.95,0,v-.13,v+.13));
    if(mask&1)shapes.push(rect(0,1.12,v-.13,v+.13),[[.95,v-.46],[1.95,v],[.95,v+.46]]);
    for(const [bit,side] of [[2,-1],[4,1],[8,-1],[16,1]])if(mask&bit){
      const skew=bit>=8?.85:.25;
      const stem=[[0,-.13],[skew+.14,.56],[skew-.14,.56],[0,.13]];
      const head=[[skew-.43,.48],[skew+.43,.48],[skew+.08,1.02]];
      for(const p of [stem,head]){
        const poly=p.map(([u,d])=>[u,v+side*d]);
        if(side<0)poly.reverse();
        shapes.push(poly);
      }
    }
  }
  return paint(s,shapes,positions);
}
