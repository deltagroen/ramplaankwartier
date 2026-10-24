# CLAUDE.md — Ramplaankwartier 3D

Werkinstructies voor dit project. Taal van code-commentaar, commits en documentatie: Nederlands.

## Harde regel: toestemming voor de VPS en productiesleutels

Vraag altijd eerst toestemming aan Stijn voordat je de VPS benadert of een productiesleutel gebruikt, en
wacht op een expliciet "ja". Dat geldt voor elke `ssh`-, `scp`- of `rsync`-verbinding met de VPS, ook alleen
lezen, en voor het gebruiken, kopiëren of doorgeven van sleutels uit `~/.ssh` (bijvoorbeeld als
GitHub-secret). Toestemming geldt per actie, niet voor de rest van de sessie. Controleren via de publieke URL
en via GitHub Actions valt hier niet onder. Liever een plakklaar blok voor Stijn dan zelf verbinden.

## Wat dit is

Pipeline (Python, `pipeline/`) die uit open data (AHN, Kadaster 3D Basisvoorziening, luchtfoto, BGT, CBS) een
3D-model van het Ramplaankwartier in Haarlem bouwt, en een zelfstandige three.js-viewer (`viewer/`) die het
model toont. Zie README.md voor gebruik, bronnen en beperkingen.

## Vastgelegde keuzes

- Werkgebied, nulpunt en bronlagen staan in `pipeline/config.py`; lokaal assenstelsel x = oost, y = omhoog,
  z = zuid (glTF), nulpunt RD (101800, 488600).
- `viewer/` moet zonder build-stap en zonder internet werken: bibliotheken zijn gevendord in `viewer/lib/`,
  alle paden zijn relatief zodat de viewer ook onder een subpad (deltagroen.nl/ramplaankwartier/) werkt.
- `viewer/model/*.glb` zijn bouwresultaten maar worden gecommit, want de site-deploy haalt ze uit deze repo.
  `viewer/model/tex/` niet: die texturen zitten al in `terrain.glb`.
- `buildings.glb` wordt niet met meshopt gecomprimeerd: het `_BID`-attribuut moet exact blijven.
- Dakkleur komt uit de luchtfoto; gevelkleur is een schatting per bouwperiode (`pipeline/facade_colours.py`),
  handmatig te corrigeren via `overrides/gevelkleuren_override.json`.
- Deploy: via de workflow in `deltagroen/Sites` (checkt deze repo uit, kopieert `viewer/` naar
  `docs/ramplaankwartier/`, rsync als release naar de VPS). Geen eigen VPS-deploy in deze repo.
- Brondata (`data/raw/`) en tussenresultaten (`data/work/`) zijn niet in git; `pipeline/fetch_data.py`
  haalt alles opnieuw op.
