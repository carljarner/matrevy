# Auto-save and undo: plan for the rest of the site

Updated Oct 6, 2026 · What's done, what's left, and why

## Status

**Done (Oct 6, 2026)**
- **Four admin editors auto-save** through `siteCreateAutosave()` in `js/site-utils.js`. Saves are debounced about 1 s and run one at a time, the editor never re-renders after a save, and the browser warns before you leave with unsaved changes.
  - **Kalender → Revyperiode (Gantt)** and **Revyugen**: the "Rediger" button switches to "Færdig". Pressing it waits for the last save, then leaves edit mode. If that save failed, you stay in edit mode.
  - **Koordinator → Masterplan** and **Lokalebooking**: always editable, with no Gem button. A status text next to the editor shows Gemmer… / Gemt / Ikke gemt.
- **Manus merges before saving** (commit `9c26005`), so several people can edit at once without overwriting each other. **Stjerneark and Program auto-save.** See the Manus section.
- **Undo in Øveplan**: Ctrl/Cmd+Z (no buttons, by decision), snapshots taken in `saveState()`.
- **Stregregnskab grid auto-saves per row** (`streg_upsert_row`/`streg_delete_row`), no Gem button.
- **Tier A for Manus**: the Gem tabs' draft is backed up in `localStorage` (`siteDraftBackup()` in `site-utils.js`) and offered back on load.

- **Kalender, Posts and Wiki no longer overwrite others' saves**: each save reads the live list, applies its one change and saves with a sha check (`siteSaveListResource()`).
- **Masterplan and Lokalebooking merge on save** (three-way, per row/cell), so an old tab never undoes newer edits.

**Not started:** tier A for the other Gem pages, Bosser auto-save, the sha/409 check for the admin full-array resources, and undo outside Øveplan.

## Where the site stands

| Save model | Pages |
|---|---|
| Auto-save (live) | Fællesspisning, Bandet, Stregregnskab (grid and Priser), Formularer reordering, signed booking forms, Øveplan (saved only in that browser), Gantt, Revyugen, Masterplan, Lokalebooking, **Manus → Stjerneark and Program** |
| Gem button (batched draft) | **Manus → Scener / Aktfordeling / Rollefordeling / Manus** (merged before save, backed up locally), Wiki editor, Bosser, Budget sheet, Formularer builder |
| A dialog is the commit | Kalender events, Budget approve/expense, Arkiv year editor, posts/comments |

**Protected against stale overwrites:** Manus (merge + sha check), Program (sha check + merge), Kalender/Posts/Wiki (read → apply one change → sha check), Masterplan/Lokalebooking (read → merge → sha check), Stjerneark and the per-row pages (Fællesspisning, Bandet, the Stregregnskab grid; they change one row at a time). **Still last save wins:** Gantt and Revyugen (by decision) and the rarely edited admin resources (Arkiv, Bosser, config).

## Pros and cons of auto-save

**Pros**
- No lost work when a tab closes, a phone locks, or someone forgets to press Gem.
- One editing model for the whole site.
- Less UI: no Gem/Annuller buttons and no dirty-state checks.

**Cons, specific to this codebase**
1. **Most resources are saved as a full array.** The page sends the whole file, built from the data it loaded. With auto-save, a stale overwrite can happen on every change instead of once per Gem. Two people editing different rows silently erase each other's work. The fix is either per-row actions (Fællesspisning, Bandet, Stjerneark) or a sha check plus merge (Manus, Program).
2. **Half-finished states go live.** Examples: LaTeX mid-edit, Kalender data that is published straight to `/calendar.ics`. Program avoids it: `program.json` is only used when "Generér PDF'er" is pressed, and an unfinished QR row isn't saved until it has a label.
3. **Some saves have side effects.** Choosing scenes in Manus moves files (`manuscripts_sync_selection`, now only for selections changed in that tab), and every write under `data/` starts an embed run.
4. **Formularer builder:** editing a form that is open would change it under people who are filling it in.
5. **No server-side history** beyond the nightly restic backup. Today Annuller on a draft works as "undo everything".
6. **Re-rendering after a save wipes the browser's own text undo**, so auto-save editors must never re-render on save.

## Remaining tiers

**A. Local draft backup on every Gem page.** Mirror the draft to `localStorage`; on load, offer it back in a banner (Gendan / Kassér). **Done for Manus** with the shared `siteDraftBackup(name)` helper in `site-utils.js` (see the Manus section). Manus, Formularer and Budget already warn before leaving with unsaved changes. Left: Wiki, Bosser, Formularer builder, Budget sheet — each needs a draft it can rebuild from JSON plus a banner. A restored draft must be safe against data saved since: Manus gets that from its merge; the others don't have one yet (see the sha/409 fix).

**B. More auto-save.** Two proven patterns now exist: per-row server actions (like `band_upsert_row`, `manus_set_stars`), or Program's sha check + per-section merge (see below).
- ~~Stregregnskab grid: per-row actions.~~ Done: `streg_upsert_row` (only the changed field; `counts` merge per key) and `streg_delete_row`, commits chained per row. No undo toasts yet.
- Bosser (small and rarely edited, so low priority).
- Masterplan and Lokalebooking already auto-save but still send the whole document, so last save wins. If more than one admin edits them at once, add the sha check + merge.

**C. Keep an explicit Gem:**
- Manus → Scener, Aktfordeling, Rollefordeling and Manus, **by decision**: Rollefordeling has its own "Opdater roller" step, the manus text is long-form LaTeX where Gem means "this version is ready", and choosing scenes moves files. They're merged before save, so concurrent editing is safe.
- Wiki: prose; tier A covers lost work.
- Formularer builder.
- Kalender and Budget dialogs.
- Arkiv, config and the close-year steps.

## Manus: several people editing at once

**Status (Oct 6, 2026):** merge done. Stjerneark and Program auto-save. The other tabs keep Gem by decision (tier C). Deployed in commit `9c26005`. A Manus tab opened before the deploy still saves the old last-save-wins way until it's reloaded.

### The problem (before the fix)

Gem sent two full lists, built from the draft the page loaded, and the server wrote them back as-is:
- `scenes.json` → `acts`: every act and every scene. One scene object holds everything about it: title, `types`, roles (`cast`), the manus text (`scriptBody`), Stjerneark (`priority`, `repeat`, `dansPriority`, `dansRepeat`), `duration`, `status`, `melody`, `writtenBy`, `sourcePdf`/`sourceTex`, and its position (`id`/`number`).
- `cast.json` → `cast`: the roster.

So the last save won, and the unit was the whole file. Every case clashed: two people on different scenes, Stjerneark vs. roles, or the manus and the roles of the same scene. Three less obvious paths lost work the same way:
- **"Generér PDF'er" also saved.** It re-sent the tab's copy of `scenes.json`, so a boss who had the page open for an hour and only pressed Generér undid every save since then.
- **The selection sync.** Gem sent `{id, selected}` for *every* pool row. A stale tab sent `selected:false` for a submission someone else had just selected, moving its files back to `submitted/`. And a stale `acts` array dropped a scene someone else had just placed.
- **Fjern in the upload pool** sent the full `manuscripts` list, dropping any submission uploaded after the page loaded.

### Merge before save (done)

1. **Stable key.** Every scene has a permanent `uid` (`manusSceneUid()`): `sub:<submissionId>` when placed from the pool (so two tabs placing the same submission make one scene), `s<hex>` for a new video/bandsang, `id:<id>` derived for scenes saved before uids existed (every tab derives the same one). `manusRowScene()` writes it.
2. **Base.** `manusInitDraft()` stores the scenes it was built from, in save shape, as `draft._base`.
3. **Merge on Gem** (`manusSaveMain()`): `manus_read` (boss) returns the live `scenes.json`/`cast.json` and their shas; `manusNormalizeFileActs()` puts them through the same row → scene path as the draft, so formatting never looks like an edit. `manusMergeActs()` merges base / mine / theirs per scene and per field group: Roller (`cast`), Manus (`scriptBody`), Stjerneark (`priority`/`repeat`/`dansPriority`/`dansRepeat`), Titel og detaljer (everything else).
   - Only one side changed a group → that side's version.
   - Both changed the same group of the same scene → `manusAskConflicts()`: one "Min version / Deres version" choice per conflict, then Gem (or Annuller).
   - A scene added on one side is kept. A scene removed on one side stays removed, unless the other side edited it since; then the user is asked.
4. **Aktfordeling** (order and act placement) is one more group. A side counts as having moved scenes only if the scenes it shares with base sit differently. If only they moved, theirs is used; if both did, mine, with a toast. A scene missing from the chosen layout goes into its act on the other side, after the scene it followed there.
5. **Cast roster** (`manusMergeCastRoster()`): the live roster plus any name the merged scenes use, `index` renumbered.
6. **sha check.** The save sends `baseScenesSha`/`baseCastSha` from `manus_read`. `save_manus()` checks both before writing either. On a 409 (`stale`), Gem re-reads, re-merges and retries (`MANUS_SAVE_ATTEMPTS`, keeping the user's conflict choices). A save without shas still works the old way.
7. **Edits during a save survive.** Gem is not optimistic: the draft stays editable until the merged result is known. `manusRebaseDraft()` then rebuilds the draft from the saved result and replays edits made in the meantime with the same merge, so they show as unsaved.
8. **Selection sync** sends only pool rows whose selection changed in this tab (`row._baseSelected`). `manuscripts_sync_selection` patches only the moved records into `manuscripts.json`, not the list it read at the start.
9. **"Generér PDF'er" writes no data**: `manus_regenerate_pdfs` (boss) just touches `.regen-pdfs-requested`, after saving any pending Stjerneark/Program edits. Unsaved Gem edits aren't included, and the toast says so.
10. **Fjern** uses `manuscripts_remove` (boss, one id). The full-array `manuscripts` resource is admin-only (only Koordinator's "Afslut revyen" uses it).
11. The tex backfill (`manusImportFromTex()`) folds its values into `draft._base` as well as the dirty baseline, so a backfill never counts as "my change".

### Auto-save: Stjerneark and Program (done)

- **Stjerneark** saves each click on its own, about 0.6 s later (`manus_set_stars`: only the four Stjerneark fields of the named scenes, by `uid`). No read, no merge: last click wins per scene, and it can't touch anyone's other edits. The saved values go into `draft._base`, so a later Gem doesn't count them as changes, and the Gem status ignores star fields of saved scenes. A scene that isn't saved yet keeps its stars for the next Gem. Gem saves pending stars first; star saves wait while Gem runs.
- **Program** uses `siteCreateAutosave()` with an optimistic sha: the save sends the sha it last saw (`save_program` returns the new one), so normally it's one request with no read. On a 409 it reads (`program_read`), merges per section (Medvirkende / Ordliste / QR-koder) and retries. A section only the other person changed is pulled into the screen. Both changing the same section shows a banner in that section ("Behold min" / "Brug deres"); the other sections keep saving. A QR row saves once it has a label.
- Both show their own status line at the top of the tab ("Gemmer…" / "Gemmes automatisk · Gemt" / the error).

### Local draft backup (done)

While the Gem tabs are dirty, the whole draft (including `_base`) is written to `localStorage['matrevy-draft-manus']` on the same 500 ms poll as the Gemt/Ikke gemt status; once clean, this tab's backup is removed (never another tab's). On load, a backup for the current production is offered in a banner above the tabs. **Gendan** makes it the draft as it was — the same as a tab that had been left open — so Gem's merge (base = the backup's `_base`) folds in anything saved since and asks only on real conflicts. Row keys are re-minted, pool rows get the server's current submission, and submissions uploaded since are added. **Kassér** deletes it. While the banner is open nothing is written, so the offer can't be overwritten.

### Still open

- **Live updates while the page is open.** Partly covered since Oct 6, 2026 by the site-wide stale-page banner (`site.js`): a tab that comes back into view, or every 15 min, notices that its data or the site's code changed and offers "Genindlæs". Today a Manus tab still only merges others' saves in when it saves. Option: a tiny version check (only the shas, ~100 bytes) every 15–30 s while the tab is visible; when it changes, fetch once and merge others' changes into the draft. Fewer conflicts, and you see others' edits without reloading.
- **Auto-save for the Gem tabs**, if ever wanted: the same read → merge → save from `siteCreateAutosave()`, with the conflict dialog turned into a banner. Undo would then be a stack of draft snapshots.
- **Merge granularity is per field group.** Two people editing *different lines* of the same scene's manus text still conflict. Fine for now; a line-level merge of `scriptBody` is possible later.
- **Pool rows changed during a save** keep their live state, but a pool row placed into an act *during* a save becomes an ordinary scene without its files being moved. Edge case.
- **Close-year** (`koordinator.js`) still sends `manus`/`manuscripts` without a sha. Intentional: it's a reset.

## The sha/409 fix (remaining full-array resources)

The browser never sends which version it loaded, so for most resources the 409 only catches two saves that land at exactly the same moment.

**The building blocks exist now** (from the Manus/Program work):
- `update_file($path, $mutate, $message, $expectedSha)` answers 409 `stale` when the file's sha differs, and returns the new sha.
- `siteSaveResource()` returns `conflict: true` on a 409 and `data` (the server's reply) on success.
- Done for `manus` (`baseScenesSha`/`baseCastSha`) and `program` (`baseSha`, reply carries `sha`).
- **Done for `calendar`, `posts`, `wiki` (Oct 6, 2026)**: every save there changes one item, so `siteSaveListResource()` in `site-utils.js` reads the live file + sha (`resource_read`, boss), applies just that change to the live list, and saves with `baseSha`, re-reading on a 409. No merge dialog needed. Editing something someone else deleted shows an error; Wiki's chapter editor asks "Overskriv?" if the chapter was saved by someone else since editing started; Posts' edit keeps live pin/comments; "Rediger kapitler" applies only its own changes.

- **Done for `masterplan` and `lokaler` (Oct 6, 2026)**: each auto-save reads the live file, three-way merges per row/field (Lokalebooking: per room × date cell) against what the tab last knew, and saves with `baseSha`. Someone else's changes are pulled into the open editor; the same field changed on both sides → this tab's version, with a toast. See "Merge on save" in `koordinator.js`.
- **Gantt and Revyugen: left as last save wins, by decision** (almost never edited).

**If ever needed for the rest** (`archive`, `bosses`, `config`):
1. The save handler accepts an optional `baseSha`, passes it to `update_file()` and responds with the new `sha`.
2. The page gets the sha it started from: a cheap read action (like `program_read`), or the reply of its own last save.
3. On a 409: either show "Nogen andre har ændret dette — genindlæs", or merge like Program does (re-read, merge per section/row, retry). The merge is worth it for the auto-saving editors (Gantt, Revyugen, Masterplan, Lokalebooking).

## Undo (Ctrl+Z)

Undo doesn't depend on auto-save. Batched drafts are actually the easiest place for it: keep a stack of draft snapshots.

**Good fits**
- ~~**Øveplan:**~~ Done. `saveState()` records the previous whole-state snapshot when the state changed (`schedUndoRecord()`); undo/redo swap snapshots and re-render. In memory only (20 steps, reset on load). Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y outside text fields and modals; no on-screen buttons, by decision (so not available on a phone). The snapshot includes the day-setup fields, so undoing a "Byg øveplan" restores its times and rooms too.
- **Drafts:** Gantt, Revyugen, Masterplan, Lokalebooking and Manus Aktfordeling. Push a snapshot before each change; with auto-save, undo is just "restore the snapshot + `schedule()`". For Manus, the merge keeps an undo from wiping someone else's edit.
- **Live per-row pages** (Fællesspisning, Bandet cells and reordering, Stjerneark clicks): use *inverse operations*, not snapshots, so an undo never overwrites a later edit by someone else. For example, undo a deleted row by recreating it with the same data.

**Not possible without soft-delete or server history:** file deletions (Bandet files, receipts, `manuscripts_delete`), Budget approval (assigns bilag numbers), Afslut revyen / Start ny revy, PDF generation, append-only posts/comments, form submissions.

**UX**
- Leave Ctrl+Z to the browser when focus is in an `<input>`/`<textarea>`/`contenteditable`, so text undo keeps working. Intercept it only outside text fields.
- Ctrl+Z is invisible on a phone, so pair it with a toast that has a "Fortryd" button after deletes and drags. That toast can replace many of the "Er du sikker?" confirms.
- Shared helper `siteUndo.push({label, undo, redo})` in `site-utils.js` for the other pages (Øveplan has its own snapshot stack in `schedule.js`).

## Suggested order

1. ~~Manus: stable `uid` + three-way merge + sha check, Stjerneark and Program auto-save.~~ Done Oct 6, 2026.
2. ~~Undo in Øveplan.~~ Done Oct 6, 2026.
3. Tier A: ~~Manus~~ (done Oct 6, 2026); the remaining Gem pages.
4. ~~The sha/409 fix: Kalender, Posts, Wiki, Masterplan, Lokalebooking~~ (done Oct 6, 2026). Gantt/Revyugen skipped by decision.
5. Tier B: ~~Stregregnskab grid per-row auto-save~~ (done Oct 6, 2026); undo toasts there and on the other per-row pages.
6. Optional: live version polling for Manus (see "Still open").
