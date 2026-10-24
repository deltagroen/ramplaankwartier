"""Luchtfotomozaïek van het werkgebied (uit de ruwe WMS-tegels) en kleurbemonstering per polygoon."""
import numpy as np
from PIL import Image
from rasterio import features
from rasterio.transform import Affine

import config as C

Image.MAX_IMAGE_PIXELS = None


def load_mosaic(res=0.25):
    """RGB-mozaïek (H, W, 3) uint8 op `res` m/pixel plus de affiene transformatie (pixel -> RD)."""
    minx, miny, maxx, maxy = C.AOI
    W = int(round((maxx - minx) / res))
    H = int(round((maxy - miny) / res))
    mosaic = np.zeros((H, W, 3), np.uint8)
    for i in range(C.NX):
        for j in range(C.NY):
            x0, y0, x1, y1 = C.patch_bbox(i, j)
            sw, sh = (x1 - x0) / C.WMS_SUB, (y1 - y0) / C.WMS_SUB
            tw, th = int(round(sw / res)), int(round(sh / res))
            for a in range(C.WMS_SUB):
                for b in range(C.WMS_SUB):
                    tile = Image.open(C.RAW / "ortho" / f"p{i}{j}_s{a}{b}.jpg").convert("RGB").resize((tw, th), Image.BOX)
                    px = int(round((x0 + a * sw - minx) / res))
                    py = int(round((maxy - (y0 + (b + 1) * sh)) / res))
                    arr = np.asarray(tile)
                    h = min(th, H - py)
                    w = min(tw, W - px)
                    mosaic[py:py + h, px:px + w] = arr[:h, :w]
    return mosaic, Affine(res, 0, minx, 0, -res, maxy)


def median_colour(mosaic, tr, geom, min_pixels=4):
    """Mediaankleur (sRGB 0..1) van de mozaïekpixels binnen een shapely-polygoon, of None."""
    if geom.is_empty:
        return None
    gx0, gy0, gx1, gy1 = geom.bounds
    H, W = mosaic.shape[:2]
    c0 = max(int((gx0 - tr.c) / tr.a), 0)
    c1 = min(int(np.ceil((gx1 - tr.c) / tr.a)) + 1, W)
    r0 = max(int((tr.f - gy1) / -tr.e), 0)
    r1 = min(int(np.ceil((tr.f - gy0) / -tr.e)) + 1, H)
    if c1 <= c0 or r1 <= r0:
        return None
    win_tr = tr * Affine.translation(c0, r0)
    mask = features.rasterize([(geom.__geo_interface__, 1)], out_shape=(r1 - r0, c1 - c0), transform=win_tr,
                              fill=0, dtype="uint8")
    px = mosaic[r0:r1, c0:c1][mask == 1]
    if len(px) < min_pixels:
        return None
    return np.median(px, axis=0) / 255.0
