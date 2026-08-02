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

**Sub-phases** (session order 4.1 → 4.2 → 4.3 → 4.4 → 4.5, each its own session):
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
  A `sourcePdf`/`sourceTex` pointer is carried onto each pool-originated scene so a future
  4.5 compile phase can find its `.tex`. Once `scenes.json` has any content, the pool
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
  **Still pending, deliberately not part of this sub-phase**: moving the *scheduling*
  scene-priority (0–3) selector and the Rekvisitten/per-cell cast-override tooling from
  `schedule.js`'s own sidebar into Manus's boss view — Stjerneark's priority is a
  different, persisted concept (see above), not a replacement for Øveplan's own
  per-rehearsal-day selector.
- **4.4 — `.tex` → PDF compilation & printing**: Aktoversigt/Rolleoversigt/per-person
  manuscript PDFs (the user shared 2025's real `Aktoversigt.pdf`/`Rolleoversigt.pdf` as
  reference — an act-numbered scene list with duration, and a scene-by-cast role matrix,
  respectively). **Blocked on the user sharing the LaTeX/PDF-generation repo** they
  previously used — need real package/class dependencies before picking an engine
  (tectonic vs. a full texlive image) and deciding whether this reuses a GitHub Action
  (like `embed-scenes.yml`) or renders client-side.
- **4.5 — Full manuscript assembly**: combine the season's selected/laid-out scenes into
  one `manus.tex` → `manus.pdf`, feeding Arkiv's existing `manusPdf` slot once the season
  is archived.

**Status**: 4.1 + 4.2 + 4.3 done 2026-08-01 (needs the usual manual `update-data.php`
re-upload to Simply.com before live on `matematikrevy.dk`). 4.4/4.5 need the user's LaTeX
repo before they can be scoped.

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

**Status**: [ ] not started

---

### Later / parked

- **Auto-place algorithm (schedule tool)** — implemented once, then deliberately removed
  for a future redesign. Original spec: greedy placement of priority scenes respecting
  cast conflicts and absences, auto-placed cells visually distinct, re-runnable, with a
  placement summary. Priority 0–3 in the sidebar is currently a manual aid only.
- **Real per-user login** — only if the shared-password model ever stops being enough.
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
