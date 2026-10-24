"""Centrale instellingen voor de Ramplaankwartier 3D-pipeline.

Alle coördinaten zijn RD New (EPSG:28992) met hoogtes in m NAP.
Het 3D-model gebruikt een lokaal assenstelsel: x = oost, y = omhoog, z = zuid
(glTF is Y-up), met ORIGIN als nulpunt.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"
MODEL = ROOT / "viewer" / "model"
OVERRIDES = ROOT / "overrides"                       # handmatige correcties (wordt mee-gecommit)

# Werkgebied: CBS-buurt Ramplaankwartier (BU03920503) met ca. 300 m rand.
AOI = (101100.0, 488000.0, 102500.0, 489200.0)        # minx, miny, maxx, maxy (RD)
ORIGIN = (101800.0, 488600.0)                          # lokaal nulpunt (RD)
BUURTCODE = "BU03920503"

# Terrein: patches met eigen textuur.
NX, NY = 4, 4                                          # 4 x 4 patches van 350 x 300 m
GRID_M = 1.0                                           # hoekpuntafstand terreinmesh (m)

# Luchtfoto via PDOK WMS (max 2500 px per verzoek) -> per patch 2 x 2 deelverzoeken.
WMS_URL = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0"
WMS_LAYER = "2026_orthoHR"                             # 8 cm, winteropname 2026
WMS_SUB = 2
WMS_GSD = 0.085                                        # m per pixel per verzoek; fijner dan 8 cm levert de WMS leeg beeld
WMS_MAXPX = 2500
TEX_STD = 2048                                         # standaardtextuur per patch (px)
TEX_HD = 4096                                          # HD-textuur per patch (px)
WEBP_QUALITY = 82

# Hoogtemodel via PDOK WCS (actuele AHN, 0,5 m).
WCS_URL = "https://service.pdok.nl/rws/ahn/wcs/v1_0"

# Kadaster 3D Basisvoorziening (CityJSON) en BGT via PDOK OGC API Features.
KADASTER_API = "https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1"
BGT_API = "https://api.pdok.nl/lv/bgt/ogc/v1"
KADASTER_JAAR = 2025
RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992"

# CBS Wijken en Buurten (buurtgrens).
CBS_WFS = "https://service.pdok.nl/cbs/wijkenbuurten/2025/wfs/v1_0"

# Bomen
TREE_MIN_H = 3.0          # minimale hoogte (m) voor automatisch gedetecteerde bomen
TREE_WINDOW_M = 4.5       # zoekvenster voor lokale maxima in het kroonhoogtemodel
BUILDING_SKIRT = 1.5      # gebouwen zoveel meter onder maaiveld doortrekken (geen zwevende randen)


def patch_bbox(i: int, j: int):
    """RD-bbox van patch (i = kolom vanaf west, j = rij vanaf zuid)."""
    minx, miny, maxx, maxy = AOI
    pw = (maxx - minx) / NX
    ph = (maxy - miny) / NY
    return (minx + i * pw, miny + j * ph, minx + (i + 1) * pw, miny + (j + 1) * ph)


def to_local(x, y, z):
    """RD/NAP -> lokaal glTF-assenstelsel (x oost, y omhoog, z zuid)."""
    return (x - ORIGIN[0], z, -(y - ORIGIN[1]))


def ensure_dirs():
    for d in (RAW / "terrain", RAW / "ortho", RAW / "vector", RAW / "kadaster3d", WORK, MODEL, MODEL / "tex", MODEL / "tex_hd"):
        d.mkdir(parents=True, exist_ok=True)
