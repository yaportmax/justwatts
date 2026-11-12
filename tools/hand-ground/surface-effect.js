// A horizontal textured cutout with no vertical extent paints a surface; it cannot obstruct it.
// This changes only onroad classification. A floating surface effect still fails support checks.
export function isSurfaceEffect(object,matrix){
 const g=object.geometry;if(!g?.attributes.position)return false;
 if(!g.boundingBox)g.computeBoundingBox();const b=g.boundingBox,m=object.material;
 if(Array.isArray(m)||!m?.map||!(m.transparent||m.alphaTest>0))return false;
 if(b.max.y-b.min.y>1e-5||b.max.x-b.min.x<1e-4||b.max.z-b.min.z<1e-4)return false;
 const e=matrix.elements,nx=e[1]*e[10]-e[2]*e[9],ny=e[2]*e[8]-e[0]*e[10],nz=e[0]*e[9]-e[1]*e[8],scale=Math.hypot(nx,ny,nz);
 return scale>1e-12&&Math.abs(ny)/scale>0.9999;
}
