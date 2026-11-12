import {writeFileSync} from 'node:fs';
export function modelFixture(path,decal=false){
 const j={asset:{version:'2.0'},nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],accessors:[{type:'VEC3',count:3,min:[-1,0,-1],max:[1,decal?0:1,1]}],materials:[{alphaMode:decal?'BLEND':'OPAQUE',pbrMetallicRoughness:{baseColorTexture:{index:0}}}]};
 let text=JSON.stringify(j);text+=' '.repeat((4-text.length%4)%4);const b=Buffer.alloc(20+Buffer.byteLength(text));b.writeUInt32LE(0x46546c67,0);b.writeUInt32LE(2,4);b.writeUInt32LE(b.length,8);b.writeUInt32LE(b.length-20,12);b.writeUInt32LE(0x4e4f534a,16);b.write(text,20);writeFileSync(path,b);
}
