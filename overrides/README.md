# Handmatige correcties

`gevelkleuren_override.json`: gevelkleur per pand, sleutel = BAG-pand-id (16 cijfers, zie het infopaneel in de
viewer), waarde = materiaalnaam uit het palet in `pipeline/facade_colours.py` of een eigen kleur `[r, g, b]` (0..1).

```json
{ "0392100000025541": "pleister_wit", "0392100000023311": [0.62, 0.40, 0.30] }
```

Daarna `pipeline/build_buildings.py` opnieuw draaien (of `./run_pipeline.sh`).
