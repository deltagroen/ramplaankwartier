"""Stap 6: bomen -> viewer/model/trees.glb, trees.json en species.json.

Bronnen:
- BGT-boompunten (gemeentelijke bomen, positie) en het boombeheerregister van de gemeente Haarlem (soort,
  leeftijd, kroonklasse), aan elkaar gekoppeld op afstand (< 3,5 m);
- automatisch gedetecteerde boomtoppen in het kroonhoogtemodel (DSM - DTM) buiten gebouwen, water en bruggen
  (vooral particuliere tuinbomen, zonder soort).
Per boom: stam + kroon (vorm per soort) in de mesh "bomen", en voor bladverliezende bomen takkensilhouetten
(3 verticale + 1 horizontaal vlak) in de mesh "takken", die de viewer in de winter zichtbaar maakt.
Hoekpuntattributen: _SEASON (willekeurig per boom), _SPEC (index in species.json), _TID (index in trees.json),
_CROWN (1 = kroon, 0 = stam). Kleur = zomerkleur van de soort (RGBA; alfa stuurt de viewer per seizoen).
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
import species as SP
import terrain_common as T
from glb import GLBWriter

rng = np.random.default_rng(42)
KROON_KLASSE = {"<3": 1.2, "3 - 6": 2.2, "6 - 9": 3.7, "9 - 12": 5.2, "12 - 15": 6.7, "15 - 18": 8.2, "18 - 24": 10.0, ">24": 12.0}


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
    return v, np.array(f), np.vstack([ring, ring])


SPH_V, SPH_F = icosphere(1)
CYL_V, CYL_F, CYL_N = cylinder()


def crown_geometry(shape, r, h, hb):
    """Kroonhoekpunten (lokaal, kroonbasis op y=0) en normalen voor een kroonvorm."""
    rv = (h - hb) / 2.0
    sv = SPH_V.copy()
    bump = 1.0 + 0.10 * (rng.random(len(sv)) - 0.5)
    if shape == "conical":
        t = (sv[:, 1] + 1) / 2                      # 0 onder, 1 boven
        radial = 0.12 + 0.88 * (1 - t) ** 0.8
        sv[:, 0] *= radial; sv[:, 2] *= radial
        sx, sy, sz = r * 1.1, rv, r * 1.1
    elif shape == "columnar":
        sx, sy, sz = r * 0.55, rv * 1.05, r * 0.55
    elif shape == "broad":
        sx, sy, sz = r * 1.15, rv * 0.9, r * 1.15
    elif shape == "weeping":
        t = (sv[:, 1] + 1) / 2
        radial = 0.9 + 0.35 * (1 - t)               # onderaan breder (hangende takken)
        sv[:, 0] *= radial; sv[:, 2] *= radial
        sx, sy, sz = r * 1.1, rv, r * 1.1
    else:                                           # round, small
        sx, sy, sz = r, rv, r
    pts = np.stack([sv[:, 0] * bump * sx, (sv[:, 1] * bump) * sy + rv, sv[:, 2] * bump * sz], axis=1)
    nrm = np.stack([SPH_V[:, 0] / sx, SPH_V[:, 1] / sy, SPH_V[:, 2] / sz], axis=1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    return pts, nrm


# Takkenatlas (viewer, makeTwigTexture): 4 zijaanzichten met oplopende stamdikte als fractie van de kroonbreedte,
# daarna 1 bovenaanzicht; elk tegel 1/5 van de breedte. De stam in het silhouet loopt van de onderrand tot 0.3 van
# de hoogte en moet in dikte aansluiten op de stamcilinder van het model.
TWIG_TRUNK_FRAC = [0.025, 0.045, 0.08, 0.13]


def twig_planes(r, h, hb, r_trunk, rot=0.0, mirror=False):
    """3 verticale vlakken (60 graden uit elkaar, gedraaid met rot) en 1 horizontaal vlak, lokaal (kroonbasis y=0).
    Het vlak is 2.1 r breed; de variant wordt gekozen zodat de getekende stam ~ 2 r_trunk breed is."""
    P, N, UV, I = [], [], [], []
    ch = h - hb
    width = 2.1 * r
    frac = 2 * r_trunk / width
    var = int(np.argmin([abs(f - frac) for f in TWIG_TRUNK_FRAC]))
    width = max(width, 2 * r_trunk / TWIG_TRUNK_FRAC[var])          # bij dikke stam: vlak iets breder
    u0, u1 = var / 5, (var + 1) / 5
    if mirror:
        u0, u1 = u1, u0
    n = 0
    for k in range(3):
        a = rot + k * np.pi / 3
        dx, dz = np.cos(a) * width / 2, np.sin(a) * width / 2
        quad = np.array([[-dx, -0.3 * ch, -dz], [dx, -0.3 * ch, dz], [dx, ch, dz], [-dx, ch, -dz]])
        P.append(quad); N.append(np.tile([-np.sin(a), 0, np.cos(a)], (4, 1)))
        UV.append([[u0, 1], [u1, 1], [u1, 0], [u0, 0]]); I.append(np.array([[0, 1, 2], [0, 2, 3]]) + n); n += 4
    y = 0.55 * ch
    c, s_ = np.cos(rot), np.sin(rot)
    corners = np.array([[-r, -r], [r, -r], [r, r], [-r, r]]) @ np.array([[c, s_], [-s_, c]])
    quad = np.array([[cx, y, cz] for cx, cz in corners])
    P.append(quad); N.append(np.tile([0, 1, 0], (4, 1))); UV.append([[0.8, 1], [1, 1], [1, 0], [0.8, 0]])
    I.append(np.array([[0, 1, 2], [0, 2, 3]]) + n)
    return np.vstack(P), np.vstack(N), np.array(UV).reshape(-1, 2), np.vstack(I)


def trunk_radius(info, h):
    """Stamstraal (m) uit de stamomtrek van het register, anders allometrisch uit de hoogte."""
    om = (info or {}).get("stamomtrek")
    try:
        om = float(str(om).replace(",", "."))
    except (TypeError, ValueError):
        om = None
    if om and om > 5:
        return float(np.clip(om / 100.0 / (2 * np.pi), 0.05, 1.2))
    return float(np.clip(0.011 * h + 0.02, 0.05, 0.6))


def main():
    C.ensure_dirs()
    minx, miny, maxx, maxy = C.AOI
    dtm, tr, _ = T.load_dtm_filled(burn_water=False)
    dsm, _, dsm_valid = T.load_dsm()
    chm = np.clip(np.nan_to_num(np.where(dsm_valid, dsm - dtm, 0.0), nan=0.0), 0, 45)
    px = abs(tr.a)

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

    def window(x, y, r_m):
        c = int(round((x - tr.c) / tr.a - 0.5)); r = int(round((y - tr.f) / tr.e - 0.5))
        k = int(np.ceil(r_m / px))
        return chm[max(r - k, 0):min(r + k + 1, chm.shape[0]), max(c - k, 0):min(c + k + 1, chm.shape[1])]

    def crown_radius(x, y, h):
        win = window(x, y, 7.0)
        area = np.count_nonzero(win > 0.5 * h) * px * px
        return float(np.clip(np.sqrt(area / np.pi), 1.2, 5.5))

    def measured_height(x, y, r_m=1.5, q=95):
        win = window(x, y, r_m)
        return float(np.percentile(win, q)) if win.size else 0.0

    # --- gemeentelijke bomen: BGT-punten + Haarlems beheerregister ---
    bgt = json.loads((C.RAW / "vector" / "bgt_bomen.geojson").read_text())["features"]
    bgt_xy = np.array([f["geometry"]["coordinates"][:2] for f in bgt], dtype=np.float64)
    inside = (bgt_xy[:, 0] >= minx) & (bgt_xy[:, 0] <= maxx) & (bgt_xy[:, 1] >= miny) & (bgt_xy[:, 1] <= maxy)
    bgt_xy = bgt_xy[inside]
    if len(bgt_xy):
        keep = np.ones(len(bgt_xy), bool)
        for a, b in cKDTree(bgt_xy).query_pairs(1.0):
            keep[max(a, b)] = False
        bgt_xy = bgt_xy[keep]
    bor_path = C.RAW / "vector" / "haarlem_bor_bomen.geojson"
    bor = json.loads(bor_path.read_text())["features"] if bor_path.exists() else []
    bor_xy = np.array([f["geometry"]["coordinates"][:2] for f in bor], dtype=np.float64).reshape(-1, 2)
    table = SP.SpeciesTable()
    municipal = []                       # dicts: x, y, spec, info
    matched = 0
    bor_used = np.zeros(len(bor), bool)
    bor_tree = cKDTree(bor_xy) if len(bor_xy) else None
    for x, y in bgt_xy:
        rec = {"x": x, "y": y, "bron": "bgt", "spec": None, "info": {}}
        if bor_tree is not None:
            d, j = bor_tree.query([x, y])
            if d < 3.5 and not bor_used[j]:
                bor_used[j] = True
                p = bor[j]["properties"]
                rec.update(spec=table.for_name(p.get("geslachtsnaam"), p.get("naam_lt")), bron="haarlem",
                           info={"lt": p.get("naam_lt"), "leeftijd": p.get("leeftijd"), "kroon": p.get("kroondiameter"),
                                 "stamomtrek": p.get("stamomtrek"), "beschermd": p.get("beschermwaardig") == "Ja",
                                 "nr": p.get("boomnummer")})
                matched += 1
        municipal.append(rec)
    for j, f in enumerate(bor):               # registerbomen zonder BGT-punt in de buurt: toevoegen
        if bor_used[j]:
            continue
        x, y = bor_xy[j]
        if not (minx <= x <= maxx and miny <= y <= maxy):
            continue
        p = f["properties"]
        municipal.append({"x": x, "y": y, "bron": "haarlem", "spec": table.for_name(p.get("geslachtsnaam"), p.get("naam_lt")),
                          "info": {"lt": p.get("naam_lt"), "leeftijd": p.get("leeftijd"), "kroon": p.get("kroondiameter"),
                                   "stamomtrek": p.get("stamomtrek"), "beschermd": p.get("beschermwaardig") == "Ja",
                                   "nr": p.get("boomnummer")}})
    print(f"gemeentelijke bomen: {len(bgt_xy)} BGT-punten, {len(bor)} registerbomen, {matched} gekoppeld, "
          f"{len(municipal)} totaal")

    trees = []                               # (x, y, h, r, spec, bron, info)
    for rec in municipal:
        x, y = rec["x"], rec["y"]
        h = measured_height(x, y)
        if h < 2.5:
            h, r = 4.5, 1.8
        else:
            h = min(h, 32.0)
            r = min(crown_radius(x, y, h), 0.35 * h + 1.0)
        kl = KROON_KLASSE.get((rec["info"].get("kroon") or "").strip())
        if kl:
            r = float(np.clip(0.6 * kl + 0.4 * r, 1.0, 9.0))
        spec = rec["spec"] if rec["spec"] is not None else table.generic(float(rng.random()))
        trees.append((x, y, h, r, spec, rec["bron"], rec["info"]))

    # --- automatische detectie buiten de gemeentelijke bomen ---
    muni_xy = np.array([(t[0], t[1]) for t in trees]) if trees else np.zeros((0, 2))
    muni_tree = cKDTree(muni_xy) if len(muni_xy) else None
    smooth = gaussian_filter(chm, sigma=2.0)
    smooth[mask] = 0.0
    k = int(round(C.TREE_WINDOW_M / px)); k += (k + 1) % 2
    peaks = (smooth == maximum_filter(smooth, size=k)) & (smooth > C.TREE_MIN_H)
    rr, cc = np.nonzero(peaks)
    xs = tr.c + (cc + 0.5) * tr.a; ys = tr.f + (rr + 0.5) * tr.e
    cand = []
    for x, y in zip(xs, ys):
        if muni_tree is not None and muni_tree.query(np.array([x, y]))[0] < 3.5:
            continue
        win = window(x, y, 2.5)
        if np.count_nonzero(win > C.TREE_MIN_H) < 24:
            continue
        h = float(min(np.percentile(win, 98), 32.0))
        if h >= C.TREE_MIN_H:
            cand.append((x, y, h))
    detected = 0
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
            trees.append((x, y, h, r, table.generic(float(rng.random())), "chm", {}))
            detected += 1
    print(f"bomen: {len(municipal)} gemeentelijk, {detected} gedetecteerd in kroonhoogtemodel; "
          f"{len(table.profiles)} soortprofielen")

    # --- geometrie ---
    P, N, Col, I, SEAS, SPEC, TID, CROWN = [], [], [], [], [], [], [], []
    TP, TN, TUV, TC, TI, TSEAS, TSPEC, TTID = [], [], [], [], [], [], [], []
    n = tn = 0
    out = []
    for tid, (x, y, h, r, spec, bron, info) in enumerate(trees):
        prof = table.profiles[spec]
        zg = float(T.sample(dtm, tr, [x], [y])[0])
        lx, _, lz = C.to_local(x, y, 0.0)
        seas = float(rng.random())
        shape = prof["shape"]
        hb = {"conical": 0.12, "columnar": 0.15, "weeping": 0.22, "small": 0.3}.get(shape, 0.28 if h > 5 else 0.22) * h
        rt = trunk_radius(info, h)
        # stam
        v = CYL_V.copy(); v[:, 0] *= rt; v[:, 2] *= rt
        v[:, 1] = v[:, 1] * (hb + 0.8) + (zg - 0.5); v[:, 0] += lx; v[:, 2] += lz
        P.append(v); N.append(CYL_N.copy()); Col.append(np.tile((0.34, 0.26, 0.18, 1.0), (len(v), 1)))
        SEAS.append(np.full(len(v), seas, np.float32)); SPEC.append(np.full(len(v), spec, np.float32))
        TID.append(np.full(len(v), tid, np.float32)); CROWN.append(np.zeros(len(v), np.float32))
        I.append(CYL_F + n); n += len(v)
        # kroon
        pts, nrm = crown_geometry(shape, r, h, hb)
        pts = pts + [lx, zg + hb, lz]
        g = np.array(prof["summer"]) * (1.0 + 0.16 * (rng.random(3) - 0.5))
        P.append(pts); N.append(nrm)
        Col.append(np.tile(np.append(np.clip(g, 0, 1), 1.0), (len(pts), 1)))
        SEAS.append(np.full(len(pts), seas, np.float32)); SPEC.append(np.full(len(pts), spec, np.float32))
        TID.append(np.full(len(pts), tid, np.float32)); CROWN.append(np.ones(len(pts), np.float32))
        I.append(SPH_F + n); n += len(pts)
        # takken (alleen bladverliezend)
        if not prof["evergreen"]:
            tp, tnn, tuv, ti = twig_planes(r * (0.55 if shape == "columnar" else 1.0), h, hb, rt,
                                           rot=float(rng.random() * np.pi), mirror=bool(rng.random() < 0.5))
            tp = tp + [lx, zg + hb, lz]
            TP.append(tp); TN.append(tnn); TUV.append(tuv)
            TC.append(np.tile((0.80, 0.74, 0.68, 0.0), (len(tp), 1)))
            TSEAS.append(np.full(len(tp), seas, np.float32)); TSPEC.append(np.full(len(tp), spec, np.float32))
            TTID.append(np.full(len(tp), tid, np.float32)); TI.append(ti + tn); tn += len(tp)
        out.append({"x": round(lx, 1), "z": round(lz, 1), "h": round(h, 1), "r": round(r, 1), "stam": round(2 * rt, 2),
                    "bron": bron, "spec": spec, **{k: v for k, v in info.items() if v not in (None, "", False)}})

    w = GLBWriter()
    m = w.add_material("bomen", roughness=0.95)
    w.add_mesh("bomen", np.vstack(P), np.vstack(I), m, normals=np.vstack(N), colors=np.vstack(Col),
               custom={"_SEASON": np.concatenate(SEAS), "_SPEC": np.concatenate(SPEC), "_TID": np.concatenate(TID),
                       "_CROWN": np.concatenate(CROWN)})
    if TP:
        m2 = w.add_material("takken", roughness=1.0, double_sided=True)
        w.add_mesh("takken", np.vstack(TP), np.vstack(TI), m2, normals=np.vstack(TN), uvs=np.vstack(TUV),
                   colors=np.vstack(TC), custom={"_SEASON": np.concatenate(TSEAS), "_SPEC": np.concatenate(TSPEC),
                                                 "_TID": np.concatenate(TTID)})
    size = w.write(C.MODEL / "trees.glb")
    (C.MODEL / "trees.json").write_text(json.dumps({"municipal": len(municipal), "matched": matched, "detected": detected,
                                                    "trees": out}, separators=(",", ":"), ensure_ascii=False))
    (C.MODEL / "species.json").write_text(json.dumps(table.profiles, separators=(",", ":"), ensure_ascii=False))
    hs = np.array([t[2] for t in trees])
    print(f"trees.glb: {size/1e6:.1f} MB, {len(trees)} bomen, {sum(len(i) for i in I)} kroon/stam-driehoeken, "
          f"{sum(len(i) for i in TI)} takkendriehoeken, hoogte mediaan {np.median(hs):.1f} m")


if __name__ == "__main__":
    main()
