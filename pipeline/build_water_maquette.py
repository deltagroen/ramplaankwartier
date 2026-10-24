"""Stap 2: water en BGT-'maquette'-vlakken (wegen, terrein, groen, bruggen) uit Kadaster 3D volledig.

Schrijft viewer/model/water.glb en maquette.glb, plus data/work/water_faces.json en bridge_faces.json
(gebruikt door terrein- en boomstap).
"""
import glob
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import cityjson as CJ
from glb import GLBWriter

CLASSES = {"Road": "wegen", "LandUse": "terrein", "PlantCover": "groen", "Bridge": "bruggen", "OtherConstruction": "overig"}
FLAT_NORMAL_CLASSES = {"Road", "LandUse", "PlantCover"}


def colour(t, a):
    f = (a.get("bgt_functie") or "").lower()
    fv = (a.get("bgt_fysiekvoorkomen") or "").lower()
    bt = (a.get("bgt_type") or "").lower()
    if t == "Road":
        if "voetpad" in f or "fietspad" in f or "voetgangers" in f:
            return (0.68, 0.65, 0.60)
        if "parkeer" in f:
            return (0.54, 0.54, 0.56)
        if "inrit" in f or "woonerf" in f:
            return (0.60, 0.58, 0.56)
        if "spoor" in f:
            return (0.45, 0.42, 0.40)
        if "onverhard" in fv or "half verhard" in fv:
            return (0.76, 0.70, 0.56)
        return (0.46, 0.46, 0.48)
    if t == "LandUse":
        if "berm" in f or "groen" in fv:
            return (0.55, 0.66, 0.38)
        if "oever" in bt or "slootkant" in bt:
            return (0.52, 0.60, 0.42)
        if "erf" in bt or "erf" in fv or "erf" in f:
            return (0.83, 0.77, 0.65)
        if "verkeerseiland" in f:
            return (0.66, 0.66, 0.66)
        if "half verhard" in fv:
            return (0.74, 0.70, 0.60)
        if "gesloten" in fv:
            return (0.63, 0.63, 0.63)
        if "open verharding" in fv:
            return (0.71, 0.69, 0.65)
        if "zand" in fv:
            return (0.89, 0.84, 0.69)
        if "onverhard" in fv:
            return (0.75, 0.67, 0.53)
        return (0.80, 0.76, 0.68)
    if t == "PlantCover":
        if "bouwland" in fv:
            return (0.62, 0.52, 0.38)
        if "bos" in fv:
            return (0.31, 0.48, 0.26)
        if "struik" in fv or "heide" in fv:
            return (0.42, 0.56, 0.31)
        if "gras" in fv:
            return (0.57, 0.70, 0.40)
        return (0.47, 0.63, 0.36)
    if t == "Bridge":
        return (0.42, 0.42, 0.45)
    return (0.56, 0.52, 0.47)


class Acc:
    def __init__(self):
        self.P, self.N, self.C, self.I, self.n = [], [], [], [], 0

    def add_shared(self, V, tris, col, dz=0.0, flat_z=None, normal=(0.0, 1.0, 0.0)):
        uniq, inv = np.unique(tris.ravel(), return_inverse=True)
        pos = V[uniq].copy()
        if flat_z is not None:
            pos[:, 2] = flat_z
        pos[:, 2] += dz
        self.P.append(CJ.to_local(pos, C.ORIGIN))
        self.N.append(np.tile(np.asarray(normal, dtype=np.float64), (len(uniq), 1)))
        self.C.append(np.tile(np.asarray(col, dtype=np.float64), (len(uniq), 1)))
        self.I.append(inv.reshape(-1, 3) + self.n)
        self.n += len(uniq)

    def add_flat(self, V, tris, normals, col, dz=0.0):
        """Per driehoek eigen hoekpunten (vlakke schaduw) voor niet-horizontale vlakken."""
        pos = V[tris.ravel()].copy()
        pos[:, 2] += dz
        self.P.append(CJ.to_local(pos, C.ORIGIN))
        self.N.append(np.repeat(normals, 3, axis=0))
        self.C.append(np.tile(np.asarray(col, dtype=np.float64), (len(pos), 1)))
        self.I.append(np.arange(len(pos)).reshape(-1, 3) + self.n)
        self.n += len(pos)

    def arrays(self):
        return (np.vstack(self.P), np.vstack(self.N), np.vstack(self.C), np.vstack(self.I)) if self.P else None


def main():
    C.ensure_dirs()
    minx, miny, maxx, maxy = C.AOI
    files = sorted(glob.glob(str(C.RAW / "kadaster3d" / "volledig_*.city.json")))
    acc = {name: Acc() for name in CLASSES.values()}
    water = Acc()
    water_faces, bridge_faces, road_faces = [], [], []
    stats, attr_stats = Counter(), Counter()
    for f in files:
        print("lezen", Path(f).name, flush=True)
        cj, V = CJ.load(f)
        for oid, co in cj["CityObjects"].items():
            t = co.get("type")
            if t not in CLASSES and t != "WaterBody":
                continue
            a = co.get("attributes") or {}
            g = CJ.pick_geometry(co.get("geometry", []), lods=("1.2", "1.3", "1", "0", "2.2"))
            if g is None:
                continue
            tris_all, normals_all, rings_all = [], [], []
            for rings, st in CJ.faces_of(g):
                outer = [int(i) for i in rings[0]]
                if len(outer) < 3:
                    continue
                c = V[outer].mean(axis=0)
                if not (minx <= c[0] <= maxx and miny <= c[1] <= maxy):
                    continue
                tris, n = CJ.triangulate(rings, V)
                if tris is None:
                    continue
                if n[2] < 0:  # zorg dat vlakken omhoog kijken
                    tris = tris[:, [0, 2, 1]]
                    n = -n
                tris_all.append(tris)
                normals_all.append(np.tile(CJ.normal_to_local(n), (len(tris), 1)))
                rings_all.append(outer)
            if not tris_all:
                continue
            stats[t] += 1
            tris_all = np.vstack(tris_all)
            if t == "WaterBody":
                zmed = float(np.median(V[np.unique(tris_all.ravel()), 2]))
                water.add_shared(V, tris_all, (1, 1, 1), flat_z=zmed)
                for outer in rings_all:
                    ring = [[round(float(x), 2), round(float(y), 2)] for x, y in V[outer][:, :2]]
                    ring.append(ring[0])
                    water_faces.append({"ring": ring, "z": round(zmed, 2)})
                continue
            attr_stats[(t, a.get("bgt_functie", ""), a.get("bgt_fysiekvoorkomen", ""), a.get("bgt_type", ""))] += 1
            col = colour(t, a)
            A = acc[CLASSES[t]]
            if t in FLAT_NORMAL_CLASSES:
                A.add_shared(V, tris_all, col, dz=0.08)
            else:
                A.add_flat(V, tris_all, np.vstack(normals_all), col, dz=0.08)
            if t == "Bridge":
                for outer in rings_all:
                    ring = [[round(float(x), 2), round(float(y), 2)] for x, y in V[outer][:, :2]]
                    ring.append(ring[0])
                    bridge_faces.append({"ring": ring})
            if t == "Road" and "rijbaan" in (a.get("bgt_functie") or "").lower():
                for outer in rings_all:
                    ring = [[round(float(x), 2), round(float(y), 2)] for x, y in V[outer][:, :2]]
                    ring.append(ring[0])
                    road_faces.append({"ring": ring})
    print("objecten in werkgebied:", dict(stats))
    print("attributen (top 30):")
    for k, v in attr_stats.most_common(30):
        print("  ", v, k)

    (C.WORK / "water_faces.json").write_text(json.dumps(water_faces))
    (C.WORK / "bridge_faces.json").write_text(json.dumps(bridge_faces))
    (C.WORK / "road_faces.json").write_text(json.dumps(road_faces))

    w = GLBWriter()
    arr = water.arrays()
    if arr:
        Pw, Nw, _, Iw = arr
        m = w.add_material("water", color=(0.33, 0.52, 0.70, 0.80), roughness=0.2, alpha_mode="BLEND", double_sided=True)
        w.add_mesh("water", Pw, Iw, m, normals=Nw)
        print(f"water: {len(Pw)} hoekpunten, {len(Iw)} driehoeken")
    w.write(C.MODEL / "water.glb")

    mq = GLBWriter()
    m = mq.add_material("maquette", roughness=1.0, double_sided=True)
    total = 0
    for name, A in acc.items():
        arr = A.arrays()
        if not arr:
            continue
        Pm, Nm, Cm, Im = arr
        mq.add_mesh(name, Pm, Im, m, normals=Nm, colors=Cm)
        total += len(Im)
        print(f"maquette/{name}: {len(Pm)} hoekpunten, {len(Im)} driehoeken")
    size = mq.write(C.MODEL / "maquette.glb")
    print(f"maquette.glb: {size/1e6:.1f} MB, {total} driehoeken")


if __name__ == "__main__":
    main()
