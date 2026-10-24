"""Stap 5: luchtfototexturen per patch: 2x2 WMS-tegels samenvoegen, verkleinen, als WebP opslaan."""
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C

Image.MAX_IMAGE_PIXELS = None


def main():
    C.ensure_dirs()
    for i in range(C.NX):
        for j in range(C.NY):
            tiles = {(a, b): Image.open(C.RAW / "ortho" / f"p{i}{j}_s{a}{b}.jpg").convert("RGB")
                     for a in range(C.WMS_SUB) for b in range(C.WMS_SUB)}
            tw, th = tiles[(0, 0)].size
            canvas = Image.new("RGB", (tw * C.WMS_SUB, th * C.WMS_SUB))
            for (a, b), tile in tiles.items():
                if tile.size != (tw, th):
                    tile = tile.resize((tw, th), Image.LANCZOS)
                canvas.paste(tile, (a * tw, (C.WMS_SUB - 1 - b) * th))  # b=0 is zuid -> onderaan
            if canvas.getextrema() == ((255, 255), (255, 255), (255, 255)):
                raise RuntimeError(f"patch p{i}{j}: luchtfoto leeg (wit) - controleer WMS_LAYER/WMS_GSD")
            for size, folder in ((C.TEX_STD, "tex"), (C.TEX_HD, "tex_hd")):
                img = canvas.resize((size, size), Image.LANCZOS)
                out = C.MODEL / folder / f"p{i}{j}.webp"
                img.save(out, "WEBP", quality=C.WEBP_QUALITY, method=4)
            print(f"p{i}{j}: {(C.MODEL/'tex'/f'p{i}{j}.webp').stat().st_size/1e6:.2f} MB std, "
                  f"{(C.MODEL/'tex_hd'/f'p{i}{j}.webp').stat().st_size/1e6:.2f} MB hd", flush=True)


if __name__ == "__main__":
    main()
