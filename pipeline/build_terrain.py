"""Stap 4: terreinmesh uit het AHN-DTM -> viewer/model/terrain.glb (+ heights_2m.u16 voor de viewer).

Per patch (NX x NY) een mesh met UV's op de bijbehorende luchtfototextuur tex/p{i}{j}.webp
(texturen worden in build_textures.py gemaakt).
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import terrain_common as T
from glb import GLBWriter


def main():
    C.ensure_dirs()
    minx, miny, maxx, maxy = C.AOI
    dtm, tr, _ = T.load_dtm_filled(burn_water=True)
    nxv = int(round((maxx - minx) / C.GRID_M)) + 1
    nyv = int(round((maxy - miny) / C.GRID_M)) + 1
    xs = minx + np.arange(nxv) * C.GRID_M
    ys = miny + np.arange(nyv) * C.GRID_M
    X, Y = np.meshgrid(xs, ys)                      # (nyv, nxv): rij j = y, kolom i = x
    H = T.sample(dtm, tr, X.ravel(), Y.ravel()).reshape(nyv, nxv)
    print(f"hoogtegrid {nxv} x {nyv}, hoogte {H.min():.2f} .. {H.max():.2f} m NAP")

    dHdx = np.gradient(H, C.GRID_M, axis=1)
    dHdy = np.gradient(H, C.GRID_M, axis=0)
    # normaal in RD-stelsel (-dh/dx, -dh/dy, 1) -> lokaal (x oost, y omhoog, z zuid)
    Nl = np.stack([-dHdx, np.ones_like(H), dHdy], axis=-1)
    Nl /= np.linalg.norm(Nl, axis=-1, keepdims=True)

    w = GLBWriter()
    pw = (maxx - minx) / C.NX
    ph = (maxy - miny) / C.NY
    ci = int(round(pw / C.GRID_M))
    cj = int(round(ph / C.GRID_M))
    total_tris = 0
    for i in range(C.NX):
        for j in range(C.NY):
            i0, j0 = i * ci, j * cj
            sl = (slice(j0, j0 + cj + 1), slice(i0, i0 + ci + 1))
            Xp, Yp, Hp, Np = X[sl], Y[sl], H[sl], Nl[sl]
            x0, y0, x1, y1 = C.patch_bbox(i, j)
            pos = np.stack([Xp.ravel() - C.ORIGIN[0], Hp.ravel(), -(Yp.ravel() - C.ORIGIN[1])], axis=1)
            uv = np.stack([(Xp.ravel() - x0) / (x1 - x0), (y1 - Yp.ravel()) / (y1 - y0)], axis=1)
            nrm = Np.reshape(-1, 3)
            rows, cols = cj + 1, ci + 1
            jj, ii = np.meshgrid(np.arange(cj), np.arange(ci), indexing="ij")
            A = jj * cols + ii
            B = A + 1
            D = A + cols
            Cc = D + 1
            tris = np.concatenate([np.stack([A, B, D], axis=-1).reshape(-1, 3),
                                   np.stack([B, Cc, D], axis=-1).reshape(-1, 3)])
            m = w.add_material(f"p{i}{j}", texture_uri=f"tex/p{i}{j}.webp", roughness=1.0)
            w.add_mesh(f"p{i}{j}", pos, tris, m, normals=nrm, uvs=uv, extras={"i": i, "j": j})
            total_tris += len(tris)
    size = w.write(C.MODEL / "terrain.glb")
    print(f"terrain.glb: {size/1e6:.1f} MB, {total_tris} driehoeken in {C.NX*C.NY} patches")

    # Hoogtegrid 2 m voor de viewer (loopmodus, camerahoogte): uint16 in cm boven hmin.
    H2 = H[::2, ::2]
    hmin = float(np.floor(H2.min()))
    enc = np.clip(np.round((H2 - hmin) * 100.0), 0, 65535).astype("<u2")
    (C.MODEL / "heights_2m.u16").write_bytes(enc.tobytes())
    meta = {"nx": int(H2.shape[1]), "ny": int(H2.shape[0]), "dx": 2.0 * C.GRID_M, "hmin": hmin, "scale": 0.01,
            "x0": float(minx - C.ORIGIN[0]), "z_south": float(-(miny - C.ORIGIN[1])),
            "note": "rij 0 = zuidrand (z_south), rijen lopen naar het noorden (z neemt af); kolom 0 = westrand (x0)"}
    (C.WORK / "heights_meta.json").write_text(json.dumps(meta))
    print("heights_2m.u16:", enc.shape, f"hmin={hmin}")


if __name__ == "__main__":
    main()
