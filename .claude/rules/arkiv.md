---
paths:
  - "arkiv.html"
  - "js/archive.js"
  - "css/archive.css"
---

# Arkiv (`arkiv.html`/`archive.js`, `data/archive.json`, admin editing)

One square-cover card per year. The stable key is `folder` — slugified once from `name` at creation (`slugifyFolderName()`) and never recomputed, so renaming can't orphan files. `year` isn't unique (a jubilee revy can share a year). Individual sketch/song/other `.tex`/`.pdf` files aren't tracked in the JSON — they live under `archive/<folder>/{sketches,songs,other,…}/` on the server disk (the card's GitHub link pill points at the repo's `archive/<folder>`, kept current by the worker's archive mirror). Only the cover photo and manuscript PDF upload from the browser, via the top-level `upload` action (`archive/<folder>/{cover.jpg,manus.pdf,Manuskript.pdf}`); covers are re-encoded to JPEG client-side; ~5 MB cap. Years are added/edited on Koordinator's Arkivering tab (`openKoordYearEditor`, a near-duplicate of `archive.js`'s never-wired `openYearEditor()`); `arkiv.html` itself is read-only.


**Oval pills**: the detail overlay's link actions (`.arkiv-action-btn`) keep the old `.site-pill-btn` / `-primary` (green) / `-danger` (red) / `-warm` (amber): idle white/cream oval, thin border, hover/focus-visible only changing `border-color`. Kept in `style.css` solely for Arkiv (`archive.js`'s unwired `openYearEditor()` also uses them).
