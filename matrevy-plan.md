# Matematikrevyen – Website Roadmap

## Top-Level Overview

The site is graduating from a single-tool experiment into the internal website for
Matematikrevyen, easing the coordinators' yearly administrative workload: dashboard,
calendar, archive of previous years, manus selection, budget, and more — on the same
zero-dependency stack (static GitHub Pages + Simply.com PHP write proxy +
GitHub-repo-as-database).

**How this file is used**: it is the living master roadmap. Each phase below is executed
in its own working session ("implement Phase N from matrevy-plan.md"): plan the details,
build, verify manually, mark the Status line, and update CLAUDE.md so the next session
inherits accurate architecture docs. CLAUDE.md documents *how the code works now*; this
file documents *what's next and why*.

---

## Architecture Decisions

- **Tech stack**: Plain HTML + CSS + JS, no framework, no build step. Node only for
  `scripts/embed-scenes.js`. Hosted on GitHub Pages at `matematikrevy.dk`.
- **Access model** (four levels: public / revyst / boss / admin, added in Phase 6):
  public landing page; top-right login with three shared passwords handed out verbally.
  **Boss** is today's show-directors/coordinators role (Øveplan, editing Manus/Kalender);
  **Admin** is a new top tier above Boss (the site's technical maintainer) with everything
  Boss has plus year-switching and site-wide config. Revyst-level pages are greyed out in
  the nav until login; boss/admin-level pages are hidden from the nav entirely below that
  level. Client-side gating for *reads* is a deliberate, accepted trade-off (the repo is
  public — nothing on the site is secret); **writes are genuinely validated server-side**
  by `server/update-data.php` (three password levels, `hash_equals`).
- **Data**: every feature stores its data as JSON in `data/`, committed via the PHP proxy →
  GitHub Contents API pattern proven by the manus tool. `.github/workflows/embed-scenes.yml`
  regenerates the embedded `*-data.js` globals on any `data/*.json` push.
- **Videos**: external links only (YouTube/Drive/…) — never video files in the repo
  (GitHub's 100 MB file limit; repo stays lean).
- **Multi-production**: permanent site shell; the `data/` files are replaced each
  production cycle.

---

## Phases

### Phase 0 — Foundation: login, shared nav, generalized write endpoint

**Intent**: everything later phases depend on — the access-level system, a single central
page registry instead of hand-copied nav blocks, and a write endpoint that new resources
can register with.

**What was built**
- `site.js`: central `SITE_PAGES` registry (`{href, label, level}`), JS-rendered header
  nav (revyst pages greyed when logged out, admin pages omitted), login modal (verifies
  against the server, stores `{level, password}` in `localStorage` key `matrevy-auth`),
  logout, and a per-page gate that hides `<main>` behind a "Log ind" card when the level
  is insufficient. Over `file://` the gate is bypassed entirely (login is unreachable
  there) so the schedule tool's offline use keeps working.
- `server/update-data.php` generalized: `{action:'login'|'save', password, resource,
  payload}`; `REVYST_PASSWORD`/`ADMIN_PASSWORD` in `config.php` (legacy `SHARED_PIN`
  still accepted as admin); per-resource table (`$RESOURCES`) with minimum level +
  validator — currently just `manus` (admin). Legacy `{pin, scenes, cast}` body still
  accepted.
- `import.js` sends the new shape and prefers the site login's stored admin password over
  the old per-tab PIN prompt (which remains as fallback).
- `scripts/embed-scenes.js` made table-driven (`EMBEDS`); workflow triggers on
  `data/*.json`.

**Status**: [x] done — live and verified end-to-end 2026-07-11: PHP redeployed to
Simply.com with real passwords, login verified for both levels (plus 403/400 save
rejections), and a real manus save went through the new request shape with the widened
workflow regenerating the embeds. Post-launch adjustment: Øveplan is **admin**-level,
not revyst — the schedule tool serves coordinators only, which also keeps the
"Rediger Manus" button out of revyst view.

---

### Phase 1 — Dashboard + announcements

**Intent**: Forside becomes a real dashboard and the first admin-editable content.

**Expected outcomes**
- `data/announcements.json` (+ embedded `announcements-data.js`, new `EMBEDS` entry and
  workflow `git add` line).
- Announcements listed on Forside (public sees them all, or possibly a public/revyst
  split — decide at planning); admins get add/edit/delete controls in-page.
- New `announcements` resource (admin) in `server/update-data.php`'s `$RESOURCES`.
- General info + quick links section.

**Status**: [x] done 2026-07-11 — per-announcement `level` (public/revyst) chosen at
planning; Forside renders from `announcements-data.js` via `announcements.js`, admins
add/edit/delete in-page (modal from the new shared `site-utils.js`); the old hardcoded
welcome message became the seed record. General info card now links Kalender/Manus/Arkiv.

---

### Phase 2 — Calendar

**Intent**: rehearsal/show/deadline calendar, admin-editable, revyst-visible.

**Expected outcomes**
- `data/calendar.json` with events (date, time, title, category, note).
- Calendar page (month and/or list view, Danish), registered as revyst-level.
- Admin editing in-page; `calendar` resource in `$RESOURCES`.
- Later possibility (own sub-task): revyster register absences per rehearsal day, feeding
  the schedule tool's "Fraværende revyster" — first revyst-level write.

**Status**: [x] done 2026-07-11 — `kalender.html` (revyst) with month-grid + list toggle
(view choice persisted, list default on mobile), four event categories with ASCII keys
(`ove`/`forestilling`/`deadline`/`andet`), admin editing in-page, `calendar` resource.
The absence-registration sub-task remains **parked** (deliberately deferred at planning —
first revyst-level write, deserves its own session).

---

### Phase 3 — Archive (previous years)

**Intent**: previous years' manus and videos in one place.

**Expected outcomes**
- `data/archive.json`: per year — manus PDF path + video links (external only).
- PDFs committed under `arkiv/<year>/`.
- Archive page (revyst-level), admin-editable via an `archive` resource.

**Status**: [x] done 2026-07-11 — `arkiv.html` (revyst) renders a poster-grid of years
(cover photo, YouTube link, manuscript PDF), admin-editable via an add-tile in the grid.
Redesigned same day: admins upload cover photos, manuscript PDFs, and individual
sketch/song/other-material files directly through the browser — no manual git step.
Files commit to `archive/<folder>/...` via new `upload`/`delete` actions in
`server/update-data.php` (GitHub Contents API, path allow-listed server-side since
`GITHUB_TOKEN` has whole-repo write access); metadata still saves through the `archive`
resource. See `data/README.md` for the schema and upload flow.

**Bug found & fixed 2026-07-12** (while building Phase 5): browser cover/manus uploads had
been silently broken by a PHP const-ordering issue — `ARCHIVE_PATH_RE`/`MAX_UPLOAD_BYTES`
were declared *below* the `upload`/`delete` dispatch, so they were `Undefined constant` at
call time (a fatal returned as `200`+HTML). Consts moved above the dispatch. Any archive
covers already in the repo were committed directly via git, not through this endpoint.

---

### Phase 4 — Manus production pipeline

**Intent**: supersedes the original one-line placeholder now that requirements exist.
The original 2026-07-14 sketch (one-stage catalog with a `submitted`/`selected`/`cut`
`status` field) was superseded 2026-08-01 once the user described the actual flow they
want, which splits upload and selection into two distinct data stores instead: revyster
upload `.tex`/`.pdf` into a standing pool → boss votes/selects from that pool and builds
this year's act structure → boss assigns cast/roles (reusing Øveplan's existing "Rediger
Manus" tool) → the site compiles `.tex` sources into manuscript PDFs.

**Sub-phases** (session order 4.1 → 4.2 → 4.3 → 4.4, each its own session; a planned separate
4.5 "full manuscript assembly" ended up folded into 4.4 once it was actually scoped — see
4.4's own note):
- **4.1 — Upload** — [x] done 2026-08-01. `data/manuscripts.json` (new resource, embedded
  as `MANUSCRIPTS_DATA`): any revyst+ submits a sketch/song (Titel/Afsender/`.pdf`/`.tex`)
  via a new revyst-level append-only `manuscripts_create` server action (mirrors
  `posts_create`) — **not** a `status` field on the production catalog itself, a fully
  separate standing pool, so a submission never touches `data/scenes.json` until Boss
  explicitly promotes it via Aktfordeling (4.2). Files are renamed server-side to
  `<slug>.pdf`/`.tex` (spaces → `_`, `_2`/`_3`… on a same-type title collision) and written
  into `archive/<currentProductionFolder>/submitted/` (amended 2026-08-02: originally
  `manus/<sketch|sang>/`, moved to the archive's 3-folder model — see 4.3's amendment
  below). Boss/admin remove a submission via a small ✕ (full-array-replace `manuscripts`
  resource) — the underlying files are left in the repo, not deleted (same accepted
  trade-off as a deleted Post's orphaned image). `manus.html` renders the pool as two
  alphabetical columns (Sketches/Sange); PDFs open in a new tab, `.tex` is never displayed.
  See CLAUDE.md's "Manus page" section for the full architecture.
- **4.2 — Selection** — [x] done 2026-08-01, built together with 4.1. Boss/admin get
  **"Hent stemmeark"** per column (a browser-print Navn/Point/Kommentar voting sheet,
  `@media print`, no new file-generation infra) and an **"Aktfordeling"** builder
  (replaces the revyst "Upload manus" button for boss/admin) that seeds a fixed Akt
  1/2/3/Ekstranumre skeleton from the *current* `data/scenes.json` (existing scenes keep
  every field — cast, priority, etc. — untouched) and lets Boss drag in not-yet-placed
  pool submissions, per-scene, with a manually-entered **Tidsestimat** (`duration`,
  minutes — reintroduced to the schema specifically for this, since the two reference
  PDFs the user shared show it and it's no longer auto-derivable). Saving reuses the
  *existing* boss-level `manus` resource (`{scenes, cast}`) — no new server-side
  scenes.json validator was needed, since `save_manus()` never validated per-scene shape.
  A `sourcePdf`/`sourceTex` pointer is carried onto each pool-originated scene so the later
  4.4 compile phase can find its `.tex`. Once `scenes.json` has any content, the pool
  columns become closed-by-default toggle sections and a read-only "Dette års manus" act
  list renders below. **"Intast point"** (voting results entry) was a stub button here —
  removed 2026-08-02, since voting/point entry will be handled outside the website
  entirely, not built into a later session as originally planned.
- **4.3 — Main Manus View (selection, act-building, roles, priority)** — [x] done
  2026-08-01. The single-modal Aktfordeling builder from 4.2 was retired and rebuilt as a
  boss/admin-only tabbed section on `manus.html` — **Vælg scener** / **Aktfordeling** /
  **Rollefordeling** / **Stjerneark** — all four sharing one flat draft-state row list
  (`manusDraft`, `js/manus.js`) so edits made in one tab survive switching to another,
  with a single shared "Gem" saving everything at once through the existing boss-level
  `manus` resource. Vælg scener replaces the old per-column Stemmeark/Point buttons and
  adds select/deselect per pool submission plus the duration field (moved from the old
  builder). (Amended 2026-08-02: selecting/deselecting a row only marks it locally until
  Gem — no separate confirm step; see the discard-flow amendment below.)
  Aktfordeling keeps the same drag-and-drop row model but renders acts as side-by-side
  kanban columns instead of stacked sections. Rollefordeling is the "assign cast/roles"
  half of this sub-phase — `ROLE_CATEGORIES`/`classifyRoleCode`/`classifyOrKeep` were
  **duplicated from `import.js`** into `manus.js` rather than reusing "Rediger Manus"
  directly (that tool stays on Øveplan, untouched — see CLAUDE.md's "Manus" section for
  why cross-file reuse wasn't a fit here, same reasoning Aktfordeling's row model already
  established in 4.2). Stjerneark is the scene-priority half: a real 0-3 `priority` is now
  persisted into `data/scenes.json` (this changes the schema's old "priority must always
  be 0 here" invariant — see CLAUDE.md's "Data schemas" section), with a scene that
  combines `dans`+`sketch`/`sang` shown as two independent rows (a new `dansPriority`
  field holds the "(Dans)" half's value) exactly like Øveplan's own dance-split display —
  `schedule.js`'s dance-split helpers were duplicated the same way the role-classification
  helpers were. A discard flow needed two small additions: a `data/config.json` +
  admin-level `config` resource naming the active `archive/<folder>` (no real "current
  season" concept exists yet, so this is a small manually-set stand-in, not a step toward
  full season-switching), and a boss-level server action that moves files between the
  archive and the pool. **Amended 2026-08-02**: the original one-way `manuscripts_discard`
  (moved a discarded submission's pdf/tex into `archive/<folder>/not_selected/` and
  permanently dropped it from `data/manuscripts.json`) was replaced by
  `manuscripts_sync_selection` — a bidirectional, idempotent reconciliation run silently on
  *every* Gem click rather than a separate explicit confirm step: every non-graduated pool
  submission's file is moved to `archive/<folder>/sketches/` or `.../songs/` (by type) if
  currently selected, or back to `archive/<folder>/submitted/` (renamed from
  `not_selected/`) if not — nothing is ever removed from `data/manuscripts.json` by this
  flow anymore, only the pre-existing ✕-button full-array-replace can still do that. A
  submission's `selected` state is no longer a separate persisted flag at all — it's
  derived purely from which of the three folders its file currently sits in. Uploads
  (`manuscripts_create`) now land directly in `archive/<folder>/submitted/` instead of the
  old flat `manus/<sketch|sang>/` pool folder, which no longer exists. `submitted/` folders
  (with a `.gitkeep` placeholder, renamed from `not_selected/`) exist in every non-jubilee
  `archive/MatRevy_<year>/` from 2019 through 2026; `MatRevy_2026` additionally got
  `sketches/`/`songs/` placeholders backfilled to match the older years' existing
  convention, and its ~32 existing pool submissions were migrated from `manus/sketch/`
  /`manus/sang/` into `submitted/` in the same pass.
  **Amended 2026-08-02**: the 4.2-era read-only "Dette års manus" act list (`renderYearView()`)
  was removed outright as redundant now that Vælg scener/Aktfordeling already show the same
  scenes with more control. Vælg scener's row filter changed from pool-origin rows only to
  every row of that type (`manusRowType()`/`manusRowTitle()` made origin-agnostic) — the old
  filter meant a submission vanished from Vælg scener the moment it graduated into an
  existing scene (i.e. after being placed in Aktfordeling and saved), which read as a bug
  ("scenes disappeared after I saved"); deselecting an existing scene there now sends it back
  to the `pool` lane exactly like a not-yet-placed submission. Aktfordeling's card
  (`renderDraftRowCard()`) dropped its type badge and duration field entirely — duration is
  still set in Vælg scener (which every row now passes through) and simply carried along into
  the save payload, just no longer shown or re-editable on the Aktfordeling card itself.
  **Still pending, deliberately not part of this sub-phase**: moving the *scheduling*
  scene-priority (0–3) selector and the Rekvisitten/per-cell cast-override tooling from
  `schedule.js`'s own sidebar into Manus's boss view — Stjerneark's priority is a
  different, persisted concept (see above), not a replacement for Øveplan's own
  per-rehearsal-day selector.
- **4.4 — `.tex` → PDF compilation & printing**: Aktoversigt/Rolleoversigt/Manuskript PDFs
  (the user shared 2025's real `Aktoversigt.pdf`/`Rolleoversigt.pdf`/`Manuskript.pdf` as
  reference, plus the original toolchain's lineage — `matrevy/matrevy.dk` → the actual
  generator, `matrevy/RevyTeX` — which unblocked this). Landed as `scripts/generate-pdfs.js`,
  a manually-run Node script (see CLAUDE.md's Manus section for the full breakdown) reusing
  the repo's already-vendored `manus/revy.sty` for typesetting, plain JS reimplementations of
  RevyTeX's `acts.pl`/`roles.pl` for the two data reports, and `pdf-lib` (the repo's first npm
  dependency, scoped to this one dev-only script) to merge per-scene PDFs into Manuskript —
  which folds in what would have been a separate 4.5 ("full manuscript assembly"), so that
  phase is retired as covered rather than tracked separately. A new Main Manus View tab,
  **Manus** (5th tab, between Rollefordeling and Stjerneark), added the actual per-scene
  script-text editing (`scriptBody`) — `data/scenes.json` stays the sole source of truth
  throughout; the generator only ever reads it and writes disposable `.tex`/build output, never
  back into `archive/<folder>/`'s stored `.tex` sources (a deliberate choice over
  round-tripping into GitHub `.tex` files, discussed and rejected earlier in the same session
  for its corruption risk on hand-authored LaTeX). A first version of the Manus tab's overlay
  also had a small per-scene metadata form (`status`/`melody`/`writtenBy`/`sourceProduction`/
  `sourceYear`); cut same-session as too much clutter — those `scenes.json` fields and
  `generate-pdfs.js`'s support for them are untouched, just nothing in the UI sets them anymore.
  Several same-session follow-ups closed real gaps rather than adding scope for its own sake:
  (1) auto-import (`manusImportFromTex()`) was broadened from "only a freshly-dragged pool row"
  to *every* row shown in the Manus **or** Rollefordeling tab, backfilling `scriptBody` and/or
  `row.cast` from whatever `.tex` is already uploaded; (2) each cast entry grew a
  `roleCode`/`description` pair (imported straight from the `.tex`'s own `\role{<code>}[<name>]
  <description>` line) — this was the exact "free-text per-cast-row role description" gap this
  phase originally deferred, and it mattered more than expected: without a real `roleCode`, the
  compiled `.tex`'s `\role{}` codes couldn't have matched an auto-imported `scriptBody`'s own
  pre-existing `\says{}`/`\sings{}` calls, which reference the *real* per-scene codes (`S1`,
  `D2`, ...), not an invented category+ordinal label; (3) Rollefordeling's cast editor itself
  was then reworked a second time, from a Kode/Navn/Beskrivelse/Type per-row form to editing the
  `\begin{roles}` block directly as LaTeX text in a textarea, updated only on an explicit
  "Opdater roller" click — mirroring the Manus tab's own "it's genuinely LaTeX, edit it as
  LaTeX" philosophy; (4) that summary was reworked a third time — one role per line
  (`<code> : <name>`, description dropped from the summary entirely, still only ever edited via
  the textarea) with the classification redone as **addable/removable tag chips**
  (`row.cast[i].tags: string[]`, replacing the earlier single `code` field) rather than a
  dropdown, since a role can genuinely be more than one thing at once (e.g. both "Dans" and
  "Koreograf"). Tags are edited directly and immediately in the summary (unlike code/name/
  description, which only change on "Opdater roller"), so that handler has to carry a
  `roleCode`'s existing tags forward by matching against the previous `row.cast` — otherwise
  every re-parse would silently wipe any tag added since the last click. `role` (what
  `schedule.js` classifies against everywhere else) is derived as `tags[0] || ''` at save time,
  never omitted as a key (an absent `role` would throw inside `schedule.js`'s own
  `classifyRoleCode()`, which calls `.trim()` on it unconditionally). Once every `row.cast` entry
  started always carrying a real `roleCode` by construction (the only way to create one is by
  parsing a `\role{<code>}[...]` line), the earlier fallback-label scheme
  (`castRoleLabels()`/`sceneCastLabels()`) became dead code in `manus.js` specifically and was
  removed there — it stays in `scripts/generate-pdfs.js` as a defensive net against legacy/
  hand-edited `scenes.json` cast entries with no `roleCode`.
  **Still deliberately deferred**: an in-browser "Generér PDF'er" button that compiles
  on demand, synchronously (Simply.com's PHP host has no LaTeX/Perl, so this would need a
  separate always-on compile service — see the CI automation below for the alternative that
  was actually built instead); pixel-exact fidelity to the original's tab-sidebar/bookmark
  styling in Manuskript.
  **Follow-up session (2026-08-03), verified end-to-end + individual manuscripts added**:
  installed BasicTeX locally and ran `node scripts/generate-pdfs.js` against real production
  data for the first time — the pure-logic/dummy-PDF smoke test above had never caught two
  real bugs, both fixed in this session: `scenes.json`'s `production` field bakes the year
  into the name string, which was silently duplicating the year on every title page once
  combined with the separately-parsed `\revyyear{}` (`prodMeta.name` now has the trailing
  year stripped back out); and `buildAktoversigtTex()`'s preamble was missing
  `\usepackage[T1]{fontenc}`, breaking Danish `å`/`æ`/`ø` rendering on that one document only.
  Per-scene `.tex` also gained `\usepackage{amsmath,amssymb}` unconditionally, since a math
  revue's `scriptBody` routinely contains real math notation. Also added the "individual
  manuscripts for each revyst" deliverable originally scoped alongside this phase: the old
  single-purpose `buildManuskript()` became a shared `buildManuskriptPdf(..., {skuespillerName,
  sceneFilter})`, reused unchanged for the master `Manuskript.pdf` (blank "Skuespiller:" line,
  no filter) and for one new personalized PDF per `data/cast.json` roster entry
  (`buildActorManuskripts()`, output to `archive/<folder>/manuskripter/<Name>.pdf`, filtered to
  just that person's own scenes, generated unconditionally even for someone cast in nothing).
  `data/scenes.json`'s stale `production`/`_schema` ("...2024") was also corrected to 2026 to
  match `config.json`'s `currentProductionFolder`, since every generated title page reads it.
  **Follow-up session (2026-08-04), Rolleoversigt format pass + CI automation**: iterated
  `buildRolleoversigtTex()` against user feedback into its current shape — the page's running
  header (revyname/version/date/Side-X-of-Y + a horizontal rule) is gone entirely
  (`\pagestyle{empty}`, replacing revy.sty's default `revyheadings`), leaving just a centered
  "`<revyname> <year>`"/"Rolleoversigt" title above the table. Both are vertically centered as
  one unit on the page via `\vbox to \textheight{\vfil ... \vfil}` — a bare page-level
  `\vfill`/`\vfil` (even `\null`-anchored) turned out to be genuinely unsafe here, since TeX's
  page-breaker can treat it as a near-zero-badness break point and split the title from the
  table onto separate pages entirely (reproduced firsthand); wrapping both in one explicit,
  atomic `\vbox to <height>` sidesteps that. Physical margins are symmetric on all four sides
  via a single clean `geometry` call (`margin=15mm`, `headheight=0pt`/`headsep=0pt`/
  `footskip=0pt` since there's no header/footer to reserve space for) — the previous approach
  of overriding raw `\textwidth`/`\textheight`/`\headsep` registers *after* loading `geometry`
  left top and bottom asymmetric, since geometry has no way to know about dimensions changed
  post-load. The table itself first tries to fill `\textwidth` (as before); only if that would
  overflow the height budget left after the title block does it get measured and rescaled to
  fit the height instead — verified against synthetic fewer-scenes (11) and many-more-scenes
  (96, 3×) variants, confirming this generalizes correctly to any future season's scene/actor
  count without a hardcoded size to re-tune by hand. This measure-then-rescale step must use
  the *starred* `\resizebox*`, not the plain form — plain `\resizebox{!}{<height>}` only pins
  `\ht` (above baseline), silently leaving `\dp` (a tabular's last-row depth) to scale along
  uncontrolled, which undershot the intended total height by nearly 2× before this was caught
  via an isolated minimal reproduction. Also added: a new `generate-pdfs.yml` GitHub Actions
  workflow, firing on the exact same `data/scenes.json`/`cast.json` push trigger as
  `embed-scenes.yml` (installs LaTeX via `apt-get`, runs `generate-pdfs.js`, commits the
  resulting PDFs back — rebasing onto `origin/main` before its own push, since this job runs
  far longer than `embed-scenes.yml`'s and the faster workflow may already have pushed from the
  same trigger by the time this one is ready) — **not yet verified against a real Actions run**,
  since that can't be exercised from this environment; the `apt` package list is a best-effort
  mirror of BasicTeX's default scheme (which needed zero `tlmgr` extras locally) and may need a
  package added on the first real trigger. One new button in Main Manus View ("Generér PDF'er",
  `.site-pill-warm`, next to Gem) calls `manusRegeneratePdfs()` — initially built as three
  separate, identically-labeled-per-document buttons (a deliberate simplification agreed with
  the user over a true per-document `--only` rebuild, since Manuskript is a merge of every
  other scene PDF and a partial rebuild risks the three drifting out of sync), then collapsed
  into the one button once the user pointed out three buttons that always did the exact same
  thing was pure redundancy. That function needs no new server endpoint: it re-saves the currently-effective (not draft) scenes/cast
  through the existing boss-level `manus` resource path, and `save_manus()` already re-stamps
  `scenes.json`'s `version` to today's date on every save regardless of payload content — so
  even an otherwise-unchanged resave reliably produces a fresh commit, and GitHub's
  push-path trigger fires on any commit touching the path, not on an actual content diff. This
  needed a new `manusCurrentActsPayload()` (the inverse of the existing `manusFlattenActs`) to
  turn `getEffectiveScenesData()`'s flat, already-saved shape back into the nested acts payload
  the save endpoint expects, without needing a live edit draft to build from. `manus.html` also
  gained a `config-data.js` load (dropped earlier in Phase 4.4 as then-unused) purely so this
  feature can read `CONFIG_DATA.currentProductionFolder` rather than hardcoding it.
  **Same-day follow-up**: the file-open links were relocated per user feedback, from inline text
  links below the "Generér ..." buttons to their own dedicated card (`#manus-pdf-links`,
  `renderManusPdfLinksSection()`) between the pool/guide row and Main Manus View — four real
  `.btn-small` buttons ("Aktfordeling"/"Rollefordeling"/"Manus"/"Individuel Manus", named after
  the tab a boss would associate each document with rather than the PDF's own filename) instead
  of a plain link list. The first three open Aktoversigt/Rolleoversigt/Manuskript directly;
  "Individuel Manus" opens `siteOpenDropdownPicker()` (the same anchored popup Rollefordeling's
  own tag-adder already uses) listing every cast member, opening whichever one's
  `manuskripter/<slug>.pdf` was picked — needing a small client-side `manusSlugifyName()`
  duplicate of the script's own transliteration table, since none of today's roster names
  happen to contain æøå but a future one might. Verified in a real headless-browser pass
  (Playwright, per the `verify` skill) rather than just reading the code: confirmed zero console
  errors, the section's boss-only gate, and — after an initial false alarm where
  `page.url()` reported a bare `":"` for the newly-opened PDF tab, a known Chromium/Playwright
  quirk around its built-in PDF viewer rather than a real bug — the actual underlying network
  request via a context-level listener, which showed the correct
  `archive/<folder>/{file}.pdf` URL being requested every time.
  Two more refinements same day, both from further user feedback: (1) the three "Generér ..."
  buttons (one per document) were noticed to all call the exact same code with no actual
  per-document behavior — collapsed into one "Generér PDF'er" button, since three identically-
  behaving buttons were pure redundancy, not a real per-document capability; (2) the whole
  `#manus-pdf-links` card's gate was lowered from boss to **revyst** — any cast member benefits
  from reading Aktoversigt/Rolleoversigt/Manuskript/their own manuscript, not just bosses —
  *except* "Generér PDF'er" itself, moved into this same card as a second, left-aligned row
  (`align-self: flex-start`, opting out of the column's default stretch) but re-gated to
  `siteHasLevel('boss')` specifically for that one button, since unlike the four read-only
  open-file buttons above it, this one actually triggers a rebuild. The four file buttons
  initially gained `flex: 1` each (`.manus-pdf-links-row`) so they were equal width and evenly
  filled the row, matching `.manus-tab-bar`'s own folder-tab sizing — then reverted the same day
  on further feedback ("quite ugly"): switched from `.btn-small`/`flex:1` to the oval
  `.site-pill-btn` style (normally reserved for modal contexts, used here anyway on explicit
  request) sized to each label's own content width instead, with "Generér PDF'er" itself getting
  `.site-pill-warm`'s amber tint to stand out from the four neutral open-file buttons above it.
  Re-verified with the same Playwright approach across all three levels (revyst/boss/admin) to
  confirm the split gate renders correctly at each.
  **Third same-day round**: (1) the four PDF-links buttons got their own explicit orange tint
  (`.site-pill-warm` added), centered as a group (`justify-content: center`) with equal
  width forced to the widest label (`Individuel Manus`) via a one-time `getBoundingClientRect()`
  measurement once they're all in the live DOM — there's no clean pure-CSS way to size flex
  siblings off the widest sibling's own content; (2) "Generér PDF'er" moved back *out* of the
  PDF-links card and into Main Manus View's own action row, bottom-left corner, opposite Gem —
  once the PDF-links card itself became revyst-readable, this one write-triggering button needed
  to stay under Main Manus View's existing boss gate instead of a second per-button check; (3) a
  new "Gemt"/"Ikke gemt" save-status indicator next to Gem, modeled on Budget's own
  `.budget-save-status`/`markSheetDirty()`/`beforeunload` trio but explicitly **not** an autosave
  (the user was specific: track only, never save in the background). Rather than a dirty flag set
  at every mutation call site (Budget's approach), a plain `JSON.stringify(manusDraft)` snapshot
  is captured once inside `manusInitDraft()` (the one function that only ever runs when nothing
  is genuinely unsaved — page load, or right after a successful Gem resets the draft to force a
  fresh one), then re-diffed on a 500 ms `setInterval` — chosen over instrumenting call sites
  because several edit paths (the Manus tab's `scriptBody` textarea, Stjerneark's priority
  circles) deliberately mutate the draft *without* re-rendering, to avoid disrupting typing/UI
  state, so a flag set only from render-triggered sites would silently miss them. Verified live:
  clicking a real draft mutation (a Vælg-scener row) flips "Gemt" → "Ikke gemt" within one poll
  tick, and a real `beforeunload` dialog (confirmed via Playwright's `dialog` event, not just
  reading the handler code) fires and blocks navigation while dirty.

**Status**: 4.1 + 4.2 + 4.3 done 2026-08-01 (needs the usual manual `update-data.php`
re-upload to Simply.com before live on `matematikrevy.dk`). 4.4 done 2026-08-03, **verified
end-to-end the same day** against a real local BasicTeX install (see the follow-up note
above) — `node scripts/generate-pdfs.js` now compiles all 32 scenes plus Aktoversigt/
Rolleoversigt/Manuskript and 35 individual manuscripts cleanly, checked directly against the
reference PDFs.

---

### Phase 5 — Budget / økonomistyring

**Intent**: digitise the revue's `Regnskab.xlsx` workflow so it's live and multi-user —
revyster submit reimbursement requests (kategori, beløb, navn, telefon, kvitteringsfoto,
kommentar); the kasserer approves them into a paid ledger (assigning the next
bilagsnummer, renaming the receipt to `<kategori>_<n>.jpg`); and an editable budget
sheet tracks planned numbers with spent/balance derived from the ledger.

**Key architecture decision** (new for the site): the budget data is **private** — it holds
names, phone numbers and receipt photos, so it must NOT go in the public repo. It lives as
plain files on the Simply.com PHP host under `BUDGET_DATA_DIR`, read/written only through
authenticated actions on `update-data.php` (`budget_submit`/`budget_read`/`budget_receipt`/
`budget_approve`/`budget_request_reject`). This is a deliberate exception to the
embed-pipeline pattern — the budget feature never touches `scripts/embed-scenes.js`, the
workflow, or `data/*.json`. It is also the site's **first revyst-level write**.

**Status**:
- [x] Phase 5.1 — reimbursement loop, built 2026-07-12. `budget.html`/`budget.js`/
  `budget.css`; revyst submit form; admin pending list + approve/reject + read-only paid
  browser. Deployed to Simply.com (`BUDGET_DATA_DIR` created, `.htaccess`-denied). Live
  debugging surfaced three bugs, all now fixed: (1) receipt image helpers were referenced
  from archive.js which isn't loaded on budget.html → now self-contained in budget.js with a
  `createImageBitmap`→`<img>`→original-bytes fallback so iPhone/HEIC photos upload; (2) a
  **PHP const-ordering** fatal — top-level `const`s are registered in execution order, so
  ones declared below the early action dispatch were undefined at call time (this had also
  silently broken **archive** cover/manus uploads — see Phase 3 note); (3) the client showed
  "Tak!" on a `200`+HTML PHP error → `budgetApi` now requires an `{ok:true}` JSON body.
  **Verified live end-to-end 2026-07-12** — user re-uploaded the fixed `update-data.php`
  and confirmed a real submit→approve round-trip works (archive uploads fixed in the same
  pass).
- [x] Phase 5.2 — built 2026-07-12. Editable budget sheet (`renderBudgetSheet` in
  budget.js): a **planned** amount per category with **Brugt** (= sum of that category's
  expense `amount`) and **Rest** computed live, an editable **income** list, and a net
  result. 15-min autosave (`setInterval` guarded to register once) + `beforeunload` guard on
  a dirty flag, plus a manual "Gem budget" button; a reload triggered by any expense/request
  action flushes unsaved sheet edits first (`reloadAdmin`/`saveBudgetSheetIfDirty`).
  Admin-added **direct expenses** (`openExpenseAddModal`, optional receipt) and
  **request/expense editing** (`openRequestEditModal`/`openExpenseEditModal` — expense
  category locked, keeping bilag + receipt stable). New `budget.json` schema
  `{planned:{key→n}, income:[{id,label,amount}], updatedAt}`. Server: four admin actions
  (`budget_save_sheet`/`budget_expense_add`/`budget_expense_update`/`budget_request_update`)
  + a shared `budget_next_n()` refactor, all hoisted functions (const-ordering landmine).
  **Pending live deploy**: re-upload `update-data.php` to Simply.com, then verify end-to-end.
- [ ] Later — reimbursement-owed rollup (Excel's "Udlægsholder/Udlæg"), closer parity
  with the full Excel. (Export/backup of the private datastore is now folded into
  Phase 13.)

---

### Phase 6 — Access-level expansion + nav reorder

**Intent**: foundation for everything below — inserts the "boss" level between revyst and
admin, reorders/relevels the nav to the user's full 8-page vision, and adds stub pages for
the two pages that don't exist yet (Wiki, Koordinator). Small and self-contained on
purpose, so Phase 4 (Manus) can build on a working boss login immediately.

**What was built**:
- Four-level rank (`public`/`revyst`/`boss`/`admin`) threaded through `js/site.js`
  (`SITE_LEVEL_RANK`, `getSiteAuth`, the login response validator, the generalized
  `buildSiteNavLinks` rank rule) and `server/update-data.php` (`password_level()`,
  `$LEVEL_RANK`, `$RESOURCES`), plus a new `BOSS_PASSWORD` in `config.example.php`/
  `config.php`.
- `SITE_PAGES` reordered/relevelled to: Forside (public), Kalender (public — was
  revyst), Arkiv (revyst), Wiki (revyst, new stub), Budget (revyst), Manus (revyst),
  Øveplan (boss — was admin), Koordinator (boss, new stub).
- `manus`/`calendar` resources in `$RESOURCES` moved from `admin` to `boss`; `calendar.js`
  and the password-resolution helpers (`site-utils.js`'s `siteResolvePassword`,
  `import.js`'s manus-save flow) updated so a boss login is trusted for these saves
  instead of forcing a redundant admin-password prompt. `announcements`/`archive` stay
  `admin`-only (unaffected — their boss-authored content is Phase 7/8).
- New stub pages `wiki.html`/`koordinator.html`, matching `manus.html`'s existing
  pre-Phase-4 stub pattern.

**Status**: [x] done 2026-07-14, verified end-to-end with a headless-browser drive of all
four levels (nav contents + page-gate behavior for public/revyst/boss, admin implied by
rank) — see verification notes below. Needs a real `BOSS_PASSWORD` value + a manual
`update-data.php`/`config.php` re-upload to Simply.com before this is live in production
(local dev config uses a placeholder).

---

### Phase 7 — Wiki

**Intent**: structured FAQ/knowledge-base for general revyst info (not a forum) — same
editorial pattern as Announcements/Kalender/Arkiv.

**What was built** (2026-07-18, planned against a user-supplied work-in-progress PDF
handbook, "Revyhåndbogen"; reworked 2026-07-25 to the model below): a flat list of
rich-text **chapters** — `{id, title, body}`, one record per chapter, no category
grouping. The original plan called for a flat "articles + free-text category" model
(reusing the existing data-driven-page pattern verbatim), but once real content was in
place a chapter read/edited better as one continuous piece of text than as a stack of
same-category articles, so the category level was collapsed away — see CLAUDE.md's
"Wiki" section for the full current architecture (in-place rich-text edit view with a
formatting toolbar, per-chapter `h2`-driven outline in the left column, sanitized-HTML
storage). `data/wiki.json` (`chapters: [{id, title, body}]`) + embedded
`wiki-data.js`; `wiki` resource in `$RESOURCES` at **boss** level (matches
Kalender/Manus/Posts-edit, not Arkiv's admin-only); revyst+ read-only on `wiki.html`.
Chapters originally could also each attach one PDF (uploaded via the same generic
`upload`/`delete` action Arkiv uses, gated per-path-prefix rather than a single
hardcoded `admin` check); that attach/detach feature was removed 2026-08-01 as
unneeded — chapters are text-only now, and `upload_path_level()`/the server's
`WIKI_PATH_RE` regex were removed along with it, leaving `upload`/`delete` admin-only
again (Arkiv's cover/manus paths). Seeded from the
PDF's sections that already had real prose (Velkommen, Hvem må være med, the six group
descriptions, Nyttige links) — empty stub sections from the PDF were **not** seeded as
placeholder chapters; boss/admin add them once there's real content. One
credential-looking string in the PDF's Nyttige Links page was deliberately left out of
the seed, since `data/wiki.json` lands in the public repo. A follow-up pass
(2026-07-25/08-01) polished the reading experience: the left column's chapter list
(and the selected chapter's outline) is sticky, pinned 20px below the site header
while the right column scrolls under it; the outline highlights whichever `h2` section
is currently scrolled into view and jumps to a section with one click; switching
chapters scrolls the right column back to the top without visibly moving the sticky
left column (an instant jump, not animated — animating it fought the browser's own
scroll-position clamp when a long chapter's content is replaced by a much shorter
one, producing a visible "snap-then-glide" double motion).

**Status**: [x] done — built and verified locally (headless-browser drive across
public/revyst/boss/admin levels + mobile viewport, see CLAUDE.md). Like every other
phase touching `server/update-data.php`, the live save/upload round-trip needs a
manual re-upload of that file to Simply.com before it works on `matematikrevy.dk`.

---

### Phase 8 — Forside dashboard v2

**Intent**: right-hand general-info card (names of the year's coordinators, etc.) plus a
second post section for boss/admin-only "coordinator" notes, alongside the existing
revyst-facing announcements.

**What was built** (2026-07-16, superseding the original "extend announcements.json's
level enum" idea once real requirements emerged mid-session): a genuine two-board forum,
not just a second announcements section — `data/posts.json` (new resource) rendered as
two equal-width, equal-fixed-height columns (`.dashboard-columns` in `style.css`, 420px
with internal scroll, stacking on mobile) below the existing untouched announcements
card, with "Årets bosser" full-width below that. Left/general board: revyst+ can create,
only boss/admin can edit/delete (no per-post ownership — there's no per-user login).
Right/boss board: boss/admin only end-to-end, visible read-only to revyst, absent
entirely below revyst level. This is the site's first write split across two mechanisms
against the same **public, git-backed** file: a new revyst-level **append-only** server
action (`posts_create`, its own `$POST_ACTIONS` table, forces `board='general'` for any
non-boss caller) alongside the usual boss/admin full-array-replace (`posts` resource in
`$RESOURCES`) for edit/delete — see CLAUDE.md's "Data-driven pages" section for the full
architecture writeup. Also folded into this session: `.page-content`'s site-wide default
width was bumped from 900px to 1200px (matching Arkiv/Kalender/Budget, which no longer
need their own override) per user request, since the new two-column layout looked
cramped at the old width.

**Left open / follow-up**: "Årets bosser" is still hand-edited directly in `index.html`
(the real 2026 names are there now) rather than its own admin-editable resource — revisit
if that becomes annoying to update by hand next season. The real `posts_create`/edit/
delete round-trip is unverified against the live Simply.com endpoint (needs the usual
manual `update-data.php` redeploy first); only local UI/permission-gating was verified
headlessly.

**Status**: [x] mostly done — layout, permissions, and client/server code built and
verified locally (three access levels, scroll/mobile behavior); pending a live
`update-data.php` redeploy to Simply.com before real posts can be created/edited on
`matematikrevy.dk`.

---

### Phase 9 — Kalender polish

**Intent**: visual styling pass (Kalender currently has none), plus a calendar-subscribe
`.ics` feature.

**Expected outcomes**: styling pass on `kalender.html`/`calendar.css`. `.ics` subscribe:
an unguessable per-viewer link (accepted trade-off, see Architecture Decisions) via a new
`calendar_feed` server action serving `text/calendar`, guarded the same way
`budget_receipt` guards its file path.

**Status**: [x] done 2026-07-15 — `.page-content` widened to 1200px (matches Arkiv/Budget);
every button on the page unified under the site's warm-amber hover treatment (with an
actual `transition` added to `.btn-small`/`.site-btn-warm`, previously an instant color
swap), Gem/Annuller order swapped so Gem lands on the right. Categories became 5: Manus
(green), Øvning (yellow), Forestilling (red), Deadline (blue), Andet (purple). Events
now support multi-day spans via an `endDate` field. A month-grid chip click always opens
the read-only detail modal (same as a revyst sees); boss/admin get a "Rediger" button there
into the edit form instead of jumping straight to editing — list view's existing
Rediger/Slet buttons are unchanged. **`.ics` feed shipped as a static file, not the planned
live PHP endpoint**: `data/calendar.json` is already fully public (the page is
`public`-level, the repo is public), so a "secret" token gating a PHP round-trip would be
obfuscation, not real security. Instead `scripts/embed-scenes.js` gained a `raw: true` output
mode generating `calendar.ics` (RFC 5545) at the repo root, served directly by GitHub Pages
at `matematikrevy.dk/calendar.ics` and regenerated by the existing `embed-scenes.yml` — no
new server code, config secret, or PHP-host dependency for calendar apps to poll. An
always-visible "Abonnér" button links visitors to the feed URL.

---

### Phase 10 — Budget final styling + SMS-on-reject

**Intent**: remaining visual polish, plus letting an admin text a revyst member when
their expense is denied.

**Expected outcomes**: styling pass on `budget.css`. SMS: an `sms:<phone>?body=...` link
shown after `Afvis` (opens the admin's own Messages app pre-filled — no server-side SMS
sending, no new infra). `phone` is already a required field on every request
(`budget.js`), so no data-model change needed.

**Status**: [x] done (styling) — the `budget.css` pass shipped as part of the site-wide
pill-button/warm-theme rollout (confirm dialogs on `Afvis`/`Godkend`/etc. already use the
shared `.site-pill-btn` system; inputs and buttons already use the honey/walnut palette —
see CLAUDE.md's Budget section). **SMS-on-reject was discussed 2026-07-16 and parked, not
built** — see "Later / parked" below for the two designs considered.

---

### Phase 11 — Øveplan final touches

**Intent**: last round of polish on the scheduling tool.

**Expected outcomes**: a pause/break-between-segments control when building the grid
(`buildGrid()`/segment config in `schedule.js`); removing the "Rediger manus" button (now
moved to Manus, Phase 4.4); further small notes from the user as they come up.

**Status**: [ ] not started

---

### Phase 12 — Koordinator

**Intent**: a private notes board for boss/admin — "top secret", meeting notes and
similar, not yet fully specified beyond v1 shape.

**Expected outcomes**: chronological notes board (title, body, optional file
attachment), boss/admin post — same pattern as Forside announcements/Phase 8. New
`koordinator` resource; page already registered at `boss` level (Phase 6).

**Status**: [ ] not started

---

### Phase 13 — Season/year switching (last)

**Intent**: let admin start a new production year while keeping every previous year
fully accessible — deliberately last, since it needs Manus/Budget/Øveplan's data shapes
to be stable first.

**Expected outcomes**: namespace `data/<year>/scenes.json` + `cast.json` under a year
(and the private Budget store on the PHP host similarly), plus a "current year" pointer
and an admin "New season" action. Nothing is ever destructively cleared — old years just
stop being current. Also where the private-budget-data backup task (previously parked,
see Phase 5 note above) finally gets addressed, since both are about the private
datastore's durability across seasons.

**What was built** (diverges from the original "namespace `data/<year>/...`" idea above —
see the user's own explicit steer at build time: old Manus years don't need to stay live
in-app, only reachable via GitHub, so a reset+archive approach was simpler than a full
namespace):
- **Manus/Øveplan** — a new admin-only tool on the previously-stub `koordinator.html`
  (`js/koordinator.js`). "Afslut produktionsår" is a two-step flow: step 1 just points the
  admin at Manus's own existing "Generér PDF'er" button (now also — see below — persisting
  each scene's final composed `.tex`, not just its PDF, into `archive/<folder>/`) with a
  "Tjek om klar" freshness poll; step 2 opens a form that runs four sequential saves
  through the *already-existing* boss/admin resource-save endpoints (no bespoke close-year
  server action was needed): fetch the closing year's raw `scenes.json`/`cast.json` off
  GitHub, add an `archive` entry for the closing folder if none exists yet, upload that
  raw JSON as a permanent snapshot to `archive/<folder>/snapshot/{scenes,cast}.json`, reset
  the `manus` resource (scenes/cast) to an empty 4-act skeleton, reset `manuscripts` to
  `{submissions:[]}`, then switch `config`'s `currentProductionFolder` to the new folder.
  `scripts/generate-pdfs.js` was extended (`deriveSourceTexPath`) to write the exact
  composed `.tex` it already builds for each scene back into
  `archive/<folder>/{sketches,songs}/<slug>.tex` (previously discarded after compiling) —
  so both the archived `.tex` and the archived PDF always match the final edited content.
  `server/update-data.php` gained `ARCHIVE_SNAPSHOT_RE` (an admin-level upload path for the
  snapshot JSON) and widened `ARCHIVE_PATH_RE` to also accept `Manuskript.pdf`. Øveplan
  needed no server-side change at all — it's purely `localStorage`-based (see "`schedule.js`
  architecture" in CLAUDE.md) and just picks up the reset data next time it's opened fresh.
- **Budget** — the private PHP datastore is now namespaced per year:
  `BUDGET_DATA_DIR/<year>/{budget,requests,expenses}.json` + `receipts/`, plus a root-level
  `years.json` manifest (`{activeYear, years:[{year,label,createdAt}]}`). Every admin-level
  budget action now accepts an optional `{year}` (`budget_resolve_year()`, defaulting to
  the active year) so the admin can view/correct a past year (e.g. "Tilføj udgift")
  independent of which year is active; `budget_submit` (revyst) always resolves the active
  year server-side and never trusts a client-supplied year. Two new single-purpose admin
  actions, `budget_create_year` (seeds the new year's `planned` from the currently active
  year, per the user's explicit ask) and `budget_set_active_year` (flips which year new
  uploads land in) — kept separate so re-activating an already-existing past year needs no
  recreation. `budget.html`'s admin view gained a year-toolbar ("Ser: <year>" vs. a
  read-only "Aktivt år" badge, plus "Start nyt budgetår") in `js/budget.js`. No migration
  of the old flat (pre-this-phase) budget files was built — that data was disposable test
  data, deleted as part of deploying this. The private-budget-data backup task mentioned
  above is still unaddressed — this phase only namespaced the data by year, it didn't add
  git/off-host backup.

**Status**: [x] done (2026-08-20) — the private-budget-data backup task noted above remains open

---

### Later / parked

- **Auto-place algorithm (schedule tool)** — implemented once, then deliberately removed
  for a future redesign. Original spec: greedy placement of priority scenes respecting
  cast conflicts and absences, auto-placed cells visually distinct, re-runnable, with a
  placement summary. Priority 0–3 in the sidebar is currently a manual aid only.
- **Real per-user login** — only if the shared-password model ever stops being enough.
- **Compile a video scene's manus field into the PDF pipeline** — Manus's "Vælg
  scener" tab now has a "Videoer & Bandsange" panel letting a boss write a
  video/bandsang scene's manus (LaTeX) field, same as sketches/songs. Bandsang
  is already compiled (`scripts/generate-pdfs.js`'s `isSongScene()`/`hasScript()`
  already treat it as song-like), but `hasScript()` still excludes `video` on
  purpose — a video's manus text is saved to `scenes.json` but never gets its
  own compiled scene PDF or a slot in `Manuskript.pdf`. Revisit once there's a
  real need; deciding which LaTeX environment to typeset it in is the open
  question, since `revy.sty` has no dedicated `video` environment (`sketch` is
  the obvious fallback).
- **SMS-on-reject (Phase 10)** — discussed 2026-07-16, not built. Two designs considered:
  a zero-infra `sms:<phone>?body=...` link (opens the *admin's own* Messages app,
  pre-filled with a Danish template built from name/amount/category) — no cost, no server
  code, but the text comes from the admin's personal number, not "MatRevy"; or a branded
  sender (an SMS gateway's alphanumeric sender ID showing "MatRevy", or a dedicated leased
  virtual number) — requires a paid third-party SMS provider account, an API key stored
  server-side (`config.php`, same pattern as `GITHUB_TOKEN`), and a new `update-data.php`
  action that actually sends the SMS. The user wants the branded sender if this is ever
  built, but decided the account setup isn't worth it right now — revisit if it becomes
  worth the overhead.

---

## History (completed sub-tasks)

### Scheduling tool (core) — done
Grid-based rehearsal planner (`schedule.html`/`schedule.js`): rooms × time slots,
scene picker with conflict/absence tags, per-cell cast editor, custom scenes
(Scenemøde/Rekvisitten), dance/actor splits, absences, print stylesheet,
localStorage persistence. See CLAUDE.md for the full architecture.

### Manus edit tool with global save — done (2026-07-11)
"Rediger Manus" modal (`import.js`) edits the whole catalog (manual + `.tex` upload,
role classification) and saves globally: POST to `server/update-data.php` on
`https://manus.matematikrevy.dk` (Simply.com — GitHub Pages can't run PHP), which
commits `data/*.json` via the GitHub Contents API; `embed-scenes.yml` regenerates
`scenes-data.js`; the saving tab sees its change immediately via an in-memory shadow
(`manus-data.js`). Deploy gotchas (subdomain + double CNAME for Let's Encrypt,
Simply.com WAF challenges, PHP 4-space JSON reindentation) are documented in CLAUDE.md.
