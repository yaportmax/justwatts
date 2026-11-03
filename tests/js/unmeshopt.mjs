// A hand chunk (EXT_meshopt_compression, tools gltfpack -cc) back to a plain GLB for the checks that parse glbs themselves.
//   node unmeshopt.mjs in.glb out.glb
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptDecoder } from '../../app/vendor/three-0.180.0/addons/libs/meshopt_decoder.module.js';
await MeshoptDecoder.ready;
const b = readFileSync(process.argv[2]), n = b.readUInt32LE(12), J = JSON.parse(b.subarray(20, 20 + n).toString()), bin = b.subarray(20 + n + 8);
const parts = []; let off = 0;
for (const v of J.bufferViews) {
  const e = v.extensions?.EXT_meshopt_compression; let out;
  if (e) { const u = new Uint8Array(e.count * e.byteStride); MeshoptDecoder.decodeGltfBuffer(u, e.count, e.byteStride, bin.subarray(e.byteOffset ?? 0, (e.byteOffset ?? 0) + e.byteLength), e.mode, e.filter); out = u; v.byteStride = e.mode === 'ATTRIBUTES' ? e.byteStride : undefined; delete v.extensions; }
  else if (v.buffer === undefined || J.buffers[v.buffer].extensions?.EXT_meshopt_compression) { out = new Uint8Array(0); }
  else out = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); off += pad; }
  v.buffer = 0; v.byteOffset = off; v.byteLength = out.length; parts.push(out); off += out.length;
}
J.buffers = [{ byteLength: off }]; delete J.extensionsUsed; delete J.extensionsRequired;
const body = Buffer.concat(parts), pad2 = (4 - (body.length % 4)) % 4, B2 = Buffer.concat([body, Buffer.alloc(pad2)]);
let js = Buffer.from(JSON.stringify(J)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 32)]);
const head = Buffer.alloc(12); head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + B2.length, 8);
const h1 = Buffer.alloc(8); h1.writeUInt32LE(js.length, 0); h1.writeUInt32LE(0x4E4F534A, 4); const h2 = Buffer.alloc(8); h2.writeUInt32LE(B2.length, 0); h2.writeUInt32LE(0x004E4942, 4);
writeFileSync(process.argv[3], Buffer.concat([head, h1, js, h2, B2]));
