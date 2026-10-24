"""Geschatte gevelkleur per pand (route 2): op basis van bouwjaar, afmetingen en dakkleur.

Open bronnen voor echte gevelkleuren ontbreken (geen open stereo-/obliekbeelden, straatbeelden dekken te weinig
straten). Daarom een geloofwaardige schatting: per bouwperiode een palet van gangbare Nederlandse gevelmaterialen,
met samenhang per bouwrij (zelfde bouwjaar, dicht bij elkaar -> zelfde materiaal) en kleine variatie per pand.
Handmatige correcties: overrides/gevelkleuren_override.json  {"<BAG pand-id 16 cijfers>": "pleister_wit" | [r,g,b]}.
"""
import json
import random
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

# Kleuren zoals je ze ziet (sRGB 0..1), omschrijving voor de viewer.
PALETTE = {
    "baksteen_roodbruin": ((0.56, 0.34, 0.26), "roodbruine baksteen"),
    "baksteen_rood": ((0.64, 0.38, 0.29), "rode baksteen"),
    "baksteen_donkerbruin": ((0.42, 0.30, 0.25), "donkerbruine baksteen"),
    "baksteen_paarsbruin": ((0.47, 0.31, 0.30), "paarsbruine baksteen"),
    "baksteen_geelbruin": ((0.70, 0.58, 0.43), "geelbruine baksteen"),
    "baksteen_geel": ((0.78, 0.68, 0.50), "gele baksteen"),
    "baksteen_bruin": ((0.52, 0.40, 0.31), "bruine baksteen"),
    "pleister_wit": ((0.90, 0.88, 0.84), "wit pleisterwerk"),
    "pleister_creme": ((0.88, 0.83, 0.72), "crème pleisterwerk"),
    "grijs": ((0.58, 0.58, 0.57), "grijs (beton/plaat)"),
    "antraciet": ((0.33, 0.34, 0.35), "antraciet"),
    "hout_donker": ((0.40, 0.33, 0.27), "donker hout"),
    "glas_kas": ((0.80, 0.84, 0.86), "glas (kas)"),
}

# Bouwperiode (bovengrens exclusief) -> materialen met gewicht.
PERIODS = [
    (1900, [("baksteen_roodbruin", 4), ("baksteen_donkerbruin", 2), ("pleister_wit", 2), ("baksteen_rood", 1)]),
    (1930, [("baksteen_roodbruin", 5), ("baksteen_paarsbruin", 2), ("baksteen_rood", 2), ("pleister_wit", 1)]),
    (1945, [("baksteen_roodbruin", 4), ("baksteen_donkerbruin", 2), ("baksteen_paarsbruin", 2), ("baksteen_rood", 1), ("pleister_wit", 1)]),
    (1970, [("baksteen_geelbruin", 3), ("baksteen_rood", 3), ("baksteen_bruin", 2), ("baksteen_geel", 1)]),
    (1990, [("baksteen_bruin", 3), ("baksteen_geel", 2), ("baksteen_geelbruin", 2), ("baksteen_rood", 2), ("pleister_wit", 1)]),
    (2010, [("baksteen_rood", 3), ("baksteen_geel", 2), ("pleister_wit", 2), ("baksteen_bruin", 1), ("grijs", 1)]),
    (9999, [("baksteen_rood", 2), ("baksteen_bruin", 2), ("pleister_wit", 2), ("antraciet", 1), ("grijs", 1), ("hout_donker", 1)]),
]
UNKNOWN = [("baksteen_roodbruin", 3), ("baksteen_bruin", 2), ("pleister_creme", 1)]


def _period_options(year):
    if not year or year < 1700:
        return UNKNOWN
    for lim, opts in PERIODS:
        if year < lim:
            return opts
    return UNKNOWN


def _pick(options, rng, roof):
    """Gewogen keuze; een duidelijk oranjerood pannendak maakt rode baksteen wat waarschijnlijker."""
    opts = list(options)
    if roof is not None:
        r, g, b = roof
        if r > 0.42 and r > 1.35 * g:
            opts = [(m, w * (2 if m == "baksteen_rood" else 1)) for m, w in opts]
    total = sum(w for _, w in opts)
    x = rng.random() * total
    for m, w in opts:
        x -= w
        if x <= 0:
            return m
    return opts[-1][0]


def assign(buildings, override_path=None, cluster_dist=30.0, seed=7):
    """buildings: lijst dicts met id, bouwjaar, x, y (RD), area, h, dak (r,g,b).
    Geeft per pand (materiaalnaam, kleur) terug, in dezelfde volgorde."""
    n = len(buildings)
    years = [b.get("bouwjaar") for b in buildings]
    # Samenhang per bouwrij: panden met hetzelfde bouwjaar binnen cluster_dist m -> zelfde materiaal.
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    xy = np.array([(b["x"], b["y"]) for b in buildings], dtype=np.float64)
    tree = cKDTree(xy)
    for i, j in tree.query_pairs(cluster_dist):
        if years[i] and years[i] == years[j]:
            parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)

    overrides = {}
    if override_path and override_path.exists():
        overrides = json.loads(override_path.read_text())

    result = [None] * n
    for root, members in groups.items():
        key = min(buildings[i]["id"] for i in members)
        rng = random.Random(f"{seed}:{key}")
        first = buildings[members[0]]
        mat = _pick(_period_options(first.get("bouwjaar")), rng, first.get("dak"))
        for i in members:
            b = buildings[i]
            m = mat
            # bijgebouwen en grote lage hallen/kassen krijgen een eigen materiaal
            if b["area"] < 30 and b["h"] < 4.0:
                m = "hout_donker" if rng.random() < 0.65 else "grijs"
            elif b["area"] > 300 and b["h"] < 7.0:
                lum = sum(b["dak"]) / 3 if b.get("dak") else 0.4
                m = "glas_kas" if lum > 0.55 else "grijs"
            src = "schatting"
            bag = (b["id"] or "").split(".")[-1]
            ov = overrides.get(bag) or overrides.get(b["id"])
            if ov is not None:
                src = "handmatig"
                if isinstance(ov, str) and ov in PALETTE:
                    m = ov
                    col = np.array(PALETTE[m][0])
                else:
                    m = "handmatig"
                    col = np.clip(np.array(ov, dtype=float), 0, 1)
                    result[i] = (m, tuple(col), src)
                    continue
            col = np.array(PALETTE[m][0])
            jitter = 1.0 + 0.05 * (random.Random(f"{seed}:{b['id']}").random() - 0.5)
            result[i] = (m, tuple(np.clip(col * jitter, 0, 1)), src)
    return result


def describe(material):
    return PALETTE.get(material, (None, material))[1]
