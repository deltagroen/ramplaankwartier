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
        stats["bomen_bgt"], stats["bomen_gedetecteerd"] = t["bgt"], t["detected"]
    scene = {
        "naam": "Ramplaankwartier 3D",
        "gebouwd": dt.datetime.now().isoformat(timespec="minutes"),
        "origin_rd": list(C.ORIGIN), "origin_lonlat": [round(lon, 6), round(lat, 6)],
        "aoi_rd": list(C.AOI),
        "aoi_local": {"xmin": minx - C.ORIGIN[0], "xmax": maxx - C.ORIGIN[0],
                      "zmin": -(maxy - C.ORIGIN[1]), "zmax": -(miny - C.ORIGIN[1])},
        "patches": {"nx": C.NX, "ny": C.NY, "tex": "tex", "tex_hd": "tex_hd"},
        "heights": heights,
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
