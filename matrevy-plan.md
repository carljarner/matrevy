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

### Sub-Task 1 — Repository & Site Shell

**Intent**
Set up the GitHub repository and build the outer site shell: navigation, main/landing page, and a placeholder manus page. This establishes the structure all future pages plug into.

**Expected Outcomes**
- A GitHub repository exists with the project files.
- A working multi-page site with a top navigation bar.
- A `Main` page (index.html) with a section for coordinator announcements/messages.
- A `Manus` page (manus.html) as a placeholder.
- Clean, modern styling (neutral colours, readable typography).
- Easy to add new pages by copying a template.

**Todo List**
1. Create GitHub repository `matrevy-website` (user does this; Bob provides instructions).
2. Create `index.html` — main/landing page with a messages/announcements section.
3. Create `manus.html` — placeholder page.
4. Create `style.css` — shared stylesheet with navigation, page layout, and typography.
5. Create `page-template.html` — a blank page template so new pages are trivial to add.
6. Commit and push to GitHub.
7. Enable GitHub Pages on the repository.

**Relevant Context**
- The existing site is at `manus.matrevy.dk` — the new site should feel like a modern replacement.
- Navigation must be easy to extend (just add a link).

**Status**: [ ] pending

---

### Sub-Task 2 — Scene Data JSON

**Intent**
Convert the scene/cast data from the LaTeX appendix (as seen in `Scenes.pdf`) into a structured JSON file. This JSON is the input to the scheduling tool and any other page that needs to display cast/scene information.

**Expected Outcomes**
- A `data/scenes.json` file containing all scenes from Matematikrevyen 2025.
- Each scene entry includes: act, scene number, scene name, time estimate (minutes), and an array of cast members with their role codes.
- The JSON is human-readable and easy to update for future productions.

**Todo List**
1. Define the JSON schema (act, number, name, duration_minutes, cast: [{name, role_code}]).
2. Parse `Scenes.pdf` data and write `data/scenes.json` covering all acts and extra numbers.
3. Write `data/cast.json` with the full cast list and what role type each code maps to (D = dancer, I = director, etc.).
4. Add a brief `README.md` in `data/` explaining how to update the files for a new production.

**Relevant Context**
- Source: `Scenes.pdf` — Rolleoversigt table (pages 4–5 of the PDF).
- Role codes: D = dancer, I = director, others are acting roles (S, R, F, etc.).
- Some scenes are videos or band jingles (duration 0) — these should be flagged and excluded from scheduling.

**Status**: [ ] pending

---

### Sub-Task 3 — Scheduling Tool: Input & Grid UI

**Intent**
Build the rehearsal scheduling page (`schedule.html`). This sub-task covers the day-setup inputs and the visual schedule grid — the interactive canvas the coordinator works on.

**Expected Outcomes**
- A `schedule.html` page accessible from the navigation.
- A day-setup panel where the coordinator can:
  - Set the day's start time, end time, and break times.
  - Enter the list of rooms available that day.
  - Enter the list of cast members absent for the full day.
  - Set a rehearsal priority score (0–3) per scene.
- A schedule grid rendered as a table: rooms as columns, 30-minute time slots as rows.
- Empty slots are visually distinct from filled ones.
- The grid updates live as the coordinator changes day-setup inputs.

**Todo List**
1. Build the day-setup form (time range, rooms, absences, priority scores).
2. Render the schedule grid from the form inputs (rooms × time slots).
3. Style the grid to match the look of the existing PDF schedule.
4. Load scene and cast data from `data/scenes.json`.
5. Show a sidebar/panel listing all schedulable scenes with their priority score and cast count.

**Relevant Context**
- The existing schedule runs 10:00–17:00 with 30-minute blocks and 5-minute gaps.
- Rooms from the example: Lille UP1, Store UP1, Biblioteket, A101, A102, A105, A106, A107, Bandet, Rekvisitten.
- Videos and band jingles (duration 0) are excluded from the scheduling tool.

**Status**: [ ] pending

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

**Status**: [ ] pending

---

### Sub-Task 5 — Scheduling Tool: Drag-and-Drop & Manual Editing

**Intent**
Allow the coordinator to freely move scenes between cells after auto-placement, and to manually add scenes to empty slots from the scene sidebar.

**Expected Outcomes**
- Scenes in the grid are draggable to other empty cells.
- Dragging a scene to a cell with a cast conflict shows a warning (but does not block the move — coordinator can override).
- Clicking an empty cell opens a scene picker to manually assign a scene.
- Scenes can be removed from a cell (returned to the unplaced sidebar list).
- The page state is saved to `localStorage` so refreshing doesn't lose work.

**Todo List**
1. Implement drag-and-drop using the HTML5 Drag and Drop API.
2. Add conflict highlighting: when dragging, highlight cells where the dragged scene would have a cast conflict.
3. Implement click-to-assign on empty cells (dropdown or search of unplaced scenes).
4. Implement remove/unassign on placed scenes.
5. Save and restore schedule state to/from `localStorage`.

**Relevant Context**
- Cast conflict = any cast member of the dragged scene is already scheduled in the same time slot in any other room.
- The coordinator should always be able to override conflicts — warnings only, no hard blocks on manual edits.

**Status**: [ ] pending

---

### Sub-Task 6 — Scheduling Tool: Cast Attendance View & PDF Export

**Intent**
Show the cast attendance column (who is present/absent per slot) and implement the PDF export that matches the existing schedule format.

**Expected Outcomes**
- Each grid cell shows the scene name and the cast list for that scene, with absent members shown crossed out or in parentheses.
- A "Export to PDF" button triggers a print-optimised view of the schedule grid.
- The printed output matches the style of `rehearsal_schedule.pdf`: rooms as columns, time slots as rows, scene name + cast list in each cell.
- Page breaks are handled cleanly for longer schedules.

**Todo List**
1. Render cast names inside each filled grid cell, crossing out absent members.
2. Write a `@media print` CSS stylesheet that hides the UI controls and formats the grid for A4 paper.
3. Add an "Export PDF" button that calls `window.print()`.
4. Test print output against `rehearsal_schedule.pdf` as a reference.

**Relevant Context**
- Reference output: `rehearsal_schedule.pdf` — rooms as columns, 30-min slots as rows, scene + cast list per cell.
- Absent members should be visually distinct but still present in the cell (crossed out or parenthesised), so the rest of the cast know who to wait for.

**Status**: [ ] pending

---

### Sub-Task 7 — GitHub & Deployment Setup

**Intent**
Connect the repository to GitHub Pages and point the Simply.com domain to it, so the site is live at the existing domain.

**Expected Outcomes**
- The site is publicly accessible at the production URL.
- A `README.md` at the repo root explains how to update the site and the data files for a new production.
- The coordinator knows how to push changes and see them go live.

**Todo List**
1. Enable GitHub Pages on the `main` branch (or a `/docs` folder if preferred).
2. Add a custom domain in the GitHub Pages settings.
3. Update the DNS CNAME record on Simply.com to point to the GitHub Pages URL.
4. Verify the site loads at the domain.
5. Write `README.md` with instructions for: updating scene data, adding pages, and deploying changes.

**Relevant Context**
- Current domain host: Simply.com.
- Current URL pattern from the PDF footer: `manus.matrevy.dk/oeveplan/plan.html` — the new site should ideally preserve or improve this structure.

**Status**: [ ] pending

---

## Open Questions / Future Phases

- **Login / access control**: Some pages will eventually be behind a login form. This is explicitly out of scope for the current build and will be a separate phase.
- **Manus page content**: The content for the manus page has not been described yet — to be filled in when ready.
- **Additional pages**: The user noted there will be more pages. These can be added using the page template from Sub-Task 1.
- **New productions**: The JSON data files in `data/` are replaced each cycle. A future improvement could be a LaTeX-to-JSON parser to automate this.
