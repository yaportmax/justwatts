import assert from 'node:assert/strict';
import { buildingGeometry } from '../../app/js/world3d/props.js';
import { footprintGap } from '../../app/js/world3d/footprint.js';

// A small missing notch can have a large fill ratio; its bounding box still
// reaches across the open space. Include duplicate corners and a zero-rise roof.
const cases = [
  { ring: [[0,0],[40,0],[40,10],[25,10],[25,6],[21,6],[21,10],[0,10],[0,0]], h: 6, rh: 3, seed: 13 },
  { ring: [[0,0],[30,0],[30,2],[2,2],[2,28],[0,28],[0,0]], h: 5, rh: 3, seed: 19 },
  { ring: [[0,0],[10,0],[10,0],[10,10],[0,10],[0,0]], h: 6, rh: 0, seed: 2 },
  { ring: [[0,0],[20,0],[20,12],[0,12],[0,0]], h: 9, maxTop: 10, seed: 17 },
  { ring: [[0,0],[20,0],[20,12],[0,12],[0,0]], h: 8.4, maxTop: 9, minEave: 8.4, seed: 17 },
  // A zero-rise gable is collinear before packing; Float32 rounding used to
  // turn it into a tiny downward horizontal triangle instead of removing it.
  { ring: [[13996.234790372491,16315.760433529027],[13997.086482099241,16329.973275867036],[14001.41120082392,16329.979616470382],[14000.531020208198,16315.759252013379],[13996.234790372491,16315.760433529027]], base:52.88240826640853,h:3.6172961750497605,maxTop:56.09970444145829,minEave:56.09970444145829,seed:296161 },
  // Quantized Mill Valley outline with a short backtrack. Overall ring winding
  // alone previously left three primary wall faces pointing into the building.
  { ring: [[7246.37,2471.88],[7250.71,2482.92],[7262.91,2478.50],[7262.03,2476.29],[7259.40,2476.28],[7258.52,2471.89],[7255.02,2473.02],[7255.89,2474.07],[7255.05,2471.93],[7257.65,2471.89],[7255.94,2467.48],[7247.24,2470.78],[7246.37,2471.88]], h: 6.07, rh: 0.7, seed: 111506 },
];
const angle = 0.37, axis = [Math.cos(angle),Math.sin(angle)], centre = [13200,10500];
const rotated = [[-15,-6.5],[15,-6.5],[15,6.5],[-15,6.5],[-15,-6.5]].map(([s,t])=>[centre[0]+axis[0]*s-axis[1]*t,centre[1]+axis[1]*s+axis[0]*t]);
cases.push({ring:rotated,h:6,rh:3,maxTop:9,seed:13,gable:true});
let faces = 0;
for (const input of cases) {
  const b = { base: 0, ...input }, g = buildingGeometry([b]), p = g.attributes.position, bw = g.attributes.bw;
  assert.ok(p.count > 0);
  for (let i = 0; i < p.count; i++) {
    assert.ok(footprintGap(b.ring, p.getX(i), p.getZ(i)) <= 1.45 + 1e-4);
    assert.ok(p.getY(i) <= (b.maxTop ?? b.h + b.rh) + 1e-4);
  }
  if (b.minEave != null) {
    const wallTop = Math.max(...Array.from({length:p.count},(_,i)=>bw.getW(i)===0?p.getY(i):-Infinity));
    assert.ok(wallTop >= b.minEave-1e-4, 'roof height cap preserves the exposed uphill storey');
  }
  for (let i = 0; i < p.count; i += 3) {
    const a = [p.getX(i),p.getY(i),p.getZ(i)], u = [p.getX(i+1)-a[0],p.getY(i+1)-a[1],p.getZ(i+1)-a[2]], v = [p.getX(i+2)-a[0],p.getY(i+2)-a[1],p.getZ(i+2)-a[2]];
    const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    assert.ok(Math.hypot(...n) > 1e-7);
    assert.ok(n[1] >= -Math.hypot(n[0],n[2])*.01-1e-6, 'horizontal and sloping roofs face up; vertical walls tolerate coordinate rounding');
    if (b.gable && bw.getW(i) === 2 && Math.min(a[1],a[1]+u[1],a[1]+v[1]) >= 5.99 && Math.abs(n[1]) < Math.hypot(n[0],n[2])*.01) {
      const side = Math.sign((a[0]+(u[0]+v[0])/3-centre[0])*axis[0]+(a[2]+(u[2]+v[2])/3-centre[1])*axis[1]);
      assert.ok((n[0]*axis[0]+n[2]*axis[1])*side>0,'translated gable ends face outward despite Float32 tilt');
    }
    if (bw.getW(i) === 0) {
      const length = Math.hypot(n[0],n[2]), x = a[0]+(u[0]+v[0])/3, z = a[2]+(u[2]+v[2])/3;
      if (length > 1e-6) assert.ok(footprintGap(b.ring,x+n[0]/length*.1,z+n[2]/length*.1) >= footprintGap(b.ring,x-n[0]/length*.1,z-n[2]/length*.1)-.05, 'primary wall faces away from its interior');
    }
    faces++;
  }
}
console.log(JSON.stringify({ cases: cases.length, faces }));
