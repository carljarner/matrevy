---
paths:
  - "stjerneark.html"
  - "js/stjerneark.js"
  - "css/stjerneark.css"
---

# Stjerneark (`stjerneark.html`/`stjerneark.js`/`stjerneark.css`) — scene priorities

Was a Manus tab; now its own revyst-level page under Redskaber. One table like the old spreadsheet: acts stacked, one row per scene of `scenes.json` (SCENES_DATA, or this browser's `siteLoadOverride('manus')`; `pool` act and videos/band jingles skipped, `stjerneSceneIsMedia`), columns Titel / Skuespil / Sang / Dans / Band (0-3 pickers) / Dobbeltsegment / Øvet med band / Øvet på scene (checkboxes) / Kommentar, a `.site-sheet` straight in its card like Rekvisitten's (no frame of its own): it scrolls with the page (header row via `siteStickyHead`) and sideways with a sticky title column; Kommentar is one line that widens its column. Only the default pickers show (`stjerneDefaultFields()`: a sketch only Skuespil; a song Skuespil/Sang/Band, plus Dans when the scene has dancers, `stjerneIsDanceCastRole` copied from `schedule.js`; each shown picker is a placeable part in Øveplan); an empty cell's "+" adds a picker (`stjerneExtra`), and right-click on an added one offers "Fjern". A non-default field with a value above 0 also shows its picker. A value is 0-3, `null` (clicking the selected value unselects it, e.g. a dance not made yet) or missing (never set: shows as 3, `STJERNE_START`); a hidden picker's value is dropped on save. The field helpers are page-scoped copies of `manus.js`'s `manusStar*` ones (which Manus still needs for Gem's save shape); keep them in sync.

- **Access**: boss/admin edit. Below boss the table is read-only (disabled circles/checkboxes, comment as text) and lists nothing until Manus's "Revyster kan se manus" and "Revyster kan se roller" are both on (`stjerneHiddenMessage()`, like Øveplan/Ninjas; cosmetic).
- **Auto-saved per change** (`stjerneAutosave` → `stjerneSave()`, ~0.6 s): rows whose save shape (`stjerneSaveValues()`) differs from the last saved one go to `manus_set_stars` (boss), which sets only the Stjerneark fields plus `priority` = max(Skuespil, Sang), unselected = 0, and `dansRepeat` = `repeat`, on the scenes named by `uid` (`uid || 'id:'+id`) — no read, no merge, last save wins per scene. The result is written to the `manus` override shadow (`stjerneApplyToScene()` ↔ `manus_set_stars()`), so Manus/Øveplan/Ninjas in this browser see it at once. A `missing` uid (scene removed in Manus meanwhile) shows "Genindlæs siden". Scenes placed in Manus but not yet Gem'd aren't in `scenes.json`, so they appear here only after Gem.


## Known issues

- **Layout, to revisit**: the sheet was moved out of its own bordered box into the card, Rekvisitten-style (page scroll, following header, sticky title column), in the site-wide style pass (Nov 2026). Flagged by the maintainer as something to come back to.
