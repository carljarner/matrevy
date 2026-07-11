# Matematikrevyen – Website & Rehearsal Scheduling Tool Plan

## Top-Level Overview

Build a modern internal website for Matematikrevyen cast and crew, centred around a rehearsal scheduling tool. The site will live on a GitHub repository and be served via the existing domain on Simply.com. The scheduling tool is the primary feature for this production cycle; other pages (manus, messages, etc.) form the wider site shell.

The site is intentionally internal-facing. A login wall will be added at a later phase; the first version is open but not publicly promoted.

---

## Architecture Decisions

- **Tech stack**: Plain HTML + CSS + JavaScript (no framework). Simple to deploy anywhere, no build step needed.
- **Data**: Scene/cast data is stored in a JSON file derived from the LaTeX appendix table. This is the single source of truth for the scheduling tool.
- **PDF export**: Generated client-side using a print-to-PDF stylesheet (CSS `@media print`), matching the layout of the existing schedule.
- **Hosting**: Files are committed to GitHub. The Simply.com domain points to GitHub Pages (or the repo is deployed manually — TBD with user).
- **Multi-production**: The site has a permanent shell (nav, main page, manus page). The scheduling data JSON is replaced each production cycle.

---

## Sub-Tasks

---

### Sub-Task 4 — Scheduling Tool: Auto-Place Algorithm

**Intent**
Implement the optimization step: automatically distribute all scenes with priority score 3 across the grid, respecting hard constraints (no cast overlap, no absent cast members).

**Expected Outcomes**
- A "Auto-place priority scenes" button in the schedule UI.
- Clicking it fills the grid with priority-3 scenes, one scene per room-slot cell, maximising the number of scenes placed.
- Hard constraints respected:
  - A cast member cannot be in two rooms at the same time.
  - A scene is not placed if a required cast member is fully absent (unless coordinator has marked the scene as override-OK).
- Cells placed by the algorithm are visually distinguished from manually placed ones (e.g. a subtle colour tint).
- The coordinator can re-run the algorithm at any time (it replaces only algorithm-placed cells, not manual ones).

**Todo List**
1. Implement a greedy placement algorithm: iterate time slots, for each slot iterate rooms, place highest-priority unplaced scene that has no cast conflict and no absent-member block.
2. Track which cells were auto-placed vs manually placed.
3. Add an "override absent member" toggle per scene in the sidebar.
4. Add a "Clear auto-placed" button.
5. Show a summary after auto-placement: how many priority-3 scenes were placed vs left unplaced and why.

**Relevant Context**
- A scene spans one 30-minute slot by default; if its duration > 30 min it occupies consecutive slots in the same room.
- The algorithm should place scenes "across the whole day" (not top-to-bottom per room) — fill the highest-need scenes first across all available slots.

**Status**: implemented, then removed — deliberately deferred for a future redesign (see CLAUDE.md's scheduling-tool notes on scene priority: priority 0–3 is currently just a manual-placement aid with no automatic placement behind it).

---

## Open Questions / Future Phases

- **Login / access control**: Some pages will eventually be behind a login form. This is explicitly out of scope for the current build and will be a separate phase. Still not implemented.
- **Manus page content**: The content for the manus page has not been described yet — to be filled in when ready. Still a placeholder ("Manussiden er under opbygning").
- **Additional pages**: The user noted there will be more pages. These can be added using `page-template.html`.
- **New productions**: The JSON data files in `data/` are replaced each cycle. A LaTeX-to-JSON parser now partially exists — the manus edit tool (`import.js`/`manus-data.js`) already parses `.tex` sketch files into scene/cast data, but only writes to `localStorage`; promoting a browser's edits into the committed `data/scenes.json`/`cast.json` is still a manual step.

---

### Sub-Task — Make Manus Tool Data Global (not per-browser localStorage)

**Intent**
Replace the manus edit tool's `localStorage`-only save (`import.js`'s `applyImport()`,
`manus-data.js`'s `MANUS_OVERRIDE_KEY`/`getManusOverride()`) with a genuinely global write,
so one coordinator's "Opdater" is visible to everyone instead of only their own browser.
Real admin login is explicitly deferred to a later phase; a shared PIN is a deliberate
interim stopgap.

**Architecture**
```
schedule.html (Rediger Manus modal)
   │ user clicks "Opdater"
   ▼
import.js: applyImport()
   │ POST { pin, scenes, cast } over HTTPS
   ▼
Simply.com PHP proxy (server/update-data.php)
   │ checks PIN, validates JSON shape
   │ calls GitHub Contents API with a server-side-only PAT
   ▼
GitHub repo: commits data/scenes.json + data/cast.json to main
   │ push triggers
   ▼
New GitHub Action (.github/workflows/embed-scenes.yml)
   │ runs node scripts/embed-scenes.js, commits regenerated scenes-data.js
   ▼
GitHub Pages rebuilds (~1-2 min) — everyone sees the change
```
This uses the user's existing Simply.com hosting plan (which includes PHP) as the
server-side piece holding the GitHub write credential, rather than introducing new
infrastructure like Cloudflare Workers.

**Expected Outcomes**
- A save in the manus tool updates the real `data/scenes.json`/`data/cast.json` in the repo
  for everyone, not just the saving browser.
- `scenes-data.js` regenerates automatically (via a new GitHub Action) — no manual
  `node scripts/embed-scenes.js` step needed for this flow.
- The write endpoint is gated by a single shared PIN, easy to remove once real login exists.
- Concurrent-edit conflicts (stale GitHub file `sha`) are surfaced clearly, never silently
  overwritten.

**Todo List**
1. Generate a fine-grained GitHub PAT scoped to just this repo, **Contents: read & write**
   only. Never commit it — store only in the PHP proxy's server-side config.
2. Build `server/update-data.php` (committed to the repo for review, deployed by hand to
   Simply.com): validates the PIN and JSON shape, then for each of
   `data/scenes.json`/`data/cast.json` does GET (fetch current `sha`) → PUT (commit new
   base64 content) via GitHub's Contents API; returns a clear conflict error on `409`.
3. Add `server/config.example.php` (committed, documents required constants: `GITHUB_TOKEN`,
   `GITHUB_OWNER`, `GITHUB_REPO`, `SHARED_PIN`) and `server/config.php` (gitignored, holds
   the real secrets, lives only on the Simply.com server).
4. Add `.github/workflows/embed-scenes.yml`: on push to `main` touching
   `data/scenes.json`/`data/cast.json`, run `node scripts/embed-scenes.js` and commit the
   regenerated `scenes-data.js` back to `main`.
5. Rewrite `manus-data.js`: remove the `localStorage` override entirely;
   `getEffectiveScenesData()`/`getEffectiveCastData()` read `SCENES_DATA`/`CAST_DATA`,
   optionally shadowed by an in-memory (not persisted) "just saved this tab" value for
   instant same-tab feedback.
6. Rewrite `import.js`'s `applyImport()`: prompt for the PIN once per tab (cached in
   `sessionStorage`), POST `{ pin, scenes, cast }` to the proxy, spinner on "Opdater" while
   in flight, success closes the modal with a brief confirmation, failure (bad PIN, network,
   conflict) shows an inline error (reuse the existing `importWarning()` pattern) and keeps
   the modal open so edits aren't lost.
7. Update CLAUDE.md's "Manus edit tool" section (currently says this is explicitly "local,
   not the publishing pipeline") and `data/README.md` to describe the new global-save flow.

**Relevant Context**
- Current write point: `import.js` lines ~588-634 (`applyImport()`), ending in
  `localStorage.setItem(MANUS_OVERRIDE_KEY, ...); location.reload();`.
- `getEffectiveScenesData()`/`getEffectiveCastData()` (`manus-data.js`) are read by
  `schedule.js` in several places (`loadScenes()`, cast-name lookups) — signatures must stay
  the same so those call sites keep working unchanged.
- Out of scope: real user accounts/login — the PIN is a deliberate stopgap only.

**Status**: [x] done — live and verified end-to-end. `server/update-data.php` is deployed at
`https://manus.matematikrevy.dk/update-data.php` (a subdomain created on the Simply.com hosting
account specifically for this, since `matematikrevy.dk`'s own DNS points at GitHub Pages, which
can't run PHP — two CNAMEs, `manus` and `www.manus`, both to
`matematikrevy.dk.linux32.unoeuro-server.com`, were needed for Let's Encrypt's free-cert
validation), with a real `GITHUB_TOKEN`/`SHARED_PIN` filled into `server/config.php` on that
server (gitignored, never committed). A real "Opdater" save was tested end-to-end on
2026-07-11: the PIN prompt, the PHP proxy, both GitHub commits (`data/scenes.json` and
`data/cast.json`), and the `embed-scenes.yml` Action's automatic `scenes-data.js` regeneration
all worked. See CLAUDE.md's "Manus edit tool" section for the deploy gotchas discovered along
the way (the subdomain requirement, Simply.com's WAF bot-challenge behavior, and the
4-space-vs-2-space JSON indentation diff quirk).
