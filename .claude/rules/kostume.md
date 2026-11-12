---
paths:
  - "kostumetinder.html"
  - "js/kostume.js"
  - "css/kostume.css"
---

# Kostumetinder (`kostumetinder.html`/`kostume.js`/`kostume.css`) — costume sheet

A Sangoversigt-style sheet (a page-scoped copy of Bandet's sheet code, no sections) where revyster note what costume item they need and who has it. Revyst-level page under Redskaber. Private data (names) in `KOSTUME_DATA_DIR` (`/data/kostumetinder`): `<folder>/kostumer.json` = `{rows, columnLabels, columnWidths, customColumns, hiddenColumns, updatedAt}`, one sheet per revy. Online-only.

- **Per revy, with a picker** like Rekvisitten's (`kostumeRevyOptions()`: Arkiv years + the current production, choice in `matrevy-kostume-revy`, default the current production). Every action takes `folder` (validated by `rekvisit_folder_from_body()` at dispatch); reads work on any revy, but **writes below boss only reach the current production** (`403 read_only`; `kostumeCanEdit()` mirrors it and renders an older year read-only: plain titles, no handle/✕/"+"/resize, disabled status pills, "Tidligere år kan kun redigeres af bosser" top-left).

- **Rows** `{id, jegMangler, scene, navn, jegHarDet, note, status, …custom keys}`. Default columns Jeg mangler / Sang/sketch / Navn / Jeg har det / Note (free text) + a rightmost **Status** toggle (`kostumeStatusToggle`, click to cycle Søger → Lånt → Returneret, stored `''`/`laant`/`returneret`, `''` = Søger by default; `KOSTUME_STATUSES` ↔ `kostume_status_values()`; custom columns are inserted before it). A sheet without a document reads as **10 blank rows** with deterministic ids (`kostume_default_id()`, like `band_default_id()`), so a default row can be edited/moved before anything is written. The **topmost row without Jeg mangler, Sang/sketch and Navn all filled in** (`KOSTUME_HINT_REQUIRED`) shows example placeholders per built-in column ("Det du skal bruge" / "Til hvilken scene" / "Dit eget navn" / "Navn på dig, der har det"); `kostumeRefreshHints()` re-checks on each keystroke, so they move to the next row once those three are filled and back up when one is cleared.
- **Columns** like Bandet: rename in place (`columnLabels`), drag-resize (`columnWidths`), remove by clearing a title + Backspace (built-in → hidden, custom → deleted with its values), "+" in the header adds a custom column (**text only**) or brings a hidden one back. `jegMangler` can't be removed (`kostume_locked_column()`).
- **Live writes** like Bandet: cells commit on blur (`row._inFlight`), drag-reorder (handle only, `kostumeGetDragImageEl`, `.kostume-drop-tail-row`) on drop, ✕ deletes (confirms only when the row has content), centered "+" under the sheet adds a draft row at the end.
- **Server actions** (`$KOSTUME_ACTIONS`, all revyst + the folder rule): `kostume_read`, `kostume_upsert_row`, `kostume_delete_row` (idempotent), `kostume_reorder` (permutation or `409 stale_rows`), `kostume_save_columns`, `kostume_save_column_labels`, `kostume_save_column_widths`. `kostume_mutate()` = flock'd copy of `band_mutate()`; hoisted functions, no consts (dispatched early).

