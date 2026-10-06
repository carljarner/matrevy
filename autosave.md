# Auto-save and undo: plan for the rest of the site

Updated Oct 6, 2026 · What's done, what's left, and why

## Status

**Done (Oct 6, 2026).** Four admin editors save on their own through `siteCreateAutosave()` in `js/site-utils.js`. Saves are debounced about 1 s and run one at a time, the editor never re-renders after a save, and the browser warns before you leave with unsaved changes.

- **Kalender → Revyperiode (Gantt)** and **Revyugen**: the "Rediger" button switches to "Færdig". Pressing it waits for the last save, then leaves edit mode. If that save failed, you stay in edit mode.
- **Koordinator → Masterplan** and **Lokalebooking**: always editable, with no Gem button. A status text next to the editor shows Gemmer… / Gemt / Ikke gemt.

**Not started:** everything below.

## Where the site stands

| Save model | Pages |
|---|---|
| Auto-save (live) | Fællesspisning, Bandet, Stregregnskab → Priser, Formularer reordering, signed booking forms, Øveplan (saved only in that browser), **Gantt, Revyugen, Masterplan, Lokalebooking** |
| Gem button (batched draft) | Manus main view + Program, Wiki editor, Bosser, Stregregnskab grid, Budget sheet, Formularer builder |
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
- Manus: until the merge below exists, then possibly auto-save.
- Wiki: prose; tier A covers lost work.
- Formularer builder.
- Kalender and Budget dialogs.
- Arkiv, config and the close-year steps.

## Manus: several people editing different sketches

**This loses work today, even without auto-save.** `manusSaveMain()` (`js/manus.js`) builds the entire `acts` array from `manusDraft`. That draft is built when the page loads and rebuilt only after this tab's own save. `save_manus()` (`server/update-data.php`) then does `$json['acts'] = $scenesActs`.

Example:
1. A and B both open Manus.
2. A changes the roles in 1-3 and presses Gem.
3. B changes the script of 2-1 and presses Gem. B's payload still holds the old 1-3, so A's roles are gone with no warning.

**Fix: a three-way merge per scene before each save.**
1. **Give each scene a stable key.** `id` is positional (`manusRowScene()` sets `${act.code}-${number}`), so it changes when a scene moves in Aktfordeling. Add a permanent `uid` to each scene, carried through `manusRowScene()`. Existing scenes get one on their next save.
2. **Remember the base.** When the draft is built, store a copy of the scenes it came from (`manusDraft.base`).
3. **Merge on Gem.** Fetch the current `/data/scenes.json` and `cast.json` (same origin, `no-cache`). Compare base / mine / theirs for each scene (by `uid`) and each field group: roles (`cast`), script (`scriptBody`), Stjerneark (`priority`/`repeat`/`dansPriority`/`dansRepeat`), and title/metadata.
   - Only I changed a field → take mine.
   - Only they changed it → take theirs.
   - Both changed the same field group of the same scene → a real conflict. Show "X er ændret af en anden — behold min / behold deres".
4. **Aktfordeling (order and act placement) is its own field group.** If only one side moved scenes, take that order. If both did, take mine and say so in a toast. A scene someone else added is kept. A scene they deleted stays deleted.
5. **Cast roster:** the union of names from both versions, with `index` renumbered as `manusBuildCastRoster()` already does.
6. **Close the gap between merge and save** with the sha/409 fix below. On a 409, fetch, merge and retry automatically.

**After the merge exists:** Manus can auto-save with the same merge on every save. Run `manuscripts_sync_selection` only when the "Vælg scener" selection changes. Undo becomes a stack of draft snapshots, and the merge keeps my undo from wiping someone else's edit.

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

1. Manus: stable `uid` + three-way merge + sha check. This fixes data loss that happens today.
2. Undo in Øveplan.
3. Tier A: local draft backup and `beforeunload` on the remaining Gem pages.
4. The sha/409 fix for the other full-array resources.
5. Tier B: per-row actions + auto-save for the Stregregnskab grid (and Masterplan/Lokalebooking if needed), with undo toasts.
