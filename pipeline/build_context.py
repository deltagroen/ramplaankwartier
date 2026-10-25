"""Stap 7b: omgeving in twee zones, grof en niet bevliegbaar.

- ring  (6 x 6 km, gat = werkgebied): terrein om de 10 m uit het 5 m-DTM, één luchtfototextuur (1,5 m/px),
         gebouwen LoD 2.2 inclusief schuurtjes (dakkleur uit de foto, gevels neutraal, vlakke schaduw in de viewer),
         BGT-water op oeverhoogte, bomen: straatbomen uit BGT en het Haarlemse register (soort), losse bomen uit het
         5 m-kroonhoogtemodel, en dichte bossen als groene kroonlaag op de hoogte van het DSM.
- buiten (10 x 10 km, gat = ring): terrein om de 20 m uit het 10 m-DTM, textuur 2,5 m/px, gebouwen LoD 1.2, water.
Uitvoer: context_terrain.glb, context_objects.glb, context_trees.glb, context_outer_terrain.glb, context_outer_objects.glb.
"""
import glob
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio import features
from rasterio.fill import fillnodata
from rasterio.transform import Affine
from scipy import ndimage
from scipy.ndimage import gaussian_filter, maximum_filter, uniform_filter
from scipy.spatial import cKDTree
from shapely.geometry import Polygon, box, shape
import mapbox_earcut as earcut

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import cityjson as CJ
import ortho
import species as SP
import terrain_common as T
from glb import GLBWriter

Image.MAX_IMAGE_PIXELS = None
WALL = (0.78, 0.74, 0.68)
ROOF_FALLBACK = (0.55, 0.40, 0.33)
rng = np.random.default_rng(11)


def local_xyz(x, y, z):
    return np.stack([x - C.ORIGIN[0], z, -(y - C.ORIGIN[1])], axis=-1)


def inside(bb, x, y):
    return (x >= bb[0]) & (x <= bb[2]) & (y >= bb[1]) & (y <= bb[3])


def load_dtm(path, search=200, big_water=None, big_cells=1500):
    """DTM inlezen en gaten vullen. Grote gaten (zee, grote plassen) krijgen het peil big_water in plaats van
    een extrapolatie van de oevers; kleine gaten (sloten, vijvers) worden vanuit de oevers geinterpoleerd."""
    with rasterio.open(path) as ds:
        a = ds.read(1).astype(np.float64)
        nod = ds.nodata
        tr = ds.transform
    valid = np.isfinite(a) & (a > -100) & (a < 1000)
    if nod is not None:
        valid &= a != nod
    if big_water is not None:
        lab, _ = ndimage.label(~valid)
        sizes = np.bincount(lab.ravel())
        big = np.isin(lab, np.nonzero(sizes >= big_cells)[0]) & ~valid
        a[big] = big_water
        valid |= big
        print(f"  {path.name}: {int(big.sum())} cellen groot water op {big_water} m NAP")
    filled = fillnodata(np.nan_to_num(a, nan=0.0).astype(np.float32), mask=valid.astype(np.uint8),
                        max_search_distance=search, smoothing_iterations=2).astype(np.float64)
    filled[~np.isfinite(filled)] = 0.0
    return filled, tr, valid


def mosaic_from_tiles(folder, sub, bbox, tex_px, out_name):
    minx, miny, maxx, maxy = bbox
    tiles = {(a, b): Image.open(folder / f"r{a}{b}.jpg").convert("RGB") for a in range(sub) for b in range(sub)}
    tw, th = tiles[(0, 0)].size
    canvas = Image.new("RGB", (tw * sub, th * sub))
    for (a, b), tile in tiles.items():
        canvas.paste(tile.resize((tw, th)), (a * tw, (sub - 1 - b) * th))
    canvas.resize((tex_px, tex_px), Image.LANCZOS).save(C.MODEL / "tex" / out_name, "WEBP", quality=80, method=4)
    mtr = Affine((maxx - minx) / canvas.size[0], 0, minx, 0, -(maxy - miny) / canvas.size[1], maxy)
    return np.asarray(canvas), mtr


def build_terrain(bbox, hole, grid, dtm, tr, seam_dtm, seam_tr, tex_name, out_path, mesh_name):
    minx, miny, maxx, maxy = bbox
    nx = int(round((maxx - minx) / grid)) + 1
    ny = int(round((maxy - miny) / grid)) + 1
    xs = minx + np.arange(nx) * grid
    ys = miny + np.arange(ny) * grid
    X, Y = np.meshgrid(xs, ys)
    H = T.sample(dtm, tr, X.ravel(), Y.ravel()).reshape(ny, nx)
    on_hole = inside(hole, X, Y)
    if on_hole.any():
        H[on_hole] = T.sample(seam_dtm, seam_tr, X[on_hole], Y[on_hole])     # naadloos op de rand van het gat
    dHdx = np.gradient(H, grid, axis=1)
    dHdy = np.gradient(H, grid, axis=0)
    N = np.stack([-dHdx, np.ones_like(H), dHdy], axis=-1)
    N /= np.linalg.norm(N, axis=-1, keepdims=True)
    jj, ii = np.meshgrid(np.arange(ny - 1), np.arange(nx - 1), indexing="ij")
    cxs, cys = xs[ii] + grid / 2, ys[jj] + grid / 2
    keep = ~((cxs > hole[0]) & (cxs < hole[2]) & (cys > hole[1]) & (cys < hole[3]))
    A = (jj * nx + ii)[keep]
    tris = np.concatenate([np.stack([A, A + 1, A + nx], axis=-1), np.stack([A + 1, A + nx + 1, A + nx], axis=-1)])
    used, inv = np.unique(tris.ravel(), return_inverse=True)
    tris = inv.reshape(-1, 3)
    pos = local_xyz(X.ravel()[used], Y.ravel()[used], H.ravel()[used])
    uv = np.stack([(X.ravel()[used] - minx) / (maxx - minx), (maxy - Y.ravel()[used]) / (maxy - miny)], axis=1)
    w = GLBWriter()
    m = w.add_material(mesh_name, texture_uri=f"tex/{tex_name}", roughness=1.0)
    w.add_mesh(mesh_name, pos, tris, m, normals=N.reshape(-1, 3)[used], uvs=uv)
    size = w.write(out_path)
    print(f"{out_path.name}: {len(pos)} hoekpunten, {len(tris)} driehoeken, {size/1e6:.1f} MB")
    return H, xs, ys


def aoi_dist(x, y):
    """Afstand (m) tot de rand van het werkgebied, negatief erbinnen."""
    cx, cy = (C.AOI[0] + C.AOI[2]) / 2, (C.AOI[1] + C.AOI[3]) / 2
    return np.maximum(np.abs(x - cx) - (C.AOI[2] - C.AOI[0]) / 2, np.abs(y - cy) - (C.AOI[3] - C.AOI[1]) / 2)


def build_buildings(bbox, hole, lods, mosaic, mtr, near_m=0.0):
    """Gebouwen uit de Kadaster-tegels met zwaartepunt in bbox maar buiten hole. Twee sets: binnen near_m van het
    werkgebied (werpen schaduw in de viewer) en de rest."""
    files = sorted(glob.glob(str(C.RAW / "kadaster3d" / "buildings_*.city.json")))
    sets = {"near": ([], [], [], 0), "far": ([], [], [], 0)}
    foot = []
    nb = 0
    seen = set()
    for f in files:
        cj, V = CJ.load(f)
        cos = cj["CityObjects"]
        for oid, co in cos.items():
            if co.get("type") != "Building":
                continue
            att = co.get("attributes") or {}
            ident = att.get("identificatie", oid)
            if ident in seen:
                continue
            fp = next((gg for gg in co.get("geometry", []) if str(gg.get("lod")) == "0"), None)
            if fp is None or not fp.get("boundaries"):
                continue
            ring = [int(i) for i in fp["boundaries"][0][0]]
            cxy = V[ring][:, :2].mean(axis=0)
            if not inside(bbox, cxy[0], cxy[1]) or inside(hole, cxy[0], cxy[1]):
                continue
            seen.add(ident)
            parts = [cos[c] for c in co.get("children", []) if c in cos] or [co]
            roof_tris, wall_tris = [], []
            for part in parts:
                gm = CJ.pick_geometry(part.get("geometry", []), lods=lods)
                if gm is None:
                    continue
                for rings, st in CJ.faces_of(gm):
                    if st == "GroundSurface":
                        continue
                    tri, n = CJ.triangulate(rings, V)
                    if tri is None:
                        continue
                    (roof_tris if st == "RoofSurface" or (st is None and n[2] > 0.5) else wall_tris).append(tri)
            if not roof_tris and not wall_tris:
                continue
            foot.append(V[ring][:, :2].tolist())
            col = None
            try:
                pg = Polygon(V[ring][:, :2]).buffer(0)
                inner = pg.buffer(-1.0)
                col = ortho.median_colour(mosaic, mtr, inner if not inner.is_empty else pg, min_pixels=2)
            except Exception:
                col = None
            if col is not None:
                g = col.mean()
                roof_col = tuple(np.clip((col - g) * 1.2 + g * 1.05, 0, 1))
            else:
                roof_col = ROOF_FALLBACK
            key = "near" if aoi_dist(cxy[0], cxy[1]) < near_m else "far"
            P, Col, I, vcount = sets[key]
            for group, colr in ((roof_tris, roof_col), (wall_tris, WALL)):
                if not group:
                    continue
                tt = np.vstack(group)
                uniq, invq = np.unique(tt.ravel(), return_inverse=True)
                pts = V[uniq]
                P.append(local_xyz(pts[:, 0], pts[:, 1], pts[:, 2]))
                Col.append(np.tile(colr, (len(uniq), 1)))
                I.append(invq.reshape(-1, 3) + vcount)
                vcount += len(uniq)
            sets[key] = (P, Col, I, vcount)
            nb += 1
    out = {}
    for key, (P, Col, I, vcount) in sets.items():
        out[key] = (np.vstack(P), np.vstack(Col), np.vstack(I)) if P else None
        print(f"  gebouwen {key}: {vcount} hoekpunten, {sum(len(i) for i in I)} driehoeken")
    print(f"  gebouwen: {nb} panden")
    return out, foot


def triangulate_polygon(poly):
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    pts = np.vstack(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = earcut.triangulate_float64(pts, ends)
    return pts, np.asarray(tri, dtype=np.int64).reshape(-1, 3)


def build_water(bbox, hole, path, dtm, tr, tol):
    feats = json.loads(path.read_text())["features"]
    zone, hole_box = box(*bbox), box(*hole)
    WP, WI, polys2d = [], [], []
    wcount = nw = 0
    for ft in feats:
        try:
            geom = shape(ft["geometry"]).buffer(0)
        except Exception:
            continue
        geom = geom.intersection(zone).difference(hole_box).simplify(tol, preserve_topology=True)
        if geom.is_empty:
            continue
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom] if geom.geom_type == "Polygon" else []
        for pg in polys:
            if pg.area < 4 or len(pg.exterior.coords) < 4:
                continue
            ext = np.asarray(pg.exterior.coords)
            level = float(np.percentile(T.sample(dtm, tr, ext[:, 0], ext[:, 1]), 10)) - 0.3
            try:
                pts, tri = triangulate_polygon(pg)
            except Exception:
                continue
            if len(tri) == 0:
                continue
            WP.append(local_xyz(pts[:, 0], pts[:, 1], np.full(len(pts), level)))
            WI.append(tri + wcount)
            wcount += len(pts)
            nw += 1
            polys2d.append(pg)
    print(f"  water: {nw} vlakken, {wcount} hoekpunten")
    return (np.vstack(WP), np.vstack(WI), polys2d) if WP else (None, None, polys2d)


def icosphere0():
    t = (1 + 5 ** 0.5) / 2
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], dtype=np.float64)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    f = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
                  [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5],
                  [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]])
    return v, f


def trunk_geom(sides):
    a = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    ring = np.stack([np.cos(a), np.zeros(sides), np.sin(a)], axis=1)
    f = [[k, (k + 1) % sides, k + sides] for k in range(sides)] + [[(k + 1) % sides, (k + 1) % sides + sides, k + sides] for k in range(sides)]
    return ring, np.array(f)


SPH_V, SPH_F = icosphere0()                                  # kroon dichtbij: 12 hoekpunten, 20 driehoeken
OCT_V = np.array([[0, 1, 0], [0, -1, 0], [1, -0.15, 0], [0, -0.15, 1], [-1, -0.15, 0], [0, -0.15, -1]], dtype=np.float64)
OCT_F = np.array([[0, 3, 2], [0, 4, 3], [0, 5, 4], [0, 2, 5], [1, 2, 3], [1, 3, 4], [1, 4, 5], [1, 5, 2]])   # kroon veraf: 8 driehoeken
TRUNK5 = trunk_geom(5)
TRUNK3 = trunk_geom(3)
NEAR_M = 600.0                                              # tot deze afstand van het werkgebied: fijnere bomen met schaduw
KROON_KLASSE = {"<3": 1.2, "3 - 6": 2.2, "6 - 9": 3.7, "9 - 12": 5.2, "12 - 15": 6.7, "15 - 18": 8.2, "18 - 24": 10.0, ">24": 12.0}


def build_trees_ring(ring_bbox, hole, dtm, tr, footprints, water_polys, table):
    """Bomen in de ring: BGT-boompunten en het Haarlemse register (soort), losse bomen uit het 5 m-kroonhoogtemodel,
    en dichte bossen als kroonlaag op 10 m. Geen takkenmodel: kale kronen worden in de viewer doorzichtig bruin."""
    with rasterio.open(C.RAW / "terrain" / "dsm_ring_5m.tif") as ds:
        raw = ds.read(1).astype(np.float64)
        nod = ds.nodata
    valid = np.isfinite(raw) & (raw > -100) & (raw < 1000)
    if nod is not None:
        valid &= raw != nod
    chm = np.clip(np.where(valid, raw - dtm, 0.0), 0, 45)
    px = abs(tr.a)
    H_, W_ = chm.shape
    shapes = [(Polygon(r).buffer(2.0).__geo_interface__, 1) for r in footprints if len(r) >= 3]
    shapes += [(pg.buffer(1.0).__geo_interface__, 1) for pg in water_polys]
    mask = features.rasterize([sh for sh in shapes if sh[0].get("coordinates")], out_shape=chm.shape, transform=tr,
                              fill=0, dtype="uint8").astype(bool)
    chm_m = np.where(mask, 0.0, chm)
    dens = uniform_filter((chm_m > 3.0).astype(np.float64), size=5)          # aandeel begroeide cellen in 25 m
    forest = (dens >= 0.6) & (chm_m > 3.0)
    lab, _ = ndimage.label(forest)                                             # lanen en tuinen (< 0.25 ha) zijn geen bos
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    forest = sizes[lab] >= 100
    holes = ndimage.binary_fill_holes(forest) & ~forest                        # open plekken tot 1 ha dichtmaken
    lab, _ = ndimage.label(holes)
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    forest |= holes & (sizes[lab] <= 400)
    forest &= ~ndimage.binary_dilation(mask, iterations=1)

    def cell(x, y):
        return int((y - tr.f) / tr.e), int((x - tr.c) / tr.a)

    def chm_at(x, y, rad):
        r_, c = cell(x, y)
        k = int(np.ceil(rad / px))
        win = chm[max(r_ - k, 0):r_ + k + 1, max(c - k, 0):c + k + 1]
        return float(win.max()) if win.size else 0.0

    trees = []                                                                 # (x, y, h, r, spec)

    def add_tree(x, y, spec, kroon=None):
        h = chm_at(x, y, 7.5)
        if h < 2.5:
            h = 5.0
        h = min(h, 32.0)
        r = min(0.35 * h + 1.0, 6.5)
        kl = KROON_KLASSE.get((kroon or "").strip())
        if kl:
            r = float(np.clip(0.6 * kl + 0.4 * r, 1.0, 9.0))
        trees.append((x, y, h, r, spec))

    # --- gemeentelijke bomen: BGT-punten, soort uit het register waar dat binnen 3,5 m een boom heeft ---
    bgt = json.loads((C.RAW / "vector" / "bgt_bomen_ring.geojson").read_text())["features"]
    bxy = np.array([f["geometry"]["coordinates"][:2] for f in bgt if f["geometry"]["type"] == "Point"], dtype=np.float64).reshape(-1, 2)
    keep = inside(ring_bbox, bxy[:, 0], bxy[:, 1]) & ~inside(hole, bxy[:, 0], bxy[:, 1])
    bxy = bxy[keep]
    if len(bxy):
        k = np.ones(len(bxy), bool)
        for a, b in cKDTree(bxy).query_pairs(1.0):
            k[max(a, b)] = False
        bxy = bxy[k]
    reg_path = C.RAW / "vector" / "haarlem_bor_bomen_ring.geojson"
    reg = json.loads(reg_path.read_text())["features"] if reg_path.exists() else []
    rxy = np.array([f["geometry"]["coordinates"][:2] for f in reg], dtype=np.float64).reshape(-1, 2)
    rtree = cKDTree(rxy) if len(rxy) else None
    used = np.zeros(len(reg), bool)
    n_spec = 0
    for x, y in bxy:
        if rtree is not None:
            d, j = rtree.query([x, y])
            if d < 3.5 and not used[j]:
                used[j] = True
                p = reg[j]["properties"]
                add_tree(x, y, table.for_name(p.get("geslachtsnaam"), p.get("naam_lt")), p.get("kroondiameter"))
                n_spec += 1
                continue
        add_tree(x, y, table.generic(float(rng.random())))
    for j, f in enumerate(reg):
        if used[j]:
            continue
        x, y = rxy[j]
        if inside(ring_bbox, x, y) and not inside(hole, x, y):
            p = f["properties"]
            add_tree(x, y, table.for_name(p.get("geslachtsnaam"), p.get("naam_lt")), p.get("kroondiameter"))
            n_spec += 1
    n_muni = len(trees)

    # --- bos: dichte cellen zonder gemeentelijke bomen in de buurt (daar tonen we de bomen zelf) ---
    muni = np.zeros(chm.shape, bool)
    for x, y, *_ in trees:
        r_, c = cell(x, y)
        if 0 <= r_ < H_ and 0 <= c < W_:
            muni[r_, c] = True
    forest &= ~ndimage.binary_dilation(muni, iterations=1)
    print(f"  bos: {int(forest.sum())} cellen van {px:.0f} m ({forest.sum() * px * px / 1e6:.2f} km2)")

    # --- losse bomen uit het kroonhoogtemodel: toppen > 5 m, buiten bos, gebouwen, water en bekende bomen ---
    sm = gaussian_filter(chm_m, sigma=0.7)
    sm[forest | mask] = 0.0
    peaks = (sm == maximum_filter(sm, size=5)) & (sm > 5.0)
    rr, cc = np.nonzero(peaks)
    xs = tr.c + (cc + 0.5) * tr.a
    ys = tr.f + (rr + 0.5) * tr.e
    known = cKDTree(np.array([(t[0], t[1]) for t in trees])) if trees else None
    n_chm = 0
    for x, y in zip(xs, ys):
        if not inside(ring_bbox, x, y) or inside(hole, x, y):
            continue
        if known is not None and known.query([x, y])[0] < 6.0:
            continue
        add_tree(x, y, table.generic(float(rng.random())))
        n_chm += 1
    print(f"  bomen: {n_muni} gemeentelijk ({n_spec} met soort), {n_chm} uit het kroonhoogtemodel")

    # --- geometrie losse bomen: dichtbij icosaeder + 5-kantige stam, veraf octaeder + 3-kantige stam ---
    HB = {"conical": 0.12, "columnar": 0.15, "weeping": 0.22, "small": 0.3}
    out = {}
    for key in ("near", "far"):
        P, N, Col, I, SEAS, SPEC, CROWN = [], [], [], [], [], [], []
        n = 0
        crown_v, crown_f = (SPH_V, SPH_F) if key == "near" else (OCT_V, OCT_F)
        tr_ring, tr_f = TRUNK5 if key == "near" else TRUNK3
        nt = len(tr_ring)
        for x, y, h, r, spec in trees:
            near = aoi_dist(x, y) < NEAR_M
            if near != (key == "near"):
                continue
            prof = table.profiles[spec]
            zg = float(T.sample(dtm, tr, [x], [y])[0])
            lx, _, lz = C.to_local(x, y, 0.0)
            seas = float(rng.random())
            hb = HB.get(prof["shape"], 0.28 if h > 5 else 0.22) * h
            rt = float(np.clip(0.011 * h + 0.02, 0.06, 0.5))
            rv = (h - hb) / 2.0
            sx = r * (0.55 if prof["shape"] == "columnar" else 1.1 if prof["shape"] == "broad" else 1.0)
            v = np.vstack([tr_ring * [rt, 0, rt] + [lx, zg - 0.3, lz], tr_ring * [rt, 0, rt] + [lx, zg + hb + 0.5, lz]])
            P.append(v); N.append(np.vstack([tr_ring, tr_ring])); Col.append(np.tile((0.34, 0.26, 0.18, 1.0), (2 * nt, 1)))
            SEAS.append(np.full(2 * nt, seas, np.float32)); SPEC.append(np.full(2 * nt, spec, np.float32)); CROWN.append(np.zeros(2 * nt, np.float32))
            I.append(tr_f + n); n += 2 * nt
            sv = crown_v * (1.0 + 0.12 * (rng.random((len(crown_v), 1)) - 0.5))
            if prof["shape"] == "conical":
                t_ = (crown_v[:, 1] + 1) / 2
                sv[:, 0] *= 0.15 + 0.85 * (1 - t_); sv[:, 2] *= 0.15 + 0.85 * (1 - t_)
            pts = np.stack([sv[:, 0] * sx + lx, sv[:, 1] * rv + zg + hb + rv, sv[:, 2] * sx + lz], axis=1)
            g = np.clip(np.array(prof["summer"]) * (1.0 + 0.16 * (rng.random(3) - 0.5)), 0, 1)
            P.append(pts); N.append(crown_v.copy()); Col.append(np.tile(np.append(g, 1.0), (len(crown_v), 1)))
            SEAS.append(np.full(len(crown_v), seas, np.float32)); SPEC.append(np.full(len(crown_v), spec, np.float32)); CROWN.append(np.ones(len(crown_v), np.float32))
            I.append(crown_f + n); n += len(crown_v)
        out[key] = (P, N, Col, I, SEAS, SPEC, CROWN)

    # --- kroonlaag op 10 m: hoekpunten op het gladgestreken DSM, seizoen en soort in vlekken van ~75 m ---
    top = dtm + gaussian_filter(chm_m, sigma=1.0)
    gy, gx = np.gradient(top, px)
    f2 = forest[:H_ // 2 * 2, :W_ // 2 * 2].reshape(H_ // 2, 2, W_ // 2, 2).sum(axis=(1, 3)) >= 2
    H2, W2 = f2.shape
    FP, FN, FC, FI, FSEAS, FSPEC, FCROWN = [], [], [], [], [], [], []
    jj, ii = np.nonzero(f2)
    if len(jj):
        A = jj * (W2 + 1) + ii
        tris = np.concatenate([np.stack([A, A + W2 + 1, A + 1], axis=-1), np.stack([A + 1, A + W2 + 1, A + W2 + 2], axis=-1)])
        used, inv = np.unique(tris.ravel(), return_inverse=True)
        cj, ci = np.divmod(used, W2 + 1)
        pr = np.clip(cj * 2, 0, H_ - 1); pc = np.clip(ci * 2, 0, W_ - 1)          # 5 m-pixel bij elke 10 m-hoek
        cx = tr.c + pc * tr.a; cy = tr.f + pr * tr.e
        hz = top[pr, pc]
        nrm = np.stack([-gx[pr, pc], np.ones(len(used)), gy[pr, pc]], axis=1)
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        field = gaussian_filter(rng.random((H_, W_)), sigma=6.0)
        field = (field - field.min()) / (field.max() - field.min() + 1e-9)
        fv = field[pr, pc]
        gen = [table.generic(0.1), table.generic(0.5), table.generic(0.8), table.generic(0.95)]   # geel, oranjebruin, olijf, groenblijvend
        spec_v = np.where(fv > 0.78, gen[3], np.where(fv > 0.52, gen[2], np.where(fv > 0.26, gen[1], gen[0]))).astype(np.float32)
        cols = np.array([table.profiles[int(s_)]["summer"] for s_ in spec_v]) * (0.72 * (0.88 + 0.24 * fv[:, None]))
        cols *= 1.0 + 0.3 * (rng.random((len(used), 1)) - 0.5)                  # korrel, anders oogt het dek als een laken
        FP.append(local_xyz(cx, cy, hz)); FN.append(nrm)
        FC.append(np.hstack([np.clip(cols, 0, 1), np.ones((len(used), 1))]))
        FI.append(inv.reshape(-1, 3)); FSEAS.append(((fv * 7.0) % 1.0).astype(np.float32)); FSPEC.append(spec_v); FCROWN.append(np.ones(len(used), np.float32))
        print(f"  kroonlaag: {len(used)} hoekpunten, {len(tris)} driehoeken")

    w = GLBWriter()
    for key, name in (("near", "omgeving_bomen_nabij"), ("far", "omgeving_bomen")):
        P, N, Col, I, SEAS, SPEC, CROWN = out[key]
        if not P:
            continue
        m = w.add_material(name, roughness=0.95)
        w.add_mesh(name, np.vstack(P), np.vstack(I), m, normals=np.vstack(N), colors=np.vstack(Col),
                   custom={"_SEASON": np.concatenate(SEAS), "_SPEC": np.concatenate(SPEC), "_CROWN": np.concatenate(CROWN)})
        print(f"  {name}: {sum(len(i) for i in I)} driehoeken")
    if FP:
        m3 = w.add_material("omgeving_bos", roughness=0.95, double_sided=True)
        w.add_mesh("omgeving_bos", np.vstack(FP), np.vstack(FI), m3, normals=np.vstack(FN), colors=np.vstack(FC),
                   custom={"_SEASON": np.concatenate(FSEAS), "_SPEC": np.concatenate(FSPEC), "_CROWN": np.concatenate(FCROWN)})
    size = w.write(C.MODEL / "context_trees.glb")
    print(f"context_trees.glb: {len(trees)} bomen, {size/1e6:.1f} MB")


def main(steps):
    C.ensure_dirs()
    ring_dtm, rtr, _ = load_dtm(C.RAW / "terrain" / "dtm_ring_5m.tif")
    mask_path = C.WORK / "context_ring_mask.json"
    if "ring" in steps:
        print("== ring 6 x 6 km")
        aoi_dtm, atr, _ = T.load_dtm_filled(burn_water=True)
        mosaic, mtr = mosaic_from_tiles(C.RAW / "ortho_ring", C.RING_WMS_SUB, C.RING, C.RING_TEX, "ring.webp")
        build_terrain(C.RING, C.AOI, C.RING_GRID, ring_dtm, rtr, aoi_dtm, atr, "ring.webp", C.MODEL / "context_terrain.glb", "omgeving_terrein")
        sets, foot = build_buildings(C.RING, C.AOI, ("2.2", "1.3", "1.2"), mosaic, mtr, near_m=400.0)
        WP, WI, wpolys = build_water(C.RING, C.AOI, C.RAW / "vector" / "bgt_waterdeel_ring.geojson", ring_dtm, rtr, 1.5)
        w = GLBWriter()
        for key, name in (("near", "omgeving_gebouwen_nabij"), ("far", "omgeving_gebouwen")):
            if sets[key] is not None:
                P, Col, I = sets[key]
                m = w.add_material(name, roughness=0.9)
                w.add_mesh(name, P, I, m, colors=Col)
        if WP is not None:
            mw = w.add_material("omgeving_water", color=(0.33, 0.52, 0.70, 0.80), roughness=0.2, alpha_mode="BLEND", double_sided=True)
            w.add_mesh("omgeving_water", WP, WI, mw, normals=np.tile([0.0, 1.0, 0.0], (len(WP), 1)))
        print(f"context_objects.glb: {w.write(C.MODEL / 'context_objects.glb')/1e6:.1f} MB")
        mask_path.write_text(json.dumps({"foot": foot, "water": [pg.wkt for pg in wpolys]}))
    if "bomen" in steps:
        print("== ring: bomen")
        from shapely import wkt as _wkt
        d = json.loads(mask_path.read_text())
        sp_path = C.MODEL / "species.json"
        table = SP.SpeciesTable(json.loads(sp_path.read_text()) if sp_path.exists() else None)
        build_trees_ring(C.RING, C.AOI, ring_dtm, rtr, d["foot"], [_wkt.loads(x) for x in d["water"]], table)
        sp_path.write_text(json.dumps(table.profiles, separators=(",", ":"), ensure_ascii=False))
        print(f"species.json: {len(table.profiles)} profielen")
    if "buiten" in steps:
        print("== buitenzone 10 x 10 km")
        outer_dtm, otr, _ = load_dtm(C.RAW / "terrain" / "dtm_outer_10m.tif", big_water=-0.4, big_cells=1500)
        mosaic_o, mtr_o = mosaic_from_tiles(C.RAW / "ortho_outer", C.OUTER_WMS_SUB, C.OUTER, C.OUTER_TEX, "outer.webp")
        build_terrain(C.OUTER, C.RING, C.OUTER_GRID, outer_dtm, otr, ring_dtm, rtr, "outer.webp", C.MODEL / "context_outer_terrain.glb", "buiten_terrein")
        sets, _ = build_buildings(C.OUTER, C.RING, ("1.2", "1.3", "2.2"), mosaic_o, mtr_o)
        WP, WI, _ = build_water(C.OUTER, C.RING, C.RAW / "vector" / "bgt_waterdeel_outer.geojson", outer_dtm, otr, 3.0)
        w = GLBWriter()
        if sets["far"] is not None:
            P, Col, I = sets["far"]
            m = w.add_material("buiten_gebouwen", roughness=0.9)
            w.add_mesh("buiten_gebouwen", P, I, m, colors=Col)
        if WP is not None:
            mw = w.add_material("buiten_water", color=(0.33, 0.52, 0.70, 0.80), roughness=0.2, alpha_mode="BLEND", double_sided=True)
            w.add_mesh("buiten_water", WP, WI, mw, normals=np.tile([0.0, 1.0, 0.0], (len(WP), 1)))
        print(f"context_outer_objects.glb: {w.write(C.MODEL / 'context_outer_objects.glb')/1e6:.1f} MB")


if __name__ == "__main__":
    main(sys.argv[1:] or ["ring", "bomen", "buiten"])
