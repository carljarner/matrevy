# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Static HTML/CSS/JS site for Matematikrevyen (Danish student revue), hosted via GitHub Pages at `matematikrevy.dk`. No build step, no package manager, no framework, no test suite, no linter — validation is entirely manual. Node is only used for the one codegen script below.

## The one command you must know

`scenes-data.js` is **auto-generated** and must never be edited directly. After changing `data/scenes.json` or `data/cast.json`, regenerate it:

```
node scripts/embed-scenes.js
```

Commit `data/scenes.json`, `data/cast.json`, and `scenes-data.js` together.

`fetch()`-based data loading was intentionally replaced with embedded globals (`SCENES_DATA` and `CAST_DATA`, injected via `<script src="scenes-data.js">`) so the scheduling tool works when opened directly from the filesystem (`file://`), where `fetch()` fails. The `async` wrapper on `loadScenes()` in `schedule.js` is vestigial — the data is always synchronously available.

## Data schemas

Full schema docs live in `data/README.md`. Key non-obvious constraints:

- `data/scenes.json` — source of truth for scenes. Scene `id` format is `"act-number"` (e.g. `"1-3"`, `"E-2"`). `priority` must always be `0` in this file — the coordinator sets real priorities (0-3) per rehearsal day at runtime via the sidebar selector, stored only in `localStorage`. It's currently just a manual-placement aid (badge colour: 0=green, 1=blue, 2=yellow, 3=red) — there is no automatic placement using it; that was removed and will be redesigned later. `schedulable: false` for videos/band jingles with no rehearsable cast.
- `data/cast.json` — `index` values must stay sequential from 0; they're **not** used by the JS tool, only by a separate LaTeX table (Rolleoversigt). The `cast` array itself *is* used now, as `CAST_DATA` — it's the full roster shown in the Rekvisitten cast picker (see below).

## `schedule.js` architecture

- Single global `state` object: `{ rooms, slots, grid, scenes, allScenes, absentees }`.
- `grid[slotIdx][roomIdx]` is `{ sceneId, customCast? } | null` — never store the full scene object there, only the id. `customCast` (an array of cast names) is only present for Rekvisitten placements; see below.
- State is persisted to `localStorage` under key `matrevy-schedule` on every mutation (`saveState()`), restored on `DOMContentLoaded` (`restoreState()`). Any change that mutates state must preserve this contract or users lose their work on reload. The standard flush sequence after a mutation is `renderGrid()` + `renderSceneSidebar()` + `saveState()`.
- No reactive framework — the grid is a plain 2-D array and all UI updates require explicit render calls.
- Scenes are placed via a picker: click a time slot (or an empty cell) to open a modal, multi-select scenes, confirm to fill empty rooms left-to-right — except a *single* selected scene goes straight into the specific cell that was clicked. Each scene chip in the sidebar also has a priority (0-3) selector — a manual-placement aid only; automatic/priority-based placement was deliberately removed and will be redesigned later.
- **Custom scenes** (`CUSTOM_SCENES` in `schedule.js`, not in `data/scenes.json` — they're tool-level, not production content, so they survive a production swap): `Scenemøde` and `Rekvisitten`, tagged `custom: true`. They're prepended to `state.allScenes` so they sort above "Akt 1" in the picker, but `renderSceneSidebar()` explicitly skips `scene.custom` entries so they never appear in the left-hand nav. They're also exempt from the picker's "already placed" dimming (`isPlaced = !scene.custom && placed.has(...)`) since, unlike script scenes, they can legitimately be used in multiple slots per day.
  - `Scenemøde` renders "Alle" as its cast line in the grid instead of an (empty) cast list — see the `SCENEMODE_ID` branch in `renderCell()`.
  - `Rekvisitten` has no fixed cast; clicking it in the picker (`REKVISITTEN_ID` branch) skips the normal toggle-and-confirm flow and opens `renderRekvisittenCastList()`, a full-roster (`CAST_DATA`) checklist where cast already used elsewhere in that slot are shown unavailable. Confirming stores the chosen names on the cell as `customCast` and places it directly (in the clicked cell if there was one, else the first empty room). Conflict detection (`getConflicts`, `castConflictsAtNames`, drag/drop) resolves cast names per-cell via `getCellCastNames(cell)`, which prefers `cell.customCast` over the scene's fixed `cast` list, so Rekvisitten's chosen team is treated the same as any other scene's cast for conflict purposes.
- Time slot length is configurable via the "Segmentlængde" selector (`input-segment`, a handful of preset minute values, default 30 — check the `<option>`s in `schedule.html` for the current list), built by `buildSlots(startTime, endTime, segmentMinutes)` with a `(segmentMinutes - 5)`-minute guard so a slightly-short trailing slot is still included.
- `escHtml()` is the **only** XSS sanitiser in the codebase — always use it when interpolating user/data strings into `innerHTML`.

## Adding a new page

Copy `page-template.html`. Add a nav `<a>` to **all** existing pages. Mark `class="active"` only on the new page.

## Code style

- `'use strict'` at top of every JS file.
- Section headers in JS use `// ── Section name ─────` comment style.
- HTML and all user-facing strings/UI labels are in Danish.

## Deployment

Push to `main` → live at `matematikrevy.dk` within ~1-2 minutes. No CI, no build. `CNAME` controls the custom domain (Simply.com DNS, four A records pointing at GitHub Pages).

## Updating for a new production

The data files in `data/` are replaced each production cycle (see `data/README.md` for the full walkthrough): replace `scenes.json`'s `acts` array and `cast.json`'s `cast` array, keep `priority: 0` and sequential `index`, then regenerate `scenes-data.js` as above.
