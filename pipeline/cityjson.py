"""CityJSON 2.0 lezen en vlakken trianguleren (mapbox_earcut)."""
import json
import numpy as np
import mapbox_earcut as earcut


def load(path):
    with open(path) as f:
        cj = json.load(f)
    V = np.asarray(cj["vertices"], dtype=np.float64)
    t = cj.get("transform")
    if t:
        V = V * np.asarray(t["scale"], dtype=np.float64) + np.asarray(t["translate"], dtype=np.float64)
    return cj, V


def pick_geometry(geoms, lods=("2.2", "1.3", "1.2")):
    for lod in lods:
        for g in geoms:
            if str(g.get("lod")) == lod:
                return g
    return None


def faces_of(geom):
    """Levert (ringen, semantisch type) per vlak; ringen = lijst van indexlijsten, buitenring eerst."""
    b = geom["boundaries"]
    sem = geom.get("semantics")
    surf = sem["surfaces"] if sem else None
    vals = sem.get("values") if sem else None

    def stype(v):
        if v is None or surf is None:
            return None
        return surf[v].get("type")

    gt = geom["type"]
    if gt == "Solid":
        for si, shell in enumerate(b):
            sv = vals[si] if vals is not None and si < len(vals) and vals[si] is not None else None
            for fi, face in enumerate(shell):
                yield face, stype(sv[fi] if sv is not None and fi < len(sv) else None)
    elif gt in ("MultiSurface", "CompositeSurface"):
        for fi, face in enumerate(b):
            yield face, stype(vals[fi] if vals is not None and fi < len(vals) else None)
    elif gt in ("MultiSolid", "CompositeSolid"):
        for solid in b:
            for shell in solid:
                for face in shell:
                    yield face, None


def newell_normal(P):
    Q = np.roll(P, -1, axis=0)
    n = np.array([np.sum((P[:, 1] - Q[:, 1]) * (P[:, 2] + Q[:, 2])),
                  np.sum((P[:, 2] - Q[:, 2]) * (P[:, 0] + Q[:, 0])),
                  np.sum((P[:, 0] - Q[:, 0]) * (P[:, 1] + Q[:, 1]))])
    l = np.linalg.norm(n)
    return n / l if l > 1e-12 else None


def triangulate(rings, V):
    """Trianguleer een (mogelijk niet-convex) vlak met gaten. Geeft (driehoeken (m,3) als V-indices, normaal)."""
    outer = [int(i) for i in rings[0]]
    if len(outer) < 3:
        return None, None
    P = V[outer]
    n = newell_normal(P)
    if n is None:
        return None, None
    if len(rings) == 1 and len(outer) == 3:
        tris = np.array([outer], dtype=np.int64)
    else:
        a = np.array([1.0, 0.0, 0.0]) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        u = np.cross(n, a)
        u /= np.linalg.norm(u)
        v = np.cross(n, u)
        basis = np.stack([u, v], axis=1)
        idx, pts, ends = [], [], []
        for r in rings:
            r = [int(i) for i in r]
            if len(r) < 3:
                continue
            idx.extend(r)
            pts.append(V[r] @ basis)
            ends.append(len(idx))
        if not pts:
            return None, None
        tri = earcut.triangulate_float64(np.vstack(pts), np.asarray(ends, dtype=np.uint32))
        if len(tri) == 0:
            return None, None
        tris = np.asarray(idx, dtype=np.int64)[np.asarray(tri, dtype=np.int64).reshape(-1, 3)]
    A, B, Cc = V[tris[:, 0]], V[tris[:, 1]], V[tris[:, 2]]
    flip = (np.cross(B - A, Cc - A) @ n) < 0
    if flip.any():
        tris[flip] = tris[flip][:, [0, 2, 1]]
    return tris, n


def to_local(P, origin):
    """RD/NAP (n,3) -> lokaal glTF-stelsel (x oost, y omhoog, z zuid)."""
    return np.stack([P[:, 0] - origin[0], P[:, 2], -(P[:, 1] - origin[1])], axis=1)


def normal_to_local(n):
    return np.array([n[0], n[2], -n[1]])
