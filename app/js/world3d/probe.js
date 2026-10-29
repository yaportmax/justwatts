// Can this page show the 3D world? WebGL2, checked once without loading three.js. Pure enough for node (no document:
// false). tests/test_world3d.py.
let known = null;
export function probeWebGL2(doc = globalThis.document) {
  if (known != null) return known;
  try {
    if (!doc?.createElement) return (known = false);
    const c = doc.createElement('canvas'), gl = c.getContext?.('webgl2');
    known = !!gl;
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
  } catch { known = false; }
  return known;
}
export const resetProbe = () => { known = null; };

// The view the ride map shows: 'world' (3D world), '3d' (MapLibre terrain) or '2d'.
// pref: the rider's choice for this kind of ride ('world' | '3d' | '2d' | null), open: an open-world ride,
// gl: WebGL2 works, failed: the world view broke or was too slow this session.
export function pickView({ pref = null, open = false, gl = false, failed = false, d3 = false }) {
  const world = open && gl && !failed;
  if (pref === 'world') return world ? 'world' : failed && open ? '3d' : d3 ? '3d' : '2d';
  if (pref === '3d' || pref === '2d') return pref;
  if (open) return world ? 'world' : failed ? '3d' : d3 ? '3d' : '2d';
  return d3 ? '3d' : '2d';
}
