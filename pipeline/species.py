"""Soortenprofielen voor de bomen: uiterlijk per seizoen, bloesem en kroonvorm.

Profiel-velden (kleuren sRGB 0..1):
  nl            Nederlandse naam
  summer        zomerkleur kroon
  autumn        herfstkleur
  as, fs, lo    verschuiving in dagen van resp. verkleuring, bladval en uitlopen t.o.v. de standaard
                (standaard: verkleuren 23 sep - 31 okt, bladval 19 okt - 26 nov, uitlopen 29 mrt - 12 mei)
  evergreen     groenblijvend
  blossom       bloesemkleur of None; bdoy = dag van het jaar (piek), blen = duur in dagen
  shape         round | broad | small | columnar | weeping | conical
Toewijzing: eerst cultivar-regels (deel van de Latijnse naam), dan geslacht, anders 'onbekend'.
"""
import re

G = (0.28, 0.45, 0.19)        # standaard zomergroen
GEEL, ORANJE, BRUIN = (0.84, 0.70, 0.16), (0.80, 0.42, 0.12), (0.62, 0.42, 0.15)
WIT, ROZE = (0.96, 0.95, 0.92), (0.92, 0.62, 0.74)


def prof(nl, summer=G, autumn=GEEL, as_=0, fs=0, lo=0, evergreen=False, blossom=None, bdoy=0, blen=0, shape="round"):
    return {"nl": nl, "summer": summer, "autumn": autumn, "as": as_, "fs": fs, "lo": lo, "evergreen": evergreen,
            "blossom": blossom, "bdoy": bdoy, "blen": blen, "shape": shape}


GENUS = {
    "Alnus": prof("els", (0.26, 0.42, 0.17), (0.36, 0.38, 0.14), as_=12, fs=15, lo=-6),
    "Salix": prof("wilg", (0.42, 0.56, 0.27), (0.66, 0.64, 0.24), as_=5, fs=10, lo=-20, shape="broad"),
    "Acer": prof("esdoorn", G, (0.72, 0.56, 0.15), shape="broad"),
    "Malus": prof("sierappel", (0.30, 0.46, 0.20), (0.70, 0.54, 0.18), blossom=(0.95, 0.86, 0.88), bdoy=118, blen=16, shape="small"),
    "Tilia": prof("linde", (0.28, 0.46, 0.18), (0.82, 0.68, 0.15), as_=-4, shape="broad"),
    "Populus": prof("populier", (0.30, 0.48, 0.20), (0.86, 0.72, 0.18), as_=-5, fs=-5, shape="broad"),
    "Betula": prof("berk", (0.38, 0.56, 0.22), (0.88, 0.74, 0.20), as_=-10, fs=-10, lo=-8),
    "Crataegus": prof("meidoorn", (0.27, 0.43, 0.18), (0.72, 0.42, 0.15), blossom=WIT, bdoy=132, blen=14, shape="small"),
    "Prunus": prof("sierkers", G, (0.80, 0.42, 0.15), blossom=WIT, bdoy=112, blen=14, shape="small"),
    "Fagus": prof("beuk", (0.24, 0.40, 0.16), (0.62, 0.36, 0.14), as_=8, fs=25, shape="broad"),
    "Parrotia": prof("Perzisch ijzerhout", G, (0.86, 0.34, 0.10), as_=-5, shape="small"),
    "Sorbus": prof("lijsterbes", G, (0.82, 0.42, 0.12), blossom=WIT, bdoy=130, blen=10, shape="small"),
    "Quercus": prof("eik", (0.27, 0.43, 0.18), (0.60, 0.42, 0.14), as_=12, fs=20, lo=10, shape="broad"),
    "Carpinus": prof("haagbeuk", G, (0.72, 0.58, 0.18), as_=4, fs=20),
    "Ulmus": prof("iep", G, (0.80, 0.68, 0.18), fs=5, shape="broad"),
    "Ginkgo": prof("ginkgo", (0.33, 0.50, 0.22), (0.93, 0.78, 0.10), as_=6, fs=8, lo=6, shape="columnar"),
    "Robinia": prof("robinia", (0.32, 0.50, 0.22), (0.72, 0.68, 0.20), fs=-10, lo=12, blossom=WIT, bdoy=152, blen=10),
    "Fraxinus": prof("es", G, (0.65, 0.65, 0.22), fs=-12, lo=12, shape="broad"),
    "Cupressocyparis": prof("leylandcipres", (0.20, 0.34, 0.18), (0.20, 0.34, 0.18), evergreen=True, shape="conical"),
    "Pyrus": prof("sierpeer", (0.26, 0.42, 0.18), (0.60, 0.20, 0.15), as_=15, fs=25, blossom=WIT, bdoy=105, blen=12, shape="columnar"),
    "Platanus": prof("plataan", (0.30, 0.47, 0.20), (0.72, 0.56, 0.18), as_=6, fs=15, shape="broad"),
    "Liquidambar": prof("amberboom", G, (0.60, 0.12, 0.14), fs=12, shape="conical"),
    "Juglans": prof("walnoot", (0.30, 0.46, 0.20), (0.74, 0.58, 0.18), fs=-8, lo=12, shape="broad"),
    "Aesculus": prof("paardenkastanje", (0.26, 0.42, 0.17), (0.75, 0.45, 0.12), as_=-12, fs=-8, blossom=(0.95, 0.93, 0.85), bdoy=128, blen=12, shape="broad"),
    "Pinus": prof("den", (0.22, 0.36, 0.20), (0.22, 0.36, 0.20), evergreen=True, shape="broad"),
    "Catalpa": prof("trompetboom", (0.32, 0.50, 0.22), (0.72, 0.68, 0.20), fs=-10, lo=18, blossom=WIT, bdoy=180, blen=12, shape="broad"),
    "Castanea": prof("tamme kastanje", G, (0.72, 0.56, 0.18), fs=5, shape="broad"),
    "Metasequoia": prof("watercipres", (0.30, 0.48, 0.22), (0.72, 0.40, 0.15), as_=10, fs=15, shape="conical"),
    "Morus": prof("moerbei", G, (0.84, 0.70, 0.16), fs=-5),
    "Magnolia": prof("magnolia", G, (0.72, 0.56, 0.18), blossom=(0.95, 0.85, 0.90), bdoy=100, blen=14, shape="small"),
    "Pterocarya": prof("vleugelnoot", G, (0.80, 0.66, 0.18), shape="broad"),
    "Cladrastis": prof("geelhout", G, (0.86, 0.62, 0.14), blossom=WIT, bdoy=160, blen=10),
    "Ostrya": prof("hopbeuk", G, (0.72, 0.58, 0.18)),
    "Liriodendron": prof("tulpenboom", G, (0.88, 0.76, 0.18), shape="broad"),
    "Ilex": prof("hulst", (0.18, 0.32, 0.16), (0.18, 0.32, 0.16), evergreen=True, shape="small"),
    "Taxodium": prof("moerascipres", (0.30, 0.48, 0.22), (0.70, 0.38, 0.14), as_=10, fs=20, shape="conical"),
    "Sophora": prof("honingboom", G, (0.72, 0.68, 0.20), as_=8, fs=10, lo=10),
    "Cercis": prof("judasboom", G, (0.84, 0.70, 0.16), blossom=(0.85, 0.45, 0.65), bdoy=118, blen=14, shape="small"),
    "Taxus": prof("taxus", (0.16, 0.30, 0.15), (0.16, 0.30, 0.15), evergreen=True, shape="small"),
    "Picea": prof("spar", (0.20, 0.34, 0.20), (0.20, 0.34, 0.20), evergreen=True, shape="conical"),
    "Larix": prof("lariks", (0.34, 0.52, 0.24), (0.84, 0.62, 0.14), as_=10, fs=15, shape="conical"),
    "Onbekend": prof("onbekende soort"),
}

# Cultivar-regels: (deel van de Latijnse naam, lowercase) -> overschrijvingen
CULTIVAR = [
    ("fagus sylvatica atropunicea", {"summer": (0.30, 0.12, 0.16), "autumn": (0.46, 0.22, 0.12), "nl": "bruine beuk"}),
    ("fagus sylvatica purpurea", {"summer": (0.30, 0.12, 0.16), "autumn": (0.46, 0.22, 0.12), "nl": "bruine beuk"}),
    ("populus nigra italica", {"shape": "columnar", "nl": "Italiaanse populier"}),
    ("populus canescens", {"summer": (0.40, 0.52, 0.30), "nl": "grauwe abeel"}),
    ("populus alba", {"summer": (0.42, 0.54, 0.32), "nl": "witte abeel"}),
    ("populus tremula", {"nl": "ratelpopulier", "shape": "round"}),
    ("salix sepulcralis", {"shape": "weeping", "nl": "treurwilg"}),
    ("salix babylonica", {"shape": "weeping", "nl": "treurwilg"}),
    ("salix matsudana tortuosa", {"nl": "kronkelwilg", "shape": "round"}),
    ("salix caprea", {"nl": "boswilg", "shape": "small"}),
    ("betula pendula", {"shape": "weeping"}),
    ("acer platanoides globosum", {"shape": "small", "nl": "bolesdoorn", "autumn": (0.85, 0.60, 0.12)}),
    ("acer platanoides", {"autumn": (0.85, 0.60, 0.12), "nl": "Noorse esdoorn"}),
    ("acer saccharinum", {"autumn": (0.86, 0.70, 0.20), "nl": "zilveresdoorn", "summer": (0.34, 0.50, 0.24)}),
    ("acer pseudoplatanus", {"autumn": (0.70, 0.55, 0.15), "nl": "gewone esdoorn"}),
    ("acer campestre", {"nl": "veldesdoorn", "shape": "small", "autumn": (0.80, 0.65, 0.15)}),
    ("quercus robur fastigiata", {"shape": "columnar", "nl": "zuileik"}),
    ("quercus palustris", {"autumn": (0.70, 0.22, 0.10), "nl": "moeraseik"}),
    ("quercus texana", {"autumn": (0.70, 0.22, 0.10), "nl": "Texaanse eik"}),
    ("carpinus betulus frans fontaine", {"shape": "columnar", "nl": "zuilhaagbeuk"}),
    ("prunus serrulata", {"blossom": ROZE, "bdoy": 112, "blen": 14, "nl": "Japanse sierkers", "autumn": (0.80, 0.40, 0.15)}),
    ("prunus padus", {"blossom": WIT, "bdoy": 120, "blen": 12, "nl": "vogelkers", "autumn": (0.82, 0.66, 0.18)}),
    ("prunus avium", {"blossom": WIT, "bdoy": 108, "blen": 12, "nl": "zoete kers"}),
    ("prunus serotina", {"blossom": WIT, "bdoy": 135, "blen": 10, "nl": "Amerikaanse vogelkers", "autumn": GEEL}),
    ("prunus domestica", {"blossom": WIT, "bdoy": 108, "blen": 12, "nl": "pruim"}),
    ("malus domestica", {"nl": "appel", "blossom": (0.96, 0.88, 0.90), "bdoy": 120}),
    ("malus red sentinel", {"blossom": (0.90, 0.62, 0.72)}),
    ("malus liset", {"blossom": (0.86, 0.40, 0.55), "summer": (0.28, 0.36, 0.20)}),
    ("malus floribunda", {"blossom": (0.94, 0.72, 0.80)}),
    ("crataegus laevigata paul", {"blossom": (0.85, 0.35, 0.45), "nl": "rode meidoorn"}),
    ("crataegus monogyna", {"nl": "eenstijlige meidoorn"}),
    ("sorbus aria", {"summer": (0.38, 0.50, 0.30), "nl": "meelbes", "autumn": (0.80, 0.62, 0.20)}),
    ("sorbus aucuparia", {"nl": "wilde lijsterbes"}),
    ("sorbus intermedia", {"nl": "Zweedse meelbes"}),
    ("sorbus thuringiaca fastigiata", {"shape": "columnar"}),
    ("tilia tomentosa", {"summer": (0.36, 0.50, 0.26), "nl": "zilverlinde"}),
    ("tilia euchlora", {"nl": "Krimlinde"}),
    ("tilia cordata", {"nl": "winterlinde"}),
    ("tilia platyphyllos", {"nl": "zomerlinde"}),
    ("tilia americana", {"nl": "Amerikaanse linde"}),
    ("ulmus carpinifolia wredei", {"summer": (0.55, 0.62, 0.20), "nl": "goudiep"}),
    ("pyrus calleryana chanticleer", {"shape": "columnar", "nl": "sierpeer Chanticleer"}),
    ("pyrus communis", {"shape": "round", "nl": "peer", "autumn": (0.72, 0.52, 0.16), "as": 0, "fs": 0}),
    ("alnus glutinosa", {"nl": "zwarte els"}),
    ("alnus incana", {"nl": "grijze els"}),
    ("alnus spaethii", {"nl": "Spaeths els"}),
    ("juglans regia", {"nl": "okkernoot"}),
    ("aesculus flava", {"autumn": (0.82, 0.52, 0.12), "nl": "gele pavia"}),
    ("betula verrucosa", {"nl": "ruwe berk"}),
    ("betula ermanii", {"nl": "goudberk"}),
    ("robinia pseudoacacia", {"nl": "gewone robinia"}),
    ("fraxinus excelsior", {"nl": "gewone es"}),
    ("platanus acerifolia", {"nl": "gewone plataan"}),
    ("ginkgo biloba", {"nl": "ginkgo"}),
    ("liquidambar styraciflua", {"nl": "amberboom"}),
    ("catalpa bignonioides nana", {"shape": "small", "nl": "boltrompetboom"}),
    ("castanea sativa", {"nl": "tamme kastanje"}),
    ("metasequoia glyptostroboides", {"nl": "watercipres"}),
    ("cupressocyparis leylandii", {"nl": "leylandcipres"}),
    ("pinus nigra", {"nl": "zwarte den"}),
    ("magnolia kobus", {"nl": "beverboom", "blossom": WIT, "bdoy": 98}),
    ("cercis siliquastrum", {"nl": "judasboom"}),
    ("taxodium distichum", {"nl": "moerascipres"}),
    ("sophora japonica", {"nl": "honingboom"}),
    ("liriodendron tulipifera", {"nl": "tulpenboom"}),
    ("ilex aquifolium", {"nl": "hulst"}),
    ("ostrya carpinifolia", {"nl": "hopbeuk"}),
    ("morus alba", {"nl": "witte moerbei"}),
    ("pterocarya fraxinifolia", {"nl": "Kaukasische vleugelnoot"}),
    ("cladrastis kentukea", {"nl": "geelhout"}),
    ("fagus sylvatica", {"nl": "beuk"}),
    ("quercus robur", {"nl": "zomereik"}),
    ("carpinus betulus", {"nl": "haagbeuk"}),
    ("ulmus hollandica", {"nl": "Hollandse iep"}),
    ("acer cappadocicum", {"nl": "Kolchische esdoorn", "autumn": (0.88, 0.72, 0.16)}),
]

# Profielen voor bomen zonder soort (automatisch gedetecteerde tuinbomen): willekeurig toegewezen
GENERIC = [
    prof("onbekend (geel)", G, (0.82, 0.66, 0.14)),
    prof("onbekend (oranjebruin)", (0.27, 0.44, 0.18), (0.74, 0.40, 0.12)),
    prof("onbekend (olijf)", (0.26, 0.42, 0.17), (0.42, 0.44, 0.14), as_=8, fs=10),
    prof("onbekend (groenblijvend)", (0.20, 0.34, 0.18), (0.20, 0.34, 0.18), evergreen=True),
]
GENERIC_WEIGHTS = [0.34, 0.3, 0.22, 0.14]


class SpeciesTable:
    """Bouwt een lijst unieke profielen op (index per profiel) en wijst bomen toe."""

    def __init__(self):
        self.profiles = []
        self._index = {}

    def _add(self, key, profile):
        if key not in self._index:
            self._index[key] = len(self.profiles)
            self.profiles.append(dict(profile, key=key))
        return self._index[key]

    def for_name(self, genus, latin):
        latin_l = re.sub(r"\s+", " ", (latin or "").strip().lower())
        base = GENUS.get((genus or "").strip().capitalize()) or GENUS["Onbekend"]
        p = dict(base)
        for needle, over in CULTIVAR:
            if latin_l.startswith(needle):
                p.update(over)
                break
        p["lt"] = (latin or "").strip() or (genus or "")
        return self._add(latin_l or (genus or "onbekend").lower(), p)

    def generic(self, rnd):
        acc = 0.0
        for g, w in zip(GENERIC, GENERIC_WEIGHTS):
            acc += w
            if rnd <= acc:
                return self._add("generic:" + g["nl"], dict(g, lt=""))
        return self._add("generic:" + GENERIC[-1]["nl"], dict(GENERIC[-1], lt=""))
