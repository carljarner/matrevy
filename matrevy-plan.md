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
- **Access model** (three levels: public / revyst / admin): public landing page; top-right
  login with two shared passwords handed out verbally. Revyst pages are greyed out in the
  nav until login; admin pages are hidden from the nav until admin login. Client-side
  gating for *reads* is a deliberate, accepted trade-off (the repo is public — nothing on
  the site is secret); **writes are genuinely validated server-side** by
  `server/update-data.php` (two password levels, `hash_equals`).
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

### Phase 4 — Manus selection tool

**Intent**: tool for shortlisting/voting which sketches make the current year's manus.
Requirements gathered in its own planning session — likely the first real revyst-level
write (voting).

**Status**: [ ] not started — needs requirements

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
- [ ] Later — reimbursement-owed rollup (Excel's "Udlægsholder/Udlæg"), export/backup of the
  private datastore (this data has no git history), closer parity with the full Excel.

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
