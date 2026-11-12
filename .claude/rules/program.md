---
paths:
  - "program.html"
  - "js/program.js"
  - "css/program.css"
---

# Program (`program.html`/`program.js`/`program.css`, Redskaber) — scratch copy of Medvirkende/Ordliste

A revyst-level page under Redskaber with two raw-text boxes, **Medvirkende** and **Ordliste**, in the same look as Manus's Program tab (no QR section). Bosses paste the current lists in, revyster add to them, and bosses copy the wanted changes back into Manus → Program **by hand**. **Coupled to nothing, by decision**: never filled from `program.json`, never read by `generate-pdfs.js`, not touched by Koordinator's Afslut revyen. Empty until someone types.

- **Naming**: page/URL `program` (prefix `prog`, `.prog-` CSS), but everything server-side is **`programkladde`** so it can't be mixed up with Manus's `program` resource/`program_read`.
- **Store**: private `PROGRAMKLADDE_DATA_DIR` (`/data/programkladde/programkladde.json` = `{medvirkende, ordliste, updatedAt}`, created on the first save, in the nightly backup). Revyst actions in `$PROGRAMKLADDE_ACTIONS` (hoisted functions): `programkladde_read` → `{medvirkende, ordliste, sha}` (`sha` = sha1 of the file bytes, `null` with no file) and `programkladde_save {medvirkende, ordliste, baseSha}` (each ≤ 50 000 chars, `programkladde_max_chars()` ↔ `PROG_MAX_CHARS`; `baseSha` is **required**, a mismatch is 409 `stale`; returns the new `sha`). Values are stored verbatim (not trimmed) so draft and base never drift. `progApi()` never prompts for a password (stored login only), since the refresh timer calls it.
- **Auto-saved** (`progAutosave` → `progSaveNow()`, status line "Gemmer…" / "Gemmes automatisk · Gemt" / "Ikke gemt: …"). Each save sends the sha it built on; a 409 re-reads, merges and retries (3 attempts).
- **Line merge** (`progMerge3(base, mine, theirs)` → `{text, overlap}`, `progDiffHunks()` = LCS on lines between the common prefix/suffix, one hunk past `PROG_DIFF_MAX_CELLS`): changes on different lines both apply; lines both sides added at the same spot (both appending at the end) are all kept, theirs first; only where both changed the same base lines is it an `overlap`: theirs' version, then mine's lines not in theirs (nothing lost; a deletion loses to an edit), with a toast. `progAbsorb()` merges a server version into the draft per field (only fields that changed since `progBase`) and writes the box through `progSetFieldValue()`, which keeps the caret/selection and scroll position (mapped through the common prefix/suffix).
- **Refresh**: `progRefresh()` every 15 s while the tab is visible and on `visibilitychange`, so people see each other's additions. Skipped while a save is pending or running; dropped if a save started while the read was out (`progSaveGen`). If the draft still differs from the server copy afterwards (an earlier save failed), it schedules a save.
