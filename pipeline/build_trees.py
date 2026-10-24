"""Stap 6: bomen -> viewer/model/trees.glb + trees.json.

Bronnen: BGT-boompunten (gemeentelijke bomen) met hoogte uit het kroonhoogtemodel (DSM - DTM),
aangevuld met automatisch gedetecteerde boomtoppen in het kroonhoogtemodel buiten gebouwen, water en bruggen
(vooral particuliere tuinbomen). Elke boom wordt een eenvoudige stam + ellipsoïde kroon.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, maximum_filter
from scipy.spatial import cKDTree
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import terrain_common as T
from glb import GLBWriter

rng = np.random.default_rng(42)


def icosphere(subdiv=1):
    t = (1 + 5 ** 0.5) / 2
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], dtype=np.float64)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    f = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
                  [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5],
                  [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]])
    for _ in range(subdiv):
        cache, verts, faces = {}, list(v), []

        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                m = (verts[a] + verts[b]) / 2
                verts.append(m / np.linalg.norm(m))
                cache[key] = len(verts) - 1
            return cache[key]

        for a, b, c in f:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            faces += [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]
        v, f = np.array(verts), np.array(faces)
    return v, f


def cylinder(segments=7):
    ang = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    ring = np.stack([np.cos(ang), np.zeros(segments), np.sin(ang)], axis=1)
    v = np.vstack([ring, ring + [0, 1, 0]])
    f = []
    for k in range(segments):
        k2 = (k + 1) % segments
        f += [[k, k2, k + segments], [k2, k2 + segments, k + segments]]
    n = np.vstack([ring, ring])
    return v, np.array(f), n


SPH_V, SPH_F = icosphere(1)
CYL_V, CYL_F, CYL_N = cylinder()


def main():
    C.ensure_dirs()
    minx, miny, maxx, maxy = C.AOI
    dtm, tr, _ = T.load_dtm_filled(burn_water=False)
    dsm, _, dsm_valid = T.load_dsm()
    chm = np.where(dsm_valid, dsm - dtm, 0.0)
    chm = np.clip(np.nan_to_num(chm, nan=0.0), 0, 45)
    px = abs(tr.a)                                   # 0,5 m

    # Maskers: gebouwen (+1,5 m), water (+1 m), bruggen (+2 m)
    shapes = []
    for ring in json.loads((C.WORK / "footprints.json").read_text()):
        if len(ring) >= 3:
            shapes.append((Polygon(ring).buffer(1.5).__geo_interface__, 1))
    for f in json.loads((C.WORK / "water_faces.json").read_text()):
        if len(f["ring"]) >= 4:
            shapes.append((Polygon(f["ring"]).buffer(1.0).__geo_interface__, 1))
    for f in json.loads((C.WORK / "bridge_faces.json").read_text()):
        if len(f["ring"]) >= 4:
            shapes.append((Polygon(f["ring"]).buffer(2.0).__geo_interface__, 1))
    mask = T.rasterize(shapes, tr, chm.shape).astype(bool)
    print(f"masker dekt {mask.mean()*100:.1f}% van het gebied")

    # BGT-bomen
    bgt = json.loads((C.RAW / "vector" / "bgt_bomen.geojson").read_text())["features"]
    bgt_xy = np.array([f["geometry"]["coordinates"][:2] for f in bgt], dtype=np.float64)
    inside = (bgt_xy[:, 0] >= minx) & (bgt_xy[:, 0] <= maxx) & (bgt_xy[:, 1] >= miny) & (bgt_xy[:, 1] <= maxy)
    bgt_xy = bgt_xy[inside]
    # dubbele punten (< 1 m) samenvoegen
    if len(bgt_xy):
        tree = cKDTree(bgt_xy)
        keep = np.ones(len(bgt_xy), bool)
        for a, b in tree.query_pairs(1.0):
            keep[max(a, b)] = False
        bgt_xy = bgt_xy[keep]

    def window_stats(x, y, r_m):
        c = int(round((x - tr.c) / tr.a - 0.5))
        r = int(round((y - tr.f) / tr.e - 0.5))
        k = int(np.ceil(r_m / px))
        r0, r1 = max(r - k, 0), min(r + k + 1, chm.shape[0])
        c0, c1 = max(c - k, 0), min(c + k + 1, chm.shape[1])
        win = chm[r0:r1, c0:c1]
        return win

    def crown_radius(x, y, h):
        win = window_stats(x, y, 7.0)
        area = np.count_nonzero(win > 0.5 * h) * px * px
        return float(np.clip(np.sqrt(area / np.pi), 1.2, 5.5))

    trees = []  # (x, y, h, r, bron)
    for x, y in bgt_xy:
        win = window_stats(x, y, 1.5)
        h = float(np.percentile(win, 95)) if win.size else 0.0
        if h < 2.5:
            h, r = 4.5, 1.8   # jonge/verwijderde boom: standaardmaat
        else:
            h = min(h, 32.0)
            r = min(crown_radius(x, y, h), 0.35 * h + 1.0)
        trees.append((x, y, h, r, "bgt"))

    # Automatische detectie van boomtoppen buiten BGT-bomen
    smooth = gaussian_filter(chm, sigma=2.0)
    smooth[mask] = 0.0
    k = int(round(C.TREE_WINDOW_M / px))
    k += (k + 1) % 2                                   # oneven venster
    peaks = (smooth == maximum_filter(smooth, size=k)) & (smooth > C.TREE_MIN_H)
    rr, cc = np.nonzero(peaks)
    xs = tr.c + (cc + 0.5) * tr.a
    ys = tr.f + (rr + 0.5) * tr.e
    bgt_tree = cKDTree(bgt_xy) if len(bgt_xy) else None
    detected = 0
    cand = []
    for x, y in zip(xs, ys):
        if bgt_tree is not None and bgt_tree.query(np.array([x, y]))[0] < 3.5:
            continue
        win = window_stats(x, y, 2.5)
        if np.count_nonzero(win > C.TREE_MIN_H) < 24:   # te smal: lantaarnpaal, schoorsteen, mast
            continue
        h = float(min(np.percentile(win, 98), 32.0))
        if h < C.TREE_MIN_H:
            continue
        cand.append((x, y, h))
    # kandidaten dichter dan 3 m bij elkaar: hoogste houdt
    if cand:
        cand.sort(key=lambda t: -t[2])
        ct = cKDTree(np.array([(c[0], c[1]) for c in cand]))
        taken = np.zeros(len(cand), bool)
        for idx, (x, y, h) in enumerate(cand):
            if taken[idx]:
                continue
            for j in ct.query_ball_point([x, y], 3.0):
                if j != idx:
                    taken[j] = True
            r = min(crown_radius(x, y, h), 0.35 * h + 1.0)
            trees.append((x, y, h, r, "chm"))
            detected += 1
    print(f"bomen: {len(bgt_xy)} uit BGT, {detected} gedetecteerd in kroonhoogtemodel")

    # Geometrie
    P, N, Col, I = [], [], [], []
    n = 0
    for x, y, h, r, src in trees:
        zg = float(T.sample(dtm, tr, [x], [y])[0])
        lx, _, lz = C.to_local(x, y, 0.0)
        hb = 0.28 * h if h > 5 else 0.22 * h            # kroonbasis
        rv = (h - hb) / 2.0
        rt = float(np.clip(0.03 * h, 0.10, 0.45))
        # stam
        v = CYL_V.copy()
        v[:, 0] *= rt; v[:, 2] *= rt
        v[:, 1] = v[:, 1] * (hb + 0.5 + 0.3) + (zg - 0.5)
        v[:, 0] += lx; v[:, 2] += lz
        P.append(v); N.append(CYL_N.copy()); Col.append(np.tile((0.34, 0.26, 0.18), (len(v), 1)))
        I.append(CYL_F + n); n += len(v)
        # kroon (ellipsoïde met wat ruis)
        bump = 1.0 + 0.10 * (rng.random(len(SPH_V)) - 0.5)
        sv = SPH_V * bump[:, None]
        v = np.stack([sv[:, 0] * r + lx, sv[:, 1] * rv + zg + hb + rv, sv[:, 2] * r + lz], axis=1)
        nn = np.stack([SPH_V[:, 0] / r, SPH_V[:, 1] / rv, SPH_V[:, 2] / r], axis=1)
        nn /= np.linalg.norm(nn, axis=1, keepdims=True)
        g = np.array((0.26, 0.42, 0.17)) * (1.0 + 0.22 * (rng.random(3) - 0.5))
        P.append(v); N.append(nn); Col.append(np.tile(np.clip(g, 0, 1), (len(v), 1)))
        I.append(SPH_F + n); n += len(v)
    Pm, Nm, Cm, Im = np.vstack(P), np.vstack(N), np.vstack(Col), np.vstack(I)
    w = GLBWriter()
    m = w.add_material("bomen", roughness=0.95)
    w.add_mesh("bomen", Pm, Im, m, normals=Nm, colors=Cm)
    size = w.write(C.MODEL / "trees.glb")
    out = {"bgt": int(len(bgt_xy)), "detected": int(detected),
           "trees": [[round(C.to_local(x, y, 0)[0], 1), round(C.to_local(x, y, 0)[2], 1), round(h, 1), round(r, 1), src]
                     for x, y, h, r, src in trees]}
    (C.MODEL / "trees.json").write_text(json.dumps(out, separators=(",", ":")))
    hs = np.array([t[2] for t in trees])
    print(f"trees.glb: {size/1e6:.1f} MB, {len(trees)} bomen, {len(Im)} driehoeken, hoogte mediaan {np.median(hs):.1f} m, max {hs.max():.1f} m")


if __name__ == "__main__":
    main()
