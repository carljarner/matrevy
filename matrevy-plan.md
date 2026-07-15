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

**Intent**: supersedes the original one-line placeholder now that requirements exist
(gathered 2026-07-14). The full flow the user wants: revyster upload `.tex`/`.pdf` for
scenes they've written → boss selects/lays out which scenes make the cut → boss assigns
cast/roles → the site compiles `.tex` sources into manuscript PDFs. This is the biggest
change on the roadmap and the next thing to build (session order: 4.1 → 4.2 → 4.3 → 4.4 →
4.5 → 4.6, though each may be its own session).

**Resolved design decisions**: one-stage data model — revyst uploads write directly into
the production catalog (`data/scenes.json`-equivalent) with a `status` field, rather than
a separate submissions store; once a season's manus is finalized, the submit/upload UI is
simply removed for that season. PDF generation is a GitHub Action running a LaTeX engine
on push, the same pattern as `embed-scenes.yml`.

**Sub-phases**:
- **4.1 — Upload**: revyst uploads `.tex`/`.pdf` for scenes they've written, writing
  directly into the catalog with a `status` (e.g. `submitted`/`selected`/`cut`). This is
  the first revyst-level write to the *production catalog itself* (unlike Budget's
  separate private store) — needs a dedicated design pass on scoping it safely (a revyst
  user should only add new submissions or edit their own still-pending ones, never touch
  someone else's or an already-selected scene). Open question for this session.
- **4.2 — Selection & layout**: boss chooses which submitted scenes make the cut and
  arranges act structure/order (`status` submitted→selected/cut; act/number assignment)
  — reuses `import.js`'s existing act-grouping/drag-reorder UI.
- **4.3 — Role assignment**: boss assigns cast/role-categories per scene — exactly
  `import.js`'s existing per-scene cast editor; reused directly.
- **4.4 — Move priority + cast-editing from Øveplan into Manus**: the scene-priority
  selector and Rekvisitten/per-cell cast-override tooling currently in `schedule.js`'s
  sidebar relocate to Manus's boss view; the "Rediger manus" entry point moves off
  Øveplan's sidebar onto the Manus page (`import.js`'s modal logic is reused, only its
  entry point and host page change).
- **4.5 — `.tex` → PDF compilation**: new GitHub Action (e.g. `compile-manus.yml`),
  triggered like `embed-scenes.yml`, runs a LaTeX engine and commits generated PDFs back
  to the repo. **Blocked on the user sharing example `.tex`/PDF files** — need real
  package/class dependencies before picking an engine (tectonic vs. a full texlive
  image) and the generated-file layout (per-actor scripts? full manus?).
- **4.6 — Full manuscript assembly**: combine the season's selected/laid-out scenes into
  one `manus.tex` → `manus.pdf`, feeding Arkiv's existing `manusPdf` slot once the season
  is archived.

**Status**: [ ] not started — 4.1 is the next session; needs Phase 6 (boss level) live
first, and example `.tex`/PDF files from the user before 4.5/4.6 can be scoped.

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

**Expected outcomes**: `data/wiki.json` (articles: title, category, body) + embedded
`wiki-data.js`; boss/admin write via a new `wiki` `$RESOURCES` entry; revyst+ read on
`wiki.html`. Content itself (FAQ text) comes from the user, continuously.

**Status**: [ ] not started

---

### Phase 8 — Forside dashboard v2

**Intent**: right-hand general-info card (names of the year's coordinators, etc.) plus a
second post section for boss/admin-only "coordinator" notes, alongside the existing
revyst-facing announcements.

**Expected outcomes**: likely extends `announcements.json`'s `level` enum with a third
value (e.g. `boss`) rendered in its own Forside section — reuses the existing
`announcements.js`/editor code almost entirely. General-info card contents (coordinator
names, etc.) probably need their own small admin-editable resource rather than being
hardcoded.

**Status**: [ ] not started

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
(green), Øvning (yellow), Forestilling (red), Deadline (blue), Andet Revy (purple). Events
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

**Status**: [ ] not started

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
