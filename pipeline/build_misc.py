"""Stap 7: buurtgrens, straatnaamlabels en scene.json (metadata voor de viewer)."""
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import terrain_common as T


def densify(coords, step=5.0):
    out = []
    for (x0, y0), (x1, y1) in zip(coords[:-1], coords[1:]):
        d = float(np.hypot(x1 - x0, y1 - y0))
        k = max(int(d // step), 1)
        for s in range(k):
            t = s / k
            out.append((x0 + t * (x1 - x0), y0 + t * (y1 - y0)))
    out.append(tuple(coords[-1]))
    return np.array(out)


def main():
    C.ensure_dirs()
    dtm, tr, _ = T.load_dtm_filled(burn_water=False)
    minx, miny, maxx, maxy = C.AOI

    # Buurtgrens
    buurt = json.loads((C.RAW / "vector" / "buurt_ramplaankwartier.geojson").read_text())["features"][0]
    geom = shape(buurt["geometry"])
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    lines = []
    for poly in polys:
        pts = densify(np.asarray(poly.exterior.coords), 5.0)
        z = T.sample(dtm, tr, pts[:, 0], pts[:, 1]) + 0.5
        lines.append([[round(float(x - C.ORIGIN[0]), 2), round(float(h), 2), round(float(-(y - C.ORIGIN[1])), 2)]
                      for (x, y), h in zip(pts, z)])
    (C.MODEL / "buurtgrens.json").write_text(json.dumps({"naam": buurt["properties"].get("buurtnaam"),
                                                          "code": buurt["properties"].get("buurtcode"), "lijnen": lines}))
    print(f"buurtgrens: {sum(len(l) for l in lines)} punten")

    # Straatnaamlabels (BGT openbareruimtelabel), indien opgehaald
    labels = []
    lp = C.RAW / "vector" / "bgt_labels.geojson"
    if lp.exists():
        for f in json.loads(lp.read_text())["features"]:
            p = f["properties"]
            txt = p.get("openbareruimtenaam") or p.get("tekst") or p.get("naam")
            g = f.get("geometry") or {}
            if not txt or g.get("type") != "Point":
                continue
            x, y = g["coordinates"][:2]
            if not (minx <= x <= maxx and miny <= y <= maxy):
                continue
            z = float(T.sample(dtm, tr, [x], [y])[0])
            labels.append({"t": txt, "x": round(x - C.ORIGIN[0], 1), "y": round(z, 2), "z": round(-(y - C.ORIGIN[1]), 1),
                           "hoek": p.get("hoek"), "type": p.get("openbareruimtetype")})
    (C.MODEL / "labels.json").write_text(json.dumps(labels, ensure_ascii=False))
    print(f"labels: {len(labels)}")

    # Oppervlaktegrid 4 m (hoogste DSM-punt per cel: gebouwen, bomen, masten) voor botsingsvrije vluchten
    dsm, _, dsm_valid = T.load_dsm()
    surf = np.where(dsm_valid, dsm, dtm)
    cell = 8                                            # 8 pixels van 0,5 m = 4 m
    H, W = surf.shape
    Hc, Wc = H // cell, W // cell
    smax = surf[:Hc * cell, :Wc * cell].reshape(Hc, cell, Wc, cell).max(axis=(1, 3))
    smax = smax[::-1]                                   # rij 0 = zuidrand, zoals heights_2m
    smin = float(np.floor(smax.min()))
    enc = np.clip(np.round((smax - smin) * 100.0), 0, 65535).astype("<u2")
    (C.MODEL / "surface_4m.u16").write_bytes(enc.tobytes())
    surface_meta = {"nx": int(Wc), "ny": int(Hc), "dx": cell * 0.5, "hmin": smin, "scale": 0.01,
                    "x0": float(minx - C.ORIGIN[0]), "z_south": float(-(miny - C.ORIGIN[1]))}
    print(f"surface_4m.u16: {Wc} x {Hc}, hoogste punt {smax.max():.1f} m NAP")

    # Straatcorridors: rechte stukken rijbaan zonder obstakel (> 2,5 m boven maaiveld) binnen CLEAR m
    from scipy.ndimage import distance_transform_edt
    from shapely.geometry import Polygon
    CLEAR, MINLEN = 3.5, 120.0
    obstacle = np.where(dsm_valid, dsm - dtm, 0.0) > 2.5
    dist = distance_transform_edt(~obstacle) * 0.5
    roads = [(Polygon(f["ring"]).buffer(0).__geo_interface__, 1) for f in json.loads((C.WORK / "road_faces.json").read_text()) if len(f["ring"]) >= 4]
    waters = [(Polygon(f["ring"]).buffer(0).__geo_interface__, 1) for f in json.loads((C.WORK / "water_faces.json").read_text()) if len(f["ring"]) >= 4]
    road = T.rasterize(roads, tr, dtm.shape).astype(bool)
    water = T.rasterize(waters, tr, dtm.shape).astype(bool)
    ok = (dist >= CLEAR) & (road | water)        # laag vliegen mag over rijbanen en (breed genoeg) water
    bx0, by0, bx1, by1 = 101416 - 60, 488312 - 60, 102193 + 60, 488941 + 60   # buurt + rand
    rng = np.random.default_rng(3)
    rows, cols = np.nonzero(ok)
    segs = []
    if len(rows):
        pick = rng.choice(len(rows), size=min(6000, len(rows)), replace=False)
        for k in pick:
            r, c = rows[k], cols[k]
            x = tr.c + (c + 0.5) * tr.a
            y = tr.f + (r + 0.5) * tr.e
            if not (bx0 <= x <= bx1 and by0 <= y <= by1):
                continue
            for ang in np.deg2rad(np.arange(0, 180, 7.5)):
                dx, dy = np.cos(ang), np.sin(ang)
                ends = []
                for sgn in (1, -1):
                    d = 0.0
                    while True:
                        px, py = x + sgn * (d + 2) * dx, y + sgn * (d + 2) * dy
                        cc = int((px - tr.c) / tr.a); rr = int((py - tr.f) / tr.e)
                        if not (0 <= rr < H and 0 <= cc < W) or not ok[rr, cc]:
                            break
                        d += 2
                    ends.append(d)
                length = ends[0] + ends[1]
                if length >= MINLEN:
                    x0, y0 = x - ends[1] * dx, y - ends[1] * dy
                    x1, y1 = x + ends[0] * dx, y + ends[0] * dy
                    segs.append((length, x0, y0, x1, y1))
    segs.sort(reverse=True)
    kept = []
    for L, x0, y0, x1, y1 in segs:
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        ang = np.arctan2(y1 - y0, x1 - x0) % np.pi
        dup = False
        for K in kept:
            kmx, kmy = (K[1] + K[3]) / 2, (K[2] + K[4]) / 2
            kang = np.arctan2(K[4] - K[2], K[3] - K[1]) % np.pi
            dang = abs(ang - kang); dang = min(dang, np.pi - dang)
            if np.hypot(mx - kmx, my - kmy) < 60 and dang < np.deg2rad(20):
                dup = True; break
        if not dup:
            kept.append((L, x0, y0, x1, y1))
        if len(kept) >= 25:
            break
    streets = []
    for L, x0, y0, x1, y1 in kept:
        zs = T.sample(dtm, tr, [x0, (x0 + x1) / 2, x1], [y0, (y0 + y1) / 2, y1])
        mc = int(((x0 + x1) / 2 - tr.c) / tr.a); mr = int(((y0 + y1) / 2 - tr.f) / tr.e)
        kind = "water" if (0 <= mr < H and 0 <= mc < W and water[mr, mc]) else "weg"
        streets.append({"lengte": round(float(L), 1), "type": kind,
                        "a": [round(x0 - C.ORIGIN[0], 1), round(float(zs[0]), 2), round(-(y0 - C.ORIGIN[1]), 1)],
                        "b": [round(x1 - C.ORIGIN[0], 1), round(float(zs[2]), 2), round(-(y1 - C.ORIGIN[1]), 1)]})
    (C.MODEL / "streets.json").write_text(json.dumps(streets))
    print(f"corridors: {len(streets)} ({sum(1 for q in streets if q['type']=='water')} water) (langste {streets[0]['lengte'] if streets else 0} m, kortste {streets[-1]['lengte'] if streets else 0} m)")

    # Obstakelgrid 2 m voor botsingen in de viewer: per cel bovenkant (dm boven hmin, 10 bits) en onderkant
    # (m boven maaiveld, 6 bits) van gebouwen en boomkronen; stam- en gebouwcellen hebben onderkant 0; water = 0xFFFF.
    from shapely.geometry import Polygon
    heights_meta = json.loads((C.WORK / "heights_meta.json").read_text())
    hmin = heights_meta["hmin"]
    bx, bz = int(round((maxx - minx) / 2)) + 1, int(round((maxy - miny) / 2)) + 1
    btop = np.zeros((bz, bx), np.float64)          # absolute bovenkant (m NAP), 0 = vrij
    bbase = np.zeros((bz, bx), np.float64)         # onderkant boven maaiveld (m)
    cell_x = minx + np.arange(bx) * 2.0
    cell_y = miny + np.arange(bz) * 2.0            # rij 0 = zuidrand, zoals heights_2m
    btr = __import__("rasterio").transform.Affine(2.0, 0, minx - 1.0, 0, 2.0, miny - 1.0)   # rij j -> y = miny + 2j
    blocks = json.loads((C.WORK / "building_blocks.json").read_text())
    if blocks:
        from rasterio import features as _f
        shapes = []
        for ring, ztop in blocks:
            if len(ring) < 3:
                continue
            pg = Polygon(ring).buffer(0)
            if pg.is_empty:
                continue
            shapes.append((pg.buffer(0.6).__geo_interface__, float(ztop)))
        shapes.sort(key=lambda t: t[1])            # hoogste als laatste, zodat het maximum blijft staan
        rb = _f.rasterize(shapes, out_shape=(bz, bx), transform=btr, fill=0.0, dtype="float64")
        btop = np.maximum(btop, rb)
    trees = json.loads((C.MODEL / "trees.json").read_text())["trees"]
    species = json.loads((C.MODEL / "species.json").read_text())
    HB = {"conical": 0.12, "columnar": 0.15, "weeping": 0.22, "small": 0.3}
    gy, gx = np.mgrid[0:bz, 0:bx]
    for t in trees:
        x, y = t["x"] + C.ORIGIN[0], -t["z"] + C.ORIGIN[1]
        h, r = t["h"], t["r"]
        shp = species[t["spec"]]["shape"] if t.get("spec") is not None else "round"
        hb = HB.get(shp, 0.28 if h > 5 else 0.22) * h
        zg = float(T.sample(dtm, tr, [x], [y])[0])
        ci, cj = (x - minx) / 2.0, (y - miny) / 2.0
        k = int(np.ceil(r / 2.0)) + 1
        i0, i1 = max(int(ci) - k, 0), min(int(ci) + k + 1, bx)
        j0, j1 = max(int(cj) - k, 0), min(int(cj) + k + 1, bz)
        if i1 <= i0 or j1 <= j0:
            continue
        sub_i, sub_j = gx[j0:j1, i0:i1], gy[j0:j1, i0:i1]
        dist = np.hypot((sub_i - ci) * 2.0, (sub_j - cj) * 2.0)
        inside = dist <= r + 1.0
        top = zg + h
        cur_top = btop[j0:j1, i0:i1]
        cur_base = bbase[j0:j1, i0:i1]
        newcell = inside & (cur_top == 0)
        cur_base[newcell] = hb
        cur_top[inside] = np.maximum(cur_top[inside], top)
        # stam: de cel van de boom zelf blokkeert tot op de grond
        ti, tj = int(round(ci)), int(round(cj))
        if 0 <= ti < bx and 0 <= tj < bz:
            bbase[tj, ti] = 0.0
            btop[tj, ti] = max(btop[tj, ti], top)
    water = json.loads((C.WORK / "water_faces.json").read_text())
    wpolys = [Polygon(f["ring"]).buffer(0) for f in water if len(f["ring"]) >= 4]
    wmask = T.rasterize([(pg.__geo_interface__, 1) for pg in wpolys if not pg.is_empty], btr, (bz, bx)).astype(bool)
    enc = np.zeros((bz, bx), np.uint16)
    has = btop > 0
    top_dm = np.clip(np.round((btop - hmin) * 10.0), 1, 1023).astype(np.uint16)
    base_m = np.clip(np.round(bbase), 0, 62).astype(np.uint16)
    enc[has] = (top_dm[has] << 6) | base_m[has]
    enc[wmask & ~has] = 0xFFFF
    (C.MODEL / "block_2m.u16").write_bytes(enc.astype("<u2").tobytes())
    block_meta = {"nx": int(bx), "ny": int(bz), "dx": 2.0, "hmin": hmin, "x0": float(minx - C.ORIGIN[0]), "z_south": float(-(miny - C.ORIGIN[1]))}
    print(f"block_2m.u16: {bx} x {bz}, {int(has.sum())} cellen met object, {int((wmask & ~has).sum())} watercellen")

    # scene.json
    to_wgs = Transformer.from_crs("EPSG:28992", "EPSG:4326", always_xy=True)
    lon, lat = to_wgs.transform(*C.ORIGIN)
    heights = json.loads((C.WORK / "heights_meta.json").read_text()) if (C.WORK / "heights_meta.json").exists() else None
    stats = {}
    bj = C.MODEL / "buildings.json"
    if bj.exists():
        stats["gebouwen"] = len(json.loads(bj.read_text()))
    tj = C.MODEL / "trees.json"
    if tj.exists():
        t = json.loads(tj.read_text())
        stats["bomen_bgt"], stats["bomen_gedetecteerd"] = t.get("municipal", t.get("bgt", 0)), t["detected"]
        stats["bomen_soort"] = sum(1 for x in t.get("trees", []) if x.get("bron") == "haarlem")
    scene = {
        "naam": "Ramplaankwartier 3D",
        "gebouwd": dt.datetime.now().isoformat(timespec="minutes"),
        "origin_rd": list(C.ORIGIN), "origin_lonlat": [round(lon, 6), round(lat, 6)],
        "aoi_rd": list(C.AOI),
        "aoi_local": {"xmin": minx - C.ORIGIN[0], "xmax": maxx - C.ORIGIN[0],
                      "zmin": -(maxy - C.ORIGIN[1]), "zmax": -(miny - C.ORIGIN[1])},
        "patches": {"nx": C.NX, "ny": C.NY, "tex": "tex", "tex_hd": "tex_hd"},
        "heights": heights,
        "surface": surface_meta,
        "block": block_meta,
        "stats": stats,
        "bronnen": [
            {"naam": "AHN (actuele versie, DTM/DSM 0,5 m via PDOK WCS)", "licentie": "CC0 / CC BY 4.0", "url": "https://www.ahn.nl"},
            {"naam": f"Luchtfoto Beeldmateriaal Nederland {C.WMS_LAYER} (PDOK WMS)", "licentie": "CC BY 4.0", "url": "https://www.beeldmateriaal.nl"},
            {"naam": f"Kadaster 3D Basisvoorziening {C.KADASTER_JAAR} (gebouwen LoD 2.2, terrein, water)", "licentie": "CC BY 4.0", "url": "https://www.kadaster.nl/zakelijk/producten/geo-informatie/3d-basisvoorziening"},
            {"naam": "BGT (boompunten, straatnaamlabels) via PDOK", "licentie": "CC0", "url": "https://www.pdok.nl/introductie/-/article/basisregistratie-grootschalige-topografie-bgt-"},
            {"naam": "CBS Wijken en Buurten 2025 (buurtgrens)", "licentie": "CC BY 4.0", "url": "https://www.cbs.nl"},
        ],
    }
    (C.MODEL / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    print("scene.json geschreven; origin lon/lat", round(lon, 5), round(lat, 5))


if __name__ == "__main__":
    main()
