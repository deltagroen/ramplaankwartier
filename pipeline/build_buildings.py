"""Stap 3: gebouwen (LoD 2.2) uit Kadaster 3D Basisvoorziening -> viewer/model/buildings.glb + buildings.json.

De dakkleur per pand is de mediaankleur van de luchtfoto binnen de dakvlakken (gevels krijgen een neutrale
kleur, die staan niet op de foto). Elk hoekpunt draagt het gebouwnummer (_BID) en een dakvlag (_ROOF) zodat
de viewer een aangeklikt pand kan opzoeken en daken apart kan kleuren. Gebouwen worden BUILDING_SKIRT meter
onder maaiveld doorgetrokken.
"""
import glob
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import cityjson as CJ
import facade_colours
import ortho
from glb import GLBWriter

ROOF = (0.63, 0.34, 0.28)      # terugvalkleur als de luchtfoto geen bruikbare pixels geeft
WALL = (0.90, 0.86, 0.78)
OTHER = (0.80, 0.78, 0.72)


def roof_colour_from_photo(mosaic, tr, rings_xy):
    """Mediaankleur van de luchtfoto binnen de (iets naar binnen gekrompen) dakvlakken van een pand."""
    polys = []
    for ring in rings_xy:
        if len(ring) >= 3:
            pg = Polygon(ring)
            if not pg.is_valid:
                pg = pg.buffer(0)
            if not pg.is_empty:
                polys.append(pg)
    if not polys:
        return None
    geom = unary_union(polys)
    inner = geom.buffer(-0.5)                 # dakranden/goten buiten beschouwing laten
    col = ortho.median_colour(mosaic, tr, inner if not inner.is_empty else geom)
    if col is None:
        col = ortho.median_colour(mosaic, tr, geom)
    if col is None:
        return None
    g = col.mean()
    col = g + (col - g) * 1.25               # winteropname is wat flets: iets meer verzadiging en licht
    return tuple(np.clip(col * 1.08, 0, 1))


def main():
    C.ensure_dirs()
    minx, miny, maxx, maxy = C.AOI
    files = sorted(glob.glob(str(C.RAW / "kadaster3d" / "buildings_*.city.json")))
    print("luchtfotomozaïek opbouwen ...", flush=True)
    mosaic, mtr = ortho.load_mosaic(0.25)
    photo_hits = 0
    P, N, Col, BID, ROOFF, I = [], [], [], [], [], []
    vcount = 0
    info, footprints, pending = [], [], []
    seen = set()
    lod_stats = Counter()
    for f in files:
        print("lezen", Path(f).name, flush=True)
        cj, V = CJ.load(f)
        cos = cj["CityObjects"]
        for oid, co in cos.items():
            if co.get("type") != "Building":
                continue
            a = co.get("attributes") or {}
            ident = a.get("identificatie", oid)
            if ident in seen:
                continue
            fp = next((g for g in co.get("geometry", []) if str(g.get("lod")) == "0"), None)
            if fp is None or not fp.get("boundaries"):
                continue
            ring = [int(i) for i in fp["boundaries"][0][0]]
            cxy = V[ring][:, :2].mean(axis=0)
            in_aoi = minx <= cxy[0] <= maxx and miny <= cxy[1] <= maxy
            near = (minx - 30) <= cxy[0] <= (maxx + 30) and (miny - 30) <= cxy[1] <= (maxy + 30)
            if near:
                footprints.append([[round(float(x), 2), round(float(y), 2)] for x, y in V[ring][:, :2]])
            if not in_aoi:
                continue
            parts = [cos[c] for c in co.get("children", []) if c in cos] or [co]
            faces, used_lod, roof_rings = [], None, []
            for part in parts:
                g = CJ.pick_geometry(part.get("geometry", []))
                if g is None:
                    continue
                used_lod = str(g.get("lod"))
                for rings, st in CJ.faces_of(g):
                    if st == "GroundSurface":
                        continue
                    tris, n = CJ.triangulate(rings, V)
                    if tris is None:
                        continue
                    faces.append((tris, n, st))
                    if st == "RoofSurface":
                        roof_rings.append([tuple(xy) for xy in V[[int(k) for k in rings[0]]][:, :2]])
            if not faces:
                continue
            roof_col = roof_colour_from_photo(mosaic, mtr, roof_rings)
            if roof_col is not None:
                photo_hits += 1
            else:
                roof_col = ROOF
            seen.add(ident)
            lod_stats[used_lod] += 1
            bid = len(info)
            allidx = np.unique(np.concatenate([t.ravel() for t, _, _ in faces]))
            zs = V[allidx, 2]
            z0, z1 = float(zs.min()), float(zs.max())
            lx, _, lz = C.to_local(float(cxy[0]), float(cxy[1]), 0.0)
            fp_area = float(abs(Polygon(V[ring][:, :2]).area)) if len(ring) >= 3 else 0.0
            bouwjaar = a.get("oorspronkelijkBouwjaar")
            info.append({"id": ident, "bouwjaar": bouwjaar, "z0": round(z0, 2),
                         "h": round(z1 - z0, 1), "lod": used_lod, "x": round(lx, 1), "z": round(lz, 1),
                         "dak": [round(float(c), 3) for c in roof_col], "opp": round(fp_area, 1)})
            pending.append((bid, faces, V, z0, roof_col))

    # Gevelkleur per pand (schatting op bouwjaar/afmeting/dakkleur, met samenhang per bouwrij; zie facade_colours.py)
    walls = facade_colours.assign(
        [{"id": b["id"], "bouwjaar": b["bouwjaar"], "x": b["x"] + C.ORIGIN[0], "y": -b["z"] + C.ORIGIN[1],
          "area": b["opp"], "h": b["h"], "dak": b["dak"]} for b in info],
        override_path=C.OVERRIDES / "gevelkleuren_override.json")
    mat_stats = Counter(m for m, _, _ in walls)
    for b, (mat, col, src) in zip(info, walls):
        b["gevel"] = [round(float(c), 3) for c in col]
        b["gevel_mat"] = facade_colours.describe(mat)
        b["gevel_bron"] = src

    for bid, faces, V, z0, roof_col in pending:
        wall_col = walls[bid][1]
        for tris, n, st in faces:
            uniq, inv = np.unique(tris.ravel(), return_inverse=True)
            pos = V[uniq].copy()
            low = pos[:, 2] <= z0 + 0.05
            pos[low, 2] -= C.BUILDING_SKIRT
            col = roof_col if st == "RoofSurface" else wall_col if st == "WallSurface" else OTHER
            P.append(CJ.to_local(pos, C.ORIGIN))
            N.append(np.tile(CJ.normal_to_local(n), (len(uniq), 1)))
            Col.append(np.tile(col, (len(uniq), 1)))
            BID.append(np.full(len(uniq), bid, dtype=np.float32))
            ROOFF.append(np.full(len(uniq), 1.0 if st == "RoofSurface" else 0.0, dtype=np.float32))
            I.append(inv.reshape(-1, 3) + vcount)
            vcount += len(uniq)
    print("gevelmaterialen:", dict(mat_stats.most_common()))
    Pm, Nm, Cm, Im = np.vstack(P), np.vstack(N), np.vstack(Col), np.vstack(I)
    Bm, Rm = np.concatenate(BID), np.concatenate(ROOFF)
    w = GLBWriter()
    m = w.add_material("gebouwen", roughness=0.9)
    w.add_mesh("gebouwen", Pm, Im, m, normals=Nm, colors=Cm, custom={"_BID": Bm, "_ROOF": Rm})
    print(f"dakkleur uit luchtfoto voor {photo_hits} van {len(info)} panden")
    size = w.write(C.MODEL / "buildings.glb")
    (C.MODEL / "buildings.json").write_text(json.dumps(info, separators=(",", ":")))
    (C.WORK / "footprints.json").write_text(json.dumps(footprints))
    print(f"gebouwen: {len(info)} panden, LoD {dict(lod_stats)}, {len(Pm)} hoekpunten, {len(Im)} driehoeken, "
          f"buildings.glb {size/1e6:.1f} MB; {len(footprints)} footprints voor maskers")


if __name__ == "__main__":
    main()
