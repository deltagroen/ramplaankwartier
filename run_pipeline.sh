#!/bin/bash
# Bouwt het complete 3D-model opnieuw op uit de brondata. Zie README.md voor de vereisten.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PY:-$HOME/micromamba/envs/ramplaan3d/bin/python}"
if [ ! -x "$PY" ]; then echo "Python-omgeving niet gevonden ($PY). Zie README.md (micromamba create ...)."; exit 1; fi
echo "== 1/8 brondata ophalen";        python3 pipeline/fetch_data.py
echo "== 2/8 water en BGT-maquette";    "$PY" pipeline/build_water_maquette.py
echo "== 3/8 gebouwen";                 "$PY" pipeline/build_buildings.py
echo "== 4/8 terrein";                  "$PY" pipeline/build_terrain.py
echo "== 5/8 luchtfototexturen";        "$PY" pipeline/build_textures.py
echo "== 6/8 bomen";                    "$PY" pipeline/build_trees.py
echo "== 7/9 buurtgrens, labels, scene"; "$PY" pipeline/build_misc.py
echo "== 8/9 omgeving (ring + buitenzone)"; "$PY" pipeline/build_context.py
echo "== 9/9 optimaliseren (gltf-transform via npx)"; bash pipeline/optimize.sh
echo "klaar: open de viewer met ./start.command (macOS) of start.bat (Windows)"
