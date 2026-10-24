"""Gedeelde rasterfuncties: DTM/DSM lezen, gaten vullen, water inbranden, bemonsteren."""
import json
import numpy as np
import rasterio
from rasterio import features
from rasterio.fill import fillnodata
from scipy.ndimage import map_coordinates

import config as C


def _read(path):
    with rasterio.open(path) as ds:
        a = ds.read(1).astype(np.float64)
        nod = ds.nodata
        tr = ds.transform
    valid = np.isfinite(a) & (a > -100) & (a < 1000)
    if nod is not None:
        valid &= a != nod
    a[~valid] = np.nan
    return a, tr, valid


def load_dtm_filled(burn_water=True):
    """DTM 0,5 m met gevulde gaten; optioneel water-polygonen (uit build_water_maquette) ingebrand."""
    a, tr, valid = _read(C.RAW / "terrain" / "dtm_05m_aoi.tif")
    filled = fillnodata(np.nan_to_num(a, nan=0.0).astype(np.float32), mask=valid.astype(np.uint8),
                        max_search_distance=400, smoothing_iterations=2).astype(np.float64)
    wf = C.WORK / "water_faces.json"
    if burn_water and wf.exists():
        faces = json.loads(wf.read_text())
        shapes = [({"type": "Polygon", "coordinates": [f["ring"]]}, f["z"] - 0.7) for f in faces if len(f["ring"]) >= 4]
        if shapes:
            burned = features.rasterize(shapes, out_shape=filled.shape, transform=tr, fill=np.nan, dtype="float64")
            m = ~np.isnan(burned)
            filled[m] = np.minimum(filled[m], burned[m])
    return filled, tr, valid


def load_dsm():
    a, tr, valid = _read(C.RAW / "terrain" / "dsm_05m_aoi.tif")
    return a, tr, valid


def sample(arr, tr, xs, ys, order=1):
    """Bilineaire bemonstering van raster arr op RD-coördinaten (pixelmiddens)."""
    cols = (np.asarray(xs, dtype=np.float64) - tr.c) / tr.a - 0.5
    rows = (np.asarray(ys, dtype=np.float64) - tr.f) / tr.e - 0.5
    return map_coordinates(arr, [rows, cols], order=order, mode="nearest")


def rasterize(shapes, tr, shape, fill=0, dtype="uint8"):
    if not shapes:
        return np.zeros(shape, dtype=dtype)
    return features.rasterize(shapes, out_shape=shape, transform=tr, fill=fill, dtype=dtype)
