# Ramplaankwartier 3D

Interactief 3D-model van het Ramplaankwartier (Haarlem) en 300 m omgeving, opgebouwd uit open overheidsdata
(AHN, Kadaster 3D Basisvoorziening, luchtfoto's, BGT, CBS). Het model draait in de browser op een gewone
computer, met vrij gezichtspunt, zonnestand met schaduwen, wandelmodus en BAG-informatie per pand.

![Overzicht van het model](docs/screenshot-overzicht.jpg)

## Online

De viewer staat op <https://deltagroen.nl/ramplaankwartier/>. Deployen gaat via de website-repo
`deltagroen/Sites`: de workflow "Deploy production" daar checkt deze repo uit en kopieert `viewer/` naar
`docs/ramplaankwartier/`, waarna de site als release naar de VPS gaat. Na een modelwijziging dus:

```bash
git push                                                   # deze repo
gh workflow run deploy-production.yml -R deltagroen/Sites  # site opnieuw deployen
```

## Viewer starten

De viewer moet via een lokale webserver worden geopend (browsers blokkeren het laden van modelbestanden
vanaf `file://`).

- macOS: dubbelklik op `start.command` (of in Terminal: `./start.command`).
- Windows: dubbelklik op `start.bat`.
- Handmatig: `cd viewer && python3 -m http.server 8765` en open <http://localhost:8765/>.

De map `viewer/` is zelfstandig: kopieer die map naar een andere computer of zet hem op een webserver
(bijv. GitHub Pages) en hij werkt zonder verdere installatie. Omvang circa 30 MB.

Bij het openen wordt de dag afgespeeld: de camera begint recht boven de wijk vlak voor zonsopkomst, kantelt naar
de opkomende zon, vliegt een lus om en door de wijk op wisselende hoogtes terwijl de zon zijn baan aflegt, en
eindigt vanaf de oostkant kijkend naar de ondergaande zon (circa 110 seconden, datum uit het datumveld). De lus
wordt elke keer willekeurig gegenereerd; begin- en eindpunt liggen vast. De baan blijft minstens 12 m boven het
hoogste object binnen 6 m (gebouwen, bomen, masten, uit een 4 m-oppervlaktegrid van het DSM), met één korte lage pas
op 8 m door een rechte straat of over een brede watergang zonder obstakels binnen 3,5 m (`model/streets.json`,
berekend in `build_misc.py`). De camera kijkt vooruit, naar een punt 200 m verderop op de baan, zodat het hoofd
meedraait in de richting waarin daarna gevlogen wordt (hoogstens 35 graden per seconde); de snelheid is constant,
met vertraging in scherpe bochten en in de lage pas. Tijdens het vliegen zijn het paneel ingeklapt en de
straatnamen uit. Elke muis- of toetsactie stopt het afspelen; de knop "Dag afspelen" of de spatiebalk start het
opnieuw.

De bomen volgen het seizoen van de gekozen datum, per soort: uitlopen in april (fris lichtgroen, wilg en els
vroeg, eik en es laat), bloesem bij sierappel, meidoorn, sierkers, sierpeer, magnolia en kastanje op het moment
van die soort, zomergroen per soort (bruine beuk donkerrood, abelen grijsgroen), verkleuring vanaf eind
september naar de kleur van de soort (beuk koper, berk en linde geel, Parrotia rood, amberboom purper, els en
wilg dof), bladval, en in de winter kale bomen: de kroon verdwijnt en een takkensilhouet verschijnt (drie
verticale en een horizontaal vlak met een procedureel getekende takkentextuur, zie `makeTwigTexture()`).
Groenblijvende soorten (den, leylandcipres, hulst, taxus) houden hun kroon. Tabel in `pipeline/species.py`,
toewijzing en kroonvorm (rond, breed, zuil, treur, kegel) in `build_trees.py`, kleuring in `applySeason()`.

Bediening: slepen = verschuiven, draaien = rechter muisknop, Ctrl/Shift+slepen, twee vingers op een trackpad,
toetsen `Q`/`E` of de draaiknoppen in het paneel (`R`/`F` kantelen, knop of kompas = noorden boven),
scrollen = zoomen, pijltjes = verschuiven, klik op een pand = BAG-gegevens, `W` = wandelen (WASD/pijltjes,
Shift = rennen, Esc = stoppen), `O` = overzicht. In het paneel: lagen aan/uit, datum en tijd voor de zonnestand, panden kleuren op
bouwjaar, BGT-maquette in plaats van luchtfoto.

## Wat zit erin

| Laag | Bron | Opmerking |
|---|---|---|
| Terrein | AHN DTM 0,5 m via PDOK WCS (actuele AHN; hier AHN5, gevlogen 2023) | 1 m-grid, vereenvoudigd tot ca. 0,8 M driehoeken, gaten gevuld, water ingebrand |
| Luchtfoto | Luchtfoto Beeldmateriaal NL 2026, 8 cm (PDOK WMS, laag `2026_orthoHR`) | 16 texturen van 2048², ingebed in terrain.glb |
| Gebouwen | Kadaster 3D Basisvoorziening 2025, LoD 2.2 (CityJSON) | 2730 panden, met bouwjaar en BAG-id; dakkleur = mediaankleur van de luchtfoto binnen het dak; gevelkleur = schatting op bouwjaar, afmeting en dakkleur (zie hieronder); 1,5 m onder maaiveld doorgetrokken |
| Bomen | Boomregister gemeente Haarlem (soort, leeftijd, kroonklasse) gekoppeld aan BGT-boompunten, plus automatische detectie in DSM-DTM | 1011 bomen met soort, 352 BGT-punten zonder soort, 6465 gedetecteerde tuinbomen (indicatief); hoogte uit AHN; klik op een boom voor soort en leeftijd |
| Water, wegen, groen | Kadaster 3D Basisvoorziening 2025 (BGT-vlakken met hoogte) | water altijd zichtbaar; wegen/groen als "maquette"-laag |
| Buurtgrens, straatnamen | CBS Wijken en Buurten 2025, BGT openbareruimtelabels | |

Coördinaten: RD New (EPSG:28992) met NAP-hoogtes, verschoven naar lokaal nulpunt RD (101800, 488600).
In het model is x = oost, y = omhoog, z = zuid (glTF-conventie). Werkgebied RD 101100–102500 / 488000–489200.

## Opnieuw bouwen

Vereisten (eenmalig):

```bash
brew install micromamba            # of zie https://mamba.readthedocs.io
micromamba create -y -n ramplaan3d -c conda-forge python=3.12 numpy scipy rasterio shapely pyproj \
    geopandas gdal pdal python-pdal mapbox_earcut pillow requests laspy lazrs-python
# Node.js (voor gltf-transform via npx), bijv. brew install node
```

Daarna:

```bash
./run_pipeline.sh
```

De stappen staan los in `pipeline/` en kunnen ook apart worden gedraaid (`fetch_data.py` gebruikt alleen de
standaardbibliotheek; de overige scripts draaien in de micromamba-omgeving). Instellingen zoals het werkgebied,
de textuurresolutie en de luchtfotolaag staan in `pipeline/config.py`. Brondata komt in `data/raw/` (wordt
overgeslagen als het al bestaat), tussenresultaten in `data/work/`, het model in `viewer/model/`.

Pipeline:

1. `fetch_data.py` – DTM/DSM (WCS), luchtfototegels (WMS), Kadaster CityJSON-tegels, BGT-bomen en -labels, boomregister Haarlem (GeoServer data.haarlem.nl, laag bor_bomen), CBS-buurtgrens.
2. `build_water_maquette.py` – water.glb en maquette.glb; schrijft ook de watervlakken voor stap 4 en 6.
3. `build_buildings.py` – buildings.glb en buildings.json (attributen per pand).
4. `build_terrain.py` – terrain.glb (16 patches met UV's) en heights_2m.u16 (hoogtegrid voor de viewer).
5. `build_textures.py` – WebP-texturen per patch.
6. `build_trees.py` – trees.glb (kronen, stammen en takkensilhouetten), trees.json en species.json.
7. `build_misc.py` – buurtgrens.json, labels.json, scene.json.
8. `optimize.sh` – terrein vereenvoudigen en meshopt-compressie (gltf-transform). `buildings.glb` blijft
   ongecomprimeerd omdat het `_BID`-attribuut exact moet blijven.

## Gevelkleuren

Voor gevels bestaat geen open bron: de stereo- en obliekopnamen van Beeldmateriaal zijn niet open, de open
puntenwolk daaruit is een 8 cm-raster met nadirkleur zonder gevelpunten, en open straatbeelden (Mapillary,
Panoramax) dekken maar een deel van de straten. Daarom schat `pipeline/facade_colours.py` per pand een gangbaar
gevelmateriaal op basis van bouwperiode, met samenhang per bouwrij (zelfde bouwjaar binnen 30 m krijgt hetzelfde
materiaal), bijgebouwen in donker hout of grijs, grote lage hallen in grijs of kasglas. De keuze staat per pand in
`buildings.json` (`gevel_mat`, `gevel_bron`) en in het infopaneel van de viewer.

Handmatig corrigeren kan met `overrides/gevelkleuren_override.json`, bijvoorbeeld:

```json
{ "0392100000025541": "pleister_wit", "0392100000023311": [0.62, 0.40, 0.30] }
```

Sleutel is het BAG-pand-id (zie het infopaneel), waarde een materiaalnaam uit het palet in `facade_colours.py`
of een eigen kleur. Daarna `build_buildings.py` opnieuw draaien.

## Bekende beperkingen

- Jaargangen verschillen: AHN5 is van 2023, gebouwen en luchtfoto van 2025/2026. Panden gebouwd na 2023
  kunnen ontbreken of als blok (LoD 1.3) verschijnen.
- Automatisch gedetecteerde bomen zijn een benadering uit het hoogtemodel (winteropname): aantal, hoogte en
  kroonmaat zijn indicatief; dichte bosranden worden als rijen bollen weergegeven.
- Het terrein is het maaiveld; bruggen en viaducten zijn als BGT-vlak aanwezig maar niet als volume.
- Gevelkleuren zijn een schatting per bouwperiode, geen meting; de dakkleur komt wel uit de luchtfoto
  (winteropname, dus incl. mos en zonnepanelen, licht opgehaald in verzadiging).

## Bronnen en licenties

AHN (CC0/CC BY 4.0, ahn.nl), Kadaster 3D Basisvoorziening (CC BY 4.0), Luchtfoto Beeldmateriaal Nederland
(CC BY 4.0), BGT (CC0), CBS Wijken en Buurten (CC BY 4.0), boomregister gemeente Haarlem (open data, CC BY-SA 4.0). Vermeld bij publicatie de bronnen zoals in de
voettekst van de viewer. Software: three.js (MIT), SunCalc (BSD-2), gltf-transform (MIT), meshoptimizer (MIT).
