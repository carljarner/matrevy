# Auto-save and undo: plan for the rest of the site

Updated Oct 6, 2026 · What's done, what's left, and why

## Status

**Done (Oct 6, 2026).** Four admin editors save on their own through `siteCreateAutosave()` in `js/site-utils.js`. Saves are debounced about 1 s and run one at a time, the editor never re-renders after a save, and the browser warns before you leave with unsaved changes.

- **Kalender → Revyperiode (Gantt)** and **Revyugen**: the "Rediger" button switches to "Færdig". Pressing it waits for the last save, then leaves edit mode. If that save failed, you stay in edit mode.
- **Koordinator → Masterplan** and **Lokalebooking**: always editable, with no Gem button. A status text next to the editor shows Gemmer… / Gemt / Ikke gemt.

**Manus merge-before-save, plus auto-save for Manus → Stjerneark and Program: done (Oct 6, 2026)**, see the Manus section. **Not started:** the rest below.

## Where the site stands

| Save model | Pages |
|---|---|
| Auto-save (live) | Fællesspisning, Bandet, Stregregnskab → Priser, Formularer reordering, signed booking forms, Øveplan (saved only in that browser), **Gantt, Revyugen, Masterplan, Lokalebooking, Manus → Stjerneark and Program** |
| Gem button (batched draft) | Manus → Scener/Aktfordeling/Rollefordeling/Manus (merged before save, see below), Wiki editor, Bosser, Stregregnskab grid, Budget sheet, Formularer builder |
| A dialog is the commit | Kalender events, Budget approve/expense, Arkiv year editor, posts/comments |

## Pros and cons of auto-save

**Pros**
- No lost work when a tab closes, a phone locks, or someone forgets to press Gem.
- One editing model for the whole site.
- Less UI: no Gem/Annuller buttons and no dirty-state checks.

**Cons, specific to this codebase**
1. **Most resources are saved as a full array.** The page sends the whole file, built from the data it loaded. With auto-save, a stale overwrite can happen on every change instead of once per Gem. Two people editing different rows silently erase each other's work. The pages that already auto-save safely (Fællesspisning, Bandet) use **per-row actions** with a server-side merge.
2. **Half-finished states go live.** Examples: LaTeX mid-edit, half-filled QR rows, Kalender data that is published straight to `/calendar.ics`.
3. **Some saves have side effects.** Manus's `manuscripts_sync_selection` moves files, and every write under `data/` starts an embed run.
4. **Formularer builder:** editing a form that is open would change it under people who are filling it in.
5. **No server-side history** beyond the nightly restic backup. Today Annuller on a draft works as "undo everything".
6. **Re-rendering after a save wipes the browser's own text undo**, so auto-save editors must never re-render on save.

## Remaining tiers

**A. Local draft backup on every Gem page (cheap, do first).** Mirror the draft to `localStorage`. On load, show a banner: "Du har ugemte ændringer — Gendan / Kassér". Add a `beforeunload` warning while the draft is dirty. Implement it as one shared helper in `site-utils.js` (e.g. `siteDraftStore(key)`).

**B. More auto-save (each needs per-row server actions, like `band_upsert_row`):**
- Stregregnskab grid (Priser already auto-saves).
- Bosser (small and rarely edited, so low priority).
- Masterplan and Lokalebooking, if more than one admin will edit them at the same time. Today they still send the whole document, so last save wins.

**C. Keep an explicit Gem:**
- Manus: the merge exists now (below); auto-save is the next step.
- Wiki: prose; tier A covers lost work.
- Formularer builder.
- Kalender and Budget dialogs.
- Arkiv, config and the close-year steps.

## Manus: several people editing at once

**Status (Oct 6, 2026):** merge done. Stjerneark and Program auto-save. Scener, Aktfordeling, Rollefordeling and Manus keep Gem **by decision**: Rollefordeling has its own "Opdater roller" step, the manus text is long-form LaTeX where Gem means "this version is ready", and choosing scenes moves files.

### The problem (before the fix)

Gem sent two full lists, built from the draft the page loaded, and the server wrote them back as-is:
- `scenes.json` → `acts`: every act and every scene. One scene object holds everything about it: title, `types`, roles (`cast`), the manus text (`scriptBody`), Stjerneark (`priority`, `repeat`, `dansPriority`, `dansRepeat`), `duration`, `status`, `melody`, `writtenBy`, `sourcePdf`/`sourceTex`, and its position (`id`/`number`).
- `cast.json` → `cast`: the roster.

So the last save won, and the unit was the whole file. Every case clashed: two people on different scenes, Stjerneark vs. roles, or the manus and the roles of the same scene. Three less obvious paths lost work the same way:
- **"Generér PDF'er" also saved.** It re-sent the tab's copy of `scenes.json`, so a boss who had the page open for an hour and only pressed Generér undid every save since then.
- **The selection sync.** Gem sent `{id, selected}` for *every* pool row. A stale tab sent `selected:false` for a submission someone else had just selected, moving its files back to `submitted/`. And a stale `acts` array dropped a scene someone else had just placed.
- **Fjern in the upload pool** sent the full `manuscripts` list, dropping any submission uploaded after the page loaded.

### What's done

1. **Stable key.** Every scene has a permanent `uid` (`manusSceneUid()`): `sub:<submissionId>` when placed from the pool (so two tabs placing the same submission make one scene), `s<hex>` for a new video/bandsang, `id:<id>` derived for scenes saved before uids existed (every tab derives the same one). `manusRowScene()` writes it.
2. **Base.** `manusInitDraft()` stores the scenes it was built from, in save shape, as `draft._base`.
3. **Merge on Gem** (`manusSaveMain()`): `manus_read` (boss) returns the live `scenes.json`/`cast.json` and their shas; `manusNormalizeFileActs()` puts them through the same row → scene path as the draft, so formatting never looks like an edit. `manusMergeActs()` merges base / mine / theirs per scene and per field group: Roller (`cast`), Manus (`scriptBody`), Stjerneark (`priority`/`repeat`/`dansPriority`/`dansRepeat`), Titel og detaljer (everything else).
   - Only one side changed a group → that side's version.
   - Both changed the same group of the same scene → `manusAskConflicts()`: one "Min version / Deres version" choice per conflict, then Gem (or Annuller).
   - A scene added on one side is kept. A scene removed on one side stays removed, unless the other side edited it since; then the user is asked.
4. **Aktfordeling** (order and act placement) is one more group. A side counts as having moved scenes only if the scenes it shares with base sit differently. If only they moved, theirs is used; if both did, mine, with a toast. A scene missing from the chosen layout goes into its act on the other side, after the scene it followed there.
5. **Cast roster** (`manusMergeCastRoster()`): the live roster plus any name the merged scenes use, `index` renumbered.
6. **sha check.** The save sends `baseScenesSha`/`baseCastSha` from `manus_read`. `save_manus()` checks both before writing either; `update_file()` takes an optional expected sha. On a 409 (`stale`), `siteSaveResource()` returns `conflict: true` and Gem re-reads, re-merges and retries (`MANUS_SAVE_ATTEMPTS`, keeping the user's conflict choices). A save without shas (a tab loaded before the deploy) still works the old way.
7. **Edits during a save survive.** Gem is no longer optimistic: the draft stays editable until the merged result is known. `manusRebaseDraft()` then rebuilds the draft from the saved result and replays edits made in the meantime with the same merge, so they show as unsaved.
8. **Selection sync** sends only pool rows whose selection changed in this tab (`row._baseSelected`). `manuscripts_sync_selection` now patches only the moved records into `manuscripts.json`, not the list it read at the start.
9. **"Generér PDF'er" writes nothing**: `manus_regenerate_pdfs` (boss) just touches `.regen-pdfs-requested`. Unsaved edits aren't included, and the toast says so.
10. **Fjern** uses `manuscripts_remove` (boss, one id). The full-array `manuscripts` resource is now admin-only (only Koordinator's "Afslut revyen" uses it).
11. The tex backfill (`manusImportFromTex()`) folds its values into `draft._base` as well as the dirty baseline, so a backfill never counts as "my change".

### Auto-save: Stjerneark and Program (done)

- **Stjerneark** saves each click on its own (`manus_set_stars`: only the four Stjerneark fields of the named scenes, by `uid`). No read, no merge: last click wins per scene, and it can't touch anyone's other edits. The saved values go into `draft._base`, so a later Gem doesn't count them as changes, and the Gem status ignores star fields of saved scenes. A scene that isn't saved yet keeps its stars for the next Gem. Gem saves pending stars first; star saves wait while Gem runs.
- **Program** uses `siteCreateAutosave()` with an optimistic sha: the save sends the sha it last saw (`save_program` returns the new one), so normally it's one request with no read. On a 409 it reads (`program_read`), merges per section (Medvirkende / Ordliste / QR-koder) and retries. Both sides changing the same section shows a banner in that section ("Behold min" / "Brug deres"); the other sections keep saving. A QR row saves once it has a label.
- Both show their own status line at the top of the tab. "Generér PDF'er" saves both first.

### Still open

- **Auto-save for the Gem tabs**, if ever wanted: the same read → merge → save from `siteCreateAutosave()`, with the conflict dialog turned into a banner. Undo would then be a stack of draft snapshots.
- **Merge granularity is per field group.** Two people editing *different lines* of the same scene's manus text still conflict. Fine for now; a line-level merge of `scriptBody` is possible later.
- **Pool rows changed during a save** keep their live state, but a pool row placed into an act *during* a save becomes an ordinary scene without its files being moved. Edge case; auto-save shrinks the window further.
- **Close-year** (`koordinator.js`) still sends `manus`/`manuscripts` without a sha. Intentional: it's a reset.

## The sha/409 fix (all full-array resources)

The browser never sends which version it loaded, so the 409 only catches two saves that land at exactly the same moment. The fix:

1. Every save sends the `sha` of the data the page was built from (embedded, or from a cheap read action).
2. `update_file()` compares it with the file's current sha and returns 409 on a mismatch.
3. The page shows "Nogen andre har ændret dette — genindlæs" (or merges, as in Manus above).

The save response should return the new sha, so a page that auto-saves can keep going.

## Undo (Ctrl+Z)

Undo doesn't depend on auto-save. Batched drafts are actually the easiest place for it: keep a stack of draft snapshots.

**Good fits**
- **Øveplan:** one `state` object, saved only in that browser, with no concurrency. Push a snapshot in `saveState()`. This guards against drag mistakes, swaps, merged/split slots and "Ryd skema". Highest value for the least work, so do it first.
- **Drafts:** Gantt, Revyugen, Masterplan, Lokalebooking and Manus Aktfordeling. Push a snapshot before each change; with auto-save, undo is just "restore the snapshot + `schedule()`".
- **Live per-row pages** (Fællesspisning, Bandet cells and reordering): use *inverse operations*, not snapshots, so an undo never overwrites a later edit by someone else. For example, undo a deleted row by recreating it with the same data.

**Not possible without soft-delete or server history:** file deletions (Bandet files, receipts, `manuscripts_delete`), Budget approval (assigns bilag numbers), Afslut revyen / Start ny revy, PDF generation, append-only posts/comments, form submissions.

**UX**
- Leave Ctrl+Z to the browser when focus is in an `<input>`/`<textarea>`/`contenteditable`, so text undo keeps working. Intercept it only outside text fields.
- Ctrl+Z is invisible on a phone, so pair it with a toast that has a "Fortryd" button after deletes and drags. That toast can replace many of the "Er du sikker?" confirms.
- Shared helper `siteUndo.push({label, undo, redo})` in `site-utils.js`, plus a copy in `schedule.js` (Øveplan doesn't load `site-utils.js`).

## Suggested order

1. ~~Manus: stable `uid` + three-way merge + sha check.~~ Done Oct 6, 2026. Stjerneark and Program auto-save too.
2. Undo in Øveplan.
3. Tier A: local draft backup and `beforeunload` on the remaining Gem pages.
4. The sha/409 fix for the other full-array resources.
5. Tier B: per-row actions + auto-save for the Stregregnskab grid (and Masterplan/Lokalebooking if needed), with undo toasts.
