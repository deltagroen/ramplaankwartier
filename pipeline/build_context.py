"""Stap 7b: omgeving ("ring") -> viewer/model/context_terrain.glb en context_objects.glb.

Grof en niet bevliegbaar: 6 x 6 km rond de wijk met een gat voor het werkgebied.
- Terrein: AHN-DTM op 5 m (WCS geschaald), hoekpunten om de 10 m, één luchtfototextuur van 4096 px (1,5 m/px);
  randhoekpunten die op de rand van het werkgebied liggen krijgen de hoogte van het fijne DTM (geen kier).
- Gebouwen: Kadaster LoD 1.2 (blokken), dakkleur = mediaan van de luchtfoto, gevels neutraal; zonder normalen,
  de viewer gebruikt vlakke schaduw.
- Water: BGT-waterdelen, afgesneden op het werkgebied, op een hoogte uit het DTM langs de oever.
"""
import glob
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.fill import fillnodata
from rasterio.transform import Affine
from scipy.ndimage import map_coordinates
from shapely.geometry import Polygon, box, shape
import mapbox_earcut as earcut

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import cityjson as CJ
import ortho
import terrain_common as T
from glb import GLBWriter

Image.MAX_IMAGE_PIXELS = None
WALL = (0.78, 0.74, 0.68)
ROOF_FALLBACK = (0.55, 0.40, 0.33)


def local_xyz(x, y, z):
    return np.stack([x - C.ORIGIN[0], z, -(y - C.ORIGIN[1])], axis=-1)


def triangulate_polygon(poly):
    """Polygon (met gaten) -> (punten (n,2), driehoeken (m,3))."""
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    pts = np.vstack(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = earcut.triangulate_float64(pts, ends)
    return pts, np.asarray(tri, dtype=np.int64).reshape(-1, 3)


def main():
    C.ensure_dirs()
    rminx, rminy, rmaxx, rmaxy = C.RING
    aminx, aminy, amaxx, amaxy = C.AOI

    # ---------- terrein ----------
    with rasterio.open(C.RAW / "terrain" / "dtm_ring_5m.tif") as ds:
        a = ds.read(1).astype(np.float64)
        nod = ds.nodata
        rtr = ds.transform
    valid = np.isfinite(a) & (a > -100) & (a < 1000)
    if nod is not None:
        valid &= a != nod
    ring_dtm = fillnodata(np.nan_to_num(a, nan=0.0).astype(np.float32), mask=valid.astype(np.uint8),
                         max_search_distance=200, smoothing_iterations=2).astype(np.float64)
    ring_dtm[~np.isfinite(ring_dtm)] = 0.0
    aoi_dtm, atr, _ = T.load_dtm_filled(burn_water=True)

    g = C.RING_GRID
    nx = int(round((rmaxx - rminx) / g)) + 1
    ny = int(round((rmaxy - rminy) / g)) + 1
    xs = rminx + np.arange(nx) * g
    ys = rminy + np.arange(ny) * g
    X, Y = np.meshgrid(xs, ys)
    H = T.sample(ring_dtm, rtr, X.ravel(), Y.ravel()).reshape(ny, nx)
    on_aoi = (X >= aminx - 1e-6) & (X <= amaxx + 1e-6) & (Y >= aminy - 1e-6) & (Y <= amaxy + 1e-6)
    H[on_aoi] = T.sample(aoi_dtm, atr, X[on_aoi], Y[on_aoi])            # naadloos op de rand van het werkgebied
    dHdx = np.gradient(H, g, axis=1)
    dHdy = np.gradient(H, g, axis=0)
    N = np.stack([-dHdx, np.ones_like(H), dHdy], axis=-1)
    N /= np.linalg.norm(N, axis=-1, keepdims=True)
    # cellen: alles behalve cellen met het midden in het werkgebied
    jj, ii = np.meshgrid(np.arange(ny - 1), np.arange(nx - 1), indexing="ij")
    cxs = xs[ii] + g / 2
    cys = ys[jj] + g / 2
    keep = ~((cxs > aminx) & (cxs < amaxx) & (cys > aminy) & (cys < amaxy))
    A = (jj * nx + ii)[keep]
    B = A + 1
    D = A + nx
    Cc = D + 1
    tris = np.concatenate([np.stack([A, B, D], axis=-1), np.stack([B, Cc, D], axis=-1)])
    used, inv = np.unique(tris.ravel(), return_inverse=True)
    tris = inv.reshape(-1, 3)
    pos = local_xyz(X.ravel()[used], Y.ravel()[used], H.ravel()[used])
    uv = np.stack([(X.ravel()[used] - rminx) / (rmaxx - rminx), (rmaxy - Y.ravel()[used]) / (rmaxy - rminy)], axis=1)
    nrm = N.reshape(-1, 3)[used]
    print(f"ringterrein: {len(pos)} hoekpunten, {len(tris)} driehoeken")

    # textuur
    sub = C.RING_WMS_SUB
    tiles = {(aa, bb): Image.open(C.RAW / "ortho_ring" / f"r{aa}{bb}.jpg").convert("RGB") for aa in range(sub) for bb in range(sub)}
    tw, th = tiles[(0, 0)].size
    canvas = Image.new("RGB", (tw * sub, th * sub))
    for (aa, bb), tile in tiles.items():
        canvas.paste(tile.resize((tw, th)), (aa * tw, (sub - 1 - bb) * th))
    canvas.resize((C.RING_TEX, C.RING_TEX), Image.LANCZOS).save(C.MODEL / "tex" / "ring.webp", "WEBP", quality=80, method=4)
    mosaic = np.asarray(canvas)
    mtr = Affine((rmaxx - rminx) / canvas.size[0], 0, rminx, 0, -(rmaxy - rminy) / canvas.size[1], rmaxy)

    wt = GLBWriter()
    m = wt.add_material("omgeving_terrein", texture_uri="tex/ring.webp", roughness=1.0)
    wt.add_mesh("omgeving_terrein", pos, tris, m, normals=nrm, uvs=uv)
    size = wt.write(C.MODEL / "context_terrain.glb")
    print(f"context_terrain.glb: {size/1e6:.1f} MB")

    # ---------- gebouwen (blokken) ----------
    files = sorted(glob.glob(str(C.RAW / "kadaster3d" / "buildings_*.city.json")))
    P, Col, I = [], [], []
    vcount = 0
    seen = set()
    nb = 0
    aoi_box = box(aminx, aminy, amaxx, amaxy)
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
            if not (rminx <= cxy[0] <= rmaxx and rminy <= cxy[1] <= rmaxy):
                continue
            if aminx <= cxy[0] <= amaxx and aminy <= cxy[1] <= amaxy:
                continue                                        # zit al in het gedetailleerde model
            seen.add(ident)
            parts = [cos[c] for c in co.get("children", []) if c in cos] or [co]
            roof_tris, wall_tris = [], []
            for part in parts:
                gm = CJ.pick_geometry(part.get("geometry", []), lods=("1.2", "1.3", "2.2"))
                if gm is None:
                    continue
                for rings, st in CJ.faces_of(gm):
                    if st == "GroundSurface":
                        continue
                    tri, n = CJ.triangulate(rings, V)
                    if tri is None:
                        continue
                    (roof_tris if st == "RoofSurface" or (n is not None and n[2] > 0.5) else wall_tris).append(tri)
            if not roof_tris and not wall_tris:
                continue
            try:
                pg = Polygon(V[ring][:, :2]).buffer(0)
                col = ortho.median_colour(mosaic, mtr, pg.buffer(-1.0) if not pg.buffer(-1.0).is_empty else pg, min_pixels=2)
            except Exception:
                col = None
            roof_col = tuple(np.clip((np.asarray(col) - np.asarray(col).mean()) * 1.2 + np.asarray(col).mean() * 1.05, 0, 1)) if col is not None else ROOF_FALLBACK
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
            nb += 1
    print(f"ringgebouwen: {nb} panden, {vcount} hoekpunten")

    # ---------- water ----------
    wfeat = json.loads((C.RAW / "vector" / "bgt_waterdeel_ring.geojson").read_text())["features"]
    WP, WI = [], []
    wcount = 0
    ring_box = box(rminx, rminy, rmaxx, rmaxy)
    nw = 0
    for ft in wfeat:
        try:
            geom = shape(ft["geometry"]).buffer(0)
        except Exception:
            continue
        geom = geom.intersection(ring_box).difference(aoi_box).simplify(1.5, preserve_topology=True)
        if geom.is_empty:
            continue
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom] if geom.geom_type == "Polygon" else []
        for pg in polys:
            if pg.area < 4 or len(pg.exterior.coords) < 4:
                continue
            ext = np.asarray(pg.exterior.coords)
            hs = T.sample(ring_dtm, rtr, ext[:, 0], ext[:, 1])
            level = float(np.percentile(hs, 10)) - 0.3
            try:
                pts, tri = triangulate_polygon(pg)
            except Exception:
                continue
            if len(tri) == 0:
                continue
            z = np.full(len(pts), level)
            WP.append(local_xyz(pts[:, 0], pts[:, 1], z))
            WI.append(tri + wcount)
            wcount += len(pts)
            nw += 1
    print(f"ringwater: {nw} vlakken, {wcount} hoekpunten")

    wo = GLBWriter()
    if P:
        mb = wo.add_material("omgeving_gebouwen", roughness=0.9)
        wo.add_mesh("omgeving_gebouwen", np.vstack(P), np.vstack(I), mb, colors=np.vstack(Col))
    if WP:
        mw = wo.add_material("omgeving_water", color=(0.33, 0.52, 0.70, 0.80), roughness=0.2, alpha_mode="BLEND", double_sided=True)
        wo.add_mesh("omgeving_water", np.vstack(WP), np.vstack(WI), mw, normals=np.tile([0.0, 1.0, 0.0], (wcount, 1)))
    size = wo.write(C.MODEL / "context_objects.glb")
    print(f"context_objects.glb: {size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
