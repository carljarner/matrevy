---
paths:
  - "server/**"
  - "docker-compose.yml"
---

# Server, worker & write endpoint (details)

The summary is in CLAUDE.md; this is the detail for work under `server/`.

## Containers (`docker-compose.yml`)

Both mount the host folder `/srv/matrevy/data` at `/data`.

- **`web`** (`server/Dockerfile.site`, `php:8.3-apache`, build context = repo root): serves the repo's static files plus `update-data.php`, `health.php` (Coolify healthcheck/UptimeRobot) and `config.php` (= `server/config.docker.php`, every value from Coolify env vars: `REVYST_PASSWORD`, `BOSS_PASSWORD`, `ADMIN_PASSWORD`, optional `SATYR_PASSWORD`; data dirs default to `/data/{budget,forms,faellesspisning,band,lokaler,site}`). `.dockerignore` keeps the data folders and generated files out of the image.
- **`server/apache-site.conf`**: aliases `/data/`, `/archive/`, `/posts/`, `/wiki/` to `/data/site/…`; every `js/<name>-data.js` **except** `js/manus-data.js` (hand-written code) to `/data/site/generated/js/`; `/calendar.ics` to `/data/site/generated/calendar.ics`. Redirects `www.` → apex (pages on `www.` would fail CORS and keep a separate login). **Clean URLs**: `/kalender` is internally rewritten to `kalender.html`, while `/kalender.html`, `/kalender/`, `/index` and `/index.html` 301 to the clean form (old bookmarks and printed QR codes keep working). Only a single root-level segment naming an existing page file is touched. **`server/dev-router.php` mirrors these rules for `php -S`: keep the two in sync.** It also sends `Cache-Control: no-cache` on everything (cheap 304s; a save or deploy is never hidden behind a cache).
- **`worker`** (`server/Dockerfile.worker`, `texlive/texlive:latest-medium` + Node, runs as uid 33 like Apache): `server/worker.sh` runs `scripts/embed-scenes.js` once at startup, then polls every 2 s for flag files in `/data/site`: `.embed-requested` → `embed-scenes.js`, `.regen-pdfs-requested` → `scripts/generate-pdfs.js`. The flag is removed before each run, so a save landing mid-run triggers one more run. `/app/{data,archive,js,calendar.ics}` are symlinks into `/data/site`, so both scripts run unchanged.

## Archive mirror to GitHub (`worker.sh`)

`update-data.php` touches `.archive-sync-requested` on any write under `archive/`, and the worker touches it after every PDF build. Once the flag has been quiet for `ARCHIVE_SYNC_QUIET_SECONDS` (default 300), the worker `rsync --delete`s `/data/site/archive/` into a sparse clone at `/data/archive-git` and pushes one `[skip ci]` commit to `main` (deploy key = base64 in Coolify's `ARCHIVE_SYNC_DEPLOY_KEY`; empty = mirror off). Strictly one-way; `archive/README.md` is repo-managed. Any write to `data/config.json` backdates the flag so the sync runs within seconds.

What gets mirrored for the **current production** depends on Manus's two toggles:

- `pdfLinksVisibleToRevyst` off → **hidden view**: only `submitted/` (plus `cover.jpg`/`other/`/`snapshot/`), with the selected scenes copied back into it from `sketches/`/`songs/` as their current server version, and no generated PDFs (top-level `*.pdf`, `manuskripter/`).
- manus on, `rolesVisibleToRevyst` off → **redacted view**: the whole folder, but `sketches/`/`songs/`/`manus.pdf` come from the generator's `anonym/` copies, and `manuskripter/`/`Rolleoversigt.pdf` are left out.
- Both restricted views run every `.tex` through `redact_tex` (`\role{X}[…]` → `\role{X}[navn]`). With both toggles on, a plain full mirror. `anonym/` itself is never mirrored.

This keeps closed years and the current production's `submitted/`/`sketches/`/`songs/` browsable on GitHub, so Arkiv's GitHub pill, the Manus Guide link and Program QR codes keep working.

## Save path (`github_api()`)

Despite its name, `github_api()` is a local-disk stand-in for the GitHub Contents API, kept so every caller works unchanged: same return shape (base64 `content` + `sha`), `sha` = sha1 of the file bytes, reads/writes under a `.write.lock` flock, atomic temp-file + rename, a stale `sha` → `409`. After a write it touches `.embed-requested` (any path under `data/`) and `.regen-pdfs-requested` (when the write's message contains `[regen-pdfs]`). Error codes keep their git-era names (`github_read_failed`, `github_write_failed`). `update_file()` has no create-if-missing branch.

## `update-data.php` dispatch order

`action:'login'` maps a password to a level (`hash_equals`; `$LEVEL_RANK` satyr 1 → admin 4).

0. `GET ?teknik_dl=<token>` (before the POST-only check) → `teknik_serve_download()`; the signed token is the authorization.
1. Legacy `{pin, scenes, cast}` → `save`/`manus`.
2. `login`.
3. `upload`/`delete`: binary files at client-chosen paths, level from `upload_path_level()`: `ARCHIVE_PATH_RE` (`archive/<folder>/{cover.jpg,manus.pdf,Manuskript.pdf}`) and `ARCHIVE_SNAPSHOT_RE` → admin, `WIKI_ATTACHMENT_PATH_RE` → boss. Checked before any write and re-checked inside the handlers.
4. `$BUDGET_ACTIONS`, `$FORMS_ACTIONS`, `$FAELLES_ACTIONS`, `$BAND_ACTIONS`, `$KOSTUME_ACTIONS`, `$REKVISIT_ACTIONS`, `$NINJAS_ACTIONS`, `$LOKALER_ACTIONS`, `$FRAVAER_ACTIONS`, `$TEKNIK_ACTIONS`, `$SANGERE_ACTIONS`, `$KOORD_ACTIONS`, `$PROGRAMKLADDE_ACTIONS` (private stores).
5. `$POST_ACTIONS` (revyst, append-only, must never accept a client-supplied full array): `posts_create` (image at `POST_IMAGE_PATH_RE`), `comments_create`, `manuscripts_create`, `manuscripts_update`.
6. Boss: `manuscripts_sync_selection` (only `{id, selected}` pairs; moves files between `submitted`/`sketches`/`songs`), `manus_read`, `manus_regenerate_pdfs`, `manus_pdf_status`, `manuscripts_remove`, `manuscripts_set_durations`, `manus_set_stars`, `manus_set_cast`, `manus_set_sangboss`, `program_read`, `resource_read` (live file + sha of `calendar`/`posts`/`wiki`/`masterplan`/`lokaler`/`fravaer` from a fixed map, `data: null` for a missing file). Admin: `manuscripts_delete` (one `{pdfPath, texPath, id?}`, `ARCHIVE_MANUS_ANY_RE`).
7. `save` → `$RESOURCES` (per-resource min level + validator + writer), full replace:
   - **boss**: `manus` (optional `baseScenesSha`/`baseCastSha` → 409 `stale`), `calendar`, `posts`, `wiki`, `program` (each optional `baseSha` via `payload_base_sha()` → 409 `stale`; returns the new `sha`), `config` (boss for the revyst flags and `teknikUploadsClosed`; `currentProductionFolder` and the ready flags admin-only).
   - **admin**: `manuscripts` (only Koordinator's reset), `archive`, `bosses`, `masterplan`, `lokaler`, `fravaer` (optional `baseSha` → 409 `stale`, return the new `sha`; `fravaer` keeps the live `connection`; `lokaler`/`fravaer` are created if missing), `gantt`, `revyugen`, `production`.
