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

## Manus edit tool (local, not the publishing pipeline)

`manus-data.js` + `import.js` add a "Upload manus" / "Opdater manus" button at the bottom of the scheduling tool's left sidebar for building up the scene/cast list without hand-editing JSON — either by typing scenes in directly or by uploading the production's actual `.tex` sketch sources (avoids the kind of role-code transcription errors that hand-editing `data/scenes.json` has produced before).

**This is a local, per-browser iteration tool, not the git-committed publishing pipeline.** It never touches `data/scenes.json`/`data/cast.json` — it writes to `localStorage` (see below), so changes only exist in the browser that made them and won't appear on `matematikrevy.dk` or in another coordinator's browser. Promoting a browser's edits into the real committed data files is a manual step outside this tool (currently: transcribe by hand into `data/scenes.json`/`cast.json`, or ask for a "download current data" feature to be added).

- **Opening it**: clicking the sidebar button loads the *entire current catalog* into the modal (`initImportStateFromCurrentData()`), grouped into act sections exactly like the scheduling sidebar (Akt 1/Akt 2/Akt 3/Ekstranumre, via `renderSceneSidebar()`'s grouping in `schedule.js`) — it's a live, overview-first editor, not a blank staging form. Every scene starts collapsed to a single row (drag handle, name, a compact type badge, remove button); clicking a row expands it in place to show the editable fields. Act groups themselves are fixed to whatever acts already exist in the data — there's no "add a new act" control. **Act sections are collapsible too** (`act.open`, reset to *collapsed* every time the modal opens) — a small count badge stays visible next to the label either way. Adding a scene (manually or via a non-matching `.tex` upload) or updating one in place via a matching `.tex` upload force-opens its containing act (`ensureActOpen()`) so it's actually visible, since an expanded row inside a still-collapsed act section wouldn't render.
- **Act and scene number are not typed fields.** They're derived purely from which act-section a scene's row sits in and its position within that section, recomputed on "Opdater" (`id = ${actCode}-${positionInAct+1}`). There are two ways to change a scene's act: drag-and-drop (only enabled while a row is collapsed — expanding a row disables its drag handle), or the **Akt dropdown** next to the Scenenavn field when a row is expanded. The dropdown writes to `pendingActCode`, not `actCode` — the actual move (`moveSceneTo`) only fires when you collapse the row, so it doesn't jump out of view mid-edit; it lands at the *bottom* of the chosen act. `moveSceneTo` keeps `actCode`/`pendingActCode` in sync afterward regardless of whether the move came from a drag or the dropdown. New scenes (manual add, or an uploaded `.tex` that doesn't name-match anything already in the catalog) land in a synthetic **"Ikke placeret"** section above Akt 1 until placed; "Opdater" refuses to run while anything is still there.
- **Fields per (expanded) row**: scene name + act dropdown (same line), five scene-type pills (`sketch`/`sang`/`dans`/`bandsang`/`video`), cast rows (each a role-category dropdown + name). No duration field — it's unused by the scheduling grid, so it's dropped entirely (stored as `0`).
- **Scene types replace the old `schedulable` checkbox**: `sketch` and `sang` are mutually exclusive; `dans` can be combined with either one; `bandsang` and `video` are exclusive of everything else including each other. `schedulable` is derived (`setSceneType`/`isSchedulable` in `import.js`): true for `sketch`/`sang`/`dans`, false for `bandsang`/`video`. The `types` array is stored on the scene going forward so re-opening the tool doesn't have to re-guess it from `schedulable` alone (that guess — `schedulable ? ['sketch'] : ['video']` — only kicks in for scenes that predate this tool and have no `types` yet).
- **Cast role codes are normalized into one of 7 fixed categories** (`ROLE_CATEGORIES` in `import.js`: Instruktør, Koreograf, Dans, Sang/Rap, Kor, Skuespil, Statist) rather than kept as raw script codes (`S1`, `YD`, `D2/K7`, ...) — picked from a dropdown everywhere, never typed. `classifyRoleCode(code, types)` auto-guesses the category once, at `.tex`-parse time (or when a legacy raw code is first loaded into the tool — see `classifyOrKeep()`, which leaves already-categorized values alone so reclassifying doesn't corrupt them, e.g. "Koreograf" would otherwise false-positive-match the song ruleset's `startsWith('K')` check for Kor): `I`→Instruktør always; for `sang`/`bandsang`-typed scenes, `Y`→Koreograf, contains `D`→Dans, starts with `K`→Kor, starts with `St`→Statist, else→Sang/Rap; for everything else (including a brand-new upload with no type chosen yet — every `.tex` file uses the same generic `\begin{sketch}` wrapper regardless of content, so type can't be inferred from the file itself), starts with `St`→Statist, else→Skuespil. Classification is one-shot, not live — changing a scene's type afterward does not retroactively reclassify its already-categorized cast.
- **No "matches existing scene" picker** — instead, uploading a `.tex` that name-matches (case-insensitive) a row already in the catalog updates that row's name/cast **in place** (position and act untouched); a non-matching upload (or manual add) creates a new row in "Ikke placeret". There's no separate merge/collision step at apply time — the modal *is* the catalog, so what you see is what gets written.
- **One uploaded file can contain the whole manuscript, not just one sketch.** `parseTexFile()` finds every `\title{}` in the file and treats the text between one and the next (or EOF) as that scene's scope, extracting its own `\begin{roles}` block from within that scope — so a single file with dozens of `\title{}`/`\begin{roles}` blocks back to back yields that many scenes, each matched/created independently exactly as above. A file with no `\title{}` at all still falls back to one untitled scene from the whole text, same as before. Rows only auto-expand when a whole upload batch produces exactly **one** scene total (the common "fix one sketch" case) — a bulk manuscript upload leaves everything collapsed (but force-opens the relevant act sections via `ensureActOpen()`) so the modal doesn't fill up with dozens of open forms at once. When a file yields more than one scene, each row's `fileName` badge is suffixed like `manus.tex (3/41)` to disambiguate which block it came from.
- **Applying** ("Opdater" button) walks each act section, assigns `number`/`id` from row order, builds the cast roster from `getEffectiveCastData()` (appends any new names, reindexes sequentially), writes the whole thing to `localStorage['matrevy-manus-data']`, and reloads — no download, no confirmation dialog. `schedule.js`'s `loadScenes()` and `renderRekvisittenCastList()` both read through `getEffectiveScenesData()`/`getEffectiveCastData()` (from `manus-data.js`) rather than the raw `SCENES_DATA`/`CAST_DATA` globals, so the reload picks up the change immediately.
- No external dependencies — plain regex parsing of the `.tex` text via `FileReader`, consistent with the rest of the site having zero JS dependencies.

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
