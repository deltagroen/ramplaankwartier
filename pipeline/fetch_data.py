"""Stap 1: alle brondata ophalen voor het werkgebied (alleen standaardbibliotheek).

- AHN DTM/DSM 0,5 m via PDOK WCS
- Luchtfoto 8 cm via PDOK WMS (2 x 2 deelverzoeken per patch)
- Kadaster 3D Basisvoorziening 2025 (gebouwen + volledig) als CityJSON
- BGT boompunten (vegetatieobject_punt) via PDOK OGC API
- CBS buurtgrens Ramplaankwartier
Bestaande bestanden worden overgeslagen; verwijder ze om opnieuw op te halen.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C

UA = {"User-Agent": "Ramplaankwartier3D/1.0 (open data pipeline)"}


def http_get(url, dest: Path | None = None, retries=4, timeout=300):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                ctype = r.headers.get("Content-Type", "")
            if dest is None:
                return data, ctype
            if "xml" in ctype and dest.suffix != ".xml":
                raise RuntimeError(f"server gaf XML (fout) terug: {data[:300]!r}")
            dest.write_bytes(data)
            return data, ctype
        except Exception as e:  # noqa: BLE001
            wait = 3 * (attempt + 1)
            print(f"  poging {attempt + 1} mislukt ({e}); opnieuw in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"ophalen mislukt: {url}")


def fetch_terrain():
    minx, miny, maxx, maxy = C.AOI
    for cov in ("dtm_05m", "dsm_05m"):
        dest = C.RAW / "terrain" / f"{cov}_aoi.tif"
        if dest.exists():
            print(f"[terrein] {dest.name} bestaat al"); continue
        url = (f"{C.WCS_URL}?service=WCS&version=2.0.1&request=GetCoverage&coverageid={cov}"
               f"&subset=x({minx:.0f},{maxx:.0f})&subset=y({miny:.0f},{maxy:.0f})&format=image/tiff")
        print(f"[terrein] {cov} ophalen ...", flush=True)
        http_get(url, dest)
        print(f"[terrein] {dest.name}: {dest.stat().st_size/1e6:.1f} MB")


def fetch_ortho():
    n = 0
    for i in range(C.NX):
        for j in range(C.NY):
            x0, y0, x1, y1 = C.patch_bbox(i, j)
            sw = (x1 - x0) / C.WMS_SUB
            sh = (y1 - y0) / C.WMS_SUB
            for a in range(C.WMS_SUB):
                for b in range(C.WMS_SUB):
                    dest = C.RAW / "ortho" / f"p{i}{j}_s{a}{b}.jpg"
                    if dest.exists():
                        continue
                    bbox = f"{x0 + a*sw:.1f},{y0 + b*sh:.1f},{x0 + (a+1)*sw:.1f},{y0 + (b+1)*sh:.1f}"
                    wpx = min(int(sw / C.WMS_GSD), C.WMS_MAXPX)
                    hpx = min(int(sh / C.WMS_GSD), C.WMS_MAXPX)
                    url = (f"{C.WMS_URL}?service=WMS&version=1.3.0&request=GetMap&layers={C.WMS_LAYER}"
                           f"&styles=&crs=EPSG:28992&bbox={bbox}&width={wpx}&height={hpx}&format=image/jpeg")
                    http_get(url, dest)
                    n += 1
                    print(f"[luchtfoto] {dest.name} ({dest.stat().st_size/1e6:.1f} MB)", flush=True)
    print(f"[luchtfoto] {n} nieuwe tegels opgehaald")


def fetch_kadaster():
    minx, miny, maxx, maxy = C.AOI
    for coll, kind in (("basisbestand_gebouwen", "gebouwen"), ("basisbestand_gebouwen_terreinen", "volledig")):
        url = (f"{C.KADASTER_API}/collections/{coll}/items?bbox={minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f}"
               f"&bbox-crs={urllib.parse.quote(C.RD_CRS, safe='')}&limit=200&f=json")
        data, _ = http_get(url)
        items = json.loads(data)["features"]
        for f in items:
            p = f["properties"]
            if p.get("jaargang_luchtfoto") != C.KADASTER_JAAR:
                continue
            tx, ty = (float(v) for v in p["bladnr"].split("_"))
            # tegel = 2 x 2 km, naam = linkeronderhoek
            overlap_x = min(maxx, tx + 2000) - max(minx, tx)
            overlap_y = min(maxy, ty + 2000) - max(miny, ty)
            if kind == "volledig" and (overlap_x <= 0 or overlap_y <= 0):
                continue  # alleen rakende tegel: niet nodig voor terrein/water
            link = p["download_link"]
            zpath = C.RAW / "kadaster3d" / Path(link).name
            marker = C.RAW / "kadaster3d" / f"{Path(link).stem}.city.json"
            if marker.exists():
                print(f"[kadaster] {marker.name} bestaat al"); continue
            print(f"[kadaster] {Path(link).name} ophalen ({p.get('download_size_bytes',0)/1e6:.1f} MB) ...", flush=True)
            http_get(link, zpath)
            with zipfile.ZipFile(zpath) as z:
                for name in z.namelist():
                    if name.endswith(".json"):
                        out = C.RAW / "kadaster3d" / Path(name).name
                        out.write_bytes(z.read(name))
                        if out != marker:
                            out.rename(marker)
            zpath.unlink()
            print(f"[kadaster] -> {marker.name}")


def fetch_bgt_trees():
    dest = C.RAW / "vector" / "bgt_bomen.geojson"
    if dest.exists():
        print(f"[bgt] {dest.name} bestaat al"); return
    minx, miny, maxx, maxy = C.AOI
    crs = urllib.parse.quote(C.RD_CRS, safe="")
    url = (f"{C.BGT_API}/collections/vegetatieobject_punt/items?bbox={minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f}"
           f"&bbox-crs={crs}&crs={crs}&limit=1000&f=json")
    feats = []
    while url:
        data, _ = http_get(url)
        d = json.loads(data)
        feats.extend(d.get("features", []))
        url = next((l["href"] for l in d.get("links", []) if l.get("rel") == "next"), None)
        print(f"[bgt] {len(feats)} boompunten ...", flush=True)
    feats = [f for f in feats if f["properties"].get("plus_type") == "boom" or f["properties"].get("plus_type") in (None, "")]
    dest.write_text(json.dumps({"type": "FeatureCollection", "crs_epsg": 28992, "features": feats}))
    print(f"[bgt] {len(feats)} bomen -> {dest.name}")


def fetch_buurt():
    dest = C.RAW / "vector" / "buurt_ramplaankwartier.geojson"
    if dest.exists():
        print(f"[cbs] {dest.name} bestaat al"); return
    src = C.RAW / "vector" / "cbs_buurten_2025_omgeving.json"
    if not src.exists():
        minx, miny, maxx, maxy = C.AOI
        url = (f"{C.CBS_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=wijkenbuurten:buurten"
               f"&outputFormat=json&srsName=EPSG:28992&bbox={minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f},EPSG:28992&count=100")
        http_get(url, src)
    d = json.loads(src.read_text())
    feats = [f for f in d["features"] if f["properties"].get("buurtcode") == C.BUURTCODE]
    if not feats:
        raise RuntimeError("buurt niet gevonden in CBS-bestand")
    dest.write_text(json.dumps({"type": "FeatureCollection", "crs_epsg": 28992, "features": feats}))
    print(f"[cbs] buurtgrens {feats[0]['properties'].get('buurtnaam')} -> {dest.name}")


def fetch_bgt_labels():
    """Straatnaamlabels (BGT openbareruimtelabel) voor oriëntatie in de viewer."""
    dest = C.RAW / "vector" / "bgt_labels.geojson"
    if dest.exists():
        print(f"[bgt] {dest.name} bestaat al"); return
    minx, miny, maxx, maxy = C.AOI
    crs = urllib.parse.quote(C.RD_CRS, safe="")
    url = (f"{C.BGT_API}/collections/openbareruimtelabel/items?bbox={minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f}"
           f"&bbox-crs={crs}&crs={crs}&limit=1000&f=json")
    feats = []
    while url:
        data, _ = http_get(url)
        d = json.loads(data)
        feats.extend(d.get("features", []))
        url = next((l["href"] for l in d.get("links", []) if l.get("rel") == "next"), None)
    dest.write_text(json.dumps({"type": "FeatureCollection", "crs_epsg": 28992, "features": feats}, ensure_ascii=False))
    print(f"[bgt] {len(feats)} labels -> {dest.name}")
    if feats:
        print("[bgt] labelvelden:", list(feats[0]["properties"].keys()))


if __name__ == "__main__":
    C.ensure_dirs()
    steps = sys.argv[1:] or ["terrain", "kadaster", "bgt", "labels", "buurt", "ortho"]
    for s in steps:
        {"terrain": fetch_terrain, "ortho": fetch_ortho, "kadaster": fetch_kadaster,
         "bgt": fetch_bgt_trees, "labels": fetch_bgt_labels, "buurt": fetch_buurt}[s]()
    print("klaar")
