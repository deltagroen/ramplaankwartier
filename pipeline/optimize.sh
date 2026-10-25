#!/bin/bash
# Stap 8: GLB's optimaliseren voor de browser (terrein vereenvoudigen + meshopt-compressie).
# Vereist Node (npx). buildings.glb blijft bewust ongecomprimeerd: het _BID-attribuut moet exact blijven.
set -euo pipefail
cd "$(dirname "$0")/.."
GT="npx --yes @gltf-transform/cli@4.5.1"
# Ruwe GLB's (uit de bouwstappen) staan in data/work/raw_glb; de texturen worden meegekopieerd omdat
# terrain.glb ze relatief (tex/...) aanspreekt.
mkdir -p data/work/raw_glb
rm -rf data/work/raw_glb/tex && cp -R viewer/model/tex data/work/raw_glb/tex
WHAT="${*:-terrain trees maquette water context_terrain context_objects}"
for f in $WHAT; do
  if [ -f "data/work/raw_glb/$f.glb" ] && [ ! "viewer/model/$f.glb" -nt "data/work/raw_glb/$f.glb" ]; then
    echo "[$f] ruwe versie in data/work/raw_glb is nieuwer of gelijk; die wordt gebruikt"
  else
    cp -f "viewer/model/$f.glb" "data/work/raw_glb/$f.glb"
  fi
done
for f in $WHAT; do
  case $f in
    terrain)
      $GT simplify data/work/raw_glb/terrain.glb data/work/raw_glb/terrain_simplified.glb --ratio 0.25 --error 0.0003 --lock-border true
      $GT meshopt data/work/raw_glb/terrain_simplified.glb viewer/model/terrain.glb --level high --quantize-position 16 --quantize-texcoord 14 ;;
    context_terrain)
      $GT simplify data/work/raw_glb/context_terrain.glb data/work/raw_glb/context_terrain_simplified.glb --ratio 0.3 --error 0.0002 --lock-border true
      $GT meshopt data/work/raw_glb/context_terrain_simplified.glb viewer/model/context_terrain.glb --level high --quantize-position 16 --quantize-texcoord 14 ;;
    *)
      $GT meshopt "data/work/raw_glb/$f.glb" "viewer/model/$f.glb" --level high --quantize-position 16 ;;
  esac
done
ls -la viewer/model/*.glb
