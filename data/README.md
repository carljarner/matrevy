# data/

This folder contains the source-of-truth data files for the site.

These files can be edited by hand (see below) or via the site's in-page admin tools (the scheduling tool's "Rediger Manus" button, the Forside announcement editor, the Kalender event editor, the Arkiv year editor), which all save globally through `server/update-data.php` — see CLAUDE.md. A GitHub Action regenerates the embedded `*-data.js` files automatically after either kind of change lands on `main`; `node scripts/embed-scenes.js` only needs to be run by hand after editing these JSON files directly.

## Files

| File | Purpose |
|------|---------|
| `scenes.json` | All scenes for the current production, with cast per scene |
| `cast.json` | Full cast list and role type legend |
| `announcements.json` | Announcements shown on Forside |
| `calendar.json` | Events shown on the Kalender page |
| `archive.json` | Previous years' manus/videos shown on the Arkiv page |

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

## Schema: announcements.json

```json
{
  "announcements": [
    {
      "id": "kx7f2a",
      "date": "2025-11-27",
      "author": "Koordinatorerne",
      "level": "public",
      "text": "Besked her. Linjeskift bliver til separate afsnit."
    }
  ]
}
```

- `id` — unique string; the editor generates `Date.now().toString(36)`.
- `date` — `YYYY-MM-DD`; Forside sorts newest first.
- `level` — `"public"` (everyone) or `"revyst"` (only shown after revyst/admin login; still client-side-only gating).

## Schema: calendar.json

```json
{
  "events": [
    {
      "id": "m3k2j1",
      "date": "2026-01-15",
      "start": "19:00",
      "end": "22:00",
      "title": "Fællesøve",
      "category": "ove",
      "note": "Medbring manus"
    }
  ]
}
```

- Single-day events only — a multi-day thing is several events.
- `start`/`end` — `"HH:MM"` or `""` (all-day).
- `category` — ASCII key from `ove` / `forestilling` / `deadline` / `andet`; the Danish labels and colors live in `calendar.js`'s `CAL_CATEGORIES`.

## Schema: archive.json

```json
{
  "years": [
    {
      "year": 2024,
      "name": "MatRevy 2024",
      "folder": "MatRevy_2024",
      "coverImage": "archive/MatRevy_2024/cover.jpg",
      "youtubeUrl": "https://youtube.com/watch?v=...",
      "manusPdf": "archive/MatRevy_2024/manus.pdf",
      "sketches": [
        { "filename": "Scene1.pdf", "path": "archive/MatRevy_2024/sketches/Scene1.pdf" }
      ],
      "songs": [],
      "andet": []
    }
  ]
}
```

- `year` — integer, unique; auto-detected from `name` when creating a new entry (still editable); the archive page sorts newest first.
- `name` — required free-text display name, e.g. `"MatRevy 2024"`.
- `folder` — the repo-relative folder slug (`archive/<folder>/...`), derived once from `name` when the entry is created (spaces → `_`, Danish `æøå` transliterated, everything else stripped) and **never recomputed** — editing `name` later must not change `folder`, or every already-uploaded file would orphan.
- `coverImage`/`manusPdf` — repo-relative paths (`archive/<folder>/cover.jpg` / `archive/<folder>/manus.pdf`) or `""`. **Uploaded directly through the Arkiv admin UI** (no manual git step) — the browser reads the file, the site's PHP endpoint (`server/update-data.php`'s `upload` action) commits it to the repo via the GitHub Contents API. Cover photos are always re-encoded to JPEG client-side (canvas-resized, max ~1600px wide) before upload, so the filename/extension never changes across re-uploads.
- `sketches` / `songs` / `andet` — arrays of `{ filename, path }`, one entry per individually uploaded `.pdf`/`.tex` file, growing over time as an admin adds material via the same in-app uploader.
- Uploads are capped at ~5 MB each (client- and server-side) — Simply.com's actual PHP upload limits aren't documented, so this is a conservative guess.

## Adding a year to the archive

No manual git steps needed — everything happens in the browser:

1. Open `arkiv.html`, log in as admin.
2. Click the grey **+** tile at the end of the grid.
3. Fill in the Navn (required — e.g. "MatRevy 2024"; Årstal auto-fills from a year in the name), optionally a cover photo, a YouTube link, and the manuscript PDF.
4. Optionally upload individual sketch/song/other-material files further down — these can also be added later at any time via **Rediger** on the year's card.
5. Click **Gem** — files upload first (one at a time, with a progress indicator), then the year's metadata saves to `data/archive.json` via `server/update-data.php`; a GitHub Action then regenerates `archive-data.js` automatically.
