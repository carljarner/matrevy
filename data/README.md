# data/

This folder contains the source-of-truth data files for the scheduling tool.

## Files

| File | Purpose |
|------|---------|
| `scenes.json` | All scenes for the current production, with cast per scene |
| `cast.json` | Full cast list and role type legend |

## Updating for a New Production

1. **`scenes.json`** — Replace the `acts` array with the new production's scenes.
   - Set `schedulable: false` for videos, band jingles, and anything else with no rehearsable cast.
   - Set all `priority` values to `0` — the coordinator sets priorities per rehearsal day in the scheduling tool.
   - The `id` field must be unique (format: `"act-number"`, e.g. `"1-3"` or `"E-2"`).
   - `types` is optional but recommended: an array from `sketch`/`sang`/`dans`/`bandsang`/`video` (e.g. `["sang", "dans"]` for a choreographed song). Without it, the scheduling tool and manus editor can only guess `sketch` vs `video` from `schedulable` — a real `types` array is what drives correct role classification (Sang/Rap vs. Skuespil, etc. — see `CLAUDE.md`) and the dance/actor-split feature (a `dans`+`sketch`/`sang` combo splits into two independently-schedulable placements).

2. **`cast.json`** — Replace the `cast` array with the new cast list.
   - Keep the `index` values sequential starting from 0 (they match the column order in the LaTeX Rolleoversigt table).
   - Add any new role type codes to `role_type_legend`.

## Schema: scenes.json

```json
{
  "acts": [
    {
      "act": "1",
      "label": "Akt 1",
      "scenes": [
        {
          "id": "1-1",
          "number": 1,
          "name": "Scene name",
          "types": ["sketch"],
          "schedulable": true,
          "priority": 0,
          "cast": [
            { "name": "Cast member name", "role": "S1" }
          ]
        }
      ]
    }
  ]
}
```

## Schema: cast.json

```json
{
  "cast": [
    { "name": "Adam", "index": 0 }
  ]
}
```
