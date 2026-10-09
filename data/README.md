# data/

Schemas for the site's public data files.

**The live files are on the server**, in `/srv/matrevy/data/site/data/` on web-1, not in this repo folder (the repo copies are stale snapshots from Oct 2, 2026 until the cleanup in `plans/migration-guide.md` untracks them). They're edited through the site's own tools (Manus, Kalender, Forside, Wiki, Koordinator, …), which save through `server/update-data.php`. The worker container regenerates the embedded `js/*-data.js` files a couple of seconds after every save (see CLAUDE.md → Hosting & data flow). After a hand edit on the server, trigger the same with `touch /srv/matrevy/data/site/.embed-requested`. Locally, run `node scripts/embed-scenes.js`.

## Files

| File | Purpose |
|------|---------|
| `scenes.json` | All scenes for the current production, with cast per scene |
| `cast.json` | Full cast list and role type legend |
| `calendar.json` | Events shown on the Kalender page |
| `archive.json` | Previous years' manus/videos shown on the Arkiv page |
| `posts.json` | Post board with a boss/admin-pinnable column, shown on Forside |
| `bosses.json` | The static "Bosser for ..." info card on Forside |
| `wiki.json` | Flat list of rich-text chapters shown on the Wiki page |
| `manuscripts.json` | Upload pool of submitted sketch/song `.pdf`/`.tex` pairs, shown on the Manus page |
| `config.json` | Small site-wide settings: the active production folder and three revyst toggles |
| `program.json` | Medvirkende/Ordliste/QR-codes content for the printed programme booklet, edited on the Manus page's Program tab and rendered into three layouts, `archive/<folder>/Program.pdf`, `ProgramHaefte.pdf`, and `ProgramHaefteHorisontal.pdf` |
| `masterplan.json` | Koordinator page's "Masterplan" checklist — recurring production to-dos across 5 fixed phase-tabs, replacing an externally-maintained spreadsheet |
| `lokaler.json` | Koordinator page's "Lokaler & Fravær" tab — room bookings per rehearsal day (Lokalebooking) plus one-off bookings, replacing the yearly Lokalebooking spreadsheet |
| `gantt.json` | Gantt chart of the revy period (September–November) shown below the calendar on Kalender |
| `revyugen.json` | Hour-by-hour week schedule of the revy's final nine days ("Revyugen"), shown below the Gantt chart on Kalender |

## Updating for a New Production

Normally done from **Koordinator → Arkivering** ("Afslut revyen", then "Start ny revy"), which resets `scenes.json`, `cast.json` and `manuscripts.json` and sets `config.json`. Scenes then come in through Manus's upload pool and Main Manus View. The notes below describe the fields if you ever edit by hand.

1. **`scenes.json`** — the `acts` array holds the production's scenes.
   - Set `schedulable: false` for videos, band jingles, and anything else with no rehearsable cast.
   - `priority` (0-3) is set on the Manus page's Stjerneark tab. Øveplan shows it read-only as a badge; there's no separate per-rehearsal priority any more.
   - The `id` field must be unique (format: `"act-number"`, e.g. `"1-3"` or `"E-2"`).
   - `types` is optional but recommended: an array from `sketch`/`sang`/`dans`/`bandsang`/`video`. It drives role classification (Sang/Rap vs. Skuespil, etc. — see `CLAUDE.md`) and video/bandsang handling. The dance/actor split no longer depends on `types`: Øveplan splits any scene where a cast member is tagged Dans or Koreograf into two independently-schedulable halves.
   - `uid` (string) is the scene's permanent key, used by Manus's merge-before-save. Unlike `id` it never changes when a scene moves. Formats: `sub:<submissionId>` for a scene placed from the upload pool, `s<hex>` for a video/bandsang, `id:<id at the time>` for a scene saved before uids existed. Omit it when hand-adding a scene; Manus derives one (`id:<id>`) and saves it.
   - `duration` (optional, minutes) defaults from the submission's `\eta{}` and is edited in Manus's Vælg scener. `sourcePdf`/`sourceTex` (optional) point at the originating submission's files under `archive/<folder>/{submitted,sketches,songs}/`; `generate-pdfs.js` overwrites `sourceTex` with the composed scene on every regeneration. `dansPriority` (optional int 0-3) holds the "(Dans)" half's priority for a dance-split scene, set by Stjerneark. `repeat`/`dansRepeat` (optional booleans) mark a scene (or its dance half) that wants a second rehearsal, also from Stjerneark. All are safe to omit on hand-edited/legacy scenes.

2. **`cast.json`** — Replace the `cast` array with the new cast list.
   - Keep the `index` values sequential starting from 0 (Manus rebuilds them on every save).

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
          "dansPriority": null,
          "repeat": false,
          "dansRepeat": null,
          "duration": 3,
          "sourcePdf": "archive/MatRevy_2026/sketches/Scene_name.pdf",
          "sourceTex": "archive/MatRevy_2026/sketches/Scene_name.tex",
          "cast": [
            {
              "name": "Cast member name",
              "role": "Sang/Rap",
              "roleCode": "S1",
              "description": "Sanger",
              "tags": ["Sang/Rap"]
            }
          ],
          "scriptBody": "\\says{S1} A line of dialogue",
          "status": "Færdig",
          "melody": "Thor Farlov: \"Hej\"",
          "writtenBy": "Christian '24, Louie '24",
          "sourceProduction": "Matematikrevyen",
          "sourceYear": "2013"
        }
      ]
    }
  ]
}
```

`scriptBody`/`status`/`melody`/`writtenBy`/`sourceProduction`/`sourceYear` (all optional
strings, added Phase 4.4) and each cast entry's `roleCode`/`description`/`tags` (also optional,
same phase) are written by the Manus page's Main Manus View, and consumed only by
`scripts/generate-pdfs.js` (see CLAUDE.md's Manus section) — nothing else reads them.
`roleCode`/`description` hold the real per-person code (e.g. `"S1"`) and free-text explanation
from a `.tex` file's own `\role{<code>}[<name>] <description>` line — `roleCode` is what the
scene's `scriptBody` actually references in `\says{}`/`\sings{}`, and `scripts/generate-pdfs.js`
prefers it over auto-generating one whenever it's present. `tags` (an array of zero or more
`ROLE_CATEGORIES` values, e.g. `["Dans", "Koreograf"]` for someone who's both) is edited
directly in Rollefordeling's roles summary — see CLAUDE.md — as small add/removable tag chips,
not a single-choice dropdown; `role` stays a **single** string (`tags[0]` if any tag is set,
else `""`) since that's still what `schedule.js`'s own classification helpers everywhere else on
the site expect. `scriptBody` is the scene's actual LaTeX body (dialogue/lyrics/stage
directions — everything between `\begin{sketch}`/`\begin{song}` and its `\end{...}`); `melody`
is only meaningful for a `sang`-type scene (maps to `\melody{}`); `sourceProduction`/
`sourceYear` default to the current production when empty (a reused classic sketch is the one
case where they'd differ, e.g. `"MatematikRevyen 2013"` on a scene reused years later). `name`
may itself contain raw LaTeX (e.g. `"$\chi$-faktor"`) — it's rendered as-is (plain text) in the
webview and inserted unescaped, verbatim, into every generated `.tex` file by
`scripts/generate-pdfs.js`, exactly like `scriptBody`/`writtenBy`/`melody`; it's edited the same
way, via the Manus tab's title/author/melody header field (see CLAUDE.md's Manus section).

## Schema: cast.json

```json
{
  "cast": [
    { "name": "Adam", "index": 0 }
  ]
}
```

## Schema: calendar.json

```json
{
  "events": [
    {
      "id": "m3k2j1",
      "date": "2026-01-15",
      "endDate": "2026-01-15",
      "start": "19:00",
      "end": "22:00",
      "title": "Fællesøve",
      "category": "ove",
      "location": "Lokale 4",
      "note": "Medbring manus"
    }
  ]
}
```

- `endDate` — `YYYY-MM-DD`, `>= date`; equal to `date` for a single-day event, later for a multi-day one (e.g. a weekend rehearsal camp).
- `start`/`end` — `"HH:MM"` or `""` (all-day).
- `category` — ASCII key from `manus` / `ove` / `forestilling` / `deadline` / `andet`; the Danish labels and colors live in `calendar.js`'s `CAL_CATEGORIES` (and are duplicated in `scripts/embed-scenes.js`'s `.ics` builder for the feed's `CATEGORIES` field).
- `location` — optional string, shown as "Lokale" in the editor/detail view and as a `LOCATION:` line in the `.ics` feed; not server-validated (like Manus's optional scene fields), safe to omit on legacy events.

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
      "spotifyUrl": "https://open.spotify.com/album/...",
      "driveUrl": "https://drive.google.com/drive/folders/...",
      "manusPdf": "archive/MatRevy_2024/manus.pdf"
    }
  ]
}
```

- `year` — integer; auto-detected from `name` when creating a new entry (still editable); the archive page sorts newest first. **Not required to be unique** — e.g. a jubilee revy can share the year of a regular one; `folder` is the sole unique key.
- `name` — required free-text display name, e.g. `"MatRevy 2024"`.
- `folder` — the repo-relative folder slug (`archive/<folder>/...`), derived once from `name` when the entry is created (spaces → `_`, Danish `æøå` transliterated, everything else stripped) and **never recomputed** — editing `name` later must not change `folder`, or every already-uploaded file would orphan. Also the source for the overlay's **GitHub** button (`github.com/carljarner/matrevy/tree/main/archive/<folder>`) — derived in `archive.js`, not stored.
- `coverImage`/`manusPdf` — repo-relative paths (`archive/<folder>/cover.jpg` / `archive/<folder>/manus.pdf`) or `""`. **Uploaded directly through Koordinator's Arkiv editor** (no manual git step) — the browser reads the file, the site's PHP endpoint (`server/update-data.php`'s `upload` action) commits it to the repo via the GitHub Contents API. Cover photos are always re-encoded to JPEG client-side (canvas-resized, max ~1600px wide) before upload, so the filename/extension never changes across re-uploads.
- `youtubeUrl` / `spotifyUrl` / `driveUrl` — optional external links (or `""`); each renders a matching link pill on the detail overlay. All three are validated against a host regex in `save_archive` only when non-empty (never required, so entries lacking them still validate).
- The archive does **not** track individual sketch/song/other-material files. Those `.tex`/`.pdf` files live on the server under `archive/<folder>/{sketches,songs,other,…}/`. The overlay's GitHub button points at the repo's old copy and goes away with the cleanup.
- Uploads (cover / manus) are capped at ~5 MB each, client- and server-side.

## Schema: posts.json

```json
{
  "posts": [
    {
      "id": "68123abc4def5678",
      "pinned": false,
      "date": "2026-07-16T14:32:00",
      "author": "Ida",
      "title": "Prøve i morgen aflyst",
      "text": "Besked her. Linjeskift bliver til separate afsnit.",
      "image": "posts/68123abc4def5678/image.jpg",
      "comments": [
        {
          "id": "68124f0011aa22bb",
          "author": "Carl",
          "text": "Noteret!",
          "date": "2026-07-16T15:01:00"
        }
      ]
    }
  ]
}
```

- `id` — unique string, always server-assigned (`dechex(time()) . bin2hex(random_bytes(4))` in `server/update-data.php`'s `posts_create`) — never client-supplied, so a revyst-level poster can't forge or collide one.
- `pinned` — boolean, defaults to `false`. Only boss/admin can set it `true`, via the post's edit modal (which goes through the full-array `posts` resource, not `posts_create` — a revyst-level create can never produce a pre-pinned post). Pinning **moves** a post from the normal list into the pinned column on Forside; it does not duplicate it.
- `date` — `YYYY-MM-DDTHH:MM:SS`, a floating local (Europe/Copenhagen) timestamp with no `Z`/offset — same "everyone's in the same timezone" convention as the calendar `.ics` feed. Server-assigned to the current time on create; editable afterwards only via the boss/admin edit modal.
- `author` — free-typed string (no per-user login to attribute a post otherwise).
- `title` — optional string (may be `""`); shown as a small tag on the post.
- `text` — the body: sanitized rich-text HTML (`POST_ALLOWED_TAGS` in `posts.js`, same approach as Wiki). Older plain-text posts are still rendered by splitting on `\n` into paragraphs and auto-linking URLs.
- `image` — optional repo-relative path (`posts/<id>/image.jpg`) or `""`. Uploaded inline as part of `posts_create` itself (not the generic admin-only `upload` action, since post creation is revyst-level) — the client sends raw base64 image bytes alongside the post fields, and the server writes the file via the GitHub Contents API before appending the post's JSON entry. Always re-encoded to JPEG client-side (canvas-resized, max ~1600px wide) before upload, capped at ~5 MB. Not re-uploadable from the edit modal in this pass — changing a post's picture means deleting and recreating the post.
- `comments` — array of `{id, author, text, date}`, defaulting to `[]` on a freshly created post. `id`/`date` are server-assigned by a separate append-only action, `comments_create`, the same way a post's own `id`/`date` are assigned by `posts_create`. Any revyst+ visitor can comment on any post — there's no per-post visibility restriction to gate against. Deleting an individual comment is boss/admin only and needs no dedicated server action: the client filters the comment out of that post's `comments` array and calls the same full-array-replace `posts` resource used to edit/delete a whole post.

This is the site's first resource combining **three** write paths against the
same public, git-backed file: two revyst-level **append-only** actions
(`posts_create` — assigns `id`/`date`, always creates with `pinned:false`, and
optionally writes an inline image; `comments_create` — assigns a comment's own
`id`/`date`) outside `$RESOURCES`, and the usual boss-level **full-array
replace** (the `posts` resource in `$RESOURCES`, `save_posts`) for
editing/deleting a post (including toggling `pinned`), or deleting one of its
comments.

## Schema: bosses.json

```json
{
  "title": "Bosser for MatRevy 2025",
  "roles": [
    { "names": "Frida Nøhr Larsen, Carl Jarner", "role": "Koordinatorer" }
  ]
}
```

- `title` — the card's heading text, required non-empty string.
- `roles` — ordered list of `{names, role}`, rendered top-to-bottom exactly as stored (no client-side sorting). `names` is one free-text string (comma-separated when there's more than one person), not an array — matches how the card originally hand-listed multiple names per role. Both fields are plain strings server-side (empty allowed) since this is admin-only cosmetic content, not validated further.
- Edited entirely from the Forside card itself (admin-only "Rediger" button next to the title) via the `bosses` resource (full-array replace, like `calendar`/`archive`) — no manual git step needed for day-to-day edits, same as the other data-driven pages.

## Schema: wiki.json

```json
{
  "chapters": [
    {
      "id": "m3k2j1ab",
      "title": "Grupper",
      "body": "<h2>Bandet</h2><p>Fri, sanitized HTML — se WIKI_ALLOWED_TAGS i wiki.js.</p>",
      "published": true,
      "attachments": [
        { "id": "m3k2j1cd", "name": "Bandnoder.pdf", "path": "wiki/m3k2j1ab/m3k2j1cd-bandnoder.pdf" }
      ]
    }
  ]
}
```

- One flat list, one record per chapter — deliberately not a nested chapter/section tree, and not grouped by category; a chapter reads and edits as a single continuous piece of rich text, shown top-to-bottom exactly in the array's stored order (the "Rediger kapitler" modal's drag-and-drop reorders it).
- `id` — unique string, client-generated (`Date.now().toString(36)`) when the chapter is created — same convention as `calendar.json`'s event `id`. Stable for the chapter's lifetime.
- `title` — required, non-empty.
- `body` — a sanitized HTML string restricted to a small allow-list (`b/strong`, `i/em`, `u`, `ul`, `ol`, `li`, `p`, `br`, `h2`, `h3` — see `WIKI_ALLOWED_TAGS` in `wiki.js`), produced by the page's own rich-text toolbar. `<a>` is deliberately not allowed — links are never stored as markup, only auto-detected from plain-text `http(s)://`/`www.` URLs at render time. `h2` sections also drive the page's per-chapter outline (click-to-scroll sidebar list).
- `published` — optional boolean, defaults to `false`/unset (not yet visible to revyster) if omitted. Toggled per chapter from the "Rediger kapitler" modal. Boss/admin always see every chapter regardless of this flag; a revyst-level visitor sees every chapter's title in the left column but can only open (click into) a published one — unpublished titles render greyed-out/disabled. If no chapter is published at all, the revyst-level view shows a single "not published yet" banner card instead of the two-column layout.
- `attachments` — optional, defaults to none if omitted. A list of `{id, name, path}`: `id` is client-generated the same way as a chapter's own id; `name` is the original filename, shown as the link text; `path` is the repo-relative path the file was uploaded to (`wiki/<chapterId>/<attachmentId>-<slugified-name>.{pdf,tex}`, uploaded via the generic boss-level `upload` action, validated server-side against `WIKI_ATTACHMENT_PATH_RE`). Rendered as link buttons at the end of the chapter. Removing an attachment only drops it from this array — the uploaded file is left orphaned in the repo, same accepted trade-off as a deleted Post's `image` or a deleted Manuscript's pdf/tex.

## Schema: manuscripts.json

```json
{
  "submissions": [
    {
      "id": "68abc1234def5678",
      "type": "sketch",
      "title": "Hej",
      "sender": "Ida",
      "pdfPath": "archive/MatRevy_2026/submitted/Hej.pdf",
      "texPath": "archive/MatRevy_2026/submitted/Hej.tex",
      "createdAt": "2026-08-01T12:00:00"
    }
  ]
}
```

- `id` — unique string, server-assigned (`dechex(time()) . bin2hex(random_bytes(4))`, same convention as `posts.json`) — never client-supplied.
- `type` — `"sketch"` or `"sang"`, chosen by the uploader; determines which of the Manus page's two columns the submission appears in, and matches the `types` vocabulary used in `scenes.json`. A "Sang (fisk)" upload is `type: "sang"` plus `fisk: true`.
- `title`/`sender` — required, non-empty free text.
- `pdfPath`/`texPath` — site-relative paths, `archive/<currentProductionFolder>/submitted/<slug>.pdf`/`.tex` on upload. `slug` is the title with spaces replaced by `_` (`manus_slugify()`), deduplicated with a `_2`/`_3`/… suffix so two submissions never overwrite each other. Both files are uploaded inline by `manuscripts_create` (revyst-level), ~5 MB each; `manuscripts_update` (revyst, "Opdater") replaces them while they're still in `submitted/`. When a submission is selected or deselected and Manus is saved, `manuscripts_sync_selection` moves its files between `submitted/`, `sketches/` and `songs/` and updates these paths.
- `createdAt` — server-assigned floating local timestamp, same convention as `posts.json`'s `date`.
- `duration` — optional, minutes (0.5-step), parsed client-side from the uploaded `.tex`'s `\eta{}` at upload/update time. Only the default for the Vælg scener duration field; boss/admin can change it, and the edited value lives on the scene in `scenes.json` once selected.
- Removing a submission: the pool's "Fjern" (boss, full-array `manuscripts` resource) drops only the record and leaves the files; "Slet" in Vælg scener (admin, `manuscripts_delete`) deletes the files **and** the record.

## Schema: config.json

```json
{
  "currentProductionFolder": "MatRevy_2026",
  "pdfLinksVisibleToRevyst": false,
  "sketchUploadsClosedForRevyst": false,
  "songUploadsClosedForRevyst": false
}
```

- `currentProductionFolder` — the active production's `archive/<folder>`: where new submissions land and where `generate-pdfs.js` writes. `""` means no active production, which blocks `manuscripts_create`. Set by Koordinator's "Afslut revyen" (→ `""`) and "Start ny revy" (→ the new folder). Read client-side as `CONFIG_DATA`.
- `pdfLinksVisibleToRevyst` — shows Manus's PDF quick links to revyster too.
- `sketchUploadsClosedForRevyst`/`songUploadsClosedForRevyst` — close the upload pool per type for revyster.
- Admin-only `config` resource. Koordinator resets all three toggles to `false` when it closes or starts a production.

## Schema: program.json

```json
{
  "medvirkende": "\\arb{Koordinatorer}\nFrida Nøhr Larsen\\\\\nCarl Jarner -- \\emph{Boss}\\\\\n",
  "ordliste": "\\textbf{Kridt:} Matematikerens yndlingsfallossymbol \\\\\n",
  "qrCodes": [
    { "id": "q1a2b3", "label": "Sangtekster", "url": "https://matematikrevy.dk" }
  ]
}
```

- Feeds three self-hosted printed audience programme layouts, all generated by `scripts/generate-pdfs.js` from the same `program.json` content/images — `archive/<folder>/Program.pdf` (plain reading order: front cover, Aktoversigt, Medvirkende, Ordliste, QR-koder, back cover) and two booklet layouts, `ProgramHaefte.pdf`/`ProgramHaefteHorisontal.pdf` (reordered: front cover, Aktoversigt, Ordliste, Medvirkende, a blank run, QR-koder, back cover — then imposed two-up onto landscape A4 sheets in saddle-stitch order, one per physical duplex-printing flip convention, see `imposeBooklet()`'s own comment) — replaces the old hand-maintained `program.tex` workflow. `buildProgramSections()` compiles the six pieces of content as separate standalone PDFs and `composeProgramPdf()` reassembles them in whichever order+padding a given output needs, since Medvirkende/Ordliste are open-ended boss-typed LaTeX whose real page count can't be known ahead of compiling. The Manus page's PDF quick-links row offers a "Program" dropdown (`js/manus.js`'s `renderManusPdfLinksSection`, same pattern as its "Individuelt Manus" per-person picker) to open any of the three. Edited exclusively via the Manus page's boss/admin-only **Program** tab (`server/update-data.php`'s `program` resource, boss level, `save_program`).
- `medvirkende`/`ordliste` are each a single raw-LaTeX string, edited as a plain textarea in the Program tab exactly like `scenes.json`'s `scriptBody` — inserted verbatim, un-escaped. `medvirkende` is wrapped in `\begin{multicols}{2}...\end{multicols}`; a category heading uses the `\arb{...}` macro (`buildProgramSections()`'s preamble defines it as `\textbf{#1}\\`, matching the original hand-maintained `program.tex`). `ordliste` is also wrapped in `\begin{multicols}{2}...\end{multicols}` (`\textbf{Term:} definition \\` per line, conventionally alphabetized by hand — nothing sorts it automatically anymore, since there's no structured `term` field left to sort by).
- `qrCodes` — `url` generates a QR code image at PDF-build time (via the `qrcode` npm package, `scripts/generate-pdfs.js`'s one other real dependency alongside `pdf-lib`) — no image is ever uploaded or stored; `label` is the heading printed above each QR code. Unlike `medvirkende`/`ordliste`, `label`/`url` are plain text typed into small structured fields and are **always** LaTeX-escaped when composed into Program.pdf — the opposite convention, easy to get backwards (see `buildProgramSections()`'s own comment).
- Program.pdf's Aktoversigt section is built from `scenes.json`'s real `acts`/`scenes` (styled centered/`\Huge`, matching the original `program.tex`, not the internal `Aktoversigt.pdf`'s numbered/time-estimate layout) and **excludes the `E`/Ekstranumre act** — unlike `Aktoversigt.pdf`, which includes it. The front cover image is the current production's Arkiv cover photo (`archive.json`'s `coverImage` for the `config.json`-selected `currentProductionFolder`), falling back to `archive/_assets/placeholder-cover.jpg` when unset; the back cover is always that same sitewide placeholder.
- The booklet layouts' reordering is a **fixed template** tuned so a normal year's Ordliste+Medvirkende content fits exactly two folded A4 sheets, with Aktoversigt/QR-koder facing each other on the sheet nearest the covers and Medvirkende landing as one unbroken spread on the innermost sheet — by explicit product decision this does not auto-rebalance for a future year whose content outgrows that budget (imposeBooklet still pads to a foldable multiple of 4 pages regardless, it just won't recreate this exact pairing once content overflows two sheets).
- `data/program.json` must already exist on the server (even in its empty seed shape) before the first Program-tab save — `update_file()`, which every `$RESOURCES` save uses, reads before writing and has no create-if-missing branch.
- None of the three layouts has its own regeneration trigger — they're rebuilt by Manus's "Generér PDF'er" along with Aktoversigt/Rolleoversigt/Manuskript (the worker runs `generate-pdfs.js`). If `data/program.json` is missing entirely, `generate-pdfs.js` skips the three Program PDFs with a log notice rather than failing the whole run.

## Schema: masterplan.json

```json
{
  "plans": [
    {
      "id": "matrevy_2026",
      "year": 2026,
      "label": "MatRevy 2026",
      "ansvarLabels": ["Ansvar 2026", "Ansvar 2027"],
      "tabs": {
        "blok4": [
          { "id": "blok4-g1", "type": "group", "title": "" },
          { "id": "blok4-r1", "type": "task", "emne": "Praktisk", "todo": "Koordinator",
            "beskrivelse": "Del Drev med nye bosser", "ansvarA": "Frida", "ansvarB": "Carl",
            "status": "faerdig" }
        ],
        "august": [], "blok1": [], "revyen": [], "efterrevyen": []
      }
    }
  ]
}
```

- Backs the Koordinator page's **Masterplan** tab — a checklist grid replacing an externally-maintained spreadsheet of recurring production to-dos, always editable (a local draft, nothing saved until "Gem") via `js/koordinator.js`'s `renderMasterplanCard`/`renderMpGrid`. Edited exclusively there (`server/update-data.php`'s `masterplan` resource, **admin** level — same rank as `archive`/`config`, since Koordinator itself is admin-gated).
- `plans` is a flat array, **one entry per production year** (e.g. "MatRevy 2026", "MatRevy 2025", ...) — mirrors Budget's multi-year datastore in spirit, though far simpler (no private storage, no per-year directory: every plan just lives in this one public array). The admin switches which plan is being viewed via a "Viser plan for: ..." picker (`js/koordinator.js`'s `masterplanViewId`, persisted in `localStorage`) that also offers "+ Tilføj" to create a new plan and "Slet" to delete the one currently in view — same UI primitive as Arkiv's own year picker on this same page.
- Each plan: `id` (stable slug, `^[A-Za-z0-9_-]+$`, generated once at creation and never recomputed — same posture as `archive.json`'s `folder`), `year` (int, used to sort the picker newest-first), `label` (free text shown in the picker, e.g. "MatRevy 2026"), `ansvarLabels`, and `tabs`.
- `tabs` has **exactly** 5 fixed keys — `blok4`/`august`/`blok1`/`revyen`/`efterrevyen` — whose labels ("Blok 4", "August", "Blok 1", "Revyen", "Efter revyen") are hardcoded client-side (`KOORD_MP_TABS` in `koordinator.js`, mirroring `manus.js`'s own `MANUS_MAIN_TABS`); only each tab's row *content* is data. The server rejects a plan whose `tabs` object doesn't have exactly these 5 keys in this order.
- Each tab's value is a flat, ordered array mixing two row kinds (discriminated by `type`), matching the source spreadsheet's blue section-divider rows plus ordinary rows:
  - `"group"` — just an `id` and a `title` (a section divider; `title` may be an empty string — the spreadsheet had several unlabelled dividers).
  - `"task"` — `id`, `emne`/`todo`/`beskrivelse` (free text), `ansvarA`/`ansvarB` (free text, labeled by that plan's own `ansvarLabels` below), and `status` — one of `""` (unset), `"mangler"` (red), `"igang"` (yellow), `"faerdig"` (green), cycled by clicking the row's status pill.
- A row `id` must be a non-empty string, unique **within its own plan** (not globally across every plan — the client only ever edits one plan's rows at a time, so cross-plan uniqueness buys nothing).
- `ansvarLabels` is a pair of admin-editable column-header strings (e.g. `["Ansvar 2026", "Ansvar 2027"]`) shared across that one plan's 5 tabs — replaces the source spreadsheet's inconsistent per-tab "Ansvar 2025/2026" vs "Ansvar 2024/2025" headers with one pair per plan, edited directly as the grid's own Ansvar column headers (no separate settings UI). A past year's plan keeps its own historical labels (e.g. "Ansvar 2024"/"Ansvar 2025") even after a newer plan exists.
- Not reset by Koordinator's `koordCloseYear()` — a new production cycle doesn't touch `masterplan.json` at all; the admin creates that year's own plan by hand via "+ Tilføj" (typically once the previous year's plan is "done") and fills it in, optionally copying over recurring rows from the previous year's plan by hand.

## Schema: lokaler.json

```json
{
  "rooms":    [{ "id": "r-seed-00", "name": "Store UP1" }],
  "bookings": { "r-seed-00": { "2026-11-12": "x", "2026-11-19": "Matkantinen" } },
  "other":    [{ "id": "o-…", "event": "Infomøde d. 19/9", "booking": "A107 17-22" }]
}
```

- Backs Koordinator's **Lokaler & Fravær** tab (`renderLokalerTab` in `js/koordinator.js`), **admin** `lokaler` resource, Gem-batched draft like Masterplan.
- `rooms` are the grid's rows (order = display order). The **columns are never stored**: they are every `ove`/`forestilling` day in Kalender within `range` (optional `{start, end}` ISO dates, set by the admin's "Øvedage fra/til"; absent = the current rolling half-year), plus the day after the last `forestilling` ("Rengøring").
- `bookings` is free text keyed by room `id` then ISO date — not by calendar event, so rooms carry over between years and moving an event never orphans a cell. Bookings for dates no longer shown stay in the file, unrendered. Empty strings are dropped on save; an empty map may come back as `[]` from PHP (the client treats it as `{}`).
- `other` is the free-form "Øvrige bookinger" list under the grid.
- The signed booking-form PDFs are **not** here: they live in the private `LOKALER_DATA_DIR` (`files.json` + `files/<id>.pdf`), via the admin `lokaler_*` actions.

## Schema: gantt.json

```json
{
  "year": 2026,
  "rows": [
    { "id": "mt3k9q2a", "title": "Manusskrivning",
      "bars": [ { "id": "mt3kb1x0", "start": "2026-08-15", "end": "2026-09-30", "label": "Sketches", "color": "green" } ] }
  ]
}
```

- Backs the Gantt chart below Kalender's calendar (`js/calendar.js`'s `renderGantt`). Visible to everyone (the card is hidden while `rows` is empty), edited only by **admin** (`server/update-data.php`'s `gantt` resource), as a local draft saved with "Gem".
- `year` picks the window drawn: September 1 – November 30 of that year. Changing it in the editor offers to shift every bar's dates by the same number of years.
- `rows` is the ordered list of sections on the y-axis (`id` matches `^[A-Za-z0-9_-]+$`, unique; `title` non-empty). Each row holds any number of `bars`: `start`/`end` are `YYYY-MM-DD` (`end >= start`), and `label` is optional (it may be `""`). A bar `id` is unique across the whole file.
- Bars keep full dates and aren't limited to the window: a bar partly outside it is clipped at the edge, and one entirely outside is simply not drawn. Overlapping bars in the same row stack into extra lanes. `color` is optional, one of `green`/`blue`/`yellow`/`purple`/`red`/`teal` (`GANTT_COLORS` in `js/calendar.js`), chosen per bar in the editor. A bar without one falls back to a colour cycled by its row's position, and the editor writes that fallback in explicitly on the next save.
- Not reset by Koordinator's `koordCloseYear()`.

## Schema: revyugen.json

```json
{
  "startDate": "2026-11-14",
  "endDate": "2026-11-22",
  "startHour": 8,
  "endHour": 24,
  "blocks": [
    { "id": "mt3kb1x0", "date": "2026-11-14", "start": "10:00", "end": "12:30", "title": "Opstilling", "text": "Alle mødes i salen", "category": "obligatorisk" }
  ]
}
```

- Backs the "Revyugen" week schedule below the Gantt chart on Kalender (`js/calendar.js`'s `renderRevyugen`). Visible to **revyst**+ only (hidden below admin while `blocks` is empty), edited only by **admin** (`server/update-data.php`'s `revyugen` resource), as a local draft saved with "Gem".
- The days `startDate`–`endDate` (inclusive, at most 31 days) are drawn as columns; a file without `endDate` shows nine days from `startDate`. `startHour`/`endHour` (integers, `0 <= startHour < endHour <= 24`) set the visible time range. Changing `startDate` in the editor moves `endDate` and every block by the same number of days; changing `endDate` only moves the end.
- Each block: `id` (`^[A-Za-z0-9_-]+$`, unique), `date` (`YYYY-MM-DD`), `start`/`end` (`HH:MM`, `end > start`; `end` may be `"24:00"` for midnight), `title` (non-empty, shown bold), `text` (may be `""`, shown below the title), `category` — one of `ove` (Øvning, blue), `frivillig` (Frivillig, green), `scenefolk` (Scenefolk, yellow), `obligatorisk` (Obligatorisk, red), `andet` (Andet, purple) — `REVYUGEN_CATEGORIES` in `js/calendar.js`. A block outside the days or the hour range is clipped or simply not drawn; overlapping blocks on the same day share the column side by side.
- Not reset by Koordinator's `koordCloseYear()`.

## Adding a year to the archive

Everything happens in the browser:

1. Open **Koordinator** (admin) → **Arkivering**.
2. In the Arkiv section, add a year (or pick an existing one to edit).
3. Fill in the Navn (required, e.g. "MatRevy 2024"; Årstal auto-fills from a year in the name), optionally a cover photo, the manuscript PDF, and YouTube / Spotify / Google Drive links.
4. Click **Gem**. The cover/manus files upload first, then the year saves to `archive.json` through `server/update-data.php`, and the worker regenerates `archive-data.js` within seconds.
5. Individual sketch/song/other files go under `archive/<folder>/{sketches,songs,other}/` on the server. For the current production, `generate-pdfs.js` and the Manus upload pool fill these in. For older years, copy them to `/srv/matrevy/data/site/archive/<folder>/` on web-1 and `chown -R 33:33` them.
