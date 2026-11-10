"""Defect check: no floating leaves in the hand-built vegetation (app/world/hand/veg.json, veg/*.glb, conz_*.glb).

A model's visible leaves are its opaque texels, not its cards: a card can overlap its neighbours while what it shows hangs in
the air. So every triangle's opaque texels are sampled into voxels in the model's own space, the voxels are closed over a small
gap, and any connected cluster that does not reach the ground and is wider than MIN_CLUSTER counts as a floater.
A plant whose foot stands more than MAX_FOOT over the hand terrain under it counts too.

    python tests/test_veg_floaters.py [app dir] [--glb extra.glb ...]   (prints per species; exit 1 when the total is not 0)
"""
import json
import struct
import sys
from io import BytesIO
from pathlib import Path

import pytest

np = pytest.importorskip("numpy") if "pytest" in sys.modules else __import__("numpy")
if "pytest" in sys.modules:
    pytest.importorskip("scipy")
    pytest.importorskip("PIL")
from PIL import Image  # noqa: E402
from scipy import ndimage as nd  # noqa: E402

APP = Path(__file__).resolve().parent.parent / "app"
# (validated 2026-11-02 on the known-bad card shrub of the a22 14:06 renders: 6 floaters up to 1.15 m wide at these values, and
# 0 on every shipped model; a 0.025 m voxel or a closed gap of 0 no longer told them apart)
VOXEL_SHARE = 0.012  # voxel size as a share of the model's height
MIN_VOXEL = 0.02     # metres, at the plant's largest scale
GAP_VOXELS = 1       # gaps up to about two voxels count as attached
GROUND_SHARE = 0.12  # a cluster reaching this share of the height is on the ground
MIN_CLUSTER = 0.06   # metres: a loose cluster narrower than this is a stray leaf at the mound's edge, not a floater
MAX_FOOT = 0.35      # metres over the hand terrain


def load_veg(hand):
    """veg.json's head with its groups' plants (veg/g<k>.bin, little-endian floats, species after species) back in veg["species"]"""
    veg = json.loads((hand / "veg.json").read_text())
    parts = {}
    for g in veg["groups"]:
        a = np.fromfile(hand / g["file"], dtype="<f4")
        off = 0
        for sp, n in g["species"].items():
            st = veg.get("stride", {}).get(sp, 7)  # (A30: low plants carry their slope, stride 9)
            parts.setdefault(sp, []).append(a[off : off + st * n].reshape(-1, st)[:, :7].reshape(-1))
            off += st * n
    veg["species"] = {sp: np.concatenate(v) for sp, v in parts.items()}
    return veg


def read_glb(path):
    b = Path(path).read_bytes()
    n = struct.unpack_from("<I", b, 12)[0]
    j = json.loads(b[20:20 + n])
    if "EXT_meshopt_compression" in j.get("extensionsUsed", []):  # (the road's chunks: back to a plain glb through the app's own decoder)
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "u.glb"
            subprocess.run(["node", str(Path(__file__).parent / "js" / "unmeshopt.mjs"), str(path), str(out)], check=True)
            b = out.read_bytes()
        n = struct.unpack_from("<I", b, 12)[0]
        j = json.loads(b[20:20 + n])
    bin0 = 20 + n + 8

    def acc(i):
        a = j["accessors"][i]
        v = j["bufferViews"][a["bufferView"]]
        t = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a["componentType"]]
        c = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        o = bin0 + v.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(b, t, a["count"] * c, o).reshape(-1, c)

    def image(mat):
        tex = j["materials"][mat].get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if not tex:
            return None
        t = j["textures"][tex["index"]]
        src = t.get("source", t.get("extensions", {}).get("EXT_texture_webp", {}).get("source"))
        v = j["bufferViews"][j["images"][src]["bufferView"]]
        o = bin0 + v.get("byteOffset", 0)
        return np.asarray(Image.open(BytesIO(b[o:o + v["byteLength"]])).convert("RGBA"))[..., 3]

    return j, acc, image


def model_parts(path):
    """[(node name, positions n*3 y up, uvs n*2 or None, triangle indices m*3, alpha image or None)]"""
    j, acc, image = read_glb(path)
    out = []
    for nd_ in j["nodes"]:
        if nd_.get("mesh") is None:
            continue
        t = np.array(nd_.get("translation", [0, 0, 0]), float)
        s = np.array(nd_.get("scale", [1, 1, 1]), float)
        for p in j["meshes"][nd_["mesh"]]["primitives"]:
            pos = acc(p["attributes"]["POSITION"]).astype(float) * s + t
            uv = acc(p["attributes"]["TEXCOORD_0"]).astype(float) if "TEXCOORD_0" in p["attributes"] else None
            tri = acc(p["indices"]).astype(int).reshape(-1, 3) if "indices" in p else np.arange(len(pos)).reshape(-1, 3)
            out.append((nd_.get("name", ""), pos, uv, tri, image(p["material"]) if "material" in p else None))
    return out


def opaque_points(pos, uv, tri, alpha, step):
    """world points of a part's opaque texels, sampled about every step metres"""
    pts = []
    for ia, ib, ic in tri:
        a, b, c = pos[ia], pos[ib], pos[ic]
        n = int(max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)) / step) + 2
        i, k = np.meshgrid(np.arange(n + 1), np.arange(n + 1))
        keep = i + k <= n
        l1, l2 = i[keep] / n, k[keep] / n
        l0 = 1 - l1 - l2
        p = l0[:, None] * a + l1[:, None] * b + l2[:, None] * c
        if alpha is not None and uv is not None:
            u = l0 * uv[ia, 0] + l1 * uv[ib, 0] + l2 * uv[ic, 0]
            v = l0 * uv[ia, 1] + l1 * uv[ib, 1] + l2 * uv[ic, 1]
            h, w = alpha.shape
            p = p[alpha[np.clip((v % 1 * h).astype(int), 0, h - 1), np.clip((u % 1 * w).astype(int), 0, w - 1)] >= 128]
        pts.append(p)
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def model_floaters(path, scale=(1, 1, 1)):
    """clusters of opaque voxels off the ground and wider than MIN_CLUSTER, in lod0 and in each lod1 card set, at a plant scale
    (x, y, z): a stretched plant's gaps stretch with it"""
    res = {}
    parts = [(n, pos * np.array(scale, float), uv, tri, al) for n, pos, uv, tri, al in model_parts(path)]
    for lod in ("lod0", "lod1"):
        sel = [p for p in parts if lod in p[0]]
        if not sel:
            continue
        H = max(p[1][:, 1].max() for p in sel) - min(p[1][:, 1].min() for p in sel)
        vox = max(MIN_VOXEL, H * VOXEL_SHARE)
        pts = np.concatenate([opaque_points(p[1], p[2], p[3], p[4], vox / 2) for p in sel])
        if not len(pts):
            res[lod] = []
            continue
        g = np.floor((pts - pts.min(0)) / vox).astype(int)
        grid = np.zeros(g.max(0) + 1 + 2 * GAP_VOXELS, bool)
        grid[tuple((g + GAP_VOXELS).T)] = True
        closed = nd.binary_dilation(grid, np.ones((3, 3, 3), bool), iterations=GAP_VOXELS)
        lab, n = nd.label(closed, np.ones((3, 3, 3), bool))
        low = int(np.ceil(GROUND_SHARE * H / vox)) + GAP_VOXELS
        grounded = set(np.unique(lab[:, :low, :])) - {0}
        loose = []
        for i, s in enumerate(nd.find_objects(lab), 1):
            if i in grounded:
                continue
            extent = max(sl.stop - sl.start - 2 * GAP_VOXELS for sl in s) * vox
            if extent >= MIN_CLUSTER:
                loose.append(round(float(extent), 2))
        res[lod] = loose
    return res


def terrain_grid(app):
    """highest hand terrain per metre {(x, z): y} from conz_<i>.glb's terrain and verge meshes"""
    hand = Path(app) / "world" / "hand"
    conz = json.loads((hand / "conz.json").read_text())
    grid = {}
    for c in conz["chunks"]:
        f = hand / f"conz_{c['i']}.glb"
        if not f.exists():
            continue
        for name, pos, _, tri, _ in model_parts_nomat(f):
            if not name.startswith(("terrain", "verge")):
                continue
            q = pos + [c["cx"], 0, c["cz"]]
            for t in q[tri]:
                x0, x1 = np.floor(t[:, 0].min()), np.ceil(t[:, 0].max())
                z0, z1 = np.floor(t[:, 2].min()), np.ceil(t[:, 2].max())
                y = float(t[:, 1].max())
                if (x1 - x0) * (z1 - z0) > 400:
                    continue
                for x in range(int(x0), int(x1) + 1):
                    for z in range(int(z0), int(z1) + 1):
                        if y > grid.get((x, z), -1e9):
                            grid[(x, z)] = y
    return grid


def model_parts_nomat(path):
    j, acc, _ = read_glb(path)
    for n in j["nodes"]:
        if n.get("mesh") is None:
            continue
        t = np.array(n.get("translation", [0, 0, 0]), float)
        for p in j["meshes"][n["mesh"]]["primitives"]:
            pos = acc(p["attributes"]["POSITION"]).astype(float) + t
            tri = acc(p["indices"]).astype(int).reshape(-1, 3) if "indices" in p else np.arange(len(pos)).reshape(-1, 3)
            yield n.get("name", ""), pos, None, tri, None


def foot_floaters(app):
    """plants whose foot stands more than MAX_FOOT over the highest hand terrain within a metre of it"""
    hand = Path(app) / "world" / "hand"
    veg = load_veg(hand)
    grid = terrain_grid(app)
    out = {}
    for sp, a in veg["species"].items():
        a = np.array(a).reshape(-1, 7)
        bad = 0
        for x, y, z, *_ in a:
            k = (round(x), round(z))
            h = grid.get(k)
            if h is not None and y - h > MAX_FOOT:
                bad += 1
        out[sp] = bad
    return out


def road_overhangs(app):
    """plants whose crown (the model's farthest opaque-or-not vertex from its axis, at the plant's width) reaches over the road, kerbs or paint"""
    hand = Path(app) / "world" / "hand"
    veg = load_veg(hand)
    conz = json.loads((hand / "conz.json").read_text())
    g = {}
    for c in conz["chunks"]:
        f = hand / f"conz_{c['i']}.glb"
        if not f.exists():
            continue
        for name, pos, _, tri, _ in model_parts_nomat(f):
            if not name.startswith(("road", "kerb", "paint")):
                continue
            q = (pos + [c["cx"], 0, c["cz"]])[:, [0, 2]]
            for t in q[tri]:
                for X in range(int(t[:, 0].min() // 4), int(t[:, 0].max() // 4) + 1):
                    for Z in range(int(t[:, 1].min() // 4), int(t[:, 1].max() // 4) + 1):
                        g.setdefault((X, Z), []).append(t)

    def dist(x, z, reach):
        n = int(reach // 4) + 1
        d = 1e9
        P = np.array([x, z])
        for X in range(int(x // 4) - n, int(x // 4) + n + 1):
            for Z in range(int(z // 4) - n, int(z // 4) + n + 1):
                for t in g.get((X, Z), ()):
                    a, b, c = t
                    v0, v1, v2 = c - a, b - a, P - a
                    den = v0[0] * v1[1] - v1[0] * v0[1]
                    if den:
                        u, v = (v2[0] * v1[1] - v1[0] * v2[1]) / den, (v0[0] * v2[1] - v2[0] * v0[1]) / den
                        if u >= 0 and v >= 0 and u + v <= 1:
                            return 0.0
                    for e0, e1 in ((a, b), (b, c), (c, a)):
                        w = e1 - e0
                        l = w @ w
                        k = min(1.0, max(0.0, (P - e0) @ w / l)) if l else 0.0
                        d = min(d, float(np.hypot(*(P - e0 - k * w))))
        return d

    G = {k: np.array(v) for k, v in g.items()}

    def near_any(P, eps):
        """(A37: the same test as dist(x, z, 1.0) < eps for any of the points, vectorised: thousands of trees now)"""
        cells = {(int(x // 4) + i, int(z // 4) + k) for x, z in P for i in (-1, 0, 1) for k in (-1, 0, 1)}
        T = [G[c] for c in cells if c in G]
        if not T:
            return False
        T = np.concatenate(T)
        A, B, C = T[:, 0][None], T[:, 1][None], T[:, 2][None]
        Q = np.asarray(P, float)[:, None, :]
        v0, v1, v2 = C - A, B - A, Q - A
        den = v0[..., 0] * v1[..., 1] - v1[..., 0] * v0[..., 1]
        with np.errstate(divide="ignore", invalid="ignore"):
            u = (v2[..., 0] * v1[..., 1] - v1[..., 0] * v2[..., 1]) / den
            v = (v0[..., 0] * v2[..., 1] - v2[..., 0] * v0[..., 1]) / den
        if np.any((den != 0) & (u >= 0) & (v >= 0) & (u + v <= 1)):
            return True
        for e0, e1 in ((A, B), (B, C), (C, A)):
            w = e1 - e0
            l = (w * w).sum(-1)
            with np.errstate(divide="ignore", invalid="ignore"):
                k = np.where(l > 0, np.clip(((Q - e0) * w).sum(-1) / l, 0, 1), 0)
            if np.any(np.hypot(*(Q - e0 - k[..., None] * w).transpose(2, 0, 1)) < eps):
                return True
        return False

    out = {}
    for sp, a in veg["species"].items():
        pts = np.concatenate([q[1] for q in model_parts(hand / "veg" / f"{sp}.glb")])
        # (A37: every tree, not only the oak: crowns may span the road high up, as Street View has them, w_east2, w_murray0; place_roads37 /
        # export_veg37 fit each crown to its lod0 leaves at 4.5 m over the road)
        if sp in ("willow", "willow2", "mcyp", "mcyp2", "loak", "loak2", "oak", "wood", "btree", "cypress", "cyp2", "cyp3", "cypt", "cypt2", "lime", "lime2", "bushtree", "euc", "euc2"):  # a one-sided crown: its own lod0 vertices at each plant's turn and width, not a circle round its trunk
            pts0 = np.concatenate([q[1] for q in model_parts(hand / "veg" / f"{sp}.glb") if "lod0" in q[0]])[::40]
            n = 0
            for x, _, z, r, sx, sy, sw in np.array(a).reshape(-1, 7):
                c, s = np.cos(r), np.sin(r)
                # (over the road only high up, 4 m and more: sb1_0545_a, the oak's limbs span the road)
                low = pts0[pts0[:, 1] * sy < 4.0]
                if len(low):
                    n += near_any(np.c_[x + low[:, 0] * sx * c + low[:, 2] * sw * s, z - low[:, 0] * sx * s + low[:, 2] * sw * c], 0.2)
            out[sp] = n
            continue
        if sp == "shade":
            continue
        if sp in ("avc", "avc2"):  # the avenue's tall cypress: the crown spans the road by design (s7w_14255_a), only a trunk on the road counts
            out[sp] = sum(1 for x, _, z, *_ in np.array(a).reshape(-1, 7) if dist(x, z, 1.0) < 0.4)
            continue
        r0 = float(np.hypot(pts[:, 0], pts[:, 2]).max())
        out[sp] = sum(1 for x, _, z, _, sx, _, sw in np.array(a).reshape(-1, 7) if dist(x, z, r0 * max(sx, sw)) < r0 * max(sx, sw))
    return out


def run(app, extra=()):
    hand = Path(app) / "world" / "hand"
    veg = load_veg(hand)
    total = 0
    lines = []
    for sp in veg["species"]:
        if sp == "shade":  # a flat decal on the road, not a plant: its dapples are apart by design
            continue
        a = np.array(veg["species"][sp]).reshape(-1, 7)
        r = model_floaters(hand / "veg" / f"{sp}.glb", tuple(a[:, 4:7].max(0)))
        n = sum(len(v) for v in r.values())
        total += n
        lines.append(f"{sp}: model floaters {n} at scale {tuple(a[:, 4:7].max(0).round(2).tolist())} {r if n else ''}")
    feet = foot_floaters(app)
    for sp, n in feet.items():
        if sp == "shade":  # a road decal: it stands on the paving, which can lie over the terrain
            continue
        total += n
        lines.append(f"{sp}: plants with a raised foot {n}")
    for sp, n in road_overhangs(app).items():
        total += n
        lines.append(f"{sp}: crowns over the road {n}")
    for g in extra:
        r = model_floaters(g)
        lines.append(f"(extra, not counted) {Path(g).name}: model floaters {sum(len(v) for v in r.values())} {r}")
    return total, lines


def test_no_floating_leaves():
    if not (APP / "world" / "hand" / "veg.json").exists():
        pytest.skip("no hand vegetation")
    total, lines = run(APP)
    assert total == 0, "\n".join(lines)


if __name__ == "__main__":
    args = sys.argv[1:]
    extra = []
    if "--glb" in args:
        i = args.index("--glb")
        extra = args[i + 1:]
        args = args[:i]
    total, lines = run(args[0] if args else APP, extra)
    print("\n".join(lines))
    print("floaters total", total)
    sys.exit(1 if total else 0)
