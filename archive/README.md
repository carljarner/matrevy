# archive/

Binary files for the Arkiv page (`arkiv.html`) — cover photos, manuscript PDFs, and individual sketch/song/other-material files, one subfolder per production year.

These are uploaded directly through the Arkiv admin UI (never by hand) via `server/update-data.php`'s `upload`/`delete` actions, which commit straight to this folder through the GitHub Contents API. Metadata pointing at these paths lives in `data/archive.json` — see its schema docs in `data/README.md`.

This file exists only so the folder isn't empty in git before the first upload happens.
