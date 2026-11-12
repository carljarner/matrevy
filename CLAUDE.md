# CLAUDE.md

Internal website for Matematikrevyen (Danish student revue) at `matematikrevy.dk`. This file is the always-loaded core; **per-page detail lives in `.claude/rules/<page>.md`**, which loads automatically when you read or edit that page's files (see "Where to look").

## Stack

- Plain HTML/CSS/JS, no framework, bundler, package manager, test suite or linter; validation is manual (`/verify` skill).
- One PHP file, `server/update-data.php`, is the whole write API (POST only, except Teknikken's signed download GET).
- Node only runs the two build scripts in `scripts/` (dev deps `pdf-lib`, `qrcode`).
- Everything runs on **web-1** (Hetzner, `188.245.30.36`), deployed by **Coolify** from `main` as one Docker Compose app. Simply.com only hosts DNS (records in README.md); mail goes through Forward Email. Operations/backups: README.md → Drift.
- Planning docs live in the gitignored local `plans/` folder (e.g. `plans/autosave.md`).

## Rules that always apply

- **All UI text is Danish.** No em/en dashes (—, –) in anything the site shows (labels, toasts, `aria-label`s, generated PDFs): use a period, comma or parentheses. A hyphen is fine in words, unspaced ranges (`10:00-16:00`) and as the empty placeholder (`-`); date ranges use "til". Code comments may use dashes.
- `'use strict'` at the top of every JS file. Section headers: `// ── Section name ─────`.
- **Never `innerHTML`**: build DOM with `createElement`/`textContent`. Exceptions: Wiki/Posts rich text (sanitized via a detached `DOMParser` doc, rebuilt from an allow-list) and Øveplan's templates (always through `escHtml()`).
- **A write succeeded only if the body parses as JSON with `ok === true`** (a PHP fatal or proxy page can arrive as HTTP 200 + HTML). Every `*Api` helper follows this.
- Every `:hover` rule lives inside `@media (hover: hover)`; split `:hover, :focus-visible` so focus stays ungated; hover-only reveals need a `@media (hover: none)` fallback.
- **Breakpoints**: `@media (max-width: 719px)` site-wide; `420px` only for small narrow-phone tweaks.
- **Drag to reorder**: every draggable row supplies its own drag image via a page-scoped `<prefix>GetDragImageEl()` (one lazily-created off-screen `<div>`, `position: fixed; top/left: -999px`, never `display:none`; `dragstart` sets its text and calls `setDragImage(ghost, 12, 16)`). A per-row drop target only inserts *before*, so add a trailing drop-tail element (`.<x>-drop-tail`) or make the whole list the drop zone. A `<table>` drop highlight uses an inset `box-shadow`, never `border-top/bottom` (collapsed borders eat the row lines).
- **Duplication is deliberate**: pages load different script subsets, so shared logic not in `site.js`/`site-utils.js` is copied per page (role classification, dance split, drag helpers, tooltips, cast placeholder check). Keep copies in sync.
- **Roles**: always call `classifyOrKeep`, never `classifyRoleCode` (a role may already be a category; `"Koreograf"` would re-classify as Kor). Lives in `schedule.js`, copied verbatim into `manus.js` and `scripts/generate-pdfs.js`.
- **Server safety**: `github_api()` can write anything under `SITE_DATA_DIR`, so the path allow-list regexes in `update-data.php` are the only guard. **Never relax one without an equally strict replacement.**
- **PHP const-ordering landmine**: top-level `const`s register in execution order, and most action groups dispatch near the top of `update-data.php`, so their handlers use **hoisted functions** (`budget_receipt_re()`, `band_max_upload_bytes()`, …), not consts declared later.
- **Git**: the worker pushes `[skip ci]` commits to `main` (only under `archive/`), so `git pull --rebase` before pushing. Never edit the repo's `archive/`; the next sync overwrites it.

## Where to look

| Page | Files | Rule |
|---|---|---|
| Forside (Posts, Bosser) | `index.html`, `posts.js`, `bosses.js` | `forside.md` |
| Kalender (+ .ics, Gantt, Revyugen) | `kalender.html`, `calendar.js`; `.ics` in `embed-scenes.js` | `kalender.md` |
| Arkiv | `arkiv.html`, `archive.js` | `arkiv.md` |
| Wiki | `wiki.html`, `wiki.js` | `wiki.md` |
| Manus (+ Program, PDFs) | `manus.html`, `manus.js`, `manus-data.js`, `scripts/generate-pdfs.js`, `manus/` | `manus.md` |
| Stjerneark | `stjerneark.*` | `stjerneark.md` |
| Koordinator (Masterplan, notes, Lokaler & Fravær, Arkivering, new production) | `koordinator.*` | `koordinator.md` |
| Budget (+ Stregregnskab) | `budget.*` | `budget.md` |
| Formularer | `forms.*` | `forms.md` |
| Fællesspisning | `faellesspisning.*` | `faellesspisning.md` |
| Bandet | `band.*` | `band.md` |
| Kostumetinder | `kostumetinder.html`, `kostume.*` | `kostume.md` |
| Ninjas, Mics & Cues | `ninjas.*` | `ninjas.md` |
| Rekvisitten | `rekvisitten.html`, `rekvisit.*` | `rekvisitten.md` |
| Teknikken | `teknikken.*` | `teknikken.md` |
| Lydfiler (internally `sangere`; shares Teknikken's server code) | `lydfiler.html`, `js/sangere.js`, `css/sangere.css` | `lydfiler.md` |
| Program (Redskaber; scratch Medvirkende/Ordliste, internally `programkladde` server-side) | `program.*` | `program.md` |
| Øveplan | `schedule.*` | `oveplan.md` |
| Header/nav/login | `js/site.js` | `site-shell.md` |
| Containers, worker, archive mirror, dispatch order | `server/**`, `docker-compose.yml` | `server.md` |

`update-data.php` serves every feature, so it doesn't trigger page rules: **before changing a feature's actions there, read that feature's rule file.** Schemas for public data files: `data/README.md`.

## Hosting & data flow

- **Two containers** (`docker-compose.yml`), both mounting `/srv/matrevy/data` at `/data`: **`web`** (`php:8.3-apache`: static files, `update-data.php`, `health.php`, `config.php` from Coolify env vars `REVYST_/BOSS_/ADMIN_PASSWORD`, optional `SATYR_PASSWORD`) and **`worker`** (TeX Live + Node: reruns `embed-scenes.js` / `generate-pdfs.js` when `update-data.php` drops a flag file, and mirrors the archive to GitHub). Apache gives pages **clean URLs** (`/kalender`); `server/dev-router.php` mirrors those rules for local `php -S`.
- **Live data**: public in `/srv/matrevy/data/site/{data,archive,posts,wiki}` (+ `generated/` for `js/*-data.js` and `calendar.ics`); private in `/srv/matrevy/data/{budget,forms,faellesspisning,band,kostumetinder,ninjas,rekvisitten,lokaler,teknikken,sangere,koordinator,programkladde}`, never web-served. Nightly restic backup of `/srv`, except `teknikken/` and `sangere/`. The repo doesn't track `data/*.json`, `posts/`, `wiki/`, `calendar.ics` or `js/*-data.js` (except `manus-data.js`); editing local copies changes nothing live.
- **Save path**: browser → `update-data.php` → `github_api()` (now a local-disk stand-in: base64 `content` + `sha` = sha1 of the bytes, flock'd, atomic rename, stale `sha` → 409) → touches `.embed-requested` → worker regenerates embeds. Visible on next load within ~3 s; a full PDF build takes ~15 s.
- **Deploy**: push to `main` → Coolify rebuilds both containers (code is baked into the image). Secrets only in Coolify env vars. `SITE_API_ENDPOINT` is always `/update-data.php` (same origin); CORS only allows `https://matematikrevy.dk`.
- **Archive mirror**: the worker pushes `/data/site/archive/` to the repo's `archive/` ~5 min after the last change. Until Manus's "Revyster kan se manus"/"… roller" toggles are on, the current production is mirrored hidden or redacted (`server.md`).
- **Embedded data**: `scripts/embed-scenes.js` is table-driven (`EMBEDS`): each `data/<name>.json` becomes a global (`SCENES_DATA`, `CAST_DATA`, `CALENDAR_DATA`, …) in `js/<name>-data.js`, loaded via `<script src>` (globals, not `fetch()`, so pages work over `file://`). Files are only rewritten when content changed (`writeIfChanged`), so `Last-Modified` means "data changed" (the stale-page banner relies on it). **Adding a data file** = an `EMBEDS` entry + `<script>` tags + creating the JSON on the server once (`update_file()` has no create-if-missing).
- **Local development**:
  ```
  rsync -a web-1:/srv/matrevy/data/site/{data,archive,posts,wiki} ./
  node scripts/embed-scenes.js
  php -S localhost:8741 server/dev-router.php   # python's http.server can't do clean URLs
  ```
  Local saves go to the local `/update-data.php`, never the real API (use a hand-written `config.php` pointing `SITE_DATA_DIR` at a scratch copy if needed).

## Access levels & site shell (`site.js`)

- **Five levels: public / satyr / revyst / boss / admin**, four shared passwords handed out verbally (deliberately not real per-user auth). **Reads are gated client-side only (cosmetic); writes are validated server-side.**
  - **Satyr** (optional): Forside/Kalender look like a visitor's (gates there are `siteHasLevel('revyst')`), Budget shows only the submit form, Fællesspisning only the per-day summary; every other page hidden.
  - **Revyst**: most pages. **Boss**: edits Manus/Kalender/Wiki/Formularer and the private tools' admin bits. **Admin** (site maintainer): everything plus Koordinator, Budget management, site config, Arkiv, Gantt/Revyugen, Bosser.
- **`SITE_PAGES`** (`{href, label, level, group?}`) is the **only** place a page is registered; `group: 'redskaber'` folds it into the Redskaber nav tab.
- **Auth**: login stores `{level, password}` in `localStorage['matrevy-auth']` (the password is resent on writes). A boss/admin can **view as a lower level** (`viewLevel`): `getSiteAuth()` returns `{level: <view>, realLevel, password}`, so every `siteHasLevel()` gate follows the view while writes still use the real password.
- Password helpers trust a stored login for boss-level saves when the level is `boss` *or* `admin`; admin-only resources only trust `admin`.
- **`file://`**: `getSiteAuth()` returns a synthetic admin with an empty password, so tools work offline (writes fail).
- **Page gate** (`applyPageGate()`) hides `<main>` with a login card. Cosmetic by design.
- **z-index ladder**: header 100 → mobile menu 150 → modals 200 → field-picker popups 210 → Manus PDF progress 220 → hover tooltips 250 → `.site-toast` 300 (stale banner 120).

## Design system (`style.css`)

One design system for every page **except Øveplan** (`schedule.css` keeps its own look and `.btn-primary`/`.btn-secondary`; its confirm modal uses the shared classes). Use the shared classes below; page JS builders stay page-scoped but emit these class names.

- **Tokens** (`:root`): warm palette (`--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--input-bg` cream, `--accent-warm*`), `--radius` (6px, controls/fields) / `--radius-card` (8px), `--focus-ring` (the one focus indicator), `--disabled-opacity`, `--shadow-pop`/`--shadow-toast`, `--row-hover`, `--fs-xs/sm/md/lg`, category colours `--cat-{blue,green,yellow,red,purple,teal}` + `-bg`, `--danger-tint`/`--success-tint`. Typed text is `--text`, never `--header`. Use tokens, not new literals. Font: Computer Modern Serif, vendored in `fonts/computer-modern/`.
- **Global `:where()` defaults**: controls inherit the font, amber checkboxes, muted placeholders, links in text (`a` without class, or `.site-link`) amber + underlined. Scrollbars are themed site-wide (don't style a page's own).
- **Page title**: `.page-content h1`.
- **Tabs**: `.site-tabs` > `button.site-tab.active`; `.site-tabs-sub` for a second level. Scroll sideways on phones; no mobile dropdowns.
- **Collapsible row**: one `button.site-collapse[aria-expanded]` with a `.site-chevron` (one ▾, rotated while collapsed) on the left; hover recolours only the chevron. `siteCollapseHeading(tag, title, {open, body, onToggle})`; `.site-collapse-icon` = chevron-only.
- **Boss Box**: `.site-boss-box`, always the **last card** on the page, content-width, bare h2 collapse toggle, open on every load (state in memory). Settings are `.site-switch-row` (label left, `label.site-switch > input + span.site-switch-slider` right).
- **Edit mode**: `siteEditToggle(editing, onClick, {editLabel, doneLabel})`, a pencil that becomes an amber check mark in the card head's top-right corner. Buttons that only open an editor modal stay a text "Rediger".
- **Icon buttons**: `.site-icon-btn` (+ `-danger` for ✕, `-sm` in dense rows, `.site-add-plus` for "+", `.site-add-center`, `.site-icon-on`). The glyph is `✕`, never `×`.
- **Fields**, three kinds:
  - `.site-inline-field`: sheet cells and unlabeled in-place text. Transparent at rest, `--border` on hover, amber border + ring on focus, background stays transparent; `[readonly]` opts out.
  - `+ .site-field-labeled`: a field beside its own label; same, but cream while focused.
  - `.edit-field`: modals and forms. Boxed, cream, amber on hover/focus. Pickers (`.site-field-btn`) match.
- **Toolbar controls**: `.site-toolbar-control` on a `.site-field-btn`/`.btn-small` in a title row (2rem, cream). **Segmented**: `.site-segmented > button(.active)`.
- **Sheets**: `.site-sheet` (+ `.site-sheet-lines`, `.site-sheet-section`, `.site-sheet-noline`, `.site-sheet-sticky` with inline `left`). Long sheets scroll **with the page** (wrapper only scrolls sideways); `siteStickyHead(thead, container?)` keeps the header under the site header. List tables (Budget ledger, Formularer Oversigt) don't use it.
- **Modals**: `.edit-modal` 480px; `.site-modal-sm/-md/-lg/-xl` 400/560/760/1040px. One-line confirms: `.site-confirm-modal` + `.site-confirm-text` / `.site-confirm-sub`. Never `confirm()`/`alert()`.
- **Text**: `.site-muted`, `.site-hint`, `.site-empty`. Italic only for an in-tree placeholder ("Tom mappe").
- **Save status**: `.site-save-status` (+ `.dirty`, `.error` red). Auto-save pages: "Gemmer…" / "Gemmes automatisk · Gemt" / "Ikke gemt: …"; Gem pages: "Ikke gemt" / "Gemt"; live-write pages show none.
- **Buttons**:
  - First level (inline): `.btn-small` / `.btn-small-danger`.
  - Second level (in `.login-overlay`/`.login-modal`): `.site-btn-primary` (blue) / `-danger` (red) / `-warm` (amber, e.g. Annuller) / `-success` (green); `min-width: 5rem` (Manus has its own sizing). Per-page factories (`calPillBtn()`, `budgetPillBtn()`, …) default to `site-btn-warm`.
  - **Blue is only for Login** (and the gate card). Every other save/confirm ("Gem", "Indsend", "Forbind") is green. Exception: Formularer's "Skabelon" is blue.
  - **Orange = chosen/selected**: solid amber + white (segmented, `.site-list-selected`, `.site-dp-selected`, today marker) or light amber fill (picked rows in long lists). Never blue. Category blue (`--cat-blue`) is identity, not selection.
- **Modal actions** (`.login-actions`): centred by default. Editor-shaped modals pin to the corners (delete left, save right) with `.login-actions.<own-class> { justify-content: space-between }`, plus `:has(> :only-child) { justify-content: center }` where only one button can render. Self-contained bars (`.post-detail-actions`, `.budget-save-bar`, `.forms-builder-actions`) use plain `space-between`.

### Field pickers (`site-utils.js`)

Native date/time/select UI is unstylable, so every page except Øveplan uses custom popups. Each factory returns an element with a `.value` getter/setter and a `change` event:

- `siteCreateDateField(iso)`, `siteCreateTimeField(value)` (typeable; `siteParseTimeInput` accepts `14:30`/`14.30`/`1430`/`930`), `siteCreateDateTimeField` (date, then optional time; "Ingen tid", optional `endOfDayOption` 23:59), `siteCreateDropdownField(options, value, placeholder?)`.
- Chrome: `siteOpenFieldPopup`/`sitePositionFieldPopup`/`siteCloseFieldPopup`/`siteToggleFieldPopup` (`.site-field-pop`, fixed, clamped, repositions on scroll, one open at a time, Escape closes only the popup).
- `schedule.js` has `sched`-prefixed copies (its time field fires no `change`). Kalender's category field adds coloured dots on the same primitives.

## Data-driven pages

- **Script order**: `site.js` → `site-utils.js` → `<feature>-data.js` → `<feature>.js`. One page-scoped JS file per feature.
- **Optimistic shadow**: `let xOverride = siteLoadOverride('x')` + `getEffectiveX()`; a successful save calls `siteSaveOverride(resource, data)` and re-renders, so the tab sees its change before the embed regenerates. Lasts `SITE_OVERRIDE_TTL_MS` (30 s) across refreshes. Manus writes `siteSaveOverride('manus', …)`, which Øveplan, Stjerneark and Ninjas read too.
- **`site-utils.js` helpers**:
  - Dates: `DA_MONTHS`, `DA_WEEKDAYS_SHORT`/`_LONG` (Monday-first), `parseIsoDate` (always from parts; never `new Date('YYYY-MM-DD')`, which is UTC), `formatDaDate`, `formatDaDateMaybeTime`, `todayIso`.
  - `siteShowToast`; `siteFileStatus(path)` (HEAD → `{exists, date, checkFailed}`).
  - Saves: `siteSaveResource(resource, payload)` (boss/admin; stored password or a `sessionStorage` prompt keyed `matrevy-manus-pin`; returns `{ok}` / `{ok:false, message}`, never throws, `message === ''` = cancelled); `siteSaveListResource(resource, listKey, update)`.
  - Files: `siteFileAction`/`siteUploadFile`/`siteDeleteFile`.
  - Drafts: `siteCreateAutosave({save, onStatus})` (debounced ~1 s, serialized, `{schedule, flush, isBusy, hasUnsaved}`, `beforeunload` warning; `save()` must not re-render; a failure waits for the next change); `siteDraftBackup(name)` (unsaved Gem drafts mirrored to `localStorage['matrevy-draft-<name>']`); `siteRegisterUnsavedCheck(fn)`.
  - Modals: `siteOpenEditModal`/`siteEditField`, `siteOpenModalWithClose` (✕ + Escape). A backdrop click only closes when the `mousedown` also started on the backdrop.
  - Components: `siteCollapseHeading`, `siteEditToggle`/`siteIcon`, `siteStickyHead`.
- **Four save models** (check which one a page uses before changing it):
  1. **Full array replace** via `siteSaveResource` (`archive`, `bosses`, `config`, `gantt`, `revyugen`): last save wins.
  2. **Read-apply-retry** via `siteSaveListResource` (Kalender, Posts, Wiki): `resource_read` → apply one change to the live list → save with `baseSha`, a 409 re-reads (3 tries).
  3. **Three-way merge on save**: Manus (`manusMergeActs`), Program, Masterplan/Lokalebooking/Fravær (`koordSaveMerged`), Redskaber's Program page (per line, `progMerge3`).
  4. **Live per-row/per-cell actions** on private stores (Fællesspisning, Bandet, Kostume, Rekvisitten, Ninjas, Stregregnskab, Koordinator notes, Teknikken/Lydfiler): blur-commit, chained per row on `row._inFlight`, flock'd `*_mutate()` server-side. Each has its own `*Api` helper (`budgetApi`, `formsApi`, `faellesApi`, `bandApi`, `postsApi`, `manusApi`, `progApi`, …).
- **Per-revy tools** (Bandet, Kostume, Rekvisitten, Ninjas): a revy picker; revyster write only the current production (Bandet: its active folder), boss any year (`403 read_only`).

## Data schemas (`data/README.md` has them all)

- `scenes.json`: scene `id` is `"act-number"` (`"1-3"`, `"E-2"`); permanent `uid` per scene. `schedulable:false` = video/band jingle. `cast[].role` is a classified category in Manus-saved data (raw codes only in legacy data). Stjerneark fields `prioSkuespil`/`prioSang`/`dansPriority`/`prioBand` (0-3), `repeat`, `oevetBand`/`oevetScene`, `stjerneNote`, `stjerneExtra`; `priority`/`dansRepeat` are derived on save.
- `cast.json`: `index` sequential from 0; exactly the names cast in `scenes.json` plus the `sangboss: true` entry; optional `placeholder`.
- `config.json`: `currentProductionFolder` (`''` = no active production), `pdfLinksVisibleToRevyst`, `rolesVisibleToRevyst`, `sketch`/`songUploadsClosedForRevyst`, `archiveReadyTeknik`/`archiveReadyManus`, `teknikUploadsClosed`.

## Adding a new page

Copy `page-template.html` (add `site-utils.js` for a data-driven page), register it once in `SITE_PAGES` with its level (and `group` for Redskaber); the clean URL, nav and gate work automatically. Add a `.claude/rules/<page>.md` with `paths:` frontmatter for its files and a row in "Where to look".

## Known issues

- **Last save wins** for `archive`, `bosses`, `config`, `gantt`, `revyugen` (rarely edited; not fixed by decision; `plans/autosave.md` has the plan). Every other shared resource merges or retries (save models above).
- **Real per-user login**: only if the shared-password model stops being enough.
- Page-specific issues are in each rule file.
